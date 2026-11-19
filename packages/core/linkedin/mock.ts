import { createHash } from "node:crypto";
import type {
  AcceptanceResolution,
  AcceptInvitationInput,
  AcceptInvitationResult,
  AgentPage,
  AgentPageRequest,
  AuthorProfileRead,
  CompanyPageRead,
  CommentActivity,
  CommentRepliesRead,
  ConversationHistory,
  DiscoverParams,
  DiscoverResult,
  DmAttempt,
  DmMessage,
  DmReceipt,
  DmResolution,
  DmResolveInput,
  DmThreadRead,
  DriverIncomingComment,
  DriverPost,
  InboxRead,
  IncomingInvitation,
  IncomingInvitationsRead,
  InvitationReceipt,
  InvitationAttempt,
  InvitationResolution,
  KnownMember,
  LikeStateRead,
  LinkedInDriver,
  NotificationCard,
  NotificationsRead,
  OpenDmInput,
  OpenDmReceipt,
  OpenDmResolution,
  OpenDmResult,
  OwnCommentCounters,
  PostInput,
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
  WithdrawalAttempt,
  WithdrawalResolution,
  WithdrawInvitationResult,
  SessionStatus,
} from "./driver";
import { dmWordsHash } from "./driver";
import type { MentionTarget } from "./mention";
import { ConnectorError } from "./connectorError";

/**
 * Deterministic in-memory driver for building + testing the whole pipeline
 * without touching LinkedIn. Everything downstream is proven against this.
 *
 * A TEST FIXTURE, and only that. It was also the system's answer to "no account
 * is connected" — an `unavailable` mode that failed every operation, handed out
 * by the env-selecting resolver — which made a decrypt fault indistinguishable
 * from "you haven't connected yet" and put a connector's identity where a
 * capability answer belongs. Not-connected is `resolveChannelConnector`'s typed
 * refusal now, and a fixture is never a production answer.
 *
 * Failure simulation supports the exactly-once tests: `failNextPostMode` can
 * make postComment throw AFTER it "posted" (the timeout-after-success race).
 */
export type MockFailMode =
  | "none"
  | "timeout_after_success" // post lands, then the call throws (retry must NOT double-post)
  | "rate_limited"
  | "retryable"
  // the sidecar's refusal before the click: no single Like control was found
  | "refused_before_press";

export class MockDriver implements LinkedInDriver {
  readonly name = "mock";
  readonly capabilities: {
    incoming: boolean;
    ownContent: boolean;
  };

  private seq = 0;
  // Records every successful post so the exactly-once test can assert no dup.
  // A reply's `target` is the comment it is posted under; `replyTo` the one it
  // answers.
  readonly posted: {
    kind: "comment" | "reply";
    target: string;
    text: string;
    urn: string;
    mention?: MentionTarget;
    replyTo?: string;
  }[] = [];
  failNextPost: MockFailMode = "none";
  /** The same simulation for the next `likeComment`: a
   *  `timeout_after_success` like lands, then the call throws. */
  failNextLike: MockFailMode = "none";

  private posts: DriverPost[];
  private incoming: DriverIncomingComment[];
  private pages: number;
  private expiredTerms: Set<string>;
  private rateLimitTerms: Set<string>;
  private samePostsEveryPage: boolean;
  private threads: Map<string, PostThread>;
  private authors: Map<string, AuthorProfileRead>;
  private companies: Map<string, CompanyPageRead>;
  /** Every verify read, in order, so a test can assert what was spent. */
  readonly threadReads: string[] = [];
  readonly profileReads: string[] = [];
  readonly companyReads: string[] = [];
  /** Every discoverPosts call, so tests can assert per-term separation + pagination. */
  readonly discoverCalls: {
    term: string;
    cursor: string | null;
    kind: "search" | "author";
    sort?: DiscoverParams["sort"];
    datePosted?: DiscoverParams["datePosted"];
  }[] = [];

  constructor(opts?: {
    posts?: DriverPost[];
    incoming?: DriverIncomingComment[];
    /** Pages available per term (default 1). Page 0 = injected `posts`; later pages
     *  return fresh synthetic posts so pagination ingests genuinely-new URNs. */
    pages?: number;
    /** Terms that return cursorState:'expired' when a cursor is sent (reset, not dry). */
    expiredTerms?: string[];
    /** Terms whose discoverPosts throws a rate-limited ConnectorError. */
    rateLimitTerms?: string[];
    /** Return the SAME `posts` on every page (so later pages dedupe to 0-new —
     *  drives the dup-page-streak → parking path). */
    samePostsEveryPage?: boolean;
    /** Canned verify reads by post urn / profile id. A post without one reads
     *  as its discovered text with an empty thread; an author without one as
     *  a plain member with no recent posts. */
    threads?: PostThread[];
    authors?: AuthorProfileRead[];
    /** Canned company pages by their ref; one without reads as a page that
     *  says only its name. */
    companies?: CompanyPageRead[];
    /** Override reported capabilities, for a suite standing in for a connector
     *  that cannot do one of the three kinds a driver still states for itself.
     *  `ownContent` defaults FALSE — a mock is "no real account", so voice
     *  import stays a no-op unless a test opts in. */
    capabilities?: Partial<{
      incoming: boolean;
      ownContent: boolean;
    }>;
  }) {
    this.posts = opts?.posts ?? defaultPosts();
    this.incoming = opts?.incoming ?? defaultIncoming();
    this.pages = Math.max(1, opts?.pages ?? 1);
    this.expiredTerms = new Set(opts?.expiredTerms ?? []);
    this.rateLimitTerms = new Set(opts?.rateLimitTerms ?? []);
    this.samePostsEveryPage = opts?.samePostsEveryPage ?? false;
    this.threads = new Map(
      (opts?.threads ?? []).map((thread) => [thread.postUrn, thread]),
    );
    this.authors = new Map(
      (opts?.authors ?? []).map((author) => [author.profileId, author]),
    );
    this.companies = new Map(
      (opts?.companies ?? []).map((company) => [company.companyRef, company]),
    );
    this.capabilities = {
      incoming: true,
      ownContent: false,
      ...opts?.capabilities,
    };
  }

  /** Every ensureSession call, so a test can assert a refused grant reached no
   *  connector at all — not merely that the result omitted the session block. */
  ensureSessionCalls = 0;

  async ensureSession(): Promise<SessionStatus> {
    this.ensureSessionCalls += 1;
    return {
      ok: true,
      account: {
        externalAccountId: "mock-account",
        displayName: "Mock Owner",
      },
    };
  }

