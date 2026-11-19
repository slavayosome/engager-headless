import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  actions,
  campaigns,
  incomingComments,
  conversationEvents,
  conversations,
  messages,
  productFacts,
  stepRuns,
  type ActionRow,
  type Campaign,
  type OfferBinding,
  type ProductFact,
  type StepDraft,
  type StepRunRow,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { invalidateApproval, liveApproval } from "../actions/approval";
import { contentHash } from "../actions/keys";
import { ACTION_REDRAFT } from "../actions/ledger";
import { currentGeneration } from "../actions/pause";
import type { LLM } from "../ai/client";
import { recordPrompt } from "../ai/prompts";
import type { WriteResult } from "../ai/writer";
import type { CampaignAgentStrategy, StrategyStep } from "../strategy/contract";
import { voiceMoved } from "../strategy/draftingVoice";
import { approvedOffer, unsupportedOfferClaim, type ApprovedOffer } from "../products/offers";
import { roomEventRefusal } from "../rooms/continuation";
import { isRoomThreadReply } from "../rooms/thread";
import { buildStepInput } from "./input";
import { loadStrategy, type LoadedStrategy } from "./select";
import {
  conversationSource,
  dmWritingRevision,
  exchangeSource,
  factsBoundToNote,
  noteSource,
  keepReading,
  noteWritingRevision,
  prepareStepReply,
  stepReplyWritingRevision,
  writeStepDm,
  writeStepNote,
  writeStepReply,
} from "./writing";

/**
 * A VOICE UPDATE IS PROSPECTIVE (spec §09 R04). When a version that moves the
 * campaign's voice takes effect (`strategy/activate.ts` queues this), the
 * drafts still waiting to go out are written again by the model, through the
 * same writers a fresh draft takes (`writing.ts`), in the voice the active
 * version states — and nothing already sent is touched. An undo is another
 * version: it redrafts what still waits in the voice it restores, for work
 * from then on, and never reaches what went out.
 *
 * What is written again, and nothing else:
 * - a public reply an agent step drafted, in the drafter's words: waiting for
 *   the owner's yes, or approved by its Automatic mode and waiting for its
 *   send, which it still is after. A reply the owner said yes to, or edited,
 *   carries their words in `finalText` — the words their yes was given to —
 *   and is never touched. A redraft is filed and completed as the server's own
 *   request, so the reply's revision log (`message_draft_revisions`) keeps the
 *   words it replaced beside the new ones.
 * - the words of a queued ledger action — an invitation's note, a DM, a
 *   follow-up — written again from the step's conversation as it stands. A yes
 *   given to words that changed no longer holds (`invalidateApproval`), and the
 *   DM its checkpoint holds carries the new words with it.
 * - a DM an open checkpoint holds that no action carries yet.
 *
 * Each draft is read, written with no transaction held, then written back
 * under a compare-and-swap on what was read: one the owner edited, decided or
 * sent meanwhile — or that moved any other way — is left exactly as it is.
 */

type StrategyVoice = CampaignAgentStrategy["voice"];

export type VoiceRedraftPayload = { campaignId: number };

/** What a voice update wrote again. */
export type VoiceRedraft = {
  /** The strategy version whose voice the drafts were written in; null
   *  where the campaign runs on no strategy. */
  version: number | null;
  /** Public replies, redrafted in place. */
  replies: number[];
  /** Queued ledger actions whose words were written again. */
  actions: number[];
  /** Yeses given to words that changed, which no longer hold. */
  invalidatedApprovals: number;
  /** Open checkpoints whose held DMs were written again. */
  checkpoints: number[];
};

const QUEUED_ACTION: ActionRow["status"][] = ["reserved", "awaiting_review", "approved"];
const OPEN_CHECKPOINT: StepRunRow["status"][] = ["running", "waiting", "needs_approval"];
const REDRAFT_NOTE = "the campaign's voice changed";
/** Passes one job makes: a version activated while it runs is redrafted in
 *  by its own re-check, since the queue key it holds coalesced the enqueue. */
