import { and, count, desc, eq, gte, inArray, isNull, lte, min, notInArray, or, sql, type SQL } from "drizzle-orm";
import { actions, campaigns, jobs, messages, workerRuns, workers, type ActionKind, type ActionStatus } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { dispatchActionsKey } from "../actions/drain";
import { MESSAGE_SENDS } from "../actions/keys";
import { withConversationSums } from "../agentStep/runSums";
import type { CampaignRun } from "../operations/campaignWorkspace";
import type { WorkerRunStatus } from "../operations/workers";
import { OWNER_AUTHORED_MODEL } from "../operations/clientDrafting";
import { findPeople } from "../people/directory";
import { personKey } from "../people/key";
import { ACTION_TAB_STATUSES } from "./presentation";

/**
 * WHO A RUN REACHED — what a campaign's runs wrote, what of it went out and
 * who came back, as the campaign's Activity says it line by line.
 *
 * A comment or a reply is the run's whose stamp it carries
 * (`messages.worker_run_id`), and an answer to it is a reply under it
 * (`incoming_comments.parent_message_id`). An invitation or a DM is the run's
 * whose call first queued it (`step_tool_calls.result_ref`, which never moves,
 * where a checkpoint's `run_id` does), and its answer is the acceptance or the
 * message of theirs its conversation recorded after it went out. Every count is
 * a count of those rows, never a number a model reported. Reads only.
 */

/** What a campaign's Activity narrows its runs to, as its address spells them. */
export const RUN_REACH_FILTERS = ["sent", "came_back", "problems"] as const;
export type RunReachFilter = (typeof RUN_REACH_FILTERS)[number];

/** The calls `k` joined to the actions `a` they queued… */
const callActions = sql`step_tool_calls k
  join actions a on a.id = (case when k.result_ref like 'action:%' then substring(k.result_ref from 8)::bigint end)`;

/** …kept to the first dispatched call of each: a later call that found the
 *  action already queued did not queue it. */
const firstCall = sql`k.outcome = 'dispatched' and not exists (
  select 1 from step_tool_calls p where p.outcome = 'dispatched' and p.result_ref = k.result_ref and p.id < k.id)`;

/** An event `e` that answers the action `a`: an invitation accepted, or a
 *  message of theirs after a DM or follow-up went out. */
const answersAction = sql`e.conversation_id = a.conversation_id
  and ((a.kind = 'invite' and e.type = 'invitation_accepted')
    or (a.kind in ('dm', 'followup') and e.type = 'inbound_message_observed'
      and e.occurred_at > coalesce(a.settled_at, a.updated_at)))`;

/** A reply `r` under the comment or reply of ours `m`, still there. */
const answersMessage = sql`r.parent_message_id = m.id and r.source = 'our_comment_thread' and r.removed_at is null`;

/** Problems holds the runs of the last seven days that went wrong. */
const PROBLEMS_WINDOW_MS = 7 * 86_400_000;

const FILTER_WHERE: Record<RunReachFilter, (now: number) => SQL> = {
  sent: () => sql`(
    exists (select 1 from messages m where m.worker_run_id = ${workerRuns.id} and m.status = 'posted')
    or exists (select 1 from ${callActions} where ${firstCall} and k.run_id = ${workerRuns.id} and a.status = 'confirmed'))`,
  came_back: () => sql`(
    exists (select 1 from messages m join incoming_comments r on ${answersMessage}
      where m.worker_run_id = ${workerRuns.id} and m.status = 'posted')
    or exists (select 1 from ${callActions} where ${firstCall} and k.run_id = ${workerRuns.id} and a.status = 'confirmed'
      and exists (select 1 from conversation_events e where ${answersAction})))`,
  // The runs whose pill warns: failed, stopped early, or an agent task that was
  // cancelled or ran out (`runOutcomePill`).
  problems: (now) =>
    and(
      gte(workerRuns.startedAt, now - PROBLEMS_WINDOW_MS),
      or(
        inArray(workerRuns.status, ["failed", "partial"]),
        inArray(workerRuns.agentTaskStatus, ["canceled", "expired"]),
      ),
    )!,
};

