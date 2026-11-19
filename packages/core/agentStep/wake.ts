import { createHash } from "node:crypto";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  conversationEvents,
  conversations,
  stepRuns,
  stepToolCalls,
  type Campaign,
  type ConversationEventRow,
  type ConversationRow,
  type StepMemoryPatch,
  type StepRunRow,
  type StepRunStatus,
  type StepWait,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { isDmRefusal, type DmRefusal } from "../actions/dm";
import { pausesTouching, pauseVerdict, scopesOf } from "../actions/pause";
import { LLMOutputError, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import type { CapabilityId } from "../strategy/catalog";
import type { StrategyStep } from "../strategy/contract";
import type { ResolvedAction } from "../strategy/resolve";
import { liveModes } from "../strategy/mode";
import { rememberFromStep, stepMayRemember } from "../memory/records";
import { roomEventRefusal } from "../rooms/continuation";
import { proposeRoomReply } from "./roomDispatch";
import { resolvedReadsOn, unmetBarrier } from "./barriers";
import {
  estimateTokens,
  progressAfter,
  remainingActions,
  tripBeforeCall,
  type BudgetSpent,
} from "./budget";
import {
  dispatchCall,
  foldLikeCall,
  proposeReply,
  recordCall,
  reserveCall,
  type DispatchOutcome,
  type DispatchRefusal,
  type ReserveContext,
  type WokenBy,
} from "./dispatch";
import { answerReply, soleReply } from "./directReply";
import { wakeOnHandOn } from "./handOn";
import { buildStepInput, likeConversation, type StepInput } from "./input";
import { stepSystemPrompt, stepUserPrompt, type HistoryEntry } from "./prompt";
import {
  MAX_WAIT_HOURS,
  RATIONALE_SUMMARY_CHARS,
  WAIT_EVENTS,
  agentStepResultSchema,
  withBareInputIds,
  type AgentStepResult,
  type WaitEvent,
  type WaitRequest,
} from "./result";
import {
  ownerReplyPending,
  reopenable,
  stepById,
  type ConversationItem,
  type ConversationPlan,
  type LoadedStrategy,
} from "./select";
import {
  callDigest,
  memoryPatchAdmitted,
  validateCalls,
  type CallVerdict,
  type DiscardReason,
} from "./validate";
import {
  armWaitTimeout,
  consumeWait,
  conversationCorrelation,
  judgeWait,
  supersedeWaits,
  waitFor,
  waitMatches,
  type CitedWords,
  type WakeRefusal,
} from "./wait";

/**
 * THE WAKE — the Ambassador's conversation work for one run, a conversation at a
 * time, each conversation one step's loop (spec §02 R17, §04 R19, §08):
 *
 *   1. open the step's checkpoint — or adopt the one a crashed wake left —
 *      after re-reading the conversation's guards and the step's barriers;
 *   2. build its input from the contexts it names;
 *   3. ask the owner's agent CLI for one `AgentStepResult`;
 *   4. judge every proposed call (`validate.ts`), record a row for each,
 *      dispatch the permitted reads and drafts itself, and queue a permitted
 *      send for the owner's yes — a Like reserved on the action ledger, a
 *      Reply proposed on `messages` — never anything that goes out without
 *      one;
 *   5. ask again with what they returned, until the step proposes nothing
 *      more, a budget trips, a draft is refused, or two iterations in a row
 *      dispatch nothing — then the step's `on_no_progress` decides.
 *
 * A Reply when they answer step whose only action above Off is Reply skips the loop:
 * the server drafts the reply itself as the step's one tool call
 * (`directReply.ts`), and the step waits for their next one.
 *
 * The step's last word is its own: achieved, waiting — for the person, or
 * until a time it names (`wait.ts` `judgeWait`) — or a person's to decide.
 * The server bounds it, never replaces it: a wait it cannot arm, or a DM its
 * rules refuse (too soon, already nudged, nothing of theirs to answer), is
 * told to the step with why, and the step decides again. A Stop, a hold or an
 * exclusion still ends it.
 *
 * Nothing a model returns is executed or counted: each call's row is the
 * server's record of what was done with it, and a run's sums are counted over
 * those rows (`runSums.ts`). Every model call happens with no transaction open; each
 * checkpoint write is its own short one, so a crash between iterations leaves
 * a checkpoint the next wake adopts — its spend and its dispatched calls with
 * it, so a crash neither buys a fresh budget nor drafts twice.
 *
 * A Stop is read before every model call, against the generation the plan
 * was made under (INV-29): a pause on the account, the campaign or the
 * conversation — or one written since the wake began, even if already
 * resumed — ends the step `guard:paused:…`, which the next wake after a
 * Resume picks up afresh.
 */

export type ConversationTally = {
  /** The strategy steps a checkpoint was opened or adopted for. */
  servedStepIds: string[];
};

export function emptyTally(): ConversationTally {
  return { servedStepIds: [] };
}

export type WakeOptions = {
  organizationId: string;
  runId: number;
  /** As the run read it: its run mode is the one every step is served
   *  under, and a campaign that moved off it mid-wake drafts nothing more. */
  campaign: Campaign;
  llm: LLM;
  /** The run's pinned instant: facts' freshness, barriers and expiries. */
  now: number;
  /** Renews the run's lease; false stops the wake between model calls. */
  continueRun: () => Promise<boolean>;
  /** The pause generation the plan was made under. */
  generationSeen: number;
};

/** Work the plan's conversations in order, into `tally` — the caller's, so a wake
 *  that throws still leaves what it did on the run row. */
export async function runConversationWake(
  plan: Extract<ConversationPlan, { kind: "plan" }>,
  opts: WakeOptions,
  tally: ConversationTally,
): Promise<void> {
  for (const item of plan.items) {
    if (!(await opts.continueRun())) return;
    const step = stepById(plan.strategy.document, item.stepId);
    if (!step) continue;
    if (await runStep(plan.strategy, item, step, opts)) {
      if (!tally.servedStepIds.includes(step.step_id)) tally.servedStepIds.push(step.step_id);
    }
  }
}

/** What the next iteration is told of a call the server did not dispatch. */
const NOT_DISPATCHED: Record<DiscardReason | DispatchRefusal, string> = {
  unknown_tool: "no such tool",
  version_mismatch: "that is not the tool's version",
  outside_grants: "this step may not use that tool",
  mode_off: "that send is Off here; nothing was sent",
  target_mismatch: "this step's binding aims that send at another target; nothing was queued",
  write_unavailable: "nothing is sent in this run",
  reply_off: "Reply is Off here, so a reply would have no yes to wait for; nothing was drafted",
  unbound_input: "an input is bound to nothing you were handed, or a required input is missing",
  target_unavailable: "that target is not in this conversation",
  duplicate_call: "already done earlier in this step",
  over_budget: "past this step's tool budget",
  input_version_mismatch: "your input_version is not the input's",
  stale_fact: "a fact it is bound to is stale or gone; nothing was drafted",
  cta_unapproved:
    "an offer is made only in a DM, from the campaign's offer as the owner approved it, and this one is not; nothing was drafted",
  cta_claim_unsupported:
    "the draft said something about the offer its approved words do not — a free trial, a discount, instant access or another link; nothing was kept",
  guard_moved: "the conversation changed under the step; nothing was written",
  reservation_refused:
    "the conversation, its campaign or its account is stopped, held or excluded; nothing was queued",
};

/** What the next iteration is told of a DM its rules refused — something it
 *  can plan around, by waiting or answering instead. */
const DM_RULE: Record<DmRefusal, string> = {
  no_thread: "no conversation with them is bound yet",
  owner_held: "the conversation with them is the owner's own: Engager only shows it, and sends no words of its own there",
  dm_pending: "a message to them already waits for the owner's yes",
  dm_unsettled: "nobody knows yet whether the last message to them went out",
  person_cap: "the account's 30-day cap on messages to this person is reached",
  person_cap_unset: "the account sets no per-person cap, so nothing unattended goes to them",
  trigger_not_eligible: "what you are answering is not something to answer",
  acceptance_not_interest: "an accepted invitation alone is not interest",
  interest_missing: "they have not asked about the product in their own words",
  incoming_opener_off: "this campaign sends no opener after their invitation",
  link_unverified: "their invitation is not verifiably tied to an exchange",
  opener_spent: "the one opener was already sent",
  no_trigger: "nothing here is a message to answer",
  dm_unanswered: "our last message is unanswered, so only a follow-up may come next",
  cta_unconfigured: "this campaign has no offer configured",
  cta_asset_mismatch: "that is not this campaign's offer",
  cta_unapproved: "the offer is not approved as it stands, or is retired",
  cta_claim_unsupported: "the draft says more about the offer than its approved words do; draft it again",
  cta_offered_already: "the offer was already made",
  cta_too_early: "too few exchanges for the offer yet",
  followup_off: "this campaign allows no follow-up",
  followup_no_dm: "there is no message of ours to follow up",
  followup_answered: "they wrote after our last message, so answer them with send_dm instead",
  followup_spent: "one follow-up already went unanswered, so wait for them",
  followup_too_soon:
    "too soon after our unanswered message: not before the campaign's follow-up delay, unless you woke at a time their own quoted words named",
  followup_offer: "a follow-up never carries an offer",
};

/** What the next iteration is told of a wait the server did not arm. */
const NOT_ARMED: Record<WakeRefusal, string> = {
  wake_time_invalid: "wake_at is not an ISO 8601 time with its offset; nothing was armed",
  wake_out_of_range: `wake_at is not after now and within ${MAX_WAIT_HOURS / 24} days; nothing was armed`,
  wake_unresolved_evidence:
    "a wait's evidence_refs must be events of this conversation you were shown, and a named time needs at least one; nothing was armed",
  wake_unquoted: "quote is not their words, copied exactly, in a message of theirs you cited; nothing was armed",
};

/** The name a refused wait's row is recorded under: not a catalog tool, so it
 *  never binds as an output or dispatches. */
const WAIT_TOOL = "wait";

/** The events whose words are the person's own. */
const THEIR_WORDS: ReadonlySet<string> = new Set(["inbound_message_observed", "reply_observed", "reply_edited"]);

/** What a call's row says was done with it, as a later iteration is told. */
function discardDetail(row: { tool: string; reason: string; resultRef: string | null }): string {
  const rule = row.resultRef?.startsWith("refused:") ? row.resultRef.slice("refused:".length) : null;
  if (row.reason === "reservation_refused" && rule !== null && isDmRefusal(rule)) {
    return `refused — ${DM_RULE[rule]}; nothing was queued`;
  }
  if (row.tool === WAIT_TOOL && Object.hasOwn(NOT_ARMED, row.reason)) return NOT_ARMED[row.reason as WakeRefusal];
  return NOT_DISPATCHED[row.reason as DiscardReason | DispatchRefusal] ?? row.reason;
}

type Ending = {
  status: Exclude<StepRunStatus, "running">;
  blockedReason?: string | null;
  wait?: StepWait | null;
};

/** Whether a dispatched call answers their reply in public: the draft, or the
 *  Reply that sends it — what a Like of the same reply folds into. */
function answers(row: { tool: string; targetKind: string | null }): boolean {
  return ["draft_comment", "reply_public", "reply_to_comment"].includes(row.tool) &&
    ["their_reply", "room_comment"].includes(row.targetKind ?? "");
}

/** A like folded into the answer to its reply rides with that answer where it
 *  can, and is reserved as a like of its own where it cannot. */
async function reserveOrFold(fold: boolean, ctx: ReserveContext): Promise<DispatchOutcome> {
  return (fold ? await foldLikeCall(ctx) : null) ?? reserveCall(ctx);
}

/** One step on one conversation. True when a checkpoint was opened or adopted —
 *  whatever it came to, the step was served. */
async function runStep(
  strategy: LoadedStrategy,
  item: ConversationItem,
  step: StrategyStep,
  opts: WakeOptions,
): Promise<boolean> {
  const org = opts.organizationId;
  const opened = await withOrg(org, (tx) => openCheckpoint(tx, strategy, item, step, opts));
  if (opened.kind === "decided") return false;
  if (opened.kind === "ended") return true;
  const { checkpoint, conversation, event } = opened;
  const finish = (ending: Ending) =>
    withOrg(org, (tx) => finishCheckpoint(tx, checkpoint.id, ending));
  const woke = await withOrg(org, (tx) => wokenBy(tx, checkpoint, opts.now));

  const stepInput = await withOrg(org, (tx) =>
    buildStepInput(tx, {
      step,
      campaign: opts.campaign,
      memoryBindings: strategy.document.memory_bindings,
      conversation,
      event,
      now: opts.now,
    }),
  );
  if (stepInput.missing.length > 0) {
    await finish(onMissingContext(step, conversation.id, stepInput, opts.now));
    return true;
  }
  await withOrg(org, (tx) =>
    tx
      .update(stepRuns)
      .set({
        inputVersion: stepInput.version,
        evidenceVersion: stepInput.evidenceVersion,
        memoryRefs: stepInput.memory.refs,
        updatedAt: Date.now(),
      })
      .where(eq(stepRuns.id, checkpoint.id)),
  );

  const actions = await withOrg(org, async (tx) => {
    return (await liveModes(tx, opts.campaign.id, opts.now)).filter((action) => action.step_id === step.step_id);
  });
  // What an adopted checkpoint already did: its dispatched calls bind as
  // outputs and are never dispatched again.
  const prior = await withOrg(org, (tx) =>
    tx
      .select()
      .from(stepToolCalls)
      .where(eq(stepToolCalls.stepRunId, checkpoint.id))
      .orderBy(asc(stepToolCalls.id)),
  );
  const outputs = new Map<string, CapabilityId>();
  const dispatched = new Set<string>();
  const produced = new Set<string>();
  const answering = new Set<string>();
  const history: HistoryEntry[] = [];
  for (const row of prior) {
    if (row.outcome === "dispatched") {
      if (row.callId) outputs.set(row.callId, row.tool as CapabilityId);
      dispatched.add(row.callDigest);
      if (row.resultRef) produced.add(row.resultRef);
      if (answers(row) && row.targetRef) answering.add(row.targetRef);
    }
    history.push({
      iteration: row.iteration,
      callId: row.callId,
      tool: row.tool,
      outcome: row.outcome,
      detail:
        row.reason === null
          ? `done in an earlier wake${row.resultRef ? ` (${row.resultRef})` : ""}`
          : discardDetail({ tool: row.tool, reason: row.reason, resultRef: row.resultRef }),
    });
  }

  // A reply step whose only action is Reply is answered by the server alone.
  const sole = soleReply({
    step,
    actions,
    stepInput,
    memoryBindings: strategy.document.memory_bindings,
    item,
  });
  if (sole) {
    if (prior.every((row) => row.outcome !== "dispatched")) {
      if (!(await opts.continueRun())) return true;
      const paused = await heldBeforeCall(org, conversation, event, opts);
      if (paused) {
        await finish({ status: "blocked", blockedReason: `guard:${paused}` });
        return true;
      }
      const answered = await answerReply({
        organizationId: org,
        checkpointId: checkpoint.id,
        runId: opts.runId,
        campaign: opts.campaign,
        step,
        stepInput,
        conversation,
        event,
        sole,
        generationSeen: opts.generationSeen,
        strategyVersion: strategy.version,
        voice: strategy.document.voice,
        llm: opts.llm,
        continueRun: opts.continueRun,
        now: opts.now,
      });
      if (answered.kind === "held") {
        await finish({ status: "needs_approval", blockedReason: "sensitive_hold" });
        return true;
      }
      if (answered.kind === "refused") {
        await finish({ status: "blocked", blockedReason: `${answered.reason}:${answered.ref}` });
        return true;
      }
      await saveSpent(org, checkpoint.id, {
        iterations: checkpoint.iterations,
        toolActions: checkpoint.toolActions + 1,
        elapsedMs: checkpoint.elapsedMs,
        tokens: checkpoint.tokens,
      });
    }
    // The reply is answered; their next one is the step's to wait for.
    await finish({ status: "waiting", wait: waitFor(null, { conversationId: conversation.id, event: entryWait(step) }, opts.now) });
    return true;
  }

  const spent: BudgetSpent = {
    iterations: checkpoint.iterations,
    toolActions: checkpoint.toolActions,
    elapsedMs: checkpoint.elapsedMs,
    tokens: checkpoint.tokens,
  };
  const elapsedBefore = checkpoint.elapsedMs;
  const resumedAt = Date.now();
  const system = stepSystemPrompt({
    step,
    actions,
    inputVersion: stepInput.version,
    memoryVersion: stepInput.memory.version,
  });
  let streak = 0;
  for (;;) {
    spent.elapsedMs = elapsedBefore + (Date.now() - resumedAt);
    const trip = tripBeforeCall(step.budget, spent);
    if (trip) {
      await saveSpent(org, checkpoint.id, spent);
      await finish({ status: "budget_exhausted", blockedReason: `budget:${trip}` });
      return true;
    }
    // The run's lease and wall clock bound every step: stopped here, the
    // checkpoint stays `running` and the next wake adopts it.
    if (!(await opts.continueRun())) {
      await saveSpent(org, checkpoint.id, spent);
      return true;
    }
    const paused = await heldBeforeCall(org, conversation, event, opts);
    if (paused) {
      await saveSpent(org, checkpoint.id, spent);
      await finish({ status: "blocked", blockedReason: `guard:${paused}` });
      return true;
    }
    // Spent BEFORE the call, so a wake that dies inside it still paid for it.
    spent.iterations += 1;
    await saveSpent(org, checkpoint.id, spent, opts.runId);
    const iteration = spent.iterations;
    const user = stepUserPrompt({ stepInput, history });
    let result: AgentStepResult;
    try {
      result = withBareInputIds(
        await opts.llm.json({
          model: step.model_override ?? modelFor("writer"),
          system,
          user,
          schema: agentStepResultSchema,
          maxTokens: 2_000,
          stage: "agent_step",
          promptRef: promptRef("agent.step"),
        }),
      );
    } catch (error) {
      if (!(error instanceof LLMOutputError)) throw error;
      spent.tokens += estimateTokens(system, user);
      await saveSpent(org, checkpoint.id, spent);
      await finish({ status: "blocked", blockedReason: "invalid_result" });
      return true;
    }
    spent.tokens += estimateTokens(system, user, JSON.stringify(result));

    const verdicts: CallVerdict[] =
      result.input_version === stepInput.version
        ? validateCalls(result.proposed_tool_calls, {
            step,
            grants: strategy.document.grants,
            actions,
            targets: stepInput.targets,
            context: stepInput.context,
            outputs,
            dispatched,
            answering,
            remainingActions: remainingActions(step.budget, spent),
          })
        : result.proposed_tool_calls.map((call) => ({
            call,
            digest: callDigest(call),
            outcome: "discard" as const,
            reason: "input_version_mismatch" as const,
          }));

    let dispatchedNow = 0;
    let overBudget = false;
    let refusal: { reason: DispatchRefusal; ref: string } | null = null;
    // A like folded into the answer to the same reply goes after it, so the
    // Reply it rides with is on `messages` by the time it looks.
    const ordered = [
      ...verdicts.filter((verdict) => verdict.outcome !== "fold"),
      ...verdicts.filter((verdict) => verdict.outcome === "fold"),
    ];
    for (const verdict of ordered) {
      const record = { checkpoint, runId: opts.runId, iteration, call: verdict.call, digest: verdict.digest };
      const entry = { iteration, callId: verdict.call.call_id, tool: verdict.call.tool };
      if (verdict.outcome === "discard") {
        await withOrg(org, (tx) => recordCall(tx, record, { reason: verdict.reason, resultRef: null }));
        overBudget ||= verdict.reason === "over_budget";
        history.push({ ...entry, outcome: "discarded", detail: NOT_DISPATCHED[verdict.reason] });
        continue;
      }
      const callCtx = {
        organizationId: org,
        record,
        stepInput,
        campaignId: opts.campaign.id,
        conversation,
        event,
        generationSeen: opts.generationSeen,
      };
      const outcome =
        verdict.outcome === "reserve" || verdict.outcome === "fold"
          ? await reserveOrFold(verdict.outcome === "fold", {
              organizationId: org,
              record,
              tool: verdict.tool,
              binding: verdict.binding,
              conversation,
              event: { id: event.id, contentHash: event.contentHash },
              likeContext: likeConversation(stepInput, conversation, event),
              step,
              stepInput,
              campaign: opts.campaign,
              llm: opts.llm,
              strategyVersion: strategy.version,
              voice: strategy.document.voice,
              generationSeen: opts.generationSeen,
              continueRun: opts.continueRun,
              woke,
              now: opts.now,
            })
          : verdict.outcome === "propose"
            ? await (verdict.tool === "reply_to_comment" ? proposeRoomReply : proposeReply)({ ...callCtx,
                mode: verdict.effective === "auto" ? "auto" : "review" })
            : await dispatchCall({
                ...callCtx,
                tool: verdict.tool,
                step,
                strategyVersion: strategy.version,
                voice: strategy.document.voice,
                llm: opts.llm,
                continueRun: opts.continueRun,
                now: opts.now,
              });
      if (outcome.kind === "refused") {
        // A DM rule is the step's to plan around; anything else ends it.
        if (outcome.rule === undefined) refusal ??= outcome;
        history.push({
          ...entry,
          outcome: "discarded",
          detail: discardDetail({ tool: verdict.call.tool, reason: outcome.reason, resultRef: outcome.ref }),
        });
        continue;
      }
      dispatchedNow += 1;
      spent.toolActions += 1;
      outputs.set(verdict.call.call_id, verdict.tool);
      dispatched.add(verdict.digest);
      if (outcome.resultRef) produced.add(outcome.resultRef);
      if (answers({ tool: verdict.tool, targetKind: verdict.call.target.kind })) {
        answering.add(verdict.call.target.ref);
      }
      history.push({ ...entry, outcome: "dispatched", detail: outcome.detail });
    }

    const admitted = result.memory_patches.filter(
      (patch) => memoryPatchAdmitted(patch, strategy.document.memory_bindings) && stepMayRemember(patch),
    );
    await withOrg(org, async (tx) => {
      await saveIteration(tx, checkpoint.id, {
        spent,
        summary: result.rationale_summary.slice(0, RATIONALE_SUMMARY_CHARS),
        evidenceRefs: citedRefs(result.evidence_refs, stepInput, outputs, produced),
        memoryPatches: admitted.map(({ slot, scope, key, value }) => ({ slot, scope, key, value })),
      });
      await rememberFromStep(tx, {
        conversation,
        stepRunId: checkpoint.id,
        patches: admitted,
        evidence: stepInput.evidence,
        now: opts.now,
      });
    });

    if (refusal) {
      await finish({ status: "blocked", blockedReason: item.origin === "room" && refusal.reason === "guard_moved"
        ? `guard:held:${refusal.ref}` : `${refusal.reason}:${refusal.ref}` });
      return true;
    }
    if (overBudget) {
      await finish({ status: "budget_exhausted", blockedReason: "budget:tool_actions" });
      return true;
    }
    let proposed = result.proposed_tool_calls.length;
    if (proposed === 0) {
      if (result.status !== "waiting") {
        await finish({ status: result.status });
        return true;
      }
      const words = await withOrg(org, (tx) => citedWords(tx, conversation.id, result.wait?.evidence_refs ?? []));
      const judged = judgeWait(
        result.wait,
        { conversationId: conversation.id, event: entryWait(step) },
        { evidence: stepInput.evidence, words },
        opts.now,
      );
      if (judged.ok) {
        await finish({ status: "waiting", wait: judged.wait });
        return true;
      }
      // A wait it cannot arm is told to the step, which decides again — and
      // counts as a turn that got nowhere. Only a wait it asked for can fail.
      await withOrg(org, (tx) =>
        recordWaitRefused(tx, {
          checkpointId: checkpoint.id,
          runId: opts.runId,
          iteration,
          conversationId: conversation.id,
          wait: result.wait!,
          reason: judged.reason,
        }),
      );
      history.push({ iteration, callId: null, tool: WAIT_TOOL, outcome: "discarded", detail: NOT_ARMED[judged.reason] });
      proposed = 1;
    }
    const progress = progressAfter({ proposed, dispatched: dispatchedNow }, streak);
    streak = progress.streak;
    if (progress.stalled) {
      await finish(onNoProgress(step, conversation.id, opts.now));
      return true;
    }
  }
}

/** Why the step may not draft or ask a model now: a Stop on its account,
 *  campaign or conversation, or a room reply held. Read before every model
 *  call, against the generation the plan was made under. */
async function heldBeforeCall(
  org: string,
  conversation: Pick<ConversationRow, "id" | "channelId">,
  event: ConversationEventRow,
  opts: Pick<WakeOptions, "campaign" | "generationSeen">,
): Promise<string | null> {
  return withOrg(org, async (tx) => {
    const roomHeld = await roomEventRefusal(tx, event, opts.campaign.id, Date.now(), opts.generationSeen);
    return await pauseGuard(tx, conversation, opts) ?? (roomHeld ? `held:${roomHeld}` : null);
  });
}

/** The words of the conversation's events a wait cites, by ref, and whether each
 *  is the person's own. A ref to anything else resolves to nothing. */
async function citedWords(tx: Tx, conversationId: number, refs: readonly string[]): Promise<CitedWords> {
  const ids = refs.flatMap((ref) => {
    const id = /^event:(\d+)$/.exec(ref)?.[1];
    return id === undefined ? [] : [Number(id)];
  });
  if (ids.length === 0) return new Map();
  const events = await tx
    .select({ id: conversationEvents.id, type: conversationEvents.type, content: conversationEvents.content })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversationId), inArray(conversationEvents.id, ids)));
  return new Map(
    events.map((event) => [`event:${event.id}`, { content: event.content ?? "", theirs: THEIR_WORDS.has(event.type) }]),
  );
}

