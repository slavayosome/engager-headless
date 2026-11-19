import { and, eq } from "drizzle-orm";
import { liveChecks } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { isGrant } from "../../connector/resolve";
import { LIVE_CHECK_READS, performLiveRead, type LiveCheckReadPayload } from "../../liveChecks/flow";
import { isLiveCheckCapability } from "../../liveChecks/records";
import { grantFor } from "../context";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
} from "../spendAccess";
import type { JobResult, SelfScopedCtx } from "../worker";

/**
 * Worker handler for `live_check_read`: the read half of an owner's live check
 * (`liveChecks/flow.ts`), queued by their press and never by a wake. One read
 * op on the account through the capability its check leans on — the person's
 * profile, the invitations page, the conversation — and what it saw kept on
 * the check for the owner to compare. An account Engager cannot reach ends
 * the check with that reason rather than waiting behind the owner's back.
 *
 * SELF_SCOPED: the read is a page load in no transaction, between short ones.
 */
export async function handleLiveCheckRead(
  ctx: SelfScopedCtx,
  payload: LiveCheckReadPayload,
): Promise<JobResult> {
  const org = ctx.organizationId;
  const granted = await withOrg(org, async (tx) => {
    const [attempt] = await tx
      .select({ capability: liveChecks.capability })
      .from(liveChecks)
      .where(and(eq(liveChecks.id, payload.liveCheckId), eq(liveChecks.state, "reading")));
    if (!attempt || !isLiveCheckCapability(attempt.capability)) return null;
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return grantFor(ctx, tx, LIVE_CHECK_READS[attempt.capability].kind);
  });
  if (granted === null) return { gone: 1 };
  if (!isGrant(granted)) {
    await withOrg(org, (tx) =>
      tx
        .update(liveChecks)
        .set({ state: "closed", closedReason: `read_refused:${granted.code}`, updatedAt: Date.now() })
        .where(and(eq(liveChecks.id, payload.liveCheckId), eq(liveChecks.state, "reading"))),
    );
    return { refusal: granted };
  }
  try {
    await assertHostedJobSpendStillAllowed(ctx);
    const outcome = await performLiveRead({
      organizationId: org,
      liveCheckId: payload.liveCheckId,
      surface: granted.use,
    });
    return { [outcome]: 1 };
  } catch (error) {
    // The job runs once: whatever stopped it ends the check, so the owner
    // sees why rather than a read that never lands.
    await withOrg(org, (tx) =>
      tx
        .update(liveChecks)
        .set({ state: "closed", closedReason: "read_failed:interrupted", updatedAt: Date.now() })
        .where(and(eq(liveChecks.id, payload.liveCheckId), eq(liveChecks.state, "reading"))),
    );
    throw error;
  }
}
