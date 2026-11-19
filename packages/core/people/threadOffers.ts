import { sql, type SQL } from "drizzle-orm";
import type { MessageLikeOutcome } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { boxKey, composerFor, type ComposerAngle } from "../composer/drafts";
import { closedPeople } from "../conversations/read";
import { commentId } from "../linkedin/commentThread";
import { normalizePostUrn } from "../linkedin/postUrn";
import type { PersonRoom } from "../rooms/person";
import { ownerCommentMode, ownerReplyMode, replyCampaign } from "../operations/clientDrafting";
import { getChannelWriteAuthority } from "../operations/orgSettings";
import { roomOnly, type JoinLens } from "../rooms/presentation";
import type { PersonThread } from "./threads";

/**
 * WHAT THE OWNER CAN DO THEMSELVES ON A PERSON'S THREAD — Like post and
 * Comment on their post; Like reply and Reply on their reply under our
 * comment; Like on their comment in a room — and where a like on each already
 * stands.
 *
 * Each is offered only where the operation its press calls would take it:
 * Comment where `saveOwnerComment` would — no comment of ours on the post
 * but a draft the owner skipped — with the angles its box holds
 * (`composerFor`), and not on a room-only post (`roomOnly`), whose author
 * isn't the audience: the owner answers the people in its comments instead;
 * Reply where `saveOwnerReply` would, on a campaign that takes the owner's
 * press — with the angles its box holds too; a like where
 * `ownerLike` would — an action target the server can name, on such a campaign, that
 * no like of ours has reached or is on its way to; their comment in a room,
 * only where they fit and were not skipped. A paused campaign takes it
 * (Pause only stops new runs); an archived one does not. Nothing is offered on
 * someone whose conversation is closed (`closedPeople`), on the list or not.
 * What a block at the bottom of the thread already offers is the caller's to
 * leave out (`person-threads.tsx`).
 *
 * A like stands where the rows that carry likes say: a like on the action
 * ledger, the like a comment or reply of ours carried. A like
 * landed outranks one unsure, which outranks one on its way: a like never
 * comes off.
 *
 * Reads only, inside the caller's `withOrg`; every table read is under RLS.
 */

/** Where a like on one target stands: offered; waiting for a yes in a block
 *  of its own; on its way; landed on its own, or with a send of ours, whose
 *  event says so; pressed with nobody able to say whether it landed; or
 *  settled not liked because what it was on is gone. */
export type ThreadLike = "offer" | "waiting" | "liking" | "liked" | "carried" | "checking" | "gone";

/** What saving the owner's words there does: send, wait for a yes, or
 *  record and send nothing. */
export type ThreadSaveMode = ReturnType<typeof ownerReplyMode>;

export type ThreadOffer = {
  /** Their post, where the thread is about one Engager discovered. Its like
   *  is null where none can be aimed at it and none stands; its comment box,
   *  with the angles it holds, where Comment is offered. */
  post: {
    postId: number;
    like: ThreadLike | null;
    comment: { box: string; angles: ComposerAngle[] } | null;
    saveMode: ThreadSaveMode;
  } | null;
  /** Their comment in the room under the post they were spotted in, where the
   *  thread read one: the room member it was read from, and where a like of it
   *  stands — offered only where they fit and were not skipped. Absent where
   *  there is no room comment to like. */
  room?: { roomMemberId: number; like: ThreadLike };
  /** Their replies on it, by id. Its reply box, with the angles it holds,
   *  where Reply is offered. */
  replies: Record<
    number,
    {
      like: ThreadLike | null;
      reply: { box: string; angles: ComposerAngle[] } | null;
      saveMode: ThreadSaveMode;
    }
  >;
};

/** The strongest word on an action target first: a like never comes off. */
const RANK: readonly ThreadLike[] = ["carried", "liked", "checking", "liking", "waiting", "gone"];

/** A ledger like's status as the thread reads it. */
const LEDGER: Readonly<Record<string, ThreadLike>> = {
  awaiting_review: "waiting",
  approved: "liking",
  reserved: "liking",
  dispatching: "liking",
  confirmed: "liked",
  uncertain: "checking",
};

/** Why a ledger like settled without a click because its reply is gone. */
const GONE = new Set(["reply_gone", "parent_gone"]);

/** A reply of theirs, with ours above it and our answer to it, as a like of
 *  it would aim and the owner's own answer would take it. */
type ReplyRow = {
  id: number;
  source: "own_post" | "our_comment_thread";
  status: "new" | "reply_proposed" | "replied" | "ignored" | "dismissed";
  removed_at: number | null;
  comment_urn: string;
  author_profile_id: string | null;
  replied_to: string | null;
  campaign_id: number | null;
  campaign_pressable: boolean;
  answer_status: string | null;
  answer_campaign_id: number | null;
};

type PostRow = {
  id: number;
  post_urn: string;
  author_profile_id: string | null;
  campaign_status: "active" | "paused" | "archived" | null;
  pressable: boolean;
  commented: boolean;
  /** The confirmed read's, where Research confirmed the post. */
  join_lens: JoinLens | null;
  author_fit: "fits" | "maybe" | "not" | null;
};

