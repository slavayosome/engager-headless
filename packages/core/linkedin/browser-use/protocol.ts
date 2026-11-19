import { z } from "zod";
import {
  MAX_COMMENT_REPLIES,
  MAX_HISTORY_MESSAGES,
  MAX_INBOX_THREADS,
  MAX_INCOMING_INVITATIONS,
  MAX_NOTIFICATION_START,
  MAX_THREAD_COMMENTS,
  type AgentPage,
  type CommentRepliesRead,
  type ConversationHistory,
  type DmThreadRead,
  type InboxRead,
  type IncomingInvitationsRead,
  type InvitationReceipt,
  type LikeStateRead,
  type NotificationsRead,
  type RelationshipRead,
} from "../driver";

/**
 * Private, versioned protocol between the TypeScript LinkedIn adapter and the
 * local Browser Use Python process. Stdout is NDJSON protocol traffic only;
 * human-readable diagnostics belong on stderr.
 */
export const BROWSER_USE_PROTOCOL_VERSION = 1 as const;
export const CDP_USE_PACKAGE_VERSION = "1.4.5" as const;
export const BROWSER_USE_SELECTOR_PACK_VERSION =
  "linkedin-2026-10-14.1" as const;

export const BrowserUseOperationSchema = z.enum([
  "warm_browser",
  "ensure_session",
  "discover_posts",
  "fetch_own_profile",
  "fetch_own_posts",
  "fetch_own_comments",
  "write",
  "reconcile_posted",
  "resolve_write_outcome",
  "settle_member_write",
  "like_post",
  "like_comment",
  "read_like_state",
  "read_post_thread",
  "read_author_profile",
  "read_company_page",
  "read_comment_replies",
  "read_notifications",
  "read_relationship",
  "read_incoming_invitations",
  "accept_invitation",
  "read_inbox",
  "read_dm_thread",
  "read_conversation_messages",
  "read_page_for_agent",
  "send_invitation",
  "withdraw_invitation",
  "send_dm",
  "open_dm",
  "set_window_visibility",
  "restart_browser",
  "close_browser",
  "shutdown",
]);

export type BrowserUseOperation = z.infer<typeof BrowserUseOperationSchema>;

const ProtocolVersionSchema = z.literal(BROWSER_USE_PROTOCOL_VERSION);
const RequestIdSchema = z.string().min(1).max(128);
const OperationIdSchema = z.string().min(1).max(1_000);
const LimitSchema = z.number().int().min(1).max(100);
const UnixMsSchema = z.number().int().nonnegative();
const EmptyParamsSchema = z.object({}).strict();

export const BrowserUseDriverPostSchema = z
  .object({
    postUrn: z.string().min(1),
    authorProfileId: z.string().min(1).optional(),
    authorName: z.string().min(1).optional(),
    authorHeadline: z.string().optional(),
    authorIsCompany: z.boolean().optional(),
    url: z.string().min(1).optional(),
    contentText: z.string(),
    postedAt: UnixMsSchema.optional(),
    detectedLanguage: z.string().min(1).optional(),
    authorGeo: z.string().min(1).optional(),
    media: z.unknown().optional(),
    metrics: z.unknown().optional(),
  })
  .strict();

/**
 * What the sidecar writes. A reply sits under one of our comments and answers
 * one reply beside it — LinkedIn threads are two levels deep — so it names both:
 * `parentCommentUrn` is the comment the reply is posted under, `replyToUrn` the
 * one it answers. Everything here is the journal's fingerprint.
 */
export const BrowserUsePostInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("room_reply"),
    organizationId: z.string().uuid(),
    channelId: z.number().int().positive(),
    expectedAccountProfileId: z.string().min(1).max(1_000),
    postUrn: z.string().min(1).max(1_000),
    parentCommentUrn: z.string().min(1).max(1_000),
    expectedAuthorMemberUrn: z.string().regex(/^urn:li:fsd_profile:[A-Za-z0-9_-]{1,200}$/),
    text: z.string().min(1).max(3_000),
    marker: z.string().min(1).max(1_000),
  }).strict(),
  z
    .object({
      kind: z.literal("comment"),
      postUrn: z.string().min(1).max(1_000),
      text: z.string().min(1).max(3_000),
      marker: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reply"),
      postUrn: z.string().min(1).max(1_000),
      parentCommentUrn: z.string().min(1).max(1_000),
      replyToUrn: z.string().min(1).max(1_000),
      rootIsRoomReply: z.object({ replyUrn: z.string().min(1).max(1_000) }).strict().optional(),
      text: z.string().min(1).max(3_000),
      marker: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export type BrowserUsePostInput = z.infer<typeof BrowserUsePostInputSchema>;

/** An area of the screen, in screen points: where a window is put beside
 *  whatever else the owner is using. The sidecar refuses anything smaller than
 *  a page can be read in or larger than a display holds. */
export const WindowPlaceSchema = z
  .object({
    left: z.number().int().min(-16_000).max(16_000),
    top: z.number().int().min(-16_000).max(16_000),
    width: z.number().int().min(400).max(8_000),
    height: z.number().int().min(400).max(8_000),
  })
  .strict();

const WarmBrowserRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("warm_browser"),
    params: EmptyParamsSchema,
  })
  .strict();

const EnsureSessionRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("ensure_session"),
    // `interactive` marks a probe the owner is watching (Test connection):
    // the sidecar surfaces its hidden window so they can sign in, and reads
    // again who is signed in. Unattended callers omit it and the window stays
    // hidden. `surface: false` is a probe that only WATCHES a sign-in: it
    // leaves the window where the owner put it and opens nothing if they closed
    // it. `signIn` goes to LinkedIn's sign-in page first, and `place` is the
    // area the window is put in when it is surfaced.
    params: z
      .object({
        interactive: z.boolean().optional(),
        existingPageOnly: z.literal(true).optional(),
        surface: z.boolean().optional(),
        signIn: z.boolean().optional(),
        place: WindowPlaceSchema.optional(),
      })
      .strict(),
  })
  .strict();

const DiscoverPostsRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("discover_posts"),
    params: z
      .object({
        term: z.string().min(1).max(1_000),
        cursor: z.string().min(1).max(100_000).nullable().optional(),
        limit: LimitSchema.optional(),
        kind: z.enum(["search", "author"]).optional(),
        datePosted: z
          .enum(["past_day", "past_week", "past_month"])
          .optional(),
        sort: z.enum(["relevance", "latest"]).optional(),
      })
      .strict(),
  })
  .strict();

const FetchOwnProfileRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("fetch_own_profile"),
    params: EmptyParamsSchema,
  })
  .strict();

const FetchOwnPostsRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("fetch_own_posts"),
    params: z.object({ limit: LimitSchema.optional() }).strict(),
  })
  .strict();

const FetchOwnCommentsRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("fetch_own_comments"),
    params: z.object({ limit: LimitSchema.optional() }).strict(),
  })
  .strict();

const WriteRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("write"),
    params: z
      .object({
        operationId: OperationIdSchema,
        input: BrowserUsePostInputSchema,
      })
      .strict(),
  })
  .strict();

const ReconcilePostedRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("reconcile_posted"),
    params: z
      .object({
        operationId: OperationIdSchema,
        input: BrowserUsePostInputSchema,
      })
      .strict(),
  })
  .strict();

const LikePostRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("like_post"),
    params: z.object({ postUrn: z.string().min(1).max(1_000) }).strict(),
  })
  .strict();

const LikeCommentRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("like_comment"),
    params: z
      .object({
        // Navigation target: comment urns are not navigable, so the sidecar
        // opens the PARENT post and locates the row by its comment-urn data-id.
        postUrn: z.string().min(1).max(1_000),
        commentUrn: z.string().min(1).max(1_000),
        // Where the action target is a reply: the comment it answers. The receipt
        // reads the post opened by LinkedIn's own link to the reply, the one
        // page that declares a reply's reaction.
        parentCommentUrn: z.string().min(1).max(1_000).optional(),
      })
      .strict(),
  })
  .strict();

const ReadPostThreadRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_post_thread"),
    params: z
      .object({
        postUrn: z.string().min(1).max(1_000),
        maxComments: z.number().int().min(0).max(MAX_THREAD_COMMENTS),
        order: z.enum(["RELEVANCE", "REVERSE_CHRONOLOGICAL"]).optional(),
        start: z.number().int().min(0).max(100).optional(),
      })
      .strict(),
  })
  .strict();

const ReadAuthorProfileRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_author_profile"),
    params: z.object({ profileId: z.string().min(1).max(1_000), role: z.boolean().optional() }).strict(),
  })
  .strict();

const ReadCompanyPageRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_company_page"),
    params: z.object({ companyRef: z.string().min(1).max(1_000) }).strict(),
  })
  .strict();

const ReadCommentRepliesRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_comment_replies"),
    params: z
      .object({
        // Comment urns are not navigable: the sidecar opens the parent post
        // and finds our row by its comment id, as like_comment does.
        postUrn: z.string().min(1).max(1_000),
        commentUrn: z.string().min(1).max(1_000),
        since: UnixMsSchema.optional(),
        roomReplyUrn: z.string().min(1).max(1_000).optional(),
        limit: z.number().int().min(1).max(MAX_COMMENT_REPLIES),
        // Replies a notification about our comment named: where the page
        // prints no reply count, only these are read as replies to it.
        vouchedReplyUrns: z
          .array(z.string().min(1).max(1_000))
          .max(MAX_COMMENT_REPLIES)
          .optional(),
      })
      .strict(),
  })
  .strict();

const ReadNotificationsRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_notifications"),
    params: z
      .object({ start: z.number().int().min(0).max(MAX_NOTIFICATION_START) })
      .strict(),
  })
  .strict();

/** The account's reaction to a post, or to a comment or reply under it, read
 *  from the post's own data: never a press. A reply is read from the post
 *  opened at it, which needs the comment it answers (`parentCommentUrn`). */
const ReadLikeStateRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_like_state"),
    params: z
      .object({
        postUrn: z.string().min(1).max(1_000),
        commentUrn: z.string().min(1).max(1_000).optional(),
        parentCommentUrn: z.string().min(1).max(1_000).optional(),
      })
      .strict()
      .refine((params) => params.parentCommentUrn === undefined || params.commentUrn !== undefined, {
        message: "parentCommentUrn names the comment a reply answers, and needs the reply's commentUrn",
      }),
  })
  .strict();

const ReadRelationshipRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_relationship"),
    // Exactly one: the member's public identifier, or their profile URL; and
    // whether to look up where they are as well.
    params: z.union([
      z.object({ profileId: z.string().min(1).max(1_000), place: z.literal(true).optional() }).strict(),
      z.object({ profileUrl: z.string().min(1).max(1_000), place: z.literal(true).optional() }).strict(),
    ]),
  })
  .strict();

const ReadIncomingInvitationsRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_incoming_invitations"),
    params: z
      .object({
        since: UnixMsSchema.optional(),
        limit: z.number().int().min(1).max(MAX_INCOMING_INVITATIONS),
      })
      .strict(),
  })
  .strict();

/**
 * One acceptance's two sub-steps on the write journal. Every step names the
 * invitation, its sender and the fingerprint of the two, which the sidecar
 * recomputes and binds to the operation id: `send` reads the invitations
 * page's data, binds the request's one Accept and presses it, journaling the
 * attempt as CLICKING before the press; `resolve` reads what an attempt
 * nobody saw land did.
 */
const AcceptanceContentSchema = {
  operationId: OperationIdSchema,
  invitationId: z.string().regex(/^urn:li:invitation:[0-9]{1,30}$/),
  senderProfileId: z.string().min(1).max(1_000),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
};

const AcceptInvitationRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("accept_invitation"),
    params: z.discriminatedUnion("step", [
      z.object({ step: z.literal("send"), ...AcceptanceContentSchema }).strict(),
      z
        .object({
          step: z.literal("resolve"),
          ...AcceptanceContentSchema,
          /** The page loads the caller has budgeted this read: the sender's
           *  profile, then the invitations page's data. */
          reads: z.number().int().min(0).max(2),
        })
        .strict(),
    ]),
  })
  .strict();

const ReadInboxRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_inbox"),
    params: z
      .object({
        since: UnixMsSchema.optional(),
        limit: z.number().int().min(1).max(MAX_INBOX_THREADS),
      })
      .strict(),
  })
  .strict();

/** The id a conversation's own address carries — the one segment of
 *  `/messaging/thread/<id>/` the sidecar navigates to, so nothing in it can
 *  climb out of that path. */
export const DmThreadIdSchema = z.string().regex(/^[A-Za-z0-9_=+-]{1,200}$/);
/** A member's own identity on LinkedIn, as its conversation data names them. */
export const MemberUrnSchema = z.string().regex(/^urn:li:fsd_profile:[A-Za-z0-9_-]{1,200}$/);

/** Whose profile each member urn in a conversation is, as the caller's reads
 *  tied them: what lets its history stand for its page. */
const KnownMembersSchema = z
  .array(z.object({ memberUrn: MemberUrnSchema, profileId: z.string().min(1).max(1_000) }).strict())
  .max(100);

const ReadDmThreadRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_dm_thread"),
    params: z
      .object({
        threadId: DmThreadIdSchema,
        since: UnixMsSchema.optional(),
        restoreUnread: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const ReadConversationMessagesRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_conversation_messages"),
    params: z
      .object({
        threadId: DmThreadIdSchema,
        limit: z.number().int().min(1).max(MAX_HISTORY_MESSAGES),
        members: KnownMembersSchema.optional(),
      })
      .strict(),
  })
  .strict();

/**
 * One page for the agent reader. The sidecar reads `url` only as the page
 * `intent` names — a post's own page (with the comment of ours it settles),
 * the messaging inbox, one conversation — and refuses any other address.
 */
const ReadPageForAgentRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("read_page_for_agent"),
    params: z.discriminatedUnion("intent", [
      z
        .object({
          intent: z.literal("comment_replies"),
          url: z.string().min(1).max(1_000),
          commentUrn: z.string().min(1).max(1_000),
        })
        .strict(),
      z.object({ intent: z.literal("inbox"), url: z.string().min(1).max(1_000) }).strict(),
      z.object({ intent: z.literal("dm_thread"), url: z.string().min(1).max(1_000) }).strict(),
    ]),
  })
  .strict();

/**
 * One invitation's two sub-steps on the write journal. Every step names the
 * member and the note and the fingerprint of the two, which the sidecar
 * recomputes and binds to the operation id: `send` re-reads the member,
 * holds them to the member the admitting read bound — their profile urn and
 * member number — journals the request as CLICKING and makes LinkedIn's own
 * invitation POST once, `resolve` reads what an attempt nobody saw land did.
 */
const InvitationContentSchema = {
  operationId: OperationIdSchema,
  profileId: z.string().min(1).max(1_000),
  note: z.string().min(1).max(3_000),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
};

const SendInvitationRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("send_invitation"),
    params: z.discriminatedUnion("step", [
      z
        .object({
          step: z.literal("send"),
          ...InvitationContentSchema,
          expected: z
            .object({
              degree: z.enum(["2nd", "3rd+"]),
              pending: z.literal("none"),
              profileUrn: MemberUrnSchema,
              memberId: z.string().regex(/^[0-9]{1,20}$/),
            })
            .strict(),
        })
        .strict(),
      z.object({ step: z.literal("resolve"), ...InvitationContentSchema }).strict(),
    ]),
  })
  .strict();

/**
 * One withdrawal's two sub-steps on the write journal. Every step names the
 * member and its fingerprint, which the sidecar recomputes and binds to the
 * operation id: `send` re-reads the member, binds their Pending, journals the
 * attempt as CLICKING and presses it and the confirmation's Withdraw;
 * `resolve` reads what an attempt nobody saw land did.
 */
const WithdrawalContentSchema = {
  operationId: OperationIdSchema,
  profileId: z.string().min(1).max(1_000),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
};

const WithdrawInvitationRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("withdraw_invitation"),
    params: z.discriminatedUnion("step", [
      z.object({ step: z.literal("send"), ...WithdrawalContentSchema }).strict(),
      z.object({ step: z.literal("resolve"), ...WithdrawalContentSchema }).strict(),
    ]),
  })
  .strict();

