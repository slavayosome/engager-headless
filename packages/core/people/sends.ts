import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { channels, type ActionStatus, type ActiveHours } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { PASSING_HOLDS } from "../activity/messageRows";
import { withinActiveWindow } from "../time";
import { actionSendState, messageSendState, type Opening, type Send } from "./sendState";

/**
 * THE SENDS OF OURS ON THEIR WAY OUT TO ONE PERSON — read from the rows that
 * hold them, and classified by `sendState.ts`: their approved comments and
 * replies from `messages`, their invites, acceptances and messages from the
 * action ledger.
 *
 * A moment is only ever one a row, the queue or the account's hours name. A
 * comment's is its planned slot, or the instant the drain looks again after the
 * gate held the action that sends it (as `blockedSends` reads it for Activity).
 * An action's is the instant the account's `dispatch_actions` job runs again,
 * which is where `actions/drain.ts` rescheduled it when the gate held the
 * action. A hold on the account's active
 * hours names their next opening instead, from the channel's own hours, because
 * the queue's instant is shared by every held action and can fall before they
 * open. `jobs`, outside RLS, is read with the row's own organization. Reads
 * only, inside the caller's `withOrg`.
 */

/** The channel's hours a row is held against. */
type Hours = { active_hours: ActiveHours | null; active_days: string[] | null };

type MessageRow = Hours & {
  id: number;
  kind: "comment" | "reply" | "room_reply";
  status: string;
  scheduled_at: number | null;
  paused_campaign: { id: number; name: string } | null;
  send_authorized: boolean | null;
  code: string | null;
  retry_at: number | null;
  queued_at: number;
};

type ActionRow = Hours & {
  id: number;
  conversation_id: number;
  kind: "invite" | "accept_invite" | "dm" | "followup";
  status: ActionStatus;
  status_reason: string | null;
  retry_at: number | null;
  queued_at: number;
};

/** When the channel's hours next open, null where they are open now or none
 *  are kept. The window is scanned, so one channel's is scanned once. */
function openings(now: number): (row: Hours) => Opening | null {
  const known = new Map<string, Opening | null>();
  return (row) => {
    const key = JSON.stringify([row.active_hours, row.active_days]);
    if (!known.has(key)) {
      const window = withinActiveWindow(now, row.active_hours, row.active_days);
      known.set(
        key,
        window.within || row.active_hours === null
          ? null
          : { at: window.nextOpen, tz: row.active_hours.tz || "UTC" },
      );
    }
    return known.get(key) ?? null;
  };
}

/**
 * The person's sends on their way out: `messageIds` are the comments and
 * replies of ours on their threads (`PersonThread.messageIds`, drafts
 * included — a draft is not on its way and is left out), `conversationId` their
 * conversation, where the ledger keeps the rest. `now` is the instant the
 * hours are read against.
 */
export async function readSends(
  tx: Tx,
  input: { conversationId: number | null; messageIds: readonly number[]; now?: number },
): Promise<Send[]> {
  const sends = await readQueuedSends(tx, {
    conversationIds: input.conversationId === null ? [] : [input.conversationId],
    messageIds: input.messageIds,
    now: input.now,
  });
  return sends.map(({ queuedAt: _queuedAt, conversationId: _conversationId, ...send }) => send);
}

/** A send on its way out, the conversation its ledger row is on (null for a
 *  comment or reply), and when it was put on its way: the owner's newest yes
 *  — a comment's move to approved, an action's approval — else the row's
 *  own making, which is the gate's reservation of an Automatic one. */
export type QueuedSend = Send & { conversationId: number | null; queuedAt: number };

/** `readSends` for many people at once: every send on `conversationIds`, and
 *  among `messageIds`, each with its conversation and its yes. */
export async function readQueuedSends(
  tx: Tx,
  input: { conversationIds: readonly number[]; messageIds: readonly number[]; now?: number },
): Promise<QueuedSend[]> {
  const openingOf = openings(input.now ?? Date.now());
  const writeAuthority = alias(channels, "ch").writesEnabled;
  const comments =
    input.messageIds.length === 0
      ? []
      : ((
          await tx.execute(sql`
            select m.id::float8 as id, m.kind, m.status, m.scheduled_at::float8 as scheduled_at,
              case when m.publish_origin = 'worker' and c.status = 'paused'
                then jsonb_build_object('id', c.id, 'name', c.name) end as paused_campaign,
              ch.active_hours, ch.active_days, ${writeAuthority} as send_authorized,
              refused.code, refused.retry_at::float8 as retry_at,
              coalesce((select max(event.occurred_at) from message_status_events event
                where event.message_id = m.id and event.to_status = 'approved'), m.created_at)::float8 as queued_at
            from messages m
            left join campaigns c on c.id = m.campaign_id
            left join channels ch on ch.id = c.channel_id
            left join lateral (
              select substring(held.status_reason from 6) as code,
                (select job.next_run_at from jobs job
                  where job.organization_id = held.organization_id
                    and job.idempotency_key = 'dispatch_actions:' || held.channel_id
                    and job.status = 'queued') as retry_at
              from actions held
              where held.message_id = m.id and held.kind = m.kind and held.status = 'approved'
                and held.status_reason like 'held:%'
                and held.status_reason not in (${sql.join(PASSING_HOLDS.map((reason) => sql`${`held:${reason}`}`), sql`, `)})
            ) refused on true
            where m.id in (${sql.join(
              input.messageIds.map((id) => sql`${id}`),
              sql`, `,
            )})
              and m.status in ('approved', 'posting')
            order by m.id`)
        ).rows as MessageRow[]);
  const actions =
    input.conversationIds.length === 0
      ? []
      : ((
          await tx.execute(sql`
            select action.id::float8 as id, action.conversation_id::float8 as conversation_id, action.kind, action.status,
              action.status_reason, ch.active_hours, ch.active_days,
              coalesce((select max(approval.created_at) from action_approvals approval
                where approval.action_execution_id = action.id), action.created_at)::float8 as queued_at,
              (select job.next_run_at::float8
                from jobs job
                where job.organization_id = action.organization_id
                  and job.idempotency_key = 'dispatch_actions:' || action.channel_id
                  and job.status = 'queued'
                limit 1) as retry_at
            from actions action
            left join channels ch on ch.id = action.channel_id
            where action.conversation_id in (${sql.join(
              input.conversationIds.map((id) => sql`${id}`),
              sql`, `,
            )})
              and action.kind in ('invite', 'accept_invite', 'dm', 'followup')
              and action.status in ('reserved', 'approved', 'dispatching', 'uncertain')
            order by action.id`)
        ).rows as ActionRow[]);

  const sends: QueuedSend[] = [];
  for (const row of comments) {
    const state = messageSendState(
      { status: row.status, scheduledAt: row.scheduled_at, pausedCampaign: row.paused_campaign,
        sendAuthorized: row.send_authorized ?? undefined },
      row.code === null ? null : { code: row.code, retryAt: row.retry_at },
      openingOf(row),
    );
    if (state) sends.push({ kind: row.kind, id: row.id, state, conversationId: null, queuedAt: row.queued_at });
  }
  for (const row of actions) {
    const state = actionSendState(
      { status: row.status, statusReason: row.status_reason },
      row.retry_at,
      openingOf(row),
    );
    // A message and a follow-up both go out as a message.
    if (state) {
      sends.push({
        kind: row.kind === "followup" ? "dm" : row.kind,
        id: row.id,
        state,
        conversationId: row.conversation_id,
        queuedAt: row.queued_at,
      });
    }
  }
  return sends;
}
