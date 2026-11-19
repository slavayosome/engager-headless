import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import { RLS_TABLES, rlsStatementsForTable } from "../packages/database/rls";

const POLICY_MARKER = "-- Generated tenant policies from packages/database/rls.ts";
const tenantTables = new Set<string>(RLS_TABLES);

/** Drizzle describes the table shape; the existing policy registry owns its
 * tenant permissions. Generate both into one pre-commit migration. */
export function migrationWithTenantPolicies(source: string): string {
  const shape = source.split(POLICY_MARKER)[0]!.replace(/\s*--> statement-breakpoint\s*$/, "").trimEnd();
  const tables = Array.from(shape.matchAll(/CREATE TABLE "([a-z_][a-z0-9_]*)"\s*\(/g), (match) => match[1]!)
    .filter((table): table is typeof RLS_TABLES[number] => tenantTables.has(table));
  if (!tables.length) return source;
  const dialect = new PgDialect();
  const policies = tables.flatMap((table) => rlsStatementsForTable(table).map((statement) => {
    const query = dialect.sqlToQuery(statement);
    if (query.params.length) throw new Error("Migration policies must contain no runtime parameters");
    return `${query.sql};`;
  }));
  return `${shape}\n--> statement-breakpoint\n${POLICY_MARKER}\n${policies.join("\n--> statement-breakpoint\n")}\n`;
}

export function finishNewMigration(root: string, existing: ReadonlySet<string> = new Set()): string | null {
  const pending = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "packages/database/migrations"], { cwd: root, encoding: "utf8" })
    .split("\0").filter((file) => /^packages\/database\/migrations\/\d{4}_[^/]+\.sql$/.test(file) && !existing.has(file));
  if (pending.length > 1) throw new Error("More than one untracked migration exists; finish one migration at a time.");
  const file = pending[0];
  if (!file) return null;
  const path = resolve(root, file);
  const source = readFileSync(path, "utf8");
  const generated = migrationWithTenantPolicies(source);
  if (generated !== source) writeFileSync(path, generated);
  return file;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const existing = new Set(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "packages/database/migrations"], { cwd: root, encoding: "utf8" }).split("\0"));
  const result = spawnSync(process.execPath, [resolve(root, "node_modules/drizzle-kit/bin.cjs"), "generate",
    "--config=packages/database/drizzle.config.ts", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const file = finishNewMigration(root, existing);
  if (file) console.log(`Generated tenant policies: ${file}`);
}
