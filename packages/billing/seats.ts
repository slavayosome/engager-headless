import { and, eq, isNull, sql } from "drizzle-orm";
import { licenseSeats } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { deviceIdForKey } from "./claims";
import { MAC_SEATS_PER_ACCOUNT } from "./offer";
import { commercialProjection, hasCapability } from "./projection";

/**
 * The one registered Mac a paid account may hold. Cloud includes Mac, so
 * both offers carry the same one seat.
 *
 * A seat is an OPAQUE RANDOM KEY the device mints and keeps; the control plane
 * stores only its sha256. There is no hardware fingerprint here and none is
 * derivable from a row — moving to a new Mac is registering a new key, not
 * proving anything about a machine.
 *
 * Rows are append-only. Revoking sets `revokedAt` and the row remains as its
 * own audit record, so re-presenting a revoked key is a refusal rather than a
 * silent resurrection. Reassignment is therefore always "revoke, then register
 * a fresh key", which is also why an offline Mac whose seat was revoked cannot
 * quietly become a second execution authority: its signed claim runs out at its
 * own bounded expiry and no new one is ever issued for that key.
 */
export const MAX_MAC_SEATS = MAC_SEATS_PER_ACCOUNT;

export type SeatRow = {
  id: string;
  deviceId: string;
  label: string | null;
  assignedAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
};

/** The Mac currently holding the account's seat, as the owner names it. */
export type SeatHolder = {
  label: string | null;
  lastSeenAt: number | null;
};

export type SeatAssignment =
  | { status: "assigned" | "already_assigned"; seat: SeatRow; remaining: number }
  | { status: "seats_exhausted"; seats: SeatRow[]; holder: SeatHolder; remaining: 0 }
  | { status: "key_revoked" }
  | { status: "not_entitled" };

export type SeatMove =
  | {
      status: "moved";
      seat: SeatRow;
      previousHolder: SeatHolder | null;
      previous: SeatHolder | null;
      remaining: 0;
    }
  | { status: "already_assigned"; seat: SeatRow; remaining: number }
  | { status: "key_revoked" }
  | { status: "not_entitled" };

export type SeatRevocation =
  | { status: "revoked" | "already_revoked"; seat: SeatRow }
  | { status: "unknown_seat" };

function toHolder(row: typeof licenseSeats.$inferSelect): SeatHolder {
  return { label: row.label, lastSeenAt: row.lastSeenAt };
}

