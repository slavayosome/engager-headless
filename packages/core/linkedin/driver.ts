/**
 * The pluggable LinkedIn integration boundary. The local BrowserUseDriver and
 * the MockDriver implement it, so the scheduler/worker code never changes.
 */

import { createHash } from "node:crypto";
import type {
  AuthorProfileReadJson,
  CompanyPageReadJson,
  DmParticipantJson,
  PostThreadJson,
  RelationshipReadJson,
} from "@engager/database/schema";
import type { MentionTarget } from "./mention";

export type SessionStatus = {
  ok: boolean;
  reason?: string;
  /** The connector's own name for why a probe could not answer at all (the
   *  sidecar's `BROWSER_UNAVAILABLE`), where the failure carried one. `reason`
   *  is then the failure's message, which is for a log and can name a path;
   *  this is the half a screen may act on. */
  code?: string;
  /** The connector SAW LinkedIn's own sign-in page. `reason` cannot say so by
   *  itself: a page the connector could not place on LinkedIn at all — a
   *  network that is down — reads `login_required` too. */
  signInPage?: true;
  /** WHICH account the live session belongs to, when the driver can tell.
   *  Optional by contract: the first probe after a fresh sign-in may not know
   *  it yet, and a driver that never learns it is still valid. Surfaces render
   *  "Connected as <displayName>" when present and stay generic when not —
   *  they must never wait on it to call a session live.
   *
   *  `externalAccountId` is the DURABLE half: a display name is not an
   *  identity, because a rename on the network silently rewrites who the
   *  account is. Both stay optional under the same contract.
   *
   *  `headline` is what the same profile says under the name. It exists so the
   *  sign-in step can ask "is this you?" with more than a name, and it is never
   *  stored: no row, no log and no event keeps it. */
  account?: { displayName?: string; externalAccountId?: string; headline?: string };
};

/** An area of the screen, in screen points: where a window is put beside
 *  whatever else the owner is using. */
export type WindowPlace = { left: number; top: number; width: number; height: number };

/** How a probe reaches the owner's window (`ensureSession`). */
export type EnsureSessionOptions = {
  /** The owner is at the window (Test connection, the sign-in step): a driver
   *  holding a hidden headed browser surfaces it, and reads again who is
   *  signed in rather than answering from what it learned earlier. */
  interactive?: boolean;
  /** `false` on an interactive probe: only WATCH. The window stays where the
   *  owner put it, and one they closed stays closed (`browser_closed`). */
  surface?: boolean;
  /** Go to LinkedIn's own sign-in page first (Open LinkedIn again). */
  signIn?: boolean;
  /** Where to put the window when it is surfaced, in screen points. */
  place?: WindowPlace;
};

export type DriverPost = {
  postUrn: string;
  authorProfileId?: string;
  authorName?: string;
  authorHeadline?: string;
  /** True when the author is a LinkedIn company/organization page, not a person
   *  (provider `author.is_company`). Discovery engages people only by default. */
  authorIsCompany?: boolean;
  url?: string;
  contentText: string;
  postedAt?: number; // unix ms
  detectedLanguage?: string; // ISO code if the source provides it
  authorGeo?: string; // ISO country code if the source provides it
  media?: unknown;
  metrics?: unknown;
};

export type DriverIncomingComment = {
  commentUrn: string;
  ownPostUrn: string;
  authorProfileId?: string;
  authorName?: string;
  text: string;
  receivedAt?: number;
  /** The own post's text (the walk already has it in hand) — persisted so
   *  reply drafting sees what the post said. */
  ownPostText?: string;
};

/** A reply someone left under OUR comment (engagement monitor drill-in). */
export type DriverCommentReply = {
  replyUrn: string;
  postUrn: string;
  authorProfileId?: string;
  authorName?: string;
  text: string;
  ts?: number;
};

export type DriverCommentReaction = {
  /** LIKE | PRAISE | APPRECIATION | EMPATHY | INTEREST | ENTERTAINMENT */
  value: string;
  actorProfileId?: string;
  actorName?: string;
};

/** Everything one engagement check on one of OUR comments returns. */
export type CommentActivity = {
  replies: DriverCommentReply[];
  /** null = the reactions endpoint is unavailable for this driver/account —
   *  callers fall back to counter-diff events with no actor identity. */
  reactions: DriverCommentReaction[] | null;
  replyCount: number;
  reactionCount: number;
};

/** One row of the authored-comments counter sweep (cheap change detection). */
export type OwnCommentCounters = {
  commentUrn: string;
  postUrn: string;
  replyCount: number;
  reactionCount: number;
};

export type PostResult = {
  ok: boolean;
  externalUrn?: string;
  /** The connector adopted an existing receipt without another press. */
  reconciled?: boolean;
  error?: string;
  /** The connector's own code for why a write failed, where it has one (the
   *  browser sidecar's `DOM_CHANGED`): what a failed send stores as
   *  `messages.error_code`, the cause the owner is told. */
  code?: string;
  /** transient failure — safe to retry (network, 5xx) */
  retryable?: boolean;
  /** 429 / checkpoint — trip backoff + anomaly auto-pause, do NOT hammer */
  rateLimited?: boolean;
  /** The connector stopped before any provider write — a browser or page that
   *  was not ready. Nothing can have landed: with `retryable` the draft goes
   *  back to its slot and is tried again, never through "may have landed"
   *  recovery. */
  notAttempted?: boolean;
  /** A like's answer, where the connector can tell: `liked` — this call
   *  pressed it and the control read pressed afterwards; `already_liked` — it
   *  read pressed before the call, which then clicked nothing. Absent where
   *  the connector cannot say. */
  reaction?: "liked" | "already_liked";
};

/**
 * A single-term, cursor-paginated discovery request. The intelligent sweep calls
 * this once per source per page: `term` is one keyword, `#hashtag`, boolean/URL
 * query, or — when `kind:"author"` — an action target author URN/identifier whose own posts
 * to fetch; `cursor` is the next-page token from the previous page (null = page 1).
 */
export type DiscoverParams = {
  term: string;
  cursor?: string | null;
  limit?: number;
  /** "search" (default) runs a keyword/query search; "author" fetches the posts of
   *  the author identified by `term` (target_author_urns discovery). */
  kind?: "search" | "author";
  /** Server-side recency window for the keyword search (provider `date_posted`; docs:
   *  past_day / past_week / past_month). Coarse — the caller still applies the exact
   *  `maxPostAgeDays` age gate. */
  datePosted?: "past_day" | "past_week" | "past_month";
  /** The keyword search's order: `relevance` is LinkedIn's Top match, `latest`
   *  newest first. Absent reads as each connector's own default. A cursor is a
   *  place in one ordered list, so a new sort starts from page 1. */
  sort?: "relevance" | "latest";
};

