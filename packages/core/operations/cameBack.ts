import { and, count, desc, eq, gte, inArray, max, sql, type SQL } from "drizzle-orm";
import {
  campaigns,
  discoveredPosts,
  engagementEvents,
  incomingComments,
  conversationEvents,
  conversations,
  messages,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { scheduledWakes } from "../agentStep/wakes";
import { findPeople, resolvePersonKeys } from "../people/directory";
import { personKey, personKeySql } from "../people/key";
import { waitingPeople } from "../people/waits";
import { cameBackRepliesSince as repliesSince, cameBackEventsSince as eventsSince } from "../people/cameBackEvidence";
export { CAME_BACK_CONVERSATION_EVENTS } from "../people/cameBackEvidence";

/**
 * WHAT CAME BACK — the people who answered what the account sent, and the
 * reactions its comments drew, in the last seven days. The number to grow;
 * output alone is not success.
 *
 * ONE READ, every place that says it: Home's Came back for the account,
 * and the campaign list and a campaign's Overview for theirs — so the account
 * and a campaign cannot disagree about who answered. Every count is of rows
 * the server wrote: a reply the account observed under one of its comments or
 * replies (`incoming_comments`, removed ones left out), an invitation of its
 * accepted and a message written to it (their conversation's events), and a like
 * on one of its comments (`engagement_events`).
 *
 * A PERSON IS ONE PERSON however many ways they came back: replying twice and
 * then accepting is one. People are joined on their LinkedIn profile id, else
 * their member urn, and never on a name, so a reply that carries neither is a
 * person of its own. A reply is credited to the campaign whose comment it
 * answers; an accept or a message to the campaign that owns the person's
 * conversation. A person who came back on two campaigns is one on the account and
 * one on each.
 */

export const CAME_BACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type CameBack = {
  /** Replies under the account's comments and replies. */
  replies: number;
  /** Invitations of the account's that they accepted. */
  accepted: number;
  /** Messages they wrote to the account. */
  messages: number;
  /** Reactions on the account's comments. */
  reactions: number;
  /** The people behind the replies, accepts and messages, each once. */
  people: number;
};

export type CameBackWeek = {
  /** Every campaign read, and with none named the sends no campaign made. */
  total: CameBack;
  /** Each campaign that anything came back on. */
  byCampaign: ReadonlyMap<number, CameBack>;
};

/** A like on one of the account's comments since `since`, read joined to the
 *  comment. */
function reactionsSince(since: number, ids: number[] | null): SQL | undefined {
  return and(
    eq(engagementEvents.type, "like_received"),
    gte(engagementEvents.ts, since),
    ids ? inArray(messages.campaignId, ids) : undefined,
  );
}

type Tally = Omit<CameBack, "people"> & { who: Set<string> };

function tally(): Tally {
  return { replies: 0, accepted: 0, messages: 0, reactions: 0, who: new Set() };
}

function settled({ who, ...counts }: Tally): CameBack {
  return { ...counts, people: who.size };
}

/**
 * The last seven days before `now`, for the account — or for `campaignIds`
 * alone when it is given, which leaves out what no campaign sent. `since`
 * moves the window's start, for Home's month.
 */
export async function cameBackWeek(
  tx: Tx,
  input: { now: number; campaignIds?: readonly number[]; since?: number },
): Promise<CameBackWeek> {
  const { total, byCampaign } = await tallies(tx, input);
  return {
    total: settled(total),
    byCampaign: new Map([...byCampaign].map(([id, row]) => [id, settled(row)])),
  };
}

/**
 * The people who came back on each of `campaignIds` in the same seven days —
 * or since `since` — by the key the Inbox opens them by: the set
 * `cameBackWeek` counts as each campaign's `people`, for a read that asks who
 * they are (US-LME-10); and its `accepted`, the invitations among them.
 */
export async function cameBackPeople(
  tx: Tx,
  input: { now: number; campaignIds: readonly number[]; since?: number },
): Promise<Map<number, { people: ReadonlySet<string>; accepted: number }>> {
  const { byCampaign } = await tallies(tx, input);
  return new Map([...byCampaign].map(([id, row]) => [id, { people: row.who, accepted: row.accepted }]));
}

async function tallies(
  tx: Tx,
  { now, campaignIds, since = now - CAME_BACK_WINDOW_MS }: { now: number; campaignIds?: readonly number[]; since?: number },
): Promise<{ total: Tally; byCampaign: Map<number, Tally> }> {
  const total = tally();
  const byCampaign = new Map<number, Tally>();
  if (campaignIds?.length === 0) return { total, byCampaign };
  const ids = campaignIds ? [...campaignIds] : null;
  const add = (campaignId: number | null, apply: (row: Tally) => void) => {
    apply(total);
    if (campaignId === null) return;
    let row = byCampaign.get(campaignId);
    if (!row) byCampaign.set(campaignId, (row = tally()));
    apply(row);
  };

  const replies = await tx
    .select({
      campaignId: incomingComments.campaignId,
      person: personKeySql({ profileId: sql`${incomingComments.authorProfileId}`,
        memberUrn: sql`${incomingComments.authorMemberUrn}`, incomingCommentId: sql`${incomingComments.id}` }).mapWith(String),
    })
    .from(incomingComments)
    .where(repliesSince(since, ids));
  const events = await tx
    .select({
      campaignId: conversations.owningCampaignId,
      person: sql<string>`'p.' || ${conversations.authorProfileId}`,
      type: conversationEvents.type,
    })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(eventsSince(since, ids));
  // A member-only reply and a later profile-backed reply are one person,
  // just as they are in the Inbox and the room that introduced them.
  const identities = await resolvePersonKeys(tx, [...new Set([...replies, ...events].map((row) => row.person))]);
  for (const reply of replies) {
    add(reply.campaignId, (row) => {
      row.replies += 1;
      row.who.add(identities.get(reply.person) ?? reply.person);
    });
  }
  for (const event of events) {
    add(event.campaignId, (row) => {
      if (event.type === "invitation_accepted") row.accepted += 1;
      else row.messages += 1;
      row.who.add(identities.get(event.person) ?? event.person);
    });
  }

  const reactions = await tx
    .select({ campaignId: messages.campaignId, n: count() })
    .from(engagementEvents)
    .leftJoin(messages, eq(messages.id, engagementEvents.messageId))
    .where(reactionsSince(since, ids))
    .groupBy(messages.campaignId);
  for (const reaction of reactions) {
    add(reaction.campaignId, (row) => {
      row.reactions += reaction.n;
    });
  }
  return { total, byCampaign };
}

/** What one person did: replied under a comment or a reply of the account's,
 *  accepted its invitation, or wrote to it. */
export type CameBackKind = "replied_to_comment" | "replied_to_reply" | "replied_to_room_reply" | "accepted" | "messaged";

export type CameBackRow = {
  /** `reply:<incoming_comments.id>` or `event:<conversation_events.id>`. */
  id: string;
  kind: CameBackKind;
  at: number;
  /** The key the Inbox opens them by (`people/key.ts`): a member urn some row
   *  ties to a profile id is that profile's, and a reply that carries neither
   *  is a person of its own. Null only for a row that names no one. */
  personKey: string | null;
  /** The name the row carries, else the newest one any of their rows does. */
  name: string | null;
  room: { author: string | null } | null;
  campaign: { id: number; name: string } | null;
  /** Their words, verbatim — untrusted display data; null for an accept. */
  quote: string | null;
  /** The Inbox lists them as waiting (`people/waits.ts`): an answer, a yes
   *  or a send of theirs waits there. */
  waiting: boolean;
  /** When their conversation is read again on its own, while a wake waits. */
  wakesAt: number | null;
};

/** One of the account's comments or replies that drew reactions, and whose
 *  post or comment it sits under. */
export type ReactedSend = {
  messageId: number;
  kind: "comment" | "reply" | "room_reply";
  /** The author of the post a comment is on, or of the comment a reply
   *  answers. */
  to: { name: string | null; personKey: string | null };
  externalUrn: string | null;
  reactions: number;
};

export type CameBackFeed = {
  /** The newest `limit` replies, accepts and messages. */
  rows: CameBackRow[];
  /** Every reply, accept and message in the window — `replies + accepted +
   *  messages` of the same week's `cameBackWeek`. */
  total: number;
  /** Every reaction in the window, and the sends they are on, the most
   *  reacted to first. A reaction whose send is gone counts, unlisted. */
  reactions: { total: number; sends: ReactedSend[] };
};

/** A row before it is told who it is about: the key its own ids give, and the
 *  conversation it is in, if any. */
type Unresolved = Omit<CameBackRow, "personKey" | "waiting" | "wakesAt"> & {
  key: string | null;
  conversationId: number | null;
};

/**
 * WHAT CAME BACK, PERSON BY PERSON — the week's replies, accepts and messages
 * one row each, newest first, so the list and the week's counts agree row for
 * row; and its reactions, summed and grouped by the send they are on.
 *
 * Each row says whether the Inbox lists its person as waiting, which is what
 * makes "Open in Inbox" a warning rather than a way in, and when their
 * conversation wakes again. Reads only; nothing here answers anyone.
 *
 * `campaignIds` narrows every row, count and reaction to those campaigns, as
 * `cameBackWeek` credits them, so the narrowed list still agrees with the
 * same week's counts; what no campaign sent is left out.
 */
export async function cameBackFeed(
  tx: Tx,
  { now, limit, campaignIds, offset = 0 }: { now: number; limit: number; campaignIds?: readonly number[]; offset?: number },
): Promise<CameBackFeed> {
  if (campaignIds?.length === 0) return { rows: [], total: 0, reactions: { total: 0, sends: [] } };
  const since = now - CAME_BACK_WINDOW_MS;
  const ids = campaignIds ? [...campaignIds] : null;

  const page = await tx.execute(sql`
    select source, id::float8 as id from (
      select 'reply'::text as source, ${incomingComments.id} as id, ${incomingComments.receivedAt} as at
      from ${incomingComments} where ${repliesSince(since, ids)}
      union all
      select 'event'::text as source, ${conversationEvents.id} as id, ${conversationEvents.occurredAt} as at
      from ${conversationEvents} inner join ${conversations} on ${conversations.id} = ${conversationEvents.conversationId}
      where ${eventsSince(since, ids)}
    ) activity order by at desc, (source || ':' || id::text) desc limit ${limit} offset ${offset}`);
  const entries = page.rows as Array<{ source: "reply" | "event"; id: number }>;
  const replyIds = entries.filter((entry) => entry.source === "reply").map((entry) => entry.id);
  const eventIds = entries.filter((entry) => entry.source === "event").map((entry) => entry.id);

  const replies = await tx
    .select({
      id: incomingComments.id,
      at: incomingComments.receivedAt,
      profileId: incomingComments.authorProfileId,
      memberUrn: incomingComments.authorMemberUrn,
      name: incomingComments.authorName,
      text: incomingComments.text,
      parentKind: messages.kind,
      roomAuthor: discoveredPosts.authorName,
      campaign: { id: campaigns.id, name: campaigns.name },
    })
    .from(incomingComments)
    .leftJoin(messages, eq(messages.id, incomingComments.parentMessageId))
    .leftJoin(discoveredPosts, sql`${discoveredPosts.id} = (${messages.roomReplyTarget}->>'discoveredPostId')::bigint`)
    .leftJoin(campaigns, eq(campaigns.id, incomingComments.campaignId))
    .where(and(repliesSince(since, ids), inArray(incomingComments.id, replyIds)))
    .orderBy(desc(incomingComments.receivedAt), desc(incomingComments.id))
    .limit(limit);
  const events = await tx
    .select({
      id: conversationEvents.id,
      type: conversationEvents.type,
      at: conversationEvents.occurredAt,
      content: conversationEvents.content,
      conversationId: conversations.id,
      profileId: conversations.authorProfileId,
      openedFrom: conversations.openedFrom,
      roomAuthor: discoveredPosts.authorName,
      campaign: { id: campaigns.id, name: campaigns.name },
    })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .leftJoin(discoveredPosts, eq(discoveredPosts.id, conversations.openedFromPostId))
    .leftJoin(campaigns, eq(campaigns.id, conversations.owningCampaignId))
    .where(and(eventsSince(since, ids), inArray(conversationEvents.id, eventIds)))
    .orderBy(desc(conversationEvents.occurredAt), desc(conversationEvents.id))
    .limit(limit);
  const [replyCount] = await tx.select({ n: count() }).from(incomingComments).where(repliesSince(since, ids));
  const [eventCount] = await tx
    .select({ n: count() })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(eventsSince(since, ids));

  const listed: Unresolved[] = [
    ...replies.map((reply) => ({
      id: `reply:${reply.id}`,
      kind: reply.parentKind === "room_reply" ? ("replied_to_room_reply" as const)
        : reply.parentKind === "reply" ? ("replied_to_reply" as const) : ("replied_to_comment" as const),
      room: reply.parentKind === "room_reply" ? { author: reply.roomAuthor } : null,
      at: reply.at,
      key: personKey({ profileId: reply.profileId, memberUrn: reply.memberUrn, incomingCommentId: reply.id }),
      name: reply.name,
      campaign: reply.campaign,
      quote: reply.text,
      conversationId: null,
    })),
    ...events.map((event) => ({
      id: `event:${event.id}`,
      kind: event.type === "invitation_accepted" ? ("accepted" as const) : ("messaged" as const),
      room: event.type === "invitation_accepted" && event.openedFrom === "room" ? { author: event.roomAuthor } : null,
      at: event.at,
      key: personKey({ profileId: event.profileId }),
      name: null,
      campaign: event.campaign,
      quote: event.type === "invitation_accepted" ? null : event.content,
      conversationId: event.conversationId,
    })),
  ]
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .slice(0, limit);

  return {
    rows: await resolved(tx, listed),
    total: (replyCount?.n ?? 0) + (eventCount?.n ?? 0),
    reactions: await reactedSends(tx, since, ids),
  };
}

/** Each row under its person: their key as the Inbox has it, the name their
 *  other rows give where this one has none, whether they wait on the owner,
 *  and their conversation's next wake. */
async function resolved(tx: Tx, listed: Unresolved[]): Promise<CameBackRow[]> {
  if (listed.length === 0) return [];
  const people = await findPeople(tx, [...new Set(listed.flatMap((row) => (row.key ? [row.key] : [])))]);
  const waiting = new Set((await waitingPeople(tx)).map((entry) => entry.person.canonicalKey));
  // Their conversation: the one the directory knows them by, else the one
  // the row is in.
  const rows = listed.map(({ key, conversationId, ...row }) => {
    const person = key ? people.get(key) : undefined;
    return { row, person, key: person?.canonicalKey ?? key, conversationId: person?.conversationId ?? conversationId };
  });
  const wakes = new Map<number, number>();
  const conversationIds = [...new Set(rows.flatMap((entry) => entry.conversationId ?? []))];
  // Soonest first: the first wake read for a conversation is its next.
  for (const wake of await scheduledWakes(tx, { conversationIds })) {
    if (!wakes.has(wake.conversationId)) wakes.set(wake.conversationId, wake.at);
  }
  return rows.map(({ row, person, key, conversationId }) => ({
    ...row,
    personKey: key,
    name: row.name || person?.name || null,
    waiting: key !== null && waiting.has(key),
    wakesAt: conversationId === null ? null : (wakes.get(conversationId) ?? null),
  }));
}

/** The week's reactions, summed, and the sends they are on — `ids`'
 *  campaigns' alone when given. */
async function reactedSends(tx: Tx, since: number, ids: number[] | null): Promise<CameBackFeed["reactions"]> {
  const groups = await tx
    .select({
      messageId: engagementEvents.messageId,
      reactions: count(),
      kind: messages.kind,
      targetProfileId: messages.targetProfileId,
      roomTarget: messages.roomReplyTarget,
      externalUrn: messages.externalUrn,
      postAuthor: discoveredPosts.authorName,
      postAuthorId: discoveredPosts.authorProfileId,
      replier: incomingComments.authorName,
      replierId: incomingComments.authorProfileId,
      replierUrn: incomingComments.authorMemberUrn,
      replyId: incomingComments.id,
    })
    .from(engagementEvents)
    .leftJoin(messages, eq(messages.id, engagementEvents.messageId))
    .leftJoin(discoveredPosts, eq(discoveredPosts.id, messages.discoveredPostId))
    .leftJoin(incomingComments, eq(incomingComments.id, messages.incomingCommentId))
    .where(reactionsSince(since, ids))
    .groupBy(
      engagementEvents.messageId,
      messages.kind,
      messages.id,
      messages.externalUrn,
      discoveredPosts.authorName,
      discoveredPosts.authorProfileId,
      incomingComments.id,
    )
    .orderBy(desc(count()), desc(max(engagementEvents.ts)), desc(engagementEvents.messageId));
  return {
    total: groups.reduce((sum, group) => sum + group.reactions, 0),
    sends: groups.flatMap((group) =>
      group.messageId === null || group.kind === null
        ? []
        : [
            {
              messageId: group.messageId,
              kind: group.kind,
              to:
                group.kind === "room_reply"
                  ? { name: null, personKey: personKey({ profileId: group.targetProfileId, memberUrn: group.roomTarget?.memberUrn }) }
                  : group.kind === "reply"
                  ? {
                      name: group.replier,
                      personKey:
                        group.replyId === null
                          ? null
                          : personKey({
                              profileId: group.replierId,
                              memberUrn: group.replierUrn,
                              incomingCommentId: group.replyId,
                            }),
                    }
                  : { name: group.postAuthor, personKey: personKey({ profileId: group.postAuthorId }) },
              externalUrn: group.externalUrn,
              reactions: group.reactions,
            },
          ],
    ),
  };
}
