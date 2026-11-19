import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { fitDiagnostics } from "@engager/common/problem-report";
import {
  actions,
  discoveredPosts,
  engagedProfiles,
  engagementEvents,
  incomingComments,
  incomingInvitations,
  jobs,
  leads,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { Redactor } from "@engager/observability/redact";
import { processExists, readAgentState } from "../ai/agentCli/state";
import { readBridgeFile } from "../linkedin/browser-use/bridgeFile";
import { linkedInConnectionState } from "../linkedin/liveness";
import { rateLimitState } from "../operations/observability";
import { getOrgSafety } from "../operations/orgSettings";
import { getSystemState } from "../ratelimit/killswitch";

/**
 * What a problem report's diagnostics are made of — and the whole of it
 * (US-BUG-06). Four sources, nothing else:
 * - the tail of each process log (`~/.engager/logs/*.log` and its `.1`);
 * - the jobs that failed in the window, and the actions whose outcome is
 *   uncertain — by type, error class and message, never their payload;
 * - the dashboard's own recent errors, handed in by the page;
 * - an `engager doctor`-style health block.
 *
 * Composed as plain text and redacted as a whole by the caller's `Redactor`,
 * so what the owner previews is exactly what goes: the preview, the agent's
 * input and the sent attachment are the same string.
 */

export const REPORT_WINDOW_MS = 24 * 60 * 60_000;
export const LOG_TAIL_LINES = 300;
export const DASHBOARD_ERROR_LIMIT = 50;
/** Enough of a file's end for 300 lines at the redactor's 2,000-character cap. */
const LOG_TAIL_BYTES = LOG_TAIL_LINES * 2_000;
const MAX_JOB_LINES = 50;
const MAX_MESSAGE_CHARS = 300;
/** Per source, so one busy table cannot crowd the others out of the list. */
const KNOWN_PEOPLE_PER_SOURCE = 5_000;

/** The dashboard's in-page error record (`apps/dashboard/lib/telemetry/errors.ts`),
 *  restated structurally: core cannot import the app. */
export type DashboardErrorRecord = {
  at: number;
  route: string;
  kind: "render" | "script" | "promise" | "action" | "fetch";
  name: string;
  message: string;
  frame?: string;
  status?: number;
};

export type ReportHealth = {
  database: string;
  agent: string;
  browserBridge: string;
  linkedin: string;
  stopEverything: string;
  today: string;
};

export type LogTail = { file: string; lines: string[] };

export function reportLogDirectory(): string {
  return join(process.env.ENGAGER_HOME ?? join(homedir(), ".engager"), "logs");
}

/**
 * The last `LOG_TAIL_LINES` of every `*.log` and `*.log.1` in `directory`
 * written within the window. The Mac app's logs carry no per-line time, so the
 * window is the file's: a file last written before it says nothing about now.
 * A missing directory is no logs, not an error — a checkout writes none.
 */
export async function readLogTails(directory: string, now: number): Promise<LogTail[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const tails: LogTail[] = [];
  for (const name of names.filter((n) => /\.log(\.1)?$/.test(n)).sort()) {
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs < now - REPORT_WINDOW_MS) continue;
      const start = Math.max(0, info.size - LOG_TAIL_BYTES);
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(info.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8").split("\n");
        // A read that starts mid-file starts mid-line: drop the fragment.
        if (start > 0) lines.shift();
        if (lines.at(-1) === "") lines.pop();
        tails.push({ file: name, lines: lines.slice(-LOG_TAIL_LINES) });
      } finally {
        await handle.close();
      }
    } catch {
      // A file rotated away between the listing and the read is simply gone.
    }
  }
  return tails;
}

/** Jobs that failed in the window: type, when, and the error's class and
 *  message — the payload is never selected. `jobs` is outside RLS, so the org
 *  predicate is explicit. */
export async function readFailedJobLines(tx: Tx, orgId: string, now: number): Promise<string[]> {
  const rows = await tx
    .select({ id: jobs.id, type: jobs.type, status: jobs.status, error: jobs.lastError, at: jobs.updatedAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, orgId),
        inArray(jobs.status, ["failed", "dead"]),
        gte(jobs.updatedAt, now - REPORT_WINDOW_MS),
      ),
    )
    .orderBy(desc(jobs.updatedAt))
    .limit(MAX_JOB_LINES);
  return rows.map((row) => {
    const { errorClass, message } = splitError(row.error);
    return `${iso(row.at)} job ${row.id} ${row.type} ${row.status} · ${errorClass}: ${message}`;
  });
}

