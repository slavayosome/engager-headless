import { and, count, desc, eq, inArray, isNull, min, notInArray, sql, type SQL } from "drizzle-orm";
import { isMessageSend, MESSAGE_SENDS } from "../actions/keys";
import { sendLike } from "../actions/likeTarget";
import { scheduledWakes, type WakeView } from "../agentStep/wakes";
import { OWNER_AUTHORED_MODEL } from "../operations/clientDrafting";
import { findPeople } from "../people/directory";
import { parsePersonKey, personKey } from "../people/key";
import { completedLedgerActionPredicate } from "../ratelimit/ledger";
import {
  ACTION_KINDS,
  actionApprovals,
  actions,
  campaigns,
  conversationEvents,
  conversationSources,
  conversations,
  discoveredPosts,
  incomingComments,
  messageStatusEvents,
  messages,
  pauseControls,
  rateLimitLedger,
  stepRuns,
  type ActionKind,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { cameBackFeed, type CameBackRow } from "../operations/cameBack";
import { blockedSends, loadMessageGroups, PASSING_HOLDS, type MessageGroupSpec } from "./messageRows";
import { QUEUE_STATUSES, type MessageStatus, type QueueMessage } from "./messageTypes";
import {
  ACTION_TAB_STATUSES,
  actionStatusNote,
  heldForReview,
  ledgerActionLabel,
  pauseLabel,
  type ActionRowView,
  type PauseView,
} from "./presentation";
import {
  companionLikeLabel,
  ledgerSendLabel,
  messageSendLabel,
  type SendLabel,
} from "./sendLabels";
import { PIPELINE_TABS, type PipelineTab } from "./tabs";

export * from "./presentation";
export * from "./sendLabels";
export * from "./tabs";
export * from "./upcoming";

/**
 * The action ledger's half of the pipeline: one group of `actions`
 * rows per tab, beside the `messages` rows `pipeline-data.ts` loads, and the
 * open Stops the owner can resume.
 *
 * A row carries the words of what it is aimed at, so a list of likes is a
 * list of people and words rather than of urns: someone's reply — who wrote
 * it and what they said, read off the thread the account observed — the post
 * a Like post is for, as discovered, or the comment of ours their reply
 * answered. An invitation, aimed at a person rather than at words, carries
 * the person and the exchange its note cites.
 */

/** The words of an action target that is a comment of ours: the text that went out. */
const ourCommentText = sql<string | null>`(
  select coalesce(${messages.finalText}, ${messages.proposedText})
  from ${messages}
  where ${messages.externalUrn} = ${actions.target} ->> 'urn'
  limit 1
)`;

/** The exchange an action cites — the reply its candidate answers, as the
 *  conversation recorded it: what an invitation's note is about. */
const citedExchange = sql<string | null>`(
  select ${conversationEvents.content}
  from ${conversationEvents}
  where ${conversationEvents.id} = (${actions.candidate} -> 'sources' -> 0 ->> 'eventId')::bigint
)`;

/** The person an action is to, by the name their latest reply carried. */
const personName = sql<string | null>`(
  select ${incomingComments.authorName}
  from ${incomingComments}
  where ${incomingComments.authorProfileId} = ${actions.authorProfileId}
  order by ${incomingComments.id} desc
  limit 1
)`;

/** The wake an action was proposed on: the checkpoint that proposed it served
 *  a wait of the step's own (`timeout:<id>`), whose quote and summary say why
 *  then. Null for an action an event's wake proposed. */
const wokenOn = sql<{ quote: string | null; rationale: string | null } | null>`(
  select jsonb_build_object('quote', waited.wait ->> 'quote', 'rationale', waited.rationale_summary)
  from ${stepRuns} as woke
  join ${stepRuns} as waited on woke.work_key = 'timeout:' || waited.id
  where woke.id = ${actions.stepRunId}
)`;

const PER_TAB = 50;

export type ActionGroups = {
  rows: Record<PipelineTab, ActionRowView[]>;
  counts: Record<PipelineTab, number>;
  pauses: PauseView[];
};

/** Every tab's rows and counts — or these campaigns' only, which leaves out
 *  the rows no campaign proposed. The open Stops stay the account's either
 *  way. */
export async function loadActionGroups(
  tx: Tx,
  { campaignIds }: { campaignIds?: readonly number[] } = {},
): Promise<ActionGroups> {
  const rows = {} as Record<PipelineTab, ActionRowView[]>;
  const counts = {} as Record<PipelineTab, number>;
  const campaign = campaignIds && inArray(actions.campaignId, [...campaignIds]);
  for (const tab of PIPELINE_TABS) {
    const where = and(inArray(actions.status, [...ACTION_TAB_STATUSES[tab]]), notInArray(actions.kind, [...MESSAGE_SENDS]), campaign)!;
    rows[tab] = await actionRowViews(tx, where);
    const [total] = await tx.select({ n: count() }).from(actions).where(where);
    counts[tab] = total?.n ?? 0;
  }
  return { rows, counts, pauses: await loadOpenPauses(tx) };
}

/** One conversation's rows still to settle: waiting for a yes, scheduled, or
 *  with an outcome nobody knows yet. */
export async function loadConversationActions(tx: Tx, conversationId: number): Promise<ActionRowView[]> {
  return actionRowViews(
    tx,
    and(
      eq(actions.conversationId, conversationId),
      notInArray(actions.kind, [...MESSAGE_SENDS]),
      inArray(actions.status, [
        ...ACTION_TAB_STATUSES.waitingForYes,
        ...ACTION_TAB_STATUSES.scheduled,
        "uncertain",
      ]),
    )!,
  );
}

/** These exact ledger rows, whatever their state: what a person's pane lists
 *  for the waits attributed to them. */
export async function loadActionRows(tx: Tx, ids: readonly number[]): Promise<ActionRowView[]> {
  if (ids.length === 0) return [];
  return actionRowViews(tx, inArray(actions.id, [...ids]));
}

/** The ledger rows `where` selects, newest first, each with the words of
 *  what it is aimed at. */
async function actionRowViews(tx: Tx, where: SQL): Promise<ActionRowView[]> {
  const found = await tx
    .select({
      action: actions,
      campaignName: campaigns.name,
      authorName: sql<string | null>`coalesce(${incomingComments.authorName}, ${discoveredPosts.authorName}, ${personName})`,
      excerpt: sql<string | null>`coalesce(${incomingComments.text}, ${discoveredPosts.contentText}, ${ourCommentText}, ${citedExchange})`,
      wake: wokenOn,
      runId: sql<number | null>`(select ${stepRuns.runId} from ${stepRuns} where ${stepRuns.id} = ${actions.stepRunId})`,
      approved: sql<boolean>`exists (
        select 1 from ${actionApprovals}
        where ${actionApprovals.actionExecutionId} = ${actions.id}
          and ${actionApprovals.invalidatedAt} is null
      )`,
    })
    .from(actions)
    .leftJoin(campaigns, eq(campaigns.id, actions.campaignId))
    .leftJoin(
      incomingComments,
      sql`${incomingComments.commentUrn} = ${actions.target} ->> 'urn'`,
    )
    .leftJoin(
      discoveredPosts,
      sql`${discoveredPosts.postUrn} = ${actions.target} ->> 'urn'`,
    )
    .where(where)
    .orderBy(desc(actions.updatedAt), desc(actions.id))
    .limit(PER_TAB);
  return found.map(({ action, campaignName, authorName, excerpt, wake, runId, approved }) => ({
    id: action.id,
    kind: action.kind,
    status: action.status,
    statusReason: action.statusReason,
    campaignId: action.campaignId,
    campaignName,
    conversationId: action.conversationId,
    personKey: personKey({ profileId: action.authorProfileId }),
    targetKind: action.target.kind,
    targetUrn: action.target.urn,
    context: authorName === null && excerpt === null ? null : { authorName, excerpt },
    text: action.candidate.text,
    receiptReason:
      typeof action.externalReceipt?.reason === "string" ? action.externalReceipt.reason : null,
    receiptDetail:
      typeof action.externalReceipt?.detail === "string" ? action.externalReceipt.detail : null,
    wake,
    runId,
    updatedAt: action.updatedAt,
    origin: action.origin,
    approved,
  }));
}

/** Every open Stop and takeover, newest first, named where the scope has a
 *  name the owner would know it by. */
export async function loadOpenPauses(tx: Tx, key?: string): Promise<PauseView[]> {
  const parsed = key === undefined ? undefined : parsePersonKey(key);
  if (key !== undefined && parsed?.kind !== "profile") return [];
  const profileId = parsed?.kind === "profile" ? parsed.profileId : undefined;
  const open = await tx
    .select()
    .from(pauseControls)
    .where(and(
      isNull(pauseControls.resumedAt),
      profileId === undefined ? undefined : and(
        eq(pauseControls.scope, "conversation"),
        inArray(pauseControls.scopeId, tx.select({ id: conversations.id }).from(conversations)
          .where(eq(conversations.authorProfileId, profileId))),
      ),
    ))
    .orderBy(desc(pauseControls.generation));
  const views: PauseView[] = [];
  for (const pause of open) {
    views.push({
      id: pause.id,
      scope: pause.scope,
      scopeId: pause.scopeId,
      reason: pause.reason,
      scopeName: await scopeName(tx, pause.scope, pause.scopeId),
      personKey: pause.scope === "conversation" ? await conversationPerson(tx, pause.scopeId) : null,
      pausedAt: pause.pausedAt,
    });
  }
  return views;
}

/** The person a conversation is with, by key. */
async function conversationPerson(tx: Tx, conversationId: number): Promise<string | null> {
  const [conversation] = await tx
    .select({ profileId: conversations.authorProfileId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return conversation ? personKey(conversation) : null;
}

async function scopeName(
  tx: Tx,
  scope: PauseView["scope"],
  scopeId: number,
): Promise<string | null> {
  if (scope === "campaign") {
    const [campaign] = await tx
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.id, scopeId));
    return campaign?.name ?? null;
  }
  if (scope === "conversation") {
    const [person] = await tx
      .select({ name: incomingComments.authorName })
      .from(conversations)
      .innerJoin(incomingComments, eq(incomingComments.authorProfileId, conversations.authorProfileId))
      .where(eq(conversations.id, scopeId))
      .limit(1);
    return person?.name ?? null;
  }
  return null;
}

/**
 * Every state a message can be in, one group per tab: what still needs a yes,
 * what is scheduled, what went out, and what went wrong.
 *
 * The scheduled and posted groups keep the day plan's exact semantics from
 * their time on the Channel: `posting` rides with `approved` because a row
 * mid-send is still something the owner is waiting on, and dropping it would
 * blink slots out of the plan; the plan takes its window at the SOONEST end
 * (an imminent slot on an old row must not fall out of a full window); the
 * posted list is a history, ordered by when things went out.
 *
 * SCOPE IS THE ORG'S, WHICH IS THIS ACCOUNT'S. `messages` carries no
 * `channelId`: channel scope rides `campaigns.channelId`, and
 * `messages.campaignId` is NULLABLE, so a join would drop a queued send out of
 * the very list that exists to show every send. The org is the account as a
 * FACT (`channels_org_network_account_key` is NULLS NOT DISTINCT and its only
 * writer is `bootstrapLocalOrg`) until the landing that fills
 * `externalAccountId` pays the join's real bill.
 *
 * The projection itself is `app/channels/message-rows.ts`: one `QueueMessage`
 * for every surface that lists messages, so a field cannot go missing on one.
 *
 * Beside them, the action ledger's rows (`action-rows.ts`) — the Likes,
 * Invites, DMs a worker proposed, which never live on `messages` (INV-27) —
 * on the same tabs, and every count is the two together: a tab's badge says
 * how much is in it, not how much of one table.
 */

/** Keyed on `PipelineTab`, so a tab added to the vocabulary without a group
 *  here fails to compile rather than rendering an always-empty panel. */
const TAB_GROUPS: Record<PipelineTab, MessageGroupSpec> = {
  waitingForYes: {
    statuses: ["proposed"],
    limit: 50,
    order: "newest",
  },
  scheduled: {
    statuses: ["approved", "posting"],
    limit: 50,
    order: "soonest",
  },
  posted: { statuses: ["posted"], limit: 25, order: "newest" },
  // What still asks something of the owner. A skipped or turned-down draft
  // and a shadow campaign's rehearsal ask nothing, and listing them would
  // bring a no the owner already said back to them as a problem.
  issues: {
    statuses: ["needs_review", "failed"],
    limit: 25,
    order: "newest",
  },
};

export type PipelineData = {
  rows: Record<PipelineTab, QueueMessage[]>;
  /** The action ledger's rows on the same tabs, and how many there are in
   *  all. */
  actions: Record<PipelineTab, ActionRowView[]>;
  actionCounts: Record<PipelineTab, number>;
  /** Totals across ALL rows of both, not just the loaded window — an honest
   *  badge. */
  counts: Record<PipelineTab, number>;
  /** Every open Stop and takeover — what stays paused, beside Issues. */
  pauses: PauseView[];
  /** Every time the Ambassador decided to read a conversation again, on
   *  Scheduled — not a send, so in no count. */
  wakes: WakeView[];
  /** Of the scheduled sends listed: the drafts the owner moved from waiting
   *  for a yes to approved, and those a like rides out with (`sendLike`). */
  approvedDrafts: number[];
  ridingLikes: number[];
};

/**
 * One conversation's half of Waiting for a yes: the drafted replies to their
 * own replies, in the tab's own window and order, so the conversation's page
 * offers the same Approve, Edit and Skip on them the tab does.
 */
export async function loadConversationDrafts(
  tx: Tx,
  conversationId: number,
): Promise<{ rows: QueueMessage[]; total: number }> {
  const theirs = tx
    .select({ id: conversationSources.incomingCommentId })
    .from(conversationSources)
    .where(eq(conversationSources.conversationId, conversationId));
  const groups = await loadMessageGroups(
    tx,
    { waitingForYes: TAB_GROUPS.waitingForYes },
    { where: inArray(messages.incomingCommentId, theirs) },
  );
  return { rows: groups.rows.waitingForYes, total: groups.counts.waitingForYes };
}

/**
 * These exact messages, newest first: what a person's pane lists for the
 * drafts, failed sends and unclear outcomes attributed to them. Only a state
 * that waits on the owner is read, so a row that moved on since the waits
 * were read is simply not listed.
 */
export async function loadMessageRows(tx: Tx, ids: readonly number[]): Promise<QueueMessage[]> {
  if (ids.length === 0) return [];
  const groups = await loadMessageGroups(
    tx,
    { waiting: { statuses: ["proposed", "needs_review", "failed"], limit: 50, order: "newest" } },
    { where: inArray(messages.id, [...ids]) },
  );
  return groups.rows.waiting;
}

/**
 * `organizationId` is for the dispatch-job read behind `blockedSends`: `jobs` is
 * outside RLS, so that predicate is explicit where every message read is not.
 *
 * `campaignIds` narrows every group, count and wake to those campaigns — the
 * bar's filter — and so leaves out what no campaign made. The open Stops stay
 * the account's.
 */
export async function loadPipeline(
  tx: Tx,
  organizationId: string,
  { campaignIds }: { campaignIds?: readonly number[] } = {},
): Promise<PipelineData> {
  const where = campaignIds && inArray(messages.campaignId, [...campaignIds]);
  const blocks = await blockedSends(tx, organizationId, { where });
  const groups = await loadMessageGroups(tx, TAB_GROUPS, { blocks, where });
  // A blocked send is STILL scheduled — its slot is real and the plan keeps
  // it — and it is an issue: something the owner has to fix before it goes
  // out. It sits on both tabs. Live problems lead Issues: blocked sends, then
  // an unclear outcome, which holds every later send until the owner says
  // whether it posted; the settled failures follow. Blocked rows come from the
  // plan's own window; the badge counts every blocked send, as the others do.
  const blocked = groups.rows.scheduled.filter((row) => row.blocked !== null);
  const unclear = groups.rows.issues.filter((row) => row.status === "needs_review");
  const settled = groups.rows.issues.filter((row) => row.status !== "needs_review");
  const ledger = await loadActionGroups(tx, { campaignIds });
  const counts = { ...groups.counts, issues: groups.counts.issues + blocks.size };
  for (const tab of PIPELINE_TABS) counts[tab] += ledger.counts[tab];
  return {
    rows: { ...groups.rows, issues: [...blocked, ...unclear, ...settled] },
    actions: ledger.rows,
    actionCounts: ledger.counts,
    counts,
    pauses: ledger.pauses,
    wakes: await scheduledWakes(tx, { campaignIds }),
    approvedDrafts: await approvedDrafts(tx, groups.rows.scheduled),
    ridingLikes: await ridingLikes(tx, groups.rows.scheduled),
  };
}

/**
 * THE ACCOUNT'S PLAN, in the two facts Upcoming's Today says of it: how many
 * sends are scheduled — the rows `loadPipeline` counts as scheduled, on both
 * tables — and the soonest slot. Never narrowed to a campaign: one budget
 * binds every campaign on the account (INV-4), so its day is one day.
 */
export async function accountPlan(tx: Tx): Promise<{ scheduled: number; soonest: number | null }> {
  const [sends] = await tx
    .select({ n: count(), soonest: min(messages.scheduledAt) })
    .from(messages)
    .where(inArray(messages.status, [...TAB_GROUPS.scheduled.statuses]));
  const [queued] = await tx
    .select({ n: count() })
    .from(actions)
    .where(and(inArray(actions.status, [...ACTION_TAB_STATUSES.scheduled]), notInArray(actions.kind, [...MESSAGE_SENDS])));
  return { scheduled: (sends?.n ?? 0) + (queued?.n ?? 0), soonest: sends?.soonest ?? null };
}

/** The sends among `rows` the owner said yes to as drafts: a `proposed` →
 *  `approved` move in their history, or their agent's words they queued from
 *  their own box, which lands approved on the press (`OWNER_AUTHORED_MODEL`). */
async function approvedDrafts(tx: Tx, rows: readonly QueueMessage[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const moved = await tx
    .selectDistinct({ id: messageStatusEvents.messageId })
    .from(messageStatusEvents)
    .where(
      and(
        inArray(messageStatusEvents.messageId, ids),
        eq(messageStatusEvents.fromStatus, "proposed"),
        eq(messageStatusEvents.toStatus, "approved"),
      ),
    );
  const pressed = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(inArray(messages.id, ids), eq(messages.model, OWNER_AUTHORED_MODEL)));
  return [...new Set([...moved, ...pressed].map((row) => row.id))];
}

/** The sends among `rows` a like goes out with, as the send itself will
 *  decide once it posts. One decision per campaign, kind and tick, not one
 *  per row. */
async function ridingLikes(tx: Tx, rows: readonly QueueMessage[]): Promise<number[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.campaignId == null ? [] : [row.campaignId])))];
  if (ids.length === 0) return [];
  const byId = new Map(
    (await tx.select().from(campaigns).where(inArray(campaigns.id, ids))).map((campaign) => [campaign.id, campaign]),
  );
  const sends = await tx
    .select({ id: messages.id, kind: messages.kind, likeWithSend: messages.likeWithSend, campaignId: messages.campaignId })
    .from(messages)
    .where(inArray(messages.id, rows.map((row) => row.id)));
  const decided = new Map<string, boolean>();
  const riding: number[] = [];
  // SEQUENTIAL, for the reason `loadMessageGroups` gives: one transaction.
  for (const message of sends) {
    const campaign = message.campaignId == null ? undefined : byId.get(message.campaignId);
    if (!campaign) continue;
    const key = `${campaign.id}:${message.kind}:${message.likeWithSend}`;
    if (!decided.has(key)) decided.set(key, (await sendLike(tx, campaign, message)).kind === "ride");
    if (decided.get(key)) riding.push(message.id);
  }
  return riding;
}

