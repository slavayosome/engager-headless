import { and, desc, eq, sql } from "drizzle-orm";
import {
  supervisionEvents,
  supervisionState,
  type SupervisionEventRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  INITIAL_SUPERVISION,
  supervisionTick,
  supervisionTransition,
  type SupervisionSignal,
  type SupervisionSnapshot,
  type SupervisionTransition,
} from "./lifecycle";

/**
 * The DURABLE half of supervision: who holds it, what the policy in
 * `lifecycle.ts` last decided, and the append-only history that makes "it
 * restarted three times" checkable.
 *
 * The holder is exclusive in exactly the sense `channels.executionHolder` is,
 * and for the same reason: two supervisors watching one install would each
 * restart the other's process. It is deliberately NOT dispatch authority —
 * losing this lease stops the WATCH, and a send already dispatched settles
 * through `settleDispatch` regardless (TIER-05). Nothing in this module can
 * enqueue work, publish anything or move an epoch.
 */

/** How long a supervision claim survives without a renewal. Short enough that
 *  a crashed supervisor's install is adoptable within a tick, long enough that
 *  an ordinary five-minute scheduler pass renews it comfortably. */
export const SUPERVISION_LEASE_MS = 10 * 60_000;

/**
 * How long a recorded sleep may survive a LIVE renewal before the renewal reads
 * it as a wake nobody came back to report.
 *
 * A renewal is proof that this installation root is awake and serving ticks — a
 * suspended machine runs no scheduler. So a sleep that is still open while ticks
 * are arriving means the supervisor that recorded it is not coming back to end
 * it: the app was deleted after a lapse, or the lid never actually closed. One
 * scheduler period is the bound, which is far longer than the fraction of a
 * second a live supervisor takes to report a real wake, and far shorter than an
 * owner should wait for their own free core.
 */
export const UNREPORTED_WAKE_MS = 5 * 60_000;

/** The supervised process a self-managed runtime's own lifecycle events belong
 *  to: the agent is the process that runs the scheduler renewing this claim. */
const SELF_SUPERVISED_COMPONENT = "agent";

export type Supervisor = "self_managed" | "managed_desktop";

export type SupervisionRecord = SupervisionSnapshot & {
  organizationId: string;
  supervisor: Supervisor;
  holderId: string | null;
  holderLeaseUntil: number | null;
  updatedAt: number | null;
};

function toSnapshot(row: {
  state: SupervisionSnapshot["state"];
  restartCount: number;
  restartWindowStartedAt: number | null;
  backoffUntil: number | null;
  healthySince: number | null;
  lastDiagnosis: string | null;
  lastDiagnosisAt: number | null;
  sleepingSince: number | null;
}): SupervisionSnapshot {
  return {
    state: row.state,
    restartCount: row.restartCount,
    restartWindowStartedAt: row.restartWindowStartedAt,
    backoffUntil: row.backoffUntil,
    healthySince: row.healthySince,
    lastDiagnosis: row.lastDiagnosis,
    lastDiagnosisAt: row.lastDiagnosisAt,
    sleepingSince: row.sleepingSince,
  };
}

/** Nothing creates this row eagerly, exactly like `system_state`: an install
 *  nobody has supervised yet reads the initial snapshot with no holder rather
 *  than a row of defaults somebody has to interpret. */
export async function readSupervision(
  tx: Tx,
  organizationId: string,
): Promise<SupervisionRecord> {
  const [row] = await tx
    .select()
    .from(supervisionState)
    .where(eq(supervisionState.organizationId, organizationId));
  if (!row) {
    return {
      ...INITIAL_SUPERVISION,
      organizationId,
      supervisor: "self_managed",
      holderId: null,
      holderLeaseUntil: null,
      updatedAt: null,
    };
  }
  return {
    ...toSnapshot(row),
    organizationId,
    supervisor: row.supervisor,
    holderId: row.holderId,
    holderLeaseUntil: row.holderLeaseUntil,
    updatedAt: row.updatedAt,
  };
}

/** Whether `row` is currently held by someone other than `holderId`. An expired
 *  lease is not a holder: the previous supervisor is gone and did not say so. */
