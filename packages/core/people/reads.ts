import { eq, sql, type SQL } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { personReads, type ConversationEventType } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { findPeople, memberProfilesSql, resolvePersonKeys } from "./directory";
import { roomExcludedSql } from "../rooms/eligibility";
import { parsePersonKey } from "./key";

/**
 * WHO IS UNREAD. A person is unread until the owner opens them, and again
 * whenever they answer after that: the Inbox works like email, and nobody who
 * answered can slip past. What counts as an answer is one query
 * (`readAnswers`): the conversation events of `ENGAGED_BACK_EVENTS` and an
 * invitation of theirs tied to no conversation; a like is neither. The list, its
 * count and the badge all read it, so they cannot disagree. Opening and
 * archiving are the owner's, and write a key and two times (`person_reads`).
 * Nothing here sends, opens a conversation, reads LinkedIn or calls a model.
 */

/** Their reply under our comment, their message, their invitation to us, their
 *  acceptance of ours. A like never makes anyone unread and never brings them
 *  into the list; neither does an edit of a reply, nor anything of ours. */
export const ENGAGED_BACK_EVENTS = [
  "reply_observed",
  "inbound_message_observed",
  "incoming_invitation_observed",
  "invitation_accepted",
] as const satisfies readonly ConversationEventType[];

/** What an answer was: a reply, a message, an invitation, an acceptance. */
export type AnswerKind = "reply" | "dm" | "invitation" | "acceptance";

const ANSWER_OF: Record<(typeof ENGAGED_BACK_EVENTS)[number], AnswerKind> = {
  reply_observed: "reply",
  inbound_message_observed: "dm",
  invitation_accepted: "acceptance",
  incoming_invitation_observed: "invitation",
};

/** A person's newest answer, by when it happened, and when Engager first saw
 *  the newest of all of them (the moment they turned unread). */
export type Answer = { kind: AnswerKind; occurredAt: number; observedAt: number };

/** A person's newest answer of one type, on the campaign whose conversation holds
 *  it; no campaign for an invitation tied to no conversation. */
type Row = {
  key: string;
  type: (typeof ENGAGED_BACK_EVENTS)[number];
  campaign_id: number | null;
  at: number;
  observed_at: number;
};

function answerRowsSql(
  where: { personKeys?: readonly string[]; campaignId?: number },
): SQL {
  const profiles = where.personKeys?.flatMap((key) => (key.startsWith("p.") ? [key.slice(2)] : []));
  if (profiles?.length === 0) return sql`select null::text as key, null::text as type,
    null::float8 as campaign_id, null::float8 as at, null::float8 as observed_at where false`;
  const among = profiles && sql.join(profiles.map((profile) => sql`${profile}`), sql`, `);
  const types = sql.join(ENGAGED_BACK_EVENTS.map((type) => sql`${type}`), sql`, `);
  return sql`
    select 'p.' || conversation.author_profile_id as key, event.type, conversation.owning_campaign_id::float8 as campaign_id,
      max(event.occurred_at)::float8 as at, max(event.observed_at)::float8 as observed_at
    from conversation_events event
    join conversations conversation on conversation.id = event.conversation_id
    where event.type in (${types}) and conversation.author_profile_id <> ''
      ${where.campaignId === undefined ? sql`` : sql`and conversation.owning_campaign_id = ${where.campaignId}`}
      ${among ? sql`and conversation.author_profile_id in (${among})` : sql``}
      and (event.type <> 'inbound_message_observed'
        or not exists (select 1 from conversation_events later where later.supersedes_event_id = event.id))
      and (event.type <> 'incoming_invitation_observed'
        or not exists (select 1 from incoming_invitations hidden
          where hidden.conversation_event_id = event.id and hidden.status = 'dismissed'))
    group by 1, 2, 3
    ${
      where.campaignId === undefined
        ? sql`union all
          select 'p.' || sender_profile_id, 'incoming_invitation_observed', null::float8,
            max(coalesce(received_at, first_observed_at))::float8, max(first_observed_at)::float8
          from incoming_invitations
          where conversation_id is null and status <> 'dismissed' and sender_profile_id <> ''
            ${among ? sql`and sender_profile_id in (${among})` : sql``}
          group by 1`
        : sql``
    }`;
}

async function readAnswerRows(
  tx: Tx,
  where: { personKeys?: readonly string[]; campaignId?: number },
): Promise<Row[]> {
  const { rows } = await tx.execute<Row>(answerRowsSql(where));
  return rows;
}

/** Each person's newest answer among `rows`, and when Engager first saw the
 *  newest of all of them. */
function newestAnswers(rows: readonly Row[]): Map<string, Answer> {
  const newest = new Map<string, Answer>();
  for (const row of rows) {
    const held = newest.get(row.key);
    const observedAt = Math.max(row.observed_at, held?.observedAt ?? -Infinity);
    newest.set(
      row.key,
      row.at > (held?.occurredAt ?? -Infinity)
        ? { kind: ANSWER_OF[row.type], occurredAt: row.at, observedAt }
        : { ...held!, observedAt },
    );
  }
  return newest;
}