/**
 * Result of one discovery page. `nextCursor` is null when the source is exhausted;
 * `cursorState:'expired'` tells the orchestrator the stored cursor was rejected, so
 * reset it and retry page 1 later — distinct from a genuinely dry source.
 */
export type DiscoverResult = {
  posts: DriverPost[];
  nextCursor: string | null;
  cursorState: "active" | "expired";
};

/** A reply targets a specific comment on a specific post (LinkedIn needs both).
 *  `replyToUrn` is the comment or reply it answers, when that is not
 *  `commentId` itself. `mention` @-tags the person being answered (best-effort
 *  — absent metadata posts plain text). */
export type ReplyTarget = {
  postUrn: string;
  commentId: string;
  replyToUrn?: string;
  mention?: MentionTarget;
};

/** Everything an exactly-once post/reply needs, incl. the reconcile marker. */
/** Isolated transport target. Domain dispatch admits it only after the room
 * lifecycle is wired to its own capability, lease and durable message row. */
export type RoomReplyInput = {
      kind: "room_reply";
      organizationId: string;
      channelId: number;
      expectedAccountProfileId: string;
      postUrn: string;
      commentId: string;
      expectedAuthorMemberUrn: string;
      text: string;
      marker: string;
    };

export type PostInput =
  | RoomReplyInput
  | { kind: "comment"; postUrn: string; text: string; marker: string }
  | {
      kind: "reply";
      postUrn: string;
      /** The comment the reply is posted under — the thread's top-level
       *  comment, since LinkedIn threads are two levels deep. */
      commentId: string;
      /** The comment or reply being answered: `commentId` itself, or a reply
       *  directly under it, beside which the answer is posted. */
      replyToUrn: string;
      /** A confirmed room reply under a third-party root; rechecked on page. */
      rootIsRoomReply?: { replyUrn: string };
      text: string;
      marker: string;
      mention?: MentionTarget;
    };

export type WriteOutcomeResolutionResult =
  | {
      operationId: string;
      state: "resolved_not_posted";
      resolutionVersion: number;
    }
  | {
      operationId: string;
      state: "already_committed";
      resolutionVersion: number;
      externalUrn: string;
    };

/**
 * How much of the owner's own writing a voice or Brain read takes: the 25 posts
 * they AUTHORED (no reposts, no company page's) and the 50 comments they wrote.
 * One pair of numbers for every path that learns from the account, so they
 * cannot drift apart.
 */
export const OWN_POST_LIMIT = 25;
export const OWN_COMMENT_LIMIT = 50;

export interface LinkedInDriver {
  readonly name: string;
  /**
   * What this driver can actually do, so handlers short-circuit instead of
   * burning poll budget or job attempts on an operation that must throw:
   * `incoming` — incoming-comment polling; `ownContent` — the connected
   * account's OWN posts/comments for voice learning.
   *
   * These two are all that is left of the struct. The others had no reader to
   * lose: they described what DISCOVERY carries, which is now
   * `CONNECTOR_DECLARATIONS[connector].discover` in
   * `connector/capabilities.ts` — the vocabulary these two join when their
   * guards become grants.
   */
  readonly capabilities: {
    incoming: boolean;
    ownContent: boolean;
  };

  /**
   * `interactive` means the owner is watching (Test connection) and may be
   * about to sign in — a driver holding a hidden headed browser surfaces it.
   * Drivers with nothing to show ignore the flags.
   */
  ensureSession(opts?: EnsureSessionOptions): Promise<SessionStatus>;
  discoverPosts(params: DiscoverParams): Promise<DiscoverResult>;
  /**
   * The connected user's own recent posts — used to learn their writing voice.
   * Only posts they authored: never a repost or a company page's. `onIncomplete`
   * is called when the read stopped short of `limit` for want of pages, so the
   * list is not the whole of what the account wrote.
   */
  fetchOwnPosts(limit?: number, onIncomplete?: () => void): Promise<DriverPost[]>;
  /**
   * The connected account's OWN profile (authoritative "Connected as <name>"
   * source — never derived from feed items, which can be reposts carrying the
   * original author's name). OPTIONAL: drivers that can't source it omit it
   * and callers fall back to a majority vote over own-posts authors.
   */
  fetchOwnProfile?(): Promise<{ displayName?: string } | null>;
  /**
   * The user's OWN comments (their replies on their own posts) — the real
   * commenting-voice signal. OPTIONAL: drivers that can't source it omit it and
   * the comment voice falls back to posts + human-edited drafts.
   */
  fetchOwnComments?(
    limit?: number,
    onIncomplete?: () => void,
  ): Promise<{ text: string; postUrn: string }[]>;
  postComment(postUrn: string, text: string): Promise<PostResult>;
  /**
   * The marker-aware write: it durably binds the Engager operation id before
   * external I/O (the local browser connector's crash journal). Every comment
   * and reply write goes through it — `postExactlyOnce()` is the only canonical
   * caller and reconciles first.
   */
  postWithReceipt(input: PostInput): Promise<PostResult>;
  likePost(postUrn: string): Promise<PostResult>;
  /**
   * React to a COMMENT (acknowledge a conversation-closer instead of replying —
   * an endless mutual thread is a bot signature). Rooted at the parent post,
   * comment id as the action target. OPTIONAL: drivers without it degrade to
   * dismiss-without-like (same graceful contract as fetchCommentActivity).
   * Where the action target is a REPLY, `parentCommentUrn` is the comment it answers:
   * LinkedIn's data declares a reply's reaction only on the post opened at it.
   */
  likeComment?(postUrn: string, commentUrn: string, parentCommentUrn?: string): Promise<PostResult>;
  /**
   * The account's reaction to a post, or to a comment or reply under it, as
   * LinkedIn's own data for the post declares it — what an uncertain like is
   * settled by. A reply needs `parentCommentUrn`, the comment it answers, to be
   * read at all; without it a reply reads as a reaction the data cannot tell.
   * Read only. OPTIONAL: a connector without it leaves an uncertain like to
   * the owner.
   */
  readLikeState?(postUrn: string, commentUrn?: string, parentCommentUrn?: string): Promise<LikeStateRead>;
  /**
   * Comments on the owner's OWN posts since `sinceTs` — the own-post sweep, a
   * provider call the caller meters (`reservePollCall`). OPTIONAL: `incoming`
   * is observed through whichever of this and `readCommentReplies` a connector
   * has, and the local browser reads no own post's comments.
   */
  fetchIncomingComments?(sinceTs: number): Promise<DriverIncomingComment[]>;
  postReply(target: ReplyTarget, text: string): Promise<PostResult>;
  /**
   * Replies + reactions on ONE comment we posted (engagement monitor drill-in).
   * Rooted at the parent post — comment ids are only filters on LinkedIn.
   * OPTIONAL: drivers without comment-level access omit it and the monitor
   * no-ops (same graceful-degrade contract as fetchOwnComments).
   */
  fetchCommentActivity?(postUrn: string, commentUrn: string): Promise<CommentActivity>;
  /**
   * Counter sweep over comments WE authored (spike-confirmed
   * GET /users/{memberId}/comments): one call returns reply/reaction counters
   * for our recent comments, so the monitor drills in only where a counter
   * moved. OPTIONAL — the monitor falls back to per-watch checks.
   */
  fetchOwnCommentCounters?(limit?: number): Promise<OwnCommentCounters[]>;