export function heldByAnother(
  record: Pick<SupervisionRecord, "holderId" | "holderLeaseUntil">,
  holderId: string,
  now: number,
): boolean {
  return (
    record.holderId !== null &&
    record.holderId !== holderId &&
    record.holderLeaseUntil !== null &&
    record.holderLeaseUntil > now
  );
}

export type SupervisionClaim =
  | { status: "claimed"; record: SupervisionRecord }
  | { status: "held_elsewhere"; record: SupervisionRecord };

/**
 * Take (or renew) supervision. The commercial question — may this machine
 * supervise as `managed_desktop`? — is answered by `adoption.ts` BEFORE this
 * call; what happens here is only mutual exclusion and the durable record.
 *
 * A claim never touches the lifecycle snapshot. Adoption after a lapse, or a
 * crashed supervisor's install picked up by the owner's own `engager up`, must
 * inherit the restart history and the last diagnosis rather than start the
 * budget again — otherwise "at most three restarts in ten minutes" would be
 * escapable by handing supervision back and forth.
 */
export async function claimSupervision(
  tx: Tx,
  input: {
    organizationId: string;
    holderId: string;
    supervisor: Supervisor;
    now: number;
    leaseMs?: number;
  },
): Promise<SupervisionClaim> {
  const leaseMs = input.leaseMs ?? SUPERVISION_LEASE_MS;
  // Serialize against a simultaneous claim by another process at this
  // installation root, the same advisory-lock discipline the engagement safety
  // writes use. Two `engager up` starts racing must not both win.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`supervision:${input.organizationId}`}, 0))`,
  );
  const current = await readSupervision(tx, input.organizationId);
  if (heldByAnother(current, input.holderId, input.now)) {
    return { status: "held_elsewhere", record: current };
  }
  const supervisorChanged = current.supervisor !== input.supervisor;
  const values = {
    organizationId: input.organizationId,
    supervisor: input.supervisor,
    holderId: input.holderId,
    holderLeaseUntil: input.now + leaseMs,
    updatedAt: input.now,
  };
  await tx
    .insert(supervisionState)
    .values(values)
    .onConflictDoUpdate({
      target: supervisionState.organizationId,
      set: {
        supervisor: values.supervisor,
        holderId: values.holderId,
        holderLeaseUntil: values.holderLeaseUntil,
        updatedAt: values.updatedAt,
      },
    });
  if (supervisorChanged || current.holderId !== input.holderId) {
    await tx.insert(supervisionEvents).values({
      organizationId: input.organizationId,
      component: "supervisor",
      state: current.state,
      reason: "supervisor_changed",
      holderId: input.holderId,
      diagnosis: null,
      at: input.now,
    });
  }
  return {
    status: "claimed",
    record: {
      ...current,
      supervisor: input.supervisor,
      holderId: input.holderId,
      holderLeaseUntil: values.holderLeaseUntil,
      updatedAt: input.now,
    },
  };
}

/**
 * Keep a claim alive WITHOUT touching who the supervisor is.
 *
 * The distinction is load-bearing. Every process at one installation root
 * shares its runtime instance id (`runtimeInstanceId`), so the agent the Mac
 * app supervises holds the same id the app claimed with. A renewal that also
 * wrote `supervisor` would let the supervised process quietly demote its own
 * supervisor to `self_managed` on the first scheduler tick after a maintained
 * Mac took over. Only an explicit adoption — a verified Mac sign-in over the
 * app's own bridge — moves that field; `resumeSupervision` does not, which is
 * what makes it safe for the owner to run from a terminal.
 *
 * An install nobody has ever supervised gets its row here, as `self_managed`:
 * that is what `engager up` on a laptop IS, and it needs no ceremony.
 *
 * What a renewal DOES say, when nothing else can, is that this runtime is up —
 * see `recordRuntimeIsUp` below for the two shapes in which that is news.
 */
