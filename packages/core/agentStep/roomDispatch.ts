import { and, desc, eq, inArray } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, conversationEvents, messages, productFacts, stepRuns, stepToolCalls } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { sendRoomReply } from "../actions/roomReply";
import { assignSlots } from "../operations/schedule";
import { notUnscheduledByOwner } from "../operations/messages";
import { insertRoomReplyRow } from "../operations/roomReply";
import { roomReplyKey } from "../rooms/replySource";
import { recordCall, type DispatchContext, type DispatchOutcome, type ProposeContext } from "./dispatch";
import { currentRoomWork } from "./roomWork";
import { prepareStepRoomReply, writeStepRoomReply } from "./roomWriting";
import { firstUnusableFact } from "./freshness";

async function current(tx: Tx, ctx: Pick<DispatchContext, "record" | "campaignId" | "conversation" | "generationSeen">) {
  const [checkpoint] = await tx.select().from(stepRuns).where(eq(stepRuns.id, ctx.record.checkpoint.id));
  if (!checkpoint || checkpoint.campaignId !== ctx.campaignId || checkpoint.conversationId !== ctx.conversation.id ||
    checkpoint.eventId === null || checkpoint.status !== "running") return null;
  const [event] = await tx.select().from(conversationEvents).where(eq(conversationEvents.id, checkpoint.eventId));
  if (!event || event.conversationId !== ctx.conversation.id || event.type !== "room_member_spotted" ||
    event.sourceRef.room?.stepId !== checkpoint.stepId || ctx.record.call.target.kind !== "room_comment" ||
    event.sourceRef.room.target.parentCommentUrn !== ctx.record.call.target.ref) return null;
  const admitted = await currentRoomWork(tx, event, ctx.campaignId, ctx.generationSeen);
  if (admitted.kind === "held") return null;
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, ctx.campaignId));
  if (!campaign) return null;
  return { ...admitted.opportunity, checkpoint, campaign };
}

async function refuse(tx: Tx, ctx: Pick<DispatchContext, "record">, reason: "guard_moved" | "reservation_refused", ref: string): Promise<DispatchOutcome> {
  await recordCall(tx, ctx.record, { reason, resultRef: ref });
  return { kind: "refused", reason, ref };
}

export async function draftRoomReply(ctx: DispatchContext): Promise<DispatchOutcome> {
  const ref = `room_reply:${ctx.record.call.target.ref}`;
  const prepare = (tx: Tx) => prepareCurrent(tx, ctx);
  const prepared = await withOrg(ctx.organizationId, prepare);
  if (!prepared) return withOrg(ctx.organizationId, (tx) => refuse(tx, ctx, "guard_moved", ref));
  if (prepared.existing) return withOrg(ctx.organizationId, async (tx) => {
    const checked = await current(tx, ctx);
    if (!checked) return refuse(tx, ctx, "guard_moved", ref);
    const resultRef = `message:${prepared.existing!.id}`;
    await recordCall(tx, ctx.record, { reason: null, resultRef });
    return { kind: "dispatched", detail: `This exact room reply is already drafted (${resultRef}).`, resultRef, drafted: false };
  });
  let text: string;
  try {
    text = await writeStepRoomReply(prepared.words, { organizationId: ctx.organizationId, llm: ctx.llm, beforeCall: async () => {
      if (!ctx.continueRun || !await ctx.continueRun()) return false;
      const fresh = await withOrg(ctx.organizationId, prepare);
      return !!fresh && !fresh.existing && fresh.words.contextRevision === prepared.words.contextRevision;
    } });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return withOrg(ctx.organizationId, (tx) => refuse(tx, ctx,
      error.code === "room_work_changed" ? "guard_moved" : "reservation_refused", `refused:${error.code}`));
  }
  if (!ctx.continueRun || !await ctx.continueRun()) {
    return withOrg(ctx.organizationId, (tx) => refuse(tx, ctx, "guard_moved", ref));
  }
  return withOrg(ctx.organizationId, async (tx) => {
    const fresh = await prepare(tx);
    if (!fresh || fresh.words.contextRevision !== prepared.words.contextRevision) return refuse(tx, ctx, "guard_moved", ref);
    const { message, created } = await insertRoomReplyRow(tx, { source: fresh.source, text,
      publishOrigin: "worker", assistRetention: 1, ownerOrigin: 0, workerRunId: ctx.record.runId });
    if (!fresh.checkpoint.drafts.some((draft) => draft.kind === "room_reply" && draft.messageId === message.id)) {
      await tx.update(stepRuns).set({ drafts: [...fresh.checkpoint.drafts,
        { kind: "room_reply", messageId: message.id, target: fresh.source.parentCommentUrn }], updatedAt: Date.now() })
        .where(eq(stepRuns.id, fresh.checkpoint.id));
    }
    const resultRef = `message:${message.id}`;
    await recordCall(tx, ctx.record, { reason: null, resultRef });
    return { kind: "dispatched", detail: `Drafted a public reply to the selected comment (${resultRef}); nothing was sent.`, resultRef, drafted: created };
  });
}

