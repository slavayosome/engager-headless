import { and, eq, ne, or } from "drizzle-orm";
import {
  discoveredPosts,
  incomingComments,
  messages,
  type IncomingComment,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { DraftConversation } from "./dispatcher/types";
import { config } from "./config";

/**
 * Everything a reply DECISION needs: what the post said, what WE said and why,
 * how the conversation has gone so far, and how much reply budget remains.
 * Shared by the dispatcher's reply writer, the server triage
 * (processIncoming), and the agent loop (list_people) so both
 * drafting paths reason from the same picture.
 */
export type ReplyThreadContext = {
  /** The post the conversation lives on. isOurs=true → the user's own post. */
  post?: { text: string; authorName?: string; url?: string; isOurs: boolean };
  /** OUR root comment on a discovered post + the agent's stored rationale. */
  ourComment?: { text: string; rationale?: string; postedAt?: number };
  /** Prior turns in THIS conversation (both sides), oldest first. Excludes
   *  the incoming comment being handled. */
  exchanges: { who: "them" | "us"; text: string; at?: number }[];
  /** OUR posted replies in this conversation — counted exactly like the
   *  post-time depth caps (status='posted' only) so triage math always agrees
   *  with the gate. */
  repliesUsed: number;
  repliesBudget: number;
  /** True → the reply being considered is our LAST budgeted one: close the
   *  conversation (statement, no question). */
  finalReply: boolean;
  /** True → the budget is already spent: don't draft at all (dismiss/react). */
  capReached: boolean;
};

/**
 * A thread as the dispatcher reads it: the post, the owner's comment under it
 * and every exchange since, oldest first, then the words answered. `before` is
 * anything else the owner knows they said, earlier, in the person's own words.
 */
export function threadConversation(
  words: { text: string; authorName: string | null; postedAt: number | null },
  thread: ReplyThreadContext | undefined,
  before: readonly string[] = [],
): Pick<DraftConversation, "post" | "turns"> {
  const author = { speaker: "author" as const, name: words.authorName };
  const owner = { speaker: "owner" as const, name: null };
  const turns = [
    ...before.map((text) => ({ ...author, text: `In another thread: ${text}` })),
    ...(thread?.post ? [{ speaker: thread.post.isOurs ? ("owner" as const) : ("other" as const), name: thread.post.authorName ?? null, text: thread.post.text }] : []),
    ...(thread?.ourComment ? [{ ...owner, text: thread.ourComment.text }] : []),
    ...(thread?.exchanges ?? []).map((turn) => ({ ...(turn.who === "us" ? owner : author), text: turn.text })),
  ].filter((turn) => turn.text.length > 0);
  return {
    post: { discoveredPostId: null, authorName: words.authorName, postedAt: words.postedAt, text: words.text, mediaText: null },
    turns,
  };
}

/** The conversation-scoping condition — MUST mirror the post-time depth caps
 *  in `actions/reply.ts` (thread: same root urn; own_post: same post+comment author).
 *  Null identity returns undefined = unscopeable → fail open, like the caps. */
function conversationScope(
  inc: IncomingComment,
  rootDiscoveredPostId?: number,
  rootOwnCommentUrn?: string,
) {
  if (inc.source === "our_comment_thread") {
    if (inc.discoveredPostId && rootDiscoveredPostId) {
      return and(
        eq(incomingComments.organizationId, inc.organizationId),
        eq(incomingComments.source, "our_comment_thread"),
        eq(incomingComments.discoveredPostId, rootDiscoveredPostId),
      );
    }
    const rootUrn = rootOwnCommentUrn ?? inc.threadParentUrn;
    if (!rootUrn) return undefined;
    return and(
      eq(incomingComments.organizationId, inc.organizationId),
      or(
        eq(incomingComments.threadParentUrn, rootUrn),
        and(
          eq(incomingComments.source, "own_post"),
          eq(incomingComments.commentUrn, rootUrn),
        ),
      ),
    );
  }
  if (!inc.authorProfileId) return undefined;
  return and(
    eq(incomingComments.organizationId, inc.organizationId),
    eq(incomingComments.source, "own_post"),
    eq(incomingComments.ownPostUrn, inc.ownPostUrn),
    eq(incomingComments.authorProfileId, inc.authorProfileId),
  );
}

export async function assembleReplyContext(
  db: Tx,
  inc: IncomingComment,
): Promise<ReplyThreadContext> {
  const budget = config.threadReplyDepthCap;

  // --- The post + our root comment -----------------------------------------
  let post: ReplyThreadContext["post"];
  let ourComment: ReplyThreadContext["ourComment"];
  let rootDiscoveredPostId = inc.discoveredPostId ?? undefined;
  let rootOwnIncoming: IncomingComment | undefined;
  let rootMessage:
    | {
        proposedText: string;
        finalText: string | null;
        trace: (typeof messages.$inferSelect)["trace"];
        postedAt: number | null;
        discoveredPostId: number | null;
      }
    | undefined;
  if (inc.source === "our_comment_thread") {
    // Follow direct parent links first. A watched reply points to the inbound
    // row it answered, so walking those pairs reaches either a discovered-post
    // root comment or a top-level comment on our own post.
    let parentMessageId = inc.parentMessageId;
    const seen = new Set<number>();
    while (parentMessageId && !seen.has(parentMessageId)) {
      seen.add(parentMessageId);
      const [parent] = await db
        .select({
          kind: messages.kind,
          incomingCommentId: messages.incomingCommentId,
          proposedText: messages.proposedText,
          finalText: messages.finalText,
          trace: messages.trace,
          postedAt: messages.postedAt,
          discoveredPostId: messages.discoveredPostId,
          roomReplyTarget: messages.roomReplyTarget,
        })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, inc.organizationId),
            eq(messages.id, parentMessageId),
          ),
        );
      if (!parent) break;
      if (parent.discoveredPostId) rootDiscoveredPostId = parent.discoveredPostId;
      if (parent.kind === "comment" || parent.kind === "room_reply") {
        rootMessage = parent;
        // A reply under a lead's comment has no post row to read the post from.
        if (parent.kind === "room_reply") {
          const target = parent.roomReplyTarget;
          rootDiscoveredPostId = target?.source === "lead" ? undefined : target?.discoveredPostId;
        }
        break;
      }
      if (!parent.incomingCommentId) break;
      const [parentIncoming] = await db
        .select()
        .from(incomingComments)
        .where(
          and(
            eq(incomingComments.organizationId, inc.organizationId),
            eq(incomingComments.id, parent.incomingCommentId),
          ),
        );
      if (!parentIncoming) break;
      if (parentIncoming.discoveredPostId) {
        rootDiscoveredPostId = parentIncoming.discoveredPostId;
      }
      if (parentIncoming.source === "own_post") {
        rootOwnIncoming = parentIncoming;
        break;
      }
      parentMessageId = parentIncoming.parentMessageId;
    }

    if (!rootMessage && rootDiscoveredPostId) {
      [rootMessage] = await db
        .select({
          proposedText: messages.proposedText,
          finalText: messages.finalText,
          trace: messages.trace,
          postedAt: messages.postedAt,
          discoveredPostId: messages.discoveredPostId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, inc.organizationId),
            eq(messages.kind, "comment"),
            eq(messages.discoveredPostId, rootDiscoveredPostId),
          ),
        );
    }

    // Historical NOT VALID rows may lack direct links. Keep the old URN path,
    // but make tenant identity explicit instead of trusting a globally-shaped URN.
    if (!rootMessage && inc.threadParentUrn) {
      [rootMessage] = await db
        .select({
          proposedText: messages.proposedText,
          finalText: messages.finalText,
          trace: messages.trace,
          postedAt: messages.postedAt,
          discoveredPostId: messages.discoveredPostId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, inc.organizationId),
            eq(messages.externalUrn, inc.threadParentUrn),
            eq(messages.kind, "comment"),
          ),
        );
      if (rootMessage?.discoveredPostId) {
        rootDiscoveredPostId = rootMessage.discoveredPostId;
      }
    }
    if (!rootOwnIncoming && !rootDiscoveredPostId && inc.threadParentUrn) {
      [rootOwnIncoming] = await db
        .select()
        .from(incomingComments)
        .where(
          and(
            eq(incomingComments.organizationId, inc.organizationId),
            eq(incomingComments.source, "own_post"),
            eq(incomingComments.commentUrn, inc.threadParentUrn),
          ),
        );
    }

    const text = rootMessage?.finalText ?? rootMessage?.proposedText;
    if (rootMessage && text) {
      ourComment = {
        text,
        rationale: rootMessage.trace?.client?.declared?.rationale,
        postedAt: rootMessage.postedAt ?? undefined,
      };
    }
    if (rootDiscoveredPostId) {
      const [p] = await db
        .select({
          contentText: discoveredPosts.contentText,
          authorName: discoveredPosts.authorName,
          url: discoveredPosts.url,
        })
        .from(discoveredPosts)
        .where(
          and(
            eq(discoveredPosts.organizationId, inc.organizationId),
            eq(discoveredPosts.id, rootDiscoveredPostId),
          ),
        );
      if (p?.contentText) {
        post = {
          text: p.contentText,
          authorName: p.authorName ?? undefined,
          url: p.url ?? undefined,
          isOurs: false,
        };
      }
    } else if (rootOwnIncoming?.postText) {
      post = { text: rootOwnIncoming.postText, isOurs: true };
    }
  } else if (inc.postText) {
    post = { text: inc.postText, isOurs: true };
  }

  // --- Prior exchanges + reply budget ---------------------------------------
  const scope = conversationScope(
    inc,
    rootDiscoveredPostId,
    rootOwnIncoming?.commentUrn,
  );
  const exchanges: ReplyThreadContext["exchanges"] = [];
  let repliesUsed = 0;
  if (scope) {
    const theirs = await db
      .select({
        text: incomingComments.text,
        at: incomingComments.receivedAt,
      })
      .from(incomingComments)
      .where(and(scope, ne(incomingComments.id, inc.id)));
    const ours = await db
      .select({
        proposedText: messages.proposedText,
        finalText: messages.finalText,
        at: messages.postedAt,
      })
      .from(messages)
      .innerJoin(incomingComments, eq(messages.incomingCommentId, incomingComments.id))
      .where(and(eq(messages.kind, "reply"), eq(messages.status, "posted"), scope));
    repliesUsed = ours.length;
    for (const t of theirs) {
      // Only PRIOR turns belong in the transcript (a sibling that arrived
      // after the one being handled isn't context for it).
      if (t.at <= inc.receivedAt) exchanges.push({ who: "them", text: t.text, at: t.at });
    }
    for (const o of ours) {
      const text = o.finalText ?? o.proposedText;
      exchanges.push({ who: "us", text, at: o.at ?? undefined });
    }
    exchanges.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }

  return {
    post,
    ourComment,
    exchanges,
    repliesUsed,
    repliesBudget: budget,
    finalReply: repliesUsed + 1 >= budget,
    capReached: repliesUsed >= budget,
  };
}

/** Compact text rendering shared by the server writer's user turn and any
 *  human-facing surface that wants the transcript. */
export function renderExchanges(
  exchanges: ReplyThreadContext["exchanges"],
): string {
  return exchanges
    .map((e) => `${e.who === "us" ? "YOU" : "THEM"}: ${e.text}`)
    .join("\n");
}
