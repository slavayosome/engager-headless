import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@engager/common/errors";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  actions,
  campaigns,
  incomingComments,
  conversationEvents,
  conversations,
  messages,
  productFacts,
  stepRuns,
  stepToolCalls,
  type Campaign,
  type IncomingComment,
  type ConversationEventRow,
  type ConversationRow,
  type Message,
  type ProductFact,
  type StepDraft,
  type StepRunRow,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { isDmRefusal, reserveDirectMessage, type DmRefusal } from "../actions/dm";
import { invitationRefusal, reserveInvitation, roomInvitationAdmission } from "../actions/invite";
import { personKey } from "../actions/keys";
import { candidateRefusal, reserveAction, type ReserveOutcome } from "../actions/ledger";
import { likeTargetFor, likeableRecorded, type LikeConversation } from "../actions/likeTarget";
import { queueAutomaticReply } from "../actions/reply";
import type { LLM } from "../ai/client";
import { recordPrompt, untrusted } from "../ai/prompts";
import { loadStrategy } from "./select";
import { readingOf, sensitivityRow } from "../ai/reading";
import { assignSlots } from "../operations/schedule";
import type { BindingMode, TargetType } from "../strategy/catalog";
import type { CampaignAgentStrategy, StrategyStep } from "../strategy/contract";
import { notUnscheduledByOwner } from "../operations/messages";
import { dedupeKey } from "../posting";
import { approvedOffer, unsupportedOfferClaim } from "../products/offers";
import { modeFor } from "../strategy/mode";
import { roomContinuationRefusal } from "../rooms/continuation";
import { firstUnusableFact } from "./freshness";
import { draftRoomReply } from "./roomDispatch";
import type { StepInput } from "./input";
import type { ProposedToolCall } from "./result";
import { ledgerKindOf, type DiscardReason, type DispatchableTool, type ReservableTool } from "./validate";
import {
  conversationSource,
  dmWritingRevision,
  exchangeSource,
  factsBoundToNote,
  noteSource,
  noteWritingRevision,
  keepReading,
  prepareStepReply,
  stepReplyWritingRevision,
  writeStepDm,
  writeStepNote,
  writeStepReply,
} from "./writing";

/**
 * THE SERVER'S HALF OF A TOOL CALL — the reads and drafts a validated call
 * may become, and nothing that reaches a person: a send above Off is a
 * reservation on the action ledger (`reserveCall`) — a Like, an Invite with
 * the note the server drafts for it, a DM — which only the dispatch gate ever
 * clicks, after the owner's yes at Ask me or on its own at Automatic, within
 * the account's ceiling; or a Reply, as the draft it names on `messages`
 * (`proposeReply`), which the owner's yes at Ask me, or its own mode at
 * Automatic, hands to the action ledger, paced by the day plan. Every
 * call leaves a `step_tool_calls` row written in the same transaction as
 * whatever it produced, so a draft and the record of it commit together or
 * not at all.
 *
 * Reads are of the rows the server already holds — the thread the conversation's
 * reads recorded, the profile it fetched — so a read spends nothing on the
 * account. A draft goes through the existing drafting modules with the step's
 * instructions as its angle, in the campaign's voice as its strategy states
 * it (`writing.ts`), after the facts it is bound to and its CTA pass:
 * a stale fact, or a CTA asset the owner has not approved as it stands,
 * refuses the draft before a word is written (spec §18 R14). Whatever the
 * step bound, no drafter is handed a stale fact of the campaign's own: a DM's
 * product context drops them, and a reply loses
 * the compiled brief, which was written over all of them. A public reply lands
 * where every reply lands, on `messages` (`replyLanding`): `proposed`, never
 * approved by the draft itself;
 * a DM has no row of its own and is held on its checkpoint. An
 * automated draft is never a voice sample (INV-7) and never `leads.dmDraft`.
 *
 * Idempotent on the checkpoint: a reply the thread already has, or a DM the
 * checkpoint already holds, is handed back rather than drafted again — except
 * a worker's reply written for words the person has since edited, which is
 * drafted afresh in its place (`answersOldWords`).
 */

export type DispatchRefusal =
  | "stale_fact"
  | "cta_unapproved"
  | "cta_claim_unsupported"
  | "guard_moved"
  | "reservation_refused";

export type DispatchOutcome =
  | { kind: "dispatched"; detail: string; resultRef: string | null; drafted: boolean }
  | {
      kind: "refused";
      reason: DispatchRefusal;
      ref: string;
      /** A DM rule the step is told about and may plan around — wait, then
       *  try again — rather than one that ends it (`actions/dm.ts`). */
      rule?: DmRefusal;
    };

export type CallRecord = {
  checkpoint: Pick<StepRunRow, "id">;
  runId: number;
  iteration: number;
  call: ProposedToolCall;
  digest: string;
};

/** Write one call's row. `reason` null is a dispatch; `ProposedToolCall`'s
 *  free text is bounded here, where it becomes a column. */
export async function recordCall(
  tx: Tx,
  record: CallRecord,
  outcome: { reason: DiscardReason | DispatchRefusal | null; resultRef: string | null },
): Promise<void> {
  await tx.insert(stepToolCalls).values({
    stepRunId: record.checkpoint.id,
    runId: record.runId,
    iteration: record.iteration,
    callId: record.call.call_id,
    tool: record.call.tool.slice(0, 64),
    toolVersion: record.call.version,
    targetKind: record.call.target.kind.slice(0, 32),
    targetRef: record.call.target.ref.slice(0, 300),
    callDigest: record.digest,
    outcome: outcome.reason === null ? "dispatched" : "discarded",
    reason: outcome.reason,
    resultRef: outcome.resultRef,
    createdAt: Date.now(),
  });
}

export type DispatchContext = {
  continueRun?: () => Promise<boolean>;
  organizationId: string;
  record: CallRecord;
  tool: DispatchableTool;
  step: StrategyStep;
  stepInput: StepInput;
  campaignId: number;
  /** The person the step is working, on the account it works them from. */
  conversation: Pick<ConversationRow, "id" | "channelId" | "authorProfileId">;
  /** The event the step answers. */
  event: Pick<ConversationEventRow, "id" | "type">;
  /** The pause generation the wake's plan was made under. */
  generationSeen: number;
  strategyVersion: number;
  /** The campaign's voice as its strategy states it: every draft is
   *  written in it (`strategy/draftingVoice.ts`). */
  voice: CampaignAgentStrategy["voice"];
  llm: LLM;
  now: number;
  /** Set when the server drafts the reply itself, as the step's only action
   *  (`directReply.ts`): the Reply's mode, so the draft lands as the Reply
   *  would put it — Automatic approved for the day plan, Ask me waiting for
   *  the owner's yes. An agent's draft leaves this out, and its Reply call
   *  decides. */
  replyMode?: "review" | "auto";
};

