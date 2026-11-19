import { eq, sql } from "drizzle-orm";
import type { Tx } from "@engager/database/tenant";
import { z } from "zod";
import {
  brainQuestions,
  brainState,
  type BrainSlot,
} from "@engager/database/schema";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { sha256, untrusted } from "../ai/prompts";
import {
  persistBrainAssessment,
  prepareBrainAssessment,
  type BrainAssessmentKnowledge,
} from "./assess";
import { enqueueRecompileForCampaigns } from "./compile";
import { syncVaultMirror, vaultReplicaEnabled } from "./mirror";
import { storeKnowledge, type KnowledgeSource } from "./knowledge";
import { lockBrainMutation } from "./mutationLock";
import {
  applyPreparedQueueRefill,
  prepareQueueRefill,
} from "./questions";
import { BRAIN_SLOTS } from "./slots";
import { archiveNote, listNotes } from "./vault";
import { deferTask } from "../tasks/judgment";

const SLOT_IDS = BRAIN_SLOTS.map((s) => s.id) as [BrainSlot, ...BrainSlot[]];

/** What one chunk's extraction may write back. The real bound on a chunk: it
 *  has to hold every fact a `chunkBackground()` chunk carries, so the two move
 *  together — a wider chunk with the old 4096 would silently truncate the tail
 *  of a long post's facts rather than fail. */
const SEED_MAX_OUTPUT_TOKENS = 8192;

const SeedSchema = z.object({
  items: z
    .array(
      z.object({
        slot: z.enum(SLOT_IDS),
        // A short (2-5 word) human title for the document; optional — the UI
        // derives one from the content when it's absent.
        title: z.string().max(200).optional(),
        content: z.string().min(1).max(20_000),
      }),
    )
    .max(100),
});

/** `StartTask`'s `sourceText` bound, minus headroom for the envelope. */
const MAX_DEFERRED_CORPUS_CHARS = 60_000;

export type BrainOrgScope = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

export type BackgroundSeedOpts = {
  llm?: LLM;
  source?: KnowledgeSource;
  /** When set, archive this source's existing notes with the first usable replacement chunk. */
  replaceSource?: KnowledgeSource;
  /** WHERE these bytes came from — `linkedin:<account>`, `url:<host>`,
   *  `file:<absolute path>`, `text:<attribution>`. Stamped on every note this
   *  seed writes, in both modes, so a reader can go back to the source rather
   *  than take the note on trust. */
  sourcePath?: string;
  /** Runs immediately before each LLM call. */
  beforeExternalPhase?: () => Promise<void>;
  /** Runs after provider preparation and immediately before each DB apply. */
  beforeApplyPhase?: () => Promise<void>;
};

function seedSystemPrompt(): string {
  return `You process a brain seed: split a person's free-text background into discrete, atomic facts and assign each to ONE of ${BRAIN_SLOTS.length} fixed context slots used to write LinkedIn engagement in their voice.

Slots:
${BRAIN_SLOTS.map((s) => `- ${s.id}: ${s.description}`).join("\n")}

Emit one item per distinct fact. Give each a short (2-5 word) title and keep its content self-contained (it will be stored on its own). Do not invent facts not present in the text.`;
}

/**
 * Move every active note carrying `source` into `4-archive/` — one version
 * bump per archived note (a vanished fact must invalidate briefs that cited
 * it), then ONE coarse recompile wave at the batch boundary. DB+vault only,
 * no provider work, so the org scope here is short by construction.
 *
 * Exported for the prepared `brain_notes` task, whose replacement is available
 * only once the owner's agent submits. The background seed waits for its first
 * usable extracted chunk. Both archive in the replacement's apply transaction,
 * so failed inference or a task never submitted leaves the previous seed intact.
 */
