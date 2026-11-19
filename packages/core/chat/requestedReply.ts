import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { incomingComments, messages, type IncomingComment, type Message } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { replyWordsInput } from "../agentStep/writing";
import { writeConversationWords } from "../dispatcher/conversationWords";
import { prepareReplyDraft, type PreparedReplyDraft } from "../draft";
import { replyCampaign, submitClientReply, type DurableDraftRequest } from "../operations/clientDrafting";
import type { BoxWords, ComposerAsk, RequestedReplyDraft } from "./requestedDraft";
import { runSpokenWords } from "./requestedWords";

/**
 * A REPLY DRAFT THE OWNER ASKED FOR — the Inbox's Draft for me, on a reply
 * only they can answer, or its Redraft, on a draft that waits for their yes —
 * written by their own agent in the chat dock and delivered as a proposal
 * waiting for Approve once.
 *
 * The app owns the request, the context and the delivery; the agent writes
 * one reply. Its words come from the exact prompt the managed writer and the
 * runner's reply lane render (`assembleReplyDraftingContext` with no server
 * cognition), and they land through the canonical reply intake against the
 * owner's own durable request with `forceProposal`, so no Reply mode — not
 * even Automatic — can approve what the owner asked only to see.
 *
 * Two asks are the owner's: one filed on the reply (`requestIncomingReplyDraft`)
 * and one filed on the draft that waits on it (`requestMessageRedraft`). A
 * reply draft is never the Ambassador's to redo (`workers/commentRedraft.ts`
 * takes comments only), so its Redraft is written here, beside the words it
 * replaces, as a comment's is beside the Ambassador's.
 */

/** What the reply is written from, and the owner's open request it answers. */
export type PreparedRequestedReply = {
  incomingCommentId: number;
  request: DurableDraftRequest;
  draft: PreparedReplyDraft;
  /** On a redraft, the draft's words it replaces; null on a first draft. */
  replacing: string | null;
};

/** What delivering one written reply came to. `linted` is the intake's
 *  deterministic check turning the words down, which leaves the request open
 *  for one rewrite. */
export type RequestedReplyOutcome =
  | { kind: "saved"; messageId: number; status: string }
  | { kind: "linted"; violations: string[] }
  | { kind: "refused"; error: string };

export const RequestedReplyText = z.object({ text: z.string().trim().min(1).max(1250) }).strict();

/** What a redraft is asked beside the words it replaces. */
const REDRAFT_NOTE = "The owner asked for a different reply than this draft. Write a new one; do not reword this.";

/** The owner's open ask on a reply: a first draft asked of the reply, or a
 *  redraft asked of the draft that waits on it; null where neither is open. */
function openReplyRequest(incoming: IncomingComment, reply: Message | undefined): DurableDraftRequest | null {
  if (incoming.status === "new" && incoming.draftRequestId != null) {
    return {
      target: "incoming",
      targetId: incoming.id,
      requestId: incoming.draftRequestId,
      requestVersion: incoming.draftRequestVersion,
      status: incoming.status,
    };
  }
  if (reply?.kind === "reply" && reply.status === "proposed" && reply.redraftRequestId != null) {
    return {
      target: "message",
      targetId: reply.id,
      requestId: reply.redraftRequestId,
      requestVersion: reply.redraftRequestVersion,
      status: reply.status,
    };
  }
  return null;
}

/** The request's reply, read to write from; refused once no request of the
 *  owner's is open on it — cancelled, answered or dismissed since. */
export async function prepareRequestedReply(
  tx: Tx,
  request: RequestedReplyDraft,
): Promise<PreparedRequestedReply> {
  const [incoming] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, request.incomingCommentId));
  const [reply] = incoming
    ? await tx.select().from(messages).where(eq(messages.incomingCommentId, incoming.id))
    : [];
  const open = incoming && incoming.removedAt == null ? openReplyRequest(incoming, reply) : null;
  if (!incoming || !open) throw new Error("reply_request_closed");
  const campaign = await replyCampaign(tx, reply ?? incoming);
  if (!campaign) throw new Error("reply_campaign_missing");
  return {
    incomingCommentId: incoming.id,
    request: open,
    draft: await prepareReplyDraft(tx, incoming, campaign),
    replacing: open.target === "message" && reply ? (reply.finalText ?? reply.proposedText) : null,
  };
}

/**
 * One written reply, delivered against the request it answers: a proposal,
 * always. A request the owner cancelled while the agent wrote takes nothing,
 * and neither does a reply that has an answer of ours on its way, or a draft
 * the owner decided, rewrote or skipped since asking for its redraft.
 */
export async function submitRequestedReply(
  tx: Tx,
  asked: { incomingCommentId: number; request: DurableDraftRequest },
  text: string,
): Promise<RequestedReplyOutcome> {
  const { incomingCommentId, request } = asked;
  // The reply first, then its draft: the intake's own lock order.
  const [incoming] = await tx
    .select({ draftRequestId: incomingComments.draftRequestId })
    .from(incomingComments)
    .where(eq(incomingComments.id, incomingCommentId))
    .for("update");
  const [reply] =
    request.target === "message"
      ? await tx
          .select({ redraftRequestId: messages.redraftRequestId })
          .from(messages)
          .where(and(eq(messages.id, request.targetId), eq(messages.incomingCommentId, incomingCommentId)))
          .for("update")
      : [];
  const open =
    request.target === "message"
      ? reply?.redraftRequestId === request.requestId
      : incoming?.draftRequestId === request.requestId;
  if (!incoming || !open) {
    return { kind: "refused", error: "The request was cancelled or answered, so the draft was not saved." };
  }
  const result = await submitClientReply(
    tx,
    { incomingCommentId, text },
    { forceProposal: true, durableRequest: request, requireFrozenRequest: true, keepsSensitivity: true },
  );
  if (!result.ok) {
    return {
      kind: "refused",
      error: result.details?.recovery ? `${result.error} ${result.details.recovery}` : result.error,
    };
  }
  const data = result.data as {
    messageId: number | null;
    alreadyExisted?: boolean;
    redrafted?: boolean;
    status: string;
    violations?: Array<{ detail: string }>;
  };
  if (data.messageId == null) {
    return { kind: "linted", violations: (data.violations ?? []).map((violation) => violation.detail) };
  }
  if (data.alreadyExisted && !data.redrafted) {
    return { kind: "refused", error: "This reply already has an answer on its way, so the draft was not saved." };
  }
  return { kind: "saved", messageId: data.messageId, status: data.status };
}

