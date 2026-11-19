import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isLoopbackDatabaseHost } from "./environment";

/**
 * A scratch database, created and dropped around `run`.
 *
 * Migration suites cannot run against the shared test database: they assert
 * what a migration DOES, which needs a database that has not had it yet. Each
 * one therefore needs a database of its own, and a second copy of this would
 * be a second answer to "is this URL safe to CREATE DATABASE on" — the loopback
 * check below is the whole guard, and it must have exactly one home.
 *
 * Not a `.test.ts`: vitest collects those, and a file of helpers with no cases
 * fails the run it is meant to support.
 */
export async function disposableDatabase<T>(
  prefix: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const owner = process.env.ENGAGER_MIGRATE_DATABASE_URL;
  if (!owner || !isLoopbackDatabaseHost(owner)) {
    throw new Error("A disposable local Postgres owner URL is required");
  }
  const database = `${prefix}_${randomUUID().replaceAll("-", "_")}`;
  const target = new URL(owner);
  target.pathname = `/${database}`;
  const server = new Client({ connectionString: owner });
  const client = new Client({ connectionString: target.toString() });
  await server.connect();
  try {
    await server.query(`CREATE DATABASE ${database}`);
    await client.connect();
    return await run(client);
  } finally {
    await client.end();
    await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await server.end();
  }
}
