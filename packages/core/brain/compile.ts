import { and, eq, ne } from "drizzle-orm";
import {
  brainState,
  campaignProducts,
  campaigns,
  type BrainSlot,
  type CompiledBrief,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { sha256, untrusted } from "../ai/prompts";
import type { ProductContext } from "../ai/writer";
import { campaignProductId, loadCampaignProductContext } from "../products/queries";
import { enqueue } from "../jobs/queue";
import {
  compileFields,
  NO_COMPILE,
  routeCompile,
  type CompileReceipt,
} from "../operations/compileRouting";
import { currentKnowledgeVersion } from "./knowledge";
import { materializeVaultMirror } from "./mirror";
import { BRAIN_SLOTS } from "./slots";
import { listNotes } from "./vault";

export type CompileDeps = {
  llm?: LLM;
  /** Runs after every no-op/validation exit and immediately before the LLM. */
  beforeExternalPhase?: () => Promise<void>;
};

/** Slots never used as compile FRAMING material: `avoid` is a runtime hard
 *  constraint (injected separately), `product` is the dropped legacy slot
 *  (product knowledge lives in the Products model) — Codex #5. */
const EXCLUDED_SLOTS: ReadonlySet<BrainSlot> = new Set(["avoid", "product"]);
/** A slot below this assessed confidence is too sparse/noisy to frame from. */
const MIN_SLOT_CONFIDENCE = 0.1;
/** Cap the knowledge fed to the compiler so a huge Brain can't blow the budget. */
const MAX_ANCHOR_ROWS = 40;
const MAX_KNOWLEDGE_CHARS = 6000;
/** What a lead-mode campaign's brief is framed by in place of a Goal, which it
 *  never reads: each draft follows its person's intent (`intentGate`). */
const LEAD_MODE_GOAL = {
  label: "Find leads",
  description: "How much each draft says about the product follows that person's intent.",
};

// ---------------------------------------------------------------- snapshot

type SlotGroup = { slot: BrainSlot; items: { id: number; content: string }[] };

type CompileSnapshot = {
  campaignId: number;
  /** read at snapshot time — the CAS guard for the write phase. */
  knowledgeVersion: number;
  fillScore: number;
  sourceHash: string;
  existing: CompiledBrief | null;
  // prompt inputs:
  objectiveLabel: string;
  objectiveDesc: string;
  angle: string;
  products: ProductContext[];
  knowledgeBySlot: SlotGroup[];
  // code-derived brief outputs (deterministic provenance):
  preferredSlots: BrainSlot[];
  anchorKnowledgeIds: number[];
};

/**
 * Read everything the brief is derived from inside ONE short tx, and compute the
 * `sourceHash`. Returns null if the campaign is gone. NOTE: reads the cached
 * `brain_state.slots` confidence — it does NOT re-run `assessBrain` (Codex: cheap,
 * and assess already ran at the mutation boundary).
 */
export async function snapshotInputs(
  tx: Tx,
  campaignId: number,
): Promise<CompileSnapshot | null> {
  // First, so the `brainState` read below and the `listNotes()` that feeds
  // `noteDigest`/`sourceHash` both see ONE materialized state.
  await materializeVaultMirror(tx);
  const [c] = await tx
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!c) return null;

  const meta = LEAD_MODE_GOAL;
  const angle = c.tone?.angle?.trim() ?? "";

  // The product in use: name + one-liner + the SAME prioritized facts slice
  // the runtime writer weaves in (Codex #4).
  const products = await loadCampaignProductContext(tx, campaignId, {});
  const productId = await campaignProductId(tx, campaignId);
  const productIds = productId === null ? [] : [productId];

  const [bs] = await tx.select().from(brainState);
  const knowledgeVersion = bs?.knowledgeVersion ?? 0;
  const fillScore = bs?.fillScore ?? 0;
  const slotConf = bs?.slots ?? null;

  // `listNotes` is created-desc with id-desc tiebreak — the same newest-first
  // order the table read guaranteed via `desc(knowledge.createdAt)`.
  const rows = (await listNotes()).map((note) => ({
    id: note.id,
    slot: note.slot,
    content: note.content,
  }));

  // Group by slot in canonical order, excluding avoid/product, gating sparse slots,
  // capping to a token budget. The included row ids become `anchorKnowledgeIds`.
  const knowledgeBySlot: SlotGroup[] = [];
  const anchorKnowledgeIds: number[] = [];
  let usedChars = 0;
  for (const s of BRAIN_SLOTS) {
    if (EXCLUDED_SLOTS.has(s.id)) continue;
    const conf = slotConf?.[s.id]?.confidence;
    if (slotConf && conf !== undefined && conf < MIN_SLOT_CONFIDENCE) continue;
    const items: { id: number; content: string }[] = [];
    for (const r of rows) {
      if (r.slot !== s.id) continue;
      if (anchorKnowledgeIds.length >= MAX_ANCHOR_ROWS) break;
      if (
        usedChars + r.content.length > MAX_KNOWLEDGE_CHARS &&
        anchorKnowledgeIds.length > 0
      )
        break;
      items.push({ id: r.id, content: r.content });
      anchorKnowledgeIds.push(r.id);
      usedChars += r.content.length;
    }
    if (items.length) knowledgeBySlot.push({ slot: s.id, items });
  }

  // preferredSlots: the slots we actually fed, best-covered first (drives the
  // runtime retrieval quota top-up). Deterministic — never the `avoid` slot.
  const preferredSlots = [...knowledgeBySlot]
    .sort(
      (a, b) =>
        (slotConf?.[b.slot]?.confidence ?? 0) -
        (slotConf?.[a.slot]?.confidence ?? 0),
    )
    .map((g) => g.slot);

  const nameOneLinerDigest = products
    .map((p) => `${p.name}|${p.oneLiner ?? ""}`)
    .join("¦");
  const factsDigest = products.map((p) => p.facts.join("·")).join("¦");
  // `knowledgeVersion` only moves through `bumpKnowledgeVersion` — an owner who
  // hand-edits a note file in the vault (INV-14 canonical) changes what the brief
  // is compiled FROM without moving that counter, so the version alone can't
  // detect it. Hash the active rows themselves (id+slot+content) alongside it.
  const noteDigest = rows.map((r) => `${r.id}:${r.slot}:${r.content}`).join("¦");
  const sourceHash = sha256(
    [
      "lead_mode",
      angle,
      productIds.join(","),
      nameOneLinerDigest,
      factsDigest,
      noteDigest,
      String(knowledgeVersion),
    ].join("\n§\n"),
  );

  return {
    campaignId,
    knowledgeVersion,
    fillScore,
    sourceHash,
    existing: c.compiledBrief ?? null,
    objectiveLabel: meta.label,
    objectiveDesc: meta.description,
    angle,
    products,
    knowledgeBySlot,
    preferredSlots,
    anchorKnowledgeIds,
  };
}

