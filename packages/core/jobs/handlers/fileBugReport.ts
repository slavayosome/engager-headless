import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  REPORT_ID_HEADER,
  fitRelayRequest,
  type ProblemReport,
  type ReportApp,
  type ReportDiagnosticsStatus,
  type ReportImageType,
  type ReportRelayRequest,
  type ReportScreen,
  type ReportWriteUp,
} from "@engager/common/problem-report";
import { bugReports, type BugReportRow, type BugReportSummary } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { readInstallId } from "@engager/observability/installId";
import { getLLM, type LLM } from "../../ai/client";
import { readKnownPeople } from "../../reports/diagnostics";
import { buildReportRedactor, redactWriteUp } from "../../reports/redactor";
import { registeredRelayTarget, type RelayTarget } from "../../reports/sources";
import { REPORT_DELIVERY_WINDOW_MS } from "../../reports/store";
import { writeUpReport } from "../../reports/writeUp";
import { RescheduleError } from "../queue";
import { assertHostedJobSpendStillAllowed } from "../spendAccess";
import type { SelfScopedCtx } from "../worker";

const PayloadSchema = z.object({ reportId: z.string().uuid() });

/** After the first, second and third failed delivery; hourly after that,
 *  until the day from `queuedAt` is out. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
const HOURLY_MS = 60 * 60_000;
const RELAY_TIMEOUT_MS = 60_000;

export function deliveryDelay(failedAttempts: number): number {
  return BACKOFF_MS[failedAttempts - 1] ?? HOURLY_MS;
}

/** Everything the job reaches outside its own database, so a test can stand
 *  in for each of it. */
export type ReportDelivery = {
  installId: () => string | null;
  /** Null when this process registered no relay (`reports/sources.ts`); throws
   *  when the one it registered cannot say. */
  target: (runtimeOrganizationId: string) => RelayTarget | null;
  fetch: typeof fetch;
  now: () => number;
  llm: () => LLM;
  writeUpTimeoutMs?: number;
};

function defaultDelivery(ctx: SelfScopedCtx): ReportDelivery {
  return {
    installId: () => readInstallId(),
    target: registeredRelayTarget,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    llm: () => ctx.llm ?? getLLM(),
  };
}

type Attempt =
  | { kind: "sent"; messageId: string }
  | { kind: "retry"; error: string }
  | { kind: "refused"; error: string };

/** Where the report goes: the destination the process registered, nothing (it
 *  registered none), or a registered source that failed — an attempt like an
 *  unreachable relay, tried again until the day is out. */
function resolveTarget(
  delivery: ReportDelivery,
  runtimeOrganizationId: string,
): { target: RelayTarget } | { failed: Attempt } | null {
  try {
    const target = delivery.target(runtimeOrganizationId);
    return target ? { target } : null;
  } catch (error) {
    console.warn("[file_bug_report] the registered relay target could not be resolved:", error);
    return { failed: { kind: "retry", error: "relay target unavailable" } };
  }
}

/** One POST to the relay, read for exactly one of three answers. Only a 200
 *  saying `sent` with a message id is sent; a network failure, a 404, a 429, a
 *  5xx or a 2xx that is not that is worth another try under the same id;
 *  anything else is the relay refusing it. */
