import type { SearchDepth } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { InvalidWorkerError } from "../operations/workers";
import type { ActionMode, BindingMode, CapabilityId, GrantId, ReadMode } from "./catalog";
import {
  STRATEGY_PATCH,
  StrategyPatchError,
  readPatchState,
  type StrategyPatch,
  type PatchOp,
} from "./patch";
import { oneMode } from "./project";
import { resolveStrategy } from "./resolve";
import {
  commentOnPostsStep,
  findLeadsStep,
  type SeedStep,
} from "./seed";
import { FindPostsRetiredError } from "./writers";

/**
 * THE OLD SWITCHES, SAID AS A PATCH. On a campaign that runs on its strategy,
 * a search depth and the kill switch's narrowing no longer write a switch:
 * each one's request becomes a `strategy.patch` over the active version, and
 * the patch classifies itself like any other — a narrowing lands, a widening
 * waits for the owner's click. A wake is not here: it is the campaign's
 * Active/Paused, which no patch carries (`writers.ts`).
 *
 * Each switch is the projection read backwards (`project.ts`):
 *
 *   the Scout's find            → Find posts      On / Off (on a campaign
 *                                 that finds leads, Find leads and its
 *                                 Research together: `project.ts` wakes the
 *                                 Scout for either)
 *   `verifyStage`               → Research        On / Off
 *   a search depth, on a        → Find leads' Company page read, On at Deep
 *   campaign that finds leads     (`setSearchDepth`)
 *   an Ambassador's draft/publish → Comment         Off / Ask me / Automatic
 *
 * written as the override on every binding of that action whose stored mode
 * differs, because the step is the narrowest scope. A strategy that no longer
 * has the step gets the seeder's own step back (`seed.ts`) — so turning a
 * switch on can add a step, its grants and its group, all of which the card
 * names and all of which widen. A switch the strategy already says writes
 * nothing.
 */

export const REDIRECT_COMPILER_VERSION = "strategy-redirect/1";

/** What an old writer asked for, in the switches it knows. Absent is untouched. */
export type SwitchRequest = {
  find?: boolean;
  research?: boolean;
  /** A search depth on a campaign that finds leads: Deep is Find leads'
   *  Company page read (`setSearchDepth`). */
  leadDepth?: SearchDepth;
  comment?: { draft?: boolean; publish?: boolean };
};

const READ: Record<"true" | "false", ReadMode> = { true: "on", false: "off" };

const COPY: Record<BindingMode, string> = { off: "Off", on: "On", review: "Ask me", auto: "Automatic" };

/**
 * The patch that says `request` in the strategy's words, against the
 * campaign's active version, or null when the strategy already says it.
 * `instruction` is the call as it was made — provenance, never parsed.
 */
