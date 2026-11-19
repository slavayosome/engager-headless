import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  workerRuns,
  campaignStrategies,
  campaigns,
  channels,
  jobs,
  workers,
  type WorkerRun,
  type Campaign,
  type CampaignStrategyRow,
  type Channel,
  type WorkerRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { withConversationSums, type WithConversation } from "../agentStep/runSums";
import { audienceProfile, editableAudience } from "../audience/model";
import { saveAudience } from "../audience/write";
import { audienceLineOf, NoLineToWidenError } from "../campaigns/widenLine";
import {
  CONNECTOR_DECLARATIONS,
  type ConnectorDeclaration,
} from "../connector/capabilities";
import { StrategyActivationError, readAccountDefault } from "../strategy/activate";
import { awaitingStart } from "../strategy/read";
import {
  CAPABILITIES,
  NETWORK_CATALOGS,
  NO_LIVE_CHECKS,
  WORKER_CATALOG,
  capabilityAvailable,
  type CapabilityId,
  type CatalogStepId,
  type StrategyWorker,
  type LiveChecks,
  type NetworkCatalog,
} from "../strategy/catalog";
import {
  parseStrategy,
  type CampaignAgentStrategy,
} from "../strategy/contract";
import type { ResolvedAction } from "../strategy/resolve";
import { liveModes } from "../strategy/mode";
import { previewModes } from "../strategy/preview";
import { readSearchDepth } from "../strategy/searchDepth";
import { resolveJudgmentPolicy, type JudgmentPolicy } from "../tasks/policy";
import type { WorkerRunPayload } from "../jobs/handlers/workerRun";
import { enqueue, retireFinishedIdempotencyKey } from "../jobs/queue";
import { widenPainPhrases } from "../leads/scout/mapPlan";
import { recordedLiveChecks } from "../liveChecks/records";
import type { NetworkId } from "../network/registry";
import { campaignFirstLook, FIRST_LOOK_ROUNDS, firstLookKey } from "../workers/firstLook";
import { scoutIdFor, workerRunState, type WorkerRunStatus } from "./workers";
import { withOrg } from "@engager/database/tenant";
import type { McpCtx } from "../mcp/context";
import { startTask } from "../tasks/task";
export { listRunOutput, type WorkerOutputRow } from "./runOutput";

/**
 * WHAT THE CAMPAIGN WORKSPACE READS — one campaign, the object the owner
 * manages (INV-33), with the workers it hires named only as the owners of its
 * steps.
 *
 * A campaign reads its active version (or, before its first activation, its
 * newest one — "Not started"). Every action is resolved by the one
 * resolver (`resolve.ts`), against the channel's real connector, so a surface
 * shows the effective mode and where it came from rather than a column. No
 * clock: what a campaign may do is configuration, and an action shown Off at
 * night because the account's window is shut would be a different answer to
 * the same question every few hours.
 *
 * Nothing here writes but Run now's enqueue (`enqueueManualRun`), which is
 * exactly what each worker's own Run now enqueues (INV-5), and Run a test's
 * and a first look's, which are that job marked a test.
 */

/** A campaign's channel, as a fact: the network and the account's own name. */
export type CampaignChannel = {
  id: number;
  network: NetworkId;
  displayName: string | null;
};

export type CampaignStrategy = {
  /** The document the actions resolve from. */
  document: CampaignAgentStrategy | null;
  /** The stored version read, or null for an unflagged campaign, whose
   *  actions are its rows said in the strategy's words. */
  version: Pick<CampaignStrategyRow, "version" | "status" | "effectiveAt"> | null;
  /** On its strategy, with no version ever activated: nothing wakes. */
  notStarted: boolean;
  accountDefault: { version: number; document: CampaignAgentStrategy } | null;
  network: NetworkCatalog | null;
  connector: ConnectorDeclaration | null;
  /** The first sends and live checks recorded on the campaign's account. */
  liveChecks: LiveChecks;
  actions: ResolvedAction[];
};

/** One worker the strategy uses, with its actions' effective modes. */
export type WorkerActions = {
  worker: StrategyWorker;
  label: string;
  actions: ResolvedAction[];
};

/**
 * The actions grouped by the worker that owns each, workers in the order their
 * first step appears in the strategy — Scout before Ambassador whenever Find
 * posts leads. Pure.
 */