export async function renewSupervision(
  tx: Tx,
  input: {
    organizationId: string;
    holderId: string;
    now: number;
    leaseMs?: number;
    component?: string;
  },
): Promise<SupervisionClaim> {
  const leaseMs = input.leaseMs ?? SUPERVISION_LEASE_MS;
  // The same advisory lock a claim takes, for the same reason: this decides
  // exclusivity too. Without it, a renewal whose read predated another
  // installation root's committed claim would block on the row lock and then
  // overwrite `holderId` with its own, leaving both sides believing they hold
  // supervision.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`supervision:${input.organizationId}`}, 0))`,
  );
  const current = await readSupervision(tx, input.organizationId);
  if (heldByAnother(current, input.holderId, input.now)) {
    return { status: "held_elsewhere", record: current };
  }
  const nobodyWasHolding =
    current.holderId === null ||
    current.holderId !== input.holderId ||
    current.holderLeaseUntil === null ||
    current.holderLeaseUntil <= input.now;
  const unreportedWake =
    current.state === "paused" &&
    current.sleepingSince !== null &&
    input.now - current.sleepingSince >= UNREPORTED_WAKE_MS;
  await tx
    .insert(supervisionState)
    .values({
      organizationId: input.organizationId,
      supervisor: current.supervisor,
      holderId: input.holderId,
      holderLeaseUntil: input.now + leaseMs,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: supervisionState.organizationId,
      set: {
        holderId: input.holderId,
        holderLeaseUntil: input.now + leaseMs,
        updatedAt: input.now,
      },
    });
  const held: SupervisionRecord = {
    ...current,
    holderId: input.holderId,
    holderLeaseUntil: input.now + leaseMs,
    updatedAt: input.now,
  };
  if (!nobodyWasHolding && !unreportedWake) {
    return { status: "claimed", record: held };
  }
  return {
    status: "claimed",
    record: await recordRuntimeIsUp(tx, {
      organizationId: input.organizationId,
      holderId: input.holderId,
      component: input.component ?? SELF_SUPERVISED_COMPONENT,
      now: input.now,
      current: held,
    }),
  };
}

/**
 * A RENEWAL IS EVIDENCE THAT THIS RUNTIME IS UP, and in two cases that is a
 * fact the record does not have yet.
 *
 * `paused` and `recovery_required` are written by the maintained Mac app, and
 * both stop the scheduler arming product work. Before this, both were cleared
 * only by a further signal from that same app — so an owner whose service
 * lapsed, whose app crashed, or who restored an archive carrying one of those
 * states kept a free core that armed nothing ever again. That is the artificial
 * restriction on the free core the phase's Excluded list forbids and the
 * opposite of the lapse rule: a lapse changes WHO supervises the same core and
 * nothing else.
 *
 * The way out is the renewal itself, in the two shapes where it says something
 * new:
 *
 * - **nobody holds a live lease.** Whoever wrote the state is not here; this
 *   process is, and it is running. That is a start;
 * - **a sleep no supervisor came back to end.** A suspended machine serves no
 *   ticks, so a renewal arriving while `paused` is open past
 *   `UNREPORTED_WAKE_MS` is a wake nobody reported.
 *
 * The retry budget is deliberately NOT reset by either: `start_requested`
 * leaves `restartCount` and its window exactly where they were, so handing
 * supervision back and forth still buys no extra attempts, and the next failure
 * on a spent budget is `recovery_required` again immediately.
 */
async function recordRuntimeIsUp(
  tx: Tx,
  input: {
    organizationId: string;
    holderId: string;
    component: string;
    now: number;
    current: SupervisionRecord;
  },
): Promise<SupervisionRecord> {
  let record = input.current;
  // Two signals, because that is what came up and became usable: the scheduler
  // tick this renewal is part of IS the agent's readiness surface, and leaving
  // the record at `starting` for the life of a self-managed install would be
  // less true, not more careful.
  for (const kind of ["start_requested", "ready"] as const) {
    record = await persistTransition(
      tx,
      input,
      record,
      supervisionTransition(record, { kind }, input.now),
    );
  }
  return record;
}

/**
 * Hand supervision back. Only the holder may release, and releasing changes no
 * lifecycle state: quitting the Mac app leaves the recorded history and the
 * last diagnosis exactly where they were, which is what an owner reads on the
 * dashboard afterwards.
 */
