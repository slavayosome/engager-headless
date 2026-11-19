import { and, eq, gt, isNull, max, count, sql } from "drizzle-orm";
import {
  candidateFeedback,
  discoveredPosts,
  messages,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { actionableCandidateStatusesSql } from "../operations/postStatus";
import { threadCounts } from "./threads";

/**
 * Agent-page read model: what the user's agent has actually done (server-
 * verified domain outcomes, not model summaries) and what is waiting for it.
 * Domain outcomes — ranked Candidates and client-authored drafts — are the
 * canonical activity regardless of trigger; runner work events are liveness
 * only and are never counted here, so interactive and continuous runs can
 * never double-count.
 */

export const AGENT_ACTIVITY_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

export type AgentActivityDay = {
  /** UTC calendar day, "YYYY-MM-DD" — same day key the runner budget uses. */
  day: string;
  /** Candidates the agent ranked (task completion, either trigger). */
  triaged: number;
  /** Client-authored comment drafts intaken that day. */
  comments: number;
  /** Client-authored reply drafts intaken that day. */
  replies: number;
};

export type AgentActivityWaiting = {
  /** Fresh pool rows with no agent score and no human good-match verdict. */
  untriaged: number;
  /** Exact human-requested drafts the agent has not fulfilled yet. */
  draftRequests: number;
  /** Thread items currently in the Drafting state (comments + replies). */
  drafting: number;
};

export type AgentActivity = {
  now: number;
  /** Derived, never stored: an enrolled runner row (any state) means the
   * continuous trigger exists; otherwise the org runs the agent on demand.
   * Mirrors resolveRunnerHealth's no-runner ⇒ manual branch. */
  mode: "continuous" | "on_demand";
  /** Latest proof of the agent touching this org across both triggers:
   * key use, runner heartbeat, ranked Candidate, or client-authored draft. */
  lastActivityAt: number | null;
  /** True once any non-revoked interactive key has been used at least once. */
  connectedEver: boolean;
  /** Zero-filled daily outcomes, most recent day first. */
  days: AgentActivityDay[];
  waiting: AgentActivityWaiting;
};

/** Mirrors the radar workspace's human good-match predicate (a current,
 * unreverted good_match verdict keeps a row out of the untriaged count). */
function hasGoodMatchFeedback(tx: Tx) {
  return sql<boolean>`exists (
    ${tx
      .select({ id: candidateFeedback.id })
      .from(candidateFeedback)
      .where(
        and(
          eq(candidateFeedback.organizationId, discoveredPosts.organizationId),
          eq(candidateFeedback.campaignId, discoveredPosts.campaignId),
          eq(candidateFeedback.discoveredPostId, discoveredPosts.id),
          eq(candidateFeedback.verdict, "good_match"),
          isNull(candidateFeedback.revertedAt),
        ),
      )}
  )`;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function agentActivity(
  tx: Tx,
  opts: {
    /** Scopes every read to one organization. */
    organizationId: string;
    now?: number;
  },
): Promise<AgentActivity> {
  const now = opts.now ?? Date.now();
  const since = now - AGENT_ACTIVITY_WINDOW_DAYS * DAY_MS;

  const triagedDay = sql<string>`to_char(to_timestamp(${discoveredPosts.agentRankedAt} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  const triageRows = await tx
    .select({ day: triagedDay, n: count() })
    .from(discoveredPosts)
    .where(gt(discoveredPosts.agentRankedAt, since))
    .groupBy(sql`1`);

  const clientTrace = sql`${messages.trace}->>'source' = 'client'`;
  const draftedDay = sql<string>`to_char(to_timestamp(${messages.createdAt} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  const draftRows = await tx
    .select({ day: draftedDay, kind: messages.kind, n: count() })
    .from(messages)
    .where(and(gt(messages.createdAt, since), clientTrace))
    .groupBy(sql`1`, messages.kind);

  const [rankedAgg] = await tx
    .select({ lastRankedAt: max(discoveredPosts.agentRankedAt) })
    .from(discoveredPosts);
  const [draftAgg] = await tx
    .select({ lastDraftAt: max(messages.createdAt) })
    .from(messages)
    .where(clientTrace);

  const [candidateAgg] = await tx
    .select({
      untriaged: sql<number>`count(*) filter (where ${actionableCandidateStatusesSql()} and ${discoveredPosts.agentScore} is null and not ${hasGoodMatchFeedback(tx)})::int`,
      draftRequests: sql<number>`count(*) filter (where ${discoveredPosts.status} = 'draft_requested')::int`,
    })
    .from(discoveredPosts);

  const counts = await threadCounts(tx, { now });

  const byDay = new Map<string, AgentActivityDay>();
  for (let i = 0; i < AGENT_ACTIVITY_WINDOW_DAYS; i++) {
    const day = utcDay(now - i * DAY_MS);
    byDay.set(day, { day, triaged: 0, comments: 0, replies: 0 });
  }
  for (const row of triageRows) {
    const bucket = byDay.get(row.day);
    if (bucket) bucket.triaged = row.n;
  }
  for (const row of draftRows) {
    // Rows older than the zero-filled window (a partial eighth day) drop out.
    const bucket = byDay.get(row.day);
    if (!bucket) continue;
    if (row.kind === "comment") bucket.comments += row.n;
    else bucket.replies += row.n;
  }

  const stamps = [
    rankedAgg?.lastRankedAt,
    draftAgg?.lastDraftAt,
  ].filter((value): value is number => typeof value === "number");

  return {
    now,
    mode: "on_demand",
    lastActivityAt: stamps.length > 0 ? Math.max(...stamps) : null,
    connectedEver: false,
    days: [...byDay.values()],
    waiting: {
      untriaged: candidateAgg?.untriaged ?? 0,
      draftRequests: candidateAgg?.draftRequests ?? 0,
      drafting: counts.items.drafting.items,
    },
  };
}
