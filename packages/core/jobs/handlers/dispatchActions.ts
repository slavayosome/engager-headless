import { and, eq, inArray, notInArray } from "drizzle-orm";
import { actions } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { backgroundEntitlement, LICENSE_HOLD_RECHECK_MS } from "@engager/billing/entitlement";
import { isGrant } from "../../connector/resolve";
import {
  actionCapabilitiesFor,
  DRAIN_LIMIT,
  drainActions,
  type DrainSummary,
} from "../../execution/actionGate";
import { RECONCILE_LOOKS_MS } from "../../execution/reconcileReads";
import { grantFor } from "../context";
import { RescheduleError } from "../queue";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
} from "../spendAccess";
import type { JobResult, SelfScopedCtx } from "../worker";

const MINUTE = 60_000;
/** A held action whose hold names no instant is looked at again this much
 *  later; its approval expires within a day, which ends the retries. */
const HOLD_RECHECK_MS = 15 * MINUTE;

/**
 * Worker handler for `dispatch_actions`: one account's approved actions
 * through the dispatch gate (`execution/actionGate.ts` `drainActions`) —
 * reconcile first, then the owner's own and the rest, each oldest first,
 * passing over an action held on its own and stopping where the account holds
 * or a click comes back uncertain.
 * Enqueued by the owner's yes and by the settling of an uncertain send
 * (`actions/drain.ts`); never by a model.
 *
 * SELF_SCOPED: the gate commits `dispatching` in its own short transaction
 * before the click and settles after it, so no connection is held across a
 * browser call, and the hosted-spend fence is re-checked in the transaction
 * that writes `dispatching`.
 *
 * What it leaves for later it reschedules: the account's hold at the instant
 * it names; a full drain, or a yes given while this one ran, at once; and
 * otherwise the earliest instant an action held on its own names — which a
 * later yes pulls forward, so a yes never waits behind it (`actions/drain.ts`).
 *
 * A send whose outcome is open does not wait for the owner: the drain looks
 * again on its own at the next of `RECONCILE_LOOKS_MS` after the attempt, and
 * a look is only ever the operation's read (`reconcileActions`) — what it sees
 * settles the send, confirmed or not sent and eligible again, and nothing is
 * pressed without one. Only a send the page still leaves open after the last
 * look is the owner's (`execution/reconcileReads.ts`): it shows in Issues, and
 * their resolution enqueues the next drain.
 */
export async function handleDispatchActions(
  ctx: SelfScopedCtx,
  payload: { channelId: number },
): Promise<JobResult> {
  const org = ctx.organizationId;
  // Record the hold before resolving a connector, while leaving owner presses
  // and reconciliation reads available to the same drain.
  const held = await withOrg(org, async (tx) => {
    const entitlement = await backgroundEntitlement(tx, org, { lock: true });
    if (entitlement.allowed || entitlement.reason !== "license_lapsed") return false;
    const rows = await tx.select({ origin: actions.origin, status: actions.status })
      .from(actions).where(and(eq(actions.channelId, payload.channelId),
        inArray(actions.status, ["approved", "reserved", "dispatching", "uncertain"])));
    const automatic = rows.some((row) => row.origin === "worker" && (row.status === "approved" || row.status === "reserved"));
    if (automatic) await tx.update(actions).set({ statusReason: "held:license_lapsed", updatedAt: Date.now() })
      .where(and(eq(actions.channelId, payload.channelId), eq(actions.origin, "worker"),
        inArray(actions.status, ["approved", "reserved"])));
    return automatic && !rows.some((row) => row.origin === "owner" || row.status === "dispatching" || row.status === "uncertain");
  });
  if (held) throw new RescheduleError("held:license_lapsed", Date.now() + LICENSE_HOLD_RECHECK_MS);
  const granted = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return grantFor(ctx, tx, await actionCapabilitiesFor(tx, payload.channelId));
  });
  if (!isGrant(granted)) {
    throw new RescheduleError(
      granted.detail ?? "LinkedIn account is not connected",
      Date.now() + 5 * MINUTE,
      granted,
    );
  }
  await assertHostedJobSpendStillAllowed(ctx);
  const summary = await drainActions(
    {
      organizationId: org,
      driver: granted.use,
      connector: granted.connector,
      authorizeStartInTx: (tx) => assertHostedJobSpendStillAllowedInTx(tx, ctx),
    },
    payload.channelId,
  );

  // An owner's answer the journal has not taken yet is retried soon, not on a
  // read's schedule: the account holds until it has.
  if (summary.reconciled.answering.length > 0) {
    throw new RescheduleError(`journal:${summary.reconciled.answering.length}`, Date.now() + MINUTE);
  }
  const last = summary.outcomes.at(-1);
  if (last?.status === "held" && last.scope !== "action") {
    throw new RescheduleError(`held:${last.reason}`, last.retryAt ?? Date.now() + HOLD_RECHECK_MS);
  }
  const open = [...summary.reconciled.unsettled, ...(last?.status === "uncertain" ? [last.id] : [])];
  if (open.length > 0) {
    const look = await nextLook(org, open, Date.now());
    if (look !== null) throw new RescheduleError(`looking:${open.length}`, look);
    return { ...tally(summary), escalated: open.length };
  }
  const heldAlone = summary.outcomes.flatMap((outcome) =>
    outcome.status === "held"
      ? [{ id: outcome.id, retryAt: outcome.retryAt ?? Date.now() + HOLD_RECHECK_MS }]
      : [],
  );
  if (
    summary.outcomes.length >= DRAIN_LIMIT ||
    (await queuedBeside(org, payload.channelId, heldAlone.map((held) => held.id)))
  ) {
    throw new RescheduleError("more_approved", Date.now() + MINUTE);
  }
  if (heldAlone.length > 0) {
    throw new RescheduleError(
      `held:${heldAlone.length}`,
      Math.min(...heldAlone.map((held) => held.retryAt)),
    );
  }
  return tally(summary);
}

/** Whether an approved action is waiting on the account beside the ones this
 *  drain held — one approved while it ran. */
async function queuedBeside(
  organizationId: string,
  channelId: number,
  held: readonly number[],
): Promise<boolean> {
  const [row] = await withOrg(organizationId, (tx) =>
    tx
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          eq(actions.channelId, channelId),
          inArray(actions.status, ["approved", "reserved"]),
          ...(held.length > 0 ? [notInArray(actions.id, [...held])] : []),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/** The earliest look still due on any of these open sends, counted from its
 *  latest attempt, or null once every one is past its last look. */
async function nextLook(
  organizationId: string,
  ids: readonly number[],
  now: number,
): Promise<number | null> {
  const rows = await withOrg(organizationId, (tx) =>
    tx
      .select({ attempts: actions.attempts, updatedAt: actions.updatedAt })
      .from(actions)
      .where(inArray(actions.id, [...ids])),
  );
  const due = rows.flatMap((row) => {
    const startedAt = row.attempts.at(-1)?.startedAt ?? row.updatedAt;
    const at = RECONCILE_LOOKS_MS.map((offset) => startedAt + offset).find((instant) => instant > now);
    return at === undefined ? [] : [at];
  });
  return due.length > 0 ? Math.min(...due) : null;
}

/** Rows the gate wrote, by what became of them. */
function tally(summary: DrainSummary): JobResult {
  const counts: Record<string, number> = {
    interrupted: summary.reconciled.interrupted.length,
    reconciled: summary.reconciled.settled.length,
    unsettled: summary.reconciled.unsettled.length,
  };
  for (const outcome of summary.outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return counts;
}
