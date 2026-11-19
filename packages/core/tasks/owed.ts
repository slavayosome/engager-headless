import { and, isNull, ne, sql } from "drizzle-orm";
import { campaigns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { resolveJudgmentPolicy } from "./policy";

/**
 * Model work this org owes the CALLER that no prepared task covers yet.
 *
 * `listOpenTasks` answers the other half — tasks that exist and are waiting
 * on judgment. This one exists because, under the external judgment policy, a
 * tool may leave work owed WITHOUT preparing anything: `save_campaign` writes
 * no `compile_campaign` row, so the campaign's focus brief is owed to the caller's
 * own agent and nothing on the wire said so. `get_status` read
 * `pendingTasks: []` beside "Scout campaign live" with the brief uncompiled, and
 * an agent following engager-setup Step 4 had no reason to prepare it.
 *
 * KINDS, not ids, because there is nothing to hold an id yet: the agent
 * settles one of these by calling `start_task`, which is what
 * moves it into `pendingTasks` proper.
 *
 * A campaign brief is owed only while its campaign has never compiled. A brief
 * that later becomes stale is handled by the compiler's own source hash.
 */
export async function listOwedTasks(
  tx: Tx,
  /** A campaign brief already prepared is not owed. */
  prepared: readonly { taskKind: string }[] = [],
): Promise<string[]> {
  if ((await resolveJudgmentPolicy(tx)) === "configured_background") return [];
  const owed: string[] = [];

  const [uncompiled] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(
      and(ne(campaigns.status, "archived"), isNull(campaigns.compiledBrief)),
    );
  if (
    (uncompiled?.n ?? 0) > 0 &&
    !prepared.some((task) => task.taskKind === "campaign_brief")
  )
    owed.push("campaign_brief");
  return owed;
}
