import { asc, eq, inArray } from "drizzle-orm";
import {
  campaigns,
  workers,
  type Campaign,
  type WorkerRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { getSystemState } from "../ratelimit/killswitch";
import {
  createWorker,
  hasStepOn,
  stampPublishArmed,
  workerNameFor,
  workerSteps,
  type WorkerSteps,
} from "../operations/workers";
import type { ActionMode, CatalogStepId, LiveChecks, NetworkCatalog } from "./catalog";
import { holdsStep, type CampaignAgentStrategy } from "./contract";
import { resolveStrategy, type ResolvedAction } from "./resolve";

/**
 * THE PROJECTION — the one module that writes what a campaign's strategy
 * decides onto the columns the runtime already reads (INV-25):
 *
 *   Scout's Find posts or Find leads → the Scout row's `sweepEnabled` (Find
 *                               leads' Research keeps it on too)
 *   Scout's Find posts Research → `campaigns.verifyStage`
 *   Ambassador's Comment      → the Ambassador row's `draftEnabled` (Ask me
 *                               or Automatic ⇒ draft); Automatic also arms
 *                               unattended publishing, which stamps the
 *                               account's first-arm moment and keeps no column
 *   its person-to-person steps → the Ambassador row's `conversationEnabled`
 *   the campaign's status     → every row's `auto` (`projectWake`)
 *
 * — the seeder's table read backwards, so activating a seeded v1 writes
 * nothing that was not already there. Each mapping is a table below. Reply
 * and the run mode project nothing: every send reads its mode through
 * `modeFor` where it happens.
 *
 * WHAT IS PROJECTED is the documents' authority: the mode each action
 * inherits, lowered by the campaign's grants and the null
 * ceiling — the resolver run with no connector (`projectDocument`). What the
 * world says at run time stays where the runtime already enforces it: the
 * connector at the send, and the day plan's caps and window at the slot.
 *
 * Two functions, two inputs. `projectStrategy` reads nothing but the
 * strategy and the rows it writes; `projectWake` nothing but the campaign's
 * status and its worker rows, and it holds the one statement that writes
 * `workers.auto` for a campaign that runs on its strategy — called by
 * activation and by every writer of that campaign's status, in their
 * transaction.
 */

/** Comment's mode as the Ambassador row's write switch, and whether it
 *  publishes without the owner. Publishing without drafting is not a state. */
export const COMMENT_SWITCHES = {
  off: { draftEnabled: false, publishes: false },
  review: { draftEnabled: true, publishes: false },
  auto: { draftEnabled: true, publishes: true },
} as const satisfies Record<
  ActionMode,
  Pick<WorkerRow, "draftEnabled"> & { publishes: boolean }
>;

/** The Ambassador's person-to-person steps: any action one of them binds that
 *  is not Off arms `conversationEnabled`. Record outcome takes no mode — the
 *  owner confirms — so a Check outcome step that binds it is on. */
export const CONVERSATION_STEPS = [
  "meet_the_room",
  "handle_reply",
  "connect",
  "continue_in_dms",
  "check_outcome",
] as const satisfies readonly CatalogStepId[];

export type StrategyProjection = {
  /** Null when no step is the Scout's: its row keeps its history, find off. */
  scout: Pick<WorkerRow, "sweepEnabled"> | null;
  /** Null when no step is the Ambassador's: likewise, every switch off.
   *  `publishes` is no column: Comment is Automatic. */
  ambassador:
    | (Pick<WorkerRow, "draftEnabled" | "conversationEnabled"> & { publishes: boolean })
    | null;
  campaign: Pick<Campaign, "verifyStage">;
};

/**
 * What several bindings of one action say together, on a row with one switch
 * for it: drafting when any asks, publishing only when every one is Automatic
 * — so one binding's Automatic never publishes another's Ask me.
 */
export function oneMode(modes: readonly ActionMode[]): ActionMode {
  if (modes.length === 0) return "off";
  if (modes.every((mode) => mode === "auto")) return "auto";
  return modes.some((mode) => mode !== "off") ? "review" : "off";
}

/** What resolving a document as activation projects it reads. */
export type ProjectionContext = {
  accountDefault: CampaignAgentStrategy | null;
  network: NetworkCatalog;
  /** The first sends and live checks recorded on the campaign's account. */
  liveChecks?: LiveChecks;
};

/**
 * A document's actions resolved as activation projects them: its own
 * authority, the account default included, no connector, no clock. Expects a document that passed `parseStrategy` against
 * `network`. Pure.
 */
export function resolvedAsProjected(
  document: CampaignAgentStrategy,
  context: ProjectionContext,
): ResolvedAction[] {
  return resolveStrategy({
    accountDefault: context.accountDefault,
    campaign: document,
    network: context.network,
    connector: null,
    liveChecks: context.liveChecks,
  });
}

/**
 * What activating this document projects: its actions resolved as
 * {@link resolvedAsProjected} and read through the tables. Pure.
 */
export function projectDocument(
  document: CampaignAgentStrategy,
  context: ProjectionContext,
): StrategyProjection {
  return projectionOf(document, resolvedAsProjected(document, context));
}

/** The projection of one resolved strategy. Pure. */
export function projectionOf(
  document: CampaignAgentStrategy,
  actions: readonly ResolvedAction[],
): StrategyProjection {
  const steps = document.steps ?? [];
  const catalogStep = new Map(
    steps.map((step) => [step.step_id, step.catalog_step]),
  );
  // Each read by its own capability: Find leads' reads are of the same kinds as
  // Find posts' and are never Find posts' columns to switch (`verifyStage`).
  const readOn = (capability: ResolvedAction["capability"]) =>
    actions.some((action) => action.capability === capability && action.effective === "on");
  const sends = (kind: ResolvedAction["kind"]) =>
    actions
      .filter((action) => action.kind === kind)
      .map((action) => action.effective as ActionMode);
  const conversation: readonly CatalogStepId[] = CONVERSATION_STEPS;
  const hasScout = steps.some((step) => step.worker === "scout");
  const hasAmbassador = steps.some((step) => step.worker === "ambassador");
  return {
    // The Scout's one step switch is any read it is hired to make: Find posts'
    // find, or Find leads' find or Research, which the schedule wakes the same.
    scout: hasScout
      ? { sweepEnabled: readOn("discover_opportunities") || readOn("find_leads") || readOn("research_lead") }
      : null,
    ambassador: hasAmbassador
      ? {
          ...COMMENT_SWITCHES[oneMode(sends("comment"))],
          conversationEnabled: actions.some(
            (action) =>
              conversation.includes(catalogStep.get(action.step_id)!) &&
              action.effective !== "off",
          ),
        }
      : null,
    campaign: { verifyStage: hasScout && readOn("research") },
  };
}

/**
 * A projection held to what the rows already say, so that writing it can only
 * LOWER them: a switch the rows have off stays off. Where the
 * document is narrower than the rows, the rows follow it; where it is wider,
 * nothing arms that something else disarmed — a kill switch, a suspension
 * (INV-11). What re-projecting a version already in force does when no one
 * has asked for it to arm anything (`activateStrategy`'s `narrowOnly`).
 * Pure.
 */
export function narrowedTo(
  projection: StrategyProjection,
  rows: readonly Pick<
    WorkerRow,
    "type" | "sweepEnabled" | "draftEnabled" | "conversationEnabled"
  >[],
  campaign: Pick<Campaign, "verifyStage">,
): StrategyProjection {
  const scout = rows.find((row) => row.type === "scout");
  const ambassador = rows.find((row) => row.type === "ambassador");
  return {
    scout:
      projection.scout && scout
        ? { sweepEnabled: projection.scout.sweepEnabled && scout.sweepEnabled }
        : projection.scout,
    ambassador:
      projection.ambassador && ambassador
        ? {
            draftEnabled: projection.ambassador.draftEnabled && ambassador.draftEnabled,
            publishes: projection.ambassador.publishes && ambassador.draftEnabled,
            conversationEnabled:
              projection.ambassador.conversationEnabled && ambassador.conversationEnabled,
          }
        : projection.ambassador,
    campaign: { verifyStage: projection.campaign.verifyStage && campaign.verifyStage },
  };
}

/** Whether the server wakes a worker: the campaign is Active and the worker
 *  has a step on. Pure — the wake has no other input. */
export function wakeFor(
  status: Campaign["status"],
  steps: WorkerSteps,
): boolean {
  return status === "active" && hasStepOn(steps);
}

/** The switch columns a projection writes — each row only the ones its type
 *  reads (`workerSteps`); a dead column keeps whatever it holds. */
type Switches = Partial<
  Pick<WorkerRow, "sweepEnabled" | "draftEnabled" | "conversationEnabled">
>;

/**
 * Write a projection: the campaign's Research column, then each worker row's
 * switches with the wake that follows from them.
 *
 * ONE ROW PER WORKER THAT OWNS A STEP. A step whose worker has no row mints
 * one (`createWorker`, armed at nothing — the switches come next). The oldest
 * row of a type is that worker; any other row of the type keeps its run history
 * and is left with every switch off, which is how a campaign that had two
 * Ambassadors ends with one Ambassador. A worker whose last step left the
 * strategy keeps its row too, every switch off.
 *
 * `narrowOnly` writes the projection held to what the rows already say
 * (`narrowedTo`): the document's narrowing reaches them, and nothing is
 * minted, armed or woken that was not.
 */
export async function projectStrategy(
  tx: Tx,
  campaignId: number,
  wanted: StrategyProjection,
  now: number,
  options: { narrowOnly?: boolean } = {},
): Promise<void> {
  const [campaign] = await tx
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  const before = await workersOf(tx, campaignId);
  // Narrow only: it lowers what the rows have, mints no row, arms no switch
  // and wakes no worker.
  const projection = options.narrowOnly ? narrowedTo(wanted, before, campaign) : wanted;
  if (!options.narrowOnly && projection.scout && !before.some((row) => row.type === "scout")) {
    await createWorker(
      tx,
      {
        name: await workerNameFor(tx, "Scout", campaign.name),
        campaignId,
        type: "scout",
      },
      now,
    );
  }
  if (!options.narrowOnly && projection.ambassador && !before.some((row) => row.type === "ambassador")) {
    await createWorker(
      tx,
      {
        name: await workerNameFor(tx, "Ambassador", campaign.name),
        campaignId,
        type: "ambassador",
      },
      now,
    );
  }

  const rows = await workersOf(tx, campaignId);
  const scout = rows.find((row) => row.type === "scout");
  const ambassador = rows.find((row) => row.type === "ambassador");
  // The kill switch disarmed every publish step and lifting it re-arms none
  // (INV-11); a version activated in between — a scheduled one, say — must not
  // be the thing that re-arms it. Publishing stays off until a version is
  // activated with the switch clear, which is the owner's re-arm.
  const holdPublish = (await getSystemState(tx))?.killSwitch === true;
  const staged = new Map<number, Switches>();
  for (const row of rows) {
    if (row.type === "scout") {
      staged.set(row.id, {
        sweepEnabled:
          row.id === scout?.id && projection.scout
            ? projection.scout.sweepEnabled
            : false,
      });
    } else {
      staged.set(
        row.id,
        row.id === ambassador?.id && projection.ambassador
          ? {
              draftEnabled: projection.ambassador.draftEnabled,
              conversationEnabled: projection.ambassador.conversationEnabled,
            }
          : { draftEnabled: false, conversationEnabled: false },
      );
    }
  }
  // A Comment that is Automatic is the moment unattended publishing is armed,
  // whoever arms it; first one wins, so the stamp is the same on every later
  // version that says so.
  if (!options.narrowOnly && projection.ambassador?.publishes && !holdPublish) {
    await stampPublishArmed(tx, campaign.organizationId, now);
  }

  await projectCampaign(tx, campaign, projection, now);
  await projectWake(tx, campaignId, now, staged, { arm: !options.narrowOnly });
}

/**
 * The campaign's own projected column: Research, and the search depth it
 * gives way to.
 */
async function projectCampaign(
  tx: Tx,
  campaign: Campaign,
  projection: StrategyProjection,
  now: number,
): Promise<void> {
  // Research on is the search depth Deep, which a stored Quick gives way to:
  // turned off again, it reads Standard (strategy/searchDepth.ts).
  const quickGivesWay = projection.campaign.verifyStage && campaign.searchDepth === "quick";
  if (campaign.verifyStage === projection.campaign.verifyStage && !quickGivesWay) return;
  await tx
    .update(campaigns)
    .set({
      verifyStage: projection.campaign.verifyStage,
      ...(quickGivesWay ? { searchDepth: "standard" as const } : {}),
      updatedAt: now,
    })
    .where(eq(campaigns.id, campaign.id));
}

/**
 * Every worker's wake, from the campaign's status and the worker's steps — the
 * one writer of `workers.auto` on a campaign that runs on its strategy.
 *
 * `staged` carries the switches activation is writing in the same statement,
 * because the per-type CHECK reads both: a row losing its last step must lose
 * its wake in the write that removes the step. A status change passes none.
 *
 * The wake moves exactly as turning Auto on and off always has: on, due now
 * and any server pause cleared; off, no wake at all. The source table follows
 * the twin, as every writer of the pair does; it has no shape for conversation
 * work, as it has none for a scout, so its `enabled` says only what it can.
 */
export async function projectWake(
  tx: Tx,
  campaignId: number,
  now: number,
  staged: ReadonlyMap<number, Switches> = new Map(),
  /** `arm: false` only ever disarms: a worker the server does not wake stays
   *  unwoken whatever its steps and the campaign's status say. */
  { arm = true }: { arm?: boolean } = {},
): Promise<void> {
  const [campaign] = await tx
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);
  const rows = await workersOf(tx, campaignId);
  if (rows.length === 0) return;
  await tx
    .select({ id: workers.id })
    .from(workers)
    .where(inArray(workers.id, rows.map((row) => row.id)))
    .for("update");

  for (const row of rows) {
    const switches = staged.get(row.id) ?? {};
    const next = { ...row, ...switches };
    const auto = (arm || row.auto) && wakeFor(campaign.status, workerSteps(next));
    const turnedOn = !row.auto && auto;
    const turnedOff = row.auto && !auto;
    const moved = Object.entries(switches).some(
      ([column, value]) => row[column as keyof Switches] !== value,
    );
    if (!moved && !turnedOn && !turnedOff) continue;
    const nextRunAt = turnedOn ? now : turnedOff ? null : row.nextRunAt;
    const pausedReason = turnedOn ? null : row.pausedReason;
    await tx
      .update(workers)
      .set({ ...switches, auto, nextRunAt, pausedReason, updatedAt: now })
      .where(eq(workers.id, row.id));

  }
}

async function workersOf(tx: Tx, campaignId: number): Promise<WorkerRow[]> {
  return tx
    .select()
    .from(workers)
    .where(eq(workers.campaignId, campaignId))
    .orderBy(asc(workers.id));
}
