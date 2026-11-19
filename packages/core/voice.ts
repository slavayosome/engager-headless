import { and, desc, eq, gte, isNull, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  FIRST_RADAR_ASSIST_RETENTION_MAX,
  OWNER_ORIGIN_MIN,
} from "@engager/common/text-provenance";
import {
  campaigns,
  voiceSamples,
  voices,
  type Campaign,
  type DraftingKnobs,
  type LearnedEdit,
  type Profile,
  type ResolvedStyleRules,
  type StyleRules,
  type StyleStructuralRange,
  type SurfaceVoice,
  type Voice,
  type VoiceSurfaceKey,
  type VoiceTraits,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { DEFAULT_STYLE_RULES, resolveStyleRules, withAsideDashes } from "./ai/styleRules";
import {
  measureVoiceTraits,
  resolveVoiceTraits,
  TRAIT_MIN_SAMPLES,
  TRAIT_WINDOW,
  traitWindow,
  type MeasuredVoiceTraits,
} from "./ai/voiceTraits";
import { resolveVoice, type ResolvedVoice } from "./profile";
import { draftExamples, exampleTexts } from "./voice/examples";
import { activeDirectives } from "./voice/habits";

/**
 * Voice ENTITIES — named registers attachable per campaign. Resolution ladder:
 *   campaign.voiceId → the org's default voice (isDefault) → the legacy
 *   profile voice (migration compat) → the built-in template.
 * styleRules resolve PER-FIELD against the template regardless of which rung
 * supplied persona/houseStyle, so a thin voice still gets full register rules.
 */

/** The built-in template: what an org with no voices (or a voice with every
 *  field null) writes with. styleRules ARE the shipped defaults — the same
 *  constant the writer/slop/lint shim falls back to. */
export const DEFAULT_VOICE_TEMPLATE = {
  name: "Default voice",
  persona: null as string | null,
  houseStyle: null as string | null,
  language: null as string | null,
  styleRules: DEFAULT_STYLE_RULES,
} as const;

/** Where a resolved voice came from (trace + UI provenance). */
export type VoiceResolvedFrom =
  | "campaign_voice"
  | "org_default_voice"
  | "legacy_profile"
  | "template";

export type ResolvedVoiceV2 = {
  channel: VoiceSurfaceKey;
  /** Null = legacy-profile or pure-template resolution (no voice row). */
  voiceId: number | null;
  voiceName: string | null;
  /** Write-side hint only; discovery/filter language stays campaign config. */
  language: string | null;
  persona: string | null;
  houseStyle: string | null;
  learnedFrom: number;
  sources: string[];
  /** Always fully resolved (per-field template fallback). */
  styleRules: ResolvedStyleRules;
  /** Which styleRules fields the voice row actually overrides. */
  styleRulesOverridden: (keyof StyleRules)[];
  structuralRange: StyleStructuralRange | null;
  resolvedFrom: VoiceResolvedFrom;
  /** Legacy post-channel semantic preserved (see profile.resolveVoice). */
  seeded: boolean;
  /** The examples the owner gave of how they actually write for this
   *  channel (`StyleRules.examples`; Comment's where it has none), and their
   *  newest comments of their own — never an approved agent draft; only
   *  `resolveCampaignVoice` reads those. Each absent when there are none. */
  examples?: string[];
  samples?: string[];
  /** The traits a DM is written by: the owner's set ones over what their own
   *  DMs show, else what their comments show. */
  dmTraits?: VoiceTraits;
  /** The traits a reply is written by, the same way: over what the owner's
   *  own replies show, else what their comments show. */
  replyTraits?: VoiceTraits;
  /** A reply's or a DM's habits: what the owner's rewrites of that channel's
   *  drafts show, less what they forgot (`activeDirectives`). Never
   *  Comment's, which its prompt is handed where it is drafted. */
  channelEdits?: LearnedEdit[];
};

/** What `ensureDefaultVoice` writes when it mints the org's default. Exported
 *  so a READ can describe the default an org has not created yet without
 *  guessing at what creating it would produce. */
export const DEFAULT_VOICE_SEED = {
  name: "My voice",
  isDefault: true,
  createdFrom: "manual",
} as const;

/**
 * The org's default voice BEFORE any row exists for it.
 *
 * Samples captured on a voice-less org are stored with `voiceId: null` — "the
 * default voice at the time" — and `sampleBelongsToVoice` matches those
 * against ANY default-shaped voice. So a corpus read can answer truthfully on
 * an org that has never created a voice, which is what the drafting context
 * already does with this same shape (operations/clientDrafting.ts). A READ may
 * describe this default; only a WRITE may create it.
 */
export const UNMATERIALISED_DEFAULT_VOICE: Pick<Voice, "id" | "isDefault"> = {
  id: -1,
  isDefault: true,
};

/** Samples with `voiceId null` were captured for "the org's default voice at
 *  the time" — they belong to the campaign exactly when the campaign IS the
 *  default. */
export function sampleBelongsToVoice(
  voice: Pick<Voice, "id" | "isDefault">,
): SQL {
  return voice.isDefault
    ? or(eq(voiceSamples.voiceId, voice.id), isNull(voiceSamples.voiceId))!
    : eq(voiceSamples.voiceId, voice.id);
}

/**
 * The owner wrote most of the saved words — the SQL twin of
 * `!isAssisted(assistRetention, ownerOrigin)`. Under half of the text's word
 * 3-grams traced to an offered draft (`FIRST_RADAR_ASSIST_RETENTION_MAX`, 0.5:
 * "most of it is theirs" is the one bar that needs no second explanation), or
 * at least half traced to wording the owner supplied, or no draft offered at
 * all. A real corpus splits cleanly on it: approved drafts measure 0.65-0.94,
 * the owner's own rewrites near 0.05.
 */
export function ownerAuthoredSample(): SQL {
  return or(
    isNull(voiceSamples.assistRetention),
    lt(voiceSamples.assistRetention, FIRST_RADAR_ASSIST_RETENTION_MAX),
    gte(voiceSamples.ownerOrigin, OWNER_ORIGIN_MIN),
  )!;
}

/**
 * The complement of `ownerAuthoredSample`: a draft the owner approved with
 * most of its words as offered. Spelled out rather than `not(...)`, because an
 * owner-origin nobody measured is null, and NOT of the null that makes is
 * null — the negation would drop exactly the rows it is asked for.
 */
export function assistedSample(): SQL {
  return and(
    gte(voiceSamples.assistRetention, FIRST_RADAR_ASSIST_RETENTION_MAX),
    or(isNull(voiceSamples.ownerOrigin), lt(voiceSamples.ownerOrigin, OWNER_ORIGIN_MIN)),
  )!;
}

/** What a voice learns how its owner writes from: its own samples, in the
 *  corpus, not disowned, and written by the owner. An agent draft they
 *  approved stays in the corpus as an approval and teaches none of this. */
export function voiceEvidence(voice: Pick<Voice, "id" | "isDefault">): SQL {
  return and(
    sampleBelongsToVoice(voice),
    eq(voiceSamples.eligible, true),
    isNull(voiceSamples.disownedAt),
    ownerAuthoredSample(),
  )!;
}

/** The ways of writing a voice learns apart: the owner's replies, their DMs,
 *  and everything else they wrote, which are comments. */
export type WritingChannel = "comment" | "reply" | "dm";

/** The samples one channel learns from: the owner's DMs, their replies, and
 *  everything else they wrote, which are comments. */
export function writtenIn(channel: WritingChannel): SQL {
  switch (channel) {
    case "dm":
      return eq(voiceSamples.source, "owner_dm");
    case "reply":
      return eq(voiceSamples.source, "owner_reply");
    case "comment":
      return notInArray(voiceSamples.source, ["owner_dm", "owner_reply"]);
  }
}

/** How many of the owner's newest comments a writer is shown. */
export const OWNER_SAMPLE_LIMIT = 6;

export type OwnerWriting = {
  samples: string[];
  measured: Record<WritingChannel, MeasuredVoiceTraits | null>;
};

/** One text the owner wrote, with where it was written. */
export type OwnerText = Pick<
  typeof voiceSamples.$inferSelect,
  "id" | "text" | "capturedAt" | "campaignId" | "discoveredPostId"
>;

/**
 * The owner's own texts in one channel, newest first — at most as many as a
 * measurement reads. Each channel is read on its own, so a run of DMs can
 * never push the comments out of the window, or the other way round.
 */
export async function ownerTexts(
  tx: Tx,
  voice: Pick<Voice, "id" | "isDefault">,
  channel: WritingChannel,
): Promise<OwnerText[]> {
  return tx
    .select({
      id: voiceSamples.id,
      text: voiceSamples.text,
      capturedAt: voiceSamples.capturedAt,
      campaignId: voiceSamples.campaignId,
      discoveredPostId: voiceSamples.discoveredPostId,
    })
    .from(voiceSamples)
    .where(and(voiceEvidence(voice), writtenIn(channel)))
    .orderBy(desc(voiceSamples.capturedAt), desc(voiceSamples.id))
    .limit(TRAIT_WINDOW);
}

/**
 * What the owner's own writing says about a voice, read in one place: their
 * newest comments, and the traits measured from their comments, from their
 * replies and from their DMs — each with the examples they gave that channel
 * ahead of everything — in the language the voice writes in. Owner-written
 * samples only.
 */
export async function readOwnerWriting(
  tx: Tx,
  voice: Pick<Voice, "id" | "isDefault"> & {
    styleRules?: StyleRules | null;
    language?: string | null;
  },
): Promise<OwnerWriting> {
  const comments = (await ownerTexts(tx, voice, "comment")).map((row) => row.text);
  const replies = (await ownerTexts(tx, voice, "reply")).map((row) => row.text);
  const dms = (await ownerTexts(tx, voice, "dm")).map((row) => row.text);
  const language = { language: voice.language };
  return {
    samples: comments.slice(0, OWNER_SAMPLE_LIMIT),
    measured: {
      comment: measureVoiceTraits([...exampleTexts(voice.styleRules, "comment"), ...comments], language),
      reply: measureVoiceTraits([...exampleTexts(voice.styleRules, "reply"), ...replies], language),
      dm: measureVoiceTraits([...exampleTexts(voice.styleRules, "dm"), ...dms], language),
    },
  };
}

/**
 * Whether a channel has too few of the owner's own texts to be measured, and
 * is written the way they comment — what `measureVoiceTraits` decides of its
 * window, which holds the examples they gave the channel ahead of its texts.
 */
export async function followsComment(
  tx: Tx,
  voice: Pick<Voice, "id" | "isDefault"> & { styleRules?: StyleRules | null },
  channel: Exclude<WritingChannel, "comment">,
): Promise<boolean> {
  const texts = (await ownerTexts(tx, voice, channel)).map((row) => row.text);
  return traitWindow([...exampleTexts(voice.styleRules, channel), ...texts], (text) => text).length < TRAIT_MIN_SAMPLES;
}

/** The traits the owner set that hold one channel: the ones set for it, and
 *  the ones set for comments that it takes. */
export type ChannelOwnerSets = { own: VoiceTraits | null; inherited: VoiceTraits | null };

/**
 * What the owner set that a draft in one channel is held to. Comment's set is
 * `styleRules.traits`. A reply or a DM is held to its own set
 * (`traitsByChannel`) and, while it follows Comment, to Comment's under it. A
 * voice whose channels were never split holds every channel to Comment's, as
 * it did before they could be.
 */
export function channelOwnerSets(
  styleRules: Pick<StyleRules, "traits" | "traitsByChannel"> | null | undefined,
  channel: WritingChannel,
  follows: boolean,
): ChannelOwnerSets {
  const comment = styleRules?.traits ?? null;
  if (channel === "comment") return { own: comment, inherited: null };
  const split = styleRules?.traitsByChannel;
  if (split == null) return { own: null, inherited: comment };
  return { own: split[channel] ?? null, inherited: follows ? comment : null };
}

/** `channelOwnerSets` as one set: the channel's own values over the ones it
 *  takes from Comment. */
export function ownerTraitsFor(
  styleRules: Pick<StyleRules, "traits" | "traitsByChannel"> | null | undefined,
  channel: WritingChannel,
  follows: boolean,
): VoiceTraits | null {
  const { own, inherited } = channelOwnerSets(styleRules, channel, follows);
  return own || inherited ? { ...inherited, ...own } : null;
}

/** A resolved voice with what the owner's own writing shows laid under the
 *  traits they set, channel by channel. Nothing is added for a voice with
 *  nothing to show, so its prompts stay byte-identical. */
export function withOwnerWriting(
  resolved: ResolvedVoiceV2,
  writing: OwnerWriting,
  styleRules: Pick<StyleRules, "traits" | "traitsByChannel"> | null | undefined,
): ResolvedVoiceV2 {
  const opts = {
    language: resolved.language,
    strictness: resolved.styleRules.knobs?.voiceStrictness,
  };
  // A channel with too few texts of its own is written the way the owner
  // comments.
  const channelTraits = (channel: WritingChannel) =>
    resolveVoiceTraits(
      writing.measured[channel] ?? writing.measured.comment,
      ownerTraitsFor(styleRules, channel, writing.measured[channel] == null),
      opts,
    );
  const traits = channelTraits("comment");
  const replyTraits = channelTraits("reply");
  const dmTraits = channelTraits("dm");
  return {
    ...resolved,
    styleRules:
      Object.keys(traits).length > 0
        ? withAsideDashes({ ...resolved.styleRules, traits }, resolved.styleRulesOverridden)
        : resolved.styleRules,
    ...(Object.keys(replyTraits).length > 0 ? { replyTraits } : {}),
    ...(Object.keys(dmTraits).length > 0 ? { dmTraits } : {}),
    ...(writing.samples.length > 0 ? { samples: writing.samples } : {}),
  };
}

/**
 * The org's default voice, created lazily ("My voice"). Concurrency-safe via
 * the partial unique index (voices_org_default_unq): a concurrent creator's
 * insert makes ours throw → re-select. Mirrors getProfile's lazy-upsert.
 */
export async function ensureDefaultVoice(tx: Tx): Promise<Voice> {
  const [existing] = await tx.select().from(voices).where(eq(voices.isDefault, true));
  if (existing) return existing;
  try {
    const [created] = await tx
      .insert(voices)
      .values(DEFAULT_VOICE_SEED)
      .returning();
    if (created) return created;
  } catch {
    // unique-violation race → fall through to re-select
  }
  const [row] = await tx.select().from(voices).where(eq(voices.isDefault, true));
  if (!row) throw new Error("ensureDefaultVoice: no default voice after insert");
  return row;
}

/**
 * The voice a campaign writes with: its attached voice, else the org default,
 * else null (→ legacy profile / template resolution). Does NOT lazily create
 * the default — read paths stay write-free.
 */
export async function getVoiceForCampaign(
  tx: Tx,
  campaign: Pick<Campaign, "voiceId">,
): Promise<{ voice: Voice; attached: boolean } | null> {
  if (campaign.voiceId != null) {
    const [row] = await tx.select().from(voices).where(eq(voices.id, campaign.voiceId));
    if (row) return { voice: row, attached: true };
    // Dangling voiceId (deleted voice mid-flight) → fall through to default.
  }
  const [def] = await tx.select().from(voices).where(eq(voices.isDefault, true));
  return def ? { voice: def, attached: false } : null;
}

/**
 * The id of the voice a campaign writes in — its attached voice, else the org
 * default — which the owner's words written for that campaign teach: a
 * comment they save, a draft they rewrite, a DM they write. Null where there
 * is no campaign, or the org has no voice yet: "the default", as a sample
 * captured with no voice reads.
 */
export async function campaignVoiceId(tx: Tx, campaignId: number | null): Promise<number | null> {
  if (campaignId == null) return null;
  const [campaign] = await tx
    .select({ voiceId: campaigns.voiceId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  return (await getVoiceForCampaign(tx, campaign))?.voice.id ?? null;
}

/** A voice whose own saves add marks may use one whatever its register says
 *  — the drafting prompt and the intake gate both read these rules, so they
 *  agree on it. */
export function addsMarks(voice: Pick<Voice, "learnedDirectives" | "disabledDirectives">): boolean {
  return (
    voice.learnedDirectives?.directives.some((d) => d.kind === "emoticons") === true &&
    !voice.disabledDirectives.includes("emoticons")
  );
}

/**
 * Resolve the full voice for one output surface. Ladder for persona/houseStyle:
 * the voice row's channel variant → the legacy profile resolution → template
 * (empty). A reply or a DM has no rung of its own below the row: without
 * words of its own for it, a voice writes replies and DMs with its comment
 * description. styleRules/structuralRange are voice-level: rules per-field
 * from the voice row (else template); range from the voice row (else the
 * profile's).
 */
export function resolveVoiceV2(opts: {
  voice: Voice | null;
  /** Whether `voice` came from campaign.voiceId (vs the org default). */
  attached?: boolean;
  profile: Profile;
  channel: VoiceSurfaceKey;
}): ResolvedVoiceV2 {
  const { voice, profile: prof, channel } = opts;
  // A reply's and a DM's drafts are shown their own examples first, else
  // Comment's — whichever description they are written with.
  const shown = draftExamples(voice?.styleRules, channel === "reply" || channel === "dm" ? channel : "comment");
  const examples = shown.length > 0 ? { examples: shown } : {};
  if ((channel === "reply" || channel === "dm") && !hasWords(voice?.channels?.[channel])) {
    const { examples: _comments, ...described } = resolveVoiceV2({ ...opts, channel: "comment" });
    return { ...described, channel, ...examples };
  }
  const rules = resolveStyleRules(voice?.styleRules);
  if (voice && addsMarks(voice) && rules.resolved.emojiMax === 0) rules.resolved.emojiMax = 1;
  const structuralRange = voice?.structuralRange ?? prof.voiceStructuralRange ?? null;

  const cv = voice?.channels?.[channel];
  if (voice && cv && hasWords(cv)) {
    return {
      channel,
      voiceId: voice.id,
      voiceName: voice.name,
      language: voice.language,
      persona: cv.persona,
      houseStyle: cv.houseStyle,
      learnedFrom: cv.learnedFrom,
      sources: cv.sources,
      styleRules: rules.resolved,
      styleRulesOverridden: rules.overridden,
      structuralRange,
      resolvedFrom: opts.attached ? "campaign_voice" : "org_default_voice",
      seeded: false,
      ...examples,
    };
  }

  // No usable channel variant on the voice row → legacy profile resolution.
  // The voice row (when present) still owns styleRules/structuralRange.
  const legacy: ResolvedVoice = resolveVoice(prof, channel);
  const hasLegacy = !!(legacy.persona?.trim() || legacy.houseStyle?.trim());
  return {
    channel,
    voiceId: voice?.id ?? null,
    voiceName: voice?.name ?? null,
    language: voice?.language ?? null,
    persona: legacy.persona,
    houseStyle: legacy.houseStyle,
    learnedFrom: legacy.learnedFrom,
    sources: legacy.sources,
    styleRules: rules.resolved,
    styleRulesOverridden: rules.overridden,
    structuralRange,
    resolvedFrom: hasLegacy
      ? "legacy_profile"
      : voice
        ? opts.attached
          ? "campaign_voice"
          : "org_default_voice"
        : "template",
    seeded: legacy.seeded,
    ...examples,
  };
}

/** A surface's description has words of its own. */
export function hasWords(words: Pick<SurfaceVoice, "persona" | "houseStyle"> | undefined): boolean {
  return !!(words?.persona?.trim() || words?.houseStyle?.trim());
}

/** Convenience: campaign → resolved voice in one call (read-only), with what
 *  the owner's own writing shows (`withOwnerWriting`) and, for a reply or a
 *  DM, the habits from their rewrites of that channel's drafts. `knobs` lays a
 *  set of drafting knobs over the voice's own, knob by knob — a preview's
 *  variant. */
export async function resolveCampaignVoice(
  tx: Tx,
  campaign: Pick<Campaign, "voiceId">,
  prof: Profile,
  channel: VoiceSurfaceKey = "comment",
  opts: { knobs?: DraftingKnobs } = {},
): Promise<ResolvedVoiceV2> {
  const hit = await getVoiceForCampaign(tx, campaign);
  const voice = resolveVoiceV2({
    voice: hit?.voice ?? null,
    attached: hit?.attached ?? false,
    profile: prof,
    channel,
  });
  const resolved =
    opts.knobs && Object.keys(opts.knobs).length > 0
      ? {
          ...voice,
          styleRules: { ...voice.styleRules, knobs: { ...voice.styleRules.knobs, ...opts.knobs } },
        }
      : voice;
  const writing = await readOwnerWriting(tx, hit?.voice ?? UNMATERIALISED_DEFAULT_VOICE);
  const written = withOwnerWriting(resolved, writing, hit?.voice.styleRules);
  const edits = channel === "reply" || channel === "dm" ? activeDirectives(hit?.voice, channel) : [];
  return edits.length > 0 ? { ...written, channelEdits: edits } : written;
}

/** How many campaigns a voice writes for: the ones attached to it and, for the
 *  default, the ones that picked no voice. An archived campaign writes for
 *  nothing, so it is not one of them. */
export async function countCampaignsWritingIn(
  tx: Tx,
  voice: Pick<Voice, "id" | "isDefault">,
): Promise<number> {
  const attached = voice.isDefault
    ? or(eq(campaigns.voiceId, voice.id), isNull(campaigns.voiceId))
    : eq(campaigns.voiceId, voice.id);
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(and(attached, ne(campaigns.status, "archived")));
  return row?.count ?? 0;
}

/** Guard for delete/default flows: the ids of campaigns writing with a voice. */
export async function campaignIdsUsingVoice(tx: Tx, voiceId: number): Promise<number[]> {
  const rows = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.voiceId, voiceId));
  return rows.map((r) => r.id);
}