async function prepareCurrent(tx: Tx, ctx: DispatchContext) {
  const ready = await current(tx, ctx);
  if (!ready || ready.strategyVersion !== ctx.strategyVersion || ready.stepId !== ctx.step.step_id) return null;
  const facts = ctx.record.call.inputs.filter((input) => input.name === "facts" && input.source === "context")
    .flatMap((input) => input.ids.map(Number));
  // The dispatcher's fact guard has checked these IDs; reread them under the
  // same transaction as the source snapshot before each model invocation.
  const rows = facts.length ? await tx.select().from(productFacts).where(inArray(productFacts.id, facts)) : [];
  if (firstUnusableFact(facts, new Map(rows.map((fact) => [fact.id, fact])), Date.now()) !== null) return null;
  const [existing] = await tx.select().from(messages).where(eq(messages.dedupeKey, roomReplyKey(ready.source)));
  const words = await prepareStepRoomReply(tx, { source: ready.source, campaign: ready.campaign,
    step: ctx.step, voice: ctx.voice, facts: rows });
  return { ...ready, existing: existing ?? null, words };
}

export async function proposeRoomReply(ctx: ProposeContext): Promise<DispatchOutcome> {
  return withOrg(ctx.organizationId, async (tx) => {
    const ready = await current(tx, ctx);
    const draftCall = ctx.record.call.inputs.find((input) => input.name === "draft")?.ref;
    const [call] = !draftCall ? [] : await tx.select().from(stepToolCalls).where(and(
      eq(stepToolCalls.stepRunId, ctx.record.checkpoint.id), eq(stepToolCalls.callId, draftCall),
      eq(stepToolCalls.tool, "draft_comment"), eq(stepToolCalls.outcome, "dispatched")))
      .orderBy(desc(stepToolCalls.id)).limit(1);
    const draft = ready?.checkpoint.drafts.find((entry) => entry.kind === "room_reply" &&
      `message:${entry.messageId}` === call?.resultRef && entry.target === ctx.record.call.target.ref);
    const [message] = draft?.kind === "room_reply" ? await tx.select().from(messages).where(eq(messages.id, draft.messageId)) : [];
    if (!ready || !message || message.dedupeKey !== roomReplyKey(ready.source)) {
      return refuse(tx, ctx, "guard_moved", `room_reply:${ctx.record.call.target.ref}`);
    }
    const automatic = ctx.mode === "auto" && ready.mode === "auto" &&
      message.status === "proposed" && message.publishOrigin === "worker";
    // Paced by the day plan: with no slot free, the proposal waits for the owner.
    const [slot] = automatic ? await assignSlots(tx, { campaign: ready.campaign, origin: "worker", items: [{ messageId: message.id, kind: "room_reply" }] }) : [];
    const approved = slot ? await tx.update(messages).set({ status: "approved" })
      .where(and(eq(messages.id, message.id), eq(messages.status, "proposed"), notUnscheduledByOwner()))
      .returning() : [];
    // Nobody said yes to it: an Automatic reservation the gate holds to the mode.
    if (approved[0]) await sendRoomReply(tx, { message: approved[0], campaign: ready!.campaign, yes: null });
    const resultRef = `message:${message.id}`;
    await recordCall(tx, ctx.record, { reason: null, resultRef });
    return { kind: "dispatched", resultRef, drafted: false,
      detail: approved.length ? `Queued under the current Automatic authority (${resultRef}).` : `Waiting for the owner's approval (${resultRef}).` };
  });
}