async function relay(delivery: ReportDelivery, target: RelayTarget, request: ReportRelayRequest): Promise<Attempt> {
  let res: Response;
  try {
    res = await delivery.fetch(`${target.origin}/api/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [REPORT_ID_HEADER]: request.report.id,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return { kind: "retry", error: "relay unreachable" };
  }
  const body = (await res.json().catch(() => null)) as { status?: unknown; messageId?: unknown; error?: unknown } | null;
  const code = typeof body?.error === "string" ? ` ${body.error.slice(0, 60)}` : "";
  if (res.status === 200 && body?.status === "sent" && typeof body.messageId === "string" && body.messageId !== "") {
    return { kind: "sent", messageId: body.messageId };
  }
  // The caps are shared with the relay and sit under Vercel's 4.5 MB body
  // limit, which answers 413 in its own words before the route runs. A request
  // over either is a bug on this side, and the same request would fail the
  // same way tomorrow.
  if (res.status === 413) return { kind: "refused", error: "report too large for the relay" };
  // Any other 2xx is not the relay's answer — a proxy's, a captive portal's —
  // and says nothing about whether the team has the report.
  // A 404 is a cloud that does not serve the route yet (an older deploy
  // mid-rollout), not a refusal of this report: it is tried again.
  if (res.status === 404 || res.status === 429 || res.status >= 500 || res.ok) {
    return { kind: "retry", error: `relay ${res.status}${code}` };
  }
  return { kind: "refused", error: `relay ${res.status}${code}` };
}

/** The owner's choice and what became of it: a row that asked for
 *  diagnostics and holds none is one the install could not prepare them for. */
function diagnosticsStatus(row: Pick<BugReportRow, "includeDiagnostics" | "diagnostics">): ReportDiagnosticsStatus {
  if (!row.includeDiagnostics) return "unticked";
  return row.diagnostics === null ? "unavailable" : "included";
}

function problemReport(row: BugReportRow, installId: string, summary: BugReportSummary): ProblemReport {
  return {
    id: row.id,
    installId,
    screen: row.screen as ReportScreen,
    words: row.ownerText,
    expected: row.expected,
    app: row.app as ReportApp,
    diagnostics: row.includeDiagnostics ? row.diagnostics : null,
    diagnosticsStatus: diagnosticsStatus(row),
    writeUp: "writeUp" in summary ? (summary.writeUp as ReportWriteUp) : null,
    writeUpUnavailable: "unavailable" in summary ? summary.unavailable : null,
    screenshots: row.screenshots.map((shot) => ({
      contentType: shot.contentType as ReportImageType,
      content: shot.content,
    })),
  };
}

/**
 * FILE A PROBLEM REPORT (`file_bug_report`, US-BUG-04), on the agent process:
 * the owner's agent writes it up, then it is relayed to the team through the
 * cloud — at most once.
 *
 * - The write-up runs once per report and is kept: a retry never asks again.
 *   No agent, a failing agent, or one past 120 s is a reason class the report
 *   carries instead; it is never held back for want of one.
 * - The owner's words go verbatim beside the write-up.
 * - Delivery is retried with backoff — 1 min, 5 min, 30 min, then hourly — on
 *   a network failure, a 429 or a 5xx, always under the report's own id, which
 *   the relay dedupes on: a retry after an uncertain answer is answered with
 *   the first send. A day after it was queued it is failed, and waits for the
 *   owner's Retry. A refusal (a 4xx) fails it at once.
 * - Only a process that registered a relay (`reports/sources.ts`) sends. Any
 *   other that claims the job (the MCP server's drain) hands it back untouched
 *   to run again, and the agent sends it. A registered relay that cannot say
 *   where to send is an attempt that failed, on the same backoff and deadline.
 *
 * Self-scoped: the agent call and the POST hold no transaction; every row
 * write is its own short one.
 */
export async function fileBugReport(
  ctx: SelfScopedCtx,
  rawPayload: unknown,
  delivery: ReportDelivery = defaultDelivery(ctx),
): Promise<{ sent: number }> {
  const { reportId } = PayloadSchema.parse(rawPayload);
  const orgScope = <T>(work: (tx: Tx) => Promise<T>) => withOrg(ctx.organizationId, work);
  const write = (set: Partial<typeof bugReports.$inferInsert>) =>
    orgScope((tx) =>
      tx
        .update(bugReports)
        .set({ ...set, updatedAt: delivery.now() })
        .where(eq(bugReports.id, reportId)),
    );

  const [row] = await orgScope((tx) => tx.select().from(bugReports).where(eq(bugReports.id, reportId)).limit(1));
  // Deleted since Send, already sent, or failed and waiting for a Retry.
  if (!row || row.status === "sent" || row.status === "failed") return { sent: 0 };

  // A process that registered no relay (the MCP server's drain, `engager call`)
  // does not know where this goes or as whom, and sending it from here would
  // send it anonymously. It touches nothing, not even the write-up, and gives
  // the job back for the agent that carries the licence gate: a wait, never a
  // failure, so the report stays queued and the owner's Retry stays unneeded.
  const resolved = resolveTarget(delivery, ctx.organizationId);
  if (!resolved) throw new RescheduleError("this process has no relay for problem reports; the agent sends them");

  let summary = row.agentSummary;
  if (!summary) {
    await write({ status: "filing" });
    // A hosted runtime re-authorizes its spend before the agent is asked; a
    // refusal there costs the write-up, never the report.
    const allowed = await assertHostedJobSpendStillAllowed(ctx).then(
      () => true,
      () => false,
    );
    const outcome = allowed
      ? await writeUpReport(
          delivery.llm,
          {
            screen: row.screen as ReportScreen,
            words: row.ownerText,
            expected: row.expected,
            diagnostics: row.includeDiagnostics ? row.diagnostics : null,
            diagnosticsStatus: diagnosticsStatus(row),
          },
          { signal: ctx.signal, timeoutMs: delivery.writeUpTimeoutMs },
        )
      : { unavailable: "agent not available" };
    if ("writeUp" in outcome) {
      // The agent writes prose of its own beside what it was shown, so its
      // write-up passes the redactor too: the people it knows are read in a
      // short transaction of their own, and the redacting happens after it.
      const knownPeople = await orgScope((tx) => readKnownPeople(tx, delivery.now()));
      summary = { writeUp: redactWriteUp(outcome.writeUp, buildReportRedactor(knownPeople)) };
    } else {
      summary = { unavailable: outcome.unavailable };
    }
    await write({ agentSummary: summary, status: "sending" });
  } else if (row.status !== "sending") {
    await write({ status: "sending" });
  }

  const installId = delivery.installId();
  if (!installId) {
    // The relay keys its budget and its dedupe on the install; an install
    // that cannot name itself cannot send, and says so rather than guessing.
    await write({ status: "failed", error: "install id unavailable" });
    return { sent: 0 };
  }

  const attempt =
    "failed" in resolved
      ? resolved.failed
      : await relay(
          delivery,
          resolved.target,
          fitRelayRequest({ report: problemReport(row, installId, summary), credential: resolved.target.credential }),
        );
  const attempts = row.attempts + 1;
  const now = delivery.now();

  if (attempt.kind === "sent") {
    await write({ status: "sent", sentAt: now, messageId: attempt.messageId, attempts, error: null });
    return { sent: 1 };
  }
  const deadline = row.queuedAt + REPORT_DELIVERY_WINDOW_MS;
  if (attempt.kind === "refused" || now >= deadline) {
    await write({ status: "failed", attempts, error: attempt.error });
    return { sent: 0 };
  }
  await write({ attempts, error: attempt.error });
  throw new RescheduleError(
    `report not relayed yet (${attempt.error})`,
    Math.min(now + deliveryDelay(attempts), deadline),
  );
}

export function handleFileBugReport(ctx: SelfScopedCtx, rawPayload: unknown): Promise<{ sent: number }> {
  return fileBugReport(ctx, rawPayload);
}
