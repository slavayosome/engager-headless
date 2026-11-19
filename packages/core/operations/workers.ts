import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  workerRuns,
  campaigns,
  channels,
  jobs,
  organizations,
  workers,
  type WorkerRun,
  type Campaign,
  type Channel,
  type WorkerRow,
  type WorkerType,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { withConversationSums, type WithConversation } from "../agentStep/runSums";
import {
  CONNECTOR_DECLARATIONS,
  unsupportedWorkerCapabilities,
} from "../connector/capabilities";
import { unsupportedKindRefusal } from "../connector/resolve";
import {
  assertNotStrategyOwned,
  refuseStrategyOwnedWrite,
  runsOnStrategy,
} from "../strategy/writers";
import { modeFor } from "../strategy/mode";
import { DEFAULT_NETWORK } from "../network/registry";
import { jitteredIntervalMs } from "../pacing";
import {
  channelCeilings,
  effectiveDailyCommentCap,
} from "../ratelimit/ledger";
import { withinActiveWindow } from "../time";
import { backlogFull, committedWorkerSupply, TOP_UP_HORIZON_MS } from "./demand";
import { anchorsInRange, commentFloorGapMs, restOfDayPlan } from "./schedule";

/**
 * Workers: the one place that answers "does this run by itself".
 *
 * There are no gates here on purpose. Every step is switchable the moment the
 * owner wants it — the product ships tools and the owner decides what to
 * automate. What this module DOES do is tell them, in numbers, when a setting
 * is outside the range most accounts settle on (see `workerAdvisories`).
 * Advice is never a block: nothing in this file refuses a save because a
 * setting looks bold.
 *
 * The structural rules that DO refuse are the ones that describe unreachable
 * states rather than risky ones — publishing with nothing of its own to
 * publish, an armed worker with every step of its OWN TYPE off. Those are DB
 * CHECKs too; these throw first so the owner gets a sentence instead of a
 * constraint violation. Nothing here refuses a VOLUME any more, because there
 * is no volume to type: how much a run does is the day plan's answer and how
 * often it wakes is derived from the same plan.
 *
 */

export class InvalidWorkerError extends AppError {
  readonly recovery: string;

  constructor(code: string, message: string, recovery: string) {
    super(code, message, 400);
    this.recovery = recovery;
  }
}

export class WorkerNotFoundError extends AppError {
  readonly recovery = "Reload the workers list and try again.";

  constructor() {
    super("worker_not_found", "That worker no longer exists.", 404);
  }
}

export type WorkerInput = {
  name: string;
  campaignId: number;
  /**
   * WHAT THIS WORKER IS, and therefore which switches mean anything on it. Only
   * the create path takes it: a scout that became an Ambassador would keep a run
   * history describing work of a kind it no longer does, so retyping is a delete
   * and a hire rather than an edit.
   */
  type?: WorkerType;
  enabled?: boolean;
  /** THE FIND — a scout's only step, and dead on an Ambassador since T-8.3, where
   *  `workerSteps` reads `find: false` for one whatever this column says. */
  sweepEnabled?: boolean;
  draftEnabled?: boolean;
};

export type WorkerWithCampaign = WorkerRow & {
  campaignName: string;
  campaignStatus: Campaign["status"];
};

/** Patch worker fields for a stop or completed run. */
export async function patchWorkerFields(
  tx: Tx,
  ids: number[],
  patch: Partial<
    Pick<
      WorkerRow,
      | "auto"
      | "sweepEnabled"
      | "draftEnabled"
      | "pausedReason"
      | "lastRunAt"
      | "nextRunAt"
      | "updatedAt"
    >
  >,
): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(workers).set(patch).where(inArray(workers.id, ids));
}

/**
 * WHAT THIS WORKER'S SWITCHES MEAN — the one place the per-type mapping lives.
 *
 * The table carries three step booleans and the two worker types spend them
 * differently: a scout finds and triages, an Ambassador writes and converses.
 * Reading `sweepEnabled` at a call site therefore answers the wrong question
 * half the time, and the run handler has three such call sites.
 *
 * SCOUT: `sweepEnabled` is the find. Triage is deliberately NOT a member here:
 * it has never had a switch of its own — it runs inside the find's block, on
 * the rows the find just wrote — so a `triage` field would be a condition that
 * cannot be false, which reads as a switch the model says does not exist. T-8.6
 * owns whether the Scout page needs two, and owns the column that would back
 * the second.
 *
 * Ambassador: `draftEnabled` is the write. Whether what it wrote publishes
 * unattended is its Comment's mode (`modeFor`), no column. Its `sweepEnabled` is dead — finding is Scout's job — but the column stays
 * true on rows the split left behind, which is exactly why this mapping returns
 * `find: false` for an Ambassador rather than reading the column. The Ambassador
 * row is the AMBASSADOR's (Phase 38), so its person-to-person work rides here
 * too: `conversationEnabled` is `converse`, projected from its strategy and
 * false on every unflagged row.
 */
export type WorkerSteps = {
  /** Sweep the account for new posts, and judge what comes back. The only step
   *  that spends exposure. */
  find: boolean;
  /** Write a comment per match. Nothing reaches LinkedIn. */
  write: boolean;
  /** Reply when they answer, Invite to connect, Message after they accept,
   *  Check outcome — sends that wait for the owner's yes. */
  converse: boolean;
};

export function workerSteps(
  worker: Pick<
    WorkerRow,
    | "type"
    | "sweepEnabled"
    | "draftEnabled"
    | "conversationEnabled"
  >,
): WorkerSteps {
  return worker.type === "scout"
    ? { find: worker.sweepEnabled, write: false, converse: false }
    : {
        find: false,
        write: worker.draftEnabled,
        converse: worker.conversationEnabled,
      };
}

/** Whether any of a worker's steps is on — what the schedule promises
 *  something of, and so what an armed row needs (the per-type CHECK). */
export function hasStepOn(steps: WorkerSteps): boolean {
  return steps.find || steps.write || steps.converse;
}

