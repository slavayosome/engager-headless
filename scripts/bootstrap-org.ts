// Standalone entry for `engager init`: bootstrap the single local org + owner
// and print the result as one JSON line on stdout (the CLI parses it and
// writes ENGAGER_ORG_ID into the env file). Local/test/cloud only — a cloud
// tenant is the same single org on a remote database, so the provisioner mints
// it through the entry the laptop uses. HOSTED org creation goes through the
// product's own signup, never through this script.
try {
  process.loadEnvFile?.(".env");
} catch {
  /* ambient env */
}

const { resolveDeploymentEnvironment } = await import(
  "@engager/database/environment"
);
const environment = resolveDeploymentEnvironment();
if (
  environment !== "local" &&
  environment !== "test" &&
  environment !== "cloud"
) {
  console.error(
    `bootstrap-org: refusing to run against a "${environment}" deployment — local/test/cloud only.`,
  );
  process.exit(1);
}

const { db, pool } = await import("@engager/database");
const { bootstrapLocalOrg } = await import(
  "@engager/database/bootstrap-local-org"
);
const { connectorBindingForDriverName } = await import(
  "@engager/core/connector/binding"
);

// The driver the env `engager init` just wrote selects, as the binding it
// means, stated on the row this mints — one of the two moments the system
// writes a channel row, so it is one of the two moments the binding can be
// captured without a probe. A driver that binds to nothing (mock, unset) says
// nothing and leaves the column default.
const connector = connectorBindingForDriverName(
  process.env.ENGAGER_DRIVER ?? "",
);

try {
  const result = await bootstrapLocalOrg(db, {
    ...(process.env.ENGAGER_ORG_ID
      ? { organizationId: process.env.ENGAGER_ORG_ID }
      : {}),
    ...(connector ? { connector } : {}),
  });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}

export {}; // mark as a module so top-level await typechecks (TS1375)