export async function dispatchCall(ctx: DispatchContext): Promise<DispatchOutcome> {
  switch (ctx.tool) {
    case "read_thread":
    case "read_profile": {
      const detail =
        ctx.tool === "read_thread"
          ? (ctx.stepInput.thread ?? "The thread is no longer verifiable.")
          : ctx.stepInput.profile;
      await withOrg(ctx.organizationId, (tx) =>
        recordCall(tx, ctx.record, { reason: null, resultRef: null }),
      );
      return { kind: "dispatched", detail, resultRef: null, drafted: false };
    }
    case "draft_comment":
    case "draft_dm": {
      const refused = await draftRefusal(ctx);
      if (refused) {
        await withOrg(ctx.organizationId, (tx) =>
          recordCall(tx, ctx.record, { reason: refused.reason, resultRef: refused.ref }),
        );
        return refused;
      }
      return ctx.tool === "draft_comment"
        ? ctx.record.call.target.kind === "room_comment" ? draftRoomReply(ctx) : draftReply(ctx)
        : draftDm(ctx);
    }
  }
}

/** The fact ids a draft is bound to. */
function boundFactIds(call: ProposedToolCall): number[] {
  return call.inputs
    .filter((input) => input.name === "facts" && input.source === "context")
    .flatMap((input) => input.ids.map(Number));
}

/** Facts re-read at the moment of the draft: one deleted since the step was
 *  handed it is as unusable as a stale one. */
async function boundFacts(ctx: DispatchContext): Promise<ProductFact[]> {
  const ids = boundFactIds(ctx.record.call);
  if (ids.length === 0) return [];
  return withOrg(ctx.organizationId, (tx) =>
    tx.select().from(productFacts).where(inArray(productFacts.id, ids)),
  );
}

async function draftRefusal(
  ctx: DispatchContext,
): Promise<Extract<DispatchOutcome, { kind: "refused" }> | null> {
  const ids = boundFactIds(ctx.record.call);
  const facts = await boundFacts(ctx);
  const unusable = firstUnusableFact(ids, new Map(facts.map((fact) => [fact.id, fact])), ctx.now);
  if (unusable !== null) return { kind: "refused", reason: "stale_fact", ref: `fact:${unusable}` };
  // An offer is made in a DM, from an offer the owner approved (spec R14;
  // `draftDm` resolves it): a public reply makes none.
  const asset = ctx.record.call.cta_asset_id;
  if (asset !== null && ctx.tool !== "draft_dm") {
    return { kind: "refused", reason: "cta_unapproved", ref: `cta:${asset}` };
  }
  return null;
}

/** The reply the step answers, unchanged since the step was handed it, on a
 *  campaign still in the run mode the wake serves — or null when any of that
 *  moved. */
async function currentReply(
  tx: Tx,
  ctx: Pick<DispatchContext, "stepInput" | "campaignId">,
) {
  const handed = ctx.stepInput.incoming;
  if (!handed) return null;
  const [incoming] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, handed.id))
    .for("update");
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, ctx.campaignId));
  if (
    !incoming ||
    !campaign ||
    incoming.removedAt !== null ||
    incoming.textHash !== handed.textHash
  ) {
    return null;
  }
  if (await roomContinuationRefusal(tx, incoming, campaign.id, Date.now())) return null;
  return { incoming, campaign };
}

/** `currentReply` for a public answer: a reply the owner let go (`dontReply`)
 *  or one already answered has moved too. Read under the row lock the answer's
 *  row is written beneath, so a Don't reply either lands first, and no answer
 *  is written, or waits for it, and finds it. */
async function replyToAnswer(
  tx: Tx,
  ctx: Pick<DispatchContext, "stepInput" | "campaignId">,
) {
  const current = await currentReply(tx, ctx);
  if (!current || current.incoming.status === "dismissed" || current.incoming.status === "replied") {
    return null;
  }
  return current;
}

/**
 * Where a public reply a step drafts lands: `proposed`, a draft the Reply
 * proposal then decides (`proposeReply`). Null with Reply Off — the same
 * reading the owner's yes makes — where a draft would wait for a yes nobody
 * can give.
 */
async function replyLanding(tx: Tx, campaign: Campaign): Promise<"proposed" | null> {
  const mode = (await modeFor(tx, { campaignId: campaign.id, capability: "reply_public", target: "their_reply" })).effective;
  return mode === "review" || mode === "auto" ? "proposed" : null;
}

/** What deciding about an existing reply row reads of it. */
const REPLY_ROW = {
  id: messages.id,
  status: messages.status,
  publishOrigin: messages.publishOrigin,
  error: messages.error,
  redraftRequestVersion: messages.redraftRequestVersion,
};
type ReplyRow = Pick<Message, keyof typeof REPLY_ROW>;

/**
 * Whether a worker's reply row answers words the person no longer says, so
 * the owner must never be asked to approve it: withdrawn when the thread read
 * saw the edit (`reply_edited`), or still waiting for a yes though the step
 * that drafted it was handed another revision of the reply. The owner's own
 * reply, and one already decided, sent or drafted, stand as they
 * are.
 */
async function answersOldWords(
  tx: Tx,
  row: ReplyRow,
  incoming: Pick<IncomingComment, "textHash">,
  conversationId: number,
): Promise<boolean> {
  if (row.publishOrigin !== "worker") return false;
  if (row.status === "rejected") return row.error === "reply_edited";
  if (row.status !== "proposed") return false;
  const [drafting] = await tx
    .select({ drafts: stepRuns.drafts })
    .from(stepRuns)
    .where(
      and(
        eq(stepRuns.conversationId, conversationId),
        sql`${stepRuns.drafts} @> ${JSON.stringify([{ kind: "reply", messageId: row.id }])}::jsonb`,
      ),
    )
    .orderBy(desc(stepRuns.id))
    .limit(1);
  const draft = drafting?.drafts
    .filter((held) => held.kind === "reply" && held.messageId === row.id)
    .at(-1);
  return (
    draft?.kind === "reply" &&
    draft.replyTextHash !== undefined &&
    draft.replyTextHash !== incoming.textHash
  );
}

/** A worker's reply withdrawn for words the person no longer says — what the
 *  thread read does to one when it sees the edit. Undefined when the row
 *  moved since it was read. */
async function withdraw(tx: Tx, row: ReplyRow): Promise<ReplyRow | undefined> {
  const [withdrawn] = await tx
    .update(messages)
    .set({
      status: "rejected",
      scheduledAt: null,
      error: "reply_edited",
      redraftRequestId: null,
      redraftRequestVersion: row.redraftRequestVersion + 1,
      redraftRequestedAt: null,
      redraftRequestedBy: null,
      redraftRequestNote: null,
    })
    .where(
      and(
        eq(messages.id, row.id),
        eq(messages.status, "proposed"),
        eq(messages.redraftRequestVersion, row.redraftRequestVersion),
      ),
    )
    .returning(REPLY_ROW);
  return withdrawn;
}

