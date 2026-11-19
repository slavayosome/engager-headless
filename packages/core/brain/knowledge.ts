import { sql } from "drizzle-orm";
import {
  brainState,
  type BrainSlot,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { sha256 } from "../ai/prompts";
import { materializeVaultMirror, syncVaultMirror, vaultReplicaEnabled } from "./mirror";
import { lockBrainMutation } from "./mutationLock";
import { enqueueRecompileForCampaigns } from "./compile";
import {
  archiveNote,
  listNotes,
  updateNote,
  writeNote,
  type VaultNote,
  type VaultNotePatch,
} from "./vault";

export type KnowledgeSource = "obsidian" | "interview" | "manual" | "linkedin" | "learned";

/**
 * The result of a knowledge mutation. `changed` is true only when a note was
 * actually written / edited / archived — a content-hash duplicate, a blank-content
 * edit, or an empty patch all report `changed:false` so they do NOT bump
 * `knowledgeVersion` (Codex #9). Callers aggregate `changed` across a batch
 * (seed/answer/edit) and enqueue ONE coarse recompile wave at the batch boundary.
 */
export type KnowledgeMutation = { changed: boolean; changedIds: number[] };

const NO_CHANGE: KnowledgeMutation = { changed: false, changedIds: [] };

/**
 * Bump this org's monotonic `knowledgeVersion` (upsert — the `brain_state` row may
 * not exist on the first knowledge write). Called only when a mutation actually
 * changed a note. Uses the caller's `tx` (the `withOrg` connection) — NEVER a 2nd
 * connection / `baseDb`, which would deadlock at `ENGAGER_PG_POOL_MAX=1` (133f979).
 */
async function bumpKnowledgeVersion(tx: Tx): Promise<void> {
  await tx
    .insert(brainState)
    .values({ knowledgeVersion: 1 })
    .onConflictDoUpdate({
      target: brainState.organizationId,
      set: {
        knowledgeVersion: sql`${brainState.knowledgeVersion} + 1`,
        updatedAt: Date.now(),
      },
    });
}

/** Read this org's current `knowledgeVersion` (0 when no `brain_state` row yet). */
export async function currentKnowledgeVersion(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ v: brainState.knowledgeVersion })
    .from(brainState);
  return row?.v ?? 0;
}

export type StoreKnowledgeInput = {
  slot: BrainSlot;
  title?: string;
  content: string;
  tags?: string[];
  source: KnowledgeSource;
  sourcePath?: string;
};

/** The interactive note mutation shared by surfaces. */
export async function saveNote(
  tx: Tx,
  input: { id?: number; slot?: BrainSlot; title?: string | null; content?: string; tags?: string[] },
): Promise<KnowledgeMutation> {
  await lockBrainMutation(tx);
  const result = input.id !== undefined
    ? await updateKnowledge(tx, input.id, { slot: input.slot, title: input.title, content: input.content, tags: input.tags })
    : input.slot && input.content
      ? await storeKnowledge(tx, { slot: input.slot, title: input.title ?? undefined, content: input.content, tags: input.tags, source: "manual" })
      : (() => { throw new Error("A new note needs a slot and content."); })();
  if (result.changed) {
    await enqueueRecompileForCampaigns(tx);
    if (vaultReplicaEnabled()) await syncVaultMirror(tx);
  }
  return result;
}

export async function removeNote(tx: Tx, id: number): Promise<KnowledgeMutation> {
  await lockBrainMutation(tx);
  const result = await deleteKnowledge(tx, id);
  if (result.changed) {
    await enqueueRecompileForCampaigns(tx);
    if (vaultReplicaEnabled()) await syncVaultMirror(tx);
  }
  return result;
}

/**
 * Store one piece of knowledge for the current org. Dedupes on the sha256 content
 * hash — re-storing identical content is a no-op, which is what makes re-syncs
 * idempotent (and reports `changed:false`, so it does NOT bump the version).
 */