  async discoverPosts(params: DiscoverParams): Promise<DiscoverResult> {
    const term = (params.term ?? "").trim();
    this.discoverCalls.push({
      term,
      cursor: params.cursor ?? null,
      kind: params.kind ?? "search",
      // Recorded only when sent, so a call that names neither reads as before.
      ...(params.sort ? { sort: params.sort } : {}),
      ...(params.datePosted ? { datePosted: params.datePosted } : {}),
    });
    if (this.rateLimitTerms.has(term)) {
      throw new ConnectorError(`rate limited (mock): ${term}`, {
        rateLimited: true,
        status: 429,
      });
    }
    const page = params.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
    if (this.expiredTerms.has(term) && params.cursor) {
      return { posts: [], nextCursor: null, cursorState: "expired" };
    }
    if (page >= this.pages)
      return { posts: [], nextCursor: null, cursorState: "active" };
    const limit = params.limit ?? this.posts.length;
    const posts: DriverPost[] =
      this.samePostsEveryPage || page === 0
        ? this.posts.slice(0, limit)
        : Array.from({ length: Math.min(limit, 2) }, (_, i) => ({
            postUrn: `urn:li:activity:mock-${mockSlug(term)}-${page}-${i}`,
            authorProfileId: `urn:li:person:mock-${mockSlug(term)}-${i}`,
            authorName: `Author ${mockSlug(term)} ${page}.${i}`,
            contentText: `Synthetic post for "${term}" page ${page} #${i}`,
            postedAt: Date.now() - page * 60_000,
            detectedLanguage: "en",
            authorGeo: "US",
          }));
    const nextCursor = page + 1 < this.pages ? String(page + 1) : null;
    return { posts, nextCursor, cursorState: "active" };
  }

  /** Every fetchOwnPosts call — the own-content twin of `ensureSessionCalls`. */
  ownPostsCalls = 0;

  async fetchOwnPosts(limit = 15): Promise<DriverPost[]> {
    this.ownPostsCalls += 1;
    const own: DriverPost[] = [
      {
        postUrn: "urn:li:activity:mock-own-1",
        authorName: "You",
        contentText:
          "Shipped a thing this week. Small team, no fanfare — just fixed the one workflow that annoyed every user. Boring beats clever.",
      },
      {
        postUrn: "urn:li:activity:mock-own-2",
        authorName: "You",
        contentText:
          "Hot take: most 'AI features' are a search box with extra steps. Solve the actual job, then maybe add the model.",
      },
    ];
    return own.slice(0, limit);
  }

  /** Canned own-comments (the user's replies on their own posts) — settable so
   *  voice-import tests can exercise the sparse-history fallback with []. */
  ownComments: { text: string; postUrn: string }[] = [
    {
      text: "ha, exactly — we hit the same wall with retries. what fixed it for us was just logging every attempt id",
      postUrn: "urn:li:activity:mock-own-1",
    },
    {
      text: "fair pushback. i'd still take the boring version, the clever one paged me at 3am twice",
      postUrn: "urn:li:activity:mock-own-1",
    },
    {
      text: "yes! search box with extra steps is exactly it",
      postUrn: "urn:li:activity:mock-own-2",
    },
  ];

  async fetchOwnComments(
    limit = 50,
  ): Promise<{ text: string; postUrn: string }[]> {
    return this.ownComments.slice(0, limit);
  }

  /** Deterministic author-impact personas: identifiers containing "influencer"
   *  read as a 52k-follower author; everyone else is a 300-follower author. */
  async fetchProfile(identifier: string): Promise<{
    name?: string;
    headline?: string;
    country?: string;
    followers?: number;
    connections?: number;
    isInfluencer?: boolean;
  }> {
    const big = identifier.includes("influencer");
    return {
      name: big ? "Ivy Influencer" : "Enid Engineer",
      headline: big ? "Founder & builder-in-public" : "Engineer",
      country: "US",
      followers: big ? 52_000 : 300,
      connections: big ? 12_000 : 250,
      isInfluencer: big,
    };
  }

  async readPostThread(
    postUrn: string,
    opts: { maxComments: number; order?: "relevance" | "recent"; start?: number },
  ): Promise<PostThread> {
    this.threadReads.push(postUrn);
    const canned = this.threads.get(postUrn);
    if (canned) {
      const start = opts.start ?? 0;
      return { ...canned, comments: canned.comments.slice(start, start + opts.maxComments) };
    }
    const post = this.posts.find((candidate) => candidate.postUrn === postUrn);
    return {
      postUrn,
      fullText: post?.contentText ?? "",
      ...(post?.postedAt != null ? { postedAt: post.postedAt } : {}),
      counts: { reactions: 0, comments: 0, reposts: 0 },
      comments: [],
    };
  }

  async readAuthorProfile(profileId: string): Promise<AuthorProfileRead> {
    this.profileReads.push(profileId);
    return (
      this.authors.get(profileId) ?? {
        profileId,
        name: "Enid Engineer",
        headline: "Engineer",
        recentPosts: [],
        isCompanyPage: false,
      }
    );
  }

  async readCompanyPage(companyRef: string): Promise<CompanyPageRead> {
    this.companyReads.push(companyRef);
    return this.companies.get(companyRef) ?? { companyRef, name: "Acme" };
  }

  private recordPost(
    kind: "comment" | "reply",
    target: string,
    text: string,
    mention?: MentionTarget,
    replyTo?: string,
  ): PostResult {
    const mode = this.failNextPost;
    this.failNextPost = "none";
    if (mode === "rate_limited") {
      return { ok: false, rateLimited: true, error: "429 (mock)" };
    }
    if (mode === "retryable") {
      return { ok: false, retryable: true, error: "transient (mock)" };
    }
    // Both success and timeout_after_success actually record the post.
    const urn = `urn:li:${kind}:mock-${++this.seq}`;
    this.posted.push({
      kind,
      target,
      text,
      urn,
      mention,
      ...(replyTo ? { replyTo } : {}),
    });
    if (mode === "timeout_after_success") {
      throw new Error("response timeout after post (mock)");
    }
    return { ok: true, externalUrn: urn };
  }

  async postComment(postUrn: string, text: string): Promise<PostResult> {
    return this.recordPost("comment", postUrn, text);
  }

  /** The receipt-bearing write every send goes through: a comment or a reply
   *  is recorded as `postComment` / `postReply` record it, and a room reply
   *  needs a verified thread the fixture does not have. */
  async postWithReceipt(input: PostInput): Promise<PostResult> {
    if (input.kind === "comment") {
      return this.postComment(input.postUrn, input.text);
    }
    if (input.kind === "reply" && !input.rootIsRoomReply) {
      return this.postReply(
        {
          postUrn: input.postUrn,
          commentId: input.commentId,
          replyToUrn: input.replyToUrn,
          mention: input.mention,
        },
        input.text,
      );
    }
    return {
      ok: false,
      notAttempted: true,
      code: "UNSUPPORTED_WRITE",
      error: "Room conversations require a verified thread and durable receipt.",
    };
  }

  async postReply(target: ReplyTarget, text: string): Promise<PostResult> {
    return this.recordPost(
      "reply",
      target.commentId,
      text,
      target.mention,
      target.replyToUrn,
    );
  }

  async likePost(postUrn: string): Promise<PostResult> {
    if (this.alreadyLiked.has(postUrn)) return { ok: true, reaction: "already_liked" };
    this.likedPosts.push(postUrn);
    this.alreadyLiked.add(postUrn);
    return { ok: true, externalUrn: `urn:li:like:mock-${++this.seq}`, reaction: "liked" };
  }