const MAX_PASSES = 3;

type Run = {
  organizationId: string;
  llm: LLM;
  campaign: Campaign;
  strategy: LoadedStrategy;
  now: number;
};

export async function redraftForVoice(
  ctx: { organizationId: string; llm: LLM },
  campaignId: number,
): Promise<VoiceRedraft> {
  const out: VoiceRedraft = { version: null, replies: [], actions: [], invalidatedApprovals: 0, checkpoints: [] };
  let written: StrategyVoice | null = null;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const state = await withOrg(ctx.organizationId, async (tx) => {
      const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
      if (!campaign) return null;
      const strategy = await loadStrategy(tx, campaign);
      return strategy && { campaign, strategy };
    });
    if (!state || (written !== null && !voiceMoved(written, state.strategy.document.voice))) break;
    written = state.strategy.document.voice;
    out.version = state.strategy.version;
    const run: Run = { ...ctx, ...state, now: Date.now() };
    await redraftReplies(run, out);
    await redraftActions(run, out);
    await redraftHeldDms(run, out);
  }
  return {
    ...out,
    replies: [...new Set(out.replies)],
    actions: [...new Set(out.actions)],
    checkpoints: [...new Set(out.checkpoints)],
  };
}

/** The replies a voice update writes again: an agent step's, unsent, still
 *  in the drafter's words, with no redraft already asked for. Approved with
 *  no `finalText` is approved by its mode: a person's yes keeps the words. */
const waitingReplies = (campaignId: number) =>
  and(
    eq(messages.campaignId, campaignId),
    eq(messages.kind, "reply"),
    eq(messages.loopVersion, "agent_step"),
    eq(messages.publishOrigin, "worker"),
    inArray(messages.status, ["proposed", "approved"]),
    isNull(messages.finalText),
    isNull(messages.redraftRequestId),
  );

/** The queued ledger actions whose words a voice update writes again. */
const queuedWords = (campaignId: number) =>
  and(
    eq(actions.campaignId, campaignId),
    eq(actions.origin, "worker"),
    inArray(actions.status, QUEUED_ACTION),
    inArray(actions.kind, ["invite", "dm", "followup"]),
    isNotNull(actions.stepRunId),
    sql`${actions.candidate} ->> 'text' is not null`,
  );

const openHoldingDms = (campaignId: number) =>
  and(
    eq(stepRuns.campaignId, campaignId),
    inArray(stepRuns.status, OPEN_CHECKPOINT),
    sql`${stepRuns.drafts} @> ${JSON.stringify([{ kind: "dm" }])}::jsonb`,
  );

/** Legacy replies with no checkpoint inherit campaign guidance. A named
 * step that was removed cannot be replaced by an inferred writing context. */
function stepOf(strategy: LoadedStrategy, stepId: string | undefined): (Pick<StrategyStep, "instructions"> & Partial<Pick<StrategyStep, "step_id" | "objective">>) | null {
  return stepId === undefined ? { instructions: "" }
    : (strategy.document.steps ?? []).find((step) => step.step_id === stepId) ?? null;
}

