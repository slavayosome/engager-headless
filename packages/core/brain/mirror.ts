import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { brainState, brainVaultMirror } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { sha256 } from "../ai/prompts";
import { config } from "../config";
import { ensureVault, noteFolders } from "./vault";

/**
 * The vault's replica in the tenant database — the whole of what a cloud tenant
 * can see of a Brain whose canonical copy is the owner's laptop (INV-14, INV-23).
 *
 * Derivation runs ONE WAY only: files → rows. This module is the table's only
 * writer, it never writes a note file, and nothing on the laptop reads the
 * replica to answer a dashboard, chat or MCP question — the files still answer
 * those, exactly as they did before.
 *
 * The diff is taken over the FILES rather than hooked onto the vault's writers,
 * for three reasons the phase brief spells out: the file write sits outside the
 * version bump's transaction by contract, `seed.ts` archives without going
 * through `knowledge.ts` at all, and a hand edit in Obsidian moves no version
 * anywhere. A whole-vault diff sees all three.
 */

/**
 * Whether this install replicates its vault at all. Read as a RAW string and
 * deliberately NOT through `resolveDeploymentEnvironment()`, whose environment
 * set does not carry `"cloud"` and which throws on anything outside it — until
 * it widens, this predicate is false on every environment that exists, which is
 * what makes every call site below inert on today's installs.
 */
export function vaultReplicaEnabled(): boolean {
  return false;
}

/**
 * Whether THIS process may rewrite its vault directory from the rows. BOTH
 * halves are load-bearing. A cloud tenant's LAPTOP also runs under
 * `ENGAGER_DEPLOYMENT_ENV=cloud` in client mode — same env file, same label —
 * and its `config.brainDir` is the canonical vault, so an environment-only
 * predicate would overwrite the owner's `~/.engager/brain` with a database
 * snapshot. Only the container's agent entrypoint sets `ENGAGER_PROCESS_ROLE`.
 *
 * Fails CLOSED: it guards a directory rewrite and lives with the mirror it
 * serves. The raw env string again, for the reason `vaultReplicaEnabled`
 * gives.
 */
export function vaultMaterializeAllowedHere(): boolean {
  return process.env.ENGAGER_PROCESS_ROLE === "agent" && vaultReplicaEnabled();
}

/** One note file as the replica stores it — its own bytes, and their digest. */
type VaultFile = {
  relativePath: string;
  sha256: string;
  bytes: string;
  fileMtimeMs: number;
};

/**
 * Every `.md` file under the folders `noteFolders` names, read as RAW BYTES —
 * never `serializeNote` output re-derived from a parse. The digest a brief
 * hashes has to be the file's own, so a hand edit to the frontmatter moves the
 * sha and a materializer that re-serializes cannot quietly diverge from it.
 * A folder that does not exist yet is skipped, exactly as `scanNotes` does.
 */
export async function readVaultMirrorFiles(dir: string): Promise<VaultFile[]> {
  const files: VaultFile[] = [];
  for (const folder of noteFolders(dir)) {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = path.join(folder, entry.name);
      let fileStat;
      try {
        fileStat = await stat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const bytes = await readFile(file, "utf8");
      files.push({
        relativePath: path.relative(dir, file).split(path.sep).join("/"),
        sha256: sha256(bytes),
        bytes,
        // Rounded because the column is a bigint and `mtimeMs` is fractional.
        fileMtimeMs: Math.round(fileStat.mtimeMs),
      });
    }
  }
  return files;
}

/** This org's current replica version (0 when no `brain_state` row yet). */
async function currentMirrorVersion(tx: Tx): Promise<number> {
  const [row] = await tx.select({ v: brainState.mirrorVersion }).from(brainState);
  return row?.v ?? 0;
}

/**
 * Bring this org's replica rows to what the vault holds now, at ONE new version
 * for the whole batch. Paths that are new or whose digest moved are upserted;
 * rows whose file is gone are deleted. An empty diff writes nothing and leaves
 * the version where it stands, so a caller may sync at every batch boundary
 * without inventing versions.
 *
 * Runs entirely on the caller's `tx` (the `withOrg` connection) — never a second
 * connection, which deadlocks at `ENGAGER_PG_POOL_MAX=1`. `knowledgeVersion` is
 * neither read nor written here: the mirror version is a second counter beside
 * it, not a replacement.
 */