/**
 * SENT — everything that went out, newest first, one row per send the
 * account's limits counted.
 *
 * Read off the rate ledger itself, every completed send in it
 * (`completedLedgerActionPredicate`), so the table and the limits cannot
 * disagree: a comment or a reply is its posted message, a like is its settled
 * receipt — the one a comment or a reply carried out, a standalone one, or a
 * dismissal's — and a like, invite, acceptance, DM or follow-up on the action
 * ledger is its confirmed execution. Each row is joined to what it went to
 * one-to-one (`limit 1` where a urn could name two rows), so no send is listed
 * twice and none is missing.
 *
 * Beside each, what came back of it: a reply under a comment or a reply of
 * ours, else the reactions its watch last counted — or that its post was
 * deleted, where its watch retired on the post answering so; an invitation
 * accepted; a message after a DM or a follow-up.
 *
 * Each row also names the row of its person's thread it is (`item`), so the
 * Inbox opens them on it: the message for a comment, a reply or a room reply,
 * the ledger's action for the rest. A like that rode a send is that send's.
 */

/** What a send's Came back cell says, and whom it opens — on `item`, the
 *  row of their thread it came back as (`inbox/item-ref.ts`). */
export type SentCameBack =
  | { kind: "replied"; personKey: string | null; item: string | null }
  | { kind: "reactions"; n: number }
  | { kind: "post_deleted" }
  | { kind: "not_yet" }
  | { kind: "accepted"; personKey: string | null; item: string | null }
  | { kind: "none" };