export async function patchForSwitches(
  tx: Tx,
  campaignId: number,
  request: SwitchRequest,
  instruction: string,
): Promise<StrategyPatch | null> {
  const state = await readPatchState(tx, campaignId, { lock: false });
  const document = state.base;
  const actions = resolveStrategy({
    accountDefault: state.accountDefault?.document ?? null,
    campaign: document,
    network: state.network,
    connector: null,
    liveChecks: state.liveChecks,
  });
  const ops: PatchOp[] = [];
  const grants: GrantId[] = [];
  const groups = [...document.capability_groups];
  const moved: string[] = [];

  const restored = new Set<string>();

  const bound = (capability: CapabilityId) =>
    (document.action_bindings ?? []).filter((binding) => binding.capability_ref === capability);
  /** What the strategy SAYS for a send — the stored mode the owner
   *  confirmed, read the way the projection reads several bindings. Never the
   *  effective mode: a ceiling holding Automatic at Ask me is not the owner
   *  asking for Ask me, and a switch the call did not name must not become
   *  one. */
  const current = (capability: CapabilityId) =>
    oneMode(
      actions
        .filter((action) => action.capability === capability)
        .map((action) => action.requested as ActionMode),
    );

  const set = (capability: CapabilityId, mode: BindingMode, label: string, seed: () => SeedStep) => {
    const bindings = bound(capability);
    if (bindings.length === 0) {
      if (mode === "off") return;
      // Nothing seeds Find posts into a campaign that finds leads.
      if (capability === "discover_opportunities" || capability === "research") {
        throw new FindPostsRetiredError();
      }
      const seeded = seed();
      // Find posts and Research share a step: the first restored it with both.
      if (!restored.has(seeded.step.step_id)) restore(seeded, capability, mode);
      moved.push(`${label} → ${COPY[mode]}`);
      return;
    }
    const stale = bindings.filter(
      (binding) => actions.find((action) => action.action_binding_id === binding.action_binding_id)?.requested !== mode,
    );
    for (const binding of stale) {
      ops.push({ op: "add", path: `/action_bindings/${binding.action_binding_id}/mode`, value: mode });
    }
    if (stale.length > 0) moved.push(`${label} → ${COPY[mode]}`);
  };

  /** The seeder's step back, with the action asked for at `mode`. A step id
   *  the strategy still holds without that action is not guessed at. */
  const restore = (seeded: SeedStep, capability: CapabilityId, mode: BindingMode) => {
    if ((document.steps ?? []).some((step) => step.step_id === seeded.step.step_id)) {
      throw new StrategyPatchError(
        "strategy_patch_invalid",
        `This campaign's ${seeded.step.label} step no longer binds that action, so a switch cannot say where it goes.`,
        "Add the binding to the step with patch_strategy.",
        {
          issues: [
            { path: `/steps/${seeded.step.step_id}`, code: "unknown_path", message: `no binding of ${capability}` },
          ],
        },
      );
    }
    restored.add(seeded.step.step_id);
    ops.push({ op: "add", path: `/steps/${seeded.step.step_id}`, value: seeded.step });
    for (const binding of seeded.bindings) {
      ops.push({
        op: "add",
        path: `/action_bindings/${binding.action_binding_id}`,
        value: binding.capability_ref === capability ? { ...binding, mode } : binding,
      });
    }
    grants.push(...seeded.grants.filter((grant) => !document.grants.includes(grant) && !grants.includes(grant)));
    if (!groups.includes(seeded.group)) groups.push(seeded.group);
  };

  if (request.leadDepth !== undefined) {
    // On Find leads Deep is the Company page read, On there and Off at every
    // other depth. Research is the owner's own switch and no depth moves it: a
    // run reads a profile only above Quick, and only while Research is On.
    const company = request.leadDepth === "deep" ? "on" : "off";
    set("read_company", company, "Company page", () =>
      findLeadsStep({ find: current("find_leads") !== "off" ? "on" : "off", research: "on", company }),
    );
  }
  if (request.find !== undefined) {
    const mode = READ[`${request.find}`];
      // The Scout's one switch is its schedule, and both of Find leads' reads
      // wake it, so Off turns them off together. On turns Find leads on and,
      // where the schedule was off altogether, Research back on, as every depth
      // seeds it. A Research already on is left.
      const wasOff = current("find_leads") === "off" && current("research_lead") === "off";
      const research: ReadMode | null = !request.find ? "off" : wasOff ? "on" : null;
      set("find_leads", mode, "Find leads", () => findLeadsStep({ find: mode, research: research ?? "off" }));
      if (research) set("research_lead", research, "Research", () => findLeadsStep({ find: mode, research }));
  }
  if (request.research !== undefined) {
    // The legacy Research switch belongs to Find posts. Lead Research is
    // changed on the Find leads step, not through this retired writer.
    throw new FindPostsRetiredError();
  }

  if (request.comment) {
    const now = current("publish_comment");
    const draft = request.comment.draft ?? now !== "off";
    const publish = request.comment.publish ?? now === "auto";
    if (publish && !draft) {
      throw new InvalidWorkerError(
        "worker_publish_without_draft",
        "Publishing is on but writing is off, so this worker would have nothing of its own to publish.",
        "Turn on write, or turn off publish.",
      );
    }
    set("publish_comment", !draft ? "off" : publish ? "auto" : "review", "Comment", commentOnPostsStep);
  }
  if (groups.length > document.capability_groups.length) {
    ops.push({ op: "replace", path: "/capability_groups", value: groups });
  }
  if (ops.length === 0 && grants.length === 0) return null;
  return {
    kind: STRATEGY_PATCH,
    campaignId,
    expectedBaseVersion: state.active.version,
    ops,
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    ...(grants.length > 0 ? { requestedGrants: { add: grants, remove: [] } } : {}),
    provenance: {
      instruction,
      recognizedIntent: {
        summary: moved.join("; "),
        paths: [...new Set([...ops.map((op) => op.path), ...(grants.length > 0 ? ["/grants"] : [])])],
      },
      scope: { stepId: null },
      compilerVersion: REDIRECT_COMPILER_VERSION,
    },
  };
}
