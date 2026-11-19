/**
 * Read-only hosted migration preflight.
 *
 * Requires the operator-confirmed target fingerprint before a hosted migration
 * can mutate anything. If Phase 1A already created the marker table, an existing
 * marker must also match. The post-migration bootstrap remains the only writer.
 */
import { sql } from "drizzle-orm";

try {
  (
    process as unknown as { loadEnvFile?: (path: string) => void }
  ).loadEnvFile?.(".env");
} catch {
  /* ambient env */
}

const ownerUrl = process.env.ENGAGER_MIGRATE_DATABASE_URL;
if (!ownerUrl) {
  throw new Error(
    "ENGAGER_MIGRATE_DATABASE_URL is required for environment preflight.",
  );
}
process.env.DATABASE_URL = ownerUrl;

const {
  assertDeploymentEnvironmentMatch,
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
    `Environment preflight is only for remote dev/prod/cloud databases; received ${environment}.`,
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
    // eslint-disable-next-line no-console
    console.log(`database migration target confirmed: ${fingerprint}`);
  } else {
    const existing = (await db.execute(sql`
      select environment from public.deployment_metadata where id = 'runtime_environment'
    `)) as unknown as { rows?: { environment?: string }[] };
    const marker = existing.rows?.[0]?.environment;
    if (marker) assertDeploymentEnvironmentMatch(marker, environment);
    // eslint-disable-next-line no-console
    console.log(
      marker
        ? `database environment verified: ${fingerprint}`
        : `database migration target confirmed: ${fingerprint}`,
    );
  }
} finally {
  await pool.end();
}