async function redraftReplies(run: Run, out: VoiceRedraft): Promise<void> {
  const waiting = await withOrg(run.organizationId, (tx) =>
    tx.select({ id: messages.id }).from(messages).where(waitingReplies(run.campaign.id)).orderBy(asc(messages.id)),
  );
  for (const { id } of waiting) {
    const read = await withOrg(run.organizationId, async (tx) => {
      const [row] = await tx.select().from(messages).where(and(eq(messages.id, id), waitingReplies(run.campaign.id)));
      if (!row?.incomingCommentId) return null;
      const [incoming] = await tx
        .select()
        .from(incomingComments)
        .where(eq(incomingComments.id, row.incomingCommentId));
      if (!incoming || incoming.removedAt !== null) return null;
      const [drafting] = await tx
        .select({ id: stepRuns.id, stepId: stepRuns.stepId, drafts: stepRuns.drafts, eventId: stepRuns.eventId })
        .from(stepRuns)
        .where(sql`${stepRuns.drafts} @> ${JSON.stringify([{ kind: "reply", messageId: row.id }])}::jsonb`)
        .orderBy(desc(stepRuns.id))
        .limit(1);
      let roomCheck = null;
      if (await isRoomThreadReply(tx, incoming)) {
        const generation = await currentGeneration(tx);
        const [event] = drafting?.eventId ? await tx.select().from(conversationEvents).where(eq(conversationEvents.id, drafting.eventId)) : [];
        if (!event || await roomEventRefusal(tx, event, run.campaign.id, Date.now(), generation)) return null;
        roomCheck = { event, generation };
      }
      const held = drafting?.drafts
        .filter((draft) => draft.kind === "reply" && draft.messageId === row.id)
        .at(-1);
      // A reply to words the person has since edited is its step's to draft
      // afresh for the edit (`dispatch.ts`), not a voice update's.
      if (held?.kind === "reply" && held.replyTextHash != null && held.replyTextHash !== incoming.textHash) {
        return null;
      }
      const step = stepOf(run.strategy, drafting?.stepId);
      if (!step) return null;
      const prepared = await prepareStepReply(tx, { incoming, campaign: run.campaign,
        voice: run.strategy.document.voice, now: run.now,
        ...(step.step_id ? { step: { step_id: step.step_id, instructions: step.instructions, objective: step.objective ?? "" } } : {}),
      });
      return {
        row,
        roomCheck,
        checkpointId: drafting?.id,
        revision: stepReplyWritingRevision(prepared, []),
        // The facts a reply's draft was bound to are not kept on it, so its
        // redraft is bound to none: it claims nothing beyond the brief and
        // the campaign's attached products, handed to it as context.
        step,
        prepared,
      };
    });
    if (!read) continue;
    const written = await writeStepReply(read.prepared, { organizationId: run.organizationId, step: read.step, facts: [], llm: run.llm });
    if (written.kind === "held") {
      // Words a person must see first stay as they are, for the owner.
      if (written.reading) await withOrg(run.organizationId, (tx) => keepReading(tx, read.prepared.incoming, written.reading!));
      continue;
    }
    const { draft } = written;
    const redrafted = await withOrg(run.organizationId, async (tx) => {
      if (read.roomCheck && await roomEventRefusal(tx, read.roomCheck.event, run.campaign.id, Date.now(), read.roomCheck.generation)) return false;
      const latest = await currentRun(tx, run);
      const step = latest && stepOf(latest.strategy, read.step.step_id);
      const [incoming] = await tx.select().from(incomingComments).where(eq(incomingComments.id, read.row.incomingCommentId!));
      if (!latest || !step || !incoming || incoming.removedAt !== null) return false;
      const current = await prepareStepReply(tx, { incoming, campaign: latest.campaign,
        voice: latest.strategy.document.voice, now: latest.now,
        ...(step.step_id ? { step: { step_id: step.step_id, instructions: step.instructions, objective: step.objective ?? "" } } : {}),
      });
      if (stepReplyWritingRevision(current, []) !== read.revision) return false;
      // Filed and completed in one transaction, as `dispatch.ts` files its
      // own: the revision log reads the server's redraft, never an owner edit.
      const [filed] = await tx
        .update(messages)
        .set({
          redraftRequestId: randomUUID(),
          redraftRequestVersion: read.row.redraftRequestVersion + 1,
          redraftRequestedAt: run.now,
          redraftRequestedBy: "voice_update",
          redraftRequestNote: REDRAFT_NOTE,
        })
        .where(
          and(
            eq(messages.id, read.row.id),
            waitingReplies(run.campaign.id),
            eq(messages.status, read.row.status),
            eq(messages.proposedText, read.row.proposedText),
            eq(messages.redraftRequestVersion, read.row.redraftRequestVersion),
          ),
        )
        .returning({ id: messages.id });
      if (!filed) return false;
      await tx
        .update(messages)
        .set({
          proposedText: draft.text,
          promptVersionId: await recordPrompt(tx, "reply", draft.promptTemplate),
          model: draft.model,
          draftPlanId: draft.planId,
          briefSourceHash: draft.briefSourceHash ?? null,
          briefAnchorIds: draft.briefAnchorIds ?? null,
          redraftRequestId: null,
          redraftRequestedAt: null,
          redraftRequestedBy: null,
          redraftRequestNote: null,
        })
        .where(eq(messages.id, read.row.id));
      if (read.checkpointId && step.step_id) {
        const [checkpoint] = await tx.select().from(stepRuns).where(eq(stepRuns.id, read.checkpointId)).for("update");
        if (checkpoint) await tx.update(stepRuns).set({ drafts: checkpoint.drafts.map(held =>
          held.kind === "reply" && held.messageId === read.row.id
            ? { ...held, writing: { stepId: step.step_id!, contextRevision: read.revision, factIds: [] } }
            : held), updatedAt: run.now }).where(eq(stepRuns.id, checkpoint.id));
      }
      return true;
    });
    if (redrafted) out.replies.push(read.row.id);
  }
}