/** One page of a campaign's runs under a filter, and of one status where
 *  one is named — a running one first, then newest first — and how many runs
 *  they hold. */
export async function pageReachRuns(
  tx: Tx,
  campaignId: number,
  {
    filter,
    status = null,
    limit,
    offset,
    now,
  }: { filter: RunReachFilter | null; status?: WorkerRunStatus | null; limit: number; offset: number; now: number },
): Promise<{ runs: CampaignRun[]; total: number }> {
  const where = and(
    eq(workers.campaignId, campaignId),
    filter === null ? undefined : FILTER_WHERE[filter](now),
    status === null ? undefined : eq(workerRuns.status, status),
  );
  const rows = await tx
    .select({ run: workerRuns, type: workers.type })
    .from(workerRuns)
    .innerJoin(workers, eq(workers.id, workerRuns.workerId))
    .where(where)
    .orderBy(desc(sql`${workerRuns.status} = 'running'`), desc(workerRuns.startedAt), desc(workerRuns.id))
    .limit(limit)
    .offset(offset);
  const [counted] = await tx
    .select({ total: count() })
    .from(workerRuns)
    .innerJoin(workers, eq(workers.id, workerRuns.workerId))
    .where(where);
  return {
    runs: await withConversationSums(tx, rows.map(({ run, type }) => ({ ...run, ranBy: type }))),
    total: counted?.total ?? 0,
  };
}

/** How many runs the campaign's Problems holds. */
export async function countProblemRuns(tx: Tx, campaignId: number, now: number): Promise<number> {
  const [counted] = await tx
    .select({ total: count() })
    .from(workerRuns)
    .innerJoin(workers, eq(workers.id, workerRuns.workerId))
    .where(and(eq(workers.campaignId, campaignId), FILTER_WHERE.problems(now)));
  return counted?.total ?? 0;
}

/** Where one thing a run wrote stands: out, on its way, waiting for the
 *  owner's yes, or none of those — turned down, failed, never sent. */
export type ReachState = "sent" | "going_out" | "waiting" | "not_sent";

/** One thing a run wrote, to one person. */
export type ReachedPerson = {
  /** The row of their thread it is: `message:<id>` or `action:<id>`. */
  item: string;
  kind: "comment" | "reply" | "room_reply" | ActionKind;
  person: { key: string | null; name: string | null };
  /** Who wrote the post it went under, for a comment or a reply. */
  postAuthor: string | null;
  state: ReachState;
  /** The owner wrote it or said yes to it: it did not go out on its own. */
  approved: boolean;
  at: number;
  /** Their answer, where they gave one: their words, null for an acceptance. */
  cameBack: { at: number; words: string | null; item: string } | null;
};

/** How many of each kind. */
export type KindCounts = Partial<Record<ReachedPerson["kind"], number>>;

/** What one run wrote, and the counts its line says, over all of it. */
export type RunReach = {
  /** The newest `PEOPLE_PER_RUN` of it. */
  people: ReachedPerson[];
  written: KindCounts;
  sent: KindCounts;
  /** Everything of it that went out was the owner's or had their yes. */
  sentApproved: boolean;
  waiting: number;
  cameBack: number;
};

/** The most a run lists under its line; its counts are over everything. */
const PEOPLE_PER_RUN = 50;

type MessageRow = {
  id: number;
  run_id: number;
  kind: "comment" | "reply" | "room_reply";
  status: string;
  at: number;
  approved: boolean;
  profile_id: string | null;
  member_urn: string | null;
  reply_id: number | null;
  name: string | null;
  answer_id: number | null;
  answer_at: number | null;
  answer_text: string | null;
  post_author: string | null;
};

type ActionRow = {
  id: number;
  run_id: number;
  kind: ActionKind;
  status: ActionStatus;
  at: number;
  approved: boolean;
  profile_id: string | null;
  member_urn?: undefined;
  reply_id?: undefined;
  name: string | null;
  answer_at: number | null;
  answer_text: string | null;
};

