import { readFileSync } from "node:fs";
import path from "node:path";
import { hash } from "./ownedFiles.mjs";

/**
 * THE migration journal, read the way Drizzle itself reads it — one place, for
 * every placement that has to answer "is this database behind the code that is
 * about to run against it".
 *
 * The Mac path asked this question on every launch (`macDatabase.mjs`); the
 * free path never asked it at all, which is how a free install could take an
 * `applied` update and keep running on the previous release's schema
 * (measured 2026-09-15: 169 applied rows under a payload packaging 174).
 * Two spellings of "pending" would be that defect waiting to come back, so
 * both callers read this module.
 */

/** The packaged entries, TIMESTAMPS ONLY: one small JSON read and no migration
 *  file opened. This is what a serving arm consults before it serves, and that
 *  arm is spawned by an owner's client on every session — hashing 174 files to
 *  answer a question about timestamps is a cost nobody asked for. */
export function packagedJournal(directory) {
  const journal = JSON.parse(readFileSync(path.join(directory, "meta/_journal.json"), "utf8"));
  return journal.entries.map((entry) => ({ tag: entry.tag, created_at: entry.when }));
}

/** The same entries with their BYTES, for the admission that compares applied
 *  history against what this payload actually ships. `tag` travels with them so
 *  a failure can be named; strip it before handing the rows to the core, which
 *  is asked about hashes and timestamps and nothing else. */
export function packagedMigrations(directory) {
  return packagedJournal(directory).map((entry) => ({
    tag: entry.tag,
    hash: hash(readFileSync(path.join(directory, `${entry.tag}.sql`))),
    created_at: entry.created_at,
  }));
}

/** The rows a core is asked to admit: hash and timestamp, nothing else. */
export const historyRows = (entries) => entries.map(({ hash, created_at }) => ({ hash, created_at }));

/** The migration URL, refused unless it names this machine. Callers that are
 *  about to read the packaged journal assert it FIRST: a URL pointing somewhere
 *  else is refused before a byte of the payload is read, which is the order the
 *  Mac path has always reported these two in. */
export function assertLocalMigrationUrl(env, refusal) {
  const url = new URL(env.ENGAGER_MIGRATE_DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error(refusal);
  return url;
}

/** Read the applied history off THIS install's own database.
 *
 *  `refusal` is the caller's own code for a migration URL that does not name a
 *  local server: the Mac path and the free path each report that in their own
 *  words, and neither may migrate something over the network. */
export async function withMigrationHistory(env, refusal, read) {
  const { default: pg } = await import("pg");
  const url = assertLocalMigrationUrl(env, refusal);
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await client.connect();
    return await read(client);
  } finally { await client.end(); }
}

/** Every row `drizzle.__drizzle_migrations` holds, oldest first. A database
 *  that has never been migrated has no such table and no history — not an
 *  error, which is what a first `init` looks like. */
export async function appliedMigrations(client) {
  const exists = await client.query("select to_regclass('drizzle.__drizzle_migrations') as name");
  return exists.rows[0].name
    ? (await client.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at, id")).rows
    : [];
}

/** The packaged entries the migrator WOULD run, by Drizzle's own rule: newer
 *  than the last applied `created_at` (`drizzle-orm/pg-core/dialect.js:59-62`).
 *  Nothing applied means everything packaged is pending. It can never claim
 *  "nothing to do" for a migration the migrator would still run. */
export function pendingMigrations(packaged, applied) {
  if (applied.length === 0) return [...packaged];
  const latest = applied.reduce((newest, row) => Math.max(newest, Number(row.created_at)), Number.NEGATIVE_INFINITY);
  return packaged.filter((entry) => Number(entry.created_at) > latest);
}

/** What `status --json` and `doctor --json` report, and what every serving arm
 *  is held to: how many migrations this database has applied, how many the
 *  payload packages, and how many of those have still to run. */
export async function migrationTriple({ directory, env, refusal }) {
  const packaged = packagedJournal(directory);
  const applied = await withMigrationHistory(env, refusal, appliedMigrations);
  return { applied: applied.length, packaged: packaged.length, pending: pendingMigrations(packaged, applied).length };
}