/** The longest DM LinkedIn's composer carries. */
export const MAX_DM_CHARS = 8_000;

/**
 * One DM's two sub-steps on the write journal. Every step names the
 * conversation, the recipient and the words and the fingerprint of the three,
 * which the sidecar recomputes and binds to the operation id: `send` reads
 * the conversation afresh, journals the attempt as CLICKING and makes the one
 * createMessage POST, `resolve` reads what an attempt nobody saw land did.
 */
const DmContentSchema = {
  operationId: OperationIdSchema,
  threadId: DmThreadIdSchema,
  recipientProfileId: z.string().min(1).max(1_000),
  text: z.string().min(1).max(MAX_DM_CHARS),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
};

const SendDmRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("send_dm"),
    params: z.discriminatedUnion("step", [
      z
        .object({
          step: z.literal("send"),
          ...DmContentSchema,
          expected: z
            .object({ lastMessageId: z.string().min(1).max(1_000), memberUrn: MemberUrnSchema.optional() })
            .strict(),
        })
        .strict(),
      z
        .object({ step: z.literal("resolve"), ...DmContentSchema, members: KnownMembersSchema.optional() })
        .strict(),
    ]),
  })
  .strict();

/**
 * A first message's two sub-steps, as a DM's but into no conversation yet:
 * every step names the member and the words and the fingerprint of the two.
 * `send` reads the member's profile, the account's conversations and the
 * compose view their Message trigger leads to, journals the attempt as
 * CLICKING and makes the one createMessage POST to them; `resolve` reads the
 * account's conversation list for what an attempt nobody saw land did.
 */
const OpenDmContentSchema = {
  operationId: OperationIdSchema,
  recipientProfileId: z.string().min(1).max(1_000),
  text: z.string().min(1).max(MAX_DM_CHARS),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
};

const OpenDmRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("open_dm"),
    params: z.discriminatedUnion("step", [
      z.object({ step: z.literal("send"), ...OpenDmContentSchema }).strict(),
      z.object({ step: z.literal("resolve"), ...OpenDmContentSchema }).strict(),
    ]),
  })
  .strict();

const ResolveWriteOutcomeRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("resolve_write_outcome"),
    params: z
      .object({
        operationId: OperationIdSchema,
        input: BrowserUsePostInputSchema,
        outcome: z.enum(["confirmed_not_posted", "confirmed_posted"]),
        externalUrn: z.string().min(1).optional(),
        resolutionVersion: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/**
 * The owner's word on an invitation, acceptance, withdrawal or DM nobody saw
 * land, recorded in the journal entry the attempt's operation id names. It
 * reads and presses nothing.
 */
const SettleMemberWriteRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("settle_member_write"),
    params: z
      .object({ operationId: OperationIdSchema, outcome: z.enum(["went_out", "not_sent"]) })
      .strict(),
  })
  .strict();

/** The owner's choice of window on Settings › This Mac. */
export const BrowserWindowSchema = z.enum(["hidden", "shown"]);
export type BrowserWindow = z.infer<typeof BrowserWindowSchema>;

/**
 * Only the browser's WINDOW moves: no page is opened or navigated. `window`
 * applies the owner's choice at once; `reveal` brings the window up for this
 * session (Show Engager's browser) — in `place`, where the caller names an
 * area — and the next unattended task hides it again while the choice is
 * Hidden.
 */
const SetWindowVisibilityRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("set_window_visibility"),
    params: z.union([
      z.object({ window: BrowserWindowSchema }).strict(),
      z.object({ reveal: z.literal(true), place: WindowPlaceSchema.optional() }).strict(),
    ]),
  })
  .strict();

/**
 * The sign-in step's Try again: close Engager's browser and start it again on
 * the same profile, with its window brought up in `place`. The browser is
 * replaced and nothing else (no page is opened or navigated), and the
 * profile's cookies are kept.
 */
const RestartBrowserRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("restart_browser"),
    params: z.object({ place: WindowPlaceSchema.optional() }).strict(),
  })
  .strict();

const CloseBrowserRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("close_browser"),
    params: EmptyParamsSchema,
  })
  .strict();

const ShutdownRequestSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: z.literal("shutdown"),
    params: EmptyParamsSchema,
  })
  .strict();

export const BrowserUseRequestSchema = z.discriminatedUnion("op", [
  WarmBrowserRequestSchema,
  EnsureSessionRequestSchema,
  DiscoverPostsRequestSchema,
  FetchOwnProfileRequestSchema,
  FetchOwnPostsRequestSchema,
  FetchOwnCommentsRequestSchema,
  WriteRequestSchema,
  ReconcilePostedRequestSchema,
  ResolveWriteOutcomeRequestSchema,
  SettleMemberWriteRequestSchema,
  LikePostRequestSchema,
  LikeCommentRequestSchema,
  ReadLikeStateRequestSchema,
  ReadPostThreadRequestSchema,
  ReadAuthorProfileRequestSchema,
  ReadCompanyPageRequestSchema,
  ReadCommentRepliesRequestSchema,
  ReadNotificationsRequestSchema,
  ReadRelationshipRequestSchema,
  ReadIncomingInvitationsRequestSchema,
  AcceptInvitationRequestSchema,
  ReadInboxRequestSchema,
  ReadDmThreadRequestSchema,
  ReadConversationMessagesRequestSchema,
  ReadPageForAgentRequestSchema,
  SendInvitationRequestSchema,
  WithdrawInvitationRequestSchema,
  SendDmRequestSchema,
  OpenDmRequestSchema,
  SetWindowVisibilityRequestSchema,
  RestartBrowserRequestSchema,
  CloseBrowserRequestSchema,
  ShutdownRequestSchema,
]);

export type BrowserUseRequest = z.infer<typeof BrowserUseRequestSchema>;
export type BrowserUseRequestFor<Op extends BrowserUseOperation> = Extract<
  BrowserUseRequest,
  { op: Op }
>;

const AccountSummarySchema = z
  .object({
    displayName: z.string().min(1).optional(),
    /** The sidecar's `own_public_identifier` — survives a display-name rename.
     *  This schema is `.strict()`, so it must be declared here or a sidecar
     *  that sends the field is REJECTED. */
    externalAccountId: z.string().min(1).optional(),
    /** The same mini profile's headline, for the sign-in step's "Is this
     *  you?" and nothing else: no row keeps it. Absent where it has none. */
    headline: z.string().min(1).optional(),
  })
  .strict();

const OwnProfileSchema = z
  .object({
    displayName: z.string().min(1).optional(),
  })
  .strict();

const OwnCommentSchema = z
  .object({
    text: z.string(),
    postUrn: z.string().min(1),
  })
  .strict();

const successBase = <Op extends BrowserUseOperation>(op: Op) => ({
  v: ProtocolVersionSchema,
  id: RequestIdSchema,
  op: z.literal(op),
  ok: z.literal(true),
});

const WarmBrowserSuccessSchema = z
  .object({
    ...successBase("warm_browser"),
    result: z.object({ ok: z.literal(true) }).strict(),
  })
  .strict();

const EnsureSessionSuccessSchema = z
  .object({
    ...successBase("ensure_session"),
    result: z
      .object({
        ok: z.boolean(),
        reason: z.string().min(1).optional(),
        signInPage: z.literal(true).optional(),
        account: AccountSummarySchema.optional(),
      })
      .strict(),
  })
  .strict();

const DiscoverPostsSuccessSchema = z
  .object({
    ...successBase("discover_posts"),
    result: z
      .object({
        posts: z.array(BrowserUseDriverPostSchema),
        nextCursor: z.string().min(1).nullable(),
        cursorState: z.enum(["active", "expired"]),
      })
      .strict(),
  })
  .strict();

const FetchOwnProfileSuccessSchema = z
  .object({
    ...successBase("fetch_own_profile"),
    result: z.object({ profile: OwnProfileSchema.nullable() }).strict(),
  })
  .strict();

const FetchOwnPostsSuccessSchema = z
  .object({
    ...successBase("fetch_own_posts"),
    result: z
      .object({ posts: z.array(BrowserUseDriverPostSchema), incomplete: z.boolean().optional() })
      .strict(),
  })
  .strict();