  /** Post urns liked via likePost — assert on in tests. */
  readonly likedPosts: string[] = [];
  /** (postUrn, commentUrn) pairs liked via likeComment — assert on in tests —
   *  with the comment a reply answers where the like named it. */
  readonly likedComments: { postUrn: string; commentUrn: string; parentCommentUrn?: string }[] = [];
  /** Post and comment urns whose Like control already reads pressed. A like
   *  of one clicks nothing and answers `already_liked`, as the sidecar does —
   *  never a toggle off; a like this fixture places joins them. Seed one to
   *  stand for a like the account placed before. */
  readonly alreadyLiked = new Set<string>();

  async likeComment(postUrn: string, commentUrn: string, parentCommentUrn?: string): Promise<PostResult> {
    const mode = this.failNextLike;
    this.failNextLike = "none";
    if (mode === "rate_limited") return { ok: false, rateLimited: true, error: "429 (mock)" };
    if (mode === "retryable") return { ok: false, retryable: true, error: "transient (mock)" };
    if (mode === "refused_before_press") {
      return { ok: false, notAttempted: true, error: "could not identify exactly one Like control on the action target comment" };
    }
    if (this.alreadyLiked.has(commentUrn)) return { ok: true, reaction: "already_liked" };
    this.likedComments.push({ postUrn, commentUrn, ...(parentCommentUrn ? { parentCommentUrn } : {}) });
    this.alreadyLiked.add(commentUrn);
    if (mode === "timeout_after_success") throw new Error("response timeout after like (mock)");
    return { ok: true, externalUrn: `urn:li:like:mock-${++this.seq}`, reaction: "liked" };
  }

  /** Post and comment urns whose data declares a reaction other than the
   *  Like this fixture places — or null, a data that cannot tell. Unseeded,
   *  an action target reads `Like` once liked and `Default` before. */
  readonly reactions = new Map<string, string | null>();
  /** The account the browser reads the post's data as: the session's own,
   *  unless a test signs another in — or undefined, a read that names none. */
  signedInAs: string | undefined = "mock-account";

  /** The (post, comment, comment it answers) of every read of a like's state —
   *  assert on in tests. */
  readonly likeStateReads: { postUrn: string; commentUrn?: string; parentCommentUrn?: string }[] = [];

  async readLikeState(postUrn: string, commentUrn?: string, parentCommentUrn?: string): Promise<LikeStateRead> {
    this.likeStateReads.push({
      postUrn,
      ...(commentUrn ? { commentUrn } : {}),
      ...(parentCommentUrn ? { parentCommentUrn } : {}),
    });
    const target = commentUrn ?? postUrn;
    const reaction = this.reactions.has(target)
      ? this.reactions.get(target)!
      : this.alreadyLiked.has(target)
        ? "Like"
        : "Default";
    return {
      reaction,
      observedAt: Date.now(),
      ...(this.signedInAs === undefined ? {} : { accountId: this.signedInAs }),
    };
  }

  /** Every owner's word the journal was told of — assert on in tests. */
  readonly memberWrites: { operationId: string; outcome: "went_out" | "not_sent" }[] = [];

  async settleMemberWrite(operationId: string, outcome: "went_out" | "not_sent") {
    this.memberWrites.push({ operationId, outcome });
    return { state: "recorded" as const };
  }

  async reconcilePosted(input: PostInput): Promise<string | null> {
    if (input.kind === "room_reply") throw new Error("Use MockRoomReplyDriver to exercise room receipts.");
    const key = input.kind === "comment" ? input.postUrn : input.commentId;
    const hit = this.posted.find((p) => p.target === key);
    return hit ? hit.urn : null;
  }

  async fetchIncomingComments(
    sinceTs: number,
  ): Promise<DriverIncomingComment[]> {
    return this.incoming.filter((c) => (c.receivedAt ?? 0) >= sinceTs);
  }

  // ---- Engagement-monitor fixtures ----------------------------------------
  /** Set per (commentUrn) what the next fetchCommentActivity returns. */
  readonly commentActivity = new Map<string, CommentActivity>();
  /** Counter-sweep fixture; empty = sweep unavailable behavior is NOT simulated
   *  (the method still exists), it just reports no rows. */
  ownCommentCounters: OwnCommentCounters[] = [];
  /** Every activity check, so tests can assert the monitor's call pattern. */
  readonly activityCalls: { postUrn: string; commentUrn: string }[] = [];

  async fetchCommentActivity(
    postUrn: string,
    commentUrn: string,
  ): Promise<CommentActivity> {
    this.activityCalls.push({ postUrn, commentUrn });
    return (
      this.commentActivity.get(commentUrn) ?? {
        replies: [],
        reactions: [],
        replyCount: 0,
        reactionCount: 0,
      }
    );
  }

  async fetchOwnCommentCounters(_limit = 100): Promise<OwnCommentCounters[]> {
    return this.ownCommentCounters;
  }

  // ---- Reply-thread fixtures -----------------------------------------------
  /** What the next read of a watched comment's thread returns, by comment urn
   *  — a thrown error included, for the failures a read can end in. A comment
   *  without one reads as ours, present, with no replies. */
  readonly commentReplies = new Map<string, CommentRepliesRead | Error>();
  /** Every reply-thread read, so a test can assert what was spent. */
  readonly replyReads: {
    postUrn: string;
    commentUrn: string;
    since?: number;
    limit: number;
    vouchedReplyUrns?: string[];
  }[] = [];

  /** Applies `since` and `limit` the way the sidecar does, so a canned thread
   *  answers each ask as a real read would. */
  async readCommentReplies(
    postUrn: string,
    commentUrn: string,
    opts: { since?: number; limit: number; vouchedReplyUrns?: string[] },
  ): Promise<CommentRepliesRead> {
    this.replyReads.push({ postUrn, commentUrn, ...opts });
    const canned = this.commentReplies.get(commentUrn);
    if (canned instanceof Error) throw canned;
    if (!canned) {
      return {
        comment: {
          present: true,
          urn: commentUrn,
          resolvedId: commentUrn,
          authorIsSelf: true,
          textHash: "0".repeat(64),
          replyCount: null,
          replyRows: 0,
        },
        replies: [],
        truncated: false,
        pageFingerprint: "mock",
        selectorPack: "mock",
      };
    }
    const since = opts.since;
    const replies = canned.replies.filter(
      (reply) => since === undefined || reply.postedAt === undefined || reply.postedAt >= since,
    );
    return {
      ...canned,
      replies: replies.slice(-opts.limit),
      truncated: canned.truncated || replies.length > opts.limit,
    };
  }

  // ---- Relationship fixtures -----------------------------------------------
  /** What the next relationship read of a member returns, by profile id — a
   *  thrown error included. A member without one reads as a verified 2nd-degree
   *  stranger offered Connect, with no composer open. */
  readonly relationships = new Map<string, RelationshipRead | Error>();
  /** Every relationship read, so a test can assert what was spent. */
  readonly relationshipReads: RelationshipTarget[] = [];
  /** Where a relationship read asked to look finds the member, by profile id;
   *  a member without one is not looked up. */
  readonly places = new Map<string, NonNullable<RelationshipRead["place"]>>();

