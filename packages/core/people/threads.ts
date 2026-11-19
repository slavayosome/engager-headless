import { asc, sql, type SQL } from "drizzle-orm";
import { channels, type MessageLikeOutcome } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { stripOwnerMention } from "../linkedin/mention";
import { memberProfilesSql, resolvePersonKeys } from "./directory";
import { parsePersonKey, personKeySql } from "./key";
import { peopleRooms, type PersonRoom } from "../rooms/person";

/**
 * A PERSON'S PUBLIC HISTORY, ONE THREAD PER POST WHERE THE OWNER MET THEM —
 * their own post we matched, commented on or liked; someone else's post where
 * they replied under our comment; the owner's own post where they commented.
 * Each thread is what happened there, oldest first: Scout's match, our
 * comment and its like, their replies, our replies. Comments nobody answered
 * are in it; a post that was only ever matched is not a thread on anyone —
 * it is Posts to join's.
 *
 * Every row is attributed by the key `people/key.ts` gives it, so a thread is
 * the person's whatever their rows carry, and never anyone's by a name. Each
 * thread also names every id and urn on it, so whatever waits on the owner
 * can be placed at the bottom of the thread its item belongs to.
 *
 * Reads only, inside the caller's `withOrg`; every table read is under RLS.
 */

export type ThreadKind = "their_post" | "their_reply" | "own_post" | "spotted_in";

/** Who said it, and what Engager makes of it. */
export type ThreadEvent =
  | { kind: "match"; at: number; reason: string }
  | {
      kind: "our_comment" | "our_reply";
      /** A first reply under their room comment, not an answer to us. */
      roomReply?: true;
      at: number;
      /** Where it sits: 1 for a comment on the post, 2 for a reply under
       *  one. */
      depth: 1 | 2;
      messageId: number;
      text: string;
      /** The owner's own words, as against a draft they approved. */
      owner: boolean;
      status: string;
      /** The like that rode it landed. */
      liked: boolean;
      /** When a failed send was tried. */
      triedAt: number | null;
      /** The slot a queued send is set to go out at; null with none yet. */
      scheduledAt?: number | null;
    }
  | {
      kind: "their_reply";
      at: number;
      depth: 1 | 2;
      incomingCommentId: number;
      /** Null once LinkedIn shows it deleted. */
      text: string | null;
      intent: "explicit_ask" | "product_question" | "positive_signal" | null;
    }
  | {
      /** A connection invite of ours that went out, from the reply it
       *  answered. */
      kind: "our_invite";
      at: number;
      actionId: number;
      note: string | null;
      /** The owner's yes sent it; else it went on its own, Automatic. */
      approved: boolean;
      /** The mode Invite resolved to when the owner said yes, where it had
       *  one. */
      approvedAs: string | null;
      writing?: { instructions: string; strategyVersion: number };
    }
  | {
      /** Their accepting that invite. */
      kind: "their_acceptance";
      at: number;
      eventId: number;
    };

/** The campaign a thread is in: its post's, or for a post Engager never
 *  discovered, its first reply's. */
export type ThreadCampaign = { id: number; name: string };

export type PersonThread = {
  /** `post:<discovered post>`, or `urn:<post urn>` for a post Engager never
   *  discovered — the owner's own, or one only a reply named. */
  key: string;
  kind: ThreadKind;
  campaign: ThreadCampaign | null;
  /** Whose post it is, where it is not theirs. */
  postAuthor: string | null;
  postUrn: string | null;
  url: string | null;
  excerpt: string | null;
  postedAt: number | null;
  matchedAt: number | null;
  events: ThreadEvent[];
  /** The newest thing on it — what the threads are ordered by. */
  lastAt: number;
  /** While a watch on our comment there is active, when it ends. */
  watchUntil: number | null;
  /** Every message of ours on it, drafts included. */
  messageIds: number[];
  /** Every reply of theirs on it. */
  replyIds: number[];
  /** Every invite of ours sent, or proposed, from a reply of theirs on it. */
  actionIds: number[];
  /** The post's urn and every comment's on it. */
  urns: string[];
  room?: PersonRoom;
  roomReplies?: Array<{ messageId: number; parentCommentUrn: string; confirmed: boolean }>;
};

/** Our messages a thread shows as what happened. A draft waits at its
 *  bottom instead, and a turned-down draft or a shadow rehearsal happened
 *  nowhere. */