/** A wait the server did not arm, as a row beside the step's calls: what the
 *  step asked for and why not. */
async function recordWaitRefused(
  tx: Tx,
  input: {
    checkpointId: number;
    runId: number;
    iteration: number;
    conversationId: number;
    wait: WaitRequest;
    reason: WakeRefusal;
  },
): Promise<void> {
  await tx.insert(stepToolCalls).values({
    stepRunId: input.checkpointId,
    runId: input.runId,
    iteration: input.iteration,
    callId: null,
    tool: WAIT_TOOL,
    toolVersion: null,
    targetKind: "dm_thread",
    targetRef: conversationCorrelation(input.conversationId),
    callDigest: createHash("sha256").update(JSON.stringify([WAIT_TOOL, input.wait]), "utf8").digest("hex"),
    outcome: "discarded",
    reason: input.reason,
    resultRef: null,
    createdAt: Date.now(),
  });
}

/** How late a wait's own time may be found before what it wakes is a
 *  catch-up: proposed for review whatever its mode. */
export const WAKE_CATCHUP_GRACE_MS = 3_600_000;

/** What the checkpoint's own wait waking it means: a time the person's quoted
 *  words named — the one thing that lets a follow-up go before the
 *  campaign's delay (`actions/dm.ts` `decideFollowup`) — and whether the wake
 *  was found late. Neither, for a step an event woke. Their time is an
 *  instant the step named (`wake_at`, never hours from now) on a quote of
 *  theirs, and stays theirs only until the owner moves it: the owner's time
 *  is not the person's. */