function toSeatRow(row: typeof licenseSeats.$inferSelect): SeatRow {
  return {
    id: row.id,
    deviceId: row.deviceKeyHash,
    label: row.label,
    assignedAt: row.assignedAt,
    revokedAt: row.revokedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

/** Serialize every seat decision for one organization. `license_seats` is
 * billing-global, so a row lock on another tenant's table is not available and
 * this advisory lock is the mutual exclusion. */
export async function lockSeats(tx: Tx, organizationId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`mac-seats:${organizationId}`}, 0))`,
  );
}

export async function listSeats(
  tx: Tx,
  organizationId: string,
): Promise<SeatRow[]> {
  const rows = await tx
    .select()
    .from(licenseSeats)
    .where(eq(licenseSeats.organizationId, organizationId))
    .orderBy(licenseSeats.assignedAt, licenseSeats.id);
  return rows.map(toSeatRow);
}

/**
 * Register this device against the account, idempotently. Presenting the same
 * key twice returns the same seat and consumes nothing; presenting a revoked
 * key is refused; presenting a new key when the seat is held names the holder
 * so the owner can move the plan here.
 */
export async function assignSeat(
  tx: Tx,
  input: {
    organizationId: string;
    deviceKey: string;
    label?: string | null;
    assignedByUserId?: string | null;
    now: number;
  },
): Promise<SeatAssignment> {
  await lockSeats(tx, input.organizationId);
  const deviceId = deviceIdForKey(input.deviceKey);

  const [existing] = await tx
    .select()
    .from(licenseSeats)
    .where(eq(licenseSeats.deviceKeyHash, deviceId));
  if (existing) {
    // A key registered to a different organization is not this account's seat,
    // and the hash is globally unique, so it can only be refused.
    if (existing.organizationId !== input.organizationId || existing.revokedAt != null) {
      return { status: "key_revoked" };
    }
    await tx
      .update(licenseSeats)
      .set({ lastSeenAt: input.now })
      .where(eq(licenseSeats.id, existing.id));
    const active = await activeSeats(tx, input.organizationId);
    return {
      status: "already_assigned",
      seat: toSeatRow({ ...existing, lastSeenAt: input.now }),
      remaining: MAX_MAC_SEATS - active.length,
    };
  }

  // A seat is a maintained-service registration. Revocation and listing stay
  // available without payment (they are recovery actions); taking a NEW seat
  // needs the Mac capability the account actually bought.
  const projection = await commercialProjection(tx, input.organizationId, {
    now: input.now,
    lock: true,
  });
  if (!hasCapability(projection, "desktop_managed")) {
    return { status: "not_entitled" };
  }

  const active = await activeSeats(tx, input.organizationId);
  if (active.length >= MAX_MAC_SEATS) {
    return {
      status: "seats_exhausted",
      seats: active.map(toSeatRow),
      holder: toHolder(active[0]!),
      remaining: 0,
    };
  }
  const [inserted] = await tx
    .insert(licenseSeats)
    .values({
      organizationId: input.organizationId,
      deviceKeyHash: deviceId,
      label: input.label ?? null,
      assignedAt: input.now,
      assignedByUserId: input.assignedByUserId ?? null,
      lastSeenAt: input.now,
    })
    .returning();
  return {
    status: "assigned",
    seat: toSeatRow(inserted!),
    remaining: MAX_MAC_SEATS - (active.length + 1),
  };
}

/**
 * Move the account's one seat to this Mac, in one transaction under the same
 * advisory lock as every other seat decision. Every other active seat is
 * revoked as `reassigned` and this device takes the seat, so no interleaving
 * — two presses from one Mac, or a press from each of two — can leave two
 * active seats: the loser of a same-key race sees `already_assigned`, and a
 * key displaced by the winner sees `key_revoked` ever after.
 */
export async function moveSeatHere(
  tx: Tx,
  input: {
    organizationId: string;
    deviceKey: string;
    label?: string | null;
    byUserId?: string | null;
    assignedByUserId?: string | null;
    now: number;
  },
): Promise<SeatMove> {
  await lockSeats(tx, input.organizationId);
  const byUserId = input.byUserId ?? input.assignedByUserId ?? null;

  const projection = await commercialProjection(tx, input.organizationId, {
    now: input.now,
    lock: true,
  });
  if (!hasCapability(projection, "desktop_managed")) {
    return { status: "not_entitled" };
  }

  const deviceId = deviceIdForKey(input.deviceKey);
  const [existing] = await tx
    .select()
    .from(licenseSeats)
    .where(eq(licenseSeats.deviceKeyHash, deviceId));
  if (existing) {
    if (existing.organizationId !== input.organizationId || existing.revokedAt != null) {
      return { status: "key_revoked" };
    }
    // A legacy account may still hold a second active seat beside this one.
    // "Move it here" must never leave two active, so displace the others
    // exactly as the moved path below would.
    const others = (await activeSeats(tx, input.organizationId)).filter(
      (seat) => seat.id !== existing.id,
    );
    for (const seat of others) {
      await tx
        .update(licenseSeats)
        .set({
          revokedAt: input.now,
          revokedReason: "reassigned",
          revokedByUserId: byUserId,
        })
        .where(eq(licenseSeats.id, seat.id));
    }
    await tx
      .update(licenseSeats)
      .set({ lastSeenAt: input.now })
      .where(eq(licenseSeats.id, existing.id));
    return {
      status: "already_assigned",
      seat: toSeatRow({ ...existing, lastSeenAt: input.now }),
      remaining: Math.max(0, MAX_MAC_SEATS - 1),
    };
  }

  const active = await activeSeats(tx, input.organizationId);
  const previousHolder = active[0] ? toHolder(active[0]) : null;
  for (const seat of active) {
    await tx
      .update(licenseSeats)
      .set({
        revokedAt: input.now,
        revokedReason: "reassigned",
        revokedByUserId: byUserId,
      })
      .where(eq(licenseSeats.id, seat.id));
  }
  const [inserted] = await tx
    .insert(licenseSeats)
    .values({
      organizationId: input.organizationId,
      deviceKeyHash: deviceId,
      label: input.label ?? null,
      assignedAt: input.now,
      assignedByUserId: byUserId,
      lastSeenAt: input.now,
    })
    .returning();
  return {
    status: "moved",
    seat: toSeatRow(inserted!),
    previousHolder,
    previous: previousHolder,
    remaining: 0,
  };
}

async function activeSeats(
  tx: Tx,
  organizationId: string,
): Promise<(typeof licenseSeats.$inferSelect)[]> {
  return tx
    .select()
    .from(licenseSeats)
    .where(
      and(
        eq(licenseSeats.organizationId, organizationId),
        isNull(licenseSeats.revokedAt),
      ),
    )
    .orderBy(licenseSeats.assignedAt, licenseSeats.id);
}

/**
 * Remove a seat. Idempotent by device id, and available in every commercial
 * state: disconnecting a machine the owner no longer has is a recovery action,
 * not a paid feature.
 */
export async function revokeSeat(
  tx: Tx,
  input: {
    organizationId: string;
    deviceId: string;
    reason: "owner_removed" | "reassigned" | "account_closed";
    revokedByUserId?: string | null;
    now: number;
  },
): Promise<SeatRevocation> {
  await lockSeats(tx, input.organizationId);
  const [row] = await tx
    .select()
    .from(licenseSeats)
    .where(
      and(
        eq(licenseSeats.organizationId, input.organizationId),
        eq(licenseSeats.deviceKeyHash, input.deviceId),
      ),
    );
  if (!row) return { status: "unknown_seat" };
  if (row.revokedAt != null) {
    return { status: "already_revoked", seat: toSeatRow(row) };
  }
  const [revoked] = await tx
    .update(licenseSeats)
    .set({
      revokedAt: input.now,
      revokedReason: input.reason,
      revokedByUserId: input.revokedByUserId ?? null,
    })
    .where(eq(licenseSeats.id, row.id))
    .returning();
  return { status: "revoked", seat: toSeatRow(revoked!) };
}

/** Whether this device may still be issued a claim. A revoked or unknown key
 * gets none — which is how a revocation becomes permanent once the offline
 * Mac's last signed claim reaches its own bounded expiry. */
export async function seatIsAssignable(
  tx: Tx,
  organizationId: string,
  deviceId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ revokedAt: licenseSeats.revokedAt })
    .from(licenseSeats)
    .where(
      and(
        eq(licenseSeats.organizationId, organizationId),
        eq(licenseSeats.deviceKeyHash, deviceId),
      ),
    );
  return row != null && row.revokedAt == null;
}
