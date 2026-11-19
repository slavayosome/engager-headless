import { desc, eq } from "drizzle-orm";
import { subscriptions } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { Capability } from "./capabilities";
import {
  MAC_SEATS_PER_ACCOUNT,
  isOfferId,
  offerCapabilities,
  type OfferId,
  type OfferProvenance,
} from "./offer";

/**
 * ONE commercial projection (ADR-05). Every reader — the cloud's licence
 * issuer, the tenant provisioner, local runtime admission, the dashboard and
 * the CLI — asks this module what an organization bought and until when. No
 * caller re-derives payment policy from a provider status string, a price id,
 * a trial timestamp or a Checkout return URL.
 *
 * Three properties this module exists to hold:
 *
 * - **Only catalogued offers grant.** Authority comes from the frozen
 *   `offerTerms` provenance a projection wrote, never from `status` alone. A
 *   historical Pro row, a comp `licenseTrialEndsAt`, a legacy price alias and a
 *   pre-checkout grant are all readable and all grant nothing (TIER-11). A
 *   trial is the same rule, not an exception: the webhook projection moves
 *   the boundary to `trial_end` only for a catalogued offer with a card on
 *   file, so a cardless or uncatalogued `trialing` row reaches this module
 *   exactly like the historical shapes — readable, granting nothing.
 * - **Time is re-evaluated on every call.** `paidThrough` is the boundary;
 *   `past_due` never moves it, revocation ends service earlier, and a known
 *   expiry always beats an optimistic cache.
 * - **Generations are monotonic.** A replayed or reordered provider event
 *   projects onto its own generation's row; the canonical answer is always the
 *   newest generation, so a stale positive event cannot revive a canceled one.
 */
export type CommercialState =
  | "no_account"
  | "active"
  | "trialing"
  | "cancel_at_period_end"
  | "past_due"
  | "paused"
  | "expired"
  | "refunded"
  | "cancellation_pending";

export type CommercialReason =
  | "available"
  | "no_offer"
  | "offer_not_recognized"
  | "payment_not_settled"
  | "payment_failed"
  | "period_ended"
  | "revoked"
  | "cancellation_pending";

/** How long a failed charge keeps service running before it pauses
 * (US-ONA-04). One named constant, evaluated on the same server clock that
 * recorded `paymentFailedAt`: at `t + PAYMENT_GRACE_MS - 1` the failing
 * subscription still grants, at `t + PAYMENT_GRACE_MS` it is paused. */
export const PAYMENT_GRACE_MS = 24 * 60 * 60 * 1000;

export type CommercialProjection = {
  organizationId: string;
  subscriptionId: string | null;
  offerId: OfferId | null;
  terms: OfferProvenance | null;
  /** Monotonic per organization. Zero means no paid generation ever existed. */
  generation: number;
  state: CommercialState;
  reason: CommercialReason;
  /** Every service currently bought. `core_local` is never listed here: free
   * core is not a commercial grant and needs no projection. */
  capabilities: readonly Exclude<Capability, "core_local">[];
  /** The instant paid service ends. Null when nothing was ever paid for. */
  paidThrough: number | null;
  /**
   * The instant the CURRENT paid period began — the identity of the funded
   * window, not of the subscription. A rebuy, a replayed event or an offer
   * replacement inside the same window projects the same value, which is what
   * lets a resource allowance be granted exactly once per paid period (ADR-06).
   * Null whenever nothing is currently granted, or when a historical row never
   * recorded a period start: an unidentifiable window funds nothing.
   */
  paidPeriodStart: number | null;
  revokedAt: number | null;
  /** The server instant the current failure episode was first seen, or null
   * when no charge is currently failing (US-ONA-04). */
  paymentFailedAt: number | null;
  /** `paymentFailedAt + PAYMENT_GRACE_MS` — the instant the grace ends and
   * the still-unpaid subscription pauses. Null outside a failure episode. */
  graceEndsAt: number | null;
  cancelAtPeriodEnd: boolean;
  /** Registered Macs this account may hold. Zero without a Mac capability. */
  macSeats: number;
};

const NO_ACCOUNT = (organizationId: string): CommercialProjection => ({
  organizationId,
  subscriptionId: null,
  offerId: null,
  terms: null,
  generation: 0,
  state: "no_account",
  reason: "no_offer",
  capabilities: [],
  paidThrough: null,
  paidPeriodStart: null,
  revokedAt: null,
  paymentFailedAt: null,
  graceEndsAt: null,
  cancelAtPeriodEnd: false,
  macSeats: 0,
});

/** Provider statuses that may still be inside a live service window.
 * `trialing` belongs here only in the company of the boundary the webhook
 * projection set for it: a card-backed trial's `paidThrough` IS its
 * `trial_end`, and a cardless one never got a boundary, so it is refused
 * above on `payment_not_settled` before this set is consulted. */
const IN_PERIOD_STATUSES = new Set(["active", "past_due", "trialing"]);

type SubscriptionRow = Pick<
  typeof subscriptions.$inferSelect,
  | "id"
  | "status"
  | "active"
  | "offerId"
  | "offerTerms"
  | "commercialGeneration"
  | "paidThrough"
  | "periodStartsAt"
  | "revokedAt"
  | "paymentFailedAt"
  | "cancelAtPeriodEnd"
  | "guardedCancellationToken"
>;

const PROJECTION_COLUMNS = {
  id: subscriptions.id,
  status: subscriptions.status,
  active: subscriptions.active,
  offerId: subscriptions.offerId,
  offerTerms: subscriptions.offerTerms,
  commercialGeneration: subscriptions.commercialGeneration,
  paidThrough: subscriptions.paidThrough,
  periodStartsAt: subscriptions.periodStartsAt,
  revokedAt: subscriptions.revokedAt,
  paymentFailedAt: subscriptions.paymentFailedAt,
  cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  guardedCancellationToken: subscriptions.guardedCancellationToken,
} as const;