/** Actions whose send could not be settled in the window, counted by kind —
 *  the kind is the whole of what a report needs; who they were for is not. */
export async function readUncertainActionLines(tx: Tx, now: number): Promise<string[]> {
  const rows = await tx
    .select({ kind: actions.kind, n: sql<number>`count(*)::int` })
    .from(actions)
    .where(and(eq(actions.status, "uncertain"), gte(actions.updatedAt, now - REPORT_WINDOW_MS)))
    .groupBy(actions.kind);
  return rows.map((row) => `${row.kind} × ${row.n}`);
}

/** One record to one line: a message with a newline in it would otherwise
 *  start a line the redactor cannot tell from the page's own. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function dashboardErrorLines(records: readonly DashboardErrorRecord[]): string[] {
  return records.slice(-DASHBOARD_ERROR_LIMIT).map((record) =>
    [
      iso(record.at),
      record.kind,
      oneLine(record.route),
      record.status != null ? String(record.status) : null,
      oneLine(`${record.name}: ${record.message.slice(0, MAX_MESSAGE_CHARS)}`),
      record.frame ? `(at ${oneLine(record.frame)})` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/** The doctor's view, from recorded state only: nothing here probes LinkedIn
 *  or opens a browser. Each read is its own savepoint, so one that fails says
 *  "unreadable" and costs nothing else. */
