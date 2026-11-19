import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import {
  engagedProfiles,
  campaigns,
  products,
  VOICE_QUESTION_KEYS,
  type Campaign,
  type LookalikeProposalJson,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { DAY_KEYS } from "../time";
import { ACTIVE_HOUR_HH_MM_PATTERN } from "../campaigns/activeHours";
import { BRAIN_SLOTS } from "../brain/slots";
import {
  listKnowledge,
  storeKnowledge,
  updateKnowledge,
} from "../brain/knowledge";
import { syncVaultMirror, vaultReplicaEnabled } from "../brain/mirror";
import { lockBrainMutation } from "../brain/mutationLock";
import { compileForVault } from "../brain/compile";
import {
  getOrgSafety,
  orgSafetyAfter,
  updateOrgSafety,
  type OrgSafety,
} from "../operations/orgSettings";
import { SEARCH_CAP_BOUNDS } from "../operations/readBudgets";
import { WRITE_AHEAD, WRITE_AHEAD_WORDS } from "../operations/writeAhead";
import { warmupWords } from "../operations/warmupWords";
import { VOICE_EXAMPLE_MAX_CHARS } from "../ai/styleRules";
import { getProfile, setChannelVoice } from "../profile";
import { ensureDefaultVoice } from "../voice";
import {
  answerVoiceQuestion,
  checkVoiceAnswer,
  listVoiceQuestions,
  voiceAnswerWords,
  VOICE_QUESTIONS,
} from "../voice/questions";
import { offerWords, readOffer, retireOffer, saveOffer } from "../products/offers";
import { setDoNotEngage } from "../operations/engagedProfiles";
import {
  applyStrategyPatch,
  conflictWith,
  strategyPatchSchema,
  preparePatch,
  readPatchState,
  type StrategyPatch,
} from "../strategy/patch";
import {
  ACCOUNT_POLICY_UPDATE,
  accountPolicyUpdateSchema,
  applyAccountPolicy,
  prepareAccountPolicy,
  readAccountPolicyState,
  type AccountPolicyUpdate,
} from "../strategy/accountPolicy";
import { DELETE_CAMPAIGN_WORDS } from "../campaigns/deleteWords";
import { OBJECTIVE_BY_ID } from "../campaigns/objectives";
import {
  CAMPAIGN_FACTS,
  campaignFactsBaseSchema,
  campaignFactsSchema,
  readCampaignFactsBase,
  writeCampaignFacts,
  type CampaignFactsBase,
  type CampaignFactsChange,
  type CampaignFactsPatch,
} from "../operations/campaignFacts";
import { getCampaign } from "../operations/campaigns";
import { startCampaign } from "../operations/startCampaign";
import { AUDIENCE_UPDATE, NoAudienceChange, audienceChangeSchema, changedAudience, type AudienceChange } from "../audience/change";
import { audienceProfile, type AudienceProfile } from "../audience/model";
import { saveAudience } from "../audience/write";
import { addLookalikeSearch, readLookalike } from "../discovery/lookalike";
import { campaignOneEach, pickCampaignProduct } from "../operations/campaignOneEach";
import {
  CAMPAIGN_DELETE,
  campaignDeleteSchema,
  deleteCampaign,
  type CampaignDelete,
} from "../operations/deleteCampaign";
import { CONNECTOR_DECLARATIONS } from "../connector/capabilities";
import { voiceRedraftPreview } from "../agentStep/redraft";
import { changePreview } from "../strategy/compiler";
import { describeDesign, type DesignSummary } from "../strategy/designSummary";
import { TEMPLATE_COMPILER_VERSION } from "../strategy/templates";
import {
  createAndStart,
  createAndStartSchema,
  createWithStrategy,
  dryRun,
  factsOf,
  type CampaignFact,
  type CreateAndStart,
} from "./quickCampaign";
import { CAMPAIGN_CREATE_AND_START } from "./quickCampaignWords";

/**
 * EVERY CHANGE CHAT MAY PROPOSE, and the whole of what a proposal is allowed to
 * become.
 *
 * The founder's rule is that chat may change things only after the owner says
 * so, and the reason it is a TABLE rather than a sentence in the system prompt
 * is that chat now reads third-party text: an incoming comment, an inbox row,
 * the body of a discovered post. A prompt-only rule is one injected line away
 * from a voice rewrite or a blocklist edit, so the model is given no write tool
 * for any kind here at all. It gets `propose_change`, and a proposal is inert —
 * `proposals.ts` writes a row, draws a card from the SERVER's own words, and
 * returns. Only an owner's click on that card reaches an `apply` below.
 *
 * TWO LEVELS, which are two cards and not two permissions:
 *
 *   `confirm` — CONTENT the owner owns and can read at a glance: what a voice
 *     sounds like, a Brain note, who never to engage. The card states the
 *     change and asks yes or no.
 *   `apply` — SETTINGS that spend the account or decide what runs unattended:
 *     the ceilings, a worker's steps. The card is a before → after table and
 *     the button is Apply, because a number moving from 12 to 40 is a thing to
 *     read rather than a thing to agree with.
 *
 * One kind's level is not a constant. A `strategy.patch` classifies itself
 * from its own diff (`strategy/patch.ts`): `confirm` when it widens what the
 * campaign may do, `apply` when it narrows or is style. Chat draws a card for
 * either; nothing a model sends spends one. Outside chat a widening waits here
 * too, with no conversation, while a narrowing lands at once
 * (`strategy/submit.ts`).
 *
 * WHAT IS NOT HERE IS THE POINT. There is no kind for turning write authority
 * on, for turning the kill switch OFF, for a plan move, or for disconnecting an
 * account, and their absence is the enforcement: no id the model can name
 * resolves to any of those operations, so there is nothing for an injected line
 * to ask for. `proposals.pin.test.ts` reads this file and the applies in it and
 * fails if one ever names any of their setters — it holds the list, spelled
 * out, and this file deliberately does not, because the sibling pin at
 * `apps/dashboard/app/channels/linkedin/write-authority.test.ts` scans raw text
 * on the principle that a mention is the first half of a call.
 *
 * Each entry reuses the operation the PAGE's own save calls, inside the
 * caller's `withOrg` transaction. There is no second persistence path, and no
 * validation written twice: `pacing.update` is clamped by `orgSafetyAfter`,
 * which is the function `updateOrgSafety` itself uses to decide what to store.
 */

/** Which card, and therefore which buttons. */
export type ProposalLevel = "confirm" | "apply";

/** One line of the card. Strings, because the card renders them and the server
 *  is what decides how a null, a list of days or a persona reads. */
export type ProposalRow = { label: string; before: string; after: string };

/** WHERE the owner can go and do this themselves — as a key, never a route.
 *  Core has no business knowing the dashboard's paths, and the card resolves
 *  the key through `lib/settings-links.ts` so the one link map stays the one
 *  link map. */
export type ProposalPage = {
  /** `campaign_settings` is only ever read: a card drawn before the campaign's
   *  Settings folded into its Strategy, which it opens. */
  key: "pacing" | "worker" | "campaign" | "campaign_settings" | "campaign_searches" | "voice" | "brain" | "channel";
  id?: number;
};

/** The card, authored here. The model's prose sits beside it and cannot edit
 *  a word of it. */
export type ProposalSummary = {
  level: ProposalLevel;
  title: string;
  rows: ProposalRow[];
  page: ProposalPage;
  /** A kind that removes something. The card asks twice. */
  destructive?: boolean;
  /** What the change does, said plainly — the spec's required preview (§09),
   *  read off the change itself rather than off who proposed it. */
  preview?: string[];
  /** A campaign's strategy designed from a template: what it will do, the
   *  operations it will not perform and why, and what a reply today would
   *  meet — before it does any of it. */
  design?: DesignSummary;
  /** Answering yes starts a campaign that has not started: the card's
   *  primary says Start campaign. */
  start?: true;
  /** A campaign the yes creates as well as starts: what it is for, read off
   *  the create itself — its name, audience, search depth, oldest post. */
  facts?: CampaignFact[];
  selection?: Array<{ index: number; label: string; detail: string; checked: boolean }>;
  searchEvidence?: { opening: string; comments: number; postReads: number; fits: number; judged: number; pains: string[] };
};

/** Canonical state as it stood when the card was drawn. Compared field by
 *  field at apply time: a row that moved since is refused `stale` rather than
 *  overwritten. */
export type ProposalBefore = Record<string, unknown>;

/** What the apply recorded — the receipt the card shows and the next turn
 *  reads. */
export type ProposalOutcome = Record<string, unknown>;

/** The refusal a kind raises when the change it was handed is not one the
 *  page could produce either. `AppError` so it keeps its code and status
 *  through the broker's own refusal shape. */
export class InvalidProposalError extends AppError {
  readonly recovery: string;

  constructor(message: string, recovery: string) {
    super("invalid_proposal", message, 400);
    this.recovery = recovery;
  }
}

function missing(what: string): never {
  throw new InvalidProposalError(
    `${what} no longer exists`,
    "Nothing was written. Read the current state and propose again from what is actually stored.",
  );
}

/** A card that would say nothing. Answering it would still spend a click, and
 *  it is the honest answer to a model restating what is already stored. */
export class ProposalNoOpError extends AppError {
  readonly recovery =
    "Nothing was written and no card was shown. Read the current state and tell the owner it already says what they asked for, or propose a value that differs from it.";

  constructor() {
    super("proposal_is_a_no_op", "this change would move nothing", 409);
  }
}

/** Who spent the card, and when — the provenance a version records. */
export type ApplyContext = { approver: string | null; now: number; selection?: number[] };

/** The card's lines, and — for the one kind whose level follows its diff —
 *  the level this proposal is. */
export type ProposalDrawing = {
  title: string;
  rows: ProposalRow[];
  level?: ProposalLevel;
} & Pick<ProposalSummary, "preview" | "design" | "start" | "facts" | "selection" | "searchEvidence">;

type KindImpl<T> = {
  /** The card's level, or for a kind that classifies each proposal, the level
   *  it falls back to: the stricter one. */
  level: ProposalLevel;
  /** The change itself. A `.strict()` object with a literal `kind`, so the MCP
   *  SDK refuses a smuggled key BY NAME before the handler runs. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown> & { shape: { kind: z.ZodLiteral<string> } };
  page: (value: T) => ProposalPage;
  /** A change this kind no longer makes on the state in hand, said as the
   *  kind that does — checked before anything is read, so the card drawn is
   *  the redirected kind's. Null keeps it. */
  redirect?: (
    tx: Tx,
    organizationId: string,
    value: T,
  ) => Promise<{ kind: string; change: Record<string, unknown> } | null>;
  /** Canonical state, read off the stored rows. Never the model's account of
   *  it: `before` is what the owner is shown AND what staleness is measured
   *  against, so a value the request supplied would make both meaningless. */
  read: (
    tx: Tx,
    organizationId: string,
    value: T,
  ) => Promise<ProposalBefore>;
  /** The card's lines, from that state and the change. */
  summarize: (before: ProposalBefore, value: T) => ProposalDrawing;
  /** A compare-and-swap the click must pass before staleness is asked: the
   *  fresh diff when the base the proposal was written against was replaced,
   *  else null. */
  conflict?: (
    tx: Tx,
    organizationId: string,
    value: T,
  ) => Promise<Record<string, unknown> | null>;
  apply: (
    tx: Tx,
    organizationId: string,
    value: T,
    context: ApplyContext,
  ) => Promise<ProposalOutcome>;
  destructive?: boolean;
  selectable?: boolean;
  /** Its own page shows each field the change moves beside what that field
   *  says now, so a click there that names what it showed is an informed yes:
   *  spent over a field that moved since the card was drawn, so long as the
   *  field still says what was shown (`decidePendingChange`). Every other
   *  click on it is held to the card's own `before`. */
  informedYes?: boolean;
};

/** The erased entry every caller sees. `schema.parse` is the only door in, and
 *  the casts below are sound because each function is reached only with a value
 *  that came through it — `proposals.ts` parses at the tool boundary and parses
 *  the STORED payload again before applying, so neither path carries an
 *  unvalidated object. */
export type ProposalKind = {
  level: ProposalLevel;
  schema: z.ZodTypeAny;
  destructive: boolean;
  informedYes: boolean;
  selectable: boolean;
  page: (value: unknown) => ProposalPage;
  redirect: (
    tx: Tx,
    organizationId: string,
    value: unknown,
  ) => Promise<{ kind: string; change: Record<string, unknown> } | null>;
  read: (
    tx: Tx,
    organizationId: string,
    value: unknown,
  ) => Promise<ProposalBefore>;
  summarize: (before: ProposalBefore, value: unknown) => ProposalDrawing;
  conflict: (
    tx: Tx,
    organizationId: string,
    value: unknown,
  ) => Promise<Record<string, unknown> | null>;
  apply: (
    tx: Tx,
    organizationId: string,
    value: unknown,
    context: ApplyContext,
  ) => Promise<ProposalOutcome>;
};

function kind<T>(impl: KindImpl<T>): ProposalKind {
  return {
    level: impl.level,
    schema: impl.schema,
    destructive: impl.destructive ?? false,
    informedYes: impl.informedYes ?? false,
    selectable: impl.selectable ?? false,
    page: (value) => impl.page(value as T),
    redirect: async (tx, organizationId, value) =>
      impl.redirect ? impl.redirect(tx, organizationId, value as T) : null,
    read: (tx, organizationId, value) =>
      impl.read(tx, organizationId, value as T),
    summarize: (before, value) => impl.summarize(before, value as T),
    conflict: async (tx, organizationId, value) =>
      impl.conflict ? impl.conflict(tx, organizationId, value as T) : null,
    apply: (tx, organizationId, value, context) =>
      impl.apply(tx, organizationId, value as T, context),
  };
}

// ---------------------------------------------------------------------------
// Rendering — the server's words for a value, so a card never prints a raw JSON
// fragment and two kinds never spell the same absence two ways.
// ---------------------------------------------------------------------------

/** Every "nothing there" reads the same, and it reads as a state rather than as
 *  an error: an account with no active window is not misconfigured. */
const NOTHING = "not set";

/** A campaign's status, as its own pill says it. */
const CAMPAIGN_STATUS_WORDS: Record<Campaign["status"], string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

function num(value: number | null | undefined): string {
  if (value == null) return NOTHING;
  return value === 0 ? "0 (off)" : String(value);
}

function text(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : NOTHING;
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function days(value: string[] | null | undefined): string {
  return value?.length ? value.join(", ") : "every day";
}

function window(value: OrgSafety["activeHours"]): string {
  return value ? `${value.start}–${value.end} ${value.tz}` : NOTHING;
}

/** One row, or none. A card lists what MOVES: a field the change restates
 *  without altering is noise on a before → after table, and on a long one it is
 *  what hides the line that matters. */
function moved(
  label: string,
  before: string,
  after: string,
): ProposalRow[] {
  return before === after ? [] : [{ label, before, after }];
}

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

const bounded = z.number().int().min(0).max(100_000);
/** The discovery search limits have no top (INV-6), so this one has none of
 *  `bounded`'s either. */
const searchCap = z.number().int().min(SEARCH_CAP_BOUNDS.min).max(SEARCH_CAP_BOUNDS.max);
const hhmm = z.string().regex(ACTIVE_HOUR_HH_MM_PATTERN);
const slot = z.enum(
  BRAIN_SLOTS.map((entry) => entry.id) as [
    (typeof BRAIN_SLOTS)[number]["id"],
    ...(typeof BRAIN_SLOTS)[number]["id"][],
  ],
);

/**
 * THE ACCOUNT'S CEILINGS, its active window and its warm-up ramp.
 *
 * The numeric bounds here are deliberately wider than the account's: every one
 * of these knobs is CLAMPED by `orgSafetyAfter` rather than refused, so a
 * schema that refused 400 comments a day would refuse a proposal the page
 * itself would have accepted and quietly stored as 100. What the schema keeps
 * out is nonsense — a negative cap, a number no arithmetic survives — and the
 * clamp decides the rest, which is how the card's "after" is the number the
 * account will actually hold.
 */
const pacingUpdate = z
  .object({
    kind: z.literal("pacing.update"),
    dailyEngageCap: bounded.optional(),
    minActionGapSec: bounded.optional(),
    dailyCommentCap: bounded.optional(),
    dailyReplyCap: bounded.optional(),
    perProfileDayCap: bounded.optional(),
    perProfileWeekCap: bounded.optional(),
    perProfileMonthCap: bounded.optional(),
    minDelaySec: bounded.optional(),
    warmupWeeks: bounded.optional(),
    /** Null is the default ramp, and `.nullable()` is how a proposal says so —
     *  `??` upstream would read an omitted field the same way. */
    warmupStartRate: bounded.nullable().optional(),
    activeDays: z.array(z.enum(DAY_KEYS)).min(1).max(7).optional(),
    activeHours: z
      .object({ start: hhmm, end: hhmm, tz: z.string().min(1).max(64) })
      .strict()
      .optional(),
    dailyThreadReadCap: bounded.optional(),
    dailyProfileReadCap: bounded.optional(),
    dailySearchPageCap: searchCap.optional(),
    hourlySearchCap: searchCap.optional(),
    dailyReplyCheckCap: bounded.optional(),
    replyCheckBaseMin: bounded.optional(),
    inboxCheckBaseMin: bounded.optional(),
    writeAhead: z.enum(WRITE_AHEAD).optional(),
  })
  .strict();

type PacingUpdate = z.infer<typeof pacingUpdate>;

/** The patch, without the discriminator the operation has never heard of. */
function pacingPatch(value: PacingUpdate): Partial<OrgSafety> {
  const { kind: _kind, ...patch } = value;
  return patch;
}

const PACING_LABELS: Record<keyof OrgSafety, string> = {
  dailyEngageCap: "Daily engage cap",
  minActionGapSec: "Minimum gap between actions (s)",
  dailyCommentCap: "Daily comment cap",
  dailyReplyCap: "Daily reply cap",
  perProfileDayCap: "Per profile, per day",
  perProfileWeekCap: "Per profile, per week",
  perProfileMonthCap: "Per profile, per month",
  minDelaySec: "Minimum delay before a send (s)",
  warmupWeeks: "Warm-up",
  warmupStartRate: "Warm-up start rate (%)",
  activeHours: "Active window",
  activeDays: "Active days",
  dailyThreadReadCap: "Post reads per day",
  dailyProfileReadCap: "Profile reads per day",
  dailySearchPageCap: "Searches per day",
  hourlySearchCap: "Searches per hour",
  dailyReplyCheckCap: "Reply and DM checks per day",
  replyCheckBaseMin: "Check replies every (min)",
  inboxCheckBaseMin: "Check messages every (min)",
  writeAhead: "Write comments ahead",
};

/**
 * HOW THE OWNER SOUNDS — the org's own register, and no `voiceId`.
 *
 * The Voice page edits exactly one thing, and it is not "a voice by id": it is
 * the org's register for one output surface, saved through
 * `profile.setChannelVoice`, which dual-writes the default voice row AND the
 * `profile` singleton the page itself renders from. `operations/voices`'
 * `setVoiceChannel` writes only the voices row, so a proposal that used it
 * changed what drafting reads while `/voice` went on showing the old words —
 * two stores disagreeing, with the owner looking at the stale one.
 *
 * So this kind is the page's operation rather than a near neighbour of it. A
 * named non-default voice is not editable from the page either, and giving
 * chat a reach the page does not have is how the two drift again; the day one
 * is wanted it is its own kind, with its own writer.
 */
const voiceUpdate = z
  .object({
    kind: z.literal("voice.update"),
    /** Which output the register is for. The two are separate registers, and a
     *  proposal that did not say which would be a persona applied to whichever
     *  one the code happened to reach first. */
    surface: z.enum(["comment", "post"]),
    persona: z.string().trim().min(1).max(4_000).optional(),
    houseStyle: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

type VoiceUpdate = z.infer<typeof voiceUpdate>;

/**
 * AN ANSWER THE OWNER GAVE IN CHAT to one of the voice questions
 * (`voice/questions.ts`) — a value every writer reads, so chat proposes it and
 * only the owner's yes saves it. The apply is `answerVoiceQuestion`, the one
 * operation the Voice page and the owner's own agent answer through, recorded
 * as answered in chat. Like `voice.update` it is the org's own voice, and takes
 * no id.
 */
const voiceQuestionAnswer = z
  .object({
    kind: z.literal("voice_question.answer"),
    key: z.enum(VOICE_QUESTION_KEYS),
    /** A choice's key; for who and proud the owner's text as they said it,
     *  for like and never their words. */
    answer: z.union([
      z.string().trim().min(1).max(VOICE_EXAMPLE_MAX_CHARS),
      z.array(z.string().trim().min(1).max(40)).min(1).max(30),
    ]),
  })
  .strict();

type VoiceAnswerProposal = z.infer<typeof voiceQuestionAnswer>;

/** A refusal the answer would meet, raised before a card is drawn. */
function refuseAnswer(detail: string): never {
  throw new InvalidProposalError(
    detail,
    "Nothing was written. Ask the owner again, offering the question's choices, and propose exactly what they said.",
  );
}

/** A product's offer in the owner's approved words: what an offer DM may
 *  carry and say (`products/offers.ts`). The yes on its card is the approval. */
const offerSet = z
  .object({
    kind: z.literal("offer.set"),
    productId: z.number().int().positive(),
    ...offerWords.shape,
  })
  .strict();

type OfferSet = z.infer<typeof offerSet>;

const offerRetire = z
  .object({
    kind: z.literal("offer.retire"),
    productId: z.number().int().positive(),
  })
  .strict();

type OfferRetire = z.infer<typeof offerRetire>;

/** The one product a campaign's drafts draw on, or none (`productId: null`).
 *  The Ambassador's Product row is the page's own save of the same pick. */
const campaignProduct = z
  .object({
    kind: z.literal("campaign.product"),
    campaignId: z.number().int().positive(),
    productId: z.number().int().positive().nullable(),
  })
  .strict();

type CampaignProduct = z.infer<typeof campaignProduct>;

const knowledgeCreate = z
  .object({
    kind: z.literal("knowledge.create"),
    slot,
    title: z.string().trim().max(200).optional(),
    content: z.string().min(1).max(20_000),
    tags: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
  })
  .strict();

type KnowledgeCreate = z.infer<typeof knowledgeCreate>;

const knowledgeUpdate = z
  .object({
    kind: z.literal("knowledge.update"),
    id: z.number().int().positive(),
    slot: slot.optional(),
    title: z.string().trim().max(200).nullable().optional(),
    content: z.string().min(1).max(20_000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(16).nullable().optional(),
  })
  .strict();

type KnowledgeUpdate = z.infer<typeof knowledgeUpdate>;

/** A person the account must never engage, by the id every send gate checks.
 *  `name` and `url` are there so the CARD can say who it is — a bare profile id
 *  is not a person the owner can recognise, and a blocklist entry approved
 *  without recognising it is not an approval. */
const doNotEngageShape = {
  profileId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300).optional(),
  url: z.string().trim().url().max(2_048).optional(),
  notes: z.string().trim().max(2_000).optional(),
};

const doNotEngageAdd = z
  .object({ kind: z.literal("do_not_engage.add"), ...doNotEngageShape })
  .strict();

const doNotEngageRemove = z
  .object({ kind: z.literal("do_not_engage.remove"), ...doNotEngageShape })
  .strict();

type DoNotEngageAdd = z.infer<typeof doNotEngageAdd>;
type DoNotEngageRemove = z.infer<typeof doNotEngageRemove>;
/** What the two share: everything the card and the write read. The kinds
 *  differ only in which way the flag goes. */
type DoNotEngage = Omit<DoNotEngageAdd, "kind">;

/** The blocklist row as it stands, read straight off the table rather than
 *  through `listEngagedProfiles`: that projection joins the ledger to answer
 *  the PAGE's question — who has been engaged, how often — and a proposal about
 *  one flag has no business paying for the history behind it or depending on
 *  how its free-text search matches an id. */
async function readEngagedProfile(
  tx: Tx,
  profileId: string,
): Promise<{
  known: boolean;
  doNotEngage: boolean;
  name: string | null;
  url: string | null;
}> {
  const [row] = await tx
    .select({
      doNotEngage: engagedProfiles.doNotEngage,
      name: engagedProfiles.name,
      url: engagedProfiles.url,
    })
    .from(engagedProfiles)
    .where(eq(engagedProfiles.profileId, profileId));
  return {
    known: row !== undefined,
    doNotEngage: row?.doNotEngage ?? false,
    name: row?.name ?? null,
    url: row?.url ?? null,
  };
}

/** A product's offer as its card states it: the product by name, the words,
 *  and where they stand. */
async function readOfferState(tx: Tx, productId: number): Promise<ProposalBefore> {
  const [product] = await tx.select({ name: products.name }).from(products).where(eq(products.id, productId));
  if (!product) missing(`product ${productId}`);
  const offer = await readOffer(tx, productId);
  return {
    product: product.name,
    url: offer?.url ?? null,
    what: offer?.what ?? null,
    facts: offer?.facts ?? [],
    status: offer === null ? NOTHING : offer.retired ? "retired" : offer.approved ? "approved" : "waiting for a yes",
  };
}

type NamedProduct = { id: number; name: string };

/** A campaign's product as its card states it: the campaign, the product its
 *  drafts use, every one an older campaign still has attached, and the one
 *  picked — read here, so a card never names a product the org does not hold. */
async function readCampaignProduct(tx: Tx, value: CampaignProduct): Promise<ProposalBefore> {
  const campaign = await getCampaign(tx, value.campaignId);
  if (!campaign) missing("This campaign");
  const { product, attached } = await campaignOneEach(tx, campaign);
  const [picked] =
    value.productId === null
      ? []
      : await tx.select({ id: products.id, name: products.name }).from(products).where(eq(products.id, value.productId));
  if (value.productId !== null && !picked) missing(`product ${value.productId}`);
  return { campaign: campaign.name, product, attached, picked: picked ?? null };
}

function offerFacts(facts: unknown): string {
  return Array.isArray(facts) && facts.length > 0 ? facts.join("; ") : "nothing more";
}

/**
 * WHO THE CARD IS ABOUT, and the difference between a label and an identity.
 *
 * `profileId` is what `canEngage` checks before every comment, reply and like.
 * A NAME is decoration, and on a proposal it is decoration the MODEL supplied —
 * which is how "Never engage A. Person again" could sit above an id belonging
 * to somebody else entirely, approved by an owner who read the only words the
 * card showed them. So the name is a heading, the id is a ROW, and the row is
 * what the decision actually is.
 *
 * The heading prefers what is STORED: a profile this account has engaged
 * carries a name Engager learned from the account itself, and that is evidence.
 * A model-supplied one is marked as unconfirmed, because an owner reading an
 * unmarked name has no way to tell which of the two they are looking at.
 */
function personHeading(before: ProposalBefore, value: DoNotEngage): string {
  const stored = typeof before.name === "string" ? before.name : null;
  if (stored) return stored;
  return value.name ? `${value.name} (unconfirmed name)` : "this profile";
}

/**
 * The rows every blocklist card carries whatever else it says: the id the send
 * gate reads, and the link, so what the owner approves is an identity rather
 * than a string.
 *
 * The link is the STORED one wherever there is one, for the same reason
 * `doNotEngageInput` refuses to overwrite it — and for a second reason that is
 * about the card rather than the row. The apply keeps the stored link, so a
 * card that showed the proposal's would be offering the owner a URL the
 * decision is never going to store: a heading reading "Dana Whitfield" over a
 * link to somewhere else entirely, which is a worse version of the labelling
 * problem the heading already solves. A proposal's link shows only where the
 * row has none, marked the way its name is.
 */
function personRows(before: ProposalBefore, value: DoNotEngage): ProposalRow[] {
  const stored = typeof before.url === "string" ? before.url : null;
  const link = stored ?? (value.url ? `${value.url} (unconfirmed)` : null);
  return [
    { label: "Profile", before: NOTHING, after: value.profileId },
    ...(link ? [{ label: "Link", before: NOTHING, after: link }] : []),
  ];
}

/** The three writes that have to recompile the Brain after them.
 *
 *  `storeKnowledge` and `updateKnowledge` only bump `knowledgeVersion`; routing
 *  the compile is the caller's job, and the MCP tools beside these do exactly
 *  this. Skipping it would leave every active campaign's focus brief quoting a
 *  note that no longer says what it says — the failure is silent and shows up
 *  as drafting that is subtly out of date. */
async function afterKnowledgeWrite(
  tx: Tx,
  organizationId: string,
  changed: boolean,
): Promise<Record<string, unknown>> {
  const compile = await compileForVault(tx, organizationId, changed);
  // Independent of the compile: a replica row is not spend, and an org whose
  // compile credits are exhausted must keep replicating.
  if (changed && vaultReplicaEnabled()) await syncVaultMirror(tx);
  return compile as Record<string, unknown>;
}

type LookalikeCardBefore = {
  status: string; stale: boolean; author: string; opening: string; comments: number;
  postReads: number; fits: number; judged: number; pains: string[]; proposals: LookalikeProposalJson[];
};

/**
 * A strategy patch's card, as it reads now. The whole drawn card is the
 * `before`: the version it was written against, the account default it
 * resolved under, and the diff the owner reads — with what the change does
 * said plainly, and for a designed strategy what it will and will not do. A
 * click is refused stale if any of it moved.
 */
async function readStrategyPatch(tx: Tx, value: StrategyPatch): Promise<ProposalBefore> {
  const prepared = await preparePatch(tx, value, { now: Date.now(), lock: false });
  const { state } = prepared;
  const designed =
    state.notStarted || value.provenance.compilerVersion === TEMPLATE_COMPILER_VERSION;
  return {
    campaignId: value.campaignId,
    activeVersion: state.active.version,
    accountDefaultVersion: state.accountDefault?.version ?? null,
    level: prepared.level,
    title: prepared.title,
    rows: prepared.rows,
    preview: [
      ...changePreview(state.base, prepared.document),
      ...(await voiceRedraftPreview(tx, value.campaignId, state.base.voice, prepared.document.voice)),
    ],
    ...(designed
      ? {
          design: describeDesign({
            document: prepared.document,
            accountDefault: state.accountDefault?.document ?? null,
            network: state.network,
            connector: state.channel.connector
              ? CONNECTOR_DECLARATIONS[state.channel.connector]
              : null,
            liveChecks: state.liveChecks,
            channel: state.channel,
          }),
        }
      : {}),
    ...(state.notStarted ? { start: true } : {}),
  };
}

export const PROPOSAL_KINDS = {
  "searches.from_post": kind({
    level: "confirm",
    selectable: true,
    schema: z.object({ kind: z.literal("searches.from_post"), campaignId: z.number().int().positive(),
      lookalikeId: z.number().int().positive() }).strict(),
    page: (value) => ({ key: "campaign_searches", id: value.campaignId }),
    read: async (tx, _org, value) => {
      const row = await readLookalike(tx, value.campaignId, value.lookalikeId);
      return { status: row.status, stale: row.stale, contextRevision: row.contextRevision,
        author: row.authorName || "the author", opening: row.opening, comments: row.comments,
        postReads: row.readSpentAt === null ? 0 : 1, fits: row.fits, judged: row.judged,
        pains: row.painTexts, proposals: row.proposals };
    },
    summarize: (before) => {
      const row = before as unknown as LookalikeCardBefore;
      const choices = row.status === "read" && !row.stale ? row.proposals.flatMap((proposal, index) =>
        proposal.state === "open" ? [{ index, label: proposal.displayName || proposal.term,
          // A room read onto a search map judged no one: its proposals say why themselves.
          detail: proposal.source ? `Audience magnet · ${proposal.line}` : proposal.languageType ? proposal.line
            : proposal.intent === "magnet_author" ? `Audience magnet · their room held ${row.fits} people who fit`
            : proposal.intent === "pain" ? "Pain · in their words" : "Topic",
          checked: proposal.intent !== "topic" }] : []) : [];
      return { title: `Searches from ${row.author}'s post`,
        rows: choices.map((choice) => ({ label: choice.detail, before: "Not added", after: choice.label })),
        selection: choices,
        searchEvidence: { opening: row.opening, comments: row.comments, postReads: row.postReads,
          fits: row.fits, judged: row.judged, pains: row.pains } };
    },
    apply: async (tx, _org, value, context) => {
      const row = await readLookalike(tx, value.campaignId, value.lookalikeId);
      const indices = context.selection;
      if (!indices?.length || indices.some((index) => !row.proposals[index] || row.proposals[index]!.state !== "open")) {
        throw new InvalidProposalError("Choose open searches from this card.", "Nothing was added. Refresh the card and select its saved suggestions.");
      }
      for (const index of indices) await addLookalikeSearch(tx, value.campaignId, value.lookalikeId, index, context.now);
      return { changed: true, added: indices.length, selected: indices };
    },
  }),
  "pacing.update": kind<PacingUpdate>({
    level: "apply",
    schema: pacingUpdate,
    page: () => ({ key: "pacing" }),
    read: async (tx, organizationId) => {
      const safety = await getOrgSafety(tx, organizationId);
      if (!safety) missing("this account's pacing");
      return { ...safety };
    },
    summarize: (before, value) => {
      const current = before as unknown as OrgSafety;
      // The AFTER is what the save would store, clamp included — computed by
      // the function the save itself calls, so the two cannot disagree.
      const next = orgSafetyAfter(current, pacingPatch(value));
      const rows: ProposalRow[] = [
        ...moved(
          PACING_LABELS.dailyCommentCap,
          num(current.dailyCommentCap),
          num(next.dailyCommentCap),
        ),
        ...moved(
          PACING_LABELS.dailyReplyCap,
          num(current.dailyReplyCap),
          num(next.dailyReplyCap),
        ),
        ...moved(
          PACING_LABELS.dailyEngageCap,
          num(current.dailyEngageCap),
          num(next.dailyEngageCap),
        ),
        ...moved(
          PACING_LABELS.perProfileDayCap,
          num(current.perProfileDayCap),
          num(next.perProfileDayCap),
        ),
        ...moved(
          PACING_LABELS.perProfileWeekCap,
          num(current.perProfileWeekCap),
          num(next.perProfileWeekCap),
        ),
        ...moved(
          PACING_LABELS.perProfileMonthCap,
          num(current.perProfileMonthCap),
          num(next.perProfileMonthCap),
        ),
        ...moved(
          PACING_LABELS.minActionGapSec,
          num(current.minActionGapSec),
          num(next.minActionGapSec),
        ),
        ...moved(
          PACING_LABELS.minDelaySec,
          num(current.minDelaySec),
          num(next.minDelaySec),
        ),
        ...moved(
          PACING_LABELS.warmupWeeks,
          warmupWords(current.warmupWeeks),
          warmupWords(next.warmupWeeks),
        ),
        ...moved(
          PACING_LABELS.warmupStartRate,
          num(current.warmupStartRate),
          num(next.warmupStartRate),
        ),
        ...moved(
          PACING_LABELS.activeHours,
          window(current.activeHours),
          window(next.activeHours),
        ),
        ...moved(
          PACING_LABELS.activeDays,
          days(current.activeDays),
          days(next.activeDays),
        ),
        ...moved(
          PACING_LABELS.dailyThreadReadCap,
          num(current.dailyThreadReadCap),
          num(next.dailyThreadReadCap),
        ),
        ...moved(
          PACING_LABELS.dailyProfileReadCap,
          num(current.dailyProfileReadCap),
          num(next.dailyProfileReadCap),
        ),
        ...moved(
          PACING_LABELS.dailySearchPageCap,
          num(current.dailySearchPageCap),
          num(next.dailySearchPageCap),
        ),
        ...moved(
          PACING_LABELS.hourlySearchCap,
          num(current.hourlySearchCap),
          num(next.hourlySearchCap),
        ),
        ...moved(
          PACING_LABELS.dailyReplyCheckCap,
          num(current.dailyReplyCheckCap),
          num(next.dailyReplyCheckCap),
        ),
        ...moved(
          PACING_LABELS.replyCheckBaseMin,
          num(current.replyCheckBaseMin),
          num(next.replyCheckBaseMin),
        ),
        ...moved(
          PACING_LABELS.inboxCheckBaseMin,
          num(current.inboxCheckBaseMin),
          num(next.inboxCheckBaseMin),
        ),
        ...moved(
          PACING_LABELS.writeAhead,
          WRITE_AHEAD_WORDS[current.writeAhead],
          WRITE_AHEAD_WORDS[next.writeAhead],
        ),
      ];
      return { title: "Change this account's pacing", rows };
    },
    apply: async (tx, organizationId, value) => {
      const applied = await updateOrgSafety(
        tx,
        organizationId,
        pacingPatch(value),
      );
      if (!applied) missing("this account's pacing");
      return { ...applied };
    },
  }),

  "strategy.patch": kind<StrategyPatch>({
    // The fallback, and the stricter one: each proposal's own diff decides.
    level: "confirm",
    schema: strategyPatchSchema,
    // The campaign's own strategy, where the inspector edits the same document.
    page: (value) => ({ key: "campaign", id: value.campaignId }),
    read: (tx, _organizationId, value) => readStrategyPatch(tx, value),
    summarize: (before) => ({
      title: String(before.title),
      rows: before.rows as ProposalRow[],
      level: before.level === "apply" ? "apply" : "confirm",
      ...(Array.isArray(before.preview) && before.preview.length > 0
        ? { preview: before.preview as string[] }
        : {}),
      ...(before.design ? { design: before.design as DesignSummary } : {}),
      ...(before.start === true ? { start: true as const } : {}),
    }),
    conflict: async (tx, _organizationId, value) =>
      conflictWith(await readPatchState(tx, value.campaignId, { lock: false }), value),
    apply: async (tx, _organizationId, value, context) => {
      const state = await readPatchState(tx, value.campaignId, { lock: false });
      if (!state.notStarted || value.ops.length > 0) return { ...(await applyStrategyPatch(tx, value, context)) };
      if (!context.approver) throw new Error("An owner must confirm Start.");
      const started = await startCampaign(tx, value.campaignId, value.expectedBaseVersion, { approver: context.approver, now: context.now, instruction: value.provenance.instruction, confirmed: true, patch: value });
      return { ...started.result };
    },
  }),

  "voice.update": kind<VoiceUpdate>({
    level: "confirm",
    schema: voiceUpdate,
    page: () => ({ key: "voice" }),
    // Read from the PROFILE, which is the store `/voice` renders from: the
    // before the owner is shown has to be the words on the page they would
    // otherwise have edited.
    read: async (tx, _organizationId, value) => {
      const surface = (await getProfile(tx)).voices?.[value.surface];
      return {
        persona: surface?.persona ?? null,
        houseStyle: surface?.houseStyle ?? null,
      };
    },
    summarize: (before, value) => ({
      title: `Change how you sound on ${value.surface === "comment" ? "comments" : "posts"}`,
      rows: [
        ...moved(
          "Persona",
          text(before.persona as string | null),
          text(value.persona ?? (before.persona as string | null)),
        ),
        ...moved(
          "House style",
          text(before.houseStyle as string | null),
          text(value.houseStyle ?? (before.houseStyle as string | null)),
        ),
      ],
    }),
    apply: async (tx, _organizationId, value) => {
      // The Voice page's own writer, and the reason this kind has no voiceId:
      // it dual-writes the default voice row and the profile singleton, so
      // what drafting reads and what `/voice` shows cannot end up disagreeing.
      await setChannelVoice(tx, value.surface, {
        ...(value.persona !== undefined ? { persona: value.persona } : {}),
        ...(value.houseStyle !== undefined
          ? { houseStyle: value.houseStyle }
          : {}),
        // The owner typed the yes, so the provenance is the owner's — never
        // the distillation's, which is what calibration means and this is not.
        sources: ["manual"],
      });
      return { surface: value.surface };
    },
  }),

  "voice_question.answer": kind<VoiceAnswerProposal>({
    level: "confirm",
    schema: voiceQuestionAnswer,
    page: () => ({ key: "voice" }),
    // The question as the default voice holds it now: what the owner is shown
    // beside their answer, and what an answer given elsewhere since makes
    // stale. Read, never created — a voice comes into being on the yes.
    read: async (tx, _organizationId, value) => {
      const checked = checkVoiceAnswer(value.key, value.answer);
      if (!checked.ok) refuseAnswer(checked.detail);
      const { questions } = await listVoiceQuestions(tx, {});
      const question = questions.find((q) => q.key === value.key)!;
      return { status: question.status, answer: question.answer };
    },
    summarize: (before, value) => {
      const checked = checkVoiceAnswer(value.key, value.answer);
      if (!checked.ok) refuseAnswer(checked.detail);
      const was =
        before.answer == null
          ? NOTHING
          : voiceAnswerWords(value.key, before.answer as VoiceAnswerProposal["answer"]);
      return {
        title: "Save how you want to sound",
        rows:
          was === checked.words
            ? []
            : [
                {
                  label: VOICE_QUESTIONS.find((q) => q.key === value.key)!.prompt,
                  before: was,
                  after: `${checked.words} · from your answer in chat`,
                },
              ],
      };
    },
    apply: async (tx, _organizationId, value) => {
      const voice = await ensureDefaultVoice(tx);
      const outcome = await answerVoiceQuestion(tx, {
        voiceId: voice.id,
        key: value.key,
        answer: value.answer,
        via: "agent",
      });
      if (!outcome.ok) refuseAnswer(outcome.detail);
      return { key: outcome.key, sets: [...outcome.sets], value: outcome.value };
    },
  }),

  "knowledge.create": kind<KnowledgeCreate>({
    level: "confirm",
    schema: knowledgeCreate,
    page: () => ({ key: "brain" }),
    // Nothing exists yet, so there is nothing that can go stale — and an empty
    // `before` is the honest statement of that rather than a missing field.
    read: async () => ({}),
    summarize: (_before, value) => ({
      title: "Add a note to the Brain",
      rows: [
        { label: "Slot", before: NOTHING, after: value.slot },
        ...(value.title
          ? [{ label: "Title", before: NOTHING, after: value.title }]
          : []),
        { label: "Note", before: NOTHING, after: value.content },
      ],
    }),
    apply: async (tx, organizationId, value) => {
      // Interactive writes race seed/refresh's phased applies for the same
      // note-id scan — serialize on the same advisory lock they take.
      await lockBrainMutation(tx);
      const result = await storeKnowledge(tx, {
        slot: value.slot,
        ...(value.title !== undefined ? { title: value.title } : {}),
        content: value.content,
        ...(value.tags !== undefined ? { tags: value.tags } : {}),
        source: "manual",
      });
      return {
        changed: result.changed,
        ids: result.changedIds,
        ...(await afterKnowledgeWrite(tx, organizationId, result.changed)),
      };
    },
  }),

  "knowledge.update": kind<KnowledgeUpdate>({
    level: "confirm",
    schema: knowledgeUpdate,
    page: () => ({ key: "brain" }),
    read: async (tx, _organizationId, value) => {
      const note = (await listKnowledge(tx)).find((row) => row.id === value.id);
      if (!note) missing(`Brain note ${value.id}`);
      return {
        slot: note.slot,
        title: note.title,
        content: note.content,
        tags: note.tags,
      };
    },
    summarize: (before, value) => ({
      title: "Edit a Brain note",
      rows: [
        ...moved("Slot", String(before.slot), value.slot ?? String(before.slot)),
        ...moved(
          "Title",
          text(before.title as string | null),
          text(value.title !== undefined ? value.title : (before.title as string | null)),
        ),
        ...moved(
          "Note",
          String(before.content),
          value.content ?? String(before.content),
        ),
      ],
    }),
    apply: async (tx, organizationId, value) => {
      await lockBrainMutation(tx);
      const result = await updateKnowledge(tx, value.id, {
        ...(value.slot !== undefined ? { slot: value.slot } : {}),
        ...(value.title !== undefined ? { title: value.title } : {}),
        ...(value.content !== undefined ? { content: value.content } : {}),
        ...(value.tags !== undefined ? { tags: value.tags } : {}),
      });
      return {
        changed: result.changed,
        ids: result.changedIds,
        ...(await afterKnowledgeWrite(tx, organizationId, result.changed)),
      };
    },
  }),

  "offer.set": kind<OfferSet>({
    level: "confirm",
    schema: offerSet,
    page: () => ({ key: "brain" }),
    read: (tx, _organizationId, value) => readOfferState(tx, value.productId),
    summarize: (before, value) => ({
      title: `Approve ${String(before.product)}'s offer`,
      rows: [
        ...moved("Link", text(before.url as string | null), value.url),
        ...moved("What it is", text(before.what as string | null), value.what),
        ...moved("What a DM may say about it", offerFacts(before.facts), offerFacts(value.facts)),
        ...moved("Offer", String(before.status), "approved"),
      ],
      preview: [
        "A DM that makes this offer carries this link and says only these things about it. Each one still waits for your yes.",
        "No DM implies a free trial, a discount or instant access unless a line above says so.",
      ],
    }),
    apply: async (tx, _organizationId, value, context) => ({
      ...(await saveOffer(
        tx,
        { productId: value.productId, url: value.url, what: value.what, facts: value.facts },
        { approver: context.approver ?? "owner:chat", now: context.now },
      )),
    }),
  }),

  "offer.retire": kind<OfferRetire>({
    level: "confirm",
    destructive: true,
    schema: offerRetire,
    page: () => ({ key: "brain" }),
    read: (tx, _organizationId, value) => readOfferState(tx, value.productId),
    summarize: (before) => ({
      title: `Retire ${String(before.product)}'s offer`,
      rows: [
        ...(before.url === null ? [] : [{ label: "Link", before: String(before.url), after: String(before.url) }]),
        ...moved("Offer", String(before.status), "retired"),
      ],
      preview: ["No DM makes this offer from now on, and one already waiting for your yes can no longer be sent."],
    }),
    apply: async (tx, _organizationId, value, context) => ({
      ...(await retireOffer(tx, { productId: value.productId }, { now: context.now })),
    }),
  }),

  /**
   * THE ONE PRODUCT A CAMPAIGN'S DRAFTS DRAW ON, OR NONE — for the owner's
   * yes, through the Ambassador's own pick (`pickCampaignProduct`), brief
   * recompile included. The pick replaces whatever an older campaign still has
   * attached. Product promotion keeps one: the save refuses none.
   */
  "campaign.product": kind<CampaignProduct>({
    level: "confirm",
    schema: campaignProduct,
    page: (value) => ({ key: "campaign", id: value.campaignId }),
    read: (tx, _organizationId, value) => readCampaignProduct(tx, value),
    summarize: (before) => campaignProductCard(before),
    apply: async (tx, organizationId, value) => {
      if (!(await pickCampaignProduct(tx, organizationId, value.campaignId, value.productId)).ok) {
        missing("This campaign");
      }
      return { campaignId: value.campaignId, productId: value.productId };
    },
  }),

  "do_not_engage.add": kind<DoNotEngageAdd>({
    level: "confirm",
    schema: doNotEngageAdd,
    page: () => ({ key: "channel" }),
    read: (tx, _organizationId, value) =>
      readEngagedProfile(tx, value.profileId),
    summarize: (before, value) => ({
      title: `Never engage ${personHeading(before, value)} again`,
      rows: [
        ...personRows(before, value),
        {
          label: "Engagement",
          before: before.doNotEngage ? "blocked" : "allowed",
          after: "blocked",
        },
        ...(value.notes
          ? [{ label: "Why", before: NOTHING, after: value.notes }]
          : []),
      ],
    }),
    apply: async (tx, _organizationId, value) =>
      setDoNotEngage(tx, {
        ...doNotEngageInput(value, await readEngagedProfile(tx, value.profileId)),
        doNotEngage: true,
      }),
  }),

  "do_not_engage.remove": kind<DoNotEngageRemove>({
    level: "confirm",
    // Removing a block is the direction that lets an account engage someone it
    // had been told not to, so the card asks twice even though the level is
    // `confirm` — the tone is about consequence, not about which buttons.
    destructive: true,
    schema: doNotEngageRemove,
    page: () => ({ key: "channel" }),
    read: (tx, _organizationId, value) =>
      readEngagedProfile(tx, value.profileId),
    summarize: (before, value) => ({
      title: `Allow engaging ${personHeading(before, value)} again`,
      rows: [
        ...personRows(before, value),
        {
          label: "Engagement",
          before: before.doNotEngage ? "blocked" : "allowed",
          after: "allowed",
        },
      ],
    }),
    apply: async (tx, _organizationId, value) =>
      setDoNotEngage(tx, {
        ...doNotEngageInput(value, await readEngagedProfile(tx, value.profileId)),
        doNotEngage: false,
      }),
  }),

  /**
   * THE ACCOUNT'S OWN POLICY: the rolling-24h ceilings that are all that lets
   * a new kind go out without a yes, the per-person DM cap and its unattended
   * sending windows — the account default every campaign on the channel
   * spends (`strategy/accountPolicy.ts`). Numbers and hours only: no mode.
   * Its level follows its diff, like a campaign's patch: a ceiling set or
   * raised, or a window widened, confirms; anything that only holds the
   * account closer applies.
   */
  [ACCOUNT_POLICY_UPDATE]: kind<AccountPolicyUpdate>({
    level: "confirm",
    schema: accountPolicyUpdateSchema,
    page: () => ({ key: "channel" }),
    // The drawn card is the `before`: a click after another change to the
    // account moved anything it shows is refused stale. Not the version it was
    // drawn against — an agent setting an account up draws one card per
    // setting, and each must stay answerable after the one before it lands,
    // so long as what it says is still true.
    read: async (tx, _organizationId, value) => {
      const now = Date.now();
      const prepared = prepareAccountPolicy(
        await readAccountPolicyState(tx, { lock: false, now }),
        value,
        now,
      );
      return {
        level: prepared.level,
        title: prepared.title,
        rows: prepared.rows,
        preview: prepared.preview,
      };
    },
    summarize: (before) => ({
      title: String(before.title),
      rows: before.rows as ProposalRow[],
      level: before.level === "apply" ? "apply" : "confirm",
      ...(Array.isArray(before.preview) && before.preview.length > 0
        ? { preview: before.preview as string[] }
        : {}),
    }),
    apply: async (tx, _organizationId, value, context) => ({
      ...(await applyAccountPolicy(tx, value, context)),
    }),
  }),

  /** The full profile and revision are the card's base. The row lock keeps
   *  that comparison and the canonical writer inside one owner decision. */
  [AUDIENCE_UPDATE]: kind<AudienceChange>({
    level: "apply",
    schema: audienceChangeSchema,
    page: (value) => ({ key: "campaign", id: value.campaignId }),
    read: async (tx, _organizationId, value) => {
      const [campaign] = await tx.select().from(campaigns).where(and(
        eq(campaigns.id, value.campaignId), isNull(campaigns.deletedAt),
      )).for("update");
      if (!campaign) missing("This campaign");
      return { name: campaign.name, profile: audienceProfile(campaign) };
    },
    summarize: (before, value) => {
      const profile = before.profile as AudienceProfile;
      const next = changedAudience(profile, value);
      const pains = (items: AudienceProfile["pains"]) => items.map((pain, index) =>
        `P${index + 1} ${pain.text}${pain.phrases.length ? ` (${pain.phrases.join("; ")})` : ""}${pain.status !== "active" ? ` · ${pain.status}` : ""}`).join("\n") || NOTHING;
      const rows = [
        ...moved("Who they are", text(profile.who.summary), text(next.who.summary)),
        ...moved("Signals", text(profile.who.signals.join("; ")), text(next.who.signals.join("; "))),
        ...moved("Company kinds", text(profile.who.companyKinds.join("; ")), text(next.who.companyKinds.join("; "))),
        ...moved("Pains", pains(profile.pains), pains(next.pains)),
        ...moved("Not them", text(profile.notThem.join("; ")), text(next.notThem.join("; "))),
      ];
      if (rows.length === 0) throw new NoAudienceChange();
      return { title: `Change who ${String(before.name)} is looking for`, rows };
    },
    apply: async (tx, organizationId, value, context) => {
      const campaign = await getCampaign(tx, value.campaignId);
      if (!campaign) missing("This campaign");
      const profile = audienceProfile(campaign);
      return { campaignId: value.campaignId, ...(await saveAudience(tx, organizationId, value.campaignId, {
        baseRevision: profile.revision, profile: changedAudience(profile, value),
      }, context.now, { reason: "chat_proposal", changedBy: "owner" })) };
    },
  }),

  /** The campaign's name, goal and legacy relevance test. Strategy can show
   *  moved facts and take an informed yes while they still say what it showed. */
  [CAMPAIGN_FACTS]: kind<CampaignFactsChange>({
    level: "confirm",
    schema: campaignFactsSchema,
    informedYes: true,
    page: (value) => ({ key: "campaign", id: value.campaignId }),
    read: async (tx, _organizationId, value) => {
      const base = await readCampaignFactsBase(tx, value.campaignId);
      if (!base) missing("This campaign");
      return base;
    },
    summarize: (before, value) => campaignFactsCard(campaignFactsBaseSchema.parse(before), value.patch),
    apply: async (tx, organizationId, value) => {
      const now = await readCampaignFactsBase(tx, value.campaignId);
      if (!now) missing("This campaign");
      // A yes to what the fields already say — an owner who typed the value
      // themselves, and was shown that — writes nothing, and says so.
      const changed = (Object.keys(value.patch) as (keyof CampaignFactsPatch)[]).some(
        (field) => value.patch[field] !== now[field],
      );
      if (!changed) return { campaignId: value.campaignId, changed: false };
      if (!(await writeCampaignFacts(tx, organizationId, value.campaignId, value.patch)).ok) {
        missing("This campaign");
      }
      return { campaignId: value.campaignId, fields: Object.keys(value.patch) };
    },
  }),

  /**
   * DELETING ONE CAMPAIGN. Drawn by the owner's own agent (`delete_campaign`)
   * and never by chat — it is not in the union below — and spent only by the
   * owner's click on the campaign's Changes. Final: its apply is
   * `deleteCampaign`, which nothing reverses, so the card asks twice.
   */
  [CAMPAIGN_DELETE]: kind<CampaignDelete>({
    level: "confirm",
    destructive: true,
    schema: campaignDeleteSchema,
    page: (value) => ({ key: "campaign", id: value.campaignId }),
    read: async (tx, _organizationId, value) => {
      const campaign = await getCampaign(tx, value.campaignId);
      if (!campaign) missing("This campaign");
      return { name: campaign.name, status: campaign.status };
    },
    summarize: (before) => ({
      title: `Delete ${String(before.name)}`,
      rows: [
        {
          label: "Campaign",
          before: CAMPAIGN_STATUS_WORDS[before.status as Campaign["status"]] ?? NOTHING,
          after: "Deleted",
        },
      ],
      preview: [...DELETE_CAMPAIGN_WORDS],
    }),
    apply: async (tx, _organizationId, value, context) => ({
      ...(await deleteCampaign(tx, value.campaignId, {
        by: context.approver ?? "owner",
        now: context.now,
      })),
    }),
  }),

  /**
   * A QUICK CAMPAIGN, CREATED AND STARTED by the card's one yes
   * (`chat/quickCampaign.ts`). Drawn by chat's `patch_campaign_strategy`
   * from a Quick design, which names no campaign: nothing exists until the
   * yes, and no campaign page lists it. Its `before` is the Start the yes
   * would make and the campaign it would create, read off a dry run of that
   * press — never their ids, which a dry run spends and the yes does not
   * reuse.
   */
  [CAMPAIGN_CREATE_AND_START]: kind<CreateAndStart>({
    level: "confirm",
    schema: createAndStartSchema,
    page: () => ({ key: "campaign" }),
    read: (tx, organizationId, value) =>
      dryRun(tx, async (savepoint) => {
        const { campaignId, start } = await createWithStrategy(savepoint, organizationId, value, {
          approver: null,
          now: Date.now(),
        });
        const { rows, design } = await readStrategyPatch(savepoint, start);
        return { rows, design, facts: factsOf((await getCampaign(savepoint, campaignId))!) };
      }),
    summarize: (before) => ({
      title: "Start this campaign",
      rows: before.rows as ProposalRow[],
      design: before.design as DesignSummary,
      facts: before.facts as CampaignFact[],
      start: true,
    }),
    apply: async (tx, organizationId, value, context) => ({
      ...(await createAndStart(tx, organizationId, value, context)),
    }),
  }),
} as const satisfies Record<string, ProposalKind>;

export type ProposalKindName = keyof typeof PROPOSAL_KINDS;

export const PROPOSAL_KIND_NAMES = Object.keys(
  PROPOSAL_KINDS,
) as ProposalKindName[];

export function isProposalKindName(value: string): value is ProposalKindName {
  return Object.hasOwn(PROPOSAL_KINDS, value);
}

/**
 * The whole change surface as ONE schema, which is what the model is shown.
 *
 * A discriminated union rather than a free-form object: the model reads every
 * kind and every field of each from its own tool definition, and the SDK
 * refuses a smuggled key by name inside the `.strict()` member it belongs to.
 * A `z.record(z.unknown())` would have moved both of those into the handler and
 * shown the model nothing.
 *
 * `strategy.patch` is a kind and NOT a member here. Its schema is the size
 * of every other kind together, and this union rides every model step of every
 * turn; chat draws its card through its own strategy tools instead
 * (`chat/campaignStrategy.ts`), which say a template or a recognized
 * instruction rather than ops. Nor is `campaign.delete`: deleting a campaign
 * is the owner's own decision, asked for at most by their own agent, and chat
 * reads third-party text.
 */
export const PROPOSED_CHANGE = z.discriminatedUnion("kind", [
  pacingUpdate,
  accountPolicyUpdateSchema,
  voiceUpdate,
  voiceQuestionAnswer,
  knowledgeCreate,
  knowledgeUpdate,
  doNotEngageAdd,
  doNotEngageRemove,
  offerSet,
  offerRetire,
  campaignProduct,
]);

/** A goal as its picker names it. */
function goalWords(id: string): string {
  return Object.hasOwn(OBJECTIVE_BY_ID, id) ? OBJECTIVE_BY_ID[id as keyof typeof OBJECTIVE_BY_ID].label : id;
}

/** What a campaign-facts card says: each field it moves, from what it says
 *  now, and a title naming the one change or the set. */
function campaignFactsCard(base: CampaignFactsBase, patch: CampaignFactsPatch): ProposalDrawing {
  const rows = [
    ...moved("Name", base.name, patch.name ?? base.name),
    ...moved("Goal", goalWords(base.objective), goalWords(patch.objective ?? base.objective)),
    ...moved("Audience", text(base.audience), text(patch.audience ?? base.audience)),
  ];
  const [only] = rows;
  const title =
    rows.length !== 1 || !only
      ? `Change what “${base.name}” is for`
      : only.label === "Name"
        ? `Rename “${base.name}” to “${only.after}”`
        : only.label === "Goal"
          ? `Change the goal of “${base.name}”`
          : `Change who “${base.name}” looks for`;
  return { title, rows };
}

/** What a campaign-product card says: the product its drafts use now — or
 *  each an older campaign still has attached — and the one picked. */
function campaignProductCard(before: ProposalBefore): ProposalDrawing {
  const campaign = String(before.campaign);
  const product = before.product as NamedProduct | null;
  const attached = before.attached as NamedProduct[] | null;
  const picked = before.picked as NamedProduct | null;
  if (attached === null && product?.id === picked?.id) {
    throw new InvalidProposalError(
      `“${campaign}” already offers ${picked?.name ?? "nothing"}`,
      "Nothing was proposed. Tell the owner it is already so.",
    );
  }
  return {
    title: picked ? `Offer ${picked.name} on “${campaign}”` : `Offer nothing on “${campaign}”`,
    rows: [{
      label: "Product",
      before: attached ? attached.map((named) => named.name).join(", ") : (product?.name ?? "none"),
      after: picked?.name ?? "none",
    }],
    preview: [
      picked
        ? `Its next drafts draw on ${picked.name}, as context. Drafts already waiting stay as written.`
        : "Its next drafts offer nothing. Drafts already waiting stay as written.",
    ],
  };
}

/**
 * The blocklist write's own input — without the discriminator, without the
 * `undefined` keys `setDoNotEngage` reads as "overwrite with nothing", and
 * without any label the stored row already has.
 *
 * `setDoNotEngage` upserts `name` and `url` whenever they are present, so a
 * proposal carrying them RELABELS an existing row. Engager learned that row's
 * name from the account's own engagement history; a proposal's came from
 * whatever text the model was reading. The learned one wins, and the flag —
 * the only thing the owner actually decided — is written either way.
 *
 * A row that has no label yet may take the proposal's, marked `unconfirmed`,
 * so every surface that renders the blocklist says which kind of name it is
 * showing rather than presenting a model's guess as a fact about a person.
 */
function doNotEngageInput(
  value: DoNotEngage,
  stored: { name: string | null; url: string | null },
) {
  return {
    profileId: value.profileId,
    ...(value.name !== undefined && stored.name === null
      ? { name: `${value.name} (unconfirmed)` }
      : {}),
    ...(value.url !== undefined && stored.url === null
      ? { url: value.url }
      : {}),
    ...(value.notes !== undefined ? { notes: value.notes } : {}),
  };
}

