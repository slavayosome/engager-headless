import { rmSync } from "node:fs";
import path from "node:path";
import { atomicWrite, readJson } from "./ownedFiles.mjs";
import { migrationFingerprint } from "./migrationFingerprint.mjs";
import {
  appliedMigrations,
  assertLocalMigrationUrl,
  historyRows,
  migrationTriple,
  packagedJournal,
  packagedMigrations,
  pendingMigrations,
  withMigrationHistory,
} from "./migrationHistory.mjs";

/**
 * THE FREE PATH'S MIGRATOR, and the one thing an `applied` update used to be
 * missing.
 *
 * Measured 2026-09-15 on a blank fixture: a shipped 0.2.5 install updated to
 * the current archive answered `applied`, reported `0.2.6`, said `core:
 * usable`, answered `get_status` and started its agent — and
 * `drizzle.__drizzle_migrations` still held the 0.2.5 journal's 169 rows under
 * a payload packaging 174. `init` was the only place `dist/migrate.mjs` ever
 * ran. Nothing migrated, and nothing noticed.
 *
 * The Mac path never had this: `finishMacUpdate` runs the packaged migrator on
 * every launch, behind the same history admission.
 */

/** The migrations a payload directory ships — `<payload>/cli/dist/migrations`,
 *  the tree `packages/cli/build.mjs` copies beside the compiled entries. */
export const payloadMigrations = (payloadRoot) => path.join(payloadRoot, "cli/dist/migrations");

/** A migration URL that does not name this machine is not this install's own
 *  database, and the free core migrates nothing over a network. */
const LOCAL_ONLY = "free_local_database_required";

/** The marker an install carries when its migrator advanced the journal and
 *  then failed FINISHING the job.
 *
 *  `migrateDatabase.ts` runs the migration FILES first and then everything the
 *  schema needs to be usable — RLS, grants, added columns, concurrent indexes,
 *  and triggers. None of that is recorded in `drizzle.__drizzle_migrations`, so a
 *  failure after the files land leaves `pending` at zero over a database whose
 *  grants or fences may be half-installed, and every check in this module
 *  would call that install healthy for good. This file is the one thing that
 *  remembers it.
 *
 *  `engager migrate` is the ONE path that clears it, and deliberately so.
 *  `init` also runs a migrator, but it runs one before this installation has an
 *  organization — `bootstrap.mjs` comes after it and writes the
 *  `ENGAGER_ORG_ID` the core's maintenance door requires — so `init` cannot ask
 *  for the history admission `migrateFreePayload` is built around, and routing
 *  it through here would refuse every first run. Its migrator therefore neither
 *  writes this marker nor removes one, which is why every refusal that names it
 *  names `engager migrate`. */
const FINALIZATION_MARKER = "migration-finalization.json";

/** The recorded finalization failure, or null. */
export const finalizationFailure = (root) => readJson(path.join(root, FINALIZATION_MARKER), null);

/** How many migrations this database has applied, how many the payload
 *  packages, and how many are still to run. */
export async function freeMigrationTriple({ payloadRoot, env }) {
  return migrationTriple({ directory: payloadMigrations(payloadRoot), env, refusal: LOCAL_ONLY });
}

/** How many a payload packages, without opening a database at all: the half of
 *  the triple that is still knowable when the database cannot be read. */
export function packagedMigrationCount(payloadRoot) {
  return packagedJournal(payloadMigrations(payloadRoot)).length;
}

/** WHERE the migrator stopped, read from the database rather than guessed.
 *
 *  A journal still short of the packaged set names the first entry it does not
 *  carry: Drizzle applies the pending files in one transaction, so that entry
 *  is the one the migrator was on. A journal that reached the end while the
 *  migrator still failed is the other class entirely — the files landed and
 *  what did not finish is everything after them, which no journal records.
 *
 *  A database this cannot read a second time falls back to the first entry
 *  that was queued, which is the same answer whenever the migrator failed
 *  before it wrote anything. */
async function failedStep(env, packaged, queued) {
  try {
    const applied = await withMigrationHistory(env, LOCAL_ONLY, appliedMigrations);
    const outstanding = pendingMigrations(packaged, applied);
    return outstanding.length > 0 ? outstanding[0].tag : "finalization";
  } catch { return queued[0]?.tag ?? "unknown"; }
}

function recordFinalizationFailure(root, payloadRoot, detail) {
  atomicWrite(path.join(root, FINALIZATION_MARKER), JSON.stringify({
    schemaHash: migrationFingerprint(payloadMigrations(payloadRoot)),
    at: Date.now(),
    detail: detail ?? null,
  }));
}

/**
 * Admit the applied history, run the payload's own migrator, and report what it
 * applied.
 *
 * The admission comes first and it is the NEW core's: `migrationHistoryAdmission`
 * reads the reviewed edge compiled into the code being asked, and the whole
 * point of this step is that the code being asked is the release just
 * installed. A history it does not recognise — rows this payload never shipped,
 * a database restored from somewhere else — refuses before a statement runs.
 *
 * `migrate` is the caller's spawn of the payload's own `dist/migrate.mjs` under
 * the payload's own interpreter; a failure may carry the child's last line on
 * `detail`, which travels into the receipt and the marker and never into a
 * code. Nothing is retried here: whether an interrupted migration is safe to
 * repeat is the owner's decision, and `engager migrate` is where they make it.
 */
export async function migrateFreePayload({ root, payloadRoot, env, admission, migrate }) {
  const directory = payloadMigrations(payloadRoot);
  assertLocalMigrationUrl(env, LOCAL_ONLY);
  const packaged = packagedMigrations(directory);
  const before = await withMigrationHistory(env, LOCAL_ONLY, appliedMigrations);
  const verdict = await admission({
    schemaHash: migrationFingerprint(directory),
    packaged: historyRows(packaged),
    applied: historyRows(before),
  });
  if (!verdict?.allowed) throw new Error("migration_history_incompatible");
  const queued = pendingMigrations(packaged, before);
  try { await migrate(); }
  catch (failure) {
    const detail = typeof failure?.detail === "string" ? failure.detail : null;
    const step = await failedStep(env, packaged, queued);
    if (step === "finalization") recordFinalizationFailure(root, payloadRoot, detail);
    throw Object.assign(new Error(`migration_failed:${step}`), { detail });
  }
  const after = await withMigrationHistory(env, LOCAL_ONLY, appliedMigrations);
  // A migrator that ran to completion did every step, including the ones no
  // journal records — which is the only thing that clears the marker.
  rmSync(path.join(root, FINALIZATION_MARKER), { force: true });
  return {
    applied: after.length - before.length,
    packaged: packaged.length,
    pending: pendingMigrations(packaged, after).length,
  };
}