/**
 * What the SCHEDULE side is allowed to see.
 *
 * `auto` decides one thing — whether the server ALSO wakes this worker — and
 * this type is how that stops being a sentence in a docstring. Exactly two
 * functions take it: `dueWorkers` and `reArmedWake`. Run now takes a worker id
 * and a trigger, so it cannot reach `auto` even by mistake, and INV-5's "Run
 * now works regardless" becomes a property of the types rather than a promise
 * about the code.
 */
export type WorkerAutoFields = Pick<WorkerRow, "auto" | "nextRunAt">;

/** What the wake also reads of the worker it is for: whose drafts waiting for
 *  a yes bound it (`nextWakeAt`). */
export type WorkerWakeFields = WorkerAutoFields &
  Pick<WorkerRow, "campaignId">;

/** The channel a campaign spends against — INV-4's account, read where it lives. */
async function channelIdForCampaign(
  tx: Tx,
  campaignId: number,
): Promise<number | null> {
  const [row] = await tx
    .select({ channelId: campaigns.channelId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  return row?.channelId ?? null;
}

/**
 * Refuse a hire the account physically cannot carry out, IN THE CONNECTOR'S
 * OWN WORDS.
 *
 * The two layers each keep what is theirs: the connector says what it does not
 * perform (`unsupportedKindRefusal`), and this rung turns that into the shape
 * every operation refuses with — a code, a sentence, and a recovery. Composing
 * a second sentence here would give the owner two accounts of one physical
 * fact depending on which surface told them; embedding the connector's
 * `detail` gives them one.
 *
 * NOT A GATE (INV-6). It refuses only work that cannot happen — the same class
 * as publishing with nothing to publish — never work that looks bold. Both
 * shipping connectors declare both required kinds, so nothing refuses today;
 * the first real producer is a responder type against a `reply` the local
 * browser genuinely cannot perform.
 *
 * BOTH early returns are "there is no connector to ask", not "allow it".
 * `createCampaignOp` is the only writer of `campaigns.channelId` and always
 * stamps the org's bootstrap channel, so a null is a campaign minted by a test
 * or by a future path that provisions before connecting; and the composite
 * same-org FK means a channel id that resolves to no row cannot exist while
 * the campaign does. Refusing on either would be refusing on the strength of a
 * connector nobody has chosen — which is a gate, not physics.
 */
export async function assertConnectorCanRunType(
  tx: Tx,
  channelId: number | null,
  type: WorkerType,
): Promise<void> {
  if (channelId == null) return;
  const [row] = await tx
    .select({ connector: channels.connector })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!row) return;
  const missing = unsupportedWorkerCapabilities(
    type,
    CONNECTOR_DECLARATIONS[row.connector],
  );
  if (missing.length === 0) return;
  throw new InvalidWorkerError(
    "worker_type_unsupported_by_connector",
    // EVERY missing kind, for the reason `unsupportedWorkerCapabilities`
    // returns a list rather than a boolean: both types need one today, and a
    // future type needing two would otherwise be refused for the first and
    // refused again for the second the moment that one was fixed.
    `This account cannot run a ${type}: ${missing
      .map((kind) => unsupportedKindRefusal(row.connector, kind).detail)
      .join("; ")}.`,
    "Connect an account whose connector performs that work, or hire a type this one can run.",
  );
}

/**
 * The two states no worker can be in, refused per TYPE.
 *
 * ARMED AND STEPLESS is the one that needs the type to state at all. The table
 * carries three step booleans and the types spend them differently — a scout
 * finds, an Ambassador writes and publishes — so "has a step" is not a predicate
 * over the columns, it is `workerSteps` asked whether anything came back. An
 * armed Ambassador whose only switch is the find would wake, walk nothing, and
 * file the same `nothing_needed` skip on every tick while reporting itself
 * armed; the union rule this replaced called that row coherent because it could
 * not tell the two types apart. Migration 0139 says the same thing at the DB;
 * this throws first so the owner gets a sentence instead of a constraint
 * violation.
 */
function assertStructurallyCoherent(
  values: Pick<
    WorkerRow,
    "sweepEnabled" | "draftEnabled"
  > & { enabled: boolean } &
    Pick<WorkerRow, "conversationEnabled">,
  type: WorkerType,
): void {
  if (values.enabled && !hasStepOn(workerSteps({ ...values, type }))) {
    throw new InvalidWorkerError(
      "worker_auto_but_no_steps",
      type === "scout"
        ? "Auto is on but this scout finds nothing, so it would do nothing on every wake."
        : "Auto is on but this worker writes and publishes nothing, so it would do nothing on every wake.",
      type === "scout"
        ? "Turn on find, or turn Auto off — Run now works either way."
        : "Turn on write, or turn Auto off — Run now works either way.",
    );
  }
}

/**
 * How far AHEAD of the anchor the wake lands.
 *
 * A run woken here still has to triage and write before the slot it is drafting
 * for arrives, so waking exactly at the anchor guarantees the comment misses it.
 * Fifteen minutes is the same order as one whole run's wall-clock budget, and
 * deliberately not shared with it: waking early costs one extra read of the same
 * rows, so the two numbers have no reason to move together.
 *
 * It survives to the returned instant, which is the whole reason the anchor arm
 * below is not jittered — see there.
 */
const WAKE_LEAD_MS = 15 * 60_000;

/**
 * The floor under every wake.
 *
 * The cadence CHECK went with the column it guarded; the floor did not, and
 * this constant is what is left of it. Below thirty minutes a run cannot finish
 * before the next one is due and the channel lease just skips it, which is as
 * true of a derived wake as it was of a typed cadence — so the number stays and
 * is named for the wake it bounds rather than the setting it came from.
 *
 * It OUTRANKS the lead, and when it binds the anchor is missed: a plan whose
 * next anchor is twenty minutes out cannot be served by any wake the floor
 * allows, so the wake passes that slot for the next one it can still reach,
 * and the day is one comment shorter. That is the honest trade and not an
 * oversight — the alternative is a run that starts inside its own
 * predecessor's lease, finishes after the slot anyway, and misses it having
 * also collided. Waking at the floor instead would be a wake aimed at a slot
 * already gone.
 */
const MIN_WAKE_MS = 30 * 60_000;

/**
 * How far ahead the wake looks for the anchor its account's supply runs out at:
 * the horizon a run tops up, and the one after it.
 *
 * One horizon is exactly too short, because the ordinary case is a run that has
 * just filled its own — and the anchor it comes back for is the first one past
 * that horizon's edge. Supply that covers more than two is supply that is not
 * moving, which is when the recheck below is the honest answer.
 */
const WAKE_SEARCH_MS = 2 * TOP_UP_HORIZON_MS;

/**
 * When this worker should wake next: the moment its account's plan starts
 * going unsupplied, inside the account's window.
 *
 * A FACT ABOUT THE ACCOUNT (INV-4), not a number the owner typed, and the SAME
 * fact for every worker on it. The wake is the earliest anchor of the day plan
 * that the account's committed supply does not already cover and the floor
 * still leaves a lead for, less that lead — so a worker that could not fill the
 * plan comes back while there is still time to fill it, and one that did comes
 * back for the first anchor past what it filled. A scout and an Ask-me Ambassador take the same anchor: neither sends,
 * but the plan is the one thing that consumes what they make — a send spends
 * the supply an Ambassador wrote, a draft spends the matches a scout found — so
 * it is the plan's next unsupplied slot that decides when there is work again.
 * A recheck a day out was what they took before, and it left a live campaign
 * idle through the rest of its window the night it started.
 *
 * Only when the plan has no such anchor to aim at — supply that already covers
 * two horizons, or an install with no account row — is the wake a jittered
 * recheck at the horizon edge. So is the wake of a worker whose output waits
 * for a yes while its own campaign's drafts waiting are a day's cap deep: it
 * drafts nothing until the owner catches up (`computeCommentDemand`), so an
 * anchor per run would be a skipped run logged per anchor. The yes that clears
 * the backlog is noticed at the recheck, or by the owner's own Run now.
 *
 * EVERY WAKE LANDS INSIDE THE WINDOW. An anchor is inside it by construction,
 * but the lead and the recheck are not: a wake outside the window is moved to
 * its next open, which for a lead is never later than the anchor itself. A wake the window holds is not exposure — the
 * find is fenced at its call site — but it is a wake spent, and the run re-arms
 * from there, so a recheck that landed at 02:00 cost the campaign the whole of
 * the next day.
 *
 * TWO ARMS, AND ONLY ONE OF THEM IS A POLL — which is why only one is jittered.
 *
 * The recheck arm is a fixed interval in the exact sense `jitteredIntervalMs`'s
 * file header warns about: the same twenty-four hours, every time, on every
 * account. It takes the helper.
 *
 * The anchor arm is a DEADLINE, and jittering a deadline destroys it. [0.7,
 * 1.3]× a base measured in hours moves the wake by hours in BOTH directions, so
 * the lead survives only while the base is under fifty minutes and the upper
 * half of every draw lands after the slot it was woken for — the lead deleted by
 * the very step meant to protect the account. It also buys nothing: the anchor
 * is already a draw from the day plan's own per-channel seed, so this wake is
 * irregular before anything here touches it.
 *
 * NO THIRD THROTTLE comes with either. The wake's only observable is the find,
 * which is conditional on the curated deficit AND fenced by the account's window
 * at its call site, so an early wake is not extra exposure: it re-reads the same
 * rows and computes zero. That is also why two workers on one account converge
 * rather than doubling up — the second reads the supply the first just wrote.
 *
 * @param rng the recheck's jitter seam, defaulted for production and injected by
 *   tests. The anchor arm ignores it, deliberately.
 * @param worker the worker the wake is for. Omitted, the wake is the account's
 *   and no backlog holds it.
 */
export async function nextWakeAt(
  tx: Tx,
  now: number,
  rng: () => number = Math.random,
  worker?: Pick<WorkerRow, "campaignId">,
): Promise<number> {
  // The account, its plan, its caps and its window are all this one row. Its
  // absence is a broken install, and a recheck is the fail-SLOW answer — of
  // everything this file computes, the wake is the one that must never come
  // back zero.
  const channel = await channelCeilings(tx);
  if (!channel) return now + jitteredIntervalMs(TOP_UP_HORIZON_MS, rng);
  const held =
    worker?.campaignId != null &&
    (await modeFor(tx, { campaignId: worker.campaignId, capability: "publish_comment", target: "post" })).effective !== "auto" &&
    (await backlogFull(tx, channel, worker.campaignId, now));
  const anchor = held ? null : await earliestUnsuppliedAnchor(tx, channel, now);
  return intoActiveWindow(
    channel,
    anchor === null
      ? now + jitteredIntervalMs(TOP_UP_HORIZON_MS, rng)
      : anchor - WAKE_LEAD_MS,
  );
}

/**
 * The first slot of the account's plan its committed supply does not already
 * cover and a wake can still serve, or `null` when the search holds none.
 *
 * The supply is `committedWorkerSupply`, the one count both demand arms
 * subtract (INV-5): approved and sending, never a draft waiting for a yes —
 * another campaign's unreviewed drafts slept this one's Scout until the next
 * day when they counted. A worker's own backlog is not read here: it holds the
 * wake only at a day's cap (`nextWakeAt`), and below that bounds the run the
 * wake starts, through the demand it reads. The plan is walked for the anchor
 * TIMES, off the same channel row and at the same instant, and the supply is
 * read as the anchors it spends in order: the first `supply` anchors are spoken
 * for, and the one after them is not. Inside the horizon that is exactly the
 * anchor the publish-on arm's own `drafts` leaves unsupplied; past it, the walk
 * simply goes on.
 *
 * An account that writes the rest of its day ahead is walked from that day as
 * its demand counted it, the make-up included (`restOfDayPlan`), and by
 * anchors from where the day closes. A supplied day wakes for the next day's
 * first anchor, and a day a run left short wakes for its own first slot still
 * open — where an anchors-only walk would read a day of make-up as the next
 * day's anchors and sleep through both.
 *
 * An unsupplied anchor whose lead the floor has already eaten is passed for the
 * next one — see `MIN_WAKE_MS`.
 */
async function earliestUnsuppliedAnchor(
  tx: Tx,
  channel: Channel,
  now: number,
): Promise<number | null> {
  const supply = await committedWorkerSupply(tx);
  const walk = (from: number) =>
    anchorsInRange(channel, {
      from,
      to: now + WAKE_SEARCH_MS,
      effDaily: effectiveDailyCommentCap(channel, now),
      floorGapMs: commentFloorGapMs(channel),
    });
  const day = channel.writeAhead === "rest_of_day" ? await restOfDayPlan(tx, channel, now) : null;
  const anchors = day
    ? [...day.slots.filter((slot) => slot < now + WAKE_SEARCH_MS), ...walk(day.close)]
    : walk(now);
  return (
    anchors
      .slice(supply)
      .find((anchor) => anchor - WAKE_LEAD_MS >= now + MIN_WAKE_MS) ?? null
  );
}

/** `at`, or the moment the account's window next opens when `at` falls outside
 *  it — read the way the send gate reads it (`withinActiveWindow`), so a wake
 *  never lands where the gate would call the window closed. */
function intoActiveWindow(channel: Channel, at: number): number {
  const window = withinActiveWindow(at, channel.activeHours, channel.activeDays);
  return window.within ? at : window.nextOpen;
}

/**
 * WHAT THIS WORKER IS DOING RIGHT NOW, as the server sees it.
 *
 * The one contract both Run-now buttons read, and the reason it is one: a
 * button that decides "busy" from its own tab's memory disagrees with the
 * server the moment the owner reloads, and two buttons deriving it separately
 * disagree with each other. This is what the SERVER says is happening.
 *
 * Two sources, because the work has two lives and neither alone is the answer.
 * A press or a wake enqueues a job, which sits `queued` before any handler
 * touches it — invisible in `worker_runs`, which has no row until the run
 * starts. Once it starts there IS a row, and the job may already have been
 * marked done by a worker that crashed after the handler returned. So the job
 * table answers "asked for", the run row answers "under way", and `running`
 * outranks `queued` because a worker already on the account is the more
 * important fact.
 *
 * THE OPEN RUN IS BOUNDED BY THE SAME ARITHMETIC THAT REAPS IT. An open row has
 * no TTL of its own: the handler closes it on any throw, so only process death
 * leaves one behind, and the only reaper runs inside another run's preflight.
 * An unbounded read would therefore let one crashed run disable Run now
 * forever — and with Auto off, the button is the worker's only trigger, so
 * "forever" is exactly that. A run cannot legitimately outlive its lease plus
 * the wall-clock budget it stops itself at, which is the same sum
 * `reapAbandonedRuns` abandons by.
 *
 * NOT an abort. There is no stop here and none is coming in this phase: the
 * only stop-shaped controls are the kill switch and the chat turn's own stop,
 * and a Stop button beside a run would promise a retraction the run lease does
 * not offer.
 */
export type WorkerRunState = "running" | "queued" | "idle";

/**
 * Past this, an open run row is a corpse rather than a run.
 *
 * The same sum `reapAbandonedRuns` abandons by — the lease a run renews plus
 * the wall-clock budget it stops itself at — because a run cannot legitimately
 * outlive both, and the two numbers must not drift apart: one decides what the
 * button believes, the other decides what actually gets cleaned up.
 *
 * Spelled out rather than imported from the handler, which imports this module:
 * a module-level sum across that cycle would be evaluated before the other half
 * exists. `apps/dashboard/app/Ambassador/run-now.test.ts` — where the button
 * that depends on the sum lives, and where an import costs nothing — holds it
 * equal to `RUN_LEASE_MS + RUN_BUDGET_MS`.
 */
export const ABANDONED_RUN_MS = 35 * 60_000;

export async function workerRunState(
  tx: Tx,
  organizationId: string,
  workerId: number,
  now: number = Date.now(),
): Promise<WorkerRunState> {
  const [open] = await tx
    .select({ id: workerRuns.id })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, workerId),
        eq(workerRuns.status, "running"),
        sql`${workerRuns.startedAt} > ${now - ABANDONED_RUN_MS}`,
      ),
    )
    .limit(1);
  if (open) return "running";
  const [pending] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        // `jobs` is deliberately outside RLS — the worker scans it across orgs
        // to claim — so a tenant-facing read states the org itself. It is also
        // what makes this an index scan: `jobs_org_type_updated_idx` is
        // org-first, and without the predicate this is a sequential scan of
        // every job the install has ever queued, on an SSE tick.
        eq(jobs.organizationId, organizationId),
        eq(jobs.type, "worker_run"),
        inArray(jobs.status, ["queued", "running"]),
        // The payload is `jsonb`, so the id inside it is compared as text.
        sql`${jobs.payload}->>'workerId' = ${String(workerId)}`,
      ),
    )
    .limit(1);
  return pending ? "queued" : "idle";
}