/**
 * Draft a reply afresh into the row that answered older words: one reply row
 * per reply, so the new words supersede the old in place, waiting for a yes
 * again. The rewrite is filed as the server's own redraft request and
 * completed in the same transaction, so the row's revision log reads a redraft
 * for the edit, never an edit of the owner's. Undefined when the row moved
 * since it was read.
 */
async function redraftInPlace(
  tx: Tx,
  row: ReplyRow,
  written: Partial<typeof messages.$inferInsert>,
): Promise<{ id: number } | undefined> {
  const [filed] = await tx
    .update(messages)
    .set({
      redraftRequestId: randomUUID(),
      redraftRequestVersion: row.redraftRequestVersion + 1,
      redraftRequestedAt: Date.now(),
      redraftRequestedBy: "agent_step",
      redraftRequestNote: "their reply was edited",
    })
    .where(
      and(
        eq(messages.id, row.id),
        eq(messages.status, row.status),
        eq(messages.redraftRequestVersion, row.redraftRequestVersion),
        isNull(messages.redraftRequestId),
      ),
    )
    .returning({ id: messages.id });
  if (!filed) return undefined;
  const [redrafted] = await tx
    .update(messages)
    .set({
      ...written,
      finalText: null,
      scheduledAt: null,
      error: null,
      postingStartedAt: null,
      redraftRequestId: null,
      redraftRequestedAt: null,
      redraftRequestedBy: null,
      redraftRequestNote: null,
    })
    .where(eq(messages.id, row.id))
    .returning({ id: messages.id });
  return redrafted;
}

async function draftReply(ctx: DispatchContext): Promise<DispatchOutcome> {
  const target = ctx.record.call.target.ref;
  const prepared = await withOrg(ctx.organizationId, async (tx) => {
    const current = await replyToAnswer(tx, ctx);
    if (!current || await replyLanding(tx, current.campaign) === null) return { kind: "moved" as const };
    const [existing] = await tx
      .select(REPLY_ROW)
      .from(messages)
      .where(eq(messages.incomingCommentId, current.incoming.id));
    const stale =
      existing && (await answersOldWords(tx, existing, current.incoming, ctx.conversation.id))
        ? existing
        : null;
    if (existing && !stale) return { kind: "existing" as const, messageId: existing.id };
    // Out of Waiting for a yes before its replacement is written, so the old
    // words cannot be approved meanwhile.
    const replaces = stale?.status === "proposed" ? await withdraw(tx, stale) : stale;
    if (stale && !replaces) return { kind: "moved" as const };
    return {
      kind: "prepare" as const,
      prepared: await prepareStepReply(tx, {
        incoming: current.incoming,
        campaign: current.campaign,
        voice: ctx.voice,
        now: ctx.now,
        step: ctx.step,
      }),
      replaces,
    };
  });
  if (prepared.kind === "moved") return refuse(ctx, "guard_moved", `reply:${target}`);
  if (prepared.kind === "existing") {
    return keep(ctx, `message:${prepared.messageId}`, "A reply is already drafted for this.");
  }

  const facts = await boundFacts(ctx);
  const contextRevision = stepReplyWritingRevision(prepared.prepared, facts);
  const written = await writeStepReply(prepared.prepared, {
    organizationId: ctx.organizationId,
    step: ctx.step,
    facts,
    llm: ctx.llm,
  });
  if (written.kind === "held") {
    await withOrg(ctx.organizationId, async (tx) => {
      const current = await replyToAnswer(tx, ctx);
      if (current && written.reading) await keepReading(tx, current.incoming, written.reading);
    });
    return refuse(ctx, "reservation_refused", "sensitive_hold");
  }
  const { draft, sensitivity } = written;
  const read = written.reading ?? readingOf(prepared.prepared.incoming)!;
  const text = draft.text;

  return withOrg(ctx.organizationId, async (tx) => {
    const current = await replyToAnswer(tx, ctx);
    const landing = current ? await replyLanding(tx, current.campaign) : null;
    // At Automatic a reply the checks cleared goes to the day plan; one held,
    // or at Ask me waits as every reply does.
    const reply = current && ctx.replyMode ? await modeFor(tx, { campaignId: current.campaign.id,
      capability: "reply_public", target: "their_reply", stepId: ctx.step.step_id }) : null;
    const status =
      landing === "proposed" && ctx.replyMode === "auto" && reply?.effective === "auto" && !sensitivity.hold && current?.incoming.sensitivity !== "hold"
        ? ("approved" as const)
        : landing;
    if (!current || status === null ||
      await currentReplyWritingRevision(tx, current, ctx.step.step_id, facts.map(fact => fact.id), ctx.now) !== contextRevision) {
      await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: `reply:${target}` });
      return { kind: "refused" as const, reason: "guard_moved" as const, ref: `reply:${target}` };
    }
    const held = await heldConversation(tx, ctx);
    if (held) {
      await recordCall(tx, ctx.record, { reason: "reservation_refused", resultRef: held });
      return { kind: "refused" as const, reason: "reservation_refused" as const, ref: held };
    }
    // Like reply at Ask me rides with the answer, so the owner's one yes sends
    // both — the server's to add, never the model's to remember — but only to
    // a reply the reads that clear a like on sight clear: friendly and on
    // topic, nothing the sensitivity check holds. A hostile, spam, uncertain
    // or sensitive reply is answered, or not, without a like going with it.
    // At Automatic the reply was liked on sight, or held back from one.
    const [recorded] = await tx
      .select({ decision: conversationEvents.decision })
      .from(conversationEvents)
      .where(eq(conversationEvents.id, ctx.event.id));
    const likesWithAnswer =
      !sensitivity.hold &&
      likeableRecorded(recorded?.decision) &&
      (await modeFor(tx, { campaignId: current.campaign.id, capability: "like_target", target: "their_reply", catalogStep: "handle_reply" })).effective === "review";
    const promptVersionId = await recordPrompt(tx, "reply", draft.promptTemplate);
    const written = {
      proposedText: text,
      status,
      publishOrigin: "worker" as const,
      workerRunId: ctx.record.runId,
      promptVersionId,
      model: draft.model,
      draftPlanId: draft.planId,
      loopVersion: "agent_step",
      briefSourceHash: draft.briefSourceHash ?? null,
      briefAnchorIds: draft.briefAnchorIds ?? null,
    };
    let inserted: { id: number } | undefined;
    if (prepared.replaces) {
      inserted = await redraftInPlace(tx, prepared.replaces, written);
      if (!inserted) {
        await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: `reply:${target}` });
        return { kind: "refused" as const, reason: "guard_moved" as const, ref: `reply:${target}` };
      }
    } else {
      [inserted] = await tx
        .insert(messages)
        .values({
          ...written,
          kind: "reply",
          campaignId: current.campaign.id,
          incomingCommentId: current.incoming.id,
          targetProfileId: current.incoming.authorProfileId,
          dedupeKey: dedupeKey("reply", current.campaign.id, current.incoming.commentUrn),
          // Only a first draft carries it: a redraft keeps what the owner made
          // of the fold.
          ...(likesWithAnswer ? { likeWithSend: true } : {}),
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });
    }
    const [message] = inserted
      ? [inserted]
      : await tx
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.incomingCommentId, current.incoming.id));
    if (!message) throw new Error(`reply to incoming ${current.incoming.id}: neither inserted nor found`);
    if (inserted && status === "approved") {
      const slots = await assignSlots(tx, { campaign: current.campaign, items: [{ messageId: message.id, kind: "reply" }] });
      if (slots.length === 0) await tx.update(messages).set({ status: "proposed" }).where(eq(messages.id, message.id));
      else await queueAutomaticReply(tx, message.id);
    }
    await tx
      .update(incomingComments)
      .set({ ...sensitivityRow(sensitivity), reading: read, status: "reply_proposed" })
      .where(and(eq(incomingComments.id, current.incoming.id), eq(incomingComments.status, "new")));
    const resultRef = `message:${message.id}`;
    await recordCall(tx, ctx.record, { reason: null, resultRef });
    if (inserted) {
      await appendDraft(tx, ctx.record.checkpoint.id, {
        kind: "reply",
        messageId: message.id,
        target,
        replyTextHash: current.incoming.textHash,
        writing: { stepId: ctx.step.step_id, contextRevision, factIds: facts.map(fact => fact.id) },
      });
    }
    return {
      kind: "dispatched" as const,
      detail: `${untrusted("YOUR DRAFT REPLY (waiting for the owner's yes)", text)}\n(${resultRef})`,
      resultRef,
      drafted: inserted !== undefined,
    };
  });
}

