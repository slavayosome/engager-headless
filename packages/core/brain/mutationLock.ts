import { sql } from "drizzle-orm";
import type { Tx } from "@engager/database/tenant";

/**
 * Serialize Brain state/knowledge/question mutations for the current tenant.
 * Transaction-owned compatibility flows acquire this before any brain_state row
 * lock; phased flows acquire it only in their short DB-only apply transaction.
 */
export async function lockBrainMutation(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('brain-mutation:' || coalesce(current_setting('app.current_org', true), '')))`,
  );
}