/**
 * The worker a find runs AS, for this campaign.
 *
 * There is exactly one — `createCampaignOp` provisions a scout per campaign and
 * nothing else mints them — so this is a lookup rather than a choice, and the
 * `orderBy` is defence against a duplicate no path creates rather than a
 * tie-break with an opinion.
 *
 * `null` means the campaign has no scout, which is a broken install rather than a
 * state: every caller turns it into a refusal the owner can act on instead of
 * pressing a button that does nothing.
 *
 * The find's step switch is NOT consulted. Auto decides whether the server
 * wakes this worker; a press is the owner deciding, and reading `sweepEnabled`
 * here would make the button silently do nothing on a scout at rest — the exact
 * shape INV-5 forbids.
 */
export async function scoutIdFor(
  tx: Tx,
  campaignId: number,
): Promise<number | null> {
  const [row] = await tx
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.campaignId, campaignId), eq(workers.type, "scout")))
    .orderBy(asc(workers.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The campaign's Ambassador: its oldest `Ambassador` row. Nothing limited an
 * unflagged campaign's Ambassadors, so one may have several; on a campaign
 * that runs on its strategy the oldest is the Ambassador and every other
 * row keeps its history with every switch off (`strategy/project.ts`).
 */
export async function ambassadorIdFor(
  tx: Tx,
  campaignId: number,
): Promise<number | null> {
  const [row] = await tx
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.campaignId, campaignId), eq(workers.type, "ambassador")))
    .orderBy(asc(workers.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * What a worker a campaign was given is called: its owner-facing role and the
 * campaign's own name, so the run log reads as the owner's work rather than as
 * a row id, truncated because `workers.name` is their handle on it.
 *
 * `campaigns` has NO unique key on (organization_id, name) — two targets may
 * legitimately share a name, and a fresh install creates "Untitled" ones — while
 * `workers_org_name_key` does. So a taken name takes the next free ORDINAL.
 * Failing instead would make provisioning a worker able to refuse a campaign,
 * which is the tail wagging the dog.
 *
 * AN ORDINAL, AND NOT THE CAMPAIGN'S ID. A row number is a fact about storage,
 * and this string is read as a name — in the breadcrumb, in the list, and in
 * the title of every run the worker makes.
 *
 * Check-then-insert: callers serialize the path that inserts against it
 * (`createCampaignOp` under its policy lock, activation under the campaign's
 * row lock). The scan is every worker in the org rather than a prefix query:
 * an org holds a handful, and a LIKE over a name the owner typed would need its
 * own escaping to stay exact. No organization predicate: `workers` is
 * RLS-forced, so a name free here is free in this org.
 */
export async function workerNameFor(
  tx: Tx,
  role: "Scout" | "Ambassador",
  campaignName: string,
): Promise<string> {
  const preferred = `${role} · ${(campaignName.trim() || "Untitled").slice(0, 60)}`;
  const taken = new Set(
    (await tx.select({ name: workers.name }).from(workers)).map(
      (row) => row.name,
    ),
  );
  if (!taken.has(preferred)) return preferred;
  // Terminates: `taken` is finite, so some ordinal at or below its size is free.
  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${preferred} ${ordinal}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function listWorkers(tx: Tx): Promise<WorkerWithCampaign[]> {
  const rows = await tx
    .select({
      worker: workers,
      campaignName: campaigns.name,
      campaignStatus: campaigns.status,
    })
    .from(workers)
    .innerJoin(campaigns, eq(workers.campaignId, campaigns.id))
    // A deleted campaign's workers went with it, as far as any list says.
    .where(isNull(campaigns.deletedAt))
    .orderBy(workers.createdAt);
  return rows.map((row) => ({
    ...row.worker,
    campaignName: row.campaignName,
    campaignStatus: row.campaignStatus,
  }));
}

/** One worker by id — none for a deleted campaign's, which went with it as
 *  far as any surface is concerned (`operations/deleteCampaign.ts`). */
export async function getWorker(
  tx: Tx,
  id: number,
): Promise<WorkerRow | null> {
  const [row] = await tx
    .select({ worker: workers })
    .from(workers)
    .leftJoin(campaigns, eq(campaigns.id, workers.campaignId))
    .where(and(eq(workers.id, id), isNull(campaigns.deletedAt)));
  return row?.worker ?? null;
}

export async function createWorker(
  tx: Tx,
  input: WorkerInput,
  now: number = Date.now(),
): Promise<WorkerRow> {
  const name = input.name.trim();
  if (!name) {
    throw new InvalidWorkerError(
      "worker_name_required",
      "A worker needs a name — it is how you find it in the run log.",
      "Give it a short name like “Morning sweep”.",
    );
  }

  const [campaign] = await tx
    .select({ id: campaigns.id, channelId: campaigns.channelId })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), isNull(campaigns.deletedAt)));
  if (!campaign) {
    throw new InvalidWorkerError(
      "worker_campaign_not_found",
      "That campaign does not exist in this organization.",
      "Pick a campaign from the list.",
    );
  }

  const type = input.type ?? "ambassador";
  // One scout per campaign — `scoutIdFor` is a lookup, not a choice, and a
  // second row would make it silently pick the older one by id. Refuse here
  // rather than let the duplicate exist and answer for the campaign.
  if (type === "scout" && (await scoutIdFor(tx, input.campaignId)) !== null) {
    throw new InvalidWorkerError(
      "target_already_has_scout",
      "That campaign already has its Scout — every campaign gets exactly one.",
      "Point this scout at a different target, or update the existing one.",
    );
  }
  if (await runsOnStrategy(tx, [input.campaignId])) {
    // The same rule for the Ambassador, on a campaign whose strategy hires
    // it: one per campaign, which activation mints when a step needs it.
    if (type === "ambassador" && (await ambassadorIdFor(tx, input.campaignId)) !== null) {
      throw new InvalidWorkerError(
        "target_already_has_ambassador",
        "That campaign already has its Ambassador — a campaign that runs on its strategy has exactly one.",
        "Read get_campaign for what it does; its steps are the strategy's to change.",
      );
    }
    assertNotStrategyOwned({
      switches:
        input.sweepEnabled !== undefined ||
        input.draftEnabled !== undefined,
      wake: input.enabled !== undefined,
    });
  }
  await assertConnectorCanRunType(tx, campaign.channelId, type);
  const values = {
    name,
    campaignId: input.campaignId,
    enabled: input.enabled ?? false,
    // A scout's find defaults ON and an Ambassador's is dead either way, so the
    // default is the same boolean for a different reason on each type.
    sweepEnabled: input.sweepEnabled ?? true,
    draftEnabled: input.draftEnabled ?? false,
    createdAt: now,
    updatedAt: now,
  };
  // A hire never arms conversation work: that column is the projection's.
  assertStructurallyCoherent({ ...values, conversationEnabled: false }, type);

  const [created] = await tx
    .insert(workers)
    .values({
      name: values.name,
      campaignId: values.campaignId,
      sweepEnabled: values.sweepEnabled,
      draftEnabled: values.draftEnabled,
      createdAt: values.createdAt,
      updatedAt: values.updatedAt,
      channelId: campaign.channelId,
      type,
      auto: values.enabled,
      // A worker that starts armed is due immediately: the owner just
      // said yes, and making them wait for the first derived wake to see
      // anything happen reads as broken.
      nextRunAt: values.enabled ? now : null,
    })
    .returning();
  if (!created) throw new Error("worker insert returned no row");
  const worker = await getWorker(tx, created.id);
  if (!worker) throw new Error("worker missing after insert");
  return worker;
}