/**
 * What recovery reads for an interrupted delivery. The delivery is one
 * transaction that consumes the request — filed on the reply, or on its
 * draft — clearing it and keeping its version, into the reply's one row; a
 * cancel, or a newer request, moves the version instead. So the request gone
 * at its own version, with a reply row there, is the delivery applied, and
 * anything else is nothing written: a turned-down row from before the request
 * is not its answer.
 */
export async function settledRequestedReply(
  tx: Tx,
  step: { incomingCommentId: number; target: DurableDraftRequest["target"]; requestVersion: number },
): Promise<Record<string, unknown>> {
  const [incoming] = await tx
    .select({ requestId: incomingComments.draftRequestId, version: incomingComments.draftRequestVersion })
    .from(incomingComments)
    .where(eq(incomingComments.id, step.incomingCommentId));
  const [reply] = await tx
    .select({
      id: messages.id,
      status: messages.status,
      redraftRequestId: messages.redraftRequestId,
      redraftRequestVersion: messages.redraftRequestVersion,
    })
    .from(messages)
    .where(eq(messages.incomingCommentId, step.incomingCommentId));
  const consumed =
    step.target === "message"
      ? reply?.redraftRequestId === null && reply.redraftRequestVersion === step.requestVersion
      : incoming?.requestId === null && incoming.version === step.requestVersion;
  return consumed && reply ? { messageId: reply.id, status: reply.status } : { recovered: "not_applied" };
}

/** The reply to word an answer to, for the owner's own box; refused once it
 *  is answered or gone. One the owner dismissed is theirs to answer, so words
 *  are written for it. Nothing is filed on it: the words are the owner's raw
 *  material, so no request, row or wake records them, and a reply Engager
 *  holds stays held. */
export async function prepareReplyWords(tx: Tx, request: RequestedReplyDraft) {
  const [incoming] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, request.incomingCommentId));
  if (!incoming || incoming.removedAt != null || incoming.status === "replied") {
    throw new Error("reply_request_closed");
  }
  const campaign = await replyCampaign(tx, incoming);
  if (!campaign) throw new Error("reply_campaign_missing");
  return prepareReplyDraft(tx, incoming, campaign);
}

/**
 * The owner's-box workflow: read the reply, have the dispatcher write one
 * answer through the owner's agent, and hand the words back as the turn's last
 * text. Nothing is delivered — what the owner saves is theirs, measured at the
 * save for how much of these words it kept (`saveOwnerReply`). An angle the
 * composer asked for (`ask`) rides beside the conversation.
 */
export async function runReplyWords(deps: {
  organizationId: string;
  request: RequestedReplyDraft;
  llm: LLM;
  progress: (text: string) => void;
  active?: () => Promise<void>;
  ask?: ComposerAsk;
}): Promise<BoxWords> {
  deps.progress("Reading the conversation and your voice…");
  await deps.active?.();
  const prepared = await withOrg(deps.organizationId, (tx) => prepareReplyWords(tx, deps.request));
  return runSpokenWords({
    ...deps,
    text: RequestedReplyText,
    input: replyWordsInput(prepared),
  });
}

/**
 * The app-owned workflow: read the reply, have the dispatcher write one answer
 * through the owner's agent, deliver it as a proposal. The intake's
 * deterministic check may turn the words down once, and the dispatcher writes
 * them again against what it named; a second refusal ends the turn with the
 * request still open, for the owner to cancel or ask again.
 */
export async function runRequestedReplyDraft(deps: {
  organizationId: string;
  llm: LLM;
  prepare: () => Promise<PreparedRequestedReply>;
  submit: (prepared: PreparedRequestedReply, text: string) => Promise<RequestedReplyOutcome>;
  progress: (text: string) => void;
  active?: () => Promise<void>;
}): Promise<string> {
  deps.progress("Reading the conversation and your voice…");
  await deps.active?.();
  const prepared = await deps.prepare();
  let violations: string[] | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    deps.progress(attempt ? "Rewriting the draft to pass the check…" : "Writing your reply…");
    const input = replyWordsInput(prepared.draft);
    const words = await writeConversationWords({
      ...input,
      organizationId: deps.organizationId,
      llm: deps.llm,
      ownerRequested: true,
      ...(prepared.replacing === null ? {} : { ask: { note: REDRAFT_NOTE, replacing: prepared.replacing } }),
      ...(violations ? { rules: [...(input.rules ?? []), `The intake's check turned the last draft down for: ${violations.join("; ")}. Write the reply so none of these apply.`] } : {}),
      ...(deps.active ? { continueRun: async () => (await deps.active!(), true) } : {}),
    });
    if (words === null) throw new Error("draft_stopped");
    const outcome = await deps.submit(prepared, words.text);
    if (outcome.kind === "saved") {
      return "Your reply draft is ready on their reply in the Inbox. Nothing is sent until you approve it.";
    }
    if (outcome.kind === "refused") throw new Error(outcome.error);
    violations = outcome.violations;
  }
  throw new Error("reply_draft_not_accepted");
}
