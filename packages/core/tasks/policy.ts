import type { Tx } from "@engager/database/tenant";
import { externalJudgmentActive } from "./judgment";
import { agentHealthy } from "./liveness";

/**
 * The two ways a piece of model-bearing work can be executed, named from the
 * judgment's point of view rather than the process's.
 *
 * `configured_background` — the org's own configured agent thinks about it,
 * later, on the worker process. `interactive_external` — the judgment is owed
 * to the CALLER, who is an agent too: the server does the I/O and hands back a
 * prepared task instead of a queue row.
 */
export type JudgmentPolicy = "configured_background" | "interactive_external";

/** What a receipt says about which of the two actually ran. */
export type ExecutionMode = "queued" | "in_session";

export function modeFor(policy: JudgmentPolicy): ExecutionMode {
  return policy === "configured_background" ? "queued" : "in_session";
}

/**
 * Which policy this call runs under.
 *
 * An explicit argument ALWAYS wins: an agent that asked for a prepared task
 * gets one whether or not a worker is alive, and one that asked for background
 * execution is not second-guessed. Next, a request already running under the
 * EXTERNAL-JUDGMENT policy is owed its thinking by the caller, whatever the
 * installation's health: that context is the caller saying "hand me the
 * task" — the broker sets it around every tool it dispatches, and
 * `runPhasesInSession` around the work it runs inline — so a tool reached
 * through either cannot resolve `configured_background` and turn the request
 * into the background inference the policy exists to keep in session. With
 * neither, the answer is the routing fact: a healthy agent process takes the
 * work, and otherwise the caller's own session does.
 *
 * "Otherwise" is never a refusal. A free install with no agent process is the
 * ordinary case this resolver exists for, not an error state: before it, every
 * tool that queued answered `queued: true` and the row sat untouched forever.
 *
 * It takes no `McpCtx` deliberately. Health is a fact about the INSTALLATION —
 * a beating worker and a resolvable agent selection — never about the request
 * context, whose `llm` is a lazy seam production never fills.
 */
export async function resolveJudgmentPolicy(
  tx: Tx,
  explicit?: JudgmentPolicy,
  now: number = Date.now(),
  selected?: () => boolean,
): Promise<JudgmentPolicy> {
  if (explicit) return explicit;
  if (externalJudgmentActive()) return "interactive_external";
  return (await agentHealthy(tx, now, selected))
    ? "configured_background"
    : "interactive_external";
}