/** The newest paid generation for this organization. Ordering is on the
 * generation, not on `active` or `createdAt`: a replayed event for an older
 * subscription must never become the answer, however active it claims to be. */
async function canonicalRow(
  tx: Tx,
  organizationId: string,
  lock: boolean,
): Promise<SubscriptionRow | undefined> {
  // `subscriptions` is global (not RLS-scoped), so the org predicate is explicit.
  const query = tx
    .select(PROJECTION_COLUMNS)
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId))
    .orderBy(desc(subscriptions.commercialGeneration), desc(subscriptions.createdAt))
    .limit(1);
  const [row] = lock ? await query.for("share") : await query;
  return row;
}

export function projectSubscriptionRow(
  organizationId: string,
  row: SubscriptionRow | undefined,
  now: number,
): CommercialProjection {
  if (!row) return NO_ACCOUNT(organizationId);

  const generation = row.commercialGeneration ?? 0;
  const terms = row.offerTerms ?? null;
  const offerId = isOfferId(row.offerId) ? row.offerId : null;
  const paymentFailedAt = row.paymentFailedAt ?? null;
  const graceEndsAt =
    paymentFailedAt == null ? null : paymentFailedAt + PAYMENT_GRACE_MS;
  const base = {
    organizationId,
    subscriptionId: row.id,
    generation,
    paidThrough: row.paidThrough ?? null,
    paidPeriodStart: null,
    revokedAt: row.revokedAt ?? null,
    paymentFailedAt,
    graceEndsAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    macSeats: 0,
    capabilities: [] as readonly Exclude<Capability, "core_local">[],
  };

  // Historical rows — the Pro catalogue, a comp trial, a legacy price alias —
  // carry no frozen offer provenance. They stay readable and grant nothing.
  if (!terms || !offerId || terms.offerId !== offerId) {
    return {
      ...base,
      offerId: null,
      terms: null,
      state: "expired",
      reason: "offer_not_recognized",
      paidThrough: null,
    };
  }

  const granted = {
    ...base,
    offerId,
    terms,
    // The funded window is only named on the granting arm. A denied projection
    // reports no period, so nothing downstream can open an allowance against a
    // subscription that is not currently paying for one. A trial funds no
    // period either, however it grants: its window is named only once the
    // paid conversion lands as `active`.
    paidPeriodStart:
      row.status === "trialing" ? null : (row.periodStartsAt ?? null),
    capabilities: offerCapabilities(offerId),
    macSeats: MAC_SEATS_PER_ACCOUNT,
  };
  const denied = (state: CommercialState, reason: CommercialReason) => ({
    ...base,
    offerId,
    terms,
    state,
    reason,
  });

  // An owner-confirmed cancellation still reconciling with the provider fences
  // every new claim until the canonical projection resolves it. Removing the
  // obsolete grant policy must not remove this fence.
  if (row.guardedCancellationToken != null) {
    return denied("cancellation_pending", "cancellation_pending");
  }
  if (row.revokedAt != null && row.revokedAt <= now) {
    return denied("refunded", "revoked");
  }
  // A recorded failure episode on a still-failing subscription (US-ONA-04).
  // The grace is its own boundary, not an extension of `paidThrough`: a
  // failed renewal or a trial's first charge lands exactly when the old
  // boundary ends, so checking `paidThrough` first would leave a grace of
  // about zero. Inside the grace the Mac keeps running as `past_due`; at
  // the grace end it pauses — no capabilities, `paidThrough` unchanged,
  // nothing deleted — until an invoice settles and the webhook clears the
  // episode. Provider end states never reach this arm: a canceled or
  // unpaid generation is not `past_due` and active here, so it keeps
  // reading `expired` or `refunded` below, never `paused`. A `past_due`
  // row with no recorded failure (every historical row) also falls through
  // to the paid-period rule it has always had.
  if (
    paymentFailedAt != null &&
    graceEndsAt != null &&
    row.status === "past_due" &&
    row.active
  ) {
    if (now < graceEndsAt) {
      // The grace funds no period of its own, like a trial: no allowance
      // window opens against days nobody has paid for yet.
      return {
        ...granted,
        paidPeriodStart: null,
        state: "past_due",
        reason: "available",
      };
    }
    return denied("paused", "payment_failed");
  }
  if (row.paidThrough == null) {
    return denied("expired", "payment_not_settled");
  }
  if (row.paidThrough <= now) {
    return denied("expired", "period_ended");
  }
  if (!IN_PERIOD_STATUSES.has(row.status) || !row.active) {
    // The provider says this generation is over (canceled/unpaid/incomplete)
    // even though the paid period has not elapsed. A known ending always wins.
    return denied("expired", "period_ended");
  }
  return {
    ...granted,
    state: row.cancelAtPeriodEnd
      ? "cancel_at_period_end"
      : row.status === "past_due"
        ? "past_due"
        : row.status === "trialing"
          ? "trialing"
          : "active",
    reason: "available",
  };
}

/** The canonical read. `lock` takes the row's SHARE lock so a mutation that
 * depends on this decision linearizes against a cancellation write, the same
 * discipline `runtimeEntitlement` already applies. */
export async function commercialProjection(
  tx: Tx,
  organizationId: string,
  opts: { now?: number; lock?: boolean } = {},
): Promise<CommercialProjection> {
  const row = await canonicalRow(tx, organizationId, opts.lock === true);
  return projectSubscriptionRow(organizationId, row, opts.now ?? Date.now());
}
