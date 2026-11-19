import { sql, type SQL } from "drizzle-orm";
import type { ActionKind, IncomingHoldReason } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { MESSAGE_SENDS } from "../actions/keys";
import { stillReadingSql } from "../execution/reconcileReads";
import type { DmThreadItem } from "../conversations/inboxView";
import { findPeople, memberProfilesSql, type Person } from "./directory";
import { parsePersonKey, personKeySql } from "./key";

/**
 * WHAT WAITS ON THE OWNER, PER PERSON — every item that needs their yes or
 * their words, attributed to the person it is about and summed up once per
 * person, so the Inbox and its badge count people and no reply waits where
 * the owner cannot see it.
 *
 * Each wait is exactly one kind, read from the row that waits: a draft or a
 * like, invite or DM waiting for a yes; someone's invitation to the account,
 * still pending, with the Accept invite waiting on it if one is; a reply
 * nobody answered that intake held or that only the owner can write; a send
 * that failed or whose outcome nobody knows; a conversation the inbox list
 * held for the owner. A Stop, a proposed change, a matched post with no draft, a send the
 * account keeps refusing, a DM whose outcome Engager is still reading, a
 * reply their later one in the same thread speaks for, a reply that came
 * back while its Reply step was Off, and anything turned down or settled as
 * not sent wait on no one — and nothing waits about someone who asked not to
 * be contacted.
 *
 * `personWaits` reads the one query below for `waitingPeople` and for the
 * Inbox's list and its badge (`people/inbox.ts`), so none of them can
 * disagree on what waits. Reads only, inside the caller's
 * `withOrg`; `jobs`, outside RLS, is read with an explicit organization
 * predicate.
 */

export const WAIT_KINDS = [
  "comment_draft",
  "reply_draft",
  "room_reply_draft",
  "like_to_approve",
  "invite_to_approve",
  "dm_draft",
  "accept_invite",
  "held_reply",
  "own_reply",
  "failed",
  "unclear",
  "owner_held_dm",
] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/** Why an unanswered reply is the owner's to write: the sensitivity check
 *  stopped it, nothing drafted it, the owner turned the draft down, or the
 *  owner took the conversation over. One a policy let go — Reply Off, own-post
 *  replies off, its campaign gone — is no one's: it came back. */
export type OwnReplyCause = "sensitive" | "undrafted" | "rejected_draft" | "takeover";

/** What a wait is about where its kind holds several: `comment` or `reply`
 *  for a message, the ledger kind for an action, why a held reply is held (null: from before the reason was
 *  kept), and why an own reply is the owner's. */
export type WaitAbout =
  | "comment"
  | "reply"
  | "room_reply"
  | ActionKind
  | "backlog"
  | "campaign_holds"
  | "unconfirmed"
  | OwnReplyCause
  | null;

export type Wait = {
  kind: WaitKind;
  /** The row that waits: a `messages`, `actions`,
   *  `incoming_comments`,
   *  `dm_threads` or `incoming_invitations` row. */
  source: "message" | "action" | "reply" | "thread" | "invitation";
  id: number;
  about: WaitAbout;
  /** Since when it waits, as near as its row says. */
  at: number;
  campaignId: number | null;
  /** Why a room reply the owner said yes to is back for another: the reason
   *  the gate returned it, which `waitLine` words. */
  reason?: string | null;
};

export type PersonSummary = {
  count: number;
  pill: string;
  line: string;
  /** Every wait is one the Inbox pills "Held", so there is nothing to act on
   *  yet: the person is listed below everyone who has something. */
  held: boolean;
  /** The newest and the oldest wait. */
  last: number;
  oldest: number;
  /** The campaigns the waits are in, the newest wait's first. */
  campaignIds: number[];
};

export type WaitingPerson = { person: Person; waits: Wait[]; summary: PersonSummary };

/** A reply of ours on the reply that is anything but turned down — a draft
 *  waiting, a send on its way, out or in trouble — stands for it: it waits,
 *  where it does, as itself. */