const runList = (runIds: readonly number[]) => sql.join(runIds.map((id) => sql`${id}`), sql`, `);

/** What each of `runIds` wrote and who came back; a run that wrote nothing is
 *  absent. */
export async function runReach(tx: Tx, runIds: readonly number[]): Promise<Map<number, RunReach>> {
  const reach = new Map<number, RunReach>();
  if (runIds.length === 0) return reach;
  const { rows: written } = await tx.execute<MessageRow>(sql`
    select m.id::float8 as id, m.worker_run_id::float8 as run_id, m.kind, m.status,
      coalesce(m.posted_at, m.scheduled_at, m.created_at)::float8 as at,
      (m.publish_origin = 'owner' or m.model is not distinct from ${OWNER_AUTHORED_MODEL} or exists (
        select 1 from message_status_events moved
        where moved.message_id = m.id and moved.from_status = 'proposed' and moved.to_status = 'approved')) as approved,
      case when m.kind = 'room_reply' then m.target_profile_id
        else coalesce(nullif(reply.author_profile_id, ''), nullif(post.author_profile_id, ''), m.target_profile_id) end as profile_id,
      case when m.kind = 'room_reply' then m.room_reply_target ->> 'memberUrn' else reply.author_member_urn end as member_urn,
      reply.id::float8 as reply_id,
      case when m.kind <> 'room_reply' then coalesce(reply.author_name, post.author_name) end as name,
      post.author_name as post_author,
      answer.id::float8 as answer_id, answer.received_at::float8 as answer_at, answer.text as answer_text
    from messages m
    left join discovered_posts post on post.id = m.discovered_post_id
    left join incoming_comments reply on reply.id = m.incoming_comment_id
    left join lateral (
      select r.id, r.received_at, r.text from incoming_comments r
      where ${answersMessage} and m.status = 'posted'
      order by r.received_at, r.id limit 1
    ) answer on true
    where m.worker_run_id in (${runList(runIds)})
    order by m.created_at desc, m.id desc`);
  const { rows: queued } = await tx.execute<ActionRow>(sql`
    select a.id::float8 as id, k.run_id::float8 as run_id, a.kind, a.status,
      coalesce(a.settled_at, a.updated_at)::float8 as at,
      (a.origin = 'owner' or exists (
        select 1 from action_approvals yes where yes.action_execution_id = a.id and yes.used_at is not null)) as approved,
      nullif(a.author_profile_id, '') as profile_id,
      (select c.author_name from incoming_comments c where c.author_profile_id = a.author_profile_id
        order by c.id desc limit 1) as name,
      answer.occurred_at::float8 as answer_at, answer.content as answer_text
    from ${callActions}
    left join lateral (
      select e.occurred_at, e.content from conversation_events e
      where ${answersAction} and a.status = 'confirmed'
      order by e.occurred_at, e.id limit 1
    ) answer on true
    where ${firstCall} and k.run_id in (${runList(runIds)})
      and a.kind not in (${sql.join(MESSAGE_SENDS.map((kind) => sql`${kind}`), sql`, `)})
    order by a.created_at desc, a.id desc`);

  const keyOf = (row: MessageRow | ActionRow) =>
    personKey({ profileId: row.profile_id, memberUrn: row.member_urn ?? null, incomingCommentId: row.reply_id ?? null });
  const people = await findPeople(tx, [...new Set([...written, ...queued].flatMap((row) => keyOf(row) ?? []))]);
  const personOf = (row: MessageRow | ActionRow) => {
    const asked = keyOf(row);
    const found = asked ? people.get(asked) : undefined;
    return { key: found?.canonicalKey ?? asked, name: row.name || found?.name || null };
  };
  const add = (runId: number, reached: ReachedPerson) => {
    const run = reach.get(runId) ?? { people: [], written: {}, sent: {}, sentApproved: true, waiting: 0, cameBack: 0 };
    run.written[reached.kind] = (run.written[reached.kind] ?? 0) + 1;
    if (reached.state === "sent") {
      run.sent[reached.kind] = (run.sent[reached.kind] ?? 0) + 1;
      run.sentApproved &&= reached.approved;
    }
    if (reached.state === "waiting") run.waiting += 1;
    if (reached.cameBack) run.cameBack += 1;
    if (run.people.length < PEOPLE_PER_RUN) run.people.push(reached);
    reach.set(runId, run);
  };

  for (const row of written) {
    add(row.run_id, {
      item: `message:${row.id}`,
      kind: row.kind,
      person: personOf(row),
      postAuthor: row.post_author,
      state: row.status === "posted" ? "sent" : row.status === "approved" || row.status === "posting" ? "going_out" : row.status === "proposed" ? "waiting" : "not_sent",
      approved: row.approved,
      at: row.at,
      cameBack:
        row.answer_id === null || row.answer_at === null
          ? null
          : { at: row.answer_at, words: row.answer_text, item: `reply:${row.answer_id}` },
    });
  }
  for (const row of queued) {
    add(row.run_id, {
      item: `action:${row.id}`,
      kind: row.kind,
      person: personOf(row),
      postAuthor: null,
      state: actionState(row.status),
      approved: row.approved,
      at: row.at,
      // An acceptance has no words, and the DM's answer opens with the DM.
      cameBack:
        row.answer_at === null
          ? null
          : { at: row.answer_at, words: row.kind === "invite" ? null : row.answer_text, item: `action:${row.id}` },
    });
  }
  return reach;
}