export async function syncVaultMirror(
  tx: Tx,
  dir: string = config.brainDir,
): Promise<{ changed: boolean; version: number }> {
  const files = await readVaultMirrorFiles(dir);
  const rows = await tx
    .select({
      relativePath: brainVaultMirror.relativePath,
      sha256: brainVaultMirror.sha256,
    })
    .from(brainVaultMirror);

  const mirrored = new Map(rows.map((row) => [row.relativePath, row.sha256]));
  const onDisk = new Set(files.map((file) => file.relativePath));
  const upserts = files.filter(
    (file) => mirrored.get(file.relativePath) !== file.sha256,
  );
  const gone = rows
    .map((row) => row.relativePath)
    .filter((relativePath) => !onDisk.has(relativePath));
  if (upserts.length === 0 && gone.length === 0) {
    return { changed: false, version: await currentMirrorVersion(tx) };
  }

  const now = Date.now();
  const [state] = await tx
    .insert(brainState)
    .values({ mirrorVersion: 1 })
    .onConflictDoUpdate({
      target: brainState.organizationId,
      set: {
        mirrorVersion: sql`${brainState.mirrorVersion} + 1`,
        updatedAt: now,
      },
    })
    .returning({ version: brainState.mirrorVersion });
  const version = state!.version;

  if (upserts.length > 0) {
    await tx
      .insert(brainVaultMirror)
      .values(upserts.map((file) => ({ ...file, mirrorVersion: version, updatedAt: now })))
      .onConflictDoUpdate({
        target: [brainVaultMirror.organizationId, brainVaultMirror.relativePath],
        set: {
          sha256: sql`excluded.sha256`,
          bytes: sql`excluded.bytes`,
          fileMtimeMs: sql`excluded.file_mtime_ms`,
          mirrorVersion: version,
          updatedAt: now,
        },
      });
  }
  if (gone.length > 0) {
    await tx
      .delete(brainVaultMirror)
      .where(inArray(brainVaultMirror.relativePath, gone));
  }
  return { changed: true, version };
}
/** The version a directory was last materialized at, as `<org id> <version>`.
 *  The org is in the file because a scratch volume that survived a re-provision
 *  must not count as materialized for a DIFFERENT org. */
const MIRROR_VERSION_FILE = ".mirror-version";

/** `${organizationId}:${dir}` → the version already on disk there. A warm
 *  process skips the read-back; a cold `/data` volume has no file and
 *  materializes from scratch. */
const materialized = new Map<string, number>();

/** In-flight materializations, keyed the same way, so a boot materialization
 *  and a job's first read cannot interleave two rewrites of one directory. */
const inFlight = new Map<string, Promise<number>>();

async function readMirrorVersionFile(
  dir: string,
): Promise<{ organizationId: string; version: number } | null> {
  let raw;
  try {
    raw = await readFile(path.join(dir, MIRROR_VERSION_FILE), "utf8");
  } catch {
    return null;
  }
  const [organizationId, version] = raw.trim().split(/\s+/);
  if (!organizationId || !Number.isInteger(Number(version))) return null;
  return { organizationId, version: Number(version) };
}

/** Rewrite `dir` to match this org's rows exactly, then stamp the version. */
async function rewriteVault(
  tx: Tx,
  dir: string,
  organizationId: string,
  version: number,
): Promise<void> {
  const rows = await tx
    .select({
      relativePath: brainVaultMirror.relativePath,
      bytes: brainVaultMirror.bytes,
    })
    .from(brainVaultMirror);

  await ensureVault(dir);
  for (const row of rows) {
    const file = path.join(dir, ...row.relativePath.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    // VERBATIM — never through `serializeNote` and never through `writeNote`.
    // These bytes are what `serializeNote` produced on the laptop, and
    // re-serializing is the one way this could quietly diverge from the source
    // vault: every digest would move and every brief would recompile.
    await writeFile(file, row.bytes);
  }

  // Exactly the file set `scanNotes` walks, so `README.md` and the version
  // stamp itself are never candidates for deletion.
  const keep = new Set(rows.map((row) => row.relativePath));
  for (const folder of noteFolders(dir)) {
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(folder, name);
      const relativePath = path.relative(dir, file).split(path.sep).join("/");
      if (!keep.has(relativePath)) await rm(file, { force: true });
    }
  }

  await writeFile(
    path.join(dir, MIRROR_VERSION_FILE),
    `${organizationId} ${version}`,
  );
}

/**
 * Bring `dir` to this org's replica version, and answer with that version.
 *
 * Returns `null` — reading nothing, writing nothing — wherever
 * `vaultMaterializeAllowedHere()` is false, which is what makes it safe to call
 * unconditionally at the top of every vault-reading path. On the cloud agent it
 * is the vault's ONLY writer: the rows are the source and the files are their
 * derivative, the exact reverse of what is true on the laptop.
 */
export async function materializeVaultMirror(
  tx: Tx,
  dir: string = config.brainDir,
): Promise<number | null> {
  if (!vaultMaterializeAllowedHere()) return null;

  const [state] = await tx
    .select({
      organizationId: brainState.organizationId,
      version: brainState.mirrorVersion,
    })
    .from(brainState);
  // No `brain_state` row is an org that has never written a note: there is
  // nothing to materialize and nothing that could have been materialized here.
  if (!state) return 0;

  const key = `${state.organizationId}:${dir}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = (async () => {
    if (materialized.get(key) === state.version) return state.version;
    const stamped = await readMirrorVersionFile(dir);
    if (
      stamped?.organizationId !== state.organizationId ||
      stamped.version !== state.version
    ) {
      await rewriteVault(tx, dir, state.organizationId, state.version);
    }
    materialized.set(key, state.version);
    return state.version;
  })();
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * The boot leg: materialize for the org this process acts for, so a container
 * whose first job is a draft finds a warm vault instead of an empty one. Its
 * own function so the leg is testable without importing a module whose top
 * level starts a scheduler.
 */
export async function materializeVaultMirrorAtBoot(): Promise<number | null> {
  const organizationId = config.organizationId();
  if (!organizationId || !vaultMaterializeAllowedHere()) return null;
  return withOrg(organizationId, (tx) => materializeVaultMirror(tx));
}