export async function readReportHealth(tx: Tx, orgId: string, now: number): Promise<ReportHealth> {
  const guarded = async (read: (sp: Tx) => Promise<string>): Promise<string> =>
    tx.transaction(read).catch(() => "unreadable");

  let agent: string;
  try {
    const selection = (await readAgentState()).backgroundSelection;
    agent = selection
      ? `${selection.adapterId} ${selection.observedVersion} · model ${selection.modelRef}`
      : "none selected";
  } catch {
    agent = "unreadable";
  }

  const bridge = readBridgeFile();
  const browserBridge = !bridge
    ? "not running"
    : processExists(bridge.pid)
      ? `running since ${iso(bridge.startedAt)}`
      : "recorded, process gone";

  return {
    // This read runs inside a transaction: the database answered.
    database: "ok",
    agent,
    browserBridge,
    linkedin: await guarded(async (sp) => {
      const state = await linkedInConnectionState(sp, now);
      return state.reason ? `${state.status} (${state.reason})` : state.status;
    }),
    stopEverything: await guarded(async (sp) => {
      const system = await getSystemState(sp);
      const paused = system?.pausedUntil && system.pausedUntil > now;
      return [
        system?.ownerKillSwitch ? "on" : "off",
        paused ? `paused until ${iso(system.pausedUntil!)} (${system.pausedReason ?? "no reason"})` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }),
    today: await guarded(async (sp) => {
      const rate = await rateLimitState(sp, { now });
      const safety = await getOrgSafety(sp, orgId);
      return `${rate?.global.commentsRepliesToday ?? 0} of ${safety?.dailyEngageCap ?? 0} comments and replies`;
    }),
  };
}

/**
 * The names of the people this install has met, for the redactor's
 * `knownPeople`: a name in a log line has no shape, so the only way to keep it
 * out of a report is to know it. Org-scoped by RLS (the caller's `withOrg`).
 */
export async function readKnownPeople(tx: Tx, now: number): Promise<string[]> {
  const recent = now - 30 * REPORT_WINDOW_MS;
  const lists = await Promise.all([
    tx
      .selectDistinct({ name: discoveredPosts.authorName })
      .from(discoveredPosts)
      .where(and(isNotNull(discoveredPosts.authorName), gte(discoveredPosts.discoveredAt, recent)))
      .limit(KNOWN_PEOPLE_PER_SOURCE),
    tx
      .selectDistinct({ name: incomingComments.authorName })
      .from(incomingComments)
      .where(isNotNull(incomingComments.authorName))
      .limit(KNOWN_PEOPLE_PER_SOURCE),
    tx
      .selectDistinct({ name: engagementEvents.actorName })
      .from(engagementEvents)
      .where(isNotNull(engagementEvents.actorName))
      .limit(KNOWN_PEOPLE_PER_SOURCE),
    tx
      .selectDistinct({ name: engagedProfiles.name })
      .from(engagedProfiles)
      .where(isNotNull(engagedProfiles.name))
      .limit(KNOWN_PEOPLE_PER_SOURCE),
    tx.selectDistinct({ name: leads.name }).from(leads).where(isNotNull(leads.name)).limit(KNOWN_PEOPLE_PER_SOURCE),
    tx
      .selectDistinct({ name: incomingInvitations.senderDisplayName })
      .from(incomingInvitations)
      .where(isNotNull(incomingInvitations.senderDisplayName))
      .limit(KNOWN_PEOPLE_PER_SOURCE),
  ]);
  return [...new Set(lists.flat().map((row) => row.name ?? "").filter(Boolean))];
}

export type DiagnosticsParts = {
  now: number;
  health: ReportHealth;
  failedJobs: readonly string[];
  uncertainActions: readonly string[];
  dashboardErrors: readonly DashboardErrorRecord[];
  logs: readonly LogTail[];
};

/** The diagnostics text, redacted. Sections always appear, empty ones as
 *  "none", so a reader can tell "nothing failed" from "not collected". */
export function composeDiagnostics(parts: DiagnosticsParts, redactor: Redactor): string {
  const section = (title: string, lines: readonly string[]) =>
    [`## ${title}`, ...(lines.length > 0 ? lines : ["none"]), ""].join("\n");
  const text = [
    `Engager diagnostics · collected ${iso(parts.now)} · secrets and people removed`,
    "",
    section("Health", [
      `database: ${parts.health.database}`,
      `agent: ${parts.health.agent}`,
      `browser bridge: ${parts.health.browserBridge}`,
      `LinkedIn: ${parts.health.linkedin}`,
      `Stop everything: ${parts.health.stopEverything}`,
      `today: ${parts.health.today}`,
    ]),
    section("Failed jobs (last 24 h)", parts.failedJobs),
    section("Uncertain actions (last 24 h)", parts.uncertainActions),
    section(`Dashboard errors (last ${DASHBOARD_ERROR_LIMIT})`, dashboardErrorLines(parts.dashboardErrors)),
    ...parts.logs.map((log) => section(`${log.file} (last ${LOG_TAIL_LINES} lines, 24 h)`, log.lines)),
  ].join("\n");
  // Held to what the request carries: redacting only ever shortens a line by
  // its secret and lengthens it by a placeholder, so the cap is the last step.
  return fitDiagnostics(redactor.text(text).trimEnd() + "\n");
}

/** What the database holds of a report's diagnostics, and the names the
 *  redactor needs — read, not yet redacted. */
export type DiagnosticInputs = Pick<DiagnosticsParts, "health" | "failedJobs" | "uncertainActions"> & {
  knownPeople: string[];
};

/**
 * Everything a report reads from the database, in the caller's org
 * transaction and nothing else. Redacting is CPU work over every log line; it
 * runs after the transaction closes (`composeDiagnostics`), so a large log
 * never holds a connection.
 */
export async function readDiagnosticInputs(tx: Tx, orgId: string, now: number): Promise<DiagnosticInputs> {
  return {
    health: await readReportHealth(tx, orgId, now),
    failedJobs: await readFailedJobLines(tx, orgId, now),
    uncertainActions: await readUncertainActionLines(tx, now),
    knownPeople: await readKnownPeople(tx, now),
  };
}

/** "TypeError: x is undefined\n    at …" → class and first line. A message
 *  with no class is an `Error`, which is what the worker records it as. */
function splitError(raw: string | null): { errorClass: string; message: string } {
  const first = (raw ?? "").split("\n")[0]?.trim() ?? "";
  const match = first.match(/^([A-Z][A-Za-z]*(?:Error|Exception))\b:?\s*(.*)$/);
  const message = (match ? match[2] ?? "" : first).slice(0, MAX_MESSAGE_CHARS);
  return { errorClass: match?.[1] ?? "Error", message: message || "(no message)" };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