  /**
   * Exactly-once support: return the external urn if WE already posted this
   * comment/reply, else null. Lets the worker recover from the
   * timeout-after-success race without double-posting. Drivers that cannot
   * support this omit it; the worker falls back to at-least-once.
   */
  reconcilePosted?(input: PostInput): Promise<string | null>;
  /**
   * Optional local acknowledgement required before a human
   * `confirmed_not_posted` decision re-arms the same durable marker. The caller
   * must settle `already_committed` as posted instead of retrying.
   */
  resolveUncertainWriteOutcome?(
    input: PostInput,
    resolutionVersion: number,
    postedUrn?: string,
  ): Promise<WriteOutcomeResolutionResult>;

  /**
   * The owner's word on an invitation, acceptance, withdrawal or DM nobody saw
   * land, recorded in the write journal's entry for that attempt. It reads and
   * presses nothing and waits on nothing; `contradicted` is an entry the
   * journal settled the other way, which is held for the owner. OPTIONAL: a
   * connector with no write journal has nothing to close.
   */
  settleMemberWrite?(
    operationId: string,
    outcome: "went_out" | "not_sent",
  ): Promise<{ state: "recorded" | "not_journaled" | "contradicted" }>;

  /**
   * One author's profile — geo/language plus IMPACT metrics (followers,
   * connections) for author-impact ranking. OPTIONAL and expensive
   * (rate-limited ~100/day on provider): only the enrich_authors job calls it,
   * under the `profile` ledger budget. Fields are best-effort — absent metrics
   * degrade ranking gracefully.
   */
  fetchProfile?(identifier: string): Promise<DriverProfile>;