type SentRow = {
  /** The rate ledger's row. */
  id: number;
  at: number;
  action: string;
  activityKind: ActivityKind | null;
  label: SendLabel | null;
  person: { name: string | null; key: string | null };
  /** The row of their thread it went out as: `message:<id>` or
   *  `action:<id>`; null for a like with no send or action behind it. */
  item: string | null;
  room: { author: string | null } | null;
  campaign: { id: number; name: string } | null;
  cameBack: SentCameBack;
  /** The comment, reply or post it went out on, where the row has one. */
  urn: string | null;
};

type SentPage = { rows: SentRow[]; total: number };

const SEND_ACTIONS = ["comment", "reply", "room_reply", "like", ...ACTION_KINDS];

type Row = {
  id: number;
  at: number;
  action: string;
  receipt: string | null;
  message_id: number | null;
  action_id: number | null;
  campaign_id: number | null;
  campaign_name: string | null;
  message_kind: "comment" | "reply" | "room_reply" | null;
  room_author: string | null;
  publish_origin: string | null;
  message_approved: boolean;
  message_urn: string | null;
  receipt_urn: string | null;
  profile_id: string | null;
  member_urn: string | null;
  reply_id: number | null;
  name: string | null;
  answer_id: number | null;
  answer_profile_id: string | null;
  answer_member_urn: string | null;
  reactions: number | null;
  post_deleted: boolean;
  action_kind: ActionKind | null;
  action_origin: "owner" | "worker" | null;
  action_approved: boolean;
  target_kind: string | null;
  target_urn: string | null;
  action_text: string | null;
  answered: boolean;
};

