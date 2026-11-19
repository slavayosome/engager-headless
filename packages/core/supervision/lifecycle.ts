import type { SUPERVISED_STATES } from "@engager/database/schema";

/**
 * THE SUPERVISION POLICY, as arithmetic on a snapshot (ADR-08).
 *
 * Everything a supervisor decides about a process it owns — restart or give
 * up, how long to wait, when the retry budget is spent, when a healthy run has
 * earned a fresh budget — is this one pure function. It touches no clock, no
 * database and no process: the caller supplies `now` and the previous
 * snapshot, so the same policy is drivable from a fake clock in a unit test,
 * from the durable row in `supervision_state`, and from the Swift supervisor
 * that reports its signals through the authenticated bridge.
 *
 * The three properties it exists to hold:
 *
 * - **Bounded recovery.** At most `MAX_RESTARTS_PER_WINDOW` restarts inside
 *   `RESTART_WINDOW_MS`. The next crash is `recovery_required`, which is a
 *   terminal state until an owner acts — never a fourth attempt, never a
 *   slower loop that still runs forever.
 * - **A reset is earned, not granted.** The budget returns only after
 *   `STABLE_HEALTHY_MS` of uninterrupted health. A process that crashes every
 *   nine minutes therefore exhausts its budget rather than restarting for ever
 *   at one crash per window.
 * - **Sleep is not a stop.** Sleeping quiesces new work and says so; it never
 *   claims that a dispatched write was cancelled, and waking revalidates
 *   before anything new is claimed.
 */
export type SupervisedState = (typeof SUPERVISED_STATES)[number];

/** Bounded recovery, both halves. Policy constants, not paid guarantees. */
export const RESTART_WINDOW_MS = 10 * 60_000;
export const MAX_RESTARTS_PER_WINDOW = 3;
/** Uninterrupted health that earns a fresh retry budget. */
export const STABLE_HEALTHY_MS = 10 * 60_000;
/** First wait before a restart; each further attempt in the window triples it,
 *  so three attempts spend 5s + 15s + 45s and stay well inside the window. */
export const BACKOFF_BASE_MS = 5_000;

/** The durable snapshot, matching `supervision_state`'s columns one for one so
 *  the row IS the state machine's memory and nothing is derived twice. */
export type SupervisionSnapshot = {
  state: SupervisedState;
  restartCount: number;
  restartWindowStartedAt: number | null;
  backoffUntil: number | null;
  healthySince: number | null;
  lastDiagnosis: string | null;
  lastDiagnosisAt: number | null;
  sleepingSince: number | null;
};

export const INITIAL_SUPERVISION: SupervisionSnapshot = {
  state: "stopped",
  restartCount: 0,
  restartWindowStartedAt: null,
  backoffUntil: null,
  healthySince: null,
  lastDiagnosis: null,
  lastDiagnosisAt: null,
  sleepingSince: null,
};

/** What the supervisor observed. A signal is a FACT about the process, never a
 *  request for an outcome: the transition below decides the outcome. */
export type SupervisionSignal =
  | { kind: "start_requested" }
  | { kind: "ready" }
  | { kind: "readiness_failed"; diagnosis: string }
  | { kind: "child_exited"; diagnosis: string }
  | { kind: "stop_requested" }
  | { kind: "stopped"; groupTornDown: boolean; diagnosis?: string }
  | { kind: "slept" }
  | { kind: "woke" }
  | { kind: "revalidation_failed"; diagnosis: string };

/** The reason vocabulary `supervision_events.reason` stores, so the row the UI
 *  switches on and the transition that produced it cannot drift. */
export type SupervisionReason =
  | "started"
  | "ready"
  | "readiness_failed"
  | "child_exited"
  | "restarted"
  | "retry_budget_exhausted"
  | "healthy_reset"
  | "stop_requested"
  | "stop_incomplete"
  | "slept"
  | "woke"
  | "revalidation_failed";

