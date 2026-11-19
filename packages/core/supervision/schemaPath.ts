import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  fingerprintOf,
  inventoryOrder,
  isSnapshot,
  type FingerprintEntry,
} from "../../cli/bin/lib/migrationFingerprint.mjs";

/**
 * SIGNED SCHEMA PATHS — how an installed app admits a forward schema that no
 * edge compiled into it names (`docs/signed-schema-paths.md`).
 *
 * `compatibleSchema` only knows the pairs its own release reviewed, so every
 * release that added a migration used to need a same-schema bridge carrying
 * one more edge. A signed path replaces that edge with evidence the INSTALLED
 * app checks for itself: Engager's release key (the Sparkle EdDSA key this
 * bundle already trusts) signs a list of migrations, and this module proves
 * that its own migration files, rehashed from disk, plus exactly those
 * migrations and the journal extended by them, hash to the candidate's
 * fingerprint. Nothing in a path can remove or rewrite a file, so no signature
 * can describe a backwards step, and a version string or a caller's approval
 * still adds nothing.
 *
 * Paths speak in `pathFingerprintOf`'s identity: drizzle-kit's snapshots are
 * left out on both sides, since nothing applies them, so a candidate that
 * ships none is the same schema as an install whose `.sql` files and journal
 * it equals or extends.
 *
 * The signature is necessary, never sufficient: a path that verifies but does
 * not reproduce the candidate's fingerprint from these bytes is refused.
 */

export const SCHEMA_PATH_FORMAT = "engager-schema-path/2";

/** The feed carries the list base64-encoded inside one appcast element, and
 *  the Mac app hands it over in argv, so it is bounded well below `ARG_MAX`. */
export const SCHEMA_PATHS_LIMIT_BYTES = 256 * 1024;

const JOURNAL = "meta/_journal.json";
const HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIGRATION_FILE = /^(\d{4})_[A-Za-z0-9_-]+\.sql$/;
// Ed25519 SubjectPublicKeyInfo DER is this fixed preamble followed by the raw
// 32-byte key, the form `SUPublicEDKey` carries.
const ED25519_SPKI_PREAMBLE = Buffer.from("302a300506032b6570032100", "hex");

export type SchemaPathMigration = {
  file: string;
  sha256: string;
  /** The journal's `when`: the order Drizzle applies it in. */
  timestamp: number;
  /** The journal entry's own `version` and `breakpoints`, so the extended
   *  journal is rebuilt byte for byte even when they change. */
  version: string;
  breakpoints: boolean;
};

export type SchemaPath = {
  format: typeof SCHEMA_PATH_FORMAT;
  from: string;
  to: string;
  /** In journal order — what a `from` install gains to reach `to`. */
  migrations: SchemaPathMigration[];
};

export type SignedSchemaPath = SchemaPath & { signature: string };

export type SchemaPathRefusal =
  /** The feed's list is not signed paths in this format. */
  | "schema_path_malformed"
  /** This install's own files do not hash to its schema, or the described
   *  target does not hash to the path's `to`. */
  | "schema_path_inventory_mismatch"
  /** No path in the list starts at this install's schema. */
  | "schema_path_missing"
  | "schema_path_signature_invalid"
  /** Signed for another schema than the one the update claims. */
  | "schema_path_target_mismatch"
  /** It would reorder, rewrite or skip history Drizzle has already applied. */
  | "schema_path_not_forward"
  /** This install's journal is not in the form drizzle-kit writes. */
  | "schema_path_journal_unrecognized";

export type SchemaPathAdmission =
  /** `path` is null when the candidate is this install's own migrations. */
  | { allowed: true; path: SignedSchemaPath | null }
  | { allowed: false; refusal: SchemaPathRefusal };

/** The signed bytes: the format as a domain tag, so no signature this key
 *  makes over a disk image can be presented as one over a path, then the
 *  path's fields in a fixed order, rebuilt from parsed values rather than
 *  taken from whatever bytes the feed carried. */
export function schemaPathBytes(path: SchemaPath): Buffer {
  const canonical = {
    format: path.format,
    from: path.from,
    to: path.to,
    migrations: path.migrations.map(({ file, sha256, timestamp, version, breakpoints }) => ({ file, sha256, timestamp, version, breakpoints })),
  };
  return Buffer.from(`${SCHEMA_PATH_FORMAT}\n${JSON.stringify(canonical)}`, "utf8");
}

export function encodeSchemaPaths(paths: readonly SignedSchemaPath[]): string {
  return Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
}

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function readMigration(value: unknown): SchemaPathMigration | null {
  if (!exactKeys(value, ["file", "sha256", "timestamp", "version", "breakpoints"])) return null;
  const { file, sha256, timestamp, version, breakpoints } = value;
  return typeof file === "string" && MIGRATION_FILE.test(file) &&
    typeof sha256 === "string" && HEX.test(sha256) &&
    typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0 &&
    typeof version === "string" && version.length > 0 && typeof breakpoints === "boolean"
    ? { file, sha256, timestamp, version, breakpoints }
    : null;
}

function readPath(value: unknown): SignedSchemaPath | null {
  if (!exactKeys(value, ["format", "from", "to", "migrations", "signature"])) return null;
  const { format, from, to, migrations, signature } = value;
  if (format !== SCHEMA_PATH_FORMAT || typeof from !== "string" || !HEX.test(from) ||
    typeof to !== "string" || !HEX.test(to) || typeof signature !== "string" ||
    !BASE64.test(signature) || !Array.isArray(migrations)) return null;
  const read = migrations.map(readMigration);
  return read.every((migration) => migration !== null)
    ? { format, from, to, migrations: read as SchemaPathMigration[], signature }
    : null;
}