  /**
   * Verify reads: one post in full with up to `maxComments` of its comments,
   * most relevant first, and one author's profile with up to five recent
   * posts. READ ONLY, and OPTIONAL with the same graceful-degrade contract as
   * `fetchCommentActivity`: a connector without them leaves a match
   * unverified. A caller spends the account's research-read budget first
   * (`reserveResearchRead`); a profile visit can show on that author's list of
   * who viewed their profile.
   */
  readPostThread?(
    postUrn: string,
    opts: { maxComments: number; order?: "relevance" | "recent"; start?: number },
  ): Promise<PostThread>;
  /** `role` also reads the member's current role off their experience page:
   *  one more page of theirs, for a read that goes on to their company's. */
  readAuthorProfile?(profileId: string, opts?: { role?: boolean }): Promise<AuthorProfileRead>;
  /**
   * One company's own page, by the public identifier a profile read linked it
   * by (`currentRole.companyRef`): its name, size band, industry, About and
   * followers, from the page's public data and nothing else. READ ONLY and
   * OPTIONAL, under the same contract as `readAuthorProfile`: a visit to the
   * page that spends one of the account's daily profile reads, reserved
   * before it loads (`reserveResearchRead`). Never follows, messages or
   * engages the page. A connector without it reads no company page.
   */
  readCompanyPage?(companyRef: string): Promise<CompanyPageRead>;
  /**
   * The replies directly under one comment WE posted. READ ONLY and
   * OPTIONAL: one way `incoming` is observed, one read the caller meters as a
   * `reply_check`. LinkedIn's own comment data for that comment's thread,
   * asked by `commentUrn` exactly as stored, answers first — whether or not
   * the post's page shows our comment; where it cannot, the post's page is
   * read, our comment resolved on it (either inner post spelling), its direct
   * replies only — a reply under a sibling comment is never attributed to
   * ours. `vouchedReplyUrns` are replies a notification about OUR comment
   * named ({@link readNotifications}): where the page lays replies out flat
   * and prints no count, only those are read as replies to it. `since` drops
   * replies dated earlier; `limit` keeps the newest. A page the connector
   * does not recognise throws a `drift` ConnectorError and answers nothing.
   */
  readCommentReplies?(
    postUrn: string,
    commentUrn: string,
    opts: { since?: number; limit: number; vouchedReplyUrns?: string[]; roomReplyUrn?: string },
  ): Promise<CommentRepliesRead>;
  /**
   * One page of the account's notification cards, read from LinkedIn's own
   * JSON: the cards about a comment — a reply to one of ours, a reaction to
   * one, a comment that mentions the account — with every card the page
   * listed accounted for in `listed`, `oldestPublishedAt` and `nextStart`.
   * READ ONLY and OPTIONAL, the other way `incoming` is observed: page 0 is
   * the response an ordinary page load already fetches, never the
   * notifications page, so nothing is marked seen; a later `start` is the
   * request that page makes as it scrolls. The caller meters each page as a
   * `reply_check`. A shape the connector does not recognise throws a `drift`
   * ConnectorError and answers nothing.
   */
  readNotifications?(opts: { start: number }): Promise<NotificationsRead>;
  /**
   * Where the connected account stands with one member right now, read off
   * their own profile page in this account's signed-in session — LinkedIn's
   * relationship data for them, fetched from it: the degree, an invitation
   * pending either way, and the profile the page verifiably is. READ ONLY
   * and OPTIONAL, a profile visit that spends a `profile_read`. A fact the
   * page does not show is `"unknown"` — never inferred, never "not
   * connected". A page the connector does not recognise throws a `drift`
   * ConnectorError and answers nothing.
   */
  readRelationship?(target: RelationshipTarget): Promise<RelationshipRead>;
  /**
   * The invitations people sent the connected account, read off its own
   * invitations page — newest first, those the page dates before `since` left
   * out, at most `limit`. READ ONLY and OPTIONAL: nobody sees the account read
   * its own list. The sender is the provider's id for them as the page links
   * them; their note is untrusted data. A list that offers more than it
   * rendered says `complete: false`, so an absence proves nothing. A page the
   * connector does not recognise throws a `drift` ConnectorError.
   */
  readIncomingInvitations?(opts: {
    since?: number;
    limit: number;
  }): Promise<IncomingInvitationsRead>;
  /**
   * Accept one invitation from one sender, once, under `operationId`, and
   * read back what it did. The connector re-reads the invitations page's data
   * before anything is pressed and refuses unless it lists the request — a
   * person's, Pending, from that sender — then presses the one Accept in the
   * row that data keys, and confirms only on the sender's own profile, read in
   * the same session, showing them connected. A press is never a receipt.
   * OPTIONAL: a connector without it has no acceptance.
   */
  acceptInvitation?(input: AcceptInvitationInput): Promise<AcceptInvitationResult>;
  /**
   * What became of an acceptance nobody saw land: a read of the sender's
   * profile and of the invitations page's data against the attempt's own
   * record. Never presses anything. `reserveRead` is asked for each page load
   * before it, and a refusal ends the reads there: an attempt that never
   * reached its press needs no page and asks for none. OPTIONAL, and present
   * exactly where `acceptInvitation` writes exactly once.
   */
  resolveAcceptance?(input: AcceptInvitationInput, reserveRead: ReserveRead): Promise<AcceptanceResolution>;
  /**
   * The account's message inbox, newest conversation first, as LinkedIn's own
   * conversation data lists it: who each conversation is with, its last
   * message — its id, words and author where the connector reads them — and
   * how many messages wait unread. READ ONLY and OPTIONAL — a page load that
   * spends a reply check; nothing in a conversation is opened, pressed or
   * marked. `since` drops conversations last active earlier; `limit` keeps
   * the newest. A person's profile is named only where LinkedIn links it: a
   * name alone is never an identity. Data the connector does not recognise
   * throws a `drift` ConnectorError and answers nothing.
   */
  readInbox?(opts: { since?: number; limit: number }): Promise<InboxRead>;
  /**
   * One conversation, read off its own page in this account's session: every
   * participant, the messages with their ids, and whether the composer holds
   * words nobody has sent — read from markup, never touched. OPTIONAL, a
   * page load the caller meters: a reply check where the inbox is observed,
   * a `thread_read` before a send. Opening it marks it seen; `restoreUnread`
   * — the inbox showed it unread — has the connector put its unread mark back
   * with the conversation's own Mark as unread, once, and say whether it took
   * (`unreadRestore`). `since` drops messages the page dates earlier. A page
   * the connector does not recognise throws a `drift` ConnectorError and
   * answers nothing.
   */
  readDmThread?(
    threadId: string,
    opts: { since?: number; restoreUnread?: boolean },
  ): Promise<DmThreadRead>;
  /**
   * One conversation's newest messages — at most `limit`, oldest first —
   * read from LinkedIn's own history for it WITHOUT opening it: nothing is
   * pressed, opened or marked, and LinkedIn sends no receipt for it. Who is
   * in it is the inbox list's word, and its composer is not read. READ ONLY
   * and OPTIONAL, a reply check. A conversation the connector cannot read
   * this way — a renamed query, an answer it does not know, one the list does
   * not name — throws, and the caller opens it with `readDmThread` instead.
   * LinkedIn's data names a member by member urn alone: `members` is whose
   * profile each urn is, as a page read of the conversation showed it, and
   * a member it does not name throws too — never a guess at who they are.
   */
  readConversationMessages?(
    threadId: string,
    opts: { limit: number; members?: readonly KnownMember[] },
  ): Promise<ConversationHistory>;
  /**
   * One page as the agent reader's text: the post our comment is on, the
   * inbox, or one conversation, loaded with the read-side expansions the
   * structured reads above already make and nothing more — then handed back
   * as words and anchors (`reader/representation.ts`), never as rows. A model
   * reads it and the server checks every identifier the model cites against
   * it (`reader/`). READ ONLY and OPTIONAL: a page load the caller meters as
   * the structured read it stands behind would be. Never evidence for a write.
   */
  readPageForAgent?(request: AgentPageRequest): Promise<AgentPage>;
  /**
   * Send one member an invitation carrying `note`, under `operationId`, and
   * say what it came to. The connector re-reads the member's profile before
   * anything is sent — LinkedIn's relationship data for the member it
   * verifies, not connected, nothing pending, as `expected` says — reads the
   * note limit LinkedIn's compose view states and refuses a longer note, then
   * sends it as LinkedIn's own client does, once, and confirms only on
   * LinkedIn's answer naming the invitation it created. OPTIONAL: a connector
   * without it has no invitation write.
   */
  sendInvitation?(input: SendInvitationInput): Promise<SendInvitationResult>;
  /**
   * What became of an attempt nobody saw land: a read of the member's profile
   * against the attempt's own record. Never presses anything. OPTIONAL, and
   * present exactly where `sendInvitation` writes exactly once.
   */
  resolveInvitation?(input: InvitationAttempt): Promise<InvitationResolution>;
  /**
   * Withdraw our pending invitation to one member, under `operationId`, and
   * read back what it did. The connector re-reads the member's profile before
   * anything is pressed and refuses unless it shows our invitation pending,
   * binding the top card's one Pending control; then, once its journal holds
   * the attempt, presses that control and the confirmation's own Withdraw,
   * once each, and confirms only on a re-read of the profile, in the same
   * session, showing Connect on offer and nothing pending. A press is never a
   * receipt. OPTIONAL: a connector without it has no withdrawal.
   */
  withdrawInvitation?(input: WithdrawalAttempt): Promise<WithdrawInvitationResult>;
  /**
   * What became of a withdrawal nobody saw land: a read of the member's
   * profile against the attempt's own record. Never presses anything.
   * OPTIONAL, and present exactly where `withdrawInvitation` writes exactly
   * once.
   */
  resolveWithdrawal?(input: WithdrawalAttempt): Promise<WithdrawalResolution>;
  /**
   * Send one message into one conversation, under `operationId`, and say what
   * it did. The connector reads the conversation afresh before anything is
   * sent and refuses unless it is the account and `recipientProfileId` alone
   * — by `expected.memberUrn` where one is given, else by profile id — its
   * newest message still `expected.lastMessageId`; then it sends the words
   * once, as LinkedIn's own messaging client does, and confirms only on
   * LinkedIn's answer naming the message it created there with exactly these
   * words, or on a read of the conversation showing it.
   * OPTIONAL: a connector without it has no DM write.
   */
  sendDm?(input: SendDmInput): Promise<SendDmResult>;
  /**
   * What became of a DM attempt nobody saw land: a read of the conversation
   * against the attempt's own record — from its history, without opening it,
   * where `members` lets the history say who is in it; else its page. Only
   * the history can show nothing of ours went; a page read that misses the
   * message stays uncertain. Never presses anything. OPTIONAL, and present
   * exactly where `sendDm` writes exactly once.
   */
  resolveDm?(input: DmResolveInput): Promise<DmResolution>;
  /**
   * The first message to a connection Engager knows no conversation with,
   * under `operationId`, and a read of what it did. The connector reads the
   * member's own profile in the same session and refuses unless its data
   * shows a connection with a Message trigger for exactly them, reads the
   * account's conversations and refuses any 1:1 with them already there,
   * opens the compose view that trigger leads to — never a button pressed —
   * and refuses unless its own load names exactly them as a connection
   * message's recipient; then sends the words once to them alone, and
   * confirms only on LinkedIn's answer naming the message it created and a 1:1
   * with them whose history shows these words, sent since the press — the
   * conversation the confirmation carries, for the caller to bind. OPTIONAL.
   */
  openDm?(input: OpenDmInput): Promise<OpenDmResult>;
  /**
   * What became of a first message nobody saw land: the account's
   * conversation list, read against the attempt's own record. Only a list
   * whole since the press can show no conversation with them began. Never
   * presses anything. Present exactly where `openDm` is.
   */
  resolveOpenDm?(input: OpenDmInput): Promise<OpenDmResolution>;
}

