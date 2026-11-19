import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { processExists } from "../ai/agentCli/state";

/**
 * KEEP THIS MAC AWAKE — the owner's choice, and what the agent is actually
 * doing about it: two small files in the install's Engager home, each with one
 * writer, like the browser window's (`windowChoice.ts`).
 *
 * The choice is the dashboard's to write and the agent's to read; the state is
 * the agent's to write (`keepAwakeHolder.ts`) and every page's to read, so the
 * sidebar and Settings say whether the Mac is held rather than inferring it
 * from the choice. A file rather than a row, because sleep is about THIS MAC:
 * an organization row would carry one machine's answer to every machine.
 *
 * Off unless chosen. Held only while something would run (`holdsAwake`), and
 * only by the agent process — a dashboard on its own holds nothing.
 */
export const KEEP_AWAKE_FILE = "keep-awake.json";
export const KEEP_AWAKE_STATE_FILE = "keep-awake-state.json";

export type KeepAwakeChoice = { on: boolean; pluggedInOnly: boolean };

/** What the agent last wrote: whether it holds the Mac, since when, which
 *  process it is, and when it last said so — rewritten on every check, so a
 *  state older than `KEEP_AWAKE_STALE_MS` describes nothing. */
export type KeepAwakeState = { pid: number; held: boolean; since: number | null; updatedAt: number };

/** Four of the agent's half-minute checks: a state not rewritten in that long
 *  is an agent that is gone or stuck, whatever process now has its pid. */
export const KEEP_AWAKE_STALE_MS = 120_000;

const OFF: KeepAwakeChoice = { on: false, pluggedInOnly: false };

export function keepAwakeHome(): string {
  return process.env.ENGAGER_HOME || join(homedir(), ".engager");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Saved whole, never half: a reader mid-write sees the old file or the new. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** The owner's choice; an absent or unreadable file is Off. */
export function readKeepAwakeChoice(home: string = keepAwakeHome()): KeepAwakeChoice {
  const saved = readJson(join(home, KEEP_AWAKE_FILE));
  if (!saved) return OFF;
  return { on: saved.on === true, pluggedInOnly: saved.pluggedInOnly === true };
}

export function writeKeepAwakeChoice(choice: KeepAwakeChoice, home: string = keepAwakeHome()): void {
  writeJson(join(home, KEEP_AWAKE_FILE), choice);
}

export function writeKeepAwakeState(state: KeepAwakeState, home: string = keepAwakeHome()): void {
  writeJson(join(home, KEEP_AWAKE_STATE_FILE), state);
}

/**
 * Whether this Mac is held awake NOW, and since when: the agent says it holds
 * it, said so within the last two minutes, is still running, and the choice
 * is still on. The last is read here rather than waited for, so a switch
 * turned off reads as off at once, before the agent has let go. A state left
 * by an agent that is gone reads as not held — its `caffeinate` went with it
 * (`-w`) — and its age says so even when its pid now names another process.
 */
export function readKeepAwakeHeld(
  home: string = keepAwakeHome(),
  alive: (pid: number) => boolean = processExists,
  now: number = Date.now(),
): { held: boolean; since: number | null } {
  const state = readJson(join(home, KEEP_AWAKE_STATE_FILE));
  const held =
    state !== null &&
    state.held === true &&
    typeof state.updatedAt === "number" &&
    now - state.updatedAt <= KEEP_AWAKE_STALE_MS &&
    typeof state.pid === "number" &&
    alive(state.pid) &&
    readKeepAwakeChoice(home).on;
  return { held, since: held && typeof state?.since === "number" ? state.since : null };
}

/**
 * THE DECISION, on its own: hold the Mac while the owner chose to, the
 * scheduler would wake something — the plan allows background work, this
 * install holds the account, and a switched-on worker of a campaign Active
 * with no stop over it (`campaignRunsIn`) — and, when they asked for it, the
 * Mac is on power. Not limited to the working hours: a run due at
 * the window's opening needs the Mac awake before it.
 */
export function holdsAwake(input: {
  choice: KeepAwakeChoice;
  campaignRuns: boolean;
  onPower: boolean;
}): boolean {
  return input.choice.on && input.campaignRuns && (!input.choice.pluggedInOnly || input.onPower);
}
