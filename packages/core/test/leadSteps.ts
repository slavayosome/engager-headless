import { and, eq, inArray } from "drizzle-orm";
import { db } from "@engager/database";
import { jobs } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { injectedGrant } from "../jobs/context";
import { runOnce } from "../jobs/worker";
import { pipelineCounts } from "../leads/scout/queues";
import type { MockDriver } from "../linkedin/mock";
import { withEntryBoundary } from "./boundary";

/**
 * The steps a Find leads run wakes, run to the end as the worker would run them:
 * Screen, Read profiles and Judge in turn until nothing waits or a round moves
 * no one.
 */
export async function runSteps(organizationId: string, campaignId: number, driver: MockDriver, llm: LLM): Promise<string[]> {
  const ctx = { organizationId, llm, grant: injectedGrant(driver) };
  const dispatched = new Set<string>();
  const waiting = async () => {
    const counts = await withOrg(organizationId, (tx) => pipelineCounts(tx, campaignId));
    return counts.toScreen + counts.waitingForRead + counts.toJudge;
  };
  for (let round = 0; round < 20; round++) {
    const before = await waiting();
    if (before === 0) return [...dispatched];
    const queued = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(and(eq(jobs.organizationId, organizationId), inArray(jobs.type, ["lead_screen", "research_signals", "lead_judge"])));
    for (const job of queued) dispatched.add(job.type);
    const ran = await withEntryBoundary(
      () => runOnce(ctx, { ownOrgs: new Set([organizationId]) }),
      { organizationId },
    );
    if (!ran || (await waiting()) >= before && queued.length === 0) return [...dispatched];
  }
  return [...dispatched];
}