/**
 * Record WHEN unattended publishing was first armed on this org.
 *
 * First one wins — the `isNull` guard means a later arming never overwrites the
 * original moment. This is a record, NOT a gate (INV-6): nothing reads it to
 * refuse a create or an update, and nothing may start. Guardrails in context,
 * not a pre-connect checkbox.
 *
 * Shared by `createWorker` and `updateWorker` so the two paths cannot
 * drift — they did, and the create path was the one that stamped nothing.
 *
 * Exported unchanged, under its own name, so the first-run disclosure step
 * (T-24.2) can call the one existing writer instead of growing a second one.
 * `stampChannelWarmupStart` — the sibling `stampPublishArmed` pairs it with —
 * stays private and stays uncalled from that step: INV-1 keys the warm-up ramp
 * to the first Automatic Comment, and a first-run disclosure
 * also starting the ramp would arm the first real Ambassador at 100% of the cap
 * on its first day, the exact failure this stamp was moved here to prevent.
 */
export async function stampLinkedinRiskAcknowledged(
  tx: Tx,
  organizationId: string,
  now: number,
): Promise<void> {
  await tx
    .update(organizations)
    .set({ linkedinRiskAcknowledgedAt: now })
    .where(
      and(
        eq(organizations.id, organizationId),
        isNull(organizations.linkedinRiskAcknowledgedAt),
      ),
    );
  // A channel created after the org stamp inherits the original moment.
  const [org] = await tx.select({ acceptedAt: organizations.linkedinRiskAcknowledgedAt })
    .from(organizations).where(eq(organizations.id, organizationId));
  if (org?.acceptedAt == null) return;
  // Dual-write onto the channel row, where the acknowledgement belongs: it is
  // about THIS connected account, not the org. Same first-one-wins guard, on
  // the channel's own column — the two clocks must not diverge. The
  // `organizations` write stays until the contract release drops it.
  await tx
    .update(channels)
    .set({ riskAcknowledgedAt: org.acceptedAt, updatedAt: now })
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.network, DEFAULT_NETWORK),
        isNull(channels.riskAcknowledgedAt),
      ),
    );
}

