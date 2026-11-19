import { eq, sql } from "drizzle-orm";
import {
  campaigns,
  voices,
  type DraftingKnobs,
  type LearnedEditKind,
  type StyleRules,
  type SurfaceProposal,
  type Voice,
  type VoiceExample,
  type VoiceExampleOrigin,
  type VoiceSurfaceKey,
  type VoicesMap,
  type VoiceTraits,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  avoidWordList,
  DEFAULT_STYLE_RULES,
  ruleLines,
  ruleProvenance,
  TEMPLATE_RULE_KEYS,
} from "../ai/styleRules";
import { campaignsAwaitingRecompile, enqueueCompileForCampaign } from "../brain/compile";
import { refreshLearnedDirectives } from "../learning/editSignals";
import { snapshotVoiceRevision } from "../learning/voiceRevisions";
import { setChannelVoice } from "../profile";
import { campaignIdsUsingVoice, ensureDefaultVoice, followsComment, type WritingChannel } from "../voice";
import {
  exampleKey,
  examplesFields,
  plainExample,
  voiceExamples,
  VOICE_EXAMPLE_CAP,
  type ExampleChannel,
} from "../voice/examples";
import { disabledEditKey } from "../voice/habits";
import { voiceCalled, voiceNameKey, voiceNameTakenWords } from "../voice/names";

export { exampleKey, VOICE_EXAMPLE_CAP };

/**
 * Voice CRUD (shared by the dashboard server actions and the MCP voice tools,
 * pattern: operations/products.ts). All run inside the caller's org scope —
 * RLS isolates tenants.
 */

export type VoiceInput = {
  name?: string;
  description?: string | null;
  language?: string | null;
  /** Per-field patch: a key present with an explicit null CLEARS the field back
   *  to "inherit template"; an absent key is left untouched. `traits` patches
   *  per trait the same way — a null trait goes back to what the owner's own
   *  comments show — `traitsByChannel` per channel and per trait, a null
   *  channel handing every trait of it back, and `knobs` per knob, a null one
   *  back to its default. */
  styleRules?: Partial<StyleRules>;
};

type ChannelTraits = NonNullable<StyleRules["traitsByChannel"]>;

/** Per-key merge of an object the owner sets key by key — the traits they
 *  set, the knobs they turn: a null key is cleared back to what it would be
 *  unset (measured, or the default); an absent key is left as it was. Null
 *  when none are left set. */
function mergeKeys<T extends VoiceTraits | DraftingKnobs>(
  current: T | null | undefined,
  patch: T | null,
): T | null {
  if (patch === null) return null;
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return Object.keys(next).length > 0 ? (next as T) : null;
}

export async function listVoices(tx: Tx): Promise<Voice[]> {
  return tx.select().from(voices).orderBy(voices.id);
}

export async function getVoice(tx: Tx, id: number): Promise<Voice | null> {
  const [row] = await tx.select().from(voices).where(eq(voices.id, id));
  return row ?? null;
}

/** A create or a rename to a name another of the org's voices already has. */
export class VoiceNameTakenError extends Error {
  readonly code = "duplicate_name";
  constructor(
    name: string,
    /** The voice that has it. */
    readonly existingId: number,
  ) {
    super(voiceNameTakenWords(name));
    this.name = "VoiceNameTakenError";
  }
}

/** The org's voice already called `name` (`voiceNameKey`), other than
 *  `exceptId`; null when none is. */
export async function voiceNameTaken(
  tx: Tx,
  name: string,
  exceptId?: number,
): Promise<Pick<Voice, "id" | "name"> | null> {
  const rows = await tx.select({ id: voices.id, name: voices.name }).from(voices);
  return voiceCalled(rows, name, exceptId);
}

/** A voice's descriptions without what a relearn proposed beside them: a
 *  proposal was read from that voice's own comments, and waits for Keep or
 *  Drop there. */
function withoutProposals(channels: VoicesMap): VoicesMap {
  const copied: VoicesMap = {};
  for (const [surface, words] of Object.entries(channels)) {
    if (!words) continue;
    const { proposed: _proposed, ...kept } = words;
    copied[surface] = kept;
  }
  return copied;
}

/** Create a voice; `cloneFromId` copies register + channels + range from an
 *  existing voice (createdFrom:"cloned", soft ref survives source deletion),
 *  and never what it learned from samples or edits, or a proposal waiting on
 *  it. A name another voice has is refused (`VoiceNameTakenError`). */