async function currentReplyWritingRevision(
  tx: Tx,
  current: { incoming: IncomingComment; campaign: Campaign },
  stepId: string,
  factIds: number[],
  now: number,
): Promise<string | null> {
  const strategy = await loadStrategy(tx, current.campaign);
  const step = strategy?.document.steps?.find(row => row.step_id === stepId);
  if (!strategy || !step) return null;
  const facts = factIds.length ? await tx.select().from(productFacts).where(inArray(productFacts.id, factIds)) : [];
  if (firstUnusableFact(factIds, new Map(facts.map(fact => [fact.id, fact])), now) !== null) return null;
  return stepReplyWritingRevision(await prepareStepReply(tx, {
    ...current, voice: strategy.document.voice, step, now,
  }), facts);
}

/** `refused:<why>` when no candidate may be made in this conversation now
 *  (`candidateRefusal`) — a draft on `messages` is one. */
async function heldConversation(
  tx: Tx,
  ctx: Pick<DispatchContext, "conversation" | "campaignId" | "generationSeen">,
): Promise<string | null> {
  const refused = await candidateRefusal(tx, {
    channelId: ctx.conversation.channelId,
    campaignId: ctx.campaignId,
    conversationId: ctx.conversation.id,
    authorProfileId: ctx.conversation.authorProfileId,
    generationSeen: ctx.generationSeen,
  });
  return refused === null ? null : `refused:${refused}`;
}

export type ProposeContext = Pick<
  DispatchContext,
  | "organizationId"
  | "record"
  | "stepInput"
  | "campaignId"
  | "conversation"
  | "generationSeen"
> & {
  /** What the step's Reply resolved to: Ask me leaves the draft for the
   *  owner's yes; Automatic approves it here. */
  mode: "review" | "auto";
};

/**
 * A Reply the step proposes to send: the draft it names — a `draft_comment`
 * of this step, which validation bound — already waits on `messages`
 * (`replyLanding`), and that row is the proposal. At Ask me nothing here moves
 * it: only the owner's yes hands it to the action ledger. At Automatic it is
 * approved here, as an unattended send — the day plan, the window and
 * `pacingPolicy` cap it at the send, and a reply the sensitivity check held,
 * or one the owner unscheduled, still waits for the owner. The conversation
 * is re-read as a draft re-reads
 * it, so a proposal never stands on a reply that moved, words the person has
 * since edited, a Reply turned Off or a conversation stopped since.
 */
export async function proposeReply(ctx: ProposeContext): Promise<DispatchOutcome> {
  const target = ctx.record.call.target.ref;
  const draftCall = ctx.record.call.inputs.find((input) => input.name === "draft")?.ref ?? null;
  return withOrg(ctx.organizationId, async (tx) => {
    const [drafted] =
      draftCall === null
        ? []
        : await tx
            .select({ resultRef: stepToolCalls.resultRef })
            .from(stepToolCalls)
            .where(
              and(
                eq(stepToolCalls.stepRunId, ctx.record.checkpoint.id),
                eq(stepToolCalls.callId, draftCall),
                eq(stepToolCalls.outcome, "dispatched"),
              ),
            )
            .orderBy(desc(stepToolCalls.id))
            .limit(1);
    const messageId = drafted?.resultRef?.startsWith("message:")
      ? Number(drafted.resultRef.slice("message:".length))
      : null;
    const current = await replyToAnswer(tx, ctx);
    const [message] =
      messageId === null || !current
        ? []
        : await tx
            .select(REPLY_ROW)
            .from(messages)
            .where(
              and(eq(messages.id, messageId), eq(messages.incomingCommentId, current.incoming.id)),
            );
    if (
      !current ||
      await replyLanding(tx, current.campaign) === null ||
      !message ||
      (await answersOldWords(tx, message, current.incoming, ctx.conversation.id))
    ) {
      await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: `reply:${target}` });
      return { kind: "refused" as const, reason: "guard_moved" as const, ref: `reply:${target}` };
    }
    if (ctx.mode === "auto" && message.status === "proposed" && message.publishOrigin === "worker") {
      const [checkpoint] = await tx.select({ drafts: stepRuns.drafts }).from(stepRuns)
        .where(and(eq(stepRuns.conversationId, ctx.conversation.id),
          sql`${stepRuns.drafts} @> ${JSON.stringify([{ kind: "reply", messageId: message.id }])}::jsonb`))
        .orderBy(desc(stepRuns.id)).limit(1);
      const saved = checkpoint?.drafts.filter(row => row.kind === "reply" && row.messageId === message.id).at(-1);
      if (saved?.kind === "reply" && saved.writing &&
        await currentReplyWritingRevision(tx, current, saved.writing.stepId, saved.writing.factIds, Date.now()) !== saved.writing.contextRevision) {
        await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: `reply:${target}` });
        return { kind: "refused" as const, reason: "guard_moved" as const, ref: `reply:${target}` };
      }
    }
    const held = await heldConversation(tx, ctx);
    if (held) {
      await recordCall(tx, ctx.record, { reason: "reservation_refused", resultRef: held });
      return { kind: "refused" as const, reason: "reservation_refused" as const, ref: held };
    }
    const resultRef = `message:${message.id}`;
    await recordCall(tx, ctx.record, { reason: null, resultRef });
    const automatic =
      ctx.mode === "auto" &&
      message.status === "proposed" &&
      message.publishOrigin === "worker" &&
      current.incoming.sensitivity !== "hold";
    // Paced by the day plan: with no slot free, the reply waits for the owner.
    const [slot] = automatic ? await assignSlots(tx, { campaign: current.campaign, items: [{ messageId: message.id, kind: "reply" }] }) : [];
    const approved = slot
      ? await tx
          .update(messages)
          .set({ status: "approved" })
          .where(and(eq(messages.id, message.id), eq(messages.status, "proposed"), notUnscheduledByOwner()))
          .returning({ id: messages.id })
      : [];
    if (approved[0]) await queueAutomaticReply(tx, message.id);
    return {
      kind: "dispatched" as const,
      detail:
        approved.length > 0
          ? `Queued to go out on its own (${resultRef}), paced by the account's day plan.`
          : message.status === "proposed"
            ? `Waiting for the owner's yes (${resultRef}); nothing is sent until they give it.`
            : `Already ${message.status} (${resultRef}); nothing new was queued.`,
      resultRef,
      drafted: false,
    };
  });
}