const ANSWERED = sql`exists (
  select 1 from messages answer
  where answer.organization_id = reply.organization_id
    and answer.incoming_comment_id = reply.id
    and answer.status <> 'rejected')`;

/** A later reply of theirs in the same thread, not let go. A LinkedIn thread
 *  is flat under its root, so the answer to their newest reply answers what
 *  they said before it: only the newest waits — never a second box beside
 *  its draft. One dismissed leaves the reply before it standing on its own. */
const SUPERSEDED = sql`exists (
  select 1 from incoming_comments later
  where later.organization_id = reply.organization_id
    and later.thread_parent_urn = reply.thread_parent_urn
    and coalesce(nullif(later.author_profile_id, ''), later.author_member_urn)
      = coalesce(nullif(reply.author_profile_id, ''), reply.author_member_urn)
    and later.removed_at is null
    and later.status <> 'dismissed'
    and (later.received_at, later.id) > (reply.received_at, reply.id))`;

/** The replier's open conversation, while the owner holds it: `human_owned` under
 *  an open takeover. */
const TAKEN_OVER = sql`left join lateral (
  select conversation.id, conversation.author_profile_id
  from conversations conversation
  where conversation.organization_id = reply.organization_id
    and conversation.author_profile_id = reply.author_profile_id
    and conversation.closed_reason is null
    and conversation.ops_status = 'human_owned'
    and exists (
      select 1 from pause_controls pause
      where pause.organization_id = conversation.organization_id
        and pause.scope = 'conversation'
        and pause.scope_id = conversation.id
        and pause.reason = 'takeover'
        and pause.resumed_at is null)
  limit 1
) taken on true`;

/** In a conversation the owner holds, their newest words — a reply or a DM —
 *  came after ours. */
const THEIRS_LAST = sql`greatest(
    (select max(theirs.received_at) from incoming_comments theirs
      where theirs.organization_id = reply.organization_id
        and theirs.author_profile_id = taken.author_profile_id
        and theirs.removed_at is null),
    (select max(event.occurred_at) from conversation_events event
      where event.organization_id = reply.organization_id
        and event.conversation_id = taken.id
        and event.type = 'inbound_message_observed')
  ) > coalesce(greatest(
    (select max(ours.posted_at) from messages ours
      where ours.organization_id = reply.organization_id
        and ours.target_profile_id = taken.author_profile_id
        and ours.status = 'posted'),
    (select max(event.occurred_at) from conversation_events event
      where event.organization_id = reply.organization_id
        and event.conversation_id = taken.id
        and event.type = 'dm_confirmed')
  ), 0)`;

/** Something will still read the reply: its pipeline job, or the Ambassador
 *  its conversation event woke, queued or running. `jobs` is outside RLS, so the
 *  organization is the reply's own. Over an `incoming_comments` row named
 *  `reply`. */
export const STILL_READING = sql`(
  exists (
    select 1 from jobs job
    where job.organization_id = reply.organization_id
      and job.idempotency_key = 'process_incoming:' || reply.id
      and job.status in ('queued', 'running'))
  or exists (
    select 1 from conversation_sources source
    join conversation_events event
      on event.organization_id = source.organization_id
     and event.conversation_id = source.conversation_id
     and event.type in ('reply_observed', 'reply_edited')
     and event.source_ref->>'incomingCommentId' = reply.id::text
    join jobs wake
      on wake.organization_id = reply.organization_id
     and wake.idempotency_key = 'conversation_event:' || event.id
     and wake.status in ('queued', 'running')
    where source.organization_id = reply.organization_id
      and source.incoming_comment_id = reply.id))`;

/** The holds intake puts on a reply before anything reads it. A held row
 *  from before the reason was kept is one of these too; any other reason is
 *  a check's, which leaves the reply the owner's to answer. */
const INTAKE_HOLDS: readonly IncomingHoldReason[] = ["backlog", "campaign_holds", "unconfirmed"];

