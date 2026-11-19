import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { db as baseDb } from "@engager/database";
import {
  leads,
  emailDeliveryReceipts,
  memberships,
  organizations,
  users,
  type Lead,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import {
  leadNudgeEmail,
  prepareEmailPayload,
  sendPreparedEmail,
} from "@engager/email";
import { config } from "../../config";
import { leadsEnabled } from "../../leads/gate";
import {
  claimedJobEmailContext,
  deliverJobEmail,
  EmailDeliveryOutcomeUncertainError,
  resumeJobEmailIfPresent,
} from "../emailDelivery";
import type { SelfScopedCtx } from "../worker";

/** How long a notified hot lead may sit untouched before the nudge. */
const STALE_AFTER_MS = 2 * 86_400_000;
const STALE_DIGEST_LIMIT = 20;

function leadIdsFromDeliveryKey(deliveryKey: string): number[] | null {
  const match = /^leads:(\d+(?:,\d+)*)$/.exec(deliveryKey);
  if (!match) return null;
  const ids = match[1]!.split(",").map(Number);
  return ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0)
    ? ids
    : null;
}

/**
 * The staleness nudge — the other half of the follow-up engine. A hot lead
 * whose email went out but whose status is still `new` two days later is going
 * cold; one digest email lists them all, once per lead ever (`nudgedAt`).
 *
 * Same discipline as checkBatchRunway: snapshot and template work stay detached.
 * The final receipt/idempotent send uses one tenant transaction so the receipt,
 * owner membership, user address, and `nudgedAt` settlement move together.
 */
export async function handleCheckStaleLeads(
  ctx: SelfScopedCtx,
  _payload: Record<string, never>,
): Promise<void> {
  const emailCtx = claimedJobEmailContext(ctx);
  const cutoff = Date.now() - STALE_AFTER_MS;

  // Phase 1 — recover the oldest unresolved immutable cohort before selecting
  // newly stale leads. This makes a new daily job reuse the original receipt and
  // provider key after an ACK/crash, even if more leads became stale meanwhile.
  const cohort: {
    deliveryKey: string;
    leadIds: number[];
    stale: Lead[];
    existing: boolean;
  } | null = await withOrg(ctx.organizationId, async (tx) => {
    const [open] = await tx
      .select({ deliveryKey: emailDeliveryReceipts.deliveryKey })
      .from(emailDeliveryReceipts)
      .where(
        and(
          eq(emailDeliveryReceipts.kind, "lead_nudge"),
          inArray(emailDeliveryReceipts.state, ["reserved", "sending"]),
        ),
      )
      .orderBy(emailDeliveryReceipts.createdAt)
      .limit(1);
    if (open) {
      const leadIds = leadIdsFromDeliveryKey(open.deliveryKey);
      if (!leadIds) {
        throw new EmailDeliveryOutcomeUncertainError(
          "unresolved lead nudge receipt has an invalid immutable cohort",
        );
      }
      return {
        deliveryKey: open.deliveryKey,
        leadIds,
        stale: [],
        existing: true,
      };
    }

    if (!(await leadsEnabled(tx, ctx.organizationId))) return null;
    const stale = await tx
      .select()
      .from(leads)
      .where(
        and(
          eq(leads.tier, "hot"),
          eq(leads.status, "new"),
          lte(leads.notifiedAt, cutoff),
          isNull(leads.nudgedAt),
        ),
      )
      .orderBy(leads.notifiedAt)
      .limit(STALE_DIGEST_LIMIT);
    if (stale.length === 0) return null;
    const leadIds = stale.map((lead) => lead.id).sort((a, b) => a - b);
    return {
      deliveryKey: `leads:${leadIds.join(",")}`,
      leadIds,
      stale,
      existing: false,
    };
  });
  if (!cohort) return;

  const settleInTx = async (tx: Tx) => {
    const settledAt = Date.now();
    await tx
      .update(leads)
      .set({ nudgedAt: settledAt, updatedAt: settledAt })
      .where(inArray(leads.id, cohort.leadIds));
  };
  const send = (
    payload: Parameters<typeof sendPreparedEmail>[0],
    key: string,
    signal: AbortSignal,
  ) => sendPreparedEmail(payload, { idempotencyKey: key, signal });

  if (cohort.existing) {
    await resumeJobEmailIfPresent(emailCtx, {
      kind: "lead_nudge",
      deliveryKey: cohort.deliveryKey,
      send,
      settleInTx,
    });
    return;
  }
  const stale = cohort.stale;

  // Phase 2 — detached recipient/template lookup. The delivery boundary locks
  // and revalidates the exact membership + user address before provider I/O.
  const [org] = await baseDb
    .select({ name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId));
  const [owner] = await baseDb
    .select({ userId: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, ctx.organizationId),
        eq(memberships.isOwner, true),
      ),
    )
    .limit(1);
  if (!owner?.email) {
    console.warn(
      `[stale_leads] org ${ctx.organizationId}: no owner email, skipping`,
    );
    return;
  }

  const props = {
    leads: stale.map((l) => ({
      name: l.name,
      headline: l.headline,
      evidence: l.evidenceQuote,
      dmDraft: l.dmDraft,
    })),
    url: org?.slug
      ? config.dashboardUrl(
          `/organizations/${encodeURIComponent(org.slug)}/leads`,
        )
      : undefined,
    orgName: org?.name,
  };
  await deliverJobEmail(emailCtx, {
    kind: "lead_nudge",
    deliveryKey: cohort.deliveryKey,
    recipientUserId: owner.userId,
    prepare: () => {
      const rendered = leadNudgeEmail(props);
      return prepareEmailPayload({ to: owner.email, ...rendered });
    },
    send,
    settleInTx,
  });
}