function actionState(status: ActionStatus): ReachState {
  if (status === "confirmed") return "sent";
  if (ACTION_TAB_STATUSES.scheduled.includes(status)) return "going_out";
  return status === "awaiting_review" ? "waiting" : "not_sent";
}

/** What of one campaign's goes out by `until` — its scheduled comments and
 *  replies whose slot falls before then or that hold none, and its queued
 *  actions while the account's dispatch is due by then — and the soonest of
 *  those moments: the account's plan (`accountPlan`), narrowed to the
 *  campaign. An action holds no slot of its own; the gate admits it on the
 *  channel's next dispatch (`enqueueActionDispatch`). */
export async function campaignGoingOut(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  until: number,
): Promise<{ count: number; soonest: number | null }> {
  const [sends] = await tx
    .select({ n: count(), soonest: min(messages.scheduledAt) })
    .from(messages)
    .where(
      and(
        eq(messages.campaignId, campaignId),
        inArray(messages.status, ["approved", "posting"]),
        or(isNull(messages.scheduledAt), lte(messages.scheduledAt, until)),
      ),
    );
  const [campaign] = await tx.select({ channelId: campaigns.channelId }).from(campaigns).where(eq(campaigns.id, campaignId));
  // `jobs` is excluded from RLS, so the org predicate is explicit.
  const [dispatch] =
    campaign?.channelId == null
      ? []
      : await tx
          .select({ at: jobs.nextRunAt })
          .from(jobs)
          .where(
            and(
              eq(jobs.organizationId, organizationId),
              eq(jobs.idempotencyKey, dispatchActionsKey(campaign.channelId)),
              inArray(jobs.status, ["queued", "running"]),
              lte(jobs.nextRunAt, until),
            ),
          );
  const [queued] = dispatch
    ? await tx
        .select({ n: count() })
        .from(actions)
        .where(
          and(
            eq(actions.campaignId, campaignId),
            inArray(actions.status, [...ACTION_TAB_STATUSES.scheduled]),
            notInArray(actions.kind, [...MESSAGE_SENDS]),
          ),
        )
    : [];
  const queuedAt = dispatch && (queued?.n ?? 0) > 0 ? dispatch.at : null;
  const soonest = [sends?.soonest ?? null, queuedAt].filter((at): at is number => at !== null);
  return { count: (sends?.n ?? 0) + (queued?.n ?? 0), soonest: soonest.length > 0 ? Math.min(...soonest) : null };
}