/** The completed sends of one kind, or of every kind, as the ledger names
 *  them — these campaigns' only when they are given, which leaves out what no
 *  campaign sent. */
function sentWhere(campaignIds: readonly number[] | undefined, kind?: ActivityKind) {
  const actions = kind ? ({ comment: ["comment"], reply: ["reply", "room_reply"], like: ["like", "like_target"], invite: ["invite"], accept: ["accept_invite"], dm: ["dm"], follow_up: ["followup"], withdraw: ["withdraw_invite"] } satisfies Record<ActivityKind, string[]>)[kind] : SEND_ACTIONS;
  return sql`rate_limit_ledger.action in (${sql.join(
    actions.map((action) => sql`${action}`),
    sql`, `,
  )}) and ${completedLedgerActionPredicate()}${
    campaignIds ? sql` and ${inArray(rateLimitLedger.campaignId, [...campaignIds])}` : sql``
  }`;
}

/** The newest `limit` sends of a kind, and how many there are in all — on
 *  the account, or on the campaigns given: the campaign each row names. */
async function loadSent(
  tx: Tx,
  {
    limit,
    campaignIds,
    offset = 0,
    kind,
  }: { limit: number; campaignIds?: readonly number[]; offset?: number; kind?: ActivityKind },
): Promise<SentPage> {
  const where = sentWhere(campaignIds, kind);
  const { rows } = await tx.execute(sql`
    with sent as (
      select id, ts, action, campaign_id, target_profile_id, target_member_urn, message_id, meta
      from rate_limit_ledger
      where ${where}
    )
    select
      sent.id::float8 as id,
      sent.ts::float8 as at,
      sent.action,
      sent.meta->>'kind' as receipt,
      message.id::float8 as message_id,
      action.id::float8 as action_id,
      campaign.id::float8 as campaign_id,
      campaign.name as campaign_name,
      message.kind as message_kind,
      case when sent.action = 'room_reply' then post.author_name end as room_author,
      message.publish_origin,
      (
        message.model is not distinct from ${OWNER_AUTHORED_MODEL}
        or exists (
          select 1 from message_status_events moved
          where moved.message_id = message.id and moved.from_status = 'proposed' and moved.to_status = 'approved'
        )
      ) as message_approved,
      message.external_urn as message_urn,
      coalesce(sent.meta->>'commentUrn', sent.meta->>'postUrn') as receipt_urn,
      case when message.kind = 'room_reply' or sent.action = 'room_reply' then coalesce(message.target_profile_id, sent.target_profile_id)
      else coalesce(
        nullif(action.author_profile_id, ''),
        nullif(reply.author_profile_id, ''),
        nullif(post.author_profile_id, ''),
        sent.target_profile_id
      ) end as profile_id,
      case when message.kind = 'room_reply' or sent.action = 'room_reply' then coalesce(message.room_reply_target->>'memberUrn', sent.target_member_urn)
        else reply.author_member_urn end as member_urn,
      reply.id::float8 as reply_id,
      case when coalesce(message.kind, '') <> 'room_reply' and sent.action <> 'room_reply'
        then coalesce(reply.author_name, post.author_name) end as name,
      answer.id::float8 as answer_id,
      answer.author_profile_id as answer_profile_id,
      answer.author_member_urn as answer_member_urn,
      watch.last_reaction_count as reactions,
      -- Retired with its mark kept: the post answered twice that it is gone.
      coalesce(watch.state = 'expired' and watch.missing_since is not null, false) as post_deleted,
      action.kind as action_kind,
      action.origin as action_origin,
      exists (
        select 1 from action_approvals yes
        where yes.action_execution_id = action.id and yes.used_at is not null
      ) as action_approved,
      action.target->>'kind' as target_kind,
      action.target->>'urn' as target_urn,
      action.candidate->>'text' as action_text,
      case
        when action.kind = 'invite' then exists (
          select 1 from conversation_events event
          where event.conversation_id = action.conversation_id and event.type = 'invitation_accepted')
        when action.kind in ('dm', 'followup') then exists (
          select 1 from conversation_events event
          where event.conversation_id = action.conversation_id and event.type = 'inbound_message_observed'
            and event.occurred_at > sent.ts)
        else false
      end as answered
    from sent
    left join campaigns campaign on campaign.id = sent.campaign_id
    left join messages message on message.id = sent.message_id
    left join actions action
      on sent.meta->>'kind' = 'action_execution_receipt'
     and action.id = (sent.meta->>'actionExecutionId')::bigint
    left join lateral (
      select post.author_profile_id, post.author_name
      from discovered_posts post
      where post.id = message.discovered_post_id
         or post.id = (message.room_reply_target->>'discoveredPostId')::bigint
         or (message.id is null and post.post_urn = coalesce(sent.meta->>'postUrn', action.target->>'urn'))
      order by post.id desc
      limit 1
    ) post on true
    left join lateral (
      select reply.id, reply.author_profile_id, reply.author_member_urn, reply.author_name
      from incoming_comments reply
      where reply.id = message.incoming_comment_id
         or (message.id is null and reply.comment_urn = coalesce(sent.meta->>'commentUrn', action.target->>'urn'))
      order by reply.id desc
      limit 1
    ) reply on true
    left join lateral (
      select answer.id, answer.author_profile_id, answer.author_member_urn
      from incoming_comments answer
      where sent.action in ('comment', 'reply', 'room_reply')
        and answer.parent_message_id = message.id
        and answer.source = 'our_comment_thread'
        and answer.removed_at is null
      order by answer.received_at desc, answer.id desc
      limit 1
    ) answer on true
    left join comment_watches watch on sent.action in ('comment', 'reply', 'room_reply') and watch.message_id = message.id
    order by sent.ts desc, sent.id desc
    limit ${limit} offset ${offset}`);
  const { rows: counted } = await tx.execute(sql`
    select count(*)::int as n from rate_limit_ledger where ${where}`);

  const listed = rows as Row[];
  const keyOf = (row: Row) =>
    personKey({ profileId: row.profile_id, memberUrn: row.member_urn, incomingCommentId: row.reply_id });
  const people = await findPeople(tx, [...new Set(listed.flatMap((row) => keyOf(row) ?? []))]);
  return {
    rows: listed.map((row) => {
      const asked = keyOf(row);
      const person = asked ? people.get(asked) : undefined;
      const key = person?.canonicalKey ?? asked;
      return {
        id: row.id,
        at: row.at,
        action: actionWord(row),
        activityKind: SENT_KIND[row.action_kind ?? row.action] ?? null,
        label: sendLabel(row),
        person: { name: row.name || person?.name || null, key },
        item: itemOf(row),
        room: row.action === "room_reply" ? { author: row.room_author } : null,
        campaign:
          row.campaign_id === null || row.campaign_name === null
            ? null
            : { id: row.campaign_id, name: row.campaign_name },
        cameBack: cameBackOf(row, key),
        urn: row.action === "like" ? row.receipt_urn : (row.message_urn ?? row.target_urn),
      };
    }),
    total: (counted as Array<{ n: number }>)[0]?.n ?? 0,
  };
}