export function actionsByWorker(
  actions: readonly ResolvedAction[],
): WorkerActions[] {
  const groups = new Map<StrategyWorker, ResolvedAction[]>();
  for (const action of actions) {
    const group = groups.get(action.worker) ?? [];
    group.push(action);
    groups.set(action.worker, group);
  }
  return [...groups].map(([worker, grouped]) => ({
    worker,
    label: WORKER_CATALOG[worker].label,
    actions: grouped,
  }));
}

/**
 * The catalog actions this channel's connector cannot perform at all — what
 * Overview shows beside what the campaign will not do: beyond this
 * connection. Pure.
 */
export function unavailableActions(
  network: NetworkCatalog,
  connector: ConnectorDeclaration,
): Array<{
  label: string;
  worker: StrategyWorker;
  capability: CapabilityId;
}> {
  return network.actions.flatMap((row) =>
    row.targets.some((target) => capabilityAvailable(row.capability, connector, target))
      ? []
      : [
          {
            label: row.label,
            worker: CAPABILITIES[row.capability].workers[0]!,
            capability: row.capability,
          },
        ],
  );
}

async function channelOf(
  tx: Tx,
  channelId: number | null,
): Promise<Pick<Channel, "id" | "network" | "connector" | "displayName"> | null> {
  if (channelId === null) return null;
  const [row] = await tx
    .select({
      id: channels.id,
      network: channels.network,
      connector: channels.connector,
      displayName: channels.displayName,
    })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row ?? null;
}

/** A campaign's workers, oldest first — the order the projection reads them. */
export async function campaignWorkers(
  tx: Tx,
  campaignId: number,
): Promise<WorkerRow[]> {
  return tx
    .select()
    .from(workers)
    .where(eq(workers.campaignId, campaignId))
    .orderBy(asc(workers.id));
}

/** What a campaign's workers may do, resolved from its strategy. */
export async function readCampaignStrategy(
  tx: Tx,
  campaign: Campaign,
): Promise<CampaignStrategy & { channel: CampaignChannel | null }> {
  const channel = await channelOf(tx, campaign.channelId);
  const network = channel ? NETWORK_CATALOGS[channel.network] : null;
  const connector = channel?.connector ? CONNECTOR_DECLARATIONS[channel.connector] : null;
  const liveChecks = channel ? await recordedLiveChecks(tx, channel.id) : NO_LIVE_CHECKS;
  // An account default that fails the contract activates nothing, so it
  // resolves nothing here either: every inherited value reads as unset, the
  // way it would with none at all, rather than taking the page down with it.
  const accountDefault =
    channel && network
      ? await readAccountDefault(tx, channel.id, { network }).catch((error: unknown) => {
          if (error instanceof StrategyActivationError) return null;
          throw error;
        })
      : null;

  let document: CampaignAgentStrategy | null = null;
  let version: CampaignStrategy["version"] = null;
  let notStarted = false;
  const versions = await tx
    .select()
    .from(campaignStrategies)
    .where(eq(campaignStrategies.campaignId, campaign.id))
    .orderBy(desc(campaignStrategies.version));
  const row = versions.find((item) => item.status === "active") ?? versions[0];
  notStarted = !versions.some((item) => item.status === "active");
  if (row) {
    const parsed = parseStrategy(row.document, { network });
    document = parsed.success ? parsed.data : null;
    version = { version: row.version, status: row.status, effectiveAt: row.effectiveAt };
  }

  let actions =
    document && network && row?.status !== "active"
      ? previewModes({
          accountDefault: accountDefault?.document ?? null,
          campaign: document,
          network,
          connector,
          liveChecks,
        })
      : [];
  if (row?.status === "active") {
    actions = await liveModes(tx, campaign.id);
  }
  return {
    document,
    version,
    notStarted,
    accountDefault,
    network,
    connector,
    liveChecks,
    actions,
    channel: channel
      ? { id: channel.id, network: channel.network, displayName: channel.displayName }
      : null,
  };
}

/**
 * The earliest wake among the campaign's workers. None while the campaign is
 * not Active or never started: its status is what decides whether the server
 * wakes them, and a paused campaign's runs would only be skipped. None either
 * while a Stop holds its sending (`stopped`, an open campaign-scope pause),
 * whatever its status reads: each wake that comes due records
 * `campaign_stopped`, runs nothing and moves on, and the one after the
 * Resume is the next to run.
 */
export function nextCampaignWake(
  campaign: Pick<Campaign, "status">,
  rows: ReadonlyArray<Pick<WorkerRow, "auto" | "nextRunAt">>,
  notStarted: boolean,
  stopped: boolean,
): number | null {
  if (campaign.status !== "active" || notStarted || stopped) return null;
  const wakes = rows
    .filter((row) => row.auto && row.nextRunAt !== null)
    .map((row) => row.nextRunAt as number);
  return wakes.length > 0 ? Math.min(...wakes) : null;
}

