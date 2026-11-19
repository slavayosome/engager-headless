import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import {
  REPORT_RETENTION_DAYS,
  type ReportApp,
  type ReportImageType,
  type ReportScreen,
} from "@engager/common/problem-report";
import { bugReports, jobs, type BugReportRow, type BugReportStatus } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueue } from "../jobs/queue";

/**
 * The owner's problem reports on this install (US-BUG-04, US-BUG-07): queued
 * at Send, moved by `file_bug_report`, listed in Settings › Reports, retried
 * or deleted from there and from the sidebar's footer. Every function runs in
 * the caller's `withOrg` transaction.
 */

/** Delivery is retried for a day from when it was queued, then the report is
 *  failed and waits for the owner's Retry. */
export const REPORT_DELIVERY_WINDOW_MS = 24 * 60 * 60_000;

/** A sent report is kept this long, then removed from this install: it
 *  answers "did the team get it?" for a while, and holds the owner's words, a
 *  screenshot and their diagnostics for no reason after that. A report that
 *  did not go is never pruned; it waits for the owner's Retry or Delete. */
export const REPORT_RETENTION_MS = REPORT_RETENTION_DAYS * 24 * 60 * 60_000;

const IN_FLIGHT: BugReportStatus[] = ["queued", "filing", "sending"];

export type QueueBugReportInput = {
  id: string;
  screen: ReportScreen;
  words: string;
  expected: string | null;
  screenshots: { contentType: ReportImageType; content: string }[];
  includeDiagnostics: boolean;
  diagnostics: string | null;
  app: ReportApp;
  now: number;
};

function jobKey(id: string, queuedAt: number): string {
  return `bug-report:${id}:${queuedAt}`;
}

async function enqueueFiling(tx: Tx, id: string, queuedAt: number): Promise<void> {
  await enqueue(tx, {
    type: "file_bug_report",
    payload: { reportId: id },
    idempotencyKey: jobKey(id, queuedAt),
    // Delivery retries are the handler's own reschedules, which burn no
    // attempt; these are for a handler that crashes outright.
    maxAttempts: 10,
  });
}

export type QueueOutcome =
  /** Queued now. */
  | "created"
  /** The same report, sent again after an answer was lost: queued already. */
  | "duplicate"
  /** The id is taken by a report with different words or images — queued
   *  already, so what the owner sees now is not what is on its way. */
  | "changed";

/** What the owner wrote and attached: the part of a report a resend must not
 *  change. The diagnostics and the screen are re-read at every open, and a
 *  resend of the same words from a refreshed dialog is still the same report. */
function sameReport(row: BugReportRow, input: QueueBugReportInput): boolean {
  return (
    row.ownerText === input.words &&
    row.expected === input.expected &&
    row.includeDiagnostics === input.includeDiagnostics &&
    isDeepStrictEqual(row.screenshots, input.screenshots)
  );
}

/**
 * One row and its job, once per id: the dashboard mints the id, so a Send
 * that reached the server twice queues one report. A second Send under the
 * same id with other words or images is not that — it is `changed`, and
 * nothing is stored, rather than the owner's edit being dropped in silence.
 */
export async function queueBugReport(tx: Tx, input: QueueBugReportInput): Promise<QueueOutcome> {
  const [row] = await tx
    .insert(bugReports)
    .values({
      id: input.id,
      screen: input.screen,
      ownerText: input.words,
      expected: input.expected,
      screenshots: input.screenshots,
      includeDiagnostics: input.includeDiagnostics,
      diagnostics: input.includeDiagnostics ? input.diagnostics : null,
      app: input.app,
      queuedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: bugReports.id });
  if (!row) {
    const existing = await readBugReport(tx, input.id);
    return existing && !sameReport(existing, input) ? "changed" : "duplicate";
  }
  await enqueueFiling(tx, input.id, input.now);
  return "created";
}

/**
 * A report whose delivery has stopped without an end: its row says queued,
 * filing or sending, and its job is gone, dead after its crashes or never
 * enqueued. Left alone it reads "Sending…" for ever and offers no Retry, so it
 * is failed with the reason, and the owner's Retry starts it again.
 */
export async function settleStrandedReports(tx: Tx, now: number): Promise<number> {
  const live = tx
    .select({ one: sql`1` })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, bugReports.organizationId),
        eq(jobs.idempotencyKey, sql`'bug-report:' || ${bugReports.id}::text || ':' || ${bugReports.queuedAt}::text`),
        inArray(jobs.status, ["queued", "running"]),
      ),
    );
  const stranded = await tx
    .update(bugReports)
    .set({ status: "failed", error: "delivery stopped", updatedAt: now })
    .where(and(inArray(bugReports.status, IN_FLIGHT), notExists(live)))
    .returning({ id: bugReports.id });
  return stranded.length;
}

