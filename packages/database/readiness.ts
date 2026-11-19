import { pool } from "./client";
import {
  assertDeploymentEnvironmentMatch,
  isHostedRuntimeEnvironment,
  resolveDeploymentEnvironment,
} from "./environment";

export type DatabaseRuntimeReadiness =
  | { mode: "configured" }
  | { mode: "disabled" }
  | { mode: "invalid"; reason: string };

type ReadinessQueryResult = {
  rows?: Array<{
    rolsuper?: boolean;
    rolbypassrls?: boolean;
    environment?: string | null;
  }>;
};

export type DatabaseReadinessClient = {
  query(config: {
    text: string;
    query_timeout: number;
  }): Promise<ReadinessQueryResult>;
};

const DEFAULT_READINESS_TIMEOUT_MS = 3_000;

function readinessTimeout(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.ENGAGER_DB_READINESS_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_READINESS_TIMEOUT_MS;
  return Math.min(10_000, Math.max(250, Math.trunc(configured)));
}

/**
 * A bounded hosted-runtime database check. It proves all three prerequisites
 * before a service is declared ready: Postgres is reachable, the application
 * role cannot bypass FORCE RLS, and the database's immutable environment marker
 * matches this process. Local/test stays dependency-free by design.
 */
export async function databaseRuntimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
  client: DatabaseReadinessClient = pool,
): Promise<DatabaseRuntimeReadiness> {
  let deployment: ReturnType<typeof resolveDeploymentEnvironment>;
  try {
    deployment = resolveDeploymentEnvironment(env);
  } catch (error) {
    return {
      mode: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "Invalid deployment environment",
    };
  }
  const hosted = isHostedRuntimeEnvironment(env);
  if (!hosted) {
    return { mode: "disabled" };
  }
  if (deployment !== "dev" && deployment !== "prod") {
    return {
      mode: "invalid",
      reason: "ENGAGER_DEPLOYMENT_ENV must be dev or prod on a hosted platform",
    };
  }

  const timeoutMs = readinessTimeout(env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = client.query({
      text: `
        select
          r.rolsuper,
          r.rolbypassrls,
          metadata.environment
        from pg_roles r
        left join deployment_metadata metadata
          on metadata.id = 'runtime_environment'
        where r.rolname = current_user
      `,
      query_timeout: timeoutMs,
    });
    const bounded = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("database readiness timed out")),
        timeoutMs,
      );
      timer.unref?.();
    });
    const result = await Promise.race([query, bounded]);
    const row = result.rows?.[0];
    if (!row) {
      return {
        mode: "invalid",
        reason: "Hosted database readiness could not identify the application role",
      };
    }
    if (row.rolsuper || row.rolbypassrls) {
      return {
        mode: "invalid",
        reason:
          "Hosted DATABASE_URL must use a non-superuser, non-BYPASSRLS application role",
      };
    }
    try {
      assertDeploymentEnvironmentMatch(row.environment, deployment);
    } catch (error) {
      return {
        mode: "invalid",
        reason:
          error instanceof Error
            ? error.message
            : "Hosted database environment marker is invalid",
      };
    }
    return { mode: "configured" };
  } catch {
    // Provider errors can contain credentials, hostnames, or SQL fragments.
    // Readiness is public, so expose a stable operator-safe failure only.
    return {
      mode: "invalid",
      reason: "Hosted database readiness check failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