/** A run of one of the campaign's workers, with which worker ran it. */
export type CampaignRun = WithConversation<WorkerRun & { ranBy: StrategyWorker }>;

/** The rows' runs, each with who ran it and the conversation sums its step rows give. */
async function withRanBy(
  tx: Tx,
  rows: ReadonlyArray<{ run: WorkerRun; type: WorkerRow["type"] }>,
): Promise<CampaignRun[]> {
  return withConversationSums(tx, rows.map((row) => ({ ...row.run, ranBy: row.type })));
}

/** The newest run of any of the campaign's workers. */
export async function latestCampaignRun(
  tx: Tx,
  campaignId: number,
): Promise<CampaignRun | null> {
  const [row] = await tx
    .select({ run: workerRuns, type: workers.type })
    .from(workerRuns)
    .innerJoin(workers, eq(workers.id, workerRuns.workerId))
    .where(eq(workers.campaignId, campaignId))
    .orderBy(desc(workerRuns.startedAt), desc(workerRuns.id))
    .limit(1);
  return row ? (await withRanBy(tx, [row]))[0]! : null;
}

/** Whether the account keeps active hours, so that its campaigns wake inside
 *  them. A Scout's section says so beside its next wake; the hours themselves
 *  are the account's, shown on its channel. */
export async function accountKeepsHours(tx: Tx, channelId: number): Promise<boolean> {
  const [channel] = await tx.select({ activeHours: channels.activeHours }).from(channels).where(eq(channels.id, channelId));
  return channel?.activeHours != null;
}

/** One run, if one of this campaign's workers ran it, with that worker. */
export async function getCampaignRun(
  tx: Tx,
  campaignId: number,
  runId: number,
): Promise<{ run: CampaignRun; worker: WorkerRow } | null> {
  const [row] = await tx
    .select({ run: workerRuns, worker: workers })
    .from(workerRuns)
    .innerJoin(workers, eq(workers.id, workerRuns.workerId))
    .where(and(eq(workerRuns.id, runId), eq(workers.campaignId, campaignId)));
  return row
    ? { run: (await withRanBy(tx, [{ run: row.run, type: row.worker.type }]))[0]!, worker: row.worker }
    : null;
}

/** The campaign's runs either side of this one, chronologically. */
export async function campaignRunNeighbours(
  tx: Tx,
  campaignId: number,
  run: Pick<WorkerRun, "id" | "startedAt">,
): Promise<{ previousId: number | null; nextId: number | null }> {
  const step = async (direction: "older" | "newer") => {
    const [row] = await tx
      .select({ id: workerRuns.id })
      .from(workerRuns)
      .innerJoin(workers, eq(workers.id, workerRuns.workerId))
      .where(
        and(
          eq(workers.campaignId, campaignId),
          direction === "older"
            ? sql`(${workerRuns.startedAt}, ${workerRuns.id}) < (${run.startedAt}, ${run.id})`
            : sql`(${workerRuns.startedAt}, ${workerRuns.id}) > (${run.startedAt}, ${run.id})`,
        ),
      )
      .orderBy(
        ...(direction === "older"
          ? [desc(workerRuns.startedAt), desc(workerRuns.id)]
          : [asc(workerRuns.startedAt), asc(workerRuns.id)]),
      )
      .limit(1);
    return row?.id ?? null;
  };
  return { previousId: await step("older"), nextId: await step("newer") };
}

/**
 * Enqueue one owner-pressed run of one worker — the job the schedule
 * enqueues, differing only in its trigger (INV-5). A fresh key per press: a
 * key that collapsed two presses would make the second silently do nothing.
 * `pressId` names the campaign press it is one step of, when it is one.
 */
export async function enqueueManualRun(
  tx: Tx,
  workerId: number,
  pressId?: string,
  trigger: "manual" | "agent" = "manual",
): Promise<boolean> {
  const payload: WorkerRunPayload = {
    workerId,
    trigger,
    ...(pressId === undefined ? {} : { pressId }),
  };
  // An agent's press keeps v1's key, so two in the same instant collapse and
  // say so; the owner's presses stay one fresh key each.
  const jobId = await enqueue(tx, {
    type: "worker_run",
    payload,
    idempotencyKey: trigger === "agent" ? `worker:${workerId}:agent:${Date.now()}` : `worker:${workerId}:manual:${randomUUID()}`,
  });
  return jobId != null;
}

