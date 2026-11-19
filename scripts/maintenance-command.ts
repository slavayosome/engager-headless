import { withOrg } from "@engager/database/tenant";
import {
  compatibleSchema,
  lastVerifiedBackup,
  migrationHistoryAdmission,
  listMaintenanceReceipts,
  planBackupRetention,
  recordMaintenanceReceipt,
  rollbackAdmission,
  updateAdmission,
  type BackupCandidate,
} from "@engager/core/supervision/maintenance";
import { recordMaintenanceEvent } from "@engager/core/supervision/record";

/**
 * The free CLI's door to the maintenance policy. It hands over facts it read
 * from disk — the snapshot inventory, the manifest, the hashes — and gets back
 * a decision plus, where the operation warrants one, a durable receipt.
 *
 * Deliberately a thin dispatch and nothing else. Every rule it applies lives in
 * `packages/core/supervision/maintenance.ts`, which is where the tests for
 * "never prune the last verified snapshot" and "an unsigned payload is refused
 * on an install that trusts a publisher" are.
 */
/**
 * The largest input this door reads.
 *
 * An update's input carries the candidate's WHOLE payload manifest — one
 * inventory line per packaged file, and the publisher signature is taken over
 * all of it — so the ceiling has to clear a released archive's: the 0.2.3 free
 * core's `payload.json` is 4,196,040 bytes, and a payload that also ships the
 * dashboard is larger again. Generous, then, but a ceiling all the same: what
 * carries this input is a pipe, and a reader without a bound is a memory fault
 * waiting for the wrong writer.
 */
export const MAINTENANCE_INPUT_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * The operation's input, read from a stream under that ceiling.
 *
 * A stream rather than an argument, because argv is bounded by the kernel
 * (`ARG_MAX`, 1 MiB on macOS) and a real manifest is several times that: passed
 * as an argument it is refused with `E2BIG` before the core starts, which is
 * how a free install's `engager update` failed on 2026-09-11.
 */
