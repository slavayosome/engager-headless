import { execFile, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, watch } from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { backgroundEntitlement } from "../entitlements/entitlement";
import { db as baseDb } from "@engager/database";
import { campaigns, organizations, workers } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { campaignStops } from "../actions/pause";
import { runtimeInstanceId } from "../execution/authority";
import { supervisionArmsWork } from "../jobs/scheduler";
import { dueWorkers } from "../operations/workers";
import { getSystemState } from "../ratelimit/killswitch";
import { heldByAnother, readSupervision } from "./record";
import {
  holdsAwake,
  KEEP_AWAKE_FILE,
  keepAwakeHome,
  readKeepAwakeChoice,
  writeKeepAwakeState,
} from "./keepAwake";

type BaseDb = typeof baseDb;

/**
 * THE AGENT'S HOLD ON THIS MAC: one `caffeinate` child, kept while
 * `holdsAwake` says so and let go the moment it does not.
 *
 * `-i` holds off idle sleep and nothing else: the display still dims and
 * locks, and a closed lid still sleeps the Mac unless it has power and a
 * display. `-w` ties the child to this process, so an agent that crashes or
 * is killed never leaves the Mac held. "Only when plugged in" is a power read
 * (`pmset -g ps`) on every check rather than caffeinate's own `-s`, so the
 * state written beside the choice says what is true on battery too.
 *
 * Checked every half minute and whenever the choice file changes, and the
 * state written on every check, so a reader tells this agent's word from an
 * old one by its age. Anywhere without `/usr/bin/caffeinate` it holds nothing
 * and says so; a check that fails leaves the hold as it was and never reaches
 * the scheduler. A child that ends within a minute of starting is not started
 * again for that minute, so a broken binary does not flap the hold.
 */
export const CAFFEINATE = "/usr/bin/caffeinate";
const PMSET = "/usr/bin/pmset";
export const KEEP_AWAKE_CHECK_MS = 30_000;
export const KEEP_AWAKE_RESPAWN_MS = 60_000;

/** What the Mac is held with, for the agent whose pid it is. Never `-d`. */
export function caffeinateArgs(pid: number): string[] {
  return ["-i", "-w", String(pid)];
}

/** Whether this Mac draws from AC power now; a read that fails is battery,
 *  so "only when plugged in" never holds on a guess. */
export function readOnPower(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(PMSET, ["-g", "ps"], { timeout: 5_000 }, (error, stdout) => {
      resolve(!error && stdout.includes("'AC Power'"));
    });
  });
}

/**
 * Whether the scheduler would wake anything in this org: first the tick's own
 * gates — supervision that arms work (`supervisionArmsWork`), read here rather
 * than renewed, then the plan (`backgroundEntitlement`) — then the account not
 * stopped — the owner's stop and its fences, the account's risk pause — and
 * one campaign Active with no Stop over it, Pause LinkedIn included, whose
 * worker the tick wakes at some point (`dueWorkers`: Auto on, a next run set).
 * The same rungs a worker run checks first (`preflightReason`).
 */
export async function campaignRunsIn(tx: Tx, organizationId: string, now: number): Promise<boolean> {
  const record = await readSupervision(tx, organizationId);
  const status = heldByAnother(record, runtimeInstanceId(), now) ? "held_elsewhere" : "claimed";
  if (!supervisionArmsWork({ status, record })) return false;
  if (!(await backgroundEntitlement(tx, organizationId, { now })).allowed) return false;
  const system = await getSystemState(tx);
  if (system?.killSwitch === true) return false;
  if (system?.pausedUntil != null && system.pausedUntil > now) return false;
  // Due by the end of time: every worker the tick will wake, whenever.
  const armed = await dueWorkers(tx, Number.MAX_SAFE_INTEGER);
  if (armed.length === 0) return false;
  const active = await tx
    .selectDistinct({ id: campaigns.id, channelId: campaigns.channelId })
    .from(campaigns)
    .innerJoin(workers, eq(workers.campaignId, campaigns.id))
    .where(
      and(
        eq(campaigns.status, "active"),
        isNull(campaigns.deletedAt),
        inArray(
          workers.id,
          armed.map((worker) => worker.id),
        ),
      ),
    );
  for (const campaign of active) {
    if ((await campaignStops(tx, campaign)).length === 0) return true;
  }
  return false;
}

