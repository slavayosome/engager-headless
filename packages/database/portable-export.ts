/**
 * The owner's portable export: what travels, what never does, and the
 * unresolved obligations that must survive the trip (ADR-08).
 *
 * Three properties this module exists to hold.
 *
 * **No live secret leaves.** `secrets` — the one manifest table whose rows are
 * ciphertext under the installation's `ENGAGER_MASTER_KEY` — is excluded here,
 * on top of every credential/runtime table `export-manifest.ts` already
 * excludes. So the archive carries nothing encrypted under that key, and the
 * archive's own protection is re-encryption under a key derived from a
 * passphrase the OWNER supplies. Restoring therefore needs new credentials, and
 * an exported master key is not part of the contract in either direction.
 *
 * **Obligations travel as evidence, never as instructions.** A prepared or
 * uncertain send, an unsettled provider reservation, an unresolved delivery
 * receipt and an open transfer intent all appear in the manifest with their
 * identity and state. A destination reads them to know what is still open; it
 * may never read one as permission to repeat the request behind it.
 *
 * **Nothing is replaced before everything is checked.** Format, schema
 * compatibility, content hash, per-table row hashes and attachment paths are
 * all verified before a restore touches live data, and a NEWER schema is
 * refused outright rather than partially imported.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import { EXPORT_TENANT_TABLES } from "./export-manifest";

export const PORTABLE_EXPORT_FORMAT = "engager-portable-export-1";

/**
 * Tables the portable archive additionally leaves behind, beyond everything
 * `export-manifest.ts` already excludes. Each entry is a REUSABLE credential,
 * not authored content: carrying it would hand a second install a working
 * session rather than the owner's data.
 */
export const PORTABLE_EXCLUDED_TABLES: readonly {
  table: string;
  reason: string;
}[] = [
  {
    table: "secrets",
    reason:
      "Provider credentials and browser session material, ciphertext under this installation's master key. Restoring asks for new credentials instead.",
  },
];

const PORTABLE_TABLES = EXPORT_TENANT_TABLES.filter(
  (table) =>
    !PORTABLE_EXCLUDED_TABLES.some((excluded) => excluded.table === table),
);

export type PortableObligationKind =
  | "message_send"
  | "email_delivery"
  | "broker_turn"
  | "engagement_action"
  | "transfer";

export type PortableObligation = {
  kind: PortableObligationKind;
  /** Stable within its kind. Enough to find the row, never enough to repeat
   * the provider request it describes. */
  id: string;
  state: string;
  recordedAt: number | null;
};

export type PortableTableDigest = {
  table: string;
  rows: number;
  sha256: string;
};

export type PortableSchemaIdentity = {
  /** How many migrations the SOURCE had applied. A destination with fewer is
   * an older schema and refuses the import rather than half-reading it. */
  appliedMigrations: number;
  /** The head migration's own hash, for evidence rather than comparison. */
  head: string | null;
};

export type PortableManifest = {
  format: typeof PORTABLE_EXPORT_FORMAT;
  createdAt: string;
  snapshotId: string;
  /** The transfer this export belongs to, when it was made for a handoff. */
  transferId: string | null;
  coreVersion: string;
  schema: PortableSchemaIdentity;
  organizationId: string;
  /** Purpose-specific account index, not the network account identity. */
  accountBinding: string | null;
  vaultRevision: string | null;
  tables: PortableTableDigest[];
  attachments: { path: string; bytes: number; sha256: string }[];
  obligations: PortableObligation[];
  excluded: { table: string; reason: string }[];
};

export type PortableContent = {
  manifest: PortableManifest;
  /** Rows keyed by table, in the manifest's order. */
  rows: Record<string, Record<string, unknown>[]>;
  /** Brain vault files and other owner attachments, base64. */
  attachments: { path: string; content: string }[];
};