const FetchOwnCommentsSuccessSchema = z
  .object({
    ...successBase("fetch_own_comments"),
    result: z
      .object({ comments: z.array(OwnCommentSchema), incomplete: z.boolean().optional() })
      .strict(),
  })
  .strict();

/**
 * What a comment's, a reply's or a room reply's one `write` came to. A write
 * an earlier attempt under the id already landed (`already_committed`, adopted
 * from the journal or from a read of the post before anything was opened for a
 * press) carries the comment's urn; `committed` is a press LinkedIn answered
 * with the comment it created; `failed` is LinkedIn's stated refusal, which
 * created nothing; `uncertain` is everything an answer could not settle.
 */
export const BrowserUseWriteSchema = z
  .object({
    operationId: OperationIdSchema,
    state: z.enum(["already_committed", "committed", "uncertain", "failed"]),
    code: z.enum(["ROOM_REPLY_REFUSED", "WRITE_REFUSED"]).optional(),
    externalUrn: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
    rateLimited: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.code && value.state !== "failed") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "refusal codes require a failed write", path: ["code"] });
    }
    if ((value.state === "committed" || value.state === "already_committed") && !value.externalUrn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.state} writes require an externalUrn`,
        path: ["externalUrn"],
      });
    }
    if ((value.state === "uncertain" || value.state === "failed") && !value.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.state} writes require an error`,
        path: ["error"],
      });
    }
  });

export type BrowserUseWrite = z.infer<typeof BrowserUseWriteSchema>;

const WriteSuccessSchema = z
  .object({
    ...successBase("write"),
    result: BrowserUseWriteSchema,
  })
  .strict();

