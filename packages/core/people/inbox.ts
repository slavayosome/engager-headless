import { and, asc, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  campaigns,
  channels,
  discoveredPosts,
  leads,
  leadSignals,
  type ConversionOutcome,
  type Lead,
  type LeadFit,
  type LeadSignalRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { authorIdentity } from "./key";
import { INVITATION_ANSWERS } from "../conversations/record";
import { leadTemperature, type LeadTemperature } from "../leads/temperature";
import { readDeclined } from "./declined";
import { NETWORK_IDS, type NetworkId } from "../network/registry";
import { truncateChars } from "../operations/postSnippets";
import { listMatchingRoomPeople, type RoomPeopleScope } from "../rooms/people";
import { knownCountries } from "./countries";
import { findPeople, namedPerson, resolvePersonKeys, type Person } from "./directory";
import { personKeySql } from "./key";
import { answersWithState, unreadPeople, type AnswerKind, type AnswerState } from "./reads";
import type { Send } from "./sendState";
import { readQueuedSends, type QueuedSend } from "./sends";
import { personStandings, type Standing } from "./standing";
import {
  itemStatus,
  mostUrgent,
  sendInFlight,
  type ItemFacts,
  type ItemInvite,
  type ItemSend,
  type ItemStatus,
  type SendInFlight,
  type TheirWords,
  type Untouched,
} from "./status";
import { readPeopleThreads, type PersonThread } from "./threads";
import { personWaits, STILL_READING, type Wait, type WaitKind } from "./waits";

/**
 * THE INBOX AS ONE LIST OF PEOPLE — `relationshipRows`, a row per person who
 * answered the owner: replied to them, messaged them, invited them or
 * accepted their invite. It is read from the conversation log's four answers
 * (`people/reads.ts#readAnswers`), newest activity first, over each person's
 * items. Each row says what they did, the newest words between you, how warm
 * they are and the facts its marks and filters read; the badge counts the
 * same list's unread people (`people/reads.ts#countUnreadPeople`).
 *
 * An ITEM is one place the owner talks with someone: their post, their
 * comment or reply on another post or on the owner's own, their Messages, or
 * an invitation of theirs tied to no reply. `personItems` reads them for many
 * people at once, a hundred at a time, and the thread pane reads one person
 * through the same read (`itemsReader`), so a row and its thread cannot say a
 * person two ways. A wait, a send or an invite sits on the item that holds
 * its message, reply or action, and each item lists the rows it holds, by
 * which `locateItem` finds it for a surface that names one of them.
 *
 * Reads only, inside the caller's `withOrg`: no provider read, no conversation
 * opened, nothing drafted or sent. Names and words come back as plain strings,
 * for a surface to render as text.
 */

/** How each network is named on a row, an item and a box. */
export const NETWORK_LABEL: Record<NetworkId, string> = { linkedin: "LinkedIn" };

/** The account an item is on: its `channels` row — null for an org that
 *  keeps none — and the network it is an account on. */
export type InboxChannel = { id: number | null; network: NetworkId; label: string };

/** Their post; a comment or reply of theirs on another post, or on the
 *  owner's own; their Messages; an invitation of theirs tied to no reply. */
export type InboxItemType = "post" | "comment" | "invite" | "dm";

/** Words between the owner and a person, on one item: `ours` when the owner's
 *  (their comment, reply or message, or one that is on its way), as written. */
export type Spoken = { at: number; text: string; ours: boolean };

/** What a send of ours that went out was. */
export type SentKind = "comment" | "reply" | "message" | "invite";

/** What a row shows of an item, and what the filters read. */
export type InboxItemSummary = {
  /** Unique among the person's items: the thread's key (`post:<id>`,
   *  `urn:<urn>`), `messages`, `invitation:<id>` for theirs, `invite:<id>`
   *  for ours with nothing public to sit on. */
  key: string;
  channel: InboxChannel;
  type: InboxItemType;
  /** Its type, and `invite` where an invite rides on it. */
  kinds: InboxItemType[];
  /** "their post", "on Aiko Tanaka's post", "on a post", "on your post",
   *  "Messages", "Invitations" — the UI writes the channel in front. */
  where: string;
  /** The newest words on it, one line: theirs as written, ours after
   *  "You: ", or what an invite on it says. */
  snippet: string;
  status: ItemStatus;
  campaignId: number | null;
  /** When Scout found the post a matched item is, null for any other; a first
   *  look's page compares it with the round's start to say which just came in. */
  foundAt: number | null;
};

/** An item, with what its thread reads. */
export type InboxItem = InboxItemSummary & {
  /** The newest moment on it, which a thread orders its items by. */
  lastAt: number;
  /** The newest words on it in full — what `snippet` cuts to one line. */
  words: string;
  /** The newest words between the two of them on it — theirs, and ours that
   *  went out or are on their way — which a row of the list shows. A post of
   *  theirs, a room comment, a stored signal and a draft of ours are none of
   *  them. */
  spoken: Spoken | null;
  /** What our newest send on it, the one `facts.oursAt` dates, was. */
  oursKind: SentKind | null;
  /** Who wrote the post a comment of theirs is on, where no thread says so:
   *  a stored signal's. */
  postAuthor: string | null;
  /** The public thread it is, where it is one. */
  thread: PersonThread | null;
  /** What its status was read from. */
  facts: ItemFacts;
  /** Every row it holds, as `<kind>:<id>`: `message:` a comment or reply of
   *  ours, `reply:` one of theirs, `action:` the ledger's, `event:` the log's
   *  — a message either way, their accepting our invite — and the rows a
   *  wait names (`invitation:` theirs, `thread:` a
   *  conversation the owner holds). */
  refs: string[];
};

/** A send of ours on its way, by its row — a `messages` row for a comment or
 *  a reply, an `actions` row for the rest — as the channel's Going out
 *  lists it. */
export type SendRef = { kind: "message" | "action"; id: number };

export function sendRef(send: Pick<Send, "kind" | "id">): SendRef {
  switch (send.kind) {
    case "comment":
    case "reply":
    case "room_reply":
      return { kind: "message", id: send.id };
    case "invite":
    case "accept_invite":
    case "dm":
      return { kind: "action", id: send.id };
  }
}

/** How well a person fits: a post of theirs worth Strong fit, else a Good
 *  fit post or a room comment that fits. */
export type InboxFit = "strong" | "fits" | null;

export type PersonItems = {
  person: Person;
  /** Where a profile read placed them. */
  country: string | null;
  /** Newest first. */
  items: InboxItem[];
  fit: InboxFit;
};

/** An item's types, in the order its `kinds` lists them. */
const ITEM_TYPES = ["post", "comment", "invite", "dm"] as const satisfies readonly InboxItemType[];

/** A set of filters: each group and its options. */
type FilterSpec = Readonly<Record<string, readonly string[]>>;

/** The options turned on: inside a group a person passes on any one of
 *  them, and they must pass every group. */
type FiltersOf<S extends FilterSpec> = { [G in keyof S]?: ReadonlyArray<S[G][number]> };

/** How many people hold each option, among those every other group and the
 *  search keep. */
type CountsOf<S extends FilterSpec> = { [G in keyof S]: Record<S[G][number], number> };

/** The list of people who answered has three groups: the channel; what the
 *  owner has read and answered (`unread`, `not_answered` — read, their words
 *  the newest between you, nothing of ours on its way —, `waiting` — our send
 *  that went out is the newest —, and `draft_ready` — a draft of ours waits
 *  for a yes); and how warm each person is. */
export const RELATIONSHIP_FILTERS = {
  channel: NETWORK_IDS,
  state: ["unread", "not_answered", "waiting", "draft_ready"],
  temp: ["hot", "warm", "cold", "dormant", "declined"],
  fit: ["strong", "fits", "weak"],
} as const;

export type RelationshipFilters = FiltersOf<typeof RELATIONSHIP_FILTERS>;
export type RelationshipFilterCounts = CountsOf<typeof RELATIONSHIP_FILTERS>;

/** How many people one read of their items takes, as `personStandings`
 *  pages its spotted read. */
const PAGE = 100;

/** The most rows one page holds: the Inbox opens up to a thousand people
 *  at once, and every page reads the whole list anyway. */
const MOST_ROWS = 1_000;

const MESSAGES = "messages";
const THEIR_POST = "their post";
const SNIPPET_MAX = 120;
/** What an invitation of theirs says when they wrote nothing with it. */
const NO_NOTE = "No note.";

/** The org-wide reads every page of people shares: in one campaign, or in
 *  every campaign for none. */
type Context = {
  now: number;
  campaigns: ReadonlyMap<number, { name: string; channelId: number | null }>;
  channels: ReadonlyMap<number, NetworkId>;
  /** The account an item no campaign or conversation places is on. */
  channelId: number | null;
  waits: ReadonlyMap<string, Wait[]>;
};

/** A campaign's view of what a context read: its deck's posts and its waits
 *  alone, as `readContext` reads them for that campaign; every campaign's,
 *  for none. */
type Scope = { campaignId: number | undefined; context: Context };

function scopeOf(context: Context, campaignId: number | undefined): Scope {
  if (campaignId === undefined) return { campaignId, context };
  const inCampaign = <T extends { campaignId: number | null }>(byKey: ReadonlyMap<string, T[]>) =>
    new Map(
      [...byKey].flatMap(([key, rows]) => {
        const kept = rows.filter((row) => row.campaignId === campaignId);
        return kept.length === 0 ? [] : [[key, kept] as const];
      }),
    );
  return { campaignId, context: { ...context, waits: inCampaign(context.waits) } };
}

async function readContext(tx: Tx, now: number, campaignId: number | undefined): Promise<Context> {
  const known = await tx.select().from(campaigns).where(isNull(campaigns.deletedAt));
  const accounts = await tx
    .select({ id: channels.id, network: channels.network })
    .from(channels)
    .orderBy(asc(channels.id));
  return {
    now,
    campaigns: new Map(known.map((campaign) => [campaign.id, { name: campaign.name, channelId: campaign.channelId }])),
    channels: new Map(accounts.map((account) => [account.id, account.network])),
    channelId: accounts[0]?.id ?? null,
    waits: await personWaits(tx, { campaignId }),
  };
}

/**
 * Each person `keys` names, by their canonical key, with every item of
 * theirs — in `campaignId` alone where one is given. A key that names no one
 * is left out; someone with no item there is kept, with none.
 */
export async function personItems(
  tx: Tx,
  keys: readonly string[],
  opts: { campaignId?: number; now?: number } = {},
): Promise<Map<string, PersonItems>> {
  const context = await readContext(tx, opts.now ?? Date.now(), opts.campaignId);
  const [found] = await itemsIn(tx, context, [{ ...scopeOf(context, opts.campaignId), keys }]);
  return found!;
}

/** One read of people's items: its keys, in its campaign alone where it
 *  names one. */
export type ItemsRead = { keys: readonly string[]; campaignId?: number };
export type InboxReadCache = {
  items?: Map<string, PersonItems>;
  waits?: ReadonlyMap<string, Wait[]>;
  read?: (reads: readonly ItemsRead[]) => Promise<Array<Map<string, PersonItems>>>;
};

/**
 * `personItems` for reads made one after another — a person, then the people
 * their items name — that each read what they all share (the campaigns, the
 * accounts, the deck, what waits) once, from the first call. Each read's
 * people come back as `personItems` gives them, a read in a campaign as that
 * campaign's list reads them.
 */
export async function itemsReader(
  tx: Tx,
  opts: { now?: number } = {},
): Promise<(reads: readonly ItemsRead[]) => Promise<Array<Map<string, PersonItems>>>> {
  const context = await readContext(tx, opts.now ?? Date.now(), undefined);
  return (reads) =>
    itemsIn(
      tx,
      context,
      reads.map((read) => ({ ...scopeOf(context, read.campaignId), keys: read.keys })),
    );
}

/** A row a surface names, to open its person's thread on the item that holds
 *  it: a comment or reply of ours, a ledger action, a reply of theirs, or a
 *  post by the person it is about. */
export type ItemRef =
  | { messageId: number }
  | { actionId: number }
  | { incomingCommentId: number }
  | { discoveredPostId: number; personKey: string };

/**
 * The person a row is about, by their canonical key, and the key of their
 * item that holds it, as `personItems` places it; null where the row names no
 * one, or no item of theirs holds it. An item holds a row only as its `refs`
 * list it, so a row none lists comes back null whoever it is about: a
 * confirmed like, acceptance or withdrawal of ours (`like_target`,
 * `accept_invite`, `withdraw_invite`) is held by no item, and nor is a
 * message or action that was turned down, blocked or cancelled. The caller
 * falls back to the person (US-ICF-03). Nor does it place anyone on the
 * do-not-engage list: a surface that opens an item opens its box, and the
 * owner decided never to engage them.
 */
export async function locateItem(
  tx: Tx,
  ref: ItemRef,
  opts: { now?: number } = {},
): Promise<{ personKey: string; itemKey: string } | null> {
  const key = "personKey" in ref ? ref.personKey : await personOfRef(tx, ref);
  if (key === null) return null;
  const [found] = (await personItems(tx, [key], opts)).values();
  const holds =
    "personKey" in ref
      ? (item: InboxItem) => item.key === `post:${ref.discoveredPostId}`
      : (item: InboxItem) => item.refs.includes(spelledRef(ref));
  const holder = found?.items.find(holds);
  return found && !found.person.doNotEngage && holder
    ? { personKey: found.person.canonicalKey, itemKey: holder.key }
    : null;
}

/** A row as an item's refs spell it. */
function spelledRef(ref: Exclude<ItemRef, { personKey: string }>): string {
  return "messageId" in ref
    ? `message:${ref.messageId}`
    : "actionId" in ref
      ? `action:${ref.actionId}`
      : `reply:${ref.incomingCommentId}`;
}

/** Whom a row is about, by the key its own columns give (`people/key.ts`): a
 *  comment of ours its post's author, a reply of ours or of theirs the
 *  replier, a room reply the comment author it answers, a ledger action the person
 *  it names. */
async function personOfRef(tx: Tx, ref: Exclude<ItemRef, { personKey: string }>): Promise<string | null> {
  const none = { memberUrn: sql`null::text`, incomingCommentId: sql`null::bigint` };
  const replier = personKeySql({
    profileId: sql`reply.author_profile_id`,
    memberUrn: sql`reply.author_member_urn`,
    incomingCommentId: sql`reply.id`,
  });
  const query =
    "incomingCommentId" in ref
      ? sql`select ${replier} as key from incoming_comments reply where reply.id = ${ref.incomingCommentId}`
      : "messageId" in ref
        ? sql`
            select case m.kind
              when 'reply' then ${replier}
              when 'room_reply' then ${personKeySql({
                profileId: sql`m.target_profile_id`,
                memberUrn: sql`m.room_reply_target->>'memberUrn'`,
                incomingCommentId: none.incomingCommentId,
              })}
              else ${personKeySql({ ...none, profileId: sql`coalesce(nullif(post.author_profile_id, ''), m.target_profile_id)` })}
            end as key
            from messages m
            left join incoming_comments reply on reply.id = m.incoming_comment_id
            left join discovered_posts post on post.id = m.discovered_post_id
            where m.id = ${ref.messageId}`
        : sql`select ${personKeySql({ ...none, profileId: sql`author_profile_id` })} as key
            from actions where id = ${ref.actionId}`;
  const [row] = (await tx.execute(query)).rows as Array<{ key: string | null }>;
  return row?.key ?? null;
}

/**
 * The people each scope's keys name, by their canonical key, with every item
 * of theirs in that scope. Each person is read once, a hundred at a time,
 * however many scopes name them, through `context`, which holds what every
 * scope's does.
 */
async function itemsIn(
  tx: Tx,
  context: Context,
  scopes: ReadonlyArray<Scope & { keys: readonly string[] }>,
): Promise<Array<Map<string, PersonItems>>> {
  const canonical = await resolvePersonKeys(tx, [...new Set(scopes.flatMap((scope) => scope.keys))]);
  const views = scopes.map((scope) => ({
    scope,
    named: new Set(scope.keys.flatMap((key) => canonical.get(key) ?? [])),
    found: new Map<string, PersonItems>(),
  }));
  const keys = [...new Set(canonical.values())];
  for (let offset = 0; offset < keys.length; offset += PAGE) {
    const page = await readPage(tx, keys.slice(offset, offset + PAGE), context);
    for (const person of page.people) {
      for (const { scope, named, found } of views) {
        if (named.has(person.canonicalKey)) {
          found.set(person.canonicalKey, itemsOfPerson(person, page, scope.context, scope.campaignId));
        }
      }
    }
  }
  return views.map((view) => view.found);
}

/** Their conversation: its campaign and account, and their messages and
 *  ours, each by the row it is (`InboxItem.refs`). */
type Conversation = {
  campaignId: number | null;
  channelId: number;
  theirs: Array<{ ref: string; at: number; text: string | null }>;
  ours: Array<{ ref: string; at: number; text: string | null; confirmed: boolean }>;
};

/** An invitation of theirs to the account, and the reply its attribution
 *  ties it to. */
type Invitation = {
  id: number;
  /** LinkedIn's, which an acceptance of ours targets. */
  invitationId: string;
  pending: boolean;
  goneAt: number | null;
  at: number;
  /** What they wrote with it, null where they wrote nothing. */
  note: string | null;
  replyId: number | null;
  campaignId: number | null;
  channelId: number;
};

/** An invite of ours, from the reply its candidate cites, sent `sentAt` — its
 *  `invitation_confirmed` — and the first answer since, and the event that
 *  records it. */
type Invite = {
  id: number;
  replyId: number | null;
  campaignId: number | null;
  channelId: number;
  sentAt: number | null;
  answer: Extract<ItemInvite, { from: "us" }>["answer"];
  answerEventId: number | null;
};

/** A reply's own status, as `incoming_comments` keeps it. */
type ReplyStatus = Extract<TheirWords, { kind: "reply" }>["status"];

/** `column in (…)` over values that are never empty. */
function listOf(values: readonly (number | string)[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function byKey<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(keyOf(row), [...(grouped.get(keyOf(row)) ?? []), row]);
  return grouped;
}

async function readConversations(tx: Tx, conversationIds: readonly number[]): Promise<Map<number, Conversation>> {
  if (conversationIds.length === 0) return new Map();
  const conversations = (
    await tx.execute(sql`
      select id::float8 as id, owning_campaign_id::float8 as campaign_id, channel_id::float8 as channel_id
      from conversations where id in (${listOf(conversationIds)})`)
  ).rows as Array<{ id: number; campaign_id: number | null; channel_id: number }>;
  // Theirs from the log; ours from the ledger, on their way or gone out — a
  // draft waits for a yes, and one turned down or called off went nowhere —
  // and a confirmed one the log holds with no row of the ledger's behind it.
  const messages = (
    await tx.execute(sql`
      select event.conversation_id::float8 as conversation_id, 'event:' || event.id as ref, event.occurred_at::float8 as at,
        event.content as text, event.type = 'dm_confirmed' as ours, true as confirmed
      from conversation_events event
      where event.conversation_id in (${listOf(conversationIds)})
        and (
          (event.type = 'inbound_message_observed'
            and not exists (select 1 from conversation_events later where later.supersedes_event_id = event.id))
          or (event.type = 'dm_confirmed' and not exists (
            select 1 from actions action
            where action.id = (event.source_ref->>'actionExecutionId')::bigint and action.conversation_id = event.conversation_id))
        )
      union all
      select conversation_id::float8, 'action:' || id, case status when 'confirmed' then coalesce(settled_at, created_at)
          else coalesce(submitted_at, created_at) end::float8,
        candidate->>'text', true, status = 'confirmed'
      from actions
      where conversation_id in (${listOf(conversationIds)}) and kind in ('dm', 'followup')
        and status in ('reserved', 'approved', 'dispatching', 'uncertain', 'confirmed')`)
  ).rows as Array<{
    conversation_id: number;
    ref: string;
    at: number;
    text: string | null;
    ours: boolean;
    confirmed: boolean;
  }>;
  return new Map(
    conversations.map((conversation) => {
      const own = messages.filter((message) => message.conversation_id === conversation.id);
      return [
        conversation.id,
        {
          campaignId: conversation.campaign_id,
          channelId: conversation.channel_id,
          theirs: own.filter((message) => !message.ours).map(({ ref, at, text }) => ({ ref, at, text })),
          ours: own
            .filter((message) => message.ours)
            .map(({ ref, at, text, confirmed }) => ({ ref, at, text, confirmed })),
        },
      ] as const;
    }),
  );
}

/** Their invitations by profile id, but any the owner hid here. */
async function readInvitations(tx: Tx, profileIds: readonly string[]): Promise<Map<string, Invitation[]>> {
  if (profileIds.length === 0) return new Map();
  const rows = (
    await tx.execute(sql`
      select invitation.id::float8 as id, invitation.invitation_id, invitation.sender_profile_id,
        invitation.status = 'pending' as pending,
        case when invitation.status = 'gone' then invitation.status_at::float8 end as gone_at, nullif(btrim(invitation.note), '') as note,
        coalesce(invitation.received_at, invitation.first_observed_at)::float8 as at,
        (reply.source_ref->>'incomingCommentId')::float8 as reply_id,
        conversation.owning_campaign_id::float8 as campaign_id, invitation.channel_id::float8 as channel_id
      from incoming_invitations invitation
      left join conversations conversation on conversation.id = invitation.conversation_id
      left join conversation_events reply on reply.id = (invitation.attribution_evidence->>'replyEventId')::bigint
      where invitation.sender_profile_id in (${listOf(profileIds)}) and invitation.status <> 'dismissed'
      order by at, invitation.id`)
  ).rows as Array<{
    id: number;
    invitation_id: string;
    sender_profile_id: string;
    pending: boolean;
    gone_at: number | null;
    note: string | null;
    at: number;
    reply_id: number | null;
    campaign_id: number | null;
    channel_id: number;
  }>;
  return byKey(
    rows.map((row) => ({
      profileId: row.sender_profile_id,
      id: row.id,
      invitationId: row.invitation_id,
      pending: row.pending,
      goneAt: row.gone_at,
      note: row.note,
      at: row.at,
      replyId: row.reply_id,
      campaignId: row.campaign_id,
      channelId: row.channel_id,
    })),
    (row) => row.profileId,
  );
}

/** Our invites by profile id, oldest first, each with its confirmation and
 *  the first answer to it the log holds since. An answer is dated when a read
 *  found it, which can be after they wrote: it is never later than their
 *  first message since the invite, so that message stays their newest. */
async function readInvites(tx: Tx, profileIds: readonly string[]): Promise<Map<string, Invite[]>> {
  if (profileIds.length === 0) return new Map();
  const rows = (
    await tx.execute(sql`
      select action.id::float8 as id, action.author_profile_id, action.campaign_id::float8 as campaign_id,
        action.channel_id::float8 as channel_id, (source.source_ref->>'incomingCommentId')::float8 as reply_id,
        sent.occurred_at::float8 as sent_at, answer.id::float8 as answer_id, answer.type as answer,
        least(answer.occurred_at, wrote.first_at - 1)::float8 as answered_at
      from actions action
      left join conversation_events source on source.id = (action.candidate->'sources'->0->>'eventId')::bigint
      left join lateral (
        select event.id, event.occurred_at from conversation_events event
        where event.conversation_id = action.conversation_id and event.type = 'invitation_confirmed'
          and event.source_ref->>'actionExecutionId' = action.id::text
        order by event.id limit 1
      ) sent on true
      left join lateral (
        select event.id, event.type, event.occurred_at from conversation_events event
        where event.conversation_id = action.conversation_id and event.id > sent.id
          and event.type in (${listOf(INVITATION_ANSWERS)})
        order by event.id limit 1
      ) answer on true
      left join lateral (
        select min(event.occurred_at) as first_at from conversation_events event
        where event.conversation_id = action.conversation_id and event.id > sent.id
          and event.type = 'inbound_message_observed'
      ) wrote on true
      where action.kind = 'invite' and action.status <> 'cancelled'
        and action.author_profile_id in (${listOf(profileIds)})
      order by action.created_at, action.id`)
  ).rows as Array<{
    id: number;
    author_profile_id: string;
    campaign_id: number | null;
    channel_id: number;
    reply_id: number | null;
    sent_at: number | null;
    answer_id: number | null;
    answer: (typeof INVITATION_ANSWERS)[number] | null;
    answered_at: number | null;
  }>;
  return byKey(
    rows.map((row) => ({
      profileId: row.author_profile_id,
      id: row.id,
      replyId: row.reply_id,
      campaignId: row.campaign_id,
      channelId: row.channel_id,
      sentAt: row.sent_at,
      answer: row.answer === null || row.answered_at === null ? null : { kind: ANSWER_KIND[row.answer], at: row.answered_at },
      answerEventId: row.answer_id,
    })),
    (row) => row.profileId,
  );
}

const ANSWER_KIND: Record<(typeof INVITATION_ANSWERS)[number], "accepted" | "withdrawn" | "gone"> = {
  invitation_accepted: "accepted",
  invitation_withdrawn: "withdrawn",
  invitation_gone: "gone",
};

/** Each reply's own status, and whether Engager still reads it. */
async function readReplies(
  tx: Tx,
  ids: readonly number[],
): Promise<Map<number, { status: ReplyStatus; reading: boolean }>> {
  if (ids.length === 0) return new Map();
  const { rows } = await tx.execute(sql`
    select reply.id::float8 as id, reply.status, ${STILL_READING} as reading
    from incoming_comments reply
    where reply.id in (${listOf(ids)})`);
  return new Map(
    (rows as Array<{ id: number; status: ReplyStatus; reading: boolean }>).map(
      (row) => [row.id, { status: row.status, reading: row.reading }] as const,
    ),
  );
}

/** When they last liked each message of ours. */
async function readLikes(tx: Tx, messageIds: readonly number[]): Promise<Map<number, number>> {
  if (messageIds.length === 0) return new Map();
  const { rows } = await tx.execute(sql`
    select message_id::float8 as message_id, max(ts)::float8 as at
    from engagement_events
    where type = 'like_received' and message_id in (${listOf(messageIds)})
    group by message_id`);
  return new Map((rows as Array<{ message_id: number; at: number }>).map((row) => [row.message_id, row.at] as const));
}

/** Where each ledger row is: its kind, the urn it is on, the invitation it
 *  accepts. */
async function readActions(
  tx: Tx,
  ids: readonly number[],
): Promise<Map<number, { kind: string; urn: string | null; targetId: string | null }>> {
  if (ids.length === 0) return new Map();
  const { rows } = await tx.execute(sql`
    select id::float8 as id, kind, target->>'urn' as urn, target->>'id' as target_id
    from actions where id in (${listOf(ids)})`);
  return new Map(
    (rows as Array<{ id: number; kind: string; urn: string | null; target_id: string | null }>).map(
      (row) => [row.id, { kind: row.kind, urn: row.urn, targetId: row.target_id }] as const,
    ),
  );
}

/**
 * The words of theirs Find leads stored that the screen did not drop, by the
 * person's key, newest first; who wrote the post each comment is on, and the
 * post row each post of theirs is, where Scout stored one. A signal LinkedIn
 * named only by member urn has no profile id and is never shown.
 */
async function readSignals(tx: Tx, keys: readonly string[]) {
  const none = {
    signals: new Map<string, LeadSignalRow[]>(),
    postAuthors: new Map<string, string>(),
    signalPosts: new Map<string, number>(),
  };
  if (keys.length === 0) return none;
  const signals = await tx
    .select()
    .from(leadSignals)
    .where(
      and(inArray(leadSignals.personKey, [...keys]), isNotNull(leadSignals.profileId), ne(leadSignals.verdict, "dropped")),
    )
    .orderBy(sql`${leadSignals.seenAt} desc`, sql`${leadSignals.id} desc`);
  if (signals.length === 0) return none;
  const posts = await tx
    .select({ id: discoveredPosts.id, postUrn: discoveredPosts.postUrn, name: discoveredPosts.authorName })
    .from(discoveredPosts)
    .where(inArray(discoveredPosts.postUrn, [...new Set(signals.map((signal) => signal.postUrn))]));
  const own = new Set(signals.flatMap((signal) => (signal.kind === "post" ? [signal.postUrn] : [])));
  return {
    signals: byKey(signals, (signal) => signal.personKey),
    postAuthors: new Map(posts.flatMap((post) => (post.name ? [[post.postUrn, post.name] as const] : []))),
    signalPosts: new Map(posts.filter((post) => own.has(post.postUrn)).map((post) => [post.postUrn, post.id] as const)),
  };
}

/** Everything one page of people's items is built from. */
type Page = {
  people: Person[];
  threads: ReadonlyMap<string, PersonThread[]>;
  standings: ReadonlyMap<string, Standing>;
  /** Everyone Audience lists among them. */
  listed: ReadonlySet<string>;
  conversations: ReadonlyMap<number, Conversation>;
  invitations: ReadonlyMap<string, Invitation[]>;
  invites: ReadonlyMap<string, Invite[]>;
  replies: ReadonlyMap<number, { status: ReplyStatus; reading: boolean }>;
  likes: ReadonlyMap<number, number>;
  sends: readonly QueuedSend[];
  actions: ReadonlyMap<number, { kind: string; urn: string | null; targetId: string | null }>;
  /** The words of theirs Find leads stored, by their key. */
  signals: ReadonlyMap<string, LeadSignalRow[]>;
  /** Who wrote the post a comment signal is on, by the post's urn. */
  postAuthors: ReadonlyMap<string, string>;
  /** The post row of each post of theirs a signal is, by the post's urn. */
  signalPosts: ReadonlyMap<string, number>;
  countries: ReadonlyMap<string, string>;
};

/** Everyone Audience lists, whatever their contact: a room comment that
 *  fits or may. */
const ROOM_PEOPLE = { contactState: "all", fit: ["fits", "maybe"] } as const satisfies RoomPeopleScope;

async function readPage(tx: Tx, keys: readonly string[], context: Context): Promise<Page> {
  // Audience's read names whoever it lists, and a writer whose comment only
  // may fit is known by it alone.
  const listed = new Map(
    (await listMatchingRoomPeople(tx, { ...ROOM_PEOPLE, keys, limit: PAGE, now: context.now })).people.map(
      (person) => [person.personKey, person] as const,
    ),
  );
  const known = await findPeople(tx, keys);
  const people = keys.flatMap((key) => {
    const person = known.get(key);
    const named = listed.get(key);
    return person ? [person] : named ? [namedPerson(key, named)] : [];
  });
  const threads = await readPeopleThreads(tx, keys);
  const profileIds = people.flatMap((person) => person.profileId ?? []);
  const conversationIds = people.flatMap((person) => person.conversationId ?? []);
  const onThreads = [...threads.values()].flat();
  const messageIds = onThreads.flatMap((thread) => thread.messageIds);
  const sends = await readQueuedSends(tx, { conversationIds, messageIds, now: context.now });
  const waits = people.flatMap((person) => context.waits.get(person.canonicalKey) ?? []);
  const stored = await readSignals(tx, keys);
  return {
    people,
    threads,
    standings: await personStandings(tx, people),
    listed: new Set(listed.keys()),
    conversations: await readConversations(tx, conversationIds),
    invitations: await readInvitations(tx, profileIds),
    invites: await readInvites(tx, profileIds),
    replies: await readReplies(tx, onThreads.flatMap((thread) => thread.replyIds)),
    likes: await readLikes(tx, messageIds),
    sends,
    actions: await readActions(tx, [
      ...waits.flatMap((wait) => (wait.source === "action" ? [wait.id] : [])),
      ...sends.flatMap((send) => (send.conversationId === null ? [] : [send.id])),
    ]),
    signals: stored.signals,
    postAuthors: stored.postAuthors,
    signalPosts: stored.signalPosts,
    countries: await knownCountries(tx, profileIds),
  };
}

/** An item while its facts are gathered. */
type Draft = {
  key: string;
  type: InboxItemType;
  kinds: Set<InboxItemType>;
  where: string;
  campaignId: number | null;
  channelId: number | null;
  thread: PersonThread | null;
  /** The urns on it, a like is placed by. */
  urns: string[];
  refs: Set<string>;
  lastAt: number;
  waits: Wait[];
  sends: ItemSend[];
  theirs: TheirWords | null;
  oursAt: number | null;
  /** What the send `oursAt` dates was. */
  oursKind: SentKind | null;
  invite: ItemInvite | null;
  untouched: Untouched | null;
  /** When Scout found the matched post this item is. */
  foundAt: number | null;
  /** When Scout read what an untouched item is. */
  scoutReadAt: number | null;
  watchUntil: number | null;
  likedAt: number | null;
  /** Every line its snippet may be: words on it, theirs and ours, and what
   *  an invite on it says. */
  lines: Array<{ at: number; text: string }>;
  /** The lines that are words between the two of them. */
  spoken: Spoken[];
  postAuthor: string | null;
};

function later(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/** Our send went out at `at`: the item's newest says what it was. */
function sent(draft: Draft, at: number, kind: SentKind): void {
  if (draft.oursAt === null || at >= draft.oursAt) draft.oursKind = kind;
  draft.oursAt = later(draft.oursAt, at);
}

/** The comments and replies a public thread holds, as an item's refs spell
 *  them; its invites are the item's by the reply they answer. */
function threadRefs(thread: PersonThread): string[] {
  return [...thread.messageIds.map((id) => `message:${id}`), ...thread.replyIds.map((id) => `reply:${id}`)];
}

/** Where a public thread is, as a row names it. */
function whereOf(thread: PersonThread): string {
  switch (thread.kind) {
    case "their_post":
      return THEIR_POST;
    case "own_post":
      return "on your post";
    case "their_reply":
    case "spotted_in":
      return whereOfPost(thread.postAuthor);
  }
}

/** A comment of theirs on someone else's post, where the post's writer is
 *  known. */
function whereOfPost(author: string | null | undefined): string {
  return author?.trim() ? `on ${author.trim()}’s post` : "on a post";
}

/** Words on one line, cut at the snippet's length in characters, never
 *  inside one (`truncateChars`). */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return truncateChars(line, SNIPPET_MAX) === line ? line : `${truncateChars(line, SNIPPET_MAX - 1).trimEnd()}…`;
}

/** One person's items, gathered from the page's rows: every place first,
 *  then what waits and what is on its way, each on the item that holds it. */
function itemsOfPerson(person: Person, page: Page, context: Context, campaignId: number | undefined): PersonItems {
  const key = person.canonicalKey;
  const threads = page.threads.get(key) ?? [];
  const drafts = new Map<string, Draft>();
  const add = (
    itemKey: string,
    type: InboxItemType,
    where: string,
    at: { campaignId: number | null; channelId?: number },
    thread: PersonThread | null = null,
  ): Draft => {
    const draft: Draft = {
      key: itemKey,
      type,
      kinds: new Set([type]),
      where,
      campaignId: at.campaignId,
      channelId: at.channelId ?? (at.campaignId === null ? null : (context.campaigns.get(at.campaignId)?.channelId ?? null)),
      thread,
      urns: thread?.urns ?? [],
      refs: new Set(thread ? threadRefs(thread) : []),
      lastAt: thread?.lastAt ?? 0,
      waits: [],
      sends: [],
      theirs: null,
      oursAt: null,
      oursKind: null,
      invite: null,
      untouched: null,
      foundAt: null,
      scoutReadAt: null,
      watchUntil: thread?.watchUntil ?? null,
      likedAt: null,
      lines: [],
      spoken: [],
      postAuthor: null,
    };
    drafts.set(itemKey, draft);
    return draft;
  };
  const holding = (test: (thread: PersonThread) => boolean) =>
    [...drafts.values()].find((draft) => draft.thread !== null && test(draft.thread));
  const newest = (types: readonly InboxItemType[]) =>
    [...drafts.values()]
      .filter((draft) => types.includes(draft.type))
      .sort((a, b) => b.lastAt - a.lastAt || a.key.localeCompare(b.key))[0];
  // When our first words to this person went out, on any of their items.
  let firstSendAt: number | null = null;
  const sentAt = (at: number) => {
    firstSendAt = firstSendAt === null ? at : Math.min(firstSendAt, at);
  };
  const conversation = person.conversationId === null ? undefined : page.conversations.get(person.conversationId);
  const messages = () =>
    drafts.get(MESSAGES) ??
    add(MESSAGES, "dm", "Messages", {
      campaignId: conversation?.campaignId ?? null,
      ...(conversation ? { channelId: conversation.channelId } : {}),
    });

  // Every public thread: their post, their comments and replies, and our
  // words there.
  for (const thread of threads) {
    const item = add(
      thread.key,
      thread.kind === "their_post" ? "post" : "comment",
      whereOf(thread),
      { campaignId: thread.campaign?.id ?? null },
      thread,
    );
    if (thread.kind === "their_post") {
      if (thread.postedAt !== null) item.theirs = { kind: "post", at: thread.postedAt };
      if (thread.excerpt) item.lines.push({ at: thread.postedAt ?? thread.matchedAt ?? 0, text: thread.excerpt });
    }
    for (const event of thread.events) {
      if (event.kind === "their_reply") {
        const reply = page.replies.get(event.incomingCommentId);
        if (reply && (item.theirs === null || event.at >= item.theirs.at)) {
          item.theirs = {
            kind: thread.kind === "own_post" ? "comment" : "reply",
            at: event.at,
            status: reply.status,
            reading: reply.reading,
          };
        }
        if (event.text !== null) {
          item.lines.push({ at: event.at, text: event.text });
          item.spoken.push({ at: event.at, text: event.text, ours: false });
        }
      } else if (event.kind === "our_comment" || event.kind === "our_reply") {
        if (event.status === "posted") {
          sent(item, event.at, event.kind === "our_comment" ? "comment" : "reply");
          sentAt(event.at);
        }
        item.lines.push({ at: event.at, text: `You: ${event.text}` });
        item.spoken.push({ at: event.at, text: event.text, ours: true });
      }
    }
    for (const id of thread.messageIds) item.likedAt = later(item.likedAt, page.likes.get(id) ?? null);
    if (thread.room) {
      if (thread.room.comment) item.lines.push({ at: thread.room.readAt, text: thread.room.comment });
      // Their room comment is the owner's to answer only while the room is
      // current and Audience lists them, which is what the badge reads.
      if (thread.messageIds.length === 0 && !thread.room.stale && page.listed.has(key)) {
        item.untouched = {
          kind: "room_comment",
          fit: thread.room.fit,
          skipped: thread.room.skipped,
          readAt: thread.room.readAt,
        };
        item.scoutReadAt = thread.room.readAt;
      }
    }
  }

  // The words of theirs Find leads stored, on a post or a comment that is no
  // item yet: nothing of ours is on it, and the owner has not joined it.
  for (const signal of page.signals.get(key) ?? []) {
    const urn = signal.commentUrn ?? signal.postUrn;
    // A post of theirs Scout kept a row for is a post to join like any, with
    // its comment box; any other has no row to write on.
    const postId = signal.kind === "post" ? page.signalPosts.get(signal.postUrn) : undefined;
    const itemKey = postId === undefined ? `signal:${signal.id}` : `post:${postId}`;
    if (drafts.has(itemKey)) continue;
    if ([...drafts.values()].some((draft) => draft.urns.includes(urn) || draft.urns.includes(signal.postUrn))) continue;
    const at = signal.saidAt ?? signal.seenAt;
    const item = add(
      itemKey,
      signal.kind === "post" ? "post" : "comment",
      signal.kind === "post" ? THEIR_POST : whereOfPost(page.postAuthors.get(signal.postUrn)),
      { campaignId: signal.campaignId },
    );
    item.urns = [urn, signal.postUrn];
    if (signal.kind !== "post") item.postAuthor = page.postAuthors.get(signal.postUrn) ?? null;
    item.untouched = { kind: "signal", at };
    item.scoutReadAt = signal.seenAt;
    item.lastAt = Math.max(item.lastAt, at);
    item.lines.push({ at, text: signal.words });
  }

  // Their Messages, wherever a message either way is.
  for (const message of conversation?.theirs ?? []) {
    const item = messages();
    if (item.theirs === null || message.at >= item.theirs.at) item.theirs = { kind: "dm", at: message.at };
    item.refs.add(message.ref);
    if (message.text) {
      item.lines.push({ at: message.at, text: message.text });
      item.spoken.push({ at: message.at, text: message.text, ours: false });
    }
    item.lastAt = Math.max(item.lastAt, message.at);
  }
  for (const message of conversation?.ours ?? []) {
    const item = messages();
    if (message.confirmed) {
      sent(item, message.at, "message");
      sentAt(message.at);
    }
    item.refs.add(message.ref);
    if (message.text) {
      item.lines.push({ at: message.at, text: `You: ${message.text}` });
      item.spoken.push({ at: message.at, text: message.text, ours: true });
    }
    item.lastAt = Math.max(item.lastAt, message.at);
  }

  // Their invitations: on the item of the reply they followed, else an item
  // of their own.
  const invitationItems = new Map<number, Draft>();
  const accepting = new Map<string, Draft>();
  for (const invitation of person.profileId === null ? [] : (page.invitations.get(person.profileId) ?? [])) {
    const after =
      invitation.replyId === null ? undefined : holding((thread) => thread.replyIds.includes(invitation.replyId!));
    const item =
      after ??
      add(`invitation:${invitation.id}`, "invite", "Invitations", {
        campaignId: invitation.campaignId,
        channelId: invitation.channelId,
      });
    item.kinds.add("invite");
    item.refs.add(`invitation:${invitation.id}`);
    item.lastAt = Math.max(item.lastAt, invitation.at);
    if (invitation.pending || item.invite === null) item.invite = { from: "them", at: invitation.at, goneAt: invitation.goneAt };
    if (invitation.pending) {
      item.lines.push({
        at: invitation.at,
        text: after ? "Invited you to connect after replying to you" : "Invited you to connect",
      });
    }
    // Their words stay once the owner has accepted: the row still says they invited.
    item.spoken.push({ at: invitation.at, text: invitation.note ?? NO_NOTE, ours: false });
    invitationItems.set(invitation.id, item);
    accepting.set(invitation.invitationId, item);
  }

  // Our invites: on the item of the reply they answer, else the newest public
  // item, else an item of their own.
  const inviteItems = new Map<number, Draft>();
  for (const invite of person.profileId === null ? [] : (page.invites.get(person.profileId) ?? [])) {
    const item =
      (invite.replyId === null ? undefined : holding((thread) => thread.replyIds.includes(invite.replyId!))) ??
      newest(["post", "comment"]) ??
      add(`invite:${invite.id}`, "invite", "Invitations", { campaignId: invite.campaignId, channelId: invite.channelId });
    item.kinds.add("invite");
    item.refs.add(`action:${invite.id}`);
    if (invite.answerEventId !== null) item.refs.add(`event:${invite.answerEventId}`);
    inviteItems.set(invite.id, item);
    if (invite.sentAt === null) continue;
    if (item.invite?.from !== "them") item.invite = { from: "us", sentAt: invite.sentAt, answer: invite.answer };
    sent(item, invite.sentAt, "invite");
    sentAt(invite.sentAt);
    item.lastAt = Math.max(item.lastAt, invite.sentAt);
    if (invite.answer === null) {
      item.lines.push({ at: invite.sentAt, text: `Invite sent · waiting for ${person.firstName ?? "them"}` });
    }
  }

  // A ledger row by its kind: a message is the Messages', an invite is where
  // the invite is, an acceptance is where the invitation is, a like is on
  // the post or comment it is on.
  const ofAction = (id: number): Draft | undefined => {
    const action = page.actions.get(id);
    switch (action?.kind) {
      case "dm":
      case "followup":
        return messages();
      case "invite":
        return inviteItems.get(id);
      case "accept_invite":
        return action.targetId === null ? undefined : accepting.get(action.targetId);
      default:
        return action?.urn ? onUrn(action.urn) : undefined;
    }
  };
  const onUrn = (urn: string) => [...drafts.values()].find((draft) => draft.urns.includes(urn));
  const anywhere = () => newest(["post", "comment", "invite", "dm"]);

  for (const wait of context.waits.get(key) ?? []) {
    const home = (() => {
      switch (wait.source) {
        case "message":
          return holding((thread) => thread.messageIds.includes(wait.id));
        case "reply":
          return holding((thread) => thread.replyIds.includes(wait.id));
        case "action":
          return ofAction(wait.id);
        case "thread":
          return messages();
        case "invitation":
          return invitationItems.get(wait.id);
      }
    })();
    const item =
      home ??
      anywhere() ??
      add(`wait:${wait.source}:${wait.id}`, "comment", "on a post", { campaignId: wait.campaignId });
    item.waits.push(wait);
    item.refs.add(`${wait.source}:${wait.id}`);
    item.lastAt = Math.max(item.lastAt, wait.at);
    if (wait.kind === "invite_to_approve") item.lines.push({ at: wait.at, text: "Your agent drafted an invite note" });
  }

  for (const send of page.sends) {
    const item =
      send.conversationId === null
        ? holding((thread) => thread.messageIds.includes(send.id))
        : send.conversationId === person.conversationId
          ? (ofAction(send.id) ?? anywhere())
          : undefined;
    if (!item) continue;
    item.sends.push({ kind: send.kind, id: send.id, state: send.state, queuedAt: send.queuedAt });
    const ref = sendRef(send);
    item.refs.add(`${ref.kind}:${ref.id}`);
  }

  // The person's standing speaks for every item where it is about all of
  // them — closed, an outcome, a conversation the owner holds; a step waiting
  // for their answer follows our newest words. The rest is the items' own: a
  // room, a send being read or held, an invite out.
  const standing = page.standings.get(key) ?? null;
  const everywhere =
    standing?.kind === "closed" || standing?.kind === "outcome" || standing?.kind === "yours" ? standing : null;
  const awaited =
    standing?.kind === "waiting"
      ? ([...drafts.values()]
          .filter((draft) => draft.oursAt !== null)
          .sort((a, b) => b.oursAt! - a.oursAt! || a.key.localeCompare(b.key))[0] ?? anywhere())
      : undefined;

  const inScope = [...drafts.values()].filter((draft) => campaignId === undefined || draft.campaignId === campaignId);
  const items = inScope
    .map((draft): InboxItem => {
      const facts: ItemFacts = {
        waits: draft.waits,
        sends: draft.sends,
        theirs: draft.theirs,
        oursAt: draft.oursAt,
        invite: draft.invite,
        untouched: draft.untouched,
        watchUntil: draft.watchUntil,
        likedAt: draft.likedAt,
        standing: everywhere ?? (draft === awaited ? standing : null),
        scoutReadAt: draft.scoutReadAt,
        firstSendAt,
        now: context.now,
      };
      const line = draft.lines.reduce<Draft["lines"][number] | null>(
        (shown, entry) => (shown === null || entry.at >= shown.at ? entry : shown),
        null,
      );
      const channelId = draft.channelId ?? context.channelId;
      const network = (channelId === null ? undefined : context.channels.get(channelId)) ?? "linkedin";
      return {
        key: draft.key,
        channel: { id: channelId, network, label: NETWORK_LABEL[network] },
        type: draft.type,
        kinds: ITEM_TYPES.filter((type) => draft.kinds.has(type)),
        where: draft.where,
        snippet: line === null ? "" : oneLine(line.text),
        status: itemStatus(facts),
        campaignId: draft.campaignId,
        foundAt: draft.foundAt,
        lastAt: draft.lastAt,
        words: line === null ? "" : line.text,
        spoken: draft.spoken.reduce<Spoken | null>(
          (shown, entry) => (shown === null || entry.at >= shown.at ? entry : shown),
          null,
        ),
        oursKind: draft.oursKind,
        postAuthor: draft.postAuthor,
        thread: draft.thread,
        facts,
        refs: [...draft.refs],
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt || a.key.localeCompare(b.key));

  const rooms = inScope.flatMap((draft) => (draft.thread?.room ? [draft.thread.room] : []));
  return {
    person,
    country: person.profileId === null ? null : (page.countries.get(person.profileId) ?? null),
    items,
    fit: rooms.some((room) => room.fit === "fits" && !room.stale) ? "fits" : null,
  };
}

/** Whether a person's name, headline or company holds the words searched
 *  for, ignoring case — the Inbox's search today. */
function matchesSearch(person: Person, search: string | undefined): boolean {
  const words = search?.trim().toLocaleLowerCase("en");
  if (!words) return true;
  return [person.name, person.headline, person.company].some((field) =>
    field?.toLocaleLowerCase("en").includes(words),
  );
}

/** What the options on keep of `listed`: whether a person passes them — past
 *  one group where it is named — and how many people each option lists,
 *  among those every other group and the search keep. */
function narrowedBy<S extends FilterSpec>(
  spec: S,
  listed: ReadonlyArray<{ person: Person; values: { [G in keyof S]: readonly string[] } }>,
  input: { filters?: FiltersOf<S>; search?: string },
) {
  const groups = Object.keys(spec) as Array<keyof S & string>;
  const on = (group: keyof S & string): readonly string[] => input.filters?.[group] ?? [];
  const holds = (entry: (typeof listed)[number], group: keyof S & string, option: string) =>
    entry.values[group].includes(option);
  const passes = (entry: (typeof listed)[number], skip?: keyof S & string) =>
    groups.every(
      (group) => group === skip || on(group).length === 0 || on(group).some((option) => holds(entry, group, option)),
    );
  const filterCounts = Object.fromEntries(
    groups.map((group) => [
      group,
      Object.fromEntries(
        spec[group]!.map((option) => [
          option,
          listed.filter(
            (entry) =>
              matchesSearch(entry.person, input.search) && passes(entry, group) && holds(entry, group, option),
          ).length,
        ]),
      ),
    ]),
  ) as CountsOf<S>;
  return { passes, filtering: groups.some((group) => on(group).length > 0), filterCounts };
}

export type { AnswerKind, LeadTemperature };

/** What moved a person last: their answer, a send of ours that went out, or
 *  an outcome the owner confirmed. */
export type ActivityKind = AnswerKind | "our_send" | "outcome";

/** What the row's what line says the newest activity was: their reply under a
 *  comment of ours or under a reply of ours, their message, their invitation
 *  or their acceptance; our comment, reply or message that went out, or our
 *  invite; or an outcome the owner confirmed. */
export type WhatKind =
  | "reply_to_comment"
  | "reply_to_reply"
  | "dm"
  | "invitation"
  | "acceptance"
  | "our_comment"
  | "our_reply"
  | "our_message"
  | "our_invite"
  | ConversionOutcome;

/** What a row's marks are drawn from, and what the filters read: whose move
 *  it is, the one send that needs the eye, whether a draft waits, and the
 *  outcome. `dashboard/app/inbox/row-marks.ts` words them. */
export type RowFacts = {
  /** `not_answered`: they have spoken last, the owner has read it, and
   *  nothing of ours is on its way or failed since. `waiting`: a send of ours
   *  that went out is the newest. None where an outcome is confirmed. */
  turn: "not_answered" | "waiting" | null;
  /** The send that needs the owner's eye, else the one on its way: a failed
   *  or unclear one first, then the first in flight to read, with the slot it
   *  goes out at where the queue names one. */
  send: { family: "problem" | "progress"; label: string; labelAt: number | null } | null;
  /** A draft of ours waits for a yes on a conversation with them. */
  draft: boolean;
  outcome: ConversionOutcome | null;
};

/** A person who answered, as the list shows them. */
export type RelationshipRow = {
  key: string;
  name: string | null;
  initials: string;
  /** When they were last active: `latest.at`, the list's order. */
  lastAt: number;
  latest: { kind: ActivityKind; at: number };
  /** The newest activity, as the what line says it. */
  what: WhatKind;
  /** The newest words between you, one line, theirs as written and ours after
   *  "You: " — a draft waiting for a yes never among them. */
  words: string;
  /** How warm they are, from their words to the owner alone. */
  temperature: LeadTemperature;
  /** How well they fit the audience: Scout's fit where it researched them,
   *  else what their post or a room comment read as; null where none did. */
  fit: LeadFit | null;
  facts: RowFacts;
  /** Their newest answer, which the usage event names the row by. */
  answered: { kind: AnswerKind; at: number };
  /** When Engager first saw their newest answer, in any campaign: what
   *  opening them marks read as of. */
  seenAt: number;
  /** They answered after the owner last opened them (`people/reads.ts`). */
  unread: boolean;
  /** The owner filed them away, and nothing has come since. */
  archived: boolean;
  /** The campaigns their items are in, the newest item's first. */
  campaigns: Array<{ id: number; name: string }>;
};

export type RelationshipQuery = {
  campaignId?: number;
  unread?: boolean;
  /** A name, headline or company. */
  search?: string;
  filters?: RelationshipFilters;
  /** The canonical key of the person the owner has open, whose row comes back
   *  as `opened` when the filters keep them, or when they are archived. */
  open?: string;
  /** The Archived fold is open: its people come back in `archivedRows`. It
   *  opens by itself for an archived `open`. */
  archived?: boolean;
  cursor?: string | null;
  limit: number;
  now?: number;
};

export type RelationshipPage = {
  /** The people on the list: archived ones are not. */
  rows: RelationshipRow[];
  nextCursor: string | null;
  /** How many people the list holds over every page, the search and the
   *  filters applied. */
  count: number;
  filterCounts: RelationshipFilterCounts;
  /** The row of `open`'s person on any page, when the filters keep them —
   *  or, for someone archived, whatever the filters say. */
  opened: RelationshipRow | null;
  /** How many people are on the list under the campaign alone, the search
   *  and the filters not applied: whether there is anyone to narrow. */
  listedCount: number;
  /** How many of the people listed under the campaign and the search are
   *  unread, which the filters do not narrow. */
  unreadCount: number;
  /** How many people under the campaign and the search are archived. */
  archivedCount: number;
  /** The archived people, newest activity first and `limit` of them, while
   *  the fold is open; none while it is shut. The filters do not narrow
   *  them. */
  archivedRows: RelationshipRow[];
};

/** What the owner confirmed with each person, and when, by `p.` key. */
async function readOutcomes(
  tx: Tx,
  keys: readonly string[],
  campaignId: number | undefined,
): Promise<Map<string, { at: number; outcome: ConversionOutcome }>> {
  if (keys.length === 0) return new Map();
  const { rows } = await tx.execute(sql`
    select 'p.' || conversation.author_profile_id as key, max(outcome.observed_at)::float8 as at,
      (array_agg(conversation.outcome order by outcome.observed_at desc))[1] as outcome
    from conversations conversation
    join outcome_events outcome on outcome.id = conversation.outcome_event_id
    where conversation.author_profile_id in (${listOf(keys.map((key) => key.slice(2)))})
      and conversation.outcome is not null
      ${campaignId === undefined ? sql`` : sql`and conversation.owning_campaign_id = ${campaignId}`}
    group by 1`);
  return new Map(
    (rows as Array<{ key: string; at: number; outcome: ConversionOutcome }>).map(
      (row) => [row.key, { at: row.at, outcome: row.outcome }] as const,
    ),
  );
}

/** What each person's newest reply sits under, of ours: a comment, a reply
 *  or a room reply, by `p.` key. A reply with no comment of ours behind it
 *  (a row from before they were kept) reads as under a comment. */
async function readReplyParents(
  tx: Tx,
  keys: readonly string[],
  campaignId: number | undefined,
): Promise<Map<string, "comment" | "reply" | "room_reply">> {
  if (keys.length === 0) return new Map();
  const { rows } = await tx.execute(sql`
    select distinct on (conversation.author_profile_id) 'p.' || conversation.author_profile_id as key, parent.kind
    from conversation_events event
    join conversations conversation on conversation.id = event.conversation_id
    join incoming_comments reply on reply.id = (event.source_ref->>'incomingCommentId')::bigint
    join messages parent on parent.id = reply.parent_message_id
    where event.type = 'reply_observed'
      and conversation.author_profile_id in (${listOf(keys.map((key) => key.slice(2)))})
      ${campaignId === undefined ? sql`` : sql`and conversation.owning_campaign_id = ${campaignId}`}
    order by conversation.author_profile_id, event.occurred_at desc, event.id desc`);
  return new Map(
    (rows as Array<{ key: string; kind: "comment" | "reply" | "room_reply" }>).map(
      (row) => [row.key, row.kind] as const,
    ),
  );
}

/** What a person's words to the owner have shown, by `authorIdentity`: the
 *  best intent, how many times they wrote, and when last. A person who never
 *  scored high enough for Engager to keep a lead has none. */
async function readTemperatureInputs(tx: Tx, profileIds: readonly string[]) {
  if (profileIds.length === 0) return new Map<string, Pick<Lead, "intentLevel" | "wordTouchCount" | "lastWordsAt" | "fit">>();
  const rows = await tx
    .select({
      profileId: leads.profileId,
      intentLevel: leads.intentLevel,
      wordTouchCount: leads.wordTouchCount,
      lastWordsAt: leads.lastWordsAt,
      fit: leads.fit,
    })
    .from(leads)
    .where(inArray(leads.profileId, profileIds.map(authorIdentity)));
  return new Map(rows.map((row) => [authorIdentity(row.profileId), row] as const));
}

/**
 * How warm a person is, from what they wrote to the owner (`leads/temperature`)
 * and nothing about who they are. Anyone on the list has answered, so is a
 * Relationship whatever their lead row's stage says; with no lead row their
 * words showed no interest worth keeping one for, so they are Cold. They are
 * quiet since the later of their lead's last words and their newest reply or
 * message, when that is over a month old: the lead row can lag the answer, or
 * be missing the time.
 */
function temperatureOf(
  words: Pick<Lead, "intentLevel" | "wordTouchCount" | "lastWordsAt"> | undefined,
  answered: RelationshipRow["answered"],
  now: number,
  declinedAt: number | null,
): LeadTemperature {
  const wrote = answered.kind === "reply" || answered.kind === "dm";
  const heard = [words?.lastWordsAt ?? null, wrote ? answered.at : null].filter((at) => at !== null);
  return leadTemperature(
    {
      stage: "relationship",
      intentLevel: words?.intentLevel ?? "none",
      wordTouches: words?.wordTouchCount ?? 0,
      lastWordsAt: heard.length === 0 ? null : Math.max(...heard),
      declinedAt,
    },
    now,
  )!;
}

const OUR_SEND: Record<SentKind, WhatKind> = {
  comment: "our_comment",
  reply: "our_reply",
  message: "our_message",
  invite: "our_invite",
};

/** Our newest send that went out to them, on any item, and what it was. */
function newestSend(items: readonly InboxItem[]): { at: number; kind: SentKind } | null {
  return items.reduce<{ at: number; kind: SentKind } | null>(
    (best, item) =>
      item.facts.oursAt !== null && item.oursKind !== null && (best === null || item.facts.oursAt > best.at)
        ? { at: item.facts.oursAt, kind: item.oursKind }
        : best,
    null,
  );
}

/**
 * The newest of their answer, a send of ours that went out and an outcome the
 * owner confirmed, and what it was. A send still queued or failed holds no
 * `oursAt`, so it moves no one; on a tie the answer comes first.
 */
function activityOf(
  answered: RelationshipRow["answered"],
  parent: "comment" | "reply" | "room_reply" | undefined,
  ours: { at: number; kind: SentKind } | null,
  outcome: { at: number; outcome: ConversionOutcome } | undefined,
): Pick<RelationshipRow, "latest" | "what"> {
  let latest: RelationshipRow["latest"] = answered;
  let what: WhatKind =
    answered.kind === "reply"
      ? parent === undefined || parent === "comment"
        ? "reply_to_comment"
        : "reply_to_reply"
      : answered.kind;
  if (ours !== null && ours.at > latest.at) {
    latest = { kind: "our_send", at: ours.at };
    what = OUR_SEND[ours.kind];
  }
  if (outcome !== undefined && outcome.at > latest.at) {
    latest = { kind: "outcome", at: outcome.at };
    what = outcome.outcome;
  }
  return { latest, what };
}

/** An invitation says it, and the acceptance of ours with nothing said since. */
const CONNECTED = "You’re connected. Nothing sent yet.";

/**
 * The newest words between the two of them, one line: theirs as written, ours
 * after "You: ", and — under an outcome — theirs after their first name. An
 * acceptance with no words since reads that they are connected. A draft of
 * ours waiting for a yes is no words, a send still queued or not posted is.
 */
function wordsOf(
  items: readonly InboxItem[],
  what: WhatKind,
  latest: RelationshipRow["latest"],
  firstName: string | null,
): string {
  const spoken = items.reduce<Spoken | null>(
    (best, item) => (item.spoken !== null && (best === null || item.spoken.at > best.at) ? item.spoken : best),
    null,
  );
  if (what === "acceptance" && (spoken === null || spoken.at < latest.at)) return CONNECTED;
  if (spoken === null) return "";
  const speaker = spoken.ours ? "You" : latest.kind === "outcome" ? (firstName ?? "They") : null;
  return oneLine(speaker === null ? spoken.text : `${speaker}: ${spoken.text}`);
}

/** The waits that are a draft of ours for the owner's yes, on a conversation
 *  with the person. */
const DRAFT_WAITS: ReadonlySet<WaitKind> = new Set([
  "comment_draft",
  "reply_draft",
  "room_reply_draft",
  "dm_draft",
  "invite_to_approve",
]);

/**
 * What a row's marks and the state filters read. A send of ours counts as
 * "since" their newest word when it was put on its way after it, whichever of
 * an item's sends reads first; one only the person's standing speaks for (a
 * message being checked, an invite held) has no moment and counts as since.
 * Nothing is Not answered once the conversation is closed (an opt-out, an
 * exclusion), nor for a newest reply the owner chose not to answer: Don't
 * reply is an answer.
 */
function factsOf(
  items: readonly InboxItem[],
  answered: RelationshipRow["answered"],
  ours: { at: number } | null,
  unread: boolean,
  outcome: ConversionOutcome | undefined,
): RowFacts {
  const problem = mostUrgent(items.filter((item) => item.status.family === "problem"));
  const flights = items.flatMap((item) => sendInFlight(item.facts) ?? []);
  const flight = flights.reduce<SendInFlight | null>(
    (best, entry) =>
      best === null ||
      entry.rank < best.rank ||
      (entry.rank === best.rank && (entry.queuedAt ?? 0) > (best.queuedAt ?? 0))
        ? entry
        : best,
    null,
  );
  const since =
    flights.some((entry) => entry.queuedAt === null) ||
    items.some(
      (item) =>
        item.facts.sends.some((send) => send.queuedAt > answered.at) ||
        item.facts.waits.some((wait) => (wait.kind === "failed" || wait.kind === "unclear") && wait.at > answered.at),
    );
  const closed = items.some((item) => item.facts.standing?.kind === "closed");
  const replies = items
    .flatMap((item) =>
      item.facts.theirs?.kind === "reply" || item.facts.theirs?.kind === "comment" ? [item.facts.theirs] : [],
    )
    .sort((a, b) => b.at - a.at);
  const dismissed = answered.kind === "reply" && replies[0]?.status === "dismissed";
  return {
    turn:
      outcome !== undefined || closed
        ? null
        : ours !== null && ours.at > answered.at
          ? "waiting"
          : !unread && !since && !dismissed
            ? "not_answered"
            : null,
    send: problem
      ? { family: "problem", label: problem.status.label, labelAt: null }
      : flight
        ? { family: "progress", label: flight.label, labelAt: flight.labelAt }
        : null,
    draft: items.some((item) => item.facts.waits.some((wait) => DRAFT_WAITS.has(wait.kind))),
    outcome: outcome ?? null,
  };
}

/** Newest activity first, then by key. */
function byActivity(a: Pick<RelationshipRow, "lastAt" | "key">, b: Pick<RelationshipRow, "lastAt" | "key">): number {
  return b.lastAt - a.lastAt || a.key.localeCompare(b.key);
}

function encodeActivity(row: Pick<RelationshipRow, "lastAt" | "key">): string {
  return Buffer.from(JSON.stringify([row.lastAt, row.key]), "utf8").toString("base64url");
}

function decodeActivity(value: string | null | undefined): Pick<RelationshipRow, "lastAt" | "key"> | null {
  if (!value || value.length > 2_000) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isFinite(parsed[0]) || typeof parsed[1] !== "string") {
      return null;
    }
    return { lastAt: parsed[0] as number, key: parsed[1] };
  } catch {
    return null;
  }
}

/** The campaigns a person's items are in, the newest item's first. */
function campaignsOf(items: readonly InboxItem[], context: Context): Array<{ id: number; name: string }> {
  const ids = [...new Set(items.flatMap((item) => (item.campaignId === null ? [] : [item.campaignId])))];
  return ids.flatMap((id) => {
    const campaign = context.campaigns.get(id);
    return campaign ? [{ id, name: campaign.name }] : [];
  });
}

/** The row of each of `answers` that has an item to show, with what each
 *  filter reads of them. Only these people are read in full, and someone the
 *  owner said never to engage is on no list. */
async function listedRows(
  tx: Tx,
  answers: ReadonlyMap<string, AnswerState>,
  input: Pick<RelationshipQuery, "campaignId" | "now">,
  cache?: InboxReadCache,
) {
  const now = input.now ?? Date.now();
  const context = await readContext(tx, now, input.campaignId);
  const [found] = await itemsIn(tx, context, [{ ...scopeOf(context, input.campaignId), keys: [...answers.keys()] }]);
  if (cache && input.campaignId === undefined) {
    cache.items = found;
    cache.waits = context.waits;
    cache.read = (reads) => itemsIn(tx, context, reads.map((read) => ({ ...scopeOf(context, read.campaignId), keys: read.keys })));
  }
  const keys = [...found!.keys()];
  const outcomes = await readOutcomes(tx, keys, input.campaignId);
  const parents = await readReplyParents(
    tx,
    keys.filter((key) => answers.get(key)?.kind === "reply"),
    input.campaignId,
  );
  const words = await readTemperatureInputs(
    tx,
    [...found!.values()].flatMap((entry) => entry.person.profileId ?? []),
  );
  const declined = await readDeclined(tx, [...found!.values()].flatMap((entry) => entry.person.profileId ?? []));
  return [...found!.values()].flatMap((entry) => {
    const answer = answers.get(entry.person.canonicalKey);
    if (!answer || entry.items.length === 0 || entry.person.doNotEngage) return [];
    const { canonicalKey: key, name, initials } = entry.person;
    const answered = { kind: answer.kind, at: answer.occurredAt };
    const ours = newestSend(entry.items);
    const outcome = outcomes.get(key);
    const { latest, what } = activityOf(answered, parents.get(key), ours, outcome);
    const temperature = temperatureOf(
      entry.person.profileId === null ? undefined : words.get(authorIdentity(entry.person.profileId)),
      answered,
      now,
      entry.person.profileId === null ? null : (declined.get(authorIdentity(entry.person.profileId)) ?? null),
    );
    const fit = (entry.person.profileId === null ? null : words.get(authorIdentity(entry.person.profileId))?.fit) ?? entry.fit;
    const facts = factsOf(entry.items, answered, ours, answer.unread, outcome?.outcome);
    const row: RelationshipRow = {
      key,
      name,
      initials,
      lastAt: latest.at,
      latest,
      what,
      words: wordsOf(entry.items, what, latest, entry.person.firstName),
      temperature,
      fit,
      facts,
      answered,
      seenAt: answer.observedAt,
      unread: answer.unread,
      archived: answer.archived,
      campaigns: campaignsOf(entry.items, context),
    };
    const state = [
      ...(row.unread ? ["unread"] : []),
      ...(facts.turn === null ? [] : [facts.turn]),
      ...(facts.draft ? ["draft_ready"] : []),
    ];
    const channel = [...new Set(entry.items.map((item) => item.channel.network))];
    return [{ person: entry.person, row, values: { channel, state, temp: [temperature.temperature], fit: fit === null ? [] : [fit] } }];
  });
}

/**
 * The Inbox's list: each person who answered the owner — in a campaign's
 * conversations, or in any — once, under their canonical key, newest activity
 * first. Nobody else is on it: not the author of a post Scout matched, a
 * comment author it spotted, someone who only liked, only wrote on the owner's own
 * post, or only has a first-contact draft of ours waiting for a yes; and not
 * someone on the do-not-engage list. A person's activity is the newest of
 * their answer, a send of ours that went out and an outcome the owner
 * confirmed.
 *
 * Each row says what that activity was and the newest words between the two,
 * how warm the person is (`leads/temperature`), and the facts its marks and
 * the state filters read (`RowFacts`) — all from rows already stored. It says
 * whether the owner has opened the person since they last answered
 * (`unread`) and whether they filed them away (`archived`), both from
 * `person_reads` against the newest answer Engager saw, in any campaign. An
 * archived person is off the list and its counts, and listed apart while the
 * fold is open.
 *
 * Every fact is already stored: no conversation is opened, nothing drafted or
 * sent, no profile or thread read spent. A person with no item to show is
 * left off.
 */
export async function relationshipRows(tx: Tx, input: RelationshipQuery, cache?: InboxReadCache): Promise<RelationshipPage> {
  const listed = await listedRows(tx, await answersWithState(tx, input.campaignId), input, cache);
  const onList = listed.filter(({ row }) => !row.archived);
  const { passes, filterCounts } = narrowedBy(RELATIONSHIP_FILTERS, onList, input);
  // The search and the campaign narrow the counts; the filters narrow the
  // rows alone.
  const searched = listed.filter(({ person }) => matchesSearch(person, input.search));
  const ordered = searched
    .filter((entry) => !entry.row.archived && passes(entry) && (input.unread === undefined || entry.row.unread === input.unread))
    .map(({ row }) => row)
    .sort(byActivity);
  const filed = searched
    .filter(({ row }) => row.archived)
    .map(({ row }) => row)
    .sort(byActivity);
  const after = decodeActivity(input.cursor);
  const start = after === null ? 0 : ordered.findIndex((row) => byActivity(row, after) > 0);
  const limit = Math.min(MOST_ROWS, Math.max(1, Math.floor(input.limit)));
  const rows = start < 0 ? [] : ordered.slice(start, start + limit);
  const last = rows.at(-1);
  const opened =
    listed.find((entry) => entry.row.key === input.open && (entry.row.archived || passes(entry)))?.row ?? null;
  return {
    rows,
    nextCursor: last !== undefined && start + limit < ordered.length ? encodeActivity(last) : null,
    count: ordered.length,
    filterCounts,
    opened,
    listedCount: onList.length,
    unreadCount: searched.filter(({ row }) => !row.archived && row.unread).length,
    archivedCount: filed.length,
    archivedRows: input.archived || opened?.archived ? filed.slice(0, limit) : [],
  };
}

/**
 * The unread people `countUnreadPeople` counts, under a campaign or in every
 * one, and the first `limit` of them as the list's rows, newest activity
 * first: a campaign's "N people waiting" with their names. The count and the
 * rows come from one read of the unread alone, so they cannot differ, and
 * naming two people does not read everyone who ever answered.
 */
export async function unreadPeopleFirst(
  tx: Tx,
  input: { campaignId?: number; limit: number; now?: number },
): Promise<{ count: number; rows: RelationshipRow[] }> {
  const unread = await unreadPeople(tx, input.campaignId);
  if (unread.size === 0) return { count: 0, rows: [] };
  const listed = await listedRows(tx, unread, input);
  return { count: unread.size, rows: listed.map(({ row }) => row).sort(byActivity).slice(0, input.limit) };
}
