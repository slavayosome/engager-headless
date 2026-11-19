import { createPublicKey, verify as verifySignature } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  maintenanceReceipts,
  type MaintenanceReceiptRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { compatibleSchema } from "./schemaCompatibility";
import { schemaPathAdmission } from "./schemaPath";
export { compatibleSchema, migrationHistoryAdmission } from "./schemaCompatibility";

/**
 * BACKUP, UPDATE AND ROLLBACK — the decisions, in one place, so the free CLI
 * that owns the files and the maintained Mac that triggers them cannot answer
 * the same question two ways (ADR-08).
 *
 * The mechanics stay where they already are: `localSnapshot` writes and
 * verifies a snapshot, `installPayload` stages a payload and switches a
 * pointer. What is here is what those two are not allowed to decide for
 * themselves —
 *
 * - which snapshots may be pruned, and the one that never may;
 * - whether an artifact's publisher signature is good enough to install;
 * - whether an update may proceed at all without a restorable backup;
 * - whether a failed update may roll the binary back, or must stop paused.
 *
 * Every function here is pure except the three that write receipts, and those
 * write only receipts: nothing in this module starts, stops or enqueues work.
 */

/** Verified local snapshots retained initially. Policy constant (ADR-08), not
 *  a paid guarantee, and adjustable without touching the pruning rule. */
export const BACKUP_RETAIN_COUNT = 7;

export type BackupCandidate = {
  /** File name inside the installation's snapshot directory. Never a path. */
  name: string;
  at: number;
  /** Whether this snapshot's own verification passed when it was written. A
   *  failed snapshot is a file on disk and NOT a restorable backup. */
  verified: boolean;
};

export type BackupRetention = {
  /** Newest first, the verified snapshots this install keeps. */
  keep: BackupCandidate[];
  /** Safe to delete: everything beyond the retention count, plus every failed
   *  snapshot — but NEVER the newest verified one, whatever the count says. */
  prune: BackupCandidate[];
  /** The snapshot a restore would use, or null when there is none. */
  lastVerified: BackupCandidate | null;
};

/**
 * Which snapshots stay and which go.
 *
 * "Never prune the last verified snapshot" is enforced here as a property of
 * the partition rather than as a caller's promise: `prune` cannot contain
 * `lastVerified`, so a retention count someone later sets to zero deletes
 * everything except the one file that makes recovery possible.
 */
export function planBackupRetention(
  candidates: readonly BackupCandidate[],
  retain: number = BACKUP_RETAIN_COUNT,
): BackupRetention {
  const newestFirst = [...candidates].sort((a, b) => b.at - a.at);
  const verified = newestFirst.filter((candidate) => candidate.verified);
  const lastVerified = verified[0] ?? null;
  const keep = verified.slice(0, Math.max(0, retain));
  const kept = new Set(keep.map((candidate) => candidate.name));
  if (lastVerified && !kept.has(lastVerified.name)) {
    keep.unshift(lastVerified);
    kept.add(lastVerified.name);
  }
  return {
    keep,
    prune: newestFirst.filter((candidate) => !kept.has(candidate.name)),
    lastVerified,
  };
}

export type PayloadSignature = "verified" | "invalid" | "unsigned";

/**
 * Whether the payload's publisher signature holds.
 *
 * Deliberately three-valued. An `unsigned` payload is not a failure by itself
 * — a source build carries a manifest hash and no publisher signature, and
 * that install trusts no publisher key — but it is a refusal for an
 * installation that HAS a trusted key, because accepting one there would let a
 * maintained Mac be walked back to an unsigned artifact.
 *
 * The signed bytes are a CANONICAL rendering of the manifest rather than the
 * file's own bytes: `signature` is dropped, the remaining TOP-LEVEL keys are
 * sorted, and the parsed object is re-serialized with `JSON.stringify` — so
 * nested objects keep their parse order and the file's own whitespace and key
 * order are not covered. `signedManifestBytes` below is that rule, and
 * publisher tooling has to sign exactly what it returns: signing the raw
 * `payload.json` bytes produces an artifact this verifier rejects.
 */
