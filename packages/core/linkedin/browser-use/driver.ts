import { createHash } from "node:crypto";
import type {
  AcceptanceResolution,
  AcceptInvitationInput,
  AcceptInvitationResult,
  AgentPage,
  AgentPageRequest,
  AuthorProfileRead,
  CompanyPageRead,
  CommentRepliesRead,
  ConversationHistory,
  DiscoverParams,
  DiscoverResult,
  DmAttempt,
  DmReceipt,
  DmResolution,
  DmResolveInput,
  DmThreadRead,
  DriverPost,
  EnsureSessionOptions,
  InboxRead,
  IncomingInvitationsRead,
  InvitationAttempt,
  InvitationResolution,
  KnownMember,
  LikeStateRead,
  LinkedInDriver,
  OpenDmInput,
  OpenDmResolution,
  OpenDmResult,
  NotificationsRead,
  PostInput as DomainPostInput,
  RoomReplyInput,
  PostResult,
  PostThread,
  RelationshipRead,
  RelationshipTarget,
  ReplyTarget,
  ReserveRead,
  SendDmInput,
  SendDmResult,
  SendInvitationInput,
  SendInvitationResult,
  SessionStatus,
  WithdrawalAttempt,
  WithdrawalResolution,
  WithdrawInvitationResult,
} from "../driver";
import { dmWordsHash, OWN_COMMENT_LIMIT, OWN_POST_LIMIT } from "../driver";
import {
  BrowserUseClient,
  BrowserUseRemoteError,
  BrowserUseTransportError,
} from "./client";
import type { ConnectorError } from "../connectorError";
import type {
  BrowserUseAcceptance,
  BrowserUseDm,
  BrowserUseInvitation,
  BrowserUseOpenDm,
  BrowserUsePostInput,
  BrowserUseWrite,
  BrowserUseResolvedWrite,
  BrowserUseWithdrawal,
} from "./protocol";

type PostInput = DomainPostInput | RoomReplyInput;

const UNSUPPORTED_WRITE =
  "Browser Use writes require a stable marker and the supervised marker-aware flow";

const LINKEDIN_ORIGIN = "https://www.linkedin.com";

export class BrowserUseUnsupportedOperationError extends Error {
  readonly code = "unsupported_operation";

  constructor(operation: string) {
    super(`Browser Use spike does not support ${operation}`);
    this.name = "BrowserUseUnsupportedOperationError";
  }
}

/** A request this driver refuses to send because its arguments contradict
 *  themselves; the sidecar is never asked. */
export class BrowserUseInvalidRequestError extends Error {
  readonly code = "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "BrowserUseInvalidRequestError";
  }
}

export class BrowserUseWriteUncertainError extends Error {
  readonly code = "write_uncertain";

  constructor(readonly operationId: string, message: string) {
    super(message);
    this.name = "BrowserUseWriteUncertainError";
  }
}

export type BrowserUseDriverOptions = {
  /** The owner's live-writes switch, read when the driver is built. Without
   *  it the driver refuses every write before any request reaches the
   *  sidecar, so no page is visited for one; absence always fails closed. */
  writesEnabled?: boolean;
};

/**
 * Local Browser Use adapter. It implements the core read contract plus the
 * marker-aware write for comments and replies. Legacy driver write methods
 * fail closed because their signatures omit PostInput.marker; canonical sends
 * use postExactlyOnce(), which selects postWithReceipt when it is available.
 */
export class BrowserUseDriver implements LinkedInDriver {
  readonly name = "browser-use";
  readonly capabilities = {
    // What comes in here is the replies under comments we posted: seen in
    // the account's notification cards (`readNotifications`) and read one
    // watched comment at a time (`readCommentReplies`). No sidecar op reads
    // the owner's own posts' comments, so there is no own-post sweep.
    incoming: true,
    // fetchOwnPosts/fetchOwnComments are live-verified — voice learning works.
    ownContent: true,
  } as const;

  readonly #client: BrowserUseClient;
  readonly #writesEnabled: boolean;

  constructor(
    client: BrowserUseClient,
    options: BrowserUseDriverOptions = {},
  ) {
    this.#client = client;
    this.#writesEnabled = options.writesEnabled === true;
  }