/**
 * A DM's draft, held on the checkpoint until a `send_dm` or `followup` call
 * names it. Answering a reply under our comment it is drafted from that
 * exchange; answering anything in their conversation with the account — a
 * message, an accepted invitation, a follow-up come due — from the
 * conversation, as the one opener, an answer or the follow-up the event asks
 * for. A draft that makes an offer is written from the offer's approved words,
 * as they stand: an unknown, unapproved or retired asset refuses it before a
 * word is written, as `reserveDirectMessage` refuses the DM that would carry
 * one, and a draft that says more than the words do is refused after
 * (`unsupportedOfferClaim`).
 */
async function draftDm(ctx: DispatchContext): Promise<DispatchOutcome> {
  const target = ctx.record.call.target.ref;
  const asset = ctx.record.call.cta_asset_id;
  const prepared = await withOrg(ctx.organizationId, async (tx) => {
    const [checkpoint] = await tx
      .select({ drafts: stepRuns.drafts })
      .from(stepRuns)
      .where(eq(stepRuns.id, ctx.record.checkpoint.id));
    const held = checkpoint?.drafts.find((draft) => draft.kind === "dm" && draft.target === target);
    if (held?.kind === "dm") return { kind: "existing" as const, text: held.text };
    const offer = asset === null ? null : await approvedOffer(tx, asset);
    if (asset !== null && offer === null) return { kind: "unapproved" as const };
    if (!ctx.stepInput.incoming) {
      const drafted = await conversationDraft(tx, ctx);
      return drafted.kind === "write" ? { ...drafted, offer } : drafted;
    }
    const current = await currentReply(tx, ctx);
    if (!current) return { kind: "moved" as const };
    return {
      kind: "write" as const,
      source: await exchangeSource(tx, {
        incoming: current.incoming,
        campaign: current.campaign,
        voice: ctx.voice,
        now: ctx.now,
      }),
      offer,
    };
  });
  if (prepared.kind === "moved") return refuse(ctx, "guard_moved", `dm:${target}`);
  if (prepared.kind === "unapproved") return refuse(ctx, "cta_unapproved", `cta:${asset}`);
  if (prepared.kind === "existing") {
    return keep(ctx, `dm:${target}`, untrusted("YOUR DRAFT DM (held, never sent)", prepared.text));
  }

  const facts = await boundFacts(ctx);
  const { offer } = prepared;
  const dm = await writeStepDm(prepared.source, { organizationId: ctx.organizationId, step: ctx.step, facts, offer, llm: ctx.llm });
  if (dm.kind === "held") {
    await withOrg(ctx.organizationId, async (tx) => {
      const current = prepared.source.kind === "exchange" ? await currentReply(tx, ctx) : null;
      if (current && dm.reading) await keepReading(tx, current.incoming, dm.reading);
    });
    return refuse(ctx, "reservation_refused", "sensitive_hold");
  }
  const { text, promptTemplate } = dm.draft;
  const contextRevision = dmWritingRevision(prepared.source, ctx.step.instructions, facts, offer);
  const claim = offer === null ? null : unsupportedOfferClaim(text, offer);
  if (claim !== null) return refuse(ctx, "cta_claim_unsupported", `cta:${asset}:${claim}`);
  const draft: StepDraft = {
    kind: "dm",
    target,
    text,
    textHash: createHash("sha256").update(text, "utf8").digest("hex"),
    versions: {
      strategy: ctx.strategyVersion,
      input: ctx.stepInput.version,
      facts: facts.map((fact) => fact.id),
    },
    ...(offer === null ? {} : { offer: { ref: offer.ref, contentHash: offer.contentHash } }),
  };
  return withOrg(ctx.organizationId, async (tx) => {
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, ctx.campaignId));
    const strategy = campaign && await loadStrategy(tx, campaign);
    const step = strategy?.document.steps?.find(row => row.step_id === ctx.step.step_id);
    const current = strategy && await (ctx.stepInput.incoming
      ? currentReply(tx, ctx).then(value => value ? exchangeSource(tx, { incoming: value.incoming,
        campaign: value.campaign, voice: strategy.document.voice, now: ctx.now }) : null)
      : conversationDraft(tx, { ...ctx, voice: strategy.document.voice }).then(value => value.kind === "write" ? value.source : null));
    const currentFacts = facts.length ? await tx.select().from(productFacts).where(inArray(productFacts.id, facts.map(fact => fact.id))) : [];
    const currentOffer = asset === null ? null : await approvedOffer(tx, asset);
    if (!step || !current || dmWritingRevision(current, step.instructions, currentFacts, currentOffer) !== contextRevision) {
      await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: `dm:${target}` });
      return { kind: "refused" as const, reason: "guard_moved" as const, ref: `dm:${target}` };
    }
    draft.writing = { promptId: await recordPrompt(tx, "writer", promptTemplate),
      hash: createHash("sha256").update(promptTemplate).digest("hex"), stepId: ctx.step.step_id, contextRevision, instructions: ctx.step.instructions };
    await recordCall(tx, ctx.record, { reason: null, resultRef: `dm:${target}` });
    await appendDraft(tx, ctx.record.checkpoint.id, draft);
    return {
      kind: "dispatched" as const,
      detail: untrusted("YOUR DRAFT DM (held, never sent)", text),
      resultRef: `dm:${target}`,
      drafted: true,
    };
  });
}