/** A reply intake held: never classified, drafted or woken for. */
export function heldAtIntake(reply: { sensitivity: "ok" | "hold"; holdReason: IncomingHoldReason | null }): boolean {
  return reply.sensitivity === "hold" && (reply.holdReason === null || INTAKE_HOLDS.includes(reply.holdReason));
}

/**
 * Why an unanswered reply waits, or null when it does not (yet). Held — taken
 * in before anything read it, never classified, drafted or woken for — comes
 * first; then, in a conversation the owner holds, it waits only while their
 * newest words are later than ours; then the reasons it is the owner's own.
 */
const REPLY_CAUSE = sql`case
  when reply.status = 'new' and reply.sensitivity = 'hold'
    and (reply.hold_reason is null or reply.hold_reason in (${sql.join(
      INTAKE_HOLDS.map((reason) => sql`${reason}`),
      sql`, `,
    )})) then 'held'
  when taken.id is not null then case when ${THEIRS_LAST} then 'takeover' end
  when reply.status = 'new' and reply.sensitivity = 'hold' then 'sensitive'
  when reply.status = 'reply_proposed' then 'rejected_draft'
  when reply.status = 'new' and reply.draft_request_id is null and not ${STILL_READING} then 'undrafted'
end`;

/** A comment or reply of ours waiting for a yes, failed, or sent unsure: the
 *  post's author's, or the replier's. */
const MESSAGE_WAITS = sql`
  select
    case m.status
      when 'proposed' then case m.kind when 'comment' then 'comment_draft'
        when 'room_reply' then 'room_reply_draft' else 'reply_draft' end
      when 'failed' then 'failed'
      else 'unclear'
    end as kind,
    'message' as source,
    m.id::bigint as id,
    m.kind as about,
    coalesce(nullif(reply.author_profile_id, ''), nullif(post.author_profile_id, ''), m.target_profile_id)
      as profile_id,
    coalesce(reply.author_member_urn, m.room_reply_target->>'memberUrn') as member_urn,
    reply.id::bigint as incoming_comment_id,
    case m.status when 'proposed' then m.created_at else coalesce(m.scheduled_at, m.created_at) end as at,
    m.campaign_id,
    case when m.kind = 'room_reply' and m.status = 'proposed' then m.error end as reason
  from messages m
  left join discovered_posts post
    on post.organization_id = m.organization_id and post.id = m.discovered_post_id
  left join incoming_comments reply
    on reply.organization_id = m.organization_id and reply.id = m.incoming_comment_id
  where m.status in ('proposed', 'failed', 'needs_review')
    and not (m.status = 'proposed' and m.kind = 'room_reply' and m.error is null
      and (m.worker_run_id is null or coalesce(m.room_reply_target->>'selectedBy', '') <> 'worker'))`;

/** The pending invitation an Accept invite on the ledger is for: the wait
 *  is the invitation's, and the acceptance is how it is answered. */
const FOR_PENDING_INVITATION = sql`exists (
  select 1 from incoming_invitations invitation
  where invitation.organization_id = action.organization_id
    and invitation.channel_id = action.channel_id
    and invitation.invitation_id = action.target->>'id'
    and invitation.status = 'pending')`;

/** A like, invite, DM, follow-up or acceptance on the action ledger waiting
 *  for a yes, or sent unsure — but an acceptance of an invitation still
 *  pending, which waits as the invitation; a withdrawal whose yes lapsed,
 *  which the pending invite's own Withdraw approves again; and a DM, a
 *  follow-up or a withdrawal whose outcome Engager is still reading, which
 *  waits on no one until the reads give up (`execution/reconcileReads.ts`). */