  async ensureSession(opts?: EnsureSessionOptions): Promise<SessionStatus> {
    const result = await this.#client.request("ensure_session", {
      ...(opts?.existingPageOnly ? { existingPageOnly: true } : {}),
      ...(opts?.interactive ? { interactive: true } : {}),
      ...(opts?.interactive && opts.surface === false ? { surface: false } : {}),
      ...(opts?.signIn ? { signIn: true } : {}),
      ...(opts?.place ? { place: opts.place } : {}),
    });
    // The sidecar has always been allowed to name the account here (the wire
    // schema carries `account`), and this method used to drop it — which is why
    // no surface could ever say WHICH LinkedIn identity was connected.
    const account = {
      ...(result.account?.displayName
        ? { displayName: result.account.displayName }
        : {}),
      ...(result.account?.externalAccountId
        ? { externalAccountId: result.account.externalAccountId }
        : {}),
      ...(result.account?.headline ? { headline: result.account.headline } : {}),
    };
    return {
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.signInPage ? { signInPage: true } : {}),
      ...(Object.keys(account).length > 0 ? { account } : {}),
    };
  }

  async discoverPosts(params: DiscoverParams): Promise<DiscoverResult> {
    const term = params.term.trim();
    if (!term) throw new Error("Browser Use discovery term must not be empty");
    const result = await this.#client.request("discover_posts", {
      term,
      cursor: params.cursor,
      limit: params.limit,
      kind: params.kind,
      datePosted: params.datePosted,
      sort: params.sort,
    });
    return result;
  }

  async fetchOwnProfile(): Promise<{ displayName?: string } | null> {
    const { profile } = await this.#client.request("fetch_own_profile", {});
    return profile;
  }

  async fetchOwnPosts(
    limit = OWN_POST_LIMIT,
    onIncomplete?: () => void,
  ): Promise<DriverPost[]> {
    const result = await this.#client.request("fetch_own_posts", { limit });
    if (result.incomplete) {
      console.warn(`[voice] own posts: read stopped at ${result.posts.length} of ${limit}`);
      onIncomplete?.();
    }
    return result.posts;
  }

  /**
   * The account's own comments, as its activity page's data lists them: the
   * first screen, then each page LinkedIn's own pager loads as the list is
   * scrolled (`own_comments.py`), to `limit`. A page of the list that was
   * read wrongly rejects the read; a page that did not arrive after some were
   * read returns those, and `onIncomplete` says the list went on. It waits on
   * pages of megabytes, so it has the longer timeout
   * (`OWN_COMMENTS_TIMEOUT_MS`).
   */
  async fetchOwnComments(
    limit = OWN_COMMENT_LIMIT,
    onIncomplete?: () => void,
  ): Promise<{ text: string; postUrn: string }[]> {
    const result = await this.#client.request(
      "fetch_own_comments",
      { limit },
      { timeoutMs: OWN_COMMENTS_TIMEOUT_MS },
    );
    if (result.incomplete) {
      console.warn(`[voice] own comments: read stopped at ${result.comments.length} of ${limit}`);
      onIncomplete?.();
    }
    return result.comments;
  }

  /** The post's own page, then its JSON: the read a person makes opening it. */
  async readPostThread(
    postUrn: string,
    opts: { maxComments: number; order?: "relevance" | "recent"; start?: number },
  ): Promise<PostThread> {
    return this.#client.request("read_post_thread", {
      postUrn,
      maxComments: opts.maxComments,
      ...(opts.order ? { order: opts.order === "recent" ? "REVERSE_CHRONOLOGICAL" as const : "RELEVANCE" as const } : {}),
      ...(opts.start === undefined ? {} : { start: opts.start }),
    });
  }

  /** The author's profile page, then its JSON — a visible profile view. */
  async readAuthorProfile(profileId: string, opts: { role?: boolean } = {}): Promise<AuthorProfileRead> {
    return this.#client.request("read_author_profile", { profileId, ...(opts.role ? { role: true } : {}) });
  }

  async readCompanyPage(companyRef: string): Promise<CompanyPageRead> {
    return this.#client.request("read_company_page", { companyRef });
  }

  /**
   * LinkedIn's comment data for our comment's own thread, asked by its urn as
   * stored; where that cannot answer, the post's own page, read as markup:
   * our comment's row and the rows directly under it. A layout the sidecar
   * does not recognise comes back as a `drift` ConnectorError carrying the
   * page's fingerprint, never as rows.
   */
  async readCommentReplies(
    postUrn: string,
    commentUrn: string,
    opts: { since?: number; limit: number; vouchedReplyUrns?: string[]; roomReplyUrn?: string },
  ): Promise<CommentRepliesRead> {
    return this.#client.request("read_comment_replies", {
      postUrn,
      commentUrn,
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      limit: opts.limit,
      ...(opts.vouchedReplyUrns?.length ? { vouchedReplyUrns: opts.vouchedReplyUrns } : {}),
      ...(opts.roomReplyUrn ? { roomReplyUrn: opts.roomReplyUrn } : {}),
    });
  }

  /**
   * One page of the notification cards, as LinkedIn's own JSON: page 0 is the
   * response the feed's own load fetches, kept as the page receives it — the
   * notifications page is never opened. A shape the sidecar does not
   * recognise comes back as a `drift` ConnectorError, never as "no cards".
   */
  async readNotifications(opts: { start: number }): Promise<NotificationsRead> {
    return this.#client.request("read_notifications", { start: opts.start });
  }

  /**
   * The member's own profile page, read as markup in this account's session.
   * Nothing on it is pressed, so the note composer is read only where one is
   * already open; a layout the sidecar does not recognise comes back as a
   * `drift` ConnectorError, never as a relationship.
   */
  async readRelationship(target: RelationshipTarget): Promise<RelationshipRead> {
    return this.#client.request("read_relationship", target);
  }

  /**
   * The account's own received-invitations page, read from the data it is
   * served with. Nothing on it is pressed; data the sidecar does not
   * recognise comes back as a `drift` ConnectorError, never as "no
   * invitations".
   */
  async readIncomingInvitations(opts: {
    since?: number;
    limit: number;
  }): Promise<IncomingInvitationsRead> {
    return this.#client.request("read_incoming_invitations", {
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      limit: opts.limit,
    });
  }

  /**
   * One acceptance through the sidecar's write journal, in one request: the
   * invitations page's data is re-read, the request refused unless it lists
   * it from the sender, and the one Accept bound in the row the data keys;
   * then, after the account is probed and the journal holds the attempt as
   * CLICKING, it is pressed and answered with the sender's profile read in
   * the same session, until it shows the Accept. Gated by the live-writes
   * switch, as every write is.
   *
   * Only a read showing the sender connected is `confirmed`. Everything
   * refused before the press went nowhere — a failed account probe among it;
   * anything after the press that a read did not settle is `uncertain`, and a
   * second call under the same operation id never presses again.
   */
  async acceptInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
    if (!this.#writesEnabled) {
      return { status: "not_sent", reason: "writes_off" };
    }
    const content = acceptanceContent(input);
    let sent: BrowserUseAcceptance;
    try {
      sent = await this.#client.request(
        "accept_invitation",
        { step: "send", ...content },
        { timeoutMs: MEMBER_WRITE_TIMEOUT_MS },
      );
    } catch (error) {
      return acceptanceFailure(error);
    }
    assertReceiptOperationId(input.operationId, sent.operationId);
    return acceptanceAnswer(sent, input.senderProfileId);
  }

  /** A read of the sender and the invitations page's data against an
   *  acceptance's journal entry; presses nothing. The journal is asked first
   *  with no page budgeted: an attempt it can answer alone — one that never
   *  reached its press — costs no read. Otherwise `reserveRead` is asked for
   *  each page the sidecar may then load, and a refusal ends the asking: the
   *  read goes ahead with the pages granted, or not at all. A read that could
   *  not finish throws. */
  async resolveAcceptance(input: AcceptInvitationInput, reserveRead: ReserveRead): Promise<AcceptanceResolution> {
    const resolve = async (reads: number) => {
      const result = await this.#client.request("accept_invitation", {
        step: "resolve",
        ...acceptanceContent(input),
        reads,
      });
      assertReceiptOperationId(input.operationId, result.operationId);
      return result;
    };
    let result = await resolve(0);
    if (result.state === "read_needed") {
      let reads = 0;
      while (reads < ACCEPTANCE_RESOLVE_READS && (await reserveRead())) reads += 1;
      if (reads === 0) return { status: "uncertain", relationship: null };
      result = await resolve(reads);
    }
    switch (result.state) {
      case "confirmed":
        return showsConnected(result.relationship, input.senderProfileId)
          ? { status: "accepted", relationship: result.relationship }
          : { status: "uncertain", relationship: result.relationship };
      case "blocked":
        return { status: "withdrawn", relationship: result.relationship ?? null };
      case "still_pending":
        return { status: "pending", relationship: result.relationship, observedAt: result.observedAt };
      case "resolved_not_sent":
        return { status: "not_sent", relationship: result.relationship };
      default:
        return { status: "uncertain", relationship: "relationship" in result ? (result.relationship ?? null) : null };
    }
  }

  /**
   * The messaging inbox, read from LinkedIn's own conversation data: the list
   * the compose view's load fetches, kept as the page received it. Nothing
   * is opened, pressed or marked. Data the sidecar does not recognise comes
   * back as a `drift` ConnectorError, never as a list.
   */
  async readInbox(opts: { since?: number; limit: number }): Promise<InboxRead> {
    return this.#client.request("read_inbox", {
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      limit: opts.limit,
    });
  }

  /**
   * One conversation's own page, read as markup. Its composer is read, never
   * focused, typed in or cleared, so the owner's half-written words stay
   * exactly as they were; with `restoreUnread` the sidecar then puts the
   * unread mark the open took back. A layout the sidecar does not recognise
   * comes back as a `drift` ConnectorError, never as a thread.
   */
  async readDmThread(
    threadId: string,
    opts: { since?: number; restoreUnread?: boolean },
  ): Promise<DmThreadRead> {
    return this.#client.request("read_dm_thread", {
      threadId,
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(opts.restoreUnread ? { restoreUnread: true } : {}),
    });
  }

  /**
   * One conversation's newest messages, read from LinkedIn's own history for
   * it on the compose view — the GET the page's own messaging client makes,
   * with its headers — without opening it. A renamed query or an answer the
   * sidecar does not know comes back as a failure, never as messages.
   */
  async readConversationMessages(
    threadId: string,
    opts: { limit: number; members?: readonly KnownMember[] },
  ): Promise<ConversationHistory> {
    return this.#client.request("read_conversation_messages", {
      threadId,
      limit: opts.limit,
      ...(opts.members?.length ? { members: [...opts.members] } : {}),
    });
  }

  /**
   * One page as the agent reader's text. The address is built here from what
   * the request names, and the sidecar refuses any that is not that page; it
   * loads it with the structured reads' own expansions and presses nothing
   * else. The inbox is the compose view, which opens no conversation, read as
   * the conversation data its load fetched.
   */
  async readPageForAgent(request: AgentPageRequest): Promise<AgentPage> {
    switch (request.intent) {
      case "comment_replies":
        return this.#client.request("read_page_for_agent", {
          intent: "comment_replies",
          url: `${LINKEDIN_ORIGIN}/feed/update/${request.postUrn}/`,
          commentUrn: request.commentUrn,
        });
      case "inbox":
        return this.#client.request("read_page_for_agent", {
          intent: "inbox",
          url: `${LINKEDIN_ORIGIN}/messaging/`,
        });
      case "dm_thread":
        return this.#client.request("read_page_for_agent", {
          intent: "dm_thread",
          url: `${LINKEDIN_ORIGIN}/messaging/thread/${request.threadId}/`,
        });
    }
  }

  /**
   * One invitation through the sidecar's write journal, in one request: the
   * member's relationship is re-read against `expected` and the note limit
   * LinkedIn's compose view states; then, after the journal holds the attempt
   * as CLICKING, LinkedIn's own invitation POST is made once and answered with
   * what LinkedIn said. Gated by the live-writes switch, as a comment and a
   * like are: an external action on the account never rides in on a read-only
   * driver.
   *
   * LinkedIn's answer naming the invitation it created is `confirmed`.
   * Everything refused before the POST — the member as LinkedIn's data showed
   * them, a page that would not load — went nowhere; anything after it that
   * the answer did not settle is `uncertain`, and a second call under the same
   * operation id never sends again.
   */
  async sendInvitation(input: SendInvitationInput): Promise<SendInvitationResult> {
    if (!this.#writesEnabled) {
      return { status: "not_sent", reason: "writes_off" };
    }
    const content = invitationContent(input);
    let sent: BrowserUseInvitation;
    try {
      sent = await this.#client.request(
        "send_invitation",
        { step: "send", ...content, expected: input.expected },
        { timeoutMs: MEMBER_WRITE_TIMEOUT_MS },
      );
    } catch (error) {
      return journaledWriteFailure(error);
    }
    assertReceiptOperationId(input.operationId, sent.operationId);
    return invitationAnswer(sent, input.profileId);
  }

  /** A read of the member against an attempt's journal entry; presses
   *  nothing. A read that could not finish throws. */
  async resolveInvitation(input: InvitationAttempt): Promise<InvitationResolution> {
    const result = await this.#client.request("send_invitation", {
      step: "resolve",
      ...invitationContent(input),
    });
    assertReceiptOperationId(input.operationId, result.operationId);
    if (result.state === "confirmed" && showsInvitation(result.relationship, input.profileId, { withdrawn: true })) {
      return { status: "confirmed", relationship: result.relationship };
    }
    if (result.state === "resolved_not_sent") {
      return { status: "not_sent", relationship: result.relationship };
    }
    return {
      status: "uncertain",
      relationship: "relationship" in result ? (result.relationship ?? null) : null,
    };
  }

  /**
   * One withdrawal through the sidecar's write journal, in one request: the
   * member is re-read, refused unless their data shows our invitation pending,
   * and the one control rendered under the key that data names for their
   * Pending bound (opening the top card's More once where it sits in its
   * menu); then, only after the journal holds the attempt as CLICKING, it
   * presses it and the confirmation's Withdraw and answers with the member's
   * profile read until it shows the withdrawal. Gated by the live-writes
   * switch, as every write is.
   *
   * Only a read whose data shows their switch on Withdrawn, or back on
   * Connect, is `confirmed`. Everything refused before a press went nowhere;
   * anything after it that a read did not settle is `uncertain`, and a second
   * call under the same operation id never presses again.
   */
  async withdrawInvitation(input: WithdrawalAttempt): Promise<WithdrawInvitationResult> {
    if (!this.#writesEnabled) {
      return { status: "not_sent", reason: "writes_off" };
    }
    const content = withdrawalContent(input);
    let sent: BrowserUseWithdrawal;
    try {
      sent = await this.#client.request(
        "withdraw_invitation",
        { step: "send", ...content },
        { timeoutMs: MEMBER_WRITE_TIMEOUT_MS },
      );
    } catch (error) {
      return journaledWriteFailure(error);
    }
    assertReceiptOperationId(input.operationId, sent.operationId);
    return withdrawalAnswer(sent, input.profileId);
  }

  /** A read of the member against a withdrawal's journal entry; presses
   *  nothing. A read that could not finish throws. */
  async resolveWithdrawal(input: WithdrawalAttempt): Promise<WithdrawalResolution> {
    const result = await this.#client.request("withdraw_invitation", {
      step: "resolve",
      ...withdrawalContent(input),
    });
    assertReceiptOperationId(input.operationId, result.operationId);
    switch (result.state) {
      case "confirmed":
        return showsWithdrawn(result.relationship, input.profileId)
          ? { status: "withdrawn", relationship: result.relationship }
          : { status: "uncertain", relationship: result.relationship };
      case "still_pending":
        return showsPending(result.relationship, input.profileId)
          ? { status: "pending", relationship: result.relationship }
          : { status: "uncertain", relationship: result.relationship };
      case "blocked":
        return { status: "blocked", reason: result.reason, relationship: result.relationship ?? null };
      case "resolved_not_sent":
        return { status: "not_sent", relationship: result.relationship };
      default:
        return { status: "uncertain", relationship: "relationship" in result ? (result.relationship ?? null) : null };
    }
  }

  /**
   * One DM through the sidecar's write journal, in one request: the
   * conversation is read afresh and held to the recipient by the member urn
   * it is bound to and to the message it was written after; then, after the
   * journal holds the attempt as CLICKING, the one POST LinkedIn's own
   * messaging client makes is made, and answered with what LinkedIn answered.
   * Gated by the live-writes switch, as every other write is.
   *
   * Only the message LinkedIn says it created, with these words, is
   * `confirmed`. A refusal before anything was sent went nowhere, and only
   * those refusals, by code, say so: anything else a send answers may follow
   * the POST, and is `uncertain`. A second call under the same operation id
   * never sends again.
   */
  async sendDm(input: SendDmInput): Promise<SendDmResult> {
    if (!this.#writesEnabled) {
      return { status: "not_sent", reason: "writes_off" };
    }
    const content = dmContent(input);
    let sent: BrowserUseDm;
    try {
      sent = await this.#client.request(
        "send_dm",
        { step: "send", ...content, expected: input.expected },
        { timeoutMs: MEMBER_WRITE_TIMEOUT_MS },
      );
    } catch (error) {
      return dmFailure(error);
    }
    assertReceiptOperationId(input.operationId, sent.operationId);
    return dmAnswer(sent, input);
  }

  /** A read of the conversation against an attempt's journal entry — its
   *  history where the sidecar can read it, else its page; presses nothing.
   *  A read that could not finish throws. */
  async resolveDm(input: DmResolveInput): Promise<DmResolution> {
    const result = await this.#client.request("send_dm", {
      step: "resolve",
      ...dmContent(input),
      ...(input.members?.length ? { members: [...input.members] } : {}),
    });
    assertReceiptOperationId(input.operationId, result.operationId);
    switch (result.state) {
      case "confirmed":
        return showsDm(result.receipt, input.text)
          ? { status: "confirmed", receipt: result.receipt }
          : { status: "uncertain" };
      case "resolved_not_sent":
        return { status: "not_sent" };
      case "uncertain":
        return result.absent === true && result.observedAt !== undefined
          ? { status: "absent_proven", observedAt: result.observedAt }
          : { status: "uncertain" };
      default:
        return { status: "uncertain" };
    }
  }

  /**
   * The first message to a connection, in one request, on `sendDm`'s terms: a
   * refusal before the POST being `blocked` and a confirmation counting only
   * where its receipt carries these words.
   */
  async openDm(input: OpenDmInput): Promise<OpenDmResult> {
    if (!this.#writesEnabled) {
      return { status: "not_sent", reason: "writes_off" };
    }
    const content = openDmContent(input);
    let sent: BrowserUseOpenDm;
    try {
      sent = await this.#client.request(
        "open_dm",
        { step: "send", ...content },
        { timeoutMs: MEMBER_WRITE_TIMEOUT_MS },
      );
    } catch (error) {
      return dmFailure(error);
    }
    assertReceiptOperationId(input.operationId, sent.operationId);
    return openDmAnswer(sent, input);
  }

  /** A read of the account's conversations against a first message's
   *  journal entry; presses nothing. A read that could not finish throws. */
  async resolveOpenDm(input: OpenDmInput): Promise<OpenDmResolution> {
    const result = await this.#client.request("open_dm", { step: "resolve", ...openDmContent(input) });
    assertReceiptOperationId(input.operationId, result.operationId);
    switch (result.state) {
      case "confirmed":
        return showsDm(result.receipt, input.text)
          ? { status: "confirmed", receipt: result.receipt, conversation: result.conversation }
          : { status: "uncertain" };
      case "resolved_not_sent":
        return { status: "not_sent" };
      case "uncertain":
        return result.absent === true && result.observedAt !== undefined
          ? { status: "absent_proven", observedAt: result.observedAt }
          : { status: "uncertain" };
      default:
        return { status: "uncertain" };
    }
  }

  async postComment(_postUrn: string, _text: string): Promise<PostResult> {
    return { ok: false, error: UNSUPPORTED_WRITE };
  }

  async postReply(_target: ReplyTarget, _text: string): Promise<PostResult> {
    return { ok: false, error: UNSUPPORTED_WRITE };
  }

  /**
   * Like the post we are commenting on. `likeWhenCommenting` defaults TRUE, so
   * before this existed every canonical comment logged
   * `[post] like failed ... does not support liking posts` to stderr and the
   * like silently never happened.
   *
   * Gated by the SAME live-writes switch as a comment: an external action on a
   * real account may not ride in on a read-only driver. It needs no sidecar
   * journal — the sidecar reads the post's data first and sends LinkedIn's own
   * LIKE only where it shows no reaction, so it can never take a like back off
   * nor change another reaction, and "already liked" is success, not a retry.
   * Which of the two it was rides on `reaction`; a refusal raised before the
   * POST, and LinkedIn's refusal of it, is `notAttempted` (`likeRefusal`).
   */
  async likePost(postUrn: string): Promise<PostResult> {
    if (!postUrn.trim()) {
      return { ok: false, notAttempted: true, error: "likePost requires a post urn" };
    }
    if (!this.#writesEnabled) {
      return { ok: false, notAttempted: true, error: "Browser Use live writes are off" };
    }
    try {
      const result = await this.#client.request("like_post", { postUrn }, { timeoutMs: LIKE_TIMEOUT_MS });
      return { ok: true, reaction: result.outcome };
    } catch (error) {
      return likeRefusal(error);
    }
  }

  /**
   * Like a COMMENT under its parent post — the incoming-comment dismissal
   * acknowledgement. Same contract as likePost: switch-gated, journal-free
   * (the sidecar reads the comment's reaction first and sends a LIKE only from
   * none, so a re-run can never unlike), and "already liked" is success.
   * The sidecar opens the PARENT post at the comment — comment urns are not
   * navigable — and likes it by its urn as LinkedIn's comment data lists it,
   * matched on the globally-unique comment id so the inner post spelling
   * (activity vs ugcPost) cannot cause a miss. A reply names the comment it
   * answers (`parentCommentUrn`): it is read from the post opened at it.
   */
  async likeComment(postUrn: string, commentUrn: string, parentCommentUrn?: string): Promise<PostResult> {
    if (!postUrn.trim()) {
      return { ok: false, notAttempted: true, error: "likeComment requires a post urn" };
    }
    if (!commentUrn.trim()) {
      return { ok: false, notAttempted: true, error: "likeComment requires a comment urn" };
    }
    if (!this.#writesEnabled) {
      return { ok: false, notAttempted: true, error: "Browser Use live writes are off" };
    }
    try {
      const result = await this.#client.request(
        "like_comment",
        parentCommentUrn ? { postUrn, commentUrn, parentCommentUrn } : { postUrn, commentUrn },
        { timeoutMs: LIKE_TIMEOUT_MS },
      );
      return { ok: true, reaction: result.outcome };
    } catch (error) {
      return likeRefusal(error);
    }
  }

  /**
   * The account's reaction to a post, or to a comment or reply under it, as
   * the post's own data declares it — what an uncertain like is settled by. A
   * reply is read from the post opened at it, which needs the comment it
   * answers; the comment a reply answers without the reply is refused, for it
   * would read as the post's own reaction. Read only: the sidecar opens the
   * post and presses nothing, so it needs no approval.
   */
  async readLikeState(postUrn: string, commentUrn?: string, parentCommentUrn?: string): Promise<LikeStateRead> {
    if (parentCommentUrn && !commentUrn) {
      throw new BrowserUseInvalidRequestError("readLikeState was given the comment a reply answers but not the reply");
    }
    return this.#client.request(
      "read_like_state",
      commentUrn
        ? parentCommentUrn
          ? { postUrn, commentUrn, parentCommentUrn }
          : { postUrn, commentUrn }
        : { postUrn },
    );
  }

  /**
   * The only live-write-capable adapter method for a comment, a reply or a
   * room reply. The canonical exactly-once chokepoint supplies the complete
   * marker-bearing input and has reconciled and authorized it; the sidecar
   * then does the rest in one request — adopts or refuses an earlier attempt
   * under the id, opens the post's page once, journals the attempt as
   * CLICKING, durably, and makes the one POST.
   *
   * A request that failed before the attempt was journaled comes back as a
   * refusal instead of a throw: nothing was pressed, so it is a definitive
   * "not posted". Thrown, it escaped as an unknown outcome, and one changed
   * page parked every queued send behind a "did it post?" review.
   */
  async postWithReceipt(input: PostInput): Promise<PostResult> {
    const operationId = input.marker;
    assertBoundOperationId(operationId, input);
    // A driver built without the owner's live-writes switch sends nothing and
    // opens no page: canonical posting reconciles before selecting this hook,
    // so an existing receipt is recovered through reconcilePosted instead.
    if (!this.#writesEnabled) {
      return { ok: false, error: "Browser Use live writes are off" };
    }
    let written: BrowserUseWrite;
    try {
      written = await this.#client.request(
        "write",
        { operationId, input: wireInput(input) },
        { timeoutMs: WRITE_TIMEOUT_MS },
      );
    } catch (error) {
      if (!refusedBeforeWrite(error)) throw error;
      return {
        ok: false,
        error: `Browser Use could not send the ${input.kind}: ${error.message}`,
        // The sidecar's code says the cause; a dropped bridge names none.
        ...(error instanceof BrowserUseRemoteError ? { code: error.code } : {}),
        retryable: error.retryable,
        notAttempted: !(error instanceof BrowserUseRemoteError && WRITE_REFUSAL_CODES.has(error.code)),
      };
    }
    assertReceiptOperationId(operationId, written.operationId);
    if (written.state === "already_committed") {
      if (!written.externalUrn) {
        throw new Error("Browser Use committed receipt omitted externalUrn");
      }
      return { ok: true, externalUrn: written.externalUrn, reconciled: true };
    }
    if (written.state === "uncertain") {
      throw new BrowserUseWriteUncertainError(
        operationId,
        written.error ?? "Browser Use write outcome is uncertain",
      );
    }
    if (written.state === "failed") {
      return {
        ok: false,
        error: written.error ?? "Browser Use write failed",
        ...(written.code ? { code: written.code } : {}),
        retryable: written.retryable,
        rateLimited: written.rateLimited,
      };
    }
    if (!written.externalUrn) {
      throw new BrowserUseWriteUncertainError(
        operationId,
        "Browser Use reported a committed write without an external URN",
      );
    }
    return { ok: true, externalUrn: written.externalUrn };
  }

  /**
   * Reconciliation is read-only and survives client/driver reconstruction. A
   * reply's answer comes from a whole read of the thread under its comment: a
   * read that could not finish throws rather than answering "not posted".
   */
  async reconcilePosted(input: PostInput): Promise<string | null> {
    if (!this.#writesEnabled) {
      throw new Error("Browser Use live writes are off");
    }
    if (!input.marker.trim()) {
      throw new Error("PostInput.marker must not be empty");
    }
    const result = await this.#client.request("reconcile_posted", {
      operationId: input.marker,
      input: wireInput(input),
    });
    assertReceiptOperationId(input.marker, result.operationId);
    return result.externalUrn;
  }

  /**
   * Local half of the explicit human `confirmed_not_posted` recovery. This must
   * be acknowledged before the cloud message is re-armed; it never clicks.
   */
  async resolveUncertainWriteOutcome(
    input: PostInput,
    resolutionVersion: number,
    postedUrn?: string,
  ): Promise<BrowserUseResolvedWrite> {
    if (!Number.isInteger(resolutionVersion) || resolutionVersion < 0) {
      throw new Error("resolutionVersion must be a non-negative integer");
    }
    const result = await this.#client.request("resolve_write_outcome", {
      operationId: input.marker,
      input: wireInput(input),
      outcome: postedUrn ? "confirmed_posted" : "confirmed_not_posted",
      ...(postedUrn ? { externalUrn: postedUrn } : {}),
      resolutionVersion,
    });
    assertReceiptOperationId(input.marker, result.operationId);
    return result;
  }

  /** The local half of the owner's word on a member write; never reads or clicks. */
  async settleMemberWrite(operationId: string, outcome: "went_out" | "not_sent") {
    const result = await this.#client.request("settle_member_write", { operationId, outcome });
    assertReceiptOperationId(operationId, result.operationId);
    return result;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

/**
 * A post input as the sidecar takes it. A reply names the comment it is posted
 * under and the one it answers, and carries exactly the owner's words: the
 * sidecar posts them into the comment's thread as LinkedIn's own client does,
 * adding no mention, and the receipt hashes those words.
 */
function wireInput(input: PostInput): BrowserUsePostInput {
  if (input.kind === "room_reply") {
    const { commentId, ...rest } = input;
    return { ...rest, parentCommentUrn: commentId };
  }
  if (input.kind === "comment") {
    return {
      kind: "comment",
      postUrn: input.postUrn,
      text: input.text,
      marker: input.marker,
    };
  }
  return {
    kind: "reply",
    postUrn: input.postUrn,
    parentCommentUrn: input.commentId,
    replyToUrn: input.replyToUrn,
    ...(input.rootIsRoomReply ? { rootIsRoomReply: input.rootIsRoomReply } : {}),
    text: input.text,
    marker: input.marker,
  };
}

function assertBoundOperationId(operationId: string, input: PostInput): void {
  if (!operationId.trim()) throw new Error("operationId must not be empty");
  if (operationId !== input.marker) {
    throw new Error("operationId must equal the durable PostInput.marker");
  }
}

/** What stops a write on the page, in the browser or on the way to it —
 *  a reply's thread that would not load, or that its action target has left, a post
 *  LinkedIn's data names as another, or one closed to comments, among them —
 *  and the account probe that could not answer, which runs before anything is
 *  sent and may answer on the next try. Deliberately not every
 *  code: WRITE_OUTCOME_UNCERTAIN is the journal reporting an EARLIER click,
 *  CONNECTED_ACCOUNT_CHANGED and the conflict codes guard the journal's
 *  integrity, and a checkpoint keeps its own pause — those still throw, so
 *  their write stays held for review. The sidecar's PAGE_FAILURE_CODES
 *  (`service.py`) is this same list, held equal by
 *  `prepareRefusalCodes.test.ts`. */
export const PREPARE_REFUSAL_CODES = new Set([
  "ACCOUNT_IDENTITY_UNAVAILABLE",
  "DOM_CHANGED",
  "NAVIGATION_FAILED",
  "NAVIGATION_BLOCKED",
  "BROWSER_TRANSIENT",
  "BROWSER_UNAVAILABLE",
  "PREPARED_UI_STALE",
  "UI_DRIFT",
  "THREAD_INCOMPLETE",
  "THREAD_UNAVAILABLE",
  "REPLY_TARGET_UNAVAILABLE",
  "ROOM_TARGET_MOVED",
  "ROOM_AUTHOR_CHANGED",
  "ROOM_ALREADY_OURS",
  "ROOM_IDENTITY_UNRESOLVED",
  "THREAD_MISMATCH",
  "COMMENTS_CLOSED",
]);

/** LinkedIn's stated refusal of a comment's, a reply's or a room reply's one
 *  POST: it created nothing, and the sidecar's journal never sends the
 *  operation again — so a later dispatch answers with it too, which settles
 *  that send and never means it was not attempted. */
const WRITE_REFUSAL_CODES = new Set(["WRITE_REFUSED", "ROOM_REPLY_REFUSED"]);

/**
 * Whether a write that raised was refused before the journal held the attempt
 * as CLICKING — the page or the account probe, or LinkedIn's durable refusal
 * of an earlier POST — so nothing was pressed. From CLICKING on the sidecar
 * answers every failure as an `uncertain` state, never as an error, so these
 * codes are the only errors that say so. A dropped bridge is not one: it may
 * follow the press.
 */
function refusedBeforeWrite(error: unknown): error is BrowserUseRemoteError {
  return (
    error instanceof BrowserUseRemoteError &&
    (PREPARE_REFUSAL_CODES.has(error.code) || WRITE_REFUSAL_CODES.has(error.code))
  );
}

/**
 * What a like op raises before its POST, by code: a navigation that never
 * landed, a session that was signed out or parked at a checkpoint when the op
 * began, or an action target the post's data shows the account already reacted to some
 * other way (ALREADY_REACTED). Nothing was sent. A code alone can say no
 * more: BROWSER_TRANSIENT also comes out of the POST's own page evaluation,
 * which says nothing about whether the like landed, and LIKE_UNCONFIRMED is a
 * like whose re-read never showed it. So the sidecar also marks what it raised
 * before the POST, and LinkedIn's stated refusal of it (`notAttempted`: a
 * target no data shows, a post that takes no reactions, LIKE_REFUSED), which
 * is the same fact stated by the one that knows it.
 */
const LIKE_REFUSAL_CODES = new Set(["NAVIGATION_BLOCKED", "NAVIGATION_FAILED", "ALREADY_REACTED"]);

/** A like opens the post, sends its one POST and, where the answer settles
 *  nothing, opens the post again for its receipt (`backend.py` `_like_receipt`):
 *  page loads beside the POST's own wait, past the default request timeout on a
 *  slow page — but inside the account's lease (`EXECUTION_LEASE_MS`), which a
 *  write must answer within. */
export const LIKE_TIMEOUT_MS = 90_000;

/** A comment's, a reply's or a room reply's write reconciles an earlier
 *  attempt — a comment's post opened, its comments waited for — and reads the
 *  post's data from the page it keeps, then makes the POST and, where LinkedIn's
 *  answer settles nothing, reads its data back (`backend.py` `prepare_comment`,
 *  `commit_prepared_comment`): past the default request timeout at its worst,
 *  and a timeout tears the sidecar down with the attempt CLICKING. Inside the
 *  account's lease (`EXECUTION_LEASE_MS`), which a write must answer within. */
export const WRITE_TIMEOUT_MS = 110_000;

/** An Accept, an invitation, a withdrawal or a DM reads what it will press,
 *  presses — an invitation POSTs — once and then reads the member's profile up
 *  to `PROFILE_RECEIPT_READS` times, a pause between each (`backend.py`
 *  `_reread_relationship`), an Accept's invitations page after them. Past
 *  the default request timeout, and a timeout tears the sidecar down and
 *  leaves the attempt CLICKING — `send_unanswered`. The sidecar stops
 *  starting reads well inside this (`PROFILE_RECEIPT_BUDGET_S`), which is
 *  itself inside the account's lease (`EXECUTION_LEASE_MS`). */
export const MEMBER_WRITE_TIMEOUT_MS = 110_000;

/** The own comments are read across up to `OWN_COMMENT_PAGES` pages of the
 *  activity list (`own_comments.py`): the document, then those LinkedIn's pager
 *  loads as the list is scrolled or the declared request fetches, after the
 *  page's own open and, where the sidecar does not yet know the account, a
 *  profile fetch — 30s apiece. The pages share one deadline in the sidecar
 *  (`OWN_COMMENTS_PAGING_BUDGET_S` in `backend.py`) past which it returns what
 *  it has, so the transport outlasts it by the time to parse the last page. A
 *  job reads them; no account lease is held while it does. */
export const OWN_COMMENT_PAGES = 5;
const OWN_COMMENTS_OPEN_MS = 30_000;
const OWN_COMMENTS_PROFILE_FETCH_MS = 30_000;
const OWN_COMMENTS_PAGING_MS = 100_000;
const OWN_COMMENTS_PARSE_MARGIN_MS = 20_000;
export const OWN_COMMENTS_TIMEOUT_MS =
  OWN_COMMENTS_OPEN_MS + OWN_COMMENTS_PROFILE_FETCH_MS + OWN_COMMENTS_PAGING_MS + OWN_COMMENTS_PARSE_MARGIN_MS;

/** A like that failed, `notAttempted` only when the sidecar refused it before
 *  the click — the one answer that proves it did not go out. */
function likeRefusal(error: unknown): PostResult {
  const beforeClick =
    error instanceof BrowserUseRemoteError &&
    (error.notAttempted || LIKE_REFUSAL_CODES.has(error.code) || error.checkpoint || error.signIn);
  return {
    ok: false,
    ...(beforeClick ? { notAttempted: true } : {}),
    ...(error instanceof BrowserUseRemoteError && error.code === "ALREADY_REACTED" ? { code: error.code } : {}),
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * What an invitation's journal entry is bound to: the member and the note,
 * fingerprinted as the sidecar fingerprints them — SHA-256 of the canonical
 * JSON, keys sorted, no whitespace (`protocol.py` `input_fingerprint`).
 */
export function invitationFingerprint(input: Pick<InvitationAttempt, "profileId" | "note">): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind: "invitation", note: input.note, profileId: input.profileId }), "utf8")
    .digest("hex");
}