/** What the caller should DO next, distinct from what the state IS: a
 *  `backoff` state with `wait_backoff` is a supervisor holding still, and the
 *  same state read a minute later answers `restart`. */
export type SupervisionAction =
  | "none"
  | "restart"
  | "wait_backoff"
  | "require_recovery"
  | "revalidate";

export type SupervisionTransition = {
  next: SupervisionSnapshot;
  /** The row to append, or null when nothing observable changed. */
  event: { state: SupervisedState; reason: SupervisionReason; diagnosis: string | null } | null;
  action: SupervisionAction;
};

/**
 * A one-line, bounded, URL-free diagnosis.
 *
 * A supervised child's stdout tail is the most useful thing an owner can be
 * shown about a failed start and the most dangerous thing to store verbatim:
 * `DATABASE_URL`, a CDP endpoint and a provider response all appear in it. So
 * the tail is reduced to its LAST non-empty line, any URL or `postgres://`
 * authority is replaced, and the result is capped — the one place a process's
 * own output reaches a database column.
 */
export const MAX_DIAGNOSIS_LENGTH = 240;

export function redactDiagnosis(raw: string): string | null {
  const lastLine = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (lastLine === undefined) return null;
  const redacted = lastLine
    // Any scheme with an authority, including the `postgres://user:pw@host`
    // shape a failed migration prints, and the `ws://…/devtools` a browser
    // attachment failure prints.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted URL]")
    // A bare `user:password@host` with no scheme in front of it.
    .replace(/\b\S+:\S+@\S+/g, "[redacted credential]");
  return redacted.length > MAX_DIAGNOSIS_LENGTH
    ? `${redacted.slice(0, MAX_DIAGNOSIS_LENGTH - 1)}…`
    : redacted;
}

/** Attempts since the last earned healthy reset. Wall-clock age alone never
 * replenishes this budget; both the policy and the status projection read it. */
export function restartBudget(
  snapshot: Pick<SupervisionSnapshot, "restartCount" | "restartWindowStartedAt">,
  _now: number,
): { used: number; remaining: number; windowStartedAt: number | null } {
  return {
    used: snapshot.restartCount,
    remaining: Math.max(0, MAX_RESTARTS_PER_WINDOW - snapshot.restartCount),
    windowStartedAt: snapshot.restartWindowStartedAt,
  };
}

function backoffFor(attempt: number): number {
  return BACKOFF_BASE_MS * 3 ** Math.max(0, attempt - 1);
}

/** The failure arms — readiness timeout, child death, failed wake revalidation
 *  — all spend the same budget, because from the owner's side they are the one
 *  fact "it did not stay up". Only the reason and the diagnosis differ. */
function failure(
  snapshot: SupervisionSnapshot,
  now: number,
  reason: Extract<
    SupervisionReason,
    "readiness_failed" | "child_exited" | "revalidation_failed"
  >,
  rawDiagnosis: string,
): SupervisionTransition {
  const diagnosis = redactDiagnosis(rawDiagnosis);
  // A run that was healthy for long enough earns its budget back BEFORE this
  // failure is counted, so a process that has been up for a day is not one
  // crash away from recovery because of three crashes last month.
  const earnedReset =
    snapshot.healthySince !== null && now - snapshot.healthySince >= STABLE_HEALTHY_MS;
  const budget = restartBudget(
    earnedReset ? { restartCount: 0, restartWindowStartedAt: null } : snapshot,
    now,
  );
  const base = {
    ...snapshot,
    healthySince: null,
    lastDiagnosis: diagnosis,
    lastDiagnosisAt: now,
  };
  if (budget.remaining === 0) {
    return {
      next: { ...base, state: "recovery_required", backoffUntil: null },
      event: { state: "recovery_required", reason: "retry_budget_exhausted", diagnosis },
      action: "require_recovery",
    };
  }
  const attempt = budget.used + 1;
  return {
    next: {
      ...base,
      state: "backoff",
      restartCount: attempt,
      restartWindowStartedAt: budget.windowStartedAt ?? now,
      backoffUntil: now + backoffFor(attempt),
    },
    event: { state: "backoff", reason, diagnosis },
    action: "wait_backoff",
  };
}

