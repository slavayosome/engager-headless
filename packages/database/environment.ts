/**
 * `cloud` is the owner's own install on a remote tenant database: the local
 * setup contract with hosted database hygiene. It is reachable ONLY from an
 * explicit ENGAGER_DEPLOYMENT_ENV — never inferred from Vercel or NODE_ENV —
 * and it is neither hosted nor local, so every module wanting local-like
 * behaviour under it names `cloud` itself rather than widening a predicate.
 */
export const DEPLOYMENT_ENVIRONMENTS = [
  "local",
  "test",
  "dev",
  "prod",
  "cloud",
] as const;

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

const DATABASE_IDENTITY_OVERRIDE_PARAMS = new Set([
  // node-postgres / pg-connection-string uses these query parameters in
  // preference to the URI authority. A fingerprint derived from URL.hostname
  // would therefore confirm one server while the client connects to another.
  "connectionstring",
  "database",
  "dbname",
  "host",
  "hostaddr",
  "options",
  "port",
  "service",
  "servicefile",
  "target_session_attrs",
  "user",
]);

type DatabaseIdentity = {
  hostname: string;
  port: string;
  database: string;
};

/**
 * Parse only canonical PostgreSQL URIs. Benign transport parameters such as
 * sslmode remain allowed, but query-string fields that can replace or reroute
 * the URI identity are rejected instead of being interpreted differently by
 * this guard and node-postgres.
 */
function canonicalDatabaseIdentity(
  databaseUrl: string,
  label: string,
): DatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${label} must use postgres:// or postgresql://.`);
  }

  for (const [parameter] of parsed.searchParams) {
    if (DATABASE_IDENTITY_OVERRIDE_PARAMS.has(parameter.toLowerCase())) {
      throw new Error(
        `${label} must encode database identity in the URI authority/path; ` +
          `query parameter "${parameter}" can override or reroute the PostgreSQL target.`,
      );
    }
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database) {
    throw new Error(`${label} must include a hostname and database name.`);
  }
  return {
    hostname: parsed.hostname,
    port: parsed.port || "5432",
    database,
  };
}

function isDeploymentEnvironment(
  value: string,
): value is DeploymentEnvironment {
  return (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Resolve the runtime environment without trusting a mutable application setting
 * by itself. Hosted runtimes should set ENGAGER_DEPLOYMENT_ENV explicitly. On
 * Vercel, production requires the exact main ref; previews and every non-main ref
 * are dev. A Vercel production marker without a Git ref is ambiguous because both
 * Engager's dev and prod projects use it, so it fails closed.
 */
export function resolveDeploymentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentEnvironment {
  const configuredValue = env.ENGAGER_DEPLOYMENT_ENV?.trim();
  let configured: DeploymentEnvironment | undefined;
  if (configuredValue) {
    if (!isDeploymentEnvironment(configuredValue)) {
      throw new Error(
        `Invalid ENGAGER_DEPLOYMENT_ENV "${configuredValue}"; expected one of ${DEPLOYMENT_ENVIRONMENTS.join(", ")}.`,
      );
    }
    configured = configuredValue;
  }

  const vercelEnvironment = env.VERCEL_ENV?.trim();
  const gitRef = env.VERCEL_GIT_COMMIT_REF?.trim();
  const isVercelRuntime =
    env.VERCEL === "1" || Boolean(vercelEnvironment) || Boolean(gitRef);
  if (
    vercelEnvironment &&
    vercelEnvironment !== "production" &&
    vercelEnvironment !== "preview" &&
    vercelEnvironment !== "development"
  ) {
    throw new Error(
      `Invalid VERCEL_ENV "${vercelEnvironment}"; expected production, preview, or development.`,
    );
  }
  if (
    isVercelRuntime &&
    !gitRef &&
    vercelEnvironment !== "preview" &&
    vercelEnvironment !== "development"
  ) {
    throw new Error(
      "Refusing to resolve a Vercel deployment without " +
        'VERCEL_GIT_COMMIT_REF; dev and prod projects are ambiguous, and production requires exact ref "main".',
    );
  }

  const vercelDeploymentEnvironment: "dev" | "prod" | undefined =
    vercelEnvironment === "preview" || vercelEnvironment === "development"
      ? "dev"
      : gitRef
        ? gitRef === "main"
          ? "prod"
          : "dev"
        : undefined;

  if (configured) {
    if (
      vercelDeploymentEnvironment &&
      configured !== vercelDeploymentEnvironment
    ) {
      throw new Error(
        `ENGAGER_DEPLOYMENT_ENV "${configured}" conflicts with Vercel deployment evidence ` +
          `(VERCEL_ENV="${vercelEnvironment ?? "unset"}", ` +
          `VERCEL_GIT_COMMIT_REF="${gitRef ?? "unset"}"); expected "${vercelDeploymentEnvironment}".`,
      );
    }
    return configured;
  }

  if (vercelDeploymentEnvironment) return vercelDeploymentEnvironment;
  if (env.NODE_ENV === "test") return "test";
  return "local";
}

/**
 * Local-first single-org runtimes (local/test): the setup contract completes
 * without hosted billing. Anything unresolvable, and
 * every hosted platform marker, stays false — fail toward hosted strictness.
 *
 * `cloud` is deliberately NOT here. Widening this would hand a tenant runtime
 * the local arm of a dozen readers that were never audited for a remote
 * database; the modules that genuinely want local-like behaviour under `cloud`
 * name it themselves.
 */
export function isLocalDeployment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    if (isHostedRuntimeEnvironment(env)) return false;
    const deployment = resolveDeploymentEnvironment(env);
    return deployment === "local" || deployment === "test";
  } catch {
    return false;
  }
}