export async function releaseSupervision(
  tx: Tx,
  input: { organizationId: string; holderId: string; now: number },
): Promise<void> {
  await tx
    .update(supervisionState)
    .set({ holderId: null, holderLeaseUntil: null, updatedAt: input.now })
    .where(
      and(
        eq(supervisionState.organizationId, input.organizationId),
        eq(supervisionState.holderId, input.holderId),
      ),
    );
}

export type RecordedSignal =
  | { status: "recorded"; transition: SupervisionTransition; record: SupervisionRecord }
  | { status: "held_elsewhere"; record: SupervisionRecord };

/**
 * Apply one observed signal: read the snapshot, run the pure policy, persist
 * the result and append the event it produced.
 *
 * A caller that is not the holder is refused rather than merged. A stale Mac
 * app reporting "child exited" for a process the owner's own `engager up`
 * replaced would otherwise spend the live supervisor's retry budget.
 */
export async function recordSupervisionSignal(
  tx: Tx,
  input: {
    organizationId: string;
    holderId: string;
    component: string;
    signal: SupervisionSignal;
    now: number;
  },
): Promise<RecordedSignal> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`supervision:${input.organizationId}`}, 0))`,
  );
  const current = await readSupervision(tx, input.organizationId);
  if (heldByAnother(current, input.holderId, input.now)) {
    return { status: "held_elsewhere", record: current };
  }
  const transition = supervisionTransition(current, input.signal, input.now);
  return {
    status: "recorded",
    transition,
    record: await persistTransition(tx, input, current, transition),
  };
}

/**
 * The supervisor's periodic question, with no new fact behind it: what has the
 * passage of time made true?
 *
 * This is what turns bounded recovery from arithmetic into behaviour. A crashed
 * component is already reaped, so nothing observable happens when its backoff
 * elapses — the supervisor has to come back and be told `restart`. The same
 * question is the only thing that can notice that health has lasted long enough
 * to earn the retry budget back.
 *
 * A tick that decided nothing WRITES nothing: it is asked every few seconds for
 * the life of an install, and an UPDATE on this row each time would be churn
 * for no fact.
 */
export async function recordSupervisionTick(
  tx: Tx,
  input: {
    organizationId: string;
    holderId: string;
    component: string;
    now: number;
  },
): Promise<RecordedSignal> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`supervision:${input.organizationId}`}, 0))`,
  );
  const current = await readSupervision(tx, input.organizationId);
  if (heldByAnother(current, input.holderId, input.now)) {
    return { status: "held_elsewhere", record: current };
  }
  const transition = supervisionTick(current, input.now);
  if (transition.event === null) {
    return { status: "recorded", transition, record: current };
  }
  return {
    status: "recorded",
    transition,
    record: await persistTransition(tx, input, current, transition),
  };
}

/**
 * The owner's own "start it again".
 *
 * `recovery_required` is deliberately terminal until somebody acts, and this is
 * that act: `engager supervision resume` lands here. It is an ordinary
 * `start_requested`, so it inherits the retry budget rather than granting a
 * fresh one — an owner clearing a spent budget gets the runtime running again,
 * not three more attempts. It records the INTENT and nothing else: it starts no
 * process, and `supervisor` is `adoptSupervision`'s field to write. The
 * dashboard offered a button for this until the Settings split removed it — the
 * free tier has no dashboard, so choosing to run unsupervised is not a state
 * that app can be the place for.
 */
export async function resumeSupervision(
  tx: Tx,
  input: { organizationId: string; holderId: string; component?: string; now: number },
): Promise<RecordedSignal> {
  return recordSupervisionSignal(tx, {
    organizationId: input.organizationId,
    holderId: input.holderId,
    component: input.component ?? SELF_SUPERVISED_COMPONENT,
    signal: { kind: "start_requested" },
    now: input.now,
  });
}

export type RuntimeBootRecord = {
  status: "recorded" | "held_elsewhere" | "nothing_to_clear";
  record: SupervisionRecord;
};