export async function createVoice(
  tx: Tx,
  input: VoiceInput & { cloneFromId?: number },
): Promise<Voice> {
  let base: Voice | null = null;
  if (input.cloneFromId != null) {
    base = await getVoice(tx, input.cloneFromId);
    if (!base) throw new Error(`voice ${input.cloneFromId} not found to clone`);
  }
  const name = input.name?.trim() || (base ? `${base.name} (copy)` : "Untitled voice");
  const taken = await voiceNameTaken(tx, name);
  if (taken) throw new VoiceNameTakenError(name, taken.id);
  const [row] = await tx
    .insert(voices)
    .values({
      name,
      description: input.description?.trim() || base?.description || null,
      language: input.language?.trim() || base?.language || null,
      isDefault: false,
      channels: base?.channels ? withoutProposals(base.channels) : null,
      styleRules: mergeStyleRules(base?.styleRules ?? null, input.styleRules, "owner"),
      structuralRange: base?.structuralRange ?? null,
      createdFrom: base ? "cloned" : "manual",
      clonedFromId: base?.id ?? null,
      card: base?.card ?? null,
    })
    .returning();
  return row!;
}

/** Who wrote a set of register fields. */
type RuleAuthor = "owner" | "learned";

/** The authors of a voice's register fields after a write by `by`: each
 *  field it set stamped with its author, each it handed back to Engager's
 *  start left with none. Null when no field has one. */