export class CampaignNotStartedError extends AppError {
  readonly recovery =
    "Start the campaign first; until then nothing in it runs, by a press or on its own, but a test, which reads only.";

  constructor() {
    super("campaign_not_started", "This campaign has not started.", 409);
  }
}

/**
 * A campaign's workers with a step switched on, in the order each one's first
 * step appears in `steps` — its strategy. The rows are the projection's: the
 * Scout and the oldest Ambassador (`project.ts`). A Scout that
 * finds leads with both its reads Off has no switch on its row to be on, but a
 * press is the owner deciding: its reads are bindings on its step, which its
 * run reads, so the step being in the strategy is what puts it in the order.
 */
export function workersInStrategyOrder<Row extends WorkerRow>(
  steps: ReadonlyArray<{ worker: StrategyWorker; catalog_step: CatalogStepId; step_id: string }>,
  rows: readonly Row[],
  actions: readonly ResolvedAction[],
): Row[] {
  const rowFor = new Map<StrategyWorker, Row>();
  for (const row of rows) {
    const worker = row.type;
    if (!rowFor.has(worker)) rowFor.set(worker, row);
  }
  const order: Row[] = [];
  for (const step of steps) {
    const row = rowFor.get(step.worker);
    if (!row || order.includes(row)) continue;
    if (!actions.some((action) => action.step_id === step.step_id && action.effective !== null && action.effective !== "off")) continue;
    order.push(row);
  }
  return order;
}

/** The workers a campaign's Run now wakes, in strategy order, from the
 *  version in force. */
export async function campaignRunOrder(
  tx: Tx,
  campaignId: number,
): Promise<number[]> {
  const [active] = await tx
    .select({ document: campaignStrategies.document })
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.campaignId, campaignId),
        eq(campaignStrategies.status, "active"),
      ),
    );
  if (!active) throw new CampaignNotStartedError();
  // The active version passed the contract when it activated.
  const steps = (active.document as CampaignAgentStrategy).steps ?? [];
  const rows = await campaignWorkers(tx, campaignId);
  const actions = await liveModes(tx, campaignId);
  return workersInStrategyOrder(steps, rows, actions).map((row) => row.id);
}

/**
 * RUN NOW, for a campaign that runs on its strategy: one manual run per
 * worker with a step switched on, in strategy order. The account's run lease
 * serializes them. On a paused campaign the same press is RUN ONCE: it finds,
 * matches and drafts, and sends nothing — every draft waits for a yes and the
 * campaign stays Paused (`pausedPressAllowed`). A Stop records
 * `campaign_stopped` and the org's stop `kill_switch`; this passes neither.
 *
 * ONE PRESS IS THE WHOLE LOOP. In strategy order the Scout finds and triages
 * first and the Ambassador drafts from what it matched, for as much as the
 * account can still post today (`computeCommentDemand`), so the press reads
 * back as one answer — found, matched, drafted, waiting — through the one id
 * every run it enqueued carries (`pressId`).
 */
export async function runCampaignNow(
  tx: Tx,
  campaignId: number,
): Promise<{ workerIds: number[] }> {
  const [campaign] = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  if (!campaign) {
    throw new AppError("campaign_not_found", `campaign ${campaignId} not found`, 404);
  }
  // Find posts is hidden: a campaign still on it runs again once switched.
  const workerIds = await campaignRunOrder(tx, campaignId);
  const pressId = randomUUID();
  for (const workerId of workerIds) await enqueueManualRun(tx, workerId, pressId);
  return { workerIds };
}

const PRESS_REFUSALS: ReadonlySet<string> = new Set(["target_paused", "kill_switch", "organization_paused", "campaign_stopped"]);