/** The feed's untrusted list, or null when any part of it is not a signed path
 *  in this format. Two paths from one schema are refused rather than chosen
 *  between. */
export function readSchemaPaths(encoded: string): SignedSchemaPath[] | null {
  if (encoded.length > SCHEMA_PATHS_LIMIT_BYTES || !BASE64.test(encoded)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const paths = parsed.map(readPath);
  if (!paths.every((path) => path !== null)) return null;
  const read = paths as SignedSchemaPath[];
  return new Set(read.map((path) => path.from)).size === read.length ? read : null;
}

function signatureHolds(path: SignedSchemaPath, trustedPublicKey: string | null): boolean {
  if (!trustedPublicKey) return false;
  try {
    const raw = Buffer.from(trustedPublicKey, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREAMBLE, raw]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, schemaPathBytes(path), key, Buffer.from(path.signature, "base64"));
  } catch {
    return false;
  }
}

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = Record<string, unknown> & { entries: JournalEntry[] };

/** The journal, only when its bytes are exactly what drizzle-kit writes for
 *  it, since the destination's journal is rebuilt in that form and hashed. */
function readJournal(text: string): Journal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Journal).entries)) return null;
  const journal = parsed as Journal;
  const wellFormed = journal.entries.length > 0 && journal.entries.every((entry, index) =>
    exactKeys(entry, ["idx", "version", "when", "tag", "breakpoints"]) && entry.idx === index &&
    typeof entry.version === "string" && Number.isSafeInteger(entry.when) &&
    typeof entry.tag === "string" && typeof entry.breakpoints === "boolean");
  return wellFormed && JSON.stringify(journal, null, 2) === text ? journal : null;
}

/** The journal `migrations` extend this one into, in drizzle-kit's form. */
export function extendedJournal(journal: string, migrations: readonly SchemaPathMigration[]): string | null {
  const read = readJournal(journal);
  if (!read) return null;
  return JSON.stringify({
    ...read,
    entries: [
      ...read.entries,
      ...migrations.map((migration, index) => ({
        idx: read.entries.length + index,
        version: migration.version,
        when: migration.timestamp,
        tag: migration.file.slice(0, -".sql".length),
        breakpoints: migration.breakpoints,
      })),
    ],
  }, null, 2);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * May this install's schema be carried to the candidate's by a signed path?
 *
 * `inventory` and `journal` are this install's own migration directory as the
 * CLI rehashed and read it from disk just now — never values the feed or the
 * update supplied — and `trustedPublicKey` is the `SUPublicEDKey` of the
 * bundle that is running. Everything else is untrusted.
 */
export function schemaPathAdmission(input: {
  /** The feed's encoded list, as `encodeSchemaPaths` wrote it. */
  schemaPaths: string | null;
  trustedPublicKey: string | null;
  currentSchemaHash: string | null;
  candidateSchemaHash: string | null;
  inventory: readonly FingerprintEntry[];
  journal: string | null;
}): SchemaPathAdmission {
  const current = fingerprintOf(input.inventory);
  const journalEntry = input.inventory.find((entry) => entry.path === JOURNAL);
  if (current !== input.currentSchemaHash || input.journal === null ||
    journalEntry?.sha256 !== sha256(input.journal)) {
    return { allowed: false, refusal: "schema_path_inventory_mismatch" };
  }
  const files = input.inventory.filter((entry) => !isSnapshot(entry.path));
  const base = fingerprintOf(files);
  // The same migrations, differing only in the snapshots one side ships.
  if (base === input.candidateSchemaHash) return { allowed: true, path: null };
  const paths = input.schemaPaths === null ? null : readSchemaPaths(input.schemaPaths);
  if (!paths) return { allowed: false, refusal: "schema_path_malformed" };
  const path = paths.find((candidate) => candidate.from === base);
  if (!path) return { allowed: false, refusal: "schema_path_missing" };
  if (!signatureHolds(path, input.trustedPublicKey)) {
    return { allowed: false, refusal: "schema_path_signature_invalid" };
  }
  if (path.to !== input.candidateSchemaHash) {
    return { allowed: false, refusal: "schema_path_target_mismatch" };
  }
  const journal = readJournal(input.journal);
  if (!journal) return { allowed: false, refusal: "schema_path_journal_unrecognized" };

  // Forward means after everything Drizzle has applied, in order, and only
  // into names this install does not already hold: its migrator would skip a
  // migration timestamped earlier than its last, without a word.
  const existing = new Set(files.map((entry) => entry.path));
  const added = path.migrations.map((migration) => ({ path: migration.file, sha256: migration.sha256 }));
  const lastApplied = journal.entries[journal.entries.length - 1]!.when;
  const forward = path.migrations.length > 0 &&
    path.migrations.every((migration, index) =>
      migration.timestamp > (index === 0 ? lastApplied : path.migrations[index - 1]!.timestamp)) &&
    added.every((entry) => !existing.has(entry.path)) &&
    new Set(added.map((entry) => entry.path)).size === added.length;
  if (!forward) return { allowed: false, refusal: "schema_path_not_forward" };

  const target = [
    ...files
      .filter((entry) => entry.path !== JOURNAL)
      .map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    { path: JOURNAL, sha256: sha256(extendedJournal(input.journal, path.migrations)!) },
    ...added,
  ].sort(inventoryOrder);
  return fingerprintOf(target) === path.to
    ? { allowed: true, path }
    : { allowed: false, refusal: "schema_path_inventory_mismatch" };
}
