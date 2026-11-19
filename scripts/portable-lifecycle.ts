/**
 * `engager export --portable` and `engager restore`, as two functions the
 * free core's `core-command` seam drives.
 *
 * These are the owner's own data operations and they are never paywalled: no
 * subscription, licence cache or account is read anywhere below (TIER-01/03).
 * The passphrase arrives as a FILE path rather than an argument, because an
 * argument is visible to every process on the machine.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Pool } from "pg";
import { copyOrgPoolConfig } from "@engager/database/copy-org";
import { resolveDeploymentEnvironment } from "@engager/database/environment";
import {
  buildPortableExport,
  PortableArchiveError,
  safeAttachmentPath,
  sealPortableArchive,
} from "@engager/database/portable-export";
import { restorePortableExport } from "@engager/database/portable-restore";

type Env = NodeJS.ProcessEnv;

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value) throw new Error("portable_environment_incomplete");
  return value;
}

/** Read the passphrase and refuse the weak ones here, where the owner can still
 * be told, rather than at the sealing boundary. */
function readPassphrase(file: string): string {
  const passphrase = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (passphrase.length < 12) throw new Error("portable_passphrase_too_short");
  return passphrase;
}

/** Every file under `root`, as manifest-relative paths. Symlinks are followed
 * by `statSync` and rejected as non-files, so nothing outside the vault can be
 * pulled into an export by a link. */
function vaultFiles(
  root: string,
  prefix: string,
): { path: string; content: Buffer }[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: { path: string; content: Buffer }[] = [];
  for (const entry of entries.sort()) {
    const absolute = join(root, entry);
    const stats = statSync(absolute, { throwIfNoEntry: false });
    if (!stats) continue;
    if (stats.isDirectory()) {
      files.push(...vaultFiles(absolute, `${prefix}${entry}/`));
    } else if (stats.isFile()) {
      const path = `${prefix}${entry}`;
      if (!safeAttachmentPath(path)) continue;
      files.push({ path, content: readFileSync(absolute) });
    }
  }
  return files;
}

export async function portableExport(input: {
  output: string;
  passphraseFile: string;
  env: Env;
  now?: Date;
}): Promise<Record<string, unknown>> {
  const passphrase = readPassphrase(input.passphraseFile);
  const organizationId = required(input.env, "ENGAGER_ORG_ID");
  const ownerUrl = required(input.env, "ENGAGER_MIGRATE_DATABASE_URL");
  const attachments = input.env.ENGAGER_BRAIN_DIR
    ? vaultFiles(input.env.ENGAGER_BRAIN_DIR, "brain/")
    : [];
  const pool = new Pool(
    copyOrgPoolConfig(ownerUrl, resolveDeploymentEnvironment()),
  );
  try {
    const client = await pool.connect();
    try {
      // One snapshot: the manifest's hashes and its obligation list must
      // describe the same instant, or a reader could not tell a changed row
      // from a corrupted one. The isolation level has to be set before the
      // transaction's first query, so it rides on BEGIN.
      await client.query("begin isolation level repeatable read read only");
      await client.query("set local lock_timeout = '10s'");
      await client.query(`select set_config('app.current_org', $1, true)`, [
        organizationId,
      ]);
      const content = await buildPortableExport({
        client,
        organizationId,
        coreVersion: input.env.ENGAGER_CORE_VERSION ?? "unknown",
        attachments,
        vaultRevision: input.env.ENGAGER_BRAIN_DIR
          ? createHash("sha256")
              .update(
                attachments
                  .map(
                    (file) =>
                      `${file.path}:${createHash("sha256").update(file.content).digest("hex")}`,
                  )
                  .join("\n"),
              )
              .digest("hex")
          : null,
        now: input.now,
      });
      await client.query("commit");
      const archive = sealPortableArchive(content, passphrase);
      const bytes = Buffer.from(JSON.stringify(archive));
      mkdirSync(dirname(resolve(input.output)), { recursive: true });
      writeFileSync(resolve(input.output), bytes, { mode: 0o600, flag: "wx" });
      return {
        state: "portable_export_written",
        path: resolve(input.output),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        organizationId,
        snapshotId: content.manifest.snapshotId,
        tables: content.manifest.tables.length,
        rows: content.manifest.tables.reduce(
          (total, table) => total + table.rows,
          0,
        ),
        attachments: content.manifest.attachments.length,
        obligations: content.manifest.obligations,
        excluded: content.manifest.excluded.map((entry) => entry.table),
        portable: true,
      };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function portableRestore(input: {
  input: string;
  passphraseFile: string;
  env: Env;
  now?: number;
}): Promise<Record<string, unknown>> {
  const passphrase = readPassphrase(input.passphraseFile);
  const ownerUrl = required(input.env, "ENGAGER_MIGRATE_DATABASE_URL");
  let archive: unknown;
  try {
    archive = JSON.parse(readFileSync(resolve(input.input), "utf8"));
  } catch {
    throw new PortableArchiveError(
      "corrupt_archive",
      "This file could not be read as an Engager portable export.",
    );
  }
  const report = await restorePortableExport({
    ownerUrl,
    archive,
    passphrase,
    now: input.now,
  });
  // Attachments land only after the database transaction committed: a vault
  // written beside a rolled-back import would be the one piece of a refused
  // restore that survived.
  const vault = input.env.ENGAGER_BRAIN_DIR;
  const written: string[] = [];
  if (vault) {
    const root = resolve(vault);
    for (const attachment of report.attachments) {
      const target = resolve(root, attachment.path.replace(/^brain\//, ""));
      const inside = relative(root, target);
      if (inside.startsWith("..") || inside.startsWith(sep) || inside === "") {
        throw new PortableArchiveError(
          "unsafe_attachment_path",
          `This archive contains an unsafe path: ${attachment.path}`,
        );
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, attachment.content, { mode: 0o600 });
      written.push(attachment.path);
    }
  }
  return {
    state: "portable_restore_completed",
    organizationId: report.organizationId,
    snapshotId: report.manifest.snapshotId,
    tables: report.tables.length,
    rows: report.tables.reduce((total, table) => total + table.inserted, 0),
    attachments: written,
    // Named, not retried: the owner reconciles each of these against the
    // provider before anything is sent again.
    unresolvedObligations: report.obligations,
    execution: report.execution,
    credentials: "reconnect_required",
    // How this install comes back: connect the account, and this machine's own
    // verified session takes over on a new epoch. Nothing resumes by itself.
    resume: report.resume,
  };
}
