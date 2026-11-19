import { eq, sql } from "drizzle-orm";
import {
  brainState,
  productFacts,
  products,
  type ProductFacet,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { z } from "zod";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { untrusted } from "../ai/prompts";
import { listNotes } from "../brain/vault";
import { storeProductFact, updateProductFact } from "./facts";
import {
  markExistingProductCandidates,
  prepareProductCandidatesFromText,
  type ProductCandidate,
} from "./ingest";

const MAX_SNAPSHOT_RETRIES = 3;

const ReconcileSchema = z.object({
  decisions: z.array(
    z.object({
      index: z.number(),
      action: z.enum(["add", "skip", "merge"]),
      mergeIntoId: z.number().optional(),
      content: z.string().optional(),
    }),
  ),
});

export type ProductOrgScope = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

export type ProductCandidatePhaseOptions = {
  llm?: LLM;
  allowCreate?: boolean;
  beforeExternalPhase?: () => Promise<void>;
  beforeApplyPhase?: () => Promise<void>;
  /** Test-only interleaving seam after each candidate snapshot. */
  afterSnapshot?: () => Promise<void>;
};

type CandidateSnapshot = {
  product: { id: number; name: string; updatedAt: number } | null;
  facts: {
    id: number;
    facet: ProductFacet;
    content: string;
    contentHash: string;
    updatedAt: number;
  }[];
};

type PreparedCandidateOperation = {
  action: "add" | "merge";
  mergeIntoId?: number;
  facet: ProductFacet;
  content: string;
};

type PreparedCandidateApply = {
  snapshotFingerprint: string;
  candidate: ProductCandidate;
  operations: PreparedCandidateOperation[];
};

export type ProductCandidateApplyResult = {
  id: number | null;
  created: boolean;
  changed: boolean;
};

export class ProductCandidateStaleSnapshotError extends Error {
  constructor() {
    super("product changed repeatedly while preparing candidate facts");
    this.name = "ProductCandidateStaleSnapshotError";
  }
}

export class ProductDetectionStaleSnapshotError extends Error {
  constructor() {
    super("brain changed repeatedly while detecting products");
    this.name = "ProductDetectionStaleSnapshotError";
  }
}

async function candidateSnapshot(
  tx: Tx,
  name: string,
  lock = false,
): Promise<CandidateSnapshot> {
  const normalized = name.trim().toLowerCase();
  const productQuery = tx
    .select({
      id: products.id,
      name: products.name,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(sql`lower(btrim(${products.name})) = ${normalized}`)
    .limit(1);
  const rows = lock ? await productQuery.for("update") : await productQuery;
  const product = rows[0] ?? null;
  if (!product) return { product: null, facts: [] };

  const factsQuery = tx
    .select({
      id: productFacts.id,
      facet: productFacts.facet,
      content: productFacts.content,
      contentHash: productFacts.contentHash,
      updatedAt: productFacts.updatedAt,
    })
    .from(productFacts)
    .where(eq(productFacts.productId, product.id));
  const facts = lock ? await factsQuery.for("update") : await factsQuery;
  facts.sort((a, b) => a.id - b.id);
  return { product, facts };
}

function snapshotFingerprint(snapshot: CandidateSnapshot): string {
  return JSON.stringify({
    product: snapshot.product,
    facts: snapshot.facts.map((fact) => ({
      id: fact.id,
      facet: fact.facet,
      contentHash: fact.contentHash,
      updatedAt: fact.updatedAt,
    })),
  });
}

async function prepareCandidateApply(
  candidate: ProductCandidate,
  snapshot: CandidateSnapshot,
  opts: ProductCandidatePhaseOptions,
): Promise<PreparedCandidateApply> {
  const fresh = candidate.facts.filter((fact) => fact.content.trim());
  let decisions: z.infer<typeof ReconcileSchema>["decisions"] = [];

  if (fresh.length > 0 && snapshot.facts.length > 0) {
    const existingBlock = snapshot.facts
      .map((fact) => `#${fact.id} [${fact.facet}] ${fact.content}`)
      .join("\n");
    const newBlock = fresh
      .map((fact, index) => `${index} [${fact.facet}] ${fact.content}`)
      .join("\n");
    await opts.beforeExternalPhase?.();
    try {
      const out = await (opts.llm ?? getLLM()).json({
        model: modelFor("writer"),
        stage: "products.reconcile",
        promptRef: promptRef("products.reconcile"),
        system: `You reconcile new product facts against the ones already stored, to avoid duplicates ("reconcile product facts"). For EACH new fact (by its index) decide one action:
- "skip": it is already fully covered by an existing fact.
- "merge": it overlaps an existing fact but adds a detail; set mergeIntoId and return combined content.
- "add": it is genuinely new; optionally tighten it in content.
Prefer merge over add for the same underlying fact. Return exactly one decision per new-fact index.`,
        user: untrusted(
          "FACTS",
          `EXISTING (id, facet, content):\n${existingBlock}\n\nNEW (index, facet, content):\n${newBlock}`,
        ),
        schema: ReconcileSchema,
        maxTokens: 1500,
      });
      decisions = out.decisions;
    } catch {
      // Preserve the legacy failure-soft rule: add exact-hash-deduped facts.
      decisions = [];
    }
  }

  const byIndex = new Map(
    decisions.map((decision) => [decision.index, decision]),
  );
  const existingById = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
  const operations: PreparedCandidateOperation[] = [];
  for (let index = 0; index < fresh.length; index += 1) {
    const fact = fresh[index]!;
    const decision = byIndex.get(index);
    if (decision?.action === "skip") continue;
    if (
      decision?.action === "merge" &&
      decision.mergeIntoId != null &&
      decision.content?.trim() &&
      existingById.has(decision.mergeIntoId)
    ) {
      operations.push({
        action: "merge",
        mergeIntoId: decision.mergeIntoId,
        facet: existingById.get(decision.mergeIntoId)!.facet,
        content: decision.content.trim(),
      });
    } else {
      operations.push({
        action: "add",
        facet: fact.facet,
        content: decision?.content?.trim() || fact.content.trim(),
      });
    }
  }

  return {
    snapshotFingerprint: snapshotFingerprint(snapshot),
    candidate,
    operations,
  };
}

async function applyPreparedCandidate(
  tx: Tx,
  prepared: PreparedCandidateApply,
  allowCreate: boolean,
): Promise<
  { applied: false } | ({ applied: true } & ProductCandidateApplyResult)
> {
  const normalized = prepared.candidate.name.trim().toLowerCase();
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('product-candidate:' || coalesce(current_setting('app.current_org', true), '') || ':' || ${normalized}))`,
  );
  const current = await candidateSnapshot(tx, prepared.candidate.name, true);
  if (snapshotFingerprint(current) !== prepared.snapshotFingerprint) {
    return { applied: false };
  }

  let productId = current.product?.id ?? null;
  let created = false;
  if (productId == null) {
    if (!allowCreate) {
      return { applied: true, id: null, created: false, changed: false };
    }
    const [inserted] = await tx
      .insert(products)
      .values({
        name: prepared.candidate.name.trim(),
        oneLiner: prepared.candidate.oneLiner?.trim() || null,
        source: "brain",
      })
      .returning({ id: products.id });
    productId = inserted!.id;
    created = true;
  }

  let changed = created;
  for (const operation of prepared.operations) {
    if (operation.action === "merge" && operation.mergeIntoId != null) {
      const result = await updateProductFact(tx, operation.mergeIntoId, {
        content: operation.content,
      });
      changed ||= result.status === "updated";
      continue;
    }
    const inserted = await storeProductFact(tx, {
      productId,
      facet: operation.facet,
      content: operation.content,
      source: "interview",
    });
    changed = changed || inserted;
  }

  return { applied: true, id: productId, created, changed };
}

/** Prepare/reconcile a candidate outside DB, then stale-fence a DB-only apply. */
export async function applyProductCandidatePhased(
  orgScope: ProductOrgScope,
  candidate: ProductCandidate,
  opts: ProductCandidatePhaseOptions = {},
): Promise<ProductCandidateApplyResult> {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_RETRIES; attempt += 1) {
    const snapshot = await orgScope((tx) =>
      candidateSnapshot(tx, candidate.name),
    );
    await opts.afterSnapshot?.();
    if (!snapshot.product && opts.allowCreate === false) {
      return { id: null, created: false, changed: false };
    }
    const prepared = await prepareCandidateApply(candidate, snapshot, opts);
    await opts.beforeApplyPhase?.();
    const result = await orgScope((tx) =>
      applyPreparedCandidate(tx, prepared, opts.allowCreate !== false),
    );
    if (result.applied) return result;
  }
  throw new ProductCandidateStaleSnapshotError();
}

export type BrainProductDetectionOptions = {
  llm?: LLM;
  beforeExternalPhase?: () => Promise<void>;
  beforeApplyPhase?: () => Promise<void>;
  /** Test-only interleaving seam after version, before knowledge. */
  afterVersionRead?: () => Promise<void>;
};

/** Detect products from a coherently versioned Brain snapshot. */
export async function detectProductsFromBrainPhased(
  orgScope: ProductOrgScope,
  opts: BrainProductDetectionOptions = {},
): Promise<ProductCandidate[]> {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_RETRIES; attempt += 1) {
    const snapshot = await orgScope(async (tx) => {
      const [state] = await tx
        .select({ knowledgeVersion: brainState.knowledgeVersion })
        .from(brainState);
      await opts.afterVersionRead?.();
      // The corpus resolves from the vault (INV-14): active notes, newest
      // first — created-desc with id-desc tiebreak, the same order the table
      // read held.
      const notes = await listNotes();
      return {
        knowledgeVersion: state?.knowledgeVersion ?? 0,
        corpus: notes.map((note) => note.content).join("\n\n"),
      };
    });
    if (!snapshot.corpus) return [];

    const prepared = await prepareProductCandidatesFromText(snapshot.corpus, {
      llm: opts.llm,
      beforeExternalPhase: opts.beforeExternalPhase,
    });
    await opts.beforeApplyPhase?.();
    const validated = await orgScope(async (tx) => {
      const [state] = await tx
        .select({ knowledgeVersion: brainState.knowledgeVersion })
        .from(brainState);
      if ((state?.knowledgeVersion ?? 0) !== snapshot.knowledgeVersion) {
        return null;
      }
      return markExistingProductCandidates(tx, prepared);
    });
    if (validated) return validated;
  }
  throw new ProductDetectionStaleSnapshotError();
}