function invitationContent(input: InvitationAttempt) {
  return {
    operationId: input.operationId,
    profileId: input.profileId,
    note: input.note,
    fingerprint: invitationFingerprint(input),
  };
}

/** A read that shows our invitation to this member pending — or them already
 *  connected, an acceptance faster than the read. With `withdrawn`, their
 *  switch on Withdrawn too: it went out, and someone withdrew it since. */
function showsInvitation(
  read: RelationshipRead | null,
  profileId: string,
  opts: { withdrawn?: boolean } = {},
): read is RelationshipRead {
  return (
    read !== null &&
    read.profile.verified &&
    read.profile.id === profileId &&
    (read.pending === "outgoing" || read.degree === "1st" || (opts.withdrawn === true && read.invitation === "withdrawn"))
  );
}

/** A sub-step's answer as the driver reports it. A confirmation counts where
 *  LinkedIn's answer named the invitation it created, or where its read shows
 *  the invitation; anything else claiming one is a send nobody can vouch for.
 *  A read beside a receipt is kept only where it shows the invitation. */
function invitationAnswer(result: BrowserUseInvitation, profileId: string): SendInvitationResult {
  switch (result.state) {
    case "confirmed": {
      const shown = showsInvitation(result.relationship, profileId) ? result.relationship : null;
      if (result.receipt === undefined && shown === null) {
        return { status: "uncertain", reason: "confirmed_without_pending_read" };
      }
      return {
        status: "confirmed",
        relationship: shown,
        receipt: result.receipt ?? null,
        noteLimit: result.noteLimit ?? 0,
      };
    }
    case "refused":
      // A degree that moved since the read that admitted it is that read gone
      // stale, not a reason against the person: nothing was pressed, and a
      // later attempt reads them afresh.
      if (result.reason === "relationship_moved") return { status: "not_sent", reason: result.reason };
      return {
        status: "blocked",
        reason: result.reason,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.noteLimit !== undefined ? { noteLimit: result.noteLimit } : {}),
      };
    case "blocked":
      return { status: "blocked", reason: result.reason, detail: result.detail };
    case "uncertain":
      return {
        status: "uncertain",
        reason: result.error,
        ...(result.relationship ? { relationship: result.relationship } : {}),
      };
    case "resolved_not_sent":
      return { status: "uncertain", reason: `unexpected_${result.state}` };
  }
}