const ReconcilePostedSuccessSchema = z
  .object({
    ...successBase("reconcile_posted"),
    result: z
      .object({
        operationId: OperationIdSchema,
        externalUrn: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

/** "liked" = this call pressed it; "already_liked" = it was pressed before we
 *  arrived. Both are success — the caller must not treat the second as a retry
 *  to attempt, because pressing again would UNLIKE the post. */
const LikePostSuccessSchema = z
  .object({
    ...successBase("like_post"),
    result: z
      .object({ outcome: z.enum(["liked", "already_liked"]) })
      .strict(),
  })
  .strict();

/** Same toggle contract as like_post, on a comment row: "already_liked" is
 *  success, never a retry — pressing again would UNLIKE the comment. */
const LikeCommentSuccessSchema = z
  .object({
    ...successBase("like_comment"),
    result: z
      .object({ outcome: z.enum(["liked", "already_liked"]) })
      .strict(),
  })
  .strict();

/** The account's reaction to the action target as the post's document declares it
 *  (`like_data.py`): `Like`, `Default` for none, another reaction's name, or
 *  null where the document cannot tell — which is never "not liked" — and the
 *  account that was signed in as it was read. */
export const LikeStateReadSchema = z
  .object({
    reaction: z.string().min(1).max(64).nullable(),
    observedAt: UnixMsSchema,
    accountId: z.string().min(1).max(500).optional(),
  })
  .strict() satisfies z.ZodType<LikeStateRead>;

const ReadLikeStateSuccessSchema = z
  .object({
    ...successBase("read_like_state"),
    result: LikeStateReadSchema,
  })
  .strict();

/**
 * The verify reads, bounded where the snapshot is stored: a post's text at
 * 20,000 characters, a comment at a comment's own 1,250, an author's first
 * reply at 500, an About at 2,000, five recent posts. The sidecar truncates;
 * this refuses a sidecar that did not. The same bounds hold a host that reads
 * in its own browser and submits what it read through a prepared task.
 */
export const PostThreadSchema = z
  .object({
    postUrn: z.string().min(1),
    author: z.object({ profileId: z.string().min(1).max(500), name: z.string().min(1).max(500).optional(),
      headline: z.string().min(1).max(1000).optional(), isCompany: z.boolean() }).strict().optional(),
    fullText: z.string().max(20_000),
    mediaText: z.string().min(1).max(2_000).optional(),
    postedAt: UnixMsSchema.optional(),
    counts: z
      .object({
        reactions: z.number().int().nonnegative(),
        comments: z.number().int().nonnegative(),
        reposts: z.number().int().nonnegative(),
      })
      .strict(),
    comments: z
      .array(
        z
          .object({
            commentUrn: z.string().min(1),
            authorProfileId: z.string().min(1).optional(),
            memberUrn: MemberUrnSchema.optional(),
            authorIsCompany: z.boolean().optional(),
            authorName: z.string().min(1).optional(),
            authorHeadline: z.string().min(1).optional(),
            text: z.string().max(1_250),
            reactions: z.number().int().nonnegative(),
            authorReplied: z.boolean(),
            authorReplyText: z.string().min(1).max(500).optional(),
            isOwner: z.boolean(),
          })
          .strict(),
      )
      .max(MAX_THREAD_COMMENTS),
  })
  .strict();

export const AuthorProfileReadSchema = z
  .object({
    profileId: z.string().min(1),
    name: z.string().min(1).optional(),
    headline: z.string().min(1).optional(),
    about: z.string().min(1).max(2_000).optional(),
    currentRole: z
      .object({
        title: z.string().min(1).optional(),
        company: z.string().min(1).optional(),
        companySize: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    followers: z.number().int().nonnegative().optional(),
    /** Where the member is, from their profile's location: an ISO 3166-1
     *  alpha-2 code, and the geo it names. Never the profile's locale, which
     *  is the language it is written in. Absent when the profile names no
     *  location. */
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    geoUrn: z.string().regex(/^urn:li:fsd_geo:[0-9]+$/).optional(),
    recentPosts: z
      .array(
        z
          .object({
            postUrn: z.string().min(1),
            text: z.string().max(20_000),
            postedAt: UnixMsSchema.optional(),
          })
          .strict(),
      )
      .max(5),
    isCompanyPage: z.boolean(),
  })
  .strict();

/** A company's own page: its public data, bounded where it is stored. */
export const CompanyPageReadSchema = z
  .object({
    companyRef: z.string().min(1).max(500),
    name: z.string().min(1).max(500).optional(),
    size: z.string().min(1).max(200).optional(),
    industry: z.string().min(1).max(500).optional(),
    about: z.string().min(1).max(2_000).optional(),
    followers: z.number().int().nonnegative().optional(),
  })
  .strict();

const ReadPostThreadSuccessSchema = z
  .object({
    ...successBase("read_post_thread"),
    result: PostThreadSchema,
  })
  .strict();

/** The sidecar's own profile read, which also keeps the company page the
 *  member's current role links (`companyRef`): Deep's company read reads it. An
 *  agent's read handed in over MCP carries no such link. */
export const SidecarProfileReadSchema = AuthorProfileReadSchema.extend({
  currentRole: z
    .object({
      title: z.string().min(1).optional(),
      company: z.string().min(1).optional(),
      companySize: z.string().min(1).optional(),
      companyRef: z.string().min(1).max(500).optional(),
    })
    .strict()
    .optional(),
}).strict();

const ReadAuthorProfileSuccessSchema = z
  .object({
    ...successBase("read_author_profile"),
    result: SidecarProfileReadSchema,
  })
  .strict();

const ReadCompanyPageSuccessSchema = z
  .object({
    ...successBase("read_company_page"),
    result: CompanyPageReadSchema,
  })
  .strict();

const TextHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The replies directly under one comment we posted. A reply is bounded where
 * a comment can be — 3,000 UTF-16 units, the sidecar fails a longer body as
 * drift rather than truncating it — and a read that did not find our comment
 * carries no replies. A read of LinkedIn's comment data says nothing of our
 * comment's author or words (`authorIsSelf: null`, no `textHash`).
 */
export const CommentRepliesReadSchema = z
  .object({
    comment: z.discriminatedUnion("present", [
      z
        .object({
          present: z.literal(true),
          urn: z.string().min(1),
          resolvedId: z.string().min(1),
          authorIsSelf: z.boolean().nullable(),
          textHash: TextHashSchema.optional(),
          replyCount: z.number().int().nonnegative().nullable(),
          replyRows: z.number().int().nonnegative(),
          repliesFrom: z.enum(["comment_data", "page_data", "markup"]).optional(),
          reactionCount: z.number().int().nonnegative().optional(),
        })
        .strict(),
      z.object({ present: z.literal(false), urn: z.string().min(1) }).strict(),
    ]),
    replies: z
      .array(
        z
          .object({
            replyUrn: z.string().min(1),
            author: z
              .object({
                profileId: z.string().min(1),
                displayName: z.string().min(1).max(200).optional(),
                profileUrl: z.string().min(1),
                isSelf: z.boolean(),
                memberUrn: MemberUrnSchema.optional(),
              })
              .strict(),
            text: z.string().min(1).max(3_000),
            textHash: TextHashSchema,
            postedAt: UnixMsSchema.optional(),
            observedAt: UnixMsSchema,
            isDirectChild: z.boolean(),
          })
          .strict(),
      )
      .max(MAX_COMMENT_REPLIES),
    truncated: z.boolean(),
    pageFingerprint: z.string().min(1).max(64),
    selectorPack: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.comment.present && value.replies.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a comment the read did not find has no replies",
        path: ["replies"],
      });
    }
  }) satisfies z.ZodType<CommentRepliesRead>;

const ReadCommentRepliesSuccessSchema = z
  .object({
    ...successBase("read_comment_replies"),
    result: CommentRepliesReadSchema,
  })
  .strict();

/** The most cards one page of notifications may carry: ten a page, read live,
 *  with room for a page LinkedIn sizes differently. */
const MAX_NOTIFICATION_CARDS = 100;

const CommentUrnSchema = z
  .string()
  .regex(/^urn:li:comment:\((?:activity|ugcPost|share):[A-Za-z0-9_-]+,[A-Za-z0-9_-]+\)$/);

/**
 * One page of the account's notification cards: the cards about a comment,
 * each anchored on LinkedIn's own urns. A reply's words are bounded where a
 * comment's are; a reaction carries none.
 */
export const NotificationsReadSchema = z
  .object({
    cards: z
      .array(
        z
          .object({
            kind: z.enum(["reply", "reaction", "mention"]),
            type: z.string().regex(/^[A-Z0-9_]{1,128}$/),
            commentUrn: CommentUrnSchema,
            postUrn: z.string().regex(/^urn:li:(?:activity|ugcPost|share):[A-Za-z0-9_-]+$/),
            publishedAt: UnixMsSchema,
            aggregated: z.boolean(),
            replyUrn: CommentUrnSchema.optional(),
            replyText: z.string().min(1).max(3_000).optional(),
            actor: z
              .object({
                profileId: z.string().min(1).max(1_000),
                profileUrl: z.string().url().max(1_000),
                displayName: z.string().min(1).max(200).optional(),
                memberUrn: MemberUrnSchema.optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .superRefine((card, ctx) => {
            if (card.kind !== "reply" && card.replyText !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "only a reply card carries a reply's words",
                path: ["replyText"],
              });
            }
          }),
      )
      .max(MAX_NOTIFICATION_CARDS),
    listed: z.number().int().nonnegative(),
    oldestPublishedAt: UnixMsSchema.nullable(),
    nextStart: z.number().int().positive().nullable(),
    pageFingerprint: z.string().min(1).max(64),
    selectorPack: z.string().min(1).max(64),
  })
  .strict() satisfies z.ZodType<NotificationsRead>;

const ReadNotificationsSuccessSchema = z
  .object({
    ...successBase("read_notifications"),
    result: NotificationsReadSchema,
  })
  .strict();

/**
 * Where the account stands with one member, as LinkedIn's relationship data
 * for them — and their profile page's own data where that did not answer —
 * showed it. `"unknown"` is a value of every fact, and a note limit is never
 * a profile read's. The member's profile urn and number, the Connect on offer
 * and where their page's Connect leads are named where the data names them.
 */
export const RelationshipReadSchema = z
  .object({
    profile: z
      .object({
        id: z.string().min(1).max(1_000),
        url: z.string().url().max(1_000),
        displayName: z.string().min(1).max(200),
        verified: z.boolean(),
      })
      .strict(),
    degree: z.enum(["self", "1st", "2nd", "3rd+", "unknown"]),
    pending: z.enum(["none", "outgoing", "incoming", "unknown"]),
    note: z
      .object({
        supported: z.union([z.boolean(), z.literal("unknown")]),
        limitChars: z.number().int().positive().nullable(),
      })
      .strict(),
    profileUrn: MemberUrnSchema.optional(),
    memberId: z.string().regex(/^[0-9]{1,20}$/).optional(),
    invitation: z.enum(["connect", "pending", "withdrawn"]).optional(),
    connect: z
      .union([
        z.object({ composerUrl: z.string().url().max(1_000) }).strict(),
        z.enum(["instant", "other", "none"]),
      ])
      .optional(),
    detail: z.string().min(1).max(200).optional(),
    place: AuthorProfileReadSchema.pick({ country: true, geoUrn: true }).strict().optional(),
    observedAt: UnixMsSchema,
    sessionId: z.string().min(1).max(128),
    pageFingerprint: z.string().min(1).max(64),
    selectorPack: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.note.limitChars !== null && value.note.supported !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a note limit belongs to a composer that offers a note",
        path: ["note", "limitChars"],
      });
    }
  }) satisfies z.ZodType<RelationshipRead>;

const ReadRelationshipSuccessSchema = z
  .object({
    ...successBase("read_relationship"),
    result: RelationshipReadSchema,
  })
  .strict();

/**
 * The invitations people sent the account, as its invitations page's own data
 * lists them. A note is bounded where the sidecar bounds it — longer is drift
 * there, never truncated — and the list at the read's own limit.
 */
export const IncomingInvitationsReadSchema = z
  .object({
    invitations: z
      .array(
        z
          .object({
            invitationId: z.string().min(1).max(1_000),
            sender: z
              .object({
                profileId: z.string().min(1).max(1_000),
                url: z.string().url().max(1_000),
                displayName: z.string().min(1).max(200),
              })
              .strict(),
            note: z.string().min(1).max(2_000).optional(),
            receivedAt: UnixMsSchema.optional(),
            observedAt: UnixMsSchema,
          })
          .strict(),
      )
      .max(MAX_INCOMING_INVITATIONS),
    others: z.number().int().nonnegative(),
    complete: z.boolean(),
    otherInbox: z.boolean(),
    truncated: z.boolean(),
    observedAt: UnixMsSchema,
    sessionId: z.string().min(1).max(128),
    pageFingerprint: z.string().min(1).max(64),
    selectorPack: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    const senders = value.invitations.map((invitation) => invitation.sender.profileId);
    if (new Set(senders).size !== senders.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "one sender holds one pending invitation",
        path: ["invitations"],
      });
    }
  }) satisfies z.ZodType<IncomingInvitationsRead>;

const ReadIncomingInvitationsSuccessSchema = z
  .object({
    ...successBase("read_incoming_invitations"),
    result: IncomingInvitationsReadSchema,
  })
  .strict();

const DmParticipantSchema = z
  .object({
    profileId: z.string().min(1).max(1_000).nullable(),
    profileUrl: z.string().url().max(1_000).nullable(),
    displayName: z.string().min(1).max(200),
    memberUrn: MemberUrnSchema.optional(),
  })
  .strict();

/**
 * The inbox's conversation list, as LinkedIn's own conversation data carries
 * it. A person's profile is named only where LinkedIn links it. The last
 * message is its hash — and, where the list carries the message itself, its
 * id, words and author, all three or none.
 */