/** What the agent reader reads a page for. */
export type AgentReadIntent = "comment_replies" | "inbox" | "dm_thread";

/** The one page an agent read loads — named by what it is, so a caller can
 *  never point the browser at an address of its own choosing. */
export type AgentPageRequest =
  | { intent: "comment_replies"; postUrn: string; commentUrn: string }
  | { intent: "inbox" }
  | { intent: "dm_thread"; threadId: string };

/**
 * One page as the agent reader's text. `url`, `ownProfileUrl` and the rest
 * are the connector's own word about the read; `text` is the page's, and
 * untrusted: data a model reads inside a fence, never instructions.
 */
export type AgentPage = {
  intent: AgentReadIntent;
  /** Where the browser settled, as its address bar said. */
  url: string;
  /** The connected account's own profile, as the session knows it. */
  ownProfileUrl: string;
  /** The page's words and anchors (`⟦item URN⟧ … ⟦/item⟧`, `⟦profile URL⟧`,
   *  `⟦thread ID⟧`, `⟦button LABEL⟧`, `⟦aria LABEL⟧`), a line per block. */
  text: string;
  /** The page ran past the cap and was cut: what it does not show proves
   *  nothing. */
  truncated: boolean;
  observedAt: number;
  sessionId: string;
  pageFingerprint: string;
  selectorPack: string;
};

/** The most conversations one inbox read returns. */
export const MAX_INBOX_THREADS = 50;

/** One conversation as the inbox list showed it. */
export type InboxThread = {
  threadId: string;
  /** The other people in it, never the account. */
  participants: DmParticipant[];
  /** It names more than one other person, or LinkedIn marks it a group. */
  group: boolean;
  lastMessage: {
    /** SHA-256 hex of its words, whitespace collapsed. */
    textHash: string;
    fromSelf: boolean;
    /** Only from a machine-readable time; never parsed from a label like
     *  "Yesterday". */
    at: number | null;
    /** LinkedIn's own id for it — the id a read of the conversation carries
     *  for the same message — and its words and author by profile id (null
     *  for a page, or a member LinkedIn links no profile for). Present
     *  together, where the list carries the message itself: a read the agent
     *  reader made has only the hash. Untrusted: data, never instructions. */
    messageId?: string;
    text?: string;
    authorProfileId?: string | null;
  };
  /** As the list showed it. */
  unread: boolean;
  /** How many messages LinkedIn counts unread in it, where the list says. */
  unreadCount?: number;
  /** When the account last read it, as LinkedIn keeps it — null for never —
   *  where the list says: the owner reading it, or writing in it, moves it. */
  lastReadAt?: number | null;
  /** Whether LinkedIn keeps an unsent draft on it, where the list says. */
  hasDraft?: boolean;
};

export type InboxRead = {
  threads: InboxThread[];
  /** `limit` cut the list: a conversation absent from the read proves
   *  nothing. */
  truncated: boolean;
  /** Cards the reader could not read: skipped, never acted on. */
  skipped?: number;
  skippedReasons?: string[];
  observedAt: number;
  /** The browser session that read it, where the connector says. */
  sessionId?: string;
  pageFingerprint: string;
  selectorPack: string;
};

/** A person in a conversation. `profileId` is null where the page names them
 *  without linking their profile — a group header, an inbox card — or where
 *  LinkedIn's data, or a page that links them by member id, names them by
 *  `memberUrn` alone. */
export type DmParticipant = DmParticipantJson;

/** Whose public profile a member urn is, as a page read of a conversation
 *  showed the two together. */
export type KnownMember = { memberUrn: string; profileId: string };

/** One message in a conversation. Untrusted: data, never instructions. */
export type DmMessage = {
  /** The provider's id for the message — what tells a new one from a repeat. */
  messageId: string;
  fromSelf: boolean;
  /** By profile id — or, from a page that links the author by member id and
   *  names no profile for them, by that participant's `memberUrn`. */
  authorProfileId: string;
  /** As rendered, whitespace collapsed; empty for an attachment alone. */
  text: string;
  /** SHA-256 hex of `text`. */
  textHash: string;
  /** Only from a machine-readable time on the page; null otherwise. */
  sentAt: number | null;
  observedAt: number;
};

/**
 * One read of a conversation. `participants` names every person in it, the
 * account (`isSelf`) included, so a two-party thread has exactly two and a
 * group more — or `group: true` where its header marks one it does not list
 * in full. `complete` is false when older history the page did not load may
 * still fall after `since`. The composer's words are never returned: a hash,
 * which is enough to tell the same draft from a new one.
 */