/**
 * What a withdrawal's journal entry is bound to: the member, fingerprinted as
 * the sidecar fingerprints it — SHA-256 of the canonical JSON, keys sorted,
 * no whitespace (`protocol.py` `input_fingerprint`).
 */
export function withdrawalFingerprint(input: Pick<WithdrawalAttempt, "profileId">): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind: "withdrawal", profileId: input.profileId }), "utf8")
    .digest("hex");
}

function withdrawalContent(input: WithdrawalAttempt) {
  return {
    operationId: input.operationId,
    profileId: input.profileId,
    fingerprint: withdrawalFingerprint(input),
  };
}

/** A read of this member whose data shows our invitation gone: their switch
 *  on Withdrawn, or back on Connect, nothing pending. */
function showsWithdrawn(read: RelationshipRead | null, profileId: string): read is RelationshipRead {
  return (
    read !== null &&
    read.profile.verified &&
    read.profile.id === profileId &&
    (read.degree === "2nd" || read.degree === "3rd+") &&
    read.pending === "none" &&
    (read.invitation === "withdrawn" || read.invitation === "connect")
  );
}

/** A read of this member whose data still shows their switch on Pending. */
function showsPending(read: RelationshipRead | null, profileId: string): read is RelationshipRead {
  return (
    read !== null &&
    read.profile.verified &&
    read.profile.id === profileId &&
    read.pending === "outgoing" &&
    read.invitation === "pending"
  );
}

