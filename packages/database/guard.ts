import { sql } from "drizzle-orm";
import { db } from "./client";
import {
  assertDeploymentEnvironmentMatch,
  resolveDeploymentEnvironment,
} from "./environment";

let checked = false;

export const PHASE1B_SCHEMA_UNAVAILABLE_MESSAGE =
  "Engager is finishing a server update. Try again shortly.";

type SchemaReadinessResult = {
  rows?: Array<{ ready?: boolean }>;
};

/**
 * Build a readiness checker that caches only a positive result. A deployment
 * can observe the old schema while an additive migration is still running, so
 * a negative result must be rechecked on the next request rather than pinning
 * the process in an unavailable state until its next cold start.
 */
export function createSchemaReadinessChecker(
  query: () => Promise<unknown>,
): () => Promise<boolean> {
  let ready = false;
  return async () => {
    if (ready) return true;
    try {
      const result = (await query()) as SchemaReadinessResult;
      ready = result.rows?.[0]?.ready === true;
      return ready;
    } catch {
      // A transient database failure is indistinguishable from an incomplete
      // migration to callers: fail closed, but let the next request recheck.
      return false;
    }
  };
}

/** Backward-compatible name retained for the Phase 1B contract tests. */
export const createPhase1bSchemaReadinessChecker = createSchemaReadinessChecker;

const checkPhase1bSchemaReadiness = createSchemaReadinessChecker(() =>
  db.execute(sql`
    select (
      to_regclass('public.billing_checkout_claims') is not null
      and to_regclass('public.subscriptions_active_org_uidx') is not null
      and coalesce(has_table_privilege(
        current_user,
        to_regclass('public.billing_checkout_claims'),
        'SELECT'
      ), false)
      and coalesce(has_table_privilege(
        current_user,
        to_regclass('public.billing_checkout_claims'),
        'INSERT'
      ), false)
      and coalesce(has_table_privilege(
        current_user,
        to_regclass('public.billing_checkout_claims'),
        'UPDATE'
      ), false)
      and coalesce(has_table_privilege(
        current_user,
        to_regclass('public.billing_checkout_claims'),
        'DELETE'
      ), false)
    ) as ready
  `),
);

/** Phase 1B expand-migration capability used by independently deployed apps. */
export async function isPhase1bSchemaReady(): Promise<boolean> {
  return checkPhase1bSchemaReadiness();
}

export class Phase1bSchemaUnavailableError extends Error {
  readonly code = "phase1b_schema_unavailable";

  constructor() {
    super(PHASE1B_SCHEMA_UNAVAILABLE_MESSAGE);
    this.name = "Phase1bSchemaUnavailableError";
  }
}

export async function assertPhase1bSchemaReady(): Promise<void> {
  if (!(await isPhase1bSchemaReady())) {
    throw new Phase1bSchemaUnavailableError();
  }
}

/**
 * Assert both halves of tenant isolation before serving data:
 *  - the runtime role can be constrained by `FORCE` RLS; and
 *  - the runtime environment matches the immutable marker in this database.
 *
 * Either attribute silently turns off tenant isolation: every tenant's rows become
 * visible with no error — the single most dangerous misconfiguration in this app.
 * (This is not hypothetical: a dev env was once pointed at Neon's `neondb_owner`, which
 * is `rolsuper=false` but `rolbypassrls=true`, so a superuser-only check let it through
 * and tenants saw each other's data.) Call once at the start of any process/route that
 * serves tenant data; throws on a bypassing connection. Cached after the first success.
 */
export async function assertNonSuperuserRole(connection: Pick<typeof db, "execute"> = db): Promise<void> {
  if (connection === db && checked) return;
  const res = (await connection.execute(
    sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
  )) as unknown as { rows?: { rolsuper?: boolean; rolbypassrls?: boolean }[] };
  const row = res.rows?.[0];
  const isSuper = row?.rolsuper ?? false;
  const bypassesRls = row?.rolbypassrls ?? false;
  if (isSuper || bypassesRls) {
    throw new Error(
      `Refusing to serve tenant data: DATABASE_URL connects as a role that bypasses ` +
        `FORCE RLS (rolsuper=${isSuper}, rolbypassrls=${bypassesRls}) — cross-tenant leak. ` +
        `Connect as the non-superuser, non-BYPASSRLS engager_app role instead.`,
    );
  }

  const marker = (await connection.execute(
    sql`select environment from public.deployment_metadata where id = 'runtime_environment'`,
  )) as unknown as { rows?: { environment?: string }[] };
  assertDeploymentEnvironmentMatch(
    marker.rows?.[0]?.environment,
    resolveDeploymentEnvironment(),
  );
  if (connection === db) checked = true;
}