const ACTION_WAITS = sql`
  select
    case
      when action.status = 'uncertain' then 'unclear'
      when action.kind = 'like_target' then 'like_to_approve'
      when action.kind = 'invite' then 'invite_to_approve'
      when action.kind = 'accept_invite' then 'accept_invite'
      else 'dm_draft'
    end,
    'action',
    action.id,
    action.kind,
    coalesce(nullif(action.author_profile_id, ''), action.target->>'authorProfileId'),
    null,
    null,
    case action.status
      when 'uncertain' then coalesce(action.submitted_at, action.updated_at)
      else action.created_at
    end,
    action.campaign_id,
    null
  from actions action
  where action.status in ('awaiting_review', 'uncertain')
    and action.kind not in (${sql.join(MESSAGE_SENDS.map((kind) => sql`${kind}`), sql`, `)})
    and not (action.kind = 'accept_invite' and action.status = 'awaiting_review' and ${FOR_PENDING_INVITATION})
    and not (action.kind = 'withdraw_invite' and action.status = 'awaiting_review')
    and not ${stillReadingSql()}`;

/** Someone's invitation to the account, still pending — attributed to a
 *  conversation or not, with Accept invite on its campaign or not — unless
 *  an acceptance of it is already on its way, sent, or sent unsure. */
const INVITATION_WAITS = sql`
  select
    'accept_invite',
    'invitation',
    invitation.id,
    'accept_invite',
    invitation.sender_profile_id,
    null,
    null,
    coalesce(invitation.received_at, invitation.first_observed_at),
    conversation.owning_campaign_id,
    null
  from incoming_invitations invitation
  left join conversations conversation
    on conversation.organization_id = invitation.organization_id and conversation.id = invitation.conversation_id
  where invitation.status = 'pending'
    and not exists (
      select 1 from actions accept
      where accept.organization_id = invitation.organization_id
        and accept.channel_id = invitation.channel_id
        and accept.kind = 'accept_invite'
        and accept.target->>'id' = invitation.invitation_id
        and accept.status in ('reserved', 'approved', 'dispatching', 'uncertain', 'confirmed'))`;

/** A reply nobody answered that waits on the owner, held or theirs to write.
 *  One a policy let go (`ignored`) waits on no one, in a conversation the
 *  owner holds too: it came back, and the owner's own answer still takes it
 *  up (`saveOwnerReply`). */
const SEND_WAITS = sql`
  select
    case reply.cause when 'held' then 'held_reply' else 'own_reply' end,
    'reply',
    reply.id,
    case reply.cause when 'held' then reply.hold_reason else reply.cause end,
    reply.author_profile_id,
    reply.author_member_urn,
    reply.id,
    reply.received_at,
    reply.campaign_id,
    null
  from (
    select reply.*, ${REPLY_CAUSE} as cause
    from incoming_comments reply
    ${TAKEN_OVER}
    where reply.removed_at is null
      and reply.status in ('new', 'reply_proposed')
      and not ${ANSWERED}
      and not ${SUPERSEDED}
  ) reply
  where reply.cause is not null`;

/** A conversation the inbox list held for the owner — what
 *  {@link heldConversations} keeps of `dmThreadItems`. */
const THREAD_WAITS = sql`
  select
    'owner_held_dm',
    'thread',
    thread.id,
    null,
    conversation.author_profile_id,
    null,
    null,
    coalesce(thread.last_message_at, thread.held_message_at, thread.last_observed_at),
    conversation.owning_campaign_id,
    null
  from dm_threads thread
  join conversations conversation on conversation.organization_id = thread.organization_id and conversation.id = thread.conversation_id
  where thread.binding = 'bound' and conversation.closed_reason is null and thread.owner_held_at is not null`;

/** Each wait under the key of the person it is about; a row that names no
 *  one is left out. Someone whose conversation — the one their pane shows:
 *  open, else the newest — closed on their opt-out waits on no one: nothing
 *  reaches them again, so nothing about them is the owner's to decide. */