/** A sub-step's answer as the driver reports it. A confirmation counts only
 *  where its read shows nothing pending; anything else claiming one is a
 *  withdrawal nobody can vouch for. Every refusal came before any press, of a
 *  member with nothing of ours to withdraw as the page showed them. */
function withdrawalAnswer(result: BrowserUseWithdrawal, profileId: string): WithdrawInvitationResult {
  switch (result.state) {
    case "confirmed":
      return showsWithdrawn(result.relationship, profileId)
        ? { status: "confirmed", relationship: result.relationship }
        : { status: "uncertain", reason: "confirmed_without_withdrawn_read" };
    case "refused":
      return { status: "blocked", reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
    case "blocked":
      return {
        status: "blocked",
        reason: result.reason,
        detail: result.detail,
        ...(result.relationship ? { relationship: result.relationship } : {}),
      };
    case "uncertain":
      return {
        status: "uncertain",
        reason: result.error,
        ...(result.relationship ? { relationship: result.relationship } : {}),
      };
    case "still_pending":
    case "resolved_not_sent":
      return { status: "uncertain", reason: `unexpected_${result.state}` };
  }
}

/**
 * What an acceptance's journal entry is bound to: the invitation and its
 * sender, fingerprinted as the sidecar fingerprints them — SHA-256 of the
 * canonical JSON, keys sorted, no whitespace (`protocol.py`
 * `input_fingerprint`).
 */
export function acceptanceFingerprint(
  input: Pick<AcceptInvitationInput, "invitationId" | "senderProfileId">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        invitationId: input.invitationId,
        kind: "accept_invitation",
        senderProfileId: input.senderProfileId,
      }),
      "utf8",
    )
    .digest("hex");
}

