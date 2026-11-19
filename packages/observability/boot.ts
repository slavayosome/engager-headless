/**
 * What an install does once per process start, before any event: remember it
 * exists, notice a new version, and decide whether its owner needs telling
 * that usage data is shared (INV-19).
 *
 * A fresh install's owner agreed to the Terms on the way in, so there is
 * nothing to tell them. An install that had already finished setup when this
 * shipped never saw those Terms say so, and gets one dismissible notice. The
 * caller (packages/core/telemetry/start.ts) knows which it is; this module only
 * keeps the three facts on disk (telemetryState.ts).
 */
import { productVersion } from "@engager/common/version";
import { telemetryEnabled, track } from "./analytics";
import { installationPlacement } from "./context";
import { SEND_KINDS, type SetupStage } from "./events";
import {
  claimMilestone,
  readTelemetryState,
  writeTelemetryState,
  type TelemetryState,
} from "./telemetryState";

/** The firsts the activation funnel claims once (US-TEL-04): the first match,
 * the first confirmed send, and the first confirmed send of each kind. */
const FIRSTS = [
  "first_match",
  "first_send",
  ...SEND_KINDS.map((kind) => `kind_${kind}`),
] as const;

/** Left by `markSetupStage` on the state it creates: Set up Engager saw this
 * install before its agent ever started, so that first start is still owed
 * its `install_started`. */
const SEEN_BY_SETUP = "seen_by_setup";

export type BootFacts = {
  /** The first run of an install that had not used Engager before. */
  fresh: boolean;
  /** The version that ran before this one, when this is its first start. */
  updatedFrom: string | null;
};

export function bootTelemetry(input: {
  hadPriorUse: boolean;
  version?: string;
  now?: number;
}): BootFacts | null {
  try {
    if (!telemetryEnabled()) return null;
    const version = input.version ?? productVersion();
    const state = readTelemetryState();
    if (!state) {
      const fresh = !input.hadPriorUse;
      const created: TelemetryState = {
        firstSeenAt: new Date(input.now ?? Date.now()).toISOString(),
        lastVersion: version,
        noticeDue: !fresh,
        // An install that was already in use has had its firsts.
        milestones: fresh ? [] : [...FIRSTS],
      };
      // Not written means not remembered: say nothing rather than say it every start.
      if (!writeTelemetryState(created)) return null;
      if (fresh) track("install_started", { placement: installationPlacement() });
      return { fresh, updatedFrom: null };
    }
    if (state.milestones.includes(SEEN_BY_SETUP) && claimMilestone("install_started", input.now)) {
      track("install_started", { placement: installationPlacement() });
      return { fresh: true, updatedFrom: null };
    }
    if (state.lastVersion === version) return { fresh: false, updatedFrom: null };
    if (!writeTelemetryState({ ...state, lastVersion: version })) return null;
    track("app_updated", { from_version: state.lastVersion, to_version: version });
    return { fresh: false, updatedFrom: state.lastVersion };
  } catch {
    return null;
  }
}

/**
 * A stage of Set up Engager on a Mac, reported once each (`SETUP_STAGES`).
 * `opened` is where a new install is first seen, so it writes the state the
 * agent's first start would have, and only for a Mac that has never been set
 * up; a later stage counts only for an install whose `opened` did. Never throws.
 */
export function markSetupStage(
  stage: SetupStage,
  input: { hadPriorUse: boolean; version?: string; now?: number },
): void {
  try {
    if (!telemetryEnabled()) return;
    const now = input.now ?? Date.now();
    const state = readTelemetryState();
    if (stage === "opened") {
      if (state || input.hadPriorUse) return;
      const created: TelemetryState = {
        firstSeenAt: new Date(now).toISOString(),
        lastVersion: input.version ?? productVersion(),
        noticeDue: false,
        milestones: [SEEN_BY_SETUP],
      };
      if (!writeTelemetryState(created)) return;
    } else if (!state?.milestones.includes(SEEN_BY_SETUP)) {
      return;
    }
    if (claimMilestone(`setup_${stage}`, now)) track("setup_stage_reached", { stage });
  } catch {
    // Setup goes on unreported.
  }
}

/** The owner closed the usage-data notice. It never comes back. */
export function dismissUsageNotice(): void {
  const state = readTelemetryState();
  if (state?.noticeDue) writeTelemetryState({ ...state, noticeDue: false });
}

/** Whether to show the notice now: usage data is on and this install was told
 * nothing about it. Reads one small file; never throws. */
export function usageNoticeDue(): boolean {
  try {
    return telemetryEnabled() && readTelemetryState()?.noticeDue === true;
  } catch {
    return false;
  }
}
