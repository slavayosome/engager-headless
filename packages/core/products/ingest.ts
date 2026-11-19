import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import {
  request as httpsRequest,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  jobs,
  productFacts,
  products,
  type Product,
  type ProductFacet,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { AgentCliError } from "../ai/agentCli/types";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { untrusted } from "../ai/prompts";
import {
  hostedJobSpendAccess,
  type HostedSpendAccess,
} from "../entitlements/hosted";
import { enqueue } from "../jobs/queue";
import {
  recomputeFillScore,
  storeProductFact,
  updateProductFact,
} from "./facts";
import { firecrawlScrape } from "./firecrawl";

/**
 * Enqueue the async URL-ingest for a product instead of running `ingestProductUrl`
 * inline. Inline ingest holds the org tx across an SSRF fetch + an LLM call, which
 * idles-in-transaction on Vercel and DEADLOCKS the es2 worker at POOL_MAX=1 — so the
 * dashboard create/rescan paths MUST enqueue. 5-minute idempotency slot so a rapid
 * double-submit dedupes but an intentional re-scan after a few minutes still runs.
 */
export async function enqueueIngestProduct(
  tx: Tx,
  productId: number,
  opts: { reason?: "create" | "rescan" } = {},
): Promise<void> {
  const reason = opts.reason ?? "create";
  await enqueue(tx, {
    type: "ingest_product",
    payload: { productId },
    // An explicit rescan immediately after create is a distinct user intent;
    // repeated clicks within the same five-minute lane still dedupe.
    idempotencyKey: `ingest:${reason}:${productId}:${Math.floor(Date.now() / 300_000)}`,
  });
}

export type ProductIngestRunState =
  | { status: "queued" | "running" }
  | {
      status: "unavailable";
      reason:
        | Extract<HostedSpendAccess, { allowed: false }>["reason"]
        | "permanent_failure";
      errorCode: ProductIngestErrorCode;
    };

export type ProductIngestErrorCode = NonNullable<Product["ingestErrorCode"]>;

function hostedDenialCode(
  reason: Extract<HostedSpendAccess, { allowed: false }>["reason"],
): ProductIngestErrorCode {
  // `product_ingest_initial_allowance_exhausted` survives as a stored value on
  // historical rows; P4 removed the allowance that produced it, so no new
  // denial can carry it.
  return reason === "job_lease_lost"
    ? "product_ingest_job_lease_lost"
    : "product_ingest_subscription_inactive";
}

/**
 * Ensure a website-ingest run for this product is underway — the one path the
 * onboarding save AND its explicit "read the website again" retry both use.
 * Modeled on requestVoiceImport: open work is reused; otherwise the latest
 * terminal job row is explicitly re-armed (a new logical execution of the same
 * physical row), which deliberately BYPASSES enqueue's five-minute idempotency
 * lane — a user-visible retry must never silently no-op against a finished job.
 * Always stamps ingestStage='crawling' when a run is live so the wizard's
 * target step shows progress immediately, before any worker picks the job up.
 */
export async function requestProductIngestRun(
  tx: Tx,
  organizationId: string,
  productId: number,
  opts: { resetSuggestion?: boolean } = {},
): Promise<ProductIngestRunState> {
  // Every path that touches both rows locks product -> job. The worker follows
  // the same order, so a product edit plus retry cannot deadlock by inversion.
  const [product] = await tx
    .select({ ingestErrorCode: products.ingestErrorCode })
    .from(products)
    .where(eq(products.id, productId))
    .for("update");
  if (!product) {
    return {
      status: "unavailable",
      reason: "permanent_failure",
      errorCode: "product_ingest_url_invalid",
    };
  }
  if (product.ingestErrorCode === "product_ingest_url_invalid") {
    return {
      status: "unavailable",
      reason: "permanent_failure",
      errorCode: product.ingestErrorCode,
    };
  }
  const stampPending = async () => {
    await tx
      .update(products)
      .set({
        ingestStage: "crawling",
        ingestErrorCode: null,
        // A changed link invalidates targeting derived from the old site.
        ...(opts.resetSuggestion ? { campaignSuggestion: null } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(products.id, productId));
  };
  const stampDenied = async (
    reason: Extract<HostedSpendAccess, { allowed: false }>["reason"],
  ) => {
    const errorCode = hostedDenialCode(reason);
    await tx
      .update(products)
      .set({
        ingestStage: "failed",
        ingestErrorCode: errorCode,
        updatedAt: Date.now(),
      })
      .where(eq(products.id, productId));
    return { status: "unavailable" as const, reason, errorCode };
  };
  // jobs is intentionally outside RLS — the org predicate is load-bearing.
  // Row-locked so a concurrent retry can't double-re-arm the same terminal row.
  const [latest] = await tx
    .select({ id: jobs.id, status: jobs.status, nextRunAt: jobs.nextRunAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.type, "ingest_product"),
        sql`${jobs.payload}->>'productId' = ${String(productId)}`,
      ),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(1)
    .for("update");
  if (latest?.status === "running") {
    await stampPending();
    return { status: "running" };
  }
  if (latest?.status === "queued") {
    const access = await hostedJobSpendAccess(
      tx,
      organizationId,
      "ingest_product",
    );
    if (!access.allowed) return stampDenied(access.reason);
    const now = Date.now();
    if (latest.nextRunAt > now) {
      await tx
        .update(jobs)
        .set({ nextRunAt: now, lastError: null, updatedAt: now })
        .where(and(eq(jobs.id, latest.id), eq(jobs.status, "queued")));
    }
    await stampPending();
    return { status: "queued" };
  }
  if (latest) {
    const access = await hostedJobSpendAccess(
      tx,
      organizationId,
      "ingest_product",
    );
    if (!access.allowed) return stampDenied(access.reason);
    const now = Date.now();
    await tx
      .update(jobs)
      .set({
        status: "queued",
        attempts: 0,
        // A manual rerun is a new logical execution of the same physical row
        // (stable idempotency surface). Queue retries never advance this value.
        executionGeneration: sql`${jobs.executionGeneration} + 1`,
        payload: { productId },
        nextRunAt: now,
        lockedAt: null,
        leaseToken: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(jobs.id, latest.id));
    await stampPending();
    return { status: "queued" };
  }
  const access = await hostedJobSpendAccess(
    tx,
    organizationId,
    "ingest_product",
  );
  if (!access.allowed) return stampDenied(access.reason);
  await enqueueIngestProduct(tx, productId);
  await stampPending();
  return { status: "queued" };
}

const FACET_VALUES = [
  "what",
  "audience",
  "value",
  "proof",
  "objections",
  "links",
] as const;

// "extract product facts" marker is load-bearing for FakeLLM test routing.
const ExtractSchema = z.object({
  name: z
    .string()
    .max(80)
    .optional()
    .describe(
      "the product's actual brand/product name as stated on the page (not the domain)",
    ),
  tagline: z
    .string()
    .max(180)
    .optional()
    .describe(
      "ONE sentence: what the product fundamentally IS and does, for whom — the core elevator pitch. NOT a secondary/implementation detail (delivery channel, tech stack, platform, integrations).",
    ),
  facts: z
    .array(
      z.object({
        facet: z.enum(FACET_VALUES),
        content: z.string().min(1),
      }),
    )
    .max(12),
});

// A new-product preview needs identity as well as facts. Required fields let
// the agent's existing bounded schema repair handle an incomplete answer.
const ProductPreviewSchema = ExtractSchema.extend({
  name: ExtractSchema.shape.name.unwrap().trim().min(1),
  tagline: ExtractSchema.shape.tagline.unwrap().trim().min(1),
});

export type PreparedProductUrlIngest =
  | { ok: false; code: ProductIngestErrorCode; reason: string }
  | {
      ok: true;
      url: string;
      name?: string;
      tagline?: string;
      facts: {
        facet: ProductFacet;
        content: string;
      }[];
    };

// "identify products" marker is load-bearing for FakeLLM test routing.
const ProductsFromTextSchema = z.object({
  products: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        oneLiner: z.string().max(200).optional(),
        facts: z
          .array(
            z.object({
              facet: z.enum(FACET_VALUES),
              content: z.string().min(1),
            }),
          )
          .max(12)
          .optional(),
      }),
    )
    .max(5),
});

/** A product the LLM spotted in free text — proposed, not yet persisted. */
export type ProductCandidate = {
  name: string;
  oneLiner: string | null;
  facts: { facet: ProductFacet; content: string }[];
  /** True when a product with this name already exists in the org. */
  exists: boolean;
};

export type DetectedProductCandidate = Omit<ProductCandidate, "exists">;

export type PrepareProductDetectionOptions = {
  llm?: LLM;
  /** Re-authorize immediately before the product-detection model call. */
  beforeExternalPhase?: () => Promise<void>;
};

/**
 * Detect (do NOT create) products a person is building/selling from a free-text
 * blurb (the Brain seed). Conservative: only clearly-named products, never
 * jobs/skills/beliefs. Marks which candidates already exist so the UI can offer a
 * confirm step. Best-effort — an LLM/parse failure returns an empty list.
 */
export async function prepareProductCandidatesFromText(
  text: string,
  opts: PrepareProductDetectionOptions = {},
): Promise<DetectedProductCandidate[]> {
  const body = text.trim();
  if (body.length < 40) return [];

  let out: z.infer<typeof ProductsFromTextSchema>;
  // Keep the economic/auth guard outside the failure-soft model catch. A
  // revocation must abort this phase, not masquerade as "no products found".
  await opts.beforeExternalPhase?.();
  try {
    const llm = opts.llm ?? getLLM();
    out = await llm.json({
      // Writer model (Sonnet): product identification is subtler than slot
      // classification, and recall matters for the auto-detect to feel useful.
      model: modelFor("writer"),
      stage: "products.detect",
      promptRef: promptRef("products.detect"),
      system: `You identify products from a person's text, to seed a product knowledge base ("identify products"). A PRODUCT is any app, tool, service, library, platform, or side-project the person builds, ships, or sells — include early-stage, in-progress, or beta ones, and infer a short name from context if they describe one without naming it. EXCLUDE employers/companies they merely work at, job titles, skills, and pure opinions. When in doubt about a thing they are clearly building, include it. Return an empty list ONLY if the text describes no product at all. For each product give its name, a one-line description, and any concrete facts grouped by facet: what (what it is), audience (who it's for), value (why it matters), proof (results/traction), objections (concerns it answers), links (urls). Do not invent facts not in the text.`,
      user: untrusted("BACKGROUND", body.slice(0, 8000)),
      schema: ProductsFromTextSchema,
      maxTokens: 1200,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[products] detectProductsFromText failed:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }

  const candidates: DetectedProductCandidate[] = [];
  for (const p of out.products) {
    const name = p.name.trim();
    if (!name) continue;
    candidates.push({
      name,
      oneLiner: p.oneLiner?.trim() || null,
      facts: (p.facts ?? []).map((f) => ({
        facet: f.facet,
        content: f.content,
      })),
    });
  }
  return candidates;
}

/** Mark provider-prepared candidates against the current org using DB work only. */
export async function markExistingProductCandidates(
  tx: Tx,
  candidates: DetectedProductCandidate[],
): Promise<ProductCandidate[]> {
  const existing = await tx.select({ name: products.name }).from(products);
  const names = new Set(existing.map((row) => row.name.trim().toLowerCase()));
  return candidates.map((candidate) => ({
    ...candidate,
    exists: names.has(candidate.name.trim().toLowerCase()),
  }));
}

/** Compatibility wrapper for transaction-owned callers. */
export async function detectProductsFromText(
  tx: Tx,
  text: string,
  opts: { llm?: LLM } = {},
): Promise<ProductCandidate[]> {
  const prepared = await prepareProductCandidatesFromText(text, opts);
  return markExistingProductCandidates(tx, prepared);
}

// "reconcile product facts" marker is load-bearing for FakeLLM test routing.
const ReconcileSchema = z.object({
  decisions: z.array(
    z.object({
      index: z.number(), // index into the NEW facts
      action: z.enum(["add", "skip", "merge"]),
      mergeIntoId: z.number().optional(), // an existing fact id, when action=merge
      content: z.string().optional(), // merged/enriched text (merge) or refined add
    }),
  ),
});

/**
 * Add new facts to a product WITHOUT duplicating: an LLM compares each new fact to
 * the product's existing facts and decides add (novel) / skip (redundant) / merge
 * (enrich an existing fact with the new detail). Falls back to plain add (exact
 * hash-dedupe) when there are no existing facts or the model call fails — so it
 * never loses a genuinely new fact. Returns the applied counts.
 */
export async function reconcileProductFacts(
  tx: Tx,
  productId: number,
  newFacts: { facet: ProductFacet; content: string }[],
  opts: { llm?: LLM } = {},
): Promise<{ added: number; merged: number; skipped: number }> {
  const fresh = newFacts.filter((f) => f.content.trim());
  if (fresh.length === 0) return { added: 0, merged: 0, skipped: 0 };

  const existing = await tx
    .select({
      id: productFacts.id,
      facet: productFacts.facet,
      content: productFacts.content,
    })
    .from(productFacts)
    .where(eq(productFacts.productId, productId));

  const addAll = async () => {
    let added = 0;
    for (const f of fresh) {
      if (
        await storeProductFact(tx, {
          productId,
          facet: f.facet,
          content: f.content,
          source: "interview",
        })
      )
        added++;
    }
    return { added, merged: 0, skipped: 0 };
  };

  if (existing.length === 0) return addAll();

  let decisions: z.infer<typeof ReconcileSchema>["decisions"] = [];
  try {
    const llm = opts.llm ?? getLLM();
    const existingBlock = existing
      .map((e) => `#${e.id} [${e.facet}] ${e.content}`)
      .join("\n");
    const newBlock = fresh
      .map((f, i) => `${i} [${f.facet}] ${f.content}`)
      .join("\n");
    const out = await llm.json({
      model: modelFor("writer"),
      stage: "products.reconcile",
      promptRef: promptRef("products.reconcile"),
      system: `You reconcile new product facts against the ones already stored, to avoid duplicates ("reconcile product facts"). For EACH new fact (by its index) decide one action:
- "skip": it's already fully covered by an existing fact (no new information).
- "merge": it overlaps an existing fact but adds a detail — set mergeIntoId to that existing fact's id and set content to the combined, deduped fact (one clear sentence keeping every concrete detail from both).
- "add": it's genuinely new — optionally tighten it in content.
Prefer merge over add when a new fact is about the same thing as an existing one. Return exactly one decision per new-fact index.`,
      user: untrusted(
        "FACTS",
        `EXISTING (id, facet, content):\n${existingBlock}\n\nNEW (index, facet, content):\n${newBlock}`,
      ),
      schema: ReconcileSchema,
      maxTokens: 1500,
    });
    decisions = out.decisions;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[products] reconcileProductFacts failed — adding as-is:",
      e instanceof Error ? e.message : e,
    );
    return addAll();
  }

  const byIndex = new Map(decisions.map((d) => [d.index, d]));
  const validIds = new Set(existing.map((e) => e.id));
  let added = 0;
  let merged = 0;
  let skipped = 0;
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i]!;
    const d = byIndex.get(i);
    if (d?.action === "skip") {
      skipped++;
    } else if (
      d?.action === "merge" &&
      d.mergeIntoId &&
      d.content?.trim() &&
      validIds.has(d.mergeIntoId)
    ) {
      const result = await updateProductFact(tx, d.mergeIntoId, {
        content: d.content.trim(),
      });
      if (result.status === "updated") merged++;
      else skipped++;
    } else {
      if (
        await storeProductFact(tx, {
          productId,
          facet: f.facet,
          content: d?.content?.trim() || f.content,
          source: "interview",
        })
      )
        added++;
    }
  }
  return { added, merged, skipped };
}