const SHOWN = new Set(["approved", "posting", "posted", "failed", "needs_review"]);

type ReplyRow = {
  id: number;
  source: "own_post" | "our_comment_thread";
  own_post_urn: string;
  post_text: string | null;
  comment_urn: string;
  text: string;
  received_at: number;
  intent: "explicit_ask" | "product_question" | "positive_signal" | "none" | null;
  removed_at: number | null;
  /** The comment of ours it answers, where it answers one. */
  parent_message_id: number | null;
  post_id: number | null;
  campaign_id: number | null;
  campaign_name: string | null;
};

type PostRow = {
  id: number;
  post_urn: string;
  url: string | null;
  author_name: string | null;
  author_profile_id: string | null;
  content_text: string | null;
  posted_at: number | null;
  discovered_at: number;
  agent_ranked_at: number | null;
  agent_rank_reason: string | null;
  campaign_id: number | null;
  campaign_name: string | null;
};

type InviteRow = {
  id: number;
  conversation_id: number | null;
  status: string;
  note: string | null;
  created_at: number;
  settled_at: number | null;
  /** The reply the invite answered: the event its candidate cites. */
  incoming_comment_id: number | null;
  approved: boolean;
  approved_as: string | null;
  writing_instructions: string | null;
  strategy_version: number | null;
};

type AcceptanceRow = { id: number; conversation_id: number; occurred_at: number };

type RoomSendRow = {
  id: number;
  post_id: number | null;
  post_urn: string;
  campaign_id: number;
  campaign_name: string;
  parent_comment_urn: string;
  confirmed: boolean;
};

type MessageRow = {
  id: number;
  kind: "comment" | "reply" | "room_reply";
  status: string;
  discovered_post_id: number | null;
  incoming_comment_id: number | null;
  text: string;
  publish_origin: "owner" | "worker";
  like_outcome: MessageLikeOutcome | null;
  posted_at: number | null;
  scheduled_at: number | null;
  last_attempt_at: number | null;
  created_at: number;
  external_urn: string | null;
};

function campaignOf(row: { campaign_id: number | null; campaign_name: string | null }): ThreadCampaign | null {
  return row.campaign_id === null || row.campaign_name === null ? null : { id: row.campaign_id, name: row.campaign_name };
}

/** `column in (…)`, or false for none. */
function inList(column: string, values: readonly (number | string)[]): SQL {
  return values.length === 0
    ? sql`false`
    : sql`${sql.raw(column)} in (${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )})`;
}

export async function readPersonThreads(tx: Tx, key: string): Promise<PersonThread[]> {
  const canonical = (await resolvePersonKeys(tx, [key])).get(key);
  return canonical === undefined ? [] : ((await readPeopleThreads(tx, [canonical])).get(canonical) ?? []);
}

/**
 * `readPersonThreads` for many people at once, by the canonical keys given
 * (`resolvePersonKeys`): each table is read once for all of them, and each
 * person's threads are built from their own rows alone, so a person read
 * among a hundred reads as they do read by themselves.
 */