/** Route an agent's press through the same run order and judgment policy. */
export async function runWorkerNow(ctx: McpCtx, campaignId: number, worker: "scout" | "ambassador" | undefined, signal: AbortSignal) {
  const selected = await withOrg(ctx.organizationId, async tx => {
    const order = await campaignRunOrder(tx, campaignId);
    const rows = await campaignWorkers(tx, campaignId);
    const ordered = order.flatMap(id => rows.filter(row => row.id === id));
    const chosen = worker ? ordered.filter(row => row.type === worker) : ordered;
    if (worker && chosen.length === 0) throw new AppError("worker_not_in_strategy", "That worker has no enabled step in the strategy.", 409);
    return { chosen, policy: await resolveJudgmentPolicy(tx) };
  });
  if (selected.policy === "interactive_external") {
    if (selected.chosen.some(row => row.type === "scout")) throw new AppError("first_look_needs_agent", "Find leads requires a background agent.", 409);
    const tasks = [];
    for (const row of selected.chosen) {
      try { tasks.push(await startTask(ctx, { workerId: row.id, campaignId, taskKind: "draft" }, signal)); }
      catch (error) {
        // A Pause, a Stop or the kill switch ends the press here, coded, with the tasks already prepared still reported.
        const code = error instanceof Error ? error.message : "";
        if (!PRESS_REFUSALS.has(code)) throw error;
        return { mode: "in_session" as const, tasks, refused: { workerId: row.id, code } };
      }
    }
    return { mode: "in_session" as const, tasks };
  }
  return withOrg(ctx.organizationId, async tx => {
    const current = await campaignRunOrder(tx, campaignId);
    const ids = selected.chosen.map(row => row.id);
    if (ids.some(id => !current.includes(id))) throw new AppError("worker_not_in_strategy", "The strategy changed; read it and try again.", 409);
    const pressId = randomUUID();
    const queued: number[] = [];
    for (const id of ids) if (await enqueueManualRun(tx, id, pressId, "agent")) queued.push(id);
    return { mode: "queued" as const, workerIds: queued, queued: queued.length > 0, ...(queued.length < ids.length && { alreadyQueued: ids.filter(id => !queued.includes(id)) }) };
  });
}

/** A test on a campaign that is not waiting for its Start. */
export class CampaignStartedError extends AppError {
  readonly recovery = "Run now runs a campaign that has started.";

  constructor() {
    super("campaign_started", "A test runs only before a campaign starts.", 409);
  }
}

/** A test on a draft with nothing that finds. The code is today's on either
 *  step, for the callers that read it; the words name the step this campaign
 *  can add. */
export class TestNeedsFindLeadsError extends AppError {
  readonly recovery = "A test is the Scout's find and triage, so the draft needs the step that finds.";

  constructor() {
    super("test_needs_find_leads", "Add a Find leads step first.", 409);
  }
}

/** A first look asked of a campaign whose depth is not Quick. */
export class FirstLookNeedsQuickError extends AppError {
  readonly recovery = "A first look is a Quick campaign's: set its search depth to Quick, then ask again.";

  constructor() {
    super("first_look_needs_quick", "This campaign's search depth is not Quick.", 409);
  }
}

/** A first look asked of a draft with no step that comments, which would have
 *  nothing to draft into. */
export class FirstLookNeedsCommentStepError extends AppError {
  readonly recovery = "A first look drafts comments, so the draft needs the step that comments. Add a Comment step, then ask again.";

  constructor() {
    super("first_look_needs_comment_step", "This draft has no Comment step, so a first look has nothing to draft.", 409);
  }
}

/** A first look asked of a campaign whose Scout finds leads, with no
 *  background agent to think for it: its rounds screen and merge on the
 *  agent Engager runs, and none of it is owed to the caller's session. */
export class FirstLookNeedsAgentError extends AppError {
  readonly recovery = "Choose one in Agent, then ask again.";

  constructor() {
    super("first_look_needs_agent", "A Find leads first look runs on the agent that thinks for Engager.", 409);
  }
}

/** The steps of a campaign's newest version, which for one not started is its
 *  draft. */
async function draftSteps(tx: Tx, campaignId: number): Promise<NonNullable<CampaignAgentStrategy["steps"]>> {
  const [draft] = await tx
    .select({ document: campaignStrategies.document })
    .from(campaignStrategies)
    .where(eq(campaignStrategies.campaignId, campaignId))
    .orderBy(desc(campaignStrategies.version))
    .limit(1);
  return (draft?.document as Partial<CampaignAgentStrategy> | undefined)?.steps ?? [];
}

/** Whether a campaign's draft has the step that finds leads, which makes its
 *  Scout one that finds leads: its test reads and screens the search map,
 *  and its first look serves Signals and drafts nothing. */
export async function draftFindsLeads(tx: Tx, campaignId: number): Promise<boolean> {
  return (await draftSteps(tx, campaignId)).some((step) => step.catalog_step === "find_leads");
}

/**
 * The Scout of a campaign a test may run: one waiting for its Start, whose
 * draft has the step that finds, posts or leads. Refuses every other campaign
 * with what the owner can do about it.
 */
