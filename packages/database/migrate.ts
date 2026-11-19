/**
 * The CLI entry for `npm run db:migrate`: read the environment, hand
 * `migrateDatabase` one owner URL, print what it did. Everything that touches
 * a database lives in `./migrateDatabase.ts`, so a provisioner can migrate a
 * tenant's own database without a second process — this file is what a CLI is
 * and nothing more.
 *
 * Runs as the DB OWNER (superuser): set ENGAGER_MIGRATE_DATABASE_URL to the
 * owner connection. The app and tests connect as the non-superuser role
 * (DATABASE_URL) so RLS is actually enforced.
 */
import { fileURLToPath } from "node:url";
import { resolveDeploymentEnvironment } from "./environment";
import { migrateDatabase } from "./migrateDatabase";

try {
  (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(
    fileURLToPath(new URL("../../.env", import.meta.url)),
  );
} catch {
  /* ambient env */
}

// Migrations need owner privileges; prefer the owner URL when provided.
const configuredMigrationDatabaseUrl =
  process.env.ENGAGER_MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!configuredMigrationDatabaseUrl) {
  throw new Error("ENGAGER_MIGRATE_DATABASE_URL or DATABASE_URL is required");
}
const migrationDatabaseUrl: string = configuredMigrationDatabaseUrl;

const APP_ROLE = process.env.ENGAGER_DB_APP_ROLE ?? "engager_app";
const deploymentEnvironment = resolveDeploymentEnvironment();

await migrateDatabase({
  migrateUrl: migrationDatabaseUrl,
  environment: deploymentEnvironment,
  confirmation: process.env.ENGAGER_DATABASE_BOOTSTRAP_CONFIRM,
  ssl: process.env.ENGAGER_PG_SSL,
  appRole: APP_ROLE,
  appRolePassword: process.env.ENGAGER_DB_APP_ROLE_PASSWORD || undefined,
});

// eslint-disable-next-line no-console
console.log(
  `migrations applied for ${deploymentEnvironment} + RLS enforced + ${APP_ROLE} granted + concurrent indexes built + message-send withdraw trigger installed`,
);
