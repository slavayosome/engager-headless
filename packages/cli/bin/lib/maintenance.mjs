import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { atomicWrite, hash, noSymlinks, readJson } from "./ownedFiles.mjs";

/**
 * The FILE half of backup, update and rollback. Every decision it needs —
 * which snapshots may be pruned, whether a payload's publisher signature is
 * good enough, whether a failed update may roll the binary back — is made by
 * `packages/core/supervision/maintenance.ts` and reached through the core
 * command, so the free CLI and the maintained Mac cannot answer the same
 * question two ways.
 *
 * What lives here is what only this side can do: read the snapshot directory,
 * hash a file, delete a pruned one, and move the payload pointer back.
 */

export const SNAPSHOT_DIR = "snapshots";

/** The publisher key THIS installation trusts, or null when it trusts none.
 *
 *  Written once by `install --publisher-key` and never by an update: a payload
 *  that could rotate the key it is checked against would be checking itself.
 *  A source install has no such file, and `unsigned` is a legitimate answer
 *  for it — what it must never do is accept a signature it cannot verify. */
export function trustedPublisher(root) {
  const file = path.join(root, "trusted-publisher.json");
  noSymlinks(file);
  const stored = readJson(file, null);
  if (stored === null) return null;
  if (typeof stored.publicKey !== "string" || !/^[A-Za-z0-9+/=]{40,}$/.test(stored.publicKey)) {
    throw new Error("trusted_publisher_invalid");
  }
  return stored.publicKey;
}

export function setTrustedPublisher(root, publicKey) {
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9+/=]{40,}$/.test(publicKey)) {
    throw new Error("trusted_publisher_invalid");
  }
  const existing = trustedPublisher(root);
  // Idempotent for the same key, refused for a different one: rotating the
  // publisher an install trusts is an owner decision with its own ceremony,
  // not something a repeated `install` can do quietly.
  if (existing !== null && existing !== publicKey) throw new Error("trusted_publisher_rotation_refused");
  atomicWrite(path.join(root, "trusted-publisher.json"), JSON.stringify({ publicKey }));
}

/** Every snapshot on disk, newest first, with the hash a receipt is checked
 *  against. Only this install's own `<root>/snapshots` — never a path an
 *  archive or a caller named. */
export function snapshotInventory(root) {
  const directory = path.join(root, SNAPSHOT_DIR);
  noSymlinks(directory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(directory, name);
      noSymlinks(file);
      const bytes = readFileSync(file);
      return { name, at: statSync(file).mtimeMs, sizeBytes: bytes.length, sha256: hash(bytes) };
    })
    .sort((a, b) => b.at - a.at);
}

/** Whether the snapshot named by a receipt is still on disk and still hashes
 *  to what the receipt recorded. A file edited or truncated since is NOT a
 *  restorable backup, and saying so is the whole point of verifying. */
export function snapshotVerifies(root, name, sha256) {
  const file = path.join(root, SNAPSHOT_DIR, name);
  noSymlinks(file);
  if (!existsSync(file)) return false;
  return hash(readFileSync(file)) === sha256;
}

/** Delete the snapshots the core's retention plan named, and only those. The
 *  plan can never contain the last verified snapshot, so this cannot remove
 *  the file a restore would use. */
export function pruneSnapshots(root, names) {
  const removed = [];
  for (const name of names) {
    if (typeof name !== "string" || name.includes("/") || name.includes("..")) {
      throw new Error("snapshot_name_invalid");
    }
    const file = path.join(root, SNAPSHOT_DIR, name);
    noSymlinks(file);
    if (!existsSync(file)) continue;
    rmSync(file);
    removed.push(name);
  }
  return removed;
}

export function snapshotPath(root, name) {
  mkdirSync(path.join(root, SNAPSHOT_DIR), { recursive: true, mode: 0o700 });
  return path.join(root, SNAPSHOT_DIR, name);
}

/** The manifest an update is about to install, read as JSON so its signature
 *  can be checked over the same bytes the publisher signed. */
export function payloadManifest(source) {
  const file = path.join(source, "payload.json");
  noSymlinks(file);
  return JSON.parse(readFileSync(file, "utf8"));
}
