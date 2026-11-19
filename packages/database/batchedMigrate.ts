import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import { NodePgSession, type NodePgClient } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  isOnboardingMergeInventory,
  isReleasedMainMigrationFork,
  RELEASED_DISPATCHER_MIGRATION,
} from "./onboardingMigrationFork";

/**
 * Keep Drizzle's migration transaction, journal and ordering, while sending one
 * SQL batch per migration file instead of one round trip per statement marker.
 * PostgreSQL's simple query protocol accepts these parameter-free statements in
 * order; newline-delimited semicolons retain both statement and trailing
 * line-comment boundaries, including files whose chunks omit a final semicolon.
 * The canonical file hash and timestamp are unchanged. This does not batch the
 * journal insert or replace the guarded caller's RLS/grants/readiness installer.
 *
 * On the merged inventory, an existing database's upgrade is applied here, in
 * one transaction under one advisory lock, rather than left to Drizzle: Drizzle
 * reads the newest receipt before it opens its own transaction, so two
 * upgrades that both get past it would both apply the same migration. Under
 * the lock a history that is a prefix of the canonical one is continued, and
 * the exact released-main history is first reconciled (its missing onboarding
 * migrations applied, its dispatcher receipt moved to the merged slot). Any
 * other history is refused. A fresh database, or another inventory, goes to
 * Drizzle as before.
 */
export async function migrate(
  db: { $client: NodePgClient },
  config: MigrationConfig,
): Promise<void> {
  const migrations = readMigrationFiles(config).map((migration) => ({
    ...migration,
    sql: [migration.sql.join("\n;\n")],
  }));
  const dialect = new PgDialect();
  const session = new NodePgSession<
    Record<string, never>,
    Record<string, never>
  >(db.$client, dialect, undefined);
  const packaged = migrations.map((migration) => ({
    hash: migration.hash,
    created_at: migration.folderMillis,
  }));
  if (isOnboardingMergeInventory(packaged)) {
    // PostgreSQL quotes both configuration values; Drizzle must never treat
    // a runtime string as an identifier without escaping it.
    const named = await session.execute<{ rows: { name: string }[] }>(
      sql`select format('%I.%I', ${config.migrationsSchema ?? "drizzle"}::text, ${config.migrationsTable ?? "__drizzle_migrations"}::text) as name`,
    );
    const tableName = named.rows[0]!.name;
    const table = sql.raw(tableName);
    const exists = await session.execute<{ rows: { name: string | null }[] }>(
      sql`select to_regclass(${tableName}) as name`,
    );
    if (exists.rows[0]?.name) {
      await session.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('engager-migration-upgrade', 0))`,
        );
        const result = await tx.execute<{ hash: string; created_at: string }>(
          sql`select hash, created_at from ${table} order by created_at`,
        );
        const applied = result.rows.map((row) => ({
          hash: row.hash,
          created_at: Number(row.created_at),
        }));
        const canonicalPrefix =
          applied.length <= packaged.length &&
          applied.every(
            (row, index) =>
              row.hash === packaged[index]?.hash &&
              row.created_at === packaged[index]?.created_at,
          );
        let applyFrom = applied.length;
        if (!canonicalPrefix) {
          if (!isReleasedMainMigrationFork(packaged, applied))
            throw new Error("migration_history_unrecognized");
          // Drizzle's timestamp shortcut would skip Terms/payment columns and run
          // the dispatcher twice. Apply the missing branch in this transaction,
          // then move the already-applied dispatcher receipt to its merged slot.
          for (const migration of migrations.slice(257, 267)) {
            await tx.execute(sql.raw(migration.sql.join("\n;\n")));
            await tx.execute(
              sql`insert into ${table} (hash, created_at) values (${migration.hash}, ${migration.folderMillis})`,
            );
          }
          await tx.execute(sql`update ${table} set created_at = ${packaged[267]!.created_at}
            where hash = ${RELEASED_DISPATCHER_MIGRATION.hash} and created_at = ${RELEASED_DISPATCHER_MIGRATION.created_at}`);
          applyFrom = 268;
        }
        // Whatever the history lacks is applied under the same lock.
        for (const migration of migrations.slice(applyFrom)) {
          for (const statement of migration.sql) await tx.execute(sql.raw(statement));
          await tx.execute(
            sql`insert into ${table} (hash, created_at) values (${migration.hash}, ${migration.folderMillis})`,
          );
        }
      });
    }
  }
  await dialect.migrate(migrations, session, config);
}