export async function readMaintenanceInput(
  stream: AsyncIterable<Buffer | string>,
  limit: number = MAINTENANCE_INPUT_LIMIT_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += bytes.length;
    if (size > limit) throw new Error("maintenance_input_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type MaintenanceOperation =
  | "backup-plan"
  | "backup-receipt"
  | "update-admission"
  | "update-edge"
  | "migration-history-admission"
  | "rollback-admission"
  | "update-receipt"
  | "receipts";

/** The input, validated before any rule reads it. It arrives as a STREAM — the
 *  megabyte-scale manifests an update carries cannot travel in argv — so "not
 *  valid JSON" now includes "cut short", and both refuse with the same code:
 *  a parser's own message would be echoed to the owner and can quote the
 *  bytes it choked on. */
function parse(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("maintenance_arguments_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("maintenance_arguments_invalid");
  }
  return parsed as Record<string, unknown>;
}

function candidates(value: unknown): BackupCandidate[] {
  if (!Array.isArray(value)) throw new Error("maintenance_arguments_invalid");
  return value.map((entry) => {
    const row = entry as Record<string, unknown>;
    if (
      typeof row.name !== "string" ||
      typeof row.at !== "number" ||
      typeof row.verified !== "boolean"
    ) {
      throw new Error("maintenance_arguments_invalid");
    }
    return { name: row.name, at: row.at, verified: row.verified };
  });
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** The Mac path's signed-path evidence: the feed's list as it arrived, and the
 *  key, files and journal the CLI read from this bundle. Absent is no path. */
function schemaPath(value: unknown): Parameters<typeof updateAdmission>[0]["schemaPath"] {
  if (value === undefined) return undefined;
  const row = value as Record<string, unknown> | null;
  if (
    !row || typeof row !== "object" || !Array.isArray(row.inventory) ||
    row.inventory.some((entry) => !entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string")
  ) {
    throw new Error("maintenance_arguments_invalid");
  }
  return {
    schemaPaths: text(row.schemaPaths),
    trustedPublicKey: text(row.trustedPublicKey),
    inventory: row.inventory.map((entry: { path: string; sha256: string }) => ({ path: entry.path, sha256: entry.sha256 })),
    journal: text(row.journal),
  };
}

export async function maintenanceCommand(
  organizationId: string,
  operation: string,
  json: string,
): Promise<unknown> {
  const input = parse(json);
  const now = Date.now();
  switch (operation as MaintenanceOperation) {
    case "migration-history-admission": {
      const rows = (value: unknown): { hash: string; created_at: number }[] => {
        if (!Array.isArray(value) || value.some((row) => !row || typeof row.hash !== "string" || !Number.isSafeInteger(Number(row.created_at)))) {
          throw new Error("maintenance_arguments_invalid");
        }
        return value.map((row) => ({ hash: row.hash, created_at: Number(row.created_at) }));
      };
      return migrationHistoryAdmission({ schemaHash: text(input.schemaHash), packaged: rows(input.packaged), applied: rows(input.applied) });
    }
    case "backup-plan": {
      // Names, not candidates, on the way out: the CLI deletes files, and the
      // decision about WHICH is made here and nowhere else.
      const plan = planBackupRetention(candidates(input.candidates));
      return { ...plan, prune: plan.prune.map((entry) => entry.name) };
    }
    case "backup-receipt":
      return withOrg(organizationId, async (tx) => {
        await recordMaintenanceReceipt(tx, {
          organizationId,
          kind: "backup",
          outcome: input.outcome === "verified"
            ? "verified"
            : input.outcome === "pruned"
              ? "pruned"
              : "failed",
          name: String(input.name ?? ""),
          sha256: text(input.sha256),
          version: text(input.version),
          sizeBytes: typeof input.sizeBytes === "number" ? input.sizeBytes : null,
          detail: text(input.detail),
          at: now,
        });
        return { recorded: true };
      });
    case "update-admission":
      return withOrg(organizationId, async (tx) => {
        const verified = await lastVerifiedBackup(tx, organizationId);
        return updateAdmission({
          manifest: (input.manifest ?? {}) as Record<string, unknown>,
          trustedPublicKey: text(input.trustedPublicKey),
          currentSchemaHash: text(input.currentSchemaHash),
          candidateSchemaHash: text(input.candidateSchemaHash),
          schemaPath: schemaPath(input.schemaPath),
          // The CLI proved the file still hashes to its receipt; the receipt
          // proves it was verified when written. Both are required, which is
          // why neither side answers this alone.
          hasRestorableBackup: verified !== null && input.backupOnDisk === true,
          isFirstInstall: input.isFirstInstall === true,
        });
      });
    // A reviewed edge alone, for Engager Dev's install: it prepares before it
    // has taken the backup `update-admission` also requires.
    case "update-edge":
      return { allowed: compatibleSchema(text(input.from), text(input.to), "update") };
    case "rollback-admission":
      return rollbackAdmission({
        priorPayload: text(input.priorPayload),
        currentSchemaHash: text(input.currentSchemaHash),
        priorSchemaHash: text(input.priorSchemaHash),
      });
    case "update-receipt":
      return withOrg(organizationId, async (tx) => {
        const kind = input.kind === "rollback" ? "rollback" : "update";
        const outcome =
          input.outcome === "applied"
            ? "applied"
            : input.outcome === "refused"
              ? "refused"
              : "paused_recovery";
        await recordMaintenanceReceipt(tx, {
          organizationId,
          kind,
          outcome,
          name: String(input.name ?? ""),
          sha256: text(input.sha256),
          version: text(input.version),
          schemaHash: text(input.schemaHash),
          signature:
            input.signature === "verified" || input.signature === "invalid" ||
              input.signature === "unsigned"
              ? input.signature
              : null,
          detail: text(input.detail),
          at: now,
        });
        // The same timeline the restarts are in, so "it stopped after the
        // update" reads as one sequence rather than two tables.
        await recordMaintenanceEvent(tx, {
          organizationId,
          component: "payload",
          // An update that could not be applied leaves recovery paused, which
          // is a supervision state and not merely a receipt.
          state: outcome === "applied" ? "stopped" : "recovery_required",
          reason:
            kind === "rollback"
              ? "rollback_applied"
              : outcome === "applied"
                ? "update_applied"
                : "update_failed",
          holderId: null,
          diagnosis: text(input.detail),
          now,
        });
        return { recorded: true };
      });
    case "receipts":
      return withOrg(organizationId, (tx) =>
        listMaintenanceReceipts(tx, organizationId, 20),
      );
    default:
      throw new Error("maintenance_operation_unknown");
  }
}