/**
 * True when either the explicit Engager environment or an immutable hosted
 * platform marker says this process is deployed. An explicit local/test label
 * cannot disguise a Vercel release and bypass hosted readiness checks.
 *
 * A `cloud` tenant answers false: it is the owner's runtime on their own
 * database, not a hosted Engager service, so hosted readiness, hosted email
 * delivery and the hosted release-marker contract are all off for it.
 */
export function isHostedRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const deployment = resolveDeploymentEnvironment(env);
  if (deployment === "dev" || deployment === "prod") return true;
  if (
    env.VERCEL_GIT_COMMIT_REF === "main" ||
    env.VERCEL_GIT_COMMIT_REF === "develop"
  ) {
    return true;
  }
  return env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
}

export function assertDeploymentEnvironmentMatch(
  actual: string | null | undefined,
  expected: DeploymentEnvironment,
): void {
  if (!actual) {
    throw new Error(
      "Refusing to serve tenant data: the database has no deployment environment marker. Run the guarded migration first.",
    );
  }
  if (actual !== expected) {
    throw new Error(
      `Refusing to serve tenant data: runtime environment ${expected} does not match database environment ${actual}.`,
    );
  }
}

/**
 * Is this URL's server the machine we are already on? The question two
 * different guards ask of one URL: the migration target refusal below, and any
 * caller holding TWO urls at once (`copy-org.ts`), for which the process env
 * cannot answer — a loopback Postgres has no certificate to verify, whatever
 * the deployment says about the remote end of the same copy.
 */
export function isLoopbackDatabaseHost(
  databaseUrl: string,
  label = "Database URL",
): boolean {
  const identity = canonicalDatabaseIdentity(databaseUrl, label);
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(identity.hostname);
}

/**
 * Local/test self-initialization is safe only for a loopback database. A hosted
 * owner URL must carry an explicit dev/prod declaration; Vercel or NODE_ENV
 * inference is not strong enough authorization for a one-way migration. A
 * `cloud` tenant database is remote too, and asks for one thing more: the exact
 * non-secret fingerprint, so a process may only migrate the database it can
 * already name. `local` and `test` keep the unconditional non-loopback refusal
 * — a supplied confirmation must not buy them anything, because that refusal is
 * what stands between a laptop and someone else's remote database.
 */
export function assertMigrationTargetIsSafe(
  environment: DeploymentEnvironment,
  databaseUrl: string,
  configuredEnvironment: string | undefined,
  confirmation?: string | undefined,
): void {
  if (isLoopbackDatabaseHost(databaseUrl, "Migration database URL")) return;

  const explicit = configuredEnvironment?.trim();
  if (environment === "cloud") {
    if (explicit !== "cloud") {
      throw new Error(
        "Refusing to migrate a non-loopback database without ENGAGER_DEPLOYMENT_ENV explicitly set to cloud.",
      );
    }
    assertHostedDatabaseFingerprintConfirmation(
      environment,
      databaseUrl,
      confirmation,
    );
    return;
  }
  if ((explicit !== "dev" && explicit !== "prod") || environment !== explicit) {
    throw new Error(
      "Refusing to migrate a non-loopback database without ENGAGER_DEPLOYMENT_ENV explicitly set to dev or prod.",
    );
  }
}

/**
 * Non-secret database identity shown to an operator before the one-time hosted
 * environment bootstrap. Requiring this exact value prevents a copied command
 * from silently claiming whichever database URL happens to be in the shell.
 */
export function deploymentEnvironmentFingerprint(
  environment: DeploymentEnvironment,
  databaseUrl: string,
): string {
  const identity = canonicalDatabaseIdentity(
    databaseUrl,
    "ENGAGER_MIGRATE_DATABASE_URL",
  );
  return `${environment}@${identity.hostname}:${identity.port}/${identity.database}`;
}

/**
 * Which environments may only touch a remote database they can already name.
 * The three that live on one: hosted dev and prod, and a cloud tenant.
 */
export function requiresDatabaseFingerprintConfirmation(
  environment: DeploymentEnvironment,
): boolean {
  return (
    environment === "dev" || environment === "prod" || environment === "cloud"
  );
}

/**
 * Require a human-confirmed remote database identity before the one-time
 * unmarked migration and marker bootstrap. Keeping this check shared
 * prevents the read-only preflight, migrator, and marker writer from drifting
 * into three subtly different trust decisions.
 */
export function assertHostedDatabaseFingerprintConfirmation(
  environment: DeploymentEnvironment,
  databaseUrl: string,
  confirmation: string | undefined,
): string {
  if (!requiresDatabaseFingerprintConfirmation(environment)) {
    throw new Error(
      `Hosted database confirmation requires dev, prod, or cloud; received ${environment}.`,
    );
  }
  const fingerprint = deploymentEnvironmentFingerprint(
    environment,
    databaseUrl,
  );
  if (confirmation?.trim() !== fingerprint) {
    throw new Error(
      `Refusing hosted database operation. Set ENGAGER_DATABASE_BOOTSTRAP_CONFIRM=${fingerprint}`,
    );
  }
  return fingerprint;
}