/**
 * Read back the org's LinkedIn-risk acknowledgement moment, or `null` before
 * one exists.
 *
 * `organizations` is an identity/global table, not RLS-scoped (`getSetupState`
 * says so in the same words, operations/setup.ts) — so the select carries
 * `eq(organizations.id, organizationId)` explicitly, exactly as the stamp's
 * own `where` does.
 *
 * The single read both `complete_setup`'s read-back and
 * `get_status` call, so the two surfaces cannot report different
 * timestamps.
 */
export async function readLinkedinRiskAcknowledgedAt(
  tx: Tx,
  organizationId: string,
): Promise<number | null> {
  const [row] = await tx
    .select({ linkedinRiskAcknowledgedAt: organizations.linkedinRiskAcknowledgedAt })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.linkedinRiskAcknowledgedAt ?? null;
}

/**
 * Start the owning campaign's warm-up ramp at the moment publishing is armed.
 *
 * INV-1: warm-up is a ramp on the CAP, never a fence. The ramp exists to hold
 * unattended volume down over the first weeks of real exposure, so the only
 * honest moment to start it is the first Comment that is Automatic — the
 * first time something can reach LinkedIn without the owner in the loop. It
 * used to be keyed on campaign ACTIVATION, which arms nothing: an activated
 * campaign with publishing off ran a clock it had no exposure to ramp, and
 * every fully-manual campaign started no clock at all and therefore ran at
 * `warmupFactor` 1 — 100% of its daily cap from the first day.
 *
 * `coalesce` is the whole rule, and it is keyed on the ACCOUNT: the FIRST arm
 * on ANY worker row for ANY campaign wins. A campaign may own several workers
 * (the unique key is `(organizationId, name)`, not `(campaignId, …)`),
 * an account may own several campaigns, and a re-arm after a disarm — or a first
 * arm on a second campaign, or an arm after the first campaign was archived — must
 * never restart the ramp. That would be a fresh cap on an account that has
 * already carried the exposure, which is a fence wearing a ramp's name.
 *
 * Keyed per CAMPAIGN this was INV-4 false by accident: two campaigns on one pair
 * of hands ran two independent ramps, and archiving the one that started the
 * clock took the clock with it. The channel row is the account, so the account's
 * anchor is the one that counts.
 *
 * The coalesce is what makes it an anchor: the stamp is written once, so arming
 * a second target never restarts the account's ramp, and archiving the first
 * touches nothing here so it can never clear it.
 *
 * Reached only through `stampPublishArmed`, for the reason
 * `stampLinkedinRiskAcknowledged` is shared: the paths drifted once already.
 */