/** The row of their thread a send is: the ledger's action where it has one,
 *  else the message it posted or rode. */
function itemOf(row: Row): string | null {
  if (row.action_id !== null) return `action:${row.action_id}`;
  return row.message_id !== null ? `message:${row.message_id}` : null;
}

/** The action, as the owner calls it: a like by what it is on. */
function actionWord(row: Row): string {
  if (row.action_kind) return ledgerActionLabel(row.action_kind, row.target_kind ?? "");
  if (row.action === "comment") return "Comment";
  if (row.action === "reply") return "Reply";
  if (row.action === "room_reply") return "Reply in the room";
  const onReply = row.message_kind === "reply" || row.message_kind === "room_reply" || row.receipt === "dismissal_like_receipt";
  return onReply ? "Like reply" : "Like post";
}

/** Whose the send was. A like that rode a send went with it; a standalone
 *  or a dismissal's like, which the owner pressed and which carries no
 *  words, says nothing under it. */
function sendLabel(row: Row): SendLabel | null {
  if (row.action_kind) {
    return ledgerSendLabel({
      kind: row.action_kind,
      origin: row.action_origin ?? "worker",
      approved: row.action_approved,
      hasText: row.action_text !== null,
    });
  }
  if (row.action === "like") return row.message_kind ? companionLikeLabel(row.message_kind) : null;
  return messageSendLabel({ publishOrigin: row.publish_origin ?? "worker", approved: row.message_approved });
}