/** The conversation a checkpoint's step was handed, built again as it stands
 *  now — or null where the step, the conversation or its event is gone. */
async function stepConversation(tx: Tx, run: Run, checkpointId: number) {
  const [checkpoint] = await tx.select().from(stepRuns).where(eq(stepRuns.id, checkpointId));
  if (!checkpoint || checkpoint.eventId === null) return null;
  const step = (run.strategy.document.steps ?? []).find((item) => item.step_id === checkpoint.stepId);
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, checkpoint.conversationId));
  const [event] = await tx.select().from(conversationEvents).where(eq(conversationEvents.id, checkpoint.eventId));
  if (!step || !conversation || !event) return null;
  const input = await buildStepInput(tx, {
    step,
    campaign: run.campaign,
    memoryBindings: run.strategy.document.memory_bindings,
    conversation,
    event,
    now: run.now,
  });
  return { checkpoint, step, conversation, event, input };
}

/** Null where the rewrite is not one to keep. */
type WritingProvenance = NonNullable<Extract<StepDraft, { kind: "dm" }>["writing"]>;
type Rewrite = WriteResult & {
  writing: Omit<WritingProvenance, "promptId" | "hash">;
  current: (tx: Tx) => Promise<boolean>;
};
type Writer = (llm: LLM) => Promise<Rewrite | null>;

async function currentRun(tx: Tx, run: Run): Promise<Run | null> {
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, run.campaign.id));
  const strategy = campaign ? await loadStrategy(tx, campaign) : null;
  return campaign && strategy ? { ...run, campaign, strategy } : null;
}

async function recordWriting(tx: Tx, written: Rewrite): Promise<WritingProvenance> {
  return { ...written.writing, promptId: await recordPrompt(tx, "writer", written.promptTemplate),
    hash: sha256(written.promptTemplate) };
}

/** The offer a DM was written to make, as approved now — or `moved` where it
 *  was retired or reworded since: those words are the gate's to refuse, never
 *  a redraft's to rewrite from other ones. */
async function boundOffer(tx: Tx, bound: OfferBinding | undefined): Promise<ApprovedOffer | null | "moved"> {
  if (bound === undefined) return null;
  const offer = await approvedOffer(tx, bound.ref);
  return offer?.contentHash === bound.contentHash ? offer : "moved";
}

/** How a DM in the step's conversation is written again — from the exchange
 *  it answers, or their conversation, making the offer it made — or null
 *  where neither stands now. A rewrite that says more about the offer than its
 *  approved words do is no rewrite: the DM keeps the words it had. */
