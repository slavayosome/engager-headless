import type { CodexSelfTestCheck } from "./types";

/**
 * The owner's sentence for a refusal the agent connection check can end with
 * (US-ONE-06) — one table, so the Settings picker and the Set up window never
 * word one differently. Every sentence is plain words: no vendor string, no
 * path, no address, and no button that gets round the isolation gate (R-10) —
 * the only things on offer are "try again" and "another agent".
 *
 * Pure and import-free on purpose: the dashboard's client picker bundles it
 * beside the core's own refusal codes (`state.ts`, `picker.ts`).
 */

/** The names setup uses for the two agents it can run, keyed by adapter id. */
const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
/** What an owner calls the account behind each one's usage limit. */
const LIMIT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };
const OTHER_AGENT: Record<string, string> = { claude: "codex", codex: "claude" };

/** A table's own entry, never one inherited from `Object.prototype`. */
function own(table: Record<string, string>, key: string | undefined): string | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

export type AgentReasonContext = {
  /** The adapter id of the agent that was tested (`claude`, `codex`). */
  adapterId?: string | undefined;
  /** When the usage limit lifts, epoch ms, as the adapter parsed it. */
  resetsAt?: number | undefined;
  /** Test seams for the clock the reset time is read against. */
  now?: number | undefined;
  timeZone?: string | undefined;
};

const COPY: Record<string, string> = {
  authentication_required:
    "That agent is not signed in. Sign in with its own CLI, then try again.",
  agent_timeout: "The connection check did not finish in time. Try again.",
  agent_smoke_invalid:
    "The agent answered the connection check in a way Engager could not use. Try again, or choose another agent.",
  agent_smoke_unconfirmed:
    "The agent answered, but not in the form Engager asked for. Retry, or choose another agent.",
  agent_version_unsupported:
    "That version is not one Engager has been tested against. Update the agent, then try again.",
  isolation_unverified:
    "Engager will not run that agent: its execution checks are not satisfied on this Mac. Update it, or choose another agent.",
  agent_catalog_unavailable:
    "Engager could not read the models this agent offers. Retry, or choose another agent.",
  agent_model_unavailable:
    "None of the models this agent offers can be used by Engager. Update the agent, or choose another.",
};

/** The codes this table has a sentence of its own for, apart from the usage
 *  limit and the Codex sandbox family, which read their context. */
export const AGENT_REASON_CODES: readonly string[] = [
  ...Object.keys(COPY),
  "quota_exhausted",
];

/** What Codex's sandbox self-test (`codexSelfTest.ts`) saw, by the check that
 *  failed. Each names what the sandbox let through, because "execution checks
 *  are not satisfied" gives an owner nothing to act on. */
const CODEX_SANDBOX_FAILURES: Record<CodexSelfTestCheck, string> = {
  control: "could not run even a permitted read",
  read_outside: "did not block reading a file outside its folder",
  symlink_out: "did not block a link pointing outside its folder",
  traversal: "did not block a ../ path out of its folder",
  write_workspace: "did not block writing inside its read-only folder",
  write_outside: "did not block writing outside its folder",
  network: "did not block network access",
  network_control:
    "could not reach a local test server even when allowed, so its network check proves nothing",
  judgment_profile: "let Engager's own profile read, write or connect",
  features: "kept a feature on that Engager turns off",
};

/** The sentence for Codex's sandbox refusals — `undefined` for any other
 *  code, so a caller can fall through to the rest of the table. */
export function codexSandboxCopy(code: string): string | undefined {
  if (code === "isolation_unverified:codex_sandbox_unproven")
    return "Engager has not checked Codex's sandbox on this Mac yet. Rescan to run the check.";
  const check = code.match(/^isolation_unverified:codex_sandbox:(\w+)$/)?.[1];
  const failure = own(CODEX_SANDBOX_FAILURES, check);
  return failure
    ? `Engager will not run this Codex: its sandbox ${failure} on this Mac. Update Codex, or choose another agent.`
    : undefined;
}

/** `3:15 PM` today, `Oct 29, 3:15 PM` another day, in the Mac's own zone. */
export function formatResetTime(
  resetsAt: number,
  clock: { now?: number | undefined; timeZone?: string | undefined } = {},
): string {
  const zone = clock.timeZone ? { timeZone: clock.timeZone } : {};
  const day = (instant: number) =>
    new Intl.DateTimeFormat("en-US", { ...zone, year: "numeric", month: "numeric", day: "numeric" }).format(
      new Date(instant),
    );
  const sameDay = day(resetsAt) === day(clock.now ?? Date.now());
  return new Intl.DateTimeFormat("en-US", {
    ...zone,
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(resetsAt))
    // Newer ICU puts a narrow no-break space before AM/PM.
    .replace(/[  ]/g, " ");
}

/**
 * The usage limit's sentence. With the agent known it names the account and
 * the other agent ("Your Claude usage limit is reached. It resets at 3:15 PM.
 * Retry then, or use Codex now."); with no agent it is the general one.
 */
function usageLimitCopy(context: AgentReasonContext): string {
  const limitName = own(LIMIT_NAMES, context.adapterId);
  if (!limitName) {
    return "That account has reached its usage limit. Try again later, or choose another agent.";
  }
  const other = own(AGENT_NAMES, own(OTHER_AGENT, context.adapterId));
  const alternative = other ? `, or use ${other} now` : "";
  return context.resetsAt === undefined
    ? `Your ${limitName} usage limit is reached. Try again later${alternative}.`
    : `Your ${limitName} usage limit is reached. It resets at ${formatResetTime(context.resetsAt, context)}. Retry then${alternative}.`;
}

/** A code printed into the fallback sentence is one core already vetted
 *  (`safeFailureCode`); this keeps the table honest if a caller skips that. */
const SAFE_CODE = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_.:-]+)?$/;

/**
 * The sentence for one refusal code, or `undefined` when this table has none
 * of its own — the dashboard's Settings-only codes (a stale model list, a
 * concurrent save) stay beside the form they belong to.
 */
export function sharedAgentReasonCopy(
  code: string,
  context: AgentReasonContext = {},
): string | undefined {
  if (code === "quota_exhausted") return usageLimitCopy(context);
  return codexSandboxCopy(code) ?? own(COPY, code) ?? own(COPY, code.split(":")[0]);
}

/** The sentence for any code: the shared one, else the general line. */
export function agentReasonCopy(code: string, context: AgentReasonContext = {}): string {
  return (
    sharedAgentReasonCopy(code, context) ??
    `Engager could not connect that agent (${SAFE_CODE.test(code) && code.length <= 96 ? code : "unknown"}). Retry, or choose another agent.`
  );
}