async function wokenBy(tx: Tx, checkpoint: Pick<StepRunRow, "workKey">, now: number): Promise<WokenBy> {
  const waited = /^timeout:(\d+)$/.exec(checkpoint.workKey)?.[1];
  if (waited === undefined) return { namedTime: false, catchup: false };
  const [row] = await tx.select({ wait: stepRuns.wait }).from(stepRuns).where(eq(stepRuns.id, Number(waited)));
  const wait = row?.wait?.consumedBy === "timeout" ? row.wait : null;
  return {
    namedTime:
      wait !== null && wait.named === true && (wait.movedBy ?? null) === null && (wait.quotedEventId ?? null) !== null,
    catchup: wait !== null && now - wait.expiresAt > WAKE_CATCHUP_GRACE_MS,
  };
}

/** The event a step waits for when its result names none: its own entry
 *  event, where that is one a conversation produces. */
function entryWait(step: StrategyStep): WaitEvent {
  const entry = step.entry.event as WaitEvent;
  return (WAIT_EVENTS as readonly string[]).includes(entry) ? entry : "direct_reply";
}

function onNoProgress(step: StrategyStep, conversationId: number, now: number): Ending {
  switch (step.on_no_progress) {
    case "wait":
      return { status: "waiting", wait: waitFor(null, { conversationId, event: entryWait(step) }, now) };
    case "stop":
      return { status: "blocked", blockedReason: "no_progress" };
    case "escalate":
      return { status: "needs_approval", blockedReason: "no_progress" };
  }
}