async function dmWriter(
  tx: Tx,
  run: Run,
  conversation: NonNullable<Awaited<ReturnType<typeof stepConversation>>>,
  facts: ProductFact[],
  offer: ApprovedOffer | null,
): Promise<Writer | null> {
  const { input, conversation: personConversation, event, step } = conversation;
  const voice = run.strategy.document.voice;
  const source = input.incoming
    ? await exchangeSource(tx, { incoming: input.incoming, campaign: run.campaign, voice, now: run.now })
    : input.conversation === null
      ? null
      : await conversationSource(tx, {
          conversation: personConversation,
          campaign: run.campaign,
          dmHistory: input.conversation,
          eventType: event.type,
          voice,
          now: run.now,
        });
  if (source === null) return null;
  const revision = dmWritingRevision(source, step.instructions, facts, offer);
  return async (llm) => {
    const dm = await writeStepDm(source, { organizationId: run.organizationId, step, facts, offer, llm });
    if (dm.kind === "held") {
      if (dm.reading && source.kind === "exchange") await withOrg(run.organizationId, (tx) => keepReading(tx, source.incoming, dm.reading!));
      return null;
    }
    const written = dm.draft;
    if (offer !== null && unsupportedOfferClaim(written.text, offer) !== null) return null;
    return { ...written,
      writing: { stepId: step.step_id, instructions: step.instructions, contextRevision: revision },
      current: async (currentTx) => {
        const latest = await currentRun(currentTx, run);
        const fresh = latest && await stepConversation(currentTx, latest, conversation.checkpoint.id);
        if (!latest || !fresh) return false;
        const currentFacts = facts.length ? await currentTx.select().from(productFacts)
          .where(inArray(productFacts.id, facts.map(fact => fact.id))) : [];
        const currentOffer = offer ? await approvedOffer(currentTx, offer.ref) : null;
        const currentSource = fresh.input.incoming
          ? await exchangeSource(currentTx, { incoming: fresh.input.incoming, campaign: latest.campaign,
            voice: latest.strategy.document.voice, now: latest.now })
          : fresh.input.conversation === null ? null : await conversationSource(currentTx, {
            conversation: fresh.conversation, campaign: latest.campaign, dmHistory: fresh.input.conversation,
            eventType: fresh.event.type, voice: latest.strategy.document.voice, now: latest.now });
        return currentSource !== null && dmWritingRevision(currentSource, fresh.step.instructions, currentFacts, currentOffer) === revision;
      },
    };
  };
}

async function redraftActions(run: Run, out: VoiceRedraft): Promise<void> {
  const queued = await withOrg(run.organizationId, (tx) =>
    tx
      .select({ id: actions.id })
      .from(actions)
      .where(queuedWords(run.campaign.id))
      .orderBy(asc(actions.id)),
  );
  for (const { id } of queued) {
    const read = await withOrg(run.organizationId, async (tx) => {
      const [action] = await tx
        .select()
        .from(actions)
        .where(and(eq(actions.id, id), queuedWords(run.campaign.id)));
      const conversation = action?.stepRunId ? await stepConversation(tx, run, action.stepRunId) : null;
      if (!action || !conversation) return null;
      if (action.kind === "invite") {
        const thread = conversation.input.thread;
        if (thread === null) return null;
        const source = await noteSource(tx, {
          campaign: run.campaign,
          authorProfileId: conversation.conversation.authorProfileId,
          voice: run.strategy.document.voice,
          now: run.now,
        });
        const noteInput = {
          thread,
          name: conversation.input.incoming?.authorName ?? null,
          interestShown: conversation.conversation.interestEvidenceEventId !== null,
        };
        const revision = noteWritingRevision(source, { ...noteInput, instructions: conversation.step.instructions });
        const write: Writer = async (llm) => {
          const written = await writeStepNote(source, {
            ...noteInput,
            organizationId: run.organizationId,
            step: conversation.step,
            llm,
          });
          return { ...written,
            writing: { stepId: conversation.step.step_id, instructions: conversation.step.instructions,
              contextRevision: revision },
            current: async (currentTx) => {
              const latest = await currentRun(currentTx, run);
              const fresh = latest && await stepConversation(currentTx, latest, conversation.checkpoint.id);
              if (!latest || !fresh || fresh.input.thread !== thread) return false;
              const currentSource = await noteSource(currentTx, { campaign: latest.campaign,
                authorProfileId: fresh.conversation.authorProfileId, voice: latest.strategy.document.voice, now: latest.now });
              return noteWritingRevision(currentSource, { ...noteInput, name: fresh.input.incoming?.authorName ?? null,
                instructions: fresh.step.instructions, interestShown: fresh.conversation.interestEvidenceEventId !== null }) === revision;
            },
          };
        };
        // A note rests on the facts it was shown, as a fresh one does.
        return { action, write, facts: factsBoundToNote(source, conversation.step) };
      }
      const write = await queuedDmWriter(tx, run, action, conversation);
      return write && { action, write, facts: undefined };
    });
    if (!read) continue;
    const written = await read.write(run.llm);
    const before = read.action.candidate.text!;
    if (written === null) continue;
    const rewritten = await withOrg(run.organizationId, async (tx) => {
      const [locked] = await tx
        .select()
        .from(actions)
        .where(eq(actions.id, read.action.id))
        .for("update");
      if (!locked || !QUEUED_ACTION.includes(locked.status) || locked.candidate.text !== before) return false;
      if (!await written.current(tx)) return false;
      if (await putWords(tx, run, locked, written, read.facts === undefined ? {} : { facts: read.facts })) {
        out.invalidatedApprovals += 1;
      }
      return true;
    });
    if (rewritten) out.actions.push(read.action.id);
  }
}