async function testableScout(
  tx: Tx,
  campaignId: number,
): Promise<{ campaign: Campaign; scoutId: number; steps: NonNullable<CampaignAgentStrategy["steps"]> }> {
  const [campaign] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  if (!campaign) {
    throw new AppError("campaign_not_found", `campaign ${campaignId} not found`, 404);
  }
  if (campaign.status === "archived") {
    throw new AppError("campaign_archived", "An archived campaign runs nothing.", 409);
  }
  if (!(await awaitingStart(tx, campaign))) throw new CampaignStartedError();
  // Not started, so the newest version is its draft.
  const steps = await draftSteps(tx, campaignId);
  // Find posts is hidden (US-LMF-08): a draft still on it is switched first.
  if (!steps.some((step) => step.catalog_step === "find_leads")) {
    throw new TestNeedsFindLeadsError();
  }
  const [scout] = await tx
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.campaignId, campaignId), eq(workers.type, "scout")))
    .orderBy(asc(workers.id))
    .limit(1);
  if (!scout) throw new AppError("scout_not_found", "This campaign has no Scout to run.", 404);
  return { campaign, scoutId: scout.id, steps };
}

/**
 * RUN A TEST, on a campaign not started: one manual run of its Scout, marked a
 * test (`WorkerRunPayload.test`), which reads the campaign's searches and
 * triages what they find against its audience — whatever the Scout's switches
 * say, and nothing else. A Scout that finds leads reads its search map and
 * screens the people's words instead, and merges no one into a lead. No
 * Ambassador run, so nothing is drafted, liked or sent; the campaign stays as
 * it is, and no wake is armed.
 *
 * A press while the Scout already has a run queued or going enqueues nothing:
 * that run is the test the owner is waiting on.
 */
export async function runCampaignTestOp(
  tx: Tx,
  campaignId: number,
  now: number = Date.now(),
): Promise<{ workerId: number; enqueued: boolean }> {
  const { campaign, scoutId } = await testableScout(tx, campaignId);
  if ((await workerRunState(tx, campaign.organizationId, scoutId, now)) !== "idle") {
    return { workerId: scoutId, enqueued: false };
  }
  const payload: WorkerRunPayload = { workerId: scoutId, trigger: "manual", test: true };
  await enqueue(tx, {
    type: "worker_run",
    payload,
    idempotencyKey: `worker:${scoutId}:test:${randomUUID()}`,
  });
  return { workerId: scoutId, enqueued: true };
}

/** What asking for a first look did: queued its first round, found one
 *  already queued or going and added nothing, or owes it to the caller's own
 *  agent, there being no background agent to think for it. */
export type FirstLookOutcome = { workerId: number; outcome: "queued" | "already_running" | "owed" };

/**
 * RUN A FIRST LOOK, on a Quick campaign not started (US-DEP-06): the test
 * before Start, run as the first look a Start would begin — Quick's rounds,
 * the first drafting its best matches into their comment boxes. A test still:
 * it drafts and sends nothing else, arms no wake, and leaves the campaign
 * waiting for its Start, which stays the owner's.
 *
 * Where the draft's Scout step is Find leads (US-LMF-06), each round is a
 * Quick Find leads run that serves the people who pass the screen as Signals
 * on Leads and drafts nothing, so no Comment step is needed.
 *
 * Routed as the campaign's first sweep is (`kickFirstDiscovery`): with no
 * healthy background agent nothing is queued and the first look is owed to
 * the caller's own agent, stage by stage (`firstLookStage`) — except a Find
 * leads first look, which has no stages to owe and is refused. A first look,
 * or any run of the Scout, already queued or going is the one asked for, and
 * nothing is added. One that finished is the campaign's to run again: the
 * keys its rounds held are freed for the new one.
 */
export async function runFirstLookOp(
  tx: Tx,
  campaignId: number,
  options: { trigger: "manual" | "agent"; judgmentPolicy?: JudgmentPolicy },
  now: number = Date.now(),
): Promise<FirstLookOutcome> {
  const { campaign, scoutId, steps } = await testableScout(tx, campaignId);
  const findsLeads = steps.some((step) => step.catalog_step === "find_leads");
  if ((await readSearchDepth(tx, campaign)) !== "quick") throw new FirstLookNeedsQuickError();
  if (!findsLeads && !steps.some((step) => step.catalog_step === "comment_on_posts")) {
    throw new FirstLookNeedsCommentStepError();
  }
  if ((await workerRunState(tx, campaign.organizationId, scoutId, now)) !== "idle") {
    return { workerId: scoutId, outcome: "already_running" };
  }
  if ((await resolveJudgmentPolicy(tx, options.judgmentPolicy, now)) === "interactive_external") {
    if (findsLeads) throw new FirstLookNeedsAgentError();
    return { workerId: scoutId, outcome: "owed" };
  }
  const queued = await enqueueFirstLookRound(tx, campaign.organizationId, scoutId, 1, {
    trigger: options.trigger,
    test: true,
  });
  return { workerId: scoutId, outcome: queued === null ? "already_running" : "queued" };
}

