import { assertLocalMigrationUrl, historyRows, packagedMigrations, pendingMigrations, withMigrationHistory, appliedMigrations } from "./migrationHistory.mjs";
import { migrationFingerprint } from "./macMaintenance.mjs";

/** Verifies the database's applied history against the packaged migrations and
 * reports whether the packaged migrator would actually apply anything.
 * `pending` uses Drizzle's own rule — a packaged entry newer than the last
 * applied `created_at` (`drizzle-orm/pg-core/dialect.js:59-62`) — so it can
 * never claim "nothing to do" for a migration the migrator would run. It is
 * only ever used to AVOID work (a full database snapshot), never to skip the
 * migrator, the history admission, or a required backup.
 *
 * The journal reading, the history query and the pending rule are
 * `migrationHistory.mjs`: the free path asks the same three questions, and two
 * spellings of "pending" is the defect this check exists to catch. */
export async function verifyMacMigrationHistory({ directory, env, maintenance }) {
  // The loopback refusal first, before a byte of the packaged journal is read:
  // the order this reports its two refusals in is part of its contract.
  assertLocalMigrationUrl(env, "mac_local_database_required");
  const packaged = packagedMigrations(directory);
  const applied = await withMigrationHistory(env, "mac_local_database_required", appliedMigrations);
  const result = maintenance("migration-history-admission", { schemaHash: migrationFingerprint(directory), packaged: historyRows(packaged), applied });
  if (!result.allowed) throw new Error("mac_database_history_incompatible");
  return { pending: applied.length === 0 || pendingMigrations(packaged, applied).length > 0 };
}
