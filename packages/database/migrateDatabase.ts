/**
 * Apply migrations + RLS + app-role grants against ONE database, as a
 * function. Runs as that database's OWNER (superuser): `migrateUrl` is the
 * owner connection, while the app and tests connect as the non-superuser role
 * so RLS is actually enforced.
 *
 * Extracted from `migrate.ts`, which stays what it always was — a CLI entry
 * reading `process.env` — because a provisioner that must migrate a DIFFERENT
 * database per tenant cannot call a script whose one target was frozen at
 * import time.
 *
 * ⚠️ This function reads NOTHING from the caller's process env. The
 * environment label, the SSL flag and the fingerprint confirmation are all
 * arguments: in the cloud app's Vercel process `ENGAGER_DEPLOYMENT_ENV` is
 * `prod`, and reading it here would refuse every tenant migration. Every guard
 * `migrate.ts` carried is otherwise unchanged, including the refusal of a
 * non-loopback host whose label is not exactly `dev`, `prod` or `cloud`.
 *
 * ⚠️ THE FUNCTION OWNS ITS POOL. The predecessor set
 * `process.env.DATABASE_URL` and let `./client`'s singleton build itself on
 * the owner URL — a trick that works exactly once per process. Nothing here
 * touches that singleton, which is precisely what makes a second call against
 * a second tenant's URL possible.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "./batchedMigrate";
import { Pool, type PoolClient } from "pg";
import { applyConcurrentMigrationMaintenance, concurrentFinalisationInputs, prepareCandidateFeedbackMutationIds } from "./concurrent-indexes";
import {
  assertDeploymentEnvironmentMatch,
  assertHostedDatabaseFingerprintConfirmation,
  assertMigrationTargetIsSafe,
  requiresDatabaseFingerprintConfirmation,
  type DeploymentEnvironment,
} from "./environment";
import { migrationDefaultPrivilegeFirewallStatements } from "./migration-privileges";
import { pgConnectionSecurityConfig } from "./poolConfig";
import { applyRls, RLS_TABLES, rlsStatementsForTable } from "./rls";
import * as schema from "./schema";
import { applyTriggers, triggerFinalisationInputs } from "./triggers";

export type MigrateDatabaseOptions = {
  /** Server bundles provide their traced asset directory; CLI bundles keep assets beside them. */
  migrationsFolder?: string;
  /** The owner connection for the database to migrate — the ONLY target. */
  migrateUrl: string;
  /** The label this caller vouches for; the argument IS the intent. */
  environment: DeploymentEnvironment;
  /** `deploymentEnvironmentFingerprint` for THIS url and no other. */
  confirmation?: string;
  /** The SSL flag for THIS url: the CLI passes `ENGAGER_PG_SSL`, a
   *  provisioner migrating a remote tenant passes `"true"`. */
  ssl?: string;
  appRole?: string;
  /** Set on the app role as it is ensured. A tenant's app role is created by
   *  this function and by nothing else, so this is the only moment it exists
   *  without a password to connect with. */
  appRolePassword?: string;
};