/**
 * Create (or enrich, if a product with that name already exists) a product from a
 * detected candidate. New product → facts added directly; existing product → facts
 * reconciled so a "merge" enriches rather than duplicates. Returns id + whether new.
 */
export async function createProductFromCandidate(
  tx: Tx,
  candidate: ProductCandidate,
  opts: { llm?: LLM } = {},
): Promise<{ id: number; created: boolean }> {
  const name = candidate.name.trim();
  const existing = await tx
    .select({ id: products.id, name: products.name })
    .from(products);
  const match = existing.find(
    (p) => p.name.trim().toLowerCase() === name.toLowerCase(),
  );

  if (match) {
    await reconcileProductFacts(tx, match.id, candidate.facts, opts);
    return { id: match.id, created: false };
  }

  const [row] = await tx
    .insert(products)
    .values({
      name,
      oneLiner: candidate.oneLiner?.trim() || null,
      source: "brain",
    })
    .returning({ id: products.id });
  const id = row!.id;
  for (const f of candidate.facts) {
    await storeProductFact(tx, {
      productId: id,
      facet: f.facet,
      content: f.content,
      source: "interview",
    });
  }
  return { id, created: true };
}

/**
 * Detect AND create products from free text in one shot (non-interactive callers).
 * The interactive Brain seed uses detect + a confirm step instead.
 */