function cameBackOf(row: Row, key: string | null): SentCameBack {
  if (row.action === "comment" || row.action === "reply" || row.action === "room_reply") {
    if (row.post_deleted) return { kind: "post_deleted" };
    if (row.answer_id !== null) {
      return {
        kind: "replied",
        personKey: personKey({
          profileId: row.answer_profile_id,
          memberUrn: row.answer_member_urn,
          incomingCommentId: row.answer_id,
        }),
        item: `reply:${row.answer_id}`,
      };
    }
    return row.reactions ? { kind: "reactions", n: row.reactions } : { kind: "not_yet" };
  }
  // Their yes is the invite's own row; their answer to a DM is in the
  // messages, which the DM itself opens.
  if (row.action_kind === "invite") {
    return row.answered ? { kind: "accepted", personKey: key, item: itemOf(row) } : { kind: "not_yet" };
  }
  if (row.action_kind === "dm" || row.action_kind === "followup") {
    return row.answered ? { kind: "replied", personKey: key, item: itemOf(row) } : { kind: "not_yet" };
  }
  return { kind: "none" };
}

/**
 * ONE LIST OF WHAT GOES OUT AND COMES BACK, each row saying why it is where it
 * is. The Activity tabs and the MCP `list_activity` read the same loaders above
 * and the same reasons here, so the rows and the counts cannot disagree.
 */

export const ACTIVITY_VIEWS = ["waiting", "upcoming", "sent", "came_back", "problems"] as const;
export type ActivityView = (typeof ACTIVITY_VIEWS)[number];