/** Remove the reports sent more than `REPORT_RETENTION_MS` ago. */
export async function pruneBugReports(tx: Tx, now: number): Promise<number> {
  const pruned = await tx
    .delete(bugReports)
    .where(and(eq(bugReports.status, "sent"), lt(bugReports.sentAt, now - REPORT_RETENTION_MS)))
    .returning({ id: bugReports.id });
  return pruned.length;
}

/**
 * The owner's Retry on a report that did not go: delivery starts again, for
 * another day, under the SAME report id — so a report the relay did send
 * after all answers with its first message and is never sent twice. A
 * write-up already made is kept.
 */
export async function retryBugReport(tx: Tx, id: string, now: number): Promise<boolean> {
  // A report stranded in flight is a failed one the list has not caught up
  // with; Retry on it must not be refused for that.
  await settleStrandedReports(tx, now);
  const [row] = await tx
    .update(bugReports)
    .set({ status: "queued", attempts: 0, error: null, queuedAt: now, updatedAt: now })
    .where(and(eq(bugReports.id, id), eq(bugReports.status, "failed")))
    .returning({ id: bugReports.id });
  if (!row) return false;
  // A fresh key: the queue time is in it, so the finished job's key stays its
  // receipt and this delivery gets its own.
  await enqueueFiling(tx, id, now);
  return true;
}

/** Delete the local row and what it holds. It does not unsend. */
export async function deleteBugReport(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.delete(bugReports).where(eq(bugReports.id, id)).returning({ id: bugReports.id });
  return rows.length > 0;
}

export async function readBugReport(tx: Tx, id: string): Promise<BugReportRow | null> {
  const [row] = await tx.select().from(bugReports).where(eq(bugReports.id, id)).limit(1);
  return row ?? null;
}

export type BugReportListItem = {
  id: string;
  createdAt: number;
  sentAt: number | null;
  screenLabel: string;
  /** The agent's title, or the owner's first line when there is none. */
  title: string;
  severity: string | null;
  writeUpUnavailable: string | null;
  status: BugReportStatus;
};

export function reportTitle(row: Pick<BugReportRow, "agentSummary" | "ownerText">): string {
  const writeUp = row.agentSummary && "writeUp" in row.agentSummary ? row.agentSummary.writeUp : null;
  if (writeUp && typeof writeUp.title === "string") return writeUp.title;
  const first = row.ownerText.trim().split("\n")[0] ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

export async function listBugReports(tx: Tx, limit = 100): Promise<BugReportListItem[]> {
  const rows = await tx
    .select({
      id: bugReports.id,
      createdAt: bugReports.createdAt,
      sentAt: bugReports.sentAt,
      screen: bugReports.screen,
      ownerText: bugReports.ownerText,
      agentSummary: bugReports.agentSummary,
      status: bugReports.status,
    })
    .from(bugReports)
    .orderBy(desc(bugReports.createdAt))
    .limit(limit);
  return rows.map((row) => {
    const writeUp = row.agentSummary && "writeUp" in row.agentSummary ? row.agentSummary.writeUp : null;
    return {
      id: row.id,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      screenLabel: typeof row.screen.label === "string" ? row.screen.label : "",
      title: reportTitle(row),
      severity: writeUp && typeof writeUp.severity === "string" ? writeUp.severity : null,
      writeUpUnavailable: row.agentSummary && "unavailable" in row.agentSummary ? row.agentSummary.unavailable : null,
      status: row.status,
    };
  });
}

/** What the sidebar's footer says about reports: whether one is on its way,
 *  the newest one that did not go, and the newest that went — whose arrival
 *  the page announces once, saying whether the agent's write-up went too. */
export type BugReportFooter = {
  sending: boolean;
  failedId: string | null;
  lastSent: { id: string; withWriteUp: boolean } | null;
};

export async function bugReportFooter(tx: Tx): Promise<BugReportFooter> {
  const [inFlight] = await tx
    .select({ id: bugReports.id })
    .from(bugReports)
    .where(inArray(bugReports.status, IN_FLIGHT))
    .limit(1);
  const [failed] = await tx
    .select({ id: bugReports.id })
    .from(bugReports)
    .where(eq(bugReports.status, "failed"))
    .orderBy(desc(bugReports.updatedAt))
    .limit(1);
  const [sent] = await tx
    .select({ id: bugReports.id, agentSummary: bugReports.agentSummary })
    .from(bugReports)
    .where(eq(bugReports.status, "sent"))
    .orderBy(desc(bugReports.sentAt))
    .limit(1);
  return {
    sending: Boolean(inFlight),
    failedId: failed?.id ?? null,
    lastSent: sent
      ? { id: sent.id, withWriteUp: Boolean(sent.agentSummary && "writeUp" in sent.agentSummary) }
      : null,
  };
}