/**
 * Queue one round of a first look under its key, the keys finished rounds held
 * freed for it. Two asks at once both find the Scout idle; the key lets one
 * through, and the other gets null. A campaign not started runs it as a test.
 */
async function enqueueFirstLookRound(
  tx: Tx,
  organizationId: string,
  scoutId: number,
  round: number,
  options: { trigger: "manual" | "agent"; test: boolean; freshSearches?: true },
): Promise<number | null> {
  for (let key = 1; key <= FIRST_LOOK_ROUNDS; key++) {
    await retireFinishedIdempotencyKey(tx, organizationId, firstLookKey(scoutId, key));
  }
  const payload: WorkerRunPayload = {
    workerId: scoutId,
    trigger: options.trigger,
    ...(options.test ? { test: true } : {}),
    firstLook: { round, ...(options.freshSearches ? { freshSearches: true } : {}) },
  };
  return enqueue(tx, { type: "worker_run", payload, idempotencyKey: firstLookKey(scoutId, round) });
}

/** A first look run again from a wider line, asked of a campaign whose last one
 *  did not end with no one. */
export class FirstLookNotEmptyError extends AppError {
  readonly recovery = "Only a first look that found no one is run again from a wider line.";

  constructor() {
    super("first_look_not_empty", "This campaign's first look did not end with no one.", 409);
  }
}

/** A wider line none of whose drafted searches the campaign could use. */
class NoSearchesFromLineError extends AppError {
  constructor() {
    super("no_searches", "None of the searches drafted from that line could be used.", 422);
  }
}

/** The wider line and the first searches drafted from it. */
export type WiderLine = { line: string; searches: readonly string[] };

/**
 * RUN THE FIRST LOOK AGAIN, from a wider line: a Quick campaign whose first
 * look ended having found no one has its audience line replaced (one revision,
 * the old text kept in its history) and its first searches replaced by the
 * ones drafted from the new line (the old ones retired, kept in the
 * campaign's search history), and its first look queued from round one. It
 * changes nothing else — the steps, their modes and instructions, the limits
 * and every other campaign stay — and sends nothing: the first look only
 * drafts, for the owner's yes.
 *
 * On a campaign that finds leads the searches are its search map's: the
 * new ones become Pain phrases of the Scout's and its other unpinned Pain
 * phrases are retired (`widenPainPhrases`); Find posts' searches are not
 * touched.
 *
 * A first look, or any run of the Scout, already queued or going is the one
 * asked for and nothing is changed. Owed to the caller's own agent, as a
 * first look is where no background agent can think (`runFirstLookOp`), it
 * changes nothing either — and one that finds leads is refused. The campaign
 * row is locked first, so two presses at once are one: the second finds the
 * first look queued.
 */
export async function rerunFirstLook(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  wider: WiderLine,
  options: { trigger: "manual" | "agent"; judgmentPolicy?: JudgmentPolicy },
  now: number = Date.now(),
): Promise<FirstLookOutcome> {
  const campaign = await lockedCampaign(tx, campaignId);
  if ((await readSearchDepth(tx, campaign)) !== "quick") throw new FirstLookNeedsQuickError();
  const scoutId = await scoutIdFor(tx, campaignId);
  if (scoutId === null) throw new AppError("scout_not_found", "This campaign has no Scout to run.", 404);
  if ((await workerRunState(tx, organizationId, scoutId, now)) !== "idle") {
    return { workerId: scoutId, outcome: "already_running" };
  }
  const looked = await campaignFirstLook(tx, organizationId, campaignId);
  if (!looked?.done || looked.matched > 0 || looked.stopped !== null) throw new FirstLookNotEmptyError();
  if (audienceLineOf(campaign) === null) throw new NoLineToWidenError();
  if ((await resolveJudgmentPolicy(tx, options.judgmentPolicy, now)) === "interactive_external") {
    throw new FirstLookNeedsAgentError();
  }
  const before = audienceProfile(campaign);
  await saveAudience(
    tx,
    organizationId,
    campaignId,
    {
      baseRevision: campaign.audienceRevision,
      profile: { ...editableAudience(before), who: { ...before.who, summary: wider.line } },
    },
    now,
  );
  if ((await widenPainPhrases(tx, campaignId, wider.searches, now)).length === 0) throw new NoSearchesFromLineError();
  const queued = await enqueueFirstLookRound(tx, organizationId, scoutId, 1, {
    trigger: options.trigger,
    test: await awaitingStart(tx, campaign),
  });
  return { workerId: scoutId, outcome: queued === null ? "already_running" : "queued" };
}