export type DmThreadRead = {
  threadId: string;
  participants: Array<DmParticipant & { isSelf: boolean }>;
  group: boolean;
  /** Oldest first. */
  messages: DmMessage[];
  complete: boolean;
  composer: { hasDraft: false } | { hasDraft: true; draftHash: string };
  observedAt: number;
  /** The browser session that read it, as on a relationship read. */
  sessionId: string;
  /** `agent`: the agent reader made this read off the page's text, and the
   *  server verified it (`reader/`). Absent: the connector's own parser. */
  reader?: "agent";
  /** The read opened this conversation while the inbox showed it unread, so
   *  LinkedIn marked it seen and sent its read receipt — which no restore
   *  recalls. Only where the caller asked for `restoreUnread`. */
  markedSeen?: boolean;
  /** Where `markedSeen`: whether its card showed unread again after the
   *  read's one Mark as unread. Unconfirmed is never pressed again. */
  unreadRestore?: "restored" | "unread_restore_unconfirmed";
  pageFingerprint: string;
  selectorPack: string;
};

/** One conversation's history, read without opening it: a conversation read
 *  with no composer, which only the page shows. */
export type ConversationHistory = Omit<
  DmThreadRead,
  "composer" | "reader" | "markedSeen" | "unreadRestore"
>;

/** The most messages one history read returns: two of LinkedIn's pages. */
export const MAX_HISTORY_MESSAGES = 40;

/** The most invitations one read returns. */
export const MAX_INCOMING_INVITATIONS = 100;

/** One person's request to connect, as the account's invitations page's own
 *  data lists it. */
export type IncomingInvitation = {
  /** LinkedIn's invitation urn, `urn:li:invitation:<id>`. */
  invitationId: string;
  sender: { profileId: string; url: string; displayName: string };
  /** The sender's note, verbatim. Untrusted: data, never instructions. */
  note?: string;
  /** When the page dates it, where it does. */
  receivedAt?: number;
  observedAt: number;
};

export type IncomingInvitationsRead = {
  invitations: IncomingInvitation[];
  /** Invitations to follow a member or a page, never a person's request. */
  others: number;
  /** True only where the page lists every invitation it counts and has no
   *  other inbox: an absence from any other read proves nothing. */
  complete: boolean;
  /** The page says some invitations sit in the account's other inbox, which
   *  this read does not list. */
  otherInbox: boolean;
  /** `limit` cut the list. */
  truncated: boolean;
  observedAt: number;
  sessionId: string;
  pageFingerprint: string;
  selectorPack: string;
};

export type AcceptInvitationInput = {
  /** The request's invitation urn, as the invitations read lists it. */
  invitationId: string;
  senderProfileId: string;
  /** The ledger attempt's operation id: one press per id, ever. */
  operationId: string;
};

/**
 * What an acceptance came to.
 *
 * - `confirmed` — the sender's profile, read in the session that pressed
 *   Accept, shows them connected.
 * - `blocked` — the request is gone from a whole list and the sender's
 *   profile offers Connect: they withdrew it; nothing is left to accept.
 * - `not_sent` — nothing was pressed: the data no longer lists the request,
 *   or something before the press failed (a page that would not load, the
 *   account probe, a stale binding).
 * - `uncertain` — Accept may have been pressed and nothing proves either way.
 */
export type AcceptInvitationResult =
  | { status: "confirmed"; relationship: RelationshipRead }
  | { status: "blocked"; reason: string; detail?: string; relationship?: RelationshipRead }
  | { status: "not_sent"; reason: string }
  | { status: "uncertain"; reason: string; relationship?: RelationshipRead };

/** Asks the account's read budget for one page load, before it: false where
 *  the budget refuses it. */
export type ReserveRead = () => Promise<boolean>;

/** What a read says of an uncertain acceptance: `accepted` — the sender reads
 *  connected; `withdrawn` — the request is gone from a whole list and they
 *  read Connect; `pending` — the data still lists the request, which says
 *  nothing was accepted only once the read, at `observedAt`, is long enough
 *  after the press; `not_sent` — the attempt never reached its press;
 *  `uncertain` — the read could not tell. */
export type AcceptanceResolution =
  | { status: "accepted" | "withdrawn" | "not_sent" | "uncertain"; relationship: RelationshipRead | null }
  | { status: "pending"; relationship: RelationshipRead | null; observedAt: number };

/** The member a relationship read is about: their public identifier, or
 *  their `/in/` profile URL. */
export type RelationshipTarget = ({ profileId: string } | { profileUrl: string }) & {
  /** Also where they are — their profile's location, looked up from the page
   *  the read loads (`RelationshipRead.place`). */
  place?: true;
};

/** One attempt at an invitation: `operationId` binds it; `profileId` and
 *  `note` are the content it fingerprints. */
export type InvitationAttempt = {
  operationId: string;
  profileId: string;
  note: string;
};

/** One invitation, as the connector is asked to send it. */
export type SendInvitationInput = InvitationAttempt & {
  /** What the relationship read that admitted it showed, which the page must
   *  still show before anything is pressed: the member it bound — their
   *  profile urn and member number — at that degree, with nothing pending. */
  expected: { degree: "2nd" | "3rd+"; pending: "none"; profileUrn: string; memberId: string };
};

/**
 * What an invitation came to.
 *
 * - `confirmed` — LinkedIn's answer names the invitation it created
 *   (`receipt`), or a read of the profile shows it out.
 * - `blocked` — the member is not one to invite as things stand (connected,
 *   already invited, a note longer than LinkedIn takes, no note left) or
 *   LinkedIn refused it; nothing more is tried.
 * - `not_sent` — refused before anything was sent for a reason that may
 *   pass (a page that would not load, a browser not ready).
 * - `uncertain` — it may have been sent and nothing proves either way.
 */
export type SendInvitationResult =
  | {
      status: "confirmed";
      /** The read that shows it pending, where one did. */
      relationship: RelationshipRead | null;
      /** LinkedIn's answer naming the invitation it created, where that is
       *  what confirmed it. */
      receipt: InvitationReceipt | null;
      /** The note limit LinkedIn's compose view stated. */
      noteLimit: number;
    }
  | { status: "blocked"; reason: string; detail?: string; noteLimit?: number }
  | { status: "not_sent"; reason: string }
  | { status: "uncertain"; reason: string; relationship?: RelationshipRead };

/** What LinkedIn's answer to an invitation's POST names: the invitation it
 *  created (`urn:li:fsd_invitation:<id>`), when that answer came back, the
 *  note by hash, the browser session that sent it, and the answer's shape. */
