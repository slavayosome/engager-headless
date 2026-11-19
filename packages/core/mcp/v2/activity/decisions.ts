import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { actions as actionRow, conversations, incomingInvitations, incomingComments, messages, offers, type IncomingComment } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { approveAction } from "../../../actions/approval";
import { editAction, rejectAction, unscheduleAction } from "../../../actions/ledger";
import { resolveConversationReview } from "../../../actions/takeover";
import { llmWithSignal } from "../../../ai/client";
import { dismissInvitation } from "../../../invitations/link";
import {
  decideMessage,
  decideMessageWithOptions,
  dontComment,
  dontReply,
  dropScheduledLikeOp,
  postNowApprovedOp,
  REDRAFT_STOPPED_NOTE,
  reopenFailedMessage,
  restoreMessageOp,
  retryDefinitiveMessageFailure,
  lockReplyTurn,
  undoDontReply,
  unscheduleMessageOp,
  type AtomicMutationFailure,
  type DecideMessageResult,
} from "../../../operations/messages";
import { resolveOutcome, type OutcomeResult } from "../../../operations/outcomes";
import { findPerson } from "../../../people/directory";
import { approveOffer } from "../../../products/offers";
import { mcpOperationActor, type McpCtx } from "../../context";
import { errorResult, jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { parseRef } from "../refs";

/**
 * Every yes and no the owner gives, and every uncertain send they settle.
 *
 * Nothing here presses LinkedIn. A yes moves a row to approved and the drain
 * sends it after `canEngage` and exactly-once reconciliation; `post_now` only
 * moves a slot. An agent relays the owner's word: the origin of every decision
 * is stated here, never taken from an argument, so an approval is the agent's
 * and a room reply's approval, which only an owner surface can give, is
 * refused.
 */

const VERDICTS = [
  "approve",
  "edit",
  "reject",
  "skip",
  "unskip",
  "restore",
  "retry",
  "post_now",
  "unschedule",
] as const;
type Verdict = (typeof VERDICTS)[number];

/** The verdicts many items take at once: the ones that need no words and no
 *  one item's own view. */
const MANY_VERDICTS: readonly Verdict[] = ["approve", "reject", "skip", "unschedule"];
/** The most items one decision covers. */
const MANY_REFS_MOST = 100;

const decideInput = z.object({
  ref: z
    .string()
    .optional()
    .describe("msg: · act: · turn: · person: · offer: · inv: and its id."),
  refs: z.array(z.string()).min(1).max(MANY_REFS_MOST).optional().describe("Many, each read first."),
  verdict: z.enum(VERDICTS),
  text: z.string().trim().min(1).max(3000).optional().describe("The owner's words, for edit or a rewriting retry."),
  reason: z.string().trim().max(500).optional().describe("Recorded with a reject."),
  variant: z.number().int().positive().optional().describe("Another draft of the set to use."),
  likeWithSend: z.boolean().optional().describe("Whether its bound like goes out with it."),
  expectedStatus: z
    .string()
    .max(128)
    .optional()
    .describe("The status you saw; an offer's contentHash for approve. A mismatch changes nothing."),
  version: z.number().int().nonnegative().optional().describe("The version you saw; a mismatch changes nothing."),
});
type DecideInput = z.infer<typeof decideInput>;

type Call = { ctx: McpCtx; signal: AbortSignal };

/** A refusal the ledger, an offer or an invitation names, with its recovery. */
export function domainRefusal(error: unknown): CallToolResult {
  if (!(error instanceof AppError)) throw error;
  const recovery = "recovery" in error && typeof error.recovery === "string" ? error.recovery : undefined;
  return errorResult(error.message, { code: error.code, status: error.status, ...(recovery ? { recovery } : {}) });
}

function refuse(code: string, message: string, status = 409, recovery?: string): CallToolResult {
  return errorResult(message, { code, status, ...(recovery ? { recovery } : {}) });
}

function stale(current: { status?: string | null; version?: number | null }): CallToolResult {
  return errorResult("It changed since you read it, so nothing was changed.", {
    code: "stale_state",
    status: 409,
    recovery: "Read it again with list_activity and decide on what it is now.",
    data: { currentStatus: current.status ?? null, currentVersion: current.version ?? null },
  });
}

/** Whether the caller's view of a row is the row's. Absent fields say nothing. */
function sameView(input: DecideInput, row: { status: string; version: number }): boolean {
  return (
    (input.expectedStatus === undefined || input.expectedStatus === row.status) &&
    (input.version === undefined || input.version === row.version)
  );
}

function notSupported(verdict: Verdict, kind: string): CallToolResult {
  return refuse("verdict_not_supported", `${verdict} does not apply to ${kind}.`, 400);
}

function textRequired(verdict: Verdict): CallToolResult {
  return refuse("text_required", `${verdict} needs the owner's words in text.`, 400);
}

/** A failed phased decision, in the words the app's buttons use. */
function decisionRefusal(result: Extract<DecideMessageResult, { ok: false }>): CallToolResult {
  switch (result.reason) {
    case "not_found":
      return refuse("not_found", "That message is not in this organization.", 404);
    case "reply_off":
      return refuse(
        "public_reply_off",
        "That reply's campaign has Reply Off, so it cannot be approved.",
        409,
        "Turning Reply to Ask me is a widening the owner confirms in Engager; or reject the draft.",
      );
    case "invalid_state":
      return refuse(
        "invalid_state",
        `The message is ${result.currentStatus ?? "not actionable"}; only a proposed or still-queued draft can be decided.`,
      );
    default:
      return stale({ status: result.currentStatus });
  }
}

/** A failed compare-and-set mutation, as the dashboard's rows read it. */
function mutationRefusal(failure: AtomicMutationFailure<string, string>): CallToolResult {
  switch (failure.reason) {
    case "not_found":
      return refuse("not_found", "Not found in this organization.", 404);
    case "stale_state":
      return stale({ status: failure.currentStatus, version: failure.currentRequestVersion });
    case "campaign_stopped":
      return refuse("campaign_stopped", REDRAFT_STOPPED_NOTE, 409, "Only the owner's Resume lifts the Stop.");
    case "not_undoable":
      return refuse("not_undoable", "That was dismissed before Engager recorded what Undo needs, so it stays dismissed.");
    case "removed":
      return refuse("removed", "LinkedIn shows that reply deleted, so there is nothing to bring back.");
    default:
      return refuse(failure.reason, `Not applied: ${failure.reason.replaceAll("_", " ")}.`);
  }
}

const done = (ref: string, verdict: Verdict, more: Record<string, unknown> = {}) =>
  jsonResult({ ok: true, ref, verdict, ...more });

async function decideOnMessage(call: Call, input: DecideInput, id: number): Promise<CallToolResult> {
  const { ctx, signal } = call;
  const { verdict, text } = input;
  const scope = <T>(work: (tx: Tx) => Promise<T>) => withOrg(ctx.organizationId, work);
  const [row] = await scope((tx) =>
    tx
      .select({
        kind: messages.kind,
        status: messages.status,
        version: messages.redraftRequestVersion,
        incomingCommentId: messages.incomingCommentId,
      })
      .from(messages)
      .where(eq(messages.id, id)),
  );
  if (!row) return refuse("not_found", `message ${id} is not in this organization.`, 404);
  if (!sameView(input, row)) return stale(row);
  const cas = { messageId: id, expectedStatus: row.status, expectedRequestVersion: row.version };
  const ref = `msg:${id}`;
  const locked = <T>(work: (tx: Tx) => Promise<T>) => scope(async (tx): Promise<T | CallToolResult> => {
    const [current] = await tx.select({ status: messages.status, version: messages.redraftRequestVersion })
      .from(messages).where(eq(messages.id, id)).for("update");
    if (!current) return refuse("not_found", `message ${id} is not in this organization.`, 404);
    if (current.status !== row.status || current.version !== row.version) return stale(current);
    return work(tx);
  });

  switch (verdict) {
    case "approve":
    case "edit": {
      // Only an owner surface can give a room reply its first yes.
      if (row.kind === "room_reply") {
        return refuse("owner_surface_required", "A room reply is approved in Engager, on the owner's own press.", 409);
      }
      if (verdict === "edit" && !text) return textRequired(verdict);
      const decided = await decideMessageWithOptions(
        scope,
        { messageId: id, verdict, editedText: text ?? null, decisionOrigin: "agent", expectedStatus: row.status, expectedRequestVersion: row.version, variant: input.variant, likeWithSend: input.likeWithSend },
        { llm: llmWithSignal(ctx.llm, signal) },
      );
      return decided.ok
        ? done(ref, verdict, {
            kind: decided.kind,
            ...(decided.scheduledAt != null ? { scheduledAt: new Date(decided.scheduledAt).toISOString() } : {}),
          })
        : decisionRefusal(decided);
    }
    case "reject": {
      const decided = await decideMessage(
        scope,
        { messageId: id, verdict, reason: input.reason ?? null, decisionOrigin: "agent", expectedStatus: row.status, expectedRequestVersion: row.version },
        { llm: null },
      );
      return decided.ok ? done(ref, verdict, { status: "rejected", kind: decided.kind }) : decisionRefusal(decided);
    }
    case "skip": {
      if (row.kind === "comment") {
        const res = await scope((tx) => dontComment(tx, cas));
        return res.ok ? done(ref, verdict, { status: res.status, version: res.requestVersion }) : mutationRefusal(res);
      }
      if (row.kind === "reply" && row.incomingCommentId !== null) {
        const incomingCommentId = row.incomingCommentId;
        const res = await scope(async (tx) => {
          const [incoming] = await tx.select().from(incomingComments).where(eq(incomingComments.id, incomingCommentId));
          if (!incoming) return null;
          return dontReply(tx, {
            incomingCommentId,
            expectedStatus: incoming.status,
            expectedRequestVersion: incoming.draftRequestVersion,
            reply: cas,
            by: "agent",
          });
        });
        if (res === null) return refuse("not_found", "Their reply is not in this organization.", 404);
        return res.ok ? done(ref, verdict, { status: res.status, version: res.requestVersion }) : mutationRefusal(res);
      }
      if (row.kind === "room_reply") {
        // A no is always the owner's to give; it lands as the canonical rejection.
        const decided = await decideMessage(
          scope,
          { messageId: id, verdict: "reject", decisionOrigin: "agent", expectedStatus: row.status, expectedRequestVersion: row.version },
          { llm: null },
        );
        return decided.ok ? done(ref, verdict, { status: "rejected", kind: decided.kind }) : decisionRefusal(decided);
      }
      return notSupported(verdict, row.kind);
    }
    case "unskip": {
      if (row.kind !== "reply" || row.incomingCommentId === null) return notSupported(verdict, `a ${row.kind} message; use the turn: ref`);
      const incomingId = row.incomingCommentId;
      const res = await scope(async (tx) => {
        const { incoming, reply } = await lockReplyTurn(tx, incomingId);
        if (!incoming || !reply || reply.id !== id) return refuse("not_found", "That reply no longer exists.", 404);
        if (reply.status !== row.status || reply.redraftRequestVersion !== row.version) return stale({ status: reply.status, version: reply.redraftRequestVersion });
        return undoDontReply(tx, { incomingCommentId: incomingId, expectedRequestVersion: incoming.draftRequestVersion, by: "agent" });
      });
      if ("content" in res) return res;
      return res.ok ? done(ref, verdict, { status: res.status, version: res.requestVersion }) : mutationRefusal(res);
    }
    case "restore": {
      const res = await locked((tx) => restoreMessageOp(tx, id));
      if ("content" in res) return res;
      if (res.ok) return done(ref, verdict, { status: "proposed" });
      return res.error === "not_rejected"
        ? refuse("invalid_state", "Only a rejected draft can be restored.")
        : refuse("not_found", `message ${id} is not in this organization.`, 404);
    }
    case "retry": {
      const res = await scope((tx) =>
        text ? reopenFailedMessage(tx, { ...cas, text }) : retryDefinitiveMessageFailure(tx, cas),
      );
      return res.ok ? done(ref, verdict, { status: res.status, version: res.requestVersion }) : mutationRefusal(res);
    }
    case "post_now": {
      const res = await locked((tx) => postNowApprovedOp(tx, id));
      if ("content" in res) return res;
      if (res.ok) return done(ref, verdict, { kind: res.kind, note: "Moved to now; it sends only after the send gates pass." });
      return res.reason === "not_found"
        ? refuse("not_found", `message ${id} is not in this organization.`, 404)
        : refuse("invalid_state", `The message is ${res.currentStatus}; only an approved one can move to now.`);
    }
    case "unschedule": {
      const res = await locked((tx) => (input.likeWithSend === false ? dropScheduledLikeOp(tx, id) : unscheduleMessageOp(tx, id)));
      if ("content" in res) return res;
      if (res.ok) return done(ref, verdict, input.likeWithSend === false ? { like: "dropped" } : { status: "proposed" });
      return res.reason === "not_found"
        ? refuse("not_found", `message ${id} is not in this organization.`, 404)
        : res.reason === "going_out"
          ? refuse("going_out", "It is already going out, so it can no longer be unscheduled.")
          : refuse("not_scheduled", "It is no longer scheduled.");
    }
  }
}

/** Take back a Don't reply on one exact turn. */
async function undoSkip(ctx: McpCtx, input: DecideInput, incomingCommentId: number, ref: string): Promise<CallToolResult> {
  const res = await withOrg(ctx.organizationId, async (tx) => {
    const { incoming } = await lockReplyTurn(tx, incomingCommentId);
    if (!incoming) return null;
    if (!sameView(input, { status: incoming.status, version: incoming.draftRequestVersion })) {
      return stale({ status: incoming.status, version: incoming.draftRequestVersion });
    }
    return undoDontReply(tx, {
      incomingCommentId,
      expectedRequestVersion: incoming.draftRequestVersion,
      by: "agent",
    });
  });
  if (res === null) return refuse("not_found", "Their reply is not in this organization.", 404);
  if ("content" in res) return res;
  return res.ok ? done(ref, "unskip", { status: res.status, version: res.requestVersion }) : mutationRefusal(res);
}

async function decideOnTurn(call: Call, input: DecideInput, id: number): Promise<CallToolResult> {
  const { ctx } = call;
  const ref = `turn:${id}`;
  if (input.verdict === "unskip") return undoSkip(ctx, input, id, ref);
  if (input.verdict !== "skip") return notSupported(input.verdict, "a turn");
  const res = await withOrg(ctx.organizationId, async (tx) => {
    const { incoming, reply } = await lockReplyTurn(tx, id);
    if (!incoming) return null;
    if (!sameView(input, { status: incoming.status, version: incoming.draftRequestVersion })) {
      return stale({ status: incoming.status, version: incoming.draftRequestVersion });
    }
    return dontReply(tx, {
      incomingCommentId: id,
      expectedStatus: incoming.status as IncomingComment["status"],
      expectedRequestVersion: incoming.draftRequestVersion,
      reply: reply
        ? { messageId: reply.id, expectedStatus: reply.status, expectedRequestVersion: reply.redraftRequestVersion }
        : null,
      by: "agent",
    });
  });
  if (res === null) return refuse("not_found", "Their reply is not in this organization.", 404);
  if ("content" in res) return res;
  return res.ok ? done(ref, "skip", { status: res.status, version: res.requestVersion }) : mutationRefusal(res);
}

async function decideOnAction(call: Call, input: DecideInput, id: number): Promise<CallToolResult> {
  const { ctx } = call;
  const { verdict, text } = input;
  const actor = mcpOperationActor(ctx);
  const ref = `act:${id}`;
  if (!["approve", "edit", "reject", "skip", "unschedule"].includes(verdict)) return notSupported(verdict, "an action");
  if (input.version !== undefined) return refuse("version_not_supported", "An action has no version token.", 400);
  if (verdict === "edit" && !text) return textRequired(verdict);
  try {
    return await withOrg(ctx.organizationId, async (tx) => {
      const [row] = await tx
        .select({ status: actionRow.status })
        .from(actionRow)
        .where(eq(actionRow.id, id)).for("update");
      if (!row) return refuse("action_not_found", `action ${id} is not in this organization.`, 404);
      if (input.expectedStatus !== undefined && input.expectedStatus !== row.status) return stale(row);
      if (verdict === "approve" || verdict === "edit") {
        // Words an agent relays stay unattended work: an agent is not the owner writing.
        if (text !== undefined) await editAction(tx, { id, text, byOwner: false });
        const { action, approval } = await approveAction(tx, { id, approver: `owner:${actor}` });
        return done(ref, verdict, { status: action.status, approvalExpiresAt: approval.expiresAt });
      }
      if (verdict === "unschedule") {
        const action = await unscheduleAction(tx, { id });
        return done(ref, verdict, { status: action.status });
      }
      const action = await rejectAction(tx, { id, by: actor, ...(input.reason ? { reason: input.reason } : {}) });
      return done(ref, verdict, { status: action.status });
    });
  } catch (error) {
    return domainRefusal(error);
  }
}

async function decideOnPerson(call: Call, input: DecideInput, key: string): Promise<CallToolResult> {
  if (input.verdict !== "approve") return notSupported(input.verdict, "a person");
  if (input.version !== undefined) return refuse("version_not_supported", "A conversation has no version token.", 400);
  try {
    return await withOrg(call.ctx.organizationId, async (tx) => {
      const person = await findPerson(tx, key);
      if (!person) return refuse("not_found", "No such person.", 404);
      if (person.conversationId === null) {
        return refuse("conversation_not_found", "That person has no conversation waiting on a review.", 404);
      }
      const [view] = await tx.select({ status: conversations.opsStatus })
        .from(conversations).where(eq(conversations.id, person.conversationId)).for("update");
      if (!view) return refuse("conversation_not_found", "That conversation no longer exists.", 404);
      if (input.expectedStatus !== undefined && input.expectedStatus !== view.status) return stale(view);
      const conversation = await resolveConversationReview(tx, { conversationId: person.conversationId });
      return done(`person:${key}`, "approve", { conversationId: conversation.id, opsStatus: conversation.opsStatus });
    });
  } catch (error) {
    return domainRefusal(error);
  }
}

async function decideOnOffer(call: Call, input: DecideInput, productId: number): Promise<CallToolResult> {
  if (input.verdict !== "approve") return notSupported(input.verdict, "an offer");
  if (input.version !== undefined) return refuse("version_not_supported", "An offer uses its contentHash as expectedStatus; it has no version token.", 400);
  const contentHash = input.expectedStatus;
  if (!contentHash) {
    return refuse(
      "content_hash_required",
      "Approve an offer's words exactly as shown: pass its contentHash as expectedStatus.",
      400,
      "Read the product again, show the owner its words, and approve that contentHash on their word.",
    );
  }
  try {
    const offer = await withOrg(call.ctx.organizationId, async (tx) => {
      const [view] = await tx.select({ contentHash: offers.contentHash }).from(offers).where(eq(offers.productId, productId)).for("update");
      if (view && view.contentHash !== contentHash) return stale({ status: view.contentHash });
      return approveOffer(tx, { productId, contentHash }, { approver: mcpOperationActor(call.ctx), now: Date.now() });
    });
    if ("content" in offer) return offer;
    return done(`offer:${productId}`, "approve", { offer });
  } catch (error) {
    return domainRefusal(error);
  }
}

async function decideOnInvitation(call: Call, input: DecideInput, id: number): Promise<CallToolResult> {
  if (input.verdict !== "reject" && input.verdict !== "skip") return notSupported(input.verdict, "a request");
  if (input.version !== undefined) return refuse("version_not_supported", "A request has no version token.", 400);
  try {
    const invitation = await withOrg(call.ctx.organizationId, async (tx) => {
      const [view] = await tx.select({ status: incomingInvitations.status })
        .from(incomingInvitations).where(eq(incomingInvitations.id, id)).for("update");
      if (!view) return null;
      if (input.expectedStatus !== undefined && input.expectedStatus !== view.status) return stale(view);
      return dismissInvitation(tx, { id, by: mcpOperationActor(call.ctx) });
    });
    if (!invitation) return refuse("not_found", "That request no longer exists.", 404);
    if ("content" in invitation) return invitation;
    return done(`inv:${id}`, input.verdict, { status: invitation.status });
  } catch (error) {
    return domainRefusal(error);
  }
}

const resolveInput = z.object({
  ref: z.string().describe("msg: or act: and its id."),
  observed: z.enum(["went_out", "not_sent"]).describe("What the owner saw."),
  urn: z.string().trim().min(1).max(500).optional().describe("The urn the owner saw, for a send that went out."),
  target: z.string().trim().min(1).max(500).optional().describe("The exact target the owner looked at."),
});

const OUTCOME_RECOVERY: Partial<Record<Exclude<OutcomeResult, { ok: true }>["reason"], string>> = {
  owner_required: "Ask the owner to look on LinkedIn and say which it was on the person in Inbox, or on the LinkedIn channel's Overview when it holds sending.",
  stale_state: "Read it again with list_activity and decide on what it is now.",
  in_flight: "It was sent a moment before an update and may still be going out. Ask again in two minutes.",
};

function outcomeResult(ref: string, observed: string, result: OutcomeResult): CallToolResult {
  if (result.ok) return jsonResult({ ok: true, ref, observed, status: result.status });
  return errorResult(result.detail, {
    code: result.reason === "owner_required" ? "owner_surface_required" : result.reason,
    status: result.reason === "not_found" ? 404 : result.reason === "urn_required" ? 400 : 409,
    ...(OUTCOME_RECOVERY[result.reason] ? { recovery: OUTCOME_RECOVERY[result.reason] } : {}),
    ...(result.currentStatus !== undefined ? { data: { currentStatus: result.currentStatus, currentVersion: result.currentVersion ?? null } } : {}),
  });
}

async function resolveOn(call: Call, input: z.infer<typeof resolveInput>, kind: "msg" | "act", id: number): Promise<CallToolResult> {
  const { ctx } = call;
  const ref = `${kind}:${id}`;
  // An action is settled on the exact target the owner looked at; a comment, on
  // the urn it posted as.
  const urn = input.urn ?? input.target;
  try {
    const result = await withOrg(ctx.organizationId, async (tx) => {
      const first = await resolveOutcome(tx, {
        ref: { kind, id }, observed: input.observed, ...(urn ? { urn } : {}), by: `owner:${mcpOperationActor(ctx)}`, viaAgent: true,
      });
      if (kind !== "msg" || first.ok || first.reason !== "not_uncertain") return first;
      // The like a send carried can be the uncertain part of an otherwise settled send.
      const [like] = await tx
        .select({ id: actionRow.id })
        .from(actionRow)
        .where(and(eq(actionRow.messageId, id), eq(actionRow.kind, "like_target"), eq(actionRow.status, "uncertain")))
        .orderBy(desc(actionRow.id))
        .limit(1);
      if (!like) return first;
      return resolveOutcome(tx, { ref: { kind: "act", id: like.id }, observed: input.observed, ...(urn ? { urn } : {}), by: `owner:${mcpOperationActor(ctx)}`, viaAgent: true });
    });
    return outcomeResult(ref, input.observed, result);
  } catch (error) {
    return domainRefusal(error);
  }
}

/** One item decided, as its kind decides it. */
async function decideOn(call: Call, input: DecideInput, raw: string): Promise<CallToolResult> {
  const ref = parseRef(raw, ["msg", "act", "turn", "person", "offer", "inv"]);
  switch (ref.kind) {
    case "msg":
      return decideOnMessage(call, input, ref.id);
    case "act":
      return decideOnAction(call, input, ref.id);
    case "turn":
      return decideOnTurn(call, input, ref.id);
    case "person":
      return decideOnPerson(call, input, ref.key);
    case "offer":
      return decideOnOffer(call, input, ref.id);
    case "inv":
      return decideOnInvitation(call, input, ref.id);
    default:
      throw new Error("unreachable: parseRef admits only the kinds listed");
  }
}

/** A refusal's code and words, as `errorResult` wrote them. */
function errorOf(result: CallToolResult): { code: string; message: string } {
  const text = result.content.find((part) => part.type === "text");
  try {
    const body = JSON.parse(text?.type === "text" ? text.text : "{}") as { code?: unknown; error?: unknown };
    return { code: typeof body.code === "string" ? body.code : "refused", message: typeof body.error === "string" ? body.error : "" };
  } catch {
    return { code: "refused", message: text?.type === "text" ? text.text.slice(0, 200) : "" };
  }
}

export const decisionTools: readonly V2Tool[] = [
  defineTool({
    name: "decide",
    kind: "write",
    description:
      "Relay the owner's yes or no on a draft, action, turn, person, offer or request. Never presses LinkedIn. Only on the owner's word. See engager-people.",
    input: decideInput,
    handler: async (call, input) => {
      if ((input.ref === undefined) === (input.refs === undefined)) return refuse("invalid_request", "Give ref or refs.", 400);
      if (input.ref !== undefined) return decideOn(call, input, input.ref);
      // The owner's one word on many items. Each is decided as it would be
      // alone — its own gates, its own refusal — and a refusal stops that item
      // and no other. Nothing here is a filter: the owner's yes covers the
      // items named, never "whatever matches".
      const { refs, text, variant, expectedStatus, version } = input;
      if (!MANY_VERDICTS.includes(input.verdict)) return refuse("invalid_request", `Many items take ${MANY_VERDICTS.join(", ")}.`, 400);
      if ([text, variant, expectedStatus, version].some((own) => own !== undefined)) return refuse("invalid_request", "Words, a variant and a view belong to one item.", 400);
      const decided: string[] = [];
      const refused: Array<{ ref: string; code: string; message: string }> = [];
      for (const ref of new Set(refs)) {
        const result = await decideOn(call, input, ref);
        if (!result.isError) decided.push(ref);
        else refused.push({ ref, ...errorOf(result) });
      }
      return jsonResult({ verdict: input.verdict, decided: decided.length, refs: decided, refused });
    },
  }),
  defineTool({
    name: "resolve_outcome",
    kind: "linkedin",
    description:
      "Settle one uncertain send from what the owner saw: went_out, or not_sent for a comment or reply (an action's not_sent is the owner's). Never retries.",
    input: resolveInput,
    handler: async (call, input) => {
      const ref = parseRef(input.ref, ["msg", "act"]);
      if (ref.kind !== "act" && ref.kind !== "msg") throw new Error("unreachable: parseRef admits only msg and act");
      return resolveOn(call, input, ref.kind, ref.id);
    },
  }),
];