/**
 * Each person's newest answer, by `p.` key, for `personKeys` or for everyone;
 * a person who never answered is absent. On a campaign's conversations when
 * `campaignId` is given, else across every conversation they have, on every
 * account, and an invitation of theirs tied to no conversation — which a
 * campaign's list never holds. A message that was edited away and an
 * invitation the owner hid are no answer, and nor is a conversation with no
 * profile behind it.
 */
export async function readAnswers(
  tx: Tx,
  where: { personKeys?: readonly string[]; campaignId?: number } = {},
): Promise<Map<string, Answer>> {
  return newestAnswers(await readAnswerRows(tx, where));
}

/** Unread: they have answered, and the owner has not opened them since the
 *  newest answer was observed. Compared on `observed_at`, never `occurred_at`:
 *  a reply LinkedIn dates 10:00 that Engager first read at 10:10 is unread
 *  after a 10:05 open. */
export function isUnread(input: { newestObservedAt: number | null; readAt: number | null }): boolean {
  if (input.newestObservedAt === null) return false;
  return input.readAt === null || input.newestObservedAt > input.readAt;
}

/** Archived while the owner's filing is later than the newest answer: a newer
 *  reply, message, invitation or acceptance brings them back. */
export function isArchived(input: { newestObservedAt: number | null; archivedAt: number | null }): boolean {
  return input.archivedAt !== null && input.newestObservedAt !== null && input.archivedAt > input.newestObservedAt;
}

/** The canonical key of a person who has answered, or the reason there is
 *  none: a key that is no person's, and a person with nothing to read. */
async function inboxKey(tx: Tx, key: string): Promise<string> {
  if (!/^[pm]\./.test(key) || !parsePersonKey(key)) {
    throw new AppError("invalid_person_key", "That is not a person's key.", 400);
  }
  const canonical = (await resolvePersonKeys(tx, [key])).get(key) ?? key;
  if (!(await readAnswers(tx, { personKeys: [canonical] })).has(canonical)) {
    throw new AppError("person_not_in_inbox", "That person has not answered, so they are not in the Inbox.", 404);
  }
  return canonical;
}

/** One person's read state, written under the key it is kept by: the Inbox's
 *  people and Leads' share it. */
export async function writeRead(
  tx: Tx,
  key: string,
  set: { readAt: number | null } | { archivedAt: number | null },
  now: number,
) {
  await tx.insert(personReads).values({ personKey: key, ...set, updatedAt: now })
    .onConflictDoUpdate({ target: [personReads.organizationId, personReads.personKey], set: { ...set, updatedAt: now } });
}

async function setRead(tx: Tx, key: string, set: { readAt: number | null } | { archivedAt: number | null }, now: number) {
  await writeRead(tx, await inboxKey(tx, key), set, now);
}

/** `seenAt` is the newest answer the owner was shown, when they were shown
 *  one: read as of then, an answer observed since stays unread. */
export const markPersonRead = (tx: Tx, key: string, now: number, seenAt = now) =>
  setRead(tx, key, { readAt: Math.min(seenAt, now) }, now);
export const markPersonUnread = (tx: Tx, key: string, now = Date.now()) => setRead(tx, key, { readAt: null }, now);
export const archivePerson = (tx: Tx, key: string, now: number) => setRead(tx, key, { archivedAt: now }, now);
export const unarchivePerson = (tx: Tx, key: string, now = Date.now()) => setRead(tx, key, { archivedAt: null }, now);

/** Whether the owner has filed someone away, for a person who has answered;
 *  null for one who has not, who is on no list to be filed on. `key` is the
 *  person's canonical key. */
export async function archivedState(tx: Tx, key: string): Promise<{ archived: boolean } | null> {
  const answer = (await readAnswers(tx, { personKeys: [key] })).get(key);
  if (!answer) return null;
  const [read] = await tx.select().from(personReads).where(eq(personReads.personKey, key));
  return { archived: isArchived({ newestObservedAt: answer.observedAt, archivedAt: read?.archivedAt ?? null }) };
}

/** Whether someone's newest answer is still unread, and when the owner last
 *  opened them; a person who has not answered is never unread. `key` is the
 *  person's canonical key. */
export async function unreadState(tx: Tx, key: string): Promise<{ unread: boolean; readAt: number | null }> {
  const answer = (await readAnswers(tx, { personKeys: [key] })).get(key);
  const [read] = await tx.select().from(personReads).where(eq(personReads.personKey, key));
  const readAt = read?.readAt ?? null;
  return { unread: answer !== undefined && isUnread({ newestObservedAt: answer.observedAt, readAt }), readAt };
}

