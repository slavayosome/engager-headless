import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@engager/database/tenant";

/**
 * What a run's conversation work did, counted over the rows it left: the
 * conversations the server froze for it (`worker_runs.frozen_conversation_ids`),
 * the turns each checkpoint records against it (`step_runs.iterations_by_run`),
 * the calls it proposed and what the server did with each (`step_tool_calls`),
 * and the replies it drafted (`messages`). Every figure is a count of rows the
 * server wrote, never a number a step's result reported (INV-2), and none is
 * stored on the run.
 *
 * A checkpoint carries cumulative spend, and a wake that adopts one moves
 * `step_runs.run_id` to itself (`agentStep/wake.ts`, `openCheckpoint`). So a
 * turn is credited to the run that spent it, from the share the server
 * adds as it spends the turn, whether or not that turn proposed a call; a
 * call is credited by `step_tool_calls.run_id`, which never moves; and a held
 * DM draft is credited only to the run whose call first made it on its
 * checkpoint, and an invitation's note only to the earliest call that queued
 * that action, however many runs are asked for at once.
 *
 * It is one statement, so a run still going cannot be read half-way between
 * two of its writes.
 */
export type ConversationSums = {
  /** Conversations the server selected for the run, before any model call. */
  conversations: number;
  /** Model turns its steps took. */
  turns: number;
  toolCallsDispatched: number;
  toolCallsDiscarded: number;
  /** Replies written as messages, DMs held as a step's decision and the notes
   *  of invitations a step queued. */
  drafts: number;
};

/** A run's sums, read with the run: null for one that selected no conversation
 *  and left no step rows — a Scout's, or one from before conversation work —
 *  which reads "—", not 0. */
export type WithConversation<Run> = Run & { conversation: ConversationSums | null };

type SumsRow = {
  run_id: string | number;
  conversations: number;
  turns: number;
  dispatched: number;
  discarded: number;
  drafts: number;
};

/** The sums of each run that selected conversations or left step rows; a run
 *  that did neither is absent. `checkpoints` is the relation read for step runs,
 *  for a database that has not yet added `iterations_by_run`. */
export async function conversationSums(
  tx: Tx,
  runIds: readonly number[],
  checkpoints: SQL = sql`step_runs`,
): Promise<Map<number, ConversationSums>> {
  const sums = new Map<number, ConversationSums>();
  if (runIds.length === 0) return sums;
  const runs = sql.join(runIds.map((id) => sql`${id}`), sql`, `);
  const { rows } = await tx.execute<SumsRow>(sql`
    with spent as (
      select j.key::bigint as run_id, s.id as step_run_id, j.value::int as turns
      from ${checkpoints} s, jsonb_each_text(s.iterations_by_run) j
      where j.key::bigint in (${runs})
    ),
    worked as (
      select run_id, id as step_run_id from ${checkpoints} s where run_id in (${runs})
      union select run_id, step_run_id from spent
      union select run_id, step_run_id from step_tool_calls where run_id in (${runs})
    ),
    called as (
      select run_id,
        (count(*) filter (where outcome = 'dispatched'))::int as dispatched,
        (count(*) filter (where outcome = 'discarded'))::int as discarded
      from step_tool_calls where run_id in (${runs}) group by run_id
    ),
    held as (
      select k.run_id, count(*)::int as n from step_tool_calls k
      where k.run_id in (${runs}) and k.outcome = 'dispatched' and k.result_ref is not null
        and ((k.tool = 'draft_dm' and not exists (
              select 1 from step_tool_calls p
              where p.step_run_id = k.step_run_id and p.tool = 'draft_dm' and p.outcome = 'dispatched'
                and p.result_ref = k.result_ref and p.id < k.id))
          or (k.tool = 'send_invitation' and not exists (
              select 1 from step_tool_calls p
              where p.tool = 'send_invitation' and p.outcome = 'dispatched'
                and p.result_ref = k.result_ref and p.id < k.id)))
      group by k.run_id
    ),
    replied as (
      select worker_run_id as run_id, count(*)::int as n from messages
      where worker_run_id in (${runs}) and kind <> 'comment' group by worker_run_id
    )
    select r.id as run_id,
      cardinality(r.frozen_conversation_ids) as conversations,
      coalesce((select sum(turns) from spent where spent.run_id = r.id), 0)::int as turns,
      coalesce(called.dispatched, 0) as dispatched,
      coalesce(called.discarded, 0) as discarded,
      coalesce(held.n, 0) + coalesce(replied.n, 0) as drafts
    from worker_runs r
    left join called on called.run_id = r.id
    left join held on held.run_id = r.id
    left join replied on replied.run_id = r.id
    where r.id in (${runs})
      and (cardinality(r.frozen_conversation_ids) > 0 or exists (select 1 from worked where worked.run_id = r.id))
  `);
  for (const row of rows) {
    sums.set(Number(row.run_id), {
      conversations: row.conversations,
      turns: row.turns,
      toolCallsDispatched: row.dispatched,
      toolCallsDiscarded: row.discarded,
      drafts: row.drafts,
    });
  }
  return sums;
}

/** Each run with the sums its rows give. */
export async function withConversationSums<Run extends { id: number }>(
  tx: Tx,
  runs: readonly Run[],
): Promise<WithConversation<Run>[]> {
  const sums = await conversationSums(tx, runs.map((run) => run.id));
  return runs.map((run) => ({ ...run, conversation: sums.get(run.id) ?? null }));
}