function acceptanceContent(input: AcceptInvitationInput) {
  return {
    operationId: input.operationId,
    invitationId: input.invitationId,
    senderProfileId: input.senderProfileId,
    fingerprint: acceptanceFingerprint(input),
  };
}

/** The most page loads one resolve of an acceptance makes: the sender's
 *  profile, then the invitations page's data. */
const ACCEPTANCE_RESOLVE_READS = 2;

/** A read of this sender showing them connected. */
function showsConnected(read: RelationshipRead | null, profileId: string): read is RelationshipRead {
  return read !== null && read.profile.verified && read.profile.id === profileId && read.degree === "1st";
}

/** A sub-step's answer as the driver reports it. A confirmation counts only
 *  where its read shows the sender connected; anything else claiming one is
 *  an acceptance nobody can vouch for. A send's `resolved_not_sent` is a
 *  page script that refused before its press. */
function acceptanceAnswer(result: BrowserUseAcceptance, senderProfileId: string): AcceptInvitationResult {
  switch (result.state) {
    case "confirmed":
      return showsConnected(result.relationship, senderProfileId)
        ? { status: "confirmed", relationship: result.relationship }
        : { status: "uncertain", reason: "confirmed_without_connected_read" };
    case "refused":
      return { status: "not_sent", reason: result.reason };
    case "resolved_not_sent":
      return { status: "not_sent", reason: "accept_not_pressed" };
    case "blocked":
      return {
        status: "blocked",
        reason: result.reason,
        detail: result.detail,
        ...(result.relationship ? { relationship: result.relationship } : {}),
      };
    case "uncertain":
      return {
        status: "uncertain",
        reason: result.error,
        ...(result.relationship ? { relationship: result.relationship } : {}),
      };
    case "still_pending":
    case "read_needed":
      return { status: "uncertain", reason: `unexpected_${result.state}` };
  }
}