  async readRelationship(target: RelationshipTarget): Promise<RelationshipRead> {
    this.relationshipReads.push(target);
    const profileId =
      "profileId" in target
        ? target.profileId
        : (/\/in\/([^/?#]+)/.exec(target.profileUrl)?.[1]?.toLowerCase() ?? target.profileUrl);
    const read = this.memberAsItStands(profileId);
    const place = target.place ? this.places.get(profileId) : undefined;
    return place ? { ...read, place } : read;
  }

  /** The member's page as it stands — what a read would show — without
   *  counting a read: a send and a resolve read inside their own op. */
  private memberAsItStands(profileId: string): RelationshipRead {
    const canned = this.relationships.get(profileId);
    if (canned instanceof Error) throw canned;
    return canned ?? strangerRead(profileId);
  }

  // ---- Incoming invitation fixtures ----------------------------------------
  /** The account's received invitations, newest first — what the next read
   *  returns. An Error makes the read throw. */
  incomingInvitations: IncomingInvitation[] | Error = [];
  /** Whether a read of the list is complete. */
  incomingInvitationsComplete = true;
  /** Every invitations read, so a test can assert what was spent. */
  readonly invitationReads: Array<{ since?: number; limit: number }> = [];

  async readIncomingInvitations(opts: {
    since?: number;
    limit: number;
  }): Promise<IncomingInvitationsRead> {
    this.invitationReads.push(opts);
    if (this.incomingInvitations instanceof Error) throw this.incomingInvitations;
    const since = opts.since;
    const kept = this.incomingInvitations.filter(
      (invitation) =>
        since === undefined || invitation.receivedAt === undefined || invitation.receivedAt >= since,
    );
    return {
      invitations: kept.slice(0, opts.limit),
      others: 0,
      complete: this.incomingInvitationsComplete,
      otherInbox: false,
      truncated: kept.length > opts.limit,
      observedAt: Date.now(),
      sessionId: "mock",
      pageFingerprint: "mock",
      selectorPack: "mock",
    };
  }

  /** What the next acceptance of an invitation answers, by invitation id. By
   *  default a listed request is accepted — it leaves the list and its sender
   *  reads `1st` from then on — and one the list does not show is refused
   *  with nothing pressed. `uncertain` presses and leaves the request and its
   *  sender as they were, for a read to settle. */
  readonly acceptOutcomes = new Map<string, "uncertain" | Error>();
  /** Every acceptance, so a test can assert how many went out. */
  readonly acceptInvitations: AcceptInvitationInput[] = [];
  /** The operation ids whose acceptance reached its press. */
  readonly #acceptPressed = new Set<string>();

  async acceptInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
    this.acceptInvitations.push(input);
    const canned = this.acceptOutcomes.get(input.invitationId);
    if (canned instanceof Error) throw canned;
    const listed = this.#listedInvitation(input);
    if (!listed) return { status: "not_sent", reason: "invitation_not_listed" };
    this.#acceptPressed.add(input.operationId);
    const sender = { profileId: input.senderProfileId };
    if (canned === "uncertain") {
      return { status: "uncertain", reason: "accept_unconfirmed", relationship: await this.readRelationship(sender) };
    }
    this.incomingInvitations = (this.incomingInvitations as IncomingInvitation[]).filter(
      (invitation) => invitation !== listed,
    );
    this.relationships.set(input.senderProfileId, {
      profile: {
        id: input.senderProfileId,
        url: `https://www.linkedin.com/in/${input.senderProfileId}/`,
        displayName: listed.sender.displayName,
        verified: true,
      },
      degree: "1st",
      pending: "none",
      note: { supported: "unknown", limitChars: null },
      observedAt: Date.now(),
      sessionId: "mock",
      pageFingerprint: "mock",
      selectorPack: "mock",
    });
    return { status: "confirmed", relationship: await this.readRelationship(sender) };
  }

  /** A read of the sender and the list against the attempt, each page asked
   *  of `reserveRead` first as the sidecar's is: connected is accepted; the
   *  request still listed is pending, as of the sender's read; gone from a
   *  whole list with Connect on offer is withdrawn. An attempt that never
   *  reached its press needs no page. */
  async resolveAcceptance(input: AcceptInvitationInput, reserveRead: ReserveRead): Promise<AcceptanceResolution> {
    if (!this.#acceptPressed.has(input.operationId)) return { status: "not_sent", relationship: null };
    if (!(await reserveRead())) return { status: "uncertain", relationship: null };
    const read = await this.readRelationship({ profileId: input.senderProfileId });
    if (read.degree === "1st") return { status: "accepted", relationship: read };
    if (!(await reserveRead())) return { status: "uncertain", relationship: read };
    if (this.#listedInvitation(input)) return { status: "pending", relationship: read, observedAt: read.observedAt };
    if (this.incomingInvitationsComplete && read.pending === "none" && (read.degree === "2nd" || read.degree === "3rd+")) {
      return { status: "withdrawn", relationship: read };
    }
    return { status: "uncertain", relationship: read };
  }

  #listedInvitation(input: AcceptInvitationInput): IncomingInvitation | undefined {
    const list = Array.isArray(this.incomingInvitations) ? this.incomingInvitations : [];
    return list.find(
      (invitation) =>
        invitation.invitationId === input.invitationId && invitation.sender.profileId === input.senderProfileId,
    );
  }

  // ---- Notification fixtures -----------------------------------------------
  /** The notification read. ABSENT until a test serves cards
   *  ({@link serveNotifications}): every suite that polls would otherwise
   *  spend a reply check on a page load nobody asked about. */
  readNotifications?: (opts: { start: number }) => Promise<NotificationsRead>;
  /** Every page of cards read, by its start. */
  readonly notificationReads: number[] = [];

  /** Give the mock notification cards: `pages[i]` answers the i-th page — a
   *  thrown error included — each page but the last pointing at the next. */
  serveNotifications(pages: (NotificationCard[] | Error)[]): void {
    this.readNotifications = async ({ start }) => {
      this.notificationReads.push(start);
      const index = start / 10;
      const page = pages[index] ?? [];
      if (page instanceof Error) throw page;
      return {
        cards: page,
        listed: page.length,
        oldestPublishedAt: page.length ? Math.min(...page.map((card) => card.publishedAt)) : null,
        nextStart: index + 1 < pages.length ? start + 10 : null,
        pageFingerprint: "mock",
        selectorPack: "mock",
      };
    };
  }

  // ---- Agent reader fixtures -----------------------------------------------
  /** The agent reader's page load. ABSENT until a test serves pages
   *  ({@link serveAgentPages}): a mock is no real account, and one that read
   *  pages by default would put a model call behind every empty read in
   *  every suite. */
  readPageForAgent?: (request: AgentPageRequest) => Promise<AgentPage>;
  /** Every agent page read, so a test can assert what was spent. */
  readonly agentPageReads: AgentPageRequest[] = [];

  /** Give the mock an agent reader that answers each request with the page —
   *  or the thrown error — `page` returns for it. */
  serveAgentPages(page: (request: AgentPageRequest) => AgentPage | Error): void {
    this.readPageForAgent = async (request) => {
      this.agentPageReads.push(request);
      const served = page(request);
      if (served instanceof Error) throw served;
      return served;
    };
  }

  // ---- Messaging fixtures --------------------------------------------------
  /** What the next inbox read returns — a thrown error included. Empty until
   *  a test lists conversations. */
  inbox: InboxRead | Error = {
    threads: [],
    truncated: false,
    observedAt: 0,
    pageFingerprint: "mock",
    selectorPack: "mock",
  };
  /** What a read of each conversation returns, by thread id — a thrown error
   *  included. A conversation without one is gone. */
  readonly dmThreads = new Map<string, DmThreadRead | Error>();
  /** Every inbox and conversation read, so a test can assert what was spent. */
  readonly inboxReads: { since?: number; limit: number }[] = [];
  readonly dmThreadReads: { threadId: string; since?: number; restoreUnread?: boolean }[] = [];
  /** How a read asked to put back an unread mark reports it. */
  unreadRestore: "restored" | "unread_restore_unconfirmed" = "restored";

  /** Every history read, so a test can assert what was spent — with the
   *  member urns it was told the profiles of, where it was told any. */
  readonly historyReads: { threadId: string; limit: number; members?: KnownMember[] }[] = [];
  /** What a history read throws for a conversation — a renamed query, say —
   *  where it throws; null reads it. */
  historyFailure: (threadId: string) => Error | null = () => null;

  /** Reads each conversation's history off the fake's own conversations
   *  (`dmThreads`): its newest `limit` messages, and no composer. A person
   *  the fake names by `memberUrn` is LinkedIn's data naming them by it
   *  alone, as the sidecar reads it: named by the profile `members` gives
   *  the urn, or the read throws. */
  async readConversationMessages(
    threadId: string,
    opts: { limit: number; members?: readonly KnownMember[] },
  ): Promise<ConversationHistory> {
    this.historyReads.push({
      threadId,
      limit: opts.limit,
      ...(opts.members?.length ? { members: [...opts.members] } : {}),
    });
    const failed = this.historyFailure(threadId);
    if (failed) throw failed;
    const canned = this.dmThreads.get(threadId);
    if (canned instanceof Error) throw canned;
    if (!canned) throw new Error(`no conversation ${threadId}`);
    const { composer: _composer, reader: _reader, markedSeen: _seen, unreadRestore: _restore, ...read } = canned;
    const named = new Map<string, string>();
    for (const participant of read.participants) {
      if (participant.isSelf || participant.memberUrn === undefined || participant.profileId === null) continue;
      const known = opts.members?.find((member) => member.memberUrn === participant.memberUrn)?.profileId;
      if (known === undefined) throw new Error("a participant is known only by member id");
      named.set(participant.profileId, known);
    }
    return {
      ...read,
      participants: read.participants.map((participant) =>
        participant.profileId !== null && named.has(participant.profileId)
          ? { ...participant, profileId: named.get(participant.profileId)! }
          : participant,
      ),
      messages: canned.messages
        .slice(-opts.limit)
        .map((message) =>
          named.has(message.authorProfileId)
            ? { ...message, authorProfileId: named.get(message.authorProfileId)! }
            : message,
        ),
      complete: canned.messages.length <= opts.limit,
    };
  }

  /** Applies `since` and `limit` the way the sidecar does: a card dated
   *  before `since` is dropped, an undated one kept. */
  async readInbox(opts: { since?: number; limit: number }): Promise<InboxRead> {
    this.inboxReads.push(opts);
    if (this.inbox instanceof Error) throw this.inbox;
    const since = opts.since;
    const threads = this.inbox.threads.filter(
      (thread) =>
        since === undefined || thread.lastMessage.at === null || thread.lastMessage.at >= since,
    );
    return {
      ...this.inbox,
      threads: threads.slice(0, opts.limit),
      truncated: this.inbox.truncated || threads.length > opts.limit,
    };
  }

  async readDmThread(
    threadId: string,
    opts: { since?: number; restoreUnread?: boolean },
  ): Promise<DmThreadRead> {
    this.dmThreadReads.push({ threadId, ...opts });
    const canned = this.dmThreads.get(threadId);
    if (canned instanceof Error) throw canned;
    if (!canned) throw new Error(`no conversation ${threadId}`);
    const since = opts.since;
    return {
      ...canned,
      // A page links a person by their profile, or — as the live page does —
      // by member id alone, which names them by member urn and no profile:
      // never by both.
      participants: canned.participants.map(({ memberUrn, ...participant }) =>
        participant.profileId === null && memberUrn !== undefined ? { ...participant, memberUrn } : participant,
      ),
      messages: canned.messages.filter(
        (message) => since === undefined || message.sentAt === null || message.sentAt >= since,
      ),
      ...(opts.restoreUnread ? { markedSeen: true, unreadRestore: this.unreadRestore } : {}),
    };
  }

  // ---- Invitation fixtures -------------------------------------------------
  /** The note limit LinkedIn's compose view states for a member, by profile
   *  id — null where it states none. A member without one states 300. */
  readonly noteLimits = new Map<string, number | null>();
  /** Every invitation this fake pressed Send for, in order. */
  readonly invitationsSent: SendInvitationInput[] = [];
  /** Every attempt asked for, by operation id, and what it came to. */
  readonly invitationAttempts = new Map<string, SendInvitationResult["status"]>();
  /** LinkedIn's answer for every invitation this fake sent, by operation id. */
  readonly invitationReceipts = new Map<string, InvitationReceipt>();
  /** The next send's outcome after Send: `uncertain_landed` — it goes out and
   *  the call answers uncertain; `uncertain_lost` — it does not go out, and
   *  the call answers uncertain all the same. */
  failNextInvitation: "none" | "uncertain_landed" | "uncertain_lost" = "none";

  /**
   * The sidecar's invitation, over the fake's own state: the member re-read
   * before anything is pressed, refused unless verified, not connected, not
   * invited either way and at the degree `expected` names; the note held to
   * the limit LinkedIn's compose view states; and a confirmation that is
   * LinkedIn's answer naming the invitation, beside the member read back
   * pending. An operation id that already confirmed answers that again
   * without sending.
   */
  async sendInvitation(input: SendInvitationInput): Promise<SendInvitationResult> {
    if (this.invitationAttempts.get(input.operationId) === "confirmed") {
      return {
        status: "confirmed",
        relationship: this.memberAsItStands(input.profileId),
        receipt: this.invitationReceipts.get(input.operationId) ?? null,
        noteLimit: this.noteLimitOf(input.profileId) ?? 0,
      };
    }
    if (this.invitationAttempts.get(input.operationId) === "uncertain") {
      return { status: "uncertain", reason: "write_outcome_uncertain" };
    }
    let before: RelationshipRead;
    try {
      before = this.memberAsItStands(input.profileId);
    } catch {
      return { status: "not_sent", reason: "profile_unreadable" };
    }
    const refused = invitationRefusal(before, input);
    if (refused === "relationship_moved") {
      this.invitationAttempts.set(input.operationId, "not_sent");
      return { status: "not_sent", reason: refused };
    }
    if (refused) {
      this.invitationAttempts.set(input.operationId, "blocked");
      return { status: "blocked", reason: refused };
    }
    const limit = this.noteLimitOf(input.profileId);
    if (limit === null) {
      this.invitationAttempts.set(input.operationId, "blocked");
      return { status: "blocked", reason: "note_limit_unread" };
    }
    if (input.note.length > limit) {
      this.invitationAttempts.set(input.operationId, "blocked");
      return { status: "blocked", reason: "note_limit", noteLimit: limit };
    }
    const fail = this.failNextInvitation;
    this.failNextInvitation = "none";
    if (fail !== "uncertain_lost") {
      this.invitationsSent.push(input);
      this.relationships.set(input.profileId, {
        ...before,
        pending: "outgoing",
        invitation: "pending",
        observedAt: Date.now(),
      });
    }
    if (fail !== "none") {
      this.invitationAttempts.set(input.operationId, "uncertain");
      return { status: "uncertain", reason: "pending_not_shown" };
    }
    this.invitationAttempts.set(input.operationId, "confirmed");
    const receipt: InvitationReceipt = {
      invitationUrn: `urn:li:fsd_invitation:${7_300_000_000 + this.invitationsSent.length}`,
      invitationId: String(7_300_000_000 + this.invitationsSent.length),
      sentAt: Date.now(),
      noteHash: createHash("sha256").update(input.note).digest("hex"),
      sessionId: "mock-session",
      answerFingerprint: "0000000000000000",
    };
    this.invitationReceipts.set(input.operationId, receipt);
    return {
      status: "confirmed",
      relationship: this.memberAsItStands(input.profileId),
      receipt,
      noteLimit: limit,
    };
  }

  /** A read of the member against the attempt: pending, withdrawn since or
   *  connected is the invitation; the switch on Connect is no invitation at
   *  all; anything else proves nothing. */
  async resolveInvitation(input: InvitationAttempt): Promise<InvitationResolution> {
    const read = this.memberAsItStands(input.profileId);
    if (!read.profile.verified || read.profile.id !== input.profileId) {
      return { status: "uncertain", relationship: read };
    }
    if (read.pending === "outgoing" || read.degree === "1st" || read.invitation === "withdrawn") {
      this.invitationAttempts.set(input.operationId, "confirmed");
      return { status: "confirmed", relationship: read };
    }
    if ((read.degree === "2nd" || read.degree === "3rd+") && read.pending === "none" && read.invitation === "connect") {
      return { status: "not_sent", relationship: read };
    }
    return { status: "uncertain", relationship: read };
  }

  // ---- Withdrawal fixtures -------------------------------------------------
  /** Every invitation this fake withdrew, in order. */
  readonly invitationsWithdrawn: WithdrawalAttempt[] = [];
  /** Every withdrawal asked for, by operation id, and what it came to. */
  readonly withdrawalAttempts = new Map<string, WithdrawInvitationResult["status"]>();
  /** The next withdrawal's outcome after its press: `uncertain_landed` — it
   *  is withdrawn and the call answers uncertain; `uncertain_lost` — nothing
   *  is withdrawn, and the call answers uncertain all the same. */
  failNextWithdrawal: "none" | "uncertain_landed" | "uncertain_lost" = "none";

  /**
   * The sidecar's withdrawal, over the fake's own state: the member re-read
   * before anything is pressed and refused unless it shows our invitation
   * pending; a confirmation that is the member read back with nothing pending
   * — never the press. An operation id that already confirmed answers that
   * again without pressing; one left uncertain never presses again.
   */
  async withdrawInvitation(input: WithdrawalAttempt): Promise<WithdrawInvitationResult> {
    const earlier = this.withdrawalAttempts.get(input.operationId);
    if (earlier === "confirmed") return { status: "confirmed", relationship: this.memberAsItStands(input.profileId) };
    if (earlier === "uncertain") return { status: "uncertain", reason: "write_outcome_uncertain" };
    let before: RelationshipRead;
    try {
      before = this.memberAsItStands(input.profileId);
    } catch {
      return { status: "not_sent", reason: "profile_unreadable" };
    }
    const refused = withdrawalRefusal(before, input.profileId);
    if (refused) {
      this.withdrawalAttempts.set(input.operationId, "blocked");
      return { status: "blocked", reason: refused };
    }
    const fail = this.failNextWithdrawal;
    this.failNextWithdrawal = "none";
    if (fail !== "uncertain_lost") {
      this.invitationsWithdrawn.push(input);
      this.relationships.set(input.profileId, {
        ...before,
        pending: "none",
        invitation: "withdrawn",
        observedAt: Date.now(),
      });
    }
    if (fail !== "none") {
      this.withdrawalAttempts.set(input.operationId, "uncertain");
      return { status: "uncertain", reason: "pending_shown_after_withdraw" };
    }
    this.withdrawalAttempts.set(input.operationId, "confirmed");
    return { status: "confirmed", relationship: this.memberAsItStands(input.profileId) };
  }

  /** A read of the member against the attempt: their switch on Withdrawn or
   *  back on Connect is withdrawn, still on Pending is pending, connected is
   *  blocked, anything else proves nothing. An id never pressed withdrew
   *  nothing. */
  async resolveWithdrawal(input: WithdrawalAttempt): Promise<WithdrawalResolution> {
    if (!this.withdrawalAttempts.has(input.operationId)) return { status: "not_sent", relationship: null };
    const read = this.memberAsItStands(input.profileId);
    if (!read.profile.verified || read.profile.id !== input.profileId) {
      return { status: "uncertain", relationship: read };
    }
    if (read.degree === "1st") return { status: "blocked", reason: "already_connected", relationship: read };
    if (read.pending === "outgoing" && read.invitation === "pending") return { status: "pending", relationship: read };
    if (
      (read.degree === "2nd" || read.degree === "3rd+") &&
      read.pending === "none" &&
      (read.invitation === "withdrawn" || read.invitation === "connect")
    ) {
      this.withdrawalAttempts.set(input.operationId, "confirmed");
      return { status: "withdrawn", relationship: read };
    }
    return { status: "uncertain", relationship: read };
  }

  private noteLimitOf(profileId: string): number | null {
    return this.noteLimits.has(profileId) ? this.noteLimits.get(profileId)! : 300;
  }

  // ---- DM fixtures ---------------------------------------------------------
  /** Every DM this fake pressed Send for, in order. */
  readonly dmsSent: SendDmInput[] = [];
  /** Every attempt asked for, by operation id: what it came to, and the
   *  message it was written after. */
  readonly dmAttempts = new Map<string, { status: SendDmResult["status"]; after: string }>();
  /** Every resolve asked for, so a test can assert what it read by. */
  readonly dmResolves: DmResolveInput[] = [];
  /** The next DM's outcome after Send: `uncertain_landed` — it goes out and
   *  the call answers uncertain; `uncertain_lost` — it does not go out, and
   *  the call answers uncertain all the same. */
  failNextDm: "none" | "uncertain_landed" | "uncertain_lost" = "none";

  /**
   * The sidecar's DM, over the fake's own conversations (`dmThreads`): the
   * conversation re-read before anything is typed, refused unless it is the
   * account and the recipient alone, still at the message the DM was written
   * after, with no one else's words in the composer; and a confirmation that is
   * our message read back in it — never the press. An operation id that
   * already confirmed answers that again without pressing.
   */
  async sendDm(input: SendDmInput): Promise<SendDmResult> {
    const earlier = this.dmAttempts.get(input.operationId);
    if (earlier?.status === "confirmed") {
      const found = this.dmReceiptOf(input, earlier.after);
      if (found) return { status: "confirmed", receipt: found };
    }
    if (earlier?.status === "uncertain") return { status: "uncertain", reason: "write_outcome_uncertain" };
    const thread = this.dmThreads.get(input.threadId);
    if (!thread || thread instanceof Error) return { status: "not_sent", reason: "thread_unavailable" };
    const refused = dmRefusal(thread, input);
    if (refused) {
      this.dmAttempts.set(input.operationId, { status: "blocked", after: input.expected.lastMessageId });
      return { status: "blocked", reason: refused };
    }
    const fail = this.failNextDm;
    this.failNextDm = "none";
    if (fail !== "uncertain_lost") {
      const self = thread.participants.find((participant) => participant.isSelf)!;
      const at = Date.now();
      const message: DmMessage = {
        messageId: `mock-dm-${this.dmsSent.length + 1}`,
        fromSelf: true,
        authorProfileId: self.profileId!,
        text: input.text.split(/\s+/).filter(Boolean).join(" "),
        textHash: dmWordsHash(input.text),
        sentAt: at,
        observedAt: at,
      };
      this.dmsSent.push(input);
      this.dmThreads.set(input.threadId, { ...thread, messages: [...thread.messages, message], observedAt: at });
    }
    if (fail !== "none") {
      this.dmAttempts.set(input.operationId, { status: "uncertain", after: input.expected.lastMessageId });
      return { status: "uncertain", reason: "message_not_shown" };
    }
    this.dmAttempts.set(input.operationId, { status: "confirmed", after: input.expected.lastMessageId });
    return { status: "confirmed", receipt: this.dmReceiptOf(input, input.expected.lastMessageId)! };
  }

  /** A read of the conversation against the attempt: our message after the
   *  one it was written after is the receipt; its history still ending at
   *  that message is `absent_proven`. */
  async resolveDm(input: DmResolveInput): Promise<DmResolution> {
    this.dmResolves.push(input);
    const attempt = this.dmAttempts.get(input.operationId);
    if (!attempt) return { status: "not_sent" };
    const found = this.dmReceiptOf(input, attempt.after);
    if (found) {
      this.dmAttempts.set(input.operationId, { ...attempt, status: "confirmed" });
      return { status: "confirmed", receipt: found };
    }
    const thread = this.dmThreads.get(input.threadId);
    const endsAtAnchor =
      thread !== undefined && !(thread instanceof Error) && thread.messages.at(-1)?.messageId === attempt.after;
    return endsAtAnchor ? { status: "absent_proven", observedAt: Date.now() } : { status: "uncertain" };
  }

  // ---- First messages -----------------------------------------------------
  /** Every first message this fake pressed Send for, in order. */
  readonly openedDms: OpenDmInput[] = [];
  /** Every first message's attempt, by operation id: what it came to, and
   *  the conversation it opened. */
  readonly openDmAttempts = new Map<string, { status: OpenDmResult["status"]; threadId: string | null }>();
  /** Why the next first message's prepare refuses, in the sidecar's words —
   *  `not_connected`, `conversation_exists`… — or null to send it. */
  openDmRefusal: string | null = null;
  /** The next first message's outcome after Send, as `failNextDm`. */
  failNextOpenDm: "none" | "uncertain_landed" | "uncertain_lost" = "none";
  /** Whether a read of the account's conversations can say nothing at all of
   *  an uncertain first message, whatever it holds. */
  openDmResolutionUncertain = false;
  /** The account's own profile id, as the conversations a first message
   *  opens name it. */
  selfProfileId = "mock-owner";

  /**
   * The sidecar's first message, over the fake's own conversations: refused
   * where `openDmRefusal` says, else a new 1:1 with the recipient holding our
   * words, whose read is the confirmation. An operation id that already
   * confirmed answers that again without pressing.
   */
  async openDm(input: OpenDmInput): Promise<OpenDmResult> {
    const earlier = this.openDmAttempts.get(input.operationId);
    if (earlier?.status === "confirmed" || earlier?.status === "uncertain") {
      const found = this.openedReceiptOf(input, earlier.threadId);
      if (earlier.status === "confirmed" && found) return { status: "confirmed", ...found };
      return { status: "uncertain", reason: "write_outcome_uncertain" };
    }
    if (this.openDmRefusal !== null) {
      const reason = this.openDmRefusal;
      this.openDmRefusal = null;
      return { status: "blocked", reason };
    }
    const fail = this.failNextOpenDm;
    this.failNextOpenDm = "none";
    let threadId: string | null = null;
    if (fail !== "uncertain_lost") {
      threadId = `mock-opened-${this.openedDms.length + 1}`;
      const at = Date.now();
      this.openedDms.push(input);
      this.dmThreads.set(threadId, {
        threadId,
        participants: [
          { profileId: this.selfProfileId, profileUrl: null, displayName: "Owner", isSelf: true },
          { profileId: input.recipientProfileId, profileUrl: null, displayName: input.recipientProfileId, isSelf: false },
        ],
        group: false,
        messages: [
          {
            messageId: `mock-dm-${threadId}`,
            fromSelf: true,
            authorProfileId: this.selfProfileId,
            text: input.text.split(/\s+/).filter(Boolean).join(" "),
            textHash: dmWordsHash(input.text),
            sentAt: at,
            observedAt: at,
          },
        ],
        complete: true,
        composer: { hasDraft: false },
        observedAt: at,
        sessionId: "mock-session",
        pageFingerprint: "mock",
        selectorPack: "mock",
      });
    }
    if (fail !== "none") {
      this.openDmAttempts.set(input.operationId, { status: "uncertain", threadId });
      return { status: "uncertain", reason: "conversation_not_listed" };
    }
    this.openDmAttempts.set(input.operationId, { status: "confirmed", threadId });
    return { status: "confirmed", ...this.openedReceiptOf(input, threadId)! };
  }

  /** The account's conversations against a first message's attempt: the
   *  conversation it opened holding our words is the receipt; none opened is
   *  `absent_proven`. */
  async resolveOpenDm(input: OpenDmInput): Promise<OpenDmResolution> {
    if (this.openDmResolutionUncertain) return { status: "uncertain" };
    const attempt = this.openDmAttempts.get(input.operationId);
    if (!attempt) return { status: "not_sent" };
    const found = this.openedReceiptOf(input, attempt.threadId);
    if (found) {
      this.openDmAttempts.set(input.operationId, { ...attempt, status: "confirmed" });
      return { status: "confirmed", ...found };
    }
    return attempt.threadId === null ? { status: "absent_proven", observedAt: Date.now() } : { status: "uncertain" };
  }

  private openedReceiptOf(
    input: OpenDmInput,
    threadId: string | null,
  ): { receipt: OpenDmReceipt; conversation: ConversationHistory } | null {
    const thread = threadId === null ? undefined : this.dmThreads.get(threadId);
    if (!thread || thread instanceof Error) return null;
    const ours = thread.messages.find((message) => message.fromSelf && message.textHash === dmWordsHash(input.text));
    if (!ours) return null;
    const { composer: _composer, ...conversation } = thread;
    return {
      receipt: {
        threadId: thread.threadId,
        messageId: ours.messageId,
        sentAt: ours.sentAt,
        textHash: ours.textHash,
        tailMessageId: thread.messages.at(-1)!.messageId,
        observedAt: Date.now(),
        sessionId: thread.sessionId,
        pageFingerprint: thread.pageFingerprint,
      },
      conversation,
    };
  }

  /** Our message in the conversation after `after`, carrying these words, as
   *  a receipt; null where there is none. */
  private dmReceiptOf(input: DmAttempt, after: string): DmReceipt | null {
    const thread = this.dmThreads.get(input.threadId);
    if (!thread || thread instanceof Error) return null;
    const at = thread.messages.findIndex((message) => message.messageId === after);
    if (at === -1) return null;
    const ours = thread.messages
      .slice(at + 1)
      .find((message) => message.fromSelf && message.textHash === dmWordsHash(input.text));
    if (!ours) return null;
    return {
      messageId: ours.messageId,
      sentAt: ours.sentAt,
      textHash: ours.textHash,
      tailMessageId: thread.messages.at(-1)!.messageId,
      observedAt: Date.now(),
      sessionId: thread.sessionId,
      pageFingerprint: thread.pageFingerprint,
    };
  }
}

/** Why the conversation as it stands is not one to write in, in the sidecar's
 *  words, or null when it is. */
function dmRefusal(thread: DmThreadRead, input: SendDmInput): string | null {
  if (thread.group || thread.participants.length !== 2) return "group_thread";
  const others = thread.participants.filter((participant) => !participant.isSelf);
  const shown = others[0]?.memberUrn;
  const recipient =
    shown !== undefined && input.expected.memberUrn !== undefined
      ? shown === input.expected.memberUrn
      : others[0]?.profileId === input.recipientProfileId;
  if (others.length !== 1 || !recipient) return "participants_mismatch";
  if (thread.messages.at(-1)?.messageId !== input.expected.lastMessageId) return "thread_moved";
  if (thread.composer.hasDraft && thread.composer.draftHash !== dmWordsHash(input.text)) return "human_draft";
  return null;
}

/** A member with no canned read: a verified 2nd-degree stranger whose
 *  invitation switch is on Connect, which leads to their composer, with no
 *  composer open. */
function strangerRead(profileId: string): RelationshipRead {
  return {
    profile: {
      id: profileId,
      url: `https://www.linkedin.com/in/${profileId}/`,
      displayName: profileId,
      verified: true,
    },
    degree: "2nd",
    pending: "none",
    note: { supported: "unknown", limitChars: null },
    ...mockMember(profileId),
    invitation: "connect",
    connect: { composerUrl: `https://www.linkedin.com/preload/custom-invite/?vanityName=${profileId}` },
    observedAt: Date.now(),
    sessionId: "mock",
    pageFingerprint: "mock",
    selectorPack: "mock",
  };
}

/** The member's profile urn and number in the fake, from their public
 *  identifier, so every read of one member names the same member. */
export function mockMember(profileId: string): { profileUrn: string; memberId: string } {
  const digest = createHash("sha256").update(profileId).digest("hex");
  return {
    profileUrn: `urn:li:fsd_profile:ACoAAMock${digest.slice(0, 32)}`,
    memberId: String(Number.parseInt(digest.slice(0, 12), 16)),
  };
}

/** Why the member as read is not one to invite, in the sidecar's words —
 *  `invitation_write.admit` — or null when they are. */
function invitationRefusal(read: RelationshipRead, input: SendInvitationInput): string | null {
  if (!read.profile.verified || read.profile.id !== input.profileId) return "profile_unverified";
  if (read.profileUrn !== input.expected.profileUrn || read.memberId !== input.expected.memberId) {
    return "profile_unverified";
  }
  if (read.degree === "1st") return "already_connected";
  if (read.pending === "outgoing") return "invitation_pending";
  if (read.pending === "incoming") return "invitation_incoming";
  if (read.invitation === "withdrawn") return "recently_withdrawn";
  if (read.degree === "unknown" || read.pending !== "none" || read.invitation !== "connect") {
    return "relationship_unknown";
  }
  if (read.degree !== input.expected.degree) return "relationship_moved";
  return null;
}

/** Why the sidecar would refuse a withdrawal of this member as the page
 *  shows them — `invitation_withdraw.admit` — or null for our invitation
 *  pending. */
function withdrawalRefusal(read: RelationshipRead, profileId: string): string | null {
  if (!read.profile.verified || read.profile.id !== profileId) return "profile_unverified";
  if (read.degree === "1st") return "already_connected";
  if (read.pending === "incoming") return "invitation_incoming";
  if (read.pending === "none" && (read.invitation === "connect" || read.invitation === "withdrawn")) {
    return "invitation_not_pending";
  }
  if (read.pending !== "outgoing" || read.invitation !== "pending" || read.degree === "self") {
    return "relationship_unknown";
  }
  if (read.memberId === undefined || read.profileUrn === undefined) return "relationship_unknown";
  return null;
}

function mockSlug(s: string): string {
  return (
    s
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "term"
  );
}

function defaultPosts(): DriverPost[] {
  const now = Date.now();
  return [
    {
      postUrn: "urn:li:activity:mock-1",
      authorProfileId: "urn:li:person:jane",
      authorName: "Jane Doe",
      url: "https://linkedin.com/feed/mock-1",
      contentText:
        "We switched off Acme last month — the reporting was unusable and support ghosted us. Anyone found something better?",
      postedAt: now - 6 * 60 * 60 * 1000,
      detectedLanguage: "en",
      authorGeo: "US",
    },
    {
      postUrn: "urn:li:activity:mock-2",
      authorProfileId: "urn:li:person:hans",
      authorName: "Hans Müller",
      url: "https://linkedin.com/feed/mock-2",
      contentText: "Schöner Sonnenaufgang heute über München. #motivation",
      postedAt: now - 2 * 24 * 60 * 60 * 1000,
      detectedLanguage: "de",
      authorGeo: "DE",
    },
  ];
}

function defaultIncoming(): DriverIncomingComment[] {
  const now = Date.now();
  return [
    {
      commentUrn: "urn:li:comment:mock-in-1",
      ownPostUrn: "urn:li:activity:my-post-1",
      authorProfileId: "urn:li:person:ravi",
      authorName: "Ravi Patel",
      text: "Great breakdown — how do you handle the rate limits?",
      receivedAt: now - 30 * 60 * 1000,
      ownPostText:
        "Shipped a thing this week. Small team, no fanfare — just fixed the one workflow that annoyed every user.",
    },
    {
      commentUrn: "urn:li:comment:mock-in-2",
      ownPostUrn: "urn:li:activity:my-post-1",
      authorProfileId: "urn:li:person:troll",
      authorName: "Anonymous",
      text: "This is spammy garbage and you should be ashamed.",
      receivedAt: now - 10 * 60 * 1000,
    },
  ];
}
