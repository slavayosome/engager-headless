import type { PoolConfig } from "pg";
import { resolveDeploymentEnvironment } from "./environment";

const SSL_OVERRIDE_QUERY_PARAMS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "uselibpqcompat",
] as const;

/**
 * Every non-loopback Postgres must authenticate the server certificate — hosted
 * dev/prod and a cloud tenant's own database alike. Disabling validation
 * encrypts bytes but still permits an active network attacker to impersonate
 * the database and read or alter tenant data. Local plaintext remains the
 * explicit `ENGAGER_PG_SSL=false` mode.
 */
export function pgSslConfig(
  enabled = process.env.ENGAGER_PG_SSL,
): PoolConfig["ssl"] {
  return enabled === "true" ? { rejectUnauthorized: true } : undefined;
}

/**
 * node-postgres parses `connectionString` after the explicit Pool options, so URL
 * parameters such as `sslmode=no-verify` can otherwise replace the secure `ssl`
 * object. In hosted TLS mode, remove every URL-level SSL override and make the
 * verified Pool option the single authority. Other parameters (for example Neon
 * channel binding and application_name) remain intact.
 */
export function pgConnectionSecurityConfig(
  connectionString = process.env.DATABASE_URL,
  enabled = process.env.ENGAGER_PG_SSL,
  deploymentEnvironment = resolveDeploymentEnvironment(),
): Pick<PoolConfig, "connectionString" | "ssl"> {
  if (
    (deploymentEnvironment === "dev" ||
      deploymentEnvironment === "prod" ||
      deploymentEnvironment === "cloud") &&
    enabled !== "true"
  ) {
    throw new Error(
      `ENGAGER_PG_SSL=true is required when ENGAGER_DEPLOYMENT_ENV=${deploymentEnvironment}`,
    );
  }
  if (enabled !== "true" || !connectionString) {
    return { connectionString, ssl: pgSslConfig(enabled) };
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid Postgres URL when ENGAGER_PG_SSL=true",
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      "DATABASE_URL must use postgres:// or postgresql:// when ENGAGER_PG_SSL=true",
    );
  }
  for (const parameter of SSL_OVERRIDE_QUERY_PARAMS) {
    url.searchParams.delete(parameter);
  }
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
  };
}