/** `column in (…)`, or false for none. */
function inList(column: string, values: readonly (number | string)[]): SQL {
  return values.length === 0
    ? sql`false`
    : sql`${sql.raw(column)} in (${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )})`;
}

/** an action target's key as the ledger's reaction key names it (`actions/keys.ts`). */
const postKey = (urn: string) => `post:${normalizePostUrn(urn)}`;
const replyKey = (urn: string) => `their_reply:${commentId(urn)}`;
const roomKey = (urn: string) => `room_comment:${commentId(urn)}`;

/** Whether `saveOwnerReply` takes the owner's words for this reply: nothing
 *  of ours answers it, or only a draft that waits or was turned down. A reply
 *  let go — Reply Off, or dismissed — is taken up again by the owner's own
 *  answer. */
function answerable(reply: ReplyRow): boolean {
  if (reply.removed_at !== null) return false;
  return reply.answer_status === null
    ? reply.status === "new" || reply.status === "ignored" || reply.status === "dismissed"
    : (reply.status === "new" || reply.status === "reply_proposed") &&
        (reply.answer_status === "proposed" || reply.answer_status === "rejected");
}

/** What a thread's offers are read from: the post it is on, and the replies
 *  and messages on it, and the room comment they were spotted by. A post
 *  nothing of ours is on has no thread, and is offered from just these. */
export type OfferedThread = Pick<PersonThread, "key" | "kind" | "postUrn" | "messageIds" | "replyIds"> & {
  room?: Pick<PersonRoom, "roomMemberId" | "campaignId" | "parentCommentUrn" | "fit" | "skipped">;
};