function stampProvenance(
  current: StyleRules["provenance"],
  patch: Partial<StyleRules>,
  by: RuleAuthor,
): StyleRules["provenance"] {
  const next = { ...(current ?? {}) };
  for (const key of TEMPLATE_RULE_KEYS) {
    const value = patch[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = by;
  }
  return Object.keys(next).length > 0 ? next : null;
}

/** Shallow per-field merge: explicit null clears to inherit; undefined keeps.
 *  `by` stamps who set the register fields it writes (`provenance`), which is
 *  never taken from the patch itself. */
export function mergeStyleRules(
  current: StyleRules | null,
  patch: Partial<StyleRules> | undefined,
  by?: RuleAuthor,
): StyleRules | null {
  if (!patch) return current;
  const empty: StyleRules = {
    emDashes: null,
    semicolons: null,
    emojiMax: null,
    casing: null,
    bannedOpeners: null,
    closerQuestionPolicy: null,
    shorthand: null,
    roughEdges: null,
    extras: null,
  };
  const base = current ?? empty;
  const next = { ...empty, ...base };
  for (const key of Object.keys(patch) as (keyof StyleRules)[]) {
    const v = patch[key];
    if (v !== undefined) (next as Record<string, unknown>)[key] = v;
  }
  if (patch.examples !== undefined && patch.exampleItems === undefined) {
    // A writer that knows only Comment's words — `save_voice`, or an
    // older release's — replaces those alone: each keeps what the voice knew
    // of it, its pin among them, and the other channels' stay as they were.
    const kept = voiceExamples(base);
    const comments = (patch.examples ?? []).map((text) => {
      const known = kept.find((example) => example.channel === "comment" && exampleKey(example.text) === exampleKey(text));
      return known ? { ...known, text } : plainExample(text);
    });
    Object.assign(next, examplesFields([...comments, ...kept.filter((example) => example.channel !== "comment")]));
  }
  if (patch.traits !== undefined) next.traits = mergeKeys(base.traits, patch.traits);
  if (patch.traitsByChannel !== undefined) {
    next.traitsByChannel = mergeChannelTraits(base.traitsByChannel, patch.traitsByChannel);
  }
  if (patch.knobs !== undefined) next.knobs = mergeKeys(base.knobs, patch.knobs);
  // What the owner says is stored as they said it, less the edges: a blank
  // is no value, and the same never-used word twice is one.
  if (patch.ownWords !== undefined) next.ownWords = patch.ownWords?.trim() || null;
  if (patch.writesTo !== undefined) next.writesTo = patch.writesTo?.trim() || null;
  if (patch.avoidWords !== undefined) {
    const words = avoidWordList(patch.avoidWords ?? []);
    next.avoidWords = words.length > 0 ? words : null;
  }
  const provenance = by ? stampProvenance(base.provenance, patch, by) : base.provenance;
  if (provenance) next.provenance = provenance;
  else delete next.provenance;
  return next;
}

/** Per-channel merge of the traits set for replies and DMs: each channel's
 *  set patched trait by trait (`mergeKeys`), a null channel handed back
 *  whole. */
function mergeChannelTraits(
  current: StyleRules["traitsByChannel"],
  patch: StyleRules["traitsByChannel"],
): ChannelTraits | null {
  if (patch === null) return null;
  const next: ChannelTraits = { ...(current ?? {}) };
  for (const channel of ["reply", "dm"] as const) {
    const traits = patch?.[channel];
    if (traits !== undefined) next[channel] = mergeKeys(current?.[channel], traits);
  }
  return next;
}

/**
 * The traits each channel already holds, made its own the first time a trait
 * is set on a voice whose channels were never split, so splitting them
 * changes nothing a draft is held to: a channel with texts enough of its own
 * keeps Comment's set as its own, and one that follows Comment takes
 * Comment's while it does (`channelOwnerSets`). Null for a voice already
 * split.
 */
async function splitChannelTraits(tx: Tx, row: Voice): Promise<ChannelTraits | null> {
  if (row.styleRules?.traitsByChannel != null) return null;
  const comment = row.styleRules?.traits ?? null;
  return {
    reply: (await followsComment(tx, row, "reply")) ? null : comment,
    dm: (await followsComment(tx, row, "dm")) ? null : comment,
  };
}

export async function updateVoice(
  tx: Tx,
  id: number,
  input: VoiceInput,
): Promise<void> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  const patch: Partial<typeof voices.$inferInsert> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name.trim() || row.name;
  // A rename only: a name kept as it was stays, even where an older voice
  // shares it.
  if (patch.name !== undefined && voiceNameKey(patch.name) !== voiceNameKey(row.name)) {
    const taken = await voiceNameTaken(tx, patch.name, id);
    if (taken) throw new VoiceNameTakenError(patch.name, taken.id);
  }
  if (input.description !== undefined)
    patch.description = input.description?.trim() || null;
  if (input.language !== undefined)
    patch.language = input.language?.trim() || null;
  if (input.styleRules !== undefined) {
    // A trait set on one channel applies to that channel only, so the first
    // one splits the channels before it lands.
    const sets =
      input.styleRules.traits !== undefined || input.styleRules.traitsByChannel !== undefined;
    const split = sets ? await splitChannelTraits(tx, row) : null;
    const current = split ? mergeStyleRules(row.styleRules, { traitsByChannel: split }) : row.styleRules;
    patch.styleRules = mergeStyleRules(current, input.styleRules, "owner");
  }
  await tx
    .update(voices)
    .set({
      ...patch,
      maturity: sql`case when ${voices.maturity} = 'calibrating' then 'provisional' else ${voices.maturity} end`,
      revision: sql`${voices.revision} + 1`,
    })
    .where(eq(voices.id, id));
  // Any campaign may draft in this voice: each one's writing rules compile
  // now, where they changed, so its next draft does not wait on them.
  for (const campaignId of await campaignsAwaitingRecompile(tx)) await enqueueCompileForCampaign(tx, campaignId);
}

/** Write one channel's persona/houseStyle variant on a voice row. A relearn's
 *  proposal stays beside the words unless `proposed` says otherwise: null
 *  settles it, a value replaces it. */