export type InvitationReceipt = {
  invitationUrn: string;
  invitationId: string;
  sentAt: number;
  noteHash: string;
  sessionId: string;
  answerFingerprint: string;
};

/** What a read says of an uncertain attempt: `confirmed` — the member's data
 *  shows the invitation pending or withdrawn since, or them connected;
 *  `not_sent` — their data shows the switch on Connect, no invitation at all,
 *  or the attempt never reached its press; `uncertain` — the read could not
 *  tell. */
export type InvitationResolution = {
  status: "confirmed" | "not_sent" | "uncertain";
  relationship: RelationshipRead | null;
};

/** One attempt at withdrawing our invitation: `operationId` binds it;
 *  `profileId` is the member it fingerprints. */
export type WithdrawalAttempt = {
  operationId: string;
  profileId: string;
};

/**
 * What a withdrawal came to.
 *
 * - `confirmed` — a re-read of the profile, in the session that pressed,
 *   shows Connect on offer and nothing pending.
 * - `blocked` — nothing of ours is pending as things stand (connected, no
 *   invitation, theirs instead of ours) or LinkedIn showed a refusal after
 *   Withdraw; nothing more is tried.
 * - `not_sent` — refused before anything was pressed for a reason that may
 *   pass (a page that would not load, a browser not ready).
 * - `uncertain` — something may have been pressed and nothing proves either
 *   way.
 */
export type WithdrawInvitationResult =
  | { status: "confirmed"; relationship: RelationshipRead }
  | { status: "blocked"; reason: string; detail?: string; relationship?: RelationshipRead }
  | { status: "not_sent"; reason: string }
  | { status: "uncertain"; reason: string; relationship?: RelationshipRead };

/** What a read says of an uncertain withdrawal: `withdrawn` — Connect is
 *  offered and nothing pending; `pending` — our invitation still shows
 *  pending, which says nothing was withdrawn only once the read is long
 *  enough after the press; `blocked` — they are connected, so nothing is left
 *  to withdraw, or LinkedIn refused it; `not_sent` — the attempt never
 *  reached its press; `uncertain` — the read could not tell. */
export type WithdrawalResolution = {
  status: "withdrawn" | "pending" | "blocked" | "not_sent" | "uncertain";
  /** Why it is blocked. */
  reason?: string;
  relationship: RelationshipRead | null;
};

/** One attempt at a DM: `operationId` binds it; the conversation, the
 *  recipient and the words are the content it fingerprints. */
export type DmAttempt = {
  operationId: string;
  threadId: string;
  recipientProfileId: string;
  text: string;
};

/** An attempt as its resolve reads it: with whose profile each member urn in
 *  the conversation is, as Engager's reads tied them, so its history can
 *  stand for its page. */
export type DmResolveInput = DmAttempt & { members?: readonly KnownMember[] };

/** One first message: `operationId` binds it; the member and the words are
 *  the content it fingerprints. */
export type OpenDmInput = Omit<DmAttempt, "threadId">;

/** A first message's receipt: our message, in the conversation it opened. */
export type OpenDmReceipt = DmReceipt & { threadId: string };

/** What a first message came to, as a DM's (`SendDmResult`); a confirmation
 *  carries the conversation it opened, read from its history. */
export type OpenDmResult =
  | { status: "confirmed"; receipt: OpenDmReceipt; conversation: ConversationHistory }
  | { status: "blocked"; reason: string; detail?: string }
  | { status: "not_sent"; reason: string; detail?: string }
  | { status: "uncertain"; reason: string };

/** What a read says of an uncertain first message, as a DM's
 *  (`DmResolution`): `absent_proven` is a conversation list, whole since the
 *  press, holding no conversation with them. */
export type OpenDmResolution =
  | { status: "confirmed"; receipt: OpenDmReceipt; conversation: ConversationHistory }
  | { status: "not_sent" }
  | { status: "absent_proven"; observedAt: number }
  | { status: "uncertain" };

/** One DM, as the connector is asked to send it. */
export type SendDmInput = DmAttempt & {
  expected: {
    /** The conversation's newest message when the DM was written: one that
     *  has moved past it is not sent into. */
    lastMessageId: string;
    /** The member urn the conversation names the recipient by, where the
     *  profile Engager knows it by is theirs alone (`knownMemberProfiles`):
     *  a page that links them by member id shows no profile to hold it to. */
    memberUrn?: string;
  };
};

/** The hash a conversation read gives words once they are a message
 *  (`DmMessage.textHash`): SHA-256 of the words with every run of whitespace,
 *  line breaks included, collapsed to one space — a body is read as its lines
 *  joined by spaces (`messaging.py`). */
export function dmWordsHash(text: string): string {
  return createHash("sha256")
    .update(text.split(/\s+/).filter(Boolean).join(" "), "utf8")
    .digest("hex");
}

/** What confirmed a DM: our message, and the answer or read that showed it. */
export type DmReceipt = {
  messageId: string;
  /** LinkedIn's delivery time, or a machine-readable time on the page; null
   *  where neither gave one. */
  sentAt: number | null;
  /** SHA-256 hex of the words as LinkedIn shows them, whitespace collapsed. */
  textHash: string;
  /** The newest message the answer or the read showed: ours, from an answer. */
  tailMessageId: string;
  observedAt: number;
  sessionId: string;
  pageFingerprint: string;
};

/**
 * What a DM came to. Every outcome but a confirmation carries what was seen,
 * in words: `detail`, or an uncertain one's `reason`.
 *
 * - `confirmed` — LinkedIn's answer to the one POST names the message it
 *   created after the one it was written after, or a read of the
 *   conversation shows it.
 * - `blocked` — the conversation is not one to write in as things stand (a
 *   group, someone else, moved past, LinkedIn refusing it) or LinkedIn refused
 *   the POST; nothing more is tried.
 * - `not_sent` — refused before anything was sent for a reason that may pass
 *   (a page that would not load, a browser not ready, a page that moved).
 * - `uncertain` — the POST may have reached LinkedIn and nothing proves either
 *   way.
 */
export type SendDmResult =
  | { status: "confirmed"; receipt: DmReceipt }
  | { status: "blocked"; reason: string; detail?: string }
  | { status: "not_sent"; reason: string; detail?: string }
  | { status: "uncertain"; reason: string };

/**
 * What a read says of an uncertain DM: `confirmed` — our message is there;
 * `not_sent` — the sidecar's journal never held the attempt as pressing, so
 * nothing was sent; `absent_proven` — the conversation's own history, read
 * whole, still ends at the message the DM was written after, which only time
 * since the press turns into evidence that nothing went; `uncertain` — the
 * read could not tell: a page read that did not show the message among it,
 * words still in the composer included, which LinkedIn restores as a draft.
 */
