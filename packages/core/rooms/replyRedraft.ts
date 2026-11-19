import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, conversationEvents, messages, stepRuns } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { currentGeneration, lockPauses } from "../actions/pause";
import { currentRoomWork } from "../agentStep/roomWork";
import { prepareStepRoomReply, writeStepRoomReply } from "../agentStep/roomWriting";
import { loadStrategy } from "../agentStep/select";
import type { LLM } from "../ai/client";
import { enqueue } from "../jobs/queue";
import { assertNotRecoveryOnly } from "../jobs/recoveryScope";
import type { StepRoomReplyDecision } from "../operations/roomReply";
import { lockEngagementSafety } from "../ratelimit/killswitch";

export type RoomRedraftPayload = { messageId: number; requestId: string; requestVersion: number };
const changed = () => new AppError("room_reply_changed", "This draft changed. Review its current words before redrafting.", 409);
const cleared = { redraftRequestId: null, redraftRequestedAt: null, redraftRequestedBy: null, redraftRequestNote: null };
const matching = (request: RoomRedraftPayload) => and(eq(messages.id, request.messageId),
  eq(messages.redraftRequestId, request.requestId), eq(messages.redraftRequestVersion, request.requestVersion), eq(messages.status, "proposed"));

async function selected(tx: Tx, messageId: number) {
  const [message] = await tx.select().from(messages).where(eq(messages.id, messageId));
  if (!message || message.kind !== "room_reply" || message.status !== "proposed" || message.campaignId === null ||
    message.workerRunId === null || message.roomReplyTarget?.selectedBy !== "worker" || message.lastAttemptAt !== null) throw changed();
  const [checkpoint] = await tx.select().from(stepRuns).where(and(eq(stepRuns.campaignId, message.campaignId),
    sql`${stepRuns.drafts} @> ${JSON.stringify([{ kind: "room_reply", messageId }])}::jsonb`));
  const [event] = checkpoint?.eventId == null ? [] : await tx.select().from(conversationEvents).where(eq(conversationEvents.id, checkpoint.eventId));
  if (!event) throw changed();
  const current = await currentRoomWork(tx, event, message.campaignId, await currentGeneration(tx), Date.now(), { redraftingMessageId: message.id });
  if (current.kind === "held") throw new AppError("room_redraft_held", "This room opportunity changed. Refresh its evidence before asking for new words.", 409);
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, message.campaignId));
  const strategy = campaign ? await loadStrategy(tx, campaign) : null;
  const step = strategy?.document.steps?.find((entry) => entry.step_id === checkpoint!.stepId);
  if (!campaign || !strategy || !step) throw changed();
  const words = await prepareStepRoomReply(tx, { campaign, source: current.opportunity.source,
    step, voice: strategy.document.voice, facts: [] });
  return { message, words };
}

/** The displayed version authorizes one rewrite. Its old words stay visible
 * throughout; neither filing nor completing this request approves a send. */
export async function requestRoomReplyRedraft(tx: Tx, input: StepRoomReplyDecision): Promise<RoomRedraftPayload> {
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  const ready = await selected(tx, input.messageId);
  const [message] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for("update");
  if (!message || message.redraftRequestId !== null || message.redraftRequestVersion !== input.expectedRequestVersion ||
    (message.finalText ?? message.proposedText) !== input.expectedText || message.status !== "proposed") throw changed();
  const request = { messageId: message.id, requestId: randomUUID(), requestVersion: message.redraftRequestVersion + 1 };
  await tx.update(messages).set({ redraftRequestId: request.requestId, redraftRequestVersion: request.requestVersion,
    redraftRequestedAt: Date.now(), redraftRequestedBy: "owner:dashboard", redraftRequestNote: "Rewrite this room reply.",
    error: null, scheduledAt: null }).where(eq(messages.id, ready.message.id));
  await enqueue(tx, { type: "redraft_room_reply", payload: request,
    idempotencyKey: `redraft_room_reply:${request.requestId}`, maxAttempts: 1 });
  return request;
}

/** Cancellation is also recovery for an interrupted job. Its late result
 * cannot match the new version; the previous draft and owner edits remain. */
export async function cancelRoomReplyRedraft(tx: Tx, input: StepRoomReplyDecision) {
  const [message] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for("update");
  if (!message || message.kind !== "room_reply" || message.status !== "proposed" || message.workerRunId === null ||
    message.redraftRequestVersion !== input.expectedRequestVersion || (message.finalText ?? message.proposedText) !== input.expectedText) throw changed();
  if (!message.redraftRequestId) return;
  await tx.update(messages).set({ ...cleared, error: null, redraftRequestVersion: message.redraftRequestVersion + 1 })
    .where(eq(messages.id, message.id));
}

export async function failRoomReplyRedraft(tx: Tx, request: RoomRedraftPayload) {
  await tx.update(messages).set({ ...cleared, error: "The new draft could not be completed. Your previous words are kept. You can try Redraft again." })
    .where(matching(request));
}

export async function redraftRoomReply(ctx: { organizationId: string; llm: LLM; signal?: AbortSignal }, request: RoomRedraftPayload) {
  assertNotRecoveryOnly("draft");
  const read = async (tx: Tx) => {
    const [pending] = await tx.select({ id: messages.id }).from(messages).where(matching(request));
    return pending ? selected(tx, pending.id) : null;
  };
  const prepared = await withOrg(ctx.organizationId, read);
  if (!prepared) return false;
  const text = await writeStepRoomReply(prepared.words, { organizationId: ctx.organizationId, llm: ctx.llm, beforeCall: async () => {
    if (ctx.signal?.aborted) return false;
    const current = await withOrg(ctx.organizationId, read);
    return !!current && current.words.contextRevision === prepared.words.contextRevision;
  } }).catch((error) => {
    // A comment that needs the owner's eyes first keeps the words it has.
    if (error instanceof AppError && error.code === "room_sensitive_hold") return null;
    throw error;
  });
  if (text === null) return false;
  if (ctx.signal?.aborted) return false;
  return withOrg(ctx.organizationId, async (tx) => {
    await lockEngagementSafety(tx);
    await lockPauses(tx);
    const current = await read(tx);
    if (!current || current.words.contextRevision !== prepared.words.contextRevision) return false;
    const updated = await tx.update(messages).set({ ...cleared, proposedText: text, finalText: null, status: "proposed",
      publishOrigin: "worker", assistRetention: 1, ownerOrigin: 0, scheduledAt: null, error: null })
      .where(matching(request)).returning({ id: messages.id });
    return updated.length === 1;
  });
}
