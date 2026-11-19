import { managedAccess, managedAppArmed } from "../entitlements/entitlementClient";
import { commercialProjection } from "../entitlements/projection";
import type { Tx } from "@engager/database/tenant";
import { restartBudget, type SupervisedState } from "./lifecycle";
import { lastVerifiedBackup, listMaintenanceReceipts } from "./maintenance";
import { listMissedRuns } from "./missedRuns";
import { listSupervisionEvents, readSupervision, type Supervisor } from "./record";

/**
 * THE ONE SUPERVISION STATUS — the typed payload every surface consumes: the
 * dashboard's cards, `engager status --json`, and the Mac app over the
 * authenticated bridge.
 *
 * Two boundaries this shape exists to hold.
 *
 * **Swift decides nothing (INV-20).** Every string the app displays is decided
 * here, from rows this process read. In particular the commercial arm comes
 * from the canonical projection (`billing/projection.ts`) — and, for the one
 * question a Mac's own database cannot answer, from this Mac's signed claim
 * (`macService` below) — so the app never parses `~/.engager/license.json` for
 * authority; that file stays what `LicenseDisplay` says it is, a display-only
 * convenience whose forgery buys nothing.
 *
 * **The free path is never a commercial answer.** `freeCore` is invariantly
 * `available` and `recoveryActions` is never empty, in every arm, because
 * reading, exporting, stopping, disconnecting and reconciling are not services
 * anyone buys (TIER-01/03). A lapse changes `supervisor`; it changes nothing
 * below it.
 */
export const SUPERVISION_STATUS_VERSION = 1;

export type SupervisionStatus = {
  version: typeof SUPERVISION_STATUS_VERSION;
  organizationId: string;
  supervisor: Supervisor;
  /** True when a live supervisor holds the lease at `now`. */
  held: boolean;
  state: SupervisedState;
  restarts: { used: number; remaining: number; windowStartedAt: number | null };
  backoffUntil: number | null;
  sleepingSince: number | null;
  /** Already redacted at the point it was written (`redactDiagnosis`). */
  lastDiagnosis: string | null;
  lastDiagnosisAt: number | null;
  commercial: {
    state: string;
    paidThrough: number | null;
    /** Whether this install holds the maintained-Mac service. Inside the
     *  maintained app that is this Mac's signed `desktop_managed` claim — the
     *  verdict background work is held on (`backgroundEntitlement`) — because
     *  the subscription lives in the cloud and the local projection is empty
     *  there. Everywhere else it is the projection, which is where a hosted
     *  tenant's subscription row is. */
    macService: boolean;
  };
  history: {
    at: number;
    component: string;
    state: SupervisedState;
    reason: string;
    diagnosis: string | null;
  }[];
  missedRuns: {
    /** The record's own id — what the owner's dismiss names. */
    id: number;
    workerId: number;
    missedFrom: number;
    /** When the runtime was back to notice the gap — the end of it. */
    observedAt: number;
    missedCount: number;
    cause: string;
    coalescedRunAt: number | null;
  }[];
  maintenance: {
    lastVerifiedBackup: { name: string; at: number; sha256: string | null } | null;
    receipts: {
      kind: string;
      outcome: string;
      name: string;
      version: string | null;
      signature: string | null;
      at: number;
      detail: string | null;
    }[];
  };
  /** Invariant. Present in every arm, including a lapsed or crashed one. */
  freeCore: "available";
  recoveryActions: readonly ("read" | "export" | "stop" | "disconnect" | "reconcile")[];
};

const RECOVERY_ACTIONS = [
  "read",
  "export",
  "stop",
  "disconnect",
  "reconcile",
] as const;

export async function supervisionStatus(
  tx: Tx,
  organizationId: string,
  now: number = Date.now(),
): Promise<SupervisionStatus> {
  const record = await readSupervision(tx, organizationId);
  const projection = await commercialProjection(tx, organizationId, { now });
  // Sequential, not `Promise.all`: `tx` is ONE pooled client, and issuing a
  // second query on it while the first is in flight is deprecated in `pg` and
  // relies on its internal queue. Four small indexed reads cost less than the
  // hazard.
  const events = await listSupervisionEvents(tx, organizationId, 20);
  const missed = await listMissedRuns(tx, organizationId, { now, limit: 20 });
  const receipts = await listMaintenanceReceipts(tx, organizationId, 10);
  const backup = await lastVerifiedBackup(tx, organizationId);
  return {
    version: SUPERVISION_STATUS_VERSION,
    organizationId,
    supervisor: record.supervisor,
    held:
      record.holderId !== null &&
      record.holderLeaseUntil !== null &&
      record.holderLeaseUntil > now,
    state: record.state,
    restarts: restartBudget(record, now),
    backoffUntil: record.backoffUntil,
    sleepingSince: record.sleepingSince,
    lastDiagnosis: record.lastDiagnosis,
    lastDiagnosisAt: record.lastDiagnosisAt,
    commercial: {
      state: projection.state,
      paidThrough: projection.paidThrough,
      // The same switch `backgroundEntitlement` makes. `projection.state` is
      // `no_account` on every Mac, so reading the projection alone told a
      // supervised Mac with a live trial that its plan had lapsed.
      macService: managedAppArmed()
        ? managedAccess({ now: new Date(now) }).allowed
        : projection.capabilities.includes("desktop_managed"),
    },
    history: events.map((event) => ({
      at: event.at,
      component: event.component,
      state: event.state,
      reason: event.reason,
      diagnosis: event.diagnosis,
    })),
    missedRuns: missed.map((row) => ({
      id: row.id,
      workerId: row.workerId,
      missedFrom: row.missedFrom,
      observedAt: row.observedAt,
      missedCount: row.missedCount,
      cause: row.cause,
      coalescedRunAt: row.coalescedRunAt,
    })),
    maintenance: {
      lastVerifiedBackup: backup
        ? { name: backup.name, at: backup.at, sha256: backup.sha256 }
        : null,
      receipts: receipts.map((row) => ({
        kind: row.kind,
        outcome: row.outcome,
        name: row.name,
        version: row.version,
        signature: row.signature,
        at: row.at,
        detail: row.detail,
      })),
    },
    freeCore: "available",
    recoveryActions: RECOVERY_ACTIONS,
  };
}