/** An answer, and where its person stands with the owner. */
export type AnswerState = Answer & { unread: boolean; archived: boolean };

type PersonRead = typeof personReads.$inferSelect;

/** Each of `listed` judged by their newest answer anywhere (`observedAt`) and
 *  by what the owner has done with them since. */
function withState(
  listed: ReadonlyMap<string, Answer>,
  anywhere: ReadonlyMap<string, Answer>,
  reads: ReadonlyMap<string, PersonRead>,
): Map<string, AnswerState> {
  return new Map(
    [...listed].map(([key, answer]) => {
      const observedAt = anywhere.get(key)?.observedAt ?? answer.observedAt;
      const read = reads.get(key);
      return [key, {
        ...answer,
        observedAt,
        unread: isUnread({ newestObservedAt: observedAt, readAt: read?.readAt ?? null }),
        archived: isArchived({ newestObservedAt: observedAt, archivedAt: read?.archivedAt ?? null }),
      }] as const;
    }),
  );
}

async function readStates(tx: Tx): Promise<Map<string, PersonRead>> {
  return new Map((await tx.select().from(personReads)).map((read) => [read.personKey, read] as const));
}

/**
 * Each person who answered — on a campaign's conversations, or on any — and
 * whether they are unread and whether they are archived. A campaign picks who
 * is listed; each is still judged by their newest answer anywhere
 * (`observedAt`), so one person is never read in one view and unread in
 * another. The Inbox's list and `unreadPeople` both read this.
 */
export async function answersWithState(tx: Tx, campaignId?: number): Promise<Map<string, AnswerState>> {
  const listed = await readAnswers(tx, { campaignId });
  const anywhere = campaignId === undefined ? listed : await readAnswers(tx);
  return withState(listed, anywhere, await readStates(tx));
}

/** The unread people among `answered`, not archived. */
const unreadOf = (answered: ReadonlyMap<string, AnswerState>): Array<[string, AnswerState]> =>
  [...answered].filter(([, state]) => state.unread && !state.archived);

/**
 * Which of `keys` the list drops: the people on the do-not-engage list, and
 * those the owner excluded by hand (the Never-engage path, a member alias),
 * as the directory reads them (`Person.doNotEngage`), so the list and every
 * count agree on who is out.
 */
async function barredPeople(tx: Tx, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const known = await findPeople(tx, keys);
  return new Set([...known].filter(([, person]) => person.doNotEngage).map(([key]) => key));
}

/**
 * The people who are unread and not archived — in every campaign, or the
 * people with an answer on one campaign's conversations — but for anyone the list
 * drops (`barredPeople`). The Inbox's "<n> unread", its badge and a
 * campaign's names all read this, so they cannot disagree.
 */
export async function unreadPeople(tx: Tx, campaignId?: number): Promise<Map<string, AnswerState>> {
  const unread = unreadOf(await answersWithState(tx, campaignId));
  const barred = await barredPeople(tx, unread.map(([key]) => key));
  return new Map(unread.filter(([key]) => !barred.has(key)));
}

/** How many people `unreadPeople` holds. */
export async function countUnreadPeople(tx: Tx, opts: { campaignId?: number } = {}): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    with member_profiles as (${memberProfilesSql()}), answers as (${answerRowsSql({})}),
    newest as (
      select key, max(observed_at) as observed_at
      from answers group by key
      ${opts.campaignId === undefined ? sql`` : sql`having bool_or(campaign_id = ${opts.campaignId})`}
    )
    select count(*)::float8 as count from newest
    left join person_reads state on state.person_key = newest.key
    left join engaged_profiles listed on listed.profile_id = substring(newest.key from 3)
    where (state.read_at is null or newest.observed_at > state.read_at)
      and (state.archived_at is null or state.archived_at <= newest.observed_at)
      and not coalesce(listed.do_not_engage, false)
      and not ${roomExcludedSql(sql`substring(newest.key from 3)`, sql`null::text`, sql`newest.key`, sql`member_profiles`)}
  `);
  return rows[0]?.count ?? 0;
}

/** `countUnreadPeople` for each of `campaignIds`, from one read of everyone's
 *  answers and state: the Campaigns list's people waiting. */
export async function countUnreadByCampaign(
  tx: Tx,
  campaignIds: readonly number[],
): Promise<Map<number, number>> {
  const rows = await readAnswerRows(tx, {});
  const anywhere = newestAnswers(rows);
  const reads = await readStates(tx);
  const unread = campaignIds.map((campaignId) =>
    unreadOf(withState(newestAnswers(rows.filter((row) => row.campaign_id === campaignId)), anywhere, reads)),
  );
  const barred = await barredPeople(tx, [...new Set(unread.flatMap((people) => people.map(([key]) => key)))]);
  return new Map(
    campaignIds.map((campaignId, index) => [
      campaignId,
      unread[index]!.filter(([key]) => !barred.has(key)).length,
    ]),
  );
}
