/**
 * Multi-tenant Postgres schema (Drizzle pg-core). Ported from the single-tenant
 * SQLite schema and extended for SaaS:
 *  - identity/tenancy tables (organizations, users, accounts, memberships,
 *    invitations, subscriptions) modeled on Achromatic Pro;
 *  - every domain table carries `organizationId` (uuid FK, cascade) + composite
 *    unique indexes that include the org (so different orgs can engage the same post);
 *  - the former singletons `profile`/`system_state` are now per-org rows;
 *  - the "Brain" tables (knowledge, brain_questions, brain_state) are per-org.
 *
 * Timestamps stay as epoch-ms `bigint` (mode:"number") to preserve the engine's
 * existing Date.now() time math without a sweeping rewrite.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const nowMs = () => Date.now();

/** A LinkedIn profile id. It is lower-cased on its way into the database, in
 *  a write and in a comparison alike, so every lookup of a person is plain
 *  equality on an index. */
export const profileIdKey = (value: string): string => value.toLowerCase();
const profileIdText = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: profileIdKey,
});

/** The campaign's targeting facts. The free-text rule is a projection of this
 *  record once saved; null on a campaign means its legacy rule still applies. */
export type AudienceProfileJson = {
  who: { summary: string; signals: string[]; companyKinds: string[] };
  pains: Array<{
    id: string;
    text: string;
    phrases: string[];
    source: "owner" | "brain" | "learned";
    status: "proposed" | "active" | "retired";
    themeId?: string;
    seenInRooms?: number;
    evidencePurgedAt?: number;
  }>;
  notThem: string[];
  /** Countries as ISO 3166-1 alpha-2 codes, read only off a profile's
   *  location (`audience/geography.ts`). */
  where: {
    includeCountries: string[];
    excludeCountries: string[];
    unknownCountry: "count_in" | "owner_call" | "leave_out";
  };
  testSource: "derived" | "owner";
  ownerRule: string | null;
  revision: number;
  updatedAt: number;
};

/**
 * The active org for the current transaction, set via `set_config('app.current_org', …)`
 * by the `withOrg()` wrapper. Used as the default for `organization_id` so inserts don't
 * have to pass it, and (with RLS) as the isolation predicate. `true` → NULL when unset,
 * which trips the NOT NULL constraint and fails any write made outside an org scope.
 */
const CURRENT_ORG = sql`nullif(current_setting('app.current_org', true), '')::uuid`;

// JSON config shapes (unchanged from the SQLite version)

/** How discovery weighs post AUTHORS' reach. "any" = ignore author impact (default,
 *  zero extra API calls). "prefer_high_impact" = enrich authors + boost ranking.
 *  "high_impact_only" = additionally REQUIRE `min_author_followers` (unenriched
 *  authors can't prove impact → not admitted; rate-limited cold start applies). */
export type AuthorTargeting = "any" | "prefer_high_impact" | "high_impact_only";

export type DiscoveryConfig = {
  keywords?: string[];
  boolean_query?: string;
  hashtags?: string[];
  target_author_urns?: string[];
  search_query?: string;
  limit?: number;
  author_targeting?: AuthorTargeting;
  /** Floor for "high_impact_only" (default 5000 when unset). */
  min_author_followers?: number;
};

export type AiFilterConfig = {
  instruction: string;
  target_language?: string;
  min_confidence?: number; // 0..3
  min_meaningfulness?: number; // 0..1 floor on the blended ranking score
};

export type ToneConfig = {
  angle?: string;
  product_name?: string;
  product_description?: string;
  usp?: string;
  voice?: string;
  /** "auto" = the writer picks a tier per post (post depth + BetScore + recent-tier
   *  rotation, seeded by post id). A concrete tier pins every draft. Unset = auto
   *  (legacy rows without an explicit tier vary too; `ENGAGER_AUTO_LENGTH=off`
   *  restores the old always-short behavior). */
  length?: "auto" | "ultra_short" | "short" | "medium" | "long";
  /** Share (0..1) of comments that may promote. UNSET = the objective's default
   *  (0.3 for product); an explicit number — including 0 — is honored. */
  promo_ratio?: number;
  /** Force promo comments to include the attached product's NAME + URL (deterministic
   *  enforcement lands with the prompt-resolver track; stored + surfaced now). Links
   *  can reduce reach — off by default, the user decides. */
  promo_include_link?: boolean;
  /** Slop-gate strictness 0..1 (1 = strictest). Unset or "auto" = per-post auto
   *  selection with deliberate jitter (see core/ai/slop `decideSlopStrictness`).
   *  The reject threshold is `lerp(0.9, 0.4, strictness)` over the 0..1 slop score. */
  slop_strictness?: number | "auto";
  do?: string[];
  avoid?: string[];
};

export type ActiveHours = { start: string; end: string; tz: string };

export type AiPromptsConfig = {
  comment_guidance?: string;
  reply_guidance?: string;
  /** How this campaign answers a reply under its own comment, said by the
   *  owner; read beside `reply_guidance`, and absent when unset. */
  reply_policy?: string;
};

/** Fixed Brain context slots (coverage model for the agentic interview). */
export type BrainSlot =
  | "identity"
  | "expertise"
  | "positions"
  | "stories"
  | "audience"
  | "goals"
  | "avoid"
  | "product";

export type BrainSlotState = { confidence: number; missing?: string };

/**
 * A per-campaign "focus brief" compiled from the org-wide Brain (async, by the
 * `compile_campaign` job). The Brain is one org-wide library; this is the reading
 * list for ONE campaign — sanitized angle/topic framing only (never imperative
 * writer instructions, CTAs, product claims, or voice rules). Stored as a
 * TOP-LEVEL `campaigns.compiledBrief` column (NOT in `campaigns.prompts`, which is
 * shallow-merged and would lose-update vs a concurrent compile).
 */
export type CompiledBrief = {
  /** ~120-word framing prose injected into the writer. Empty when `coldStart`. */
  brief: string;
  /** Slots the runtime retrieval should prefer (soft) for this campaign. */
  preferredSlots: BrainSlot[];
  /** Knowledge row ids the brief drew on — provenance for E1/E2/debug only,
   *  NOT the recompile-invalidation key (that's the org-wide knowledgeVersion). */
  anchorKnowledgeIds: number[];
  /** sha256 of all compile inputs; a matching hash makes recompile a no-op. */
  sourceHash: string;
  compiledAt: number;
  /** brain_state.fillScore at compile time (observability). */
  basedOnFillScore: number;
  /** true when no usable brief exists (compile failed w/ changed deps, or there
   *  was nothing campaign-specific to frame) — the writer then reverts to the
   *  pre-brief flat retrieval path (byte-identical to before this feature). */
  coldStart: boolean;
};

/** Commenting goal shared by manual assistance and the Ambassador; never Scout targeting. */
export type CampaignObjective =
  | "engage"
  | "visibility"
  | "audience"
  | "nurture"
  | "thought"
  | "product";

/**
 * Persisted breakdown of a post's BetScore (Scout's relevance ranker). Stored
 * on `discovered_posts.betBreakdown` for observability + Gate 1/2. The authoritative
 * runtime type lives in `@engager/core/ai/rank` (`BetBreakdown`); this is the JSONB
 * column shape and must stay structurally compatible with it. `preset` names the
 * weighting a row was scored under — a string here rather than the runtime union,
 * because this package may not import core. OPTIONAL because the column is
 * older than the field: rows scored before Scout's single preset carry the
 * goal id this replaced, under `objective`, and a reader must treat an absent
 * `preset` as "scored under whatever that release used".
 */
export type BetBreakdownJson = {
  preset?: string;
  signals: Record<string, number>;
  weights: Record<string, number>;
  coverage: number;
  blend: number;
  score: number;
};

/**
 * Persisted breakdown of a post's OBJECTIVE-INDEPENDENT reach pre-score (the capacity
 * planner's gather-buffer ranking signal). Stored on `discovered_posts.reachBreakdown`.
 * The authoritative runtime type lives in `@engager/core/ai/rank` (`ReachBreakdown`);
 * this is the JSONB column shape and must stay structurally compatible with it.
 */
export type ReachBreakdownJson = {
  signals: Record<string, number>;
  weights: Record<string, number>;
  score: number;
};

/**
 * A full read of one post and its comment thread, stored on
 * `candidate_research.thread` and frozen with the verdict it supported. The
 * column owns this shape because this package may not import core, so the
 * LinkedIn driver's thread read must return it as is. `isOwner` marks a comment
 * the connected account wrote; `authorReplied` marks one the post's author
 * answered underneath.
 */
export type PostThreadJson = {
  postUrn: string;
  author?: { profileId: string; name?: string; headline?: string; isCompany: boolean };
  fullText: string;
  mediaText?: string;
  postedAt?: number;
  counts: { reactions: number; comments: number; reposts: number };
  comments: Array<{
    commentUrn: string;
    authorProfileId?: string;
    memberUrn?: string;
    authorIsCompany?: boolean;
    authorName?: string;
    authorHeadline?: string;
    text: string;
    reactions: number;
    authorReplied: boolean;
    authorReplyText?: string;
    isOwner: boolean;
  }>;
};

/**
 * A read of a profile, stored on `author_profiles.profile_read`. Same
 * ownership as {@link PostThreadJson}: the driver's profile read must return
 * this shape.
 */
export type AuthorProfileReadJson = {
  profileId: string;
  name?: string;
  headline?: string;
  about?: string;
  /** `companyRef` is the company page the role links to, its public
   *  identifier, where the profile names one: what Deep's company read reads
   *  (`CompanyPageReadJson`). */
  currentRole?: { title?: string; company?: string; companySize?: string; companyRef?: string };
  followers?: number;
  /** ISO 3166-1 alpha-2, uppercased, from the profile's location. Absent is
   *  unknown: never the profile's locale, which is its language. */
  country?: string;
  /** The geo the profile's location names, `urn:li:fsd_geo:<id>`. */
  geoUrn?: string;
  recentPosts: Array<{ postUrn: string; text: string; postedAt?: number }>;
  isCompanyPage: boolean;
};

/**
 * One read of a company's own page: what its public data says of it, LinkedIn
 * text held as data. Nothing beyond the page: no people, no email, no vendor's
 * enrichment. The driver's company page read returns this shape.
 */
export type CompanyPageReadJson = {
  /** The page's public identifier, as the profile linked it. */
  companyRef: string;
  name?: string;
  /** The page's size band, as it words it ("51-200 employees"). */
  size?: string;
  industry?: string;
  about?: string;
  followers?: number;
};

/**
 * One read of where the connected account stands with a member, off their
 * profile page in the account's own session — the evidence a relationship
 * fact is written from, kept on the conversation event it moved and on the
 * person's `identity_evidence`. Same ownership as {@link PostThreadJson}: the
 * driver's relationship read must return this shape. Every fact the page did
 * not show is `"unknown"`; `profile.verified` is false when the page was not
 * the member asked for.
 */
export type RelationshipReadJson = {
  profile: { id: string; url: string; displayName: string; verified: boolean };
  degree: "self" | "1st" | "2nd" | "3rd+" | "unknown";
  pending: "none" | "outgoing" | "incoming" | "unknown";
  /** Whether a note is on offer and its limit — LinkedIn's invitation
   *  compose view's, never the profile's, so `"unknown"` on a read of the
   *  profile. */
  note: { supported: boolean | "unknown"; limitChars: number | null };
  /** The member as their profile's data names them: the profile urn
   *  (`urn:li:fsd_profile:<id>`, the id an `m.` person key carries) and the
   *  number in their member urn. Absent on reads older than the data reader. */
  profileUrn?: string;
  memberId?: string;
  /** The Connect LinkedIn's data offers — `connect` on no invitation,
   *  `pending` on ours, `withdrawn` on ours withdrawn, which is none pending,
   *  and LinkedIn takes no new invitation for three weeks. */
  invitation?: "connect" | "pending" | "withdrawn";
  /** Where the member's Connect leads: their invitation composer, an
   *  invitation sent at once or any other action (neither ever pressed), or
   *  nothing the data shows. */
  connect?: { composerUrl: string } | "instant" | "other" | "none";
  /** A value the read did not know, as LinkedIn spelled it. */
  detail?: string;
  /** Where the member is, from their profile's location (as
   *  {@link AuthorProfileReadJson} has it), on a read that was asked to look
   *  and could bind the lookup to the member; `{}` when the location names
   *  neither. Absent: not looked. */
  place?: { country?: string; geoUrn?: string };
  observedAt: number;
  /** The browser session that read it, minted each time the browser starts:
   *  what "read in the same session" compares. */
  sessionId: string;
  pageFingerprint: string;
  selectorPack: string;
};

/** The facets a product's knowledge accumulates into (parallel to BrainSlot). */
export type ProductFacet =
  | "what"
  | "audience"
  | "value"
  | "proof"
  | "objections"
  | "links";

export type ProductStatus = "idea" | "beta" | "released";

/** Which sources the account-wide voice is (re-)learned from. */
export type VoiceChannels = { linkedin: boolean; brain: boolean };

/** Display payload for the onboarding "what we learned about your voice" card. */
export type VoiceCard = { tags: string[]; sample: string };

/**
 * Per-OUTPUT-SURFACE voice ("how the user comments" vs "how they write posts").
 * A CHANNEL is one account on one network (INV-4) — this map is nothing of the
 * sort, so the types say surface and only the jsonb columns the migration lint
 * forbids renaming (`voices.channels`, `profiles.voices`' sibling map,
 * `voice_revisions.channels`) still spell the older noun.
 *
 * Orthogonal to `VoiceChannels` (which sources voice is learned FROM). Map keys
 * are open strings so future surfaces ("article", …) need no migration.
 * The legacy flat columns (voicePersona/voiceHouseStyle/…) remain the read
 * fallback for comment and post, and the dual-write target for "comment".
 * "reply" and "dm" are written on the voice row alone, and a voice without
 * words of its own for one is written with its comment description.
 */
export type VoiceSurfaceKey = "comment" | "post" | "reply" | "dm";
/**
 * A description a background relearn learned for a surface that already had
 * one. It is held beside the owner's words, never over them: Keep makes it
 * the description, Drop discards it, and a newer relearn replaces it.
 */
export type SurfaceProposal = {
  persona: string;
  houseStyle: string;
  /** When the relearn proposed it. */
  at: number;
  /** What it was learned from, in `SurfaceVoice.sources`' vocabulary. */
  from: string[];
  /** Sample count the distillation drew on, as `SurfaceVoice.learnedFrom`. */
  learnedFrom: number;
  /** How many comments of the owner's it read that no relearn had before. */
  newComments: number;
  /** Drafted for a voice just created, from the owner's own writing on
   *  LinkedIn (`relearn_voice_description`) — absent on a relearn's. */
  drafted?: boolean;
};
export type SurfaceVoice = {
  persona: string | null;
  houseStyle: string | null;
  /** Sample count the distillation drew on (provenance). */
  learnedFrom: number;
  /** e.g. ["own_comments","edited_messages"] | ["posts_fallback"] | ["own_posts"] | ["manual"] */
  sources: string[];
  card?: VoiceCard | null;
  /** Absent or null: no relearn is waiting on the owner's Keep or Drop. */
  proposed?: SurfaceProposal | null;
  updatedAt: number;
};
export type VoicesMap = Partial<Record<string, SurfaceVoice>>;

/**
 * Structural style range derived from the user's OWN posts (mirrors `voiceChannels`
 * — a voice-learned signal stored on the profile). The writer's per-draft STYLE
 * DIRECTIVE rotation is picked from this, BLENDED with the hardcoded default
 * taxonomy so a narrow corpus still gets a guaranteed spread. Best-effort: nil or
 * degenerate falls back to the defaults (see `blendRanges` in core/styleVariety).
 *
 * Each axis holds the OPENING / SHAPE / STANCE classes the user actually exhibits,
 * each with a relative weight (frequency proxy). Types live here because the
 * `database` package cannot import from `core` (one-way dependency).
 */
export type StyleAxisItem = { id: string; weight: number };
export type StyleStructuralRange = {
  /** How they open: lead-with-point, lead-with-self, question-open, fragment, … */
  opening: StyleAxisItem[];
  /** Macro shape: one-liner, two-beat, list-ish, story, … */
  shape: StyleAxisItem[];
  /** Stance posture: agree-extend, push-back, reframe, ask, … */
  stance: StyleAxisItem[];
  /** Provenance: number of own-posts the range was distilled from. */
  learnedFrom?: number;
};

/**
 * How a voice's own writing reads, as rates and ranges: what a drafter aims
 * at and what the judge and the lint hold a draft to. MEASURED from the
 * comments the owner wrote (`measureVoiceTraits`, core/ai/voiceTraits.ts — an
 * agent draft the owner merely approved never counts) and SET by the owner
 * through `StyleRules.traits`, where a set value beats the measured one. Every
 * field is optional: absent = nothing known, nothing asked. Rates are shares
 * of comments, 0..1.
 */
export type VoiceTraits = {
  /** How formal the writing is. */
  register?: "casual" | "neutral" | "formal";
  /** The word range most of their comments fall in. */
  lengthWords?: { min: number; max: number };
  /** How their comments open and end, in their own words, most used first. */
  openers?: string[];
  closers?: string[];
  /** Share of comments that ask a question. */
  questionRate?: number;
  /** Share of their QUESTIONS that hand over two options to pick from. */
  eitherOrRate?: number;
  /** Share that volunteer advice ("I would…", "I'd…"). */
  adviceRate?: number;
  /** Average moves per comment, where a question and a piece of advice are
   *  each one, and a comment with neither is one. */
  movesPerComment?: number;
  /** Share that react with a short tag of two or three words set off on its
   *  own at the end of a sentence. */
  tagPhraseRate?: number;
  /** Punctuation: share using an exclamation mark, and share whose last
   *  sentence has no closing mark. */
  exclamationRate?: number;
  bareEndingRate?: number;
  /** Share that set a clause off with a colon mid-sentence; a time or a URL
   *  is no colon. */
  colonRate?: number;
  /** How they set an aside off, by majority over their texts that have one:
   *  " - ", "—", parentheses or commas. */
  asideStyle?: "spaced_hyphen" | "em_dash" | "parentheses" | "comma";
  /** Share that name a figure — a number, an amount, a percentage — or a
   *  product, tool or company. */
  specificityRate?: number;
  /** The phrases and marks they repeat — a run of words, a face, an emoji,
   *  an ellipsis — each with the share of their comments that carry it. Found
   *  in their own writing, never listed; a draft carries each at about that
   *  rate, never in every comment. */
  signatures?: { phrase: string; rate: number }[];
  /** Set at resolution, never stored or set by anyone: the language a voice
   *  writes in where it is not English, which the detectors built on English
   *  words then leave to the judge. */
  language?: string;
  /** Set at resolution, never stored or set by anyone: which of the values
   *  above were measured rather than set by the owner, and on how many of the
   *  owner's texts (and questions, and asides) — what decides whether a
   *  measured habit binds the judge and the gate, or only guides the writer.
   *  `strictness` is the voice's `DraftingKnobs.voiceStrictness` where it is
   *  not "normal": how much of that writing a measured "never" takes to bind. */
  evidence?: {
    learned: Exclude<keyof VoiceTraits, "evidence" | "language">[];
    texts: number;
    questions: number;
    asides?: number;
    strictness?: "loose" | "strict";
  };
};

/**
 * How a voice's drafts are written, as tuning the owner (or their agent) sets
 * per voice — each one a real path in the engine, each absent field today's
 * default. `preview_drafts` tries a set on one post before it is kept.
 */
export type DraftingKnobs = {
  /** How many of the owner's examples one draft is shown. Default 6. */
  exemplarCount?: number;
  /** "rotate" (default): a seeded `exemplarCount` of them, different for each
   *  draft. "all": every example, every draft. */
  exemplarMode?: "rotate" | "all";
  /** How a habit the owner has at a rate is dealt across drafts. "strict"
   *  (default): a draft not dealt one is told to leave it out, and a run of
   *  drafts past the owner's rate by two standard deviations is flagged.
   *  "soft": leaving it out is a preference, and the run takes three. "off":
   *  nothing is dealt or flagged. */
  rationing?: "off" | "soft" | "strict";
  /** How much of the owner's own writing a measured "never" takes to bind the
   *  judge and the gate: "loose" — none does, only what the owner set;
   *  "normal" (default) — ten texts, five questions, five asides; "strict" —
   *  five texts, two questions, two asides. */
  voiceStrictness?: "loose" | "normal" | "strict";
};

/**
 * Structured anti-AI-tell / register settings owned by a Voice. EVERY field is
 * nullable — null (or absent) = INHERIT the corresponding field of the built-in
 * default template ("prompts are settings": an empty DB value tracks the live
 * shipped default, so accounts that never touch a field pick up improvements).
 * The fully-resolved, non-null view (`ResolvedStyleRules`) is what the writer,
 * the slop judge, and the client validator consume — one source, three
 * renderings. Types live here because `database` cannot import from `core`
 * (one-way dependency, same as StyleStructuralRange above).
 */
/** Where an example of the owner's writing came from: pasted or typed in,
 *  kept from a text of theirs on the Voice page, dictated, or their answer
 *  to "a comment you are proud of". */
export type VoiceExampleOrigin = "pasted" | "kept" | "dictated" | "answer";

/** One example of how the owner writes, as a voice keeps it. */
export type VoiceExample = {
  text: string;
  /** Listed first, and never dropped to make room under the cap. */
  pinned: boolean;
  /** When it was kept; null for one kept before examples were dated. */
  addedAt: number | null;
  from: VoiceExampleOrigin;
  /** The drafts that see it first: Comment's, or a reply's or a DM's. */
  channel: "comment" | "reply" | "dm";
};

/** One answer to a sample comment in a voice: whether it sounds like the
 *  owner, and when they said so. */
export type VoiceSampleAnswer = {
  text: string;
  soundsLikeMe: boolean;
  at: number;
};

export type StyleRules = {
  /** Em-dashes (—) in generated text. Template: "forbid" (a strong AI tell). */
  emDashes: "allow" | "forbid" | null;
  /** Semicolons. Template: "forbid" (AI tell; a period/comma reads more human). */
  semicolons: "allow" | "forbid" | null;
  /** Max emojis per generated text; 0 = never. Template: 1. */
  emojiMax: number | null;
  /** "sentence" normal casing | "lowercase" starts lines lowercase | "mirror"
   *  follow the voice's houseStyle exactly. Template: "sentence". */
  casing: "sentence" | "lowercase" | "mirror" | null;
  /** Case-insensitive opener prefixes never to use (sycophancy tells).
   *  Template: the classic "Great post"/"Thanks for sharing" set. NEVER learned
   *  from the user's corpus — it's an anti-tell list, not a habit. */
  bannedOpeners: string[] | null;
  /** "natural" = questions only when earned, never by reflex (question-cap
   *  mechanism still applies) | "never" = never end on a question | "encouraged"
   *  = prefer a pointed closing question when the post invites one. Template:
   *  "natural". The owner's to set, never learned: how often they ask is
   *  their measured `traits.questionRate`. */
  closerQuestionPolicy: "natural" | "never" | "encouraged" | null;
  /** Shorthand (imo, tbh, w/, &). Template: "allow" (where it fits the voice). */
  shorthand: "allow" | "forbid" | null;
  /** Human rough edges (fragments, dropped commas). Template: "allow". */
  roughEdges: "allow" | "forbid" | null;
  /** Free-text extra register rules (newline "- " bullets), appended verbatim to
   *  the rendered register block. Not inherited — template value is "". Voice-
   *  level guidance-from-edit appends here. */
  extras: string | null;
  /** The traits the OWNER set by hand for comments, each beating its
   *  measured value. A trait absent here follows the owner's own comments.
   *  Template: none. */
  traits?: VoiceTraits | null;
  /** The traits the owner set for replies and for DMs, each channel its own,
   *  laid over `traits` only while that channel has too few texts of its own
   *  and follows Comment. Absent on a voice whose channels were never split:
   *  every channel is held to `traits`, as before they could be, until a
   *  trait is next set (`updateVoice`). Template: none. */
  traitsByChannel?: { reply?: VoiceTraits | null; dm?: VoiceTraits | null } | null;
  /** Comments the owner gave, verbatim, as examples of how they write
   *  (`save_voice`), newest first. Every writer shows them ahead of
   *  everything learned, and the trait measurement reads them as the owner's
   *  own. Not inherited — template: none.
   *
   *  The Comment channel's words alone, in the shape every release reads:
   *  `exampleItems` carries each example's pin, origin and channel, and every
   *  write keeps the two in step (`examplesFields`). */
  examples?: string[] | null;
  /** Every example the owner gave, each for one channel, newest first, with
   *  where it came from and whether it is pinned. Read with `examples`
   *  (`voiceExamples`): a voice kept before this field has only those. */
  exampleItems?: VoiceExample[] | null;
  /** How the owner says they want to sound, in their own words. Every writer
   *  reads it beside the description and a relearn anchors on it; it is
   *  never evidence of how they write, so nothing measures it. Not
   *  inherited — template: none. */
  ownWords?: string | null;
  /** Who the owner writes to, in their words. Read like `ownWords`. */
  writesTo?: string | null;
  /** What the owner said of sample comments written in this voice (Does this
   *  sound like you?), newest first. A relearn anchors on it like
   *  `ownWords`; the texts are worker-written, so it is never a sample and
   *  never evidence of how they write. Not inherited — template: none. */
  sampleAnswers?: VoiceSampleAnswer[] | null;
  /** Words and phrases the owner never uses. Firm by construction: every
   *  writer is told, and the lint refuses a draft that holds one as a whole
   *  word. Not inherited — template: none. */
  avoidWords?: string[] | null;
  /** How this voice's drafts are written (`DraftingKnobs`). Not inherited —
   *  template: none, which is every knob at its default. */
  knobs?: DraftingKnobs | null;
  /** Who set each register field the template would otherwise give: the
   *  owner, or a calibration that learned it. A null field has none — it is
   *  Engager's start. A field set before this was kept has no entry and
   *  reads as the owner's. Stamped by the writes, never taken as input. */
  provenance?: Partial<Record<keyof StyleRules, "owner" | "learned">> | null;
};

/** Fully-resolved view: every field non-null after per-field template fallback. */
export type ResolvedStyleRules = {
  [K in keyof StyleRules]: NonNullable<StyleRules[K]>;
};

/**
 * The OPENING / SHAPE / STANCE class ids the writer was directed to use for ONE
 * generated comment, persisted on the message row for the org-wide LRU rotation +
 * observability. Describes the PROPOSED text only — human edits to `finalText` do
 * NOT update it (see plan provenance note #10).
 */
export type StyleDirectives = {
  opening: string;
  shape: string;
  stance: string;
};

/**
 * What became of the like a send carried (`messages.like_with_send`), as the
 * send and its receipt settled it: `liked` — the connector confirmed it;
 * `unconfirmed` — it may have landed and only the owner's own eyes can say,
 * never re-pressed blind (INV-10); `not_liked` — it definitely did not land;
 * `skipped` — it was never pressed, for `reason`. `receiptId` is its
 * `actions` row, where one was reserved.
 */
export type MessageLikeOutcome = {
  state: "liked" | "unconfirmed" | "not_liked" | "skipped";
  reason?: string;
  receiptId?: number;
  at: number;
};

/**
 * Per-draft decision trace persisted on `messages.trace` — WHY this draft looks the
 * way it does (length tier chosen, slop gate applied, voice/facts provenance).
 * Trust boundary: every top-level section is SERVER-computed. Values an MCP client
 * self-reports live ONLY under `client.declared`; `client.verified` is recomputed
 * server-side at intake and is the only client-path truth. `facts`/`author`/`voice`
 * are filled by later feature PRs — additive, no version bump needed while fields
 * stay optional.
 */
export type DraftTrace = {
  v: 1;
  source: "server" | "client";
  length?: {
    tier: "ultra_short" | "short" | "medium" | "long";
    mode: "auto" | "pinned";
    factors: string[];
  };
  slop?: {
    mode: "auto" | "pinned";
    strictness: number;
    threshold: number;
    score: number | null;
    violations?: string[];
    retried?: boolean;
    attempts?: { score: number; violations?: string[] }[];
  };
  /** Convenience mirror of the message's styleDirectives (one place to read). */
  style?: { opening?: string; shape?: string; stance?: string };
  /** A worker's judged set (spec 5.2): the move that won and why, every
   *  draft's total, and the two drafts it beat. Server-computed.
   *
   *  The set is numbered from Engager's pick, draft 1, then the drafts it beat
   *  in the order `others` first held them. The owner may put another in the
   *  box (`useDraftVariant`): the two trade places, `move` and `draft` then
   *  name the draft in the box, and `why` still says why Engager picked
   *  draft 1. A number absent is the draft's place in that first order. Each
   *  of `others` keeps the owner story it tells and its writer's rationale,
   *  which travel with its words into the box.
   *
   *  A draft the owner asked their agent for, from one of the post's angles
   *  (`addAskedDraft`), joins the set as its next number, `asked` and with
   *  that `angle`; `asked` and `angle` travel with its words in and out of the
   *  box like the rest. A draft written alone gains a set this way, its
   *  `why` empty (Engager picked nothing) and its `move` empty where its
   *  writer named none. */
  pick?: {
    move: string;
    why: string;
    scores: number[];
    others: {
      move: string;
      text: string;
      draft?: number;
      ownerStoryId?: number;
      rationale?: string;
      asked?: true;
      angle?: string;
    }[];
    draft?: number;
    asked?: true;
    angle?: string;
  };
  voice?: {
    channel?: string;
    source?: string;
    /** The Voice entity the draft resolved to (absent = legacy/template). */
    voiceId?: number;
    /** How the voice resolved: campaign_voice | org_default_voice | legacy_profile | template. */
    resolvedFrom?: string;
  };
  facts?: {
    enabled: boolean;
    searched: number;
    sources?: { url: string; title?: string; date?: string }[];
    staleWarning?: boolean;
    surcharge?: string;
    declaredByClient?: boolean;
  };
  author?: {
    profileId?: string;
    followers?: number | null;
    connections?: number | null;
    isInfluencer?: boolean | null;
    fetchedAt?: number;
  };
  client?: {
    declared?: {
      lengthTier?: string;
      lengthWhy?: string;
      slopSelfScore?: number;
      slopStrictness?: number;
      /** The agent's human-readable why: why this post, what angle it took. */
      rationale?: string;
    };
    verified?: {
      wordCount: number;
      tierByWords: string;
      withinCap: boolean;
      lint?: string[];
    };
  };
};

/** Scopes a hosted-MCP API key may carry (enforced by the MCP server). */
export type ApiKeyScope =
  | "feed:read"
  | "messages:write"
  | "ops:write"
  | "brain:write"
  | "billing:read"
  | "billing:manage"
  | "linkedin:manage"
  | "runner:execute";

/** Credential classes are mutually exclusive trust boundaries, not UI labels. */
export type ApiKeyCredentialProfile =
  | "legacy"
  | "interactive"
  | "runner"
  | "public_api";

/** Why a credential was authorized. Setup-proof credentials may authorize a
 * future renewal and therefore require a purpose-bound owner approval flow. */
export type ApiKeyAuthorizationPurpose =
  | "general"
  | "runner_setup_proof"
  | "scheduled_curate"
  | "scheduled_review";

/** Purpose asserted by a device before the user sees the approval screen. */
export type DeviceAuthPurpose = ApiKeyAuthorizationPurpose;

// Identity & tenancy

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    logo: text("logo"),
    // Stripe customer (per-org billing)
    billingCustomerId: text("billing_customer_id"),
    // PER-PROJECT onboarding-wizard progress (drives the wizard's resume/gate). Null =
    // not started; a step slug while in progress; `onboardingCompletedAt` set when done.
    // (Per-org, unlike the dead per-user users.completedOnboarding — never reuse that.)
    // "paywall"/"trial" are legacy values kept so existing rows still
    // typecheck. The first-value flow is deliberately value-before-payment:
    // linkedin → product → campaign → preview → agent → done.
    onboardingStep: text("onboarding_step", {
      enum: [
        "linkedin",
        "product",
        "preview",
        "trial",
        "agent",
        "done",
        "campaign",
        "paywall",
      ],
    }),
    onboardingCompletedAt: bigint("onboarding_completed_at", {
      mode: "number",
    }),
    // First-Radar is an explicit operating choice. It is separate from the
    // legacy runner/interactive transport choice above: Curate only judges
    // relevance, while Review may also collect and later propose comments.
    onboardingRadarLevel: text("onboarding_radar_level", {
      enum: ["curate", "review"],
    }),
    // The user chooses whether Engager is driven manually or by a narrowly
    // scoped host routine after Radar calibration. This never means auto-post.
    onboardingExecutionMode: text("onboarding_execution_mode", {
      enum: ["manual", "scheduled"],
    }),
    onboardingFirstRunChoice: text("onboarding_first_run_choice", {
      enum: ["run_now", "next_schedule", "manual"],
    }),
    onboardingHostApprovalState: text("onboarding_host_approval_state", {
      enum: ["pending", "enabled", "declined", "unsupported"],
    }),
    // The owner's explicit pre-connect acknowledgement of LinkedIn account
    // risk ({when, who}) — durable consent evidence recorded by the onboarding
    // wizard before the first connect attempt. Written once; never re-asked.
    linkedinRiskAcknowledgedAt: bigint("linkedin_risk_acknowledged_at", {
      mode: "number",
    }),

    // Replies to comments on the org's OWN posts. Org-level on purpose: own posts
    // exist independently of any campaign (campaigns engage OTHER people's posts;
    // their per-campaign Reply mode gates only thread replies the campaign started).
    ownPostReplies: jsonb("own_post_replies").$type<{
      mode: "off" | "review" | "auto";
      sensitivity_gate: boolean;
      prompt: string;
    }>(),
    // Per-role model overrides the owner set on the Agent page. Only the keys
    // the owner explicitly chose are present; every unset role falls through to
    // `roleModels()` (env → shipped defaults). Null = no overrides. Read at the
    // inference entry boundary (`boundaryModelScopeFor`), never by `modelFor`
    // itself — the single-reader rule on `config.models` is untouched.
    modelOverrides: jsonb("model_overrides").$type<
      Partial<Record<"filter" | "writer" | "writerPremium" | "chat", string>>
    >(),
    // Executable the claude adapter spawns, when the owner set one in-app.
    // Null = env (`ENGAGER_AGENT_CLI_BIN`) → "claude". Applies only when the
    // resolved adapter is claude, so it can never clobber a codex pin. A stored
    // spawn path is arbitrary code execution if this row is compromised; the
    // mitigations are the local single-user database, the save-time
    // executability probe, and that no MCP tool may write this column — the
    // agent must never repoint its own spawns.
    agentCliBin: text("agent_cli_bin"),
    // Server-computed license trial deadline (epoch-ms), set by hosted issuance
    // and read verbatim by local enforcement per INV-17 — never re-derived from
    // plan/status here. Nullable, not defaulted: a founder/comp account is this
    // one column set far-future by an admin, no second column, no enum value.
    licenseTrialEndsAt: bigint("license_trial_ends_at", { mode: "number" }),
    // The first-campaign wizard's inputs while the owner is still answering
    // (US-ONG-01): the line, the agent's draft, the depth. A working copy the
    // corridor reads back after a quit and relaunch; null before the wizard is
    // opened and again once the campaign is created. Parsed by
    // `core/operations/firstCampaignDraft`. The cloud runs the same migration
    // and leaves it null.
    firstCampaignDraft: jsonb("first_campaign_draft"),
    /** Last account explicitly rejected during setup; no profile text retained. */
    rejectedLinkedinAccountId: text("rejected_linkedin_account_id"),
    // Ships dark: on, Find leads' screen drops a short comment with no question
    // by a rule, before any model call; off, every pending word goes to the
    // model. Never set by inference.
    leadScreenRule: boolean("lead_screen_rule").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    billingCustomerUnq: uniqueIndex("organizations_billing_customer_uidx")
      .on(t.billingCustomerId)
      .where(sql`${t.billingCustomerId} is not null`),
    onboardingRadarLevelCheck: check(
      "organizations_onboarding_radar_level_check",
      sql`${t.onboardingRadarLevel} is null or ${t.onboardingRadarLevel} in ('curate', 'review')`,
    ),
    onboardingExecutionModeCheck: check(
      "organizations_onboarding_execution_mode_check",
      sql`(${t.onboardingExecutionMode} is null and ${t.onboardingFirstRunChoice} is null and ${t.onboardingHostApprovalState} is null) or (${t.onboardingExecutionMode} = 'manual' and ${t.onboardingFirstRunChoice} = 'manual' and ${t.onboardingHostApprovalState} is null) or (${t.onboardingExecutionMode} = 'scheduled' and (${t.onboardingFirstRunChoice} is null or ${t.onboardingFirstRunChoice} in ('run_now', 'next_schedule')) and (${t.onboardingHostApprovalState} is null or ${t.onboardingHostApprovalState} in ('pending', 'enabled', 'declined', 'unsupported')))`,
    ),

  }),
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name"),
    email: text("email").notNull().unique(),
    emailVerified: timestamp("email_verified", { mode: "date" }),
    image: text("image"),
    completedOnboarding: boolean("completed_onboarding")
      .notNull()
      .default(false),
    // Cloud account creation records Terms acceptance (US-ONB-01). Both stay
    // null on local installs, which never read them (MIG-8).
    termsAcceptedAt: bigint("terms_accepted_at", { mode: "number" }),
    termsVersion: text("terms_version"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
);

// Auth.js Drizzle adapter shape
export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    // @auth/drizzle-adapter expects an integer (unix seconds) here.
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
  }),
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.identifier, t.token] }) }),
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["member", "admin"] })
      .notNull()
      .default("member"),
    isOwner: boolean("is_owner").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgUserUnq: uniqueIndex("memberships_org_user_unq").on(
      t.organizationId,
      t.userId,
    ),
    userIdx: index("memberships_user_idx").on(t.userId),
  }),
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    token: uuid("token").notNull().defaultRandom().unique(),
    role: text("role", { enum: ["member", "admin"] })
      .notNull()
      .default("member"),
    status: text("status", { enum: ["pending", "accepted", "revoked"] })
      .notNull()
      .default("pending"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({ orgIdx: index("invitations_org_idx").on(t.organizationId) }),
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(), // Stripe subscription id
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    active: boolean("active").notNull().default(false),
    provider: text("provider").notNull().default("stripe"),
    // `priceAuthorized` is resolved + frozen at upsert time (on the dashboard,
    // where STRIPE_PRICE_* env exists). The worker can preserve the exact
    // authorized Price without carrying Stripe catalog env; a changed unknown
    // Price fails closed. jsonb → adding fields needs no SQL migration. An
    // older row may still carry a `creditsPerMonth` key; nothing reads it.
    items: jsonb("items").$type<
      {
        priceId: string;
        quantity: number;
        priceAuthorized?: boolean;
      }[]
    >(),
    periodStartsAt: bigint("period_starts_at", { mode: "number" }),
    periodEndsAt: bigint("period_ends_at", { mode: "number" }),
    trialEndsAt: bigint("trial_ends_at", { mode: "number" }),
    /** New-tier offer provenance, frozen when the projection first recognized
     * one unit of one catalogued Engager offer. Null on every historical row —
     * a Pro subscription, a comp trial, a legacy price alias — which is exactly
     * why those rows stay readable and grant nothing (TIER-11). The catalogue
     * lives in `packages/billing/offer.ts`; this column is its frozen echo, so
     * a later price rotation cannot re-interpret an existing generation. */
    offerId: text("offer_id", {
      enum: ["mac_monthly_v1", "cloud_monthly_v1"],
    }),
    offerTerms: jsonb("offer_terms").$type<{
      offerId: "mac_monthly_v1" | "cloud_monthly_v1";
      priceId: string;
      unitAmount: number;
      currency: string;
      interval: "month";
      quantity: 1;
    }>(),
    /** Monotonic paid generation within the organization, assigned once per
     * subscription. The canonical commercial projection always reads the
     * highest one, so a replayed or reordered provider event cannot revive a
     * canceled generation however positive it looks. Zero = pre-P4 row. */
    commercialGeneration: bigint("commercial_generation", { mode: "number" })
      .notNull()
      .default(0),
    /** The instant paid service ends. Advanced only by a settled paid period;
     * `past_due` deliberately never moves it, so dunning extends nothing. */
    paidThrough: bigint("paid_through", { mode: "number" }),
    /** Refund or revocation ends paid service earlier than `paidThrough`. */
    revokedAt: bigint("revoked_at", { mode: "number" }),
    /** A confirmed full refund permanently revokes this subscription generation,
     * even when its paid-period webhook has not arrived yet. */
    confirmedRefundAt: bigint("confirmed_refund_at", { mode: "number" }),
    /** The server instant the projection first saw the current failure
     * episode (US-ONA-04). Set once on the first still-failing
     * `invoice.payment_failed`, cleared when an invoice settles; the 24-hour
     * grace arithmetic runs on this clock, never the Stripe event's. Null on
     * every row that has never failed — and always on a Mac's local database,
     * which carries the column only so one schema serves both. */
    paymentFailedAt: bigint("payment_failed_at", { mode: "number" }),
    // First-value onboarding creates a provider-guarded trial: cancelAt equals
    // trialEndsAt until an immutable subscription activation clears it.
    cancelAt: bigint("cancel_at", { mode: "number" }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    checkoutSessionId: text("checkout_session_id"),
    checkoutTerms: jsonb("checkout_terms").$type<{
      termsVersion: "2026-07-10";
      unitAmount: number;
      currency: string;
      interval: "month" | "year";
      trialKind: "initial" | "returning_activation_window";
      trialDays: number;
    }>(),
    // Owner-confirmed cancellation of an UNUSED guarded trial is a two-system
    // operation. This durable claim fences setup-proof/manual activation while
    // Stripe is being canceled and canonically reprojected; ambiguous provider
    // failures keep the token so the same operation can resume safely.
    guardedCancellationToken: uuid("guarded_cancellation_token"),
    guardedCancellationStartedAt: bigint("guarded_cancellation_started_at", {
      mode: "number",
    }),
    guardedCancellationRequestedByUserId: uuid(
      "guarded_cancellation_requested_by_user_id",
    ).references(() => users.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdx: index("subscriptions_org_idx").on(t.organizationId),
    // The public flow has no upgrade/replacement path while a subscription is
    // active. Reject concurrent or foreign Checkout races at the database edge
    // instead of letting plan/credit queries pick an arbitrary active row.
    activeOrgUnq: uniqueIndex("subscriptions_active_org_uidx")
      .on(t.organizationId)
      .where(sql`${t.active} = true`),
    orgIdUnq: uniqueIndex("subscriptions_org_id_unq").on(
      t.organizationId,
      t.id,
    ),
    checkoutSessionUnq: uniqueIndex("subscriptions_checkout_session_unq")
      .on(t.checkoutSessionId)
      .where(sql`${t.checkoutSessionId} is not null`),
    guardedCancellationPairCheck: check(
      "subscriptions_guarded_cancellation_pair_check",
      sql`(${t.guardedCancellationToken} is null and ${t.guardedCancellationStartedAt} is null and ${t.guardedCancellationRequestedByUserId} is null) or (${t.guardedCancellationToken} is not null and ${t.guardedCancellationStartedAt} is not null)`,
    ),
  }),
);

/**
 * One provider Checkout reservation per organization. This is deliberately a
 * billing-global table (like subscriptions): Checkout starts before a Stripe
 * webhook exists, so every query must bind organizationId explicitly.
 *
 * `claimId` is stable across retries of one provider request. A process that
 * loses its response can take over the expired lease and retry with the same
 * Stripe idempotency key instead of creating a second subscription.
 */
export const billingCheckoutClaims = pgTable("billing_checkout_claims", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  claimId: uuid("claim_id").notNull().defaultRandom().unique(),
  interval: text("interval", { enum: ["monthly", "yearly"] }).notNull(),
  priceId: text("price_id").notNull(),
  billingCustomerId: text("billing_customer_id").notNull(),
  trialDays: integer("trial_days"),
  successUrl: text("success_url").notNull(),
  cancelUrl: text("cancel_url").notNull(),
  status: text("status", { enum: ["creating", "open"] })
    .notNull()
    .default("creating"),
  checkoutSessionId: text("checkout_session_id"),
  checkoutUrl: text("checkout_url"),
  leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }).notNull(),
  checkoutExpiresAt: bigint("checkout_expires_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
  updatedAt: bigint("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
});

/**
 * The Macs one paid account has registered. Append-only: revoking a seat sets
 * `revoked_at` and the row stays as its own audit record, so re-registering a
 * revoked device key is a refusal rather than a silent resurrection. A new Mac
 * mints a NEW opaque random key — there is no hardware fingerprint here and
 * none is derivable from a row.
 *
 * Billing-global like `subscriptions`: the cloud binds a seat to an
 * organization resolved from a token it signed itself, before any tenant scope
 * exists, so every query carries its organization predicate explicitly.
 */
export const licenseSeats = pgTable(
  "license_seats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** sha256 of the device key the Mac holds. Plaintext is never stored. */
    deviceKeyHash: text("device_key_hash").notNull().unique(),
    /** Owner-visible name, e.g. "Slava's MacBook Pro". Never an identifier. */
    label: text("label"),
    assignedAt: bigint("assigned_at", { mode: "number" }).notNull(),
    assignedByUserId: uuid("assigned_by_user_id"),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    revokedByUserId: uuid("revoked_by_user_id"),
    revokedReason: text("revoked_reason", {
      enum: ["owner_removed", "reassigned", "account_closed"],
    }),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }),
  },
  (t) => ({
    orgIdx: index("license_seats_org_idx").on(t.organizationId),
    activeOrgIdx: index("license_seats_active_org_idx")
      .on(t.organizationId)
      .where(sql`${t.revokedAt} is null`),
    revocationPairCheck: check(
      "license_seats_revocation_pair_check",
      sql`(${t.revokedAt} is null and ${t.revokedReason} is null) or (${t.revokedAt} is not null and ${t.revokedReason} is not null)`,
    ),
  }),
);

/**
 * One durable offer-change or new-paid-period intent (ADR-05). Recorded BEFORE
 * any provider mutation with the exact quote it was accepted against, so a lost
 * provider response is reconciled against this row instead of retried into a
 * second recurring subscription. One open intent per organization is the
 * database's own "never two recurring offers" fence.
 *
 * Billing-global for the same reason as `billing_checkout_claims`: the intent
 * exists before the subscription it will change.
 */
export const commercialOfferIntents = pgTable(
  "commercial_offer_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null for a first purchase; the replaced generation for a change. */
    fromSubscriptionId: text("from_subscription_id"),
    fromOfferId: text("from_offer_id", {
      enum: ["mac_monthly_v1", "cloud_monthly_v1"],
    }),
    toOfferId: text("to_offer_id", {
      enum: ["mac_monthly_v1", "cloud_monthly_v1"],
    }).notNull(),
    /** The provider-computed quote the owner accepted, in minor units. No
     * proration is invented locally: an unvalidated quote refuses the change. */
    quoteUnitAmount: bigint("quote_unit_amount", { mode: "number" }).notNull(),
    quoteCurrency: text("quote_currency").notNull(),
    quoteCreditAmount: bigint("quote_credit_amount", { mode: "number" }),
    quoteExpiresAt: bigint("quote_expires_at", { mode: "number" }).notNull(),
    /** Frozen at record time; a later subscription revision invalidates it. */
    quoteSubscriptionRevision: text("quote_subscription_revision").notNull(),
    /** `scheduled` is a settled outcome, not a failure: a downgrade takes
     * effect at the paid period end, so the provider legitimately still
     * reports the CURRENT offer until `effectiveAt`. It remains open for the
     * "one change at a time" fence below until the boundary lands it. */
    status: text("status", {
      enum: [
        "recorded",
        "dispatched",
        "scheduled",
        "applied",
        "failed",
        "abandoned",
      ],
    })
      .notNull()
      .default("recorded"),
    /** When a scheduled change starts, epoch ms — the paid period boundary the
     * provider set it against. Null for an immediate change. */
    effectiveAt: bigint("effective_at", { mode: "number" }),
    /** Stable across retries of the one provider request. */
    providerOperationId: uuid("provider_operation_id").notNull().defaultRandom(),
    /** Checkpoint between creating a provider schedule and installing its phases. */
    providerScheduleId: text("provider_schedule_id"),
    appliedSubscriptionId: text("applied_subscription_id"),
    appliedGeneration: bigint("applied_generation", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdx: index("commercial_offer_intents_org_idx").on(t.organizationId),
    openOrgUnq: uniqueIndex("commercial_offer_intents_open_org_unq")
      .on(t.organizationId)
      .where(sql`${t.status} in ('recorded', 'dispatched', 'scheduled')`),
    operationUnq: uniqueIndex("commercial_offer_intents_operation_unq").on(
      t.providerOperationId,
    ),
  }),
);

/**
 * Global, durable authority for the one initial Engager trial an owner may
 * consume. The primary key is the immutable Auth user id, not an organization:
 * creating another tenant therefore cannot reset trial or hosted-credit
 * eligibility. `initialOrganizationId` deliberately has no organization FK.
 * Deleting a project must not erase this abuse-control history and make the
 * same owner look new again.
 *
 * This identity/billing table is intentionally outside tenant RLS. Checkout
 * serializes decisions on `ownerUserId` before inserting or reading it, and the
 * app role is narrowed to SELECT+INSERT in migrate.ts.
 */
export const ownerInitialTrialClaims = pgTable(
  "owner_initial_trial_claims",
  {
    ownerUserId: uuid("owner_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "no action" }),
    initialOrganizationId: uuid("initial_organization_id").notNull(),
    claimedAt: bigint("claimed_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    initialOrganizationIdx: index(
      "owner_initial_trial_claims_initial_org_idx",
    ).on(t.initialOrganizationId),
  }),
);

export type InitialHostedSetupLane =
  | "ingest_product"
  | "import_voice"
  | "compile_campaign";
export type InitialHostedClaimSource = "runtime" | "backfill" | "compatibility";

export type RunnerDisconnectRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "acknowledged";

// Device authorization for the hosted license. Identity rows are created before
// an organization is known, and only the device code's hash is stored.
export const licenseDeviceRequests = pgTable(
  "license_device_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256 of the device secret the client holds — the poll credential. */
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    /** Short human code the user confirms on the approval page. */
    userCode: text("user_code").notNull().unique(),
    /** e.g. "engager-agent on Slavas-MacBook-Pro" — shown at approval. */
    clientName: text("client_name"),
    status: text("status", {
      enum: ["pending", "approved", "denied", "claimed"],
    })
      .notNull()
      .default("pending"),
    userId: uuid("user_id"),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    /** Last accepted poll for server-side enforcement of the advertised cadence. */
    lastPolledAt: bigint("last_polled_at", { mode: "number" }),
  },
  (t) => ({
    expiresAtIdx: index("license_device_requests_expires_at_idx").on(
      t.expiresAt,
    ),
    statusCheck: check(
      "license_device_requests_status_check",
      sql`${t.status} in ('pending', 'approved', 'denied', 'claimed')`,
    ),
  }),
);

// Opaque, hashed-at-rest refresh tokens for the hosted license, rotated on
// use with the old token revoked — the storage revocation needs, landing with
// the device flow rather than as a surprise in the issuance task. The Ed25519
// signing key never enters this file: it is read from the deployment
// environment only.
export const licenseRefreshTokens = pgTable(
  "license_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256 of the refresh token; plaintext is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    /** Set the moment rotation issues a successor token. */
    revokedAt: bigint("revoked_at", { mode: "number" }),
    /** Exact-operation retries recover the same encrypted response only. */
    refreshOperationId: uuid("refresh_operation_id"),
    refreshResponseCiphertext: text("refresh_response_ciphertext"),
    refreshReplayExpiresAt: bigint("refresh_replay_expires_at", { mode: "number" }),
  },
  (t) => ({
    orgIdx: index("license_refresh_tokens_org_idx").on(t.organizationId),
  }),
);

// The cloud's whole record of a problem report it relayed to the team
// (US-BUG-05): the report's id — the install's idempotency key — which install
// sent it, when, and the provider's message id once it went. A retry of the
// same id answers that message id and sends nothing; a row whose message id is
// still null was claimed and not confirmed sent, and a retry sends it again
// under the same provider idempotency key. The report's content is never
// stored here, only relayed. Not RLS-scoped: the install is anonymous until a
// credential resolves, and the row is the relay's bookkeeping, not tenant data.
export const reportRelays = pgTable("report_relays", {
  id: uuid("id").primaryKey(),
  installId: text("install_id").notNull(),
  receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  messageId: text("message_id"),
});

/**
 * Durable abuse budget for unauthenticated device/public-auth endpoints and
 * authenticated public-API request ceilings. Keys are namespaced opaque hashes
 * (plus scoped deployment keys); no raw IP/email/credential/org identifier is
 * stored.
 */
export const deviceAuthRateLimits = pgTable(
  "device_auth_rate_limits",
  {
    key: text("key").primaryKey(),
    windowStartedAt: bigint("window_started_at", { mode: "number" }).notNull(),
    count: integer("count").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    updatedAtIdx: index("device_auth_rate_limits_updated_at_idx").on(
      t.updatedAt,
    ),
  }),
);

// The physical table predates password signup. Keep the compatibility export for
// device auth while naming its shared public-auth role explicitly for new code.
export const publicAuthRateLimits = deviceAuthRateLimits;

/**
 * Global deployment identity. This is intentionally NOT RLS-scoped: it must be
 * readable before an org can be selected, so a dev service pointed at prod can
 * fail before touching tenant data.
 */
export const deploymentMetadata = pgTable("deployment_metadata", {
  id: text("id").primaryKey(),
  environment: text("environment", {
    enum: ["local", "test", "dev", "prod", "cloud"],
  }).notNull(),
  // Populated on capability rows after migrations complete. Hosted services
  // bind their immutable process release to this marker before enrollment.
  releaseId: text("release_id"),
  // The coordinated deploy transaction currently allowed to compensate this
  // marker. A rollback must match both SHA and transaction id, so an older
  // workflow cannot overwrite a later publication of the same commit.
  releaseTransactionId: text("release_transaction_id"),
  createdAt: bigint("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
  updatedAt: bigint("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
});

export const databaseFinalisation = pgTable("database_finalisation", {
  id: text("id").primaryKey(),
  journalHead: bigint("journal_head", { mode: "number" }).notNull(),
  journalHash: text("journal_hash").notNull(),
  finalisationDigest: text("finalisation_digest").notNull(),
  finalisedAt: bigint("finalised_at", { mode: "number" }).notNull(),
});

/** Shorthand for the org FK every domain table carries (defaults from the GUC). */
const orgId = () =>
  uuid("organization_id")
    .notNull()
    .default(CURRENT_ORG)
    .references(() => organizations.id, { onDelete: "cascade" });

// Voices (domain) — named register/persona entities, attachable per campaign

export type VoiceProvenance = "learned" | "manual" | "cloned" | "migrated";

/**
 * How one owner save changed the draft it kept, measured by dimension. The
 * values (the phrases and marks the owner added) are theirs, read off the
 * save; nothing here is a list the product ships.
 */
export type EditSignals = {
  v: 1;
  /** The save opens with a question, and the draft asked one. */
  questionFirst: boolean;
  /** The draft's first-person opening sentence is gone. */
  removedSelfIntro: boolean;
  /** Short openers the owner added at the start of a sentence. */
  softeners: string[];
  /** Emoticons and emoji the owner added. */
  emoticons: string[];
  /** Marks in the save, added or kept. */
  marks: number;
  /** The first words of each saved sentence, lowercased, so an opener the
   *  owner keeps is seen as well as one they add. */
  heads: string[];
  /** Contractions in the draft, and how many the owner wrote without the
   *  apostrophe. */
  contractions: number;
  apostropheDrops: number;
  /** Words in the save, and how many are one slip from the draft's word. */
  words: number;
  typos: number;
  /** (saved words − draft words) ÷ draft words. */
  lengthDelta: number;
  /** The draft told an owner story and the save does not. */
  storyRemoved: boolean;
  /** The draft ended on a question and the save does not. Absent on saves
   *  measured before it was read. */
  droppedClosingQuestion?: boolean;
  /** The draft volunteered advice ("I would…") and the save does not. */
  droppedAdvice?: boolean;
  /** The draft set off a short tag at the end of a sentence and the save
   *  does not. */
  droppedTagPhrase?: boolean;
  /** The save opens on words of the owner's own where the draft's opener was
   *  — those words, or null when the opener stayed. */
  ownOpener?: string | null;
};

/** Every way a voice can learn to edit drafts — the one list the type, the
 *  owner's switches and the writer all read. */
export const LEARNED_DIRECTIVE_KINDS = [
  "question_first",
  "no_self_intro",
  "softeners",
  "emoticons",
  "dropped_apostrophes",
  "typos",
  "shorter",
  "longer",
  "no_owner_story",
] as const;

export type LearnedDirectiveKind = (typeof LEARNED_DIRECTIVE_KINDS)[number];

/** One way a voice edits drafts, seen in enough of its recent saves to apply. */
export type LearnedDirective = {
  kind: LearnedDirectiveKind;
  /** In how many of the last ten measured saves it showed. */
  seen: number;
  /** The owner's own phrases or marks, most used first. */
  values?: string[];
  /** A share (apostrophes, length) or a per-100-words rate (typos). */
  rate?: number;
  /** When it last started to apply: the rollup it first passed the floor in.
   *  Absent on one that applied before this was kept. */
  firstAppliedAt?: number;
};

/** The draft's moves an owner's saves keep cutting or replacing — learned and
 *  switched off exactly like a directive, kept apart so each list stays the
 *  closed set its readers branch on. */
export const LEARNED_MOVE_KINDS = [
  "no_closing_question",
  "no_advice",
  "no_tag_phrase",
  "own_opener",
] as const;

export type LearnedMoveKind = (typeof LEARNED_MOVE_KINDS)[number];

export type LearnedMove = {
  kind: LearnedMoveKind;
  /** In how many of the last ten measured saves it showed. */
  seen: number;
  /** That count as a share of those saves. */
  rate?: number;
  /** The owner's own replacement openers, most used first. */
  values?: string[];
  /** When it last started to apply (`LearnedDirective.firstAppliedAt`). */
  firstAppliedAt?: number;
};

/** Every learned edit a writer follows, and an owner can switch off. */
export type LearnedEdit = LearnedDirective | LearnedMove;
export type LearnedEditKind = LearnedDirectiveKind | LearnedMoveKind;

/** What one channel's measured rewrites show. */
export type LearnedChannelEdits = {
  directives: LearnedDirective[];
  /** Absent on a rollup made before the cut moves were read. */
  moves?: LearnedMove[];
  /** Measured saves the rollup read (at most 30). */
  saves: number;
  updatedAt: number;
};

/** The channels whose rewrites teach habits of their own beside Comment's. */
export type LearnedEditChannel = "reply" | "dm";

/** A voice's habits from rewrites: Comment's at the top level, where every
 *  release reads them, and each other channel's under `byChannel`. */
export type LearnedDirectives = LearnedChannelEdits & {
  /** Absent on a rollup made before replies and DMs learned habits. */
  byChannel?: Partial<Record<LearnedEditChannel, LearnedChannelEdits>>;
};

/** A learned edit the owner switched off: a comment habit by its kind, a
 *  reply or DM habit qualified by its channel ("dm:no_closing_question"). */
export type DisabledLearnedEdit = LearnedEditKind | `${LearnedEditChannel}:${LearnedEditKind}`;

/**
 * A named Voice: the single authority on HOW generated text sounds. Carries
 * per-OUTPUT-channel persona/houseStyle variants (same `VoicesMap` shape as the
 * legacy profile map), voice-level structured register rules (`StyleRules` —
 * null field = inherit the built-in default template), and the voice-learned
 * structural range. Campaigns attach at most one voice (`campaigns.voiceId`);
 * null = the org's default voice (`isDefault`); no voices at all = the code
 * template. Use cases: audience registers, languages, experimentation (clone +
 * swap — `clonedFromId` is a soft ref so deleting the source keeps the clone).
 */
export const voices = pgTable(
  "voices",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    /** BCP-47-ish language tag the voice writes in ("en", "de"); a write-side
     *  hint only — discovery/filter language stays campaign config. */
    language: text("language"),
    /** The org fallback for campaigns with voiceId null. At most one per org
     *  (partial unique index below). */
    isDefault: boolean("is_default").notNull().default(false),
    /** Per-output-channel persona/houseStyle variants (keys "comment"/"post"). */
    channels: jsonb("channels").$type<VoicesMap>(),
    /** Structured register rules; null field = inherit the default template. */
    styleRules: jsonb("style_rules").$type<StyleRules>(),
    /**
     * Who last authored `styleRules`: 'learned' rules may be refined by a later
     * calibration pass (overwrite allowed when fresh direct samples re-observe
     * the register); 'user' rules were set by hand and are never clobbered —
     * recalibration fills nulls only. Any manual styleRules write flips this
     * to 'user'.
     */
    styleRulesSource: text("style_rules_source", {
      enum: ["learned", "user"],
    })
      .notNull()
      .default("user"),
    /** Voice-learned structural range (comment-channel by nature) — feeds the
     *  per-draft style-directive rotation, blended with the default taxonomy. */
    structuralRange: jsonb("structural_range").$type<StyleStructuralRange>(),
    createdFrom: text("created_from", {
      enum: ["learned", "manual", "cloned", "migrated"],
    })
      .notNull()
      .default("manual"),
    /** LinkedIn import creates a useful but explicitly provisional voice.
     * First-Radar comments later refine it without pretending a guess is final. */
    maturity: text("maturity", {
      enum: ["provisional", "calibrating", "calibrated", "failed"],
    })
      .notNull()
      .default("calibrated"),
    /** Compare-and-swap revision for every semantic voice mutation. */
    revision: integer("revision").notNull().default(0),
    calibrationSampleCount: integer("calibration_sample_count")
      .notNull()
      .default(0),
    calibratedAt: bigint("calibrated_at", { mode: "number" }),
    /** Soft ref (no FK): the clone source may be deleted. */
    clonedFromId: bigint("cloned_from_id", { mode: "number" }),
    /** Display card ("what we learned about your voice") — tags + sample. */
    card: jsonb("card").$type<VoiceCard>(),
    /** What this voice's own saves show about how the owner edits a draft
     *  (spec 7), rolled up from `voice_samples.edit_signals`. Null until a
     *  save of an offered draft is measured. */
    learnedDirectives: jsonb("learned_directives").$type<LearnedDirectives>(),
    /** Directive and move kinds the owner switched off, a reply's or a DM's
     *  qualified by its channel; the writer skips them. */
    disabledDirectives: jsonb("disabled_directives")
      .$type<DisabledLearnedEdit[]>()
      .notNull()
      .default([]),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdx: index("voices_org_idx").on(t.organizationId),
    orgIdUnq: uniqueIndex("voices_org_id_unq").on(t.organizationId, t.id),
    // At most ONE default voice per org.
    orgDefaultUnq: uniqueIndex("voices_org_default_unq")
      .on(t.organizationId)
      .where(sql`is_default`),
    revisionCheck: check(
      "voices_revision_check",
      sql`${t.revision} >= 0 and ${t.calibrationSampleCount} >= 0`,
    ),
    maturityCheck: check(
      "voices_maturity_check",
      sql`${t.maturity} in ('provisional', 'calibrating', 'calibrated', 'failed')`,
    ),
  }),
);

/**
 * The durable voice corpus: one row per comment the OWNER actually wrote,
 * captured at SAVE time — not at posting time, and regardless of whether a
 * message row ever exists (a Curate handoff keeps the text here and posts
 * nothing). This is deliberately NOT a query over `messages`: a sample must
 * survive caps, kill switches, rejections, and campaign deletion, carry its
 * frozen authorship measurements, remember which voice revision consumed it,
 * and be individually disownable.
 *
 * Sources: 'first_radar' (onboarding deck), 'radar_deck' (steady-state deck
 * comment box), 'edited_draft' (an approve/edit that substantially rewrote a
 * draft), 'dictated' (owner wording relayed verbatim by their agent),
 * 'owner_dm' (a DM the owner wrote on a conversation's page), 'owner_reply'
 * (a reply the owner wrote, or rewrote from a draft, in the Inbox).
 * 'linkedin_own_reply' / 'linkedin_native' are reserved for the later native-
 * LinkedIn ingestion phase — no writer exists today.
 *
 * `eligible` keeps a row in the corpus (angle learning reads every eligible
 * row). Voice STYLE learns only from the eligible rows the owner wrote most of
 * the words of, decided from the frozen ratios at read time
 * (`ownerAuthoredSample`, core/voice.ts), so a retune moves no row.
 * `usedInVoiceRevision` is the calibration watermark:
 * null = not yet consumed by any calibration run. `disownedAt` is a soft
 * delete — the row stays for audit and dedupe stability, the corpus skips it.
 */
export const voiceSamples = pgTable(
  "voice_samples",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    /** Soft ref (no FK): null = the org's default voice at capture time. */
    voiceId: bigint("voice_id", { mode: "number" }),
    text: text("text").notNull(),
    /** NFKC + whitespace-collapse + lowercase digest for org-wide dedupe. */
    textHash: text("text_hash").notNull(),
    source: text("source", {
      enum: [
        "first_radar",
        "radar_deck",
        "edited_draft",
        "dictated",
        "owner_dm",
        "owner_reply",
        "linkedin_own_reply",
        "linkedin_native",
      ],
    }).notNull(),
    /** Frozen copies of the authorship measurements at capture (null = never
     *  measured, e.g. a blank-box comment with no draft offered). */
    assistRetention: real("assist_retention"),
    ownerOrigin: real("owner_origin"),
    /** In the corpus; see the table comment for what voice style reads. */
    eligible: boolean("eligible").notNull(),
    /** Soft backrefs for audit/UI; no FKs so samples outlive their sources. */
    messageId: bigint("message_id", { mode: "number" }),
    campaignId: bigint("campaign_id", { mode: "number" }),
    discoveredPostId: bigint("discovered_post_id", { mode: "number" }),
    onboardingResponseId: bigint("onboarding_response_id", { mode: "number" }),
    capturedAt: bigint("captured_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    /** Calibration watermark: the voices.revision that consumed this sample. */
    usedInVoiceRevision: integer("used_in_voice_revision"),
    /**
     * Judgment-side classification (2026-07-28 mode-ladder spec): which named
     * moves this comment made, as soft multi-labels {moveId: weight 0..1}
     * against the fixed taxonomy in learning/angleProfile.ts. Classified
     * lazily by the OWNER'S agent inside the recalibration loop — never at
     * save time — so all three columns are null until the client's first
     * classification pass, and a null backlog IS the day-one backfill queue.
     */
    angleLabels: jsonb("angle_labels").$type<Record<string, number>>(),
    /** Whether the comment's angle matched one the agent offered for that
     *  candidate. Null = no angle was ever offered there. */
    angleMatchedOffered: boolean("angle_matched_offered"),
    /**
     * Classification watermark, deliberately independent of
     * `used_in_voice_revision`: the hosted 72h calibration fallback consumes
     * samples, and classification must survive that or a hosted run would
     * silently burn the classification backlog.
     */
    angleClassifiedAt: bigint("angle_classified_at", { mode: "number" }),
    /** How this save changed the draft it kept (spec 7), measured at capture.
     *  Null when no offered draft was measured against. */
    editSignals: jsonb("edit_signals").$type<EditSignals>(),
    disownedAt: bigint("disowned_at", { mode: "number" }),
  },
  (t) => ({
    orgHashUnq: uniqueIndex("voice_samples_org_hash_unq").on(
      t.organizationId,
      t.textHash,
    ),
    /** The corpus read: eligible, not disowned, per org+voice, newest first. */
    orgVoiceIdx: index("voice_samples_org_voice_idx").on(
      t.organizationId,
      t.voiceId,
      t.capturedAt,
    ),
  }),
);

/**
 * Append-only snapshot of a voice at each semantic write — the history the
 * `voices` row deliberately does not keep (`styleRules` is overwritten in
 * place under CAS). One row per LOGICAL calibration/relearn, keyed by the
 * canonical post-write `voices.revision`: a single calibration bumps the CAS
 * counter several times, and only the final value — the same one stamped
 * onto `voice_samples.used_in_voice_revision` — is snapshotted. Gate 1's
 * convergence signal (2026-07-28 mode-ladder spec) compares successive
 * `styleRules` snapshots; 'initial' is the first-Radar baseline so two
 * recalibration cycles yield two computable deltas. 'manual' is reserved
 * for hand edits (no writer today).
 */
export const voiceRevisions = pgTable(
  "voice_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    /** Soft ref (no FK), like voice_samples: history outlives the voice. */
    voiceId: bigint("voice_id", { mode: "number" }).notNull(),
    revision: integer("revision").notNull(),
    source: text("source", {
      enum: [
        "initial",
        "client_calibration",
        "hosted_fallback",
        "relearn",
        "manual",
      ],
    }).notNull(),
    styleRules: jsonb("style_rules").$type<StyleRules>(),
    channels: jsonb("channels").$type<VoicesMap>(),
    consumedSampleIds: jsonb("consumed_sample_ids").$type<number[]>(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgVoiceRevisionUnq: uniqueIndex(
      "voice_revisions_org_voice_revision_unq",
    ).on(t.organizationId, t.voiceId, t.revision),
    /** The convergence read: per org+voice, in revision order. */
    orgVoiceIdx: index("voice_revisions_org_voice_idx").on(
      t.organizationId,
      t.voiceId,
      t.revision,
    ),
    revisionCheck: check(
      "voice_revisions_revision_check",
      sql`${t.revision} >= 0`,
    ),
    sourceCheck: check(
      "voice_revisions_source_check",
      sql`${t.source} in ('initial', 'client_calibration', 'hosted_fallback', 'relearn', 'manual')`,
    ),
  }),
);

/** The questions a voice asks its owner about how they want to sound
 *  (`VOICE_QUESTIONS`, core/voice/questions.ts), by key. */
export const VOICE_QUESTION_KEYS = [
  "who",
  "register",
  "length",
  "questions",
  "like",
  "never",
  "emoji",
  "proud",
] as const;
export type VoiceQuestionKey = (typeof VOICE_QUESTION_KEYS)[number];
/** An answer as it was given: a choice's key, a text, or a list of words. */
export type VoiceQuestionAnswer = string | string[];

/**
 * Who answered a voice's question, where and when — one row per voice and
 * question, written only when the owner answers, clears or skips one. The
 * VALUE an answer sets lives in the voice's `style_rules` (or its examples),
 * where every writer and How you write read it; this row is its provenance,
 * and a list reads the answer back from the value, so the two cannot
 * disagree.
 */
export const voiceQuestions = pgTable(
  "voice_questions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    voiceId: bigint("voice_id", { mode: "number" })
      .notNull()
      .references(() => voices.id, { onDelete: "cascade" }),
    key: text("key", { enum: VOICE_QUESTION_KEYS }).notNull(),
    status: text("status", { enum: ["pending", "answered", "skipped"] })
      .notNull()
      .default("pending"),
    /** As the owner gave it; null unless answered. */
    answer: jsonb("answer").$type<VoiceQuestionAnswer>(),
    /** Where they answered or skipped it: on the Voice page or to their agent. */
    answeredVia: text("answered_via", { enum: ["dashboard", "agent"] }),
    answeredAt: bigint("answered_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgVoiceKeyUnq: uniqueIndex("voice_questions_org_voice_key_unq").on(
      t.organizationId,
      t.voiceId,
      t.key,
    ),
  }),
);

/**
 * Org-level angle-profile history (2026-07-28 mode-ladder spec): the owner's
 * revealed distribution over the fixed move taxonomy, recomputed over ALL
 * classified samples on every classification pass and appended as a new
 * revision. Org-level, not voice-level: judgment — which entry point the
 * owner takes into a conversation — is the owner's, while voice is how they
 * write. The current profile is the max revision; `sample_count` records how
 * much evidence it rests on. 'backfill' is reserved for a hosted history
 * pass (no writer today); the client pass is 'client'.
 */
export const angleProfileRevisions = pgTable(
  "angle_profile_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    revision: integer("revision").notNull(),
    /** {moveId: share 0..1} over the taxonomy; shares sum to ~1. */
    weights: jsonb("weights").$type<Record<string, number>>().notNull(),
    sampleCount: integer("sample_count").notNull(),
    source: text("source", { enum: ["client", "backfill"] }).notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgRevisionUnq: uniqueIndex("angle_profile_revisions_org_revision_unq").on(
      t.organizationId,
      t.revision,
    ),
    revisionCheck: check(
      "angle_profile_revisions_revision_check",
      sql`${t.revision} >= 1 and ${t.sampleCount} >= 0`,
    ),
    sourceCheck: check(
      "angle_profile_revisions_source_check",
      sql`${t.source} in ('client', 'backfill')`,
    ),
  }),
);

// ============================================================================
// Channels (domain) — the connected account
// ============================================================================

/**
 * One connected account: the thing that owns the exposure budget (INV-4).
 * However many campaigns or workers feed it, there is one account, one day
 * plan and one cap — and this row is that account.
 *
 * Every org has exactly one row from the migration that creates this table on:
 * the migration seeds one identity-less row per existing org, and
 * `bootstrapLocalOrg` mints one for every org created after it. Later
 * channel-dependent surfaces may therefore assume the row exists — an org whose
 * probe never reports an identity still keeps its caps, because the row
 * precedes the identity.
 */
export const channels = pgTable(
  "channels",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    /**
     * The enum is TypeScript-level only (no Postgres type), and it is spelled
     * twice on purpose: this package cannot import `@engager/core`, where
     * `network/registry.ts` owns what a network IS — urn grammar, url shape,
     * mention syntax, hosts. `registry.test.ts` pins the two lists equal, so a
     * network cannot arrive on one side alone.
     */
    network: text("network", { enum: ["linkedin"] })
      .notNull()
      .default("linkedin"),
    /**
     * The durable identity the system has never had. Nullable because no
     * connector reports one yet — a later slice widens the session status and
     * implements it in all three connectors; this column is where it lands.
     * Until then the row exists with a null identity, which is what the
     * NULLS NOT DISTINCT key below makes safe.
     */
    externalAccountId: text("external_account_id"),
    /** Execution authority is independent of subscription and publish intent.
     * Existing rows remain paused until the managed driver verifies identity. */
    executionRuntimeId: text("execution_runtime_id"),
    executionAccountId: text("execution_account_id"),
    executionPlacement: text("execution_placement", { enum: ["local", "cloud"] }),
    executionEpoch: bigint("execution_epoch", { mode: "number" }).notNull().default(0),
    executionState: text("execution_state", {
      enum: ["active", "quiescing", "transferred", "paused_recovery"],
    }).notNull().default("paused_recovery"),
    executionHolder: text("execution_holder"),
    executionLeaseUntil: bigint("execution_lease_until", { mode: "number" }),
    executionAuthorityLeaseUntil: bigint("execution_authority_lease_until", { mode: "number" }),
    executionTransferId: text("execution_transfer_id"),
    /**
     * The connector binding as a field on the row, not its own table — until
     * capability routing makes it one. `native_api` joins the enum later.
     */
    connector: text("connector", {
      enum: ["local_browser"],
    })
      .notNull()
      .default("local_browser"),
    /**
     * WHO this account is. Moved off the voice row, where identity shared a
     * table with persona, house style and the voices map.
     */
    displayName: text("display_name"),
    /** Epoch ms of the last probe that confirmed this identity. */
    verifiedAt: bigint("verified_at", { mode: "number" }),

    /**
     * Session liveness, moved off the `system_state` singleton. Network-neutral
     * names: the row already says `network: 'linkedin'`, so the prefix those
     * columns carried died with the move.
     *
     * `sessionOkAt` is the last SUCCESSFUL probe; `sessionCheckedAt` and
     * `sessionReason` describe the most recent probe whatever its outcome — a
     * failure is the freshest evidence there is and outranks an older success.
     */
    sessionOkAt: bigint("session_ok_at", { mode: "number" }),
    sessionCheckedAt: bigint("session_checked_at", { mode: "number" }),
    sessionReason: text("session_reason"),

    /**
     * The owner's acknowledgement of LinkedIn account risk ({when, who}),
     * moved off the `organizations` row. First one wins: a later arming never
     * overwrites the original moment. A RECORD, never a gate (INV-6) — nothing
     * reads it to refuse anything.
     *
     * `riskAcknowledgedByUserId` carries over with NO live writer: its former
     * home names the onboarding wizard, and no code writes it today.
     */
    riskAcknowledgedAt: bigint("risk_acknowledged_at", { mode: "number" }),

    /**
     * The layer-3 RISK pause, and the account's — a throttle or a checkpoint is
     * a fact about this connected account, not about the org. Same shapes the
     * `system_state` singleton carried before the contract release dropped them
     * there.
     *
     * NOT the kill switch: that is the owner's org-wide layer-1 stop and stays
     * on `system_state`.
     */
    pausedReason: text("paused_reason"),
    /** Epoch ms the risk pause expires. Past or null = not paused. */
    pausedUntil: bigint("paused_until", { mode: "number" }),

    /**
     * This account's live write authority — whether any driver write may run at
     * all. Bootstrap enables it for new normal installs; Dev stays off. The
     * storage default fails closed for rows created outside bootstrap. Existing
     * rows change only through the dashboard's confirmed write switch, never
     * by inference: no MCP tool, no chat broker tool, no runner operation and
     * no job writes this column, so a task, retry or scheduled run cannot turn
     * it on. `canEngage()` is the authoritative per-write reader, so every
     * process sees a flip on its next gate check; the driver's construction
     * gate and its approval-surface refusal stay downstream as independent
     * backstops. Replaced `ENGAGER_BROWSER_WRITES`, which the runtime no
     * longer consults.
     */
    writesEnabled: boolean("writes_enabled").notNull().default(false),

    /**
     * The account's engagement ceilings, moved here from `organizations`
     * (INV-4): a rolling-24h limit across EVERY campaign's comments+replies,
     * and a minimum gap between any two posted actions. Per-campaign caps alone
     * let N campaigns multiply one account's exposure — and the account is this
     * row, which is why the ceiling belongs on it. 0 disables either limit,
     * consistent with the campaign cap fields.
     *
     * Same types and DB defaults the `organizations` columns they replaced
     * carried, quirk included.
     */
    dailyEngageCap: integer("daily_engage_cap").notNull().default(40),
    minActionGapSec: integer("min_action_gap_sec").notNull().default(120),

    /**
     * The warm-up clock, moved off the campaign row. Same types and defaults
     * the `campaigns` columns carried.
     *
     * INV-4 is why it belongs here: a ramp anchored per campaign gives two
     * targets on ONE pair of hands two independent ramps, so arming a second
     * one would restart the account's clock and archiving the first would take
     * it away. INV-1 is carried across the move unchanged — warm-up is a ramp
     * on the CAP, never a fence.
     */
    warmupWeeks: bigint("warmup_weeks", { mode: "number" }).notNull().default(3),
    warmupStartedAt: bigint("warmup_started_at", { mode: "number" }),
    /**
     * Absolute comments/day at ramp start (comment lane only). Null = the ratio
     * ramp (25% of the daily cap). >= the cap = a flat ramp ("already warmed
     * up"); Auto-post eligibility (`completedWarmupAt`) stays time-based
     * regardless.
     */
    warmupStartRate: bigint("warmup_start_rate", { mode: "number" }),

    /**
     * The eight PACING numbers, joining the ceilings and the warm-up clock
     * above. One account, one exposure budget (INV-4) — these belong here, not
     * on a campaign, because N campaigns share ONE LinkedIn account and a
     * per-campaign budget cannot add up to an account-wide truth.
     *
     * `pacingPolicy`, `assignSlots`, the ledger and every gate read them here;
     * the `campaigns` counterparts they replaced are gone.
     *
     * Each column kept the type, nullability and DB DEFAULT its `campaigns`
     * counterpart carried — deliberately the DB default rather than
     * `CAMPAIGN_CREATE_DEFAULTS`, quirk included: `daily_comment_cap` falls
     * back to 20 while every create path supplies 25.
     *
     * `hourlyCommentCap` did not come along: it was dropped, not moved, because
     * nothing server-side read it and the hourly rhythm is min-gap plus the
     * day-plan anchors. The warm-up trio is not in this set either — it arrived
     * just above with its publish-arm trigger in T-4.12a.
     *
     * The lane delay arrived as a pair and is one column again (T-11.7): no
     * gate, plan or projection ever read the CEILING half — only the
     * `minDelaySec` floor below — so the ceiling was a number the caps form
     * asked the owner for and nothing ever spent.
     */
    dailyCommentCap: bigint("daily_comment_cap", { mode: "number" })
      .notNull()
      .default(20),
    dailyReplyCap: bigint("daily_reply_cap", { mode: "number" })
      .notNull()
      .default(25),
    activeHours: jsonb("active_hours").$type<ActiveHours>(),
    activeDays: jsonb("active_days").$type<string[]>(),
    minDelaySec: bigint("min_delay_sec", { mode: "number" })
      .notNull()
      .default(40),
    perProfileDayCap: bigint("per_profile_day_cap", { mode: "number" })
      .notNull()
      .default(1),
    perProfileWeekCap: bigint("per_profile_week_cap", { mode: "number" })
      .notNull()
      .default(2),
    perProfileMonthCap: bigint("per_profile_month_cap", { mode: "number" })
      .notNull()
      .default(4),
    /**
     * The account's daily budget of RESEARCH reads — a post read in full with
     * its comments, and an author's profile — spent verifying a match before
     * it reaches the deck. Reads, not exposure: they share no count with the
     * caps above. 0 turns that read off, and a candidate it would have
     * verified stays matched, unverified.
     */
    dailyThreadReadCap: bigint("daily_thread_read_cap", { mode: "number" })
      .notNull()
      .default(60),
    dailyProfileReadCap: bigint("daily_profile_read_cap", { mode: "number" })
      .notNull()
      .default(40),
    /**
     * The account's budget of DISCOVERY searches — a keyword or author
     * search and each further results page, every one counted when it is
     * made, whether it fails or finds nothing new, across every campaign on
     * the account. Reads, not exposure: they share no count with the research
     * reads above. `dailySearchPageCap` is over a rolling 24 hours and
     * `hourlySearchCap` over the last hour; the lower binds. No upper bound on
     * either, and 0 turns discovery reads off. `ENGAGER_DISCOVERY_PAGES_PER_DAY`
     * and `ENGAGER_DISCOVERY_CALLS_PER_HOUR`, when set, override them.
     */
    dailySearchPageCap: bigint("daily_search_page_cap", { mode: "number" })
      .notNull()
      .default(150),
    hourlySearchCap: bigint("hourly_search_cap", { mode: "number" })
      .notNull()
      .default(80),
    /**
     * The account's daily budget of REPLY CHECKS — a read of the thread under
     * one of our own comments, for what people wrote back. Its own count,
     * never Research's: verifying matches can spend every post read the
     * account has and the replies to the owner's comments are still seen.
     */
    dailyReplyCheckCap: bigint("daily_reply_check_cap", { mode: "number" })
      .notNull()
      .default(80),
    /**
     * How often the account looks for what people wrote back, in minutes —
     * each a BASE the check jitters ±30%, never a fixed interval, and each
     * read only inside the active window. `replyCheckBaseMin` is a fresh
     * comment watch's cadence (its first 48 hours); the older tiers stay
     * proportional to it, 6× and 12×. `inboxCheckBaseMin` paces the light
     * inbox check (`inbox_check`).
     */
    replyCheckBaseMin: integer("reply_check_base_min").notNull().default(60),
    inboxCheckBaseMin: integer("inbox_check_base_min").notNull().default(45),
    /**
     * How far ahead an Automatic Comment step writes into the day plan:
     * `next_few` keeps the plan's next few slots supplied, `rest_of_day`
     * every slot the current day still holds (`computeCommentDemand`).
     * Drafting only — posting is paced by the plan's slots, caps and gaps
     * whichever it is. TypeScript-level enum, no Postgres type.
     */
    writeAhead: text("write_ahead", { enum: ["next_few", "rest_of_day"] })
      .notNull()
      .default("rest_of_day"),

    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    // NULLS NOT DISTINCT is what makes "one row" true while the identity is
    // still unpopulated: two null-identity rows on one org/network collide
    // instead of passing Postgres's default distinct-NULLs rule.
    orgNetworkAccountUnique: unique("channels_org_network_account_key")
      .on(t.organizationId, t.network, t.externalAccountId)
      .nullsNotDistinct(),
    // Composite target for the same-org FKs that later tasks add.
    orgIdUnique: unique("channels_org_id_key").on(t.organizationId, t.id),
  }),
);

// ============================================================================
// Campaigns (domain)
// ============================================================================

/** How hard a campaign's Scout works before it shows the owner anything:
 *  Quick reads a small, fresh slice; Standard is how it has always worked;
 *  Deep is Standard plus Research. */
export const SEARCH_DEPTHS = ["quick", "standard", "deep"] as const;
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];
/** The depths a campaign row stores. Deep is not one: it is the campaign's
 *  Research, read from its strategy (core's strategy/searchDepth.ts). */
export const STORED_SEARCH_DEPTHS = ["quick", "standard"] as const;
export type StoredSearchDepth = (typeof STORED_SEARCH_DEPTHS)[number];

export const campaigns = pgTable(
  "campaigns",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    // The connected account this campaign feeds — the row that owns the
    // exposure budget (INV-4). Nullable while the column is additive: nothing
    // reads it yet, and the one writer is `createCampaignOp`, which resolves
    // the org's single `channels` row at insert. The FK is the COMPOSITE
    // same-org one declared below, not a single-column reference.
    channelId: bigint("channel_id", { mode: "number" }),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "paused", "archived"] })
      .notNull()
      .default("active"),
    // The campaign's goal. Drives writer behavior (promo ratio, product/CTA gating).
    objective: text("objective", {
      enum: ["engage", "visibility", "audience", "nurture", "thought", "product"],
    })
      .notNull()
      // Retain the historical SQL default for binary/schema compatibility.
      // createCampaignOp explicitly supplies the current commenting default.
      .default("visibility"),
    discovery: jsonb("discovery").$type<DiscoveryConfig>(),
    maxPostAgeDays: bigint("max_post_age_days", { mode: "number" })
      .notNull()
      .default(3),
    aiFilter: jsonb("ai_filter").$type<AiFilterConfig>(),
    audienceProfile: jsonb("audience_profile").$type<AudienceProfileJson>(),
    audienceRevision: integer("audience_revision").notNull().default(0),
    /** A successful empty rollup still advances its window. The paired hashes
     * make retry settlement idempotent without replaying a model result. */
    audienceThemesRolledUpAt: bigint("audience_themes_rolled_up_at", { mode: "number" }),
    audienceThemesInputHash: text("audience_themes_input_hash"),
    audienceThemesResultHash: text("audience_themes_result_hash"),
    tone: jsonb("tone").$type<ToneConfig>(),
    prompts: jsonb("prompts").$type<AiPromptsConfig>(),
    // The voice this campaign writes in. Null = the org's default voice; a
    // deleted voice detaches (set null) rather than orphaning the campaign.
    voiceId: bigint("voice_id", { mode: "number" }).references(
      () => voices.id,
      {
        onDelete: "set null",
      },
    ),
    // Per-campaign focus brief compiled from the org-wide Brain (async, nullable
    // until the first `compile_campaign` job runs). Top-level (NOT in `prompts`)
    // so a concurrent compile can't be lost by the shallow-merge in updateCampaignOp.
    compiledBrief: jsonb("compiled_brief").$type<CompiledBrief>(),
    likeWhenCommenting: boolean("like_when_commenting").notNull().default(true),
    // No pacing columns here: caps, delays, the active window and the warm-up
    // clock are the ACCOUNT's, and live on `channels` (INV-4). A campaign says
    // WHAT to hunt for. `hourlyCommentCap` went with them but was dropped, not
    // moved — nothing server-side read it, and the channel's hourly rhythm is
    // min-gap plus the day-plan anchors. No cadence column either: WHEN
    // anything runs by itself is the worker's, and a campaign that stored
    // its own wake interval was a second answer to that question.

    diversityRejectThreshold: real("diversity_reject_threshold")
      .notNull()
      .default(0.92),
    // Structural (template) anti-repetition threshold for the writer-variety gate:
    // an openingSignature collision OR trigram-cosine >= this rejects a draft as a
    // structural duplicate (separate from the SEMANTIC diversityRejectThreshold).
    diversityStructuralThreshold: real("diversity_structural_threshold")
      .notNull()
      .default(0.45),
    premiumWriter: boolean("premium_writer").notNull().default(false),
    // Fact-checked commenting: the server writer gets a live web-search tool and is
    // told to ground the comment in ONE recent, verified fact. Drafts that actually
    // ran a search charge 3 credits instead of 1 (surcharge refunded when the model
    // chose not to search). A real column, not tone jsonb — billing flags must not
    // be exposed to the shallow-merge lose-update risk (precedent: premiumWriter).
    webFacts: boolean("web_facts").notNull().default(false),
    // Share (0..1) of drafts that get the web-search path when webFacts is on —
    // every comment citing a fresh stat is itself an AI tell, and the ratio is the
    // budget dial (avg cost ≈ 1 + 2×ratio credits/draft). Smoothed like promo_ratio
    // (deficit-based over recent trace.facts), never per-draft dice. DB default 1
    // keeps pre-ratio campaigns byte-identical (always search); NEW campaigns get
    // the mapper default (~0.3).
    webFactsRatio: real("web_facts_ratio").notNull().default(1),
    // Verified triage: a match reaches the deck only once a read of the full
    // post, its thread and its author confirms it (`candidate_research`).
    // Off by default and per campaign, so one campaign can prove it first.
    verifyStage: boolean("verify_stage").notNull().default(false),
    // The Quick or Standard chosen for this campaign's search depth. Deep is
    // never stored: it IS the Find posts step's Research, read from the
    // strategy, so a campaign whose Research is on reads Deep, and turning
    // Research on clears a stored Quick to Standard — Research turned off
    // afterwards reads Standard (`readSearchDepth`, core's
    // strategy/searchDepth.ts).
    searchDepth: text("search_depth", { enum: STORED_SEARCH_DEPTHS })
      .notNull()
      .default("standard"),
    // When the owner pressed Keep Quick on Overview's offer to run a Quick
    // campaign every day at Standard, after its first look: the offer does
    // not come back. Null while it was never answered so.
    depthOfferDismissedAt: bigint("depth_offer_dismissed_at", { mode: "number" }),
    // When the owner pressed Keep it as it is on the wider line the Inbox
    // suggests after a Quick first look that found no one: the suggestion does
    // not come back. Null while it was never answered so.
    widenOfferDismissedAt: bigint("widen_offer_dismissed_at", { mode: "number" }),
    /** One-time Automatic advice answered by the owner, per action. */
    automaticOfferDismissed: jsonb("automatic_offer_dismissed").$type<Record<string, { at: number; approved: number }>>(),
    // When the owner deleted it (`deleteCampaign`): archived, its waiting work
    // cancelled, and gone from every list. A soft delete because the row is
    // still what its ledger rows, conversations and sent messages point at, and the
    // account's caps still count what it sent (INV-4). Final: nothing writes
    // it back to null. Null while the campaign stands.
    deletedAt: bigint("deleted_at", { mode: "number" }),
    // When its status last changed, and who changed it — the owner in
    // Engager, their agent over MCP, or Engager itself (a Start, a delete, a
    // move onto its strategy). Written with every status change
    // (`setCampaignStatusOp`), never by a call that leaves the status as it
    // was. Null on a row whose status has not changed since these columns
    // were added: it reads as Paused with no who or when.
    statusChangedAt: bigint("status_changed_at", { mode: "number" }),
    statusChangedBy: text("status_changed_by", { enum: ["owner", "agent", "system"] }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgStatusIdx: index("campaigns_org_status_idx").on(
      t.organizationId,
      t.status,
    ),
    // Composite tenant key for new child tables whose FKs must prove that the
    // referenced campaign belongs to the same organization as the child row.
    orgIdUnq: uniqueIndex("campaigns_org_id_unq").on(t.organizationId, t.id),
    // The same-org FK `channels_org_id_key` was created for. Composite, not a
    // single-column reference to `channels.id`: with one column the database
    // cannot tell that a campaign's channel belongs to the CAMPAIGN'S org, and
    // the writers most likely to get that wrong are exactly the ones RLS does
    // not cover — migrations and backfills running with BYPASSRLS. MATCH SIMPLE
    // (the default) skips the check whenever any column is NULL, which is
    // precisely the behaviour an additive nullable column wants.
    //
    // NO ACTION on delete on purpose: detaching the budget owner silently is
    // worse than refusing the channel delete.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "campaigns_org_channel_fk",
    }).onDelete("no action"),

    searchDepthCheck: check(
      "campaigns_search_depth_check",
      sql`${t.searchDepth} in ('quick', 'standard')`,
    ),
  }),
);

/**
 * Where a strategy version came from. `seed` is the v1 derived from a
 * campaign's worker rows; `flag_flip` the one-time mapping when its agentic
 * workflow is turned on; `patch` an owner-facing `strategy.patch`; `undo` a
 * patch that restores what a version replaced. The rest is what a reviewed
 * change has to be able to show: the owner's words, what was recognized in
 * them, how far it reached, every value it moved, which compiler produced it,
 * and who approved it.
 *
 * The optional fields are a patch's (`strategy/patch.ts`): the paths its
 * recognized intent named, the voice / knowledge / memory versions it was
 * composed against, the grants it asked for, the version it undid and the
 * scheduled versions that undo cancelled, and `approvals` — the drafts waiting
 * for a yes or scheduled under the base version, stamped so a later phase can
 * compare what they were approved under with what governs them now.
 */
export type StrategyProvenance = {
  source: "seed" | "patch" | "flag_flip" | "undo";
  instruction: string | null;
  intent: string | null;
  scope: { campaignId: number | null; stepId: string | null } | null;
  changes: Array<{ path: string; old: unknown; new: unknown }>;
  compilerVersion: string | null;
  approver: string | null;
  intentPaths?: string[];
  dependencyVersions?: {
    voice: number | null;
    knowledge: number | null;
    memory: number | null;
  };
  requestedGrants?: { add: string[]; remove: string[] };
  undoes?: number;
  cancelled?: number[];
  approvals?: { baseVersion: number; messageIds: number[] };
};

export const audienceRevisions = pgTable(
  "campaign_audience_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    revision: integer("revision").notNull(),
    profile: jsonb("profile").$type<AudienceProfileJson>().notNull(),
    reason: text("reason", { enum: ["created", "migrated", "owner_edit", "agent", "chat_proposal", "restored", "learned", "pain_kept", "pain_dismissed"] }).notNull(),
    summary: text("summary").notNull(),
    changedBy: text("changed_by").notNull(),
    restoredFrom: integer("restored_from"),
    createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    revisionUnq: uniqueIndex("campaign_audience_revisions_org_campaign_revision_unq").on(t.organizationId, t.campaignId, t.revision),
    campaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "campaign_audience_revisions_org_campaign_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Versions of one document per campaign — the `CampaignAgentStrategy` — and
 * one per channel for the account default that every campaign on it inherits
 * from and can only narrow. The document is validated by core's contract
 * (`packages/core/strategy/contract.ts`); this package cannot import core,
 * so the column is typed as plain JSON here, exactly as `voice_revisions`
 * stores a snapshot it does not interpret.
 *
 * A DOCUMENT, not normalized step and binding tables, because the edit
 * protocol is compare-and-swap on a base version: one document has one
 * version, four tables have none. `voice_revisions` and
 * `angle_profile_revisions` are the precedent.
 *
 * Exactly one scope per row, held by the CHECK: a campaign's own version names
 * its campaign and no channel — the campaign row is what binds it to a channel
 * — and the account default names its channel and no campaign. Versions are
 * appended, never rewritten; only `status` moves: a `draft` is waiting for its
 * `effective_at`, `active` is the one in force, `archived` was replaced,
 * `pending_review` was scheduled and found its base version replaced when its
 * instant came (compare-and-swap, `strategy/activate.ts`), and `cancelled`
 * was withdrawn by an undo before it ever activated.
 *
 * Activating a version is what writes that campaign's worker switches
 * (`strategy/activate.ts`).
 */

export const campaignStrategies = pgTable(
  "campaign_strategies",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }),
    channelId: bigint("channel_id", { mode: "number" }),
    version: integer("version").notNull(),
    status: text("status", {
      enum: ["draft", "active", "archived", "pending_review", "cancelled"],
    })
      .notNull()
      .default("draft"),
    /** The version this one was derived from — the compare-and-swap base.
     *  Null on a v1. */
    baseVersion: integer("base_version"),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    patchProvenance: jsonb("patch_provenance")
      .$type<StrategyProvenance>()
      .notNull(),
    /** Epoch ms; the document carries the same instant as UTC ISO. */
    effectiveAt: bigint("effective_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    // NULLS NOT DISTINCT for the reason `channels_org_network_account_key`
    // uses it: one of the two scope columns is always null, and Postgres's
    // default distinct-NULLs rule would let two v1s of one campaign coexist.
    scopeVersionUnique: unique("campaign_strategies_scope_version_key")
      .on(t.organizationId, t.campaignId, t.channelId, t.version)
      .nullsNotDistinct(),
    oneActivePerCampaign: uniqueIndex("campaign_strategies_active_campaign_unq")
      .on(t.organizationId, t.campaignId)
      .where(sql`${t.status} = 'active' and ${t.campaignId} is not null`),
    oneActivePerChannel: uniqueIndex("campaign_strategies_active_channel_unq")
      .on(t.organizationId, t.channelId)
      .where(sql`${t.status} = 'active' and ${t.channelId} is not null`),
    // Same-org composite FKs, for the reason `campaigns_org_channel_fk` gives:
    // the writers most likely to cross orgs are the ones RLS does not cover.
    // A campaign's versions go with it; an account default refuses the channel
    // delete rather than vanish under the campaigns that inherit from it.
    orgCampaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "campaign_strategies_org_campaign_fk",
    }).onDelete("cascade"),
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "campaign_strategies_org_channel_fk",
    }).onDelete("no action"),
    scopeCheck: check(
      "campaign_strategies_scope_check",
      sql`(${t.campaignId} is null) = (${t.channelId} is not null)`,
    ),
    versionCheck: check(
      "campaign_strategies_version_check",
      sql`${t.version} >= 1 and (${t.baseVersion} is null or (${t.baseVersion} >= 1 and ${t.baseVersion} < ${t.version}))`,
    ),
    statusCheck: check(
      "campaign_strategies_status_check",
      sql`${t.status} in ('draft', 'active', 'archived', 'pending_review', 'cancelled')`,
    ),
  }),
);

export const discoveredPosts = pgTable(
  "discovered_posts",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" })
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    postUrn: text("post_urn").notNull(),
    authorProfileId: profileIdText("author_profile_id"),
    authorName: text("author_name"),
    url: text("url"),
    contentText: text("content_text"),
    media: jsonb("media"),
    postedAt: bigint("posted_at", { mode: "number" }),
    detectedLanguage: text("detected_language"),
    authorGeo: text("author_geo"),
    discoveredAt: bigint("discovered_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    /**
     * WHICH run's sweep inserted this row, when a worker's did — a manual
     * Discover stamps nothing, exactly as `messages.worker_run_id` leaves
     * the owner's rows unstamped. Same shape as that column too: a plain
     * bigint, no FK, because deleting a worker takes its runs (D26) and the
     * find outlives the run that made it. The id may dangle; what it says
     * about who found the row stays true.
     */
    discoveredRunId: bigint("worker_run_id", { mode: "number" }),
    /**
     * WHICH run's triage judged this row, same contract as above. A row can
     * carry both, and they can differ: a later run triages what an earlier
     * run (or a manual sweep) discovered.
     */
    triagedRunId: bigint("triaged_run_id", { mode: "number" }),
    // The post author's headline (e.g. "VP Marketing @ Acme") — captured from the
    // driver at discovery and used for the BetScore ICP signal (headline ↔ product
    // audience). authorCompany is NOT stored (the profile endpoint 422s for company
    // authors, so it isn't cheaply available).
    authorHeadline: text("author_headline"),
    // Author-impact SNAPSHOT (copied from author_profiles by the enrich_authors
    // job) so ranking/selection/MCP read without joins. Null = not (yet) enriched
    // → ranking degrades to the pre-feature signals.
    authorFollowers: bigint("author_followers", { mode: "number" }),
    authorConnections: bigint("author_connections", { mode: "number" }),
    metrics: jsonb("metrics"),
    filterScore: real("filter_score"),
    filterPassed: boolean("filter_passed"),
    filterReason: text("filter_reason"),
    // Legacy "meaningfulness" 0..1 — superseded by betScore, the same engine
    // under Scout's relevance preset. Kept for back-compat reads.
    meaningfulness: real("meaningfulness"),
    // Scout's relevance priority (0..1) + its full signal breakdown. Null for
    // pre-feature rows and when the ranker kill switch is off.
    betScore: real("bet_score"),
    betBreakdown: jsonb("bet_breakdown").$type<BetBreakdownJson>(),
    // The pre-score the capacity planner ranks the gather buffer by (engagement
    // surface + recency), read off the post alone before the relevance filter
    // has judged it. Distinct from betScore, which is the fuller answer and
    // drives Gate-2 posting order. Null for pre-feature rows /
    // when the capacity planner is off. The columns are added via migrate.ts
    // (ADD COLUMN + index), NOT a drizzle migration (Codex #9 — scripts may import
    // core, migrate.ts must not).
    reachScore: real("reach_score"),
    reachBreakdown: jsonb("reach_breakdown").$type<ReachBreakdownJson>(),
    // Unix-ms instant the capacity planner CLAIMED this post into 'queued_draft' (the
    // reaper's lease clock — a queued_draft whose draft job died is reset to 'new'
    // once selected_at is older than the reaper TTL and no message row exists). Null
    // outside the planner path.
    selectedAt: bigint("selected_at", { mode: "number" }),
    // Agent-submitted relevance ranking (0..1) — written ONLY by the
    // task completion MCP intake (agent-led campaigns; no server LLM, no
    // charge). Leads the candidate-ranking coalesce everywhere:
    // coalesce(agent_score, bet_score, meaningfulness, reach_score).
    agentScore: real("agent_score"),
    agentRankedAt: bigint("agent_ranked_at", { mode: "number" }),
    agentRankReason: text("agent_rank_reason"),
    // A triage estimate, never evidence that Research read the room. An old
    // Audience revision cannot spend today's reads ahead of current estimates.
    roomLikely: text("room_likely", { enum: ["high", "medium", "low"] }),
    roomLikelyAudienceRevision: integer("room_likely_audience_revision"),
    // Per-post entry angle generated at ranking time for matched posts (first-
    // Radar preview evidence). Frozen with the verdict: a later Brain compile
    // or campaign edit never rewrites it under the user's judgment. Null on
    // rejects and wherever the bounded best-effort generation was skipped —
    // readers fall back to the campaign's static angle.
    agentAngle: text("agent_angle"),
    // The verify verdict over a full read of the post, its thread and its
    // author, copied from `candidate_research` so pool queries stay join-free.
    // Both null = not verified. TS-union only, no DB CHECK, like `status`.
    verifiedAt: bigint("verified_at", { mode: "number" }),
    verifyVerdict: text("verify_verdict", { enum: ["confirmed", "rejected"] }),
    verifyAudienceRevision: integer("verify_audience_revision").notNull().default(0),
    // 'held' (TS-union only, no DB CHECK) = passed the filter but Gate 1 deferred it
    // below the objective floor / over the draft budget; re-admitted by a later sweep
    // while still fresh. NOT discarded.
    //
    // Capacity-planner statuses (TS-union only, no DB CHECK):
    //   'queued_draft' = the planner CLAIMED this post to be drafted (in-flight; counts
    //                    toward the org/campaign draft reservation). Reaped back to
    //                    'new' if the draft job dies (lease via selectedAt).
    //   'drafted'      = TERMINAL success: a message row was inserted (never re-selected).
    //   'aged_out'     = TERMINAL: a known postedAt fell outside maxPostAgeDays before
    //                    being drafted.
    //   'draft_requested' (TS-union only, no DB CHECK) = a human requested an on-demand
    //                    draft on an agent-led Review or Auto-post campaign. Consumed by
    //                    the runner via people list(status:'draft_requested') +
    //                    draft submission. Historical Curate rows remain auditable but are
    //                    not consumed while the campaign is Curate. NOT reaped (the
    //                    request stands until cancelled/dismissed); aged out like 'new'.
    //                    Server-led Review requests use 'queued_draft' instead.
    //   'rejected' (TS-union only, no DB CHECK) = the relevance TRIAGE (agent verdict via
    //                    task completion, or the server-led curate pass) judged this
    //                    post OFF-target for the campaign. TERMINAL: leaves the curated pool
    //                    (dropped from people list default + the Matched bucket), never
    //                    re-triaged. Distinct from 'filtered_out' (server draft-time runFilter)
    //                    and 'skipped' (low-meaningfulness / user dismiss) — provenance-clean.
    //                    Curated pool state model: a 'new'/'held' row is UNTRIAGED while
    //                    agent_score IS NULL, and a MATCH once agent_score IS NOT NULL.
    status: text("status", {
      enum: [
        "new",
        "filtered_out",
        "commented",
        "skipped",
        "held",
        "queued_draft",
        "drafted",
        "aged_out",
        "draft_requested",
        "rejected",
      ],
    })
      .notNull()
      .default("new"),
  },
  (t) => ({
    orgPostUrnUnq: uniqueIndex("discovered_posts_org_post_urn_unq").on(
      t.organizationId,
      t.postUrn,
    ),
    orgCampaignStatusIdx: index("discovered_posts_org_campaign_status_idx").on(
      t.organizationId,
      t.campaignId,
      t.status,
    ),
    // Candidate feedback references this tenant+campaign+post tuple so a
    // guessed global post id cannot create a cross-tenant relationship.
    orgCampaignIdUnq: uniqueIndex("discovered_posts_org_campaign_id_unq").on(
      t.organizationId,
      t.campaignId,
      t.id,
    ),
    // NOTE: all additional high-write discovered_posts indexes (BetScore,
    // reach, status/id, and the two untriaged partial indexes) are created
    // CONCURRENTLY in migrate.ts, OUTSIDE Drizzle's wrapping transaction. They
    // are intentionally not declared here so deploys never block ingestion for
    // a full index build.
  }),
);

// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------

/** How a search reads, in the parts one change moved. */

/** Anonymous counts from the server's cited room evidence at plan time.
 * The optional name belongs to the room's author, never a comment author. */
export type SourceRoomEvidence = { rooms: number; fits: number; authorName?: string };

/** Owner dismissals persist independently of the evidence that suggested an
 * author. A later room cannot silently re-offer the same author. */
export const discoveryAuthorDismissals = pgTable("discovery_author_dismissals", {
  organizationId: orgId(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  authorIdentity: text("author_identity").notNull(),
  dismissedAt: bigint("dismissed_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  pk: primaryKey({ columns: [t.organizationId, t.campaignId, t.authorIdentity] }),
  campaignFk: foreignKey({ columns: [t.organizationId, t.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id],
    name: "discovery_author_dismissals_org_campaign_fk" }).onDelete("cascade"),
  identity: check("discovery_author_dismissals_identity", sql`length(${t.authorIdentity}) between 1 and 300`),
}));

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    kind: text("kind", { enum: ["comment", "reply", "room_reply"] }).notNull(),
    /**
     * WHO authorized this send. "owner" = a human act stands behind it (a deck
     * save, an approval, an edit-then-approve). "worker" = a worker
     * published it with nobody in the loop.
     *
     * This is the input to `pacingPolicy` (ratelimit/ledger.ts): daily caps,
     * the active-hours window, the org ceiling, and the human-day anchors bind
     * UNATTENDED work, while a human act needs only the min-gap floor and the
     * per-profile anti-repeat caps. That is the rule the retired Curate mode
     * was really expressing — every Curate send had a human behind it.
     *
     * Defaults to "worker" so an unstamped row FAILS CLOSED (capped),
     * matching how a null stored mode used to resolve.
     */
    publishOrigin: text("publish_origin", { enum: ["owner", "worker"] })
      .notNull()
      .default("worker"),
    /**
     * WHICH worker run wrote this row. Null = no run did.
     *
     * `publishOrigin` cannot answer that question: it defaults to "worker"
     * so an unstamped row fails closed, which means "worker" is also what
     * an ordinary server-side insert carries. This column is the only evidence
     * that a run actually authored the row, and it is a row the SERVER wrote
     * (INV-2) rather than a number a model reported.
     *
     * SOFT REF, NO FOREIGN KEY — deliberately, on three grounds:
     *
     *  - A COMPOSITE fk to `worker_runs (organization_id, id)` cannot carry
     *    `on delete set null`: Postgres nulls EVERY column of the key, and
     *    `organization_id` is NOT NULL, so deleting a run would abort with
     *    23502 and make any worker that ever drafted undeletable. The same
     *    The PG15 column-list form is unavailable:
     *    local installs run PG14 and drizzle's UpdateDeleteAction has no
     *    column-list variant, so `db:generate` would regenerate the broken one.
     *  - `no action` instead would abort a CAMPAIGN delete, which cascades
     *    campaigns -> workers -> worker_runs while these rows still
     *    point at them.
     *  - Nulling it would be wrong even if it worked. PROVENANCE MUST OUTLIVE
     *    THE RUN: a queued comment whose run was deleted is still work an
     *    worker armed, and a reader keying on `worker_run_id is null`
     *    would otherwise read it as the owner's own. The id may dangle; what it
     *    says about who armed the row stays true.
     *
     * (Deleting a worker deletes its runs and leaves these ids dangling by
     * design — D26, queued work stands.)
     */
    workerRunId: bigint("worker_run_id", { mode: "number" }),
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      {
        onDelete: "cascade",
      },
    ),
    discoveredPostId: bigint("discovered_post_id", {
      mode: "number",
    }).references(() => discoveredPosts.id, { onDelete: "set null" }),
    /** Half of the schema's one foreign-key cycle. The composite key back to
     *  `incoming_comments` is `messages_org_incoming_comment_fk`, installed
     *  out of band by `concurrent-indexes.ts`, and it is DEFERRABLE INITIALLY
     *  IMMEDIATE — the installer creates it that way and
     *  `0149_deferrable_comment_cycle.sql` converges a database that already
     *  carries it, both hand-written because the pinned drizzle-orm's
     *  `foreignKey` builder says only `onUpdate` and `onDelete`. Nothing
     *  changes for an ordinary statement; a transaction that says
     *  `SET CONSTRAINTS ALL DEFERRED` (`copy-org.ts`) can insert both sides of
     *  the cycle and be checked once, at commit. */
    incomingCommentId: bigint("incoming_comment_id", { mode: "number" }),
    redraftRequestId: uuid("redraft_request_id"),
    redraftRequestVersion: integer("redraft_request_version")
      .notNull()
      .default(0),
    redraftRequestedAt: bigint("redraft_requested_at", { mode: "number" }),
    redraftRequestedBy: text("redraft_requested_by"),
    redraftRequestNote: text("redraft_request_note"),
    targetProfileId: profileIdText("target_profile_id"),
    /** Frozen identity for a room send, independent of expiring discovery rows. */
    roomReplyTarget: jsonb("room_reply_target").$type<RoomReplyTargetJson>(),
    commentType: text("comment_type", { enum: ["promo", "neutral"] }),
    proposedText: text("proposed_text").notNull(),
    finalText: text("final_text"),
    // Two-phase posting states (drizzle-level enum — no DB migration needed):
    //  - "posting": the durable mid-flight marker, COMMITTED before the driver call.
    //    A retry that finds it never blind-posts — it reconciles or holds.
    //  - "needs_review": an interrupted attempt whose outcome could not be verified;
    //    a human confirms on LinkedIn, then re-approves or rejects.
    status: text("status", {
      enum: [
        "proposed",
        "approved",
        "posting",
        "posted",
        "failed",
        "rejected",
        "suppressed_dryrun",
        "needs_review",
      ],
    })
      .notNull()
      .default("proposed"),
    dedupeKey: text("dedupe_key").notNull(),
    externalUrn: text("external_urn"),
    promptVersionId: bigint("prompt_version_id", { mode: "number" }),
    loopVersion: text("loop_version"),
    model: text("model"),
    /**
     * How much of an agent draft survived in the text a human saved, frozen at
     * the moment of the human act.
     *
     * Null means no draft was ever offered: every historical row, every
     * server-written draft, and every comment typed from a blank box. The
     * POLICY that turns this number into "teaches the voice" lives in
     * learning/commentAuthorship.ts, so the threshold can be retuned without a
     * migration and without rewriting history.
     */
    assistRetention: real("assist_retention"),
    /** Which offered draft the saved text most resembled. */
    assistDraftRevision: integer("assist_draft_revision"),
    /**
     * Normalized word-level edit distance from the closest offered DRAFT to
     * the text the owner saved, frozen at the same moment as
     * `assist_retention`. Gate 2's voice-fit signal (2026-07-28 mode-ladder
     * spec) reads this: ≤0.2 means the owner published the agent's
     * preparation nearly as-is. Independently nullable — null means no draft
     * was offered for this save (angles-only rounds, blank-box comments, and
     * every pre-feature row), never conflated with assist_retention's null.
     * A later decide does not re-measure; the save-time value stands.
     */
    draftFitDistance: real("draft_fit_distance"),
    /** Optional second opinion: embedding cosine similarity of the same pair,
     *  written best-effort AFTER the save commits (the embedder is metered
     *  and may be absent). Null = never measured. */

    /**
     * How much of the saved text traced back to wording the OWNER supplied —
     * text they seeded with Improve mine, or dictated to their agent and kept.
     *
     * Retention alone cannot tell authorship from CHANNEL: an owner who says
     * "put it like this" and keeps what comes back scores as fully assisted
     * while every word is theirs. Null means no such claim was measured, which
     * is every historical row, and classifies exactly as it always did.
     */
    ownerOrigin: real("owner_origin"),
    // E1 measurement (PR2): provenance of the compiled focus brief this message was
    // drafted under — null when no brief was injected (coldStart / kill switch /
    // uncompiled, i.e. the flat-retrieval path). `briefSourceHash` = the brief
    // version; `briefAnchorIds` = the knowledge rows the brief drew on. Lets
    // engagement_events (replies received) be attributed back to a brief version.
    briefSourceHash: text("brief_source_hash"),
    briefAnchorIds: jsonb("brief_anchor_ids").$type<number[]>(),
    // Writer-variety provenance: the OPENING/SHAPE/STANCE classes the writer was
    // directed to use for the PROPOSED text, and the max structural similarity to
    // the recent org-wide window at draft time (the anti-monoculture metric). Both
    // describe the proposed draft only — human `finalText` edits do not update them.
    styleDirectives: jsonb("style_directives").$type<StyleDirectives>(),
    structuralNovelty: real("structural_novelty"),
    // Per-draft decision trace (length tier / slop gate / voice / facts provenance).
    // Server-computed except `trace.client.declared` (MCP-self-reported). Null for
    // pre-feature rows.
    trace: jsonb("trace").$type<DraftTrace>(),
    // Snapshot of the discovered post's BetScore at the moment this message was
    // created (Gate 2 post-best-eligible reads this to post the highest-priority
    // eligible message first). Null for pre-feature rows + when the ranker is off.
    betScoreAtPost: real("bet_score_at_post"),
    /** The owner story (`knowledge` row tagged `owner_story`) this comment
     *  tells, so a story is told at most once a day. A plain bigint, no FK:
     *  deleting the note does not unsay the comment. */
    ownerStoryId: bigint("owner_story_id", { mode: "number" }),
    /** The `draft_plans` row this draft was written from, when the draft
     *  dispatcher planned it. A plain bigint, no FK, like `ownerStoryId`: the
     *  plan is evidence of how the words were made, not a parent of them. */
    draftPlanId: bigint("draft_plan_id", { mode: "number" }),
    /**
     * Whether the like this send's step binds goes out WITH it — on the same
     * yes, as a `like_target` action the gate sends once the send is posted
     * (`actions/likeTarget.ts` `sendLike`).
     *
     * Null is undecided, and means the step's own default: a comment likes
     * the post it answers whenever its step binds Like post above Off; a
     * reply likes nothing. True is a decision to like — the step proposed its
     * like of the reply it answers with that answer. False is a decision not
     * to: the owner unticked "+ Like" before their yes.
     */
    likeWithSend: boolean("like_with_send"),
    /** What became of that like once the send went out. Null while nothing
     *  has: not sent yet, or a send that carried no like. */
    likeOutcome: jsonb("like_outcome").$type<MessageLikeOutcome>(),
    error: text("error"),
    /**
     * Why a send that definitely did not post failed, as a code: the
     * connector's own (`PostResult.code` — the browser sidecar's
     * `DOM_CHANGED` for a comment box it could not find) or the send path's
     * (`thread_depth_cap`, a permanent refusal of the send gate). Written with
     * every `failed` this row takes, null where nothing named one, and read
     * only on a `failed` row: the owner is told the cause in their words
     * (`lib/message-presentation.ts`), `error` keeping the raw text.
     */
    errorCode: text("error_code"),
    /**
     * The write-journal operation id of the attempt now `posting` or awaiting
     * review (`postingRecovery.ts`), so a retry and a resolution address the
     * entry the sidecar actually wrote. Null before the first press.
     */
    writeMarker: text("write_marker"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    postedAt: bigint("posted_at", { mode: "number" }),
    // The planned send slot, assigned ONCE (jittered, human-random gaps) when the
    // message becomes approved+enqueued (assignSlots). A plan, not a bypass: every
    // hard gate (caps, active hours, kill switch) still decides at send time. Null =
    // slotless (pre-feature rows, post-now) → the legacy even-grid pacing applies.
    scheduledAt: bigint("scheduled_at", { mode: "number" }),
    /** Durable start of the current provider-write attempt. A fresh marker means
     * another caller is legitimately in flight; only an expired marker may enter
     * reconcile-or-hold recovery. The DB trigger fills/clears this for rolling
     * compatibility with pre-column workers. */
    postingStartedAt: bigint("posting_started_at", { mode: "number" }),
    /** When the send was last tried: set as the row enters `posting`, or
     *  fails on the way there, and never cleared — `postingStartedAt` is, on
     *  leaving `posting` — so a failed send can say when it was tried. */
    lastAttemptAt: bigint("last_attempt_at", { mode: "number" }),
  },
  (t) => ({
    orgDedupeUnq: uniqueIndex("messages_org_dedupe_unq").on(
      t.organizationId,
      t.dedupeKey,
    ),
    orgIdUnq: uniqueIndex("messages_org_id_unq").on(t.organizationId, t.id),
    linkedCommentUnq: uniqueIndex("messages_org_discovered_post_unq")
      .on(t.organizationId, t.discoveredPostId)
      .where(sql`${t.discoveredPostId} is not null`),
    linkedReplyUnq: uniqueIndex("messages_org_incoming_comment_unq")
      .on(t.organizationId, t.incomingCommentId)
      .where(sql`${t.incomingCommentId} is not null`),
    orgStatusIdx: index("messages_org_status_idx").on(
      t.organizationId,
      t.status,
    ),
    orgKindStatusIdx: index("messages_org_kind_status_idx").on(
      t.organizationId,
      t.kind,
      t.status,
    ),
    postingMarkerCheck: check(
      "messages_posting_marker_check",
      sql`(${t.status} = 'posting' and ${t.postingStartedAt} is not null) or (${t.status} <> 'posting' and ${t.postingStartedAt} is null)`,
    ),
    targetKindCheck: check(
      "messages_target_kind_check",
      sql`(${t.kind} = 'comment' and ${t.incomingCommentId} is null and ${t.roomReplyTarget} is null)
        or (${t.kind} = 'reply' and ${t.discoveredPostId} is null and ${t.roomReplyTarget} is null)
        or (${t.kind} = 'room_reply' and ${t.incomingCommentId} is null and ${t.roomReplyTarget} is not null
          and jsonb_typeof(${t.roomReplyTarget}) = 'object')`,
    ),
    redraftRequestMetadataCheck: check(
      "messages_redraft_request_metadata_check",
      sql`(${t.redraftRequestId} is null and ${t.redraftRequestedAt} is null and ${t.redraftRequestedBy} is null) or (${t.redraftRequestId} is not null and ${t.redraftRequestedAt} is not null and ${t.redraftRequestedBy} is not null)`,
    ),
    redraftRequestVersionCheck: check(
      "messages_redraft_request_version_check",
      sql`${t.redraftRequestVersion} >= 0`,
    ),
    // Enforced in the DB as well as the drizzle enum: this column decides
    // whether a real send is capped, so a raw insert must not be able to
    // invent a third value that `pacingPolicy` would fall through on.
    publishOriginCheck: check(
      "messages_publish_origin_check",
      sql`${t.publishOrigin} in ('owner','worker')`,
    ),
  }),
);

/** Why a message moved, where the move alone cannot say — written by the
 *  status trigger from the transaction-local `app.message_status_reason`. */
export const MESSAGE_STATUS_REASONS = ["owner_unscheduled"] as const;

/**
 * Immutable message lifecycle facts. `campaignId` is a snapshot rather than a
 * foreign key so each event keeps its original attribution; deleting the parent
 * message deliberately cascades the complete history.
 */
export const messageStatusEvents = pgTable(
  "message_status_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    campaignId: bigint("campaign_id", { mode: "number" }),
    fromStatus: text("from_status", {
      enum: messages.status.enumValues,
    }),
    toStatus: text("to_status", {
      enum: messages.status.enumValues,
    }).notNull(),
    localDay: text("local_day").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    /** Null for every move but one whose writer named it: the owner's
     *  Unschedule (`approved -> proposed`), which nothing may take for the
     *  retired Curate fence's demotion of the same shape. */
    reason: text("reason", { enum: MESSAGE_STATUS_REASONS }),
  },
  (t) => ({
    backfillIdentityUnq: uniqueIndex(
      "message_status_events_backfill_identity_unq",
    ).on(
      t.messageId,
      sql`coalesce(${t.fromStatus}, '')`,
      t.toStatus,
      t.occurredAt,
    ),
    orgDayIdx: index("message_status_events_org_day_idx").on(
      t.organizationId,
      t.localDay,
      t.occurredAt,
    ),
    orgCampaignDayIdx: index("message_status_events_org_campaign_day_idx").on(
      t.organizationId,
      t.campaignId,
      t.localDay,
      t.occurredAt,
    ),
    messageTimeIdx: index("message_status_events_message_time_idx").on(
      t.messageId,
      t.occurredAt,
    ),
    localDayCheck: check(
      "message_status_events_local_day_check",
      sql`${t.localDay} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
    reasonCheck: check(
      "message_status_events_reason_check",
      sql`${t.reason} is null or ${t.reason} in ('owner_unscheduled')`,
    ),
  }),
);

/** Immutable history of every effective draft body persisted for a message.
 *  `variant_swap` is the owner putting another draft of a judged set in the
 *  box (`useDraftVariant`): a draft Engager wrote, chosen, not one edited. */
export const messageDraftRevisions = pgTable(
  "message_draft_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    revision: integer("revision").notNull(),
    source: text("source", {
      enum: ["initial", "redraft", "human_edit", "variant_swap"],
    }).notNull(),
    draftText: text("draft_text").notNull(),
    requestId: uuid("request_id"),
    requestVersion: integer("request_version"),
    requestedAt: bigint("requested_at", { mode: "number" }),
    requestedBy: text("requested_by"),
    requestNote: text("request_note"),
    model: text("model"),
    loopVersion: text("loop_version"),
    promptVersionId: bigint("prompt_version_id", { mode: "number" }),
    trace: jsonb("trace").$type<DraftTrace>(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    messageFk: foreignKey({
      name: "message_draft_revisions_org_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    orgMessageRevisionUnq: uniqueIndex(
      "message_draft_revisions_org_message_revision_unq",
    ).on(t.organizationId, t.messageId, t.revision),
    orgRequestUnq: uniqueIndex("message_draft_revisions_org_request_unq")
      .on(t.organizationId, t.requestId)
      .where(sql`${t.requestId} is not null`),
    messageChronologyIdx: index(
      "message_draft_revisions_message_chronology_idx",
    ).on(t.organizationId, t.messageId, t.createdAt, t.revision),
    revisionCheck: check(
      "message_draft_revisions_revision_check",
      sql`${t.revision} >= 1`,
    ),
    sourceCheck: check(
      "message_draft_revisions_source_check",
      sql`${t.source} in ('initial', 'redraft', 'human_edit', 'variant_swap')`,
    ),
    requestMetadataCheck: check(
      "message_draft_revisions_request_metadata_check",
      sql`(${t.requestId} is null and ${t.requestVersion} is null and ${t.requestedAt} is null and ${t.requestedBy} is null) or (${t.requestId} is not null and ${t.requestVersion} is not null and ${t.requestVersion} >= 0 and ${t.requestedAt} is not null and ${t.requestedBy} is not null)`,
    ),
  }),
);

/** Which reader made a row: the connector's own markup `parser`, or the
 *  `agent` reader — a model reading the page, every identifier and word it
 *  cites verified against the page by the server (`core/reader/`). */
export const READERS = ["parser", "agent"] as const;
export type Reader = (typeof READERS)[number];

/** Why intake held a reply for the owner (`sensitivity = 'hold'`): it was
 *  `backlog` when first seen; its campaign keeps every reply held for the
 *  owner (`campaign_holds`, one that does not run on its strategy); it came
 *  from a notification card no thread read has confirmed (`unconfirmed`); or
 *  the sensitivity check judged it hostile, press, legal, a competitor's,
 *  profane or otherwise not for a draft, by its category. */
export type IncomingHoldReason =
  | "backlog"
  | "campaign_holds"
  | "unconfirmed"
  | "sensitive_negative"
  | "sensitive_press"
  | "sensitive_legal"
  | "sensitive_competitor"
  | "sensitive_profanity"
  | "sensitive_other";

/** What one model call made of one person's words to the owner: a comment on
 *  the owner's post, a reply under their comment, a direct message or an
 *  invitation's note. The one place their stance, opt-out, buying intent and
 *  sensitivity are read; every later decision reads it from here and no
 *  classifier reads the words again. Core owns the verdict's rules
 *  (`packages/core/ai/reading.ts`). */
export type IncomingReading = {
  kind: "comment" | "reply" | "message" | "invite_note";
  /** SHA-256 hex of the words read: a row whose words changed is read again. */
  textHash: string;
  model: string;
  promptRef: string;
  readAt: number;
  verdict: {
    evidence: Array<{ quote: string; supports: string }>;
    relevance: "relevant" | "unrelated" | "spam";
    stance: "positive" | "neutral" | "negative";
    opt_out: boolean;
    busy: boolean;
    question: boolean;
    interest: boolean;
    greeting: boolean;
    uncertain: boolean;
    lead_intent: "explicit_ask" | "product_question" | "positive_signal" | "none";
    lead_evidence: string;
    hold: boolean;
    category: "ok" | "negative" | "press" | "legal" | "competitor" | "profanity" | "other";
    arc?: "substantive" | "warm_closer" | "cold_closer";
  };
};

export const incomingComments = pgTable(
  "incoming_comments",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      {
        onDelete: "set null",
      },
    ),
    discoveredPostId: bigint("discovered_post_id", { mode: "number" }),
    parentMessageId: bigint("parent_message_id", { mode: "number" }),
    draftRequestId: uuid("draft_request_id"),
    draftRequestVersion: integer("draft_request_version").notNull().default(0),
    draftRequestedAt: bigint("draft_requested_at", { mode: "number" }),
    draftRequestedBy: text("draft_requested_by"),
    draftRequestNote: text("draft_request_note"),
    /** The post the thread lives on. `source='our_comment_thread'` may be a
     *  discovered post we commented on or our own post when someone follows up
     *  beneath a reply (the name is kept for schema stability). */
    ownPostUrn: text("own_post_urn").notNull(),
    commentUrn: text("comment_urn").notNull(),
    authorProfileId: profileIdText("author_profile_id"),
    /** The replier's own identity on LinkedIn, `urn:li:fsd_profile:…` — the
     *  form LinkedIn's conversation data names a member by — where the read
     *  or the notification card that recorded the reply carried it. */
    authorMemberUrn: text("author_member_urn"),
    authorName: text("author_name"),
    text: text("text").notNull(),
    /** SHA-256 hex of `text` as the last thread read of it showed it. Null on
     *  rows no thread read wrote (the own-post sweep, the provider monitor). A
     *  later read with another hash is an EDIT: `text` takes the new words and
     *  `textRevision` counts the change — the same urn is never a second row. */
    textHash: text("text_hash"),
    textRevision: integer("text_revision").notNull().default(1),
    /** When a complete thread read found this reply gone — its author deleted
     *  it, or the post it was on went. Its unsent drafts were withdrawn in the
     *  same transaction. */
    removedAt: bigint("removed_at", { mode: "number" }),
    /** When a complete thread read, our comment present, first did not show
     *  this reply. Cleared by any read that shows it; a second such read at
     *  least six hours on is what sets `removedAt`. */
    missingSince: bigint("missing_since", { mode: "number" }),
    /** When the thread read that wrote the current revision saw it — the
     *  `observed_at` of the conversation event that records it. Null on rows no
     *  thread read wrote. */
    observedAt: bigint("observed_at", { mode: "number" }),
    receivedAt: bigint("received_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    sensitivity: text("sensitivity", { enum: ["ok", "hold"] })
      .notNull()
      .default("ok"),
    /** Why a held row is held, written with `sensitivity` wherever intake
     *  sets it, and null on an `ok` row. Null on a held row older than the
     *  column, which reads as held from intake. TS-union only, no DB CHECK. */
    holdReason: text("hold_reason").$type<IncomingHoldReason>(),
    /** 'ignored' = a POLICY declined it (Reply off / no campaign);
     *  'dismissed' = no reply goes out: the owner's Don't reply, or the org's
     *  AGENT judging none was needed (closer / nothing to add), as
     *  `dismissedBy` says. Kept distinct so judgment is auditable. */
    status: text("status", {
      enum: ["new", "reply_proposed", "replied", "ignored", "dismissed"],
    })
      .notNull()
      .default("new"),
    /** The last dismissal, written in the transaction that dismissed the row,
     *  for its Undo (`undoDontReply`): when, the status it left, the reply
     *  draft of ours it withdrew and the request version it left that draft
     *  at, and who chose it. Null on a row never dismissed, and on one
     *  dismissed before the press was recorded, which no Undo can take back.
     *  Drizzle-level enums only, no DB CHECK. */
    dismissedAt: bigint("dismissed_at", { mode: "number" }),
    dismissedFrom: text("dismissed_from", { enum: ["new", "reply_proposed", "ignored"] }),
    dismissedReplyId: bigint("dismissed_reply_id", { mode: "number" }),
    dismissedReplyVersion: integer("dismissed_reply_version"),
    dismissedBy: text("dismissed_by", { enum: ["owner", "agent"] }),
    /** Where this comment came from: a top-level comment on our own post
     *  (classic pollIncoming) or a continuation beneath a message we authored
     *  (engagement monitor). */
    source: text("source", { enum: ["own_post", "our_comment_thread"] })
      .notNull()
      .default("own_post"),
    /** For thread replies: the top-level comment urn (ours on a discovered post,
     *  theirs on our post). LinkedIn threads are flat under this root, and
     *  reply-backs post with comment_id = this urn. */
    threadParentUrn: text("thread_parent_urn"),
    /** For own_post rows: the OWN post's text, captured at intake (own posts
     *  are not persisted anywhere else) so reply drafting sees what the post
     *  said. Thread rows leave it null — their post text lives in
     *  discovered_posts via the root comment's message. */
    postText: text("post_text"),
    /** Lead-intent verdict from the intake classifier (runs for EVERY inbound
     *  comment BEFORE any reply gating, so a policy-ignored row still counts
     *  as a lead signal). NULL = not yet classified (classifier failed or
     *  pre-feature row) — distinct from 'none', which is a judged verdict. */
    intent: text("intent", {
      enum: ["explicit_ask", "product_question", "positive_signal", "none"],
    }),
    /** Verbatim quote from the comment that justified the intent verdict. */
    intentEvidence: text("intent_evidence"),
    classifiedAt: bigint("classified_at", { mode: "number" }),
    /** The one reading of these words: stance, opt-out, lead intent and
     *  sensitivity. Null until the row is first processed; a row whose words
     *  were edited since is read again (`textHash`). */
    reading: jsonb("reading").$type<IncomingReading>(),
    /** The reader whose thread read first wrote the row. */
    reader: text("reader", { enum: READERS }).notNull().default("parser"),
  },
  (t) => ({
    orgCommentUrnUnq: uniqueIndex("incoming_comments_org_comment_urn_unq").on(
      t.organizationId,
      t.commentUrn,
    ),
    orgIdUnq: uniqueIndex("incoming_comments_org_id_unq").on(
      t.organizationId,
      t.id,
    ),
    orgStatusIdx: index("incoming_comments_org_status_idx").on(
      t.organizationId,
      t.status,
    ),
    /** The other half of the cycle `messages.incomingCommentId` documents, and
     *  installed the same way — `concurrent-indexes.ts` is what creates it,
     *  DEFERRABLE INITIALLY IMMEDIATE, which the builder below cannot say
     *  because the pinned drizzle-orm exposes only `onUpdate`/`onDelete`. */
    parentMessageFk: foreignKey({
      name: "incoming_comments_org_parent_message_fk",
      columns: [t.organizationId, t.parentMessageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("no action"),
    rootPostFk: foreignKey({
      name: "incoming_comments_org_campaign_post_fk",
      columns: [t.organizationId, t.campaignId, t.discoveredPostId],
      foreignColumns: [
        discoveredPosts.organizationId,
        discoveredPosts.campaignId,
        discoveredPosts.id,
      ],
    }).onDelete("no action"),
    sourceLinksCheck: check(
      "incoming_comments_source_links_check",
      sql`(${t.source} = 'own_post' and ${t.discoveredPostId} is null and ${t.parentMessageId} is null) or (${t.source} = 'our_comment_thread' and ${t.parentMessageId} is not null)`,
    ),
    draftRequestMetadataCheck: check(
      "incoming_comments_draft_request_metadata_check",
      sql`(${t.draftRequestId} is null and ${t.draftRequestedAt} is null and ${t.draftRequestedBy} is null) or (${t.draftRequestId} is not null and ${t.draftRequestedAt} is not null and ${t.draftRequestedBy} is not null)`,
    ),
    draftRequestVersionCheck: check(
      "incoming_comments_draft_request_version_check",
      sql`${t.draftRequestVersion} >= 0`,
    ),
    readerCheck: check(
      "incoming_comments_reader_check",
      sql`${t.reader} in ('parser', 'agent')`,
    ),
  }),
);

export const engagementEvents = pgTable(
  "engagement_events",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    messageId: bigint("message_id", { mode: "number" }).references(
      () => messages.id,
      {
        onDelete: "set null",
      },
    ),
    ownPostUrn: text("own_post_urn"),
    actorProfileId: profileIdText("actor_profile_id"),
    actorName: text("actor_name"),
    type: text("type", {
      enum: ["like_received", "reply_received", "profile_view", "connection"],
    }).notNull(),
    ts: bigint("ts", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    orgTypeTsIdx: index("engagement_events_org_type_ts_idx").on(
      t.organizationId,
      t.type,
      t.ts,
    ),
  }),
);

/**
 * A watch on a comment WE posted: the engagement monitor re-checks it on a
 * decaying jittered cadence for replies/reactions (the product's real success
 * metric). Created in a comment's success bookkeeping; expired by TTL or
 * after enough quiet checks. `commentUrn` = messages.externalUrn; every
 * provider reply/reaction query is rooted at the PARENT post (`postUrn`) with
 * the comment id as a filter. `resolvedCommentId` covers a stored-id format
 * that doesn't match listings (unverified for pre-monitor prod rows) —
 * resolved on first check via author+text match, reconcilePosted-style.
 */
export const commentWatches = pgTable(
  "comment_watches",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      {
        onDelete: "set null",
      },
    ),
    postUrn: text("post_urn").notNull(),
    commentUrn: text("comment_urn").notNull(),
    resolvedCommentId: text("resolved_comment_id"),
    lastReplyCount: integer("last_reply_count").notNull().default(0),
    lastReactionCount: integer("last_reaction_count").notNull().default(0),
    /** Reactor profile ids already turned into like_received events (capped ~200). */
    seenReactorIds: jsonb("seen_reactor_ids").$type<string[]>(),
    quietChecks: integer("quiet_checks").notNull().default(0),
    nextCheckAt: bigint("next_check_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    state: text("state", { enum: ["active", "expired"] })
      .notNull()
      .default("active"),
    /** What the agent reader made of the watch's last check — "read 3 replies
     *  on your comment (agent reader)" — or null where the connector's own
     *  read answered alone. */
    lastReadNote: text("last_read_note"),
    /** When the post our comment is on first answered that it is gone — a
     *  404/410, or LinkedIn's page for a post deleted or removed — with no
     *  read loading it since. A second answer six hours on retires the watch
     *  and keeps it, so an expired watch that holds one is on a deleted post
     *  (`missPost`, replyWatches.ts). A read that does not find our comment
     *  never sets it: that is never our comment gone (0210). */
    missingSince: bigint("missing_since", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgMessageUnq: uniqueIndex("comment_watches_org_message_unq").on(
      t.organizationId,
      t.messageId,
    ),
    orgStateNextIdx: index("comment_watches_org_state_next_idx").on(
      t.organizationId,
      t.state,
      t.nextCheckAt,
    ),
  }),
);

export const engagedProfiles = pgTable(
  "engaged_profiles",
  {
    organizationId: orgId(),
    profileId: profileIdText("profile_id").notNull(),
    name: text("name"),
    headline: text("headline"),
    company: text("company"),
    url: text("url"),
    firstEngagedAt: bigint("first_engaged_at", { mode: "number" }),
    lastEngagedAt: bigint("last_engaged_at", { mode: "number" }),
    totalComments: bigint("total_comments", { mode: "number" })
      .notNull()
      .default(0),
    totalReplies: bigint("total_replies", { mode: "number" })
      .notNull()
      .default(0),
    doNotEngage: boolean("do_not_engage").notNull().default(false),
    retainUntil: bigint("retain_until", { mode: "number" }),
    notes: text("notes"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.organizationId, t.profileId] }) }),
);

/** Spec §11 R08: where the account stands with a person, as server-read
 *  evidence last showed it. `unknown` until a read proves otherwise. */
export const CONVERSATION_RELATIONSHIPS = [
  "unknown",
  "not_connected",
  "outgoing_pending",
  "incoming_pending",
  "connected",
] as const;
export type ConversationRelationship = (typeof CONVERSATION_RELATIONSHIPS)[number];

/** The read a person's relationship with an account was written from: their
 *  own profile, read in that account's signed-in session. */
export type IdentityEvidence = {
  method: "relationship_read";
  channelId: number;
  read: RelationshipReadJson;
};

/**
 * Author-impact CACHE: profile metrics (followers/connections) for discovered-post
 * AUTHORS, fetched by the `enrich_authors` job under the `profile` rate budget and
 * refreshed on a TTL (~21d — impact metrics drift slowly). Deliberately SEPARATE
 * from `engaged_profiles`, which tracks authors we actually engaged (doNotEngage /
 * retention semantics); cache rows here cover authors we may never touch.
 * `fetchError` marks a profile the endpoint 422/404'd (companies, dead profiles) —
 * cooled down for a full TTL rather than retried hot.
 *
 * It is the one cache of a profile read: the read itself, the relationship a
 * read of the person's profile last showed, which nothing but such a read
 * writes, and where a Research read of their profile last placed them. The
 * profile id is lower case here, as in every table that names a person.
 */
export const authorProfiles = pgTable(
  "author_profiles",
  {
    organizationId: orgId(),
    profileId: profileIdText("profile_id").notNull(),
    headline: text("headline"),
    location: text("location"),
    /** ISO 3166-1 alpha-2, from a profile read's location. A later read that
     *  names none leaves a known one in place. */
    country: text("country"),
    /** The geo that location names, `urn:li:fsd_geo:<id>`. */
    geoUrn: text("geo_urn"),
    /** When a Research read of the profile last looked for a country, found
     *  or not. Null: never looked, so an unknown country is worth a read. */
    countryReadAt: bigint("country_read_at", { mode: "number" }),
    /** The profile read Research made, LinkedIn text held as data, and when
     *  it was made. Both null until a read; one is good for 14 days, and
     *  serves every lead, post and room the person is in. */
    profileRead: jsonb("profile_read").$type<AuthorProfileReadJson>(),
    profileReadAt: bigint("profile_read_at", { mode: "number" }),
    followers: bigint("followers", { mode: "number" }),
    connections: bigint("connections", { mode: "number" }),
    isInfluencer: boolean("is_influencer"),
    isPremium: boolean("is_premium"),
    fetchedAt: bigint("fetched_at", { mode: "number" }).notNull(),
    fetchError: text("fetch_error"),
    /** The relationship the latest read that could tell showed, read at
     *  `relationship_checked_at`. A conversation's own `relationship` is its
     *  account's, and the one every decision reads. */
    relationship: text("relationship", { enum: CONVERSATION_RELATIONSHIPS })
      .notNull()
      .default("unknown"),
    relationshipCheckedAt: bigint("relationship_checked_at", { mode: "number" }),
    /** That read: the account it was made on, and the profile page it
     *  verified as this person's. */
    identityEvidence: jsonb("identity_evidence").$type<IdentityEvidence>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.profileId] }),
    profileReadCheck: check(
      "author_profiles_profile_read_check",
      sql`(${t.profileRead} is null) = (${t.profileReadAt} is null)`,
    ),
    relationshipCheck: check(
      "author_profiles_relationship_check",
      sql`${t.relationship} in ('unknown', 'not_connected', 'outgoing_pending', 'incoming_pending', 'connected')`,
    ),
  }),
);

/** Provenance of a lead's suggested DM — what the draft was assembled from,
 *  rendered on the Leads page so trust is inspectable (the messages-`trace`
 *  idea, DM-sized). `edited: true` = the human touched it after drafting. */
export type LeadDmTrace = {
  promptRef?: string;
  campaign?: string | null;
  /** The names of the campaign's attached products, comma-separated. */
  product?: string | null;
  thread?: boolean;
  knowledge?: boolean;
  web?: {
    searched: boolean;
    searchCount: number;
    sources: { url: string; title?: string }[];
  } | null;
  edited?: boolean;
};

export type LeadTier = "hot" | "warm" | "watch";
export type LeadStatus =
  | "new"
  | "contacted"
  | "in_conversation"
  | "converted"
  | "dead";
export type LeadIntent =
  | "explicit_ask"
  | "product_question"
  | "positive_signal"
  | "none";

/** How far Scout carried a person. A null `leads.stage` reads as Relationship
 *  (`leadStage`, core's `leads/read.ts`). */
export const LEAD_STAGES = ["signal", "lead", "contacted", "relationship", "no_answer"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
/** What a person is to the owner; only a buyer is ever served. */
export const LEAD_ROLES = ["buyer", "peer", "competitor", "partner", "noise"] as const;
export type LeadRole = (typeof LEAD_ROLES)[number];
/** How a person arrived. A null `leads.origin` reads as inbound. */
export const LEAD_ORIGINS = ["inbound", "find_leads"] as const;
export type LeadOrigin = (typeof LEAD_ORIGINS)[number];
export const LEAD_FITS = ["strong", "fits", "weak"] as const;
export type LeadFit = (typeof LEAD_FITS)[number];
/** What a person's own words show, as Scout reads them. Not `LeadIntent`,
 *  which is the reply-interest classifier's scale. */
export const SCOUT_INTENTS = ["asking", "has_problem", "topic_only"] as const;
export type ScoutIntent = (typeof SCOUT_INTENTS)[number];
/** Why Deep read no company page for a lead: their profile names none, the
 *  connection cannot read one, the day's profile reads ran out, or the read
 *  failed. */
export const COMPANY_NOT_READ = ["no_company_page", "unsupported", "reads_spent", "failed"] as const;
export type CompanyNotRead = (typeof COMPANY_NOT_READ)[number];
/** The owner's answer to "Is this right?" on a lead. */
export const LEAD_RATINGS = ["right_person", "a_peer", "not_a_fit", "wrong_intent"] as const;
export type LeadRating = (typeof LEAD_RATINGS)[number];
/** Why a lead is set aside: the owner's own press, which their next words
 *  undo, or their rating Not a fit or A peer, which nothing undoes but them. */
export const SET_ASIDE_REASONS = ["owner", "not_a_fit", "a_peer"] as const;
export type SetAsideReason = (typeof SET_ASIDE_REASONS)[number];
/** Where Scout stopped trying a person after their tries ran out: their
 *  profile would not read, or their words would not be judged. Never the owner's
 *  Set aside, which is `leads.setAsideAt`. */
export const PIPELINE_HOLDS = ["unread", "unjudged"] as const;
export type PipelineHold = (typeof PIPELINE_HOLDS)[number];
/** The first send that reached a lead: a comment or reply is a `messages` row,
 *  an invitation an `actions` row. */
export type LeadFirstSend = { kind: "message" | "action"; id: number };
/** Where one of Qualify's reasons comes from: the person's post or comment (a
 *  `lead_signals` id), their profile, a recent post inside the profile read
 *  (its urn), or one of the campaign's product facts (its id). */
export const QUALIFICATION_SOURCES = ["post", "comment", "profile", "recent_post", "product_facts"] as const;
export type QualificationSource = (typeof QUALIFICATION_SOURCES)[number];
/** What Qualify concluded about a person and why, as it is kept on the lead.
 *  `text`, `unknown` and `thread` are model text over LinkedIn words, held as
 *  data. `inferred` marks a reason drawn from the title and not their words. A
 *  reason sourced to a product fact names that fact's product (`productId`),
 *  whose facts in Brain it opens. */
export type LeadQualificationJson = {
  reasons: Array<{ text: string; source: QualificationSource; ref: string | null; productId?: number; inferred: boolean }>;
  unknown: string | null;
  thread: string | null;
  promptRef: string;
  model: string;
  at: number;
};

/**
 * A person showing buying intent, detected from CAMPAIGN engagement only —
 * thread replies (and reactions) on comments a campaign posted. Comments on the
 * org's OWN posts are deliberately out of scope: they engage the person's
 * content history, not a campaign, and polluted leads with other-product
 * questions when included. ONE row per (org, profile) — the lifecycle lives in
 * `status`, not in new rows: a `dead` lead that signals again (≥
 * product_question) reopens to `new`; `converted` never reopens. `intentLevel`
 * is the BEST intent ever seen (ratchets up, a later drive-by 'none' never
 * downgrades); `tier` is recomputed on every signal from intent × authority ×
 * touch count and also only ratchets up — humans demote via status.
 * `campaignId` follows the strongest signal (same semantics as
 * `triggerIncomingCommentId`). Snapshot fields (name/headline/followers) are
 * display copies; authority truth stays in `author_profiles`. `dmDraft` is a
 * suggested copy-paste DM — there is deliberately NO code path that sends it.
 */
export const leads = pgTable(
  "leads",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    profileId: profileIdText("profile_id").notNull(),
    /** The campaign whose engagement produced the strongest signal so far. */
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      {
        onDelete: "set null",
      },
    ),
    name: text("name"),
    headline: text("headline"),
    followers: bigint("followers", { mode: "number" }),
    tier: text("tier", { enum: ["hot", "warm", "watch"] })
      .notNull()
      .default("watch"),
    status: text("status", {
      enum: ["new", "contacted", "in_conversation", "converted", "dead"],
    })
      .notNull()
      .default("new"),
    intentLevel: text("intent_level", {
      enum: ["explicit_ask", "product_question", "positive_signal", "none"],
    })
      .notNull()
      .default("none"),
    evidenceQuote: text("evidence_quote"),
    /** Lead mode. Every column below is null for a row today's intake wrote,
     *  which reads as an inbound Relationship (`leads/read.ts`). */
    stage: text("stage", { enum: LEAD_STAGES }),
    role: text("role", { enum: LEAD_ROLES }),
    origin: text("origin", { enum: LEAD_ORIGINS }),
    /** When Scout read their profile; null is "screened, not researched". */
    researchedAt: bigint("researched_at", { mode: "number" }),
    /** When the owner pressed Research on them and the read has not finished:
     *  the Leads page's "Researching…" (core's `leads/scout/press.ts`). */
    researchRequestedAt: bigint("research_requested_at", { mode: "number" }),
    /** Qualify's verdict and its reasons, and the up to three ways in it
     *  found; both replace what the screen guessed from their words alone. */
    qualification: jsonb("qualification").$type<LeadQualificationJson>(),
    angles: jsonb("angles").$type<LeadAngle[]>(),
    /** Why Deep's company page read left them unread, the last time it tried;
     *  null once one was read, or where none was tried. Their company's page
     *  itself is kept once, on `company_reads`. */
    companyNotRead: text("company_not_read", { enum: COMPANY_NOT_READ }),
    /** The profile reads and the judgments that failed for them, as the steps
     *  count them; at the limit `pipeline_hold` says which step gave up, and why
     *  in the note. Both null while they are not held. */
    readTries: integer("read_tries").notNull().default(0),
    judgeTries: integer("judge_tries").notNull().default(0),
    pipelineHold: text("pipeline_hold", { enum: PIPELINE_HOLDS }),
    pipelineHoldNote: text("pipeline_hold_note"),
    fit: text("fit", { enum: LEAD_FITS }),
    intent: text("intent", { enum: SCOUT_INTENTS }),
    /** Their own words, LinkedIn text held as data. Required for Asking and
     *  Has the problem. */
    intentQuote: text("intent_quote"),
    /** When they said the words, not when Scout read them. */
    intentAt: bigint("intent_at", { mode: "number" }),
    rating: text("rating", { enum: LEAD_RATINGS }),
    ratedAt: bigint("rated_at", { mode: "number" }),
    /** When the owner set them aside, and why (`core/leads/setAside.ts`);
     *  both null while they are not. */
    setAsideAt: bigint("set_aside_at", { mode: "number" }),
    setAsideReason: text("set_aside_reason", { enum: SET_ASIDE_REASONS }),
    /** When the first send that reached them settled, and which send it was
     *  (`core/leads/lifecycle.ts`). Both null until then. */
    contactedAt: bigint("contacted_at", { mode: "number" }),
    firstSend: jsonb("first_send").$type<LeadFirstSend>(),
    /** When they first answered after being found: that event's own time. */
    relationshipAt: bigint("relationship_at", { mode: "number" }),
    /** Their own words to the owner: when the newest arrived, and how many
     *  there have been — a reply under a campaign comment, a DM, an invitation
     *  note. Temperature reads these and never `tier`: a like feeds neither
     *  (`core/leads/temperature.ts`). */
    lastWordsAt: bigint("last_words_at", { mode: "number" }),
    wordTouchCount: integer("word_touch_count").notNull().default(0),
    /** The incoming comment carrying the BEST intent seen so far. */
    triggerIncomingCommentId: bigint("trigger_incoming_comment_id", {
      mode: "number",
    }).references(() => incomingComments.id, { onDelete: "set null" }),
    /** Display snapshot; recounted from incoming_comments + like events on each signal. */
    touchCount: integer("touch_count").notNull().default(1),
    /** Human-readable scoring rationale ("explicit ask", "authority: CEO", …). */
    tierReasons: jsonb("tier_reasons").$type<string[]>(),
    dmDraft: text("dm_draft"),
    dmDraftedAt: bigint("dm_drafted_at", { mode: "number" }),
    dmTrace: jsonb("dm_trace").$type<LeadDmTrace>(),
    /** Hot-lead email sent (one per lead, ever). */
    notifiedAt: bigint("notified_at", { mode: "number" }),
    /** Staleness nudge sent (one per lead, ever). */
    nudgedAt: bigint("nudged_at", { mode: "number" }),
    lastSignalAt: bigint("last_signal_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    statusChangedAt: bigint("status_changed_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgProfileUnq: uniqueIndex("leads_org_profile_unq").on(
      t.organizationId,
      t.profileId,
    ),
    orgTierStatusIdx: index("leads_org_tier_status_idx").on(
      t.organizationId,
      t.tier,
      t.status,
    ),
    orgCampaignStageIdx: index("leads_org_campaign_stage_idx").on(
      t.organizationId,
      t.campaignId,
      t.stage,
    ),
    // The referenced row of the same-org FK from `lead_signals.lead_id`.
    orgIdUnq: uniqueIndex("leads_org_id_unq").on(t.organizationId, t.id),
    stageCheck: check(
      "leads_stage_check",
      sql`${t.stage} is null or ${t.stage} in ('signal', 'lead', 'contacted', 'relationship', 'no_answer')`,
    ),
    roleCheck: check(
      "leads_role_check",
      sql`${t.role} is null or ${t.role} in ('buyer', 'peer', 'competitor', 'partner', 'noise')`,
    ),
    originCheck: check(
      "leads_origin_check",
      sql`${t.origin} is null or ${t.origin} in ('inbound', 'find_leads')`,
    ),
    fitCheck: check(
      "leads_fit_check",
      sql`${t.fit} is null or ${t.fit} in ('strong', 'fits', 'weak')`,
    ),
    intentCheck: check(
      "leads_intent_check",
      sql`${t.intent} is null or ${t.intent} in ('asking', 'has_problem', 'topic_only')`,
    ),
    intentQuoteCheck: check(
      "leads_intent_quote_check",
      sql`${t.intent} is null or ${t.intent} = 'topic_only'
        or (char_length(btrim(coalesce(${t.intentQuote}, ''))) > 0 and ${t.intentAt} is not null)`,
    ),
    ratingCheck: check(
      "leads_rating_check",
      sql`(${t.rating} is null or ${t.rating} in ('right_person', 'a_peer', 'not_a_fit', 'wrong_intent'))
        and (${t.rating} is null) = (${t.ratedAt} is null)`,
    ),
    setAsideCheck: check(
      "leads_set_aside_check",
      sql`(${t.setAsideReason} is null or ${t.setAsideReason} in ('owner', 'not_a_fit', 'a_peer'))
        and (${t.setAsideReason} is null) = (${t.setAsideAt} is null)`,
    ),
    firstSendCheck: check(
      "leads_first_send_check",
      sql`(${t.contactedAt} is null) = (${t.firstSend} is null)`,
    ),
    anglesCheck: check(
      "leads_angles_check",
      sql`${t.angles} is null or (jsonb_typeof(${t.angles}) = 'array' and jsonb_array_length(${t.angles}) <= 3)`,
    ),
    companyNotReadCheck: check(
      "leads_company_not_read_check",
      sql`${t.companyNotRead} is null or ${t.companyNotRead} in ('no_company_page', 'unsupported', 'reads_spent', 'failed')`,
    ),
    pipelineHoldCheck: check(
      "leads_pipeline_hold_check",
      sql`${t.pipelineHold} is null or ${t.pipelineHold} in ('unread', 'unjudged')`,
    ),
  }),
);

export type Lead = typeof leads.$inferSelect;

/** Where Find leads listens. Keywords are phrases searched on LinkedIn; the
 *  other three are places Scout reads, never people to serve. */
export const SEARCH_LANES = ["keywords", "creators", "competitors", "one_thread"] as const;
export type SearchLane = (typeof SEARCH_LANES)[number];
/** The kind of language a keywords phrase catches. */
export const LANGUAGE_TYPES = ["pain", "desired_outcome", "failed_alternative", "comparison", "direct_ask"] as const;
export type LanguageType = (typeof LANGUAGE_TYPES)[number];
export const SEARCH_ORIGINS = ["pains", "scout", "owner", "like_a_post"] as const;
export type SearchOrigin = (typeof SEARCH_ORIGINS)[number];
/** What a creators or competitors source is to the owner. */
export const SOURCE_ROLES = ["peer", "competitor"] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];
export const SEARCH_STATUSES = ["active", "parked", "retired"] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];

/**
 * Find leads' search map: the phrases and sources Scout reads to find
 * people in their own words, beside Find posts' `discovery_sources`, which
 * stays untouched. Its counters count people (`buyers`, `peers`, `noise`), not
 * posts. A creators or competitors row names a place to read, never a person
 * to serve. `source_key` is the normalized identity: `kw:<phrase>`,
 * `author:<profileId>`, `company:<id>` or `post:<urn>`. `term` and
 * `display_name` can be LinkedIn text.
 */
export const searches = pgTable(
  "searches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    sourceKey: text("source_key").notNull(),
    lane: text("lane", { enum: SEARCH_LANES }).notNull(),
    /** The phrase, or the source's display. */
    term: text("term").notNull(),
    displayName: text("display_name"),
    /** The author's profile id, the company page's id or the post urn a
     *  source reads. */
    targetRef: text("target_ref"),
    languageType: text("language_type", { enum: LANGUAGE_TYPES }),
    painId: text("pain_id"),
    origin: text("origin", { enum: SEARCH_ORIGINS }).notNull(),
    sourceRole: text("source_role", { enum: SOURCE_ROLES }),
    status: text("status", { enum: SEARCH_STATUSES }).notNull().default("active"),
    /** Set on a parked row LinkedIn refuses outright: the board's Refused. */
    refusedAt: bigint("refused_at", { mode: "number" }),
    pinned: boolean("pinned").notNull().default(false),
    rationale: text("rationale"),
    retiredAt: bigint("retired_at", { mode: "number" }),
    retiredBy: text("retired_by", { enum: ["scout", "owner"] }),
    sort: text("sort", { enum: ["relevance", "latest"] }).notNull().default("relevance"),
    datePosted: text("date_posted", { enum: ["past_day", "past_week", "past_month"] })
      .notNull()
      .default("past_week"),
    pagesPerSweep: integer("pages_per_sweep").notNull().default(5),
    cursor: text("cursor"),
    lastSweptAt: bigint("last_swept_at", { mode: "number" }),
    /** Set on a row read to its last page, which Scout reads again from the top
     *  once newer posts can have landed; null while it is being read. */
    nextReadAt: bigint("next_read_at", { mode: "number" }),
    buyers: integer("buyers").notNull().default(0),
    peers: integer("peers").notNull().default(0),
    noise: integer("noise").notNull().default(0),
    /** How many runs in a row read a creator or competitor source and found no
     *  buyer there; two retire it. Zero for a phrase and after a read that found
     *  one. */
    emptyReads: integer("empty_reads").notNull().default(0),
    lastCheckedAt: bigint("last_checked_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    keyUnq: uniqueIndex("searches_org_campaign_key_unq").on(
      t.organizationId,
      t.campaignId,
      t.sourceKey,
    ),
    orgIdUnq: uniqueIndex("searches_org_id_unq").on(t.organizationId, t.id),
    campaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "searches_org_campaign_fk",
    }).onDelete("cascade"),
    values: check(
      "searches_values_check",
      sql`${t.lane} in ('keywords', 'creators', 'competitors', 'one_thread')
        and (${t.languageType} is null or ${t.languageType} in ('pain', 'desired_outcome', 'failed_alternative', 'comparison', 'direct_ask'))
        and ${t.origin} in ('pains', 'scout', 'owner', 'like_a_post')
        and (${t.sourceRole} is null or ${t.sourceRole} in ('peer', 'competitor'))
        and ${t.status} in ('active', 'parked', 'retired')
        and (${t.retiredBy} is null or ${t.retiredBy} in ('scout', 'owner'))
        and ${t.sort} in ('relevance', 'latest')
        and ${t.datePosted} in ('past_day', 'past_week', 'past_month')
        and ${t.buyers} >= 0 and ${t.peers} >= 0 and ${t.noise} >= 0`,
    ),
    languageTypeRule: check(
      "searches_language_type_check",
      sql`case when ${t.lane} = 'keywords'
        then ${t.origin} = 'like_a_post' or ${t.languageType} is not null
        else ${t.languageType} is null end`,
    ),
    sourceRoleRule: check(
      "searches_source_role_check",
      sql`${t.sourceRole} is null or ${t.lane} in ('creators', 'competitors')`,
    ),
    retiredRule: check(
      "searches_retired_check",
      sql`(${t.retiredAt} is null) = (${t.retiredBy} is null)
        and (${t.retiredAt} is not null) = (${t.status} = 'retired')`,
    ),
    emptyReadsRule: check("searches_empty_reads_check", sql`${t.emptyReads} >= 0`),
  }),
);

export type Search = typeof searches.$inferSelect;

export const SEARCH_CHANGE_ACTORS = ["scout", "owner"] as const;
export type SearchChangeActor = (typeof SEARCH_CHANGE_ACTORS)[number];
export const SEARCH_CHANGE_ACTIONS = ["add", "retire", "restore", "pin", "unpin", "edit", "refused"] as const;
export type SearchChangeAction = (typeof SEARCH_CHANGE_ACTIONS)[number];

/**
 * Every change to a campaign's search map, and every one a plan asked for
 * and the server refused: who (`scout` or `owner`), what, the one-line
 * rationale and, for a refusal, its code. The history the run board lists for
 * one run (`run_id`) and a later plan reads; a row of the map only says where
 * it stands now. Mirrors `discovery_source_changes`. `term` can be LinkedIn
 * text (a creator's name).
 */
export const searchChanges = pgTable(
  "search_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    /** The row it changed; null for a refusal that made none. */
    phraseId: bigint("phrase_id", { mode: "number" }),
    /** The `worker_runs` row whose plan made it; null for an owner's. */
    runId: bigint("run_id", { mode: "number" }),
    actor: text("actor", { enum: SEARCH_CHANGE_ACTORS }).notNull(),
    action: text("action", { enum: SEARCH_CHANGE_ACTIONS }).notNull(),
    term: text("term").notNull(),
    rationale: text("rationale"),
    refusal: text("refusal"),
    /** The Scout change this owner's undo took back. A change is undone once
     *  (core's `leads/scout/mapEdits.ts`). */
    undoes: bigint("undoes", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    campaignIdx: index("search_changes_campaign_idx").on(t.organizationId, t.campaignId, t.createdAt),
    undoesUnq: uniqueIndex("search_changes_org_undoes_unq")
      .on(t.organizationId, t.undoes)
      .where(sql`${t.undoes} is not null`),
    runIdx: index("search_changes_run_idx").on(t.organizationId, t.runId),
    campaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "search_changes_org_campaign_fk",
    }).onDelete("cascade"),
    // The migration narrows the SET NULL to `phrase_id` alone, which the
    // organization column, being required, could not take.
    phraseFk: foreignKey({
      columns: [t.organizationId, t.phraseId],
      foreignColumns: [searches.organizationId, searches.id],
      name: "search_changes_org_phrase_fk",
    }).onDelete("set null"),
    values: check(
      "search_changes_values_check",
      sql`${t.actor} in ('scout', 'owner')
        and ${t.action} in ('add', 'retire', 'restore', 'pin', 'unpin', 'edit', 'refused')
        and (${t.action} = 'refused') = (${t.refusal} is not null)`,
    ),
    undoesCheck: check("search_changes_undoes_check", sql`${t.undoes} is null or ${t.actor} = 'owner'`),
  }),
);

export type SearchChange = typeof searchChanges.$inferSelect;

/**
 * The Scout's note on how its search map is doing ("What's working"), kept
 * with the run whose plan wrote it. Every plan writes a row: the newest one
 * says whether the last plan could be asked for, and the newest note that is
 * not empty is the one the Searches tab shows.
 */
export const searchPlans = pgTable(
  "search_plans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    runId: bigint("run_id", { mode: "number" }),
    /** Model text over the map's own numbers, held as data; empty when the
     *  plan said nothing or could not be asked for. */
    note: text("note").notNull(),
    /** The plan's call could not be answered, so nothing on the map changed
     *  by it. */
    failed: boolean("failed").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    campaignIdx: index("search_plans_campaign_idx").on(t.organizationId, t.campaignId, t.createdAt),
    campaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "search_plans_org_campaign_fk",
    }).onDelete("cascade"),
  }),
);

export type SearchPlan = typeof searchPlans.$inferSelect;

export const LEAD_SIGNAL_KINDS = ["post", "comment"] as const;
export type LeadSignalKind = (typeof LEAD_SIGNAL_KINDS)[number];
/** Where a signal's headline was read: the search result's author, or the
 *  comment's. */
export const HEADLINE_SOURCES = ["search", "comment"] as const;
export type HeadlineSource = (typeof HEADLINE_SOURCES)[number];
/** A way in the screen read from someone's words alone: a name of at most 24
 *  characters and a line of at most 160, the limits a composer angle keeps. */
export type LeadAngle = { name: string; why: string };
/** `expired` is a word that aged out before the screen took it, and
 *  `unscreenable` one the screen could not judge in its tries. Neither was
 *  judged, so neither is a pass or a drop. */
export const SIGNAL_VERDICTS = ["pending", "passed", "dropped", "expired", "unscreenable"] as const;
export type SignalVerdict = (typeof SIGNAL_VERDICTS)[number];
/** Why the screen dropped someone's words; core's `DROP_REASON_WORDS` has
 *  the owner-facing line for each. */
export const SIGNAL_DROP_REASONS = ["no_own_words", "not_audience", "selling_similar", "already_solved", "recruiter", "student"] as const;
export type SignalDropReason = (typeof SIGNAL_DROP_REASONS)[number];

/**
 * Someone's own words about the problem, found by a phrase or in a room's
 * comments, kept with where they were, what found them and why the screen
 * passed or dropped them. A person is keyed as everywhere (`p.<profileId>` or
 * `m.<id>`); a signal LinkedIn names only by member urn has no `profile_id`
 * and can never merge into a `leads` row, whose profile id is required.
 * `words`, `name` and `headline` are LinkedIn text, held as data. `said_at` is
 * when they wrote it (null when LinkedIn gives no time; readers fall back to
 * `seen_at`). Never engage erases a person's rows with the rest of their
 * discovery evidence (`rooms/retention.ts`).
 */
export const leadSignals = pgTable(
  "lead_signals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    personKey: text("person_key").notNull(),
    profileId: profileIdText("profile_id"),
    memberUrn: text("member_urn"),
    /** Display copies from the read. */
    name: text("name"),
    headline: text("headline"),
    headlineFrom: text("headline_from", { enum: HEADLINE_SOURCES }),
    kind: text("kind", { enum: LEAD_SIGNAL_KINDS }).notNull(),
    postUrn: text("post_urn").notNull(),
    /** Set exactly when `kind` is comment. */
    commentUrn: text("comment_urn"),
    url: text("url"),
    words: text("words").notNull(),
    saidAt: bigint("said_at", { mode: "number" }),
    /** How many comments the post had when it was read. */
    commentCount: integer("comment_count"),
    languageType: text("language_type", { enum: LANGUAGE_TYPES }),
    phraseId: bigint("phrase_id", { mode: "number" }),
    verdict: text("verdict", { enum: SIGNAL_VERDICTS }).notNull().default("pending"),
    /** When the scheduler expired a pending word, independent of its age. */
    expiredAt: bigint("expired_at", { mode: "number" }),
    /** The screen calls that left it without an accepted verdict. */
    tries: integer("tries").notNull().default(0),
    role: text("role", { enum: LEAD_ROLES }),
    /** Set exactly when `verdict` is dropped. */
    dropReason: text("drop_reason", { enum: SIGNAL_DROP_REASONS }),
    reason: text("reason"),
    /** Up to two ways in, read from the words alone, once the screen passes
     *  them; Qualify replaces them with a sharper set. */
    angles: jsonb("angles").$type<LeadAngle[]>(),
    /** The person's row, once the merge links a passed signal to it. */
    leadId: integer("lead_id"),
    /** The `worker_runs` row that saw it. */
    runId: bigint("run_id", { mode: "number" }),
    seenAt: bigint("seen_at", { mode: "number" }).notNull().$defaultFn(nowMs),
    createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    // The same words found twice in one campaign are one signal.
    wordsUnq: uniqueIndex("lead_signals_org_campaign_words_unq").on(
      t.organizationId,
      t.campaignId,
      sql`coalesce(${t.commentUrn}, ${t.postUrn})`,
    ),
    personIdx: index("lead_signals_org_person_seen_idx").on(t.organizationId, t.personKey, t.seenAt),
    verdictIdx: index("lead_signals_org_campaign_verdict_idx").on(
      t.organizationId,
      t.campaignId,
      t.verdict,
      t.seenAt,
    ),
    campaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "lead_signals_org_campaign_fk",
    }).onDelete("cascade"),
    // The migration narrows the SET NULL to `phrase_id` alone, which the
    // organization column, being required, could not take.
    phraseFk: foreignKey({
      columns: [t.organizationId, t.phraseId],
      foreignColumns: [searches.organizationId, searches.id],
      name: "lead_signals_org_phrase_fk",
    }).onDelete("set null"),
    // And likewise to `lead_id`.
    leadFk: foreignKey({
      columns: [t.organizationId, t.leadId],
      foreignColumns: [leads.organizationId, leads.id],
      name: "lead_signals_org_lead_fk",
    }).onDelete("set null"),
    leadIdx: index("lead_signals_org_lead_idx").on(t.organizationId, t.leadId),
    values: check(
      "lead_signals_values_check",
      sql`${t.personKey} ~ '^[pm][.]'
        and ${t.kind} in ('post', 'comment') and (${t.kind} = 'comment') = (${t.commentUrn} is not null)
        and (${t.languageType} is null or ${t.languageType} in ('pain', 'desired_outcome', 'failed_alternative', 'comparison', 'direct_ask'))
        and ${t.verdict} in ('pending', 'passed', 'dropped', 'expired', 'unscreenable')
        and (${t.role} is null or ${t.role} in ('buyer', 'peer', 'competitor', 'partner', 'noise'))
        and (${t.dropReason} is null or ${t.dropReason} in ('no_own_words', 'not_audience', 'selling_similar', 'already_solved', 'recruiter', 'student'))
        and (${t.verdict} = 'dropped') = (${t.dropReason} is not null)`,
    ),
    headlineFromCheck: check(
      "lead_signals_headline_from_check",
      sql`${t.headlineFrom} is null or ${t.headlineFrom} in ('search', 'comment')`,
    ),
    commentCountCheck: check(
      "lead_signals_comment_count_check",
      sql`${t.commentCount} is null or ${t.commentCount} >= 0`,
    ),
    anglesCheck: check(
      "lead_signals_angles_check",
      sql`${t.angles} is null or (jsonb_typeof(${t.angles}) = 'array' and jsonb_array_length(${t.angles}) <= 2)`,
    ),
  }),
);

export type LeadSignalRow = typeof leadSignals.$inferSelect;

/**
 * The owner's answer to "Is this right?" on a person Scout judged: one row per
 * lead, a second answer replacing the first (core's `leads/rating.ts`). It is
 * what the next run learns from: the campaign whose qualify call takes it as
 * an example, the search row that found the person's newest words, whose
 * counts it moved from what Scout said to what the owner said, and the role
 * Scout had given them, which A peer overwrites on the lead and a later answer
 * puts back. `leads.rating` and `rated_at` carry the same answer for the lead's
 * own reads. Holds no name and no words: an example reads the person's words
 * where they are kept, so a person erased teaches nothing.
 */
export const leadRatings = pgTable(
  "lead_ratings",
  {
    organizationId: orgId(),
    leadId: integer("lead_id").notNull(),
    campaignId: bigint("campaign_id", { mode: "number" }),
    verdict: text("verdict", { enum: LEAD_RATINGS }).notNull(),
    phraseId: bigint("phrase_id", { mode: "number" }),
    scoutRole: text("scout_role", { enum: LEAD_ROLES }).notNull(),
    ratedAt: bigint("rated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.leadId] }),
    campaignIdx: index("lead_ratings_org_campaign_rated_idx").on(t.organizationId, t.campaignId, t.ratedAt),
    leadFk: foreignKey({
      columns: [t.organizationId, t.leadId],
      foreignColumns: [leads.organizationId, leads.id],
      name: "lead_ratings_org_lead_fk",
    }).onDelete("cascade"),
    // The migration narrows each SET NULL to the column it names, which the
    // organization column, being required, could not take.
    campaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "lead_ratings_org_campaign_fk",
    }).onDelete("set null"),
    phraseFk: foreignKey({
      columns: [t.organizationId, t.phraseId],
      foreignColumns: [searches.organizationId, searches.id],
      name: "lead_ratings_org_phrase_fk",
    }).onDelete("set null"),
    values: check(
      "lead_ratings_values_check",
      sql`${t.verdict} in ('right_person', 'a_peer', 'not_a_fit', 'wrong_intent')
        and ${t.scoutRole} in ('buyer', 'peer', 'competitor', 'partner', 'noise')`,
    ),
  }),
);

export type LeadRatingRow = typeof leadRatings.$inferSelect;

/**
 * When Find leads last read a post's thread for a campaign, so a thread is not
 * read again inside its window (core's `leads/scout/sweep.ts`). Find posts keeps
 * the time on a candidate's research row; a thread read for a person has no
 * candidate. Holds a post urn and a time, never a name or any words.
 */
export const leadThreadReads = pgTable(
  "lead_thread_reads",
  {
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    postUrn: text("post_urn").notNull(),
    readAt: bigint("read_at", { mode: "number" }).notNull(),
    /** The pass that opened this thread, for the map plan that settles it. */
    runId: bigint("run_id", { mode: "number" }),
    /** A company page whose post held the thread, never a lead or signal. */
    authorCompanyRef: text("author_company_ref"),
    authorCompanyName: text("author_company_name"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.campaignId, t.postUrn] }),
    campaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "lead_thread_reads_org_campaign_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Every source a Find leads pass read, including a source whose pages yielded
 * no words. The plan settles the receipt belonging to its pass, rather than a
 * mutable map timestamp another sweep can replace.
 */
export const leadSourceReads = pgTable(
  "lead_source_reads",
  {
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    phraseId: bigint("phrase_id", { mode: "number" }).notNull(),
    readAt: bigint("read_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.campaignId, t.runId, t.phraseId] }),
    campaignFk: foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
      name: "lead_source_reads_org_campaign_fk",
    }).onDelete("cascade"),
    phraseFk: foreignKey({
      columns: [t.organizationId, t.phraseId],
      foreignColumns: [searches.organizationId, searches.id],
      name: "lead_source_reads_org_phrase_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * The company pages Deep read for its leads (US-LMF-02): one row a page, so
 * one read answers every person at that company for 14 days
 * (`PROFILE_READ_TTL_MS`), and a later read replaces it. Each read spent one
 * of the account's daily profile reads. The page's own public data, LinkedIn
 * text held as data, and never a person's.
 */
export const companyReads = pgTable(
  "company_reads",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    companyRef: text("company_ref").notNull(),
    read: jsonb("read").$type<CompanyPageReadJson>().notNull(),
    readAt: bigint("read_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    orgCompanyUnq: uniqueIndex("company_reads_org_company_ref_unq").on(t.organizationId, t.companyRef),
  }),
);

export type CompanyReadRow = typeof companyReads.$inferSelect;

export const LEAD_BACKTEST_STATUSES = ["queued", "running", "done", "failed"] as const;
export type LeadBacktestStatus = (typeof LEAD_BACKTEST_STATUSES)[number];

/** Where a backtest's people came to, and where the owner's comments went:
 *  counts the server wrote, never a model's tally and never a name or a word.
 *  Core's `leads/backtest.ts` writes it. */
export type LeadBacktestCounts = {
  /** People judged, and of them those Qualify judged on a profile read
   *  Engager already held and everyone else, judged on their words and
   *  headline; `leftOver` is everyone past the 200. */
  judged: number;
  researched: number;
  unresearched: number;
  leftOver: number;
  buyers: { asking: number; hasProblem: number; topicOnly: number };
  /** Of those buyers, the ones judged on a profile read. */
  buyersResearched: { asking: number; hasProblem: number; topicOnly: number };
  peers: number;
  competitors: number;
  partners: number;
  notFit: number;
  /** Words the screen dropped for a reason other than selling what the owner
   *  sells (peers and competitors are counted as such), and verdicts that
   *  could not be judged. */
  screenedOut: { noOwnWords: number; notAudience: number; alreadySolved: number; recruiter: number; student: number };
  unjudged: number;
  /** The owner's comments posted in the window, by where they went. */
  comments: {
    total: number;
    asking: number;
    hasProblem: number;
    topicOnly: number;
    peers: number;
    competitors: number;
    partners: number;
    notFit: number;
    screenedOut: number;
    notJudged: number;
  };
};

/**
 * Whether the owner has opened a person since they last answered, and whether
 * they filed them away: one row per person, keyed as everywhere
 * (`p.<profileId>`, or `m.<id>` where no profile is known). Opening someone
 * sets `read_at`; Archive sets `archived_at`; both read against the person's
 * newest engaged-back event (core's `people/reads.ts`), so a new answer
 * makes them unread, and brings them back, with nothing written here. Not
 * `inbox_reads`, which records each attempt to read the account's inbox.
 * Holds a key and two times, never a name or any words.
 */
export const personReads = pgTable(
  "person_reads",
  {
    organizationId: orgId(),
    personKey: text("person_key").notNull(),
    readAt: bigint("read_at", { mode: "number" }),
    archivedAt: bigint("archived_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.personKey] }),
    keyShape: check("person_reads_person_key_check", sql`${t.personKey} ~ '^[pm][.]'`),
  }),
);

export type PersonReadRow = typeof personReads.$inferSelect;

/** Whether work on the conversation may run — a separate column from the
 *  relationship and from every fact, so none of them is derived from it. */
export const CONVERSATION_OPS_STATUSES = [
  "runnable",
  "awaiting_review",
  "paused",
  "human_owned",
  "blocked",
  "uncertain",
] as const;
export type ConversationOpsStatus = (typeof CONVERSATION_OPS_STATUSES)[number];

/** The summary `deriveStage` writes from the other columns; it never feeds
 *  back into them. */
export const CONVERSATION_STAGES = [
  "engaged",
  "connected",
  "conversing",
  "interested",
  "cta_offered",
  "booked",
  "activated",
  "paid",
  "closed",
] as const;
export type ConversationStage = (typeof CONVERSATION_STAGES)[number];

/** Spec §18 R15: the conversion facts, each its own event. A CTA offered, a
 *  booking, an activation and a payment are four facts — a link click is not
 *  a booking, an acceptance not an activation, a warm DM not a payment — and
 *  a cancellation or a refund is a reversal that supersedes one. */
export const OUTCOME_TYPES = [
  "cta_offered",
  "booked",
  "activated",
  "paid",
  "cancelled",
  "refunded",
] as const;
export type OutcomeType = (typeof OUTCOME_TYPES)[number];

/** The outcomes that make a person a conversion, in the order a conversation
 *  advances through them. */
export const CONVERSION_OUTCOMES = ["booked", "activated", "paid"] as const;
export type ConversionOutcome = (typeof CONVERSION_OUTCOMES)[number];

/** Where an outcome came from. `provider` is the arm a real integration would
 *  fill; none is configured (spec §20). */
export const OUTCOME_SOURCE_TYPES = [
  "owner_attestation",
  "imported_receipt",
  "provider",
] as const;
export type OutcomeSourceType = (typeof OUTCOME_SOURCE_TYPES)[number];

/** How far an outcome is verified — one per source, never merged in a count. */
export const OUTCOME_VERIFICATION_STATUSES = [
  "user_confirmed",
  "receipt_reviewed",
  "provider_verified",
] as const;
export type OutcomeVerificationStatus =
  (typeof OUTCOME_VERIFICATION_STATUSES)[number];

/** How an outcome was joined to a person: the owner named the conversation, or a
 *  consented stable identifier the person gave matched exactly one. Anything
 *  else is `unknown` and attaches to no conversation. */
export const OUTCOME_ATTRIBUTION_METHODS = [
  "user_confirmed",
  "consented_identifier",
  "unknown",
] as const;
export type OutcomeAttributionMethod =
  (typeof OUTCOME_ATTRIBUTION_METHODS)[number];

/** What an outcome's free text may never carry: a LinkedIn address or urn, or
 *  a member id (spec §18: no private LinkedIn identity in URLs). The same
 *  patterns back core's refusal and the table's CHECK, in syntax JavaScript
 *  and PostgreSQL read alike. */
export const LINKEDIN_IDENTITY_PATTERNS = {
  /** Matched case-insensitively. */
  address: "linkedin\\.[a-z]|lnkd\\.in|urn:li:",
  /** Matched case-sensitively: the member ids LinkedIn's urns carry. */
  memberId: "ACoA[A-Za-z0-9_-]{8,}",
} as const;

/** A closed conversation stays closed: only an explicit reopening by the owner
 *  starts the person over, and no later event can. `reopened` is that
 *  reopening's own close — the conversation it ended, kept beside the new one. */
export const CONVERSATION_CLOSED_REASONS = ["opt_out", "manual_exclude", "reopened"] as const;
export type ConversationClosedReason = (typeof CONVERSATION_CLOSED_REASONS)[number];

/** Spec §18: what a row is kept for. `content` holds a person's words and
 *  lapses after the strategy's `content_days`; `audit` is a decision's trail
 *  and lapses after `audit_days`; `suppression` keeps an opt-out for as long
 *  as it binds. `expires_at` is stamped from them; nothing sweeps yet. */
export const RETENTION_CLASSES = ["content", "audit", "suppression"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Spec §11's R08 event names, a read of the person's relationship, and the
 *  decisions a source or a person can draw on their own. */
export const CONVERSATION_EVENT_TYPES = [
  "room_member_spotted",
  "comment_published",
  "reply_observed",
  "reply_edited",
  "action_candidate_created",
  "like_confirmed",
  "invitation_confirmed",
  "relationship_observed",
  "invitation_accepted",
  "incoming_invitation_observed",
  "inbound_message_observed",
  "dm_confirmed",
  "followup_due",
  "booking_verified",
  "activation_verified",
  "payment_verified",
  "delivery_unknown",
  "source_skipped",
  "opt_out",
  "manual_exclude",
  "warning",
  // The owner started the person over: the conversation it closes and the one it
  // opens each carry it (`conversations/reopen.ts`).
  "person_reopened",
  // The owner handed back a conversation the inbox list held for them: from
  // the next read Engager handles it like any (`conversations/dm.ts`).
  "dm_handed_back",
  // The owner withdrew our pending invitation, confirmed by a read of the
  // person showing nothing pending (`actions/withdrawInvite.ts`).
  "invitation_withdrawn",
  // A read of the person found our invitation no longer pending — their
  // switch back on Connect, or Withdrawn — without an acceptance or our own
  // withdrawal: withdrawn, or expired (`conversations/record.ts`).
  "invitation_gone",
  // Their acceptance came, and a read of the conversation showed our
  // invitation's note already there as the account's first message: LinkedIn
  // carried it (`jobs/handlers/inviteNoteCheck.ts`).
  "invite_note_carried",
  // A message the account sent in the conversation that is not one of
  // Engager's own DMs: the owner wrote it on LinkedIn, and a read of the
  // conversation saw it (`conversations/record.ts` `recordOwnerMessage`).
  "owner_message_observed",
  // Scout served a lead to the Ambassador's steps (lead mode): the event
  // Comment on posts, Meet the room and Connect can start on. Nothing writes
  // it yet.
  "lead_served",
] as const;
export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

export const CONVERSATION_EVENT_SOURCES = [
  "room",
  "our_comment_thread",
  "own_post",
  "profile",
  "dm",
  "invitation",
  "outcome",
  "owner",
  // Scout served a lead (`lead_served`): lead mode's own source, beside the
  // room's.
  "find_leads",
] as const;
export type ConversationEventSource = (typeof CONVERSATION_EVENT_SOURCES)[number];

/** Where on the network an event happened. */
export type ConversationSourceRef = {
  /** The server-selected room opportunity, independent of prompt wording. */
  room?: RoomWorkBinding;
  /** The lead Scout served and the signal of theirs the opener answers: the
   *  one behind their intent quote, else their newest. */
  lead?: { leadId: number; signalId: number; runId?: number };
  postUrn?: string;
  /** The person's comment or reply. */
  commentUrn?: string;
  /** The comment of ours it answers. */
  parentUrn?: string;
  /** Our message row the thread hangs on. */
  messageId?: number;
  incomingCommentId?: number;
  /** The person's profile page a relationship was read from. */
  profileUrl?: string;
  /** The direct-message conversation a message came in on: our `dm_threads`
   *  row and the provider's id for the thread. */
  dmThreadId?: number;
  threadId?: string;
  /** The event a derived decision (`source_skipped`, `opt_out`,
   *  `invitation_accepted`) was drawn from. */
  eventId?: number;
  /** The invitation the person sent this account, as its invitations page
   *  names it (`incoming_invitations.invitation_id`). */
  invitationId?: string;
  /** The ledger row whose settled receipt an `invitation_confirmed` is. */
  actionExecutionId?: number;
  /** The outcome row a verified outcome's event (`booking_verified`,
   *  `activation_verified`, `payment_verified`) is the echo of. */
  outcomeEventId?: number;
  /** A reopening's other conversation: the one it closed, on the conversation it
   *  opened, and the one it opened, on the conversation it closed. */
  conversationId?: number;
};

export type RoomWorkBinding = {
  evidenceHash: string;
  target: RoomSourcedReplyTarget;
  campaignId: number;
  channelId: number;
  stepId: string;
  strategyVersion: number;
  painId: string;
};

/** How the person behind an event was identified. Account-scoped provider
 *  evidence only: a display name or a coincidence of timing never joins. */
export type ConversationAttribution = {
  /** `verified_exchange`: an invitation whose sender is, by provider id, the
   *  author of a reply this conversation recorded. `user_confirmed_link`: the owner
   *  said which reply's author sent it. `dm_read`: a read of the person's
   *  direct-message thread, which named them by id. `owner`: the owner's own
   *  word, about the person this conversation already is. */
  method:
    | "thread_read"
    | "relationship_read"
    | "dm_read"
    | "derived"
    | "verified_exchange"
    | "user_confirmed_link"
    | "owner";
  /** The provider's id for the person, as this account's read showed it. */
  profileId: string;
  /** The thread read placed the reply directly under our comment. */
  directReply?: boolean;
  parentMessageId?: number;
  commentWatchId?: number | null;
  /** The account whose session made the relationship or conversation read. */
  channelId?: number;
  /** The relationship read itself, as the account's session returned it. */
  read?: RelationshipReadJson;
  /** The reply event an invitation is attributed to. */
  replyEventId?: number;
  /** The invitation's sender as its invitations page named them — the person
   *  the owner's link says wrote `replyEventId`. */
  senderProfileId?: string;
  /** Who confirmed a `user_confirmed_link`, and when. */
  confirmedBy?: string;
  confirmedAt?: number;
  /** `agent`: the read was the agent reader's, verified against the page by
   *  the server. Absent: the connector's own parser read it. */
  reader?: "agent";
};

/** A run of the event's `content`, `[start, end)`, that a classification
 *  quoted verbatim for one of its labels. */
export type ConversationEvidenceSpan = {
  start: number;
  end: number;
  label: string;
};

/** What was decided about an event, and from what. Written once, with the
 *  event; a later view of the same source is a superseding event. Core owns
 *  the shape (`packages/core/conversations/eligibility.ts`). */
export type ConversationEventDecision = Record<string, unknown>;

/**
 * One person's conversation with one account (spec §15 R11): ONE open conversation
 * per (account, provider person), owned by the campaign that started it, with
 * every public thread they answered in as a `conversation_sources` row and, from
 * Phase 52, one canonical DM thread. A second campaign reaching the same
 * person attaches a source; it never opens a second conversation.
 *
 * Relationship, operational status and the business facts (interest
 * evidence, CTA, conversion outcome) are separate columns, each written only
 * from its own kind of evidence; `derived_stage` summarizes them and is never
 * read back into them.
 * The person is `author_profiles`' identity — the provider's profile id this
 * account read — so a name alone can never join two people.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    authorProfileId: profileIdText("author_profile_id").notNull(),
    owningCampaignId: bigint("owning_campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      { onDelete: "set null" },
    ),
    /** Owner-initiated provenance; observing a room never opens a conversation. A
     *  lead served by Scout opens one too (`lead`). */
    openedFrom: text("opened_from", { enum: ["room", "lead"] }),
    openedFromPostId: bigint("opened_from_post_id", { mode: "number" }),
    /** The lead whose serving opened it; no FK, as the post has none: the
     *  conversation outlives a lead row Never engage deleted. */
    openedFromLeadId: bigint("opened_from_lead_id", { mode: "number" }),
    relationship: text("relationship", { enum: CONVERSATION_RELATIONSHIPS })
      .notNull()
      .default("unknown"),
    relationshipCheckedAt: bigint("relationship_checked_at", { mode: "number" }),
    opsStatus: text("ops_status", { enum: CONVERSATION_OPS_STATUSES })
      .notNull()
      .default("runnable"),
    /** When what set `ops_status` happened — an event's `occurred_at`. An
     *  older event never moves it. */
    opsStatusAt: bigint("ops_status_at", { mode: "number" }),
    derivedStage: text("derived_stage", { enum: CONVERSATION_STAGES })
      .notNull()
      .default("engaged"),
    /** The event whose quoted words show explicit interest — a row of this
     *  conversation's own log, written in the transaction that appends it. No FK:
     *  it would make conversations ↔ conversation_events a second foreign-key cycle,
     *  and an org transfer writes exactly one
     *  (`copy-org.ts#topologicalOrder`). */
    interestEvidenceEventId: bigint("interest_evidence_event_id", {
      mode: "number",
    }),
    /** The standing `cta_offered` outcome event, and the most advanced
     *  standing conversion with the event that shows it — projected from
     *  `outcome_events` by core's `projectConversationOutcomes` whenever one of the
     *  conversation's outcomes is appended. No FK, for the cycle reason above. */
    ctaEventId: bigint("cta_event_id", { mode: "number" }),
    outcome: text("outcome", { enum: CONVERSION_OUTCOMES }),
    outcomeEventId: bigint("outcome_event_id", { mode: "number" }),
    /** The person's one DM thread with this account — the `dm_threads` row
     *  bound to this conversation, written in the transaction that binds it. No
     *  FK, for the cycle reason above: that row names this one. */
    canonicalDmThreadId: bigint("canonical_dm_thread_id", { mode: "number" }),
    closedReason: text("closed_reason", { enum: CONVERSATION_CLOSED_REASONS }),
    closedAt: bigint("closed_at", { mode: "number" }),
    retentionClass: text("retention_class", { enum: RETENTION_CLASSES })
      .notNull()
      .default("audit"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("conversations_org_id_key").on(t.organizationId, t.id),
    /** One open conversation per account and person; a closed one keeps the
     *  history and refuses nothing. */
    openPersonUnq: uniqueIndex("conversations_open_person_unq")
      .on(t.organizationId, t.channelId, t.authorProfileId)
      .where(sql`${t.closedReason} is null`),
    orgPersonIdx: index("conversations_org_person_idx").on(
      t.organizationId,
      t.authorProfileId,
      t.updatedAt,
    ),
    // Same-org composite FKs, for the reason `campaigns_org_channel_fk`
    // gives. NO ACTION: a person's history refuses the delete of the account
    // or the identity it hangs on rather than vanish with it.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "conversations_org_channel_fk",
    }).onDelete("no action"),
    orgPersonFk: foreignKey({
      columns: [t.organizationId, t.authorProfileId],
      foreignColumns: [authorProfiles.organizationId, authorProfiles.profileId],
      name: "conversations_org_person_fk",
    }).onDelete("no action"),
    relationshipCheck: check(
      "conversations_relationship_check",
      sql`${t.relationship} in ('unknown', 'not_connected', 'outgoing_pending', 'incoming_pending', 'connected')`,
    ),
    opsStatusCheck: check(
      "conversations_ops_status_check",
      sql`${t.opsStatus} in ('runnable', 'awaiting_review', 'paused', 'human_owned', 'blocked', 'uncertain')`,
    ),
    derivedStageCheck: check(
      "conversations_derived_stage_check",
      sql`${t.derivedStage} in ('engaged', 'connected', 'conversing', 'interested', 'cta_offered', 'booked', 'activated', 'paid', 'closed')`,
    ),
    outcomeCheck: check(
      "conversations_outcome_check",
      sql`(${t.outcome} is null and ${t.outcomeEventId} is null) or (${t.outcome} in ('booked', 'activated', 'paid') and ${t.outcomeEventId} is not null)`,
    ),
    closedCheck: check(
      "conversations_closed_check",
      sql`(${t.closedReason} is null and ${t.closedAt} is null) or (${t.closedReason} in ('opt_out', 'manual_exclude', 'reopened') and ${t.closedAt} is not null)`,
    ),
    retentionCheck: check(
      "conversations_retention_check",
      sql`${t.retentionClass} in ('audit', 'suppression')`,
    ),
  }),
);

export type ConversationRow = typeof conversations.$inferSelect;

/**
 * The append-only log of a conversation (spec §15 R11's observation event and its
 * decision): what happened, when it happened (`occurred_at`) and when this
 * account saw it (`observed_at`), the provider's id for it or a stable digest,
 * a hash of its words, how the person was identified, the spans of those
 * words a classification rests on, and the decision drawn — all written once.
 * No row is updated: a correction or a later revision of the same reply is a
 * new row that names the one it supersedes, and the table's RLS family grants
 * no UPDATE.
 *
 * `content` is the person's words verbatim: untrusted data, which reaches a
 * model prompt only through core's `delimited` rendering.
 */
export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    conversationId: bigint("conversation_id", { mode: "number" }).notNull(),
    type: text("type", { enum: CONVERSATION_EVENT_TYPES }).notNull(),
    source: text("source", { enum: CONVERSATION_EVENT_SOURCES }).notNull(),
    sourceRef: jsonb("source_ref").$type<ConversationSourceRef>().notNull(),
    providerEventId: text("provider_event_id"),
    digest: text("digest").notNull(),
    content: text("content"),
    /** SHA-256 hex of `content`. */
    contentHash: text("content_hash"),
    revision: integer("revision").notNull().default(1),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    /** The provider's paging cursor, where the source has one. A thread read
     *  has none. */
    cursor: text("cursor"),
    attribution: jsonb("attribution").$type<ConversationAttribution>().notNull(),
    evidenceSpans: jsonb("evidence_spans")
      .$type<ConversationEvidenceSpan[]>()
      .notNull()
      .default([]),
    decision: jsonb("decision").$type<ConversationEventDecision>(),
    /** The one reading of a direct message's words (`IncomingReading`); null
     *  on any other event, and on a message recorded unread. */
    reading: jsonb("reading").$type<IncomingReading>(),
    supersedesEventId: bigint("supersedes_event_id", { mode: "number" }),
    retentionClass: text("retention_class", { enum: RETENTION_CLASSES }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("conversation_events_org_id_key").on(t.organizationId, t.id),
    /** The same provider event twice is one row. */
    providerEventUnq: uniqueIndex("conversation_events_provider_event_unq")
      .on(t.conversationId, t.providerEventId)
      .where(sql`${t.providerEventId} is not null`),
    digestUnq: unique("conversation_events_digest_key").on(t.conversationId, t.digest),
    conversationOccurredIdx: index("conversation_events_conversation_occurred_idx").on(
      t.organizationId,
      t.conversationId,
      t.occurredAt,
    ),
    conversationFk: foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
      name: "conversation_events_org_conversation_fk",
    }).onDelete("cascade"),
    supersedesFk: foreignKey({
      columns: [t.organizationId, t.supersedesEventId],
      foreignColumns: [t.organizationId, t.id],
      name: "conversation_events_org_supersedes_fk",
    }).onDelete("no action"),
    contentHashCheck: check(
      "conversation_events_content_hash_check",
      sql`(${t.content} is null) = (${t.contentHash} is null)`,
    ),
    revisionCheck: check(
      "conversation_events_revision_check",
      sql`${t.revision} >= 1`,
    ),
    retentionCheck: check(
      "conversation_events_retention_check",
      sql`${t.retentionClass} in ('content', 'audit', 'suppression')`,
    ),
  }),
);

export type ConversationEventRow = typeof conversationEvents.$inferSelect;

/**
 * The public threads a conversation runs through: one row per reply the person
 * left under one of our comments, naming the campaign whose comment it
 * answered. A reply its author deleted, or that went with our comment, keeps
 * its row with `deleted_at` — the tombstone a decision already drawn from it
 * still points at.
 */
export const conversationSources = pgTable(
  "conversation_sources",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    conversationId: bigint("conversation_id", { mode: "number" }).notNull(),
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      { onDelete: "set null" },
    ),
    /** A single-column FK: the `(organization_id, id)` key on
     *  `incoming_comments` is built by `concurrent-indexes.ts` after the
     *  migrations run, so no migration can reference it. */
    incomingCommentId: bigint("incoming_comment_id", { mode: "number" })
      .notNull()
      .references(() => incomingComments.id, { onDelete: "cascade" }),
    commentWatchId: bigint("comment_watch_id", { mode: "number" }).references(
      () => commentWatches.id,
      { onDelete: "set null" },
    ),
    /** The reply's urn. */
    sourceRef: text("source_ref").notNull(),
    deletedAt: bigint("deleted_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    /** A reply belongs to exactly one conversation. */
    orgIncomingUnq: unique("conversation_sources_org_incoming_key").on(
      t.organizationId,
      t.incomingCommentId,
    ),
    orgConversationIdx: index("conversation_sources_org_conversation_idx").on(
      t.organizationId,
      t.conversationId,
    ),
    conversationFk: foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
      name: "conversation_sources_org_conversation_fk",
    }).onDelete("cascade"),
  }),
);

export type ConversationSourceRow = typeof conversationSources.$inferSelect;

/**
 * How an incoming invitation was tied to a conversation (spec §15: "verified
 * identity plus an explicit exchange reference or user-confirmed link").
 * `verified_exchange`: the sender is, by provider id, the author of a reply a
 * conversation on this account recorded. `user_confirmed_link`: the owner said
 * which reply's author sent it. `unmatched`: neither — a name or a timing
 * alone never links.
 */
export const INVITATION_ATTRIBUTIONS = [
  "verified_exchange",
  "user_confirmed_link",
  "unmatched",
] as const;
export type InvitationAttribution = (typeof INVITATION_ATTRIBUTIONS)[number];

/** Where an incoming invitation stands as Engager last saw it. `gone`: a
 *  complete read of the invitations page no longer shows it — accepted,
 *  ignored or withdrawn on LinkedIn. `dismissed`: the owner hid it here; the
 *  request itself stays on LinkedIn. */
export const INCOMING_INVITATION_STATUSES = [
  "pending",
  "accepted",
  "gone",
  "dismissed",
] as const;
export type IncomingInvitationStatus =
  (typeof INCOMING_INVITATION_STATUSES)[number];

/** The evidence an attribution rests on. An unmatched invitation names the
 *  conversations whose replier shares the sender's display name — a hint for the
 *  owner's own link, never a link. */
export type InvitationAttributionEvidence =
  | {
      method: "verified_exchange";
      profileId: string;
      conversationId: number;
      replyEventId: number;
    }
  | {
      method: "user_confirmed_link";
      profileId: string;
      conversationId: number;
      /** The reply the owner said its sender wrote; null for a request they
       *  accepted from someone with no reply to name. */
      replyEventId: number | null;
      confirmedBy: string;
      confirmedAt: number;
    }
  | { method: "unmatched"; nameMatches: number[] };

/**
 * The invitations people sent this account, as its invitations page showed
 * them (spec §10 R05 "incoming invitation with verified comment link", §11
 * `IncomingInvitationObserved`). One row per invitation per account, kept
 * current by each read: the sender as the page names them — the provider's
 * id, never a name, is the identity — their note verbatim (untrusted data),
 * and how the invitation was attributed. An attributed row names the conversation
 * of the person whose reply it is tied to, and the conversation event that
 * recorded it there; an unmatched one names none and is acted on by nothing.
 *
 * Exists only for accounts a campaign running on its strategy reads.
 */
export const incomingInvitations = pgTable(
  "incoming_invitations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    /** LinkedIn's invitation urn where the page carries one; else the
     *  sender-scoped id the sidecar mints — the account holds at most one
     *  pending invitation from one member. */
    invitationId: text("invitation_id").notNull(),
    senderProfileId: profileIdText("sender_profile_id").notNull(),
    senderUrl: text("sender_url").notNull(),
    senderDisplayName: text("sender_display_name"),
    /** The sender's note, verbatim. Untrusted: data, never instructions. */
    note: text("note"),
    /** When the page dates it, where it does. */
    receivedAt: bigint("received_at", { mode: "number" }),
    firstObservedAt: bigint("first_observed_at", { mode: "number" }).notNull(),
    /** The latest read that showed it. */
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    status: text("status", { enum: INCOMING_INVITATION_STATUSES })
      .notNull()
      .default("pending"),
    statusAt: bigint("status_at", { mode: "number" }).notNull(),
    attribution: text("attribution", { enum: INVITATION_ATTRIBUTIONS })
      .notNull()
      .default("unmatched"),
    attributionEvidence: jsonb("attribution_evidence")
      .$type<InvitationAttributionEvidence>()
      .notNull(),
    conversationId: bigint("conversation_id", { mode: "number" }),
    /** The `incoming_invitation_observed` event on that conversation. */
    conversationEventId: bigint("conversation_event_id", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("incoming_invitations_org_id_key").on(
      t.organizationId,
      t.id,
    ),
    /** The same invitation read twice is one row. */
    invitationUnq: unique("incoming_invitations_org_channel_invitation_key").on(
      t.organizationId,
      t.channelId,
      t.invitationId,
    ),
    orgChannelStatusIdx: index("incoming_invitations_org_channel_status_idx").on(
      t.organizationId,
      t.channelId,
      t.status,
      t.observedAt,
    ),
    // Same-org composite FKs. NO ACTION: an invitation's attribution refuses
    // the delete of the account, conversation or event it rests on.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "incoming_invitations_org_channel_fk",
    }).onDelete("no action"),
    orgConversationFk: foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
      name: "incoming_invitations_org_conversation_fk",
    }).onDelete("no action"),
    orgEventFk: foreignKey({
      columns: [t.organizationId, t.conversationEventId],
      foreignColumns: [conversationEvents.organizationId, conversationEvents.id],
      name: "incoming_invitations_org_event_fk",
    }).onDelete("no action"),
    statusCheck: check(
      "incoming_invitations_status_check",
      sql`${t.status} in ('pending', 'accepted', 'gone', 'dismissed')`,
    ),
    /** An attributed invitation names its conversation and the event that
     *  recorded it there; an unmatched one names neither. */
    attributionCheck: check(
      "incoming_invitations_attribution_check",
      sql`(${t.attribution} = 'unmatched' and ${t.conversationId} is null and ${t.conversationEventId} is null) or (${t.attribution} in ('verified_exchange', 'user_confirmed_link') and ${t.conversationId} is not null and ${t.conversationEventId} is not null)`,
    ),
  }),
);

export type IncomingInvitationRow = typeof incomingInvitations.$inferSelect;

/**
 * Conversion evidence (spec §18 R15): one row per fact — a CTA offered, a
 * booking, an activation, a payment — or per reversal of one, each with the
 * source it came from and how far it is verified. The three verification
 * states stay distinct: an owner's word is `user_confirmed`, a receipt the
 * owner imported is `receipt_reviewed`, and `provider_verified` belongs to an
 * integration that does not exist yet. Nothing infers a row from a message,
 * a click or an acceptance.
 *
 * Append-only, like `conversation_events`: a correction, a cancellation or a
 * refund is a new row naming the one it supersedes, each row is superseded
 * at most once — so a chain has one head, and a booked → cancelled →
 * re-booked person counts once — and the table's RLS family grants no UPDATE.
 * `(source_type, source_event_id)` is the dedup key per org: the same receipt
 * row imported twice is one event.
 *
 * A row names a conversation only when the person is known — the owner said who,
 * or a consented identifier matched exactly one conversation; an ambiguous join
 * stays `unknown`, on the account and no conversation. `customer_ref_hash` is that
 * identifier hashed with the org, never the identifier.
 */
export const outcomeEvents = pgTable(
  "outcome_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    authorProfileId: profileIdText("author_profile_id"),
    conversationId: bigint("conversation_id", { mode: "number" }),
    type: text("type", { enum: OUTCOME_TYPES }).notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    sourceType: text("source_type", { enum: OUTCOME_SOURCE_TYPES }).notNull(),
    sourceEventId: text("source_event_id").notNull(),
    /** A local file, a receipt reference or the redacted hash of an imported
     *  receipt row. Never a LinkedIn identity (the CHECK below). */
    evidenceRef: text("evidence_ref"),
    verificationStatus: text("verification_status", {
      enum: OUTCOME_VERIFICATION_STATUSES,
    }).notNull(),
    attributionMethod: text("attribution_method", {
      enum: OUTCOME_ATTRIBUTION_METHODS,
    }).notNull(),
    customerRefHash: text("customer_ref_hash"),
    /** The owner's own words on an attestation. */
    note: text("note"),
    supersedesEventId: bigint("supersedes_event_id", { mode: "number" }),
    /** Who wrote the row — `mcp:<key>` for a tool call. */
    recordedBy: text("recorded_by").notNull(),
    retentionClass: text("retention_class", { enum: RETENTION_CLASSES })
      .notNull()
      .default("audit"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("outcome_events_org_id_key").on(t.organizationId, t.id),
    /** The same source event twice is one row. */
    sourceUnq: unique("outcome_events_org_source_key").on(
      t.organizationId,
      t.sourceType,
      t.sourceEventId,
    ),
    /** A row is superseded at most once: every chain has exactly one head. */
    supersedesUnq: uniqueIndex("outcome_events_org_supersedes_unq")
      .on(t.organizationId, t.supersedesEventId)
      .where(sql`${t.supersedesEventId} is not null`),
    orgConversationIdx: index("outcome_events_org_conversation_idx")
      .on(t.organizationId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
    orgChannelOccurredIdx: index("outcome_events_org_channel_occurred_idx").on(
      t.organizationId,
      t.channelId,
      t.occurredAt,
    ),
    orgCustomerIdx: index("outcome_events_org_customer_idx")
      .on(t.organizationId, t.customerRefHash)
      .where(sql`${t.customerRefHash} is not null`),
    // Same-org composite FKs. NO ACTION: conversion evidence refuses the
    // delete of the account, conversation or identity it hangs on.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "outcome_events_org_channel_fk",
    }).onDelete("no action"),
    orgConversationFk: foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
      name: "outcome_events_org_conversation_fk",
    }).onDelete("no action"),
    orgPersonFk: foreignKey({
      columns: [t.organizationId, t.authorProfileId],
      foreignColumns: [authorProfiles.organizationId, authorProfiles.profileId],
      name: "outcome_events_org_person_fk",
    }).onDelete("no action"),
    supersedesFk: foreignKey({
      columns: [t.organizationId, t.supersedesEventId],
      foreignColumns: [t.organizationId, t.id],
      name: "outcome_events_org_supersedes_fk",
    }).onDelete("no action"),
    typeCheck: check(
      "outcome_events_type_check",
      sql`${t.type} in ('cta_offered', 'booked', 'activated', 'paid', 'cancelled', 'refunded')`,
    ),
    /** Each source verifies exactly as far as it can: an attestation is the
     *  owner's word, an imported receipt was reviewed, only a provider
     *  verifies. */
    verificationCheck: check(
      "outcome_events_verification_check",
      sql`(${t.sourceType} = 'owner_attestation' and ${t.verificationStatus} = 'user_confirmed') or (${t.sourceType} = 'imported_receipt' and ${t.verificationStatus} = 'receipt_reviewed') or (${t.sourceType} = 'provider' and ${t.verificationStatus} = 'provider_verified')`,
    ),
    /** An attributed row names its conversation and person; an unknown one
     *  neither. */
    attributionCheck: check(
      "outcome_events_attribution_check",
      sql`(${t.attributionMethod} = 'unknown' and ${t.conversationId} is null and ${t.authorProfileId} is null) or (${t.attributionMethod} in ('user_confirmed', 'consented_identifier') and ${t.conversationId} is not null and ${t.authorProfileId} is not null)`,
    ),
    /** A reversal always names what it reverses. */
    reversalCheck: check(
      "outcome_events_reversal_check",
      sql`${t.type} not in ('cancelled', 'refunded') or ${t.supersedesEventId} is not null`,
    ),
    noLinkedInIdentityCheck: check(
      "outcome_events_no_linkedin_identity_check",
      sql`(${t.sourceEventId} || ' ' || coalesce(${t.evidenceRef}, '') || ' ' || coalesce(${t.note}, '')) !~* ${sql.raw(`'${LINKEDIN_IDENTITY_PATTERNS.address}'`)} and (${t.sourceEventId} || ' ' || coalesce(${t.evidenceRef}, '') || ' ' || coalesce(${t.note}, '')) !~ ${sql.raw(`'${LINKEDIN_IDENTITY_PATTERNS.memberId}'`)}`,
    ),
    retentionCheck: check(
      "outcome_events_retention_check",
      sql`${t.retentionClass} = 'audit'`,
    ),
  }),
);

export type OutcomeEventRow = typeof outcomeEvents.$inferSelect;

/** A person in a direct-message conversation, as a page of the account's own
 *  showed them. `profileId` is null where the page names them without linking
 *  their profile — a group's header, an inbox card — and is never filled in
 *  from a name. `memberUrn` is their own identity on LinkedIn
 *  (`urn:li:fsd_profile:…`), where LinkedIn's conversation data names it: that
 *  data links a member by it alone, so it carries no profile id until a page
 *  read of the same conversation shows whose profile it is, and the thread
 *  keeps the pair. Same ownership as {@link RelationshipReadJson}: the
 *  driver's DM reads return this shape. */
export type DmParticipantJson = {
  profileId: string | null;
  profileUrl: string | null;
  displayName: string;
  memberUrn?: string;
};

/**
 * Where a conversation the inbox showed beside a conversation's person stands:
 * `bound` is the conversation's canonical thread; `group` and `unmatched` are never
 * handled — a group conversation, or one a read could not verify as the
 * account and that person alone.
 */
export const DM_THREAD_BINDINGS = ["bound", "group", "unmatched"] as const;
export type DmThreadBinding = (typeof DM_THREAD_BINDINGS)[number];

/**
 * A conversation's direct-message conversation (spec §15 R11: one canonical DM
 * thread per conversation, and DMs are never stuffed into public comments). A
 * `bound` row is the thread a read verified as exactly the account and the
 * conversation's person, by profile id — or one the inbox list showed the owner
 * having with someone Engager knows by member urn, held for the owner
 * (`owner_held_at`, `conversations/dm.ts`) — and `conversations.canonical_dm_thread_id`
 * names it. A `group` or `unmatched` row is a conversation the inbox showed
 * beside one of those people that nothing handles; it is kept so it is listed
 * as the owner's and not read again until it moves. Every other conversation
 * in the inbox is the owner's alone and has no row.
 *
 * No words are kept here but a held conversation's: a message the person
 * sent is a `conversation_events` row, fenced as untrusted data; the inbox card is
 * a digest that says only that the conversation moved; a draft in the
 * composer is its hash. A conversation held for the owner keeps the person's
 * newest message as the list showed it, for the owner to see and for nothing
 * else to read.
 */
export const dmThreads = pgTable(
  "dm_threads",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    /** The conversation this is the canonical thread of; set exactly when
     *  `binding` is `bound`. */
    conversationId: bigint("conversation_id", { mode: "number" }),
    binding: text("binding", { enum: DM_THREAD_BINDINGS }).notNull(),
    /** Everyone in it as the latest read showed them, the account included. */
    participants: jsonb("participants")
      .$type<Array<DmParticipantJson & { isSelf: boolean }>>()
      .notNull(),
    /** The inbox card as last seen — its last message's hash, author, time and
     *  unread mark — so a thread that has not moved is not read again. */
    lastInboxDigest: text("last_inbox_digest"),
    /** The newest message the latest read showed — of the conversation's own
     *  page, or of the inbox list's last message standing for one: the tail a
     *  DM is written after. */
    lastMessageId: text("last_message_id"),
    /** The newest message the latest read of the conversation's HISTORY
     *  showed — its page, or LinkedIn's own message history for it: where a
     *  history read looks for messages the owner sent that none had shown. A
     *  list's last message never moves it — only the history shows what came
     *  before. Null: no history read yet, so one looks at every message it
     *  shows. */
    lastHistoryMessageId: text("last_history_message_id"),
    /** The latest read, of the inbox or the thread, that showed it. */
    lastObservedAt: bigint("last_observed_at", { mode: "number" }).notNull(),
    lastThreadReadAt: bigint("last_thread_read_at", { mode: "number" }),
    /** How many messages LinkedIn counts unread in it, and when its newest
     *  message was sent, as the latest inbox list showed them; null where
     *  that list did not say. A conversation the owner holds is shown by
     *  these, since nothing opens it. */
    unreadCount: integer("unread_count"),
    lastMessageAt: bigint("last_message_at", { mode: "number" }),
    /** When the inbox list held it for the owner: a conversation they have
     *  with someone Engager knows that no campaign started. Nothing opens it
     *  or reads it to a model, and no DM goes into it — the person's conversation
     *  and the public thread under our comments go on as before. */
    ownerHeldAt: bigint("owner_held_at", { mode: "number" }),
    /** The person's newest message in a held conversation, as the list showed
     *  it: its words — untrusted data, shown to the owner and read by nothing
     *  else — and when it was sent. Null on every other conversation. */
    heldMessageText: text("held_message_text"),
    heldMessageAt: bigint("held_message_at", { mode: "number" }),
    /** When a read last found words in the composer nobody had sent, and
     *  their hash: the owner releasing the conversation is not undone by the
     *  same draft read again, and a new one takes it back. */
    humanDraftSeenAt: bigint("human_draft_seen_at", { mode: "number" }),
    humanDraftHash: text("human_draft_hash"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("dm_threads_org_id_key").on(t.organizationId, t.id),
    /** One row per conversation on an account. */
    providerUnq: unique("dm_threads_org_channel_provider_key").on(
      t.organizationId,
      t.channelId,
      t.providerThreadId,
    ),
    /** One canonical thread per conversation. */
    conversationUnq: uniqueIndex("dm_threads_org_conversation_unq")
      .on(t.organizationId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
    // Same-org composite FKs. The account's: NO ACTION, for the reason
    // `conversations_org_channel_fk` gives. The conversation's: CASCADE, as its sources
    // do — the binding means nothing without it. `conversations` names this row
    // back without an FK, which would make a second cycle.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "dm_threads_org_channel_fk",
    }).onDelete("no action"),
    orgConversationFk: foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
      name: "dm_threads_org_conversation_fk",
    }).onDelete("cascade"),
    bindingCheck: check(
      "dm_threads_binding_check",
      sql`${t.binding} in ('bound', 'group', 'unmatched') and (${t.binding} = 'bound') = (${t.conversationId} is not null)`,
    ),
    draftCheck: check(
      "dm_threads_draft_check",
      sql`(${t.humanDraftSeenAt} is null) = (${t.humanDraftHash} is null)`,
    ),
  }),
);

export type DmThreadRow = typeof dmThreads.$inferSelect;

/** What one attempt to read an account's inbox came to. */
export const INBOX_READ_OUTCOMES = ["read", "refused", "failed"] as const;
export type InboxReadOutcome = (typeof INBOX_READ_OUTCOMES)[number];

/**
 * Every attempt to read an account's message inbox, kept so its coverage can
 * be told (spec §16, "Mac asleep or disconnected — show last successful
 * observation and missed coverage"): when the inbox was last read, and the
 * stretches nothing read it. `read` is the inbox list read; a conversation
 * read that failed after it says so in `reason` without unmaking it.
 * Append-only, like the conversation log, and it holds no words.
 */
export const inboxReads = pgTable(
  "inbox_reads",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    /** The campaign whose Ambassador's wake read it, and that run. */
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      { onDelete: "set null" },
    ),
    runId: bigint("run_id", { mode: "number" }),
    outcome: text("outcome", { enum: INBOX_READ_OUTCOMES }).notNull(),
    /** Why a read was refused or failed, or what cut a read short. */
    reason: text("reason"),
    /** The `since` the read asked from. */
    lookbackFrom: bigint("lookback_from", { mode: "number" }).notNull(),
    threadsListed: integer("threads_listed").notNull().default(0),
    threadsRead: integer("threads_read").notNull().default(0),
    messagesRecorded: integer("messages_recorded").notNull().default(0),
    /** Conversations the read opened while they showed unread whose Mark as
     *  unread it could not see land. Never pressed again: the owner's to
     *  look at. */
    unreadRestoresUnconfirmed: integer("unread_restores_unconfirmed").notNull().default(0),
    /** The reader whose list the read worked from. */
    reader: text("reader", { enum: READERS }).notNull().default("parser"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    orgChannelFinishedIdx: index("inbox_reads_org_channel_finished_idx").on(
      t.organizationId,
      t.channelId,
      t.finishedAt,
    ),
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "inbox_reads_org_channel_fk",
    }).onDelete("no action"),
    outcomeCheck: check(
      "inbox_reads_outcome_check",
      sql`${t.outcome} in ('read', 'refused', 'failed') and (${t.outcome} = 'read' or ${t.reason} is not null)`,
    ),
    readerCheck: check(
      "inbox_reads_reader_check",
      sql`${t.reader} in ('parser', 'agent')`,
    ),
  }),
);

export type InboxReadRow = typeof inboxReads.$inferSelect;

export const feedback = pgTable(
  "feedback",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    verdict: text("verdict", { enum: ["approve", "edit", "reject"] }).notNull(),
    editedText: text("edited_text"),
    reasonTags: jsonb("reason_tags").$type<string[]>(),
    freeTextNote: text("free_text_note"),
    rating: bigint("rating", { mode: "number" }),
    /** Trusted decision surface. Legacy rows are null; new approval paths stamp
     * this server-side so a model decision cannot impersonate a human edit. */
    decisionOrigin: text("decision_origin", {
      enum: ["agent", "mcp_app", "dashboard"],
    }),
    /** SHA-256 of the exact approved/edited text for send-time provenance. */
    finalTextHash: text("final_text_hash"),
    /** The attempt approved by a room-reply queue press. Null legacy receipts
     * cannot authorize a new room-reply generation. */
    messageRequestVersion: integer("message_request_version"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgMessageIdx: index("feedback_org_message_idx").on(
      t.organizationId,
      t.messageId,
    ),
    finalTextHashCheck: check(
      "feedback_final_text_hash_check",
      sql`${t.finalTextHash} is null or ${t.finalTextHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const exemplars = pgTable(
  "exemplars",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      {
        onDelete: "cascade",
      },
    ),
    // The voice the exemplar's response was written in. Null (legacy rows) =
    // retrievable under every voice; stamped rows stop leaking across
    // register-incompatible voices at retrieval time.
    voiceId: bigint("voice_id", { mode: "number" }).references(
      () => voices.id,
      {
        onDelete: "set null",
      },
    ),
    kind: text("kind", { enum: ["comment", "reply"] }).notNull(),
    contextText: text("context_text").notNull(),
    responseText: text("response_text").notNull(),
    label: text("label", { enum: ["good", "bad"] }).notNull(),
    source: text("source", { enum: ["seed", "feedback"] }).notNull(),
    /** Stable provenance key for idempotent learning materialization. */
    sourceRef: text("source_ref"),

    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgCampaignLabelIdx: index("exemplars_org_campaign_label_idx").on(
      t.organizationId,
      t.campaignId,
      t.label,
    ),
    orgSourceRefUnq: uniqueIndex("exemplars_org_source_ref_uidx")
      .on(t.organizationId, t.sourceRef)
      .where(sql`${t.sourceRef} is not null`),
  }),
);

export const campaignGuidance = pgTable("campaign_guidance", {
  campaignId: bigint("campaign_id", { mode: "number" })
    .primaryKey()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  organizationId: orgId(),
  guidance: text("guidance").notNull().default(""),
  derivedFrom: bigint("derived_from", { mode: "number" }).notNull().default(0),
  updatedAt: bigint("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
});

export const prompts = pgTable(
  "prompts",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    kind: text("kind", {
      enum: ["filter", "writer", "reply", "slop", "sensitivity", "distill"],
    }).notNull(),
    template: text("template").notNull(),
    hash: text("hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgHashUnq: uniqueIndex("prompts_org_hash_unq").on(
      t.organizationId,
      t.hash,
    ),
  }),
);

export const rateLimitLedger = pgTable(
  "rate_limit_ledger",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    ts: bigint("ts", { mode: "number" }).notNull().$defaultFn(nowMs),
    action: text("action", {
      enum: [
        "comment",
        "reply",
        "room_reply",
        "like",
        "discover",
        "poll",
        "profile",
        "thread_read",
        "profile_read",
        "reply_check",
        // The action ledger's kinds (Phase 47): the dispatch gate mints their
        // row, never the connector (INV-13).
        "like_target",
        "invite",
        "accept_invite",
        "dm",
        "followup",
        "withdraw_invite",
      ],
    }).notNull(),
    // `campaign_id`'s own fate — whether the ledger keeps attributing rows to a
    // campaign at all once the budget belongs to the account — is decided in
    // T-4.4, not here. This task leaves it untouched.
    campaignId: bigint("campaign_id", { mode: "number" }),
    targetProfileId: profileIdText("target_profile_id"),
    targetMemberUrn: text("target_member_urn"),
    messageId: bigint("message_id", { mode: "number" }),
    // The account the exposure was spent against (INV-4). Bare — no FK — because
    // this table's `campaign_id` and `message_id` carry none either: the ledger
    // is an append-only meter, and a cascade or a NO ACTION refusal on it would
    // couple a delete elsewhere to the history of what was already sent.
    // Nullable and UNREAD in this task: the writers stamp it in T-4.4a, the task
    // that gives it a reader.
    channelId: bigint("channel_id", { mode: "number" }),
    meta: jsonb("meta"),
  },
  (t) => ({
    orgActionTsIdx: index("ledger_org_action_ts_idx").on(
      t.organizationId,
      t.action,
      t.ts,
    ),
    orgProfileTsIdx: index("ledger_org_profile_ts_idx").on(
      t.organizationId,
      t.targetProfileId,
      t.ts,
    ),
    // The channel-scoped twins of the two indexes above, declared for the reads
    // T-4.4/T-4.5 do. Built CONCURRENTLY by migrate.ts (see
    // CONCURRENT_INDEX_DEFINITIONS) — an existing-table index built inside the
    // migration's wrapping transaction would lock the ledger. The org/action
    // and org/profile indexes stay: today's readers keep using them until T-4.4
    // moves them.
    orgChannelActionTsIdx: index("ledger_org_channel_action_ts_idx").on(
      t.organizationId,
      t.channelId,
      t.action,
      t.ts,
    ),
    orgChannelProfileTsIdx: index("ledger_org_channel_profile_ts_idx").on(
      t.organizationId,
      t.channelId,
      t.targetProfileId,
      t.ts,
    ),
  }),
);

/** Durable intent/receipt for retry-safe transactional email. The exact
 * provider request is AES-GCM encrypted only while delivery is unresolved,
 * then erased when the outcome becomes final. The recipient UUID is retained
 * as the immutable authorization subject; durable audit fields contain no
 * recipient address or body plaintext. */
export const emailDeliveryReceipts = pgTable(
  "email_delivery_receipts",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    jobId: bigint("job_id", { mode: "number" }),
    /** Immutable identity whose current owner membership authorizes each send.
     * Nullable only for already-final receipts created before this binding. */
    recipientUserId: uuid("recipient_user_id"),
    kind: text("kind", {
      enum: [
        "lead_hot",
        "lead_nudge",
        "checkpoint",
        "runtime_alert",
        "trial_started",
        "trial_ending",
        "payment_failed",
      ],
    }).notNull(),
    deliveryKey: text("delivery_key").notNull(),
    providerIdempotencyKey: text("provider_idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    /** Exact rendered provider request, AES-GCM encrypted only while delivery is
     * unresolved. Cleared atomically when the outcome becomes final. */
    encryptedProviderPayload: text("encrypted_provider_payload"),
    state: text("state", {
      enum: ["reserved", "sending", "sent", "uncertain"],
    })
      .notNull()
      .default("reserved"),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    firstAttemptAt: bigint("first_attempt_at", { mode: "number" }),
    lastAttemptAt: bigint("last_attempt_at", { mode: "number" }),
    sentAt: bigint("sent_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgDeliveryUnq: uniqueIndex("email_delivery_receipts_org_delivery_unq").on(
      t.organizationId,
      t.kind,
      t.deliveryKey,
    ),
    providerKeyUnq: uniqueIndex("email_delivery_receipts_provider_key_unq").on(
      t.providerIdempotencyKey,
    ),
    orgStateIdx: index("email_delivery_receipts_org_state_idx").on(
      t.organizationId,
      t.state,
      t.updatedAt,
    ),
    kindCheck: check(
      "email_delivery_receipts_kind_chk",
      sql`${t.kind} in ('lead_hot', 'lead_nudge', 'checkpoint', 'runtime_alert', 'trial_started', 'trial_ending', 'payment_failed')`,
    ),
    stateCheck: check(
      "email_delivery_receipts_state_chk",
      sql`${t.state} in ('reserved', 'sending', 'sent', 'uncertain')`,
    ),
    attemptsCheck: check(
      "email_delivery_receipts_attempts_chk",
      sql`${t.attempts} >= 0`,
    ),
    providerKeyCheck: check(
      "email_delivery_receipts_provider_key_chk",
      sql`length(${t.providerIdempotencyKey}) between 1 and 256`,
    ),
    deliveryKeyCheck: check(
      "email_delivery_receipts_delivery_key_chk",
      sql`length(${t.deliveryKey}) between 1 and 240`,
    ),
    payloadHashCheck: check(
      "email_delivery_receipts_payload_hash_chk",
      sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    lifecycleCheck: check(
      "email_delivery_receipts_lifecycle_chk",
      sql`(
        ${t.state} = 'reserved'
        and ${t.attempts} = 0
        and ${t.recipientUserId} is not null
        and ${t.encryptedProviderPayload} is not null
        and ${t.firstAttemptAt} is null
        and ${t.lastAttemptAt} is null
        and ${t.sentAt} is null
        and ${t.providerMessageId} is null
      ) or (
        ${t.state} = 'sending'
        and ${t.attempts} > 0
        and ${t.recipientUserId} is not null
        and ${t.encryptedProviderPayload} is not null
        and ${t.firstAttemptAt} is not null
        and ${t.lastAttemptAt} is not null
        and ${t.sentAt} is null
        and ${t.providerMessageId} is null
      ) or (
        ${t.state} = 'sent'
        and ${t.attempts} > 0
        and ${t.encryptedProviderPayload} is null
        and ${t.firstAttemptAt} is not null
        and ${t.lastAttemptAt} is not null
        and ${t.sentAt} is not null
      ) or (
        ${t.state} = 'uncertain'
        and ${t.encryptedProviderPayload} is null
        and ${t.sentAt} is null
        and ${t.providerMessageId} is null
        and (
          (
            ${t.attempts} = 0
            and ${t.firstAttemptAt} is null
            and ${t.lastAttemptAt} is null
          ) or (
            ${t.attempts} > 0
            and ${t.firstAttemptAt} is not null
            and ${t.lastAttemptAt} is not null
          )
        )
      )`,
    ),
  }),
);

/**
 * What a completed job reported: the counts the server observed, or the refusal
 * that says it could not. See `jobs.result`.
 *
 * `packages/core`'s `JobResult` is the authority, restated here because this
 * package may not import core — including the four rungs, so the two are EQUAL
 * rather than merely compatible. `packages/core/jobs/worker.ts` asserts that
 * equality in both directions; a field added to `Refusal` and not to this type
 * would otherwise be written to the column and be invisible to every reader of
 * it.
 */
export type JobResultValue =
  | Record<string, number>
  | {
      refusal: {
        layer: "org" | "worker" | "channel" | "connector";
        code: string;
        detail?: string;
        retryAt?: number;
      };
    };

export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    type: text("type", {
      enum: [
        "poll_incoming",
        "process_incoming",
        "reconcile_message_write",
        "monitor_engagement",
        "distill",
        "search_lookalike",
        "refresh_brain",
        "compile_campaign",
        "ingest_product",
        "notify_lead",
        "check_stale_leads",
        "forget_spotted",
        // The daily "this install is alive" usage-data event.
        "install_active",
        // The Brain seed from the owner's own posts: a browser sweep plus one
        // agent-CLI spawn per corpus chunk, far past what a chat turn can wait.
        "seed_brain",
        "recalibrate_voice",
        "reconcile_trial_renewal",
      // One worker run: discover -> triage -> draft -> publish, bounded by
      // the worker's per-run limits and serialized per campaign.
      "worker_run",
      // A strategy version scheduled for a later `effective_at`, activated
      // at that instant through the same validation as an immediate one.
      "activate_strategy",
      // The expiry of one agent step's wait: consumed once, by this or by the
      // conversation event it waited for, whichever comes first.
      "agent_step_timeout",
      // One account's approved actions taken through the dispatch gate,
      // oldest first: the only path from an owner's yes to a click.
      "dispatch_actions",
      // A sent invitation's person read again on a schedule, until a read
      // shows them connected or the wait on their acceptance expires.
      "invitation_watch",
      // A campaign's voice moved: the drafts still waiting are written again
      // in the voice its active version states.
      "redraft_for_voice",
      // The owner asked for a comment again: a strategy campaign's
      // Ambassador writes it again, and it waits for their yes.
      "redraft_comments",
      "redraft_room_reply",
      // The owner asked for a DM or follow-up again: its step's writer writes
      // it again, and it waits for their yes.
      "redraft_action",
      // The read half of an owner's live check: one read op on the account,
      // what it saw kept on the check for the owner to compare.
      "live_check_read",
      // An account's flagged campaigns activated again in place, after
      // something above them moved — a live check recorded or cleared — so
      // their switches resolve through it.
      "reproject_campaigns",
      // The account's light inbox check: one paced inbox read between
      // Ambassador wakes, so a DM is seen within the owner's chosen cadence.
      "inbox_check",
      // A person read once more after a withdrawal the owner's word alone
      // settled, so a read — never that word — moves the relationship.
      "withdrawal_read",
      // The owner's Invite on someone known only by a member urn: one read of
      // their own profile finds the address an invite goes by, then the
      // invite is queued as any owner's is.
      "owner_invite_member",
      // A voice just created drafts its description from the owner's own
      // writing on LinkedIn: the relearn engine on the account, its result
      // kept as a proposal for Keep or Drop.
      "relearn_voice_description",
      // A problem report the owner sent: their agent writes it up, and it is
      // relayed to the team through the cloud, retried until it goes or a
      // day has passed.
      "file_bug_report",
      // Their acceptance of our invitation: one read of the conversation for
      // the note that rode with it, and, where it did not arrive, the note
      // reserved as the first message (`actions/inviteNote.ts`).
      "invite_note_check",
      // The daily fold of Find leads people nobody answered into No answer.
      // Database only: no LinkedIn read, no model call.
      "lead_lifecycle",
      // A Find posts campaign's people judged by the lead pipeline, as a
      // report: model calls, no LinkedIn read, nothing written but the row.
      // The owner's Research on chosen Signals: one profile read each, then
      // qualify and serve, under the account's run lease.
      "research_signals",
      // One campaign's Screen: a batch of the words Find leads read, judged by
      // the owner's agent with no account held.
      "lead_screen",
      // One campaign's Judge: a person whose profile was read, judged by the
      // owner's agent and served, with no account held.
      "lead_judge",
      ],
    }).notNull(),
    payload: jsonb("payload"),
    status: text("status", {
      enum: ["queued", "running", "done", "failed", "dead"],
    })
      .notNull()
      .default("queued"),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    // Manual re-arms advance this generation; ordinary lease retries do not.
    // Economic claims can therefore follow one logical execution across retry
    // leases without leaking into a later user-requested rerun of the same row.
    executionGeneration: integer("execution_generation").notNull().default(0),
    maxAttempts: bigint("max_attempts", { mode: "number" })
      .notNull()
      .default(5),
    nextRunAt: bigint("next_run_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    lockedAt: bigint("locked_at", { mode: "number" }),
    // Fencing token, rotated on every claim/reap: complete/fail/heartbeat writes are
    // guarded on it, so a worker whose lease was reaped (and possibly re-claimed by
    // another worker) can no longer flip the row's state — its token is stale.
    leaseToken: text("lease_token"),
    idempotencyKey: text("idempotency_key"),
    /**
     * What the job actually DID, written by the worker from the handler's
     * return value when it completes.
     *
     * A job that finished is not the same as a job that accomplished
     * something: Radar's triage once completed in milliseconds having written
     * zero verdicts, and nothing on the row could tell you. These counts are
     * rows the server wrote — never a number a model reported about itself —
     * so the register can say "47 found, 25 triaged, 6 matched" instead of
     * implying success from a green badge.
     *
     * The refusal arm carries that same distinction one step further: a zero
     * could equally mean "swept and found nothing" or "never reached the
     * account", so a job that COULD NOT do its work writes the rung that said
     * no instead of a count. See `JobResultValue` for where the shape is
     * authored and how it is held equal to core's.
     */
    result: jsonb("result").$type<JobResultValue>(),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    statusNextRunIdx: index("jobs_status_next_run_idx").on(
      t.status,
      t.nextRunAt,
    ),
    orgIdempotencyUnq: uniqueIndex("jobs_org_idempotency_unq").on(
      t.organizationId,
      t.idempotencyKey,
    ),
    // Scout's job register (/scout/jobs and its SSE stream) reads
    // `where organizationId and type in (...) order by updatedAt desc`, which
    // neither index above serves. The stream re-runs it every couple of seconds
    // while work is in flight, so a seq scan + sort over a growing queue table
    // is the wrong default. Org first: `jobs` is excluded from RLS, so every
    // tenant-facing read is already org-prefixed.
    orgTypeUpdatedIdx: index("jobs_org_type_updated_idx").on(
      t.organizationId,
      t.type,
      t.updatedAt.desc(),
    ),
  }),
);

/**
 * Per-org jittered pacing for recurring provider reads (poll_incoming, per-campaign
 * discovery sweeps, engagement-monitor sweeps). The 5-minute scheduler tick stays
 * fixed; each paced kind self-gates on `nextRunAt`, written with fresh random
 * jitter after every real run (`claimPacedRun` in packages/core/pacing.ts) — so
 * reads never hit LinkedIn on a fixed grid (provider's automation-detection
 * warning). `kind` examples: "poll_incoming", `discover:{campaignId}`.
 */
export const pacingState = pgTable(
  "pacing_state",
  {
    organizationId: orgId(),
    kind: text("kind").notNull(),
    nextRunAt: bigint("next_run_at", { mode: "number" }).notNull().default(0),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.kind] }),
  }),
);

export const secrets = pgTable(
  "secrets",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    provider: text("provider").notNull(),
    encryptedState: text("encrypted_state").notNull(),
    status: text("status").notNull().default("active"),
    lastValidatedAt: bigint("last_validated_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgProviderUnq: uniqueIndex("secrets_org_provider_unq").on(
      t.organizationId,
      t.provider,
    ),
  }),
);

// ============================================================================
// Per-org former singletons
// ============================================================================
export const profile = pgTable("profile", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .default(CURRENT_ORG)
    .references(() => organizations.id, { onDelete: "cascade" }),
  voicePersona: text("voice_persona"),
  voiceHouseStyle: text("voice_house_style"),
  voiceLearnedFrom: bigint("voice_learned_from", { mode: "number" })
    .notNull()
    .default(0),
  // Display payload for the onboarding voice card (tags + a sample comment) — populated
  // by the import_voice job alongside voicePersona/voiceHouseStyle.
  voiceCard: jsonb("voice_card").$type<VoiceCard>(),
  // Which sources "Re-learn voice" pulls from. Voice is learned from every active channel.
  voiceChannels: jsonb("voice_channels")
    .$type<VoiceChannels>()
    .notNull()
    .default({ linkedin: true, brain: true }),
  // Structural style range distilled from the user's own posts (writer-variety).
  // Nullable + best-effort: when nil/degenerate the writer blends in the hardcoded
  // DEFAULT_STYLE_TAXONOMY so the per-draft spread is always guaranteed.
  voiceStructuralRange: jsonb(
    "voice_structural_range",
  ).$type<StyleStructuralRange>(),
  // Per-OUTPUT-channel voices (comment vs post). Null / missing key → the legacy
  // flat columns above serve both channels (the post channel then reads as
  // "seeded from posts"). Comment-channel writes DUAL-WRITE the legacy columns
  // so old readers and the fallback stay coherent. voiceStructuralRange stays
  // flat: it feeds comment style directives (comment-channel by nature).
  voices: jsonb("voices").$type<VoicesMap>(),
  updatedAt: bigint("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
});

export const systemState = pgTable("system_state", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .default(CURRENT_ORG)
    .references(() => organizations.id, { onDelete: "cascade" }),
  // The kill switch is all that is left here: the pause pair and the LinkedIn
  // session liveness trio moved to `channels`, where a pause and a probe result
  // describe the account they belong to rather than the whole install.
  killSwitch: boolean("kill_switch").notNull().default(false),
  strategyProjectionSchema: integer("strategy_projection_schema").notNull().default(0),
  /** Durable source fence during an org transfer; clearing killSwitch cannot remove it. */
  transferPaused: boolean("transfer_paused").notNull().default(false),
  /** Cloud control-plane lifecycle fence, independent of the owner's kill switch. */
  cloudPaused: boolean("cloud_paused").notNull().default(false),
  cloudControlRevision: bigint("cloud_control_revision", { mode: "number" }).notNull().default(0),
  updatedAt: bigint("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
});

/**
 * One authority handoff, from the moment it is intended to the moment exactly
 * one destination epoch is active (ADR-02). The row lives in the RUNTIME
 * database on both ends, because startup must read its own transfer fence
 * before claiming queued work — a copied lockfile or runtime id is never
 * authority, and a cloud that cannot be reached must not be able to decide
 * whether this install may run.
 *
 * The state vocabulary is deliberately conservative in one direction: a stop
 * that could not be confirmed becomes `paused_recovery`, never `source_stopped`.
 * Nothing here activates a destination; `activated_epoch` is written once, by
 * the destination, after copy and source-stop receipts are both accepted.
 */
export const transferIntents = pgTable(
  "transfer_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Deliberately OUTSIDE tenant RLS, and therefore outside the transfer write
    // fence's trigger set: a source that has been fenced must still be able to
    // advance and abandon its own handoff record, which is the recovery path,
    // not tenant content. Every query below binds `organization_id` explicitly.
    // The column keeps the tenant default because the runtime writes it from
    // inside `withOrg`, where the scope is already established.
    organizationId: orgId(),
    /** `restore` is a portable archive adopted on ONE machine (`state`
     * `restored`): there is no second end, so both placement columns below name
     * the install that holds this row. */
    direction: text("direction", {
      enum: ["local_to_cloud", "cloud_to_local", "restore"],
    }).notNull(),
    /** Which end this row describes. Both ends keep their own record; the
     * manifest hash is what proves they describe the same transfer. */
    side: text("side", { enum: ["source", "destination"] }).notNull(),
    sourcePlacement: text("source_placement", {
      enum: ["local", "cloud"],
    }).notNull(),
    destinationPlacement: text("destination_placement", {
      enum: ["local", "cloud"],
    }).notNull(),
    /** The source runtime instance that quiesced, and the epoch it held. */
    sourceRuntimeId: text("source_runtime_id"),
    expectedEpoch: bigint("expected_epoch", { mode: "number" }),
    /** Opaque destination identity presented at handshake; compared, never
     * trusted as an assertion of ownership on its own. */
    destinationIdentity: text("destination_identity"),
    state: text("state", {
      enum: [
        "recorded",
        "quiescing",
        "source_stopped",
        "copying",
        "copied",
        // A portable archive that landed on this machine. It proves nothing
        // about another install — no source stop, no verified copy — so it can
        // only be adopted by re-verifying the account here, never activated
        // like a handoff (`packages/core/execution/transfer.ts`).
        "restored",
        "activated",
        "paused_recovery",
        "abandoned",
      ],
    })
      .notNull()
      .default("recorded"),
    /** sha256 of the portable manifest both ends verified. */
    manifestSha256: text("manifest_sha256"),
    /** Unresolved obligations carried across, by kind and count. Evidence for
     * the owner and the reviewer; never a licence to repeat a request. */
    obligationSummary: jsonb("obligation_summary").$type<
      { kind: string; count: number }[]
    >(),
    sourceStopConfirmedAt: bigint("source_stop_confirmed_at", {
      mode: "number",
    }),
    activatedEpoch: bigint("activated_epoch", { mode: "number" }),
    activatedAt: bigint("activated_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgStateIdx: index("transfer_intents_org_state_idx").on(
      t.organizationId,
      t.state,
    ),
    // At most one live handoff per organization and side. A retry resumes this
    // row; it never opens a second transfer that could activate twice.
    openOrgSideUnq: uniqueIndex("transfer_intents_open_org_side_unq")
      .on(t.organizationId, t.side)
      .where(
        sql`${t.state} not in ('activated', 'abandoned')`,
      ),
    activationPairCheck: check(
      "transfer_intents_activation_pair_check",
      sql`(${t.activatedEpoch} is null and ${t.activatedAt} is null) or (${t.activatedEpoch} is not null and ${t.activatedAt} is not null and ${t.state} = 'activated')`,
    ),
  }),
);

/**
 * What verifying one matched candidate found: the full post and thread, its
 * author, the engagement play read off them, and the verdict. One current row
 * per post; a re-verify overwrites it.
 *
 * The verdict is copied onto `discovered_posts.verify_verdict` so the pool
 * reads without a join; this row is the evidence behind it. A row can hold a
 * read with no verdict yet: a read budget ran out before the other read, and
 * the candidate stays matched, unverified.
 */
export type RoomSummaryJson = {
  judged: number;
  fits: number;
  maybe: number;
  unknown: number;
  density: number;
  pages: 1 | 2;
  /** Counted under the org's evidence lock before these people become known.
   * Older snapshots deliberately have no reconstructed discovery count. */
  newlySpotted?: number;
  decision?: { reasonCode: string | null; reason: string | null };
  /** The author's fit as judged with this read. Older snapshots have none;
   * their current Research row still carries it. */
  authorFit?: "fits" | "maybe" | "not";
  /** A second-page rejudgment keeps the first page's qualification. */
  firstPageRoom?: { judged: number; fits: number };
};

/** A room claim keeps stable source identities, never prompt positions.
 * Its words are discovery evidence and expire with the cited comments. */
export type RoomInsightJson = {
  kind: "pain" | "objection" | "open_question";
  text: string;
  snapshotId: string;
  audienceRevision: number;
  sourceRefs: Array<{ personKey: string; commentUrn: string }>;
};

export type AudienceThemeSourceJson = {
  discoveredPostId: number;
  snapshotId: string;
  audienceRevision: number;
  comments: Array<{ personKey: string; commentUrn: string }>;
};

export type LookalikeProposalJson = {
  intent: "magnet_author" | "pain" | "topic";
  type: "author" | "keyword" | "query";
  term: string;
  displayName?: string;
  painId?: string;
  people?: number;
  line: string;
  state: "open" | "added" | "skipped";
  /** On a room read onto a search map (`target` below): the kind of language
   *  a phrase catches, or, for a source, the profile or company page link to
   *  read and the role the room's plan gave it. Held until the owner presses
   *  Add (core's `discovery/lookalike.ts`). */
  languageType?: LanguageType;
  source?: { link: string; role: SourceRole };
};

export const LOOKALIKE_TARGETS = ["searches", "lead_searches"] as const;
export type LookalikeTarget = (typeof LOOKALIKE_TARGETS)[number];

/** A requested post read and its bounded search suggestions. Never stores
 * comment author names, comments or person rows; a context hash binds authority. */
export const searchLookalikes = pgTable("search_lookalikes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: orgId(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  channelId: bigint("channel_id", { mode: "number" }).notNull(),
  audienceRevision: integer("audience_revision").notNull(),
  contextRevision: text("context_revision").notNull(),
  postUrn: text("post_urn").notNull(),
  url: text("url").notNull(),
  status: text("status", { enum: ["reading", "read", "failed"] }).notNull(),
  reader: text("reader", { enum: ["server", "agent"] }).notNull(),
  /** Where what the read finds lands: Find posts' searches, or the search
   *  map of a campaign that finds leads (core's `leads/scout/room.ts`). */
  target: text("target", { enum: LOOKALIKE_TARGETS }).notNull().default("searches"),
  failure: text("failure", { enum: ["read_refused", "read_failed"] }),
  refusalReason: text("refusal_reason"),
  authorProfileId: profileIdText("author_profile_id"),
  authorName: text("author_name"),
  authorHeadline: text("author_headline"),
  opening: text("opening").notNull().default(""),
  comments: integer("comments").notNull().default(0),
  judged: integer("judged").notNull().default(0),
  fits: integer("fits").notNull().default(0),
  pains: jsonb("pains").$type<Array<{ painId: string; people: number }>>().notNull().default(sql`'[]'::jsonb`),
  proposals: jsonb("proposals").$type<LookalikeProposalJson[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  readStartedAt: bigint("read_started_at", { mode: "number" }),
  readSpentAt: bigint("read_spent_at", { mode: "number" }),
  readAt: bigint("read_at", { mode: "number" }),
}, (t) => ({
  orgCampaignCreatedIdx: index("search_lookalikes_org_campaign_created_idx").on(t.organizationId, t.campaignId, t.createdAt),
  campaignFk: foreignKey({ columns: [t.organizationId, t.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id],
    name: "search_lookalikes_org_campaign_fk" }).onDelete("cascade"),
  channelFk: foreignKey({ columns: [t.organizationId, t.channelId], foreignColumns: [channels.organizationId, channels.id],
    name: "search_lookalikes_org_channel_fk" }).onDelete("cascade"),
  bounds: check("search_lookalikes_bounds", sql`${t.audienceRevision} >= 0 and ${t.comments} >= 0 and ${t.judged} >= 0
    and ${t.fits} between 0 and ${t.judged} and length(${t.opening}) <= 280 and jsonb_array_length(${t.proposals}) <= 4`),
  statuses: check("search_lookalikes_status", sql`${t.status} in ('reading', 'read', 'failed')`),
  readers: check("search_lookalikes_reader", sql`${t.reader} in ('server', 'agent')`),
  targets: check("search_lookalikes_target", sql`${t.target} in ('searches', 'lead_searches')`),
}));
/** Derived discovery evidence. Kept knowledge is a separate owner artifact;
 * its logical id is looked up under this tenant, never used for a global join. */
export const audienceThemes = pgTable("audience_themes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: orgId(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  audienceRevision: integer("audience_revision").notNull(),
  kind: text("kind", { enum: ["pain", "objection", "open_question"] }).notNull(),
  text: text("text").notNull(),
  phrases: text("phrases").array().notNull().default(sql`'{}'::text[]`),
  painId: text("pain_id"),
  rooms: integer("rooms").notNull(),
  comments: integer("comments").notNull(),
  sourceRefs: jsonb("source_refs").$type<AudienceThemeSourceJson[]>().notNull(),
  status: text("status", { enum: ["current", "past"] }).notNull(),
  keptAt: bigint("kept_at", { mode: "number" }),
  keptKnowledgeId: integer("kept_knowledge_id"),
  firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
  lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
  rolledUpAt: bigint("rolled_up_at", { mode: "number" }).notNull(),
}, (t) => ({
  campaignStatusIdx: index("audience_themes_org_campaign_status_idx").on(t.organizationId, t.campaignId, t.status),
  campaignFk: foreignKey({ columns: [t.organizationId, t.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id],
    name: "audience_themes_org_campaign_fk" }).onDelete("cascade"),
  bounds: check("audience_themes_bounds", sql`length(${t.text}) between 1 and 120 and cardinality(${t.phrases}) <= 3
    and ${t.rooms} >= 0 and ${t.comments} >= 0 and ${t.audienceRevision} >= 0`),
  kinds: check("audience_themes_kind", sql`${t.kind} in ('pain', 'objection', 'open_question')`),
  statuses: check("audience_themes_status", sql`${t.status} in ('current', 'past')`),
}));

/** One bounded reading of a room. New reads supersede the pointer on Research;
 * they never overwrite the evidence a draft or pending action was based on. */
export const roomSnapshots = pgTable("room_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: orgId(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  discoveredPostId: bigint("discovered_post_id", { mode: "number" }).notNull(),
  audienceRevision: integer("audience_revision").notNull(),
  readAt: bigint("read_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  reader: text("reader", { enum: ["server", "agent"] }).notNull(),
  runId: bigint("run_id", { mode: "number" }),
  /** The provider's count and the actual bounded evidence, not a claim that
   * every comment in the room was read. */
  totalComments: integer("total_comments").notNull(),
  commentsRead: integer("comments_read").notNull(),
  pages: integer("pages").notNull(),
  orders: jsonb("orders").$type<Array<"relevance" | "recent">>().notNull(),
  coverage: text("coverage", { enum: ["complete", "sampled", "budget_limited"] }).notNull(),
  summary: jsonb("summary").$type<RoomSummaryJson>().notNull(),
  joinLens: text("join_lens", { enum: ["none", "author", "room", "both", "author_maybe"] }).notNull(),
}, (t) => ({
  orgPostId: uniqueIndex("room_snapshots_org_post_id_unq").on(t.organizationId, t.discoveredPostId, t.id),
  postFk: foreignKey({ columns: [t.organizationId, t.campaignId, t.discoveredPostId],
    foreignColumns: [discoveredPosts.organizationId, discoveredPosts.campaignId, discoveredPosts.id],
    name: "room_snapshots_org_campaign_post_fk" }).onDelete("cascade"),
  bounds: check("room_snapshots_bounds", sql`${t.pages} between 1 and 2 and ${t.commentsRead} between 0 and 100 and ${t.totalComments} >= 0`),
}));

/** One judgment per person in a snapshot, with all bounded source comments.
 * Discovery evidence alone is neither a conversation nor a confirmed touch. */
export type RoomDraftRequestJson = {
  parentCommentUrn: string;
  deliverable: "reply" | "invite_note";
  contextRevision: string;
  text: string | null;
};

export const roomMembers = pgTable("room_members", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: orgId(),
  discoveredPostId: bigint("discovered_post_id", { mode: "number" }).notNull(),
  snapshotId: uuid("snapshot_id").notNull(),
  personKey: text("person_key").notNull(),
  personRef: text("person_ref").notNull(),
  /** A post-scoped owner choice; rereading carries it forward by identity. */
  ownerSkippedAt: bigint("owner_skipped_at", { mode: "number" }),
  draftRequestId: uuid("draft_request_id"),
  draftRequestedAt: bigint("draft_requested_at", { mode: "number" }),
  draftRequest: jsonb("draft_request").$type<RoomDraftRequestJson>(),
  profileId: profileIdText("profile_id"),
  memberUrn: text("member_urn"),
  name: text("name"),
  headline: text("headline"),
  fit: text("fit", { enum: ["fits", "maybe", "not", "unknown"] }).notNull(),
  painId: text("pain_id"),
  reason: text("reason"),
  /** Where the person's profile placed them when Research checked a fitting
   *  comment author against the Audience's countries: ISO 3166-1 alpha-2, or null
   *  for none named or none read. */
  country: text("country"),
  /** When that profile was read, or the cached read used. Null with a null
   *  country is unchecked — the budget ran out — and worth a later read. */
  countryReadAt: bigint("country_read_at", { mode: "number" }),
  evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull(),
  comments: jsonb("comments").$type<Array<PostThreadJson["comments"][number] & { ref: string }>>().notNull(),
}, (t) => ({
  personUnq: uniqueIndex("room_members_org_snapshot_person_unq").on(t.organizationId, t.snapshotId, t.personKey),
  orgIdUnq: uniqueIndex("room_members_org_id_unq").on(t.organizationId, t.id),
  snapshotFk: foreignKey({ columns: [t.organizationId, t.discoveredPostId, t.snapshotId],
    foreignColumns: [roomSnapshots.organizationId, roomSnapshots.discoveredPostId, roomSnapshots.id],
    name: "room_members_org_post_snapshot_fk" }).onDelete("cascade"),
}));

/** The minimum identity needed to honor Never engage after discovery text
 * is forgotten. An observed member alias keeps the same exclusion. */
export const roomExclusions = pgTable("room_exclusions", {
  organizationId: orgId(),
  identityKey: text("identity_key").notNull(),
  personKey: text("person_key").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  pk: primaryKey({ columns: [t.organizationId, t.identityKey] }),
  person: index("room_exclusions_org_person").on(t.organizationId, t.personKey),
  identity: check("room_exclusions_identity", sql`${t.identityKey} ~ '^[pm]\\..+' and ${t.personKey} ~ '^[pm]\\..+'`),
}));

/** Minimum source binding for a room reply. Discovery text and display names
 * stay in the expiring room evidence, never in this durable work key. A reply
 * is read from where its comment was: a room Research read (no `source`, as
 * every room reply has always been stored), or the thread read that found a
 * lead (`source: "lead"`), whose signal it re-reads. */
export type RoomReplyTargetJson = RoomSourcedReplyTarget | LeadSourcedReplyTarget;

export type RoomSourcedReplyTarget = {
  source?: undefined;
  accountProfileId: string;
  discoveredPostId: number;
  postUrn: string;
  parentCommentUrn: string;
  personKey: string;
  profileId: string | null;
  memberUrn: string;
  roomMemberId: number;
  snapshotId: string;
  audienceRevision: number;
  evidenceReadAt: number;
  selectedBy: "owner" | "worker";
};

/** A reply under a lead's comment, keyed on the signal that holds it. Only
 *  the owner's press on Leads selects one. */
export type LeadSourcedReplyTarget = {
  source: "lead";
  accountProfileId: string;
  postUrn: string;
  parentCommentUrn: string;
  personKey: string;
  profileId: string;
  memberUrn: string;
  leadId: number;
  signalId: number;
  evidenceReadAt: number;
  selectedBy: "owner";
};

/** A saved composer is not a send. The queue operation creates a message
 * separately, with a frozen copy of the action target and authorization. Erasure
 * clears discovery identity while preserving the owner's saved words. */
export const roomReplyDrafts = pgTable("room_reply_drafts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: orgId(),
  channelId: bigint("channel_id", { mode: "number" }).notNull(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  targetKey: text("target_key").notNull(),
  target: jsonb("target").$type<RoomReplyTargetJson>(),
  text: text("text").notNull().default(""),
  revision: integer("revision").notNull().default(0),
  authorship: text("authorship", { enum: ["unknown", "owner", "assisted"] }).notNull().default("unknown"),
  assistTexts: jsonb("assist_texts").$type<string[]>().notNull().default([]),
  ownerWords: jsonb("owner_words").$type<string[]>().notNull().default([]),
  assistRetention: real("assist_retention"),
  ownerOrigin: real("owner_origin"),
  evidenceExpiresAt: bigint("evidence_expires_at", { mode: "number" }).notNull(),
  erasedAt: bigint("erased_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  orgId: unique("room_reply_drafts_org_id_key").on(t.organizationId, t.id),
  targetUnq: uniqueIndex("room_reply_drafts_org_target_unq").on(t.organizationId, t.targetKey),
  campaign: index("room_reply_drafts_org_campaign_idx").on(t.organizationId, t.campaignId),
  channelFk: foreignKey({ columns: [t.organizationId, t.channelId], foreignColumns: [channels.organizationId, channels.id],
    name: "room_reply_drafts_org_channel_fk" }).onDelete("cascade"),
  campaignFk: foreignKey({ columns: [t.organizationId, t.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id],
    name: "room_reply_drafts_org_campaign_fk" }).onDelete("cascade"),
  values: check("room_reply_drafts_values_check", sql`${t.revision} >= 0 and ${t.authorship} in ('unknown', 'owner', 'assisted')
    and (${t.assistRetention} is null or ${t.assistRetention} between 0 and 1)
    and (${t.ownerOrigin} is null or ${t.ownerOrigin} between 0 and 1)`),
  erased: check("room_reply_drafts_erasure_check", sql`(${t.erasedAt} is null) = (${t.target} is not null)`),
}));

export type RoomReplyDraft = typeof roomReplyDrafts.$inferSelect;

/** Agent offers are provenance, separate from owner drafts and outgoing work.
 * The stable target survives a refreshed room snapshot; erasure removes it. */
export const roomReplyAssists = pgTable("room_reply_assists", {
  organizationId: orgId(),
  targetKey: text("target_key").notNull(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  channelId: bigint("channel_id", { mode: "number" }).notNull(),
  target: jsonb("target").$type<RoomSourcedReplyTarget>().notNull(),
  deliverable: text("deliverable", { enum: ["reply", "invite_note"] }).notNull(),
  texts: jsonb("texts").$type<string[]>().notNull().default([]),
  evidenceExpiresAt: bigint("evidence_expires_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  pk: primaryKey({ columns: [t.organizationId, t.targetKey, t.deliverable] }),
  channelFk: foreignKey({ columns: [t.organizationId, t.channelId], foreignColumns: [channels.organizationId, channels.id],
    name: "room_reply_assists_org_channel_fk" }).onDelete("cascade"),
  campaignFk: foreignKey({ columns: [t.organizationId, t.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id],
    name: "room_reply_assists_org_campaign_fk" }).onDelete("cascade"),
  delivery: check("room_reply_assists_deliverable", sql`${t.deliverable} in ('reply', 'invite_note')`),
}));

/** One agent angle in one composer box, with its one draft — or, in state
 *  `idea`, with no draft yet: a name and a line the owner may ask to have
 *  written out. Raw material the owner keeps, edits or clears, never a send.
 *  `box_key` names the box the same way whatever else exists for it
 *  (`comment:<post>`, `reply:<incoming>`,
 *  `room:<room_reply_drafts.target_key>`, `invite:<person>`, `dm:<conversation>`,
 *  `lead:<lead>`; core's `composer/drafts.ts`). `offered` keeps every earlier text of the
 *  angle, newest last, so a save is measured against all of it. */
export const composerDrafts = pgTable("composer_drafts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: orgId(),
  boxKey: text("box_key").notNull(),
  campaignId: bigint("campaign_id", { mode: "number" }),
  position: integer("position").notNull(),
  angle: text("angle").notNull(),
  angleWhy: text("angle_why"),
  /** Core's `ASSIST_MOVES`; a string here, because this package may not
   *  import core. */
  move: text("move"),
  text: text("text"),
  state: text("state", { enum: ["ready", "writing", "failed", "idea"] }).notNull().default("ready"),
  revision: integer("revision").notNull().default(1),
  offered: jsonb("offered").$type<string[]>().notNull().default([]),
  requestedAt: bigint("requested_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  positionUnq: uniqueIndex("composer_drafts_org_box_position_unq").on(t.organizationId, t.boxKey, t.position),
  campaignFk: foreignKey({ columns: [t.organizationId, t.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id],
    name: "composer_drafts_org_campaign_fk" }).onDelete("cascade"),
  values: check("composer_drafts_values_check", sql`${t.position} >= 1 and ${t.revision} >= 1
    and char_length(${t.angle}) between 1 and 24 and (${t.angleWhy} is null or char_length(${t.angleWhy}) <= 160)
    and ${t.boxKey} ~ '^(comment|reply|room|invite|dm|lead):.+'`),
  state: check("composer_drafts_state_check", sql`(${t.state} = 'ready' and ${t.text} is not null)
    or (${t.state} in ('writing', 'idea') and ${t.text} is null) or ${t.state} = 'failed'`),
}));

export type ComposerDraft = typeof composerDrafts.$inferSelect;

/** The writing surfaces the draft dispatcher plans for. Core's
 *  `WritingSurface` plus the follow-up; a string list here, because this
 *  package may not import core. */
export const DRAFT_PLAN_SURFACES = ["comment", "reply", "room_reply", "invitation", "dm", "followup", "angle"] as const;

/**
 * The draft dispatcher's compile of one campaign's writing instructions for
 * one channel: the voice's rules and the campaign's own, merged by authority
 * into the rules every plan on that channel reads. Keyed on `revision`, a hash
 * of everything that went in, so an unchanged input never compiles twice and
 * a changed one never reuses a stale compile. `rules` and `conflicts` are
 * core's `CompiledRules` and `RuleConflict[]`, parsed there.
 */
export const compiledWritingRules = pgTable("compiled_writing_rules", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: orgId(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  channel: text("channel", { enum: ["comment", "reply", "dm"] }).notNull(),
  revision: text("revision").notNull(),
  rules: jsonb("rules").$type<Record<string, unknown>>().notNull(),
  conflicts: jsonb("conflicts").$type<Record<string, unknown>[]>().notNull().default([]),
  compiledAt: bigint("compiled_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  revisionUnq: uniqueIndex("compiled_writing_rules_org_campaign_channel_revision_unq")
    .on(t.organizationId, t.campaignId, t.channel, t.revision),
  campaignFk: foreignKey({ columns: [t.organizationId, t.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id],
    name: "compiled_writing_rules_org_campaign_fk" }).onDelete("cascade"),
  channel: check("compiled_writing_rules_channel_check", sql`${t.channel} in ('comment', 'reply', 'dm')`),
}));

export type CompiledWritingRulesRow = typeof compiledWritingRules.$inferSelect;

/**
 * One plan per draft: every choice that shapes it, made before the writer is
 * called and kept so the judge checks the draft against what was dispatched
 * rather than against a prompt. `plan` is core's `DraftPlan`, parsed there;
 * `rules_revision` names the compile it was planned from.
 */
export const draftPlans = pgTable("draft_plans", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: orgId(),
  campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
  /** The worker run that planned it; null for a plan made outside a run. */
  runId: bigint("run_id", { mode: "number" }),
  surface: text("surface", { enum: DRAFT_PLAN_SURFACES }).notNull(),
  discoveredPostId: bigint("discovered_post_id", { mode: "number" }),
  /** The composer box a plan is keyed on where it answers no discovered post:
   *  a lead's opener, `lead:<id>`. */
  boxKey: text("box_key"),
  rulesRevision: text("rules_revision").notNull(),
  engine: integer("engine").notNull(),
  plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  orgIdUnq: uniqueIndex("draft_plans_org_id_unq").on(t.organizationId, t.id),
  runIdx: index("draft_plans_org_run_idx").on(t.organizationId, t.runId),
  campaignFk: foreignKey({ columns: [t.organizationId, t.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id],
    name: "draft_plans_org_campaign_fk" }).onDelete("cascade"),
  values: check("draft_plans_values_check", sql`${t.engine} >= 1
    and ${t.surface} in ('comment', 'reply', 'room_reply', 'invitation', 'dm', 'followup', 'angle')`),
}));

export type DraftPlanRow = typeof draftPlans.$inferSelect;

/**
 * Every text written from a plan and what the judge said of it, item by item:
 * the first attempt, and the one rewrite a miss earns. `admitted` went on to
 * intake; `rewrite` missed and was written again; `withheld` missed twice and
 * went nowhere, so the run can show the owner what it held back and why.
 * `verdicts` is core's `PlanVerdict[]`.
 */
export const draftAttempts = pgTable("draft_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: orgId(),
  planId: bigint("plan_id", { mode: "number" }).notNull(),
  attempt: integer("attempt").notNull(),
  text: text("text").notNull(),
  verdicts: jsonb("verdicts").$type<Record<string, unknown>[]>().notNull(),
  outcome: text("outcome", { enum: ["admitted", "rewrite", "withheld", "held", "discarded"] }).notNull(),
  /** The first missed item, or why a held draft was discarded. */
  reason: text("reason"),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  attemptUnq: uniqueIndex("draft_attempts_org_plan_attempt_unq").on(t.organizationId, t.planId, t.attempt),
  planFk: foreignKey({ columns: [t.organizationId, t.planId], foreignColumns: [draftPlans.organizationId, draftPlans.id],
    name: "draft_attempts_org_plan_fk" }).onDelete("cascade"),
  values: check("draft_attempts_values_check", sql`${t.attempt} between 1 and 2
    and ${t.outcome} in ('admitted', 'rewrite', 'withheld', 'held', 'discarded')
    and (${t.outcome} in ('admitted', 'held') or ${t.reason} is not null)`),
}));

export type DraftAttemptRow = typeof draftAttempts.$inferSelect;

export const candidateResearch = pgTable(
  "candidate_research",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    discoveredPostId: bigint("discovered_post_id", {
      mode: "number",
    }).notNull(),
    thread: jsonb("thread").$type<PostThreadJson>(),
    threadReadAt: bigint("thread_read_at", { mode: "number" }),
    /** How a comment should join this thread, derived from its counts and the
     *  author's reply rate. Null until the thread is read. */
    play: text("play", {
      enum: [
        "early_question",
        "stand_out",
        "thread_starter",
        "standalone_value",
      ],
    }),
    /** Comments the post author answered over comments by others; null under
     *  three comments, where a rate would say nothing. */
    authorReplyRate: real("author_reply_rate"),
    /** Points the thread has already made, model-written, so a draft never
     *  repeats one. */
    alreadySaid: jsonb("already_said").$type<string[]>().notNull().default([]),
    audienceRevision: integer("audience_revision"),
    /** Projection of the current revisioned room read. Historical snapshots
     * remain addressable by work already attached to them. */
    roomSnapshotId: uuid("room_snapshot_id"),
    roomSummary: jsonb("room_summary").$type<RoomSummaryJson>(),
    insights: jsonb("insights").$type<RoomInsightJson[]>(),
    joinLens: text("join_lens", { enum: ["none", "author", "room", "both", "author_maybe"] }),
    authorFit: text("author_fit", { enum: ["fits", "maybe", "not"] }),
    verdict: text("verdict", { enum: ["confirmed", "rejected"] }),
    /** Why a rejection: the deterministic pre-checks first, then the
     *  model-judged codes, then `unavailable` — the post or its author could
     *  not be read and will not become readable. Null on a confirmation.
     *  TS-union only, no DB CHECK, so a code can be added without a
     *  migration. */
    reasonCode: text("reason_code", {
      enum: [
        "already_engaged",
        "stale",
        "company_page",
        "author_geo_excluded",
        "author_geo_unknown",
        "thin_post",
        "minor",
        "unavailable",
        "not_builder",
        "agency_or_service_seller",
        "corporate_or_big_co",
        "job_seeker",
        "not_audience",
        "empty_room",
        "off_topic",
        "engagement_bait",
        "no_contribution_possible",
      ],
    }),
    reason: text("reason"),
    verifiedBy: text("verified_by", { enum: ["server", "agent", "owner"] }),
    /** The worker run that verified, same contract as
     *  `discovered_posts.worker_run_id`: a plain bigint, no FK, null for
     *  a manual verify. */
    runId: bigint("run_id", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgPostUnq: uniqueIndex("candidate_research_org_post_unq").on(
      t.organizationId,
      t.discoveredPostId,
    ),
    postFk: foreignKey({
      columns: [t.organizationId, t.campaignId, t.discoveredPostId],
      foreignColumns: [
        discoveredPosts.organizationId,
        discoveredPosts.campaignId,
        discoveredPosts.id,
      ],
      name: "candidate_research_org_campaign_post_fk",
    }).onDelete("cascade"),
    // A verdict names who reached it, and a machine rejection always says
    // why. The owner's own rejection needs no code: it is their judgment.
    verdictCheck: check(
      "candidate_research_verdict_check",
      sql`(${t.verdict} is null and ${t.reasonCode} is null and ${t.verifiedBy} is null) or (${t.verdict} = 'confirmed' and ${t.reasonCode} is null and ${t.verifiedBy} is not null) or (${t.verdict} = 'rejected' and ${t.verifiedBy} is not null and (${t.reasonCode} is not null or ${t.verifiedBy} = 'owner'))`,
    ),
  }),
);

/**
 * Which rendered MCP App card currently owns a surface, so exactly one is live.
 *
 * A conversation accumulates cards: each render appends another copy below the
 * last, and every one of them keeps polling and accepting clicks. The newest
 * card claims its surface here on mount; older ones notice on their next poll
 * and collapse. Server-held rather than client-coordinated because sandboxed
 * card iframes get opaque origins, so they cannot see each other at all.
 *
 * Keyed per surface, not per org: a trial card and a Radar card legitimately
 * coexist during setup, two Radar cards never do.
 */
export const mcpAppCardSessions = pgTable(
  "mcp_app_card_sessions",
  {
    organizationId: orgId(),
    /** Widget view name, e.g. "first-radar". */
    surface: text("surface").notNull(),
    /** The latest MINTED grant: the identity a render embedded in its payload.
     *  A grant is a promise of a card, not a card — not every bound tool call
     *  actually mounts a widget (subagent and background-task calls render
     *  nothing), so holding the latest grant confers nothing until the granted
     *  card mounts and its first probe promotes it to the adopted columns. */
    cardId: uuid("card_id").notNull(),
    /** Monotonic per surface, bumped per mint. Render order stays authoritative
     *  between real cards: an older grant can never promote once a newer one
     *  overwrote it here. */
    claimSeq: bigint("claim_seq", { mode: "number" }).notNull().default(1),
    claimedAt: bigint("claimed_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    /** The card actually on screen — the only identity probes stand down
     *  against, the fencing authority for actions, and what readCardSession
     *  reports. Null = no card has ever mounted on this surface. */
    adoptedCardId: uuid("adopted_card_id"),
    adoptedClaimSeq: bigint("adopted_claim_seq", { mode: "number" }),
    /** When the adopted card's first probe promoted it. */
    adoptedAt: bigint("adopted_at", { mode: "number" }),
    /** The candidate the ADOPTED card last reported on screen, written by the
     *  live card's own probes. This is what lets chat resolve "the post open
     *  in my card" — the deck's paging is otherwise client-only state. Only
     *  meaningful alongside adoptedCardId; focusedAt says how fresh it is. */
    focusedPostId: bigint("focused_post_id", { mode: "number" }),
    focusedAt: bigint("focused_at", { mode: "number" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.surface] }),
  }),
);

/** Cycle outcome a runner reports (mirrors the CLI's CycleOutcome). */
export type RunnerOutcome = { ran: boolean; ok: boolean; note: string };

// ============================================================================

// ============================================================================

/**
 * Immutable authority to let one guarded Stripe trial renew. Evidence is scoped
 * to the subscription: an old proof can never unlock a replacement checkout.
 */
export const subscriptionActivations = pgTable(
  "subscription_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    subscriptionId: text("subscription_id").notNull(),
    source: text("source", {
      enum: ["interactive"],
    }).notNull(),

    approvedByUserId: uuid("approved_by_user_id"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    subscriptionUnq: uniqueIndex(
      "subscription_activations_subscription_unq",
    ).on(t.subscriptionId),

    orgCreatedIdx: index("subscription_activations_org_created_idx").on(
      t.organizationId,
      t.createdAt,
    ),
    subscriptionFk: foreignKey({
      columns: [t.organizationId, t.subscriptionId],
      foreignColumns: [subscriptions.organizationId, subscriptions.id],
      name: "subscription_activations_org_subscription_fk",
    }).onDelete("no action"),

    approvedByFk: foreignKey({
      columns: [t.approvedByUserId],
      foreignColumns: [users.id],
      name: "subscription_activations_approved_by_user_fk",
    }).onDelete("no action"),
    sourceCheck: check(
      "subscription_activations_source_check",
      sql`${t.source} = 'interactive' and ${t.approvedByUserId} is not null`,
    ),
  }),
);

/**
 * Reversible human relevance feedback. Each discovered post may have one active
 * verdict per campaign; undo stamps revertedAt instead of deleting history.
 */
export const candidateFeedback = pgTable(
  "candidate_feedback",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    clientMutationId: uuid("client_mutation_id").notNull().defaultRandom(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    discoveredPostId: bigint("discovered_post_id", {
      mode: "number",
    }).notNull(),
    verdict: text("verdict", {
      enum: ["good_match", "not_relevant"],
    }).notNull(),
    reason: text("reason", {
      enum: [
        "wrong_audience",
        "topic_mismatch",
        "already_engaged",
        "too_old",
        "other",
      ],
    }),
    note: text("note"),
    actor: text("actor").notNull(),
    // Exact workflow snapshots make Undo a compare-and-swap instead of a blind
    // status rewrite. Nullable preserves pre-Radar feedback rows; every Phase 5
    // mutation writes the complete pair.
    priorStatus: text("prior_status"),
    priorFilterReason: text("prior_filter_reason"),
    priorSelectedAt: bigint("prior_selected_at", { mode: "number" }),
    expectedStatus: text("expected_status"),
    expectedFilterReason: text("expected_filter_reason"),
    expectedSelectedAt: bigint("expected_selected_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    revertedAt: bigint("reverted_at", { mode: "number" }),
    revertedBy: text("reverted_by"),
  },
  (t) => ({
    campaignCreatedIdx: index("candidate_feedback_org_campaign_created_idx").on(
      t.organizationId,
      t.campaignId,
      t.createdAt,
    ),
    postCreatedIdx: index("candidate_feedback_org_post_created_idx").on(
      t.organizationId,
      t.discoveredPostId,
      t.createdAt,
    ),
    activePostUnq: uniqueIndex(
      "candidate_feedback_org_campaign_post_active_unq",
    )
      .on(t.organizationId, t.campaignId, t.discoveredPostId)
      .where(sql`${t.revertedAt} is null`),
    clientMutationUnq: uniqueIndex(
      "candidate_feedback_org_client_mutation_unq",
    ).on(t.organizationId, t.clientMutationId),
    orgIdUnq: uniqueIndex("candidate_feedback_org_id_uidx").on(
      t.organizationId,
      t.id,
    ),
    postFk: foreignKey({
      columns: [t.organizationId, t.campaignId, t.discoveredPostId],
      foreignColumns: [
        discoveredPosts.organizationId,
        discoveredPosts.campaignId,
        discoveredPosts.id,
      ],
      name: "candidate_feedback_org_campaign_post_fk",
    }).onDelete("cascade"),
  }),
);

/**
 * Reversible user workflow actions that are intentionally separate from the
 * discovery/triage status machine. In particular, Save is presentation-only:
 * an active row removes the opportunity from Today and places it in Saved
 * without inventing another discovered_posts status.
 *
 * Status-changing actions persist both the exact prior state and the state the
 * action wrote. Undo only restores when discovered_posts still equals that
 * expected state, preventing a stale toast from erasing later runner/worker
 * progress.
 */
export const candidateActions = pgTable(
  "candidate_actions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    clientMutationId: uuid("client_mutation_id").notNull().defaultRandom(),
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    discoveredPostId: bigint("discovered_post_id", {
      mode: "number",
    }).notNull(),
    action: text("action", {
      enum: ["save", "dismiss", "request_draft"],
    }).notNull(),
    actor: text("actor").notNull(),
    priorStatus: text("prior_status").notNull(),
    priorFilterReason: text("prior_filter_reason"),
    priorSelectedAt: bigint("prior_selected_at", { mode: "number" }),
    expectedStatus: text("expected_status").notNull(),
    expectedFilterReason: text("expected_filter_reason"),
    expectedSelectedAt: bigint("expected_selected_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    revertedAt: bigint("reverted_at", { mode: "number" }),
    revertedBy: text("reverted_by"),
  },
  (t) => ({
    campaignCreatedIdx: index("candidate_actions_org_campaign_created_idx").on(
      t.organizationId,
      t.campaignId,
      t.createdAt,
    ),
    postCreatedIdx: index("candidate_actions_org_post_created_idx").on(
      t.organizationId,
      t.discoveredPostId,
      t.createdAt,
    ),
    activeActionUnq: uniqueIndex(
      "candidate_actions_org_campaign_post_action_active_unq",
    )
      .on(t.organizationId, t.campaignId, t.discoveredPostId, t.action)
      .where(sql`${t.revertedAt} is null`),
    clientMutationUnq: uniqueIndex(
      "candidate_actions_org_client_mutation_unq",
    ).on(t.organizationId, t.clientMutationId),
    postFk: foreignKey({
      columns: [t.organizationId, t.campaignId, t.discoveredPostId],
      foreignColumns: [
        discoveredPosts.organizationId,
        discoveredPosts.campaignId,
        discoveredPosts.id,
      ],
      name: "candidate_actions_org_campaign_post_fk",
    }).onDelete("cascade"),
  }),
);

// ============================================================================

// ============================================================================

export const brainQuestions = pgTable(
  "brain_questions",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    slot: text("slot", {
      enum: [
        "identity",
        "expertise",
        "positions",
        "stories",
        "audience",
        "goals",
        "avoid",
        "product",
      ],
    }).notNull(),
    question: text("question").notNull(),
    status: text("status", { enum: ["pending", "answered", "skipped"] })
      .notNull()
      .default("pending"),
    answer: text("answer"),
    // When set, this question sharpens a PRODUCT (its answer becomes a product_fact
    // in `productFacet`) rather than a Brain slot. `slot` stays for the column's
    // NOT NULL; product questions use a neutral slot and route by productId.
    productId: bigint("product_id", { mode: "number" }),
    productFacet: text("product_facet", {
      enum: ["what", "audience", "value", "proof", "objections", "links"],
    }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    answeredAt: bigint("answered_at", { mode: "number" }),
  },
  (t) => ({
    orgStatusIdx: index("brain_questions_org_status_idx").on(
      t.organizationId,
      t.status,
    ),
    orgProductIdx: index("brain_questions_org_product_idx").on(
      t.organizationId,
      t.productId,
    ),
  }),
);

export const brainState = pgTable("brain_state", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .default(CURRENT_ORG)
    .references(() => organizations.id, { onDelete: "cascade" }),
  slots: jsonb("slots").$type<Record<BrainSlot, BrainSlotState>>(),
  fillScore: real("fill_score").notNull().default(0),
  // Monotonic version of this org's Brain, upsert-bumped on every real knowledge
  // mutation (store/edit/delete/collapse). Drives COARSE recompile invalidation:
  // when it changes, all active campaigns recompile (sourceHash no-ops the
  // unchanged ones). The row may not exist on first knowledge write, so the bump
  // is an upsert (see brain/knowledge.ts).
  knowledgeVersion: bigint("knowledge_version", { mode: "number" })
    .notNull()
    .default(0),
  // Monotonic version of this org's vault REPLICA (`brain_vault_mirror`), a
  // second counter beside `knowledgeVersion` and never a replacement for it:
  // it moves once per synced batch of FILES, including hand edits made in
  // Obsidian that move no knowledge version at all. The cloud compares it
  // against what it last materialized into its scratch vault.
  mirrorVersion: bigint("mirror_version", { mode: "number" })
    .notNull()
    .default(0),
  updatedAt: bigint("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
});

/**
 * The versioned replica of the owner's vault, one row per note file — the
 * whole of what a cloud tenant can see of a Brain whose canonical copy is the
 * laptop's `~/.engager/brain`. Derived from the files and never the reverse:
 * `packages/core/brain/mirror.ts` is the table's only writer, and the cloud
 * materializes these rows into its scratch vault before every read.
 *
 * `bytes` is the serialized note exactly as it sits on disk, so the digest a
 * brief hashes is the same on both sides — a materializer that re-serializes
 * would move every `sourceHash` and recompile every brief on every sync.
 */
export const brainVaultMirror = pgTable(
  "brain_vault_mirror",
  {
    organizationId: orgId(),
    /** POSIX-separated path relative to the vault root, `4-archive/` included. */
    relativePath: text("relative_path").notNull(),
    /** Digest of the file's RAW bytes, which is what the diff is taken over. */
    sha256: text("sha256").notNull(),
    bytes: text("bytes").notNull(),
    fileMtimeMs: bigint("file_mtime_ms", { mode: "number" }).notNull(),
    /** The `brain_state.mirrorVersion` this row was last written at. */
    mirrorVersion: bigint("mirror_version", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgPathUnique: unique("brain_vault_mirror_org_path_key").on(
      t.organizationId,
      t.relativePath,
    ),
  }),
);

// ============================================================================
// Products (per-org, reusable; attached to campaigns many-to-many)
// ============================================================================
/** A first-class product. Accumulates its own knowledge (product_facts, grouped
 *  by facet) and is attached to campaigns via campaign_products. Lifts product
 *  info out of the per-campaign `tone` blob so it can be reused & enriched. */
export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    name: text("name").notNull(),
    oneLiner: text("one_liner"),
    status: text("status", { enum: ["idea", "beta", "released"] })
      .notNull()
      .default("idea"),
    // Website or repo URL — shown, and used to seed ingestion (scrape site / README).
    link: text("link"),
    // Primary origin of the record (drives the source badge). "obsidian" is a
    // legacy value — no longer produced now that vault sync is gone.
    source: text("source", {
      enum: ["brain", "obsidian", "interview", "manual"],
    })
      .notNull()
      .default("manual"),
    // 0..1, fraction of the 6 facets with ≥1 fact (recomputed on every fact write).
    fillScore: real("fill_score").notNull().default(0),
    // Cached first-campaign suggestion (name/audience/keywords/hashtags), pre-generated
    // during ingest so onboarding's campaign step can prefill instantly instead of waiting
    // on a live LLM call. Recomputed whenever the product is (re)crawled.
    campaignSuggestion: jsonb(
      "campaign_suggestion",
    ).$type<ProductCampaignSuggestion>(),
    // Live ingest progress for the onboarding panel, stamped by handleIngestProduct in
    // its own SHORT txs at real phase boundaries (never inside the crawl tx — those
    // writes wouldn't be visible until the phase commits):
    //   crawling → run queued/reading + extracting the site (requestProductIngestRun
    //   stamps it at enqueue so the wizard shows progress before a worker claims the
    //   job); suggesting → facts committed, drafting the targeting; done → suggestion
    //   cached; failed → dead-lettered.
    ingestStage: text("ingest_stage", {
      enum: ["crawling", "suggesting", "done", "failed"],
    }),
    // Monotonic fence for detached crawl/model work. Link changes advance it;
    // a worker may only apply facts, suggestions, or terminal state for the
    // revision it snapshotted before provider I/O.
    ingestRevision: bigint("ingest_revision", { mode: "number" })
      .notNull()
      .default(0),
    ingestErrorCode: text("ingest_error_code", {
      // TS-union only; the column carries no CHECK, so adding a value is not a
      // migration. `product_ingest_initial_allowance_exhausted` is retained for
      // historical rows: P4 removed the pre-checkout allowance that wrote it,
      // and nothing produces it any more.
      enum: [
        "product_ingest_url_invalid",
        "product_ingest_source_unavailable",
        "product_ingest_extraction_failed",
        "product_ingest_initial_allowance_exhausted",
        "product_ingest_subscription_inactive",
        "product_ingest_job_lease_lost",
      ],
    }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({ orgIdx: index("products_org_idx").on(t.organizationId) }),
);

export type ProductCampaignSuggestion = {
  name: string;
  audience: string;
  keywords: string[];
  hashtags: string[];
};

/** Knowledge for one product, grouped by facet. Mirrors `knowledge` (content-hash
 *  dedupe + optional embedding) so the same ingestion pipeline applies. */
export const productFacts = pgTable(
  "product_facts",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    facet: text("facet", {
      enum: ["what", "audience", "value", "proof", "objections", "links"],
    }).notNull(),
    content: text("content").notNull(),
    source: text("source", {
      enum: ["obsidian", "interview", "manual", "linkedin", "web"],
    }).notNull(),
    sourcePath: text("source_path"),
    contentHash: text("content_hash").notNull(),

    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgHashUnq: uniqueIndex("product_facts_org_hash_unq").on(
      t.organizationId,
      t.contentHash,
    ),
    orgProductFacetIdx: index("product_facts_org_product_facet_idx").on(
      t.organizationId,
      t.productId,
      t.facet,
    ),
  }),
);

/** Many-to-many link between campaigns and products. */
export const campaignProducts = pgTable(
  "campaign_products",
  {
    organizationId: orgId(),
    campaignId: bigint("campaign_id", { mode: "number" })
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.campaignId, t.productId] }) }),
);

/**
 * What a product offers, in the words the owner approved — the one thing an
 * offer DM may share (spec §14 R14): its link, what it is, and the facts a
 * message may state about it. One per product; a campaign's
 * `cta.cta_asset_id` names it as `product:<id>`, the reference a designed
 * campaign already counts its outcomes against.
 *
 * The approval is of exact words: `approved_hash` is the `content_hash` the
 * owner said yes to, so words saved since wait for a fresh yes and resolve as
 * no offer at all. A retired offer resolves as none too; its row stays, so
 * what an offer DM rested on stays readable.
 */
export const offers = pgTable(
  "offers",
  {
    id: serial("id").primaryKey(),
    organizationId: orgId(),
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** What the offer is, in a line: "a 14-day pilot of Engager". */
    what: text("what").notNull(),
    /** Everything a message may say about it, and nothing more. */
    facts: jsonb("facts").$type<string[]>().notNull(),
    contentHash: text("content_hash").notNull(),
    approvedHash: text("approved_hash"),
    approvedBy: text("approved_by"),
    approvedAt: bigint("approved_at", { mode: "number" }),
    retiredAt: bigint("retired_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgProductKey: unique("offers_org_product_key").on(
      t.organizationId,
      t.productId,
    ),
  }),
);

export type Offer = typeof offers.$inferSelect;

/** Stripe webhook idempotency — dedupe on event.id. GLOBAL (not org-scoped):
 *  webhooks arrive with no org context, like `subscriptions`. */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(), // Stripe event id (evt_...)
  type: text("type").notNull(),
  processedAt: bigint("processed_at", { mode: "number" })
    .notNull()
    .$defaultFn(nowMs),
});

/**
 * Short provider-fetch lease. Stripe HTTP happens while this durable lease is
 * held but outside any database transaction; the canonical projection itself is
 * a short transaction. Expiry makes a crashed serverless invocation recoverable.
 */
export const stripeProjectionLeases = pgTable(
  "stripe_projection_leases",
  {
    subscriptionId: text("subscription_id").primaryKey(),
    leaseToken: uuid("lease_token").notNull(),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    expiryIdx: index("stripe_projection_leases_expiry_idx").on(
      t.leaseExpiresAt,
    ),
  }),
);

// ----------------------------------------------------------------------------
// AI usage telemetry (debug/observability) — one append-only row per LLM /
// embedding API call, captured at the client chokepoints. NOT RLS-protected and
// NOT defaulted to the current-org GUC:
// rows are flushed AFTER the handler's withOrg tx closes (on the base pool), so
// the org is stamped explicitly from the usage context. Like `jobs`, it lives
// outside tenant isolation — keep it out of RLS_TABLES.
// ----------------------------------------------------------------------------
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: serial("id").primaryKey(),
    // Nullable, explicit (no CURRENT_ORG default): set from the usage context, or
    // NULL for calls made outside any org scope (scripts). FK set-null preserves
    // telemetry if the org is later deleted.
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(), // "anthropic" | "openai"
    // Which agent CLI served the call ("claude" | "codex" | …), or NULL when the
    // call went to the provider directly (the API backend, the embedder). The
    // provider alone no longer identifies the caller: two agents can front the
    // same vendor, and the owner's subscription pays for one of them.
    agentId: text("agent_id"),
    // Requested and observed identity remain distinct; absent native usage is
    // null here even though legacy aggregate token columns default to zero.
    localAgentReport: jsonb("local_agent_report").$type<{
      requestedModel: string;
      actualReportedModel: string | null;
      usage: Record<string, number> | null;
    }>(),
    model: text("model").notNull(),
    operation: text("operation").notNull(), // "text" | "json" | "embed"
    stage: text("stage"), // logical step: filter | writer | reply | distill | discover | brain.assess | …
    promptRef: text("prompt_ref"), // stable call-site id@version, e.g. "writer.comment@1"
    source: text("source"), // "worker" | "mcp" | "action" | "script"
    // Request/credential attribution lets operators join a provider call back to
    // the exact MCP key and deterministic request phase without storing prompt
    // contents.
    credentialKeyId: text("credential_key_id"),
    requestId: text("request_id"),
    requestPhase: integer("request_phase"),
    spendReservationId: uuid("spend_reservation_id"),
    jobId: bigint("job_id", { mode: "number" }),
    campaignId: bigint("campaign_id", { mode: "number" }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    // Cost in micro-USD (USD × 1e6) to avoid float drift; NULL when the model is
    // not in the price map (so an unknown model never silently reports $0).
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }),
    latencyMs: integer("latency_ms"),
    ok: boolean("ok").notNull().default(true), // did the API call itself succeed
    errorKind: text("error_kind"), // api_429 | max_tokens | schema_fail | … (post-call issues too)
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgCreatedIdx: index("ai_usage_org_created_idx").on(
      t.organizationId,
      t.createdAt,
    ),
    modelCreatedIdx: index("ai_usage_model_created_idx").on(
      t.model,
      t.createdAt,
    ),
    jobIdx: index("ai_usage_job_idx").on(t.jobId),
    reservationIdx: index("ai_usage_spend_reservation_idx").on(
      t.spendReservationId,
    ),
    requestPhaseCheck: check(
      "ai_usage_request_phase_check",
      sql`${t.requestPhase} is null or ${t.requestPhase} > 0`,
    ),
  }),
);

/**
 * Per-org provider circuit. Five consecutive failures against one provider
 * open it for fifteen minutes. Durable because a provider outage must not
 * become a retry storm the moment a worker process restarts.
 */
export const cloudProviderCircuits = pgTable(
  "cloud_provider_circuits",
  {
    organizationId: orgId(),
    provider: text("provider").notNull(),
    periodStart: bigint("period_start", { mode: "number" }).notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    openedAt: bigint("opened_at", { mode: "number" }),
    openUntil: bigint("open_until", { mode: "number" }),
    lastFailureKind: text("last_failure_kind"),
    lastFailureAt: bigint("last_failure_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.provider] }),
    countersCheck: check(
      "cloud_provider_circuits_counters_check",
      sql`${t.consecutiveFailures} >= 0 and ${t.provider} <> ''`,
    ),
  }),
);

// ----------------------------------------------------------------------------
// Convenience type exports
// ----------------------------------------------------------------------------
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type User = typeof users.$inferSelect;
export type Voice = typeof voices.$inferSelect;
export type NewVoice = typeof voices.$inferInsert;
export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type CampaignStrategyRow = typeof campaignStrategies.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type DiscoveredPost = typeof discoveredPosts.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type IncomingComment = typeof incomingComments.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Exemplar = typeof exemplars.$inferSelect;
export type Profile = typeof profile.$inferSelect;

export type BrainQuestion = typeof brainQuestions.$inferSelect;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductFact = typeof productFacts.$inferSelect;
export type NewProductFact = typeof productFacts.$inferInsert;
export type CampaignProduct = typeof campaignProducts.$inferSelect;

export type CandidateFeedback = typeof candidateFeedback.$inferSelect;
export type NewCandidateFeedback = typeof candidateFeedback.$inferInsert;

export type AiUsage = typeof aiUsage.$inferSelect;
export type NewAiUsage = typeof aiUsage.$inferInsert;
// ============================================================================
// Dashboard chat — agent chat sessions and transcripts (local dashboard host)
// ============================================================================

/**
 * One dashboard-chat conversation. `claudeSessionId` is the claude CLI session
 * resumed with `--resume` on every later turn; null until the first turn's
 * init event confirms it.
 */
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    /** First user message, truncated — the list label. */
    title: text("title"),
    claudeSessionId: uuid("claude_session_id"),
    /** Canonical broker history never resumes a native agent session. */
    agentReference: jsonb("agent_reference").$type<Record<string, unknown>>(),
    /** The person this chat was opened for. Kept if the conversation disappears so
     *  reopening it reports unavailable instead of silently changing scope. */
    personConversationId: bigint("person_conversation_id", { mode: "number" }),
    /** The owner's box a draft conversation writes in, and the angle every
     *  version it writes lands on (`composer/drafts.ts`). Null for a
     *  conversation that is no draft's; the position stays null until the
     *  first version lands. */
    boxKey: text("box_key"),
    boxPosition: integer("box_position"),
    /** Who that draft is for, as History names it. */
    personName: text("person_name"),
    createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
    lastMessageAt: bigint("last_message_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    recencyIdx: index("chat_sessions_org_recency_idx").on(
      t.organizationId,
      t.lastMessageAt,
    ),
    // Composite target for the same-org FK from chat_messages. A table-level
    // UNIQUE constraint (not uniqueIndex) so it lands inside CREATE TABLE,
    // ahead of the FK ALTER in the same generated migration.
    orgIdUnique: unique("chat_sessions_org_id_key").on(t.organizationId, t.id),
  }),
);

/**
 * Persisted transcript rows: one AI SDK UIMessage each (parts JSON verbatim —
 * text, reasoning, dynamic-tool, data parts). The message id is the natural
 * key so a full-transcript rewrite after each turn is an idempotent upsert.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    /** UIMessage.id (AI SDK generated). */
    id: text("id").notNull(),
    organizationId: orgId(),
    sessionId: uuid("session_id").notNull(),
    /** Position in the transcript. */
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    parts: jsonb("parts").$type<unknown[]>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.sessionId, t.id] }),
    seqIdx: index("chat_messages_session_seq_idx").on(
      t.organizationId,
      t.sessionId,
      t.seq,
    ),
    sessionFk: foreignKey({
      columns: [t.organizationId, t.sessionId],
      foreignColumns: [chatSessions.organizationId, chatSessions.id],
      name: "chat_messages_session_fk",
    }).onDelete("cascade"),
  }),
);

export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

/** Prepared external judgments and native observations. Receipts are portable
 * evidence, never credentials or permission to replay an external effect. */
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: orgId(),
  credentialBinding: text("credential_binding").notNull(),
  kind: text("kind").notNull(),
  context: jsonb("context").$type<Record<string, unknown>>().notNull(),
  contextRevision: text("context_revision").notNull(),
  status: text("status", { enum: ["awaiting_agent", "completed", "canceled", "expired"] }).notNull().default("awaiting_agent"),
  receipts: jsonb("receipts").$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
});

/** One cross-process conversation claim. An unresolved dispatched step blocks
 * new inference until core receipt reconciliation, even after process exit. */
export const chatBrokerTurns = pgTable("chat_broker_turns", {
  id: uuid("id").primaryKey(),
  organizationId: orgId(),
  sessionId: uuid("session_id").notNull(),
  credentialBinding: text("credential_binding").notNull(),
  requestHash: text("request_hash").notNull(),
  selection: jsonb("selection").$type<Record<string, unknown>>().notNull(),
  status: text("status", { enum: ["running", "completed", "canceled", "failed", "recovery_required"] }).notNull(),
  history: jsonb("history").$type<unknown[]>().notNull().default([]),
  steps: jsonb("steps").$type<unknown[]>().notNull().default([]),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
}, (t) => ({
  sessionFk: foreignKey({ columns: [t.organizationId, t.sessionId], foreignColumns: [chatSessions.organizationId, chatSessions.id] }),
  active: uniqueIndex("chat_broker_turns_active").on(t.organizationId, t.sessionId).where(sql`${t.status} in ('running', 'recovery_required')`),
}));

/**
 * ONE change the chat agent PROPOSED, which only an owner's click can apply.
 *
 * Chat reads third-party text now — incoming comments, the inbox, the body of a
 * discovered post — so "do this only after the owner says yes" cannot be a
 * sentence in a prompt: a prompt-only rule is one injected line away from a
 * voice rewrite or a blocklist edit. The model therefore gets no write tool for
 * any of these kinds at all. It gets `propose_change`, which validates the
 * payload with the same schema the real operation uses, reads `before` off
 * canonical state, and writes THIS ROW. Nothing in the product has moved when
 * it returns.
 *
 * The row is what the owner's click spends, and it is spendable exactly once:
 * `status` leaves `pending` under a `for update` lock, so a double-click, a
 * replayed request and a second model turn all find it already decided.
 * `sessionId` and the org scope bound WHERE it can be spent — a proposal made
 * in one conversation is inert in another and invisible to another tenant —
 * and `expiresAt` bounds WHEN, because a before/after the owner reads half an
 * hour later is a description of a decision they are no longer making.
 *
 * NOT `tasks`, which fits on paper — frozen context, a revision, a
 * status, an expiry. That table is reachable from chat: `get_task`,
 * `finish_task` and `cancel_task` are all on the
 * broker's own allowlist, so a pending change living there would be a pending
 * change the model can address by id. The whole point of the row is that no
 * model turn can reach it, and a separate table is the only version of that
 * which does not rest on another tool's argument validation.
 *
 * `before` is stored rather than re-derived because it is what the owner was
 * SHOWN. Apply re-reads canonical state and compares: a row that moved since
 * the card was drawn is refused `stale` rather than overwritten, which is the
 * one failure a before/after card can otherwise cause silently.
 *
 * NO SWEEP, for the reason `chat_broker_turns` has none: growth is bounded by
 * the conversation. A decided row is one row, a proposal is at most one per
 * model step of one turn, and the session FK cascades — deleting a
 * conversation takes its cards with it. An expired row is left where it is on
 * purpose, because "this card expired" is the honest answer to a click on it
 * and a swept row would answer "this card belongs to a different conversation".
 *
 * ONE KIND IS PROPOSED OUTSIDE CHAT TOO. A `strategy.patch` that widens what
 * a campaign may do waits here whoever asked for it — chat, the owner's own
 * agent over MCP, or an old writer redirected into the patch — because the
 * confirmation is the owner's click wherever the request came from (INV-26).
 * Such a row has no conversation: `sessionId` and `turnId` are null, and only
 * a click that names no conversation can spend it.
 */
export const chatPendingChanges = pgTable(
  "chat_pending_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    /** Null on a proposal made outside chat (see above). */
    sessionId: uuid("session_id"),
    /** The broker turn that proposed it — provenance, and how the turn's own
     *  final learns that its proposal is still undecided. Null outside chat. */
    turnId: uuid("turn_id"),
    /** The discriminator from `packages/core/chat/proposalKinds.ts`. Text, not
     *  an enum: a new kind is a code release, and a pg enum would make it a
     *  migration too. */
    kind: text("kind").notNull(),
    /** The VALIDATED change, as the kind's own schema parsed it. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Canonical state when the card was drawn, never the model's account of
     *  it. Apply refuses when it no longer matches. */
    before: jsonb("before").$type<Record<string, unknown>>().notNull(),
    /** The card, authored by the server: its level, its title, its before →
     *  after rows and the page that owns the setting. The model's prose sits
     *  beside this and cannot edit it. */
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    /** `already_there` is an APPLIED decision whose operation found the change
     *  was already made — the Brain dedupes a note on content, so a card the
     *  owner answered can legitimately write nothing. It is spent either way.
     *  `conflict` is a `strategy.patch` whose base version was replaced
     *  before the click: `outcome` carries the fresh diff. */
    status: text("status", {
      enum: [
        "pending",
        "applied",
        "already_there",
        "declined",
        "stale",
        "expired",
        "conflict",
      ],
    })
      .notNull()
      .default("pending"),
    /** What the apply recorded, or why it refused. */
    outcome: jsonb("outcome").$type<Record<string, unknown> | null>(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    decidedAt: bigint("decided_at", { mode: "number" }),
  },
  (t) => ({
    sessionFk: foreignKey({
      columns: [t.organizationId, t.sessionId],
      foreignColumns: [chatSessions.organizationId, chatSessions.id],
      name: "chat_pending_changes_session_fk",
    }).onDelete("cascade"),
    sessionIdx: index("chat_pending_changes_session_idx").on(
      t.organizationId,
      t.sessionId,
      t.createdAt,
    ),
    /** Every FINAL of every turn asks whether this turn left a card
     *  unanswered, so the `turn_id` read is on the hot path in a way the
     *  session read is not. */
    turnIdx: index("chat_pending_changes_turn_idx").on(
      t.organizationId,
      t.turnId,
    ),
  }),
);

export type ChatPendingChange = typeof chatPendingChanges.$inferSelect;
export type NewChatPendingChange = typeof chatPendingChanges.$inferInsert;

/**
 * One row per worker run — the legible record the owner reads when they ask
 * "what did this thing actually do".
 *
 * Counters are what the server WROTE, never what a model reported: a summary is
 * not evidence. `rejectedCount` (slop / diversity / validation) and
 * `capRefusedCount` (the ledger said no) stay separate on purpose — "I stopped
 * at my own limit" and "your caps refused me" are different answers, and
 * collapsing them makes the log lie.
 */
export const workerRuns = pgTable(
  "worker_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    /** The worker that ran. */
    workerId: bigint("worker_id", { mode: "number" }).notNull(),
    /** Snapshot, not a live join: the caps attribution. */
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    /**
     * Snapshot too, and the LOCK KEY — what the run lock guards is one browser
     * profile on one real account, not a campaign. No FK, exactly like the
     * campaign id beside it.
     */
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    // Five ways a run starts, and the owner is entitled to tell them apart:
    // `manual` is a button THEY pressed, `agent` is their agent pressing it for
    // them (setup's first sweep, a chat "run it now"), `schedule` is the server
    // waking the worker, `event` is the server waking the Ambassador's
    // conversation work — a reply on a conversation, or a wait that expired — and
    // `match` is the server waking the Ambassador right after a Scout run
    // confirmed what its steps start on (`workers/matchWake.ts`).
    // Labelling an agent's press "Manual" told the owner they had done
    // something they had not.
    trigger: text("trigger", {
      enum: ["schedule", "manual", "agent", "event", "match"],
    }).notNull(),
    /**
     * The one press this run answers, when a campaign's Run now woke several
     * workers at once: every run that press enqueued carries the same id, so
     * the campaign can say what the press did — found, matched, drafted — as
     * one answer rather than as whichever worker happened to finish last.
     * Null on every run nothing grouped: a schedule's, an event's, a single
     * worker's press.
     */
    pressId: text("press_id"),
    /**
     * A test before Start (`runCampaignTestOp`): one run of the Scout on a
     * campaign not started yet, which finds and triages and does nothing
     * else. Stamped from the payload on whatever row the run writes, a skip
     * included, so Runs can mark it and Overview can say what it found.
     */
    isTest: boolean("is_test").notNull().default(false),
    /** External judgment waits without holding the account execution lease. */
    agentTaskStatus: text("agent_task_status", { enum: ["awaiting_agent", "completed", "canceled", "expired"] }),
    /**
     * `interrupted` is a run the machine slept through: it stopped where the
     * sleep left it, kept every row it wrote, and its job runs the same wake
     * again once the machine is awake (`supervision/suspension.ts`). Neither a
     * failure nor an account problem, so it carries no `error`. A run Engager
     * was quit in the middle of closes the same way as it starts again, its
     * `error` the one note that says so (`releaseRunsLeftRunning`). No CHECK
     * binds the set, so a member costs no migration.
     */
    status: text("status", {
      enum: ["running", "succeeded", "partial", "failed", "skipped", "interrupted"],
    }).notNull(),
    /**
     * Set only on `skipped` — this IS the answer to "why didn't it run".
     *
     * Every member must be a reason some code path actually WRITES. This is
     * runtime text, not documentation (INV-8): `references/runs.md` and the
     * `get_run` description enumerate these verbatim and tell the
     * owner's agent to act on whichever it reads, so a member nothing writes
     * sends that agent looking for an answer the server can never give.
     * `not_entitled`, `no_candidates` and `caps_exhausted` were exactly that,
     * for their whole life, and were removed rather than implemented.
     * `outside_window` left the other way: the run stopped skipping on a closed
     * window (T-7.6), so the member lost its writer and went with it.
     *
     * A plain `text` column with no value CHECK — the only CHECK on it binds a
     * reason to `status = 'skipped'` — so the set is a TypeScript type and
     * changing it costs no migration.
     */
    skipReason: text("skip_reason", {
      enum: [
        "authority_elsewhere",
        "backlog",
        "campaign_locked",
        "campaign_stopped",
        "channel_not_connected",
        "connector_unsupported",
        "conversation_not_runnable",
        "kill_switch",
        "leads_off",
        "nothing_needed",
        "organization_paused",
        "target_paused",
      ],
    }),
    /** Where the chain got to; also where a wall-clock timeout closed it. A
     *  Find leads run walks sweep to done instead of discover to verify, and
     *  screens too in a test and a first look's round. */
    phase: text("phase", {
      enum: [
        "discover",
        "triage",
        "verify",
        "draft",
        "publish",
        "converse",
        "sweep",
        "screen",
        "research",
        "qualify",
        "serve",
        "done",
      ],
    }),
    startedAt: bigint("started_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    finishedAt: bigint("finished_at", { mode: "number" }),

    /**
     * How many comments the ACCOUNT needed written when this run sized itself —
     * `computeCommentDemand`'s answer at the run's own clock, and a row the
     * server wrote (INV-2) rather than a number a model reported about its work.
     *
     * THE COMMENT DEMAND, and deliberately only that one. A run reads three
     * things called demand: what the campaign's pool needs curated, whether a
     * find is any part of that answer, and what the account needs written.
     * `demand.ts` composes none of them and neither does this column — curation
     * counts candidates to judge and this counts comments to write, so one
     * integer holding their sum would have no unit. This is the one an owner
     * means when they ask what the worker was for, and on a SCHEDULED run it is
     * the number `get_status` gives for the same account at the instant.
     *
     * 0 has two causes and the worker's own stage switches say which: a run
     * whose draft stage is off never asked the question, and a run whose draft
     * stage is on was told the account is already supplied. On a `skipped` row
     * it is 0 because no stage was ever sized, and `skip_reason` is beside it.
     *
     * 1 has two causes on a MANUAL row and this column cannot separate them,
     * which is stated rather than papered over: a press asks for `max(1, what
     * the plan wanted)`, and `max(1, 1)` is 1 either way. `trigger` says the
     * floor MAY have applied, never that it did. The unfloored question has an
     * answer — it is what `get_status` gives — and nothing on this row is
     * it.
     */
    demandCount: integer("demand_count").notNull().default(0),
    draftedCount: integer("drafted_count").notNull().default(0),
    publishedCount: integer("published_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    capRefusedCount: integer("cap_refused_count").notNull().default(0),
    /**
     * Which round of a Quick campaign's first look this run was, 1 to 3, and
     * null on every other run. Stamped at the run's birth, and on a skip whose
     * payload named one, so a run page reads its round and the first look
     * reads its own progress off rows rather than a table of its own
     * (`workers/firstLook.ts`).
     */
    firstLookRound: integer("first_look_round"),
    /**
     * The posts this round's first-look step put a draft in, best match
     * first — each draft lives in its post's comment box, not here. Empty on
     * every run that drafted none, which is every round after the first.
     */
    firstLookPostIds: bigint("first_look_post_ids", { mode: "number" })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    /**
     * The strategy steps this run served — "ran by Ambassador · Handle a
     * reply". The catalog step's id on a campaign that does not run on its
     * strategy, where the step id IS the catalog's (the seeder names them
     * so). Stamped at close from what the run did, never from what it was
     * armed for.
     */
    servedStepIds: text("served_step_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The Ambassador's conversation work (INV-3): the conversations the SERVER
     * picked for this run before any model call, frozen here at the run's
     * birth. A step works one of these and nothing else, and the run's
     * "conversations selected" is counted from this, so a run stopped or
     * crashed before it worked them still says how many it chose. What the
     * steps then did is counted over `step_runs` and `step_tool_calls`
     * (`agentStep/runSums.ts`).
     */
    frozenConversationIds: bigint("frozen_conversation_ids", { mode: "number" })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    /**
     * A Find leads run (lead mode): the depth it read at, stamped so its page
     * prints "Find leads · Standard" whatever the campaign says later, and
     * what it did, each count a row the server wrote or accepted (INV-2) and
     * none a number a model returned. Null and 0 on every other run.
     *
     * Found is people with an accepted screen verdict, so Found = Screened in
     * + the six drops; Researched = Buyers + Not a fit + Peers and
     * competitors + Partner. The three reads are the account's, counted from
     * the pages and reads the ledger reserved.
     */
    searchDepth: text("search_depth", { enum: SEARCH_DEPTHS }),
    leadReadCount: integer("lead_read_count").notNull().default(0),
    leadFoundCount: integer("lead_found_count").notNull().default(0),
    leadScreenedInCount: integer("lead_screened_in_count").notNull().default(0),
    leadResearchedCount: integer("lead_researched_count").notNull().default(0),
    leadResearchDeferredCount: integer("lead_research_deferred_count").notNull().default(0),
    leadServedAskingCount: integer("lead_served_asking_count").notNull().default(0),
    leadServedProblemCount: integer("lead_served_problem_count").notNull().default(0),
    leadServedTopicCount: integer("lead_served_topic_count").notNull().default(0),
    leadMergedCount: integer("lead_merged_count").notNull().default(0),
    leadDropNoWordsCount: integer("lead_drop_no_words_count").notNull().default(0),
    leadDropNotAudienceCount: integer("lead_drop_not_audience_count").notNull().default(0),
    leadDropSellingCount: integer("lead_drop_selling_count").notNull().default(0),
    leadDropSolvedCount: integer("lead_drop_solved_count").notNull().default(0),
    leadDropRecruiterCount: integer("lead_drop_recruiter_count").notNull().default(0),
    leadDropStudentCount: integer("lead_drop_student_count").notNull().default(0),
    leadBuyerCount: integer("lead_buyer_count").notNull().default(0),
    leadNotFitCount: integer("lead_not_fit_count").notNull().default(0),
    leadPeerCount: integer("lead_peer_count").notNull().default(0),
    leadPartnerCount: integer("lead_partner_count").notNull().default(0),
    searchPagesCount: integer("search_pages_count").notNull().default(0),
    threadReadsCount: integer("thread_reads_count").notNull().default(0),
    profileReadsCount: integer("profile_reads_count").notNull().default(0),
    error: text("error"),
    /** Safe agent refusal context from this attempt; never raw CLI output. */
    agentFailure: jsonb("agent_failure").$type<{ reason: "quota_exhausted" | "authentication_required" | "agent_timeout"; adapterId?: string; resetsAt?: number }>(),
    /** Exact queue attempt source; no FK so run history survives queue retention. */
    jobId: bigint("job_id", { mode: "number" }),
  },
  (t) => ({
    // Repointed at `workers` in T-8.3, because that is where a worker now
    // exists: the split mints scouts with no source row, and the source table
    // has no shape for a worker that finds and does not write. The ids are one
    // space (`workers.id` defaults from `workers_id_seq`), so every
    // existing run row validates against the new parent unchanged. `cascade`
    // survives with it — `deleteWorker` removes both rows, so a deleted
    // worker still takes its run log.
    workerFk: foreignKey({
      columns: [t.organizationId, t.workerId],
      foreignColumns: [workers.organizationId, workers.id],
      name: "worker_runs_org_worker_fk",
    }).onDelete("cascade"),
    historyIdx: index("worker_runs_org_worker_started_idx").on(
      t.organizationId,
      t.workerId,
      t.startedAt,
    ),
    // Built as the composite target for messages.worker_run_id, and NOTHING
    // references it: that fk turned out to be unbuildable (see the column's own
    // comment — composite `set null` also nulls the NOT NULL tenant key, and
    // `no action` aborts a campaign delete), so the column is a soft ref.
    // Kept rather than dropped: it is a legitimate tenant-scoped uniqueness
    // guarantee, and dropping it is a destructive migration bought for nothing.
    orgIdUnique: unique("worker_runs_org_id_key").on(
      t.organizationId,
      t.id,
    ),
    // The structural half of the channel run lock: the LEASE gives liveness
    // (TTL self-heal), this gives a truth the ledger can never contradict —
    // two concurrent runs on one ACCOUNT cannot both be recorded. Keyed per
    // campaign until T-4.6, which let two campaigns on one channel run at once
    // and hand two writers the same browser profile.
    oneRunningPerChannel: uniqueIndex("worker_runs_org_channel_running_key")
      .on(t.organizationId, t.channelId)
      .where(sql`status = 'running'`),
    openRunCheck: check(
      "worker_runs_open_run_check",
      sql`(${t.status} = 'running') = (${t.finishedAt} is null)`,
    ),
    skipReasonCheck: check(
      "worker_runs_skip_reason_check",
      sql`${t.skipReason} is null or ${t.status} = 'skipped'`,
    ),
    countsCheck: check(
      "worker_runs_counts_check",
      sql`${t.demandCount} >= 0 and ${t.draftedCount} >= 0 and ${t.publishedCount} >= 0 and ${t.rejectedCount} >= 0 and ${t.capRefusedCount} >= 0`,
    ),
    leadCountsCheck: check(
      "worker_runs_lead_counts_check",
      sql`${t.leadReadCount} >= 0 and ${t.leadFoundCount} >= 0 and ${t.leadScreenedInCount} >= 0
        and ${t.leadResearchedCount} >= 0 and ${t.leadResearchDeferredCount} >= 0
        and ${t.leadServedAskingCount} >= 0 and ${t.leadServedProblemCount} >= 0 and ${t.leadServedTopicCount} >= 0
        and ${t.leadMergedCount} >= 0 and ${t.leadDropNoWordsCount} >= 0 and ${t.leadDropNotAudienceCount} >= 0
        and ${t.leadDropSellingCount} >= 0 and ${t.leadDropSolvedCount} >= 0 and ${t.leadDropRecruiterCount} >= 0 and ${t.leadDropStudentCount} >= 0
        and ${t.leadBuyerCount} >= 0 and ${t.leadNotFitCount} >= 0 and ${t.leadPeerCount} >= 0
        and ${t.leadPartnerCount} >= 0 and ${t.searchPagesCount} >= 0 and ${t.threadReadsCount} >= 0
        and ${t.profileReadsCount} >= 0`,
    ),
    searchDepthCheck: check(
      "worker_runs_search_depth_check",
      sql`${t.searchDepth} is null or ${t.searchDepth} in ('quick', 'standard', 'deep')`,
    ),
  }),
);

export type WorkerRun = typeof workerRuns.$inferSelect;
export type NewWorkerRun = typeof workerRuns.$inferInsert;

/**
 * A WORKER. One row per thing that does a job on one account.
 *
 *   what it is      `kind`                  scout · ambassador (later:
 *                                           writer). T-8.4 retypes this
 *                                           property and gives it a CHECK.
 *   where it acts   `channelId`             one account; it spends that
 *                                           account's budget and no other's
 *                                           (INV-4)
 *   who thinks      `agentId` + `model`     null on both = the role map's
 *                                           default, which is what every row
 *                                           resolved before this column existed
 *   what it does    the step switches       each one on or off
 *   how it runs     Run now                 always, whatever `enabled` says
 *                   `enabled`               whether the server ALSO wakes it.
 *                                           T-8.2 renames this property `auto`
 *                                           and says so in one place
 *   what it did     `worker_runs`       one log, every trigger (INV-5)
 *   what it made    the rows it wrote       messages, candidates
 *
 * `WorkerRow`, not `Worker`: `jobs/worker.ts` already owns that noun for the
 * job-queue process, and a bare `Worker` would shadow half its vocabulary in
 * every mixed import.
 */
export const workers = pgTable(
  "workers",
  {
    /** Shared worker id sequence. */
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .default(sql`nextval('workers_id_seq')`),
    organizationId: orgId(),
    /**
     * The campaign this worker works — nullable here, unlike the source table
     * where it is the defining pointer, though no worker row is created
     * without one. The Ambassador writes on the matches its own campaign's Scout found, never
     * another campaign's on the account, so the pointer defines both.
     */
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      { onDelete: "cascade" },
    ),
    /**
     * The account this worker acts on. Backfilled through
     * `campaigns.channelId`, which is where channel scope has ridden since
     * Phase 4 — naming it here is what stops a worker implying its account
     * from whatever target it happens to point at.
     */
    channelId: bigint("channel_id", { mode: "number" }),
    name: text("name").notNull(),
    /**
     * WHAT IT IS. The physical column is `kind` and stays `kind` — the lint
     * forbids the rename — but the property is `type`, because a discriminator
     * called `kind` beside a `WorkerType` union reads as two ideas.
     *
     * `responder` and `writer` join the enum AND the CHECK in the landings that
     * build them, never before: a constraint that admits a type nothing can run
     * lets a row exist that every consumer's switch falls through. Widening a
     * CHECK is one additive migration; the cost of admitting early is a runtime
     * `default:` branch nobody wrote.
     */
    type: text("kind", { enum: ["scout", "ambassador"] })
      .notNull()
      .default("ambassador"),
    /**
     * Whether the server ALSO wakes this worker. Never whether Run now works.
     *
     * Physical name kept, property renamed, because the old name invited the
     * old docstring — a master switch that made the row do nothing at all,
     * which the code has never done and the skill has always contradicted.
     *
     * Its two legitimate readers, both schedule-side: the due query
     * (`operations/workers.ts` `dueWorkers`) and the wake re-arm
     * (`jobs/handlers/workerRun.ts`), which take it as `WorkerAutoFields`
     * and nothing wider. That shape is what stops the column being HANDED to a
     * manual path; it cannot stop one selecting the column directly, so the
     * property that a press ignores Auto is held by a test, not by the types.
     */
    auto: boolean("enabled").notNull().default(false),
    /**
     * The support-matrix agent id — `claude`, `codex` — this worker's thinking
     * runs on. Null = the role map decides, which is what `modelFor.ts`
     * reserved the room for.
     */
    agentId: text("agent_id"),
    /** Model override. Null = the role map's default for the resolved agent. */
    model: text("model"),
    /**
     * Per-type configuration the columns above do not name. Empty object, never
     * null, so a reader never distinguishes "no config" from "no row".
     */
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    sweepEnabled: boolean("sweep_enabled").notNull().default(true),
    draftEnabled: boolean("draft_enabled").notNull().default(false),
    /**
     * THE AMBASSADOR'S PERSON-TO-PERSON WORK — Handle a reply, Connect,
     * Continue in DMs, Check outcome — on the Ambassador row, which is the
     * Ambassador's row (Ambassador and Responder merged, 2026-10-11). There is
     * never a responder row, so this column is what one would have carried.
     *
     * A projection like the two above, written only by activating the
     * campaign's strategy (`strategy/project.ts`, INV-25), and false on
     * every row of an unflagged campaign. Its sends wait for the owner's yes
     * (`agentStep/wake.ts`). A run armed for it whose
     * campaign cannot serve it — its strategy unreadable, or stopped —
     * records `conversation_not_runnable`.
     */
    conversationEnabled: boolean("conversation_enabled")
      .notNull()
      .default(false),

    lastRunAt: bigint("last_run_at", { mode: "number" }),
    nextRunAt: bigint("next_run_at", { mode: "number" }),
    /** Why the server stopped running this on its own (never a user setting). */
    pausedReason: text("paused_reason"),

    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgCampaignIdx: index("workers_org_campaign_idx").on(
      t.organizationId,
      t.campaignId,
    ),
    orgChannelIdx: index("workers_org_channel_idx").on(
      t.organizationId,
      t.channelId,
    ),
    dueIdx: index("workers_org_next_run_idx").on(
      t.organizationId,
      t.nextRunAt,
    ),
    // The owner's handle on the row — two workers called "Morning sweep" make
    // the run log unreadable.
    orgNameUnique: unique("workers_org_name_key").on(
      t.organizationId,
      t.name,
    ),
    // The composite target a same-org FK from the run log will use when the
    orgIdUnique: unique("workers_org_id_key").on(t.organizationId, t.id),
    // Same reasoning as `campaigns_org_channel_fk`: a plain fk on `channel_id`
    // cannot tell that the channel belongs to the WORKER'S org, and the writers
    // most likely to get that wrong are the ones RLS does not cover. MATCH
    // SIMPLE skips the check while the column is NULL, which is what an
    // additive nullable pointer wants. NO ACTION on delete, because detaching
    // the budget owner silently is worse than refusing the channel delete.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "workers_org_channel_fk",
    }).onDelete("no action"),
    // A worker the server wakes that does nothing is a lie in the UI. A
    // manual-only worker with every step off is just at rest, which is why the
    // predicate is guarded on `auto` rather than asserted outright — and why
    // the guard reads `auto` and not "enabled": the constraint is about the
    // SCHEDULE promising something, never about the row doing nothing.
    //
    // PER TYPE since T-8.12, which is the landing that could carry it. A scout
    // has one step, the find; an Ambassador has write and publish, and its
    // `sweep_enabled` is dead. Split earlier and the shape the CRUD path still
    // produced — an armed Ambassador whose only step was the find — became
    // unrepresentable, 30 tests across 7 files. What made it representable no
    // longer is `strategy changes` taking a `type`.
    //
    // The Ambassador has
    // person-to-person steps are steps, so an armed Ambassador whose only work
    // is a conversation is a row the schedule does promise something of.
    autoDoesSomethingCheck: check(
      "workers_enabled_does_something_check",
      sql`not ${t.auto}
        or (${t.type} = 'scout' and ${t.sweepEnabled})
        or (${t.type} = 'ambassador' and (${t.draftEnabled} or ${t.conversationEnabled}))`,
    ),
    // The source table's `kind` was created with NO check at all (`0116`), so
    // `insert ... kind = 'post'` succeeded there and the enum was a TypeScript
    // opinion. The DB holds this one.
    typeCheck: check(
      "workers_kind_check",
      sql`${t.type} in ('scout','ambassador')`,
    ),
  }),
);

export type WorkerRow = typeof workers.$inferSelect;
export type NewWorkerRow = typeof workers.$inferInsert;
/** What a worker IS. Named here rather than re-derived at each consumer because
 *  T-8.5's capability declaration is keyed on it and T-8.3's run handler
 *  branches on it. */
export type WorkerType = WorkerRow["type"];

// ============================================================================
// Agent steps (Phase 45) — the Ambassador's conversation work, one checkpoint
// per conversation per step
// ============================================================================

/** Where one step's work on one conversation stands. `running` is a checkpoint a
 *  wake is working — or one a crashed run left, which the next wake adopts;
 *  every other value is how the step ended, in `AgentStepResult`'s words. */
export const STEP_RUN_STATUSES = [
  "running",
  "achieved",
  "waiting",
  "needs_approval",
  "blocked",
  "budget_exhausted",
] as const;
export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number];

/** A step waiting on the person: the event that ends the wait, what it must
 *  name, when it expires and what the expiry does. Consumed ONCE, by the
 *  matching conversation event or by the timeout job, whichever comes first. */
export type StepWait = {
  event: string;
  /** `journey:<id>` (persisted key, never renamed) — a reply on any other conversation matches nothing. */
  correlation: string;
  expiresAt: number;
  onTimeout: "wake" | "escalate";
  /** The `agent_step_timeout` job armed at `expiresAt`. */
  timeoutJobId: number | null;
  consumedAt: number | null;
  /** What ended it: the awaited event, its own time, a newer decision of
   *  the step on the conversation, or the owner's cancel. */
  consumedBy: "event" | "timeout" | "superseded" | "owner" | null;
  /** A time the step named (`wake_at`) rather than hours from now. Absent on
   *  a wait written before Phase 56. */
  named?: boolean;
  /** The refs in the conversation the named time rests on, as resolved. */
  evidenceRefs?: string[];
  /** The person's own words the time rests on, verbatim from
   *  `quotedEventId` — a message of theirs; null when they named none. */
  quote?: string | null;
  quotedEventId?: number | null;
  /** Who last moved `expiresAt`, when the owner did. */
  movedBy?: string | null;
};

/** A draft a step wrote. A public reply lands on `messages` and is named
 *  here; a DM has no row of its own until Phase 47's ledger, so its text is
 *  held here, with what it was drafted from. */
export type StepDraft =
  | { kind: "room_reply"; messageId: number; target: string }
  | {
      kind: "reply";
      messageId: number;
      target: string;
      /** The text hash of the reply it answers, as it was drafted: absent on
       *  a draft recorded before the step kept it. */
      replyTextHash?: string | null;
      /** Absent on older drafts; new automated replies recheck these sources before approval. */
      writing?: { stepId: string; contextRevision: string; factIds: number[] };
    }
  | {
      kind: "dm";
      target: string;
      text: string;
      textHash: string;
      versions: { strategy: number; input: string; facts: number[] };
      writing?: { promptId: number; hash: string; stepId: string; contextRevision: string; instructions?: string };
      /** The approved offer it was drafted to make, at the words approved;
       *  absent on a DM that makes none. */
      offer?: OfferBinding;
    };

/** An offer a candidate rests on: its reference and the approved words'
 *  content hash (`offers`). */
export type OfferBinding = { ref: string; contentHash: string };

/** A memory update a step proposed and its bindings admitted, as the step
 *  said it — the record it became, if any, is on `memory_records`. */
export type StepMemoryPatch = {
  slot: string;
  scope: string;
  key: string;
  value: string;
};

/** One memory record a step was handed, at the version it read: what every
 *  draft and send of the step rests on (spec §05, "decisions bind the memory
 *  ids and versions used"). */
export type StepMemoryRef = { id: number; version: number };

/**
 * One agent step's checkpoint on one conversation (spec §08, "durable
 * continuation"): which step, which strategy version, the versions of the
 * input and evidence it reasoned over, the iterations and budgets it spent,
 * how it ended, its wait, its drafts and the memory updates it admitted. The
 * decision summary is the step's `rationale_summary` — display text, never a
 * receipt (INV-30), and nothing beyond it is stored.
 *
 * `work_key` names what the checkpoint answers — `event:<id>` for a reply,
 * `timeout:<step run id>` for a wait that expired — and is unique per conversation
 * and step, so a replayed event or a second wake adopts the checkpoint rather
 * than starting the work again. `run_id` is the run that last worked it.
 */
export const stepRuns = pgTable(
  "step_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    conversationId: bigint("conversation_id", { mode: "number" }).notNull(),
    /** Snapshot, like `worker_runs.campaign_id`: the campaign whose
     *  strategy the step belongs to. */
    campaignId: bigint("campaign_id", { mode: "number" }).notNull(),
    stepId: text("step_id").notNull(),
    workKey: text("work_key").notNull(),
    /** The conversation event the step answers. No FK, for the reason
     *  `conversations.interest_evidence_event_id` gives. */
    eventId: bigint("event_id", { mode: "number" }),
    strategyVersion: integer("strategy_version").notNull(),
    /** SHA-256 of the input the step was handed; null until it is built. */
    inputVersion: text("input_version"),
    /** The evidence the input rests on: `event:<id>@<content hash>`. */
    evidenceVersion: text("evidence_version"),
    iterations: integer("iterations").notNull().default(0),
    /** The model turns each run spent on this checkpoint, by run id: the server
     *  adds one as it spends the turn, so a checkpoint a later wake adopts
     *  keeps who spent which (`agentStep/wake.ts`). Sums to `iterations`. */
    iterationsByRun: jsonb("iterations_by_run").$type<Record<string, number>>().notNull().default({}),
    toolActions: integer("tool_actions").notNull().default(0),
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    /** The server's estimate of the model tokens spent, from what it sent and
     *  received — never a count a model reported. */
    tokens: integer("tokens").notNull().default(0),
    status: text("status", { enum: STEP_RUN_STATUSES }).notNull().default("running"),
    /** Why the server ended the step where a model did not: a stale fact, an
     *  unmet barrier, a guard that moved. */
    blockedReason: text("blocked_reason"),
    rationaleSummary: text("rationale_summary"),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
    wait: jsonb("wait").$type<StepWait>(),
    drafts: jsonb("drafts").$type<StepDraft[]>().notNull().default([]),
    memoryPatches: jsonb("memory_patches")
      .$type<StepMemoryPatch[]>()
      .notNull()
      .default([]),
    /** The memory records the step's input carried, by id and version. */
    memoryRefs: jsonb("memory_refs").$type<StepMemoryRef[]>().notNull().default([]),
    /** When a forgotten memory's content was taken out of this checkpoint —
     *  its patches, its held drafts and its summary (`memory/records.ts`). */
    redactedAt: bigint("redacted_at", { mode: "number" }),
    startedAt: bigint("started_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    finishedAt: bigint("finished_at", { mode: "number" }),
  },
  (t) => ({
    orgIdUnique: unique("step_runs_org_id_key").on(t.organizationId, t.id),
    workUnique: unique("step_runs_org_work_key").on(
      t.organizationId,
      t.conversationId,
      t.stepId,
      t.workKey,
    ),
    orgRunIdx: index("step_runs_org_run_idx").on(t.organizationId, t.runId),
    // Cascades with the run, as the run cascades with its worker: a deleted
    // worker takes its run log, checkpoints included.
    orgRunFk: foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [workerRuns.organizationId, workerRuns.id],
      name: "step_runs_org_run_fk",
    }).onDelete("cascade"),
    orgConversationFk: foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
      name: "step_runs_org_conversation_fk",
    }).onDelete("cascade"),
    statusCheck: check(
      "step_runs_status_check",
      sql`${t.status} in ('running', 'achieved', 'waiting', 'needs_approval', 'blocked', 'budget_exhausted')`,
    ),
    openCheck: check(
      "step_runs_open_check",
      sql`(${t.status} = 'running') = (${t.finishedAt} is null)`,
    ),
    countsCheck: check(
      "step_runs_counts_check",
      sql`${t.iterations} >= 0 and ${t.toolActions} >= 0 and ${t.elapsedMs} >= 0 and ${t.tokens} >= 0`,
    ),
  }),
);

export type StepRunRow = typeof stepRuns.$inferSelect;

/**
 * Every tool call a step's result proposed, and what the server did with it:
 * dispatched, or discarded with the reason (INV-26 — a call outside the
 * step's grants and effective modes is discarded, never clamped). The model
 * never executes a tool; this is the record that the server did, or did not.
 * Append-only: written once, by the iteration that judged it.
 */
export const stepToolCalls = pgTable(
  "step_tool_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    stepRunId: bigint("step_run_id", { mode: "number" }).notNull(),
    /** The run whose iteration proposed it — what its counters are counted
     *  from. A snapshot, like the checkpoint's. */
    runId: bigint("run_id", { mode: "number" }).notNull(),
    iteration: integer("iteration").notNull(),
    callId: text("call_id"),
    /** As proposed, which is why it is free text: an unknown tool is
     *  recorded under the name the model gave it. */
    tool: text("tool").notNull(),
    toolVersion: integer("tool_version"),
    targetKind: text("target_kind"),
    targetRef: text("target_ref"),
    /** SHA-256 of the call's tool, target and inputs: two calls with one
     *  digest are one call. */
    callDigest: text("call_digest").notNull(),
    outcome: text("outcome", { enum: ["dispatched", "discarded"] }).notNull(),
    reason: text("reason"),
    /** What a dispatch produced — `message:<id>`, `fact:<id>` on a refusal. */
    resultRef: text("result_ref"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("step_tool_calls_org_id_key").on(t.organizationId, t.id),
    orgStepRunIdx: index("step_tool_calls_org_step_run_idx").on(
      t.organizationId,
      t.stepRunId,
    ),
    orgRunIdx: index("step_tool_calls_org_run_idx").on(t.organizationId, t.runId),
    orgStepRunFk: foreignKey({
      columns: [t.organizationId, t.stepRunId],
      foreignColumns: [stepRuns.organizationId, stepRuns.id],
      name: "step_tool_calls_org_step_run_fk",
    }).onDelete("cascade"),
    outcomeCheck: check(
      "step_tool_calls_outcome_check",
      sql`${t.outcome} in ('dispatched', 'discarded')`,
    ),
    reasonCheck: check(
      "step_tool_calls_reason_check",
      sql`(${t.outcome} = 'dispatched') = (${t.reason} is null)`,
    ),
  }),
);

export type StepToolCallRow = typeof stepToolCalls.$inferSelect;

// ============================================================================
// Relationship memory (Phase 55) — what the account remembers about a person,
// or about the people of a campaign, with its provenance and its versions
// ============================================================================

/** The slot a memory record holds. Only relationship memory is a record here:
 *  a voice is Voice's, knowledge is the Brain's, outcomes are a conversation's
 *  facts, and permissions and suppressions are protected rows no memory can
 *  write (spec §05). */
export const MEMORY_RECORD_SLOTS = ["relationship_memory"] as const;
export const MEMORY_SCOPES = ["account", "campaign", "step", "person"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Who said it: the owner; the person themselves, in words the step cited
 *  from what it was handed; or the step's own inference, which can be wrong
 *  and is never shown as their statement. */
export const MEMORY_AUTHOR_TYPES = ["owner", "observed", "inferred"] as const;
export type MemoryAuthorType = (typeof MEMORY_AUTHOR_TYPES)[number];

/** `content` is remembered and can be forgotten; `no_retention` is the
 *  owner's "do not remember this" — a value-less marker that keeps anything
 *  from being remembered again in its place. */
export const MEMORY_RETENTION_CLASSES = ["content", "no_retention"] as const;
export type MemoryRetentionClass = (typeof MEMORY_RETENTION_CLASSES)[number];

/**
 * One version of one memory (spec §05 R20, "memory contract"). A memory is
 * named by where it lives — its account (`channel_id`), slot, scope, the
 * scope's ref (none for the account, the campaign's id, `<campaign>:<step>`,
 * the person's profile id) and its `key` — and every edit or correction is a
 * new row with the next `version` and `supersedes_id` the one it replaces, so
 * the current memory is the highest version and the rest are its history.
 *
 * Forgetting deletes every version of it and redacts what was derived from it
 * (`memory/records.ts`); a record of the owner's "do not remember this" may
 * take its place. Nothing here is a permission: an exclusion lives on
 * `engaged_profiles` and the pauses, and forgetting never touches either.
 *
 * `supersedes_id` carries no FK: a memory is forgotten whole, every version in
 * one statement.
 */
export const memoryRecords = pgTable(
  "memory_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    slot: text("slot", { enum: MEMORY_RECORD_SLOTS }).notNull(),
    scope: text("scope", { enum: MEMORY_SCOPES }).notNull(),
    scopeRef: text("scope_ref"),
    key: text("key").notNull(),
    /** Null only on a `no_retention` marker. */
    value: text("value"),
    /** What it was read from: `event:<id>` for their own words,
     *  `step_run:<id>` for a step's inference, `owner:<surface>` for the
     *  owner's. */
    sourceRef: text("source_ref").notNull(),
    authorType: text("author_type", { enum: MEMORY_AUTHOR_TYPES }).notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    version: integer("version").notNull().default(1),
    retentionClass: text("retention_class", { enum: MEMORY_RETENTION_CLASSES })
      .notNull()
      .default("content"),
    supersedesId: bigint("supersedes_id", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("memory_records_org_id_key").on(t.organizationId, t.id),
    // One row per version of one memory. NULLS NOT DISTINCT because an
    // account-scoped memory has no scope ref.
    versionUnique: unique("memory_records_identity_version_key")
      .on(t.organizationId, t.channelId, t.slot, t.scope, t.scopeRef, t.key, t.version)
      .nullsNotDistinct(),
    orgScopeIdx: index("memory_records_org_scope_idx").on(
      t.organizationId,
      t.channelId,
      t.scope,
      t.scopeRef,
    ),
    // NO ACTION, for the reason `conversations_org_channel_fk` gives.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "memory_records_org_channel_fk",
    }).onDelete("no action"),
    slotCheck: check("memory_records_slot_check", sql`${t.slot} in ('relationship_memory')`),
    scopeCheck: check(
      "memory_records_scope_check",
      sql`${t.scope} in ('account', 'campaign', 'step', 'person') and ((${t.scope} = 'account') = (${t.scopeRef} is null))`,
    ),
    authorCheck: check(
      "memory_records_author_check",
      sql`${t.authorType} in ('owner', 'observed', 'inferred')`,
    ),
    retentionCheck: check(
      "memory_records_retention_check",
      sql`${t.retentionClass} in ('content', 'no_retention') and ((${t.retentionClass} = 'content') = (${t.value} is not null))`,
    ),
    versionCheck: check(
      "memory_records_version_check",
      sql`${t.version} >= 1 and ((${t.version} = 1) = (${t.supersedesId} is null))`,
    ),
  }),
);

export type MemoryRecordRow = typeof memoryRecords.$inferSelect;

// ============================================================================
// Action ledger (Phase 47) — every send the `messages` path never carried, a
// row before the click and a settled row after it; and the durable Stop
// ============================================================================

/** The kinds that send through the action ledger (INV-27). `withdraw_invite`
 *  is the owner's own press on a pending invitation of ours, never a step's.
 *  `comment`, `reply` and `room_reply` are the kinds whose words also live on
 *  a `messages` row (`message_id`), the record every surface of them reads. */
export const ACTION_KINDS = [
  "like_target",
  "invite",
  "accept_invite",
  "dm",
  "followup",
  "withdraw_invite",
  "room_reply",
  "reply",
  "comment",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Why the action reaches the person — the half of the semantic key that
 *  tells two sends to one person apart. */
export const ACTION_PURPOSES = [
  "opener",
  "reply",
  "cta",
  "followup",
  "reaction",
  "acceptance",
  "withdrawal",
  // An invitation's note, sent as the first message when they accepted and
  // LinkedIn did not carry it (`actions/inviteNote.ts`): one per conversation,
  // never the invitation's own `opener`.
  "invite_note",
] as const;
export type ActionPurpose = (typeof ACTION_PURPOSES)[number];

/**
 * Where one action stands. Before the click: `reserved` (an automatic mode's
 * reservation), `awaiting_review` (Ask me), `approved`. At the click:
 * `dispatching`, written with the fence in the transaction that takes the
 * account's operation holder. After it, the adapter's four answers —
 * `confirmed`, `definitely_not_sent`, `uncertain`, `blocked` — and
 * `cancelled`, which only a row that never reached `dispatching` can become:
 * a Stop never turns a send that may have landed into one that did not
 * (INV-29). `blocked` is also the gate's own answer before any click, for an
 * automatic reservation past the account's rolling-24h ceiling
 * (`status_reason = 'ceiling_reached'`).
 */
export const ACTION_STATUSES = [
  "reserved",
  "awaiting_review",
  "approved",
  "dispatching",
  "confirmed",
  "definitely_not_sent",
  "uncertain",
  "blocked",
  "cancelled",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** What an action is aimed at: the catalog target kind, its canonical id and
 *  the provider urn where it has one. An approval binds those three; the rest
 *  is what the server resolved beside them, for the dispatch gate to reach
 *  the action target and hold the page to it. */
export type ActionTarget = {
  kind: string;
  id: string;
  urn: string | null;
  /** The post a comment target sits under — what the network navigates to. */
  postUrn?: string;
  /** The comment of ours a reply target answers: the thread the gate reads
   *  before the click. */
  parentUrn?: string;
  /** Who wrote a reply target, and the hash of its words, as the proposal
   *  saw them. */
  authorProfileId?: string;
  textHash?: string | null;
  /** A DM's conversation: its newest message when the DM was written. The
   *  sidecar sends nothing into a conversation that has moved past it. */
  lastMessageId?: string;
  /** The room member a room reply answers: the per-person caps count them
   *  where no profile places them. */
  memberUrn?: string;
  /** A reply to a comment on the owner's own post, whose mode is the account's
   *  own-post setting rather than a step's. */
  ownPost?: boolean;
  /** The confirmed room reply a reply continues under; the gate counts it as
   *  a room exchange, not a person in live conversation. */
  roomReplyUrn?: string;
};

/** What a candidate was made from, at the revisions it saw — what an approval
 *  of it is bound to (spec §21). */
export type ActionCandidate = {
  /** Exact resolved writing prompt retained for explanation, never send authority. */
  writing?: { promptId: number; hash: string; stepId: string; instructions?: string };
  /** The words that go out; null for a kind that carries none (a like, an
   *  acceptance). */
  text: string | null;
  /** How much of the owner's words are an agent's, where the owner wrote them
   *  in a box that offered theirs (Draft for me): how much of the agent's
   *  words they kept, and how much of what they had typed first survived.
   *  Absent where no agent words were offered — the owner's by construction. */
  assist?: { assistRetention: number; ownerOrigin: number | null };
  /** The observations it answers: a conversation event and the hash of its words
   *  as the candidate saw them. */
  sources: Array<{ eventId: number; contentHash: string | null }>;
  versions: {
    /** The campaign strategy version that proposed it. */
    strategy: number | null;
    /** The product facts it rests on, each at its content hash. */
    facts: Array<{ id: number; contentHash: string }>;
    /** The memory version it read; null before relationship memory exists. */
    memory: string | null;
    voice: string | null;
    /** The approved offer an offer DM makes; absent for every other. */
    offer?: OfferBinding;
  };
};

/** One try at the click, kept whatever became of it: a retry is a new
 *  attempt on the same row, never a new row. */
export type ActionAttempt = {
  attempt: number;
  operationId: string;
  epoch: number;
  startedAt: number;
  settledAt: number | null;
  outcome: "confirmed" | "definitely_not_sent" | "uncertain" | "blocked" | null;
  /** Who settled it: the gate on the adapter's answer, a reconciliation read,
   *  or the owner's own eyes. */
  settledBy: "gate" | "reconcile" | "owner" | null;
  evidence: Record<string, unknown> | null;
};

/**
 * One action of a kind the `messages` path never carried (spec §15 R11,
 * "action and attempt"): reserved BEFORE any click under a semantic
 * idempotency key the database enforces, and settled after it.
 *
 * `idempotency_key` is the action's meaning, not a transport retry key: a
 * reaction is `account + target kind + canonical target + reaction`; every
 * other kind `account + person + conversation + purpose + sequence` (and a reply
 * also the inbound event it answers) — `actions/keys.ts` builds both. Two
 * wakes proposing the same action meet the unique constraint, and the second
 * reserves nothing; the account lease alone would not survive a crash
 * between them.
 *
 * `candidate` and `content_hash` are what an approval binds (spec §21);
 * `origin` is INV-1's axis, defaulting to `worker` so an unstamped row
 * fails closed; `generation_seen` is the pause generation the reservation was
 * made under — a Stop with a higher generation on any scope the row touches
 * cancels it at the gate, whether or not that Stop has since been resumed.
 * `fence_token` is the operation id the row was dispatched under, which is
 * also the account's operation holder until the row settles.
 *
 * `channel_id` and `campaign_id` are snapshots of where the action ran;
 * `step_run_id` names the checkpoint that proposed it, without an FK, because
 * a send's history outlives the run log a deleted worker takes with it.
 */
export const actions = pgTable(
  "actions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    campaignId: bigint("campaign_id", { mode: "number" }).references(
      () => campaigns.id,
      { onDelete: "set null" },
    ),
    conversationId: bigint("conversation_id", { mode: "number" }),
    /** The person, as the conversation names them; null for a reaction on a
     *  target no conversation holds. */
    authorProfileId: profileIdText("author_profile_id"),
    stepRunId: bigint("step_run_id", { mode: "number" }),
    /** The comment or reply of ours this action rides with — a like of what
     *  a send answered. The gate sends it only once that message is posted. A
     *  plain bigint, no FK, like `draftPlanId`: the message is the reason the
     *  action exists, not its parent. */
    messageId: bigint("message_id", { mode: "number" }),
    actionBindingId: text("action_binding_id"),
    kind: text("kind", { enum: ACTION_KINDS }).notNull(),
    purpose: text("purpose", { enum: ACTION_PURPOSES }).notNull(),
    sequence: integer("sequence").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    target: jsonb("target").$type<ActionTarget>().notNull(),
    /** SHA-256 of the kind and the words that go out — what an approval
     *  binds, and what an edit changes. */
    contentHash: text("content_hash").notNull(),
    candidate: jsonb("candidate").$type<ActionCandidate>().notNull(),
    origin: text("origin", { enum: ["owner", "worker"] })
      .notNull()
      .default("worker"),
    status: text("status", { enum: ACTION_STATUSES })
      .notNull()
      .default("reserved"),
    /** Why the row stands where it does when that is not obvious: what
     *  cancelled or blocked it, what invalidated its approval. */
    statusReason: text("status_reason"),
    fenceToken: text("fence_token"),
    generationSeen: bigint("generation_seen", { mode: "number" }).notNull(),
    submittedAt: bigint("submitted_at", { mode: "number" }),
    externalReceipt: jsonb("external_receipt").$type<Record<string, unknown>>(),
    attempts: jsonb("attempts").$type<ActionAttempt[]>().notNull().default([]),
    /** How many reads have looked for what the fenced attempt did while its
     *  outcome stayed open, and when the last one looked — what decides when
     *  the owner is asked instead (`execution/actionGate.ts`
     *  `RECONCILE_ASK_OWNER_AFTER`). A new attempt starts them again. */
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    lastReconcileAt: bigint("last_reconcile_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    settledAt: bigint("settled_at", { mode: "number" }),
  },
  (t) => ({
    orgIdUnique: unique("actions_org_id_key").on(t.organizationId, t.id),
    idempotencyUnique: unique("actions_org_idempotency_key").on(
      t.organizationId,
      t.idempotencyKey,
    ),
    orgStatusIdx: index("actions_org_status_idx").on(
      t.organizationId,
      t.status,
      t.updatedAt,
    ),
    orgConversationIdx: index("actions_org_conversation_idx").on(
      t.organizationId,
      t.conversationId,
    ),
    orgCampaignIdx: index("actions_org_campaign_idx").on(
      t.organizationId,
      t.campaignId,
    ),
    orgMessageIdx: index("actions_org_message_idx").on(
      t.organizationId,
      t.messageId,
    ),
    // NO ACTION, for the reason `conversations_org_channel_fk` gives: a record of
    // what was sent refuses the delete of the account it was sent from.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "actions_org_channel_fk",
    }).onDelete("no action"),
    orgConversationFk: foreignKey({
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
      name: "actions_org_conversation_fk",
    }).onDelete("no action"),
    kindCheck: check(
      "actions_kind_check",
      sql`${t.kind} in ('like_target', 'invite', 'accept_invite', 'dm', 'followup', 'withdraw_invite', 'room_reply', 'reply', 'comment')`,
    ),
    purposeCheck: check(
      "actions_purpose_check",
      sql`${t.purpose} in ('opener', 'reply', 'cta', 'followup', 'reaction', 'acceptance', 'withdrawal', 'invite_note')`,
    ),
    originCheck: check(
      "actions_origin_check",
      sql`${t.origin} in ('owner', 'worker')`,
    ),
    statusCheck: check(
      "actions_status_check",
      sql`${t.status} in ('reserved', 'awaiting_review', 'approved', 'dispatching', 'confirmed', 'definitely_not_sent', 'uncertain', 'blocked', 'cancelled')`,
    ),
    sequenceCheck: check(
      "actions_sequence_check",
      sql`${t.sequence} >= 1`,
    ),
    // A click in flight, or one whose outcome nobody knows, always names the
    // operation it went out under.
    fenceCheck: check(
      "actions_fence_check",
      sql`${t.status} not in ('dispatching', 'uncertain') or (${t.fenceToken} is not null and ${t.submittedAt} is not null)`,
    ),
  }),
);

export type ActionRow = typeof actions.$inferSelect;

/** What an approval was given against, beyond the text and the action target —
 *  compared at the gate, field by field (`actions/approval.ts`). */
export type ActionDependencyVersions = {
  facts: Array<{ id: number; contentHash: string }>;
  memory: string | null;
  sources: Array<{ eventId: number; contentHash: string | null }>;
  /** The effective mode of the action's binding when it was approved. */
  authority: string | null;
  /** Recorded, never compared: an unrelated edit moves the strategy's
   *  version and leaves the approval standing. */
  strategy: number | null;
  voice: string | null;
  /** The approved offer the action makes, as it was approved; absent for an
   *  action that makes none. */
  offer?: OfferBinding;
};

/**
 * One owner's yes to one action, bound to the exact words and target it was
 * given for and to the facts, evidence, memory and authority they rested on
 * (spec §21). One-use: `used_at` is stamped in the transaction that moves the
 * action to `dispatching`. A material change invalidates it with the reason;
 * an unrelated settings edit leaves it standing. At most one live approval
 * per action.
 */
export const actionApprovals = pgTable(
  "action_approvals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    actionExecutionId: bigint("action_execution_id", { mode: "number" }).notNull(),
    /** Who said yes, and through which surface: `owner:dashboard`,
     *  `owner:mcp`. */
    approver: text("approver").notNull(),
    contentHash: text("content_hash").notNull(),
    targetHash: text("target_hash").notNull(),
    dependencyVersions: jsonb("dependency_versions")
      .$type<ActionDependencyVersions>()
      .notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    usedAt: bigint("used_at", { mode: "number" }),
    invalidatedAt: bigint("invalidated_at", { mode: "number" }),
    invalidatedReason: text("invalidated_reason"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("action_approvals_org_id_key").on(t.organizationId, t.id),
    liveUnq: uniqueIndex("action_approvals_live_unq")
      .on(t.organizationId, t.actionExecutionId)
      .where(sql`${t.usedAt} is null and ${t.invalidatedAt} is null`),
    orgActionFk: foreignKey({
      columns: [t.organizationId, t.actionExecutionId],
      foreignColumns: [actions.organizationId, actions.id],
      name: "action_approvals_org_action_fk",
    }).onDelete("cascade"),
    invalidatedCheck: check(
      "action_approvals_invalidated_check",
      sql`(${t.invalidatedAt} is null) = (${t.invalidatedReason} is null)`,
    ),
  }),
);

export type ActionApprovalRow = typeof actionApprovals.$inferSelect;

/** The writes an owner records a live check for (INV-31), one surface each.
 *  Follow-up is a DM and rides DM's check. */
export const LIVE_CHECK_CAPABILITIES = [
  "send_invitation",
  "accept_invitation",
  "send_dm",
  "withdraw_invitation",
] as const;
export type LiveCheckCapability = (typeof LIVE_CHECK_CAPABILITIES)[number];

/** Room replies are verified by their first approved send. They do not run
 * the optional invitation/DM read-and-write check. */
export const RECORDED_LIVE_CHECK_CAPABILITIES = [...LIVE_CHECK_CAPABILITIES, "room_reply"] as const;
export type RecordedLiveCheckCapability = (typeof RECORDED_LIVE_CHECK_CAPABILITIES)[number];

/**
 * Where one attempt at a live check stands:
 *
 *   reading   the read op is queued or running
 *   read      the read came back; the owner compares it with LinkedIn
 *   writing   the owner said it matches and pressed the one write, which
 *             `action_execution_id` names — the only action the check admits
 *   recorded  the write's own re-read confirmed it: the capability is live-
 *             checked on this account until the owner clears it
 *   closed    ended without one standing — `closed_reason` says how
 */
export const LIVE_CHECK_STATES = ["reading", "read", "writing", "recorded", "closed"] as const;
export type LiveCheckState = (typeof LIVE_CHECK_STATES)[number];

/** What the owner picked from Engager's own data: a conversation's person to
 *  invite, a pending incoming invitation, or a conversation bound to a
 *  conversation. */
export type LiveCheckSubject =
  | { kind: "conversation"; conversationId: number }
  | { kind: "invitation"; invitationId: number }
  | { kind: "dm_thread"; threadId: number };

/** What the read saw, as the owner compares it with LinkedIn: the op, when,
 *  the session and page it read, and the few values that say whether it read
 *  the right thing — ids and counts, never message words. */
export type LiveCheckReadProof = {
  op:
    | "read_relationship"
    | "read_incoming_invitations"
    | "read_dm_thread"
    | "read_conversation_messages";
  readAt: number;
  sessionId: string | null;
  pageFingerprint: string | null;
  observed: Record<string, string | number | boolean | null>;
};

/** The write's receipt: the ledger row, its attempt, and the re-read that
 *  confirmed it. */
export type LiveCheckWriteProof = {
  operationId: string | null;
  settledBy: "gate" | "reconcile";
  settledAt: number;
  evidence: Record<string, unknown>;
} & ({ actionExecutionId: number; messageId?: never } | { messageId: number; actionExecutionId?: never });

/**
 * THE OWNER'S LIVE CHECKS (INV-31) — one row per attempt to prove a write
 * surface on one account: a read the owner compares with LinkedIn, then one
 * write through the action ledger confirmed by its own re-read. A `recorded`
 * row is what makes the capability available on its account beside the
 * shipped table (`LIVE_READ_RECORDS`); clearing it closes the row, and the
 * capability is Off again. The owner records one in Engager; no agent can.
 */
export const liveChecks = pgTable(
  "live_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    capability: text("capability", { enum: RECORDED_LIVE_CHECK_CAPABILITIES }).notNull(),
    state: text("state", { enum: LIVE_CHECK_STATES }).notNull(),
    subject: jsonb("subject").$type<LiveCheckSubject | { kind: "room_reply"; messageId: number }>().notNull(),
    readProof: jsonb("read_proof").$type<LiveCheckReadProof>(),
    /** When the owner said the read matches LinkedIn. */
    readConfirmedAt: bigint("read_confirmed_at", { mode: "number" }),
    /** The one write this attempt admits through the gate. */
    actionExecutionId: bigint("action_execution_id", { mode: "number" }),
    messageId: bigint("message_id", { mode: "number" }),
    writeProof: jsonb("write_proof").$type<LiveCheckWriteProof>(),
    /** Why a closed attempt ended: the read failed or was wrong, the write
     *  did not go out, or the owner cleared a recorded check. */
    closedReason: text("closed_reason"),
    startedBy: text("started_by").notNull(),
    recordedBy: text("recorded_by"),
    recordedAt: bigint("recorded_at", { mode: "number" }),
    clearedBy: text("cleared_by"),
    clearedAt: bigint("cleared_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgIdUnique: unique("live_checks_org_id_key").on(t.organizationId, t.id),
    /** One attempt in progress per capability on an account. */
    openUnq: uniqueIndex("live_checks_open_unq")
      .on(t.organizationId, t.channelId, t.capability)
      .where(sql`${t.state} in ('reading', 'read', 'writing')`),
    /** One standing record per capability on an account. */
    recordedUnq: uniqueIndex("live_checks_recorded_unq")
      .on(t.organizationId, t.channelId, t.capability)
      .where(sql`${t.state} = 'recorded'`),
    /** An action is the write of one attempt at most. */
    actionUnq: uniqueIndex("live_checks_org_action_unq")
      .on(t.organizationId, t.actionExecutionId)
      .where(sql`${t.actionExecutionId} is not null`),
    messageUnq: uniqueIndex("live_checks_org_message_unq")
      .on(t.organizationId, t.messageId)
      .where(sql`${t.messageId} is not null`),
    // NO ACTION on both, for the reason `conversations_org_channel_fk` gives: a
    // record outlives nothing it names.
    orgChannelFk: foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
      name: "live_checks_org_channel_fk",
    }).onDelete("no action"),
    orgActionFk: foreignKey({
      columns: [t.organizationId, t.actionExecutionId],
      foreignColumns: [actions.organizationId, actions.id],
      name: "live_checks_org_action_fk",
    }).onDelete("no action"),
    orgMessageFk: foreignKey({
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
      name: "live_checks_org_message_fk",
    }).onDelete("no action"),
    valuesCheck: check(
      "live_checks_values_check",
      sql`${t.capability} in ('send_invitation', 'accept_invitation', 'send_dm', 'withdraw_invitation', 'room_reply') and ${t.state} in ('reading', 'read', 'writing', 'recorded', 'closed')`,
    ),
    writingCheck: check(
      "live_checks_writing_check",
      sql`${t.state} not in ('writing', 'recorded') or (${t.readConfirmedAt} is not null and
        ((${t.capability} <> 'room_reply' and ${t.actionExecutionId} is not null and ${t.messageId} is null)
          or (${t.capability} = 'room_reply' and ${t.messageId} is not null and ${t.actionExecutionId} is null)))`,
    ),
    roomCheck: check("live_checks_room_check", sql`${t.capability} <> 'room_reply' or
      (${t.state} in ('recorded', 'closed') and ${t.subject}->>'kind' = 'room_reply'
        and ${t.subject}->>'messageId' = ${t.messageId}::text)`),
    recordedCheck: check(
      "live_checks_recorded_check",
      sql`${t.state} <> 'recorded' or (${t.recordedAt} is not null and ${t.recordedBy} is not null and ${t.writeProof} is not null)`,
    ),
    closedCheck: check(
      "live_checks_closed_check",
      sql`(${t.state} = 'closed') = (${t.closedReason} is not null)`,
    ),
    clearedCheck: check(
      "live_checks_cleared_check",
      sql`(${t.clearedAt} is null) = (${t.clearedBy} is null) and (${t.clearedAt} is null or ${t.recordedAt} is not null)`,
    ),
  }),
);

export type LiveCheckRow = typeof liveChecks.$inferSelect;

export const PAUSE_SCOPES = ["account", "campaign", "conversation"] as const;
export type PauseScope = (typeof PAUSE_SCOPES)[number];

export const PAUSE_REASONS = [
  "stop",
  "takeover",
  "warning",
  "restriction",
  "opt_out",
  "revocation",
  // The owner excluded the person: their conversation's queued work is
  // cancelled under a new generation, beside the do-not-engage flag that
  // keeps them excluded.
  "exclusion",
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/**
 * A durable Stop (INV-29, spec §16 "concurrency and stopping semantics"): an
 * account (`scope_id` the channel), a campaign or a conversation (`scope_id`
 * the conversation), paused for a reason, under a cancellation generation that
 * rises with every pause the org writes. Candidate creation and the dispatch
 * gate read the open rows AND compare the generation: anything reserved under
 * a lower one, on a scope a later pause touched, is cancelled — even once that
 * pause is resumed. Restart, reconnection, a settings edit or the end of a
 * wake never close a row; only an explicit Resume writes `resumed_at`.
 */
export const pauseControls = pgTable(
  "pause_controls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    scope: text("scope", { enum: PAUSE_SCOPES }).notNull(),
    scopeId: bigint("scope_id", { mode: "number" }).notNull(),
    reason: text("reason", { enum: PAUSE_REASONS }).notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    pausedAt: bigint("paused_at", { mode: "number" }).notNull(),
    pausedBy: text("paused_by").notNull(),
    resumedAt: bigint("resumed_at", { mode: "number" }),
    resumedBy: text("resumed_by"),
  },
  (t) => ({
    orgIdUnique: unique("pause_controls_org_id_key").on(t.organizationId, t.id),
    generationUnique: unique("pause_controls_org_generation_key").on(
      t.organizationId,
      t.generation,
    ),
    /** One open pause per scope and reason: a second Stop is the first. */
    openUnq: uniqueIndex("pause_controls_open_unq")
      .on(t.organizationId, t.scope, t.scopeId, t.reason)
      .where(sql`${t.resumedAt} is null`),
    scopeCheck: check(
      "pause_controls_scope_check",
      sql`${t.scope} in ('account', 'campaign', 'conversation')`,
    ),
    reasonCheck: check(
      "pause_controls_reason_check",
      sql`${t.reason} in ('stop', 'takeover', 'warning', 'restriction', 'opt_out', 'revocation', 'exclusion')`,
    ),
    generationCheck: check(
      "pause_controls_generation_check",
      sql`${t.generation} >= 1`,
    ),
    resumedCheck: check(
      "pause_controls_resumed_check",
      sql`(${t.resumedAt} is null) = (${t.resumedBy} is null)`,
    ),
  }),
);

export type PauseControlRow = typeof pauseControls.$inferSelect;

// ============================================================================
// Maintained supervision (P6) — who watches this install, and what happened
// ============================================================================

/** The lifecycle vocabulary ADR-08 froze, spelled once. Swift displays these
 *  strings and decides none of them (INV-20); the core writes every value. */
export const SUPERVISED_STATES = [
  "starting",
  "healthy",
  "degraded",
  "backoff",
  "paused",
  "stopping",
  "stopped",
  "recovery_required",
] as const;

/**
 * WHO SUPERVISES THIS INSTALL, and what that supervision is currently doing —
 * one row per organization, the shape `system_state` already uses for facts
 * about the install rather than about a row in it.
 *
 * The holder is exclusive in the same sense `channels.executionHolder` is: a
 * live holder with an unexpired lease owns supervision, and nothing else may
 * take it. It is deliberately NOT authority to dispatch — that stays with the
 * execution epoch on the channel — so a supervisor that loses this lease stops
 * *watching*, and a send already dispatched settles through its own path.
 *
 * `supervisor` records WHICH service is doing the watching: the maintained Mac
 * app under a verified `desktop_managed` capability, or the owner's own
 * `engager up`. A lapse moves it from one to the other and changes nothing
 * else — no file is removed, no saved publish intent is rewritten, and a
 * separately owned self-managed executor keeps running (TIER-03/PRODUCT lapse
 * rule).
 */
export const supervisionState = pgTable(
  "supervision_state",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .default(CURRENT_ORG)
      .references(() => organizations.id, { onDelete: "cascade" }),
    supervisor: text("supervisor", {
      enum: ["self_managed", "managed_desktop"],
    })
      .notNull()
      .default("self_managed"),
    /** The runtime instance id of the process that holds supervision, or null
     *  when nobody does. Never a bare PID: a copied lockfile is not authority
     *  (ADR-02), so the holder is the same runtime identity the execution
     *  authority uses. */
    holderId: text("holder_id"),
    /** Database-clock deadline for `holderId`. Expiry frees the WATCH, never a
     *  dispatched write. */
    holderLeaseUntil: bigint("holder_lease_until", { mode: "number" }),
    state: text("state", { enum: SUPERVISED_STATES }).notNull().default("stopped"),
    /** Restart attempts inside the current window, and when that window opened.
     *  Bounded recovery is arithmetic on these two, never a timer in Swift. */
    restartCount: integer("restart_count").notNull().default(0),
    restartWindowStartedAt: bigint("restart_window_started_at", { mode: "number" }),
    /** When `state = 'backoff'`, the instant a further attempt is allowed. */
    backoffUntil: bigint("backoff_until", { mode: "number" }),
    /** The last interval of uninterrupted health, used to reset the window. */
    healthySince: bigint("healthy_since", { mode: "number" }),
    /** A REDACTED one-line diagnosis of the last failure — the shape the free
     *  CLI's failure vocabulary already uses. No connection string, no live
     *  URL, no provider body ever reaches this column. */
    lastDiagnosis: text("last_diagnosis"),
    lastDiagnosisAt: bigint("last_diagnosis_at", { mode: "number" }),
    /** Set while the machine is asleep. Sleep quiesces new claims; it never
     *  asserts that an in-flight write was cancelled (ADR-08). */
    sleepingSince: bigint("sleeping_since", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    stateCheck: check(
      "supervision_state_check",
      sql`${t.restartCount} >= 0
        and (${t.holderId} is null) = (${t.holderLeaseUntil} is null)
        and (${t.state} <> 'backoff' or ${t.backoffUntil} is not null)`,
    ),
  }),
);

export type SupervisionStateRow = typeof supervisionState.$inferSelect;

/**
 * RESTART HISTORY, and every other lifecycle transition worth an owner's
 * attention — append-only, because "it restarted three times in ten minutes"
 * is a claim only rows can settle.
 *
 * `component` is the supervised process (`agent`, `dashboard`), not a worker:
 * a worker's own runs live in `worker_runs` and this table never doubles
 * as a second run log.
 */
export const supervisionEvents = pgTable(
  "supervision_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    component: text("component").notNull(),
    /** The state this transition arrived at — one of `SUPERVISED_STATES`. */
    state: text("state", { enum: SUPERVISED_STATES }).notNull(),
    /** Why, in the same closed vocabulary the UI copy switches on. */
    reason: text("reason", {
      enum: [
        "started",
        "ready",
        "readiness_failed",
        "child_exited",
        "restarted",
        "retry_budget_exhausted",
        "healthy_reset",
        "stop_requested",
        "stop_incomplete",
        "slept",
        "woke",
        "revalidation_failed",
        "supervisor_changed",
        "update_applied",
        "update_failed",
        "rollback_applied",
      ],
    }).notNull(),
    /** The holder that observed it, so two installs' histories never merge. */
    holderId: text("holder_id"),
    /** REDACTED, one line, same rule as `supervision_state.lastDiagnosis`. */
    diagnosis: text("diagnosis"),
    at: bigint("at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    orgAtIdx: index("supervision_events_org_at_idx").on(t.organizationId, t.at),
    componentCheck: check(
      "supervision_events_component_check",
      sql`${t.component} <> ''`,
    ),
  }),
);

export type SupervisionEventRow = typeof supervisionEvents.$inferSelect;

/**
 * WHAT THE MACHINE SLEPT THROUGH, per worker.
 *
 * A wake does not replay what was missed (ADR-08): the misses are recorded
 * here and at most ONE eligible future run is armed, after the account's own
 * day-plan and cap checks. This table is therefore evidence, not a queue — no
 * consumer may read it to enqueue anything.
 *
 * `missedCount` is how many wakes fell inside the gap, not how many jobs were
 * created, which is exactly zero for all of them.
 */
export const workerMissedRuns = pgTable(
  "worker_missed_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    workerId: bigint("worker_id", { mode: "number" }).notNull(),
    /** The wake the worker was armed for when the gap began. */
    missedFrom: bigint("missed_from", { mode: "number" }).notNull(),
    /** The instant the gap was observed — the first tick after the wake. */
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    missedCount: integer("missed_count").notNull(),
    /** Why the wakes were missed, as far as this install can honestly say. */
    cause: text("cause", { enum: ["sleep", "downtime", "clock_change"] }).notNull(),
    /** The single coalesced run this gap produced, if the day plan allowed one.
     *  Null means the misses were recorded and nothing was armed. */
    coalescedRunAt: bigint("coalesced_run_at", { mode: "number" }),
    /** When the owner dismissed this record from the alert. The record stays —
     *  it is history — and stops being something wrong. */
    dismissedAt: bigint("dismissed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    orgWorkerFk: foreignKey({
      columns: [t.organizationId, t.workerId],
      foreignColumns: [workers.organizationId, workers.id],
      name: "worker_missed_runs_org_worker_fk",
    }).onDelete("cascade"),
    // One record per worker per missed wake: a tick that re-observes the same
    // gap updates the count in place rather than minting a second row, which is
    // what keeps "how many did I miss" a fact instead of a tick counter.
    workerWakeUnq: uniqueIndex("worker_missed_runs_worker_wake_unq").on(
      t.organizationId,
      t.workerId,
      t.missedFrom,
    ),
    countCheck: check(
      "worker_missed_runs_count_check",
      sql`${t.missedCount} > 0 and ${t.observedAt} >= ${t.missedFrom}`,
    ),
  }),
);

export type WorkerMissedRunRow = typeof workerMissedRuns.$inferSelect;

/**
 * BACKUP, UPDATE AND ROLLBACK RECEIPTS — this installation's own maintenance
 * ledger, and the reason "there is a verified backup" is checkable rather than
 * asserted.
 *
 * Deliberately holds no absolute path: a `name` inside the installation's own
 * snapshot directory plus the archive's SHA-256. A receipt that named an
 * absolute path would travel in a portable export and describe a directory the
 * destination does not have.
 *
 * The last VERIFIED backup is never pruned (ADR-08), which is a property of the
 * pruning query rather than a column; what this table gives that query is the
 * verified/failed distinction it needs to honour it.
 */
export const maintenanceReceipts = pgTable(
  "maintenance_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    kind: text("kind", { enum: ["backup", "update", "rollback"] }).notNull(),
    outcome: text("outcome", {
      enum: [
        "verified",
        "failed",
        "pruned",
        "applied",
        "refused",
        "paused_recovery",
      ],
    }).notNull(),
    /** The snapshot file name inside the installation's snapshot directory, or
     *  the payload version for an update/rollback. */
    name: text("name").notNull(),
    /** SHA-256 of the verified artifact — the snapshot, or the payload. */
    sha256: text("sha256"),
    /** The core version the receipt is about, and the schema fingerprint that
     *  decides whether an older binary could still read this database. */
    version: text("version"),
    schemaHash: text("schema_hash"),
    /** Whether the artifact's own signature verified. `unsigned` is honest: a
     *  free payload carries a hash and no publisher signature, and an update
     *  that claims a signature it does not have is refused, not downgraded. */
    signature: text("signature", {
      enum: ["verified", "invalid", "unsigned"],
    }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** REDACTED one-line reason, same rule as the supervision diagnosis. */
    detail: text("detail"),
    at: bigint("at", { mode: "number" }).notNull().$defaultFn(nowMs),
  },
  (t) => ({
    orgKindAtIdx: index("maintenance_receipts_org_kind_at_idx").on(
      t.organizationId,
      t.kind,
      t.at,
    ),
    nameUnq: uniqueIndex("maintenance_receipts_org_kind_name_unq").on(
      t.organizationId,
      t.kind,
      t.name,
      t.at,
    ),
    nameCheck: check(
      "maintenance_receipts_name_check",
      sql`${t.name} <> '' and (${t.sizeBytes} is null or ${t.sizeBytes} >= 0)`,
    ),
  }),
);

export type MaintenanceReceiptRow = typeof maintenanceReceipts.$inferSelect;

/**
 * PROOF THAT A BACKGROUND AGENT IS ALIVE FOR THIS ORG — one row per runtime
 * instance, rewritten on the worker's own job-heartbeat cadence.
 *
 * Job leases already say "this job is being worked". They cannot answer the
 * different question an interactive tool has to ask BEFORE it queues anything:
 * is there a process that will ever pick the row up? A free install with no
 * agent running has an empty queue and a healthy database, and every seed it
 * enqueued sat `queued`, attempts 0, forever. This table is the missing fact,
 * and `packages/core/tasks/liveness.ts#agentHealthy` is its only reader.
 *
 * `runtimeId` is the installation's execution identity (`execution-id`), not a
 * PID: the worker's lanes share one, and a copied id is still fenced by
 * everything the execution authority already checks. `at` is the wall clock of
 * the last beat, in ms — staleness, never uptime, is what a caller wants.
 */
export const runtimeHeartbeats = pgTable(
  "runtime_heartbeats",
  {
    organizationId: orgId(),
    runtimeId: text("runtime_id").notNull(),
    at: bigint("at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.runtimeId] }),
    orgAtIdx: index("runtime_heartbeats_org_at_idx").on(t.organizationId, t.at),
    runtimeCheck: check(
      "runtime_heartbeats_runtime_check",
      sql`${t.runtimeId} <> '' and ${t.at} > 0`,
    ),
  }),
);

export type RuntimeHeartbeatRow = typeof runtimeHeartbeats.$inferSelect;

export const BUG_REPORT_STATUSES = ["queued", "filing", "sending", "sent", "failed"] as const;
export type BugReportStatus = (typeof BUG_REPORT_STATUSES)[number];

/** The agent's write-up of a report, or the reason class there is none. The
 *  write-up's shape is `ReportWriteUp` (`@engager/common/problem-report`). */
export type BugReportSummary =
  | { writeUp: Record<string, unknown> }
  | { unavailable: string };

/**
 * One problem report the owner sent from the dashboard (US-BUG-04): what they
 * wrote, the screen, the screenshots they ticked, and the diagnostics they
 * previewed, frozen at Send — so what goes is what they read — then the
 * delivery's own state as the `file_bug_report` job moves it: `queued` →
 * `filing` (their agent writing it up) → `sending` → `sent`, or `failed` a
 * day after it was queued.
 *
 * The id is the report's idempotency key end to end: the dashboard mints it,
 * the job sends under it, and the cloud relay dedupes on it, so a retry after
 * an uncertain answer can never send a second email. Screenshots are kept as
 * base64 beside their type, at most four, 5 MB each.
 */
export const bugReports = pgTable(
  "bug_reports",
  {
    id: uuid("id").primaryKey(),
    organizationId: orgId(),
    /** `ReportScreen`: the breadcrumb label, route template, ids, viewport, theme. */
    screen: jsonb("screen").$type<Record<string, unknown>>().notNull(),
    /** The owner's words, verbatim. Nothing ever rewrites them. */
    ownerText: text("owner_text").notNull(),
    expected: text("expected"),
    screenshots: jsonb("screenshots")
      .$type<{ contentType: string; content: string }[]>()
      .notNull()
      .default([]),
    includeDiagnostics: boolean("include_diagnostics").notNull(),
    /** Redacted at preview and again at Send; null when the owner unticked them. */
    diagnostics: text("diagnostics"),
    /** `ReportApp`: version, build, OS and deployment at Send. */
    app: jsonb("app").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: BUG_REPORT_STATUSES }).notNull().default("queued"),
    /** Delivery attempts to the cloud relay. */
    attempts: integer("attempts").notNull().default(0),
    agentSummary: jsonb("agent_summary").$type<BugReportSummary>(),
    /** The relay's message id, once sent. */
    messageId: text("message_id"),
    sentAt: bigint("sent_at", { mode: "number" }),
    /** Why the last attempt did not send: a class, never a provider's text. */
    error: text("error"),
    /** When delivery began — at Send, or at the owner's Retry. The day the
     *  relay is retried for is counted from here. */
    queuedAt: bigint("queued_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(nowMs),
  },
  (t) => ({
    orgCreatedIdx: index("bug_reports_org_created_idx").on(t.organizationId, t.createdAt.desc()),
  }),
);

export type BugReportRow = typeof bugReports.$inferSelect;
