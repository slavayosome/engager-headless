import { and, eq, inArray } from "drizzle-orm";
import { campaigns, channels, messages } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { decryptSecret } from "@engager/common/crypto";
import { isGrant } from "../../connector/resolve";
import type { PostInput } from "../../linkedin/driver";
import { grantFor } from "../context";
import { RescheduleError } from "../queue";
import type { SelfScopedCtx } from "../worker";

type Resolution = { messageId: number; requestVersion: number; sealedResolution: string };

/** The browser holder reconciles and settles the sidecar's old attempt; it never presses. */
export async function handleReconcileMessageWrite(ctx: SelfScopedCtx, payload: Resolution): Promise<void> {
  const frozen = JSON.parse(decryptSecret(payload.sealedResolution)) as {
    organizationId: string; messageId: number; requestVersion: number; input: PostInput; postedUrn?: string;
  };
  if (frozen.organizationId !== ctx.organizationId || frozen.messageId !== payload.messageId || frozen.requestVersion !== payload.requestVersion)
    throw new Error("The frozen write resolution does not belong to this job.");
  const grant = await withOrg(ctx.organizationId, (tx) => grantFor(ctx, tx,
    frozen.input.kind === "comment" ? ["session", "comment"] : frozen.input.kind === "room_reply" ? ["session", "room_reply"] : ["session", "reply"]));
  if (!isGrant(grant)) throw new RescheduleError(grant.detail ?? "connector unavailable", Date.now() + 60_000);
  const session = await grant.use.ensureSession();
  if (!session.ok) throw new RescheduleError("account unavailable", Date.now() + 60_000);
  const [channel] = await withOrg(ctx.organizationId, (tx) => tx.select({ account: channels.executionAccountId, externalAccount: channels.externalAccountId })
    .from(messages).innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId)).where(eq(messages.id, payload.messageId)));
  const account = channel?.account ?? channel?.externalAccount;
  if (!account || account !== session.account?.externalAccountId)
    throw new RescheduleError("account mismatch", Date.now() + 60_000);
  const resolve = grant.use.resolveUncertainWriteOutcome;
  if (!resolve) {
    // Connectors with no sidecar journal have nothing local to settle.
    if (grant.connector === "local_browser") throw new RescheduleError("write journal unavailable", Date.now() + 60_000);
    return;
  }
  let result;
  try {
    result = await resolve.call(grant.use, frozen.input, payload.requestVersion, frozen.postedUrn);
  } catch (error) {
    throw new RescheduleError(error instanceof Error ? error.message : "write resolution unavailable", Date.now() + 5 * 60_000);
  }
  if (result.operationId !== frozen.input.marker || result.resolutionVersion !== payload.requestVersion)
    throw new Error("The connector returned a different write resolution.");
  if (frozen.postedUrn) {
    if (result.state !== "already_committed" || result.externalUrn !== frozen.postedUrn)
      throw new RescheduleError("the connector has a different receipt", Date.now() + 60_000);
    return;
  }
  if (result.state !== "already_committed") return;
  // The journal holds this write as landed, and the owner said it did not go
  // out. Neither answer replaces the other: the message goes back to the owner
  // to say which it was, and is never settled posted from here.
  await withOrg(ctx.organizationId, async (tx) => {
    const [held] = await tx
      .update(messages)
      .set({
        status: "needs_review",
        scheduledAt: null,
        error: "LinkedIn shows this reply posted, which is not what you marked. Look again and say which it was.",
        redraftRequestVersion: payload.requestVersion + 1,
      })
      .where(and(
        eq(messages.id, payload.messageId),
        eq(messages.redraftRequestVersion, payload.requestVersion),
        inArray(messages.status, ["proposed", "approved"]),
      ))
      .returning({ id: messages.id });
    if (held) return;
    const [message] = await tx.select({ status: messages.status, externalUrn: messages.externalUrn }).from(messages)
      .where(eq(messages.id, payload.messageId));
    if (message?.status === "posted" && message.externalUrn === result.externalUrn) return;
    throw new RescheduleError("write resolution needs owner review", Date.now() + 60_000);
  });
}