export async function archiveSourceInTx(
  tx: Tx,
  source: KnowledgeSource,
): Promise<boolean> {
  await lockBrainMutation(tx);
  const replaced = (await listNotes()).filter((note) => note.source === source);
  let changed = false;
  for (const note of replaced) {
    const result = await archiveNote(note.id);
    if (!result.changed) continue;
    changed = true;
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
  if (changed) await enqueueRecompileForCampaigns(tx);
  // Same boundary, one sync for every note this pass archived.
  if (changed && vaultReplicaEnabled()) await syncVaultMirror(tx);
  return changed;
}

/**
 * Incremental, write-through seed orchestration. Each `chunkBackground()`
 * chunk is extracted by ONE provider call and written into the vault
 * immediately after: a short org scope stores the chunk's facts via
 * `storeKnowledge`, so the version bump and the coarse recompile wave happen
 * per batch boundary. A chunk's LLM failure or timeout stops the loop but
 * keeps every prior chunk's notes — a timeout truncates a seed instead of
 * zeroing it. Coverage assessment and question refill run best-effort AFTER
 * whatever landed, never blocking the stored facts, and the chunk error then
 * surfaces to the caller.
 */
export async function seedBackgroundPhased(
  orgScope: BrainOrgScope,
  text: string,
  opts: BackgroundSeedOpts = {},
): Promise<void> {
  // BEFORE the archive, and before a single chunk is extracted. Under the
  // external-judgment policy every phase below this line is a model call, and
  // the corpus is already in hand: hand it over as one `brain_notes` task and
  // leave the vault exactly as it was. Archiving first would delete the
  // previous seed's notes in exchange for nothing — the owner's agent has not
  // submitted the replacement yet, and may never.
  //
  // The tagging and the replacement travel WITH the corpus, so the task's
  // apply is the same seed this function would have written: notes carry this
  // seed's `source`, and `replaceSource` archives at the moment the
  // replacement actually lands. Without them an in-session re-seed piled
  // `manual` notes beside the old `linkedin` ones and every reader keyed on
  // the source missed the newer facts entirely.
  if (
    deferTask({
      kind: "brain_notes",
      sourceText: text.slice(0, MAX_DEFERRED_CORPUS_CHARS),
      intent: {
        knowledgeSource: opts.source ?? "interview",
        ...(opts.replaceSource ? { replaceSource: opts.replaceSource } : {}),
        ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}),
      },
    })
  )
    return;

  const llm = opts.llm ?? getLLM();
  const source = opts.source ?? "interview";

  if (opts.replaceSource) {
    await opts.beforeApplyPhase?.();
  }

  const seen = new Set<string>();
  let replaced = false;
  let chunkError: unknown = null;
  try {
    for (const chunk of chunkBackground(text)) {
      await opts.beforeExternalPhase?.();
      const out = await llm.json({
        model: modelFor("filter"),
        stage: "brain.seed",
        promptRef: promptRef("brain.seed"),
        system: seedSystemPrompt(),
        user: untrusted("BACKGROUND", chunk),
        schema: SeedSchema,
        maxTokens: SEED_MAX_OUTPUT_TOKENS,
      });

      const items: { slot: BrainSlot; title?: string; content: string }[] = [];
      for (const item of out.items) {
        const content = item.content.trim();
        if (!content) continue;
        const contentHash = sha256(content);
        if (seen.has(contentHash)) continue;
        seen.add(contentHash);
        items.push({
          slot: item.slot,
          title: item.title?.trim() || undefined,
          content,
        });
      }

      if (items.length === 0) continue;
      await opts.beforeApplyPhase?.();
      await orgScope(async (tx) => {
        await lockBrainMutation(tx);
        if (opts.replaceSource && !replaced) await archiveSourceInTx(tx, opts.replaceSource);
        let changed = false;
        for (const item of items) {
          const result = await storeKnowledge(tx, {
            slot: item.slot,
            title: item.title,
            content: item.content,
            source,
            ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}),
          });
          changed = changed || result.changed;
        }
        if (changed) await enqueueRecompileForCampaigns(tx);
        // One sync per CHUNK, not per fact: a chunk that fails mid-seed keeps
        // its predecessors' rows, matching what the phased seed already
        // promises of the notes themselves.
        if (changed && vaultReplicaEnabled()) await syncVaultMirror(tx);
      });
      replaced = true;
    }
  } catch (error) {
    chunkError = error;
  }

  // Best-effort tail: re-score coverage on whatever landed and top the
  // interview queue back up. A failure here must never block the stored
  // facts or mask a chunk error.
  try {
    const knowledge: BrainAssessmentKnowledge[] = (await listNotes()).map(
      (note) => ({ slot: note.slot, content: note.content }),
    );
    const assessment = await prepareBrainAssessment(knowledge, {
      llm,
      beforeExternalPhase: opts.beforeExternalPhase,
    });
    const questions = await orgScope(async (tx) => {
      const pending = await tx
        .select({ id: brainQuestions.id })
        .from(brainQuestions)
        .where(eq(brainQuestions.status, "pending"));
      const existing = await tx
        .select({ question: brainQuestions.question })
        .from(brainQuestions);
      return {
        pendingCount: pending.length,
        existingQuestions: existing.map((row) => row.question),
      };
    });
    const refill = await prepareQueueRefill(
      { ...questions, slots: assessment.slots },
      { llm, beforeExternalPhase: opts.beforeExternalPhase },
    );
    await opts.beforeApplyPhase?.();
    await orgScope(async (tx) => {
      await lockBrainMutation(tx);
      await persistBrainAssessment(tx, assessment);
      await applyPreparedQueueRefill(tx, refill);
    });
  } catch {
    /* best-effort — the stored facts stay; coverage and the queue just lag */
  }

  if (chunkError !== null) throw chunkError;
}

/**
 * Split a background blurb into chunks small enough that one chunk's fact
 * extraction can't overflow the output-token budget. Packs whole paragraphs up
 * to `maxChars`, hard-splitting any single paragraph that alone exceeds it.
 * Always returns at least one chunk.
 *
 * `maxChars` is sized against WHAT A CHUNK COSTS, and on this runtime a chunk
 * is a process: every extraction call spawns the owner's agent CLI (see
 * `ai/agentCli/run.ts`), so the per-chunk floor is a CLI boot rather than an
 * HTTP round trip. Measured on Haiku 4.5, a 4.5k-char chunk takes ~19s almost
 * regardless of its size — which made a 25-post LinkedIn corpus ten spawns and
 * over three minutes of a seed that has a chat turn waiting on it. 16k chars
 * is ~4k input tokens: a quarter of the spawns for the same corpus, still an
 * eighth of Haiku's context, and still comfortably under the extraction budget
 * (`SEED_MAX_OUTPUT_TOKENS`), which is what actually bounds a chunk's answer.
 */
export function chunkBackground(text: string, maxChars = 16_000): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) chunks.push(buf);
    buf = "";
  };

  for (const para of paras) {
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }
    if (buf && buf.length + para.length + 2 > maxChars) flush();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();

  return chunks.length ? chunks : [text.trim()];
}
