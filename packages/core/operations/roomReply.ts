import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { isAssisted, isUntouchedOffer, measureBoxAssist, recordOwnerWords, retentionWindow } from "@engager/common/text-provenance";
import { campaigns, feedback, messageDraftRevisions, messages, roomReplyDrafts, stepRuns, type Campaign, type Message, type RoomReplyDraft } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { AuthoredTextSchema, MAX_TEXT_CHARACTERS, MAX_TEXT_UTF8_BYTES, authoredTextCharacterViolation } from "../ai/authoredText";
import { lockPauses } from "../actions/pause";
import { sendRoomReply } from "../actions/roomReply";
import { scopedStop } from "../actions/stops";
import { getSystemState, lockEngagementSafety } from "../ratelimit/killswitch";
import { ROOM_RETENTION_MS } from "../rooms/eligibility";
import { captureVoiceSample } from "../learning/voiceSamples";
import { campaignVoiceId } from "../voice";
import { trackMessageDecided } from "../telemetry/emit";
import { readLeadReplySource } from "../leads/replySource";
import { canOwnerReplyAfterSkip, readReplySource, readRoomReplySource, roomReplyDraftKey, roomReplyKey, sameLeadSignal,
  type ReplySource, type RoomReplySelection } from "../rooms/replySource";
import { lockRoomVoice, roomHasComment, roomHasOwnerDraft } from "../rooms/oneVoice";
import { roomAssistTexts } from "../rooms/assistProvenance";
import { boxKey, composerOffered, higherRetention, measureComposer } from "../composer/drafts";
import { assertJudgedWords } from "../dispatcher/landedJudge";
import { assignSlots } from "./schedule";
import { applyPreparedMessageDecision, prepareMessageDecision, snapshotMessageDecision } from "./messages";

/** The single account-level reservation for an exact parent comment. It
 * creates a proposal only; scheduling, approval and sending stay separate. */