/** How a queued DM or follow-up is written again from its step's
 *  conversation, bound to the facts and the offer it was — or null where one
 *  of them moved since: that is the gate's to refuse, never a redraft's to
 *  quietly drop. */
async function queuedDmWriter(
  tx: Tx,
  run: Run,
  action: ActionRow,
  conversation: NonNullable<Awaited<ReturnType<typeof stepConversation>>>,
): Promise<Writer | null> {
  const bound = action.candidate.versions.facts;
  const facts =
    bound.length === 0
      ? []
      : await tx.select().from(productFacts).where(inArray(productFacts.id, bound.map((fact) => fact.id)));
  const unmoved = bound.every((fact) =>
    facts.some((row) => row.id === fact.id && row.contentHash === fact.contentHash),
  );
  const offer = await boundOffer(tx, action.candidate.versions.offer);
  return unmoved && offer !== "moved" ? dmWriter(tx, run, conversation, facts, offer) : null;
}

/** New words on a queued action, at the version they were written under, the
 *  DM its checkpoint holds moving with them — and, where they were written
 *  from other facts than the old ones, bound to those. A yes given to the old
 *  words no longer holds; whether one did. */
async function putWords(
  tx: Tx,
  run: Run,
  locked: ActionRow,
  written: Rewrite,
  opts: { statusReason?: string; facts?: ActionRow["candidate"]["versions"]["facts"] } = {},
): Promise<boolean> {
  const { statusReason, facts } = opts;
  const { text } = written;
  const writing = await recordWriting(tx, written);
  const before = locked.candidate.text!;
  const approval = await liveApproval(tx, locked.id);
  if (approval && text !== before) await invalidateApproval(tx, approval, "text", run.now);
  await tx
    .update(actions)
    .set({
      candidate: {
        ...locked.candidate,
        text,
        writing,
        versions: {
          ...locked.candidate.versions,
          strategy: run.strategy.version,
          ...(facts === undefined ? {} : { facts }),
        },
      },
      contentHash: contentHash(locked.kind, text),
      ...(statusReason === undefined ? {} : { statusReason }),
      updatedAt: run.now,
    })
    .where(eq(actions.id, locked.id));
  if (locked.kind !== "invite" && locked.stepRunId !== null) {
    await rewriteHeld(tx, run, locked.stepRunId, new Map([[sha256(before), written]]));
  }
  return approval !== null && text !== before;
}

/** A DM or follow-up the owner asked to have written again, the ask still
 *  standing (`actions/ledger.ts` `requestActionRedraft`). */