export async function extractProductsFromText(
  tx: Tx,
  text: string,
  opts: { llm?: LLM } = {},
): Promise<{ created: number; products: { id: number; name: string }[] }> {
  const candidates = await detectProductsFromText(tx, text, { llm: opts.llm });
  let created = 0;
  const out: { id: number; name: string }[] = [];
  for (const c of candidates) {
    const r = await createProductFromCandidate(tx, c, {
      llm: opts.llm,
    });
    if (r.created) created++;
    out.push({ id: r.id, name: c.name });
  }
  return { created, products: out };
}

/** Normalize a user-entered link to an absolute https URL (best-effort). */
function normalizeUrl(link: string): string | null {
  const raw = link.trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    return null;
  }
  try {
    return new URL(
      /^https?:\/\//i.test(raw) ? raw : `https://${raw}`,
    ).toString();
  } catch {
    return null;
  }
}

/** For a github.com/owner/repo URL, the GitHub API endpoint for its README. */
function githubReadmeApi(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com")
      return null;
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return `https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, "")}/readme`;
  } catch {
    return null;
  }
}

/** Crude HTML → text: drop script/style, strip tags, collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// --- SSRF guard ------------------------------------------------------------
// `ingestProductUrl` fetches an arbitrary, user-supplied product link, and that
// link is now remotely scriptable via the MCP `save_product`/`rescan` tools by
// API key. Without a guard an attacker could point Engager at internal services
// or the cloud metadata endpoint (169.254.169.254). So: allow ONLY http(s), and
// refuse loopback/private/link-local hosts — before any fetch, on every redirect
// hop, and against the RESOLVED address (DNS rebinding), all under a hard timeout.

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RESPONSE_HEADER_BYTES = 32_768;

function parseV4(ip: string): number | null {
  const parts = ip.split(".").map((n) => Number(n));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return null;
  }
  const [a, b, c, d] = parts as [number, number, number, number];
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

function isPrivateV4(ip: string): boolean {
  if (parseV4(ip) === null) return true; // malformed → treat as unsafe
  const parts = ip.split(".").map(Number);
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network / private / loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF + TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark network
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function parseV6(ip: string): bigint | null {
  let raw = ip.toLowerCase().split("%")[0] ?? "";
  if (raw.includes(".")) {
    const lastColon = raw.lastIndexOf(":");
    const v4 = parseV4(raw.slice(lastColon + 1));
    if (lastColon < 0 || v4 === null) return null;
    raw = `${raw.slice(0, lastColon)}:${(v4 >>> 16).toString(16)}:${(
      v4 & 0xffff
    ).toString(16)}`;
  }

  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function inV6Prefix(value: bigint, base: string, bits: number): boolean {
  const baseValue = parseV6(base);
  if (baseValue === null) return false;
  const shift = BigInt(128 - bits);
  return value >> shift === baseValue >> shift;
}

/**
 * True if an IPv4/IPv6 literal is loopback / private / link-local / reserved — the
 * ranges an SSRF guard must refuse. Returns false for non-IP strings (callers only
 * pass IP literals or DNS-resolved addresses). Exported for unit testing.
 */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.split("%")[0] ?? ip;
  const fam = isIP(address);
  if (fam === 4) return isPrivateV4(ip);
  if (fam === 6) {
    const value = parseV6(address);
    if (value === null) return true;
    // Today, publicly routed IPv6 unicast is allocated from 2000::/3. Refusing
    // everything else also closes mapped/translated, discard, site-local,
    // unique-local, link-local and multicast encodings without string tricks.
    if (!inV6Prefix(value, "2000::", 3)) return true;
    // Special-purpose blocks that sit inside 2000::/3 but are not safe public
    // destinations: IETF protocol assignments, documentation and 6to4.
    if (inV6Prefix(value, "2001::", 23)) return true;
    if (inV6Prefix(value, "2001:db8::", 32)) return true;
    if (inV6Prefix(value, "2002::", 16)) return true;
    if (inV6Prefix(value, "3fff::", 20)) return true;
    return false;
  }
  return false; // not an IP literal
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Synchronous SSRF pre-check: allow ONLY http(s), and refuse `localhost` + private/
 * loopback/link-local IP literals BEFORE any network call. DNS rebinding (a public
 * hostname resolving to a private IP) is caught separately at fetch time. Exported
 * for unit testing.
 */
