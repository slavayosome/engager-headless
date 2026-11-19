/**
 * What a connector can actually do, said once, per kind.
 *
 * The capability question used to be asked four incompatible ways — a flag
 * struct on the driver, thirteen optional-method-presence checks, `driver.name
 * ===` branches, and null checks on the driver itself. This module is the one
 * vocabulary all four migrate onto: a caller names a KIND, and the declaration
 * for the bound connector answers, before anything opens a browser or a socket.
 *
 * A read kind and a write kind are held honest by DIFFERENT rules, because
 * their members differ in kind. `capabilities.test.ts` enforces both against
 * the driver classes themselves:
 *
 * - a READ kind is all-or-nothing on member presence. Every member that
 *   performs it is a distinct call the caller may make, so it may not be
 *   claimed while one is missing, and may not be denied while all are present
 *   unless the class actually refuses — which the test proves by calling it.
 * - a WRITE kind is checked on INTEGRITY, because its surface carries OPTIONAL
 *   hooks and presence proves nothing. The failure that matters here is the
 *   UNDERSTATED one — a class that reconciles while declaring less than
 *   `exactly_once` licenses the send path to skip reconciliation and post twice
 *   under the owner's name.
 * - an OBSERVATION kind (`OBSERVATION_KINDS`) is a read whose members each
 *   observe a different source, so it is claimed exactly when ANY member is
 *   there, and its caller asks the grant which ones are.
 *
 * The rules exist because this codebase already ran the experiment. The
 * retired `geo` flag declared `true` on a connector while every discovered post
 * carried `authorGeo: undefined`, because nothing ever compared the claim to
 * the code.
 */

import type { WorkerType } from "@engager/database/schema";
import type { LinkedInDriver, PostInput } from "../linkedin/driver";
export type { LinkedInDriver } from "../linkedin/driver";

/** The members of `LinkedInDriver` that are callable — the ones a capability
 *  can be performed BY. `name` and `capabilities` are data, not work. */