/** Across every org on this install, like the scheduler's tick. */
export async function anyCampaignRuns(now: number, db: BaseDb = baseDb): Promise<boolean> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const org of orgs) {
    if (await withOrg(org.id, (tx) => campaignRunsIn(tx, org.id, now))) return true;
  }
  return false;
}

type Holder = { kill(): boolean; once(event: "exit" | "error", listener: () => void): unknown };

export type KeepAwakeDeps = {
  home: string;
  /** Whether this machine has caffeinate at all. */
  supported: boolean;
  spawn: (command: string, args: string[]) => Holder;
  campaignRuns: (now: number) => Promise<boolean>;
  onPower: () => Promise<boolean>;
  now: () => number;
  everyMs: number;
};

export type KeepAwake = { check(): Promise<void>; stop(): void };

export function startKeepAwake(overrides: Partial<KeepAwakeDeps> = {}): KeepAwake {
  const deps: KeepAwakeDeps = {
    home: keepAwakeHome(),
    supported: process.platform === "darwin" && existsSync(CAFFEINATE),
    spawn: (command, args) => spawnChild(command, args, { stdio: "ignore" }),
    campaignRuns: (now) => anyCampaignRuns(now),
    onPower: readOnPower,
    now: Date.now,
    everyMs: KEEP_AWAKE_CHECK_MS,
    ...overrides,
  };
  let holder: Holder | null = null;
  let since: number | null = null;
  /** When the last child that ended early was started. */
  let failedStartAt: number | null = null;
  let checking = false;
  let again = false;
  let stopped = false;

  const record = () => {
    try {
      writeKeepAwakeState({ pid: process.pid, held: holder !== null, since, updatedAt: deps.now() }, deps.home);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[keep-awake] could not write its state:", error instanceof Error ? error.message : String(error));
    }
  };
  const hold = () => {
    const startedAt = deps.now();
    const child = deps.spawn(CAFFEINATE, caffeinateArgs(process.pid));
    // A child that ends on its own — or never started — holds nothing; a
    // later check starts another if one is still wanted, after the back-off
    // when it ended soon after starting.
    const ended = () => {
      if (holder !== child) return;
      if (deps.now() - startedAt < KEEP_AWAKE_RESPAWN_MS) failedStartAt = startedAt;
      holder = null;
      since = null;
      record();
    };
    child.once("error", ended);
    child.once("exit", ended);
    holder = child;
    since = startedAt;
  };
  const backingOff = (now: number) => failedStartAt !== null && now - failedStartAt < KEEP_AWAKE_RESPAWN_MS;
  const release = () => {
    const child = holder;
    holder = null;
    since = null;
    child?.kill();
  };

  const check = async (): Promise<void> => {
    // One check at a time; a change that lands mid-check is read once more.
    if (stopped) return;
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    try {
      do {
        again = false;
        const choice = readKeepAwakeChoice(deps.home);
        let wanted = false;
        if (deps.supported && choice.on) {
          // Power before the database: the cheap read, and on battery the only one.
          const onPower = choice.pluggedInOnly ? await deps.onPower() : true;
          const campaignRuns = onPower && (await deps.campaignRuns(deps.now()));
          wanted = holdsAwake({ choice, campaignRuns, onPower });
        }
        if (stopped) break;
        if (wanted && holder === null && !backingOff(deps.now())) hold();
        else if (!wanted && holder !== null) release();
        record();
      } while (again);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[keep-awake] check failed; the hold stays as it was:", error instanceof Error ? error.message : String(error));
    } finally {
      checking = false;
    }
  };

  record();
  const timer = setInterval(() => void check(), deps.everyMs);
  timer.unref();
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    mkdirSync(deps.home, { recursive: true });
    watcher = watch(deps.home, (_event, name) => {
      if (name === KEEP_AWAKE_FILE) void check();
    });
    watcher.on("error", () => {});
  } catch {
    // No watch: the half-minute check still takes the change.
  }
  void check();

  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
      release();
      record();
    },
  };
}