function keyedWaitsSql(campaignId: number | undefined): SQL {
  return sql`
    with member_profiles as (${memberProfilesSql()}),
    waits as (${sql.join(
      [MESSAGE_WAITS, ACTION_WAITS, INVITATION_WAITS, SEND_WAITS, THREAD_WAITS],
      sql` union all `,
    )}),
    keyed as (
      select ${personKeySql({
        profileId: sql`coalesce(nullif(waits.profile_id, ''), alias.profile_id)`,
        memberUrn: sql`waits.member_urn`,
        incomingCommentId: sql`waits.incoming_comment_id`,
      })} as key, waits.*
      from waits
      left join member_profiles alias
        on nullif(waits.profile_id, '') is null and alias.urn = waits.member_urn
      left join lateral (
        select conversation.closed_reason
        from conversations conversation
        where conversation.author_profile_id = coalesce(nullif(waits.profile_id, ''), alias.profile_id)
        order by conversation.closed_reason is null desc, conversation.id desc
        limit 1
      ) conversation on true
      where conversation.closed_reason is distinct from 'opt_out'
        ${campaignId === undefined ? sql`` : sql`and waits.campaign_id = ${campaignId}`}
    )`;
}

type WaitRow = {
  key: string;
  kind: WaitKind;
  source: Wait["source"];
  id: number;
  about: WaitAbout;
  at: number;
  campaign_id: number | null;
  reason: string | null;
};

/** What waits on each person, by key, the newest wait first: the rows
 *  `waitingPeople` lists. `campaignId` keeps the waits in that campaign. */
export async function personWaits(tx: Tx, opts: { campaignId?: number; personKey?: string } = {}): Promise<Map<string, Wait[]>> {
  const { rows } = await tx.execute(sql`
    ${keyedWaitsSql(opts.campaignId)}
    select key, kind, source, id::float8 as id, about, at::float8 as at, campaign_id::float8 as campaign_id, reason
    from keyed
    where key is not null ${opts.personKey === undefined ? sql`` : sql`and key = ${opts.personKey}`}
    order by at desc, source, id`);
  const byKey = new Map<string, Wait[]>();
  for (const row of rows as WaitRow[]) {
    const waits = byKey.get(row.key) ?? [];
    waits.push({
      kind: row.kind,
      source: row.source,
      id: row.id,
      about: row.about,
      at: row.at,
      campaignId: row.campaign_id,
      reason: row.reason,
    });
    byKey.set(row.key, waits);
  }
  return byKey;
}

/** Every person something waits on: those with something to act on before
 *  those whose waits are all held, the newest wait first in each group, then
 *  by name. How many wait on a person does not order them. `campaignId`
 *  keeps the waits in that campaign. */
export async function waitingPeople(tx: Tx, opts: { campaignId?: number } = {}): Promise<WaitingPerson[]> {
  const byKey = await personWaits(tx, opts);
  const people = await findPeople(tx, [...byKey.keys()]);
  return [...byKey]
    .map(([key, waits]) => ({ person: people.get(key) ?? onlyKey(key), waits, summary: personSummary(waits) }))
    .sort(
      (a, b) =>
        Number(a.summary.held) - Number(b.summary.held) ||
        b.summary.last - a.summary.last ||
        byName(a.person, b.person),
    );
}

/** The waits that are a decision for the owner's yes: a draft of ours, a like,
 *  an invite, a DM or follow-up, or their invitation to the account. While one
 *  waits on a person, no new post of theirs is drafted
 *  (`people/draftHolds.ts`). */
export const DECISION_KINDS = [
  "comment_draft",
  "reply_draft",
  "room_reply_draft",
  "like_to_approve",
  "invite_to_approve",
  "dm_draft",
  "accept_invite",
] as const satisfies readonly WaitKind[];

/** The oldest decision waiting on each person, by key — or on the one person
 *  `key` names — from the rows `waitingPeople` lists. */
export async function decisionsWaiting(tx: Tx, opts: { key?: string } = {}): Promise<Map<string, Wait>> {
  const { rows } = await tx.execute(sql`
    ${keyedWaitsSql(undefined)}
    select distinct on (key)
      key, kind, source, id::float8 as id, about, at::float8 as at, campaign_id::float8 as campaign_id, reason
    from keyed
    where kind in (${sql.join(
      DECISION_KINDS.map((kind) => sql`${kind}`),
      sql`, `,
    )})
      ${opts.key === undefined ? sql`and key is not null` : sql`and key = ${opts.key}`}
    order by key, at, source, id`);
  return new Map(
    (rows as WaitRow[]).map((row) => [
      row.key,
      { kind: row.kind, source: row.source, id: row.id, about: row.about, at: row.at, campaignId: row.campaign_id, reason: row.reason },
    ]),
  );
}