async function stampChannelWarmupStart(tx: Tx, now: number): Promise<void> {
  await tx
    .update(channels)
    .set({
      warmupStartedAt: sql`coalesce(${channels.warmupStartedAt}, ${now})`,
      updatedAt: now,
    })
    .where(eq(channels.network, DEFAULT_NETWORK));
}

/**
 * The moment unattended publishing was armed on this account — a Comment
 * that is Automatic, projected from the strategy — so the moment both the risk
 * acknowledgement and the warm-up ramp take their stamp. One function, so
 * neither can be armed without the other half.
 */
export async function stampPublishArmed(
  tx: Tx,
  organizationId: string,
  now: number,
): Promise<void> {
  await stampLinkedinRiskAcknowledged(tx, organizationId, now);
  await stampChannelWarmupStart(tx, now);
}

export async function updateWorker(
  tx: Tx,
  id: number,
  input: Partial<Omit<WorkerInput, "type">>,
  now: number = Date.now(),
): Promise<WorkerRow> {
  const [existing] = await tx
    .select()
    .from(workers)
    .where(eq(workers.id, id))
    .for("update");
  if (!existing) throw new WorkerNotFoundError();
  // A deleted campaign's worker is never armed or edited again: deleting the
  // campaign turned its wake off, and that is final.
  if (existing.campaignId !== null) {
    const [owner] = await tx
      .select({ deletedAt: campaigns.deletedAt })
      .from(campaigns)
      .where(eq(campaigns.id, existing.campaignId));
    if (owner?.deletedAt != null) throw new WorkerNotFoundError();
  }
  // On a campaign that runs on its strategy the switches and the wake are
  // projections (INV-25), and so is which campaign a worker serves: a retarget
  // into or out of one hires or dismisses a worker the strategy did not.
  // Its name stays the owner's to edit.
  const retargets =
    input.campaignId !== undefined && input.campaignId !== existing.campaignId;
  await refuseStrategyOwnedWrite(tx, [existing.campaignId, input.campaignId], {
    switches:
      retargets ||
      input.sweepEnabled !== undefined ||
      input.draftEnabled !== undefined,
    wake: input.enabled !== undefined,
  });

  const name = input.name?.trim();
  if (input.name !== undefined && !name) {
    throw new InvalidWorkerError(
      "worker_name_required",
      "A worker needs a name — it is how you find it in the run log.",
      "Give it a short name like “Morning sweep”.",
    );
  }

  const merged = {
    name: name ?? existing.name,
    campaignId: input.campaignId ?? existing.campaignId,
    // `auto` under the source column's name, because that is what the coherence
    // check and the source write both spell it.
    enabled: input.enabled ?? existing.auto,
    sweepEnabled: input.sweepEnabled ?? existing.sweepEnabled,
    draftEnabled: input.draftEnabled ?? existing.draftEnabled,
    // Never an input: only a strategy's projection writes it.
    conversationEnabled: existing.conversationEnabled,
  };
  assertStructurallyCoherent(merged, existing.type);
  // Same one-scout-per-target rule the create path enforces: a retarget that
  // lands a second scout on a campaign would make `scoutIdFor` silently pick
  // the older row.
  if (
    existing.type === "scout" &&
    merged.campaignId != null &&
    merged.campaignId !== existing.campaignId &&
    (await scoutIdFor(tx, merged.campaignId)) !== null
  ) {
    throw new InvalidWorkerError(
      "target_already_has_scout",
      "That campaign already has its Scout — every campaign gets exactly one.",
      "Point this scout at a different target, or update the existing one.",
    );
  }

  // Turning it on schedules it now; turning it off clears the wake so a
  // disabled row can never be picked up by the tick.
  const turnedOn = !existing.auto && merged.enabled;
  const turnedOff = existing.auto && !merged.enabled;
  const nextRunAt = turnedOn ? now : turnedOff ? null : existing.nextRunAt;
  const pausedReason = turnedOn ? null : existing.pausedReason;
  // The campaign moved, so the ACCOUNT may have: retargeting a worker at a
  // campaign on another channel moves which budget it spends, and a stale
  // `channelId` here would be INV-4 false.
  const channelId =
    merged.campaignId == null
      ? null
      : await channelIdForCampaign(tx, merged.campaignId);
  // Only when the ACCOUNT MOVED, and the difference is the whole of INV-6.
  // Re-checking every save refused the owner's own stop: a worker stranded by a
  // rebinding could not be turned off, published-off, or renamed, and the
  // recovery told them to connect an account — the opposite of what someone
  // trying to stop it needs. A retarget onto an account that cannot do the work
  // is still refused, because that save is a request to START something there.
  if (channelId !== existing.channelId) {
    await assertConnectorCanRunType(tx, channelId, existing.type);
  }

  const [updated] = await tx
    .update(workers)
    .set({
      name: merged.name,
      campaignId: merged.campaignId,
      channelId,
      auto: merged.enabled,
      sweepEnabled: merged.sweepEnabled,
      draftEnabled: merged.draftEnabled,
      nextRunAt,
      // The server owns this; a save by the owner is not a server pause.
      pausedReason,
      updatedAt: now,
    })
    .where(eq(workers.id, id))
    .returning();
  if (!updated) throw new WorkerNotFoundError();

  // Queued work STANDS. Turning a switch off used to also un-approve what the
  // owner had already approved by arming it — INV-11 counts arming a publish
  // step as their approval, so retracting it on a settings edit is the product
  // second-guessing a decision they made.
  //
  // The kill switch remains the one force that retracts: `applyKillSwitch` ->
  // `suspendWorkerPublishing` disarms every worker and returns unsent
  // worker-origin comments to `proposed`, sparing owner-authored rows. An
  // owner who wants the backlog stopped has a control that does exactly that
  // and is described as doing exactly that.
  return updated;
}

