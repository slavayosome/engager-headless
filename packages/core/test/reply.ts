import { eq, sql } from "drizzle-orm";
import { actions, incomingComments, messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { queueAutomaticReply, sendApprovedReply } from "../actions/reply";
import { dispatchAction } from "../execution/actionGate";
import { MockDriver } from "../linkedin/mock";
import { inOrg, mkOrg } from "./db";
import { queuedComment } from "./comment";
import { openerCampaign } from "./leadScout";
import { queuedRoom } from "./roomReply";

/** Our approved reply to `name`, slotted, under a root comment of ours that the campaign posted. */
export async function threadReply(tx: Tx, campaignId: number, name: string, origin?: "owner", status: "approved" | "posted" = "approved") {
  const [root] = await tx.select().from(messages).where(eq(messages.dedupeKey, "root"));
  const parent = root ?? (await tx.insert(messages).values({ kind: "comment", campaignId, proposedText: "Our comment", status: "posted", externalUrn: "urn:li:comment:root", postedAt: Date.now(), dedupeKey: "root" }).returning())[0]!;
  const [incoming] = await tx.insert(incomingComments).values({ campaignId, parentMessageId: parent.id, ownPostUrn: "urn:li:activity:root", commentUrn: `urn:li:comment:${name}`,
    authorProfileId: name, authorName: name, text: "Their reply", source: "our_comment_thread", threadParentUrn: "urn:li:comment:root", status: "new" }).returning();
  return (await tx.insert(messages).values({ kind: "reply", campaignId, incomingCommentId: incoming!.id, targetProfileId: name, proposedText: "Our answer",
    ...(origin ? { publishOrigin: origin } : {}), status, scheduledAt: Date.now() - 1000, dedupeKey: `reply-${name}` }).returning())[0]!;
}

/** What approving the reply does to the ledger: the owner's own words carry their yes, a worker's reply is an Automatic reservation. */
export const queuedAs = (tx: Tx, messageId: number, origin?: "owner") =>
  origin ? sendApprovedReply(tx, messageId, { yes: { by: "owner:test" } }) : queueAutomaticReply(tx, messageId);

/** An approved reply in its own org at the Reply mode asked, put on the ledger as approving it does, with a provider that posts. */
export async function queuedReply(opts: { reply?: "off" | "review" | "auto"; origin?: "owner"; full?: boolean } = {}) {
  const orgId = await mkOrg({ minActionGapSec: 0 });
  const { campaignId } = await openerCampaign(orgId, { comment: "auto", reply: opts.reply ?? "auto" });
  const message = await inOrg(orgId, async (tx) => {
    // Our replies already in the thread up to its depth cap.
    if (opts.full) for (const name of ["first", "second"]) await threadReply(tx, campaignId, name, undefined, "posted");
    return threadReply(tx, campaignId, "person", opts.origin);
  });
  await inOrg(orgId, (tx) => queuedAs(tx, message.id, opts.origin));
  const [action] = await inOrg(orgId, (tx) => tx.select().from(actions));
  const driver = new MockDriver();
  return {
    orgId, campaignId, message, action, driver,
    current: () => inOrg(orgId, async (tx) => (await tx.select().from(messages).where(eq(messages.id, message.id)))[0]!),
    send: () => dispatchAction({ organizationId: orgId, driver }, action!.id),
  };
}

/** Put a queued send back as an older version had it: no actions on the ledger, the message as `set` says. */
export async function rewindToLegacy(tx: Tx, messageId: number, set: Partial<typeof messages.$inferInsert>) {
  await tx.execute(sql`delete from action_approvals`);
  await tx.execute(sql`delete from actions`);
  await tx.update(messages).set(set).where(eq(messages.id, messageId));
}

/** What an update does to what an older version left: converts its sends of this kind onto the ledger. */
export const convertLegacy = (tx: Tx, kind: "comment" | "reply" | "room_reply", orgId: string) =>
  tx.execute(sql`select ${sql.raw({ comment: "convert_comments", reply: "convert_replies", room_reply: "convert_room_replies" }[kind])}(${orgId}::uuid)`);

/** A queued comment, reply or room reply as an older version left it in `status`, converted as an update does. */
export async function legacySend(kind: "comment" | "reply" | "room_reply", status: "posting" | "approved") {
  const f = kind === "reply" ? await queuedReply({ origin: "owner" }) : kind === "comment" ? await queuedComment({ origin: "owner" }) : await queuedRoom();
  await inOrg(f.orgId, async (tx) => {
    await rewindToLegacy(tx, f.message.id, { status, ...(status === "posting" ? { postingStartedAt: Date.now() } : {}) });
    await convertLegacy(tx, kind, f.orgId);
  });
  const [converted] = await inOrg(f.orgId, (tx) => tx.select().from(actions));
  return { orgId: f.orgId, converted: converted!, fence: `post:${f.message.id}:0`, send: () => dispatchAction({ organizationId: f.orgId, driver: f.driver }, converted!.id),
    writes: () => ("roomWrites" in f.driver ? f.driver.roomWrites : f.driver.posted).length };
}