function onMissingContext(
  step: StrategyStep,
  conversationId: number,
  stepInput: StepInput,
  now: number,
): Ending {
  const reason = `missing_context:${stepInput.missing.join(",")}`;
  switch (step.on_missing_context) {
    case "wait":
    case "wait_or_review":
      return {
        status: "waiting",
        blockedReason: reason,
        wait: waitFor(null, { conversationId, event: entryWait(step) }, now),
      };
    case "review":
      return { status: "needs_approval", blockedReason: reason };
    case "stop":
      return { status: "blocked", blockedReason: reason };
  }
}

/** The refs a result cited that resolve to something the step was handed or
 *  produced; a ref to anything else is the model's and is dropped. */
function citedRefs(
  refs: readonly string[],
  stepInput: StepInput,
  outputs: ReadonlyMap<string, CapabilityId>,
  produced: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      refs.filter(
        (ref) =>
          stepInput.evidence.has(ref) ||
          produced.has(ref) ||
          (ref.startsWith("call:") && outputs.has(ref.slice("call:".length))),
      ),
    ),
  ];
}

type Opened =
  | { kind: "decided" }
  | { kind: "ended" }
  | { kind: "open"; checkpoint: StepRunRow; conversation: ConversationRow; event: ConversationEventRow };

/**
 * Open the item's checkpoint, or adopt it — from the wake that crashed in
 * it, or from one a passing hold ended — then re-read what a wake must re-read
 * before acting: the conversation is open and runnable, the reply is still its
 * latest revision, the owner is not answering it themselves, and the step's
 * barriers hold. A guard that moved ends the checkpoint `blocked` with why — a
 * held conversation and an unmet barrier reopenable, the rest for good; a wait
 * barrier ends it `waiting` until the hour it lifts.
 */
