/**
 * One-time hosted database environment bootstrap.
 *
 * Run only after the additive deployment_metadata migration has landed. The
 * operator must confirm the non-secret target fingerprint printed by this
 * command before it will write the immutable environment marker.
 */
import { sql } from "drizzle-orm";

try {
  (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(
    ".env",
  );
} catch {
  /* ambient env */
}

const ownerUrl = process.env.ENGAGER_MIGRATE_DATABASE_URL;
if (!ownerUrl) {
  throw new Error(
    "ENGAGER_MIGRATE_DATABASE_URL is required for environment bootstrap.",
  );
}
process.env.DATABASE_URL = ownerUrl;

const {
  assertHostedDatabaseFingerprintConfirmation,
  requiresDatabaseFingerprintConfirmation,
  resolveDeploymentEnvironment,
} = await import("./environment");
if (!process.env.ENGAGER_DEPLOYMENT_ENV?.trim()) {
  throw new Error(
    "ENGAGER_DEPLOYMENT_ENV must be explicitly set to dev, prod, or cloud.",
  );
}
const environment = resolveDeploymentEnvironment();
if (!requiresDatabaseFingerprintConfirmation(environment)) {
  throw new Error(
    `Environment bootstrap is only for remote dev/prod/cloud databases; received ${environment}.`,
  );
}

const fingerprint = assertHostedDatabaseFingerprintConfirmation(
  environment,
  ownerUrl,
  process.env.ENGAGER_DATABASE_BOOTSTRAP_CONFIRM,
);

const { db, pool } = await import("./client");
try {
  const table = (await db.execute(sql`
    select to_regclass('public.deployment_metadata')::text as table_name
  `)) as unknown as { rows?: { table_name?: string | null }[] };
  if (!table.rows?.[0]?.table_name) {
    throw new Error(
      "deployment_metadata does not exist. Deploy and migrate Phase 1A before bootstrapping.",
    );
  }

  const existing = (await db.execute(sql`
    select environment from public.deployment_metadata where id = 'runtime_environment'
  `)) as unknown as { rows?: { environment?: string }[] };
  const claimed = existing.rows?.[0]?.environment;
  if (claimed && claimed !== environment) {
    throw new Error(
      `Database is already claimed as ${claimed}; refusing to relabel it as ${environment}.`,
    );
  }

  if (!claimed) {
    const now = Date.now();
    await db.execute(sql`
      insert into public.deployment_metadata (id, environment, created_at, updated_at)
      values ('runtime_environment', ${environment}, ${now}, ${now})
    `);
  }

  // eslint-disable-next-line no-console
  console.log(`database environment verified: ${fingerprint}`);
} finally {
  await pool.end();
}