export type PortableArchive = {
  format: typeof PORTABLE_EXPORT_FORMAT;
  /** Repeated in the clear so a reader can refuse an incompatible archive
   * before asking anyone for a passphrase. */
  manifestPreview: Pick<
    PortableManifest,
    "createdAt" | "coreVersion" | "schema" | "organizationId" | "snapshotId"
  >;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  iv: string;
  tag: string;
  /** sha256 of the ciphertext, so corruption is named before decryption. */
  sha256: string;
  payload: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic bytes for one table's rows: column order comes from the
 * source's own `information_schema`, so two exports of the same rows hash the
 * same and a reordered SELECT never looks like a changed table. */
export function digestRows(
  table: string,
  rows: readonly Record<string, unknown>[],
): PortableTableDigest {
  const hash = createHash("sha256");
  for (const row of rows) {
    const keys = Object.keys(row).sort();
    hash.update(
      JSON.stringify(keys.map((key) => [key, row[key] ?? null])),
    );
    hash.update("\n");
  }
  return { table, rows: rows.length, sha256: hash.digest("hex") };
}

/**
 * Everything still open for this organization at the moment of the snapshot.
 *
 * Deliberately conservative in one direction: a state that MIGHT mean a
 * provider request was made is listed. Nothing here distinguishes "definitely
 * not sent" from "unknown" — that judgement belongs to reconciliation against
 * the provider, not to an exporter.
 */
export async function collectPortableObligations(
  client: PoolClient,
  organizationId: string,
): Promise<PortableObligation[]> {
  const obligations: PortableObligation[] = [];
  const push = async (
    kind: PortableObligationKind,
    sql: string,
  ): Promise<void> => {
    const result = await client.query<{
      id: string;
      state: string;
      recorded_at: string | null;
    }>(sql, [organizationId]);
    for (const row of result.rows) {
      obligations.push({
        kind,
        id: row.id,
        state: row.state,
        recordedAt: row.recorded_at === null ? null : Number(row.recorded_at),
      });
    }
  };
  await push(
    "message_send",
    `select id::text as id, status as state, posting_started_at as recorded_at
       from messages where organization_id = $1 and status in ('posting', 'needs_review')`,
  );
  await push(
    "email_delivery",
    `select id::text as id, state, last_attempt_at as recorded_at
       from email_delivery_receipts where organization_id = $1 and state in ('sending', 'uncertain')`,
  );
  await push(
    "broker_turn",
    `select id::text as id, status as state, created_at as recorded_at
       from chat_broker_turns where organization_id = $1 and status in ('running', 'recovery_required')`,
  );
  await push(
    "engagement_action",
    `select id::text as id, coalesce(meta->>'state', 'unknown') as state, ts as recorded_at
       from rate_limit_ledger where organization_id = $1 and action = 'like'
        and meta->>'state' in ('reserved', 'uncertain')`,
  );
  await push(
    "transfer",
    `select id::text as id, state, updated_at as recorded_at
       from transfer_intents where organization_id = $1
        and state not in ('activated', 'abandoned')`,
  );
  return obligations;
}

async function schemaIdentity(
  client: PoolClient,
): Promise<PortableSchemaIdentity> {
  const result = await client.query<{ count: string; head: string | null }>(
    `select count(*)::text as count, max(hash) filter (where id = (select max(id) from drizzle.__drizzle_migrations)) as head
       from drizzle.__drizzle_migrations`,
  );
  return {
    appliedMigrations: Number(result.rows[0]?.count ?? 0),
    head: result.rows[0]?.head ?? null,
  };
}

async function columnsOf(
  client: PoolClient,
  table: string,
): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

function selectionPredicate(table: string): string {
  if (table === "organizations") return `"id" = $1`;
  if (table === "users") {
    return `"id" in (select user_id from memberships where organization_id = $1)`;
  }
  return `"organization_id" = $1`;
}

/**
 * Read one organization's portable content. The caller supplies a client that
 * has already fenced the source and opened its snapshot transaction — this
 * function reads and hashes, it does not decide when the source is quiet.
 */
export async function buildPortableExport(input: {
  client: PoolClient;
  organizationId: string;
  coreVersion: string;
  transferId?: string | null;
  accountBinding?: string | null;
  vaultRevision?: string | null;
  attachments?: { path: string; content: Buffer }[];
  snapshotId?: string;
  now?: Date;
}): Promise<PortableContent> {
  const { client, organizationId } = input;
  const rows: Record<string, Record<string, unknown>[]> = {};
  const tables: PortableTableDigest[] = [];
  for (const table of PORTABLE_TABLES) {
    const columns = await columnsOf(client, table);
    if (columns.length === 0) {
      throw new Error(`Cannot export missing table "${table}".`);
    }
    const result = await client.query<Record<string, unknown>>(
      `select ${columns.map((column) => `"${column}"`).join(", ")} from "${table}"
        where ${selectionPredicate(table)} order by ${columns
          .map((column) => `"${column}"`)
          .join(", ")}`,
      [organizationId],
    );
    rows[table] = result.rows;
    tables.push(digestRows(table, result.rows));
  }
  const attachments = (input.attachments ?? []).map((attachment) => ({
    path: attachment.path,
    content: attachment.content.toString("base64"),
  }));
  const manifest: PortableManifest = {
    format: PORTABLE_EXPORT_FORMAT,
    createdAt: (input.now ?? new Date()).toISOString(),
    snapshotId: input.snapshotId ?? randomBytes(16).toString("hex"),
    transferId: input.transferId ?? null,
    coreVersion: input.coreVersion,
    schema: await schemaIdentity(client),
    organizationId,
    accountBinding: input.accountBinding ?? null,
    vaultRevision: input.vaultRevision ?? null,
    tables,
    attachments: (input.attachments ?? []).map((attachment) => ({
      path: attachment.path,
      bytes: attachment.content.byteLength,
      sha256: sha256(attachment.content),
    })),
    obligations: await collectPortableObligations(client, organizationId),
    excluded: [...PORTABLE_EXCLUDED_TABLES],
  };
  return { manifest, rows, attachments };
}

/** Tables an older archive stores under a name this schema has since renamed;
 *  `upgradeRenamedRows` (`portable-restore.ts`) moves their rows across. */
export const RENAMED_ARCHIVE_TABLES: Readonly<Record<string, string>> = {
  journeys: "conversations",
  journey_events: "conversation_events",
  journey_sources: "conversation_sources",
  automation_runs: "worker_runs",
  listening_phrases: "searches",
  listening_phrase_changes: "search_changes",
  listening_map_plans: "search_plans",
  interactive_stages: "tasks",
  campaign_definitions: "campaign_strategies",
  action_executions: "actions",
};

const SCRYPT_PARAMETERS = { N: 32768, r: 8, p: 1 } as const;

function deriveKey(
  passphrase: string,
  salt: Buffer,
  parameters: { N: number; r: number; p: number },
): Buffer {
  return scryptSync(passphrase, salt, 32, {
    ...parameters,
    // scrypt's default 32 MiB budget is below what N=32768 needs.
    maxmem: 256 * 1024 * 1024,
  });
}

export class PortableArchiveError extends Error {
  constructor(
    readonly code:
      | "unsupported_format"
      | "corrupt_archive"
      | "wrong_passphrase"
      | "incompatible_schema"
      | "unsafe_attachment_path"
      | "manifest_mismatch"
      | "wrong_organization"
      /** The destination already handed its execution to another install. */
      | "authority_moved",
    message: string,
  ) {
    super(message);
    this.name = "PortableArchiveError";
  }
}

/** One name for the archive a restore came from: the manifest's own bytes,
 * which already carry the per-table digests. Recorded on the destination's
 * handoff record so "which snapshot is this install running?" has an answer
 * that is not a filename. */
export function portableManifestSha256(manifest: PortableManifest): string {
  return sha256(JSON.stringify(manifest));
}

/** Re-encrypt the portable content under a key derived from the OWNER's
 * passphrase. Nothing in the archive is protected by the installation master
 * key, which is what makes it restorable on a machine that never had one. */
export function sealPortableArchive(
  content: PortableContent,
  passphrase: string,
): PortableArchive {
  if (passphrase.length < 12) {
    throw new PortableArchiveError(
      "wrong_passphrase",
      "A portable export passphrase must be at least 12 characters.",
    );
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveKey(passphrase, salt, SCRYPT_PARAMETERS),
    iv,
  );
  const manifestPreview = {
    createdAt: content.manifest.createdAt,
    coreVersion: content.manifest.coreVersion,
    schema: content.manifest.schema,
    organizationId: content.manifest.organizationId,
    snapshotId: content.manifest.snapshotId,
  };
  // The cleartext preview is authenticated: a tampered preview changes the AAD
  // and the tag no longer verifies, so a reader cannot be lied to about the
  // schema or organization before it decrypts.
  cipher.setAAD(
    Buffer.from(
      `${PORTABLE_EXPORT_FORMAT}\n${JSON.stringify(manifestPreview)}`,
      "utf8",
    ),
  );
  const plaintext = Buffer.from(JSON.stringify(content), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: PORTABLE_EXPORT_FORMAT,
    manifestPreview,
    kdf: { name: "scrypt", salt: salt.toString("base64"), ...SCRYPT_PARAMETERS },
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    sha256: sha256(encrypted),
    payload: encrypted.toString("base64"),
  };
}

function isPortableArchive(value: unknown): value is PortableArchive {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  const kdf = a.kdf as Record<string, unknown> | undefined;
  return (
    a.format === PORTABLE_EXPORT_FORMAT &&
    typeof a.manifestPreview === "object" &&
    a.manifestPreview !== null &&
    typeof kdf?.salt === "string" &&
    kdf.name === "scrypt" &&
    typeof kdf.N === "number" &&
    typeof kdf.r === "number" &&
    typeof kdf.p === "number" &&
    typeof a.iv === "string" &&
    typeof a.tag === "string" &&
    typeof a.sha256 === "string" &&
    typeof a.payload === "string"
  );
}

/** An attachment path must stay inside the restore root: no absolute path, no
 * `..` segment, no drive letter, no backslash. Checked before anything is
 * written, and again by the writer. */
export function safeAttachmentPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === ".." || segment === "")
  );
}