export async function readPeopleThreads(
  tx: Tx,
  canonicalKeys: readonly string[],
): Promise<Map<string, PersonThread[]>> {
  const keys = [...new Set(canonicalKeys)];
  if (keys.length === 0) return new Map();
  const profileOf = (key: string) => (parsePersonKey(key)?.kind === "profile" ? key.slice(2) : null);
  const profileIds = keys.flatMap((key) => profileOf(key) ?? []);
  const keyList = sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  );

  // Their replies and comments, each with the post it is on where Engager
  // knows the post: the reply's own, its parent comment's, or one by urn.
  const replies = (
    await tx.execute(sql`
      with member_profiles as (${memberProfilesSql()})
      select keyed.* from (
        select ${personKeySql({
          profileId: sql`coalesce(nullif(reply.author_profile_id, ''), alias.profile_id)`,
          memberUrn: sql`reply.author_member_urn`,
          incomingCommentId: sql`reply.id`,
        })} as key,
          reply.id::float8 as id, reply.source, reply.own_post_urn, reply.post_text, reply.comment_urn,
          reply.text, reply.received_at::float8 as received_at, reply.intent, reply.removed_at::float8 as removed_at,
          reply.parent_message_id::float8 as parent_message_id,
          case when reply.source = 'own_post' then null else coalesce(
            reply.discovered_post_id,
            parent.discovered_post_id,
            (select post.id from discovered_posts post where post.post_urn = reply.own_post_urn order by post.id limit 1)
          ) end::float8 as post_id,
          campaign.id::float8 as campaign_id, campaign.name as campaign_name
        from incoming_comments reply
        left join messages parent on parent.id = reply.parent_message_id
        left join campaigns campaign on campaign.id = reply.campaign_id
        left join member_profiles alias
          on nullif(reply.author_profile_id, '') is null and alias.urn = reply.author_member_urn
      ) keyed
      where keyed.key in (${keyList})
      order by keyed.received_at, keyed.id`)
  ).rows as Array<ReplyRow & { key: string }>;

  // Their own posts we commented on or drafted for, or liked.
  const theirPosts =
    profileIds.length === 0
      ? []
      : ((
          await tx.execute(sql`
            select distinct m.discovered_post_id::float8 as id,
              coalesce(nullif(post.author_profile_id, ''), m.target_profile_id) as profile_id
            from messages m
            left join discovered_posts post on post.id = m.discovered_post_id
            where m.kind = 'comment' and m.discovered_post_id is not null
              and m.status not in ('rejected', 'suppressed_dryrun')
              and ${inList("coalesce(nullif(post.author_profile_id, ''), m.target_profile_id)", profileIds)}
            union
            select post.id::float8, post.author_profile_id
            from actions action
            join discovered_posts post on post.post_urn = action.target->>'urn'
            where action.kind = 'like_target' and action.status <> 'cancelled'
              and ${inList("post.author_profile_id", profileIds)}`)
        ).rows as Array<{ id: number; profile_id: string }>);

  const roomSends = (await tx.execute(sql`
    with member_profiles as (${memberProfilesSql()})
    select keyed.* from (
      select ${personKeySql({ profileId: sql`coalesce(m.target_profile_id, alias.profile_id)`,
        memberUrn: sql`m.room_reply_target->>'memberUrn'`, incomingCommentId: sql`null` })} as key,
        m.id::float8 as id, (m.room_reply_target->>'discoveredPostId')::float8 as post_id, m.room_reply_target->>'postUrn' as post_urn,
        c.id::float8 as campaign_id, c.name as campaign_name, m.room_reply_target->>'parentCommentUrn' as parent_comment_urn,
        (m.status = 'posted' and m.external_urn is not null) as confirmed
      from messages m left join campaigns c on c.id = m.campaign_id
        left join member_profiles alias on alias.urn = m.room_reply_target->>'memberUrn'
      where m.kind = 'room_reply' and m.status not in ('rejected', 'suppressed_dryrun')
    ) keyed
    where keyed.key in (${keyList})
  `)).rows as Array<RoomSendRow & { key: string }>;
  const postIds = [...new Set([...theirPosts.map((post) => post.id),
    ...replies.flatMap((reply) => reply.post_id === null ? [] : [reply.post_id]),
    ...roomSends.flatMap((reply) => reply.post_id === null ? [] : [reply.post_id])])];
  const posts = new Map(
    (
      (
        await tx.execute(sql`
          select post.id::float8 as id, post.post_urn, post.url, post.author_name, post.author_profile_id,
            post.content_text, post.posted_at::float8 as posted_at, post.discovered_at::float8 as discovered_at,
            post.agent_ranked_at::float8 as agent_ranked_at, post.agent_rank_reason,
            campaign.id::float8 as campaign_id, campaign.name as campaign_name
          from discovered_posts post
          left join campaigns campaign on campaign.id = post.campaign_id
          where ${inList("post.id", postIds)}`)
      ).rows as PostRow[]
    ).map((post) => [post.id, post] as const),
  );

  // Ours: every comment on their own posts, the comment each reply of theirs
  // answers, and our answers to them.
  const messages = (
    await tx.execute(sql`
      select m.id::float8 as id, m.kind, m.status, m.discovered_post_id::float8 as discovered_post_id,
        m.incoming_comment_id::float8 as incoming_comment_id, coalesce(m.final_text, m.proposed_text) as text,
        m.publish_origin, m.like_outcome, m.posted_at::float8 as posted_at, m.scheduled_at::float8 as scheduled_at,
        m.last_attempt_at::float8 as last_attempt_at, m.created_at::float8 as created_at, m.external_urn
      from messages m
      where m.status not in ('rejected', 'suppressed_dryrun')
        and (
          (m.kind = 'comment' and ${inList("m.discovered_post_id", theirPosts.map((post) => post.id))})
          or ${inList("m.id", replies.flatMap((reply) => (reply.parent_message_id === null ? [] : [reply.parent_message_id])))}
          or (m.kind = 'reply' and ${inList("m.incoming_comment_id", replies.map((reply) => reply.id))})
          or (m.kind = 'room_reply' and ${inList("m.id", roomSends.map((reply) => reply.id))})
        )
      order by m.created_at, m.id`)
  ).rows as MessageRow[];
  const watches = (
    await tx.execute(sql`
      select message_id::float8 as message_id, max(expires_at)::float8 as expires_at
      from comment_watches
      where state = 'active' and ${inList("message_id", messages.map((message) => message.id))}
      group by message_id`)
  ).rows as Array<{ message_id: number; expires_at: number }>;
  // Our invites to them — each from the reply its candidate cites, with the
  // yes that sent it — and their accepting one of ours: not theirs to us,
  // which carries the invitation it accepted.
  const invites =
    profileIds.length === 0
      ? []
      : ((
          await tx.execute(sql`
            select action.author_profile_id as profile_id,
              action.id::float8 as id, action.conversation_id::float8 as conversation_id, action.status,
              nullif(btrim(action.candidate->>'text'), '') as note, action.created_at::float8 as created_at,
              action.settled_at::float8 as settled_at,
              action.candidate->'writing'->>'instructions' as writing_instructions,
              (action.candidate->'versions'->>'strategy')::float8 as strategy_version,
              (source.source_ref->>'incomingCommentId')::float8 as incoming_comment_id,
              approval.id is not null as approved, approval.dependency_versions->>'authority' as approved_as
            from actions action
            left join conversation_events source on source.id = (action.candidate->'sources'->0->>'eventId')::bigint
            left join lateral (
              select approval.id, approval.dependency_versions
              from action_approvals approval
              where approval.action_execution_id = action.id and approval.used_at is not null
              order by approval.id desc
              limit 1
            ) approval on true
            where action.kind = 'invite' and ${inList("action.author_profile_id", profileIds)}
              and action.status <> 'cancelled'
            order by action.created_at, action.id`)
        ).rows as Array<InviteRow & { profile_id: string }>);
  const acceptances =
    profileIds.length === 0
      ? []
      : ((
          await tx.execute(sql`
            select conversation.author_profile_id as profile_id,
              event.id::float8 as id, event.conversation_id::float8 as conversation_id,
              event.occurred_at::float8 as occurred_at
            from conversation_events event
            join conversations conversation on conversation.id = event.conversation_id
            where ${inList("conversation.author_profile_id", profileIds)}
              and event.type = 'invitation_accepted'
              and event.source_ref->>'invitationId' is null
            order by event.occurred_at, event.id`)
        ).rows as Array<AcceptanceRow & { profile_id: string }>);
  // The account, by the name LinkedIn tags it with in front of a reply.
  const [channel] = await tx
    .select({ displayName: channels.displayName })
    .from(channels)
    .orderBy(asc(channels.id))
    .limit(1);
  const rooms = await peopleRooms(tx, keys);
  const watchEnds = new Map(watches.map((watch) => [watch.message_id, watch.expires_at] as const));

  return new Map(
    keys.map((key) => {
      const profileId = profileOf(key);
      const theirPostIds = profileId === null ? [] : theirPosts.flatMap((post) => (post.profile_id === profileId ? [post.id] : []));
      const own = replies.filter((reply) => reply.key === key);
      const sent = roomSends.filter((reply) => reply.key === key);
      const parents = new Set(own.flatMap((reply) => (reply.parent_message_id === null ? [] : [reply.parent_message_id])));
      const answered = new Set(own.map((reply) => reply.id));
      const theirs = new Set(theirPostIds);
      const roomed = new Set(sent.map((reply) => reply.id));
      return [
        key,
        personThreads({
          profileId,
          theirPostIds,
          replies: own,
          roomSends: sent,
          posts,
          messages: messages.filter((message) =>
            message.kind === "comment"
              ? (message.discovered_post_id !== null && theirs.has(message.discovered_post_id)) || parents.has(message.id)
              : message.kind === "reply"
                ? (message.incoming_comment_id !== null && answered.has(message.incoming_comment_id)) || parents.has(message.id)
                : roomed.has(message.id) || parents.has(message.id),
          ),
          watchEnds,
          invites: profileId === null ? [] : invites.filter((invite) => invite.profile_id === profileId),
          acceptances: profileId === null ? [] : acceptances.filter((acceptance) => acceptance.profile_id === profileId),
          accountName: channel?.displayName,
          rooms: rooms.get(key) ?? [],
        }),
      ] as const;
    }),
  );
}

