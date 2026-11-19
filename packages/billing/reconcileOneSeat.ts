import { and, eq, isNull } from "drizzle-orm";
import { licenseSeats } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { lockSeats } from "./seats";

/**
 * One-time reconciliation for accounts that still hold two active seats from
 * the two-Mac era (O-6). The seat that stays is the one most recently used —
 * latest `lastSeenAt`, ties by latest `assignedAt` — and the others are
 * revoked as `reassigned`, exactly as a move would leave them. Idempotent:
 * an account already down to one active seat is not in the report.
 */
export type OneSeatReconcileEntry = {
  organizationId: string;
  keepSeatId: string;
  revokeSeatIds: string[];
};

export type OneSeatSeat = {
  id: string;
  assignedAt: number;
  lastSeenAt: number | null;
};

/** The seat that stays: latest last use, then latest assignment. */
export function chooseSeatToKeep<T extends OneSeatSeat>(
  seats: readonly T[],
): T | undefined {
  return [...seats].sort((a, b) => {
    const seen =
      (b.lastSeenAt ?? Number.NEGATIVE_INFINITY) -
      (a.lastSeenAt ?? Number.NEGATIVE_INFINITY);
    if (seen !== 0) return seen;
    if (b.assignedAt !== a.assignedAt) return b.assignedAt - a.assignedAt;
    return b.id.localeCompare(a.id);
  })[0];
}

export async function reconcileOneSeat(
  tx: Tx,
  input: { apply: boolean; now: number },
): Promise<OneSeatReconcileEntry[]> {
  // Only the organization list comes from the unlocked snapshot. Each org's
  // seats are re-selected after taking that org's seat lock — in sorted org
  // order, so two reconciles (or a reconcile racing a move) cannot deadlock
  // or decide from a stale snapshot a concurrent move already displaced.
  const orgRows = await tx
    .selectDistinct({ organizationId: licenseSeats.organizationId })
    .from(licenseSeats)
    .where(isNull(licenseSeats.revokedAt))
    .orderBy(licenseSeats.organizationId);
  const organizationIds = orgRows
    .map((row) => row.organizationId)
    .sort((a, b) => a.localeCompare(b));

  const report: OneSeatReconcileEntry[] = [];
  for (const organizationId of organizationIds) {
    await lockSeats(tx, organizationId);
    const seats = await tx
      .select()
      .from(licenseSeats)
      .where(
        and(
          eq(licenseSeats.organizationId, organizationId),
          isNull(licenseSeats.revokedAt),
        ),
      )
      .orderBy(licenseSeats.assignedAt, licenseSeats.id);
    if (seats.length < 2) continue;
    const keep = chooseSeatToKeep(seats)!;
    const revoke = seats.filter((seat) => seat.id !== keep.id);
    report.push({
      organizationId,
      keepSeatId: keep.id,
      revokeSeatIds: revoke.map((seat) => seat.id),
    });
    if (!input.apply) continue;
    for (const seat of revoke) {
      await tx
        .update(licenseSeats)
        .set({
          revokedAt: input.now,
          revokedReason: "reassigned",
          revokedByUserId: null,
        })
        .where(
          and(eq(licenseSeats.id, seat.id), isNull(licenseSeats.revokedAt)),
        );
    }
  }
  return report;
}
