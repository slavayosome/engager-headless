import { sql } from "drizzle-orm";
import { organizations } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/** Lead processing is available to every local organization. */
export async function leadsEnabled(tx: Tx, organizationId?: string): Promise<boolean> {
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`${organizations.id} = nullif(current_setting('app.current_org', true), '')::uuid`);
  return !!org && (!organizationId || org.id === organizationId);
}