/**
 * The transition. `recovery_required` is deliberately absorbing for every
 * signal except an explicit stop or a start the owner asked for: a supervisor
 * that has given up must not be talked back into trying by another crash
 * report from the process it already gave up on.
 */
export function supervisionTransition(
  snapshot: SupervisionSnapshot,
  signal: SupervisionSignal,
  now: number,
): SupervisionTransition {
  switch (signal.kind) {
    case "start_requested":
      return {
        next: { ...snapshot, state: "starting", backoffUntil: null, healthySince: null, sleepingSince: null },
        event: {
          state: "starting",
          reason: snapshot.state === "backoff" ? "restarted" : "started",
          diagnosis: null,
        },
        action: "none",
      };
    case "ready": {
      // The budget is not cleared here: health has to LAST `STABLE_HEALTHY_MS`
      // to earn a reset, and `healthySince` is the clock that measures it.
      // Clearing on the ready line would give a crash-loop a fresh budget on
      // every loop, which is the exact failure bounded recovery exists to stop.
      const healthySince = snapshot.state === "healthy" ? snapshot.healthySince ?? now : now;
      const matured =
        snapshot.restartCount > 0 && now - healthySince >= STABLE_HEALTHY_MS;
      return {
        next: {
          ...snapshot,
          state: "healthy",
          healthySince,
          backoffUntil: null,
          sleepingSince: null,
          restartCount: matured ? 0 : snapshot.restartCount,
          restartWindowStartedAt: matured ? null : snapshot.restartWindowStartedAt,
        },
        event:
          snapshot.state === "healthy" && !matured
            ? null
            : {
                state: "healthy",
                reason: matured ? "healthy_reset" : "ready",
                diagnosis: null,
              },
        action: "none",
      };
    }
    case "readiness_failed":
      if (snapshot.state === "recovery_required") return { next: snapshot, event: null, action: "require_recovery" };
      return failure(snapshot, now, "readiness_failed", signal.diagnosis);
    case "child_exited":
      if (snapshot.state === "recovery_required") return { next: snapshot, event: null, action: "require_recovery" };
      // An exit the supervisor asked for is the end of a stop, not a crash.
      if (snapshot.state === "stopping" || snapshot.state === "stopped") {
        return {
          next: { ...snapshot, state: "stopped", backoffUntil: null, healthySince: null },
          event: null,
          action: "none",
        };
      }
      return failure(snapshot, now, "child_exited", signal.diagnosis);
    case "revalidation_failed":
      if (snapshot.state === "recovery_required") return { next: snapshot, event: null, action: "require_recovery" };
      return failure(snapshot, now, "revalidation_failed", signal.diagnosis);
    case "stop_requested":
      return {
        next: { ...snapshot, state: "stopping", backoffUntil: null },
        event: { state: "stopping", reason: "stop_requested", diagnosis: null },
        action: "none",
      };
    case "stopped": {
      const diagnosis = signal.diagnosis ? redactDiagnosis(signal.diagnosis) : null;
      // A group that is still alive is NOT stopped, whatever the ladder sent.
      // `recovery_required` is the honest answer: a replacement must never
      // start over a live process group (J6), and only an owner-visible
      // recovery clears it.
      if (!signal.groupTornDown) {
        return {
          next: {
            ...snapshot,
            state: "recovery_required",
            backoffUntil: null,
            healthySince: null,
            lastDiagnosis: diagnosis ?? snapshot.lastDiagnosis,
            lastDiagnosisAt: diagnosis ? now : snapshot.lastDiagnosisAt,
          },
          event: { state: "recovery_required", reason: "stop_incomplete", diagnosis },
          action: "require_recovery",
        };
      }
      return {
        next: {
          ...snapshot,
          state: "stopped",
          backoffUntil: null,
          healthySince: null,
          sleepingSince: null,
        },
        event: { state: "stopped", reason: "stop_requested", diagnosis: null },
        action: "none",
      };
    }
    case "slept":
      // Paused, not stopped: the process is alive and its in-flight work is
      // exactly as uncertain as it was a moment ago. Recording the instant is
      // what lets the wake say how long the gap was.
      if (snapshot.state === "recovery_required") {
        return { next: { ...snapshot, sleepingSince: now }, event: null, action: "require_recovery" };
      }
      return {
        next: { ...snapshot, state: "paused", sleepingSince: now, backoffUntil: null },
        event: { state: "paused", reason: "slept", diagnosis: null },
        action: "none",
      };
    case "woke":
      if (snapshot.state === "recovery_required") {
        return { next: { ...snapshot, sleepingSince: null }, event: null, action: "require_recovery" };
      }
      // Never straight back to healthy: the database, the account identity, the
      // epoch and the resource state are all facts that may have changed while
      // the lid was shut, and `revalidate` is the caller's instruction to check
      // them before anything new is claimed.
      return {
        next: { ...snapshot, state: "starting", sleepingSince: null, healthySince: null },
        event: { state: "starting", reason: "woke", diagnosis: null },
        action: "revalidate",
      };
  }
}