export async function readThreadOffers(
  tx: Tx,
  threads: readonly OfferedThread[],
): Promise<Record<string, ThreadOffer>> {
  if (threads.length === 0) return {};
  const postIds = threads.flatMap((thread) =>
    thread.kind === "their_post" && thread.key.startsWith("post:") ? [Number(thread.key.slice(5))] : [],
  );
  const posts = (
    await tx.execute(sql`
      select post.id::float8 as id, post.post_urn, nullif(post.author_profile_id, '') as author_profile_id,
        campaign.status as campaign_status,
        coalesce(campaign.status <> 'archived', false) as pressable,
        exists (
          select 1 from messages comment
          where comment.kind = 'comment' and comment.discovered_post_id = post.id and comment.status <> 'rejected'
        ) as commented,
        research.join_lens, research.author_fit
      from discovered_posts post
      left join campaigns campaign on campaign.id = post.campaign_id
      left join candidate_research research on research.discovered_post_id = post.id and research.verdict = 'confirmed'
      where ${inList("post.id", postIds)}`)
  ).rows as PostRow[];
  const replies = (
    await tx.execute(sql`
      select reply.id::float8 as id, reply.source, reply.status, reply.removed_at::float8 as removed_at,
        reply.comment_urn, nullif(reply.author_profile_id, '') as author_profile_id,
        coalesce(reply.thread_parent_urn, ours.external_urn) as replied_to,
        reply.campaign_id::float8 as campaign_id, coalesce(campaign.status <> 'archived', false) as campaign_pressable,
        answer.status as answer_status, answer.campaign_id::float8 as answer_campaign_id
      from incoming_comments reply
      left join messages ours on ours.id = reply.parent_message_id
      left join messages answer on answer.incoming_comment_id = reply.id
      left join campaigns campaign on campaign.id = coalesce(reply.campaign_id, ours.campaign_id)
      where ${inList("reply.id", threads.flatMap((thread) => thread.replyIds))}`)
  ).rows as ReplyRow[];

  const rooms = threads.flatMap((thread) => (thread.room?.parentCommentUrn ? [thread.room] : []));
  // A room comment is liked from a campaign that still sends: not an archived one.
  const sending =
    rooms.length === 0
      ? []
      : ((
          await tx.execute(sql`
            select id::float8 as id from campaigns
            where status <> 'archived' and ${inList("id", rooms.map((room) => room.campaignId))}`)
        ).rows as Array<{ id: number }>);
  const roomSends = new Set(sending.map((campaign) => campaign.id));

  // Every word on a like of these targets, by the action target's key.
  const said = new Map<string, ThreadLike[]>();
  const say = (key: string, like: ThreadLike | null) => {
    if (like !== null) said.set(key, [...(said.get(key) ?? []), like]);
  };
  const ledger = (
    await tx.execute(sql`
      select action.status, coalesce(action.external_receipt->>'reason', action.status_reason) as reason,
        action.target->>'kind' as kind, action.target->>'id' as target_id
      from actions action
      where action.kind = 'like_target' and ${inList("action.target->>'id'", [
        ...posts.map((post) => normalizePostUrn(post.post_urn)),
        ...replies.map((reply) => commentId(reply.comment_urn)),
        ...rooms.map((room) => commentId(room.parentCommentUrn!)),
      ])}`)
  ).rows as Array<{ status: string; reason: string | null; kind: string; target_id: string }>;
  for (const row of ledger) {
    const gone = row.status === "blocked" && GONE.has(row.reason ?? "");
    say(`${row.kind}:${row.target_id}`, LEDGER[row.status] ?? (gone ? "gone" : null));
  }
  const replyUrns = new Map(replies.map((reply) => [reply.id, reply.comment_urn] as const));
  const sends = (
    await tx.execute(sql`
      select m.kind, m.incoming_comment_id::float8 as incoming_comment_id, post.post_urn, m.like_outcome
      from messages m
      left join discovered_posts post on post.id = m.discovered_post_id
      where m.like_outcome is not null and ${inList("m.id", threads.flatMap((thread) => thread.messageIds))}`)
  ).rows as Array<{
    kind: "comment" | "reply";
    incoming_comment_id: number | null;
    post_urn: string | null;
    like_outcome: MessageLikeOutcome;
  }>;
  for (const send of sends) {
    const on =
      send.kind === "comment"
        ? send.post_urn
        : send.incoming_comment_id === null
          ? undefined
          : replyUrns.get(send.incoming_comment_id);
    if (!on) continue;
    const { state } = send.like_outcome;
    say(
      send.kind === "comment" ? postKey(on) : replyKey(on),
      state === "liked" ? "carried" : state === "unconfirmed" ? "checking" : null,
    );
  }
  const standing = (key: string) => RANK.find((like) => said.get(key)?.includes(like)) ?? null;

  const closed = await closedPeople(
    tx,
    [...posts.map((post) => post.author_profile_id), ...replies.map((reply) => reply.author_profile_id)].filter(
      (author) => author !== null,
    ),
  );
  /** Whether the owner may be offered anything on what this author wrote. */
  const open = (author: string | null) => author === null || !closed.has(author);
  const writes = await getChannelWriteAuthority(tx);
  const commentBox = (post: PostRow) => boxKey({ kind: "comment", discoveredPostId: post.id });
  const commentable = posts.filter(
    (post) => post.pressable && !post.commented && !roomOnly({ joinLens: post.join_lens, authorFit: post.author_fit }),
  );
  const composers = await composerFor(tx, commentable.map(commentBox));
  // Only a reply under our comment is liked from here, and only one by
  // someone a read named can be read back before the click
  // (`likeTarget.ts`). It is answered from here too, and so is a comment on
  // the owner's own post that came back while Reply was Off: no block of its
  // own asks the owner for it, so this box is the only way to answer it by
  // hand.
  const underOurs = (reply: ReplyRow) => reply.source === "our_comment_thread" && reply.replied_to !== null;
  const answerableReplies = replies.filter(
    (reply) =>
      (underOurs(reply) || reply.status === "ignored") && reply.campaign_pressable && answerable(reply),
  );
  const replyBox = (reply: ReplyRow) => boxKey({ kind: "reply", incomingCommentId: reply.id });
  const replyComposers = await composerFor(tx, answerableReplies.map(replyBox));
  const offers: Record<string, ThreadOffer> = {};
  for (const thread of threads) {
    const post = posts.find((row) => thread.key === `post:${row.id}` && open(row.author_profile_id));
    const box = post && commentable.includes(post) ? commentBox(post) : null;
    const offer: ThreadOffer = {
      post: post
        ? {
            postId: post.id,
            like: standing(postKey(post.post_urn)) ?? (post.pressable ? "offer" : null),
            comment: box === null ? null : { box, angles: composers.get(box)?.angles ?? [] },
            // As the deck saves it (`ownerCommentMode`).
            saveMode: ownerCommentMode({ status: post.campaign_status ?? "active" }),
          }
        : null,
      replies: {},
    };
    const room = thread.room;
    if (room?.parentCommentUrn) {
      const like =
        standing(roomKey(room.parentCommentUrn)) ??
        (room.fit === "fits" && !room.skipped && roomSends.has(room.campaignId) ? "offer" : null);
      if (like !== null) offer.room = { roomMemberId: room.roomMemberId, like };
    }
    for (const reply of replies.filter((row) => thread.replyIds.includes(row.id) && open(row.author_profile_id))) {
      const likeable =
        underOurs(reply) &&
        reply.removed_at === null &&
        reply.author_profile_id !== null &&
        reply.campaign_pressable;
      offer.replies[reply.id] = {
        like: standing(replyKey(reply.comment_urn)) ?? (likeable ? "offer" : null),
        reply: answerableReplies.includes(reply)
          ? { box: replyBox(reply), angles: replyComposers.get(replyBox(reply))?.angles ?? [] }
          : null,
        // The campaign `saveOwnerReply` sends it under: our answer's, else theirs.
        saveMode: ownerReplyMode(
          await replyCampaign(tx, {
            campaignId: reply.answer_status === null ? reply.campaign_id : reply.answer_campaign_id,
          }),
          writes,
        ),
      };
    }
    offers[thread.key] = offer;
  }
  return offers;
}