export async function migrateDatabase(
  opts: MigrateDatabaseOptions,
): Promise<void> {
  const migrationDatabaseUrl = opts.migrateUrl;
  const deploymentEnvironment = opts.environment;
  const APP_ROLE = opts.appRole ?? "engager_app";
  if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) {
    throw new Error(
      "ENGAGER_DB_APP_ROLE must be a safe unquoted Postgres identifier",
    );
  }
  // Interpolated into an owner-level ALTER ROLE, so it is admitted by shape
  // rather than escaped: the provisioner generates this value, and a password
  // that cannot survive this class is one it must not have minted.
  if (
    opts.appRolePassword !== undefined &&
    !/^[A-Za-z0-9_-]{16,128}$/.test(opts.appRolePassword)
  ) {
    throw new Error(
      "The app role password must be 16-128 characters of [A-Za-z0-9_-]",
    );
  }
  assertMigrationTargetIsSafe(
    deploymentEnvironment,
    migrationDatabaseUrl,
    deploymentEnvironment,
    opts.confirmation,
  );

  const pool = new Pool({
    ...pgConnectionSecurityConfig(
      migrationDatabaseUrl,
      opts.ssl,
      deploymentEnvironment,
    ),
    keepAlive: true,
  });
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end();
    throw error;
  }
  const db = drizzle(client, { schema });

  async function prepareMigrationDefaultPrivileges(): Promise<void> {
    await db.transaction(async (tx) => {
      const current = (await tx.execute(sql`
        select current_user as current_user
      `)) as unknown as { rows?: { current_user?: string }[] };
      if (current.rows?.[0]?.current_user === APP_ROLE) {
        throw new Error(
          "ENGAGER_MIGRATE_DATABASE_URL must use the owner role, not the runtime app role",
        );
      }
      await tx.execute(
        sql.raw(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}') ` +
            `THEN CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER; END IF; END $$`,
        ),
      );
      // A tenant's app role is minted by the statement above and connects over
      // the network afterwards, so the password it will present is set here,
      // in the same transaction that ensures the role.
      if (opts.appRolePassword !== undefined) {
        await tx.execute(
          sql.raw(
            `ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${opts.appRolePassword}'`,
          ),
        );
      }
      for (const statement of migrationDefaultPrivilegeFirewallStatements(
        APP_ROLE,
      )) {
        await tx.execute(sql.raw(statement));
      }
    });
  }

  /**
   * The oldest Postgres the schema can be created on. Migration 0122 declares
   * `UNIQUE NULLS NOT DISTINCT` on `channels`, which is PG 15 syntax — on 14 the
   * server answers `syntax error at or near "NULLS"`, several hundred statements
   * into a migration run, which reads as a corrupt migration rather than an
   * unsupported server. Fail up front and say which.
   */
  const MINIMUM_POSTGRES_VERSION_NUM = 150_000;

  async function assertSupportedPostgresVersion(): Promise<void> {
    const [row] = (
      await db.execute<{ version_num: string; version: string }>(
        sql`select current_setting('server_version_num') as version_num, version() as version`,
      )
    ).rows;
    const versionNum = Number(row?.version_num ?? 0);
    if (versionNum >= MINIMUM_POSTGRES_VERSION_NUM) return;
    throw new Error(
      `Engager requires PostgreSQL 15 or newer; this server is ` +
        `${row?.version ?? "an unknown version"}. The schema uses ` +
        `UNIQUE ... NULLS NOT DISTINCT (PostgreSQL 15+). Point ` +
        `ENGAGER_MIGRATE_DATABASE_URL at a 15+ server, or upgrade this one.`,
    );
  }

  /**
   * Two questions this used to conflate. WHICH DATABASE may this process name:
   * dev, prod and cloud all live on a remote one and must re-prove its exact
   * non-secret identity here, since a workflow preflight cannot authorize a
   * different URL handed to this process. WHO CLAIMS THE MARKER: only dev and
   * prod reserve that for the separate bootstrap command, because a hosted
   * database has an operator standing between the two. Local and test databases
   * are disposable and self-initialize; a cloud tenant self-initializes too — no
   * operator stands between migrate and bootstrap there, and the confirmation it
   * just produced IS the authorization.
   */
  async function assertOrInitializeDeploymentEnvironment(): Promise<void> {
    const hosted =
      deploymentEnvironment === "dev" || deploymentEnvironment === "prod";
    if (requiresDatabaseFingerprintConfirmation(deploymentEnvironment)) {
      assertHostedDatabaseFingerprintConfirmation(
        deploymentEnvironment,
        migrationDatabaseUrl,
        opts.confirmation,
      );
    }
    const table = (await db.execute(sql`
      select to_regclass('public.deployment_metadata')::text as table_name
    `)) as unknown as { rows?: { table_name?: string | null }[] };
    if (!table.rows?.[0]?.table_name) {
      if (hosted) {
        // The guarded migration may create the marker table. Only the separate
        // bootstrap command is allowed to claim the runtime environment row.
        return;
      }
      await db.execute(
        sql.raw(`
        CREATE TABLE public.deployment_metadata (
          "id" text PRIMARY KEY NOT NULL,
          "environment" text NOT NULL,
          "created_at" bigint NOT NULL,
          "updated_at" bigint NOT NULL
        )
      `),
      );
    }

    const result = (await db.execute(sql`
      select environment from public.deployment_metadata where id = 'runtime_environment'
    `)) as unknown as { rows?: { environment?: string }[] };
    const existingEnvironment = result.rows?.[0]?.environment;
    if (!existingEnvironment && hosted) {
      return;
    }
    if (!existingEnvironment) {
      const now = Date.now();
      await db.execute(sql`
        insert into public.deployment_metadata (id, environment, created_at, updated_at)
        values ('runtime_environment', ${deploymentEnvironment}, ${now}, ${now})
        on conflict (id) do nothing
      `);
    }
    // Re-read after ON CONFLICT: a concurrent initializer may have won with a
    // different marker, and assuming our intended value would miss that race.
    const confirmed = (await db.execute(sql`
      select environment from public.deployment_metadata where id = 'runtime_environment'
    `)) as unknown as { rows?: { environment?: string }[] };
    assertDeploymentEnvironmentMatch(
      confirmed.rows?.[0]?.environment,
      deploymentEnvironment,
    );
  }

  async function applyGrants(): Promise<void> {
    // GRANT ON ALL intentionally widens ordinary tables before the sensitive
    // exceptions below are narrowed again. Keep that entire transition in ONE
    // PostgreSQL transaction: an interrupted deploy must expose either the old
    // privilege set or the complete new one, never strand permanent economic or
    // audit authority with UPDATE/DELETE/TRUNCATE privileges.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}') ` +
            `THEN CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER; END IF; END $$`,
        ),
      );
      for (const stmt of [
        `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
        `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
        // Read-only, and the only grant outside `public`: in client mode the
        // dashboard reads the applied migration head to detect that this
        // database is older than the build in front of it. The migrator above
        // has already created the schema and the table, so neither can be
        // missing here.
        //
        // PERMANENT, and narrow on purpose. SELECT on one bookkeeping table is
        // the whole of it -- never `ON ALL TABLES IN SCHEMA drizzle`, which
        // would hand the app role whatever drizzle adds to its own schema next.
        // The firewall below is extended to `drizzle` for exactly that reason:
        // a new object there must begin inaccessible the same way a new object
        // in `public` does, so this grant can only ever mean the one table it
        // names.
        `GRANT USAGE ON SCHEMA drizzle TO ${APP_ROLE}`,
        `GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ${APP_ROLE}`,
        ...migrationDefaultPrivilegeFirewallStatements(APP_ROLE),
        ...migrationDefaultPrivilegeFirewallStatements(APP_ROLE, "drizzle"),
        // Revoke privileges retained from older broad defaults. PostgreSQL RLS does
        // not apply to TRUNCATE, and application code never needs it.
        `REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE}`,
      ]) {
        await tx.execute(sql.raw(stmt));
      }
      // deployment_metadata is the immutable runtime trust anchor. The broad
      // table grant above is convenient for normal app tables, so narrow this one
      // back to read-only before the transaction can commit.
      await tx.execute(
        sql.raw(
          `REVOKE ALL PRIVILEGES ON TABLE public.deployment_metadata FROM ${APP_ROLE}`,
        ),
      );
      await tx.execute(
        sql.raw(
          `GRANT SELECT ON TABLE public.deployment_metadata TO ${APP_ROLE}`,
        ),
      );
      await tx.execute(sql.raw(`REVOKE ALL PRIVILEGES ON TABLE public.database_finalisation FROM ${APP_ROLE}, PUBLIC`));
      // RLS does not apply to TRUNCATE. Narrow the broad app grant after every
      // migration so even a compromised app connection cannot erase email
      // delivery receipts.
      await tx.execute(
        sql.raw(
          `REVOKE DELETE, TRUNCATE ON TABLE ` +
            `email_delivery_receipts FROM ${APP_ROLE}`,
        ),
      );
      // Owner-global trial/setup-lane claims are permanent economic authority.
      // Runtime may append or read them, but may never move a claim to another
      // job/owner or erase it to recreate an allowance in another organization.
      // State the surviving privileges explicitly after the broad grant. This is
      // both least-privilege documentation and a repair for databases whose prior
      // ACLs were narrower than the broad-grant/default-grant assumptions.
      await tx.execute(
        sql.raw(
          `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ` +
            `owner_initial_trial_claims FROM ${APP_ROLE}`,
        ),
      );
      await tx.execute(
        sql.raw(
          `GRANT SELECT, INSERT ON TABLE ` +
            `owner_initial_trial_claims TO ${APP_ROLE}`,
        ),
      );
      // Three records that advance in place and are never erased. A Mac seat
      // row IS its own audit record; deleting an active one would free a seat
      // with no trace. An offer-change intent is the fence that stops a second
      // recurring subscription, and deleting an open one would reopen the
      // unique index a lost provider response is meant to hold shut. A transfer
      // intent is the evidence that exactly one destination activated.
      await tx.execute(
        sql.raw(
          `REVOKE DELETE, TRUNCATE ON TABLE ` +
            `license_seats, commercial_offer_intents, transfer_intents FROM ${APP_ROLE}`,
        ),
      );
    });
  }

  /**
   * Columns added OUTSIDE a drizzle migration (capacity-aware discovery selection,
   * Codex #9): `scripts/backfill-reach.ts` imports `@engager/core` to backfill these,
   * but `migrate.ts` must NOT import core (one-way package dependency), so the schema
   * change is an idempotent `ADD COLUMN IF NOT EXISTS` here rather than a generated
   * migration that would couple the two. `discovered_posts` gains the reach pre-score
   * (`reach_score`/`reach_breakdown`) + the planner's lease clock (`selected_at`). The
   * new `status`/`jobs.type` enum VALUES are TS-union-only (no DB CHECK) — no DDL.
   */
  async function applyAddedColumns(): Promise<void> {
    for (const stmt of [
      `ALTER TABLE "discovered_posts" ADD COLUMN IF NOT EXISTS "reach_score" real`,
      `ALTER TABLE "discovered_posts" ADD COLUMN IF NOT EXISTS "reach_breakdown" jsonb`,
      `ALTER TABLE "discovered_posts" ADD COLUMN IF NOT EXISTS "selected_at" bigint`,
    ]) {
      await db.execute(sql.raw(stmt));
    }
  }

  try {
    await client.query("select pg_advisory_lock(hashtextextended('engager-database-finalisation', 0))");
    await assertSupportedPostgresVersion();
    await assertOrInitializeDeploymentEnvironment();
    const migrationsFolder = opts.migrationsFolder ?? join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const journalBytes = await readFile(join(migrationsFolder, "meta", "_journal.json"));
    const journal = JSON.parse(journalBytes.toString()) as { entries: { when: number }[] };
    const journalHead = journal.entries.at(-1)?.when;
    if (!journalHead) throw new Error("Migration journal has no head");
    const journalHash = createHash("sha256").update(journalBytes).digest("hex");
    const dialect = new PgDialect();
    const policySql = RLS_TABLES.flatMap((table) => rlsStatementsForTable(table).map((statement) => dialect.sqlToQuery(statement)));
    const owner = (await client.query<{ name: string }>("select current_user as name")).rows[0]!.name;
    if (owner === APP_ROLE) throw new Error("ENGAGER_MIGRATE_DATABASE_URL must use the owner role, not the runtime app role");
    const digest = createHash("sha256").update(JSON.stringify([
      APP_ROLE, owner, migrateDatabase.toString(), migrationDefaultPrivilegeFirewallStatements.toString(),
      policySql, applyRls.toString(), triggerFinalisationInputs, applyTriggers.toString(),
      concurrentFinalisationInputs, readMigrationFiles({ migrationsFolder }).map(({ hash }) => hash),
    ])).digest("hex");
    const stampTable = (await client.query("select to_regclass('public.database_finalisation') as name")).rows[0]?.name;
    const stamp = stampTable && (await client.query(
      "select journal_head, journal_hash, finalisation_digest from public.database_finalisation where id = 'current'",
    )).rows[0];
    const appliedTable = (await client.query("select to_regclass('drizzle.__drizzle_migrations') as name")).rows[0]?.name;
    const appliedHead = appliedTable && (await client.query("select max(created_at) as head from drizzle.__drizzle_migrations")).rows[0]?.head;
    const unchanged = opts.appRolePassword === undefined && stamp && Number(stamp.journal_head) === journalHead &&
      stamp.journal_hash === journalHash && stamp.finalisation_digest === digest && Number(appliedHead) === journalHead;
    if (unchanged) {
      console.log("database finalisation skipped");
      await prepareCandidateFeedbackMutationIds(client);
    } else {
      // Invalidate before any work: a failed attempt must not leave an older
      // build's stamp able to certify a partially changed database.
      if (stampTable) await client.query("delete from public.database_finalisation where id = 'current'");
      await prepareMigrationDefaultPrivileges();
      await migrate(db, { migrationsFolder });
      await applyRls(db);
      await applyGrants();
      await applyAddedColumns();
      await prepareCandidateFeedbackMutationIds(client);
      await applyConcurrentMigrationMaintenance(client);
      await applyTriggers(db);
    }
    if (!unchanged) {
      await client.query(
        "insert into public.database_finalisation (id, journal_head, journal_hash, finalisation_digest, finalised_at) values ('current', $1, $2, $3, $4) on conflict (id) do update set journal_head = excluded.journal_head, journal_hash = excluded.journal_hash, finalisation_digest = excluded.finalisation_digest, finalised_at = excluded.finalised_at",
        [journalHead, journalHash, digest, Date.now()],
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}
