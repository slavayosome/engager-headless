import type { ReportCredential } from "@engager/common/problem-report";

/**
 * What a problem report reads from the licence gate, which core cannot import.
 * The process that carries the gate — the agent, the dashboard — registers
 * these once at start, the way `registerCoreTelemetryContext` takes the plan
 * and the cloud origin.
 *
 * A process that registers nothing (the MCP server's drain, `engager call`)
 * has no relay target, so it never sends a report: it leaves it for the agent
 * (`fileBugReport`). With no account email it redacts every address, the
 * account's own among them, which is the safe side of the same question.
 */

/** Where a report is relayed, and as whom. */
export type RelayTarget = { origin: string; credential: ReportCredential | null };

export type ReportSources = {
  /** The account's email, which the redactor leaves in. */
  accountEmail?: () => string | null;
  /** Where this process relays a report and under which credential. */
  relayTarget?: (runtimeOrganizationId: string) => RelayTarget;
};

let registered: ReportSources = {};

/** Called once by the process that carries the licence gate. Passing nothing
 *  forgets what an earlier call registered. */
export function registerReportSources(sources: ReportSources = {}): void {
  registered = sources;
}

/** The account's email as the registered source reads it; null when none is
 *  registered, it has none, or it cannot say. */
export function reportAccountEmail(): string | null {
  try {
    return registered.accountEmail?.() ?? null;
  } catch {
    return null;
  }
}

/** Where this process relays a report, or null when it registered nothing and
 *  so cannot say. A registered source that throws is not that answer: the
 *  error is the caller's, because "this process has no relay" is a wait for
 *  another process and "the relay cannot be resolved" is a failed attempt that
 *  must reach its deadline (`fileBugReport`). */
export function registeredRelayTarget(runtimeOrganizationId: string): RelayTarget | null {
  return registered.relayTarget?.(runtimeOrganizationId) ?? null;
}