export const ACTIVITY_KINDS = ["comment", "reply", "like", "invite", "accept", "dm", "follow_up", "withdraw"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Why a row stands where it does: always one of these, never empty. `sent`
 *  and `came_back` say that the row is already past waiting. */
export type ActivityWhy = {
  code:
    | "waiting_on_yes"
    | "cap"
    | "window"
    | "stop"
    | "first_send_check"
    | "uncertain"
    | "failed"
    | "scheduled"
    | "sent"
    | "came_back";
  text: string;
  /** What a stop is on. */
  scope?: PauseView["scope"];
  /** The slot, or when the gate looks again. */
  at?: number;
};

export type ActivityRow = {
  /** `msg:<id>` or `act:<id>`; null for a row that is neither (a like that
   *  went out alone, something that came back). */
  ref: string | null;
  /** The row's own address when it has no ref: the rate ledger's or Came
   *  back's. */
  key: string;
  kind: ActivityKind | null;
  status: string;
  text: string | null;
  at: number | null;
  why: ActivityWhy;
  person: string | null;
  campaign: { id: number; name: string | null } | null;
  /** The worker run that wrote it, where one did. */
  run: number | null;
};

export type ActivityPage = {
  view: ActivityView;
  rows: ActivityRow[];
  /** Every row matching the view and filters, before paging. */
  total: number;
  nextCursor: string | null;
  /** Every open Stop and takeover, which are why some queued rows wait. */
  stops: PauseView[];
};

const ACTIVITY_PAGE = 25;

/** A hold's or a refusal's reason, sorted onto the three things that pace a
 *  send; null where it is none of them. */
function holdKind(reason: string): "cap" | "window" | "stop" | null {
  if (/kill.?switch|paused|stopped|writes_off|\bstop\b/.test(reason)) return "stop";
  if (/active_hours|window/.test(reason)) return "window";
  if (/cap|gap|ceiling/.test(reason)) return "cap";
  return null;
}

function heldWhy(reason: string, at: number | undefined): ActivityWhy | null {
  const kind = holdKind(reason);
  if (kind === null) return null;
  const words = reason.replaceAll("_", " ");
  return {
    code: kind,
    text: kind === "stop" ? `Held: ${words}.` : `Held by ${kind === "cap" ? "a cap" : "the active window"} (${words}).`,
    ...(kind === "stop" ? { scope: "account" as const } : {}),
    ...(at === undefined ? {} : { at }),
  };
}

/** Why a comment or reply is where it is. */
export function messageWhy(message: QueueMessage): ActivityWhy {
  switch (message.status) {
    case "proposed":
      return { code: "waiting_on_yes", text: "Waiting on your yes." };
    case "needs_review":
      return {
        code: "uncertain",
        text: "Nobody knows yet whether it went out; nothing else is sent on this account until the owner looks on LinkedIn and says which.",
      };
    case "posted":
      return { code: "sent", text: "Went out.", ...(message.postedAt === null ? {} : { at: message.postedAt }) };
    case "approved":
    case "posting": {
      if (message.blocked) {
        const { code, detail, layer, retryAt } = message.blocked;
        return (
          heldWhy(code, retryAt) ??
          (layer === "org"
            ? { code: "stop", scope: "account", text: `Held: ${detail ?? code}.`, at: retryAt }
            : { code: "scheduled", text: `Refused (${detail ?? code}); the queue tries again.`, at: retryAt })
        );
      }
      if (message.heldForResume) {
        return { code: "stop", scope: "campaign", text: "The campaign is paused; it goes out after Resume." };
      }
      return {
        code: "scheduled",
        text: message.scheduledAt === null ? "Approved; it takes the next slot." : "Scheduled.",
        ...(message.scheduledAt === null ? {} : { at: message.scheduledAt }),
      };
    }
    case "rejected":
      return { code: "failed", text: "Turned down; nothing will be sent." };
    case "suppressed_dryrun":
      return { code: "failed", text: "A shadow campaign recorded it and sent nothing." };
    case "failed":
      return { code: "failed", text: message.error ?? "It did not go out." };
  }
}

/** Why a ledger action is where it is; a Stop on its account, campaign or
 *  conversation outranks everything else it waits on. */
export function actionWhy(action: ActionRowView, stops: readonly PauseView[]): ActivityWhy {
  const queued = ["awaiting_review", "reserved", "approved", "dispatching"].includes(action.status);
  if (queued) {
    const stop = stops.find(
      (pause) =>
        pause.scope === "account" ||
        (pause.scope === "campaign" && pause.scopeId === action.campaignId) ||
        (pause.scope === "conversation" && pause.scopeId === action.conversationId),
    );
    if (stop) return { code: "stop", scope: stop.scope, text: pauseLabel(stop) };
  }
  const note = actionStatusNote(action);
  switch (action.status) {
    case "awaiting_review":
      return action.statusReason === "review_required"
        ? { code: "first_send_check", text: "The account's first send of this kind goes out only on your yes." }
        : { code: "waiting_on_yes", text: note ?? "Waiting on your yes." };
    case "reserved":
    case "approved":
    case "dispatching": {
      if (heldForReview(action)) return { code: "waiting_on_yes", text: note ?? "Held for your review." };
      const held = action.statusReason?.startsWith("held:") ? heldWhy(action.statusReason.slice("held:".length), undefined) : null;
      return held ?? { code: "scheduled", text: "Queued; the gate sends it at its next look." };
    }
    case "uncertain":
      return { code: "uncertain", text: note ?? "Nobody knows yet whether this went out." };
    case "confirmed":
      return { code: "sent", text: "Went out.", at: action.updatedAt };
    default:
      return { code: "failed", text: note ?? "It did not go out." };
  }
}

const ACTION_KIND: Record<ActionKind, ActivityKind> = {
  like_target: "like",
  invite: "invite",
  accept_invite: "accept",
  dm: "dm",
  followup: "follow_up",
  withdraw_invite: "withdraw",
  room_reply: "reply",
  reply: "reply",
  comment: "comment",
};

const person = (key: string | null | undefined) => (key ? `person:${key}` : null);

function messageActivity(message: QueueMessage, why = messageWhy(message)): ActivityRow {
  return {
    ref: `msg:${message.id}`,
    key: `msg:${message.id}`,
    kind: message.kind === "comment" ? "comment" : "reply",
    status: message.status,
    text: message.text,
    at: message.scheduledAt ?? message.postedAt ?? message.createdAt,
    why,
    person: person(message.target?.personKey),
    campaign: message.campaignId == null ? null : { id: message.campaignId, name: message.campaignName ?? null },
    run: message.workerRunId ?? null,
  };
}

function actionActivity(action: ActionRowView, stops: readonly PauseView[]): ActivityRow {
  return {
    ref: `act:${action.id}`,
    key: `act:${action.id}`,
    kind: ACTION_KIND[action.kind],
    status: action.status,
    text: action.text,
    at: action.updatedAt,
    why: actionWhy(action, stops),
    person: person(action.personKey),
    campaign: action.campaignId == null ? null : { id: action.campaignId, name: action.campaignName },
    run: action.runId ?? null,
  };
}

const SENT_KIND: Record<string, ActivityKind> = {
  comment: "comment",
  reply: "reply",
  room_reply: "reply",
  like: "like",
  like_target: "like",
  invite: "invite",
  accept_invite: "accept",
  dm: "dm",
  followup: "follow_up",
  withdraw_invite: "withdraw",
};

function sentActivity(row: SentRow): ActivityRow {
  const ref = row.item?.startsWith("message:") ? `msg:${row.item.slice(8)}` : row.item?.startsWith("action:") ? `act:${row.item.slice(7)}` : null;
  return {
    ref,
    key: `sent:${row.id}`,
    kind: row.activityKind,
    status: "sent",
    text: null,
    at: row.at,
    why: { code: "sent", text: "Went out.", at: row.at },
    person: person(row.person.key),
    campaign: row.campaign,
    run: null,
  };
}

const CAME_BACK_WORDS: Record<CameBackRow["kind"], string> = {
  replied_to_comment: "Replied to your comment.",
  replied_to_reply: "Replied to your reply.",
  replied_to_room_reply: "Replied to your reply in a room.",
  accepted: "Accepted your invitation.",
  messaged: "Wrote to you.",
};

function cameBackActivity(row: CameBackRow): ActivityRow {
  return {
    ref: null,
    key: row.id,
    kind: null,
    status: row.kind,
    text: row.quote,
    at: row.at,
    why: { code: "came_back", text: CAME_BACK_WORDS[row.kind], at: row.at },
    person: person(row.personKey),
    campaign: row.campaign,
    run: null,
  };
}

const ALL_MESSAGE_STATUSES: readonly MessageStatus[] = [...QUEUE_STATUSES, "suppressed_dryrun"];

/** Exactly these rows, whatever their state. */
async function activityByRefs(
  tx: Tx,
  organizationId: string,
  refs: { messages: readonly number[]; actions: readonly number[] },
): Promise<{ rows: ActivityRow[]; stops: PauseView[] }> {
  const stops = await loadOpenPauses(tx);
  const rows: ActivityRow[] = [];
  if (refs.messages.length > 0) {
    const where = inArray(messages.id, [...refs.messages]);
    const blocks = await blockedSends(tx, organizationId, { where });
    const found = await loadMessageGroups(
      tx,
      { any: { statuses: ALL_MESSAGE_STATUSES, limit: refs.messages.length, order: "newest" } },
      { blocks, where },
    );
    rows.push(...found.rows.any.map((message) => messageActivity(message)));
  }
  rows.push(...(await loadActionRows(tx, refs.actions)).map((action) => actionActivity(action, stops)));
  return { rows, stops };
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
}

/** Page the combined message and action sources before projecting their rows. */
async function pipelineActivityPage(tx: Tx, organizationId: string, input: {
  view: "waiting" | "upcoming" | "problems"; kind?: ActivityKind; campaignId?: number; offset: number;
}): Promise<{ rows: ActivityRow[]; total: number; stops: PauseView[] }> {
  const tab: PipelineTab = input.view === "waiting" ? "waitingForYes" : input.view === "upcoming" ? "scheduled" : "issues";
  const campaignMessage = input.campaignId === undefined ? sql`true` : eq(messages.campaignId, input.campaignId);
  const campaignAction = input.campaignId === undefined ? sql`true` : eq(actions.campaignId, input.campaignId);
  const blocked = sql`exists (select 1 from actions held where held.message_id = ${messages.id} and held.kind = ${messages.kind}
    and held.status = 'approved' and held.status_reason like 'held:%'
    and held.status_reason not in (${sql.join(PASSING_HOLDS.map((reason) => sql`${`held:${reason}`}`), sql`, `)}))`;
  const messageState = input.view === "problems"
    ? sql`(${inArray(messages.status, ["needs_review", "failed"])} or (${inArray(messages.status, ["approved", "posting"])} and ${blocked}))`
    : inArray(messages.status, [...TAB_GROUPS[tab].statuses]);
  const messageKind = input.kind === undefined ? sql`true` : input.kind === "comment" ? eq(messages.kind, "comment")
    : input.kind === "reply" ? inArray(messages.kind, ["reply", "room_reply"]) : sql`false`;
  // A reply is shown by its message, which the action only sends.
  const actionKinds = (Object.entries(ACTION_KIND) as Array<[ActionKind, ActivityKind]>)
    .filter(([key, value]) => !isMessageSend(key) && (input.kind === undefined || value === input.kind)).map(([key]) => key);
  const actionKind = actionKinds.length ? inArray(actions.kind, actionKinds) : sql`false`;
  const choices: SQL[] = [];
  if (input.view === "upcoming" && (input.kind === undefined || input.kind === "like")) {
    const campaignsForPage = await tx.select().from(campaigns).where(input.campaignId === undefined ? undefined : eq(campaigns.id, input.campaignId));
    for (const campaign of campaignsForPage) {
      for (const kind of ["comment", "reply", "room_reply"] as const) {
        for (const value of [true, false, null] as const) {
          if ((await sendLike(tx, campaign, { kind, likeWithSend: value })).kind !== "ride") continue;
          choices.push(sql`(${messages.campaignId} = ${campaign.id} and ${messages.kind} = ${kind} and ${messages.likeWithSend} is not distinct from ${value})`);
        }
      }
    }
  }
  const rider = choices.length ? sql`(${sql.join(choices, sql` or `)})` : sql`false`;
  const messageOrder = input.view === "upcoming" ? sql`${messages.scheduledAt}` : sql`-${messages.createdAt}`;
  const rank = input.view === "problems" ? sql`case when ${messages.status} in ('approved','posting') then 0 when ${messages.status} = 'needs_review' then 1 else 2 end` : sql`0`;
  const source = sql`
    select 'msg'::text as source, ${messages.id} as id, ${rank} as rank, ${messageOrder} as ordering
      from ${messages} where ${campaignMessage} and ${messageState} and ${messageKind}
    union all
    select 'like'::text as source, ${messages.id} as id, 0 as rank, ${messages.scheduledAt} as ordering
      from ${messages} where ${campaignMessage} and ${inArray(messages.status, ["approved", "posting"])} and ${rider}
    union all
    select 'act'::text as source, ${actions.id} as id, 3 as rank, -${actions.updatedAt} as ordering
      from ${actions} where ${campaignAction} and ${inArray(actions.status, [...ACTION_TAB_STATUSES[tab]])} and ${actionKind}`;
  const countResult = await tx.execute(sql`select count(*)::int as n from (${source}) activity`);
  const pageResult = await tx.execute(sql`select source, id::float8 as id from (${source}) activity
    order by rank, ordering asc nulls last, id desc, case when source = 'msg' then 0 else 1 end limit ${ACTIVITY_PAGE + 1} offset ${input.offset}`);
  const named = pageResult.rows as Array<{ source: "msg" | "like" | "act"; id: number }>;
  const selected = named.slice(0, ACTIVITY_PAGE + 1);
  const projected = await activityByRefs(tx, organizationId, {
    messages: [...new Set(selected.filter((row) => row.source !== "act").map((row) => row.id))],
    actions: selected.filter((row) => row.source === "act").map((row) => row.id),
  });
  const byRef = new Map(projected.rows.map((row) => [row.ref, row]));
  const rows = selected.flatMap((entry) => {
    const row = byRef.get(`${entry.source === "act" ? "act" : "msg"}:${entry.id}`);
    return row ? [entry.source === "like" ? { ...row, key: `like:${entry.id}`, kind: "like" as const, status: "riding", text: null } : row] : [];
  });
  return { rows, total: Number((countResult.rows[0] as { n: number }).n), stops: projected.stops };
}

/**
 * The rows of one Activity view, each with its reason — or exactly the rows
 * `refs` name. `campaignId` narrows as the bar's campaign filter does; `kind`
 * and the cursor page what the view loaded.
 */
export async function listActivity(
  tx: Tx,
  organizationId: string,
  input: {
    view: ActivityView;
    kind?: ActivityKind;
    campaignId?: number;
    refs?: { messages: readonly number[]; actions: readonly number[] };
    cursor?: string;
    now?: number;
  },
): Promise<ActivityPage> {
  const now = input.now ?? Date.now();
  const offset = decodeOffset(input.cursor);
  const narrowed = input.campaignId === undefined ? {} : { campaignIds: [input.campaignId] };
  let all: ActivityRow[];
  let total: number;
  let stops: PauseView[] = [];
  if (input.refs) {
    ({ rows: all, stops } = await activityByRefs(tx, organizationId, input.refs));
    if (input.kind) all = all.filter((row) => row.kind === input.kind);
    total = all.length;
    all = all.slice(offset, offset + ACTIVITY_PAGE + 1);
  } else if (input.view === "sent") {
    const page = await loadSent(tx, { kind: input.kind, offset, limit: ACTIVITY_PAGE + 1, ...narrowed });
    all = page.rows.map(sentActivity);
    total = page.total;
  } else if (input.view === "came_back") {
    if (input.kind) { all = []; total = 0; }
    else {
      const feed = await cameBackFeed(tx, { now, offset, limit: ACTIVITY_PAGE + 1, ...narrowed });
      all = feed.rows.map(cameBackActivity);
      total = feed.total;
    }
  } else {
    const page = await pipelineActivityPage(tx, organizationId, { ...input, view: input.view, offset });
    all = page.rows;
    total = page.total;
    stops = page.stops;
  }
  const rows = all.slice(0, ACTIVITY_PAGE);
  const more = all.length > ACTIVITY_PAGE;
  return {
    view: input.view,
    rows,
    total,
    nextCursor: more ? Buffer.from(String(offset + ACTIVITY_PAGE), "utf8").toString("base64url") : null,
    stops,
  };
}
