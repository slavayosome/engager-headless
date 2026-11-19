import { hash, inventory } from "./ownedFiles.mjs";

/**
 * THE schema identity — one function, one hash space, every placement.
 *
 * Fingerprint the migration bytes, independent of file modes or bundle path.
 * The feed is a hint; the newly signed bundle must prove these bytes again
 * before its migrator runs. Missing metadata never means compatible.
 *
 * It is a LEAF on purpose. `packages/core/supervision/schemaCompatibility.ts`
 * records the reviewed edge in this hash space, the Mac path reads it through
 * `macMaintenance.mjs`. Before 2026-09-15 the release assembler computed
 * its own — `hash(JSON.stringify(files.filter(migrations)))` over the full
 * inventory entries, `{path, sha256, bytes, mode}` — so a free install's
 * `installation.json.schemaHash` and the edge's `from`/`to` were two different
 * numbers for the same bytes, and `compatibleSchema()` on the free path could
 * match nothing but identity. No schema-changing release could ever be applied
 * to a free install. A second spelling of this hash is that defect; importing
 * this module is the fix.
 *
 * Only `path` and `sha256` take part: a mode or a byte length that changed
 * without the content changing is not a different schema, and the archive's
 * own inventory already covers those for artifact identity.
 */
export function migrationFingerprint(directory) {
  return fingerprintOf(inventory(directory));
}

/** The entries that hash, in `inventory()` order: what a signed schema path is
 *  checked against and signed from. */
export function migrationInventory(directory) {
  return inventory(directory).map(({ path, sha256 }) => ({ path, sha256 }));
}

/** The same hash over entries already in `inventory()` order — what a signed
 *  schema path (`packages/core/supervision/schemaPath.ts`) computes for a
 *  directory it has described rather than read. */
export function fingerprintOf(entries) {
  return hash(JSON.stringify(entries.map(({ path, sha256 }) => ({ path, sha256 }))));
}

/** drizzle-kit's `meta/<nnnn>_snapshot.json`: tooling input, never applied. */
export const isSnapshot = (path) => /^meta\/\d{4}_snapshot\.json$/.test(path);

/** The identity signed schema paths are written in: the same hash with the
 *  snapshots left out, so a tree that ships none hashes as it always did and
 *  one that does still names the schema its `.sql` files and journal define. */
export function pathFingerprintOf(entries) {
  return fingerprintOf(entries.filter(({ path }) => !isSnapshot(path)));
}

/** `inventory()`'s order, spelled over relative paths: siblings by
 *  `localeCompare` of their names, a directory's files where its name sorts. */
export function inventoryOrder(a, b) {
  const left = a.path.split("/"), right = b.path.split("/");
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = left[index].localeCompare(right[index]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}
