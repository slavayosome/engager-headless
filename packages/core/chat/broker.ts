import { randomUUID } from "node:crypto";
import { contextHash as digest } from "../tasks/hash";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DraftRequest, ideaNote, runRequestedAngles, wordsBox, type BoxWords, type RequestedAngle } from "./requestedDraft";
import { failComposerAngle, putComposerAngle, putComposerIdea, readComposerAngle } from "../composer/drafts";
import { readComposerAsk, requestComposerAngle, type AskedAngle } from "../composer/requests";
import { untrusted } from "../ai/prompts";
import { AppError } from "@engager/common/errors";
import { boundaryModelScopeFor } from "../ai/modelFor";
import { withUsageContext } from "../ai/usage";
import { judgeLLM, runCommentWords } from "./requestedComment";
import { WEB_RESEARCH_SYSTEM, webFinding } from "./webResearch";
import { proposeCampaignFill } from "../campaigns/fill";
import type { MessageBox } from "./draftCommentTool";
import { runDmWords } from "./requestedDm";
import { runInviteWords } from "./requestedInvite";
import { runLeadWords } from "./requestedLead";
import { runRoomReplyWords } from "./requestedRoomReply";
import { deliverRoomReplyAssist, getRoomReplyContext } from "../rooms/replyDrafting";
import {
  prepareRequestedReply,
  runReplyWords,
  runRequestedReplyDraft,
  settledRequestedReply,
  submitRequestedReply,
  type PreparedRequestedReply,
} from "./requestedReply";
export {
  DraftRequest,
  RequestedCommentWords,
  RequestedDmWords,
  RequestedDraft,
  RequestedInviteWords,
  RequestedLeadWords,
  RequestedReplyDraft,
} from "./requestedDraft";
import {
  chatBrokerTurns,
  chatSessions,
  channels,
  tasks,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { ADAPTERS } from "../ai/agentCli";
import {
  installedRoleModels,
  storedAgentRoles,
  storedAgentSelection,
} from "../ai/agentCli/selection";
import { abortFailureCode, agentFailure } from "../ai/agentCli/state";
import { runAgentCli } from "../ai/agentCli/run";
import { AgentCliError } from "../ai/agentCli/types";
import type {
  AgentCliUsage,
  ChatDriverEvent,
  ResolvedAgentSelection,
} from "../ai/agentCli/types";
import type { McpCtx } from "../mcp/context";
import { deliverRequestedAngles } from "../tasks/task";
import { openBrokerTools, WRITE_TOOLS } from "./tools";
import {
  draftRequestShape,
  isTimeoutError,
  trackAgentCallFailed,
  trackDraftDelivered,
  trackDraftRequested,
} from "../telemetry/emit";
import { UNDECIDED_PROPOSAL_NOTE, undecidedProposals } from "./proposals";
import {
  AssistantStep,
  assistantStepJsonSchema,
  brokerSystem,
  claimsToolOutage,
} from "./protocol";
import {
  assertHostedMcpCredentialInTx,
  HostedMcpAccessError,
} from "../mcp/tools/hostedSpend";

const CAMPAIGN_CONFIG_READ = "get_campaign";
const CAMPAIGN_CONFIG_WRITE = "save_campaign";

type Step = {
  id: string;
  key: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "prepared" | "dispatched" | "completed" | "uncertain";
  result?: unknown;
  /** Dispatched by the APP's own requested-draft workflow rather than by a
   *  model that asked for it. What the verification ledger reads off it is
   *  different in kind — see `outstandingVerification`. */
  appOwned?: true;
};
type History = { role: "user" | "assistant" | "tool"; content: unknown };
type Turn = typeof chatBrokerTurns.$inferSelect;
const binding = (_ctx: McpCtx) => "local-stdio";

/**
 * The model a chat turn asks for: the installation's saved `chat` role when it
 * pins one, else the chat selection's own primary.
 *
 * `setLocalAgentRoles` is the one writer of that pin and it admits the model
 * into the selection's durable record before it lands, so the role the owner
 * saved on the Models form is the model the next turn actually runs. Reading
 * only the selection here was how a saved role became a change execution
 * ignored.
 *
 * The pin runs through the same substitution every other role does
 * (`installedRoleModels`): one the installation no longer offers asks for what
 * the Models page says runs in its place, not for the id it names.
 *
 * Read ONCE, at admission: the turn freezes this value beside the selection it
 * was chosen with and asks for it in every request and every report. A Models
 * save that lands while a child is running can no longer rename the model the
 * turn's later steps, report and session reference describe — the answer the
 * owner saved is what the NEXT turn reads.
 */
function chatModelFor(selection: ResolvedAgentSelection): string {
  try {
    const pinned = storedAgentRoles().chat;
    return pinned
      ? installedRoleModels({ chat: pinned }).models.chat
      : selection.modelRef;
  } catch {
    // An unreadable role map is not a reason to lose the chat: the selection
    // is a complete answer on its own, and the executor revalidates it.
    return selection.modelRef;
  }
}

/** The app's own angle delivery, recorded under a name of its own: it is not an
 * MCP tool, it is in no allowlist, and no model can request it. */
const DELIVER_ANGLES = "deliver_requested_angles";
/** The app's own delivery of a reply draft the owner asked for, named for the
 * same reason: the reply intake is no chat tool, and only this workflow, with
 * the owner's request in hand, may land a draft through it. A completed one
 * is the evidence the Inbox reads for "drafted because you asked". */
export const DELIVER_REPLY = "deliver_requested_reply";
/** Who asks for another version from a draft's conversation. */
const CHAT_ACTOR = "owner:dashboard:chat";

/** Receipted deliveries and transactional writes needing a read after interruption.
 * act, decide and submit_draft queue or write state; they never send directly. */
const OBLIGATIONS = new Set([
  "act",
  "decide",
  "submit_draft",
  "finish_task",
  DELIVER_ANGLES,
  DELIVER_REPLY,
]);

/** How many model steps one turn may take, the final included.
 *
 * The observed native setup sequence — a seed, a Brain stage read and submit, a
 * voice stage read and submit, the confirming read and the final — needs ten,
 * so the old eight could not complete it even when every reply was correct.
 * Twelve also fits the worst legitimate repair: nine tools, a premature final
 * the checkpoint withholds, the read it asks for, and the final after that.
 * Nothing else moves: the five-minute timeout, the context ceiling and the
 * two-attempt schema repair are unchanged, and a tool request on the last step
 * still ends the turn without an answer. */
const STEP_BUDGET = 12;
/** The most web look-ups one message runs: each is a model call of its own. */
const WEB_LOOKUPS_A_TURN = 3;

/** Prepared or setup writes require a subsequent get_status read; campaign
 * writes require get_campaign, while interrupted transactional writes require a read before repeat. */
const PREPARED_WRITES = new Set([
  "seed_brain",
  "save_knowledge",
  "start_task",
  "finish_task",
  "cancel_task",
    "complete_setup",
]);

/** The JSON body one MCP tool result carries in its text content, when it has
 *  one. A refusal's transport flag is top level; the operation's own outcome is
 *  in here. A result with no parsable object body stays UNKNOWN — never a
 *  refusal and never verified success. */
function resultBody(step: Step): Record<string, unknown> | undefined {
  const content = (
    step.result as
      | { content?: { type?: string; text?: string }[] }
      | undefined
  )?.content;
  const text = content?.find((part) => part.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a step's own CALL did not get through — MCP's transport-level
 *  `isError`, and nothing else. It is the only receipt that can stand behind a
 *  claim that the broker is unreachable: every other refusal shape below is a
 *  server that received the request, understood it, and declined it. */
function transportFailed(step: Step): boolean {
  return (step.result as { isError?: boolean } | undefined)?.isError === true;
}

/** Whether a completed step's result is a KNOWN logical refusal or no-op rather
 *  than a durable effect.
 *
 *  MCP's `isError` is only the transport-level half: several registry tools
 *  answer a normal JSON body when the operation itself did nothing. The
 *  canonical one is `seed_brain`, whose `{queued:false, mode:"in_session",
 *  reason:"not_connected"}` says no account could be read and NOTHING was
 *  queued, prepared or written. Treating that as progress claimed a durable
 *  change on every unconnected org and handed the turn a fresh read-loop
 *  allowance. The shapes below are each a tool's own canonical answer that its
 *  operation did not take:
 *
 *  - `isError` — `errorResult`, the refusal transport;
 *  - `queued:false` with a `reason` — `seed_brain` not_connected/already_running;
 *  - `changed:false` — `save_knowledge` hit its own dedupe;
 *  - `ok:false` — an apply-level refusal lifted to the receipt root;
 *  - `alreadyRunning:true` — work already in flight;
 *  - empty `taskIds` without `started` — the in-session seed found nothing to
 *    prepare.
 *
 *  `finish_task` persists its receipt even when `acceptedCount`
 *  is 0, so that shape is not a no-op.
 *
 *  A recognized durable answer is the other side: `queued:true`/`started:true`
 *  (a job or sweep marker persisted), `acceptedCount > 0` (accepted work),
 *  `changed:true`/`created:true`, a prepared task or native task row (`id` +
 *  `contextRevision`), and every other result this list does not name. An
 *  UNRECOGNIZED or malformed result is deliberately NOT a refusal: it may well
 *  be a write whose shape this classifier does not know, so it keeps the
 *  verification debt and is never read as verified success. */
function refused(step: Step): boolean {
  const result = step.result as { isError?: boolean } | undefined;
  if (!result || typeof result !== "object") return false;
  if (result.isError === true) return true;
  const body = resultBody(step);
  if (!body) return false;
  if (body.queued === false && typeof body.reason === "string") return true;
  if (body.changed === false) return true;
  if (body.ok === false) return true;
  if (body.alreadyRunning === true) return true;
  if (
    Array.isArray(body.taskIds) &&
    body.taskIds.length === 0 &&
    body.started !== true
  )
    return true;
  return false;
}

/** What the owner reads under an answer that diagnosed the broker with nothing
 *  to diagnose it from: the server's own observation, never a contradiction of
 *  the model. Which observation there is to make depends on whether the turn
 *  asked for anything — "the tools were reachable" is itself a claim nobody
 *  made when no tool was ever called. */
const TOOLS_REACHABLE_NOTE =
  "Engager's tools were reachable during this turn — no tool call failed.";
const NO_TOOL_ATTEMPTED_NOTE =
  "No tool call was attempted this turn, so none failed.";

/** What the step after a withheld outage claim is told, in the server's own
 *  words. One sentence per fact the next step has to act on: the draft is gone,
 *  the tools in front of it are connected, and the way to find out is to
 *  request one — not to send the owner to a terminal. */
const CAPABILITY_CORRECTION = [
  "Your previous draft claimed the broker was unavailable without any failed tool receipt.",
  "That draft was withheld.",
  "The tools in the BROKER TOOLS list are connected; request one as kind:tool with its name and arguments.",
  "Read current state and carry out the owner's request.",
  "Do not tell the owner to reload or reinstall.",
].join(" ");

/** What a withheld final asks the model for on its one correction step. Server-
 *  authored and carried in the payload, never in the transcript: the rejected
 *  prose is not shown or saved, and a model that only sees `verificationRequired`
 *  keeps true has no way to tell a fresh final from the one just refused. */
type VerificationCorrection = {
  withheld: "final";
  requiredTool: "get_status" | typeof CAMPAIGN_CONFIG_READ;
  /** The campaign whose repair this read confirms. Present only for a campaign
   *  repair, because the read that clears it is campaign-specific. */
  campaignId?: number;
  because: string;
};

/** The canonical read one unconfirmed write is still waiting for. */
type VerificationDebt =
  | { requiredTool: "get_status"; because: string }
  | {
      requiredTool: typeof CAMPAIGN_CONFIG_READ;
      campaignId: number;
      because: string;
    };

/** One debt's identity: the exact read that clears it. A read clears only its
 *  own debt, so the key is the read, target included. */
function debtKey(debt: VerificationDebt): string {
  return debt.requiredTool === "get_status"
    ? debt.requiredTool
    : `${debt.requiredTool}:${debt.campaignId}`;
}

/**
 * EVERY read this turn's completed writes are still waiting on, in the order
 * the correction checkpoint asks for them: the repair debts first (a setup read
 * cannot stand in for one), then the prepared/setup debt.
 *
 * `get_status` answers the prepared/setup writes: its result is the
 * organization's own record of what was prepared, queued or accepted. A bounded
 * target repair is different in kind — `get_status` carries counts, not a
 * campaign's `maxPostAgeDays`, `tone.length`, `webFacts` or discovery sources —
 * so the read that clears it is `get_campaign` for the SAME campaign, and
 * a setup read, a read of another campaign, or a read from BEFORE the write
 * leaves the debt standing. Repairs are tracked per campaign so one campaign's
 * confirming read cannot be mistaken for another's, and this is also the
 * freshness test for a repeated read: re-asking one is legitimate exactly while
 * a write sits after the last successful read of what it returns.
 *
 * ALL of them, not just the first: they are independent obligations — two
 * targets can be confirmed in either order, and a prepared write's read can
 * follow or precede a repair's. `verificationRequired` is this list being
 * non-empty; the duplicate guard asks whether the requested read is in it.
 *
 * An `appOwned` step owes nothing. The debt exists because a MODEL asked for a
 * write and then wrote prose about it; the requested-draft workflow is app code
 * that reads every submission's own server receipt (`acceptedCount !== 1`
 * throws) and hands the owner a sentence the app itself authored. The read it
 * would otherwise owe is `get_status`, which carries counts and setup
 * items — never the delivered assist — so it could only ever have confirmed
 * that something else was unchanged.
 */
function outstandingVerification(steps: Step[]): VerificationDebt[] {
  let read = -1;
  let write = -1;
  const repaired = new Map<number, number>();
  const reread = new Map<number, number>();
  steps.forEach((step, index) => {
    if (step.appOwned || step.status !== "completed" || refused(step)) return;
    if (step.name === "get_status" && (!Array.isArray(step.arguments.include) || step.arguments.include.includes("setup"))) read = index;
    else if (step.name === CAMPAIGN_CONFIG_READ) {
      const id = step.arguments.id;
      if (typeof id === "number") reread.set(id, index);
    } else if (step.name === CAMPAIGN_CONFIG_WRITE) {
      const id = step.arguments.id;
      if (typeof id === "number") repaired.set(id, index);
    } else if (PREPARED_WRITES.has(step.name)) write = index;
  });
  const debts: VerificationDebt[] = [];
  for (const [campaignId, at] of repaired)
    if ((reread.get(campaignId) ?? -1) < at)
      debts.push({
        requiredTool: CAMPAIGN_CONFIG_READ,
        campaignId,
        because: `campaign ${campaignId} was repaired this turn and no read of that SAME campaign has confirmed what it now stores`,
      });
  if (write > read)
    debts.push({
      requiredTool: "get_status",
      because:
        "prepared state changed this turn and no canonical read has confirmed it since",
    });
  return debts;
}

/** Whether anything is outstanding, and the debt named FIRST when it is: the
 *  repair's own read when both kinds are owed, because a setup read cannot
 *  supply it. It is the answer to `verificationRequired` and the priority the
 *  correction payload starts from — advice, never authority over what a read
 *  may clear, which `outstandingVerification` alone decides. */
function pendingVerification(steps: Step[]): VerificationDebt | null {
  return outstandingVerification(steps)[0] ?? null;
}

/** Whether an error is how one of the layers a turn awaits says the signal
 *  aborted: a checkpoint's own `throwIfAborted` reason, the hosted scope's
 *  cancellation, or the child's abort code. Such an error carries nothing the
 *  signal does not, which is what makes it safe to rename; anything else is a
 *  real failure and keeps its own words. */
function reportsAbort(error: unknown): boolean {
  if (error instanceof HostedMcpAccessError)
    return error.reason === "request_cancelled";
  if (error instanceof AgentCliError)
    return (
      error.cause?.code === "agent_timeout" ||
      error.cause?.code === "agent_canceled"
    );
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** What a turn's record keeps of the error that ended it: the closed,
 *  lowercase vocabulary the broker and the executor throw, never an adapter's
 *  prose or a database's message. */
function failureCodeOf(error: unknown): string {
  const code =
    error instanceof AgentCliError
      ? (error.cause?.code ?? error.message)
      : error instanceof Error
        ? error.message
        : "";
  return /^[a-z][a-z0-9_]{2,63}$/.test(code) ? code : "unclassified";
}

export type BrokerOptions = {
  ctx: McpCtx;
  sessionId: string;
  requestId: string;
  userText: string;
  system: string;
  draftRequest?: DraftRequest;
  signal: AbortSignal;
  onEvent: (event: ChatDriverEvent) => void;
};

/** All adapters share canonical history, tool dispatch and durable obligations.
 * The executor injection is only for actual-adapter offline conformance tests. */
export function createChatBroker(
  execute = runAgentCli,
  openTools = openBrokerTools,
) {
  return async (opts: BrokerOptions): Promise<void> => {
    const { ctx, sessionId, requestId, onEvent } = opts;
    const draftRequest = opts.draftRequest ? DraftRequest.parse(opts.draftRequest) : undefined;
    const requestHash = digest(draftRequest ? { text: opts.userText, draftRequest } : opts.userText);
    z.string().uuid().parse(requestId);
    if (Buffer.byteLength(opts.userText) > 64 * 1024)
      throw new Error("broker_input_oversized");
    const selection = storedAgentSelection("chat");
    if (!selection) throw new Error("agent_selection_required");
    const adapter = ADAPTERS[selection.adapterId];
    if (!adapter?.descriptor.chat.brokerTools)
      throw new Error("agent_chat_transport_pending");
    // The turn's model, fixed here for the same reason the selection is: a
    // configuration change mid-turn belongs to the next turn, and every step,
    // report and stored reference of THIS one has to name what it actually ran.
    const requestedModel = chatModelFor(selection);
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]);
    signal.throwIfAborted();
    const expiresAt = Date.now() + 300_000;
    const accountBinding = await withOrg(ctx.organizationId, async (tx) => {
      const [channel] = await tx
        .select({
          id: channels.id,
          account: channels.executionAccountId,
          epoch: channels.executionEpoch,
          runtime: channels.executionRuntimeId,
          holder: channels.executionHolder,
          state: channels.executionState,
        })
        .from(channels)
        .limit(1);
      return channel ?? null;
    });
    // A refusal that FOLLOWS a reconciliation is returned rather than thrown:
    // throwing would roll the settlement back with it, and the next turn would
    // have to discover the same abandoned work all over again.
    const admission = await withOrg<
      { refused: string } | { history: History[]; bound: { box: string; position: number } | null }
    >(ctx.organizationId, async (tx) => {
      const [session] = await tx
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .for("update");
      if (!session) throw new Error("broker_session_not_found");
      const prior = await tx
        .select()
        .from(chatBrokerTurns)
        .where(eq(chatBrokerTurns.sessionId, sessionId))
        .orderBy(asc(chatBrokerTurns.createdAt));
      const same = prior.find((turn) => turn.id === requestId);
      if (same) {
        if (
          same.credentialBinding !== binding(ctx) ||
          same.requestHash !== requestHash
        )
          throw new Error("broker_request_conflict");
        throw new Error(
          same.status === "completed"
            ? "broker_request_completed"
            : "broker_recovery_required",
        );
      }
      // A crash leaves a `running` row nobody will ever finish, and the turn id
      // it was admitted under is underivable once the transcript reload has no
      // message to regenerate from. So admission is where an abandoned turn is
      // FOUND: the session lock above serializes it, an unexpired turn is left
      // to the process that owns it, and everything else settles from receipts.
      let unresolved = false;
      for (const turn of prior) {
        if (turn.status !== "running" && turn.status !== "recovery_required")
          continue;
        if (turn.status === "running" && turn.expiresAt > Date.now())
          return { refused: "broker_turn_active" };
        // Every abandoned turn is reconciled, not just the first blocking one,
        // so clearing one obligation does not leave the next still hidden.
        if (
          turn.credentialBinding !== binding(ctx) ||
          (await reconcile(tx, ctx, turn)).status === "recovery_required"
        )
          unresolved = true;
      }
      if (unresolved) return { refused: "broker_recovery_required" };
      // No compaction of unresolved obligations: they blocked above. The newest
      // complete canonical history is already bounded at every append.
      const latest = prior.at(-1);
      const result: History[] = [
        ...((latest?.history as History[]) ?? []),
        { role: "user", content: opts.userText },
      ];
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
        throw new Error("broker_context_full");
      await tx
        .insert(chatBrokerTurns)
        .values({
          id: requestId,
          sessionId,
          credentialBinding: binding(ctx),
          requestHash: requestHash,
          selection: { ...selection, accountBinding, ...(draftRequest ? { draftRequest } : {}) },
          status: "running",
          history: result,
          expiresAt,
        });
      await tx
        .update(chatSessions)
        .set({
          agentReference: {
            adapterId: selection.adapterId,
            configRevision: selection.configRevision,
            requestedModel,
            providerRef: selection.providerRef,
            authRoute: selection.authRoute,
            streamMode: "events",
            providerValidation: "pending_R10",
          },
        })
        .where(eq(chatSessions.id, sessionId));
      return {
        history: result,
        bound: session.boxKey !== null && session.boxPosition !== null ? { box: session.boxKey, position: session.boxPosition } : null,
      };
    });
    if ("refused" in admission) throw new Error(admission.refused);
    const history = admission.history;
    let steps: Step[] = [];
    /** The corrections a withheld final has already earned, keyed by the debt
     *  AND the outstanding-debt set it was asked under. A repair and a prepared
     *  write are confirmed by different reads, so a turn holding both is asked
     *  for each once; a model that answers one debt by clearing another has
     *  still made progress, so the remaining one is asked under the moved
     *  ledger rather than refused. Once nothing outstanding is unasked for its
     *  own ledger state, a final that still cannot stand ends the turn instead
     *  of looping, and a read that clears nothing (the wrong target, an older
     *  revision) leaves every debt exactly where it was. */
    const verificationAsked = new Set<string>();
    /** Set on the step AFTER a withheld final, so that step's payload can say
     *  in the server's own words what happened and what to request. */
    let verificationCorrection: VerificationCorrection | null = null;
    let capabilityCorrection: string | null = null;
    let capabilityCorrected = false;
    const reports: unknown[] = [];
    /** Why the turn ended short, recorded beside its status: `failed` alone
     *  cannot tell the turn's own deadline from a refusal or a crash. */
    let failureCode: string | undefined;
    let tools: Awaited<ReturnType<typeof openBrokerTools>> | undefined;
    async function persist(
      status:
        | "running"
        | "completed"
        | "canceled"
        | "failed"
        | "recovery_required",
    ) {
      await withOrg(ctx.organizationId, async (tx) => {
        const [current] = await tx
          .select()
          .from(chatBrokerTurns)
          .where(
            and(
              eq(chatBrokerTurns.id, requestId),
              eq(chatBrokerTurns.sessionId, sessionId),
              eq(chatBrokerTurns.credentialBinding, binding(ctx)),
            ),
          )
          .for("update");
        if (!current) throw new Error("broker_turn_not_found");
        // Reconciliation or cancellation cannot be undone by a late process.
        const nextStatus =
          current.status === "running" ? status : current.status;
        if (status === "completed" && nextStatus !== "completed")
          throw new Error("broker_turn_inactive");
        const settled = current.steps as Step[];
        steps = steps.map(
          (step) =>
            settled.find(
              (old) => old.id === step.id && old.status === "completed",
            ) ?? step,
        );
        await tx
          .update(chatBrokerTurns)
          .set({
            status: nextStatus,
            history,
            steps,
            selection: {
              ...selection,
              accountBinding,
              reports,
              ...(draftRequest ? { draftRequest } : {}),
              ...(failureCode ? { failure: failureCode } : {}),
            },
          })
          .where(eq(chatBrokerTurns.id, requestId));
      });
    }
    async function active() {
      signal.throwIfAborted();
      const current = storedAgentSelection("chat");
      if (current?.configRevision !== selection!.configRevision)
        throw new Error("agent_selection_stale");
      await withOrg(ctx.organizationId, async (tx) => {
        await assertHostedMcpCredentialInTx(tx, ctx, signal, "feed:read");
        const [channel] = await tx
          .select({
            id: channels.id,
            account: channels.executionAccountId,
            epoch: channels.executionEpoch,
            runtime: channels.executionRuntimeId,
            holder: channels.executionHolder,
            state: channels.executionState,
          })
          .from(channels)
          .limit(1);
        if (digest(channel ?? null) !== digest(accountBinding))
          throw new Error("account_mismatch");
        const [turn] = await tx
          .select()
          .from(chatBrokerTurns)
          .where(
            and(
              eq(chatBrokerTurns.id, requestId),
              eq(chatBrokerTurns.sessionId, sessionId),
            ),
          );
        // A turn that completed may still be judging the words it landed
        // (`dispatcher/landedJudge.ts`); one canceled, failed or past its
        // deadline asks its agent nothing more.
        if (
          (turn?.status !== "running" && turn?.status !== "completed") ||
          turn.credentialBinding !== binding(ctx) ||
          turn.expiresAt <= Date.now()
        )
          throw new Error("broker_turn_inactive");
      });
    }
    async function dispatchTool(tool: { name: string; arguments: Record<string, unknown> }, index: number, retryPreparation = false) {
      if (!tools!.definitions.some((entry) => entry.name === tool.name))
        throw new Error("broker_tool_denied");
      await tools!.validate?.(tool.name, tool.arguments, signal);
      const key = digest(tool);
      // A repeated READ is the one request a turn may legitimately re-issue,
      // and only while an accepted write has moved the state it returns —
      // the checkpoint above requires exactly those reads, and this is the
      // same ledger it computes, so the two can never disagree about which
      // reads are owed. EVERY outstanding debt counts, not only the one the
      // correction names first: two independent debts may legally be read in
      // either order, and a read clears only its own debt. A repeated write,
      // a repeated read with no write behind it, and every other identical
      // request keep the guard they always had.
      const owedRead = outstandingVerification(steps).some(
        (debt) =>
          debt.requiredTool === tool.name &&
          (debt.requiredTool === "get_status" ||
            debt.campaignId === tool.arguments.id),
      );
      const duplicate = steps.some((old) => old.key === key);
      // Only the app-owned draft workflow may re-prepare once after its check.
      // Model-directed requests keep the existing duplicate guard.
      const draftRevision = retryPreparation && draftRequest && tool.name === "start_task" &&
        steps.filter((step) => step.name === tool.name).length === 1;
      if (duplicate && !owedRead && !draftRevision)
        throw new Error("broker_duplicate_tool_request");
      const receipt: Step = {
        id: `${requestId}:${index}`,
        key,
        name: tool.name,
        arguments: tool.arguments,
        status: "prepared",
        ...(draftRequest ? { appOwned: true as const } : {}),
      };
      steps.push(receipt);
      await persist("running");
      await active();
      receipt.status = "dispatched";
      await persist("running");
      await active();
      if (!draftRequest) onEvent({
        kind: "tool-input",
        toolCallId: receipt.id,
        toolName: tool.name,
        input: tool.arguments,
      });
      const result = await tools!.call(tool.name, tool.arguments, signal);
      // Settlement survives cancellation; it cannot pretend the call was undone.
      receipt.status = "completed";
      receipt.result = result;
      history.push(
        { role: "assistant", content: tool },
        { role: "tool", content: result },
      );
      if (Buffer.byteLength(JSON.stringify(history)) > 1024 * 1024)
        throw new Error("broker_context_full");
      await persist("running");
      if (!draftRequest) onEvent({
        kind: "tool-output",
        toolCallId: receipt.id,
        toolName: tool.name,
        output: result,
        isError: Boolean(result.isError),
      });
      onEvent({ kind: "step-end" });
      return result;
    }
    /** The angle delivery, as a durable step.
     *
     * It is a WRITE — it records the candidate's assist and completes the task
     * in one transaction — and it used to be the one write this turn made
     * outside the ledger: nothing in the turn said it had happened, so an
     * interrupted turn could not tell a delivery that landed from one that
     * never ran, and a repeat was refused only by the task's own status.
     * Recorded here it gets what every dispatched write gets — the duplicate
     * guard, the persisted prepared → dispatched → completed lifecycle, and a
     * step recovery can settle from the task's own `angles` receipt. No
     * tool-input/output events: this is app-owned work, like every other step
     * of a requested draft. */
    async function recordAngleDelivery(
      input: { taskId: string; contextRevision: string; angles: RequestedAngle[] },
      index: number,
    ) {
      const step = {
        name: DELIVER_ANGLES,
        arguments: {
          taskId: input.taskId,
          contextRevision: input.contextRevision,
        },
      };
      const key = digest(step);
      if (steps.some((old) => old.key === key))
        throw new Error("broker_duplicate_tool_request");
      const receipt: Step = {
        id: `${requestId}:${index}`,
        key,
        ...step,
        status: "prepared",
        appOwned: true,
      };
      steps.push(receipt);
      await persist("running");
      await active();
      receipt.status = "dispatched";
      await persist("running");
      await active();
      await deliverRequestedAngles(ctx, input, signal);
      // Settlement survives cancellation; it cannot pretend the write was undone.
      receipt.status = "completed";
      receipt.result = { delivered: input.angles.length };
      await persist("running");
    }
    /** A requested reply's delivery, as a durable step for the reason the
     *  angle delivery is one. Its outcome is its result, a refusal included:
     *  the intake's own answer settles the step, and only a delivery whose
     *  transaction never reported back is left for recovery to read. */
    async function recordReplyDelivery(
      input: { prepared: PreparedRequestedReply; text: string },
      index: number,
    ) {
      const step = {
        name: DELIVER_REPLY,
        arguments: {
          incomingCommentId: input.prepared.incomingCommentId,
          requestId: input.prepared.request.requestId,
          target: input.prepared.request.target,
          requestVersion: input.prepared.request.requestVersion,
          text: input.text,
        },
      };
      const key = digest(step);
      if (steps.some((old) => old.key === key))
        throw new Error("broker_duplicate_tool_request");
      const receipt: Step = {
        id: `${requestId}:${index}`,
        key,
        ...step,
        status: "prepared",
        appOwned: true,
      };
      steps.push(receipt);
      await persist("running");
      await active();
      receipt.status = "dispatched";
      await persist("running");
      await active();
      const outcome = await withOrg(ctx.organizationId, (tx) =>
        submitRequestedReply(tx, input.prepared, input.text),
      );
      receipt.status = "completed";
      receipt.result = outcome;
      await persist("running");
      return outcome;
    }
    try {
      let judgment = 0;
      const judge = async ({ system, context, schema }: { system: string; context: unknown; schema: z.ZodTypeAny }) => {
        const ordinal = judgment++;
        for (let attempt = 0; attempt < 2; attempt++) {
          await active();
          let result;
          try {
            result = await execute(adapter, {
              requestId: `${requestId}:draft:${ordinal}:${attempt}`,
              organizationId: ctx.organizationId, runId: requestId,
              model: requestedModel, frozenSelection: selection,
              system,
              user: untrusted("DRAFTING SOURCE DATA", JSON.stringify({ context, ...(attempt ? { correction: "Return a value matching every schema constraint." } : {}) })),
              jsonSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>,
            }, { signal });
          } catch (error) {
            if (attempt === 0 && error instanceof Error && error.message === "invalid_agent_output") continue;
            throw error;
          }
          const report = {
            adapterId: adapter.id, requestedModel,
            actualReportedModel: result.actualReportedModel ?? null,
            usage: Object.keys(result.usage).length ? result.usage : null,
            streamMode: "events" as const,
          };
          reports.push(report);
          await persist("running");
          onEvent({ kind: "agent-report", ...report });
          const parsed = schema.safeParse(result.structured);
          if (parsed.success) return parsed.data;
        }
        throw new Error("invalid_agent_output");
      };
      // The chat's one way to word a comment: the dispatcher, through this
      // turn's own agent. Only the admitted text comes back to the model.
      const draftComment = async (postId: number) =>
        (await runCommentWords({
          organizationId: ctx.organizationId,
          request: { kind: "comment", postId, deliver: "box" },
          llm: judgeLLM(judge),
          progress: () => undefined,
          active,
        })).text!;
      const draftMessage = async (box: MessageBox) => {
        const common = { organizationId: ctx.organizationId, llm: judgeLLM(judge), progress: () => undefined, active };
        const words =
          box.kind === "dm"
            ? await runDmWords({ ...common, request: { kind: "dm", conversationId: box.conversationId, deliver: "box" } })
            : box.kind === "invite"
              ? await runInviteWords({ ...common, request: { kind: "invite", personKey: box.personKey, deliver: "box" } })
              : await runReplyWords({ ...common, request: { kind: "reply", incomingCommentId: box.incomingCommentId, deliver: "box" } });
        return words.text!;
      };
      // A draft the owner asked for is written here, outside any tool call, so
      // it opens the scope every other entry point opens: the dispatcher's
      // planner and writer resolve their model from it.
      const draftScope = async <T>(work: () => Promise<T>) =>
        withUsageContext({ organizationId: ctx.organizationId, requestId, source: "action", stage: "chat.draft_request", ...(await boundaryModelScopeFor(ctx.organizationId)) }, work);
      /**
       * Words the owner asked for, written through their box's own words-only
       * turn and landed in that box: the turn that opens a draft's
       * conversation, and every version the conversation writes after it,
       * where `instruction` is the owner's own words on what to change. The
       * angle the words landed on comes back with them.
       */
      const writeAsked = async (
        request: DraftRequest,
        { progress, instruction }: { progress: (text: string) => void; instruction?: string },
      ): Promise<{ text: string; landed: { box: string; position: number } | null }> => {
        // Usage data: the app asked the agent for words, and what came of it.
        const asked = draftRequestShape(request);
        const askedAt = Date.now();
        trackDraftRequested({ ...asked, surface: "inbox" });
        // An angle the owner's composer asked for, read before any agent
        // call: its box, the angle as the ask left it, and what the writer is
        // told of it.
        const turn = "kind" in request ? request.composer : undefined;
        let composer: AskedAngle | null = null;
        let text: string;
        let landed: { box: string; position: number } | null = null;
        try {
          if (turn) {
            await active();
            composer = await withOrg(ctx.organizationId, (tx) => readComposerAsk(tx, request, turn));
          }
          const ask = composer && instruction && composer.ask.kind === "redraft" ? { ...composer.ask, instruction } : composer?.ask;
          const answer: string | BoxWords = await draftScope(async () => "kind" in request
            ? request.kind === "room_reply"
              ? await runRoomReplyWords({
                  organizationId: ctx.organizationId,
                  llm: judgeLLM(judge),
                  prepare: async () => {
                    await active();
                    const { kind: _kind, deliver: _deliver, composer: _composer, ...room } = request;
                    return withOrg(ctx.organizationId, (tx) => getRoomReplyContext(tx, room));
                  },
                  progress, active, ask,
                  submit: async (prepared, words, note) => {
                    await active();
                    return withOrg(ctx.organizationId, (tx) => deliverRoomReplyAssist(tx, {
                      ...prepared.request, contextRevision: prepared.contextRevision, text: words.text, judged: { note },
                      ...(composer ? { ...composer.at, move: words.move ?? undefined, angle: words.why ?? undefined } : {}),
                    }));
                  },
                })
            : request.kind === "dm"
              ? await runDmWords({
                  organizationId: ctx.organizationId,
                  request: request,
                  llm: judgeLLM(judge),
                  progress,
                  active,
                  ask,
                })
              : request.kind === "invite"
                ? await runInviteWords({
                    organizationId: ctx.organizationId,
                    request: request,
                    llm: judgeLLM(judge),
                    progress,
                    active,
                    ask,
                  })
              : request.kind === "lead"
                ? await runLeadWords({
                    organizationId: ctx.organizationId,
                    request: request,
                    llm: judgeLLM(judge),
                    progress,
                    active,
                    ask,
                  })
              : request.kind === "comment"
                ? await runCommentWords({
                    organizationId: ctx.organizationId,
                    request: request,
                    llm: judgeLLM(judge),
                    progress,
                    active,
                    ask,
                  })
              : request.deliver === "box"
                ? await runReplyWords({
                    organizationId: ctx.organizationId,
                    request: request,
                    llm: judgeLLM(judge),
                    progress,
                    active,
                    ask,
                  })
                : await runRequestedReplyDraft({
                    organizationId: ctx.organizationId,
                    llm: judgeLLM(judge),
                    active,
                    prepare: async () => {
                      await active();
                      return withOrg(ctx.organizationId, (tx) => prepareRequestedReply(tx, request));
                    },
                    submit: async (prepared, written) => {
                      await active();
                      return recordReplyDelivery({ prepared, text: written }, steps.length);
                    },
                    progress,
                  })
            : await runRequestedAngles(request, {
                deliverAngles: async (taskId, contextRevision, angles) => {
                  await active();
                  await recordAngleDelivery({ taskId, contextRevision, angles }, steps.length);
                },
                call: async (name, args, retryPreparation) => {
                  await active();
                  onEvent({ kind: "step-start" });
                  return dispatchTool({ name, arguments: args }, steps.length, retryPreparation);
                },
                progress,
                judge,
              }));
          text = typeof answer === "string" ? answer : (answer.text ?? ideaNote(answer));
          const box = wordsBox(request);
          if (composer && typeof answer !== "string" && answer.text === null) {
            // An angle asked for as an idea lands as a name and a line, and
            // no words, on that angle alone.
            await active();
            const idea = await withOrg(ctx.organizationId, (tx) =>
              putComposerIdea(tx, { box: composer!.box, at: composer!.at, move: answer.move, name: answer.name, why: answer.why ?? "" }),
            );
            landed = { box: idea.boxKey, position: idea.position };
          } else if (box) {
            // Words for the owner's own box land there as one more angle,
            // beside any it holds, and never over what they typed — or, asked
            // for one angle, on that angle alone.
            await active();
            const row = await withOrg(ctx.organizationId, (tx) =>
              putComposerAngle(tx, {
                box,
                text,
                requestedAt: askedAt,
                ...(composer && typeof answer !== "string"
                  ? { at: composer.at, move: answer.move, name: answer.name, why: answer.why }
                  : {}),
              }),
            );
            landed = { box: row.boxKey, position: row.position };
          } else if (composer) {
            // A room's words land through the room's own delivery, on the
            // angle asked for.
            landed = { box: composer.box, position: composer.at.position };
          }
        } catch (error) {
          trackDraftDelivered({
            kind: asked.kind,
            outcome: isTimeoutError(error) ? "timeout" : "failed",
            durationMs: Date.now() - askedAt,
          });
          // The angle asked for keeps the draft it had, or goes; one attempt.
          // Should this write fail too, the read takes the ask as lapsed.
          if (composer) {
            const { box, at } = composer;
            await withOrg(ctx.organizationId, (tx) => failComposerAngle(tx, box, at)).catch(() => undefined);
          }
          throw error;
        }
        trackDraftDelivered({ kind: asked.kind, outcome: "ok", durationMs: Date.now() - askedAt });
        return { text, landed };
      };
      // A conversation a draft opened goes on writing that draft: each version
      // the owner asks for in it lands on the same angle of the same box, one
      // version a message, so a miss is said rather than retried.
      let revised = false;
      const reviseInBox = admission.bound && !draftRequest
        ? async (instruction: string) => {
            const { box, position } = admission.bound!;
            if (revised) {
              throw new AppError(
                "one_version_per_ask",
                "This message already has its version. Tell the owner in one line what it still misses, if anything; the next version waits for their next message.",
                409,
              );
            }
            revised = true;
            await active();
            const { turn } = await withOrg(ctx.organizationId, async (tx) => {
              const row = await readComposerAngle(tx, box, position);
              if (!row) throw new AppError("composer_angle_missing", "That draft is no longer in the box.", 409);
              const at = { position, revision: row.revision };
              return row.state === "idea"
                ? requestComposerAngle(tx, { box, kind: "draft", angle: at, by: CHAT_ACTOR })
                : requestComposerAngle(tx, { box, kind: "redraft", angle: { ...at, source: "agent" }, by: CHAT_ACTOR });
            });
            if (!turn) throw new AppError("composer_angle_missing", "That draft is no longer in the box.", 409);
            return (await writeAsked(turn, { progress: () => undefined, instruction })).text;
          }
        : undefined;
      // Fill in the rest for a campaign not yet created: values only, through
      // this turn's own agent. The judge runs on the turn's signal, so the
      // call's own (its timeout) is checked on each side of it.
      const fillCampaign = async (input: unknown, callSignal: AbortSignal) => {
        callSignal.throwIfAborted();
        const fill = await proposeCampaignFill({ organizationId: ctx.organizationId, input, llm: judgeLLM(judge) });
        callSignal.throwIfAborted();
        return fill;
      };
      // A look-up on the web: a second call of this turn's agent, given the
      // question alone and the web tools alone. Offered only where the agent
      // can be held to that (`supportsWebResearch`).
      let lookups = 0;
      const researchWeb = async (question: string, callSignal: AbortSignal) => {
        callSignal.throwIfAborted();
        if (lookups >= WEB_LOOKUPS_A_TURN) {
          throw new AppError("web_lookups_spent", `A message gets ${WEB_LOOKUPS_A_TURN} look-ups. Answer from what these found.`, 409);
        }
        const ordinal = lookups++;
        await active();
        const result = await execute(adapter, {
          requestId: `${requestId}:web:${ordinal}`,
          organizationId: ctx.organizationId, runId: requestId,
          model: requestedModel, frozenSelection: selection,
          system: WEB_RESEARCH_SYSTEM,
          user: question,
          webResearch: true,
        }, { signal });
        const report = {
          adapterId: adapter.id, requestedModel,
          actualReportedModel: result.actualReportedModel ?? null,
          usage: Object.keys(result.usage).length ? result.usage : null,
          streamMode: "events" as const,
        };
        reports.push(report);
        await persist("running");
        onEvent({ kind: "agent-report", ...report });
        callSignal.throwIfAborted();
        return webFinding(result.text);
      };
      tools = await openTools(askingCtx(ctx, draftRequest), { sessionId, turnId: requestId }, {
        comment: draftComment,
        message: draftMessage,
        fill: fillCampaign,
        ...(adapter.supportsWebResearch ? { web: researchWeb } : {}),
        ...(reviseInBox ? { box: reviseInBox } : {}),
      });
      if (draftRequest) {
        const progress = (text: string) => onEvent({ kind: "final-text", id: randomUUID(), text });
        const { text, landed } = await writeAsked(draftRequest, { progress });
        if (landed) {
          await withOrg(ctx.organizationId, (tx) =>
            tx.update(chatSessions).set({ boxKey: landed.box, boxPosition: landed.position }).where(eq(chatSessions.id, sessionId)),
          );
        }
        if (pendingVerification(steps)) throw new Error("broker_verification_required");
        history.push({ role: "assistant", content: text });
        await persist("completed");
        onEvent({ kind: "final-text", id: randomUUID(), text });
        onEvent({ kind: "result", isError: false });
        return;
      }

      const schema = assistantStepJsonSchema();
      // Built once: every step and repair of this turn sends these exact
      // bytes, which is what lets each step after the first read them from
      // the provider's cache (see `brokerSystem`).
      const system = brokerSystem(opts.system, tools.definitions);
      for (let index = 0; index < STEP_BUDGET; index++) {
        const remainingSteps = STEP_BUDGET - index;
        // Consumed exactly once: only the step that follows the withheld final
        // hears about it, and a later step that is still unverified hears the
        // same `verificationRequired` it always did.
        const correction = verificationCorrection;
        verificationCorrection = null;
        await active();
        onEvent({ kind: "step-start" });
        let step: z.infer<typeof AssistantStep> | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          await active();
          let result;
          try {
            result = await execute(
              adapter,
              {
                requestId: `${requestId}:${index}:${attempt}`,
                organizationId: ctx.organizationId,
                runId: requestId,
                model: requestedModel,
                frozenSelection: selection,
                // The wire contract travels with EVERY adapter, not only the
                // one whose native schema cannot express the kind↔text/tool
                // pairing: Claude/Codex receive it in the system text they are
                // asked to obey, Gemini/OpenCode in the same field of the
                // validated-JSON envelope.
                system,
                user: JSON.stringify({
                  // FIRST, because it only ever grows: each step's history is
                  // a byte prefix of the next step's, which a provider that
                  // caches by token prefix can reuse. Claude Code caches this
                  // whole message as one block and cannot, which is why the
                  // tool list lives in `system` instead. Nothing on the broker
                  // path derives from this object's key order — both the
                  // fixtures and the repair comparison parse it.
                  history,
                  repair: attempt === 1,
                  remainingSteps,
                  verificationRequired: pendingVerification(steps) !== null,
                  verificationCorrection: correction,
                  capabilityCorrection,
                }),
                jsonSchema: schema,
              },
              { signal },
            );
          } catch (error) {
            if (
              attempt === 0 &&
              error instanceof Error &&
              error.message === "invalid_agent_output"
            )
              continue;
            throw error;
          }
          const report = {
            adapterId: adapter.id,
            requestedModel,
            actualReportedModel: result.actualReportedModel ?? null,
            usage: Object.keys(result.usage).length ? result.usage : null,
            streamMode: "events" as const,
          };
          reports.push(report);
          await persist("running");
          onEvent({ kind: "agent-report", ...report });
          const parsed = AssistantStep.safeParse(result.structured);
          if (parsed.success) {
            step = parsed.data;
            break;
          }
        }
        if (!step) throw new Error("invalid_agent_output");
        await active();
        if (step.kind === "final") {
          let finalText = step.text!;
          // The excuse is a TRANSPORT failure and only that: `isError` is the
          // one receipt that says the call itself did not get through. A
          // tool that answered `ok:false` or `alreadyRunning:true` reached the
          // server and was understood, so it is no evidence for a claim that
          // nothing can be reached.
          if (claimsToolOutage(finalText) && !steps.some(transportFailed)) {
            if (!capabilityCorrected && remainingSteps > 2) {
              capabilityCorrected = true;
              capabilityCorrection = CAPABILITY_CORRECTION;
              onEvent({ kind: "step-end" });
              continue;
            }
            // NEVER fail a turn over prose. The detector reads sentences, and
            // a sentence is not a receipt: the owner keeps the answer, with
            // one server-authored line of what the turn actually observed
            // beside it. Appended rather than cut out of the text, because
            // the transcript and recovery both carry whatever the model
            // wrote, and editing that would put words in its mouth.
            finalText = `${finalText}\n\n${steps.length === 0 ? NO_TOOL_ATTEMPTED_NOTE : TOOLS_REACHABLE_NOTE}`;
          }
          const debts = outstandingVerification(steps);
          if (debts.length) {
            // The claim is not publishable until EVERY write it rests on has
            // been read back — and the withheld text is never shown or saved.
            // One more step may ask for ONE still-unasked debt, but only while
            // the turn can still afford the read AND the final after it; past
            // that the honest answer is that the turn ends unverified. The
            // ledger's own state is part of what was asked: a model that
            // answered the named correction by clearing a DIFFERENT debt has
            // made progress, so the remaining debt is asked again under the
            // moved ledger rather than refused. Once every debt has been asked
            // for under the ledger it belongs to, a final that still cannot
            // stand is refused instead of looped. This is its own checkpoint,
            // not the schema repair above: the envelope parsed.
            const state = debts.map(debtKey).join(",");
            const debt = debts.find(
              (candidate) =>
                !verificationAsked.has(`${debtKey(candidate)}@${state}`),
            );
            if (debt && remainingSteps > 2) {
              verificationAsked.add(`${debtKey(debt)}@${state}`);
              verificationCorrection = {
                withheld: "final",
                requiredTool: debt.requiredTool,
                ...(debt.requiredTool === "get_status"
                  ? {}
                  : { campaignId: debt.campaignId }),
                because: debt.because,
              };
              onEvent({ kind: "step-end" });
              continue;
            }
            throw new Error("broker_verification_required");
          }
          // A PROPOSAL the owner has not answered, noted the same way and for
          // the same reason as the outage claim above: the verification
          // checkpoint cannot speak to it, because no canonical read confirms
          // a card nobody has pressed and asking for one would loop. So the
          // server says it in its own sentence, appended after the model's
          // words rather than cut into them.
          //
          // The two notes differ in what they are evidence OF, which is why
          // this one is a row read and not a sentence read: the outage note
          // answers a claim the model made, and this one answers a state the
          // OWNER controls. They may have pressed the button while the model
          // was still thinking, and a note under an answer about a change that
          // has already landed is its own small lie.
          if (
            (await undecidedProposals(ctx.organizationId, requestId)).length
          ) {
            finalText = `${finalText}\n\n${UNDECIDED_PROPOSAL_NOTE}`;
          }
          history.push({ role: "assistant", content: finalText });
          await persist("completed");
          // A complete validated answer is one event, not invented token deltas.
          onEvent({ kind: "final-text", id: randomUUID(), text: finalText });
          onEvent({ kind: "step-end" });
          onEvent({ kind: "result", isError: false });
          return;
        }
        await dispatchTool(step.tool!, index);
      }
      throw new Error("broker_step_limit");
    } catch (error) {
      // The owner's cancel is the one abort that is not a failure: the
      // broker's own five-minute deadline aborts this signal too, and that is
      // a turn which ran out of time.
      const aborted = signal.aborted ? abortFailureCode(signal) : null;
      const canceled = aborted === "agent_canceled";
      // And every layer this turn awaits reports that abort in its OWN words —
      // a checkpoint's bare `TimeoutError`, the hosted scope's
      // `request_cancelled`, the child's `agent_timeout` — so whichever await
      // noticed first used to decide what the turn was called, and a deadline
      // that expired before the child ran answered with a code nothing on the
      // chat path can read. The deadline is the broker's, so the signal that
      // fired names it. Only a report OF this abort is renamed: a real failure
      // that landed in the same window still carries its own words.
      //
      // The deadline gets a name of its own, too. A turn is several children,
      // and `agent_timeout` already means ONE of them did not answer within
      // its own limit; a turn whose every child answered and still ran out of
      // minutes is a different thing to tell the owner.
      const failure =
        aborted && (error === signal.reason || reportsAbort(error))
          ? agentFailure(aborted === "agent_timeout" ? "broker_turn_timeout" : aborted)
          : error;
      failureCode = failureCodeOf(failure);
      // Usage data: the owner's agent failed a chat turn (not a cancel, and not
      // the broker's own limits).
      if (failure instanceof AgentCliError && !canceled) {
        trackAgentCallFailed({ adapter: adapter.id, purpose: "chat", code: failure.cause?.code ?? failure });
      }
      const unresolved = steps.some(
        (step) => step.status === "dispatched" || step.status === "uncertain",
      );
      steps = steps.map((step) =>
        step.status === "dispatched" ? { ...step, status: "uncertain" } : step,
      );
      await persist(
        unresolved ? "recovery_required" : canceled ? "canceled" : "failed",
      );
      throw failure;
    } finally {
      await tools?.close();
    }
  };
}

export const runChatBroker = createChatBroker();

/** The context a turn's tools run under: the turn's own, plus — for the
 *  owner's ask on a waiting comment — that comment, which only this server
 *  side may name (`McpCtx.askedDraft`). */
function askingCtx(ctx: McpCtx, request: DraftRequest | undefined): McpCtx {
  if (!request || "kind" in request || request.messageId === undefined) return ctx;
  return {
    ...ctx,
    askedDraft: {
      campaignId: request.campaignId,
      discoveredPostId: request.discoveredPostId,
      messageId: request.messageId,
      angle: null,
    },
  };
}

/** What core recorded for ONE interrupted step, or undefined while its outcome
 * is still genuinely unknown. Reads rows; never re-issues the request. */
async function settled(tx: Tx, ctx: McpCtx, step: Step) {
  if (!OBLIGATIONS.has(step.name)) return WRITE_TOOLS.has(step.name)
    ? { recovered: "outcome_unknown", note: "Check the current state before deciding what to do next; this operation was not repeated." }
    : { recovered: "no_durable_effect" };
  if (step.name === DELIVER_REPLY) {
    const { incomingCommentId, target, requestVersion } = step.arguments;
    return typeof incomingCommentId === "number" &&
      (target === "incoming" || target === "message") &&
      typeof requestVersion === "number"
      ? settledRequestedReply(tx, { incomingCommentId, target, requestVersion })
      : { recovered: "no_durable_effect" };
  }
  if (step.name === "act" || step.name === "decide" || step.name === "submit_draft")
    return { recovered: "outcome_unknown", readFirst: "list_activity", refs: typeof step.arguments.ref === "string" ? [step.arguments.ref] : Array.isArray(step.arguments.refs) ? step.arguments.refs.filter((ref): ref is string => typeof ref === "string") : [], note: "Read the current state before repeating this operation; it was not repeated." };
  // The angle delivery carries no idempotency key of its own: it writes the
  // assist and the task's `angles` receipt in one transaction, so that receipt
  // is the key, and the tail below reads it like any other.
  const receiptKey =
    step.name === DELIVER_ANGLES ? "angles" : step.arguments.idempotencyKey;
  const taskId = step.arguments.taskId ?? step.arguments.stageId ?? step.arguments.id;
  if (typeof taskId !== "string" || typeof receiptKey !== "string")
    return { recovered: "no_durable_effect" };
  const [stage] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (stage?.credentialBinding !== binding(ctx))
    return { recovered: "stage_missing" };
  const receipt = stage.receipts[receiptKey as string];
  // No receipt under the key is durable evidence of its own once the task can
  // no longer accept one: receipts commit in the same transaction as effects.
  if (receipt) return receipt;
  return stage.status !== "awaiting_agent" || stage.expiresAt <= Date.now()
    ? { recovered: "not_applied" }
    : undefined;
}

/** Read core evidence for one interrupted turn inside the caller's transaction.
 * Never re-invokes a model, a tool or a send: a step settles only from what core
 * itself recorded, and an unresolved obligation keeps the turn blocked. */
async function reconcile(tx: Tx, ctx: McpCtx, turn: Turn) {
  const steps = turn.steps as Step[];
  const history = turn.history as History[];
  for (const step of steps) {
    if (step.status !== "dispatched" && step.status !== "uncertain") continue;
    const result = await settled(tx, ctx, step);
    if (result === undefined) continue;
    step.status = "completed";
    step.result = result;
    history.push({
      role: "tool",
      content: { recoveredStepId: step.id, name: step.name, result },
    });
  }
  // A turn that recorded its own failure keeps it: recovery reads receipts, and
  // a turn that ran out of time or was refused is not one the owner canceled.
  turn.status = steps.some(
    (step) => step.status === "dispatched" || step.status === "uncertain",
  )
    ? "recovery_required"
    : turn.status === "failed"
      ? "failed"
      : "canceled";
  await tx
    .update(chatBrokerTurns)
    .set({ status: turn.status, steps, history })
    .where(eq(chatBrokerTurns.id, turn.id));
  return { status: turn.status, steps };
}

/** Read core evidence after interruption. Never re-invoke a model/tool request.
 * A send whose core receipt is still unresolved remains blocked for recovery. */
export async function recoverBrokerTurn(
  ctx: McpCtx,
  sessionId: string,
  requestId: string,
) {
  return withOrg(ctx.organizationId, async (tx) => {
    await assertHostedMcpCredentialInTx(
      tx,
      ctx,
      new AbortController().signal,
      "feed:read",
    );
    const [turn] = await tx
      .select()
      .from(chatBrokerTurns)
      .where(
        and(
          eq(chatBrokerTurns.id, requestId),
          eq(chatBrokerTurns.sessionId, sessionId),
        ),
      )
      .for("update");
    if (!turn || turn.credentialBinding !== binding(ctx))
      throw new Error("broker_turn_not_found");
    if (turn.status === "running" && turn.expiresAt > Date.now())
      throw new Error("broker_turn_active");
    if (turn.status === "completed")
      return { status: turn.status, steps: turn.steps as Step[] };
    return reconcile(tx, ctx, turn);
  });
}