/** Whether the supervisor may attempt a start at `now`. A `backoff` snapshot
 *  whose window has elapsed answers true; a spent budget never does. */
export function mayStart(snapshot: SupervisionSnapshot, now: number): boolean {
  if (snapshot.state === "recovery_required") return false;
  if (snapshot.state === "paused") return false;
  if (snapshot.backoffUntil !== null && now < snapshot.backoffUntil) return false;
  return true;
}

/**
 * WHAT THE PASSAGE OF TIME ALONE HAS MADE TRUE — the answer to a supervisor
 * that has no new fact to report and comes back to ask anyway.
 *
 * It exists because the two halves of bounded recovery are both invisible to an
 * observer of processes. A crash leaves `backoff` and the instant a further
 * attempt is allowed, and NOTHING about the process changes when that instant
 * passes: the component is already reaped, so there is no second death to
 * notice. And a run that has been healthy long enough has earned its budget
 * back without anything happening at all. Without this question the retry
 * ladder and the healthy reset are arithmetic nobody ever reaches.
 *
 * Two properties keep it from becoming a way around the bound:
 *
 * - it never counts an attempt. The attempt was counted when the failure was
 *   recorded, and the restart it authorises arrives as an ordinary
 *   `start_requested`, so a supervisor that asks twice loses nothing and gains
 *   nothing;
 * - it can only ever REMOVE work from the budget's future, never add to it. A
 *   spent budget answers `require_recovery` for as long as it is asked.
 */
export function supervisionTick(
  snapshot: SupervisionSnapshot,
  now: number,
): SupervisionTransition {
  const holdStill = { next: snapshot, event: null } as const;
  switch (snapshot.state) {
    case "recovery_required":
      return { ...holdStill, action: "require_recovery" };
    case "backoff":
      return {
        ...holdStill,
        action: mayStart(snapshot, now) ? "restart" : "wait_backoff",
      };
    case "healthy": {
      // The reset the policy promises: uninterrupted health earns the budget
      // back. Applied here rather than on a second `ready` line, because a
      // process that stays up produces no further readiness to hang it on.
      const earned =
        snapshot.restartCount > 0 &&
        snapshot.healthySince !== null &&
        now - snapshot.healthySince >= STABLE_HEALTHY_MS;
      if (!earned) return { ...holdStill, action: "none" };
      return {
        next: { ...snapshot, restartCount: 0, restartWindowStartedAt: null },
        event: { state: "healthy", reason: "healthy_reset", diagnosis: null },
        action: "none",
      };
    }
    default:
      return { ...holdStill, action: "none" };
  }
}
