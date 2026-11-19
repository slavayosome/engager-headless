import type { ScoutIntent } from "@engager/database/schema";
import {
  isSupported,
  type CapabilityKind,
  type ConnectorDeclaration,
} from "../connector/capabilities";
import type { NetworkId } from "../network/registry";
import type { ENTRY_EVENTS } from "./contract";

/**
 * WHAT A CAMPAIGN'S WORKERS CAN DO, said once — the catalog a
 * `CampaignAgentStrategy` binds into and can never edit.
 *
 * An action resolves in four layers, always in this order (INV-34):
 *
 *   1. WORKER KIND — the worker owns an abstract kind of contact, whatever the
 *      network: Scout reads (no contact), the Ambassador talks to people
 *      (one-to-one), Writer broadcasts (later). `ACTION_KIND_OWNERS`.
 *   2. NETWORK CATALOG — `(network, kind)` rows give the owner-facing label,
 *      the network's rules, the effect class and where the mode is stored.
 *      LinkedIn's rows are the only ones today; X or Reddit later are new rows
 *      in `NETWORK_CATALOGS`, never a migration.
 *   3. CONNECTOR — the channel's `CONNECTOR_DECLARATIONS` entry decides whether
 *      the capability is available NOW. This module derives availability from
 *      the declaration and declares nothing of its own: a capability no
 *      declaration key covers yet is unavailable on every connector.
 *   4. CHANNEL CEILINGS — the account-default strategy's budgets, windows and
 *      per-person caps (`resolve.ts`).
 *
 * One label per action within a network, used verbatim on every surface. The
 * words are the founder's (2026-10-10 / 2026-10-11): Triage is part of Find
 * posts and its one-line note is "Why this post"; Verify is Research;
 * "angle" names only the Ambassador's writing options.
 */

export const STRATEGY_WORKERS = ["scout", "ambassador", "writer"] as const;
export type StrategyWorker = (typeof STRATEGY_WORKERS)[number];

/**
 * Each worker's one owner-facing name, and whether a campaign can give it a
 * step yet. Writer is named and not offered: the Add step picker shows it as
 * coming later, and nothing hires one.
 */
export const WORKER_CATALOG = {
  scout: { label: "Scout", offered: true },
  ambassador: { label: "Ambassador", offered: true },
  writer: { label: "Writer", offered: false },
} as const satisfies Record<StrategyWorker, { label: string; offered: boolean }>;

/** Layer 1: each abstract kind and the one worker that owns it. */
export const ACTION_KIND_OWNERS = {
  find: "scout",
  research: "scout",
  company_read: "scout",
  comment: "ambassador",
  react: "ambassador",
  reply: "ambassador",
  room_reply: "ambassador",
  connect: "ambassador",
  accept_connection: "ambassador",
  message: "ambassador",
  follow_up: "ambassador",
  record_outcome: "ambassador",
  post: "writer",
} as const satisfies Record<string, StrategyWorker>;
export type ActionKind = keyof typeof ACTION_KIND_OWNERS;

/**
 * The capability groups a strategy enables. A group's own policy fields are
 * required exactly when it is enabled, and a binding whose kind belongs to a
 * disabled group fails: discover-and-draft needs no invitation, CTA or
 * booking data.
 */