// ---------------------------------------------------------------- compile (LLM)

const COMPILE_SYSTEM = `You compile a CAMPAIGN FOCUS BRIEF: a short, neutral framing of what ONE LinkedIn engagement campaign is about, drawn from a person's own knowledge.

Write 120 words MAX (2-4 sentences) of plain prose that orients a writer to:
- the campaign's GOAL (given as descriptive context — do NOT infer permission to mention products or add a call-to-action from it)
- the topics and angle this person is genuinely credible on
- what their audience cares about

STRICT RULES (a violation makes the brief unusable):
- Framing ONLY. NEVER write imperative instructions to the writer ("write…", "make sure…", "you should…").
- NEVER include a call-to-action, a product pitch, or a product claim.
- NEVER restate voice, tone, or style rules.
- The personal ANGLE is shown to the writer separately — build around it, do NOT restate or quote it.

Output ONLY the brief prose — no preamble, no bullets, no headings.`;

// A brief that mentions selling/CTAs or barks instructions at the writer is
// rejected (validated, not just instructed — Codex #10/#11).
const CTA_RE =
  /\b(sign\s*up|subscribe|click|buy\s+(now|it|today)|book\s+a\s+(call|demo|meeting)|dm\s+me|message\s+me|check\s+(it|us|this)\s+out|link\s+in\s+bio|get\s+started|try\s+(it|us)\s+(free|today|now)|join\s+(now|today)|learn\s+more|reach\s+out)\b/i;
