import { eq } from "drizzle-orm";
import { actions, discoveredPosts, messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { queueComment, sendApprovedComment } from "../actions/comment";
import { dispatchAction } from "../execution/actionGate";
import { MockDriver } from "../linkedin/mock";
import { dedupeKey } from "../posting";
import { inOrg, mkOrg } from "./db";
import { openerCampaign } from "./leadScout";

/** Our approved comment on a fresh post of the campaign, slotted a moment ago as approving one leaves it. */
export async function approvedComment(tx: Tx, campaignId: number, over: Partial<typeof messages.$inferInsert> = {}, urn = "urn:li:activity:t1", author = "urn:li:person:x") {
  const [post] = await tx.insert(discoveredPosts).values({ campaignId, postUrn: urn, authorProfileId: author,
    contentText: "Reporting was unusable", postedAt: Date.now() - 3_600_000, status: "new" }).returning();
  return (await tx.insert(messages).values({ kind: "comment", campaignId, discoveredPostId: post!.id, targetProfileId: author,
    proposedText: "The reporting gap is a real cost.", status: "approved", scheduledAt: Date.now() - 1000, dedupeKey: dedupeKey("comment", campaignId, urn), ...over }).returning())[0]!;
}

/** What approving the comment does to the ledger: the owner's own words carry their yes, a worker's comment is an Automatic reservation. */
export const commentQueuedAs = (tx: Tx, messageId: number, origin?: "owner") =>
  origin ? sendApprovedComment(tx, messageId, { yes: { by: "owner:test" } }) : queueComment(tx, messageId);

/** Another approved comment of the campaign, on a post by its own author, put on the ledger as approving it does: its action's id. */
export async function queuedCommentAction(tx: Tx, campaignId: number, urn: string, origin?: "owner") {
  const message = await approvedComment(tx, campaignId, origin ? { publishOrigin: origin } : {}, urn, `urn:li:person:${urn.split(":").at(-1)}`);
  await commentQueuedAs(tx, message.id, origin);
  return (await tx.select().from(actions).where(eq(actions.messageId, message.id)))[0]!.id;
}

/** An approved comment in its own org at the Comment mode asked, put on the ledger as approving it does, with a provider that posts. */
export async function queuedComment(opts: { comment?: "off" | "review" | "auto"; origin?: "owner" } = {}) {
  const orgId = await mkOrg({ minActionGapSec: 0 });
  const { campaignId } = await openerCampaign(orgId, { comment: opts.comment ?? "auto", reply: "auto" });
  const message = await inOrg(orgId, async (tx) => {
    const row = await approvedComment(tx, campaignId, opts.origin ? { publishOrigin: opts.origin } : {});
    await commentQueuedAs(tx, row.id, opts.origin);
    return row;
  });
  const [action] = await inOrg(orgId, (tx) => tx.select().from(actions));
  const driver = new MockDriver();
  return {
    orgId, campaignId, message, action, driver,
    current: () => inOrg(orgId, async (tx) => (await tx.select().from(messages).where(eq(messages.id, message.id)))[0]!),
    send: () => dispatchAction({ organizationId: orgId, driver }, action!.id),
    /** The gate's answer to sending another comment of the campaign. */
    sendAnother: async (urn: string, origin?: "owner") =>
      dispatchAction({ organizationId: orgId, driver }, await inOrg(orgId, (tx) => queuedCommentAction(tx, campaignId, urn, origin))),
  };
}
