import { asc, eq, sql } from "drizzle-orm";
import { channels, systemState } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { ConnectorBinding } from "../connector/binding";
import { DEFAULT_NETWORK } from "../network/registry";

/**
 * The org's channel row.
 *
 * Filtered and ordered even though the invariant says there is exactly one row,
 * for the same reason `createCampaignOp`'s resolve is: a second entry in
 * `network/registry.ts` will legitimately put a SECOND row here, and a bare
 * unordered `limit(1)` would go silently nondeterministic that day rather than
 * obviously wrong. Oldest row wins until a network-aware resolve replaces it.
 */
async function orgChannel(tx: Tx) {
  const [channel] = await tx
    .select({
      id: channels.id,
      organizationId: channels.organizationId,
      connector: channels.connector,
      pausedReason: channels.pausedReason,
      pausedUntil: channels.pausedUntil,
      updatedAt: channels.updatedAt,
    })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .orderBy(asc(channels.id))
    .limit(1);
  return channel ?? null;
}

/** Serialize a spend/action reservation with kill-switch and auto-pause writes,
 * including the empty-system_state case where no row exists to lock. */
export async function lockEngagementSafety(tx: Tx): Promise<void> {
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtext('engager-engagement-safety'),
      hashtext(current_setting('app.current_org', true))
    )
  `);
}

/**
 * Per-org global flags. `system_state` is RLS-scoped to the current org, so these
 * operate on (at most) the one row visible inside a `withOrg` transaction —
 * organization_id is supplied by the GUC default on insert.
 *
 * THE SEAM. The return shape has not changed, but the RISK pause it reports is
 * the account's: `pausedReason`/`pausedUntil` come from the `channels` row,
 * while `killSwitch` combines the owner's org-wide stop and the durable runtime
 * transfer fence in `system_state`. That lets every existing caller — the
 * worker run's preflight, the runner's readiness idle, the radar sweep, learning signals,
 * setup, `get_status`, and the safety and radar pages — read the channel
 * pause without an edit.
 *
 * The synthesized branch matters: nothing creates a `system_state` row eagerly
 * (it appears on the first kill-switch write), and since a pause does not upsert
 * one, an org can be genuinely paused with no singleton at all. Returning null
 * there would have reported every such account as unpaused.
 */
export async function getSystemState(tx: Tx) {
  const [s] = await tx.select().from(systemState);
  const channel = await orgChannel(tx);
  if (!s && !channel) return null;
  const base = s ?? {
    organizationId: channel!.organizationId,
    killSwitch: false,
    transferPaused: false,
    cloudPaused: false,
    cloudControlRevision: 0,
    updatedAt: channel!.updatedAt,
  };
  return {
    ...base,
    /**
     * The OWNER's own stop, on its own — the one bit `applyKillSwitch` writes.
     *
     * `killSwitch` below ORs in two fences nothing on this side can clear, so a
     * surface that renders it as the state of the owner's switch shows a
     * control that springs back on after they turn it off, with no explanation.
     * A reader that offers the switch needs both: this to draw it, and the two
     * flags beside it to say why posting has not resumed.
     */
    ownerKillSwitch: base.killSwitch,
    killSwitch: base.killSwitch || base.transferPaused || base.cloudPaused,
    pausedReason: channel?.pausedReason ?? null,
    pausedUntil: channel?.pausedUntil ?? null,
  };
}

/**
 * The account's risk pause, when one is in force right now.
 *
 * Read on its OWN, before a spend, rather than inferred from the refusal one
 * earned: `reserveReadCall` answers a parked account with a flat reason and
 * a generic `retryAt` of its own choosing, which cannot tell a caller which
 * pause it met or when the account is actually free again. A sweep that reports
 * "paused as `checkpoint` until 11:41" is actionable; the same sweep reporting
 * `0 found` is what shipped (measured 2026-09-15).
 */
export async function activeChannelPause(
  tx: Tx,
  now = Date.now(),
): Promise<{ reason: string; until: number } | null> {
  const channel = await orgChannel(tx);
  if (!channel?.pausedUntil || channel.pausedUntil <= now) return null;
  return {
    reason: channel.pausedReason ?? "auto_paused",
    until: channel.pausedUntil,
  };
}

export async function setKillSwitch(tx: Tx, on: boolean): Promise<void> {
  await lockEngagementSafety(tx);
  const now = Date.now();
  await tx
    .insert(systemState)
    .values({ killSwitch: on, updatedAt: now })
    .onConflictDoUpdate({
      target: systemState.organizationId,
      set: {
        killSwitch: on,
        // Also fences in-flight drafts across stop + clear, even in one ms.
        updatedAt: sql`greatest(${now}, ${systemState.updatedAt} + 1)`,
      },
    });
}

/**
 * The layer-3 risk pause. The name says whose it is: a throttle or a checkpoint
 * is a fact about the connected ACCOUNT, not about the org, and the old
 * `autoPause` said neither. Serialized under `lockEngagementSafety` alongside
 * the reservation writes.
 *
 * An UPDATE, not an upsert: every org has had a `channels` row since the table
 * was created (migration seed + `bootstrapLocalOrg` mint), so there is nothing
 * to create here — and minting one as a side effect of a throttle would invent
 * an identity-less account row on the one path least able to describe it.
 *
 * Returns the pause it wrote (null when there was no row to park), so a caller
 * that has to act on WHICH account was parked and until when does not re-read
 * the row it just updated.
 */
export async function pauseChannel(
  tx: Tx,
  reason: string,
  minutes: number,
): Promise<{
  channelId: number;
  connector: ConnectorBinding;
  pausedUntil: number;
} | null> {
  await lockEngagementSafety(tx);
  const now = Date.now();
  const until = now + minutes * 60_000;
  const channel = await orgChannel(tx);
  if (!channel) return null;
  await tx
    .update(channels)
    .set({ pausedReason: reason, pausedUntil: until, updatedAt: now })
    .where(eq(channels.id, channel.id));
  return {
    channelId: channel.id,
    connector: channel.connector,
    pausedUntil: until,
  };
}

export async function clearChannelPause(tx: Tx): Promise<void> {
  await lockEngagementSafety(tx);
  const channel = await orgChannel(tx);
  if (!channel) return;
  await tx
    .update(channels)
    .set({ pausedReason: null, pausedUntil: null, updatedAt: Date.now() })
    .where(eq(channels.id, channel.id));
}

/**
 * How long a connector backoff parks the account. Fifteen minutes, matching the
 * reschedule every read path already picked for the same signal — the pause and
 * the retry should not disagree about how long the condition is expected to
 * last, or the job wakes into a gate that still refuses it.
 *
 * The SEND path parks for 120 minutes (`actions/messageSend.ts`), and that difference is
 * deliberate: a 429 on a write is the account being told to stop writing.
 */
export const CONNECTOR_BACKOFF_PAUSE_MINUTES = 15;

/**
 * The one place a connector backoff becomes channel state.
 *
 * INV-13's split, stated as code: the connector REPORTS (`rateLimited` /
 * `checkpoint`), layer 3 DECIDES. `connectorError.ts` is untouched by this, and
 * nothing here writes `rate_limit_ledger` — a backoff is not a spend.
 *
 * This closes T-2.11's "backoff but no auto-pause" gap on reads: before, only
 * the send path paused, so a throttle met while polling or enriching rescheduled
 * one job and left every other lane free to keep hitting the same throttled
 * account.
 *
 * Best-effort by construction. The callers are inside `catch` blocks whose job
 * is to reschedule; three of the six then `break` rather than throw. A failed
 * pause write must not convert a handled backoff into an unhandled error, so it
 * is logged and swallowed — the reschedule is the load-bearing half.
 *
 * Returns the reason so call sites keep one vocabulary for the pause and the
 * `RescheduleError` they raise next.
 */
export async function pauseChannelForConnectorBackoff(
  organizationId: string,
  error: { checkpoint?: boolean },
): Promise<"checkpoint" | "rate_limited"> {
  const reason = error.checkpoint ? "checkpoint" : "rate_limited";
  try {
    await withOrg(organizationId, async (tx) => {
      await lockEngagementSafety(tx);
      await pauseChannel(tx, reason, CONNECTOR_BACKOFF_PAUSE_MINUTES);
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[killswitch] could not record the connector backoff pause:",
      e instanceof Error ? e.message : e,
    );
  }
  return reason;
}