const IMPERATIVE_RE =
  /\b(make\s+sure|be\s+sure\s+to|remember\s+to|you\s+should|your\s+comment|write\s+a\s+comment|when\s+you\s+comment|don'?t\s+forget|be\s+sure)\b/i;
// A framing brief is third-person descriptive ("This campaign…", "The audience…",
// "<Name> is credible on…") — it never OPENS with a command verb. Reject a brief
// that barks an instruction at the writer from the first word. Erring toward
// rejection is safe: it cold-starts to the proven flat-retrieval path.
const LEADING_IMPERATIVE_RE =
  /^(write|emphasi[sz]e|highlight|mention|reference|focus|lean|position|frame|weave|anchor|stress|showcase|prioriti[sz]e|remember|ensure|avoid|use|keep|cent(er|re)|discuss|talk|bring|note|call|push|ground|draw|tie|connect|do|don'?t|make)\b/i;

export function sanitizeBrief(text: string): { ok: boolean; text: string } {
  const t = text.trim();
  if (!t) return { ok: false, text: "" };
  if (
    CTA_RE.test(t) ||
    IMPERATIVE_RE.test(t) ||
    LEADING_IMPERATIVE_RE.test(t)
  ) {
    return { ok: false, text: t };
  }
  return { ok: true, text: t };
}

function buildUser(snap: CompileSnapshot): string {
  const productBlock =
    snap.products.length > 0
      ? snap.products
          .map(
            (p) =>
              `- ${p.name}${p.oneLiner ? ` — ${p.oneLiner}` : ""}` +
              (p.facts.length
                ? `\n` + p.facts.map((f) => `    · ${f}`).join("\n")
                : ""),
          )
          .join("\n")
      : "(none)";
  const knowledgeBlock =
    snap.knowledgeBySlot.length > 0
      ? snap.knowledgeBySlot
          .map(
            (g) =>
              `[${g.slot}]\n` + g.items.map((i) => `- ${i.content}`).join("\n"),
          )
          .join("\n\n")
      : "(none)";

  return [
    `GOAL (descriptive only): ${snap.objectiveLabel} — ${snap.objectiveDesc}`,
    `PERSONAL ANGLE (shown to the writer separately — do NOT restate): ${snap.angle || "(none)"}`,
    `ATTACHED PRODUCTS (context — never pitch):\n${productBlock}`,
    untrusted("KNOWLEDGE BY SLOT", knowledgeBlock),
  ].join("\n\n");
}

/**
 * Produce the next `CompiledBrief` for a snapshot. Called OUTSIDE any tx — the
 * Haiku call must never run while a `withOrg` connection is held (133f979). On
 * LLM/sanitization failure it returns a `coldStart` brief with an empty
 * `sourceHash` so the next trigger retries (the deps changed, so keeping the now-
 * stale last-good brief is wrong — Codex #6). A campaign with nothing to frame
 * also cold-starts, but keeps the real `sourceHash` (no-op until material lands).
 */
async function computeBrief(
  snap: CompileSnapshot,
  deps: CompileDeps,
): Promise<CompiledBrief> {
  const compiledAt = Date.now();
  const base = { compiledAt, basedOnFillScore: snap.fillScore };
  const cold = (sourceHash: string): CompiledBrief => ({
    brief: "",
    preferredSlots: [],
    anchorKnowledgeIds: [],
    sourceHash,
    coldStart: true,
    ...base,
  });

  // Nothing campaign-specific to frame → cold start (writer reverts to flat
  // retrieval). Keep the real hash so it no-ops until inputs actually change.
  if (
    snap.knowledgeBySlot.length === 0 &&
    snap.products.length === 0 &&
    !snap.angle
  ) {
    return cold(snap.sourceHash);
  }

  await deps.beforeExternalPhase?.();
  const llm = deps.llm ?? getLLM();
  let prose: string;
  try {
    prose = await llm.text({
      model: modelFor("filter"),
      stage: "compile_brief",
      promptRef: promptRef("brain.compile"),
      system: COMPILE_SYSTEM,
      user: buildUser(snap),
      maxTokens: 400,
    });
  } catch {
    return cold(""); // transient failure → retry next trigger
  }

  const sanitized = sanitizeBrief(prose);
  if (!sanitized.ok) return cold(""); // non-compliant brief → retry, never inject it

  return {
    brief: sanitized.text,
    preferredSlots: snap.preferredSlots,
    anchorKnowledgeIds: snap.anchorKnowledgeIds,
    sourceHash: snap.sourceHash,
    coldStart: false,
    ...base,
  };
}

// ---------------------------------------------------------------- write (CAS)

/**
 * Persist the brief, but ONLY if this org's `knowledgeVersion` is unchanged since
 * the snapshot (compare-and-swap). If a newer knowledge mutation landed mid-compile,
 * a newer `compile_campaign` job is already queued for the new version, so this
 * (now-stale) write is discarded rather than clobbering it (Codex #7). Returns
 * whether the write happened.
 */
export async function writeCompiledBrief(
  tx: Tx,
  campaignId: number,
  snapshotVersion: number,
  brief: CompiledBrief,
): Promise<boolean> {
  const current = await currentKnowledgeVersion(tx);
  if (current !== snapshotVersion) return false; // a newer compile job will win
  await tx
    .update(campaigns)
    .set({ compiledBrief: brief, updatedAt: Date.now() })
    .where(eq(campaigns.id, campaignId));
  return true;
}

/**
 * Compile (or refresh) a campaign's focus brief. The CONNECTION DISCIPLINE is
 * load-bearing (133f979): snapshot deps in a SHORT read tx → release the `withOrg`
 * connection → call Haiku OUTSIDE any tx → re-enter a SHORT write tx with a
 * compare-and-swap. NEVER holds `withOrg` across the LLM call and NEVER needs a 2nd
 * connection, so it can't deadlock at `ENGAGER_PG_POOL_MAX=1`. The `compile_brief`
 * ai_usage spend is attributed by the worker's surrounding `withUsageContext` and
 * flushed after this returns (the txs are already closed).
 *
 * Idempotent: when the `sourceHash` is unchanged (deps identical) it no-ops and
 * keeps the existing brief — the "keep last-good ONLY if deps unchanged" rule.
 */
export async function compileCampaignBrief(
  organizationId: string,
  campaignId: number,
  deps: CompileDeps = {},
): Promise<void> {
  const snap = await withOrg(organizationId, (tx) =>
    snapshotInputs(tx, campaignId),
  );
  if (!snap) return; // campaign gone

  // No-op when deps are unchanged (keeps the last-good brief untouched). A prior
  // failure stored sourceHash="" which never matches a real hash → always retries.
  if (snap.existing && snap.existing.sourceHash === snap.sourceHash) return;

  const brief = await computeBrief(snap, deps); // LLM OUTSIDE any tx

  await withOrg(organizationId, (tx) =>
    writeCompiledBrief(tx, campaignId, snap.knowledgeVersion, brief),
  );
}

// ---------------------------------------------------------------- recompile enqueue

/**
 * Enqueue a recompile for ONE campaign (create/edit triggers). No idempotency key:
 * the cheap `sourceHash` no-op in the handler is the real guard against wasted
 * work, so a double form-submit just no-ops. Uses the caller's `tx` (the `withOrg`
 * connection) — never `baseDb` (133f979).
 */
export async function enqueueCompileForCampaign(
  tx: Tx,
  campaignId: number,
): Promise<void> {
  await enqueue(tx, { type: "compile_campaign", payload: { campaignId } });
}

/**
 * COARSE recompile: when the org's Brain changes (knowledgeVersion bumped), enqueue
 * a recompile for every NON-ARCHIVED campaign (active OR paused) at the batch boundary.
 * Paused is included on purpose: an onboarding campaign is created paused, and its brief
 * must reflect the Brain the moment it's seeded — otherwise the user sees a "0 Brain
 * sources / not enough info" brief until go-live. The dedupe key `compile:ver:<id>:<version>`
 * collapses the wave to one job per campaign per version; the `sourceHash` no-op then skips
 * campaigns whose inputs didn't actually change, so idle paused campaigns cost only a no-op.
 * (Supersedes targeted anchor-id invalidation — that can't fire for new/newly-relevant rows
 * and is inconsistent with an org-wide version.)
 */
export async function enqueueRecompileForCampaigns(tx: Tx): Promise<number> {
  const version = await currentKnowledgeVersion(tx);
  const active = await campaignsAwaitingRecompile(tx);
  for (const id of active) {
    await enqueue(tx, {
      type: "compile_campaign",
      payload: { campaignId: id },
      // `compile:ver:` namespace — never aliases the nightly `compile:nightly:`
      // daySlot key in the (permanent) jobs idempotency index.
      idempotencyKey: `compile:ver:${id}:${version}`,
    });
  }
  return active.length;
}

/**
 * WHICH targets a Brain change puts out of date — the selection above, asked
 * without writing.
 *
 * A caller that is not going to enqueue still owes the same answer: under the
 * external judgment policy the recompile is owed to the caller's own agent
 * rather than queued, and naming a brief as owed on an org that has no campaign
 * at all invents work. `save_product` answered exactly that —
 * `recompileEnqueued: true` against an empty job table.
 */
export async function campaignsAwaitingRecompile(tx: Tx): Promise<number[]> {
  const rows = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(ne(campaigns.status, "archived"));
  return rows.map((row) => row.id);
}

/**
 * Recompile the non-archived campaigns that have `productId` attached (product-fact
 * edits/deletes — product facts feed the brief but are NOT in `knowledgeVersion`,
 * so this can't use the version key; the `sourceHash` no-op guards waste). Includes
 * PAUSED campaigns, matching the knowledge-triggered wave above — onboarding
 * campaigns are paused, and a stale brief (possibly citing edited/deleted product
 * facts) surviving until reactivation was the asymmetry. Uses the caller's `tx`.
 */
export async function enqueueRecompileForProduct(
  tx: Tx,
  productId: number,
): Promise<number> {
  const links = await campaignsAwaitingProductRecompile(tx, productId);
  for (const campaignId of links) {
    await enqueue(tx, {
      type: "compile_campaign",
      payload: { campaignId },
    });
  }
  return links.length;
}

/** The product half of `campaignsAwaitingRecompile`: the non-archived targets
 *  this product's facts feed, asked without writing. */
export async function campaignsAwaitingProductRecompile(
  tx: Tx,
  productId: number,
): Promise<number[]> {
  const rows = await tx
    .select({ campaignId: campaignProducts.campaignId })
    .from(campaignProducts)
    .innerJoin(campaigns, eq(campaignProducts.campaignId, campaigns.id))
    .where(
      and(
        eq(campaignProducts.productId, productId),
        ne(campaigns.status, "archived"),
      ),
    );
  return rows.map((row) => row.campaignId);
}

/**
 * A vault write moved every non-archived campaign's brief.
 *
 * ROUTED, because `compile_campaign` is a job and a free install has nothing to
 * claim it: the row would sit `queued` forever behind a `recompileEnqueued:
 * true` that says the brief is being taken care of. A write that changed no row
 * routes nothing and says nothing: `mode` would be a claim about a compile that
 * never happened, and resolving a policy to make one is work for no reader.
 */
export async function compileForVault(
  tx: Tx,
  organizationId: string,
  changed: boolean,
): Promise<CompileReceipt> {
  if (!changed) return NO_COMPILE;
  return compileFields(
    await routeCompile(tx, organizationId, { kind: "brain" }),
  );
}
