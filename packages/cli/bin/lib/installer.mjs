import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { installState } from "./installState.mjs";
import { discardUnreferencedPayload, installPayload, stagePayload } from "./payloadInstaller.mjs";
import { lifecycleStatus, stopCore, withLifecycleLock } from "./coreLifecycle.mjs";
import { readJson } from "./ownedFiles.mjs";
import { readEnvFile } from "./localEnv.mjs";
import { ensureOwnDatabase } from "./ownDatabase.mjs";
import { localSnapshot } from "./localSnapshot.mjs";
import { migrationFingerprint } from "./migrationFingerprint.mjs";
import { migrateFreePayload } from "./payloadMigrations.mjs";
import { payloadManifest, pruneSnapshots, setTrustedPublisher, snapshotInventory, snapshotPath, snapshotVerifies, trustedPublisher } from "./maintenance.mjs";

function flag(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  if (!argv[i + 1] || argv[i + 1].startsWith("--") || argv.lastIndexOf(name) !== i) throw new Error("cli_arguments_invalid");
  return argv[i + 1];
}
/** A child's own last line when it is one of the codes this runtime raises,
 *  the spawn error's class when the binary itself could not be run, and
 *  otherwise nothing: an arbitrary line of a child's stderr can carry a
 *  connection string, so only a known-safe shape is repeated.
 *
 *  `EPIPE` is the one spawn error the child's own answer outranks: it means
 *  this side could not finish handing over the input, which is what happens
 *  when the child refused that input and exited saying so. Reporting the pipe
 *  would bury the refusal that closed it. */
function childCode(result) {
  const last = (result.stderr ?? "").trim().split("\n").at(-1) ?? "";
  const own = /^[a-z][a-z0-9_:.-]+$/.test(last) ? last : null;
  if (result.error) {
    return own !== null && result.error.code === "EPIPE" ? own : String(result.error.code ?? "spawn_failed").toLowerCase();
  }
  return own ?? "check_dependencies_and_database";
}
/** The schema a payload ON DISK actually carries.
 *
 *  Read from the payload's own migration bytes, with the `schemaHash` its
 *  manifest recorded only as the fallback for one shipping no migrations. The
 *  recorded field is a LABEL, and every free install made before 2026-09-15
 *  carries one written in a different hash space from the edge it has to be
 *  compared against: the shipped 0.2.5 archive stamped
 *  `50dbacd2…` where its own packaged migrations fingerprint to `1cb7cdcb…`,
 *  which is the edge's `from`. The bytes are on the same disk and they are what
 *  the edge is about, so the comparison is made over those — the way the Mac
 *  path has always computed it, from the bundle it is actually running.
 *
 *  `payloadRoot` is a real directory under `payloads/`, never the `current`
 *  symlink: an owned inventory refuses to read through a link. */
function payloadSchemaHash(payloadRoot, recorded = null) {
  const migrations = path.join(payloadRoot, "cli/dist/migrations");
  return existsSync(migrations) ? migrationFingerprint(migrations) : recorded;
}
/** `input` reaches the child on STDIN. Never in `args`: an argument list is
 *  bounded by the kernel (`ARG_MAX`, 1 MiB on macOS) and a real payload
 *  manifest is several times that, so a child handed one there is refused with
 *  `E2BIG` before it runs. */