export async function deleteWorker(tx: Tx, id: number): Promise<void> {
  await tx.delete(workers).where(eq(workers.id, id));
}

export async function listWorkerRuns(
  tx: Tx,
  workerId: number,
  limit = 20,
): Promise<WithConversation<WorkerRun>[]> {
  const runs = await tx
    .select()
    .from(workerRuns)
    .where(eq(workerRuns.workerId, workerId))
    .orderBy(desc(workerRuns.startedAt))
    .limit(limit);
  return withConversationSums(tx, runs);
}

/** The outcome a run ended on — the filter a run register offers. */
export type WorkerRunStatus = WorkerRun["status"];

export type WorkerRunPage = {
  runs: WorkerRun[];
  /** Every run this worker has under the same filter, not just this page's —
   *  what "1 to 10 of 64" counts. */
  total: number;
};

/**
 * ONE PAGE of a worker's run history, and how many pages there are.
 *
 * `listWorkerRuns` above stays what it is — the HEAD of the history, which is
 * what the list row and `get_run` ask for — because a paged read has
 * to return a total and changing that return type is a break for every caller
 * that only wanted the newest rows. Two questions, two functions.
 *
 * A RUNNING RUN SORTS FIRST. Only one run per channel may be `running` at a
 * time (the partial unique index), so today it is also the newest and plain
 * newest-first would put it on top by accident. Sorting on it says so, which
 * is what keeps the claim true rather than incidental — and on an offset page
 * the sort is global, so it never appears twice.
 *
 * `id` breaks a `startedAt` tie. Two runs stamped the same millisecond would
 * otherwise order arbitrarily between the count and the page, and a row can
 * appear on both pages or on neither.
 */