/**
 * The sends of ours that failed or went out unsure on a post that names no
 * one — no author, no target — newest first, by message id. No person can
 * hold them, so `waitingPeople` cannot list them; they still wait on the
 * owner, and the Inbox lists them about no person (`app/inbox/setup-data.ts`).
 */
export async function unattributedSends(tx: Tx): Promise<number[]> {
  const { rows } = await tx.execute(sql`
    ${keyedWaitsSql(undefined)}
    select id::float8 as id from keyed
    where key is null and source = 'message' and kind in ('failed', 'unclear')
    order by at desc, id desc`);
  return (rows as Array<{ id: number }>).map((row) => row.id);
}

function byName(a: Person, b: Person): number {
  if (a.name === null || b.name === null) {
    return (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || a.canonicalKey.localeCompare(b.canonicalKey);
  }
  return a.name.localeCompare(b.name, "en") || a.canonicalKey.localeCompare(b.canonicalKey);
}

/** Someone no row the directory reads names: their key, and nothing more. */
function onlyKey(key: string): Person {
  const parsed = parsePersonKey(key);
  return {
    canonicalKey: key,
    profileId: parsed?.kind === "profile" ? parsed.profileId : null,
    memberUrn: parsed?.kind === "member" ? parsed.memberUrn : null,
    incomingCommentId: parsed?.kind === "reply" ? parsed.incomingCommentId : null,
    name: null,
    firstName: null,
    initials: "?",
    headline: null,
    company: null,
    profileUrl: null,
    relationship: "unknown",
    latestRead: { invitation: null, self: false, at: null },
    conversationId: null,
    campaigns: [],
    doNotEngage: false,
    lastTouch: null,
  };
}

/** What a held reply's pill reads. */
const HELD_PILL = "Held";

const PILL: Record<Exclude<WaitKind, "unclear">, string> = {
  comment_draft: "Draft ready",
  reply_draft: "Draft ready",
  room_reply_draft: "Room reply waiting",
  like_to_approve: "Draft ready",
  invite_to_approve: "Invite",
  dm_draft: "DM draft",
  accept_invite: "Invite to you",
  held_reply: HELD_PILL,
  own_reply: "Yours to answer",
  failed: "Not posted",
  owner_held_dm: "Yours",
};

/** A wait whose pill reads "Held": there is nothing on it for the owner to
 *  act on yet. Read from the pill, so what the Inbox says and where it lists
 *  the person cannot part. */
export function isHeld(wait: Pick<Wait, "kind">): boolean {
  return wait.kind !== "unclear" && PILL[wait.kind] === HELD_PILL;
}

/** A like nobody can vouch for, as against a send. */
function isLike(wait: Wait): boolean {
  return wait.about === "like_target";
}

/** What went out unsure, as the owner calls it. */
const UNCLEAR_NOUN: Partial<Record<NonNullable<WaitAbout>, string>> = {
  reply: "reply",
  room_reply: "room reply",
  dm: "message",
  followup: "message",
  invite: "invite",
  accept_invite: "acceptance",
  withdraw_invite: "withdrawal",
};

/** Why a yes on a room reply no longer holds, in the owner's words. */
function returnedBecause(reason: string): string {
  if (reason === "approval_invalidated:expired") return "your yes expired";
  if (reason.startsWith("approval_")) return "your yes no longer matches it";
  return reason.replaceAll("_", " ");
}

function waitLine(wait: Wait): string {
  switch (wait.kind) {
    case "comment_draft":
      return "A comment to approve";
    case "reply_draft":
      return "A reply to approve";
    case "room_reply_draft":
      return wait.reason ? `A reply to their comment to approve again: ${returnedBecause(wait.reason)}` : "A reply to their comment to approve";
    case "like_to_approve":
      return "A like to approve";
    case "invite_to_approve":
      return "An invite to approve: the step to messages";
    case "dm_draft":
      return "A message to approve";
    case "accept_invite":
      return "They invited you to connect";
    case "held_reply":
      return "Replied to your comment · nothing drafted";
    case "own_reply":
      return "A reply only you can answer";
    case "failed":
      return `Your approved ${wait.about === "room_reply" ? "room reply" : wait.about === "reply" ? "reply" : "comment"} did not post`;
    case "unclear":
      return isLike(wait)
        ? "Say whether the like went through"
        : `Say whether your ${(wait.about !== null && UNCLEAR_NOUN[wait.about]) || "comment"} went out`;
    case "owner_held_dm":
      return "Their newest message: in a conversation that is yours";
  }
}

/** What a yes sends, as a line names one and two of it, in the order a line
 *  names two kinds. */
const APPROVALS: Partial<Record<WaitKind, { one: string; two: string }>> = {
  room_reply_draft: { one: "a room reply", two: "Two room replies" },
  reply_draft: { one: "a reply", two: "Two replies" },
  comment_draft: { one: "a comment", two: "Two comments" },
  like_to_approve: { one: "a like", two: "Two likes" },
  dm_draft: { one: "a message", two: "Two messages" },
  invite_to_approve: { one: "an invite", two: "Two invites" },
};
const APPROVAL_ORDER = Object.keys(APPROVALS) as WaitKind[];

/** "A reply and a comment to approve" for two approvals; else the first two
 *  lines that differ, and how many waits they leave out. */
function lineOf(waits: Wait[]): string {
  if (waits.length === 2 && waits.every((wait) => APPROVALS[wait.kind] !== undefined)) {
    const [first, second] = [...waits]
      .sort((a, b) => APPROVAL_ORDER.indexOf(a.kind) - APPROVAL_ORDER.indexOf(b.kind))
      .map((wait) => APPROVALS[wait.kind]!);
    if (first === second) return `${first!.two} to approve`;
    return `${first!.one.charAt(0).toUpperCase()}${first!.one.slice(1)} and ${second!.one} to approve`;
  }
  const shown = [...new Set(waits.map(waitLine))].slice(0, 2);
  const more = waits.filter((wait) => !shown.includes(waitLine(wait))).length;
  return [...shown, ...(more > 0 ? [`+${more} more`] : [])].join(" · ");
}

/**
 * The one summary of what waits on a person, for their Inbox row and their
 * pane's header alike: how many, the pill, the line, whether all of it is
 * held, the newest and the oldest wait, and the campaigns. `waits` holds one
 * wait or more, newest first, as `waitingPeople` gives them.
 */
export function personSummary(waits: Wait[]): PersonSummary {
  const [only] = waits;
  const pill =
    waits.length === 1 && only
      ? only.kind === "unclear"
        ? isLike(only)
          ? "Like unclear"
          : "Outcome unclear"
        : PILL[only.kind]
      : `${waits.length} waiting`;
  const times = waits.map((wait) => wait.at);
  return {
    count: waits.length,
    pill,
    line: lineOf(waits),
    held: waits.every(isHeld),
    last: Math.max(...times),
    oldest: Math.min(...times),
    campaignIds: [...new Set(waits.flatMap((wait) => (wait.campaignId === null ? [] : [wait.campaignId])))],
  };
}

/** The DM conversations the inbox list held for the owner that are theirs to
 *  answer: unread first, then the most recent. */
export function heldConversations(threads: readonly DmThreadItem[]): DmThreadItem[] {
  const unread = (item: DmThreadItem) => ((item.unreadCount ?? 0) > 0 ? 1 : 0);
  const latest = (item: DmThreadItem) => item.lastMessageAt ?? item.lastMessage?.at ?? item.lastObservedAt;
  return threads
    .filter((item) => item.ownerHeldAt != null && item.section === "needs_you")
    .sort((a, b) => unread(b) - unread(a) || latest(b) - latest(a));
}