function child(command, args, root, env, input) {
  const result = spawnSync(command, args, { cwd: root, env, input, encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`core_child_failed:${childCode(result)}`);
  return result.stdout;
}
/** The one line that repairs each failure this surface raises, so a refusal
 *  and the command that clears it are never two separate lookups. A code
 *  absent from here has no single safe repair and is reported alone. */
const FREE_REPAIR = {
  install_required: "engager install --from <unpacked payload> --sha256 <payload.json hash> --version <version>",
  payload_dependency_unusable: "engager install --from <unpacked payload> --sha256 <payload.json hash> --version <version>",
  database_setup_required: "engager init --client claude|claude-desktop|codex|manual",
  client_desktop_platform_unsupported: "engager init --client claude|codex|manual; Claude Desktop is configured on macOS only, and this install writes no file it cannot name",
  supervision_verb_unknown: "engager supervision status|resume",
  database_not_running: "start Engager (engager up) so its database is running",
  database_start_failed: "engager doctor; this install's own postgres.log holds the reason the cluster would not start",
  migration_skipped: "engager doctor, clear what it names, then engager migrate",
  database_port_conflict: "stop the other server on this port, or install again and init on a free --port",
  database_ownership_mismatch: "engager doctor, then init the installation that owns this data directory",
  database_ownership_unknown: "engager doctor; an unowned pgdata is never initialised over",
  free_path_unusable: "grant the owner read/write on the named path, then repeat the command",
  installation_switch_not_completed: "engager install --from <unpacked payload> --sha256 <payload.json hash> --version <version>",
  launcher_user_edit_preserved: "move your own bin/engager aside, then repeat the command",
  lock_ownership_unresolved: "identify the process holding lifecycle.lock before clearing it",
  portable_passphrase_too_short: "write a passphrase of at least 12 characters to the --passphrase-file path",
  wrong_passphrase: "check the --passphrase-file; this install's data is unchanged",
  corrupt_archive: "this archive does not match its own checksums; restore an intact copy — this install's data is unchanged",
  incompatible_schema: "engager update --from <payload> --sha256 <hash> --version <version>, then restore again",
  unsupported_format: "pass a portable export (engager export --portable), not a sealed local snapshot",
  wrong_organization: "restore this archive into the installation it came from",
  authority_moved: "resolve this installation's open transfer before restoring over it; its data is unchanged",
  unsafe_attachment_path: "this archive names a path outside the vault; restore an intact copy — this install's data is unchanged",
  portable_environment_incomplete: "engager init --client claude|claude-desktop|codex|manual, then repeat the command",
  restore_requires_stopped_core: "stop the running core first (quit the app or stop the agent process)",
  update_requires_stopped_core: "stop the running core first (quit the app or stop the agent process)",
  backup_requires_stopped_core: "stop the running core first (quit the app or stop the agent process)",
  rollback_requires_stopped_core: "stop the running core first (quit the app or stop the agent process)",
  artifact_signature_invalid: "this payload's publisher signature does not verify; obtain an intact copy — this install is unchanged",
  artifact_signature_missing: "this install verifies updates against a pinned publisher; an unsigned payload is refused",
  artifact_hash_mismatch: "check --sha256 against the payload.json of the archive you unpacked; this install is unchanged",
  artifact_version_unsupported: "unpack a payload this release can read, and pass --version exactly as its payload.json spells it",
  artifact_version_mismatch: "pass --version exactly as the payload's own version",
  artifact_platform_unsupported: "this payload was built for another platform; obtain the build for this machine",
  artifact_inventory_mismatch: "unpack the release archive again; these files no longer match the manifest published with them",
  artifact_incomplete: "unpack the release archive again; this payload is missing a file the core needs",
  artifact_symlink_refused: "unpack the release archive again; a payload may carry no symlink",
  artifact_special_file_refused: "unpack the release archive again; a payload may carry ordinary files only",
  update_schema_compatibility_unverified: "this payload needs a schema this install has not verified; stay on the current payload and obtain the release built for it",
  payload_pointer_ownership_unresolved: "repeat engager install with the same payload; this install's current payload pointer is not the one it recorded",
  trusted_publisher_rotation_refused: "this install already pins a different publisher key; changing it is a deliberate reinstall",
  trusted_publisher_invalid: "pass the publisher key as base64 SPKI, or omit --publisher-key",
  update_requires_verified_backup: "the snapshot this update just verified changed on disk; repeat engager update so a fresh one is taken",
  migrations_pending: "engager migrate",
  migration_finalization_incomplete: "engager migrate",
  migration_failed: "engager migrate",
  migration_history_incompatible: "this database's applied migrations are not the ones this payload ships; restore a snapshot with engager restore, or update forward to the release this database was migrated by",
  free_local_database_required: "engager init --client claude|claude-desktop|codex|manual; a free install migrates only its own local database",
  migrate_requires_stopped_core: "stop the running core first (quit the app or stop the agent process)",
  rollback_schema_incompatible: "the current schema cannot run the prior payload; restore a snapshot with engager restore, or update forward again",
  rollback_no_prior_payload: "there is no earlier payload on this install; restore a snapshot with engager restore",
  uninstall_requires_stopped_core: "stop the running core first (quit the app or stop the agent process)",
  snapshot_requires_stopped_core: "stop the running core first (quit the app or stop the agent process)",
};
/** Whether a failure `installPayload` raised means this install was REFUSED a
 *  payload rather than left mid-transition.
 *
 *  Every one of these is raised before the copy is made or the pointer is
 *  touched, so there is nothing to recover from and nothing for `rollback` to
 *  read: the artifact family and the ownership conditions come from the checks
 *  at the top of the installer, and `update_schema_compatibility_unverified` is
 *  the schema pin — the one a candidate the core already admitted can still
 *  land on, when the label its manifest records disagrees with the migrations
 *  it actually ships.
 *
 *  Everything after that point — a health check the staged code fails, a backup
 *  that stopped verifying, a switch that did not finish — stays
 *  `paused_recovery`, because each of those leaves a question this install has
 *  to settle. */
const UPDATE_REFUSED_BEFORE_SWITCH = (code) => code.startsWith("artifact_") || [
  "update_schema_compatibility_unverified",
  "launcher_user_edit_preserved",
  "payload_pointer_ownership_unresolved",
  "update_requires_stopped_core",
  "ownership_symlink_refused",
].includes(code);

export function installerFailure(error) {
  const message = error instanceof Error ? error.message : "";
  const fsCode = error?.code;
  const known = /^[a-z][a-zA-Z0-9_:.; -]+$/.test(message)
    ? message
    : typeof fsCode === "string" && /^E[A-Z]+$/.test(fsCode) && typeof error.path === "string"
      ? `free_path_unusable:${fsCode.toLowerCase()}:${error.path}`
      : "free_core_operation_failed";
  // A code raised by the core child arrives wrapped (`core_child_failed:<code>`),
  // and it is the inner code that has the repair.
  const repair = FREE_REPAIR[known.split(":")[0]] ?? FREE_REPAIR[known.split(":").at(-1)];
  return repair ? `${known}\n  → ${repair}` : known;
}

function migratorDiagnosis(stderr) {
  const lines = (stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const chosen = lines.find((line) => /^(?:cause: )?error: /i.test(line))
    ?? lines.find((line) => /^[A-Za-z]*Error: /.test(line))
    ?? lines.filter((line) => !/^(?:at |\.\.\.|\^|\}|Node\.js v)/.test(line)).at(-1);
  return chosen ? chosen.replace(/^cause: /, "").replace(/(?:file:\/\/)?\/[^\s'"]*\/[^\s'"]*/g, "…").slice(0, 200) : undefined;
}
/** What a migration failure is RECORDED as: its code, and the migrator's own
 *  last line when it carried one. The code comes first and unadorned, because
 *  that is what `freeFailure` and the repair table read; the sentence after the
 *  semicolon is for the person reading the receipt, and is the only place an
 *  arbitrary child line is ever repeated. */
function receiptDetail(failure) {
  const code = failure instanceof Error ? failure.message : "migration_failed";
  return typeof failure?.detail === "string" && failure.detail ? `${code}; ${failure.detail}` : code;
}

/** This install's own environment, and no other: its bundled Postgres, its
 *  `pgdata` and the port its settings recorded, with its `.env` over the
 *  ambient shell. Ambient hosted credentials must not change its placement,
 *  payer or database, so the database keys and provider keys a caller
 *  carries are dropped before the `.env` is read over the top. */
export function installerEnvironment(root, pkg, ambient) {
  const resources = path.resolve(pkg, "../runtime-resources");
  const settings = readJson(path.join(root, "core-settings.json"), { port: 54329, client: "manual" });
  const env = { ...ambient, ENGAGER_HOME: root, ENGAGER_PG_BIN_DIR: path.join(resources, "postgresql/bin"), ENGAGER_PGDATA: path.join(root, "pgdata"), ENGAGER_PG_PORT: String(settings.port), ENGAGER_UV_BIN: path.join(resources, "uv/uv"), UV_PROJECT_ENVIRONMENT: path.join(root, "venv"), UV_CACHE_DIR: path.join(root, "cache/uv"), UV_PYTHON_INSTALL_DIR: path.join(root, "python"), ENGAGER_BRAIN_DIR: path.join(root, "brain") };
  for (const key of Object.keys(env)) if (/^(DATABASE_URL|ENGAGER_MIGRATE_DATABASE_URL|ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|GEMINI_API_KEY|ENGAGER_MASTER_KEY|ENGAGER_ORG_ID|ENGAGER_DEPLOYMENT_ENV)$/.test(key)) delete env[key];
  for (const [key, value] of readEnvFile(path.join(root, ".env"))) env[key] = value;
  env.ENGAGER_DEPLOYMENT_ENV = "local";
  env.ENGAGER_PG_LOG = path.join(root, "postgres.log");
  env.ENGAGER_BROWSER_PROFILE_DIR = path.join(root, "browser-profile");
  env.ENGAGER_BROWSER_JOURNAL_PATH = path.join(root, "browser-use-journal.json");
  // `ENGAGER_UV_BIN` names the bundled binary only when the bundle carries
  // one. Set unconditionally it made `resolveBin("uv")`'s fall through to PATH
  // unreachable, so an install whose runtime-resources shipped without uv got
  // a spawn of a file that is not there — and a repair line naming it.
  if (!existsSync(env.ENGAGER_UV_BIN)) delete env.ENGAGER_UV_BIN;
  return env;
}

export async function runInstaller({ argv, root, pkg, env: ambient }) {
  const [command] = argv;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const env = installerEnvironment(root, pkg, ambient);
  const emit = (value) => console.log(JSON.stringify(value, null, 2));
  const core = (args, input) => child(process.execPath, [path.join(pkg, "dist/core-command.mjs"), ...args], root, env, input);
  const candidateCore = (source, args, input) =>
    child(path.join(source, "runtime-resources/node/bin/node"), [path.join(source, "cli/dist/core-command.mjs"), ...args], root, env, input);
  /** A payload's migrator, run under that payload's OWN bundled interpreter —
   *  the same reasoning as `candidateCore`: new migration code on an old
   *  runtime is a second variable nobody needs. `dist/migrate.mjs` reads
   *  `ENGAGER_MIGRATE_DATABASE_URL`, which `installerEnvironment` has already
   *  taken from this install's `.env`, so the database it opens is this install's.
   *
   *  Spawned here rather than through `child` for its two differences: a longer
   *  ceiling, because this one builds concurrent indexes on a database that may
   *  have years of rows in it, and its own DIAGNOSIS, which is the one sentence
   *  that says whether a failure was a constraint, a privilege or a disk. That
   *  sentence travels as a receipt detail only — never as a code, which is what
   *  `freeFailure` repairs on and what `childCode` refuses to invent. */
  const payloadMigrator = (payloadRoot) => () => {
    const result = spawnSync(path.join(payloadRoot, "runtime-resources/node/bin/node"), [path.join(payloadRoot, "cli/dist/migrate.mjs")], { cwd: root, env, encoding: "utf8", timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw Object.assign(new Error("migration_child_failed"), {
        detail: migratorDiagnosis(result.stderr) ?? (result.error ? String(result.error.code ?? "spawn_failed").toLowerCase() : null),
      });
    }
  };

  const maintenance = (operation, input) => JSON.parse(core(["maintenance", operation], JSON.stringify(input)));
  const candidateMaintenance = (source, operation, input) => JSON.parse(candidateCore(source, ["maintenance", operation], JSON.stringify(input)));
  /** A verified snapshot, its receipt, and the pruning the core allows.
   *
   *  Written and verified by `localSnapshot` (which re-reads and re-decrypts
   *  what it wrote), recorded whichever way it went, and pruned only by the
   *  plan the core returned — a plan that structurally cannot contain the last
   *  verified snapshot. A failure is recorded and RETURNED, never thrown: the
   *  caller decides what a missing backup costs, and for an update that is a
   *  refusal rather than a crash. */
  const runBackup = async (label) => {
    const name = `${label}-${Date.now()}.json`;
    let receipt;
    try {
      receipt = localSnapshot({ root, output: snapshotPath(root, name), env, version: installState(root)?.version });
    } catch (failure) {
      maintenance("backup-receipt", { outcome: "failed", name, detail: failure instanceof Error ? failure.message : "snapshot_failed" });
      return { state: "backup_failed", name };
    }
    maintenance("backup-receipt", { outcome: "verified", name, sha256: receipt.sha256, version: installState(root)?.version, sizeBytes: statSync(snapshotPath(root, name)).size });
    // The inventory carries what is ON DISK; whether each file is a RESTORABLE
    // backup is the receipt's hash still matching, which is what `verified`
    // reports here and what the retention plan partitions on.
    const inventory = snapshotInventory(root).map((entry) => ({ name: entry.name, at: entry.at, verified: snapshotVerifies(root, entry.name, entry.sha256) }));
    const plan = maintenance("backup-plan", { candidates: inventory });
    for (const pruned of pruneSnapshots(root, plan.prune)) {
      maintenance("backup-receipt", { outcome: "pruned", name: pruned });
    }
    return { state: "backup_verified", name, sha256: receipt.sha256, kept: plan.keep.length, pruned: plan.prune.length };
  };

  await withLifecycleLock(root, async () => {

    if (command === "migrate") {
      // The repair every refusal above names: an install whose update stopped
      // on a migration or on the finalization after them, or whose database was
      // restored from a snapshot older than the payload it is now running. It
      // applies the INSTALLED payload's own migrations behind the same history
      // admission an update makes — never a down-migration, never under a live
      // core, and idempotent, since Drizzle runs only what the journal lacks.
      if (lifecycleStatus(root).state !== "stopped") throw new Error("migrate_requires_stopped_core");
      const state = installState(root);
      if (!state) throw new Error("install_required");
      if (!existsSync(path.join(root, ".env"))) throw new Error("database_setup_required");
      const target = path.join(root, state.current);
      ensureOwnDatabase(root, env, false);
      try {
        emit(await migrateFreePayload({ root, payloadRoot: target, env,
          // The INSTALLED core, which is the one whose migrations are being run:
          // unlike an update, there is no newer code in the question.
          admission: (question) => maintenance("migration-history-admission", question),
          migrate: payloadMigrator(target) }));
      } catch (failure) {
        // The same receipt an update's failed migration writes, for the same
        // reason: this install is on a payload its database has not finished
        // arriving at, and the record of that must not depend on which command
        // was holding the migrator when it stopped.
        maintenance("update-receipt", { kind: "update", outcome: "paused_recovery", name: state.version, version: state.version, schemaHash: state.schemaHash, detail: receiptDetail(failure) });
        throw failure;
      }
      return;
    }

      // Pinning is durable and one-way (`setTrustedPublisher` refuses a
      // rotation). A FIRST install cannot check the signature it is pinning
      // against: the admission that verifies one lives in the core, and a
      // machine with no database yet has no core to ask. So the first payload's
      // identity rests on the `--sha256` the owner supplied out of band beside
      // the key, and every update after it is signature-checked.
      const publisherKey = flag(argv, "--publisher-key", null);
      if (publisherKey !== null) setTrustedPublisher(root, publisherKey);
      if (command === "update") await stopCore(root);
      const source = path.resolve(flag(argv, "--from", ""));
      const previous = installState(root);
      // Quiesce, back up, THEN decide (ADR-08's order). The backup runs before
      // the admission because the admission's last question is whether there is
      // anything to go back to, and this is the attempt to make sure there is.
      const backup = command === "update" && previous && existsSync(path.join(root, ".env"))
        ? await runBackup("before-update")
        : null;
      // The verdict the receipt below is written from, so an applied update
      // records the signature the core actually verified rather than a fixed
      // one. A first install has no core to ask and therefore no verdict.
      let admission = null;
      /** The candidate fingerprint a core allowed, read BEFORE the decision was
       *  made — so the installer can refuse bytes that moved since. */
      let admittedSchemaHash = null;
      /** The copy made to put the candidate's core somewhere it cannot change,
       *  if one was made. Unreferenced until the pointer moves, so every path
       *  that ends without moving it discards this. */
      let staged = null;
      if (previous) {
        const manifest = payloadManifest(source);
        const question = {
          manifest,
          trustedPublicKey: trustedPublisher(root),
          currentSchemaHash: payloadSchemaHash(path.join(root, previous.current), previous.schemaHash),
          // Both sides are BYTES. Comparing a fingerprint against the other
          // payload's recorded label would be the original defect in
          // miniature, and it makes `installPayload`'s pin mean something
          // sharper than "the manifest did not move": the label the candidate
          // records has to agree with the migrations it actually ships.
          candidateSchemaHash: payloadSchemaHash(source, manifest.schemaHash ?? null),
          backupOnDisk: backup?.state === "backup_verified",
          isFirstInstall: false,
        };
        admission = maintenance("update-admission", question);
        // THE CANDIDATE ANSWERS THE ONE QUESTION ONLY IT CAN ANSWER.
        //
        // `compatibleSchema` reads a reviewed edge compiled into the core that
        // runs it, and the core that ran the line above is the INSTALLED one —
        // the older payload, whose table was written before this release
        // existed. It cannot know an edge it predates, so on the free path a
        // schema-changing update was refused by construction (measured
        // 2026-09-15: shipped 0.2.5 + the archive built for it →
        // `update_schema_compatibility_unverified`, install untouched). The Mac
        // path never had this: Sparkle has already replaced the bundle, so
        // `prepareMacUpdate` asks the NEW code's table.
        //
        // Reached only through the schema refusal, so nothing else moves: the
        // installed core has already checked the publisher signature against
        // the key THIS install pins, with code the candidate did not write, and
        // staging proves the candidate's own bytes — hash, inventory, platform,
        // version — before a line of them runs. That is the same trust the Mac
        // path places in a bundle Sparkle verified.
        //
        // The bytes that ANSWER are literally the bytes that get installed. The
        // payload is STAGED first — copied into this installation and verified
        // there — and the candidate's core is run out of that copy, which
        // `installPayload` then finds already present, verifies again and
        // points at. Asking the unpacked `source` instead would leave the
        // owner's own directory writable between the verification and the
        // child, and a copy of the payload is going to be made either way.
        //
        // The candidate's whole verdict then stands, including the
        // recoverability question the installed core never reached:
        // `updateAdmission` refuses on schema before it looks at the backup, so
        // nobody has judged that yet. The one thing that does not come from the
        // candidate is the `signature` the receipt records, which stays the one
        // the installed core verified.
        //
        // A candidate that cannot answer at all decides nothing, and the
        // install must not be left with a backup, a stopped core and no record
        // of why it stayed where it was. Staging is inside that promise:
        // bytes that do not survive being copied and re-verified — a payload
        // whose manifest no longer describes it — refuse this update exactly as
        // a core that will not start does.
        if (!admission.allowed && admission.refusal === "update_schema_compatibility_unverified") {
          try {
            staged = stagePayload({ root, source, expectedHash: flag(argv, "--sha256"), version: flag(argv, "--version") });
            admission = { ...candidateMaintenance(staged.target, "update-admission", question), signature: admission.signature };
          } catch (failure) {
            discardUnreferencedPayload(root, staged?.current);
            maintenance("update-receipt", { kind: "update", outcome: "refused", name: flag(argv, "--version", ""), version: flag(argv, "--version", null), schemaHash: question.candidateSchemaHash, signature: admission.signature, detail: failure instanceof Error ? failure.message : "candidate_admission_unreadable" });
            throw failure;
          }
        }
        if (!admission.allowed) {
          // Nothing was switched: the pointer, `installation.json` and the data
          // are exactly as they were, and the receipt says why it stayed that
          // way — against the schema that was actually judged, not the label
          // the refused manifest recorded for itself. The copy consulting the
          // candidate made goes too: nothing points at it, and a refused
          // release is not something to keep several hundred megabytes of.
          discardUnreferencedPayload(root, staged?.current);
          maintenance("update-receipt", { kind: "update", outcome: "refused", name: flag(argv, "--version", ""), version: flag(argv, "--version", null), schemaHash: question.candidateSchemaHash, signature: admission.signature, detail: admission.refusal });
          throw new Error(admission.refusal);
        }
        admittedSchemaHash = question.candidateSchemaHash;
      }
      let installed;
      try {
        installed = await installPayload({ root, source, expectedHash: flag(argv, "--sha256"), version: flag(argv, "--version"),
          // The fingerprint the admission above was given, so the installer
          // stages only the schema a core actually admitted — and refuses if
          // the manifest on disk has moved since that decision was made.
          admittedSchemaHash,
          healthCheck: async (target) => { child(path.join(target, "runtime-resources/node/bin/node"), [path.join(target, "cli/dist/core-command.mjs"), "payload-check", path.join(target, "cli/package.json")], root, env); },
          // The last moment before the pointer moves, and the last chance to
          // find that the snapshot the admission counted on is no longer the
          // file it verified. Staging and the health check happen in between;
          // re-hashing one file is cheap next to switching payloads over a
          // backup that has since been truncated.
          beforeSwitch: async () => {
            if (backup?.state === "backup_verified" && !snapshotVerifies(root, backup.name, backup.sha256)) {
              throw new Error("update_requires_verified_backup");
            }
          },
        });
      } catch (failure) {
        // A failed SWITCH leaves the prior payload in place and this install
        // paused; the receipt is the record `engager rollback` and the Mac's
        // recovery card both read. A refusal raised before the switch could
        // begin is a different thing with the same shape, and calling it
        // `paused_recovery` sends an owner looking for a transition to finish
        // that never started — `update_schema_compatibility_unverified` from
        // the installer's own pin is the one an admitted candidate can still
        // land on, when its manifest's label disagrees with the migrations it
        // ships.
        const detail = failure instanceof Error ? failure.message : "update_failed";
        // `installPayload` discards what IT staged; this is the copy made
        // earlier to consult the candidate, which its own checks can still
        // refuse. Safe on every path: a payload anything names — the pointer,
        // an interrupted switch, `previous` — is never removed.
        discardUnreferencedPayload(root, staged?.current);
        if (previous) maintenance("update-receipt", { kind: "update", outcome: UPDATE_REFUSED_BEFORE_SWITCH(detail) ? "refused" : "paused_recovery", name: flag(argv, "--version", ""), version: flag(argv, "--version", null), schemaHash: admittedSchemaHash, signature: admission?.signature ?? null, detail });
        throw failure;
      }
      // THE LAST STEP OF A SUCCESSFUL UPDATE, in the same lifecycle-locked call.
      //
      // Until 2026-09-15 there was no such step, and an `applied` update left
      // the new payload running on the old schema: `init` was the only place
      // `dist/migrate.mjs` ever ran, so a database provisioned under 0.2.5 kept
      // its 169 rows under a payload packaging 174, and `--version`, `status`,
      // `doctor` and `get_status` all answered as if nothing were wrong
      // until a tool touched a table 0.2.6 added.
      //
      // The migrator is the NEW payload's, run under the new payload's own
      // interpreter, over the install's own `ENGAGER_MIGRATE_DATABASE_URL` —
      // and the database is brought up first exactly as `init` does, because an
      // update may be the first thing run since a reboot. The history is
      // admitted by the NEW core before a statement runs, for the reason the
      // admission above is asked of the candidate: the reviewed edge lives in
      // the code being asked, and the code that matters here is the release
      // just installed.
      //
      // Nothing here weakens expand-then-contract. These migrations are already
      // expand-only; this only runs them.
      let migrations = null;
      if (previous && existsSync(path.join(root, ".env"))) {
        const target = path.join(root, installed.current);
        try {
          // A database this install cannot even bring up is not a migration
          // that failed — nothing was attempted — so it is recorded as the
          // step that was SKIPPED, and its own code keeps its own repair line.
          try { ensureOwnDatabase(root, env, false); }
          catch (failure) { throw new Error(`migration_skipped:${failure instanceof Error ? failure.message : "database_unavailable"}`); }
          migrations = await migrateFreePayload({
            root,
            payloadRoot: target,
            env,
            admission: (question) => candidateMaintenance(target, "migration-history-admission", question),
            migrate: payloadMigrator(target),
          });
        } catch (failure) {
          // The switch is done and refusing cannot undo it: this install is on
          // the new payload over a database that did not finish arriving, which
          // is `paused_recovery`, and the receipt names the step that stopped —
          // a migration file, or the finalization that follows them all.
          //
          // What this does NOT change is `rollback`. That admission compares
          // the two payloads' migration fingerprints against the reviewed edge
          // and never reads the database, so going back is still allowed here —
          // which is sound for an expand-only edge, because the prior payload's
          // code names nothing the edge added. Until the owner migrates or
          // rolls back, every arm that serves refuses.
          maintenance("update-receipt", { kind: "update", outcome: "paused_recovery", name: installed.version, version: installed.version, schemaHash: installed.schemaHash, sha256: installed.artifactHash, signature: admission.signature, detail: receiptDetail(failure) });
          throw failure;
        }
      }
      if (previous) maintenance("update-receipt", { kind: "update", outcome: "applied", name: installed.version, version: installed.version, schemaHash: installed.schemaHash, sha256: installed.artifactHash, signature: admission.signature, detail: migrations ? `migrations_applied:${migrations.applied}` : null });
      emit({ ...installed, ...(backup ? { backup } : {}), ...(migrations ? { migrations } : {}) });

  });
}