const askedToRedo = (actionId: number) =>
  and(
    eq(actions.id, actionId),
    eq(actions.status, "awaiting_review"),
    eq(actions.statusReason, ACTION_REDRAFT.asked),
    eq(actions.origin, "worker"),
    inArray(actions.kind, ["dm", "followup"]),
    isNotNull(actions.stepRunId),
  );

/** Close an ask still standing as not written: its rewrite stopped where
 *  nothing could say so on the row — a failed write, a crash — and the owner
 *  approves, changes or asks again. */
export async function abandonAskedRedraft(organizationId: string, actionId: number): Promise<void> {
  await withOrg(organizationId, (tx) =>
    tx
      .update(actions)
      .set({ statusReason: ACTION_REDRAFT.notWritten, updatedAt: Date.now() })
      .where(askedToRedo(actionId)),
  );
}

/** What became of an ask: written again, or not, with the draft as it was;
 *  `moved` where the owner decided it, or asked again, meanwhile. */
export type ActionRedraftOutcome = "redrafted" | "not_written" | "moved";

/**
 * A DM OR FOLLOW-UP THE OWNER ASKED TO HAVE WRITTEN AGAIN — Redraft in their
 * Messages. Its step's writer writes it again now, from their conversation as
 * it stands and in the voice the active version states, bound to the facts
 * and the offer it was: the rewrite a voice update gives a queued DM, for one
 * draft, on the owner's word. It waits for their yes, as it did.
 *
 * Written with no transaction held, then kept under a compare-and-swap on the
 * ask: a yes, an edit or a skip given meanwhile moved the row, and it is left
 * as the owner left it. Words a voice update put there meanwhile answer the
 * ask as they stand. Words that cannot be written again — the campaign no
 * longer on its strategy, the step or its conversation gone, a fact or the
 * offer moved, the model failing — leave the draft as it was, the ask closed
 * with why, for the owner to approve, change or write themselves; it is not
 * tried again until they ask again.
 */
export async function redraftAskedAction(
  ctx: { organizationId: string; llm: LLM },
  actionId: number,
): Promise<ActionRedraftOutcome> {
  const read = await withOrg(ctx.organizationId, async (tx) => {
    const [action] = await tx.select().from(actions).where(askedToRedo(actionId));
    if (!action || action.campaignId === null) return null;
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, action.campaignId));
    const strategy = campaign ? await loadStrategy(tx, campaign) : null;
    if (!campaign || !strategy) return { action, run: null, write: null };
    const run: Run = { ...ctx, campaign, strategy, now: Date.now() };
    const conversation = await stepConversation(tx, run, action.stepRunId!);
    return { action, run, write: conversation && (await queuedDmWriter(tx, run, action, conversation)) };
  });
  if (!read) return "moved";
  let written: Rewrite | null = null;
  if (read.write) {
    try {
      written = await read.write(ctx.llm);
    } catch (error) {
      console.error(`[redraft] DM ${actionId} was not written again:`, error);
    }
  }
  return withOrg(ctx.organizationId, async (tx) => {
    const [locked] = await tx.select().from(actions).where(askedToRedo(actionId)).for("update");
    if (!locked) return "moved";
    if (read.run === null || written === null || locked.candidate.text !== read.action.candidate.text || !await written.current(tx)) {
      // Words a voice update put there since are the draft's newest.
      const answered = locked.candidate.text !== read.action.candidate.text;
      await tx
        .update(actions)
        .set({
          statusReason: answered ? ACTION_REDRAFT.written : ACTION_REDRAFT.notWritten,
          updatedAt: Date.now(),
        })
        .where(eq(actions.id, locked.id));
      return answered ? "redrafted" : "not_written";
    }
    await putWords(tx, read.run, locked, written, { statusReason: ACTION_REDRAFT.written });
    return "redrafted";
  });
}

