import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  channels,
  tasks,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { readExecutionAuthority, type AuthorityReason } from "../execution/authority";

/**
 * WHAT A CLOSED LID MEANS, and what it deliberately does not mean (ADR-08).
 *
 * Sleeping quiesces NEW claims. It does not touch an operation holder or a
 * prepared task, because the machine going to sleep is evidence about this
 * process and no evidence at all about a write already handed to LinkedIn.
 * Recording the opposite — "cancelled at sleep" — would be exactly the false negative
 * that turns one uncertain send into a duplicate on the next wake (TIER-04's
 * no-blind-retry rule).
 *
 * Waking is therefore not "resume": it is a revalidation of every fact that
 * may have moved while nothing was watching — the database, the account
 * binding, the placement epoch and the resources already committed — before a
 * single new claim is admitted.
 */

/** What was in flight when the lid closed. Every field is a COUNT of things
 *  left exactly as they were, so the UI can say what is preserved rather than
 *  implying anything was stopped. */
export type SleepQuiesce = {
  /** Channels holding a dispatch operation: a send that may already have
   *  reached LinkedIn. Never cleared here. */
  dispatchesInFlight: number;
  /** Prepared stages the owner's agent had not submitted. They expire on their
   *  own TTL through `settleExpiredTasks`; sleeping does not expire them. */
  stagesAwaiting: number;
};

export async function quiesceForSleep(
  tx: Tx,
  organizationId: string,
): Promise<SleepQuiesce> {
  const [dispatches] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        isNotNull(channels.executionHolder),
      ),
    );
  const [stages] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        eq(tasks.status, "awaiting_agent"),
      ),
    );
  return {
    dispatchesInFlight: dispatches?.n ?? 0,
    stagesAwaiting: stages?.n ?? 0,
  };
}

export type WakeChannelVerdict = {
  channelId: number;
  ok: boolean;
  /** The authority module's own vocabulary, never a second one invented here.
   *  `null` when the channel revalidated. */
  reason: AuthorityReason | null;
};

export type WakeRevalidation = {
  ok: boolean;
  /** How long the machine was asleep, when the sleep was recorded. */
  sleptForMs: number | null;
  channels: WakeChannelVerdict[];
  /** The one recovery the owner is offered, drawn from the failing channel.
   *  Null when everything revalidated. */
  recovery: "verify_account" | "resume_transfer" | "reconcile" | null;
};

/**
 * Revalidate before new work, using the SAME authority read every dispatch
 * uses — a wake that re-derived its own view of the epoch would be a second
 * implementation of the fence, and a stale one is precisely what a sleeping
 * machine risks having.
 *
 * A channel whose runtime id, placement, account binding or epoch has moved
 * fails closed here, so the first thing a woken supervisor learns is that this
 * install is no longer the executor — before the scheduler enqueues anything.
 */
export async function revalidateAfterWake(
  tx: Tx,
  input: { organizationId: string; sleepingSince: number | null; now: number },
): Promise<WakeRevalidation> {
  const rows = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.organizationId, input.organizationId))
    .orderBy(channels.id);
  const verdicts: WakeChannelVerdict[] = [];
  let recovery: WakeRevalidation["recovery"] = null;
  for (const row of rows) {
    const decision = await readExecutionAuthority(tx, row.id);
    verdicts.push({
      channelId: row.id,
      ok: decision.allowed,
      reason: decision.allowed ? null : decision.reason,
    });
    if (!decision.allowed && recovery === null) recovery = decision.recovery;
  }
  return {
    ok: verdicts.every((verdict) => verdict.ok),
    sleptForMs:
      input.sleepingSince === null
        ? null
        : Math.max(0, input.now - input.sleepingSince),
    channels: verdicts,
    recovery,
  };
}