export async function setVoiceChannel(
  tx: Tx,
  id: number,
  channel: VoiceSurfaceKey,
  v: {
    persona?: string | null;
    houseStyle?: string | null;
    learnedFrom?: number;
    sources?: string[];
    proposed?: SurfaceProposal | null;
  },
): Promise<void> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  const prev = row.channels?.[channel];
  const proposed = v.proposed !== undefined ? v.proposed : (prev?.proposed ?? null);
  const next: VoicesMap = {
    ...(row.channels ?? {}),
    [channel]: {
      persona: v.persona !== undefined ? v.persona : (prev?.persona ?? null),
      houseStyle:
        v.houseStyle !== undefined ? v.houseStyle : (prev?.houseStyle ?? null),
      learnedFrom: v.learnedFrom ?? prev?.learnedFrom ?? 0,
      sources: v.sources ?? prev?.sources ?? ["manual"],
      ...(prev?.card !== undefined ? { card: prev.card } : {}),
      ...(proposed ? { proposed } : {}),
      updatedAt: Date.now(),
    },
  };
  await tx
    .update(voices)
    .set({
      channels: next,
      maturity: sql`case when ${voices.maturity} = 'calibrating' then 'provisional' else ${voices.maturity} end`,
      revision: sql`${voices.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(voices.id, id));
}

/**
 * Settle a relearn's proposal on one surface. Keep makes it the description,
 * carrying the provenance the relearn recorded, and History counts it from
 * here: the snapshot is the relearn the owner kept. Drop discards it and
 * changes nothing else — not the words, and not the revision, because neither
 * the register nor the description moved. False when there is no proposal.
 */
export async function settleProposedDescription(
  tx: Tx,
  id: number,
  surface: VoiceSurfaceKey,
  keep: boolean,
): Promise<boolean> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  const proposal = row.channels?.[surface]?.proposed;
  if (!proposal) return false;
  if (keep) {
    const words = {
      persona: proposal.persona,
      houseStyle: proposal.houseStyle,
      learnedFrom: proposal.learnedFrom,
      sources: proposal.from,
    };
    // The default voice's words are mirrored onto the profile's legacy
    // columns, which are still a read fallback; only its own writer keeps the
    // two in step.
    if (row.isDefault) await setChannelVoice(tx, surface, words);
    else await setVoiceChannel(tx, id, surface, words);
  }
  await tx
    .update(voices)
    .set({
      channels: sql`${voices.channels} #- ${`{${surface},proposed}`}::text[]`,
      updatedAt: Date.now(),
    })
    .where(eq(voices.id, id));
  if (keep) await snapshotVoiceRevision(tx, { voiceId: id, source: "relearn" });
  return true;
}

/**
 * Switch one learned directive on or off for one channel of a voice — a
 * comment habit by default. Off is the owner's word over what their saves
 * show: that channel's writer skips it until it is switched back on, however
 * often the saves keep showing it, and the other channels' habits of the same
 * kind are untouched.
 */
export async function setLearnedDirective(
  tx: Tx,
  id: number,
  kind: LearnedEditKind,
  on: boolean,
  channel: WritingChannel = "comment",
): Promise<void> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  const off = new Set(row.disabledDirectives);
  const key = disabledEditKey(channel, kind);
  if (on) off.delete(key);
  else off.add(key);
  // Not a revision: the register and the channels are what a calibration
  // revises and snapshots, and a switch changes neither.
  await tx
    .update(voices)
    .set({ disabledDirectives: [...off], updatedAt: Date.now() })
    .where(eq(voices.id, id));
}

/** Swap the org default (single tx; the partial unique index is the invariant). */
export async function setDefaultVoice(tx: Tx, id: number): Promise<void> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  if (row.isDefault) return;
  const [previous] = await tx
    .select({ id: voices.id })
    .from(voices)
    .where(eq(voices.isDefault, true));
  const now = Date.now();
  await tx
    .update(voices)
    .set({
      isDefault: false,
      revision: sql`${voices.revision} + 1`,
      updatedAt: now,
    })
    .where(eq(voices.isDefault, true));
  await tx
    .update(voices)
    .set({
      isDefault: true,
      revision: sql`${voices.revision} + 1`,
      updatedAt: now,
    })
    .where(eq(voices.id, id));
  // The samples captured with no voice follow the default, so what both
  // voices learned from edits moves with it.
  if (previous) await refreshLearnedDirectives(tx, { id: previous.id, isDefault: false });
  await refreshLearnedDirectives(tx, { id, isDefault: true });
}

/**
 * Delete a voice. Campaigns using it detach to the org default (explicit update
 * so the count is reportable; the FK's set-null is the belt). Deleting the
 * DEFAULT voice requires promoting another (promoteVoiceId) — an org that has
 * voices must keep exactly one default.
 */
export async function deleteVoice(
  tx: Tx,
  id: number,
  opts: { promoteVoiceId?: number } = {},
): Promise<{ detachedCampaignIds: number[] }> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  if (row.isDefault) {
    if (opts.promoteVoiceId == null || opts.promoteVoiceId === id) {
      throw new Error(
        "cannot delete the default voice — pass promoteVoiceId to make another voice the default first",
      );
    }
    await setDefaultVoice(tx, opts.promoteVoiceId);
  }
  const detachedCampaignIds = await campaignIdsUsingVoice(tx, id);
  if (detachedCampaignIds.length > 0) {
    await tx
      .update(campaigns)
      .set({ voiceId: null })
      .where(eq(campaigns.voiceId, id));
  }
  await tx.delete(voices).where(eq(voices.id, id));
  return { detachedCampaignIds };
}