async function openCheckpoint(
  tx: Tx,
  strategy: LoadedStrategy,
  item: ConversationItem,
  step: StrategyStep,
  opts: WakeOptions,
): Promise<Opened> {
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, item.conversationId))
    .for("update");
  if (!conversation) return { kind: "decided" };
  const stamp = Date.now();
  const [checkpoint] = await tx
    .insert(stepRuns)
    .values({
      runId: opts.runId,
      conversationId: item.conversationId,
      campaignId: opts.campaign.id,
      stepId: step.step_id,
      workKey: item.workKey,
      eventId: item.eventId,
      strategyVersion: strategy.version,
      startedAt: stamp,
      updatedAt: stamp,
    })
    .onConflictDoUpdate({
      target: [stepRuns.organizationId, stepRuns.conversationId, stepRuns.stepId, stepRuns.workKey],
      // Adopted: a crashed wake's checkpoint, or one a passing hold ended.
      set: {
        runId: opts.runId,
        strategyVersion: strategy.version,
        status: "running",
        blockedReason: null,
        finishedAt: null,
        updatedAt: stamp,
      },
      setWhere: or(eq(stepRuns.status, "running"), reopenable(stepRuns)),
    })
    .returning();
  if (!checkpoint) return { kind: "decided" };
  // A checkpoint a crashed wake left on an older reply is answered by this
  // one, which reads the whole thread.
  await tx
    .update(stepRuns)
    .set({ status: "blocked", blockedReason: "superseded", finishedAt: stamp, updatedAt: stamp })
    .where(
      and(
        eq(stepRuns.conversationId, conversation.id),
        eq(stepRuns.stepId, step.step_id),
        eq(stepRuns.status, "running"),
        ne(stepRuns.id, checkpoint.id),
      ),
    );

  const [event] = await tx
    .select()
    .from(conversationEvents)
    .where(eq(conversationEvents.id, item.eventId));
  if (event && item.workKey.startsWith("event:")) {
    // The reply this answers ends any wait on the conversation it matches, even
    // one the recording path did not reach.
    const waiting = await tx
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.conversationId, conversation.id), eq(stepRuns.status, "waiting")));
    for (const row of waiting) {
      if (waitMatches(row.wait, event)) await consumeWait(tx, row, "event", stamp);
    }
  }
  const later = alias(conversationEvents, "later");
  const [revised] = await tx
    .select({ id: later.id })
    .from(later)
    .where(eq(later.supersedesEventId, item.eventId))
    .limit(1);
  const paused = await pauseGuard(tx, conversation, opts);
  const roomHeld = event ? await roomEventRefusal(tx, event, opts.campaign.id, Date.now(), opts.generationSeen) : null;
  const guard = !event
    ? "reply_gone"
    : conversation.closedReason !== null
      ? "conversation_closed"
      : conversation.opsStatus !== "runnable"
        ? `held:${conversation.opsStatus}`
        : paused
          ? paused
          : revised
            ? "reply_revised"
            : (await ownerReplyPending(tx, conversation.id))
              ? "owner_reply_pending"
              : roomHeld ? `held:${roomHeld}` : null;
  if (guard || !event) {
    await finishCheckpoint(tx, checkpoint.id, { status: "blocked", blockedReason: `guard:${guard}` });
    return { kind: "ended" };
  }

  const achieved = await tx
    .selectDistinct({ stepId: stepRuns.stepId })
    .from(stepRuns)
    .where(and(eq(stepRuns.conversationId, conversation.id), eq(stepRuns.status, "achieved")));
  const actions = await liveModes(tx, opts.campaign.id, opts.now);
  const barrier = unmetBarrier(step, {
    achievedSteps: new Set(achieved.map((row) => row.stepId)),
    readsOn: resolvedReadsOn(actions),
    occurredAt: event.occurredAt,
    interest: conversation.interestEvidenceEventId !== null,
    relevant: (event.decision as { decision?: unknown } | null)?.decision === "eligible",
    now: opts.now,
  });
  if (barrier?.type === "wait") {
    await finishCheckpoint(tx, checkpoint.id, {
      status: "waiting",
      blockedReason: "barrier:wait",
      wait: {
        ...waitFor(null, { conversationId: conversation.id, event: entryWait(step) }, opts.now),
        expiresAt: barrier.until,
        onTimeout: "wake",
      },
    });
    return { kind: "ended" };
  }
  if (barrier) {
    await finishCheckpoint(tx, checkpoint.id, {
      status: "blocked",
      blockedReason: `barrier:${barrier.type}:${barrier.detail}`,
    });
    return { kind: "ended" };
  }
  return { kind: "open", checkpoint, conversation, event };
}