/** What a DM in their conversation is drafted from, as it stands — or `moved`
 *  where the conversation the step was handed is gone. */
async function conversationDraft(tx: Tx, ctx: Pick<DispatchContext, "conversation" | "campaignId" | "stepInput" | "event" | "voice" | "now">) {
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, ctx.conversation.id));
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, ctx.campaignId));
  const dmHistory = ctx.stepInput.conversation;
  if (!conversation || !campaign || dmHistory === null) {
    return { kind: "moved" as const };
  }
  return {
    kind: "write" as const,
    source: await conversationSource(tx, {
      conversation,
      campaign,
      dmHistory,
      eventType: ctx.event.type,
      voice: ctx.voice,
      now: ctx.now,
    }),
  };
}

async function appendDraft(tx: Tx, checkpointId: number, draft: StepDraft): Promise<void> {
  const [row] = await tx
    .select({ drafts: stepRuns.drafts })
    .from(stepRuns)
    .where(eq(stepRuns.id, checkpointId))
    .for("update");
  await tx
    .update(stepRuns)
    .set({ drafts: [...(row?.drafts ?? []), draft], updatedAt: Date.now() })
    .where(eq(stepRuns.id, checkpointId));
}

async function refuse(
  ctx: Pick<DispatchContext, "organizationId" | "record">,
  reason: DispatchRefusal,
  ref: string,
): Promise<DispatchOutcome> {
  await withOrg(ctx.organizationId, (tx) =>
    recordCall(tx, ctx.record, { reason, resultRef: ref }),
  );
  return { kind: "refused", reason, ref };
}

/** A draft the checkpoint already has: the call dispatched, and wrote
 *  nothing new. */
async function keep(ctx: DispatchContext, resultRef: string, detail: string): Promise<DispatchOutcome> {
  await withOrg(ctx.organizationId, (tx) =>
    recordCall(tx, ctx.record, { reason: null, resultRef }),
  );
  return { kind: "dispatched", detail, resultRef, drafted: false };
}

export type ReserveContext = {
  continueRun?: () => Promise<boolean>;
  organizationId: string;
  record: CallRecord;
  tool: ReservableTool;
  binding: { action_binding_id: string; target: TargetType; effective: BindingMode | null };
  /** The person the step is working, on the account it works them from. */
  conversation: Pick<ConversationRow, "id" | "channelId" | "authorProfileId" | "interestEvidenceEventId">;
  /** The reply the step answers, at the revision it was handed. */
  event: { id: number; contentHash: string | null };
  /** What in this conversation a binding's selector can name. */
  likeContext: LikeConversation;
  /** What an invitation's note is drafted from: the step's instructions and
   *  the verified exchange it was handed. */
  step: StrategyStep;
  stepInput: StepInput;
  campaign: Campaign;
  llm: LLM;
  strategyVersion: number;
  /** The campaign's voice as its strategy states it: an invitation's note
   *  is written in it. */
  voice: CampaignAgentStrategy["voice"];
  /** The pause generation the wake's plan was made under. */
  generationSeen: number;
  /** What woke the step, when its own wait did (`wake.ts` `wokenBy`). */
  woke: WokenBy;
  now: number;
};

/** What a step's own wait waking it means for what it proposes: whether the
 *  time it woke at was one the person's own quoted words named, and whether
 *  it was found late — the Mac asleep — when nothing it proposes goes out
 *  on its own: a backlog is reviewed, never sent in a burst. */
export type WokenBy = { namedTime: boolean; catchup: boolean };

/**
 * A send whose mode is above Off becomes a row on the action ledger — the
 * candidate, never the click (INV-27) — at the mode its binding resolved to
 * for this step now: Ask me waits for the owner's yes; Automatic is reserved
 * to go out on its own, and the gate it is queued for still re-reads every
 * guard, binds it to the account's rolling-24h ceiling and window, and blocks
 * it at a spent ceiling (`execution/actionGate.ts`). Automatic removes the
 * approval row and nothing else. `reserveAction` re-reads the conversation, the
 * pauses against the plan's generation and the person's exclusion in the
 * transaction that inserts, and the call's record commits with the row. The
 * same action proposed again — by this step, a later wake, another campaign —
 * meets the unique key and is handed back, not queued twice.
 */
export async function reserveCall(ctx: ReserveContext): Promise<DispatchOutcome> {
  switch (ctx.tool) {
    case "send_invitation":
      return reserveInvitationCall(ctx);
    case "send_dm":
    case "followup":
      return reserveDirectMessageCall(ctx, ctx.tool === "send_dm" ? "dm" : "followup");
    case "like_target":
      return reserveLikeCall(ctx);
  }
}

/**
 * A DM or a follow-up: the words are the draft a `draft_dm` call of this
 * step wrote and the call names — validation bound it — at the facts it was
 * drafted on; what it is for, and whether it may go at all, is the server's
 * (`actions/dm.ts`). A draft the checkpoint no longer holds is a conversation
 * that moved.
 */