/**
 * Merge LEARNED style rules into a voice, field by field, each stamped as
 * learned. A learned value fills a field still at Engager's start; with
 * `refine` — the register re-observed across fresh samples of the owner's —
 * it may also change a field a calibration learned before. A field the owner
 * set is never touched, unless they asked for exactly that (`overwrite`, an
 * explicit relearn over their rules).
 */
export async function mergeLearnedStyleRules(
  tx: Tx,
  voiceId: number,
  learned: StyleRules,
  opts: { refine?: boolean; overwrite?: boolean } = {},
): Promise<void> {
  const row = await getVoice(tx, voiceId);
  if (!row) throw new Error(`voice ${voiceId} not found`);
  const patch: Partial<StyleRules> = {};
  for (const key of Object.keys(learned) as (keyof StyleRules)[]) {
    const v = learned[key];
    if (v === null || v === undefined) continue;
    const by = ruleProvenance(row.styleRules, key);
    if (by === null || opts.overwrite || (opts.refine && by === "learned")) {
      (patch as Record<string, unknown>)[key] = v;
    }
  }
  if (Object.keys(patch).length === 0) return;
  await tx
    .update(voices)
    .set({
      styleRules: mergeStyleRules(row.styleRules, patch, "learned"),
      maturity: sql`case when ${voices.maturity} = 'calibrating' then 'provisional' else ${voices.maturity} end`,
      revision: sql`${voices.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(voices.id, voiceId));
}

/**
 * Keep one text the owner gave as an example of how they write, verbatim, for
 * one channel — Comment unless said otherwise — newest first: the same words
 * twice on a channel are one example. Owner-set, like any hand edit of the
 * register, so no calibration ever touches it.
 *
 * At the cap a channel's oldest unpinned example drops off — unless
 * `refuseOverCap`, where nothing is kept and the answer says why, for a
 * surface that tells the owner rather than dropping one of theirs unseen. A
 * channel whose examples are all pinned keeps no more either way.
 */
export async function addVoiceExample(
  tx: Tx,
  id: number,
  text: string,
  opts: { refuseOverCap?: boolean; channel?: ExampleChannel; from?: VoiceExampleOrigin } = {},
): Promise<{ added: boolean; reason?: "duplicate" | "cap"; examples: VoiceExample[] }> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  const example = text.trim();
  const channel = opts.channel ?? "comment";
  const existing = voiceExamples(row.styleRules);
  const own = existing.filter((kept) => kept.channel === channel);
  if (own.some((kept) => exampleKey(kept.text) === exampleKey(example))) {
    return { added: false, reason: "duplicate", examples: existing };
  }
  let kept = existing;
  if (own.length >= VOICE_EXAMPLE_CAP) {
    const oldest = [...own].reverse().find((candidate) => !candidate.pinned);
    if (opts.refuseOverCap || !oldest) return { added: false, reason: "cap", examples: existing };
    kept = existing.filter((candidate) => candidate !== oldest);
  }
  const examples: VoiceExample[] = [
    { text: example, pinned: false, addedAt: Date.now(), from: opts.from ?? "pasted", channel },
    ...kept,
  ];
  await updateVoice(tx, id, { styleRules: examplesFields(examples) });
  return { added: true, examples };
}

/** Rewrite a voice's examples with the one of `channel` whose words are
 *  `text` changed by `change` — or dropped, for null. False when the voice
 *  holds no such example, and nothing is written. */
async function changeVoiceExample(
  tx: Tx,
  id: number,
  text: string,
  channel: ExampleChannel,
  change: (example: VoiceExample) => VoiceExample | null,
): Promise<boolean> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  const existing = voiceExamples(row.styleRules);
  const target = existing.find(
    (example) => example.channel === channel && exampleKey(example.text) === exampleKey(text),
  );
  if (!target) return false;
  const examples = existing.flatMap((example) => {
    if (example !== target) return [example];
    const changed = change(example);
    return changed ? [changed] : [];
  });
  await updateVoice(tx, id, { styleRules: examplesFields(examples) });
  return true;
}

/**
 * Drop one example from a voice's channel, matched by its words as
 * `exampleKey` reads them. Owner-set, like keeping one. False when the voice
 * held no such example, and nothing is written.
 */
export function removeVoiceExample(
  tx: Tx,
  id: number,
  text: string,
  channel: ExampleChannel = "comment",
): Promise<boolean> {
  return changeVoiceExample(tx, id, text, channel, () => null);
}

/** Pin one example of a channel, so it lists first and never drops off at the
 *  cap — or unpin it. False when the voice holds no such example. */
export function pinVoiceExample(
  tx: Tx,
  id: number,
  text: string,
  channel: ExampleChannel,
  pinned: boolean,
): Promise<boolean> {
  return changeVoiceExample(tx, id, text, channel, (example) => ({ ...example, pinned }));
}

/** Max freeText register rules a voice accumulates via guidance-from-edit. */
export const VOICE_RULE_CAP = 10;

/** A voice's free-text rules as the writer reads them: every line it keeps,
 *  Engager's starting line among them while the voice inherits it. */
function heldRuleLines(styleRules: StyleRules | null | undefined): string[] {
  return ruleLines(styleRules?.extras ?? DEFAULT_STYLE_RULES.extras);
}

/** Lines as the free-text rules field keeps them, one bullet each. */
function rulesField(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

/**
 * Append one learned register rule to the voice's styleRules.extras (deduped,
 * capped, newest kept) — the voice-level twin of guidance.appendGuidance. Null
 * voiceId → the org default voice (lazily created). Engager's starting line is
 * kept beside it while the voice still holds it, outside the cap: only the
 * owner turns it off. A field the owner wrote stays theirs, so no calibration
 * may later refine their lines away; one nobody wrote is learned.
 */
export async function appendVoiceRule(
  tx: Tx,
  voiceId: number | null,
  rule: string,
): Promise<void> {
  const trimmed = rule.trim().replace(/^-\s*/, "");
  if (!trimmed) return;
  const row =
    voiceId != null
      ? await getVoice(tx, voiceId)
      : await ensureDefaultVoice(tx);
  if (!row) throw new Error(`voice ${voiceId} not found`);
  const existing = heldRuleLines(row.styleRules);
  if (existing.some((l) => l.toLowerCase() === trimmed.toLowerCase())) return;
  const start = existing.filter((line) => line === DEFAULT_STYLE_RULES.extras);
  const own = [...existing.filter((line) => line !== DEFAULT_STYLE_RULES.extras), trimmed];
  const next = [...start, ...own.slice(-VOICE_RULE_CAP)];
  const author = ruleProvenance(row.styleRules, "extras") ?? "learned";
  await tx
    .update(voices)
    .set({
      styleRules: mergeStyleRules(row.styleRules, { extras: rulesField(next) }, author),
      maturity: sql`case when ${voices.maturity} = 'calibrating' then 'provisional' else ${voices.maturity} end`,
      revision: sql`${voices.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(voices.id, row.id));
}

/**
 * Let one of a voice's free-text rules go. Engager's starting line stays as
 * it is: it is turned off, not removed (`setStartingRuleLine`). False when the
 * voice holds no such line, and nothing is written.
 */
export async function removeVoiceRule(tx: Tx, id: number, line: string): Promise<boolean> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  const held = heldRuleLines(row.styleRules);
  const target = line.trim();
  if (target === DEFAULT_STYLE_RULES.extras || !held.includes(target)) return false;
  await writeRuleLines(tx, id, held.filter((kept) => kept !== target));
  return true;
}

/** Turn Engager's starting line on or off for a voice, beside the rules it
 *  keeps of its own. */
export async function setStartingRuleLine(tx: Tx, id: number, on: boolean): Promise<void> {
  const row = await getVoice(tx, id);
  if (!row) throw new Error(`voice ${id} not found`);
  const own = heldRuleLines(row.styleRules).filter((line) => line !== DEFAULT_STYLE_RULES.extras);
  await writeRuleLines(tx, id, on ? [DEFAULT_STYLE_RULES.extras, ...own] : own);
}

/** The owner's word on a voice's free-text rules: just Engager's starting
 *  line is the template again, which keeps the voice inheriting it. */
async function writeRuleLines(tx: Tx, id: number, lines: readonly string[]): Promise<void> {
  const template = lines.length === 1 && lines[0] === DEFAULT_STYLE_RULES.extras;
  await updateVoice(tx, id, { styleRules: { extras: template ? null : rulesField(lines) } });
}