export async function pageWorkerRuns(
  tx: Tx,
  workerId: number,
  options: {
    limit?: number;
    offset?: number;
    /** One outcome, or every outcome when absent. */
    status?: WorkerRunStatus;
  } = {},
): Promise<WorkerRunPage> {
  // Bounded here rather than at the caller, for the reason `get_run`
  // caps its own schema at 50: a page size is a promise about one query's
  // cost, and a read that trusts its caller for that has no bound at all the
  // day a second caller forgets. The register asks for ten.
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 20)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const where =
    options.status == null
      ? eq(workerRuns.workerId, workerId)
      : and(
          eq(workerRuns.workerId, workerId),
          eq(workerRuns.status, options.status),
        );

  const runs = await tx
    .select()
    .from(workerRuns)
    .where(where)
    .orderBy(
      desc(sql`${workerRuns.status} = 'running'`),
      desc(workerRuns.startedAt),
      desc(workerRuns.id),
    )
    .limit(limit)
    .offset(offset);
  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(workerRuns)
    .where(where);

  return { runs, total: counted?.total ?? 0 };
}

/** The run before and the run after this one, so a run page can step through
 *  the history without going back to the register. Same order as the page
 *  above, minus the running-first arm: stepping is chronological, and a
 *  neighbour that jumped over the runs between would not be one. */
export async function workerRunNeighbours(
  tx: Tx,
  workerId: number,
  run: Pick<WorkerRun, "id" | "startedAt">,
): Promise<{ previousId: number | null; nextId: number | null }> {
  const [older] = await tx
    .select({ id: workerRuns.id })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, workerId),
        sql`(${workerRuns.startedAt}, ${workerRuns.id}) < (${run.startedAt}, ${run.id})`,
      ),
    )
    .orderBy(desc(workerRuns.startedAt), desc(workerRuns.id))
    .limit(1);
  const [newer] = await tx
    .select({ id: workerRuns.id })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, workerId),
        sql`(${workerRuns.startedAt}, ${workerRuns.id}) > (${run.startedAt}, ${run.id})`,
      ),
    )
    .orderBy(asc(workerRuns.startedAt), asc(workerRuns.id))
    .limit(1);
  return { previousId: older?.id ?? null, nextId: newer?.id ?? null };
}

/** The most recent run per worker, for the list view. */
export async function latestRunByWorker(
  tx: Tx,
): Promise<Map<number, WorkerRun>> {
  const rows = await tx
    .select()
    .from(workerRuns)
    .where(
      sql`${workerRuns.startedAt} = (
        select max(inner_runs.started_at) from ${workerRuns} as inner_runs
        where inner_runs.worker_id = ${workerRuns.workerId}
          and inner_runs.organization_id = ${workerRuns.organizationId}
      )`,
    );
  return new Map(rows.map((row) => [row.workerId, row]));
}

/**
 * The workers the server should wake now — the first read that moved onto the
 * twin, and since T-8.12 not the only one.
 *
 * It moved for a reason the CRUD reads later inherited: this is the one query
 * `auto` exists for, and leaving it on `workers.enabled` would have meant
 * the rename described a column nothing consulted.
 *
 * Returns the id beside the two decision fields and nothing else. A caller
 * handed a whole row would be free to make a second decision from it, and this
 * query's answer is only ever "wake this one".
 *
 * SCOUTS FIRST. The tick enqueues in this order and the queue claims in
 * enqueue order, so it is the order the runs take the account in: a Scout and
 * an Ambassador due together share one wake, and the Ambassador that ran first
 * sized its drafting before the Scout beside it had matched anything.
 */
export async function dueWorkers(
  tx: Tx,
  now: number,
): Promise<Array<WorkerAutoFields & Pick<WorkerRow, "id">>> {
  return tx
    .select({
      id: workers.id,
      auto: workers.auto,
      nextRunAt: workers.nextRunAt,
    })
    .from(workers)
    .where(
      and(
        eq(workers.auto, true),
        sql`${workers.nextRunAt} is not null and ${workers.nextRunAt} <= ${now}`,
      ),
    )
    .orderBy(desc(sql`${workers.type} = 'scout'`), workers.nextRunAt, workers.id);
}

/**
 * The wake to re-arm to after a run, or null because the server does not wake
 * this worker at all.
 *
 * The `auto` branch lives HERE rather than at the call site so that the only
 * two functions reading the column are the two named on its docstring. A run
 * always advances its wake whatever its outcome — otherwise a skipped run
 * re-fires on every tick — and a manual-only worker advances to nothing, which
 * is not the same as never having run.
 */
export async function reArmedWake(
  tx: Tx,
  worker: WorkerWakeFields,
  now: number,
  rng: () => number = Math.random,
): Promise<number | null> {
  return worker.auto ? nextWakeAt(tx, now, rng, worker) : null;
}