/** `paused:<scope>:<reason>` when a pause on the conversation's account, campaign
 *  or conversation is open, or was written after the plan's generation. */
async function pauseGuard(
  tx: Tx,
  conversation: Pick<ConversationRow, "id" | "channelId">,
  opts: Pick<WakeOptions, "campaign" | "generationSeen">,
): Promise<string | null> {
  const verdict = pauseVerdict(
    await pausesTouching(
      tx,
      scopesOf({ channelId: conversation.channelId, campaignId: opts.campaign.id, conversationId: conversation.id }),
      opts.generationSeen,
    ),
    opts.generationSeen,
  );
  return verdict ? `paused:${verdict.pause.scope}:${verdict.pause.reason}` : null;
}

/** A held conversation, a Stop the owner may resume, or a barrier not met yet: the
 *  checkpoint is picked up again, so it answers nothing yet (`select.ts`
 *  `reopenable`). */
function reopens(ending: Ending): boolean {
  return (
    ending.status === "blocked" &&
    /^(guard:held:|guard:paused:|barrier:)/.test(ending.blockedReason ?? "")
  );
}

/** End the checkpoint. Any ending that answers its work supersedes the waits
 *  the step's older checkpoints still hold on the conversation — the plan stops
 *  serving those once a later checkpoint finished (`select.ts`
 *  `expiredWakes`), so none may stay listed as a wake that cannot fire. An
 *  achieved one wakes the Ambassador for the step it hands the conversation on to
 *  (`handOn.ts`). */