/** What a failed `send` of an acceptance means: an invitation's reading
 *  (`journaledWriteFailure`), except that nothing before the press speaks
 *  against the request itself — a page that drifted or would not load
 *  pressed nothing, and blocks no acceptance. */
function acceptanceFailure(error: unknown): AcceptInvitationResult {
  const failure = journaledWriteFailure(error);
  return failure.status === "blocked" ? { status: "not_sent", reason: failure.reason } : failure;
}

/** The page faults that leave a member unreadable as they stand: no retry
 *  reads them differently, so the invitation is blocked rather than tried
 *  again — unless the sidecar says the next read may answer (a profile whose
 *  document was not kept). */
const INVITATION_BLOCKING_CODES = new Set(["UI_DRIFT", "PROFILE_UNAVAILABLE"]);

/** The codes a `send` or a `write` raises that may follow its press. From
 *  CLICKING on the sidecar answers every failure as an `uncertain` state, so
 *  what is left is the journal failing around the press — an
 *  INTERNAL_ERROR above all — and an earlier click the journal still holds
 *  unresolved. Every other raised code came before the attempt was journaled,
 *  and nothing was pressed. */
const RAISED_AFTER_PRESS = new Set(["WRITE_OUTCOME_UNCERTAIN", "INTERNAL_ERROR", "WRITE_FAILED_AFTER_CLICK_START"]);