export function signedManifestBytes(manifest: Record<string, unknown>): Buffer {
  const { signature: _signature, ...rest } = manifest;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(rest).sort()) ordered[key] = rest[key];
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function verifyPayloadSignature(input: {
  manifest: Record<string, unknown>;
  /** The publisher key this installation trusts, base64 SPKI DER, or null when
   *  it trusts none. */
  trustedPublicKey: string | null;
}): PayloadSignature {
  const signature = input.manifest.signature;
  if (typeof signature !== "string" || signature.length === 0) return "unsigned";
  if (input.trustedPublicKey === null) {
    // A signature this install cannot check is not evidence. It is refused
    // rather than trusted, which is the same trade `Updater.isEnabled` makes
    // for an appcast with no public key beside it.
    return "invalid";
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(input.trustedPublicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return verifySignature(
      null,
      signedManifestBytes(input.manifest),
      key,
      Buffer.from(signature, "base64"),
    )
      ? "verified"
      : "invalid";
  } catch {
    return "invalid";
  }
}

export type UpdateRefusal =
  | "artifact_signature_invalid"
  | "artifact_signature_missing"
  | "update_schema_compatibility_unverified"
  | "update_requires_verified_backup";

export type UpdateAdmission =
  | { allowed: true; signature: PayloadSignature }
  | { allowed: false; signature: PayloadSignature; refusal: UpdateRefusal };

/**
 * May this payload replace the running one?
 *
 * Order is deliberate: publisher first (is this artifact from whom this install
 * trusts), then compatibility (can this database serve it), then recoverability
 * (is there something to go back to). An install that fails the last check has
 * a perfectly good payload and no way back from it, which is exactly the case
 * ADR-08 blocks rather than risks.
 *
 * Artifact IDENTITY is deliberately not re-decided here: `verifyPayload`
 * (`packages/cli/bin/lib/payloadInstaller.mjs`) owns the hash, the inventory and the
 * platform, and it runs on the same bytes a moment later. Repeating its hash
 * comparison would be a second implementation of the same check that could
 * disagree with the first.
 */
export function updateAdmission(input: {
  manifest: Record<string, unknown>;
  trustedPublicKey: string | null;
  /** The running and candidate schema fingerprints. Byte inventories change
   * even for additive migrations. Only equality, a reviewed exact migration
   * edge or a signed forward path is admitted, never an assumption based on
   * version ordering. */
  currentSchemaHash: string | null;
  candidateSchemaHash: string | null;
  /** The evidence `schemaPathAdmission` weighs for a pair no edge names: the
   *  feed's signed paths beside this install's own key and migration files. */
  schemaPath?: Omit<Parameters<typeof schemaPathAdmission>[0], "currentSchemaHash" | "candidateSchemaHash">;
  /** From `lastVerifiedBackup`. A first install has none and needs none. */
  hasRestorableBackup: boolean;
  isFirstInstall: boolean;
}): UpdateAdmission {
  const signature = verifyPayloadSignature(input);
  if (signature === "invalid") {
    return { allowed: false, signature, refusal: "artifact_signature_invalid" };
  }
  if (signature === "unsigned" && input.trustedPublicKey !== null) {
    return { allowed: false, signature, refusal: "artifact_signature_missing" };
  }
  if (
    !input.isFirstInstall &&
    !compatibleSchema(input.currentSchemaHash, input.candidateSchemaHash, "update") &&
    !(input.schemaPath && schemaPathAdmission({
      ...input.schemaPath,
      currentSchemaHash: input.currentSchemaHash,
      candidateSchemaHash: input.candidateSchemaHash,
    }).allowed)
  ) {
    return {
      allowed: false,
      signature,
      refusal: "update_schema_compatibility_unverified",
    };
  }
  if (!input.isFirstInstall && !input.hasRestorableBackup) {
    return { allowed: false, signature, refusal: "update_requires_verified_backup" };
  }
  return { allowed: true, signature };
}

export type RollbackAdmission =
  | { allowed: true; to: string }
  | { allowed: false; reason: "no_prior_payload" | "schema_incompatible" };

/**
 * May a failed update roll the BINARY back?
 *
 * Only across a proven compatible schema. A different fingerprint does not
 * establish whether the prior binary can interpret it; the outcome is
 * `paused_recovery` with
 * the data intact and the restore path documented, never a down-migration and
 * never an older binary started against a newer authority shape (the frozen
 * common rule: "never remove a safety fence to make an old binary run").
 */
export function rollbackAdmission(input: {
  priorPayload: string | null;
  currentSchemaHash: string | null;
  priorSchemaHash: string | null;
}): RollbackAdmission {
  if (!input.priorPayload) return { allowed: false, reason: "no_prior_payload" };
  if (!compatibleSchema(input.currentSchemaHash, input.priorSchemaHash, "rollback")) {
    return { allowed: false, reason: "schema_incompatible" };
  }
  return { allowed: true, to: input.priorPayload };
}

export type MaintenanceReceiptInput = {
  organizationId: string;
  kind: MaintenanceReceiptRow["kind"];
  outcome: MaintenanceReceiptRow["outcome"];
  name: string;
  sha256?: string | null;
  version?: string | null;
  schemaHash?: string | null;
  signature?: PayloadSignature | null;
  sizeBytes?: number | null;
  detail?: string | null;
  at: number;
};

export async function recordMaintenanceReceipt(
  tx: Tx,
  input: MaintenanceReceiptInput,
): Promise<void> {
  await tx.insert(maintenanceReceipts).values({
    organizationId: input.organizationId,
    kind: input.kind,
    outcome: input.outcome,
    name: input.name,
    sha256: input.sha256 ?? null,
    version: input.version ?? null,
    schemaHash: input.schemaHash ?? null,
    signature: input.signature ?? null,
    sizeBytes: input.sizeBytes ?? null,
    detail: input.detail ?? null,
    at: input.at,
  });
}

/**
 * The snapshot a restore would use — the newest backup receipt that verified and
 * has not since been pruned. A `failed` receipt for a later attempt does not
 * shadow it: a broken new backup does not un-verify an intact old one.
 *
 * Bounded work, not a scan: the newest matching row is taken under
 * `maintenance_receipts_org_kind_at_idx` and the pruning is asked as an EXISTS
 * beside it, rather than by reading every receipt an install has ever written
 * and filtering in memory. This table only grows, and a long-lived install's
 * answer must not get slower with it.
 */
export async function lastVerifiedBackup(
  tx: Tx,
  organizationId: string,
): Promise<MaintenanceReceiptRow | null> {
  const [row] = await tx
    .select()
    .from(maintenanceReceipts)
    .where(
      and(
        eq(maintenanceReceipts.organizationId, organizationId),
        eq(maintenanceReceipts.kind, "backup"),
        eq(maintenanceReceipts.outcome, "verified"),
        sql`not exists (
          select 1 from ${maintenanceReceipts} as pruned
          where pruned.organization_id = ${maintenanceReceipts.organizationId}
            and pruned.kind = 'backup'
            and pruned.outcome = 'pruned'
            and pruned.name = ${maintenanceReceipts.name}
        )`,
      ),
    )
    .orderBy(desc(maintenanceReceipts.at), desc(maintenanceReceipts.id))
    .limit(1);
  return row ?? null;
}

export async function listMaintenanceReceipts(
  tx: Tx,
  organizationId: string,
  limit = 20,
): Promise<MaintenanceReceiptRow[]> {
  return tx
    .select()
    .from(maintenanceReceipts)
    .where(eq(maintenanceReceipts.organizationId, organizationId))
    .orderBy(desc(maintenanceReceipts.at), desc(maintenanceReceipts.id))
    .limit(limit);
}