/**
 * Open and fully verify an archive. Every refusal below happens BEFORE a caller
 * can touch live data, which is the whole point: a corrupt or incompatible
 * archive must never half-replace an owner's install.
 */
export function openPortableArchive(
  raw: unknown,
  input: {
    passphrase: string;
    /** How many migrations the DESTINATION has applied. */
    appliedMigrations: number;
    /** When set, the archive must describe this organization. */
    organizationId?: string;
  },
): PortableContent {
  if (!isPortableArchive(raw)) {
    throw new PortableArchiveError(
      "unsupported_format",
      "This file is not an Engager portable export.",
    );
  }
  const encrypted = Buffer.from(raw.payload, "base64");
  if (sha256(encrypted) !== raw.sha256) {
    throw new PortableArchiveError(
      "corrupt_archive",
      "This archive's contents do not match its checksum.",
    );
  }
  if (raw.manifestPreview.schema.appliedMigrations > input.appliedMigrations) {
    throw new PortableArchiveError(
      "incompatible_schema",
      "This archive was written by a newer Engager. Update this installation before restoring it.",
    );
  }
  if (
    input.organizationId !== undefined &&
    raw.manifestPreview.organizationId !== input.organizationId
  ) {
    throw new PortableArchiveError(
      "wrong_organization",
      "This archive belongs to a different organization.",
    );
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(input.passphrase, Buffer.from(raw.kdf.salt, "base64"), raw.kdf),
      Buffer.from(raw.iv, "base64"),
    );
    decipher.setAAD(
      Buffer.from(
        `${PORTABLE_EXPORT_FORMAT}\n${JSON.stringify(raw.manifestPreview)}`,
        "utf8",
      ),
    );
    decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    // GCM cannot distinguish a wrong key from tampered bytes, and neither can
    // this: both mean "do not import".
    throw new PortableArchiveError(
      "wrong_passphrase",
      "This archive could not be opened with that passphrase, or its contents were altered.",
    );
  }

  let content: PortableContent;
  try {
    content = JSON.parse(plaintext.toString("utf8")) as PortableContent;
  } catch {
    throw new PortableArchiveError(
      "corrupt_archive",
      "This archive's contents could not be read.",
    );
  }
  assertContentMatchesManifest(content, raw);
  return content;
}