/** What a failed sub-step of a journaled member write comes to. */
type JournaledWriteFailure =
  | { status: "not_sent"; reason: string }
  | { status: "blocked"; reason: string; detail: string }
  | { status: "uncertain"; reason: string };

/**
 * What a failed `send` of an invitation or a withdrawal means. The sidecar
 * journals the attempt as CLICKING only after everything that reads and
 * checks, so a failure it raised wrote nothing — except one that can follow
 * the press (`RAISED_AFTER_PRESS`), and a send whose answer never arrived,
 * which may follow a press that landed. Both are uncertain — never
 * `not_sent`, which would re-arm a second press. An earlier attempt the
 * journal still holds unresolved is uncertain too.
 */
function journaledWriteFailure(error: unknown): JournaledWriteFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BrowserUseRemoteError) {
    if (RAISED_AFTER_PRESS.has(error.code)) return { status: "uncertain", reason: `${error.code.toLowerCase()}: ${message}` };
    return INVITATION_BLOCKING_CODES.has(error.code) && !error.retryable
      ? { status: "blocked", reason: error.code.toLowerCase(), detail: message }
      : { status: "not_sent", reason: error.code.toLowerCase() };
  }
  return { status: "uncertain", reason: `send_unanswered: ${message}` };
}

/**
 * What a DM's journal entry is bound to: the conversation, the recipient and
 * the words, fingerprinted as the sidecar fingerprints them — SHA-256 of the
 * canonical JSON, keys sorted, no whitespace (`protocol.py`
 * `input_fingerprint`).
 */
export function dmFingerprint(
  input: Pick<DmAttempt, "threadId" | "recipientProfileId" | "text">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "dm",
        recipientProfileId: input.recipientProfileId,
        text: input.text,
        threadId: input.threadId,
      }),
      "utf8",
    )
    .digest("hex");
}

function dmContent(input: DmAttempt) {
  return {
    operationId: input.operationId,
    threadId: input.threadId,
    recipientProfileId: input.recipientProfileId,
    text: input.text,
    fingerprint: dmFingerprint(input),
  };
}

/**
 * What a first message's journal entry is bound to: the member and the words,
 * fingerprinted as the sidecar fingerprints them (`dmFingerprint`).
 */
export function openDmFingerprint(input: Pick<OpenDmInput, "recipientProfileId" | "text">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ kind: "open_dm", recipientProfileId: input.recipientProfileId, text: input.text }),
      "utf8",
    )
    .digest("hex");
}

function openDmContent(input: OpenDmInput) {
  return {
    operationId: input.operationId,
    recipientProfileId: input.recipientProfileId,
    text: input.text,
    fingerprint: openDmFingerprint(input),
  };
}

/** A first message's sub-step answer as the driver reports it, on
 *  `dmAnswer`'s terms. */
function openDmAnswer(result: BrowserUseOpenDm, input: OpenDmInput): OpenDmResult {
  switch (result.state) {
    case "confirmed":
      return showsDm(result.receipt, input.text)
        ? { status: "confirmed", receipt: result.receipt, conversation: result.conversation }
        : { status: "uncertain", reason: "confirmed_without_the_words" };
    case "refused":
      return { status: "blocked", reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
    case "blocked":
      return { status: "blocked", reason: result.reason, detail: result.detail };
    case "uncertain":
      return { status: "uncertain", reason: result.error };
    case "resolved_not_sent":
      return { status: "uncertain", reason: `unexpected_${result.state}` };
  }
}

/** A receipt whose message carries these words. */
function showsDm(receipt: DmReceipt, text: string): boolean {
  return receipt.textHash === dmWordsHash(text);
}

/** A sub-step's answer as the driver reports it. A confirmation counts only
 *  where its receipt carries these words; anything else claiming one is a
 *  send nobody can vouch for. */
function dmAnswer(result: BrowserUseDm, input: DmAttempt): SendDmResult {
  switch (result.state) {
    case "confirmed":
      return showsDm(result.receipt, input.text)
        ? { status: "confirmed", receipt: result.receipt }
        : { status: "uncertain", reason: "confirmed_without_the_words" };
    case "refused":
      return { status: "blocked", reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
    case "blocked":
      return { status: "blocked", reason: result.reason, detail: result.detail };
    case "uncertain":
      return { status: "uncertain", reason: result.error };
    case "resolved_not_sent":
      return { status: "uncertain", reason: `unexpected_${result.state}` };
  }
}

/** The page faults that leave a conversation unwritable as it stands: no
 *  retry reads it differently, so the DM is blocked rather than tried again. */
const DM_BLOCKING_CODES = new Set(["UI_DRIFT", "THREAD_UNAVAILABLE"]);

/**
 * What a failed `send` of a DM means. The sidecar journals the attempt as
 * CLICKING only after the conversation is read and the page re-validated, so
 * a failure it raised sent nothing — except one that can follow the POST
 * (`RAISED_AFTER_PRESS`), and a send whose answer never arrived, which may
 * follow one. Each keeps the sidecar's own words.
 */
function dmFailure(error: unknown): Exclude<SendDmResult, { status: "confirmed" }> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BrowserUseRemoteError) {
    if (RAISED_AFTER_PRESS.has(error.code)) {
      return { status: "uncertain", reason: `${error.code.toLowerCase()}: ${message}` };
    }
    return DM_BLOCKING_CODES.has(error.code)
      ? { status: "blocked", reason: error.code.toLowerCase(), detail: message }
      : { status: "not_sent", reason: error.code.toLowerCase(), detail: message };
  }
  return { status: "uncertain", reason: `send_unanswered: ${message}` };
}

function assertReceiptOperationId(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new BrowserUseTransportError(
      "Browser Use sidecar returned a receipt for a different operation",
    );
  }
}