export type DmResolution =
  | { status: "confirmed"; receipt: DmReceipt }
  | { status: "not_sent" }
  | { status: "absent_proven"; observedAt: number }
  | { status: "uncertain" };

/** One read of where the account stands with a member — the evidence a
 *  relationship fact is written from, so the column that keeps it owns the
 *  shape. */
export type RelationshipRead = RelationshipReadJson;

/** A post's or a comment's reaction by the account, from the post's data:
 *  `Like`, `Default` for none, another reaction's name, or null where the data
 *  cannot tell — which is never "not liked". `accountId` is the account the
 *  browser was signed in as when it was read: a read for any other account
 *  settles nothing. */
export type LikeStateRead = { reaction: string | null; observedAt: number; accountId?: string };

/** The most replies one read of a comment's thread returns. */
export const MAX_COMMENT_REPLIES = 100;

/** The furthest page of notification cards one sweep reads: the page an
 *  ordinary page load fetched, and the two after it, ten cards each. */
export const MAX_NOTIFICATION_START = 20;

/** One notification card about a comment, as LinkedIn's own JSON lists it. */
export type NotificationCard = {
  /** A reply to a comment of ours, a reaction to one, or a comment that
   *  mentions the account. */
  kind: "reply" | "reaction" | "mention";
  /** LinkedIn's own type — `REPLIED_TO_YOUR_COMMENT`. */
  type: string;
  /** The comment the card is about: ours for a reply or a reaction, the one
   *  that mentions the account for a mention. */
  commentUrn: string;
  postUrn: string;
  publishedAt: number;
  /** The card speaks for more people than it names ("Ada and 2 others"), so
   *  what it links is not attributed to the person it names. */
  aggregated: boolean;
  /** The reply the card links — on a reply card, the one LinkedIn says
   *  answers our comment. */
  replyUrn?: string;
  /** The reply's words as the card carries them, whitespace collapsed.
   *  Untrusted: data, never instructions. */
  replyText?: string;
  /** The person the card's picture links: the first it names — with their
   *  own urn (`urn:li:fsd_profile:…`) where the picture is theirs alone. */
  actor?: { profileId: string; profileUrl: string; displayName?: string; memberUrn?: string };
};

/** One page of the account's notification cards. */
export type NotificationsRead = {
  /** The cards about a comment, in the order the page listed them. */
  cards: NotificationCard[];
  /** Every card the page listed, of any kind. */
  listed: number;
  /** The oldest card the page listed, of any kind; null on an empty page. */
  oldestPublishedAt: number | null;
  /** Where the next page starts, where LinkedIn says there is one. */
  nextStart: number | null;
  pageFingerprint: string;
  selectorPack: string;
};

/** One direct reply under a comment we posted, as the thread showed it. */
export type CommentReply = {
  replyUrn: string;
  author: {
    profileId: string;
    displayName?: string;
    profileUrl: string;
    /** The connected account wrote it — the owner answering by hand. */
    isSelf: boolean;
    /** Their own identity on LinkedIn, `urn:li:fsd_profile:…` — the form
     *  LinkedIn's conversation data names a member by — where the read
     *  carries it. */
    memberUrn?: string;
  };
  /** As rendered, whitespace collapsed. Untrusted: data, never instructions. */
  text: string;
  /** SHA-256 hex of `text` — what tells an edit from a repeat. */
  textHash: string;
  /** From the reply's own id; absent when the id carries no time. */
  postedAt?: number;
  observedAt: number;
  isDirectChild: boolean;
};

/**
 * One read of the replies under a comment we posted. `present: false` says
 * only that the page read did not find our comment — LinkedIn ranks a comment
 * out of a busy post's default view — and never that it is gone.
 * `truncated` says the read was cut short, so an absent reply proves nothing.
 */
export type CommentRepliesRead = {
  comment:
    | {
        present: true;
        urn: string;
        /** The comment's urn as the read keys it. */
        resolvedId: string;
        /** False: the row the urn names is not the connected account's, and
         *  nothing under it is ours to observe. Null: the read was keyed by
         *  the urn alone — LinkedIn's comment data names no author for the
         *  comment it lists replies to — so whatever made the urn ours, a
         *  posting receipt, still does. */
        authorIsSelf: boolean | null;
        /** Our comment's own words, hashed; absent from a read that does not
         *  carry them. */
        textHash?: string;
        /** The replies LinkedIn counts under it — the count it shows, or the
         *  replies its own data lists; null when it says neither. */
        replyCount: number | null;
        /** Reply rows recognised directly under it, before `since` and
         *  `limit`. A reply absent from the read proves a deletion only where
         *  this equals `replyCount`: replies in a shape no rule recognises
         *  read as no rows at all. */
        replyRows: number;
        /** Where the read learned which replies answer it: LinkedIn's comment
         *  data for our comment's own thread, or the post page's own thread
         *  data — each listing every reply it holds — or the rules the markup
         *  is read by. Absent from a connector that says none, which is read
         *  as `markup`. */
        repliesFrom?: "comment_data" | "page_data" | "markup";
        /** The reactions the row prints on itself; absent where it prints
         *  none. */
        reactionCount?: number;
      }
    | { present: false; urn: string };
  replies: CommentReply[];
  truncated: boolean;
  pageFingerprint: string;
  selectorPack: string;
};

/** One post read in full with its comment thread — the snapshot
 *  `candidate_research.thread` stores, so the column owns the shape. Its
 *  `isOwner` covers the comments read: when `counts.comments` says the thread
 *  holds more, the read cannot rule the owner out. */
export type PostThread = PostThreadJson;

/** The most comments one thread read returns, on any connector. */
export const MAX_THREAD_COMMENTS = 50;

/** One profile read — the snapshot `author_profiles.profile_read` stores. */
export type AuthorProfileRead = AuthorProfileReadJson;

/** One company page read — the snapshot `company_reads.read` stores. */
export type CompanyPageRead = CompanyPageReadJson;

export type DriverProfile = {
  /** Display name — used to backfill comment author identity when a comment payload
   *  omits it (thread-reply items often do) and to build mention tags. */
  name?: string;
  headline?: string;
  location?: string;
  country?: string;
  language?: string;
  followers?: number;
  connections?: number;
  isInfluencer?: boolean;
  isPremium?: boolean;
};