export function validateFetchUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme: ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "embedded credentials are not allowed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase(); // strip IPv6 brackets
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "loopback host" };
  }
  if (isIP(host) && isPrivateAddress(host)) {
    return { ok: false, reason: "private/loopback address" };
  }
  return { ok: true, url };
}

type VettedAddress = { address: string; family: 4 | 6 };
type AddressResolver = (
  hostname: string,
) => Promise<readonly { address: string; family?: number }[]>;

const defaultAddressResolver: AddressResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve once, reject the whole answer set if any result is non-public, and return
 * the exact address the socket must use. Rejecting mixed answers prevents a caller
 * from selecting a safe record while another connection path selects an unsafe one.
 */
async function resolveVettedAddress(
  url: URL,
  resolver: AddressResolver,
): Promise<VettedAddress | null> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(host);
  if (literalFamily) {
    return isPrivateAddress(host)
      ? null
      : { address: host, family: literalFamily as 4 | 6 };
  }
  try {
    const answers = await resolver(host);
    const vetted = answers.map((answer): VettedAddress | null => {
      const family = isIP(answer.address);
      if (
        (family !== 4 && family !== 6) ||
        (answer.family !== undefined && answer.family !== family) ||
        isPrivateAddress(answer.address)
      ) {
        return null;
      }
      return { address: answer.address, family };
    });
    if (vetted.length === 0 || vetted.some((answer) => answer === null)) {
      return null;
    }
    return vetted[0]!;
  } catch {
    return null;
  }
}

type SafeFetchResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  text: () => Promise<string>;
};

type PinnedRequester = (
  url: URL,
  init: RequestInit,
  pinned: VettedAddress,
  signal: AbortSignal,
  maxBodyBytes: number,
) => Promise<SafeFetchResponse>;

export type SafeFetchDependencies = {
  /** @internal Test seam for deterministic DNS-rebinding coverage. */
  resolver?: AddressResolver;
  /** @internal Test seam; production always uses the pinned Node HTTP requester. */
  requester?: PinnedRequester;
  /** @internal Tests may lower the cap; production is always bounded to 1 MB. */
  maxBodyBytes?: number;
  /** Re-authorize immediately before each DNS lookup and pinned request. */
  beforeExternalPhase?: () => void | Promise<void>;
};

function sameAddress(
  actual: string | undefined,
  expected: VettedAddress,
): boolean {
  if (!actual) return false;
  if (expected.family === 4) {
    if (actual === expected.address) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(actual);
    return mapped?.[1] === expected.address;
  }
  const actualValue = parseV6(actual);
  const expectedValue = parseV6(expected.address);
  return actualValue !== null && actualValue === expectedValue;
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else if (value !== undefined) {
      out.set(name, value);
    }
  }
  return out;
}

/**
 * Execute one request through a fresh, non-pooled socket. The custom lookup never
 * consults DNS: it returns only the address vetted immediately before this call.
 * `hostname`/`Host` and HTTPS `servername` remain the original URL hostname, so
 * virtual hosting and certificate verification keep their normal semantics.
 */
const requestPinned: PinnedRequester = (
  url,
  init,
  pinned,
  signal,
  maxBodyBytes,
) =>
  new Promise((resolve, reject) => {
    if (isPrivateAddress(pinned.address)) {
      reject(new Error("refusing non-public pinned address"));
      return;
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const headers = new Headers(init.headers);
    // Do not let a future caller route to one authority while sending another Host.
    headers.set("host", url.host);
    headers.set("connection", "close");
    headers.set("accept-encoding", "identity");
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [pinned]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    };
    const options: HttpsRequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup,
      agent: false,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      signal,
      ...(url.protocol === "https:" && !isIP(hostname)
        ? { servername: hostname }
        : {}),
    };

    const makeRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = makeRequest(options, (response) => {
      const status = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        const body = Buffer.concat(chunks);
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: responseHeaders(response.headers),
          text: async () => body.toString("utf8"),
        });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      response.once("error", fail);
      // Redirect bodies and reachability probes are irrelevant. Close immediately
      // rather than letting an attacker stream until the deadline.
      const bodyLimit =
        status >= 300 && status < 400 ? 0 : Math.max(0, maxBodyBytes);
      if (bodyLimit === 0) {
        finish();
        response.destroy();
        return;
      }
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = bodyLimit - received;
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining));
          received += Math.min(buffer.length, remaining);
        }
        if (buffer.length >= remaining) {
          finish();
          response.destroy();
        }
      });
      response.once("end", finish);
    });

    request.once("socket", (socket) => {
      const connected = url.protocol === "https:" ? "secureConnect" : "connect";
      socket.once(connected, () => {
        if (!sameAddress(socket.remoteAddress, pinned)) {
          socket.destroy(
            new Error("connected address did not match the vetted DNS answer"),
          );
        }
      });
    });
    request.once("error", reject);
    request.end();
  });