export async function insertRoomReplyRow(
  tx: Tx,
  input: {
    source: ReplySource;
    text: string;
    publishOrigin: Message["publishOrigin"];
    assistRetention: number | null;
    ownerOrigin: number | null;
    workerRunId?: number;
    now?: number;
  },
  options: { replaceProposed?: boolean } = {},
): Promise<{ message: Message; created: boolean }> {
  const { source } = input;
  if (input.workerRunId !== undefined && (source.selectedBy !== "worker" ||
    !Number.isSafeInteger(input.workerRunId) || input.workerRunId <= 0)) {
    throw new AppError("room_reply_invalid_run", "A step reply needs its selected room target and run.", 409);
  }
  const current = await readReplySource(tx, source, { now: input.now });
  if (current.organizationId !== source.organizationId || current.campaignId !== source.campaignId ||
    current.channelId !== source.channelId || current.memberUrn !== source.memberUrn ||
    current.profileId !== source.profileId || current.personKey !== source.personKey ||
    (current.source === "lead" || source.source === "lead" ? !sameLeadSignal(current, source)
      : current.discoveredPostId !== source.discoveredPostId || current.snapshotId !== source.snapshotId ||
        current.audienceRevision !== source.audienceRevision) ||
    current.evidenceReadAt !== source.evidenceReadAt || current.postUrn !== source.postUrn ||
    roomReplyKey(current) !== roomReplyKey(source)) {
    throw new AppError("room_reply_target_changed", "Review the recipient and exact comment again before sending.", 409);
  }
  const parsed = AuthoredTextSchema.safeParse(input.text);
  if (!parsed.success) throw new AppError("room_reply_text_invalid", "Write a reply before sending it.", 400);
  await lockRoomVoice(tx, source);
  const dedupeKey = roomReplyKey(source);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('room_reply:' || current_setting('app.current_org')), hashtext(${dedupeKey}))`);
  const [existing] = await tx.select().from(messages).where(eq(messages.dedupeKey, dedupeKey)).for("update");
  const ownerAfterSkip = !!existing && options.replaceProposed === true && input.workerRunId === undefined &&
    source.selectedBy === "owner" && canOwnerReplyAfterSkip(existing);
  if (existing) {
    if (existing.campaignId !== source.campaignId || existing.kind !== "room_reply") {
      throw new AppError("room_reply_already_reserved", "Another campaign already has this reply. Open that conversation to review it.", 409);
    }
    if (existing.roomReplyTarget?.memberUrn !== source.memberUrn || existing.targetProfileId !== source.profileId) {
      throw new AppError("room_reply_target_changed", "Review the recipient and exact comment again before sending.", 409);
    }
    if (!options.replaceProposed || (existing.status !== "proposed" && !ownerAfterSkip)) return { message: existing, created: false };
    if (input.workerRunId !== undefined) {
      throw new AppError("room_reply_already_reserved", "This reply already has a draft to review.", 409);
    }
  }
  if (input.workerRunId !== undefined && await roomHasComment(tx, source)) {
    throw new AppError("room_voice_taken", "There is already a comment from this account in the room.", 409);
  }
  if (input.workerRunId !== undefined && await roomHasOwnerDraft(tx, source)) {
    throw new AppError("room_owner_reply_pending", "The owner already has words saved for this comment.", 409);
  }
  const { organizationId: _org, channelId: _channel, campaignId: _campaign, ...target } = source;
  const values = {
    // The unique discoveredPostId key belongs to the top-level comment.
    kind: "room_reply" as const, campaignId: source.campaignId, discoveredPostId: null,
    targetProfileId: source.profileId, roomReplyTarget: target, proposedText: parsed.data,
    finalText: input.workerRunId === undefined ? parsed.data : null,
    publishOrigin: input.workerRunId === undefined ? input.publishOrigin : "worker" as const,
    assistRetention: input.assistRetention, ownerOrigin: input.ownerOrigin,
    status: "proposed" as const, dedupeKey, likeWithSend: input.workerRunId === undefined ? false : null, error: null,
  };
  const [message] = existing
    ? await tx.update(messages).set({ ...values, ...(ownerAfterSkip ? {
      redraftRequestVersion: existing.redraftRequestVersion + 1,
      redraftRequestId: null, redraftRequestedAt: null, redraftRequestedBy: null, redraftRequestNote: null,
    } : {}) }).where(eq(messages.id, existing.id)).returning()
    : await tx.insert(messages).values({ ...values, workerRunId: input.workerRunId ?? null,
      createdAt: input.now ?? Date.now() }).returning();
  return { message: message!, created: existing === undefined };
}

/** The comment a reply answers, as a composer names it: a room member's
 *  exact comment, or the signal that holds a lead's. Only the server's own
 *  `source: "lead"` names a lead's; an action target from a page never carries one. */
export type ReplyTargetRef =
  | { source?: undefined; roomMemberId: number; parentCommentUrn: string }
  | { source: "lead"; signalId: number };

/** Persist one composer, with optimistic revision checks. No message, job,
 * conversation, voice sample or contact receipt is created by a draft save. */
export async function saveRoomReplyDraft(
  tx: Tx,
  input: ReplyTargetRef & {
    text: string;
    /** Null creates a new draft; updates must name the revision displayed. */
    expectedRevision: number | null;
  },
  // These facts come from the authorized surface, never tool/model arguments.
  actor: {
    selection?: RoomReplySelection;
    authoredByOwner?: boolean;
    /** What a lead's box showed beside its own angles, and what the owner
     *  typed before them, less any text it showed: a room's composer has its
     *  saves for that, a lead's opener saves once, when it is queued. */
    assist?: { texts: readonly string[]; ownerWords: readonly string[] };
    now?: number;
  } = {},
): Promise<RoomReplyDraft> {
  const now = actor.now ?? Date.now();
  if (typeof input.text !== "string" || [...input.text].length > MAX_TEXT_CHARACTERS ||
    new TextEncoder().encode(input.text).byteLength > MAX_TEXT_UTF8_BYTES || authoredTextCharacterViolation(input.text)) {
    throw new AppError("room_reply_text_invalid", `Use plain text up to ${MAX_TEXT_CHARACTERS} characters for this reply.`, 400);
  }
  const parsed = input.text.trim() ? AuthoredTextSchema.safeParse(input.text) : null;
  if (parsed && !parsed.success) throw new AppError("room_reply_text_invalid", parsed.error.issues[0]?.message ?? "Invalid reply text.", 400);
  // A pause while typing must not remove the space before the next word.
  // Only Queue normalizes the text that is authorized to leave the app.
  const text = input.text;
  if (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new AppError("room_reply_revision_invalid", "Reload the saved reply before editing it.", 400);
  }
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  const source: ReplySource = input.source === "lead"
    ? await readLeadReplySource(tx, input.signalId, { now })
    : await readRoomReplySource(tx, input, { selectedBy: actor.selection, now });
  if ((await getSystemState(tx))?.killSwitch) {
    throw new AppError("room_reply_stopped", "Sending is stopped. Your saved reply stays unchanged.", 409);
  }
  const stopped = await scopedStop(tx, { channelId: source.channelId, campaignId: source.campaignId,
    profileId: source.profileId, origin: actor.authoredByOwner === true ? "owner" : "worker" });
  if (stopped) throw new AppError("room_reply_stopped", "This conversation is stopped. Your saved reply stays unchanged.", 409);

  // Composer text is campaign-scoped. The eventual outbound message uses
  // roomReplyKey alone, so two campaigns cannot send under the same parent.
  const targetKey = roomReplyDraftKey(source.campaignId, roomReplyKey(source));
  const [existing] = await tx.select().from(roomReplyDrafts).where(eq(roomReplyDrafts.targetKey, targetKey)).for("update");
  if (existing && input.expectedRevision === null && existing.text === text && existing.erasedAt === null) return existing;
  if ((existing?.revision ?? null) !== input.expectedRevision) {
    throw new AppError("room_reply_draft_conflict", "This reply changed in another window. Your unsaved words have been kept in the box.", 409);
  }
  if (existing?.erasedAt != null) {
    throw new AppError("room_reply_evidence_erased", "This person's discovery evidence was forgotten. The saved words remain separate.", 409);
  }
  // Unknown text is not proved owner-authored. Keeping it with a punctuation
  // edit must not turn approval into authorship when no assist history exists.
  const [stepDraft] = await tx.select({ text: messages.proposedText }).from(messages).where(and(
    eq(messages.dedupeKey, roomReplyKey(source)), eq(messages.campaignId, source.campaignId),
    eq(messages.status, "proposed"), eq(messages.publishOrigin, "worker"),
    sql`${messages.workerRunId} is not null`,
  ));
  const offered = retentionWindow([
    ...(source.source === "lead" ? [] : await roomAssistTexts(tx, source, "reply")),
    ...(stepDraft ? [stepDraft.text] : []),
    ...(existing && existing.authorship !== "owner" && existing.text ? [existing.text] : []),
    ...(existing?.assistTexts ?? []),
    ...(actor.assist?.texts ?? []),
  ]);
  // Every angle the box kept, every draft it replaced included, measured
  // beside today's window: the union can only raise what the words kept. A
  // lead's reply is written in the lead's own box.
  const boxOffered = await composerOffered(tx, source.source === "lead"
    ? boxKey({ kind: "lead", leadId: source.leadId }) : boxKey({ kind: "room", targetKey }));
  // Words the box offered are no one's typing, whatever a page says it sent.
  const typed = [
    ...(actor.assist?.ownerWords ?? []).filter((words) => !isUntouchedOffer(words, [...offered, ...boxOffered])),
    ...(existing?.ownerWords ?? []),
  ];
  const ownerWords = actor.authoredByOwner === true && offered.length === 0 && boxOffered.length === 0
    ? recordOwnerWords(typed, text)
    : typed;
  const measured = higherRetention(measureBoxAssist(text, offered, ownerWords), measureComposer(text, boxOffered, ownerWords));
  const authorship = actor.authoredByOwner !== true ? "unknown" as const
    : isAssisted(measured?.assistRetention, measured?.ownerOrigin) ? "assisted" as const : "owner" as const;
  const { organizationId: _org, channelId, campaignId, ...target } = source;
  const values = { target, text, authorship,
    ownerWords: authorship === "owner" ? recordOwnerWords(ownerWords, text) : ownerWords,
    assistTexts: offered, assistRetention: measured?.assistRetention ?? null,
    ownerOrigin: measured?.ownerOrigin ?? null, evidenceExpiresAt: source.evidenceReadAt + ROOM_RETENTION_MS, updatedAt: now };
  if (existing) {
    if (existing.text === text && existing.authorship === authorship && JSON.stringify(existing.target) === JSON.stringify(target)) return existing;
    const [updated] = await tx.update(roomReplyDrafts).set({ ...values, revision: existing.revision + 1 })
      .where(and(eq(roomReplyDrafts.id, existing.id), eq(roomReplyDrafts.revision, existing.revision))).returning();
    if (!updated) throw new AppError("room_reply_draft_conflict", "This reply changed in another window. Reload its saved version.", 409);
    return updated;
  }
  const [created] = await tx.insert(roomReplyDrafts).values({ ...values, channelId, campaignId, targetKey, createdAt: now }).returning();
  return created!;
}

/** An explicit send authorization, separate from a composer save. The origin
 * remains the measured authorship; approving assisted words does not uncap it. */
export async function queueRoomReplyDraft(
  tx: Tx,
  input: { draftId: number; expectedRevision: number },
  actor: { authorization: "owner"; surface: "dashboard" | "mcp_app"; now?: number },
): Promise<Message> {
  const now = actor.now ?? Date.now();
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  const [read] = await tx.select().from(roomReplyDrafts).where(eq(roomReplyDrafts.id, input.draftId));
  if (!read?.target || read.erasedAt !== null) {
    throw new AppError("room_reply_evidence_erased", "Read this room again before sending. Your saved words are still here.", 409);
  }
  const source = await readReplySource(tx, read.target, { now });
  const [draft] = await tx.select().from(roomReplyDrafts).where(eq(roomReplyDrafts.id, read.id)).for("update");
  if (!draft || draft.revision !== input.expectedRevision || !draft.target || draft.erasedAt !== null) {
    throw new AppError("room_reply_draft_conflict", "The saved reply changed. Review its current words before sending.", 409);
  }
  const parsed = AuthoredTextSchema.safeParse(draft.text);
  if (!parsed.success) throw new AppError("room_reply_text_invalid", "Write a reply before sending it.", 400);
  await assertJudgedWords(tx, parsed.data);
  if (roomReplyKey(source) !== roomReplyKey(draft.target) || source.memberUrn !== draft.target.memberUrn || source.campaignId !== draft.campaignId ||
    ((source.source === "lead" || draft.target.source === "lead") && !sameLeadSignal(source, draft.target))) {
    throw new AppError("room_reply_target_changed", "Review the recipient and exact comment again before sending.", 409);
  }
  const origin = draft.authorship === "owner" ? "owner" as const : "worker" as const;
  if ((await getSystemState(tx))?.killSwitch || await scopedStop(tx, {
    channelId: draft.channelId, campaignId: draft.campaignId, profileId: source.profileId, origin,
  })) throw new AppError("room_reply_stopped", "Sending is stopped. Your saved words are still here.", 409);
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, draft.campaignId));
  if (!campaign || campaign.status === "archived") throw new AppError("room_reply_campaign_unavailable", "This campaign cannot send a reply.", 409);

  const { message } = await insertRoomReplyRow(tx, { source, text: parsed.data, publishOrigin: origin,
    assistRetention: draft.assistRetention, ownerOrigin: draft.ownerOrigin, now }, { replaceProposed: true });
  if (["approved", "posting", "posted", "needs_review"].includes(message.status)) return message;
  if (message.status !== "proposed") {
    throw new AppError("room_reply_already_resolved", "This reply has already been resolved. Review its outcome before trying again.", 409);
  }
  return approveRoomReplyRow(tx, message, campaign, actor.surface, now);
}

/** Approval stamps the exact words and preserves the row's measured origin. */
async function approveRoomReplyRow(tx: Tx, message: Message, campaign: Campaign,
  surface: "dashboard" | "mcp_app", now: number): Promise<Message> {
  const origin = message.publishOrigin;
  const text = message.finalText ?? message.proposedText;
  let scheduledAt: number | null = null;
  if (campaign.status !== "paused" || origin === "owner") {
    const [slot] = await assignSlots(tx, { campaign, origin, now, items: [{ messageId: message!.id, kind: "room_reply" }] });
    if (!slot) throw new AppError("room_reply_no_slot", "The account could not schedule this reply. Your saved words are still here.", 409);
    scheduledAt = slot.scheduledAt;
  }
  const [queued] = await tx.update(messages).set({ status: "approved", scheduledAt })
    .where(eq(messages.id, message!.id)).returning();
  // The owner's yes, given here, is the action's: it goes out through the gate.
  await sendRoomReply(tx, { message: queued!, campaign, yes: { by: `owner:${surface}` }, now });
  await tx.insert(feedback).values({ messageId: message!.id, verdict: "approve", decisionOrigin: surface,
    messageRequestVersion: message!.redraftRequestVersion,
    finalTextHash: createHash("sha256").update(text).digest("hex"), createdAt: now });
  if (origin === "owner") {
    await captureVoiceSample(tx, { text, source: "owner_reply", messageId: message!.id,
      campaignId: campaign.id, voiceId: await campaignVoiceId(tx, campaign.id),
      assistRetention: message.assistRetention, ownerOrigin: message.ownerOrigin });
  }
  trackMessageDecided({ decision: "approved", for: "room_reply", origin,
    written: origin === "owner" ? "own" : "kept_draft", characters: text.length,
    retentionPercent: message.assistRetention === null ? null : message.assistRetention * 100 }, tx);
  return queued!;
}

/** A yes to one displayed step draft. Independent composer text is never
 * copied into it or overwritten by the review. */
export type StepRoomReplyDecision = {
  messageId: number;
  expectedRequestVersion: number;
  expectedText: string;
};

type RoomReplyOwner = { authorization: "owner"; surface: "dashboard" | "mcp_app"; now?: number };

function checkStepDecision(input: StepRoomReplyDecision) {
  if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0 ||
    !Number.isSafeInteger(input.expectedRequestVersion) || input.expectedRequestVersion < 0 ||
    typeof input.expectedText !== "string") {
    throw new AppError("room_reply_invalid", "Choose the displayed room reply to review.", 400);
  }
}

export async function approveStepRoomReply(tx: Tx, input: StepRoomReplyDecision & {
  editedText?: string;
  likeWithSend: boolean;
}, actor: RoomReplyOwner): Promise<Message> {
  if (typeof input.likeWithSend !== "boolean") throw new AppError("room_reply_invalid", "Choose whether to like their comment too.", 400);
  const { message, campaign, now } = await updateStepRoomReplyDraft(tx, input, actor);
  const [updated] = await tx.update(messages).set({ likeWithSend: input.likeWithSend })
    .where(eq(messages.id, message.id)).returning();
  return approveRoomReplyRow(tx, updated!, campaign, actor.surface, now);
}

/** Save a review edit on its proposal, leaving the independent composer and
 * original model words intact. Saving cannot approve or schedule the reply. */
export async function saveStepRoomReplyEdit(tx: Tx, input: StepRoomReplyDecision & { editedText: string },
  actor: RoomReplyOwner): Promise<Message> {
  return (await updateStepRoomReplyDraft(tx, input, actor)).message;
}

async function updateStepRoomReplyDraft(tx: Tx, input: StepRoomReplyDecision & { editedText?: string }, actor: RoomReplyOwner) {
  checkStepDecision(input);
  const now = actor.now ?? Date.now();
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  const [read] = await tx.select().from(messages).where(eq(messages.id, input.messageId));
  if (read?.kind !== "room_reply" || read.workerRunId === null || read.roomReplyTarget?.selectedBy !== "worker") {
    throw new AppError("room_reply_missing", "That step draft is no longer available.", 404);
  }
  const source = await readRoomReplySource(tx, { roomMemberId: read.roomReplyTarget.roomMemberId,
    parentCommentUrn: read.roomReplyTarget.parentCommentUrn }, { selectedBy: read.roomReplyTarget.selectedBy, now });
  await lockRoomVoice(tx, source);
  const [message] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for("update");
  if (!message || message.kind !== "room_reply" || message.workerRunId === null ||
    message.roomReplyTarget?.selectedBy !== "worker" ||
    message.status !== "proposed" || message.redraftRequestId !== null ||
    message.redraftRequestVersion !== input.expectedRequestVersion ||
    (message.finalText ?? message.proposedText) !== input.expectedText) {
    throw new AppError("room_reply_changed", "This draft changed. Review its current words before approving.", 409);
  }
  if (source.campaignId !== message.campaignId || roomReplyKey(source) !== message.dedupeKey ||
    source.memberUrn !== message.roomReplyTarget?.memberUrn || source.profileId !== message.targetProfileId ||
    source.discoveredPostId !== message.roomReplyTarget?.discoveredPostId) {
    throw new AppError("room_reply_target_changed", "Review the exact comment and recipient again.", 409);
  }
  const parsed = AuthoredTextSchema.safeParse(input.editedText ?? input.expectedText);
  if (!parsed.success) throw new AppError("room_reply_text_invalid", "Write a reply before approving it.", 400);
  const history = await tx.select({ text: messageDraftRevisions.draftText }).from(messageDraftRevisions)
    .where(and(eq(messageDraftRevisions.messageId, message.id),
      sql`${messageDraftRevisions.source} in ('initial', 'redraft', 'variant_swap')`))
    .orderBy(desc(messageDraftRevisions.revision)).limit(20);
  // Every angle the room box kept counts beside the step's own drafts.
  const boxOffered = await composerOffered(tx,
    boxKey({ kind: "room", targetKey: roomReplyDraftKey(source.campaignId, roomReplyKey(source)) }));
  const measured = higherRetention(
    measureBoxAssist(parsed.data, [message.proposedText, ...history.map((row) => row.text)], []),
    measureComposer(parsed.data, boxOffered),
  );
  const edited = input.editedText !== undefined && parsed.data !== input.expectedText;
  const origin = edited ? (!isAssisted(measured?.assistRetention, measured?.ownerOrigin) ? "owner" : "worker") : message.publishOrigin;
  if ((await getSystemState(tx))?.killSwitch || await scopedStop(tx, { channelId: source.channelId,
    campaignId: source.campaignId, profileId: source.profileId, origin })) {
    throw new AppError("room_reply_stopped", "Sending is stopped. The draft is still here.", 409);
  }
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, source.campaignId));
  if (!campaign || campaign.status === "archived") throw new AppError("room_reply_campaign_unavailable", "This campaign cannot send a reply.", 409);
  const [updated] = await tx.update(messages).set({ finalText: parsed.data, publishOrigin: origin,
    assistRetention: edited ? measured?.assistRetention ?? null : message.assistRetention,
    ownerOrigin: edited ? measured?.ownerOrigin ?? null : message.ownerOrigin,
  }).where(eq(messages.id, message.id)).returning();
  return { message: updated!, campaign, now };
}

/** Skip the displayed opportunity, including after its discovery expired.
 * The canonical rejection records the decision; no composer is changed. */
export async function skipStepRoomReply(tx: Tx, input: StepRoomReplyDecision, actor: RoomReplyOwner): Promise<void> {
  checkStepDecision(input);
  const [message] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for("update");
  if (!message || message.kind !== "room_reply" || message.workerRunId === null ||
    message.roomReplyTarget?.selectedBy !== "worker" ||
    message.status !== "proposed" || message.redraftRequestVersion !== input.expectedRequestVersion ||
    (message.finalText ?? message.proposedText) !== input.expectedText) {
    throw new AppError("room_reply_changed", "This draft changed. Review its current words before skipping.", 409);
  }
  const snapshot = await snapshotMessageDecision(tx, { messageId: message.id, verdict: "reject", decisionOrigin: actor.surface });
  if (!snapshot.ok) throw new AppError("room_reply_changed", "This draft is no longer waiting for a decision.", 409);
  const result = await applyPreparedMessageDecision(tx, await prepareMessageDecision(snapshot.snapshot, { llm: null }));
  if (!result.ok) throw new AppError("room_reply_changed", "This draft changed before it could be skipped.", 409);
  if (message.campaignId !== null) await tx.update(stepRuns).set({ status: "blocked", blockedReason: "owner_skipped_room_reply", wait: null, updatedAt: Date.now() })
    .where(and(eq(stepRuns.campaignId, message.campaignId),
      sql`${stepRuns.drafts} @> ${JSON.stringify([{ kind: "room_reply", messageId: message.id }])}::jsonb`));
}
