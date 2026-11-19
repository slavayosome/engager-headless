import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { atomicWrite, hash, inventory, noSymlinks } from "./ownedFiles.mjs";

/** Local recovery snapshot, deliberately not a portable/importable format.
 * pg_dump preserves row types and durable receipts. Reusable credentials are
 * retained only in the source installation and never included in this file. */
export function localSnapshot({ root, output, env, version }) {
  noSymlinks(output);
  if (existsSync(output)) throw new Error("snapshot_destination_exists");
  const url = new URL(env.ENGAGER_MIGRATE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("snapshot_local_database_required");
  const pg = env.ENGAGER_PG_BIN_DIR;
  if (!pg) throw new Error("snapshot_pg_tools_required");
  // A local sealed recovery archive contains the exact database, encrypted
  // at rest below. It cannot be shared/restored by the portable P4 path.
  const dump = spawnSync(path.join(pg, "pg_dump"), ["--format=custom", "--no-owner", "--no-acl", "--host", url.hostname, "--port", url.port || "5432", "--username", decodeURIComponent(url.username), "--dbname", url.pathname.slice(1)], {
    env: { PATH: env.PATH, HOME: env.HOME, PGPASSWORD: decodeURIComponent(url.password) }, maxBuffer: 128 * 1024 * 1024, timeout: 60000,
  });
  // Name the cause. "snapshot_database_failed" alone leaves an owner with no
  // move: the 60s timeout and the 128 MB buffer above are real limits a large
  // or slow local database can hit, and neither is fixed by retrying recovery.
  if (dump.error || dump.status !== 0) {
    const code = dump.error?.code;
    const cause = code === "ETIMEDOUT" ? "snapshot_database_timed_out after 60s"
      : code === "ENOBUFS" ? "snapshot_database_too_large for the 128 MB local snapshot bound"
      : "snapshot_database_failed";
    const reported = (dump.stderr?.toString().trim().split("\n").at(-1) ?? "") || code || `pg_dump exit ${dump.status}`;
    throw new Error(`${cause}: ${reported}`);
  }
  const keyPath = path.join(root, "snapshot.key"); noSymlinks(keyPath);
  if (!existsSync(keyPath)) atomicWrite(keyPath, randomBytes(32));
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("snapshot_key_invalid");
  const attachments = [];
  for (const directory of ["brain", "browser-use"]) {
    const source = path.join(root, directory);
    if (!existsSync(source)) continue;
    for (const file of inventory(source)) attachments.push({ path: `${directory}/${file.path}`, sha256: file.sha256, content: readFileSync(path.join(source, file.path)).toString("base64") });
  }
  const journal = path.join(root, "browser-use-journal.json"); noSymlinks(journal);
  if (existsSync(journal)) { const bytes = readFileSync(journal); attachments.push({ path: "browser-use-journal.json", sha256: hash(bytes), content: bytes.toString("base64") }); }
  const content = Buffer.from(JSON.stringify({ database: dump.stdout.toString("base64"), databaseSha256: hash(dump.stdout), attachments }));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("engager-local-sealed-snapshot-1"));
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  const archive = { format: "engager-local-sealed-snapshot-1", version, createdAt: new Date().toISOString(), portable: false, restore: "unsupported_until_P4", keyCustody: "source_installation_only", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), sha256: hash(encrypted), payload: encrypted.toString("base64") };
  atomicWrite(output, JSON.stringify(archive));
  const verified = JSON.parse(readFileSync(output, "utf8"));
  if (hash(Buffer.from(verified.payload, "base64")) !== archive.sha256) throw new Error("snapshot_verification_failed");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(verified.iv, "base64"));
  decipher.setAAD(Buffer.from(verified.format)); decipher.setAuthTag(Buffer.from(verified.tag, "base64"));
  if (hash(Buffer.concat([decipher.update(Buffer.from(verified.payload, "base64")), decipher.final()])) !== hash(content)) throw new Error("snapshot_verification_failed");
  return { state: "snapshot_verified", path: output, sha256: hash(readFileSync(output)), portable: false, restore: "unsupported_until_P4" };
}