async function reserveDirectMessageCall(ctx: ReserveContext, kind: "dm" | "followup"): Promise<DispatchOutcome> {
  const draftCall = ctx.record.call.inputs.find((input) => input.name === "draft")?.ref ?? null;
  return withOrg(ctx.organizationId, async (tx) => {
    const [drafted] =
      draftCall === null
        ? []
        : await tx
            .select({ resultRef: stepToolCalls.resultRef })
            .from(stepToolCalls)
            .where(
              and(
                eq(stepToolCalls.stepRunId, ctx.record.checkpoint.id),
                eq(stepToolCalls.callId, draftCall),
                eq(stepToolCalls.outcome, "dispatched"),
              ),
            )
            .orderBy(desc(stepToolCalls.id))
            .limit(1);
    const [checkpoint] = await tx
      .select({ drafts: stepRuns.drafts })
      .from(stepRuns)
      .where(eq(stepRuns.id, ctx.record.checkpoint.id));
    const draft = checkpoint?.drafts.find(
      (held): held is Extract<StepDraft, { kind: "dm" }> =>
        held.kind === "dm" && drafted?.resultRef === `dm:${held.target}`,
    );
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, ctx.conversation.id));
    const [event] = await tx.select().from(conversationEvents).where(eq(conversationEvents.id, ctx.event.id));
    const ref = `dm:${ctx.record.call.target.ref}`;
    if (!draft || !conversation || !event) {
      await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: ref });
      return { kind: "refused" as const, reason: "guard_moved" as const, ref };
    }
    // A held automatic draft may outlive a voice/Brain edit between model
    // turns. Recheck its writing inputs at reservation, before any send row.
    if (draft.writing) {
      const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, ctx.campaign.id));
      const strategy = campaign && await loadStrategy(tx, campaign);
      const step = strategy?.document.steps?.find(row => row.step_id === draft.writing!.stepId);
      const sourceContext = strategy ? { stepInput: ctx.stepInput, campaignId: ctx.campaign.id,
        conversation, event, voice: strategy.document.voice, now: ctx.now } : null;
      const source = sourceContext && await (ctx.stepInput.incoming
        ? currentReply(tx, sourceContext).then(value => value ? exchangeSource(tx, { ...value,
          voice: sourceContext.voice, now: ctx.now }) : null)
        : conversationDraft(tx, sourceContext).then(value => value.kind === "write" ? value.source : null));
      const sourceFacts = draft.versions.facts.length ? await tx.select().from(productFacts)
        .where(inArray(productFacts.id, draft.versions.facts)) : [];
      const sourceOffer = draft.offer ? await approvedOffer(tx, draft.offer.ref) : null;
      if (!step || !source || dmWritingRevision(source, step.instructions, sourceFacts, sourceOffer) !== draft.writing.contextRevision) {
        await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: ref });
        return { kind: "refused" as const, reason: "guard_moved" as const, ref };
      }
    }
    const facts =
      draft.versions.facts.length === 0
        ? []
        : await tx
            .select({ id: productFacts.id, contentHash: productFacts.contentHash })
            .from(productFacts)
            .where(inArray(productFacts.id, draft.versions.facts));
    const reserved = await reserveDirectMessage(tx, {
      conversation,
      campaignId: ctx.campaign.id,
      stepRunId: ctx.record.checkpoint.id,
      actionBindingId: ctx.binding.action_binding_id,
      kind,
      trigger: event,
      text: draft.text,
      writing: draft.writing,
      facts,
      ctaAssetId: ctx.record.call.cta_asset_id,
      draftOffer: draft.offer ?? null,
      namedTime: ctx.woke.namedTime,
      strategyVersion: ctx.strategyVersion,
      memoryVersion: ctx.stepInput.memory.version,
      mode: reserveMode(ctx),
      generationSeen: ctx.generationSeen,
      now: ctx.now,
    });
    return reservedOutcome(tx, ctx, reserved, false);
  });
}

/**
 * A Like: its action target is the one the binding's selector names in this
 * conversation, resolved by the server (`likeTargetFor`); validation already
 * discarded a proposal aimed anywhere else.
 *
 * It waits for the owner's yes, whatever Like reply's mode. At Automatic the
 * server already liked each reply the reply lane's reads cleared, the moment
 * it was seen (`actions/likeTarget.ts` `likeObservedReply`), so one the step
 * asks for is either that like again — the same key, nothing new queued — or
 * one those reads held back. At Ask me an answer carries its like, so one the
 * step proposes is a reply it likes and does not answer.
 */
async function reserveLikeCall(ctx: ReserveContext): Promise<DispatchOutcome> {
  const target = likeTargetFor(ctx.binding.target, ctx.likeContext);
  return withOrg(ctx.organizationId, async (tx) => {
    if (!target) {
      const ref = "refused:target_unresolved";
      await recordCall(tx, ctx.record, { reason: "reservation_refused", resultRef: ref });
      return { kind: "refused" as const, reason: "reservation_refused" as const, ref };
    }
    const reserved = await reserveAction(tx, {
      channelId: ctx.conversation.channelId,
      campaignId: ctx.campaign.id,
      conversationId: ctx.conversation.id,
      authorProfileId: ctx.conversation.authorProfileId,
      stepRunId: ctx.record.checkpoint.id,
      actionBindingId: ctx.binding.action_binding_id,
      kind: ledgerKindOf(ctx.tool),
      purpose: "reaction",
      target,
      candidate: {
        text: null,
        sources: [{ eventId: ctx.event.id, contentHash: ctx.event.contentHash }],
        versions: { strategy: ctx.strategyVersion, facts: [], memory: ctx.stepInput.memory.version, voice: null },
      },
      mode: "review",
      generationSeen: ctx.generationSeen,
      now: ctx.now,
    });
    return reservedOutcome(tx, ctx, reserved, false);
  });
}

/** The Reply states a folded like can still ride on: not yet sent. */
const RIDES: Message["status"][] = ["proposed", "approved"];

/**
 * A Like of the reply this step answers, folded into the answer
 * (`validate.ts`): no row of its own on the action ledger, but the Reply's
 * `like_with_send`, so what lets the Reply go — the owner's one yes, or its
 * own Automatic — lets the like go with it, pressed right after the Reply is
 * confirmed (`actions/reply.ts`). Null when there is no Reply left to ride on —
 * refused, rejected or already sent — and the caller reserves the like as one
 * without an answer.
 */
export async function foldLikeCall(ctx: ReserveContext): Promise<DispatchOutcome | null> {
  const incoming = ctx.stepInput.incoming;
  if (!incoming) return null;
  return withOrg(ctx.organizationId, async (tx) => {
    const [reply] = await tx
      .update(messages)
      .set({ likeWithSend: true })
      .where(
        and(
          eq(messages.incomingCommentId, incoming.id),
          eq(messages.kind, "reply"),
          inArray(messages.status, RIDES),
        ),
      )
      .returning({ id: messages.id, status: messages.status });
    if (!reply) return null;
    const resultRef = `message:${reply.id}`;
    await recordCall(tx, ctx.record, { reason: null, resultRef });
    return {
      kind: "dispatched" as const,
      detail:
        reply.status === "proposed"
          ? `Goes out with your reply (${resultRef}): the owner's one yes sends the reply, then likes their reply.`
          : `Goes out with your reply (${resultRef}), right after it is sent.`,
      resultRef,
      drafted: false,
    };
  });
}

/**
 * An Invite: to the conversation's person, carrying a note the server drafts from
 * the exchange the step was handed — the verified thread, the step's own
 * instructions, the campaign's voice — and never from the proposal. An
 * invitation already queued or sent for the conversation answers the call before
 * any draft; a conversation that forbids one (connected, pending, invited) refuses
 * it before any draft too. The note's length is aimed under the limit a
 * composer last printed for them, where one did; the limit it is held to is
 * the one the page prints at the click.
 */