async function redraftHeldDms(run: Run, out: VoiceRedraft): Promise<void> {
  const holding = await withOrg(run.organizationId, (tx) =>
    tx.select({ id: stepRuns.id }).from(stepRuns).where(openHoldingDms(run.campaign.id)).orderBy(asc(stepRuns.id)),
  );
  for (const { id } of holding) {
    const read = await withOrg(run.organizationId, async (tx) => {
      const conversation = await stepConversation(tx, run, id);
      if (!conversation || !OPEN_CHECKPOINT.includes(conversation.checkpoint.status)) return null;
      // A held DM an action carries is that action's: it moved with it, or
      // stays as the action stands.
      const carried = new Set(
        (
          await tx
            .select({ candidate: actions.candidate })
            .from(actions)
            .where(and(eq(actions.stepRunId, id), inArray(actions.kind, ["dm", "followup"])))
        ).map((row) => row.candidate.text),
      );
      const held: Array<{ draft: Extract<StepDraft, { kind: "dm" }>; write: Writer }> = [];
      for (const draft of conversation.checkpoint.drafts) {
        if (draft.kind !== "dm" || carried.has(draft.text)) continue;
        const facts =
          draft.versions.facts.length === 0
            ? []
            : await tx.select().from(productFacts).where(inArray(productFacts.id, draft.versions.facts));
        const offer = await boundOffer(tx, draft.offer);
        const write = offer === "moved" ? null : await dmWriter(tx, run, conversation, facts, offer);
        if (write) held.push({ draft, write });
      }
      return held;
    });
    if (!read?.length) continue;
    const rewritten = new Map<string, Rewrite>();
    for (const { draft, write } of read) {
      const written = await write(run.llm);
      if (written !== null) rewritten.set(draft.textHash, written);
    }
    if (rewritten.size === 0) continue;
    if (await withOrg(run.organizationId, (tx) => rewriteHeld(tx, run, id, rewritten))) {
      out.checkpoints.push(id);
    }
  }
}

/** Put new words in place of the held DMs whose words hashed to a key of
 *  `rewritten`, on a checkpoint still open. */
async function rewriteHeld(
  tx: Tx,
  run: Run,
  checkpointId: number,
  rewritten: Map<string, Rewrite>,
): Promise<boolean> {
  const [locked] = await tx
    .select({ status: stepRuns.status, drafts: stepRuns.drafts })
    .from(stepRuns)
    .where(eq(stepRuns.id, checkpointId))
    .for("update");
  if (!locked || !OPEN_CHECKPOINT.includes(locked.status)) return false;
  let moved = false;
  const drafts: StepDraft[] = [];
  for (const draft of locked.drafts) {
    const written = draft.kind === "dm" ? rewritten.get(draft.textHash) : undefined;
    if (draft.kind !== "dm" || written === undefined || !await written.current(tx)) {
      drafts.push(draft);
      continue;
    }
    moved = true;
    drafts.push({
      ...draft,
      text: written.text,
      textHash: sha256(written.text),
      writing: await recordWriting(tx, written),
      versions: { ...draft.versions, strategy: run.strategy.version },
    });
  }
  if (moved) await tx.update(stepRuns).set({ drafts, updatedAt: run.now }).where(eq(stepRuns.id, checkpointId));
  return moved;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * What a voice update does to the drafts still waiting, said on its card
 * before it applies (§09): how many are written again, and that nothing sent
 * is. Empty where the voice does not move.
 */
export async function voiceRedraftPreview(
  tx: Tx,
  campaignId: number,
  before: StrategyVoice,
  after: StrategyVoice,
): Promise<string[]> {
  if (!voiceMoved(before, after)) return [];
  const [replies] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(waitingReplies(campaignId));
  const [queued] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .where(queuedWords(campaignId));
  const n = (replies?.n ?? 0) + (queued?.n ?? 0);
  return [
    n === 0
      ? "No draft is waiting, so none is written again; drafts from now on are written in the new voice."
      : n === 1
        ? "The draft still waiting is written again in the new voice as it takes effect, kept beside the words it replaces; a yes given to its old words no longer holds."
        : `The ${n} drafts still waiting are written again in the new voice as it takes effect, each kept beside the words it replaces; a yes given to their old words no longer holds.`,
    "Nothing already sent, and no reply you approved or edited, is touched; an undo restores the old voice for work from then on.",
  ];
}