export async function storeKnowledge(
  tx: Tx,
  input: StoreKnowledgeInput,
): Promise<KnowledgeMutation> {
  const content = input.content.trim();
  if (!content) return NO_CHANGE;
  const contentHash = sha256(content);

  // Resolve the dedupe hash ourselves, ahead of any mutation, so the version
  // bump — the DB work that can fail — runs BEFORE the vault write, not
  // after. This closes only the window internal to this call: bumping first
  // means bumpKnowledgeVersion itself throwing can no longer leave an
  // already-written note behind an unbumped, rolled-back version. It does NOT
  // close the wider window every caller still has — seed.ts, mcp/v2/knowledge/voiceBrain.ts,
  // and answer.ts all do more `tx` work (enqueue recompile, question refill)
  // AFTER storeKnowledge returns, and a throw there still rolls back this
  // bump while the note stays in the active vault set (fs writes are not
  // covered by the transaction). Closing that needs the write itself covered
  // by the transaction, which is out of scope here — the residual is
  // accepted, not fixed.
  for (const note of await listNotes()) {
    if (sha256(note.content) === contentHash) return NO_CHANGE; // duplicate — no-op, no version bump
  }

  await bumpKnowledgeVersion(tx);
  const result = await writeNote({
    slot: input.slot,
    title: input.title,
    content,
    tags: input.tags,
    source: input.source,
    sourcePath: input.sourcePath,
  });

  if (!result.changed || result.id == null) return NO_CHANGE; // raced onto a duplicate after the bump
  return { changed: true, changedIds: [result.id] };
}

export type UpdateKnowledgeInput = {
  slot?: BrainSlot;
  title?: string | null;
  tags?: string[] | null;
  content?: string;
};

/**
 * Edit one knowledge note by its vault id. Changing `content` recomputes the
 * dedupe hash. A blank content edit is ignored rather than erasing the fact. If
 * the new content collapses onto another existing note (same hash), this note is
 * archived so the canonical fact stands — instead of keeping two notes with
 * identical bodies.
 *
 * Returns `changed:true` whenever a note is actually mutated OR archived —
 * INCLUDING the collapse-delete path (a vanished fact must bump the version so
 * briefs that cited it get recompiled; this is the REGRESSION-flagged path,
 * Codex #9).
 */
export async function updateKnowledge(
  tx: Tx,
  id: number,
  input: UpdateKnowledgeInput,
): Promise<KnowledgeMutation> {
  const patch: VaultNotePatch = {};
  if (input.slot !== undefined) patch.slot = input.slot;
  if (input.title !== undefined) patch.title = input.title;
  if (input.tags !== undefined) patch.tags = input.tags;

  let content: string | undefined;
  if (input.content !== undefined) {
    content = input.content.trim();
    if (!content) return NO_CHANGE; // refuse to blank out a fact
    patch.content = content;
  }

  if (Object.keys(patch).length === 0) return NO_CHANGE; // empty patch — no-op

  if (content !== undefined) {
    const contentHash = sha256(content);
    for (const note of await listNotes()) {
      if (note.id === id) continue;
      if (sha256(note.content) !== contentHash) continue;
      // Collapse onto the canonical note: this note vanishes from the active
      // set. A brief may cite it, so this MUST bump the version (regression-
      // critical) — but only if the note actually existed. Archived, not
      // removed: the fs move is not covered by `tx`, so if the bump (or
      // anything later in this transaction) throws and rolls back, the note
      // must still be recoverable from `4-archive/` rather than gone for good.
      const archived = await archiveNote(id);
      if (!archived.changed || archived.id == null) return NO_CHANGE;
      await bumpKnowledgeVersion(tx);
      return { changed: true, changedIds: [archived.id] };
    }
  }

  const updated = await updateNote(id, patch);
  if (!updated.changed || updated.id == null) return NO_CHANGE; // id absent or unchanged — no-op
  await bumpKnowledgeVersion(tx);
  return { changed: true, changedIds: [updated.id] };
}

export type RetrievedKnowledge = {
  slot: BrainSlot;
  title: string | null;
  content: string;
};

/**
 * Soft preference for slot-aware retrieval. `avoid` is handled separately (always
 * hard-included, never similarity-ranked); `preferredSlots` get a small per-slot
 * quota topped up from the ranked tail so the campaign's well-covered facets stay
 * represented without a hard `WHERE` that would starve the diversity gate / recency
 * fallback.
 */
export type SlotPolicy = {
  preferredSlots?: BrainSlot[];
  /** Rows guaranteed per preferred slot (default 2). */
  quotaPerSlot?: number;
};

/**
 * The row shape callers destructure off knowledge reads — mapped from vault notes
 * (`id` is the frontmatter id; `createdAt` the frontmatter `created` timestamp;
 * `updatedAt` the file mtime, since frontmatter carries no updated field).
 */
