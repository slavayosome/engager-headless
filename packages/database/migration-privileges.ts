const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * New database objects must begin inaccessible to the runtime role. Migrations
 * create DDL first, then apply RLS and the complete current-table grant set. If
 * the migrator dies between those phases, zero default privileges keep every
 * new table fail-closed instead of inheriting a stale broad default ACL.
 */
export function migrationDefaultPrivilegeFirewallStatements(
  appRole: string,
  schema = "public",
): string[] {
  if (!SAFE_IDENTIFIER.test(appRole)) {
    throw new Error("app role must be a safe unquoted Postgres identifier");
  }
  if (!SAFE_IDENTIFIER.test(schema)) {
    throw new Error("schema must be a safe unquoted Postgres identifier");
  }
  return [
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${appRole}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM ${appRole}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM PUBLIC`,
  ];
}