export const InboxReadSchema = z
  .object({
    threads: z
      .array(
        z
          .object({
            threadId: DmThreadIdSchema,
            participants: z.array(DmParticipantSchema).min(1).max(100),
            group: z.boolean(),
            lastMessage: z
              .object({
                textHash: TextHashSchema,
                fromSelf: z.boolean(),
                at: UnixMsSchema.nullable(),
                messageId: z.string().min(1).max(1_000).optional(),
                text: z.string().max(20_000).optional(),
                authorProfileId: z.string().min(1).max(1_000).nullable().optional(),
              })
              .strict(),
            unread: z.boolean(),
            unreadCount: z.number().int().min(0).max(100_000).optional(),
            lastReadAt: UnixMsSchema.nullable().optional(),
            hasDraft: z.boolean().optional(),
          })
          .strict(),
      )
      .max(MAX_INBOX_THREADS),
    truncated: z.boolean(),
    // Cards the reader could not read, skipped and never acted on; the reasons
    // are fixed sentences about structure, never page text.
    skipped: z.number().int().min(0).max(MAX_INBOX_THREADS).optional(),
    skippedReasons: z.array(z.string().min(1).max(200)).max(20).optional(),
    observedAt: UnixMsSchema,
    sessionId: z.string().min(1).max(128).optional(),
    pageFingerprint: z.string().min(1).max(64),
    selectorPack: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, thread] of value.threads.entries()) {
      if (seen.has(thread.threadId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a conversation is listed once",
          path: ["threads", index, "threadId"],
        });
      }
      seen.add(thread.threadId);
      const { messageId, text, authorProfileId } = thread.lastMessage;
      const carried = [messageId, text, authorProfileId].filter((value) => value !== undefined).length;
      if (carried !== 0 && carried !== 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a last message carries its id, words and author together, or none of them",
          path: ["threads", index, "lastMessage"],
        });
      }
      // LinkedIn counts a conversation unread exactly when it marks it so.
      if (thread.unreadCount !== undefined && thread.unreadCount > 0 && !thread.unread) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a conversation with unread messages is unread",
          path: ["threads", index, "unread"],
        });
      }
    }
  }) satisfies z.ZodType<InboxRead>;

const ReadInboxSuccessSchema = z
  .object({
    ...successBase("read_inbox"),
    result: InboxReadSchema,
  })
  .strict();

/**
 * One conversation as its own page showed it: every participant, the account
 * among them exactly once and by id, its messages oldest first with their
 * ids, and the composer as a hash. A thread two people are in names exactly
 * two. The account's own name may be empty — a thread it has written nothing
 * in shows none, and the sidecar invents none — but nobody else's may.
 */
/** What a read of one conversation carries, however it was read. */
const ConversationReadShape = z.object({
  threadId: DmThreadIdSchema,
  participants: z
    .array(
      DmParticipantSchema.extend({
        displayName: z.string().max(200),
        isSelf: z.boolean(),
      }).strict(),
    )
    .min(2)
    .max(100),
  group: z.boolean(),
  messages: z
    .array(
      z
        .object({
          messageId: z.string().min(1).max(1_000),
          fromSelf: z.boolean(),
          authorProfileId: z.string().min(1).max(1_000),
          text: z.string().max(20_000),
          textHash: TextHashSchema,
          sentAt: UnixMsSchema.nullable(),
          observedAt: UnixMsSchema,
        })
        .strict(),
    )
    .max(500),
  complete: z.boolean(),
  observedAt: UnixMsSchema,
  sessionId: z.string().min(1).max(128),
  pageFingerprint: z.string().min(1).max(64),
  selectorPack: z.string().min(1).max(64),
});

/** What every read of a conversation holds to, however it was read: the
 *  account in it exactly once and by id, everyone else named, each message
 *  read once and the account's exactly when the account wrote it. */
function refineConversationRead(
  value: z.infer<typeof ConversationReadShape>,
  ctx: z.RefinementCtx,
): void {
  for (const [index, participant] of value.participants.entries()) {
    if (!participant.isSelf && participant.displayName.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "everyone but the account is named",
        path: ["participants", index, "displayName"],
      });
    }
  }
  const selves = value.participants.filter((participant) => participant.isSelf);
  const self = selves.length === 1 ? selves[0]!.profileId : null;
  if (self === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "the account is in its own conversation exactly once, by id",
      path: ["participants"],
    });
  }
  const ids = new Set<string>();
  for (const [index, message] of value.messages.entries()) {
    if (ids.has(message.messageId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a message is read once",
        path: ["messages", index, "messageId"],
      });
    }
    ids.add(message.messageId);
    if (message.fromSelf !== (message.authorProfileId === self)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a message is the account's exactly when the account wrote it",
        path: ["messages", index, "fromSelf"],
      });
    }
  }
}

/**
 * One conversation as its own page showed it: every participant, the account
 * among them exactly once and by id, its messages oldest first with their
 * ids, and the composer as a hash. A thread two people are in names exactly
 * two. The account's own name may be empty — a thread it has written nothing
 * in shows none, and the sidecar invents none — but nobody else's may.
 */
export const DmThreadReadSchema = ConversationReadShape.extend({
  composer: z.discriminatedUnion("hasDraft", [
    z.object({ hasDraft: z.literal(false) }).strict(),
    z.object({ hasDraft: z.literal(true), draftHash: TextHashSchema }).strict(),
  ]),
  markedSeen: z.literal(true).optional(),
  unreadRestore: z.enum(["restored", "unread_restore_unconfirmed"]).optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    // A restore answers for a conversation the read marked seen, and every
    // one it marked seen has one.
    if ((value.markedSeen === true) !== (value.unreadRestore !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an unread restore is reported exactly where the read marked the conversation seen",
        path: ["unreadRestore"],
      });
    }
    refineConversationRead(value, ctx);
  }) satisfies z.ZodType<DmThreadRead>;

/** One conversation's history, read without opening it: a conversation read
 *  with no composer, which only the page shows, and no more messages than
 *  two of LinkedIn's pages hold. */
export const ConversationHistorySchema = ConversationReadShape.extend({
  messages: ConversationReadShape.shape.messages.max(MAX_HISTORY_MESSAGES),
})
  .strict()
  .superRefine(refineConversationRead) satisfies z.ZodType<ConversationHistory>;

const ReadConversationMessagesSuccessSchema = z
  .object({
    ...successBase("read_conversation_messages"),
    result: ConversationHistorySchema,
  })
  .strict();

const ReadDmThreadSuccessSchema = z
  .object({
    ...successBase("read_dm_thread"),
    result: DmThreadReadSchema,
  })
  .strict();

/** The sidecar caps the agent reader's text at 30 KB of UTF-8
 *  (`agent_page.py`); its UTF-16 length can only be smaller. */
export const MAX_AGENT_PAGE_TEXT = 30_000;

/** One page as the agent reader's text. Everything but `text` is the
 *  sidecar's own word about the read; `text` is the page's. */
export const AgentPageSchema = z
  .object({
    intent: z.enum(["comment_replies", "inbox", "dm_thread"]),
    url: z.string().min(1).max(2_000),
    ownProfileUrl: z.string().min(1).max(1_000),
    text: z.string().max(MAX_AGENT_PAGE_TEXT),
    truncated: z.boolean(),
    observedAt: UnixMsSchema,
    sessionId: z.string().min(1).max(128),
    pageFingerprint: z.string().min(1).max(64),
    selectorPack: z.string().min(1).max(64),
  })
  .strict() satisfies z.ZodType<AgentPage>;

const ReadPageForAgentSuccessSchema = z
  .object({
    ...successBase("read_page_for_agent"),
    result: AgentPageSchema,
  })
  .strict();

/** Why the sidecar refused an invitation before anything was sent — the
 *  member as LinkedIn's data showed them, or a note LinkedIn would not carry.
 *  `connect_without_composer` named the composer the sidecar once pressed
 *  through; nothing sends it now, and a row that carries it still reads. */
export const INVITATION_REFUSALS = [
  "already_connected",
  "invitation_pending",
  "invitation_incoming",
  "recently_withdrawn",
  "relationship_unknown",
  "relationship_moved",
  "profile_unverified",
  "note_limit",
  "note_limit_unread",
  "note_unavailable",
  "connect_without_composer",
  "invitation_gated",
] as const;
export type InvitationRefusal = (typeof INVITATION_REFUSALS)[number];

const invitationBase = {
  operationId: OperationIdSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
};

/** What LinkedIn's answer to an invitation's one POST names: the invitation
 *  it created, when that answer came back, the note by hash, the browser
 *  session that sent it and the shape of the answer — no words. */