/** Retry a stopped round once, preserving its prior output and campaign choices. */
export async function retryFirstLook(
  tx: Tx, organizationId: string, campaignId: number,
  options: { trigger: "manual" | "agent"; judgmentPolicy?: JudgmentPolicy }, now = Date.now(),
): Promise<FirstLookOutcome> {
  const campaign = await lockedCampaign(tx, campaignId);
  if ((await readSearchDepth(tx, campaign)) !== "quick") throw new FirstLookNeedsQuickError();
  const scoutId = await scoutIdFor(tx, campaignId);
  if (scoutId === null) throw new AppError("scout_not_found", "This campaign has no Scout to run.", 404);
  const state = await workerRunState(tx, organizationId, scoutId, now);
  if (state === "running") return { workerId: scoutId, outcome: "already_running" };
  const looked = await campaignFirstLook(tx, organizationId, campaignId);
  if (state !== "idle" && !looked?.stopped) return { workerId: scoutId, outcome: "already_running" };
  if (!looked?.stopped) throw new AppError("first_look_not_stopped", "This first look is not waiting for a retry.", 409);
  const test = await awaitingStart(tx, campaign);
  if (!test && campaign.status !== "active") throw new AppError("campaign_paused", "Resume this campaign before retrying its first look.", 409);
  if ((await resolveJudgmentPolicy(tx, options.judgmentPolicy, now)) === "interactive_external") {
    throw new FirstLookNeedsAgentError();
  }
  if (state !== "idle") {
    // Older runs have no job association. Never guess among another press's
    // pending jobs; their ordinary queue retries remain available.
    if (looked.stopped.jobId === undefined) return { workerId: scoutId, outcome: "already_running" };
    // Reuse a failed job rather than adding one beside it. Clearing lastError
    // marks the owner's explicit retry; the immutable run retains the fault.
    const retried = await tx.update(jobs).set({ nextRunAt: now, lastError: null, updatedAt: now,
      payload: sql`jsonb_set(${jobs.payload}, '{firstLook}', ${JSON.stringify({ round: looked.round })}::jsonb)` })
      .where(and(eq(jobs.organizationId, organizationId), eq(jobs.type, "worker_run"), eq(jobs.status, "queued"),
        eq(jobs.id, looked.stopped.jobId),
        sql`${jobs.lastError} is not null`, sql`${jobs.payload}->>'workerId' = ${String(scoutId)}`,
        sql`(${jobs.payload}->'firstLook'->>'round' = ${String(looked.round)} or (${looked.round === 1} and ${jobs.payload}->'firstLook' is null))`))
      .returning({ id: jobs.id });
    return { workerId: scoutId, outcome: retried.length ? "queued" : "already_running" };
  }
  // Retry this round with the existing cursor and rows. No audience, source,
  // match, draft, mode or limit is changed. The handler keeps prior results.
  const queued = await enqueueFirstLookRound(tx, organizationId, scoutId, looked.round, { trigger: options.trigger, test });
  return { workerId: scoutId, outcome: queued === null ? "already_running" : "queued" };
}

/** The campaign, its row locked so a press on it is one at a time. */
async function lockedCampaign(tx: Tx, campaignId: number): Promise<Campaign> {
  const [campaign] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)))
    .for("update");
  if (!campaign) throw new AppError("campaign_not_found", `campaign ${campaignId} not found`, 404);
  if (campaign.status === "archived") throw new AppError("campaign_archived", "An archived campaign runs nothing.", 409);
  return campaign;
}

/** The campaign a worker does steps for — where the redirect stub a worker's
 *  old URL became sends the owner. */
export async function campaignOfWorker(
  tx: Tx,
  workerId: number,
): Promise<number | null> {
  const [row] = await tx
    .select({ campaignId: workers.campaignId })
    .from(workers)
    .where(eq(workers.id, workerId));
  return row?.campaignId ?? null;
}