function assertContentMatchesManifest(
  content: PortableContent,
  archive: PortableArchive,
): void {
  const manifest = content.manifest;
  if (
    manifest?.format !== PORTABLE_EXPORT_FORMAT ||
    manifest.snapshotId !== archive.manifestPreview.snapshotId ||
    manifest.organizationId !== archive.manifestPreview.organizationId ||
    manifest.schema.appliedMigrations !==
      archive.manifestPreview.schema.appliedMigrations
  ) {
    throw new PortableArchiveError(
      "manifest_mismatch",
      "This archive's manifest disagrees with its own header.",
    );
  }
  const declared = new Map(manifest.tables.map((entry) => [entry.table, entry]));
  if (declared.size !== manifest.tables.length) {
    throw new PortableArchiveError(
      "manifest_mismatch",
      "This archive names a table more than once.",
    );
  }
  for (const table of PORTABLE_TABLES) {
    // An archive written before a rename stores the table under its old name.
    const stored = [table, ...Object.keys(RENAMED_ARCHIVE_TABLES).filter((old) => RENAMED_ARCHIVE_TABLES[old] === table)]
      .filter((name) => declared.has(name) || content.rows?.[name] !== undefined);
    if (stored.length > 1) {
      throw new PortableArchiveError(
        "manifest_mismatch",
        `This archive names "${table}" more than once.`,
      );
    }
    const name = stored[0] ?? table;
    const entry = declared.get(name);
    const rows = content.rows?.[name];
    if (!entry || !Array.isArray(rows)) {
      throw new PortableArchiveError(
        "manifest_mismatch",
        `This archive is missing "${table}".`,
      );
    }
    const digest = digestRows(name, rows);
    if (digest.rows !== entry.rows || digest.sha256 !== entry.sha256) {
      throw new PortableArchiveError(
        "corrupt_archive",
        `The rows of "${name}" do not match this archive's manifest.`,
      );
    }
  }
  for (const excluded of PORTABLE_EXCLUDED_TABLES) {
    if (content.rows?.[excluded.table] !== undefined) {
      throw new PortableArchiveError(
        "manifest_mismatch",
        `This archive carries "${excluded.table}", which a portable export never contains.`,
      );
    }
  }
  const attachments = new Map(
    manifest.attachments.map((entry) => [entry.path, entry]),
  );
  for (const attachment of content.attachments ?? []) {
    if (!safeAttachmentPath(attachment.path)) {
      throw new PortableArchiveError(
        "unsafe_attachment_path",
        `This archive contains an unsafe path: ${attachment.path}`,
      );
    }
    const declaredAttachment = attachments.get(attachment.path);
    const bytes = Buffer.from(attachment.content, "base64");
    if (
      !declaredAttachment ||
      declaredAttachment.bytes !== bytes.byteLength ||
      !timingSafeEqual(
        Buffer.from(declaredAttachment.sha256, "hex"),
        Buffer.from(sha256(bytes), "hex"),
      )
    ) {
      throw new PortableArchiveError(
        "corrupt_archive",
        `The attachment "${attachment.path}" does not match this archive's manifest.`,
      );
    }
  }
}

export { PORTABLE_TABLES };