export const InvitationReceiptSchema = z
  .object({
    invitationUrn: z.string().regex(/^urn:li:fsd_invitation:[0-9]{1,30}$/),
    invitationId: z.string().regex(/^[0-9]{1,30}$/),
    sentAt: UnixMsSchema,
    noteHash: z.string().regex(/^[0-9a-f]{64}$/),
    sessionId: z.string().min(1).max(128),
    answerFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict() satisfies z.ZodType<InvitationReceipt>;

/**
 * What one sub-step of an invitation came to. `confirmed` is LinkedIn's answer naming the
 * invitation it created (`receipt`), with the read showing it pending where
 * one did, or — a resolve's — a read showing it out; `refused` is a refusal
 * before anything was sent; `blocked` is LinkedIn's stated refusal of the
 * POST; `resolved_not_sent` is a read finding Connect offered and nothing
 * pending for an attempt that never landed; `uncertain` is everything an
 * answer or a read could not settle.
 */
export const BrowserUseInvitationSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...invitationBase,
      state: z.literal("confirmed"),
      relationship: RelationshipReadSchema.nullable(),
      noteLimit: z.number().int().positive().nullable(),
      receipt: InvitationReceiptSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("refused"),
      reason: z.enum(INVITATION_REFUSALS),
      detail: z.string().min(1).max(500).optional(),
      noteLimit: z.number().int().positive().optional(),
      relationship: RelationshipReadSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("blocked"),
      reason: z.literal("refused_after_send"),
      detail: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("resolved_not_sent"),
      relationship: RelationshipReadSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("uncertain"),
      error: z.string().min(1).max(500),
      relationship: RelationshipReadSchema.nullable(),
    })
    .strict(),
]);

export type BrowserUseInvitation = z.infer<typeof BrowserUseInvitationSchema>;

const SendInvitationSuccessSchema = z
  .object({
    ...successBase("send_invitation"),
    result: BrowserUseInvitationSchema,
  })
  .strict();

/** Why the sidecar refused a withdrawal before anything was pressed — the
 *  member as the page showed them. */
export const WITHDRAWAL_REFUSALS = [
  "already_connected",
  "invitation_not_pending",
  "invitation_incoming",
  "relationship_unknown",
  "profile_unverified",
] as const;
export type WithdrawalRefusal = (typeof WITHDRAWAL_REFUSALS)[number];

/**
 * What one sub-step of a withdrawal came to. `confirmed` is a re-read
 * showing nothing pending — never the press; `refused` is a refusal before
 * anything was pressed; `blocked` is LinkedIn's refusal shown after Withdraw,
 * or a read showing them connected; `still_pending` is a resolve read still
 * showing our invitation pending; `resolved_not_sent` is an attempt that never
 * reached its press; `uncertain` is everything a read could not settle.
 */
export const BrowserUseWithdrawalSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...invitationBase,
      state: z.literal("confirmed"),
      relationship: RelationshipReadSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("refused"),
      reason: z.enum(WITHDRAWAL_REFUSALS),
      detail: z.string().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("blocked"),
      reason: z.enum(["refused_after_withdraw", "already_connected"]),
      detail: z.string().min(1).max(500),
      relationship: RelationshipReadSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("still_pending"),
      relationship: RelationshipReadSchema,
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("resolved_not_sent"),
      relationship: RelationshipReadSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("uncertain"),
      error: z.string().min(1).max(500),
      relationship: RelationshipReadSchema.nullable(),
    })
    .strict(),
]);

export type BrowserUseWithdrawal = z.infer<typeof BrowserUseWithdrawalSchema>;

const WithdrawInvitationSuccessSchema = z
  .object({
    ...successBase("withdraw_invitation"),
    result: BrowserUseWithdrawalSchema,
  })
  .strict();

/**
 * What one sub-step of an acceptance came to. `confirmed` is the sender's profile, read after the
 * press, showing them connected — never the press; `refused` is a refusal
 * before anything was pressed — the data no longer lists the request;
 * `blocked` is a read showing the request gone from a whole list and Connect
 * on offer: they withdrew it; `still_pending` is a resolve read still listing
 * the request, stamped with when the data was read; `resolved_not_sent` is an
 * attempt that never reached its press; `read_needed` is a resolve that
 * pressed no page because none was budgeted and the journal alone could not
 * answer; `uncertain` is everything a read could not settle.
 */
export const BrowserUseAcceptanceSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...invitationBase,
      state: z.literal("confirmed"),
      relationship: RelationshipReadSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("refused"),
      reason: z.literal("invitation_not_listed"),
      detail: z.string().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("blocked"),
      reason: z.literal("invitation_withdrawn"),
      detail: z.string().min(1).max(500),
      relationship: RelationshipReadSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("still_pending"),
      relationship: RelationshipReadSchema.nullable(),
      observedAt: UnixMsSchema,
    })
    .strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("resolved_not_sent"),
      relationship: RelationshipReadSchema.nullable(),
    })
    .strict(),
  z.object({ ...invitationBase, state: z.literal("read_needed") }).strict(),
  z
    .object({
      ...invitationBase,
      state: z.literal("uncertain"),
      error: z.string().min(1).max(500),
      relationship: RelationshipReadSchema.nullable(),
    })
    .strict(),
]);

export type BrowserUseAcceptance = z.infer<typeof BrowserUseAcceptanceSchema>;

const AcceptInvitationSuccessSchema = z
  .object({
    ...successBase("accept_invitation"),
    result: BrowserUseAcceptanceSchema,
  })
  .strict();

/** Why the sidecar refused a DM before anything was sent — the conversation
 *  as its read showed it. */
export const DM_REFUSALS = [
  "group_thread",
  "participants_mismatch",
  "thread_moved",
  "human_draft",
  "messaging_restricted",
] as const;
export type DmRefusal = (typeof DM_REFUSALS)[number];

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** What confirmed a DM: our message after the one it was written after —
 *  as LinkedIn's answer to the POST named it, or as a read of the
 *  conversation showed it — and the answer or read that showed it. */
export const DmReceiptSchema = z
  .object({
    messageId: z.string().min(1).max(1_000),
    sentAt: UnixMsSchema.nullable(),
    textHash: Sha256Schema,
    tailMessageId: z.string().min(1).max(1_000),
    observedAt: UnixMsSchema,
    sessionId: z.string().min(1).max(200),
    pageFingerprint: z.string().min(1).max(64),
  })
  .strict();

const dmBase = {
  operationId: OperationIdSchema,
  fingerprint: Sha256Schema,
};

/**
 * What one sub-step of a DM came to. `confirmed` is the message LinkedIn's answer to the POST says it created,
 * or a read of the conversation showing ours; `refused` is a refusal before
 * anything was sent; `blocked` is LinkedIn's refusal of the POST, its status
 * and words in `detail`; `resolved_not_sent` is an attempt the journal never
 * held as sending; `uncertain` is everything an answer or a read could not
 * settle, `error` saying what was seen and `absent` whether it was the
 * conversation's history whose newest message is still the one the DM was
 * written after — never a page read that did not show it.
 */
export const BrowserUseDmSchema = z.discriminatedUnion("state", [
  z.object({ ...dmBase, state: z.literal("confirmed"), receipt: DmReceiptSchema }).strict(),
  z
    .object({
      ...dmBase,
      state: z.literal("refused"),
      reason: z.enum(DM_REFUSALS),
      detail: z.string().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      ...dmBase,
      state: z.literal("blocked"),
      reason: z.literal("refused_after_send"),
      detail: z.string().min(1).max(500),
    })
    .strict(),
  z.object({ ...dmBase, state: z.literal("resolved_not_sent") }).strict(),
  z
    .object({
      ...dmBase,
      state: z.literal("uncertain"),
      error: z.string().min(1).max(500),
      absent: z.boolean().optional(),
      observedAt: UnixMsSchema.optional(),
    })
    .strict(),
]);

export type BrowserUseDm = z.infer<typeof BrowserUseDmSchema>;

/** Why the sidecar refused a first message before anything was sent: the
 *  member's profile, the account's conversations or the compose view as their
 *  data showed them (`dm_open.py`). */
export const OPEN_DM_REFUSALS = [
  "not_connected",
  "recipient_unverified",
  "message_unavailable",
  "conversation_exists",
  "conversation_unverified",
  "recipient_unbound",
  "messaging_restricted",
] as const;
export type OpenDmRefusal = (typeof OPEN_DM_REFUSALS)[number];

/** What confirmed a first message: our message, as a DM's receipt, in the
 *  conversation it opened. */