async function finishCheckpoint(tx: Tx, id: number, ending: Ending): Promise<void> {
  const wait =
    ending.status === "waiting" && ending.wait
      ? await armWaitTimeout(tx, id, ending.wait)
      : (ending.wait ?? null);
  const stamp = Date.now();
  const [finished] = await tx
    .update(stepRuns)
    .set({
      status: ending.status,
      blockedReason: ending.blockedReason ?? null,
      wait,
      finishedAt: stamp,
      updatedAt: stamp,
    })
    .where(eq(stepRuns.id, id))
    .returning({ conversationId: stepRuns.conversationId, stepId: stepRuns.stepId, campaignId: stepRuns.campaignId });
  if (finished && !reopens(ending)) {
    await supersedeWaits(tx, { conversationId: finished.conversationId, stepId: finished.stepId, decidedBy: id, now: stamp });
  }
  if (finished && ending.status === "achieved") {
    await wakeOnHandOn(tx, { campaignId: finished.campaignId, conversationId: finished.conversationId, stepRunId: id, now: stamp });
  }
}

/** `turnOf` names the run that just spent a turn, which is added to its share of
 *  the checkpoint's `iterations_by_run` in the same write. */
async function saveSpent(organizationId: string, id: number, spent: BudgetSpent, turnOf?: number): Promise<void> {
  await withOrg(organizationId, (tx) =>
    tx
      .update(stepRuns)
      .set({
        iterations: spent.iterations,
        ...(turnOf === undefined
          ? {}
          : {
              iterationsByRun: sql`jsonb_set(${stepRuns.iterationsByRun}, ARRAY[${String(turnOf)}::text], to_jsonb(coalesce((${stepRuns.iterationsByRun} ->> ${String(turnOf)}::text)::int, 0) + 1))`,
            }),
        toolActions: spent.toolActions,
        elapsedMs: spent.elapsedMs,
        tokens: spent.tokens,
        updatedAt: Date.now(),
      })
      .where(eq(stepRuns.id, id)),
  );
}

/** One iteration's checkpoint: what it spent, the step's summary and cited
 *  evidence as of now, and the memory updates its bindings admitted. */
async function saveIteration(
  tx: Tx,
  id: number,
  iteration: {
    spent: BudgetSpent;
    summary: string;
    evidenceRefs: string[];
    memoryPatches: StepMemoryPatch[];
  },
): Promise<void> {
  await tx
    .update(stepRuns)
    .set({
      iterations: iteration.spent.iterations,
      toolActions: iteration.spent.toolActions,
      elapsedMs: iteration.spent.elapsedMs,
      tokens: iteration.spent.tokens,
      rationaleSummary: iteration.summary,
      evidenceRefs: iteration.evidenceRefs,
      memoryPatches: sql`${stepRuns.memoryPatches} || ${JSON.stringify(iteration.memoryPatches)}::jsonb`,
      updatedAt: Date.now(),
    })
    .where(eq(stepRuns.id, id));
}
