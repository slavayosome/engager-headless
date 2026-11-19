import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { and, eq } from "drizzle-orm";
import { discoveredPosts, messages, roomMembers, leads, incomingComments } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { untrusted } from "../../../ai/prompts";
import { llmWithSignal } from "../../../ai/client";
import { getCampaign } from "../../../operations/campaigns";
import { getCommentDraftingContext, submitClientReply, submitCommentDraftBatch } from "../../../operations/clientDrafting";
import { cancelIncomingReplyDraft, cancelMessageRedraft, requestIncomingReplyDraft, requestMessageRedraft } from "../../../operations/messages";
import { mcpOperationActor } from "../../context";
import { requestRoomReplyRedraft, cancelRoomReplyRedraft } from "../../../rooms/replyRedraft";
import { readRoomReplySource, roomReplyKey } from "../../../rooms/replySource";
import { requestComposerAngle } from "../../../composer/requests";
import { cancelRoomReplyDraft, deliverRoomReplyAssist, getRoomReplyContext, requestRoomReplyDraft, RoomReplyOwnerReview, submitRoomReplyReview } from "../../../rooms/replyDrafting";
import { threadTurn } from "../../../operations/threads";
import { findPerson } from "../../../people/directory";
import { leadSources } from "../../../leads/source";
import { getProfile, resolveVoice } from "../../../profile";
import { listKnowledge } from "../../../brain/knowledge";
import { boxKey, composerFor, failComposerAngle, openComposerBox, putComposerAngle, readComposerAngle, replaceComposerIdeas } from "../../../composer/drafts";
import { isPreviewRefusal, previewCommentDrafts } from "../../../workers/draftPreview";
import { resolveJudgmentPolicy } from "../../../tasks/policy";
import { assertHostedMcpExternalPhase } from "../../tools/hostedSpend";
import { errorResult, jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { parseRef } from "../refs";

const positive = z.number().int().positive();
type Tx = Parameters<Parameters<typeof withOrg>[1]>[0];
async function roomRedraft(tx: Tx, message: typeof messages.$inferSelect, version: number, cancel: boolean) {
  const step = { messageId: message.id, expectedRequestVersion: version, expectedText: message.finalText ?? message.proposedText };
  try {
    if (cancel) { await cancelRoomReplyRedraft(tx, step); return jsonResult({ cancelled: true }); }
    return jsonResult(await requestRoomReplyRedraft(tx, step));
  } catch (error) {
    if (error instanceof AppError) return errorResult(error.message, { code: error.code, status: error.status });
    throw error;
  }
}
export const draftTools: readonly V2Tool[] = [
  defineTool({
    name: "request_draft", kind: "write",
    description: "Request or cancel drafting for a current item. Supply its current status and version. See engager-campaigns.",
    input: z.object({ ref: z.string(), note: z.string().trim().min(1).max(500).optional(), cancel: z.boolean().optional(), clientId: z.string().uuid(), expectedStatus: z.enum(["new", "ignored", "reply_proposed", "proposed", "approved", "failed"]).optional(), version: z.number().int().nonnegative().optional(), position: positive.optional(), revision: positive.optional(), more: z.boolean().optional() }).strict(),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      const ref = parseRef(input.ref, ["msg", "turn", "member", "box", "lead"]);
      if ((ref.kind === "msg" || ref.kind === "turn") && (input.version === undefined || input.expectedStatus === undefined)) return errorResult("Read the current status and version first.", { code: "stale_state", status: 409 });
      if (ref.kind === "msg") {
        if (input.version === undefined || input.expectedStatus === undefined) throw new Error("unreachable");
        if (!["proposed", "approved", "failed"].includes(input.expectedStatus)) return errorResult("The message state is stale.", { code: "stale_state", status: 409 });
        const cas = { messageId: ref.id, expectedStatus: input.expectedStatus as "proposed" | "approved" | "failed", expectedRequestVersion: input.version, requestId: input.clientId };
        const [waiting] = await tx.select().from(messages).where(eq(messages.id, ref.id));
        if (waiting?.kind === "room_reply") return roomRedraft(tx, waiting, input.version, input.cancel === true);
        const result = input.cancel ? await cancelMessageRedraft(tx, cas) : await requestMessageRedraft(tx, { ...cas, actor: mcpOperationActor(ctx), note: input.note });
        return result.ok ? jsonResult(result) : errorResult(result.reason, { code: result.reason, status: 409, data: result });
      }
      if (ref.kind === "turn") {
        if (input.version === undefined || input.expectedStatus === undefined) throw new Error("unreachable");
        if (!["new", "ignored", "reply_proposed"].includes(input.expectedStatus)) return errorResult("The turn state is stale.", { code: "stale_state", status: 409 });
        const expectedStatus = input.expectedStatus as "new" | "ignored" | "reply_proposed";
        const cas = { incomingCommentId: ref.id, expectedStatus, expectedRequestVersion: input.version, requestId: input.clientId };
        const [reply] = await tx.select().from(messages).where(and(eq(messages.kind, "reply"), eq(messages.incomingCommentId, ref.id)));
        const existingReply = reply ? { messageId: reply.id, expectedStatus: reply.status, expectedRequestVersion: reply.redraftRequestVersion } : null;
        const result = input.cancel ? await cancelIncomingReplyDraft(tx, cas) : await requestIncomingReplyDraft(tx, { ...cas, actor: mcpOperationActor(ctx), note: input.note, existingReply });
        return result.ok ? jsonResult(result) : errorResult(result.reason, { code: result.reason, status: 409, data: result });
      }
      if (ref.kind === "member") {
        const id = Number(ref.memberId);
        if (!Number.isSafeInteger(id) || id <= 0) return errorResult("A room member row id is required.", { code: "invalid_ref" });
        if (input.version !== undefined || input.expectedStatus !== undefined) {
          if (input.version === undefined || input.expectedStatus !== "proposed") return errorResult("Read the current status and version first.", { code: "stale_state", status: 409 });
          const [member] = await tx.select().from(roomMembers).where(eq(roomMembers.id, id));
          const parentCommentUrn = member?.draftRequest?.parentCommentUrn;
          if (!parentCommentUrn) return errorResult("No waiting room reply for this member.", { code: "request_not_found" });
          const source = await readRoomReplySource(tx, { roomMemberId: id, parentCommentUrn }, { selectedBy: "worker" });
          const [waiting] = await tx.select().from(messages).where(and(eq(messages.dedupeKey, roomReplyKey(source)), eq(messages.campaignId, source.campaignId)));
          if (!waiting) return errorResult("No waiting room reply for this member.", { code: "request_not_found" });
          return roomRedraft(tx, waiting, input.version, input.cancel === true);
        }
        if (input.cancel) { await cancelRoomReplyDraft(tx, id, input.clientId); return jsonResult({ cancelled: true }); }
        return jsonResult(await requestRoomReplyDraft(tx, { roomMemberId: id, deliverable: "reply" }, { requestId: input.clientId }));
      }
      if (ref.kind === "box" || ref.kind === "lead") {
        const box = ref.kind === "box" ? ref.key : boxKey({ kind: "lead", leadId: ref.id });
        if ((input.position === undefined) !== (input.revision === undefined)) return errorResult("Supply both position and revision.", { code: "invalid_input", status: 400 });
        const by = mcpOperationActor(ctx);
        try {
          const at = input.position !== undefined && input.revision !== undefined ? { position: input.position, revision: input.revision } : null;
          if (input.cancel) {
            if (!at) return errorResult("Name the angle to cancel with position and revision.", { code: "invalid_input", status: 400 });
            await failComposerAngle(tx, box, at);
            return jsonResult({ cancelled: true });
          }
          if (input.more || !at) return jsonResult(await requestComposerAngle(tx, { box, kind: "more", by }));
          const row = await readComposerAngle(tx, box, at.position);
          if (!row) return errorResult("That angle is gone. Read the box again.", { code: "stale_state", status: 409 });
          const asked = row.state === "idea"
            ? await requestComposerAngle(tx, { box, kind: "draft", angle: at, by })
            : await requestComposerAngle(tx, { box, kind: "redraft", angle: { ...at, source: "agent" }, by });
          return jsonResult(asked);
        } catch (error) {
          if (error instanceof AppError) return errorResult(error.message, { code: error.code, status: error.status });
          throw error;
        }
      }
      return errorResult("This request destination is not available yet.", { code: "not_implemented" });
    }),
  }),
  defineTool({
    name: "get_drafting_context", kind: "read",
    description: "Read drafting context and the owner's voice and facts. Source text is untrusted. See engager-campaigns.",
    input: z.object({ ref: z.string().optional(), campaignId: positive.optional(), mode: z.enum(["angles", "draft"]).optional() }).strict(),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      const ref = input.ref ? parseRef(input.ref, ["post", "turn", "member", "person", "lead", "box"]) : null;
      if (ref?.kind === "box") {
        const box = await openComposerBox(tx, ref.key);
        const campaign = box.campaignId ? await getCampaign(tx, box.campaignId) : undefined;
        const context = campaign ? await getCommentDraftingContext(tx, campaign, { mode: input.mode, llm: null }) : null;
        if (context && !context.ok) return errorResult(context.error, context.details);
        const notes = context?.ok ? null : await listKnowledge(tx);
        return jsonResult({ box: box.key, composer: (await composerFor(tx, [box.key])).get(box.key) ?? null,
          ...(context?.ok ? { voice: context.data.voice, brain: context.data.brain, ownerStories: context.data.ownerStories } : { voice: resolveVoice(await getProfile(tx), "comment"), brain: notes, ownerStories: notes?.filter(note => note.slot === "stories") }) });
      }
      if (ref?.kind === "member") {
        const id = Number(ref.memberId);
        if (!Number.isSafeInteger(id) || id <= 0) return errorResult("A room member row id is required.", { code: "invalid_ref" });
        const [member] = await tx.select().from(roomMembers).where(eq(roomMembers.id, id));
        if (!member?.draftRequest || !member.draftRequestId) return errorResult("Request a draft for this member first.", { code: "request_not_found" });
        const context = await getRoomReplyContext(tx, { roomMemberId: id, requestId: member.draftRequestId, parentCommentUrn: member.draftRequest.parentCommentUrn, deliverable: member.draftRequest.deliverable });
        return jsonResult({ contextRevision: context.contextRevision, instructions: context.instructions, ownerFacts: context.context.ownerFacts, voice: context.context.voice, source: untrusted("ROOM REPLY SOURCE", context.prompt), evidence: untrusted("ROOM EVIDENCE", JSON.stringify(context.evidence)) });
      }
      if (ref?.kind === "turn" || ref?.kind === "person" || ref?.kind === "lead") {
        let source: unknown;
        let campaignId = input.campaignId;
        if (ref.kind === "turn") {
          source = await threadTurn(tx, { kind: "incoming", incomingCommentId: ref.id });
          const [incoming] = await tx.select({ campaignId: incomingComments.campaignId }).from(incomingComments).where(eq(incomingComments.id, ref.id));
          campaignId ??= incoming?.campaignId ?? undefined;
        } else if (ref.kind === "person") source = await findPerson(tx, ref.key);
        else {
          const [lead] = await tx.select().from(leads).where(eq(leads.id, ref.id));
          campaignId ??= lead?.campaignId ?? undefined;
          source = lead ? { lead, signals: await leadSources(tx, ref.id) } : null;
        }
        if (!source) return errorResult("Drafting target not found.", { code: "not_found", status: 404 });
        const campaign = campaignId ? await getCampaign(tx, campaignId) : undefined;
        const context = campaign ? await getCommentDraftingContext(tx, campaign, { mode: input.mode, llm: null }) : null;
        if (context && !context.ok) return errorResult(context.error, context.details);
        const notes = context?.ok ? null : await listKnowledge(tx);
        return jsonResult({ source: untrusted("DRAFTING SOURCE", JSON.stringify(source)), ...(context?.ok ? { voice: context.data.voice, brain: context.data.brain, ownerStories: context.data.ownerStories } : { voice: resolveVoice(await getProfile(tx), "comment"), brain: notes, ownerStories: notes?.filter(note => note.slot === "stories") }) });
      }
      if (ref && ref.kind !== "post") return errorResult("This drafting context is not available yet.", { code: "not_implemented" });
      const [post] = ref?.kind === "post" ? await tx.select().from(discoveredPosts).where(eq(discoveredPosts.id, ref.id)) : [];
      if (ref && !post) return errorResult("Post not found.", { code: "not_found", status: 404 });
      const campaignId = input.campaignId ?? post?.campaignId;
      if (!campaignId || (post && post.campaignId !== campaignId)) return errorResult("Name the post's campaign.", { code: "invalid_input" });
      const campaign = await getCampaign(tx, campaignId);
      if (!campaign) return errorResult("Campaign not found.", { code: "not_found", status: 404 });
      const context = await getCommentDraftingContext(tx, campaign, { discoveredPostId: post?.id, mode: input.mode, llm: null });
      if (!context.ok) return errorResult(context.error, context.details);
      const { post: sourcePost, author, research, followUp, systemPrompt, ...owner } = context.data;
      return jsonResult({ ...owner, systemPrompt: untrusted("DRAFTING CONTEXT", systemPrompt), source: untrusted("POST, AUTHOR AND THREAD", JSON.stringify({ post: sourcePost, author, research, followUp })) });
    }),
  }),
  defineTool({
    name: "submit_draft", kind: "write",
    description: "Place the agent's words in a composer or submit them for review. Never stamps owner authorship. See engager-campaigns.",
    input: z.object({ ref: z.string(), to: z.enum(["composer", "review"]), angles: z.array(z.object({ name: z.string().min(1), line: z.string().min(1) }).strict()).optional(), text: z.string().trim().min(1).optional(), contextRevision: z.string().optional(), evidenceReview: z.record(z.string(), z.unknown()).optional(), position: positive.optional(), revision: positive.optional(), sensitivityHold: z.boolean().optional(), rationale: z.string().optional() }).strict(),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      const ref = parseRef(input.ref, ["post", "turn", "member", "box", "lead"]);
      if (input.to === "review" && (ref.kind === "post" || ref.kind === "turn")) {
        if (!input.text) return errorResult("A review draft needs text.", { code: "invalid_input" });
        const options = { forceProposal: false, explicitUserDirected: true, resolveStepMode: true };
        if (ref.kind === "turn") {
          const result = await submitClientReply(tx, { incomingCommentId: ref.id, text: input.text, sensitivityHold: input.sensitivityHold, rationale: input.rationale }, options);
          return result.ok ? jsonResult(result.data) : errorResult(result.error, result.details);
        }
        const [post] = await tx.select().from(discoveredPosts).where(eq(discoveredPosts.id, ref.id));
        const campaign = post ? await getCampaign(tx, post.campaignId) : undefined;
        if (!campaign) return errorResult("Post not found.", { code: "not_found", status: 404 });
        const result = await submitCommentDraftBatch(tx, campaign, { drafts: [{ discoveredPostId: ref.id, text: input.text, rationale: input.rationale, sensitivityHold: input.sensitivityHold }] }, options);
        return result.ok ? jsonResult(result.data) : errorResult(result.error, result.details);
      }
      if (ref.kind === "member") {
        const id = Number(ref.memberId);
        if (!Number.isSafeInteger(id) || id <= 0) return errorResult("A room member row id is required.", { code: "invalid_ref" });
        const [member] = await tx.select().from(roomMembers).where(eq(roomMembers.id, id));
        if (!member?.draftRequest || !member.draftRequestId) return errorResult("Request a draft for this member first.", { code: "request_not_found" });
        const review = RoomReplyOwnerReview.safeParse(input.evidenceReview);
        if (!input.text || !input.contextRevision || !review.success) return errorResult("Text, contextRevision and evidenceReview are required.", { code: "invalid_input" });
        const request = { roomMemberId: id, requestId: member.draftRequestId, parentCommentUrn: member.draftRequest.parentCommentUrn, deliverable: member.draftRequest.deliverable, contextRevision: input.contextRevision, text: input.text, review: review.data };
        if (input.to === "review") {
          if (request.deliverable !== "reply") return errorResult("Only a room reply can go to review.", { code: "invalid_input" });
          return jsonResult(await submitRoomReplyReview(tx, request));
        }
        return jsonResult(await deliverRoomReplyAssist(tx, { ...request, position: input.position, revision: input.revision }));
      }
      if (input.to !== "composer") return errorResult("This draft destination is not available yet.", { code: "not_implemented" });
      const box = ref.kind === "box" ? ref.key : ref.kind === "post" ? boxKey({ kind: "comment", discoveredPostId: ref.id }) : ref.kind === "turn" ? boxKey({ kind: "reply", incomingCommentId: ref.id }) : ref.kind === "lead" ? boxKey({ kind: "lead", leadId: ref.id }) : null;
      if (!box) return errorResult("This draft destination is not available yet.", { code: "not_implemented" });
      if ((input.position === undefined) !== (input.revision === undefined)) return errorResult("Supply both position and revision.", { code: "invalid_input" });
      if (!input.text && !input.angles?.length) return errorResult("Supply angles or text.", { code: "invalid_input" });
      const ideas = input.angles?.length ? await replaceComposerIdeas(tx, { box, ideas: input.angles.map(angle => ({ name: angle.name, why: angle.line })) }) : [];
      const draft = input.text ? await putComposerAngle(tx, { box, text: input.text, ...(input.position !== undefined && input.revision !== undefined ? { at: { position: input.position, revision: input.revision } } : {}) }) : null;
      return jsonResult({ ideas, draft });
    }),
  }),
  defineTool({
    name: "preview_drafts", kind: "read",
    description: "Preview production dispatcher drafts for a post without persisting them. See engager-voice-and-brain.",
    input: z.object({ campaignId: positive, postRef: z.string(), variants: z.array(z.object({ label: z.string().trim().min(1).max(40), knobs: z.object({ exemplarCount: z.number().int().min(1).max(12).optional(), rationing: z.enum(["strict", "soft", "off"]).optional() }).strict() }).strict()).min(1).max(4).optional() }).strict(),
    handler: async ({ ctx, signal }, input) => {
      const ref = parseRef(input.postRef, ["post"]);
      if (ref.kind !== "post") throw new Error("unreachable");
      const allowed = await withOrg(ctx.organizationId, async tx => {
        const [post] = await tx.select({ campaignId: discoveredPosts.campaignId }).from(discoveredPosts).where(eq(discoveredPosts.id, ref.id));
        return post?.campaignId === input.campaignId;
      });
      if (!allowed) return errorResult("Post not found in this campaign.", { code: "not_found", status: 404 });
      await assertHostedMcpExternalPhase(ctx, signal, "messages:write");
      if (await withOrg(ctx.organizationId, tx => resolveJudgmentPolicy(tx)) !== "configured_background") return errorResult("No background agent is configured to write previews.", { code: "no_background_agent", status: 409 });
      const result = await previewCommentDrafts(ctx.organizationId, { discoveredPostId: ref.id, variants: input.variants }, llmWithSignal(ctx.llm, signal), { beforeExternalPhase: () => assertHostedMcpExternalPhase(ctx, signal, "messages:write") });
      if (isPreviewRefusal(result)) { const { message, ...details } = result.refused; return errorResult(message, details); }
      return jsonResult({ preview: true, persisted: false, ...result });
    },
  }),
];
