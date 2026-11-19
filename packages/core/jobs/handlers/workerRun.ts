import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { campaignStops } from "../../actions/pause";
import { pausedPressAllowed, type PausedPress } from "../../strategy/read";
import { modeFor } from "../../strategy/mode";
import { readExecutionAuthority } from "../../execution/authority";
import { db as baseDb } from "@engager/database";
import { anotherExecutorAlive, type ExecutorLock } from "@engager/database/executorLock";
import {
  workerRuns,
  campaigns,
  channels,
  jobs,
  leadSignals,
  organizations,
  workers,
  type WorkerRun,
  type Campaign,
  type Channel,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { backgroundEntitlement, LICENSE_HOLD_RECHECK_MS } from "../../entitlements/entitlement";
import { getLLM } from "../../ai/client";
import { readSearchDepth } from "../../strategy/searchDepth";
import { emptyLeadCounts } from "../../leads/scout/counts";
import { leadsEnabled } from "../../leads/gate";
import { wakePhasesWithWork } from "../../leads/scout/check";
import { sweepGate } from "../../leads/scout/queues";
import { runFindLeads } from "../../leads/scout/run";
import { readFindLeadsStep, type FindLeadsStep } from "../../leads/scout/phase";
import { trackFirstLookFinished } from "../../telemetry/firstResults";
import { trackWorkerRunFailed } from "../../telemetry/emit";
import { planConversation, stageStepIds } from "../../agentStep/select";
import { emptyTally, runConversationWake } from "../../agentStep/wake";
import { observeIncomingInvitations } from "../../invitations/observe";
import {
  ConnectorError,
  isConnectorBackoff,
  isConnectorDrift,
  isConnectorSignIn,
} from "../../linkedin/connectorError";
import { recordRunSession } from "../../linkedin/liveness";
import { invitationsReadDue, invitationsStepOf } from "../../invitations/wake";
import {
  inboxReadDue,
  observeInbox,
  type InboxObservation,
} from "../../conversations/inbox";
import { withUsageContext } from "../../ai/usage";
import type { SkipReason } from "../../workers/skipReasons";
import {
  ACCOUNT_STOPPED_NOTE,
  CAMPAIGN_STOPPED_NOTE,
  leadOpenersOwed,
  runLeadOpenerPhase,
} from "../../workers/phases";
import {
  beginsFirstLook,
  firstLookKey,
  firstLookAgentFailure,
  firstLookStop,
  firstLookTally,
  skippedFirstLookEnding,
} from "../../workers/firstLook";
import { isGrant } from "../../connector/resolve";
import {
  patchWorkerFields,
  reArmedWake,
  workerSteps,
  type WorkerSteps,
} from "../../operations/workers";
import {
  commentRedraftNote,
  commentsAskedToRedo,
  redraftAskedComments,
} from "../../workers/commentRedraft";
import { noteCoalescedRun } from "../../supervision/missedRuns";
import { suspensionWatch, WAKING_REASON } from "../../supervision/suspension";
import {
  claimExclusiveRun,
  releaseAbandonedExclusiveRun,
  releaseExclusiveRun,
  renewExclusiveRun,
} from "../../pacing";
import { getSystemState, pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import {
  channelCeilings,
  DAILY_SEARCH_LIMIT,
  ledgerChannelId,
  replyCheckLimitLine,
} from "../../ratelimit/ledger";
import type { Refusal } from "../../refusal";
import { localClock, withinActiveWindow } from "../../time";
import { capabilityGrant, type CapabilityGrant } from "../context";
import { enqueue, requeueAbandonedJob, RescheduleError } from "../queue";
import {
  ABANDONED_RUN_AFTER_MS,
  QUIT_MID_RUN_NOTE,
  REAPED_RUN_NOTE,
  RUN_BUDGET_MS,
  RUN_LEASE_MS,
} from "../abandonedRuns";
import type { JobResult, SelfScopedCtx } from "../worker";
import { campaignObservation, observedSince } from "./replyWatches";

/**
 * One worker run.
 *
 * SELF_SCOPED because the chain spans a browser sweep and two agent-CLI calls;
 * holding a pooled connection across either would starve the process at
 * ENGAGER_PG_POOL_MAX=1. Every DB touch below is its own short transaction and
 * the lease — not a transaction — is what serializes runs. The STAGES enforce
 * that themselves now: they take an organizationId rather than a Tx, so this
 * handler cannot hand one across a model call even by accident (T-2.5, which
 * is when this comment stopped being aspirational).
 *
 * The run record is written from what the server actually did. Counts come from
 * intake receipts, never from anything a model reported about itself, and a run
 * that stops early records the phase it stopped in rather than a bare failure.
 */


/** The read budget's refusal for a shut window (`reserveResearchRead`). */
const OUTSIDE_WINDOW = "outside_active_hours";

/**
 * A read was wanted, and the account's window was shut.
 *
 * The run itself is not a skip and not a failure: what everything downstream
 * of the read does works on rows that are already here. What this qualifies is
 * the one thing that would otherwise read as a measurement, and it says so in
 * the owner's words, with the time the wait ends, because a press made at 08:48
 * against a window opening at 09:00 is the case that reads it.
 *
 * The account's invitations and inbox reads wait the same way, for the same
 * fence (`reserveResearchRead`), and say so in the same sentence.
 *
 * A null channel is an account row that could not be read, so neither could
 * its window — and a window that cannot be read cannot be honored, so the wait
 * fails closed and says why instead of naming a time.
 */
function windowWaitNote(
  what: string,
  channel: Pick<Channel, "activeHours" | "activeDays"> | null,
  now: number,
): string {
  if (channel == null) return `${what} waits: this account's window could not be read`;
  const { nextOpen } = withinActiveWindow(now, channel.activeHours, channel.activeDays);
  return `${what} waits for your window, which opens at ${localClock(nextOpen, channel.activeHours?.tz || "UTC")}`;
}

/**
 * This run's lock lapsed and another run claimed the channel, so this one
 * stopped rather than working under someone else's lease.
 *
 * NOT a skip reason: `worker_runs_skip_reason_check` binds a skip reason to
 * `status = 'skipped'`, and by the time a renewal can fail the row has been
 * `running` for a while. `failed` carrying its reason is the shape T-1.6
 * already settled for a reaped run.
 */
const LEASE_LOST_NOTE =
  "lease lost: another run claimed this channel mid-run";

/**
 * The Scout's search map is empty: a Find leads run with nothing to listen
 * for read nothing, which is a configuration the owner finishes, not a
 * measurement.
 */
const EMPTY_MAP_NOTE =
  "Nothing searched: this Scout's search map has no phrases or sources. Add them in the campaign's Searches, then run again.";

/**
 * This install does not hold the account's engagement authority — read
 * through the persisted verified account/runtime/epoch. Mutual exclusion BETWEEN
 * INSTALLS, not a permission gate on this one (INV-6): the owner's agent
 * reads this in `error` and acts on it, which is INV-16's whole ask.
 */
const AUTHORITY_ELSEWHERE_NOTE =
  "another install holds this account's engagement authority — complete account recovery or the runtime handoff";

type Phase = NonNullable<WorkerRun["phase"]>;

/** Why a run never started, and the exact fault behind it. The reason is the
 *  vocabulary the owner's agent acts on; the note is the diagnosis it reads
 *  out, and `runNote()` renders `error` on any status including this one. */
type Skip = { reason: SkipReason; note?: string };

/**
 * A refused grant in the run log's own vocabulary.
 *
 * Two members cover the whole resolution vocabulary because two things are
 * actually different to the owner: `unsupported` says the account is reachable
 * and this connector does not do that work — a declaration, fixed by binding
 * the channel to one that does — while every other code a grant can mint says
 * the account was not reached AT ALL: nothing is stored (`not_connected`), the
 * stored credential cannot be read (`credentials_*`), or the session this
 * process holds belongs to another org (`foreign_org`). Collapsing those two
 * into one reason would tell an owner with a working session to go reconnect.
 *
 * ⚠️ `connector_unsupported` CANNOT fire today, and that is a property of the
 * declarations rather than of this mapping: `local_browser` declares
 * `discover` supported, so the only producer left is an injected grant
 * in a suite. It is written anyway because the alternative is a run log that
 * says "not connected" the first time a binding cannot sweep — and the codes
 * `resolveChannelConnector` mints are not this handler's to predict.
 *
 * The LAYER is read, not assumed. `CapabilityGrant` returns the general
 * four-rung `Refusal`, and every producer a grant has today mints through
 * `connectorRefusal` — but a refusal from another rung arriving here would be a
 * grant answering for a budget or a campaign it does not hold, and rebranding it
 * "the account could not be reached" would hide exactly that. There is no skip
 * reason for it, so the rung goes into the note instead of being dropped.
 *
 * The exact fault is never lost either way: `code` and `detail` go to `error`
 * beside the reason, so the row says skipped, why, and which precise fault —
 * the whole difference between this and the zero-counter green check.
 */
function connectorSkip(refusal: Refusal): Skip {
  const fromConnector = refusal.layer === "connector";
  return {
    reason:
      fromConnector && refusal.code === "unsupported"
        ? "connector_unsupported"
        : "channel_not_connected",
    note: fromConnector
      ? refusalNote(refusal)
      : `${refusal.layer} refusal from a connector grant: ${refusalNote(refusal)}`,
  };
}

/** `code: detail` — how a refusal reads in `error` whichever rung raised it,
 *  matching the shape the refused draft batch already writes. */
function refusalNote(refusal: Refusal): string {
  return [refusal.code, refusal.detail]
    .filter((part): part is string => part != null)
    .join(": ");
}

/**
 * Exported so the enqueue sites are TYPED rather than trusted. An object
 * literal passed to `enqueue`'s `payload` is checked against nothing, so a
 * misspelled `trigger` reached this handler as `undefined` and quietly became a
 * schedule — the same hole the retired sweep payload documented itself as
 * closing, and
 * it matters more here now that the trigger decides whether a press is floored.
 */
export type WorkerRunPayload = {
  workerId: number;
  /**
   * Who asked. Defaults to the schedule, which is the conservative half: a
   * schedule is floored at nothing and skips when the account needs nothing,
   * while a press always shows the owner one of everything it has enabled.
   *
   * `manual` and `agent` are the same PRESS and behave identically — the
   * difference is provenance, which the run log owes the owner: one of them
   * they did, the other their agent did for them.
   *
   * `event` is the server waking the Ambassador's CONVERSATION work alone — a
   * reply on a conversation, a wait that expired (`agentStep/wait.ts`). Its comment
   * work keeps its schedule: an event run sizes no comment demand, floors
   * nothing and leaves the worker's wake where the schedule put it.
   *
   * `match` is the server waking the Ambassador right after a Scout run
   * confirmed what one of its steps starts on (`workers/matchWake.ts`). It is
   * the schedule's run in everything it does — every step on, sized off the
   * day and floored at nothing — and, like an event, it waits for the account
   * rather than skipping, and leaves the wake where the schedule put it.
   */
  trigger?: "schedule" | "manual" | "agent" | "event" | "match";
  /**
   * The campaign press this run is one step of (`runCampaignNow`): one press
   * wakes the Scout and then the Ambassador, each its own run on the channel
   * lease, and this is what lets the campaign read them back as one loop.
   * Written onto the run row whatever the run's outcome, a skip included.
   */
  pressId?: string;
  /**
   * A test before Start (`runCampaignTestOp`): the Scout of a campaign not
   * started reads and screens once, whatever its switches say, and does
   * nothing else — no research, no search added, no wake. The one
   * run a campaign waiting for its Start lets through. Stamped on the row
   * (`isTest`) like the press id, a skip included.
   */
  test?: boolean;
  /**
   * One round of a Quick campaign's first look (US-DEP-04): a short sweep,
   * screen and judge in Quick's shape, three rounds at most. Each round that goes on enqueues the next
   * (`firstLookKey`); `run_campaign` enqueues the first of a test, and a
   * Quick campaign's first run is its first round without being told
   * (`beginsFirstLook`). Stamped on the row, a skip included.
   */
  firstLook?: { round: number; freshSearches?: true };
};

export function handleWorkerRun(
  ctx: SelfScopedCtx,
  payload: WorkerRunPayload,
  /**
   * The instant this run judges the world at: its DEMAND, the NEXT WAKE it
   * derives from the same plan, the organization's pause, and both stages'
   * reading of rows. Defaulted here because production has exactly one answer; a
   * test pins it, because a number derived from a day plan is only true at one
   * moment and two runs at two clocks cannot be compared.
   *
   * It is NOT `started` below, and the split is by KIND rather than by
   * convenience — so this list is exhaustive on purpose. `started` is when this
   * process began working, and what reads it is either an ELAPSED DURATION
   * measured from that beginning — the lease claim and its renewals, the
   * wall-clock budget, `reapAbandonedRuns`' lease-plus-budget threshold — or a
   * STAMP that records when the work actually happened: `startedAt`,
   * `finishedAt` and `lastRunAt`. A duration cannot be measured from a pinned
   * instant, and a column that says when a row was written must not lie about
   * it.
   *
   * Everything else is an instant, and instants take this one. The wake moved
   * across at T-7.6 and had to: it is no longer an offset from when this process
   * happened to run but a reading of the same plan the volume came off, and one
   * run answering how much to write at one instant and when to come back at
   * another is two runs wearing one row.
   */
  now: number = Date.now(),
): Promise<JobResult> {
  // The identity was never in question on this trigger — the payload names the
  // row that came due — but it reached no model call until this scope carried
  // it. Nested, so the worker boundary's own resolution comes through the ALS
  // merge and this run reads the same (agent, model) the manual sweep does.
  return withUsageContext({ workerId: payload.workerId }, () =>
    runWorker(ctx, payload, now),
  );
}

async function runWorker(
  ctx: SelfScopedCtx,
  payload: WorkerRunPayload,
  now: number,
): Promise<JobResult> {
  // A machine still waking is no time to start. A dark wake sleeps again
  // within seconds, and the first read after a real wake meets a browser that
  // has not come back yet — the run log of 2026-10-19 was five rows of exactly
  // that. The same job runs once the machine has stayed up, with no attempt
  // spent and no row written for a run that never had a chance.
  const waking = suspensionWatch.unsettledUntil();
  if (waking !== null) {
    throw new RescheduleError(WAKING_REASON, waking);
  }
  const started = Date.now();
  const trigger = payload.trigger ?? "schedule";
  const test = payload.test === true;
  if (!test && trigger !== "manual" && trigger !== "agent") {
    const entitlement = await withOrg(ctx.organizationId, (tx) => backgroundEntitlement(tx, ctx.organizationId, { lock: true }));
    if (!entitlement.allowed) throw new RescheduleError(entitlement.reason, Date.now() + LICENSE_HOLD_RECHECK_MS);
  }

  const loaded = await withOrg(ctx.organizationId, async (tx) => {
    const [worker] = await tx
      .select()
      .from(workers)
      .where(eq(workers.id, payload.workerId));
    if (!worker) return null;
    // Its campaign. A worker with no campaign has nothing to find for and nothing
    // to write about, so this is the same missing-row answer.
    if (worker.campaignId == null) return null;
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, worker.campaignId));
    if (!campaign) return null;
    // Resolved once, here: it keys the lease AND stamps every run row this
    // handler writes, and both must name the same account or the lock and the
    // index would guard different things.
    //
    // 0 when the org somehow has no channel row, the same deterministic stand-in
    // `channelCeilings` uses — defense rather than a path (every org has one
    // from the migration seed or `bootstrapLocalOrg`). It still serializes
    // correctly: the index and the lease both carry the org, so a channel-less
    // org's runs collide with each other and with nobody else's.
    const channelId = (await ledgerChannelId(tx, campaign)) ?? 0;
    // The TYPE decides which stages run, derived once here rather than branched
    // on at each stage, so a scout and an Ambassador differ in one place.
    const mode = worker.type === "ambassador"
      ? (await modeFor(tx, { campaignId: campaign.id, capability: "publish_comment", target: "post" })).effective ?? "off"
      : "off";
    const steps = worker.type === "scout"
      ? { find: worker.sweepEnabled, write: false, converse: false }
      : { find: false, write: mode === "review" || mode === "auto", converse: worker.conversationEnabled };
    return {
      worker,
      campaign,
      channelId,
      steps,
      depth: await readSearchDepth(tx, campaign),
      // A Scout that finds leads runs Find leads' stages in place of Find
      // posts', and no column of its worker row says so: its Find is a
      // binding on the step, which no Find posts switch reads.
      lead: worker.type === "scout" ? await readFindLeadsStep(tx, campaign) : null,
    };
  });
  // Deleted between enqueue and drain. There is no worker left to write a
  // run row against — but a job that finishes green having done nothing is the
  // silent discard this phase exists to remove, so leave a RECEIPT on the job
  // row instead. `jobs.result` already carries "what the handler reported
  // doing" and the register renders only the keys that are present.
  if (!loaded) return { workerMissing: 1 };
  const { worker, campaign, channelId, lead } = loaded;
  // The one owner press a Paused campaign may let through, for preflight to
  // judge (`pausedPressAllowed`): a test before Start, or Run once — the
  // owner's own press on a campaign paused after it started. Never an agent's
  // press, a schedule or an event — nor a first look's later round, which
  // carries the press's trigger for provenance and is not the press: the owner
  // pressed once, for round one, and a Pause since holds the rest like any run.
  const pausedPress: PausedPress | undefined = test
    ? { kind: "test", campaignId: campaign.id }
    : trigger === "manual" && campaign.status === "paused" && (payload.firstLook?.round ?? 1) === 1
      ? { kind: "once", campaignId: campaign.id }
      : undefined;
  // An event wakes the Ambassador's conversation work alone: its comment work
  // keeps its schedule, so for this run every other step is as if off. A test
  // reads and screens, whatever the Scout's switches say, and nothing else.
  // Run once runs its steps as Run now would, but arms nothing — every draft
  // waits for a yes, even where a step is Automatic — and leaves the
  // conversation work, whose sends answer people, to the Resume.
  const eventWake = trigger === "event";
  const matchWake = trigger === "match";
  // A Scout has none of these steps: what it does is the Find leads step's,
  // read above.
  const steps: WorkerSteps =
    worker.type === "scout" || test
      ? { find: false, write: false, converse: false }
      : eventWake
        ? { find: false, write: false, converse: loaded.steps.converse }
        : pausedPress
          ? { ...loaded.steps, converse: false }
          : loaded.steps;
  // What a Find leads run does: its sweep where Find is On, and always on a
  // test before Start, which reads and screens whatever the switches say. A run
  // that reads nothing still wakes the steps that have work, which Research's
  // own switch decides.
  const leadWork = lead !== null && (lead.find || lead.research || test);
  // The wake is the schedule's, and neither an event, a match, a test nor a
  // first look's later round is the schedule.
  const movesWake = !eventWake && !matchWake && !test && (payload.firstLook?.round ?? 1) === 1;
  const execution = await withOrg(ctx.organizationId, (tx) => readExecutionAuthority(tx, channelId));

  // A run always advances the wake, whatever its outcome. Otherwise a skipped
  // run re-fires on every tick for the rest of the day.
  //
  // Derived AFTER the work, in its own short transaction, which is what makes
  // the derivation honest: `nextWakeAt` reads the supply this run just wrote, so
  // a run that filled the plan comes back for the first anchor past what it
  // filled and one that fell short comes back for the anchors it missed.
  const advanceWake = async () => {
    await withOrg(ctx.organizationId, async (tx) => {
      // RE-READ, not the row loaded before the work. The wake is derived after
      // the run for a reason, and the same reason applies to the two fields it
      // is derived FROM: a kill switch or a pause that landed mid-run has
      // already written `auto: false, nextRunAt: null` on this row, and
      // re-arming from a pre-work snapshot would hand the worker back a wake
      // the owner just took away.
      const [current] = await tx
        .select()
        .from(workers)
        .where(eq(workers.id, worker.id));
      const nextRunAt = current ? await reArmedWake(tx, current, now) : null;
      // The worker row is the authority and the source row follows it — one
      // `where` that matches nothing on a scout the split minted, which has no
      // source row and needs none.
      await patchWorkerFields(tx, [worker.id], {
        lastRunAt: started,
        nextRunAt,
      });
      // Name the ONE run a slept-through gap produced, on the missed-run
      // record for the wake this run served. Written here rather than at the
      // scheduler because the coalesced run is whatever `reArmedWake` has just
      // decided, and until this point nothing knew it. Unconditional and cheap:
      // an ordinary on-time run has no such record, so the update matches no
      // row rather than needing a second read to find that out.
      if (worker.nextRunAt !== null && nextRunAt !== null) {
        await noteCoalescedRun(tx, {
          organizationId: ctx.organizationId,
          workerId: worker.id,
          missedFrom: worker.nextRunAt,
          coalescedRunAt: nextRunAt,
        });
      }
    });
  };

  const skip = async ({ reason, note }: Skip) => {
    await withOrg(ctx.organizationId, (tx) =>
      tx.insert(workerRuns).values({
        workerId: worker.id,
        jobId: ctx.jobId ?? null,
        campaignId: campaign.id,
        channelId,
        trigger,
        pressId: payload.pressId ?? null,
        isTest: test,
        firstLookRound: payload.firstLook?.round ?? null,
        status: "skipped",
        skipReason: reason,
        startedAt: started,
        finishedAt: Date.now(),
        ...(note === undefined ? {} : { error: note }),
      }),
    );
    if (movesWake) await advanceWake();
    // A skipped round queues no next one: it ends the first look.
    const ending = payload.firstLook ? skippedFirstLookEnding(reason) : null;
    if (ending) await trackFirstLookFinished(ctx.organizationId, worker.id, ending);
  };

  let waitingForChannel = false;
  const collision = async () => {
    // A fresh overlapping request is a skip. A queue retry is unfinished work:
    // after a crash its old run can outlive the shorter queue lease. Keep that
    // job pending until the existing channel lease and abandoned-run reaper
    // permit it, without burning attempts or advancing the worker's wake. An
    // event wake waits the same way: it is the reply's one wake, and a skip
    // would leave it for whatever woke the conversation next. A match wake is the
    // matches' one wake, and a first look's round its first look's, and each
    // waits for the same reason.
    if (
      ctx.jobId != null &&
      ctx.jobLeaseToken &&
      ((ctx.jobAttempts ?? 0) > 0 || eventWake || matchWake || payload.firstLook !== undefined)
    ) {
      waitingForChannel = true;
      throw new RescheduleError(
        "worker retry is waiting for the channel",
        Date.now() + 60_000,
      );
    }
    await skip({ reason: "campaign_locked" });
  };

  const preflight = await withOrg(ctx.organizationId, (tx) =>
    preflightReason(
      tx,
      campaign,
      channelId,
      { now, wall: started },
      capabilityGrant(ctx),
      pausedPress,
      lead && { step: lead, test },
    ),
  );
  if (preflight) {
    await skip(preflight);
    return {};
  }

  // The lease is the real lock: it outlives transactions, self-heals on a TTL,
  // and composes with the discovery lease the sweep takes inside this run. It
  // is the CHANNEL's, because what it guards is one browser profile on one real
  // account — two campaigns pointing at the same account must not both run.
  const leaseKey = `worker-run:${channelId}`;
  const claim = await withOrg(ctx.organizationId, (tx) =>
    claimExclusiveRun(tx, leaseKey, RUN_LEASE_MS, started),
  );
  if (!claim.claimed) {
    await collision();
    return {};
  }

  let leaseExpiry = claim.expiresAt;
  let runId: number | null = null;
  // The machine slept while this run held the account: it closes
  // `interrupted` and its job runs again once the machine is awake (below).
  let sleptThrough = false;
  // Its row was closed under it while it ran (`releaseRunsLeftRunning`): the
  // row and the job are no longer this run's, and its job, queued again, is
  // the next run of this wake. It writes nothing more.
  let taken = false;
  // Born in the first stage its worker's steps reach, so an Ambassador's run
  // never reads as finding posts before its first move.
  let phase: Phase = lead ? "sweep" : steps.write ? "draft" : "converse";
  // What the run DID. The ask it did it against goes on the row at birth, so
  // that no path can close without it. Declared outside the work so a run
  // that throws after earlier rounds still records what they wrote.
  const counts = {
    draftedCount: 0,
    publishedCount: 0,
    rejectedCount: 0,
    capRefusedCount: 0,
  };
  // What a Find leads run did, the same way. Null on every other run, so no
  // other row has these columns written.
  const leadCounts = lead ? emptyLeadCounts() : null;
  // The steps the conversation work served, the same way: a wake that throws
  // midway still leaves them on the row. Its turns and calls are counted over
  // its step rows when the run is read (`agentStep/runSums.ts`).
  const conversation = emptyTally();
  // Whether the write stage was entered, for the steps the run served.
  let wrote = false;
  // Whether an opener to a served lead landed, for the same.
  let openersLanded = false;
  /** Every step the run served — written beside
   *  `counts` on every path that closes a row. */
  const stepColumns = async (tx: Tx) => ({
    servedStepIds: [
      ...(await stageStepIds(tx, campaign, [
        ...(lead ? (["find_leads"] as const) : []),
        ...(wrote || openersLanded ? (["comment_on_posts"] as const) : []),
      ])),
      ...conversation.servedStepIds,
    ],
  });
  // The first-look round this run is, where it is one, and the round it
  // queues once it closes.
  let firstLookRound: number | null = payload.firstLook?.round ?? null;
  let nextFirstLookRound: number | null = null;
  try {
    // A Quick campaign's first run is the first round of its first look,
    // though nothing said so (`beginsFirstLook`) — asked here, under the
    // lease, so two runs cannot both be first.
    if (
      firstLookRound === null &&
      loaded.depth === "quick" &&
      lead?.find === true &&
      !test &&
      !eventWake &&
      !matchWake &&
      (await withOrg(ctx.organizationId, (tx) => beginsFirstLook(tx, worker.id)))
    ) {
      firstLookRound = 1;
    }
    // A first look reads in Quick's shape whatever depth it was asked under,
    // since it is Quick's.
    const depth = firstLookRound === null ? loaded.depth : "quick";

    // ---- how much is there to do? -----------------------------------------
    //
    // Read ONCE, under the lease, before a run row exists — and each of those
    // is load-bearing. ONCE because a run that asked twice would get two
    // answers and neither would be the one on its row (INV-5). UNDER THE LEASE
    // because an ask computed outside it sizes this run against what the run
    // that just finished has already written. BEFORE THE ROW because a run
    // with nothing to do is a run that should not have started, and the honest
    // record of that is a skip — not a green row of zeros, which is the exact
    // lie this phase is here to remove.
    const demand = await withOrg(ctx.organizationId, async (tx) => ({
      // Comments the owner asked to have written again. Not volume: each
      // replaces words already in the queue, so no room bounds them.
      redrafts: steps.write ? await commentsAskedToRedo(tx, campaign) : 0,
      // The leads an opener is owed to, frozen here like every other ask.
      openers: worker.type === "ambassador" && !eventWake && !test ? await leadOpenersOwed(tx, campaign, now) : [],
    }));

    // A press is the owner's (or their agent's): it serves every step that HAS
    // work, and a reply nobody wrote is not work.
    const press = trigger === "manual" || trigger === "agent";
    /**
     * The Ambassador's conversation work: the conversations a person-to-person step
     * answers, picked here — under the lease, before the row, beside the
     * demand and for the same reasons — and frozen onto the row at its birth
     * (INV-3). A campaign that cannot have any says why instead (it cannot
     * read its strategy, or it is stopped), and that answer rides on the row.
     */
    const plan = steps.converse
      ? await withOrg(ctx.organizationId, (tx) => planConversation(tx, campaign))
      : null;
    const conversationsFrozen = plan?.kind === "plan" ? plan.items : [];
    const conversationNote = plan?.kind === "refused" ? plan.note : null;
    /**
     * The Ambassador's eye on incoming invitations: one read of the account's
     * invitations page for the step that binds Accept invite
     * (`invitations/wake.ts`) — due once the account's last look at them has
     * gone stale, and at once on a press. NOT on an event, as for the inbox:
     * the light check looks on its own slot (`inboxCheck.ts`), and an event
     * wake works from what was just recorded. The read is the work, so a wake
     * with nothing else to do still runs for it.
     */
    const invitationsStep =
      steps.converse && !eventWake
        ? await withOrg(ctx.organizationId, async (tx) =>
            press || (await invitationsReadDue(tx, channelId, now)) ? invitationsStepOf(tx, campaign) : null,
          )
        : null;
    // The Ambassador's eyes on the inbox: due once a read has gone stale, and
    // at once on a press. NOT at once on an event: the light inbox check
    // records a message and wakes this run for it, so a forced read here
    // would re-read the inbox minutes later for every message it found — an
    // event works from what was just recorded. Only a campaign that hires it
    // to Invite to connect or to Message after they accept reads one
    // (`conversations/inbox.ts`).
    const inboxDue =
      steps.converse &&
      (await withOrg(ctx.organizationId, (tx) =>
        inboxReadDue(tx, campaign, { now, force: press }),
      ));
    if (
      !leadWork &&
      demand.redrafts === 0 &&
      demand.openers.length === 0 &&
      conversationsFrozen.length === 0 &&
      invitationsStep === null &&
      !inboxDue
    ) {
      // Armed for conversation alone, its refusal IS the run's answer; armed
      // beside comment work, the comment work's answer leads and the refusal
      // rides on it.
      const conversationOnly = steps.converse && !steps.write;
      await skip(
        conversationOnly && conversationNote
          ? { reason: "conversation_not_runnable", note: conversationNote }
          : {
              reason: "nothing_needed",
              ...(conversationNote ? { note: conversationNote } : {}),
            },
      );
      return {};
    }

    // Reading new posts while many found words wait to be screened, or more
    // people than the day's profile reads wait for one, only lengthens what the
    // steps after the sweep have to work through: the run reads nothing and
    // wakes them. A test and a first look's round screen what they read
    // themselves, so nothing waits behind them.
    if (lead?.find && !test && firstLookRound === null) {
      const gate = await withOrg(ctx.organizationId, (tx) => sweepGate(tx, campaign.id, channelId, now));
      if (gate.note !== null) {
        await skip({ reason: "backlog", note: gate.note });
        if (campaign.status === "active") {
          await withOrg(ctx.organizationId, (tx) => wakePhasesWithWork(tx, campaign, lead, gate.counts, now));
        }
        return {};
      }
    }

    // The partial unique index is the second belt: if a row is already
    // 'running' on this channel, this insert loses and we skip. Lease and
    // index disagreeing is exactly the case the index must win.
    runId = await withOrg(ctx.organizationId, async (tx) => {
      const [row] = await tx
        .insert(workerRuns)
        .values({
          workerId: worker.id,
          jobId: ctx.jobId ?? null,
          campaignId: campaign.id,
          channelId,
          trigger,
          pressId: payload.pressId ?? null,
          isTest: test,
          firstLookRound,
          status: "running",
          phase,
          startedAt: started,
          // The ask goes on the row at BIRTH, not at close. The server computed
          // it before this row existed, and a THROWN run is closed by the catch
          // below, which writes a status and an error and no counters.
          frozenConversationIds: conversationsFrozen.map((item) => item.conversationId),
          // The depth it reads at, so its page can say so whatever the
          // campaign says later.
          searchDepth: lead ? depth : null,
        })
        .onConflictDoNothing()
        .returning({ id: workerRuns.id });
      return row?.id ?? null;
    });
    if (runId == null) {
      await collision();
      return {};
    }
    // Const copy: `runId` is a mutable `let` assigned inside this try and read
    // from closures below, a shape TypeScript will not keep narrowed. The stages
    // need a plain number, and this is that without a non-null assertion.
    const stampRunId = runId;
    /**
     * Where the run is, on its row while it walks: its phase and every
     * counter so far, written at each move,
     * so a run page opened mid-run reads what the run is doing now instead of
     * the phase it was born with. Every counter is rows a stage already wrote,
     * and each write is its own short transaction between stages and batches,
     * never across a model call.
     *
     * Best effort. A write that fails costs the live view and nothing else:
     * the run goes on, and its close writes the truth whatever landed here.
     * Fenced on `running`, so a row something else has closed stays closed.
     */
    const report = async () => {
      try {
        await withOrg(ctx.organizationId, (tx) =>
          tx
            .update(workerRuns)
            .set({ phase, ...counts, ...leadCounts })
            .where(and(eq(workerRuns.id, stampRunId), eq(workerRuns.status, "running"))),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[worker_run] run ${stampRunId}: progress not written: ${message}`);
      }
    };
    // A move is written when it happens; a boundary that stays in its phase
    // has nothing new to say.
    const enter = async (next: Phase) => {
      if (phase === next) return;
      phase = next;
      await report();
    };

    // The sweep was wanted and the account's window was shut, so the run read
    // nothing; the note says when the window opens.
    let sweepHeld: string | null = null;
    let missingSources = false;
    // The connector gave out DURING the sweep — a profile taken by an
    // interactive session, a throttle, a transport fault. Not a skip reason and
    // not a status: preflight already refused every run that could not start,
    // so by here the run HAS started and may already carry counters the server
    // wrote, and those outrank the reason (INV-2). The note is how one run says
    // both — the half a bare job result cannot, having one value and nowhere
    // to put a second answer.
    let sweepRefusal: Refusal | null = null;
    // What came of the comments the owner asked to have redone, when any were.
    let redraftNote: string | null = null;
    // Why the invitations read changed nothing, when it did not.
    let invitationsNote: string | null = null;
    // A Find leads first look's round read nothing it had not met before.
    let phrasesDry = false;
    const overBudget = () => Date.now() - started > RUN_BUDGET_MS;
    // Adopt each renewal's expiry: renew and release are fenced on the expiry
    // this run owns, so a run that outlived its lease cannot extend or free the
    // lease of the run that replaced it.
    //
    // A `null` means the fence did NOT match — the lease lapsed and somebody
    // else claimed it, so another run legitimately owns this campaign right
    // now. Carrying on from here is the two-concurrent-runs failure the lease
    // exists to prevent, and it was silent: both callers adopted a non-null
    // expiry and ignored the null.
    let leaseLost = false;
    const renew = async () => {
      const authority = await withOrg(ctx.organizationId, (tx) =>
        readExecutionAuthority(tx, channelId, execution.allowed ? execution.token : undefined),
      );
      if (!execution.allowed || !authority.allowed) leaseLost = true;
      const renewed = await withOrg(ctx.organizationId, (tx) =>
        renewExclusiveRun(tx, leaseKey, RUN_LEASE_MS, Date.now(), leaseExpiry),
      );
      if (renewed == null) leaseLost = true;
      else leaseExpiry = renewed;
    };
    /**
     * May the next stage start? One predicate for every reason to stop, so a
     * new reason cannot be added to some stage boundaries and not others —
     * which is exactly how the lease check went missing. A sleep is one: past
     * it, the budget ran in a closed lid and the account's reads meet a
     * waking browser.
     */
    const mayContinue = () =>
      !leaseLost &&
      !overBudget() &&
      ctx.signal?.aborted !== true &&
      suspensionWatch.suspendedSince(started) === null;
    // Model batches share this run's lease and time budget. Recheck both before
    // another provider call and before the collected responses reach intake.
    const continueRun = async () => {
      await renew();
      return mayContinue();
    };

    // ---- find leads: sweep, then hand off ----------------------------- scout
    // The sweep is the stage the account's window fences: it puts a browser on
    // a real LinkedIn account.
    const leadNotes: string[] = [];
    if (lead && leadCounts && leadWork && mayContinue()) {
      await renew();
      if (mayContinue()) {
        // A failed model call resumes the stored sweep; its retry must not
        // spend the round's search pages a second time.
        const [priorSweep] = firstLookRound != null && ctx.jobId != null
          ? await withOrg(ctx.organizationId, (tx) => tx.select({
              dry: sql<boolean>`not exists (select 1 from ${leadSignals} signal where signal.run_id = worker_runs.id)`,
            }).from(workerRuns).where(and(
              eq(workerRuns.workerId, worker.id),
              eq(workerRuns.jobId, ctx.jobId!),
              eq(workerRuns.firstLookRound, firstLookRound!),
              inArray(workerRuns.status, ["failed", "interrupted"]),
              inArray(workerRuns.phase, ["screen", "research", "qualify", "serve", "done"]),
              gt(workerRuns.searchPagesCount, 0),
            )).orderBy(desc(workerRuns.id)).limit(1))
          : [];
        const reads = lead.find || test;
        const channel = reads
          ? await withOrg(ctx.organizationId, (tx) => channelCeilings(tx))
          : null;
        const windowOpen =
          channel != null && withinActiveWindow(now, channel.activeHours, channel.activeDays).within;
        if (reads && !windowOpen) sweepHeld = windowWaitNote("Finding leads", channel, now);
        const outcome = await runFindLeads({
          organizationId: ctx.organizationId,
          campaign,
          channelId,
          runId: stampRunId,
          depth,
          step: lead,
          sweep: reads && windowOpen && !priorSweep,
          // A first look's round is a Quick run in full, before Start too: it
          // seeds the map and makes the people who pass Signals. Only a plain
          // test stops at the screen.
          test: test && firstLookRound === null,
          firstLook: firstLookRound !== null,
          now,
          grant: capabilityGrant(ctx),
          llm: resolveLlm(ctx),
          counts: leadCounts,
          enter,
          report,
          continueRun,
        });
        sweepRefusal ??= outcome.refusal;
        missingSources ||= outcome.emptyMap;
        phrasesDry = priorSweep?.dry ?? outcome.dry;
        leadNotes.push(...outcome.notes);
      }
    }

    // ---- redo what the owner asked to have written again --------- Ambassador
    if (steps.write && mayContinue()) {
      await enter("draft");
      await renew();
      if (mayContinue()) {
        wrote = true;
        // The ask queued its own job (`redraft_comments`); this picks up any
        // it left.
        if (demand.redrafts > 0) {
          redraftNote = commentRedraftNote(
            await redraftAskedComments(
              { organizationId: ctx.organizationId, llm: resolveLlm(ctx), runId: stampRunId },
              campaign.id,
              { now, continueRun },
            ),
          );
        }
      }
    }

    // ---- openers to the leads Scout served ---------------------- Ambassador
    // Angle 1 of each lead frozen above, into their box; at Automatic its step
    // queues it as worker (`runLeadOpenerPhase`). Nothing here sends.
    let openerNote: string | null = null;
    if (demand.openers.length > 0 && mayContinue()) {
      await enter("draft");
      await renew();
      if (mayContinue()) {
        const openers = await runLeadOpenerPhase(
          ctx.organizationId,
          campaign,
          resolveLlm(ctx),
          demand.openers,
          { runId: stampRunId, continueRun, press: pausedPress },
          now,
        );
        counts.draftedCount += openers.drafted;
        counts.publishedCount += openers.queued;
        counts.rejectedCount += openers.withheld;
        counts.capRefusedCount += openers.held;
        openersLanded ||= openers.drafted > 0;
        openerNote = openers.note ? `openers: ${openers.note}` : null;
      }
    }

    // ---- invitations ------------------------------------------ Ambassador
    // One read of who invited the account, attributed and recorded; an
    // invitation tied to a conversation waits for the owner's yes on Accept
    // invite (`invitations/observe.ts`). A read that cannot finish changes
    // nothing and says why on the row; the rest of the run goes on.
    if (invitationsStep !== null && mayContinue()) {
      await enter("converse");
      await renew();
      invitationsNote = await readInvitations(ctx, campaign, channelId, now);
      // A read that landed served its step, as a drafted reply serves its own.
      if (invitationsNote === null && !conversation.servedStepIds.includes(invitationsStep)) {
        conversation.servedStepIds.push(invitationsStep);
      }
    }

    // ---- converse ------------------------------------------- Ambassador
    // The inbox first: what a conversation read finds — a human's draft, an
    // opt-out — holds its conversation before any step reaches it, and a step that
    // reaches one anyway meets the hold at its checkpoint.
    let inboxNote: string | null = null;
    // LinkedIn turned the inbox read away at its sign-in page.
    let inboxSignIn = false;
    if (inboxDue && mayContinue()) {
      await enter("converse");
      await renew();
      if (mayContinue()) {
        const observed = await observeInbox({
          organizationId: ctx.organizationId,
          campaign,
          grant: capabilityGrant(ctx),
          llm: resolveLlm(ctx),
          runId: stampRunId,
          now,
          continueRun,
        });
        inboxNote = inboxRunNote(
          observed,
          await withOrg(ctx.organizationId, (tx) => channelCeilings(tx)),
          now,
        );
        inboxSignIn = observed.status === "failed" && observed.reason === "sign_in";
      }
    }
    // The person-to-person steps, a conversation at a time over the IDs frozen on
    // the row: each one a step's loop of agent-CLI calls whose tool calls the
    // server judges and dispatches itself (`agentStep/wake.ts`). A send it
    // proposes waits for the owner's yes, and nothing goes out without one.
    if (plan?.kind === "plan" && plan.items.length > 0 && mayContinue()) {
      await enter("converse");
      await renew();
      if (mayContinue()) {
        await runConversationWake(
          plan,
          {
            organizationId: ctx.organizationId,
            runId: stampRunId,
            campaign,
            llm: resolveLlm(ctx),
            now,
            continueRun,
            generationSeen: plan.generation,
          },
          conversation,
        );
      }
    }

    // ONE LAST RENEW, and it is the split that made it necessary. `renew` runs
    // at every stage BOUNDARY, so a lease stolen during the last stage was
    // noticed only by the boundary after it. A scout's last stage is its
    // sweep and nothing follows it, so without this the run closes green while
    // another run holds the channel.
    // Cheap, and it cannot flip a run that still holds its lease.
    await renew();
    sleptThrough = suspensionWatch.suspendedSince(started) !== null;

    const stoppedEarly = overBudget() || ctx.signal?.aborted === true;
    // Every note that can be true at once, and none may swallow another: the
    // lease loss and a Scout with nothing to search each decide the STATUS;
    // the sweep's refusal qualifies a COUNTER.
    const notes = [
      leaseLost ? LEASE_LOST_NOTE : null,
      redraftNote,
      openerNote,
      // The account's spent day is not the account out of reach: it says so
      // in its own words.
      sweepRefusal?.code === DAILY_SEARCH_LIMIT && sweepRefusal.detail
        ? sweepRefusal.detail
        : sweepRefusal
          ? `sweep could not reach the account — ${refusalNote(sweepRefusal)}`
          : null,
      sweepHeld,
      missingSources ? EMPTY_MAP_NOTE : null,
      ...leadNotes,
      conversationNote,
      invitationsNote,
      inboxNote,
    ].filter((note): note is string => note !== null);
    // A run the machine slept through is not judged by what it got done, so
    // neither its status nor any note above is its: a refusal read off a
    // waking browser is the browser waking, not the account signed out.
    const closedStatus = sleptThrough
      ? ("interrupted" as const)
      : leaseLost || missingSources
        ? ("failed" as const)
        : stoppedEarly
          ? ("partial" as const)
          : ("succeeded" as const);
    const closed = await withOrg(ctx.organizationId, async (tx) =>
      tx
        .update(workerRuns)
        .set({
          // The earlier stages' counters are rows either way — a lost lease
          // does not un-sweep the sweep.
          ...counts,
          ...leadCounts,
          ...(await stepColumns(tx)),
          // A run that lost its lock did not finish; it was cut short by an
          // outside force, and `failed` with the reason is how T-1.6 already
          // records exactly that for a reaped run. It cannot be a skip reason:
          // `worker_runs_skip_reason_check` binds one to
          // `status = 'skipped'`, and this row has been `running` for a while.
          status: closedStatus,
          phase: closedStatus === "succeeded" ? ("done" as const) : phase,
          // An interrupted row carries none, not even one an abandoned-run reap
          // stamped on it while this run was still alive across the sleep.
          ...(sleptThrough
            ? { error: null }
            : notes.length > 0
              ? { error: notes.join(" | ") }
              : {}),
          finishedAt: Date.now(),
        })
        // Fenced on `running`, so a row released while this run went on
        // keeps what the release wrote.
        .where(and(eq(workerRuns.id, runId!), eq(workerRuns.status, "running")))
        .returning({ id: workerRuns.id }),
    );
    if (closed.length === 0) {
      taken = true;
      return {};
    }
    // A run LinkedIn turned away at sign-in is all that meets a sign-out
    // between the owner's own checks, so it is the one that says so, and a
    // later run is what finds the account signed back in. Not a run the
    // machine slept through: what that one met was the browser waking.
    if (!sleptThrough) {
      const session = await withOrg(ctx.organizationId, (tx) => capabilityGrant(ctx)(tx, "session"));
      if (isGrant(session)) {
        await recordRunSession(
          session.use,
          ctx.organizationId,
          inboxSignIn || sweepRefusal?.code === "login_required",
        );
      }
    }
    // A first look goes on to its next round, or says why it stopped: three
    // rounds, ten matches, or nothing left to read. Only a round that closed
    // clean goes on; any other ends it, out of time or failed — except one the
    // machine slept through, whose job runs the round again.
    if (firstLookRound !== null && closedStatus === "succeeded") {
      const tally = await withOrg(ctx.organizationId, (tx) => firstLookTally(tx, worker.id));
      const stop = firstLookStop({ round: firstLookRound, matched: tally.matched, searchesDry: phrasesDry });
      if (stop === null) {
        nextFirstLookRound = firstLookRound + 1;
      } else {
        await trackFirstLookFinished(ctx.organizationId, worker.id, stop, tally);
      }
    } else if (firstLookRound !== null && closedStatus !== "interrupted") {
      await trackFirstLookFinished(
        ctx.organizationId,
        worker.id,
        closedStatus === "partial" ? "over_budget" : "failed",
      );
    }
    if (closedStatus === "failed") {
      trackWorkerRunFailed({
        workerType: worker.type,
        phase,
        reason: leaseLost ? "lease lost" : "missing sources",
      });
    }
  } catch (error) {
    // Whatever threw, a run the machine slept through closes as one: a model
    // call whose timer counted the sleep, a read that met a waking browser.
    sleptThrough = suspensionWatch.suspendedSince(started) !== null;
    const message = error instanceof Error ? error.message : String(error);
    if (runId != null) {
      const closed = await withOrg(ctx.organizationId, async (tx) =>
        tx
          .update(workerRuns)
          .set({
            // The rows the earlier stages and rounds wrote are rows whatever
            // ended the run after them.
            ...counts,
            ...leadCounts,
            ...(await stepColumns(tx)),
            status: sleptThrough ? "interrupted" : "failed",
            phase,
            finishedAt: Date.now(),
            error: sleptThrough ? null : message,
            agentFailure: sleptThrough ? null : firstLookAgentFailure(error),
          })
          .where(and(eq(workerRuns.id, runId!), eq(workerRuns.status, "running")))
          .returning({ id: workerRuns.id }),
      );
      if (closed.length === 0) {
        taken = true;
        console.warn(`[worker_run] run ${runId} was released while it ran; not recording: ${message}`);
        return {};
      }
    }
    if (sleptThrough) {
      // Not on the row, which is not this error's to describe; the log keeps
      // it for whoever wants to know what the sleep looked like from inside.
      console.warn(`[worker_run] run ${runId ?? "(none)"} cut by sleep: ${message}`);
    } else if (runId != null) {
      trackWorkerRunFailed({ workerType: worker.type, phase, reason: error });
    }
    if (!sleptThrough) {
      // A failure the queue will try again is the round's retry, not the end
      // of the first look; the last attempt's is. Nor is waiting for the
      // channel, which is not a failure.
      const retried = ctx.jobMaxAttempts !== undefined && (ctx.jobAttempts ?? 0) + 1 < ctx.jobMaxAttempts;
      if (firstLookRound !== null && !retried && !waitingForChannel) {
        await trackFirstLookFinished(ctx.organizationId, worker.id, "failed");
      }
      throw error;
    }
  } finally {
    // Fenced by the expiry this run claimed, so a run whose lease already
    // lapsed and was re-claimed cannot release the NEXT run's lease.
    await withOrg(ctx.organizationId, (tx) =>
      releaseExclusiveRun(tx, leaseKey, leaseExpiry, Date.now()),
    );
    // A run the machine slept through leaves the wake where it was: the job
    // running again below IS that wake's run.
    if (!waitingForChannel && !sleptThrough && !taken && movesWake) await advanceWake();
    // Enqueued once this run's lease is free, so the next round finds the
    // account its own. Keyed on the round: a round delivered twice is one run.
    if (nextFirstLookRound !== null) {
      const next: WorkerRunPayload = {
        workerId: worker.id,
        trigger,
        ...(test ? { test: true } : {}),
        firstLook: { round: nextFirstLookRound },
      };
      const key = firstLookKey(worker.id, nextFirstLookRound);
      await withOrg(ctx.organizationId, (tx) =>
        enqueue(tx, { type: "worker_run", payload: next, idempotencyKey: key }),
      );
    }
  }
  // The same job again, once the machine has stayed awake: a reschedule
  // spends no attempt, so a night of dark wakes cannot dead-letter a wake, and
  // the run that finally gets the account sizes itself off what this one wrote.
  if (sleptThrough) {
    throw new RescheduleError(
      "the machine slept through this run",
      suspensionWatch.unsettledUntil() ?? Date.now(),
    );
  }
  // A worker run's counters live on its `worker_runs` row, which is
  // the record the owner reads. `jobs.result` carries only what has no run row
  // to live on — see the discard above.
  return {};
}

/**
 * Why this run should not start. Ordered cheapest-first; each maps 1:1 onto a
 * `skip_reason` the owner reads in the run log.
 *
 * TWO CLOCKS, and which one each check takes is a property of the check rather
 * than of this function:
 *
 *  - `clock.wall` — real time on the process doing the work. Exactly one reader:
 *    `reapAbandonedRuns`, whose threshold is `wall − RUN_LEASE_MS −
 *    RUN_BUDGET_MS`, an ELAPSED DURATION. A run really did die that long ago in
 *    real time, and reaping against a pinned instant would either spare a
 *    corpse forever or reap a run that is alive.
 *  - `clock.now` — the instant this run judges the world at. The organization's
 *    pause is an "is this true right now" question about state, not a duration,
 *    and it is the same question the sizing below it asks. It took `wall` before
 *    T-7.11 and it did not show, because nothing else in the run read a clock;
 *    once demand does, one run deciding whether it may work on one clock and how
 *    much on another is two runs wearing one row.
 *
 * The connector ask takes neither — it is a question about the account, not
 * about time.
 */
async function preflightReason(
  tx: Tx,
  campaign: Campaign,
  channelId: number,
  clock: { now: number; wall: number },
  grant: CapabilityGrant,
  /** The owner press this run is, where it may work a Paused campaign. */
  press: PausedPress | undefined,
  /** The Find leads step a Scout that finds leads runs, with whether this run
   *  is a test before Start; null for every other run. */
  leads: { step: FindLeadsStep; test: boolean } | null,
): Promise<Skip | null> {
  await reapAbandonedRuns(tx, channelId, clock.wall);
  const system = await getSystemState(tx);
  if (system?.killSwitch === true) return { reason: "kill_switch" };
  if (system?.pausedUntil != null && system.pausedUntil > clock.now) {
    return { reason: "organization_paused" };
  }
  // The campaign's own status. `dueWorkers` filters on the worker's own `auto`
  // and wake and never joins the campaign, so before this a worker on a paused
  // — or archived — target ran its full chain.
  //
  // ONE reason covers both non-active states deliberately: the owner's fix is
  // identical either way (activate the campaign, or point the worker at one
  // that is active), and a second member would double the INV-8 cost of a
  // distinction nobody acts on differently.
  //
  // TWO owner presses pass it, each on one state of a Paused campaign
  // (`pausedPressAllowed`), and nothing else does — a schedule, an event and
  // an agent's press all record `target_paused`, and so does any run on an
  // archived target:
  //
  //  - A manual press on a campaign paused after it started RUNS ONCE (owner
  //    decision, 2026-10-13). It reads and drafts as Run now would, and sends
  //    nothing: every draft waits for a yes, nothing is armed, and a draft
  //    approved while it stays Paused waits for the Resume
  //    (`heldForResume`). The pause still says whether the SERVER wakes it;
  //    the owner's own press is theirs to make.
  //  - A test before Start, on a campaign waiting for its Start, reads and
  //    screens and nothing else.
  //
  // The rungs above and below this one hold both like any run: the kill
  // switch, the account's pause, another install's authority and a Stop on
  // the campaign each keep their own reason. INV-6 is satisfied by recording
  // every skip: the run log names the outside force rather than the press
  // doing nothing.
  //
  // Status only.
  if (campaign.status !== "active" && !(await pausedPressAllowed(tx, campaign, press))) {
    return { reason: "target_paused" };
  }
  // Same trigger-blindness as target_paused above, for the same reason stated
  // there: "run now always works" is about PERMISSION, not about whether this
  // installation may spend the account's exposure right now. This is mutual
  // exclusion BETWEEN INSTALLS, not a gate on this one — a manual press on a
  // runtime that does not hold the account is the split-brain the lease
  // exists to prevent, not a way out of it.
  if (!(await readExecutionAuthority(tx, channelId)).allowed) {
    return { reason: "authority_elsewhere", note: AUTHORITY_ELSEWHERE_NOTE };
  }
  // A Stop on the campaign itself (Stop sending — `stopScope`) holds
  // everything it would send, and a run is where a send begins: its find
  // feeds the matches, its draft is the message. Trigger-blind like the campaign
  // status above, and after it and the fence, so a paused campaign and another
  // install's claim keep their own reasons. Its status may still read active;
  // this is the one read that knows otherwise. Nothing it skips is replayed:
  // the wake moves on as any skip's does, and the Resume lets the next run.
  //
  // So does a Stop on its account — Pause LinkedIn — which stops every
  // campaign on it (INV-34), under the same reason and its own note.
  const stops = await campaignStops(tx, { id: campaign.id, channelId });
  if (stops.length > 0) {
    const note = stops.some((stop) => stop.scope === "account") ? ACCOUNT_STOPPED_NOTE : CAMPAIGN_STOPPED_NOTE;
    return { reason: "campaign_stopped", note };
  }
  // Find leads reads people and runs only on a plan that has leads.
  if (leads && !(await leadsEnabled(tx))) return { reason: "leads_off" };
  // THE WINDOW IS NOT CHECKED HERE, and its absence is the decision rather than
  // an omission: it moved DOWN, onto the stages that spend the account's
  // exposure, and off the ones that only think.
  //
  // What skipping here bought, precisely: no browser traffic outside the window.
  // That is real and it is KEPT — the sweep is fenced on the same window at its
  // own call site above. What it also did, and could not tell apart, was refuse
  // to THINK: a wake half an hour before the window opened recorded a skip and
  // advanced a whole cadence past the anchors it was woken for, so the comments
  // the window was about to need did not exist when it opened. Drafting outside
  // the window is the pre-fill, and the sends it produces are fenced twice over
  // anyway — anchors only ever fall inside windows (`dayWindows`), and
  // `canEngage` reads the window again at send time.
  //
  // Last, because it is the only check that costs anything: the channel row.
  // It is asked ONLY when the sweep is on — drafting writes against rows that
  // are already here, so an unreachable account does not stop it and a run
  // that never touches the account is never skipped for one.
  //
  // The ask is deliberately the SAME one the sweep makes, so what the owner
  // reads here is the answer the sweep would have got. This is what "could
  // not" costs: before it, a run on an account nothing had connected swept
  // nothing and closed `succeeded` with a row of zeros — the diagnosis was in
  // the log's silence.
  if (leads && (leads.step.find || leads.test)) {
    const granted = await grant(tx, "discover");
    if (!isGrant(granted)) return connectorSkip(granted);
  }
  return null;
}

/**
 * Close runs that died mid-flight, so a crash stops wedging the campaign.
 *
 * The lease self-heals on a TTL. The one-running-per-channel partial unique
 * index does not: a process that died left its row `running`, the index then
 * refused every later insert, and the handler read that as `campaign_locked` —
 * forever, since nothing in the repo reaps. INV-6 says outside forces may block
 * a run and the log must say why; "a run six hours dead still holds this
 * account" is not one of them.
 *
 * A run cannot legitimately outlive the lease it renews plus the wall-clock
 * budget it stops itself at, so anything older than the sum is abandoned by
 * arithmetic rather than by guess. The backstop for every run nothing else
 * closes: a local runtime releases what a quit left sooner, as it starts again,
 * but only when it can prove no other process is there (`releaseRunsLeftRunning`).
 *
 * Recorded as `failed` with its phase left where it died — representable under
 * the open-run CHECK with no migration and no new skip reason. A reaped run is
 * not a skipped one, and `skip_reason` is bound to `status = 'skipped'` anyway.
 *
 * Scoped to THIS CHANNEL, which is exactly as wide as the wedge: the index is
 * keyed per channel, so reaping per campaign would leave a crashed run on
 * campaign A blocking campaign B forever — permanently, if A's worker is
 * since deleted or disabled and no run of A's ever fires to clear it. Still
 * narrower than org-wide, which would give one worker's preflight a blast
 * radius past the account it is actually unwedging.
 */
/**
 * One read of who invited the account, for this wake or the account's light
 * check between wakes (`inboxCheck.ts`): through the same seam every read on
 * the account takes, from where the campaign's observation begins
 * ({@link observedSince}). Null when it read. Otherwise why it changed nothing, for the run
 * row — the grant's refusal, the read budget's, or the connector's: a page it
 * did not recognise (logged with its diagnostic), a sign-in wall, a throttle,
 * which pauses the account as every read's does, or a failure worth trying
 * again later (a document the sidecar did not keep, a sidecar that did not
 * answer). Anything else throws.
 */
export async function readInvitations(
  ctx: SelfScopedCtx,
  campaign: Campaign,
  channelId: number,
  now: number,
): Promise<string | null> {
  const setup = await withOrg(ctx.organizationId, async (tx) => {
    const observation = await campaignObservation(tx, campaign.id, now);
    return {
      grant: await capabilityGrant(ctx)(tx, "invitations_read"),
      since: observedSince(observation.policy, observation.anchorMs, now),
      channel: await channelCeilings(tx),
    };
  });
  if (!isGrant(setup.grant)) {
    return `invitations could not be read — ${refusalNote(setup.grant)}`;
  }
  try {
    const observed = await observeIncomingInvitations({
      organizationId: ctx.organizationId,
      channelId,
      driver: setup.grant.use,
      now,
      since: setup.since,
      llm: ctx.llm,
    });
    if (observed.status === "read") return null;
    if (observed.status === "refused" && observed.reason === OUTSIDE_WINDOW) {
      return windowWaitNote("Reading invitations", setup.channel, now);
    }
    return `invitations not read — ${observed.status === "refused" ? observed.reason : "unsupported"}`;
  } catch (error) {
    if (isConnectorBackoff(error)) {
      return `invitations not read — ${await pauseChannelForConnectorBackoff(ctx.organizationId, error)}`;
    }
    if (isConnectorDrift(error)) {
      console.warn(
        `[invitations] ${error.message}`,
        JSON.stringify((error as { diagnostic?: unknown }).diagnostic ?? null),
      );
      return `invitations could not be read — ${error.message}`;
    }
    if (isConnectorSignIn(error)) return `invitations could not be read — ${error.message}`;
    // A page whose document was not kept, or a sidecar that did not answer: the
    // account is fine and the next wake reads again, so the wake goes on
    // without an invitations read rather than failing as a whole.
    if (error instanceof ConnectorError && error.retryable) {
      return `invitations not read — ${error.message}`;
    }
    throw error;
  }
}

/**
 * Release what runs left `running` by a process that is gone, as the local
 * runtime starts (`runLoop`), instead of after `reapAbandonedRuns`' lease plus
 * budget while the channel waits.
 *
 * The proof that the process is gone is the executor lock: every local process
 * that can run a job holds it from before its first claim, so while any process
 * but `lock`'s holder has it, nothing is released at all. `before` is a second
 * guard, not the proof: a channel is released only when its running row
 * started before it, its job (if any) was last claimed or heartbeaten before
 * it, and its `worker-run:` lease was last claimed or renewed before it; a
 * channel any of these is newer on waits for a later call. Nor is anything
 * released that `spareLeaseTokens` — the jobs this process is running — holds,
 * whatever the clock says.
 *
 * A released run closes `interrupted` with its phase and every counter it
 * wrote left as they are, its channel's lease is freed, and its job is due again
 * at once, counted as the lease reaper would count it — or, where that was the
 * job's last attempt, the job dead-letters and the run closes `failed`. Nothing
 * about its messages or actions is touched: a send it had in flight stays with
 * the exactly-once reconciliation, exactly as after the reaper. Only on
 * channels whose engagement authority this runtime holds. `onlyOrgs` (tests)
 * keeps a suite to its own organizations.
 */
export async function releaseRunsLeftRunning(
  before: number,
  opts: { lock: ExecutorLock; spareLeaseTokens?: ReadonlySet<string>; onlyOrgs?: readonly string[] },
): Promise<void> {
  if (await anotherExecutorAlive(opts.lock)) return;
  const now = Date.now();
  const orgs = await baseDb.select({ id: organizations.id }).from(organizations);
  for (const org of orgs.filter((row) => !opts.onlyOrgs || opts.onlyOrgs.includes(row.id))) {
    await withOrg(org.id, async (tx) => {
      for (const channel of await tx.select({ id: channels.id }).from(channels)) {
        if (!(await readExecutionAuthority(tx, channel.id)).allowed) continue;
        // One at most: the running-row index allows a channel no second.
        const [left] = await tx
          .select({ id: workerRuns.id, startedAt: workerRuns.startedAt, job: jobs })
          .from(workerRuns)
          .leftJoin(jobs, and(eq(jobs.id, workerRuns.jobId), eq(jobs.organizationId, org.id)))
          .where(and(eq(workerRuns.channelId, channel.id), eq(workerRuns.status, "running")));
        if (!left || left.startedAt >= before) continue;
        const job = left.job?.status === "running" ? left.job : null;
        if (job && ((job.lockedAt ?? 0) >= before || (job.leaseToken !== null && opts.spareLeaseTokens?.has(job.leaseToken)))) continue;
        if (!(await releaseAbandonedExclusiveRun(tx, `worker-run:${channel.id}`, before, now))) continue;
        const requeued = job && (await requeueAbandonedJob(tx, { organizationId: org.id, jobId: job.id, before, now, error: QUIT_MID_RUN_NOTE }));
        // A job out of attempts runs no more, so its run is no interruption.
        await tx
          .update(workerRuns)
          .set({ status: requeued === "dead" ? "failed" : "interrupted", finishedAt: now, error: QUIT_MID_RUN_NOTE })
          .where(and(eq(workerRuns.id, left.id), eq(workerRuns.status, "running")));
      }
    });
  }
}

async function reapAbandonedRuns(
  tx: Tx,
  channelId: number,
  now: number,
): Promise<void> {
  await tx
    .update(workerRuns)
    .set({
      status: "failed",
      finishedAt: now,
      error: REAPED_RUN_NOTE,
    })
    .where(
      and(
        eq(workerRuns.channelId, channelId),
        eq(workerRuns.status, "running"),
        lt(workerRuns.startedAt, now - ABANDONED_RUN_AFTER_MS),
      ),
    );
}

/**
 * What the run says of its inbox read, when there is something to say: a
 * read that could not happen or was cut short, an inbox that listed more than
 * the read took, or conversations it opened unread whose mark it could not
 * see restored. A read that went through is on its own `inbox_reads` row,
 * which is where coverage is told from.
 */
export function inboxRunNote(
  observed: InboxObservation,
  channel: Channel | null,
  now: number,
): string | null {
  switch (observed.status) {
    case "read": {
      const notes = [
        observed.stoppedBy
          ? `inbox read stopped early: ${(channel && replyCheckLimitLine(observed.stoppedBy, channel)) ?? observed.stoppedBy}`
          : null,
        observed.skipped > 0
          ? `inbox read skipped ${observed.skipped} conversation${observed.skipped === 1 ? "" : "s"} it could not read`
          : observed.truncated
            ? `inbox read took only the newest ${observed.listed} conversations`
            : null,
        observed.unreadRestoresUnconfirmed > 0
          ? `unread_restore_unconfirmed on ${observed.unreadRestoresUnconfirmed} opened conversation(s): they may show as read on LinkedIn`
          : null,
        ...observed.agentNotes,
      ].filter((note): note is string => note !== null);
      return notes.length > 0 ? notes.join("; ") : null;
    }
    case "refused":
      return observed.reason === OUTSIDE_WINDOW
        ? windowWaitNote("Reading the inbox", channel, now)
        : `inbox not read: ${(channel && replyCheckLimitLine(observed.reason, channel)) ?? observed.reason}`;
    case "failed":
      return [`inbox read failed: ${observed.reason}`, ...(observed.agentNotes ?? [])].join("; ");
    case "unsupported":
      return "inbox not read: this account's connector cannot read direct messages";
    case "stopped":
      return null;
  }
}

/** Tests inject an LLM; production resolves the owner's own agent CLI through
 *  the same registry every other server-side model call uses. The local worker
 *  starts as `runLoop({})` and injects nothing, so treating an absent `ctx.llm`
 *  as an error failed every scheduled run before it reached a model. */
function resolveLlm(ctx: SelfScopedCtx) {
  return ctx.llm ?? getLLM();
}
