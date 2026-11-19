// What an install remembers about itself between runs, beside its install id
// (so a hosted tenant's lives on the same volume): when it was first seen, the
// last version that ran, and whether the owner has been told about usage data.
// Three facts, none of them identifying. Never throws: an unwritable directory
// is the same case as a missing file, and the callers treat it as "unknown".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { installIdPath } from "./installId";

export type TelemetryState = {
  /** ISO time of the first run that saw this install. */
  firstSeenAt: string;
  /** The version that last ran, for `app_updated`. */
  lastVersion: string;
  /** True from the first run after an update that introduced usage data, until
   * the owner dismisses the notice. Never set on a fresh install: its owner
   * agreed to the Terms on the way in. */
  noticeDue: boolean;
  /** Firsts this install has already had, so a "first" is claimed once. */
  milestones: string[];
};

export function telemetryStatePath(): string {
  return path.join(path.dirname(installIdPath()), "telemetry.json");
}

export function readTelemetryState(filePath: string = telemetryStatePath()): TelemetryState | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<TelemetryState>;
    if (
      typeof raw.firstSeenAt === "string" &&
      Number.isFinite(Date.parse(raw.firstSeenAt)) &&
      typeof raw.lastVersion === "string" &&
      typeof raw.noticeDue === "boolean"
    ) {
      return {
        firstSeenAt: raw.firstSeenAt,
        lastVersion: raw.lastVersion,
        noticeDue: raw.noticeDue,
        milestones: Array.isArray(raw.milestones)
          ? raw.milestones.filter((milestone): milestone is string => typeof milestone === "string")
          : [],
      };
    }
  } catch {
    // Missing or unreadable: the same as never written.
  }
  return null;
}

export function writeTelemetryState(
  state: TelemetryState,
  filePath: string = telemetryStatePath(),
): boolean {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(state)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim a first (`first_match`, `first_send`) for this install: true exactly
 * once, with the seconds since the install was first seen; false afterwards,
 * and false when the state cannot be read or written, because a first claimed
 * twice is worse than one missed. An install that predates usage data starts
 * with every first already claimed (`bootTelemetry`), so it never reports one.
 */
export function claimMilestone(
  name: string,
  now: number = Date.now(),
  filePath: string = telemetryStatePath(),
): { secondsSinceInstall: number } | null {
  const state = readTelemetryState(filePath);
  if (!state || state.milestones.includes(name)) return null;
  if (!writeTelemetryState({ ...state, milestones: [...state.milestones, name] }, filePath)) return null;
  return { secondsSinceInstall: Math.max(0, Math.round((now - Date.parse(state.firstSeenAt)) / 1000)) };
}

/** The plan a process that may read billing last saw, and when. */
export type PlanHint = {
  plan: "free" | "paid";
  /** Epoch milliseconds of the read. */
  at: number;
};

/** Past this, a hint no longer says what plan the install is on now. The
 * stamping processes refresh it hourly, so only a day with none of them
 * running ages it out. */
export const PLAN_HINT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Beside `telemetry.json`, not inside it: the hint is rewritten hourly by
 * every stamping process, and `claimMilestone` rewrites the whole state file,
 * so a shared file could lose a claimed first to a hint written between its
 * read and its write. */
export function planHintPath(): string {
  return path.join(path.dirname(installIdPath()), "telemetry-plan.json");
}

/**
 * Leave the plan for processes that carry no billing code, so the agent and the dashboard, which
 * do, write what they read here and those processes report it while it is
 * fresh. This module imports no billing either.
 */
export function writePlanHint(
  plan: PlanHint["plan"],
  now: number = Date.now(),
  filePath: string = planHintPath(),
): boolean {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify({ plan, at: now } satisfies PlanHint)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The stamped plan, or null when there is none worth reporting: never
 * stamped, unreadable, older than a day, or dated in the future. */
export function readPlanHint(
  now: number = Date.now(),
  filePath: string = planHintPath(),
): PlanHint | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<PlanHint>;
    if ((raw.plan !== "free" && raw.plan !== "paid") || typeof raw.at !== "number") return null;
    const age = now - raw.at;
    return Number.isFinite(age) && age >= 0 && age <= PLAN_HINT_MAX_AGE_MS
      ? { plan: raw.plan, at: raw.at }
      : null;
  } catch {
    return null;
  }
}

/** Whole days since the install was first seen; 0 when that is not known. */
export function installAgeDays(now: number = Date.now(), filePath?: string): number {
  const state = readTelemetryState(filePath);
  if (!state) return 0;
  return Math.max(0, Math.floor((now - Date.parse(state.firstSeenAt)) / 86_400_000));
}