/** One person's threads, from their own rows. */
function personThreads(input: {
  profileId: string | null;
  theirPostIds: readonly number[];
  replies: readonly ReplyRow[];
  roomSends: readonly RoomSendRow[];
  posts: ReadonlyMap<number, PostRow>;
  messages: readonly MessageRow[];
  watchEnds: ReadonlyMap<number, number>;
  invites: readonly InviteRow[];
  acceptances: readonly AcceptanceRow[];
  accountName: string | null | undefined;
  rooms: readonly PersonRoom[];
}): PersonThread[] {
  const { profileId, theirPostIds, replies, roomSends, posts, messages, watchEnds, invites, acceptances } = input;
  const threads = new Map<string, PersonThread>();
  type ThreadRoot = Omit<
    PersonThread,
    "events" | "lastAt" | "watchUntil" | "messageIds" | "replyIds" | "actionIds" | "urns"
  >;
  const thread = (root: ThreadRoot) => {
    let found = threads.get(root.key);
    if (!found) {
      found = {
        ...root,
        events: [],
        lastAt: 0,
        watchUntil: null,
        messageIds: [],
        replyIds: [],
        actionIds: [],
        urns: root.postUrn ? [root.postUrn] : [],
      };
      threads.set(root.key, found);
    }
    return found;
  };
  const theirs = new Set(theirPostIds);
  const postThread = (post: PostRow) =>
    thread({
      key: `post:${post.id}`,
      kind: theirs.has(post.id) || post.author_profile_id === profileId ? "their_post" : "their_reply",
      campaign: campaignOf(post),
      postAuthor: theirs.has(post.id) || post.author_profile_id === profileId ? null : post.author_name,
      postUrn: post.post_urn,
      url: post.url,
      excerpt: post.content_text,
      postedAt: post.posted_at,
      matchedAt: post.agent_rank_reason ? post.agent_ranked_at : null,
    });
  for (const id of theirPostIds) {
    const post = posts.get(id);
    if (post) postThread(post);
  }
  const roomThread = new Map<number, PersonThread>();
  for (const send of roomSends) {
    const post = send.post_id === null ? undefined : posts.get(send.post_id);
    const home = post ? postThread(post) : thread({ key: `urn:${send.post_urn}`, kind: "spotted_in",
      campaign: campaignOf(send), postAuthor: null, postUrn: send.post_urn, url: null,
      excerpt: null, postedAt: null, matchedAt: null });
    home.kind = "spotted_in";
    (home.roomReplies ??= []).push({ messageId: send.id, parentCommentUrn: send.parent_comment_urn, confirmed: send.confirmed });
    roomThread.set(send.id, home);
  }
  const replyThread = new Map<number, PersonThread>();
  for (const reply of replies) {
    const post = reply.post_id === null ? undefined : posts.get(reply.post_id);
    const home = post
      ? postThread(post)
      : thread({
          key: `urn:${reply.own_post_urn}`,
          kind: reply.source === "own_post" ? "own_post" : "their_reply",
          campaign: campaignOf(reply),
          postAuthor: null,
          postUrn: reply.own_post_urn,
          url: null,
          excerpt: reply.post_text,
          postedAt: null,
          matchedAt: null,
        });
    replyThread.set(reply.id, home);
    home.replyIds.push(reply.id);
    home.urns.push(reply.comment_urn);
    home.events.push({
      kind: "their_reply",
      at: reply.received_at,
      // A comment on the owner's own post; else a reply in a thread a
      // comment roots, which LinkedIn keeps flat under it.
      depth: reply.source === "own_post" ? 1 : 2,
      incomingCommentId: reply.id,
      text: reply.removed_at === null ? stripOwnerMention(reply.text, input.accountName) : null,
      intent: reply.intent === "none" ? null : reply.intent,
    });
  }
  for (const message of messages) {
    // A reply of ours sits with theirs; a comment, on the post it is on.
    const home =
      message.kind === "room_reply" ? roomThread.get(message.id) : message.kind === "reply"
        ? message.incoming_comment_id === null
          ? undefined
          : replyThread.get(message.incoming_comment_id)
        : message.discovered_post_id === null
          ? undefined
          : threads.get(`post:${message.discovered_post_id}`);
    if (!home) continue;
    home.messageIds.push(message.id);
    // A draft waiting at the bottom is the thread's newest activity too.
    home.lastAt = Math.max(home.lastAt, message.created_at);
    if (message.external_urn) home.urns.push(message.external_urn);
    const until = watchEnds.get(message.id);
    if (until !== undefined) home.watchUntil = Math.max(home.watchUntil ?? 0, until);
    if (!SHOWN.has(message.status)) continue;
    home.events.push({
      kind: message.kind === "comment" ? "our_comment" : "our_reply",
      ...(message.kind === "room_reply" ? { roomReply: true as const } : {}),
      at: message.posted_at ?? message.scheduled_at ?? message.created_at,
      depth: message.kind === "comment" ? 1 : 2,
      messageId: message.id,
      text: message.text,
      owner: message.publish_origin === "owner",
      status: message.status,
      liked: message.like_outcome?.state === "liked",
      triedAt: message.status === "failed" ? message.last_attempt_at : null,
      scheduledAt: message.status === "approved" ? message.scheduled_at : null,
    });
  }
  // An invite sits with the reply it answered, and went out there once it
  // is confirmed; their acceptance follows the invite it accepted.
  const inviteThread = new Map<number, PersonThread>();
  for (const invite of invites) {
    const home = invite.incoming_comment_id === null ? undefined : replyThread.get(invite.incoming_comment_id);
    if (!home) continue;
    inviteThread.set(invite.id, home);
    home.actionIds.push(invite.id);
    if (invite.status !== "confirmed") continue;
    home.events.push({
      kind: "our_invite",
      at: invite.settled_at ?? invite.created_at,
      actionId: invite.id,
      note: invite.note,
      approved: invite.approved,
      approvedAs: invite.approved_as,
      ...(invite.writing_instructions != null && invite.strategy_version != null
        ? { writing: { instructions: invite.writing_instructions, strategyVersion: invite.strategy_version } } : {}),
    });
  }
  for (const acceptance of acceptances) {
    const sent = invites.filter(
      (invite) => invite.status === "confirmed" && invite.conversation_id === acceptance.conversation_id,
    );
    const answered =
      sent.filter((invite) => (invite.settled_at ?? invite.created_at) <= acceptance.occurred_at).at(-1) ??
      sent.at(-1);
    const home = answered === undefined ? undefined : inviteThread.get(answered.id);
    home?.events.push({ kind: "their_acceptance", at: acceptance.occurred_at, eventId: acceptance.id });
  }
  for (const found of threads.values()) {
    const post = found.key.startsWith("post:") ? posts.get(Number(found.key.slice(5))) : undefined;
    if (post?.agent_rank_reason && post.agent_ranked_at !== null) {
      found.events.push({ kind: "match", at: post.agent_ranked_at, reason: post.agent_rank_reason });
    }
    found.events.sort((a, b) => a.at - b.at || EVENT_ORDER[a.kind] - EVENT_ORDER[b.kind]);
    found.lastAt = Math.max(found.lastAt, found.events.at(-1)?.at ?? 0) || (post?.discovered_at ?? 0);
  }
  for (const room of input.rooms) {
    const existing = threads.get(`post:${room.postId}`);
    const found = existing ?? thread({ key: `post:${room.postId}`, kind: "spotted_in",
      campaign: { id: room.campaignId, name: room.campaignName }, postAuthor: room.author,
      postUrn: room.postUrn, url: room.url, excerpt: room.opening, postedAt: room.postedAt, matchedAt: null });
    found.room = room;
    found.kind = "spotted_in";
    found.postAuthor = room.author;
    found.url ??= room.url;
    found.lastAt = Math.max(found.lastAt, room.readAt);
  }
  return [...threads.values()].sort((a, b) => b.lastAt - a.lastAt || a.key.localeCompare(b.key));
}

/** Within one instant, the order things happen in. */
const EVENT_ORDER: Record<ThreadEvent["kind"], number> = {
  match: 0,
  our_comment: 1,
  their_reply: 2,
  our_reply: 3,
  our_invite: 4,
  their_acceptance: 5,
};
