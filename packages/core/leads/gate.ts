import { sql } from "drizzle-orm";
import { getOrgPlan } from "@engager/billing/plans";
import { organizations } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * The ONE feature gate every leads surface routes through: intake
 * classification, touch recording, the notify/nudge jobs, the MCP tools, and
 * the dashboard page. Leads is on for every plan today; introducing a higher
 * tier later is a catalog edit in `@engager/billing/plans` (flip
 * `features.leads` per plan) with zero changes here or at call sites.
 *
 * `organizationId` is optional because worker handlers run inside `withOrg`
 * without an explicit id — the GUC resolves it (the `getOwnPostRepliesScoped`
 * pattern). `getOrgPlan` reads the global (non-RLS) subscriptions table with
 * an explicit org filter — safe inside a `withOrg` scope. Call once per job,
 * not per row.
 */
export async function leadsEnabled(tx: Tx, organizationId?: string): Promise<boolean> {
  let orgId = organizationId;
  if (!orgId) {
    const [row] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(sql`${organizations.id} = nullif(current_setting('app.current_org', true), '')::uuid`);
    if (!row) return false;
    orgId = row.id;
  }
  const plan = await getOrgPlan(tx, orgId);
  return plan.features?.leads ?? false;
}