/**
 * This runtime's own process coming up, recorded once.
 *
 * The runbook's answer to `Needs recovery` is `engager stop` then
 * `engager up --headless`, and that has to be literally true. A renewal alone
 * cannot make it so: every process at one installation root shares
 * `runtimeInstanceId()`, so the agent's own ticks keep the lease live and
 * `recovery_required` never becomes "nobody is holding this". A start the OWNER
 * performed is a different fact from a tick, and this records it — the same
 * evidence `resumeSupervision` records when the owner says so from the CLI,
 * arriving from the runtime coming up instead.
 *
 * Narrow on purpose. It speaks only for the two states that hold the free
 * core's work back, it inherits the retry budget rather than granting one (a
 * crash loop that boots again gets no extra attempts), and it still refuses to
 * write over ANOTHER installation root's live claim — `recordSupervisionSignal`
 * answers `held_elsewhere` there, and a restored archive's previous holder must
 * still expire on its own lease.
 */
export async function resumeSupervisionAtRuntimeBoot(
  tx: Tx,
  input: { organizationId: string; holderId: string; component?: string; now: number },
): Promise<RuntimeBootRecord> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`supervision:${input.organizationId}`}, 0))`,
  );
  const current = await readSupervision(tx, input.organizationId);
  if (heldByAnother(current, input.holderId, input.now)) {
    return { status: "held_elsewhere", record: current };
  }
  if (current.state !== "recovery_required" && current.state !== "paused") {
    return { status: "nothing_to_clear", record: current };
  }
  // The same two signals a renewal that finds nobody holding records, for the
  // same reason: this process started, and the scheduler it is starting is the
  // readiness surface a self-managed install has.
  return {
    status: "recorded",
    record: await recordRuntimeIsUp(tx, {
      organizationId: input.organizationId,
      holderId: input.holderId,
      component: input.component ?? SELF_SUPERVISED_COMPONENT,
      now: input.now,
      current,
    }),
  };
}

/** The one write a decided transition makes: the snapshot the policy produced,
 *  and the event it produced beside it. An install that has never been
 *  supervised gets its row here, under the caller's own holder and lease. */
async function persistTransition(
  tx: Tx,
  input: { organizationId: string; holderId: string; component: string; now: number },
  current: SupervisionRecord,
  transition: SupervisionTransition,
): Promise<SupervisionRecord> {
  const next = transition.next;
  const holderId = current.holderId ?? input.holderId;
  const holderLeaseUntil =
    current.holderLeaseUntil ?? input.now + SUPERVISION_LEASE_MS;
  await tx
    .insert(supervisionState)
    .values({
      organizationId: input.organizationId,
      supervisor: current.supervisor,
      holderId,
      holderLeaseUntil,
      ...next,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: supervisionState.organizationId,
      set: { ...next, updatedAt: input.now },
    });
  if (transition.event) {
    await tx.insert(supervisionEvents).values({
      organizationId: input.organizationId,
      component: input.component,
      state: transition.event.state,
      reason: transition.event.reason,
      holderId: input.holderId,
      diagnosis: transition.event.diagnosis,
      at: input.now,
    });
  }
  return {
    ...next,
    organizationId: input.organizationId,
    supervisor: current.supervisor,
    holderId,
    holderLeaseUntil,
    updatedAt: input.now,
  };
}

/** Append a maintenance transition (update applied, rollback, update failed)
 *  to the same history the restarts are in — one timeline, so "it stopped
 *  after the update" reads as one sequence rather than two tables. */
export async function recordMaintenanceEvent(
  tx: Tx,
  input: {
    organizationId: string;
    component: string;
    state: SupervisionSnapshot["state"];
    reason: "update_applied" | "update_failed" | "rollback_applied";
    holderId: string | null;
    diagnosis: string | null;
    now: number;
  },
): Promise<void> {
  await tx.insert(supervisionEvents).values({
    organizationId: input.organizationId,
    component: input.component,
    state: input.state,
    reason: input.reason,
    holderId: input.holderId,
    diagnosis: input.diagnosis,
    at: input.now,
  });
}

export async function listSupervisionEvents(
  tx: Tx,
  organizationId: string,
  limit = 20,
): Promise<SupervisionEventRow[]> {
  return tx
    .select()
    .from(supervisionEvents)
    .where(eq(supervisionEvents.organizationId, organizationId))
    .orderBy(desc(supervisionEvents.at), desc(supervisionEvents.id))
    .limit(limit);
}