export const CAPABILITY_GROUPS = [
  "discovery",
  "public_engagement",
  "conversation",
  "conversion",
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export const ACTION_KIND_GROUPS = {
  find: "discovery",
  research: "discovery",
  company_read: "discovery",
  comment: "public_engagement",
  react: "public_engagement",
  reply: "public_engagement",
  room_reply: "public_engagement",
  connect: "conversation",
  accept_connection: "conversation",
  message: "conversation",
  follow_up: "conversation",
  record_outcome: "conversion",
  post: "public_engagement",
} as const satisfies Record<ActionKind, CapabilityGroup>;

/** What goes out to a person: Off / Ask me / Automatic. */
export const ACTION_MODES = ["off", "review", "auto"] as const;
export type ActionMode = (typeof ACTION_MODES)[number];

/** What only reads: On / Off. A stored `review` or `auto` on a read fails. */
export const READ_MODES = ["off", "on"] as const;
export type ReadMode = (typeof READ_MODES)[number];

export type BindingMode = ActionMode | ReadMode;

/** One ladder for reads and sends: On and Ask me both let something happen
 *  that Off did not, and Automatic lets it happen unattended. A mode no
 *  binding holds ranks as Off. */
const MODE_RANK: Readonly<Record<BindingMode, number>> = { off: 0, on: 1, review: 1, auto: 2 };
export const rankOf = (mode: BindingMode | null | undefined): number => (mode == null ? 0 : MODE_RANK[mode]);

/**
 * The most an opener may be to someone, by what their own words show
 * (`leads.intent`): the leads Comment step's one mode is the top, and each
 * intent's ceiling sits at or under it, so one step can queue Asking leads'
 * openers while Topic only ones wait for a yes. An intent a binding leaves out
 * reads its default here, so every campaign has an answer without a rewrite.
 */
export const INTENT_CEILING_DEFAULTS = {
  asking: "auto",
  has_problem: "auto",
  topic_only: "review",
} as const satisfies Record<ScoutIntent, ActionMode>;
export type IntentCeilings = Record<ScoutIntent, ActionMode>;

/** The intents a ceiling is kept for, from the most asked to the least. */
export const CEILING_INTENTS = Object.keys(INTENT_CEILING_DEFAULTS) as ScoutIntent[];

/** Each intent as the owner reads it on Leads. */
export const INTENT_LABELS: Readonly<Record<ScoutIntent, string>> = {
  asking: "Asking",
  has_problem: "Has the problem",
  topic_only: "Topic only",
};

/** A binding's ceilings, each intent it leaves out at its default. */
export function intentCeilingsOf(stored: Partial<Record<ScoutIntent, ActionMode>> | undefined): IntentCeilings {
  return { ...INTENT_CEILING_DEFAULTS, ...stored };
}

/**
 * The keys a send is granted, capped and counted under — its grant
 * (`MODE_GRANTS`), the account's rolling-24h ceiling, the first send it
 * waits on. Never where its mode is kept: that is its step's
 * binding, alone. Like post and Like reply share `like_target`, so they share
 * the account's like ceiling and each keeps a mode of its own.
 */
export const MODE_KEYS = [
  "publish_comment",
  "public_reply",
  "room_reply",
  "like_target",
  "invite",
  "accept_invite",
  "dm",
  "followup",
] as const;
export type ModeKey = (typeof MODE_KEYS)[number];

/** Each key's owner-facing name where it speaks for every step that binds
 *  it — Like post and Like reply are both Like on the account. */
export const MODE_KEY_LABELS: Readonly<Record<ModeKey, string>> = {
  publish_comment: "Comment",
  public_reply: "Reply",
  room_reply: "Reply in the room",
  like_target: "Like",
  invite: "Invite",
  accept_invite: "Accept invite",
  dm: "DM",
  followup: "Follow-up",
};

/**
 * The kinds whose ceiling is a stored rolling-24h budget on the account
 * default. `publish_comment` and `public_reply` are not here: their ceiling is
 * the channel's existing day plan (caps, window, warm-up), which is never null
 * (INV-28).
 */
export const BUDGETED_MODE_KEYS = [
  "like_target",
  "invite",
  "accept_invite",
  "dm",
  "followup",
] as const satisfies readonly ModeKey[];
export type BudgetedModeKey = (typeof BUDGETED_MODE_KEYS)[number];

/** The grant each send needs. Permission is distinct from desired behaviour:
 *  a mode says what the owner wants, a grant says what the campaign may do. */
export const MODE_GRANTS = {
  publish_comment: "grant_publish_comment",
  public_reply: "grant_public_reply",
  room_reply: "grant_room_reply",
  like_target: "grant_like",
  invite: "grant_invite",
  accept_invite: "grant_accept",
  dm: "grant_dm",
  followup: "grant_followup",
} as const satisfies Record<ModeKey, string>;
export type GrantId = (typeof MODE_GRANTS)[ModeKey];
export const GRANT_IDS = Object.values(MODE_GRANTS) as [GrantId, ...GrantId[]];

/** The key a capability's sends are granted and capped under — read off its
 *  grant, so it holds on every network — or null for a read, a draft and
 *  Record outcome, which no grant covers. */
export function modeKeyOf(capability: CapabilityId): ModeKey | null {
  const grant: GrantId | null = CAPABILITIES[capability].grant;
  return grant === null ? null : (MODE_KEYS.find((key) => MODE_GRANTS[key] === grant) ?? null);
}

/** What a binding can be aimed at. */
export const TARGET_TYPES = [
  "audience",
  "post",
  "their_reply",
  "room_comment",
  "replied_comment",
  "person",
  "invitation",
  "dm_thread",
  "outcome",
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export type EffectClass = "read" | "draft" | "send" | "none";

/** What a capability needs from the channel's connector. */
export type ConnectorNeed =
  | { needs: "nothing" }
  | { needs: "kinds"; kinds: readonly CapabilityKind[] }
  | {
      needs: "per_target";
      byTarget: Readonly<Partial<Record<TargetType, readonly CapabilityKind[]>>>;
    };

export type CapabilityEntry = {
  version: number;
  /** The kind a binding to this capability performs, or null for a
   *  supporting tool — a read or a draft a step uses but never binds. */
  kind: ActionKind | null;
  effect: EffectClass;
  input: string;
  output: string;
  targets: readonly TargetType[];
  grant: GrantId | null;
  /** Every worker that may use it. An ACTION capability has exactly one —
   *  its kind's owner; a supporting read lists each worker that reads. */
  workers: readonly StrategyWorker[];
  connector: ConnectorNeed;
};

/** The supported tools, by stable id. */
export const CAPABILITIES = {
  discover_opportunities: {
    version: 1,
    kind: "find",
    effect: "read",
    input: "AudienceSpec",
    output: "Opportunity[]",
    targets: ["audience"],
    grant: null,
    workers: ["scout"],
    connector: { needs: "kinds", kinds: ["discover"] },
  },
  // Triage runs inside the find, on the rows the find just wrote, through the
  // owner's own agent — it needs nothing from the connector.
  triage: {
    version: 1,
    kind: null,
    effect: "read",
    input: "Opportunity[]",
    output: "TriageVerdict[]",
    targets: ["post"],
    grant: null,
    workers: ["scout"],
    connector: { needs: "nothing" },
  },
  // The verify stage: the post with its thread, then its author.
  research: {
    version: 1,
    kind: "research",
    effect: "read",
    input: "PostRef",
    output: "ResearchSnapshot",
    targets: ["post"],
    grant: null,
    workers: ["scout"],
    connector: { needs: "kinds", kinds: ["thread_read", "profile_read"] },
  },
  // Find leads has capabilities of its own, so a Find posts switch or Deep
  // never moves it and its Research never runs Find posts' (`projectionOf`).
  find_leads: {
    version: 1,
    kind: "find",
    effect: "read",
    input: "AudienceSpec",
    output: "LeadSignal[]",
    targets: ["audience"],
    grant: null,
    workers: ["scout"],
    connector: { needs: "kinds", kinds: ["discover", "thread_read"] },
  },
  // The profile behind each person who passes the screen.
  research_lead: {
    version: 1,
    kind: "research",
    effect: "read",
    input: "PersonRef",
    output: "LeadProfile",
    targets: ["person"],
    grant: null,
    workers: ["scout"],
    connector: { needs: "kinds", kinds: ["profile_read"] },
  },
  // Deep's read of the company page behind each buyer Research read, from the
  // same profile reads: a company page read spends one.
  read_company: {
    version: 1,
    kind: "company_read",
    effect: "read",
    input: "CompanyRef",
    output: "CompanyPage",
    targets: ["person"],
    grant: null,
    workers: ["scout"],
    connector: { needs: "kinds", kinds: ["profile_read"] },
  },
  read_thread: {
    version: 1,
    kind: null,
    effect: "read",
    input: "SourceRef",
    output: "ThreadSnapshot",
    targets: ["post", "their_reply"],
    grant: null,
    workers: ["scout", "ambassador"],
    connector: { needs: "kinds", kinds: ["thread_read"] },
  },
  read_profile: {
    version: 1,
    kind: null,
    effect: "read",
    input: "PersonRef",
    output: "AuthorProfile",
    targets: ["person"],
    grant: null,
    workers: ["scout", "ambassador"],
    connector: { needs: "kinds", kinds: ["profile_read"] },
  },
  draft_comment: {
    version: 1,
    kind: null,
    effect: "draft",
    input: "ThreadContext + Voice + Facts",
    output: "Draft",
    targets: ["post", "their_reply", "room_comment"],
    grant: null,
    workers: ["ambassador"],
    connector: { needs: "nothing" },
  },
  publish_comment: {
    version: 1,
    kind: "comment",
    effect: "send",
    input: "ApprovedDraft + PostRef",
    output: "ActionReceipt",
    targets: ["post"],
    grant: "grant_publish_comment",
    workers: ["ambassador"],
    connector: { needs: "kinds", kinds: ["comment"] },
  },
  reply_public: {
    version: 1,
    kind: "reply",
    effect: "send",
    input: "ApprovedDraft + CommentRef",
    output: "ActionReceipt",
    targets: ["their_reply"],
    grant: "grant_public_reply",
    workers: ["ambassador"],
    connector: { needs: "kinds", kinds: ["reply"] },
  },
  reply_to_comment: {
    version: 1,
    kind: "room_reply",
    effect: "send",
    input: "ApprovedDraft + CommentRef",
    output: "ActionReceipt",
    targets: ["room_comment"],
    grant: "grant_room_reply",
    workers: ["ambassador"],
    connector: { needs: "kinds", kinds: ["room_reply"] },
  },
  // A post and a comment are separate connector kinds with separate
  // integrity, so one capability answers per campaign.
  like_target: {
    version: 1,
    kind: "react",
    effect: "send",
    input: "TargetRef",
    output: "ReactionReceipt",
    targets: ["post", "their_reply", "replied_comment"],
    grant: "grant_like",
    workers: ["ambassador"],
    connector: {
      needs: "per_target",
      byTarget: {
        post: ["like"],
        their_reply: ["like_comment"],
        replied_comment: ["like_comment"],
      },
    },
  },
  // The reads that admit it (their profile, and the received list) and the
  // write, on the account's own session.
  send_invitation: {
    version: 1,
    kind: "connect",
    effect: "send",
    input: "PersonRef + Note",
    output: "RelationshipReceipt",
    targets: ["person"],
    grant: "grant_invite",
    workers: ["ambassador"],
    connector: { needs: "kinds", kinds: ["relationship", "invitations_read", "invitations"] },
  },
  accept_invitation: {
    version: 1,
    kind: "accept_connection",
    effect: "send",
    input: "InvitationRef",
    output: "RelationshipReceipt",
    targets: ["invitation"],
    grant: "grant_accept",
    workers: ["ambassador"],
    // The list it is read from, and the write that accepts: neither alone.
    connector: { needs: "kinds", kinds: ["invitations_read", "invitations"] },
  },
  draft_dm: {
    version: 1,
    kind: null,
    effect: "draft",
    input: "ThreadContext + Voice + Facts",
    output: "Draft",
    targets: ["dm_thread"],
    grant: null,
    workers: ["ambassador"],
    connector: { needs: "nothing" },
  },
  // The conversation read that admits it and binds its thread, and the write;
  // a follow-up is a DM.
  send_dm: {
    version: 1,
    kind: "message",
    effect: "send",
    input: "ApprovedDraft + DMThreadRef",
    output: "MessageReceipt",
    targets: ["dm_thread"],
    grant: "grant_dm",
    workers: ["ambassador"],
    connector: { needs: "kinds", kinds: ["dm_read", "dm"] },
  },
  followup: {
    version: 1,
    kind: "follow_up",
    effect: "send",
    input: "ApprovedDraft + DMThreadRef",
    output: "MessageReceipt",
    targets: ["dm_thread"],
    grant: "grant_followup",
    workers: ["ambassador"],
    connector: { needs: "kinds", kinds: ["dm_read", "dm"] },
  },
  // The owner confirms an outcome; nothing reaches the network.
  record_outcome: {
    version: 1,
    kind: "record_outcome",
    effect: "none",
    input: "Evidence",
    output: "Outcome",
    targets: ["outcome"],
    grant: null,
    workers: ["ambassador"],
    connector: { needs: "nothing" },
  },
} as const satisfies Record<string, CapabilityEntry>;
export type CapabilityId = keyof typeof CAPABILITIES;
export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as [
  CapabilityId,
  ...CapabilityId[],
];

/**
 * Find posts' tools. The step is retired and no network row binds them, but a
 * strategy stored while it existed still names them, so the registry keeps
 * validating them (`redirect.ts` refuses the old switches that would seed them)
 * and the catalog stops advertising them.
 */
export const RETIRED_CAPABILITIES: readonly CapabilityId[] = ["discover_opportunities", "triage", "research"];

/** The context a step may read, by stable id. Bound by name, never attached
 *  wholesale: a step names what it reads. */
export const CONTEXT_TYPES = {
  audience_spec: {
    version: 1,
    description: "What the campaign hunts for: its discovery and relevance test.",
    workers: ["scout"],
  },
  campaign_brief: {
    version: 1,
    description: "The campaign's compiled focus brief.",
    workers: ["scout", "ambassador"],
  },
  research_snapshot: {
    version: 1,
    description: "A post read in full with its thread and its author.",
    workers: ["scout", "ambassador"],
  },
  verified_thread: {
    version: 1,
    description: "The exchange under one of our comments, read back.",
    workers: ["ambassador"],
  },
  room_thread: {
    version: 1,
    description: "Their comment in a room Research read, the post it is under, and the pain they voiced.",
    workers: ["ambassador"],
  },
  campaign_voice: {
    version: 1,
    description: "The voice this campaign writes in.",
    workers: ["ambassador"],
  },
  product_facts: {
    version: 1,
    description: "Verified facts about the products attached to the campaign.",
    workers: ["ambassador"],
  },
  relationship_state: {
    version: 1,
    description: "Where this person stands with the account, with provenance.",
    workers: ["ambassador"],
  },
  dm_thread: {
    version: 1,
    description: "The direct-message conversation with this person, as this account's reads recorded it.",
    workers: ["ambassador"],
  },
} as const satisfies Record<
  string,
  { version: number; description: string; workers: readonly StrategyWorker[] }
>;
export type ContextTypeId = keyof typeof CONTEXT_TYPES;
export const CONTEXT_TYPE_IDS = Object.keys(CONTEXT_TYPES) as [
  ContextTypeId,
  ...ContextTypeId[],
];

/**
 * The steps a worker can be given — what the Add step picker offers. A
 * strategy's step names the catalog step it is, which is what tells two
 * rows of one kind apart (Like post on Comment on posts, Like reply on Reply
 * when they answer). Each label is the step's one name on every surface,
 * read from here rather than from the copy a stored strategy keeps
 * (`stepName`).
 */
export const CATALOG_STEPS = {
  find_leads: { worker: "scout", label: "Find leads" },
  comment_on_posts: { worker: "ambassador", label: "Comment on posts" },
  meet_the_room: { worker: "ambassador", label: "Meet the room" },
  handle_reply: { worker: "ambassador", label: "Reply when they answer" },
  connect: { worker: "ambassador", label: "Invite to connect" },
  continue_in_dms: { worker: "ambassador", label: "Message after they accept" },
  check_outcome: { worker: "ambassador", label: "Check outcome" },
  write_post: { worker: "writer", label: "Write a post" },
} as const satisfies Record<string, { worker: StrategyWorker; label: string }>;
export type CatalogStepId = keyof typeof CATALOG_STEPS;
export const CATALOG_STEP_IDS = Object.keys(CATALOG_STEPS) as [
  CatalogStepId,
  ...CatalogStepId[],
];

/** A strategy step's name: its catalog step's label. A stored step keeps the
 *  label it was written with, which an earlier name of the step may be. */
export function stepName(step: { catalog_step: CatalogStepId }): string {
  return CATALOG_STEPS[step.catalog_step].label;
}

/** What a step needs before it can be switched on, where it needs anything:
 *  Meet the room answers people in the comments of the threads Scout read,
 *  which only a Deep search reads (`meetTheRoomRefusal`, addStep.ts). */
export const STEP_NEEDS: Partial<Record<CatalogStepId, string>> = {
  meet_the_room: "Search depth is Deep",
};

type EntryEvent = (typeof ENTRY_EVENTS)[number];

/**
 * The starts each catalog step can take: the event it is seeded on — the
 * thing it answers — first, then the campaign's own wake, on which any step
 * may also run. A step started on something else would wait for an event
 * that never reaches it (a reply step on a new invitation), so a CHANGE to a
 * step's start is held to this list (`entryChangeIssues`); a start stored
 * before the list stays as it is until the owner picks another.
 */
export const STEP_ENTRIES: Record<CatalogStepId, readonly EntryEvent[]> = {
  find_leads: ["campaign_wake"],
  comment_on_posts: ["lead_served", "candidate_matched", "campaign_wake"],
  meet_the_room: ["lead_served", "room_member_spotted", "campaign_wake"],
  handle_reply: ["direct_reply", "campaign_wake"],
  connect: ["invitation_status", "lead_served", "campaign_wake"],
  continue_in_dms: ["inbound_dm", "campaign_wake"],
  check_outcome: ["outcome_evidence", "campaign_wake"],
  write_post: ["campaign_wake"],
};

/**
 * Layer 2: one row per `(network, kind, step)`.
 *
 * `capability` is what a binding's `capability_ref` names; `uses` is every
 * capability the action spends. `modes` null is an action that takes no mode
 * at all (Record outcome: the owner confirms). Every mode lives on its step's
 * binding; `stored` names the key a send is granted and capped under, or
 * `step_switch` for a read, which no key covers.
 */
export type NetworkAction = {
  kind: ActionKind;
  step: CatalogStepId;
  label: string;
  rules: readonly string[];
  capability: CapabilityId;
  uses: readonly CapabilityId[];
  effect: readonly EffectClass[];
  modes: readonly BindingMode[] | null;
  stored: ModeKey | "step_switch" | null;
  targets: readonly TargetType[];
  defaultTarget: TargetType;
};

export type NetworkCatalog = {
  network: string;
  actions: readonly NetworkAction[];
};

export const LINKEDIN_ACTIONS = [
  {
    kind: "find",
    step: "find_leads",
    label: "Find leads",
    rules: [
      "Reads only: searches and the comments under them. Peers and competitors are read, never contacted.",
    ],
    capability: "find_leads",
    uses: ["find_leads", "read_thread"],
    effect: ["read"],
    modes: READ_MODES,
    stored: "step_switch",
    targets: ["audience"],
    defaultTarget: "audience",
  },
  {
    kind: "research",
    step: "find_leads",
    label: "Research",
    rules: [
      "Reads the profile of each person who passes the screen, from the account's daily profile reads.",
    ],
    capability: "research_lead",
    uses: ["research_lead", "read_profile"],
    effect: ["read"],
    modes: READ_MODES,
    stored: "step_switch",
    targets: ["person"],
    defaultTarget: "person",
  },
  {
    kind: "company_read",
    step: "find_leads",
    label: "Company page",
    rules: ["Reads the company page of each person Scout researches. Spends one profile read."],
    capability: "read_company",
    uses: ["read_company"],
    effect: ["read"],
    modes: READ_MODES,
    stored: "step_switch",
    targets: ["person"],
    defaultTarget: "person",
  },
  {
    kind: "comment",
    step: "comment_on_posts",
    label: "Comment",
    rules: ["Only on posts Scout matched."],
    capability: "publish_comment",
    uses: ["draft_comment", "publish_comment"],
    effect: ["draft", "send"],
    modes: ACTION_MODES,
    stored: "publish_comment",
    targets: ["post"],
    defaultTarget: "post",
  },
  {
    kind: "react",
    step: "comment_on_posts",
    label: "Like post",
    rules: ["The post it comments on."],
    capability: "like_target",
    uses: ["like_target"],
    effect: ["send"],
    modes: ACTION_MODES,
    stored: "like_target",
    targets: ["post"],
    defaultTarget: "post",
  },
  {
    kind: "reply",
    step: "handle_reply",
    label: "Reply",
    rules: ["A reply under one of our comments."],
    capability: "reply_public",
    uses: ["reply_public", "read_thread"],
    effect: ["draft", "send"],
    modes: ACTION_MODES,
    stored: "public_reply",
    targets: ["their_reply"],
    defaultTarget: "their_reply",
  },
  {
    kind: "react",
    step: "handle_reply",
    label: "Like reply",
    rules: [
      "Their reply, or the comment they replied to — never the original post.",
    ],
    capability: "like_target",
    uses: ["like_target"],
    effect: ["send"],
    modes: ACTION_MODES,
    stored: "like_target",
    targets: ["their_reply", "replied_comment"],
    defaultTarget: "their_reply",
  },
  {
    kind: "connect",
    step: "connect",
    label: "Invite",
    rules: [
      "With a note.",
      "Only people who engaged.",
      "Once per person, ever.",
    ],
    capability: "send_invitation",
    uses: ["send_invitation"],
    effect: ["draft", "send"],
    modes: ACTION_MODES,
    stored: "invite",
    targets: ["person"],
    defaultTarget: "person",
  },
  {
    kind: "room_reply",
    step: "meet_the_room",
    label: "Reply in the room",
    rules: [
      "A public reply under their own comment, on a post we did not write.",
      "Only people Research judged to fit, with an active pain.",
      "Never in a room where you already commented.",
    ],
    capability: "reply_to_comment",
    uses: ["draft_comment", "reply_to_comment"],
    effect: ["draft", "send"],
    modes: ACTION_MODES,
    stored: "room_reply",
    targets: ["room_comment"],
    defaultTarget: "room_comment",
  },
  {
    kind: "connect",
    step: "meet_the_room",
    label: "Invite from the room",
    rules: [
      "With a note from your exchange.",
      "Only after they answered you.",
      "Once per person, ever.",
    ],
    capability: "send_invitation",
    uses: ["send_invitation"],
    effect: ["draft", "send"],
    modes: ACTION_MODES,
    stored: "invite",
    targets: ["person"],
    defaultTarget: "person",
  },
  {
    kind: "accept_connection",
    step: "connect",
    label: "Accept invite",
    rules: ["Only verified-linked."],
    capability: "accept_invitation",
    uses: ["accept_invitation"],
    effect: ["send"],
    modes: ACTION_MODES,
    stored: "accept_invite",
    targets: ["invitation"],
    defaultTarget: "invitation",
  },
  {
    kind: "message",
    step: "continue_in_dms",
    label: "DM",
    rules: ["Only after expressed interest."],
    capability: "send_dm",
    uses: ["draft_dm", "send_dm"],
    effect: ["draft", "send"],
    modes: ACTION_MODES,
    stored: "dm",
    targets: ["dm_thread"],
    defaultTarget: "dm_thread",
  },
  {
    kind: "follow_up",
    step: "continue_in_dms",
    label: "Follow-up",
    rules: ["Requires DM."],
    capability: "followup",
    uses: ["followup"],
    effect: ["draft", "send"],
    modes: ACTION_MODES,
    stored: "followup",
    targets: ["dm_thread"],
    defaultTarget: "dm_thread",
  },
  {
    kind: "record_outcome",
    step: "check_outcome",
    label: "Record outcome",
    rules: ["The owner confirms."],
    capability: "record_outcome",
    uses: ["record_outcome"],
    effect: ["none"],
    modes: null,
    stored: null,
    targets: ["outcome"],
    defaultTarget: "outcome",
  },
] as const satisfies readonly NetworkAction[];

export const NETWORK_CATALOGS: Record<NetworkId, NetworkCatalog> = {
  linkedin: { network: "linkedin", actions: LINKEDIN_ACTIONS },
};

/** The catalog action a capability names on one step, or why there is none:
 *  no row for the kind on this network at all, or rows that live on other
 *  steps. */
export function networkActionFor(
  catalog: NetworkCatalog,
  capability: CapabilityId,
  step: CatalogStepId,
):
  | { ok: true; action: NetworkAction }
  | { ok: false; reason: "not_on_network" | "not_in_step" } {
  const kind = capabilityKind(capability);
  const rows = catalog.actions.filter((row) => row.kind === kind);
  if (kind === null || rows.length === 0)
    return { ok: false, reason: "not_on_network" };
  const action = rows.find(
    (row) => row.step === step && row.capability === capability,
  );
  return action ? { ok: true, action } : { ok: false, reason: "not_in_step" };
}

/** The kind a binding to this capability performs (layer 1, whatever the
 *  network), or null for a supporting tool. */
export function capabilityKind(capability: CapabilityId): ActionKind | null {
  return CAPABILITIES[capability].kind;
}

/**
 * The writes the owner presses that no step binds: never a catalog
 * capability, so no strategy can name one and nothing runs one on its own.
 * The owner's press is its yes, and its first confirmed send verifies it, as
 * a capability's does.
 */
export const OWNER_WRITES = ["withdraw_invitation"] as const;
export type OwnerWriteId = (typeof OWNER_WRITES)[number];

/** Each owner write's owner-facing name. */
export const OWNER_WRITE_LABELS: Readonly<Record<OwnerWriteId, string>> = {
  withdraw_invitation: "Withdraw invite",
};

/** What waits on a first confirmed send: a capability's write, or an owner
 *  write. */
export type LiveCheckedId = CapabilityId | OwnerWriteId | "room_reply";

/**
 * The writes whose Automatic waits on the account's first confirmed send of
 * them (INV-31: a surface is proven live before anything of it goes out
 * without a yes) — the SHIPPED default. Each names the date of a record made
 * for every install in its phase brief, or null until there is one. While it
 * is null the write resolves at most Ask me on an account, with
 * `first_send_pending`: the owner's yes on its first draft is the check, and
 * that send's confirmed receipt records it on the account (`live_checks`,
 * read into {@link LiveChecks}) — as does the owner's own optional live
 * check. Never a flag, an env var or a green suite.
 */
export const LIVE_READ_RECORDS: Partial<Record<LiveCheckedId, string | null>> = {
  room_reply: null,
  // docs/plan/phase-51-incoming-invitations.md § Live read record
  accept_invitation: null,
  // docs/plan/phase-50-invitation-with-note.md § Live proof record: the
  // relationship read, then one invitation sent through the sidecar.
  send_invitation: null,
  // docs/plan/phase-53-dm-send-and-followup.md § Live checks: the DM read
  // (phase 52's), then one DM sent through the sidecar. A follow-up is a DM
  // and is proven by DM's.
  send_dm: null,
  followup: null,
  // The relationship read showing our invitation pending, then one withdrawal
  // through the sidecar. Always the owner's press, so its record only says it
  // has gone out once.
  withdraw_invitation: null,
};

/** The capabilities verified on one account — by a first confirmed send or
 *  the owner's live check — beside the shipped table (`liveChecks/records.ts`
 *  reads them). */
export type LiveChecks = ReadonlySet<LiveCheckedId>;

/** Nothing verified on the account: the shipped table alone decides — what a
 *  caller that read none gets, so a forgotten read fails closed. */
export const NO_LIVE_CHECKS: LiveChecks = new Set();

/** The record that proves a capability's surface: its own, except
 *  Follow-up's, which is a DM, and the room capability, which keeps the
 *  owner-pressed room reply's existing record. */
export function liveCheckOf(capability: LiveCheckedId): LiveCheckedId {
  if (capability === "followup") return "send_dm";
  return capability === "reply_to_comment" ? "room_reply" : capability;
}

/** Who a verification a first confirmed send made is recorded by
 *  (`live_checks.recorded_by`); a check's is the owner who ran it. */
export const FIRST_SEND = "first_send";

/** Whether a capability still waits on its first confirmed send: the shipped
 *  table holds no record for it and none stands on the account. */
export function firstSendPending(
  capability: LiveCheckedId,
  recorded: LiveChecks = NO_LIVE_CHECKS,
): boolean {
  const check = liveCheckOf(capability);
  return LIVE_READ_RECORDS[check] === null && !recorded.has(check);
}

/**
 * Layer 3: whether the channel's connector can perform a capability now,
 * against one campaign. Derived from the declaration — never claimed here. A
 * first send still pending caps the mode (`strategy/resolve.ts`); it never
 * makes the capability unavailable.
 */
export function capabilityAvailable(
  capability: CapabilityId,
  connector: ConnectorDeclaration,
  target?: TargetType,
): boolean {
  const need: ConnectorNeed = CAPABILITIES[capability].connector;
  switch (need.needs) {
    case "nothing":
      return true;
    case "kinds":
      return need.kinds.every((kind) => isSupported(connector[kind]));
    case "per_target": {
      const kinds = target ? need.byTarget[target] : undefined;
      return (
        kinds !== undefined && kinds.every((kind) => isSupported(connector[kind]))
      );
    }
  }
}

/** Every capability's availability on one connector — what a surface shows
 *  beside an action it cannot run. Per campaign where the answer differs. */
export function catalogAvailability(
  connector: ConnectorDeclaration,
): Record<CapabilityId, Partial<Record<TargetType, boolean>>> {
  const out = {} as Record<CapabilityId, Partial<Record<TargetType, boolean>>>;
  for (const id of CAPABILITY_IDS) {
    out[id] = Object.fromEntries(
      CAPABILITIES[id].targets.map((target) => [
        target,
        capabilityAvailable(id, connector, target),
      ]),
    );
  }
  return out;
}