async function beforeDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) throw new Error("fetch deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("fetch deadline exceeded")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch with the SSRF guard + a hard timeout, validating EVERY hop: redirects are
 * followed manually so a redirect to an internal address can't bypass the guard.
 * Returns null on any validation failure, timeout, or network error.
 */
export async function safeFetch(
  target: string,
  init: RequestInit,
  dependencies: SafeFetchDependencies = {},
): Promise<SafeFetchResponse | null> {
  let current = target;
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  const resolver = dependencies.resolver ?? defaultAddressResolver;
  const requester = dependencies.requester ?? requestPinned;
  const maxBodyBytes = Math.min(
    MAX_RESPONSE_BYTES,
    Math.max(0, dependencies.maxBodyBytes ?? MAX_RESPONSE_BYTES),
  );
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = validateFetchUrl(current);
    if (!check.ok) {
      // eslint-disable-next-line no-console
      console.error(`[products] refusing to fetch ${current}: ${check.reason}`);
      return null;
    }
    await dependencies.beforeExternalPhase?.();
    const remainingForDns = deadline - Date.now();
    let pinned: VettedAddress | null;
    try {
      pinned = await beforeDeadline(
        resolveVettedAddress(check.url, resolver),
        remainingForDns,
      );
    } catch {
      return null;
    }
    if (!pinned) {
      // eslint-disable-next-line no-console
      console.error(
        `[products] refusing to fetch ${current}: does not resolve exclusively to public addresses`,
      );
      return null;
    }
    const ac = new AbortController();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const timer = setTimeout(() => ac.abort(), remaining);
    const signal = init.signal
      ? AbortSignal.any([init.signal, ac.signal])
      : ac.signal;
    let res: SafeFetchResponse;
    await dependencies.beforeExternalPhase?.();
    try {
      res = await requester(check.url, init, pinned, signal, maxBodyBytes);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res; // 3xx without Location — hand back as-is
      try {
        current = new URL(loc, check.url).toString();
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  // eslint-disable-next-line no-console
  console.error(`[products] too many redirects fetching ${target}`);
  return null;
}

/**
 * Quick reachability + SSRF-safety check for a user-entered product URL. Used by
 * onboarding to validate the site before creating the product — the full Firecrawl
 * ingest still runs in the background afterward. Normalises a bare host to https://,
 * then does ONE SSRF-guarded GET. Returns false for a malformed/private/unreachable
 * URL or a 4xx/5xx. Cheap by design (no scrape/parse) so the wizard doesn't stall.
 */
export async function checkUrlReachable(
  input: string,
  opts: {
    signal?: AbortSignal;
    beforeExternalPhase?: () => void | Promise<void>;
  } = {},
): Promise<boolean> {
  const raw = (input ?? "").trim();
  if (!raw) return false;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const res = await safeFetch(
    url,
    {
      method: "GET",
      headers: { "User-Agent": "engager" },
      signal: opts.signal,
    },
    {
      maxBodyBytes: 0,
      beforeExternalPhase: opts.beforeExternalPhase,
    },
  );
  return Boolean(res && res.status < 400);
}

async function fetchSource(url: string): Promise<string | null> {
  const ghApi = githubReadmeApi(url);
  if (ghApi) {
    const res = await safeFetch(ghApi, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "engager",
      },
    });
    if (!res || !res.ok) return null;
    return (await res.text()).slice(0, 12_000);
  }
  // Prefer Firecrawl for sites — it renders JS and returns clean markdown (far better
  // facts than raw HTML), and crawls on its own infra. Fall back to a direct SSRF-guarded
  // fetch when Firecrawl is unconfigured or fails.
  const crawled = await firecrawlScrape(url);
  if (crawled) return crawled;
  const res = await safeFetch(url, { headers: { "User-Agent": "engager" } });
  if (!res || !res.ok) return null;
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = ct.includes("text/html") ? htmlToText(body) : body;
  return text.slice(0, 12_000);
}

export type PrepareProductUrlIngestOptions = {
  llm?: LLM;
  /** Creating a product needs a name and description before review. */
  requireIdentity?: boolean;
  /** Runs after local URL normalization and immediately before the first fetch. */
  beforeFetch?: () => void | Promise<void>;
  /** Re-check hosted spend after fetching but immediately before extraction. */
  beforeExtract?: () => void | Promise<void>;
};

/** The bytes a product's link yields, before anything thinks about them. */
export type ProductSourceCorpus =
  | { ok: true; url: string; text: string }
  | { ok: false; code: ProductIngestErrorCode; reason: string };

/**
 * The I/O HALF of a product ingest: normalize the link, refuse the URLs a
 * retry can never fix, and read the source.
 *
 * Split out because the two halves have different owners now. The crawl is
 * always the server's — SSRF guard, Firecrawl, byte cap — while the extraction
 * belongs to whichever agent is thinking for this org. An in-session ingest
 * calls exactly this and hands the text to a prepared `product_facts` task;
 * the background job calls it through `prepareProductUrlIngest` and extracts
 * inline, as it always did. One crawler, two judges.
 */
export async function fetchProductSourceCorpus(
  link: string | null | undefined,
  opts: Pick<PrepareProductUrlIngestOptions, "beforeFetch"> = {},
): Promise<ProductSourceCorpus> {
  const url = link ? normalizeUrl(link) : null;
  if (!url)
    return {
      ok: false,
      code: "product_ingest_url_invalid",
      reason: "no valid link to scan",
    };

  // Syntax, scheme, credentials, localhost, and private literals are stable
  // properties of this exact URL. Unlike DNS/network/source failures, retrying
  // them unchanged can never succeed and must not consume the retry budget.
  const urlCheck = validateFetchUrl(url);
  if (!urlCheck.ok) {
    return {
      ok: false,
      code: "product_ingest_url_invalid",
      reason: urlCheck.reason,
    };
  }

  await opts.beforeFetch?.();
  const text = await fetchSource(url);
  if (!text || text.length < 40)
    return {
      ok: false,
      code: "product_ingest_source_unavailable",
      reason: "could not read the source",
    };
  return { ok: true, url, text };
}

/** What one extraction pass yields, with no URL in it: the same identity and
 *  facts whether the bytes came from a crawl, a file, or the agent's own text.
 *  `prepareProductUrlIngest` adds the `url` a crawl also knows. */
export type PreparedProductFacts =
  | { ok: false; code: ProductIngestErrorCode; reason: string }
  | {
      ok: true;
      name?: string;
      tagline?: string;
      facts: { facet: ProductFacet; content: string }[];
    };

/**
 * The EXTRACTION half of a product ingest, over bytes the caller already holds.
 *
 * Split out from `prepareProductUrlIngest` for the same reason the crawl was:
 * a product's facts can come from its site, but also from a file the owner
 * keeps or a paragraph their agent wrote, and one `seed_brain
 * {scope:"product:<id>"}` reaches all three. One extractor, one prompt, one
 * failure code — a second copy of this prompt is a second thing to drift.
 */
export async function extractProductFactsFromText(
  text: string,
  opts: Pick<PrepareProductUrlIngestOptions, "llm" | "requireIdentity"> = {},
): Promise<PreparedProductFacts> {
  let out: z.infer<typeof ExtractSchema>;
  try {
    const llm = opts.llm ?? getLLM();
    const schema = opts.requireIdentity ? ProductPreviewSchema : ExtractSchema;
    out = schema.parse(await llm.json({
      model: modelFor("filter"),
      stage: "products.ingest_url",
      promptRef: promptRef("products.ingest_url"),
      system: `You extract a product's identity and facts from its website or repository README, to seed a knowledge base.
If the input begins with a "SITE METADATA" block, that is the site's OWN description of itself (og:title / og:description / meta) — treat it as the AUTHORITATIVE source for the NAME and TAGLINE and prefer it; use the page body to confirm and enrich, and to mine the FACTS. If the two conflict, trust the metadata for the core identity.
1. NAME: the product's actual brand/product name as it appears on the page (hero, logo, title) — NOT the domain or URL.
2. TAGLINE: ONE sentence capturing what the product fundamentally IS and does, and for whom — the elevator pitch a stranger needs. Lead with the primary function and the value to the user. Do NOT lead with how it's delivered (a bot, an app, an integration), the tech stack, or the platform — those are secondary details, not the core.
3. FACTS, sorted into facets: what (what it is / core capabilities — lead with the primary function, keep implementation details secondary), audience (who USES or BUYS it — the end customer, not the maker), value (why it matters to them), proof (results/traction/social proof), objections (concerns it answers), links (urls/assets). Write each as ONE concrete, self-contained sentence in plain language — no marketing fluff, no duplication. Skip navigation and legal boilerplate. CRUCIALLY, skip how the product is BUILT, hosted, or marketed — the tech stack, frameworks, no-code/low-code tooling, and "building in public" / indie-hacker / maker meta are NOT product facts and mislead who the audience is. Capture what it DOES for its users, not how it was made. Return at most 12 facts.`,
      user: untrusted("PRODUCT SOURCE", text),
      schema,
      maxTokens: 900,
    }));
  } catch (error) {
    // AN AGENT'S REFUSAL IS NOT A FAILED EXTRACTION. No agent selected, a
    // signed-out CLI, a profile whose isolation cannot be proved (R-10) — none
    // of those says anything about the text, and answering them with
    // "extraction failed" sends the owner looking for another source when what
    // needs fixing is their agent. It leaves here as itself: the interactive
    // callers have a sentence for each code, and the background job maps it
    // back to a typed denial, which is what the queue has to record.
    if (error instanceof AgentCliError) throw error;
    return {
      ok: false,
      code: "product_ingest_extraction_failed",
      reason: "extraction failed",
    };
  }

  const facts = out.facts
    .map((fact) => ({ facet: fact.facet, content: fact.content.trim() }))
    .filter((fact) => fact.content.length > 0);

  const name = out.name?.trim();
  const tagline = out.tagline?.trim();
  return {
    ok: true,
    ...(name ? { name } : {}),
    ...(tagline ? { tagline } : {}),
    facts,
  };
}

/**
 * Fetch and extract a product source without an open database transaction. Provider
 * work lives here: one extraction call, nothing else. The guard callbacks deliberately
 * run outside the provider catch so typed cancellation propagates instead of becoming
 * a best-effort ingest degradation.
 */
export async function prepareProductUrlIngest(
  link: string | null | undefined,
  opts: PrepareProductUrlIngestOptions = {},
): Promise<PreparedProductUrlIngest> {
  const corpus = await fetchProductSourceCorpus(link, opts);
  if (!corpus.ok) return corpus;
  const { url, text } = corpus;

  await opts.beforeExtract?.();

  const extracted = await extractProductFactsFromText(text, opts);
  if (!extracted.ok) return extracted;
  return { ...extracted, url };
}

/** Apply already-prepared facts using database work only. */
export async function applyPreparedProductUrlIngest(
  tx: Tx,
  productId: number,
  prepared: PreparedProductUrlIngest,
  opts: { expectedRevision?: number } = {},
): Promise<
  | { ok: false; added: 0; code: ProductIngestErrorCode; reason: string }
  | { ok: false; added: 0; stale: true }
  | { ok: true; added: number; changed: boolean }
> {
  if (!prepared.ok)
    return {
      ok: false,
      added: 0,
      code: prepared.code,
      reason: prepared.reason,
    };

  const [cur] = await tx
    .select({
      name: products.name,
      oneLiner: products.oneLiner,
      ingestRevision: products.ingestRevision,
    })
    .from(products)
    .where(eq(products.id, productId))
    .for("update");
  if (
    !cur ||
    (opts.expectedRevision !== undefined &&
      cur.ingestRevision !== opts.expectedRevision)
  ) {
    return { ok: false, added: 0, stale: true };
  }

  // There is no durable provenance bit distinguishing a web row edited by a
  // user from untouched crawl output. The safest minimal semantics are therefore
  // to retain every old web row on link edits and failed/denied crawls, and
  // replace the web set only here, atomically after a successful preparation.
  const removed = await tx
    .delete(productFacts)
    .where(
      and(
        eq(productFacts.productId, productId),
        eq(productFacts.source, "web"),
      ),
    )
    .returning({ id: productFacts.id });

  let added = 0;
  for (const fact of prepared.facts) {
    const inserted = await storeProductFact(tx, {
      productId,
      facet: fact.facet,
      content: fact.content,
      source: "web",
      sourcePath: prepared.url,
    });
    if (inserted) added++;
  }

  // Correct the name from the crawled content — but ONLY when the current name is the
  // URL-derived placeholder (e.g. "trypapatime.com" → "Trypapatime"), never a name the
  // user typed. The page says "PapaTime"; the hostname doesn't. Also cache the tagline as
  // the one-liner (the card's "What it is") when the product has none yet.
  const crawledName = prepared.name;
  const tagline = prepared.tagline;
  const patch: {
    updatedAt: number;
    campaignSuggestion: null;
    name?: string;
    oneLiner?: string;
  } = {
    updatedAt: Date.now(),
    // Even an unchanged-link recrawl may replace the facts that grounded the
    // cached target. Clear it in the same atomic apply before regenerating it.
    campaignSuggestion: null,
  };
  if (
    crawledName &&
    cur &&
    isUrlDerivedName(cur.name, prepared.url) &&
    crawledName.toLowerCase() !== cur.name.toLowerCase()
  ) {
    patch.name = crawledName;
  }
  if (tagline && !cur?.oneLiner?.trim()) patch.oneLiner = tagline;
  await tx.update(products).set(patch).where(eq(products.id, productId));
  await recomputeFillScore(tx, productId);
  return {
    ok: true,
    added,
    changed:
      removed.length > 0 ||
      added > 0 ||
      patch.name !== undefined ||
      patch.oneLiner !== undefined,
  };
}

/**
 * Compatibility wrapper for callers that still own a transaction. New background
 * flows should call prepareProductUrlIngest before opening a short apply transaction.
 */
export async function ingestProductUrl(
  tx: Tx,
  productId: number,
  opts: PrepareProductUrlIngestOptions & { link?: string | null } = {},
): Promise<{ ok: boolean; added: number; reason?: string }> {
  let link = opts.link;
  if (link === undefined) {
    const [row] = await tx
      .select({ link: products.link })
      .from(products)
      .where(eq(products.id, productId));
    link = row?.link ?? null;
  }
  const prepared = await prepareProductUrlIngest(link, opts);
  return applyPreparedProductUrlIngest(tx, productId, prepared);
}

/** True when `name` looks auto-generated from the URL host (the wizard's placeholder,
 *  e.g. "trypapatime.com" → "Trypapatime"), so ingest may replace it with the real
 *  product name from the page. Case-insensitive, so it covers the capitalized form too. */
function isUrlDerivedName(name: string, url: string): boolean {
  const host =
    url
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(/[./]/)[0] ?? "";
  return Boolean(host) && name.trim().toLowerCase() === host.toLowerCase();
}