async function reserveInvitationCall(ctx: ReserveContext): Promise<DispatchOutcome> {
  const org = ctx.organizationId;
  const ref = `person:${ctx.conversation.authorProfileId}`;
  const key = personKey({
    channelId: ctx.conversation.channelId,
    personId: ctx.conversation.authorProfileId,
    conversationId: ctx.conversation.id,
    purpose: "opener",
    sequence: 1,
  });
  const ahead = await withOrg(org, async (tx) => {
    const [queued] = await tx
      .select()
      .from(actions)
      .where(eq(actions.idempotencyKey, key));
    if (queued && queued.status !== "definitely_not_sent") {
      return reservedOutcome(tx, ctx, { status: "duplicate", action: queued }, false);
    }
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, ctx.conversation.id));
    const refused = conversation ? await invitationRefusal(tx, conversation) : "conversation_not_found";
    if (refused) return reservedOutcome(tx, ctx, { status: "refused", reason: refused }, false);
    return null;
  });
  if (ahead) return ahead;
  if (!ctx.stepInput.thread) return refuse(ctx, "guard_moved", ref);

  const room = await withOrg(org, (tx) => roomInvitationAdmission(tx, { campaignId: ctx.campaign.id,
    conversationId: ctx.conversation.id, stepRunId: ctx.record.checkpoint.id, generationSeen: ctx.generationSeen }));
  if (room.kind === "refused") return refuse(ctx, "reservation_refused", `refused:${room.reason}`);
  const thread = room.kind === "ready" ? room.text : ctx.stepInput.thread;
  if (room.kind === "ready" && (!ctx.continueRun || !await ctx.continueRun())) return refuse(ctx, "guard_moved", ref);
  const source = await withOrg(org, (tx) =>
    noteSource(tx, {
      campaign: ctx.campaign,
      authorProfileId: ctx.conversation.authorProfileId,
      voice: ctx.voice,
      now: ctx.now,
    }),
  );
  const noteInput = {
    thread,
    name: ctx.stepInput.incoming?.authorName ?? null,
    interestShown: ctx.conversation.interestEvidenceEventId !== null,
  };
  const revision = noteWritingRevision(source, { ...noteInput, instructions: ctx.step.instructions });
  let written;
  try {
    written = await writeStepNote(source, {
      ...noteInput,
      organizationId: org,
      conversationId: ctx.conversation.id,
      step: ctx.step,
      llm: ctx.llm,
      ...(room.kind === "ready" ? { beforeCall: async () => {
        if (!ctx.continueRun || !await ctx.continueRun()) throw new AppError("room_work_changed", "The room work changed.", 409);
        const latest = await withOrg(org, (tx) => roomInvitationAdmission(tx, { campaignId: ctx.campaign.id,
          conversationId: ctx.conversation.id, stepRunId: ctx.record.checkpoint.id, generationSeen: ctx.generationSeen }));
        if (latest.kind !== "ready" || latest.text !== room.text) throw new AppError("room_work_changed", "The room work changed.", 409);
      } } : {}),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "room_work_changed") return refuse(ctx, "guard_moved", ref);
    throw error;
  }

  if (room.kind === "ready" && (!ctx.continueRun || !await ctx.continueRun())) return refuse(ctx, "guard_moved", ref);

  return withOrg(org, async (tx) => {
    const [currentCampaign] = await tx.select().from(campaigns).where(eq(campaigns.id, ctx.campaign.id));
    const currentStrategy = currentCampaign && await loadStrategy(tx, currentCampaign);
    const currentStep = currentStrategy?.document.steps?.find(step => step.step_id === ctx.step.step_id);
    if (!currentCampaign || !currentStrategy || !currentStep) {
      await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: ref });
      return { kind: "refused" as const, reason: "guard_moved" as const, ref };
    }
    const currentSource = await noteSource(tx, { campaign: currentCampaign,
      authorProfileId: ctx.conversation.authorProfileId, voice: currentStrategy.document.voice, now: ctx.now });
    // Compare relevant writing inputs, not the whole strategy version: an
    // unrelated setting edit must not invalidate these words.
    if (noteWritingRevision(currentSource, { ...noteInput, instructions: currentStep.instructions }) !== revision) {
      await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: ref });
      return { kind: "refused" as const, reason: "guard_moved" as const, ref };
    }
    if (room.kind === "ready") {
      const latest = await roomInvitationAdmission(tx, { campaignId: ctx.campaign.id, conversationId: ctx.conversation.id,
        stepRunId: ctx.record.checkpoint.id, generationSeen: ctx.generationSeen });
      if (latest.kind !== "ready" || latest.text !== room.text) {
        await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: ref });
        return { kind: "refused" as const, reason: "guard_moved" as const, ref };
      }
    }
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, ctx.conversation.id));
    if (!conversation) {
      await recordCall(tx, ctx.record, { reason: "guard_moved", resultRef: ref });
      return { kind: "refused" as const, reason: "guard_moved" as const, ref };
    }
    const reserved = await reserveInvitation(tx, {
      conversation,
      campaignId: ctx.campaign.id,
      stepRunId: ctx.record.checkpoint.id,
      actionBindingId: ctx.binding.action_binding_id,
      candidate: {
        writing: { promptId: await recordPrompt(tx, "writer", written.promptTemplate),
          hash: createHash("sha256").update(written.promptTemplate).digest("hex"), stepId: ctx.step.step_id,
          instructions: ctx.step.instructions },
        text: written.text,
        sources: [{ eventId: ctx.event.id, contentHash: ctx.event.contentHash }],
        versions: {
          strategy: ctx.strategyVersion,
          facts: factsBoundToNote(source, ctx.step),
          memory: ctx.stepInput.memory.version,
          voice: null,
        },
      },
      mode: reserveMode(ctx),
      generationSeen: ctx.generationSeen,
      now: ctx.now,
    });
    return reservedOutcome(tx, ctx, reserved, reserved.status === "reserved");
  });
}

/** The ledger mode a binding's effective mode reserves at — Ask me for
 *  anything a late wake proposes. */
function reserveMode(ctx: Pick<ReserveContext, "binding" | "woke">): "review" | "auto" {
  return ctx.binding.effective === "auto" && !ctx.woke.catchup ? "auto" : "review";
}

/** Record what a reservation came to on the call's row, and hand back what
 *  the next iteration is told. A DM's own rules — too soon, already nudged,
 *  nothing of theirs to answer — are the step's to plan around; a Stop, a
 *  hold or an exclusion ends it. */
async function reservedOutcome(
  tx: Tx,
  ctx: ReserveContext,
  reserved: ReserveOutcome,
  drafted: boolean,
): Promise<DispatchOutcome> {
  if (reserved.status === "refused") {
    const ref = `refused:${reserved.reason}`;
    await recordCall(tx, ctx.record, { reason: "reservation_refused", resultRef: ref });
    return {
      kind: "refused",
      reason: "reservation_refused",
      ref,
      ...((ctx.tool === "send_dm" || ctx.tool === "followup") && isDmRefusal(reserved.reason)
        ? { rule: reserved.reason }
        : {}),
    };
  }
  const resultRef = `action:${reserved.action.id}`;
  await recordCall(tx, ctx.record, { reason: null, resultRef });
  return {
    kind: "dispatched",
    detail:
      reserved.status !== "reserved"
        ? `Already queued (${resultRef}, ${reserved.action.status}); nothing new was queued.`
        : reserved.action.status === "reserved"
          ? `Queued to go out on its own (${resultRef}), within the account's ceiling for it; the send gate checks it again before anything is clicked.`
          : `Queued for the owner's yes (${resultRef}); nothing is sent until they give it.`,
    resultRef,
    drafted,
  };
}