type DriverMethod = {
  [K in keyof LinkedInDriver]-?: NonNullable<LinkedInDriver[K]> extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[keyof LinkedInDriver];

/**
 * How hard a write tries not to happen twice.
 *
 * `exactly_once` means the connector can answer "did I already post this?" —
 * `postExactlyOnce()` reconciles first and adopts the existing urn, so a job
 * retry cannot double-post under the owner's name. `at_least_once` means it
 * cannot, and a retry after an uncertain result may post again.
 */
export type WriteIntegrity = "exactly_once" | "at_least_once";

/** A write kind: unsupported, or supported at a stated integrity. One flag
 *  cannot say this, which is why integrity is declared PER KIND — the local
 *  browser writes comments and replies exactly once and likes at least once. */
export type WriteDeclaration = false | { integrity: WriteIntegrity };

/**
 * Discovery declares what its results CARRY, not just that it runs. A campaign
 * can target a language, but `runFilter` gates on it only when the post
 * carries one — so a connector that emits none turns it into no filter at all
 * rather than a loose one. `inertTargetingFacets()` in `ai/filter.ts` is what
 * says so where the targeting is configured. No campaign gates on a post's
 * author geography: countries are read off profiles (`ProfileReadDeclaration`).
 */
export type DiscoverDeclaration = {
  supported: boolean;
  emitsAuthorGeo: boolean;
  emitsLanguage: boolean;
};

/**
 * The profile read declares what it CARRIES the way discovery does. An
 * Audience's countries bind only where it carries the country the profile's
 * location names — never its locale, which is the language it is written in.
 */
export type ProfileReadDeclaration = {
  supported: boolean;
  emitsAuthorGeo: boolean;
};

export type ConnectorDeclaration = {
  session: boolean;
  discover: DiscoverDeclaration;
  comment: WriteDeclaration;
  reply: WriteDeclaration;
  room_reply: WriteDeclaration;
  like: WriteDeclaration;
  like_comment: WriteDeclaration;
  /** Comments addressed to the account are observed — through the own-post
   *  sweep, the replies under comments it posted, or both. */
  incoming: boolean;
  own_content: boolean;
  comment_activity: boolean;
  profile: boolean;
  /** The verify reads: a post in full with its thread, and a person's
   *  profile — the author's, and a fitting Ambassador's country. */
  thread_read: boolean;
  profile_read: ProfileReadDeclaration;
  /** Where the account stands with one member, read off their profile in the
   *  account's own session: degree, a pending invitation, the note on offer. */
  relationship: boolean;
  /** The invitations people sent the account, read off its own invitations
   *  page. */
  invitations_read: boolean;
  /** Invitations written on the account: accepting one, sending one — one
   *  member, one note, under one operation id — and withdrawing one of ours. */
  invitations: WriteDeclaration;
  /** The account's message inbox and one conversation in it, read in the
   *  account's own session — who is in it, its messages, and whether the
   *  composer holds a draft. Reading only: sending one is `dm`. */
  dm_read: boolean;
  /** A direct message written on the account: one message into one
   *  conversation the product has bound, under one operation id. */
  dm: WriteDeclaration;
  /** A page handed over as words and anchors for the agent reader — the
   *  post our comment is on, the inbox, one conversation — when the
   *  structured reads above find nothing or do not recognise the page. A
   *  read: what a model makes of it is verified against the page itself. */
  agent_read: boolean;
};

export type CapabilityKind = keyof ConnectorDeclaration;

/** The kinds that WRITE to the account — the ones that carry integrity, and the
 *  only ones the channel spends budget on. */
export type WriteKind = {
  [K in CapabilityKind]: ConnectorDeclaration[K] extends WriteDeclaration
    ? K
    : never;
}[CapabilityKind];

export const WRITE_KINDS = [
  "comment",
  "reply",
  "room_reply",
  "like",
  "like_comment",
  "invitations",
  "dm",
] as const satisfies readonly WriteKind[];

/** The write kinds `reconcilePosted` can answer for — `PostInput`'s two shapes,
 *  pinned against the driver's own union so the two lists cannot drift. A class
 *  that implements it therefore writes both of these exactly once, unless it
 *  refuses the kind outright in code. */
export const RECONCILABLE_KINDS = [
  "comment",
  "reply",
  "room_reply",
] as const satisfies readonly (WriteKind & PostInput["kind"])[];

/**
 * The read kinds observed through ANY of their members, each of which reads
 * a different source. `incoming` is the comments addressed to the account:
 * a sweep of the owner's own posts, a read of the thread under each comment
 * it posted, and a connector claims the kind with either. The caller asks the
 * grant which members it holds — a sweep it does not hold is a provider call
 * it never meters.
 */
export const OBSERVATION_KINDS = ["incoming"] as const satisfies readonly Exclude<
  CapabilityKind,
  WriteKind
>[];

/** The members that perform each kind. A grant for a kind hands the caller
 *  exactly these, which is what makes "no code holds a driver" a type-level
 *  fact rather than a convention. */
export const CAPABILITY_METHODS = {
  session: ["ensureSession"],
  discover: ["discoverPosts"],
  // The exactly-once machinery rides with the write it protects: reconcile
  // before the write, the receipt hook to perform it, and the human
  // `confirmed_not_posted` half to re-arm the marker afterwards. A grant that
  // handed over the first two and withheld the third would leave the recovery
  // path unreachable through any capability.
  comment: [
    "ensureSession",
    "postComment",
    "postWithReceipt",
    "reconcilePosted",
    "resolveUncertainWriteOutcome",
  ],
  reply: [
    "ensureSession",
    "postReply",
    "postWithReceipt",
    "reconcilePosted",
    "resolveUncertainWriteOutcome",
  ],
  room_reply: ["ensureSession", "postWithReceipt", "reconcilePosted", "resolveUncertainWriteOutcome"],
  // A like travels with the read of what an uncertain one did.
  like: ["ensureSession", "likePost", "readLikeState"],
  like_comment: ["ensureSession", "likeComment", "readLikeState"],
  incoming: ["fetchIncomingComments", "readCommentReplies", "readNotifications"],
  own_content: ["fetchOwnPosts", "fetchOwnComments", "fetchOwnProfile"],
  comment_activity: ["fetchCommentActivity", "fetchOwnCommentCounters"],
  profile: ["fetchProfile"],
  thread_read: ["readPostThread"],
  // A company page is read from the same profile reads, so it travels with
  // the profile read.
  profile_read: ["readAuthorProfile", "readCompanyPage"],
  relationship: ["readRelationship"],
  invitations_read: ["readIncomingInvitations"],
  // A send travels with the read of what an uncertain one did: a grant that
  // handed over the first alone would leave an attempt nobody can settle. So
  // do an acceptance and a withdrawal, and the owner's word on one: the journal
  // entry of an attempt nobody saw land is closed with `settleMemberWrite`.
  invitations: [
    "ensureSession",
    "acceptInvitation",
    "resolveAcceptance",
    "sendInvitation",
    "resolveInvitation",
    "withdrawInvitation",
    "resolveWithdrawal",
    "settleMemberWrite",
  ],
  dm_read: ["readInbox", "readDmThread", "readConversationMessages"],
  // As with an invitation: the send travels with the read of what an
  // uncertain one did.
  dm: ["ensureSession", "sendDm", "resolveDm", "openDm", "resolveOpenDm", "settleMemberWrite"],
  agent_read: ["readPageForAgent"],
} as const satisfies Record<CapabilityKind, readonly DriverMethod[]>;

export const CAPABILITY_KINDS = Object.keys(
  CAPABILITY_METHODS,
) as readonly CapabilityKind[];

/**
 * What each worker TYPE needs the connector to be able to do.
 *
 * The pairing above makes "a capability and the members that perform it" a
 * type-level fact; this makes the same true one layer up, of "a worker and the
 * capability its work IS". A scout's whole job is the find, so a channel whose
 * connector cannot discover has nowhere to put one; an Ambassador's terminal step
 * is a comment on the account, so the same is true of `comment`. Drafting needs
 * no connector at all — it is the owner's own agent — which is why an Ambassador
 * requires exactly the one kind its PUBLISH step spends and not one per step.
 *
 * Both shipping connectors declare both kinds today, so nothing refuses yet.
 * That is the point of landing it now rather than with the type that first
 * fails it: a writer type arrives against kinds some connector cannot perform,
 * and a check written then would be a check written to explain a bug report.
 */
export const WORKER_TYPE_CAPABILITIES = {
  scout: ["discover"],
  ambassador: ["comment"],
} as const satisfies Record<WorkerType, readonly CapabilityKind[]>;

/**
 * The kinds this worker's type needs that its channel's connector will not do.
 *
 * Empty is the answer for every worker on every connector shipping today, so
 * callers get a list rather than a boolean: the surfaces that render it name
 * the kind, and a future type needing two would otherwise report the first and
 * hide the second.
 *
 * Pure, and takes the DECLARATION rather than a channel row, for the reason
 * `inertTargetingFacets` does: this module sits below the resolver and must not
 * learn to read the database to answer a question about a constant.
 */
export function unsupportedWorkerCapabilities(
  type: WorkerType,
  declaration: ConnectorDeclaration,
): CapabilityKind[] {
  return WORKER_TYPE_CAPABILITIES[type].filter(
    (kind) => !isSupported(declaration[kind]),
  );
}

/** Whether a kind is available at all, whatever shape its declaration takes. */
export function isSupported(
  declaration: ConnectorDeclaration[CapabilityKind],
): boolean {
  if (typeof declaration === "boolean") return declaration;
  return "integrity" in declaration ? true : declaration.supported;
}

/**
 * Whether this write can be made to happen at most once — the fact
 * `postExactlyOnce()` reconciles on.
 *
 * An unsupported write reads as false and takes the same plain arm, which is
 * the safe direction — and the load-bearing half of that is the MEMBER: a
 * connector that cannot perform the write refuses it there (the local
 * browser's marker-less `postReply` returns UNSUPPORTED_WRITE).
 * `resolveChannelConnector` also refuses an unsupported kind before a send
 * site is reached, but it is not the only issuer of a grant: the worker's
 * injected seam answers from the driver in hand, by member presence, and so
 * can hand over a kind this declaration denies. The costly error is the other one — treating a connector that CAN
 * answer "did I already post this?" as one that cannot licenses a retry to post
 * twice under the owner's name (INV-10).
 */
export function isExactlyOnce(declaration: WriteDeclaration): boolean {
  return declaration !== false && declaration.integrity === "exactly_once";
}

/**
 * A connector: how the account is physically reached. `local_browser` is the
 * `channels.connector` binding value; `mock` is the test fixture, which is not
 * a binding and never stamps the row.
 */
export type ConnectorId = "local_browser" | "mock";

/** Which declaration a driver class answers to. Selection is still env-driven
 *  (`ENGAGER_DRIVER`); T-5.3b moves the question to the channel row and this
 *  map narrows to the one place that translates a legacy name. */
export const CONNECTOR_BY_DRIVER_NAME: ReadonlyMap<string, ConnectorId> =
  new Map([
    ["browser-use", "local_browser"],
    ["mock", "mock"],
  ]);

export const CONNECTOR_DECLARATIONS: Record<ConnectorId, ConnectorDeclaration> = {
  /**
   * The local browser sidecar. A comment and a reply both go through its crash
   * journal: `postWithReceipt` binds the operation id before the click, and
   * `reconcilePosted` re-reads the thread for the receipt — a reply's directly
   * under the comment it sits under, by this account, with the typed words.
   */
  local_browser: {
    session: true,
    // The sidecar emits `detectedLanguage: null` and `authorGeo: null` on every
    // discovered post (python/engager_browser_use/backend.py).
    discover: { supported: true, emitsAuthorGeo: false, emitsLanguage: false },
    comment: { integrity: "exactly_once" },
    reply: { integrity: "exactly_once" },
    room_reply: { integrity: "exactly_once" },
    // Likes are journal-free on purpose: the sidecar refuses unless the post's
    // data and the control both read unpressed, so a repeat cannot toggle one
    // back off — but with no journal to bind an attempt, this is at-least-once.
    like: { integrity: "at_least_once" },
    like_comment: { integrity: "at_least_once" },
    // Its incoming is the replies under comments it posted, seen in the
    // account's notification cards (`readNotifications`) and read from each
    // thread by `readCommentReplies`; it has no own-post sweep.
    incoming: true,
    own_content: true,
    comment_activity: false,
    profile: false,
    thread_read: true,
    // The member's location code and geo, off the profile's own data
    // (`parse_author_profile`); a profile that names no location reads none.
    profile_read: { supported: true, emitsAuthorGeo: true },
    relationship: true,
    // Its received-invitations page, read from the data it is served with;
    // and an acceptance on the comment's journal — one press per operation
    // id, the attempt CLICKING before Accept is pressed, and
    // `resolveAcceptance` re-reads the sender's profile and the page's data
    // for an attempt nobody saw land. A sent invitation goes through the same
    // journal: the attempt is CLICKING before Send is pressed, and
    // `resolveInvitation` re-reads the member's profile for one nobody saw
    // land.
    invitations_read: true,
    invitations: { integrity: "exactly_once" },
    // The inbox and one conversation, read from their markup
    // (`python/engager_browser_use/messaging.py`).
    dm_read: true,
    // A DM on the same journal: the attempt is CLICKING before Send is
    // pressed, the conversation loaded afresh is the receipt, and `resolveDm`
    // reads it again for an attempt nobody saw land.
    dm: { integrity: "exactly_once" },
    // The post, the inbox or a conversation as words and anchors
    // (`python/engager_browser_use/agent_page.py`), for when the markup reads
    // above find nothing or drift.
    agent_read: true,
  },

  /**
   * The in-memory fixture. It reports geo and language because its canned posts
   * carry them, which is what lets a test exercise the targeting gates the real
   * connectors never feed. `own_content` stays false — a mock is "no real
   * account", so voice import is a no-op unless a test opts in — and it omits
   * `fetchOwnProfile` accordingly. `agent_read` stays false for the same
   * reason: the fixture has no page until a test serves one
   * (`MockDriver.serveAgentPages`).
   */
  mock: {
    session: true,
    discover: { supported: true, emitsAuthorGeo: true, emitsLanguage: true },
    comment: { integrity: "exactly_once" },
    reply: { integrity: "exactly_once" },
    room_reply: { integrity: "exactly_once" },
    like: { integrity: "at_least_once" },
    like_comment: { integrity: "at_least_once" },
    incoming: true,
    own_content: false,
    comment_activity: true,
    profile: true,
    thread_read: true,
    profile_read: { supported: true, emitsAuthorGeo: true },
    relationship: true,
    invitations_read: true,
    invitations: { integrity: "exactly_once" },
    dm_read: true,
    dm: { integrity: "exactly_once" },
    agent_read: false,
  },
};

/**
 * The declaration a driver name answers to, or null for a name no connector
 * claims.
 *
 * TOTAL on purpose, and over a Map rather than an object literal so that it is
 * total for every string and not merely for plausible ones. `config.driver` is
 * an unvalidated environment string cast to a union, so a typo — or
 * `ENGAGER_DRIVER=local_browser`, a spelling this file's own vocabulary invites
 * — arrives here as a name nothing maps. A surface that advises has to go quiet
 * on one, never throw: an advisory that takes its page down is the inverse of
 * advising with the real fact (INV-6).
 */
export function declarationForDriverName(
  name: string,
): ConnectorDeclaration | null {
  const connector = CONNECTOR_BY_DRIVER_NAME.get(name);
  return connector ? CONNECTOR_DECLARATIONS[connector] : null;
}