export type KnowledgeRow = {
  id: number;
  slot: BrainSlot;
  title: string | null;
  content: string;
  tags: string[] | null;
  source: KnowledgeSource;
  sourcePath: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * Immutable DB-side input for relevance ranking. Keeping the selected notes as a
 * plain value lets cost-bearing callers release their tenant transaction before
 * LLM reranking starts.
 */
export type KnowledgeRetrievalSnapshot = readonly KnowledgeRow[];

/** Map a vault note onto the row shape readers destructure. */
function toRow(note: VaultNote): KnowledgeRow {
  return {
    id: note.id,
    slot: note.slot,
    title: note.title ?? null,
    content: note.content,
    tags: note.tags ?? null,
    source: note.source as KnowledgeSource,
    sourcePath: note.sourcePath ?? null,
    createdAt: Date.parse(note.created),
    updatedAt: note.updatedAt,
  };
}

/**
 * Retrieve the most relevant knowledge for a query.
 *
 * Every `avoid` note is ALWAYS included as a hard constraint, on EVERY path —
 * never ranked (a "never touch X" must never be dropped), and never dependent
 * on brief state: a transient compile failure or the brief kill switch must not
 * un-fence forbidden topics. The rest are ranked by word overlap, with recency
 * breaking ties, into the global
 * top-k, then the `slotPolicy.preferredSlots` (if any) are topped up to their
 * per-slot quota — with no preferred slots the top-up is a no-op and this
 * degrades to the flat top-k over non-avoid notes.
 */
export async function retrieveKnowledge(
  tx: Tx,
  opts: {
    queryText: string;
    k?: number;
    slotPolicy?: SlotPolicy;
  },
): Promise<RetrievedKnowledge[]> {
  const rows = await prepareKnowledgeRetrieval(tx);
  return retrieveKnowledgeFromSnapshot(rows, opts);
}

/**
 * Vault-only half of knowledge retrieval. No model can run here.
 *
 * It takes a `tx` for exactly one reason: on a replica the files are the rows'
 * derivative, so the vault has to be brought to the mirror's version before it
 * is read. `draft.ts` reaches this on every draft — it is the writer's path.
 */
export async function prepareKnowledgeRetrieval(
  tx: Tx,
): Promise<KnowledgeRetrievalSnapshot> {
  await materializeVaultMirror(tx);
  const notes = await listNotes();
  return notes.map(toRow);
}

/**
 * Provider-capable half of knowledge retrieval. It consumes only detached data,
 * so relevance reranking never retains a database connection.
 */
export async function retrieveKnowledgeFromSnapshot(
  rows: KnowledgeRetrievalSnapshot,
  opts: {
    queryText: string;
    k?: number;
    slotPolicy?: SlotPolicy;
  },
): Promise<RetrievedKnowledge[]> {
  const k = opts.k ?? 4;
  if (rows.length === 0) return [];

  const toResult = (r: KnowledgeRow): RetrievedKnowledge => ({
    slot: r.slot,
    title: r.title,
    content: r.content,
  });

  const avoidRows = rows.filter((r) => r.slot === "avoid");
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const query = words(opts.queryText);
  const score = (r: KnowledgeRow) => [...words(`${r.title ?? ""} ${r.content} ${(r.tags ?? []).join(" ")}`)]
    .filter((word) => query.has(word)).length;
  const others = rows.filter((r) => r.slot !== "avoid")
    .sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt);

  const result: KnowledgeRow[] = others.slice(0, k);
  const seen = new Set(result.map((r) => r.id));
  const quota = opts.slotPolicy?.quotaPerSlot ?? 2;
  for (const slot of opts.slotPolicy?.preferredSlots ?? []) {
    if (slot === "avoid") continue; // avoid is hard-included, never "preferred"
    let have = result.filter((r) => r.slot === slot).length;
    if (have >= quota) continue;
    for (const r of others) {
      if (r.slot !== slot || seen.has(r.id)) continue;
      result.push(r);
      seen.add(r.id);
      if (++have >= quota) break;
    }
  }

  // avoid first (hard constraints), then the ranked, topped-up material.
  return [...avoidRows, ...result].map(toResult);
}

/** All knowledge notes for the current org (most recent first). */
export async function listKnowledge(tx: Tx): Promise<KnowledgeRow[]> {
  const notes = await listNotes();
  return notes.map(toRow);
}

/**
 * Delete one knowledge note by its vault id. Reports `changed:true` only when a
 * note was actually archived, and bumps the version so a brief that cited the
 * now-deleted fact gets recompiled. Archives rather than hard-removes — see
 * `updateKnowledge`'s collapse-delete path — so a rollback after the fs move
 * (the bump throwing, or anything later in the caller's `withOrg` transaction)
 * leaves the note recoverable from `4-archive/` instead of gone for good.
 */
export async function deleteKnowledge(
  tx: Tx,
  id: number,
): Promise<KnowledgeMutation> {
  const archived = await archiveNote(id);
  if (!archived.changed || archived.id == null) return NO_CHANGE;
  await bumpKnowledgeVersion(tx);
  return { changed: true, changedIds: [archived.id] };
}