export const OpenDmReceiptSchema = DmReceiptSchema.extend({ threadId: DmThreadIdSchema }).strict();

/**
 * What one sub-step of a first message came to, as a DM's: `confirmed`
 * carries, beside the receipt, the new conversation's history — read where
 * LinkedIn's answer named it, or where the account's list led — which binds it
 * to the person; `uncertain`'s `absent` says the list, whole since the press,
 * held no conversation with them.
 */
export const BrowserUseOpenDmSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...dmBase,
      state: z.literal("confirmed"),
      receipt: OpenDmReceiptSchema,
      conversation: ConversationHistorySchema,
    })
    .strict(),
  z
    .object({
      ...dmBase,
      state: z.literal("refused"),
      reason: z.enum(OPEN_DM_REFUSALS),
      detail: z.string().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      ...dmBase,
      state: z.literal("blocked"),
      reason: z.literal("refused_after_send"),
      detail: z.string().min(1).max(500),
    })
    .strict(),
  z.object({ ...dmBase, state: z.literal("resolved_not_sent") }).strict(),
  z
    .object({
      ...dmBase,
      state: z.literal("uncertain"),
      error: z.string().min(1).max(500),
      absent: z.boolean().optional(),
      observedAt: UnixMsSchema.optional(),
    })
    .strict(),
]);

export type BrowserUseOpenDm = z.infer<typeof BrowserUseOpenDmSchema>;

const OpenDmSuccessSchema = z
  .object({
    ...successBase("open_dm"),
    result: BrowserUseOpenDmSchema,
  })
  .strict();

const SendDmSuccessSchema = z
  .object({
    ...successBase("send_dm"),
    result: BrowserUseDmSchema,
  })
  .strict();

export const BrowserUseResolvedWriteSchema = z.discriminatedUnion("state", [
  z
    .object({
      operationId: OperationIdSchema,
      state: z.literal("resolved_not_posted"),
      resolutionVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      operationId: OperationIdSchema,
      state: z.literal("already_committed"),
      resolutionVersion: z.number().int().nonnegative(),
      externalUrn: z.string().min(1),
    })
    .strict(),
]);

export type BrowserUseResolvedWrite = z.infer<
  typeof BrowserUseResolvedWriteSchema
>;

const ResolveWriteOutcomeSuccessSchema = z
  .object({
    ...successBase("resolve_write_outcome"),
    result: BrowserUseResolvedWriteSchema,
  })
  .strict();

/** `recorded` is the owner's answer in the entry (or an entry the sidecar
 *  settled the same way); `not_journaled` an attempt that never reached the
 *  journal, with nothing to close; `contradicted` an entry the sidecar settled
 *  the other way, which the caller holds for the owner. */
export const BrowserUseMemberWriteSettledSchema = z
  .object({
    operationId: OperationIdSchema,
    state: z.enum(["recorded", "not_journaled", "contradicted"]),
  })
  .strict();

export type BrowserUseMemberWriteSettled = z.infer<typeof BrowserUseMemberWriteSettledSchema>;

const SettleMemberWriteSuccessSchema = z
  .object({
    ...successBase("settle_member_write"),
    result: BrowserUseMemberWriteSettledSchema,
  })
  .strict();

/** `onScreen` is what the sidecar believes of its window now; `hideFailed`
 *  that the last hide found no mechanism that worked. */
const WindowVisibilityResultSchema = z
  .object({
    window: BrowserWindowSchema,
    onScreen: z.boolean(),
    hideFailed: z.boolean(),
  })
  .strict();

const SetWindowVisibilitySuccessSchema = z
  .object({
    ...successBase("set_window_visibility"),
    result: WindowVisibilityResultSchema,
  })
  .strict();

/** A restart answers as a reveal does: the window it brought up. */
const RestartBrowserSuccessSchema = z
  .object({
    ...successBase("restart_browser"),
    result: WindowVisibilityResultSchema,
  })
  .strict();

const CloseBrowserSuccessSchema = z
  .object({
    ...successBase("close_browser"),
    result: z.object({ ok: z.literal(true) }).strict(),
  })
  .strict();

const ShutdownSuccessSchema = z
  .object({
    ...successBase("shutdown"),
    result: z.object({ ok: z.literal(true) }).strict(),
  })
  .strict();

/** Where a read that refused to guess looked: the page's shape and the
 *  structure around the miss, with every word and identifier redacted. */
export const BrowserUseDiagnosticSchema = z
  .object({
    pageFingerprint: z.string().min(1).max(64),
    selectorPack: z.string().min(1).max(64),
    excerpt: z.string().max(4_096),
  })
  .strict();

export type BrowserUseDiagnostic = z.infer<typeof BrowserUseDiagnosticSchema>;

export const BrowserUseProtocolErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(4_096),
    retryable: z.boolean().optional(),
    rateLimited: z.boolean().optional(),
    /** The op refused before it pressed anything (a like's click): it did not
     *  go out. Set only where the sidecar knows the click was never evaluated. */
    notAttempted: z.boolean().optional(),
    diagnostic: BrowserUseDiagnosticSchema.optional(),
  })
  .strict();

const BrowserUseErrorResponseSchema = z
  .object({
    v: ProtocolVersionSchema,
    id: RequestIdSchema,
    op: BrowserUseOperationSchema,
    ok: z.literal(false),
    error: BrowserUseProtocolErrorSchema,
  })
  .strict();

export const BrowserUseSuccessResponseSchema = z.union([
  WarmBrowserSuccessSchema,
  EnsureSessionSuccessSchema,
  DiscoverPostsSuccessSchema,
  FetchOwnProfileSuccessSchema,
  FetchOwnPostsSuccessSchema,
  FetchOwnCommentsSuccessSchema,
  WriteSuccessSchema,
  ReconcilePostedSuccessSchema,
  ResolveWriteOutcomeSuccessSchema,
  SettleMemberWriteSuccessSchema,
  LikePostSuccessSchema,
  LikeCommentSuccessSchema,
  ReadLikeStateSuccessSchema,
  ReadPostThreadSuccessSchema,
  ReadAuthorProfileSuccessSchema,
  ReadCompanyPageSuccessSchema,
  ReadCommentRepliesSuccessSchema,
  ReadNotificationsSuccessSchema,
  ReadRelationshipSuccessSchema,
  ReadIncomingInvitationsSuccessSchema,
  AcceptInvitationSuccessSchema,
  ReadInboxSuccessSchema,
  ReadDmThreadSuccessSchema,
  ReadConversationMessagesSuccessSchema,
  ReadPageForAgentSuccessSchema,
  SendInvitationSuccessSchema,
  WithdrawInvitationSuccessSchema,
  SendDmSuccessSchema,
  OpenDmSuccessSchema,
  SetWindowVisibilitySuccessSchema,
  RestartBrowserSuccessSchema,
  CloseBrowserSuccessSchema,
  ShutdownSuccessSchema,
]);

export const BrowserUseResponseSchema = z.union([
  BrowserUseSuccessResponseSchema,
  BrowserUseErrorResponseSchema,
]);

/** The sole unsolicited stdout frame, emitted once after Python initialization. */
export const BrowserUseReadyEventSchema = z
  .object({
    v: ProtocolVersionSchema,
    event: z.literal("ready"),
    protocol: z.literal("engager.browser-use"),
    protocolVersion: ProtocolVersionSchema,
    sidecarVersion: z.string().min(1).max(64),
    cdpUseVersion: z.literal(CDP_USE_PACKAGE_VERSION),
    selectorPackVersion: z.literal(BROWSER_USE_SELECTOR_PACK_VERSION),
  })
  .strict();

export type BrowserUseSuccessResponse = z.infer<
  typeof BrowserUseSuccessResponseSchema
>;
export type BrowserUseErrorResponse = z.infer<
  typeof BrowserUseErrorResponseSchema
>;
export type BrowserUseResponse = z.infer<typeof BrowserUseResponseSchema>;
export type BrowserUseReadyEvent = z.infer<typeof BrowserUseReadyEventSchema>;
export type BrowserUseSuccessResponseFor<Op extends BrowserUseOperation> =
  Extract<BrowserUseSuccessResponse, { op: Op }>;
