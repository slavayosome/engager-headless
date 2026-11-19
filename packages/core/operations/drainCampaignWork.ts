import { and, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { actions, messages } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { MESSAGE_SENDS } from "../actions/keys";
import { startSessionBrowser } from "../linkedin/browser-use/sessionBrowser";

/** Runs already-due queue work out of process. Core does not know how: the
 *  caller that owns the install (the MCP server) hands the runner in. */
export type DrainRunner = (opts: { maxJobs: number; maxMs: number; signal: AbortSignal }) => Promise<{ processed: number }>;

let runner: DrainRunner | null = null;
export function setDrainRunner(next: DrainRunner | null): void {
  runner = next;
}

/** Drain the account's already-due work in this session. It is account-wide,
 *  never one campaign's, and it grants no pacing relief: every send-time gate
 *  still applies. Says what is left to post, read off the rows. */
export async function drainCampaignWork(organizationId: string, signal: AbortSignal) {
  if (!runner) throw new AppError("drain_unavailable", "This install cannot run due work in a session.", 409);
  await startSessionBrowser();
  let processed: number;
  try {
    ({ processed } = await runner({ maxJobs: 10, maxMs: 25_000, signal }));
  } catch (error) {
    throw new AppError(error instanceof Error && /^[a-z][a-z0-9_:.-]+$/.test(error.message) ? error.message : "drain_unavailable", "Due work could not be run in this session.", 409);
  }
  const now = Date.now();
  const posting = await withOrg(organizationId, async (tx) => {
    const [row] = await tx.select({
      waiting: sql<number>`count(*)::int`,
      dueNow: sql<number>`count(*) filter (where ${messages.scheduledAt} is null or ${messages.scheduledAt} <= ${now})::int`,
      nextRunAt: sql<number | null>`min(${messages.scheduledAt})::float8`,
    }).from(actions).innerJoin(messages, eq(messages.id, actions.messageId))
      .where(and(inArray(actions.kind, [...MESSAGE_SENDS]), inArray(actions.status, ["approved", "reserved"])));
    return { waiting: row?.waiting ?? 0, dueNow: row?.dueNow ?? 0, nextRunAt: row?.nextRunAt ?? null };
  });
  return { processed, posting };
}
