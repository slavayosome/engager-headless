import { cpSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWrite, readJson } from "./ownedFiles.mjs";
import { localSnapshot } from "./localSnapshot.mjs";
import { pruneSnapshots, snapshotInventory, snapshotPath, snapshotVerifies } from "./maintenance.mjs";
import { withLifecycleLock } from "./coreLifecycle.mjs";
import { migrationFingerprint, migrationInventory } from "./migrationFingerprint.mjs";

// The schema identity, in ONE hash space for every placement: the Mac path,
// the free archive's `payload.json` and the reviewed edge in
// `schemaCompatibility.ts` all read the same number. Re-exported here so the
// Mac callers that already import it from this module keep their spelling.
export { migrationFingerprint } from "./migrationFingerprint.mjs";

/** The evidence a signed schema path is weighed against, read from THIS
 * bundle at the moment of preparation: its migration files rehashed from disk,
 * its journal, and the release key it already trusts for the DMG itself.
 * `schemaPaths` is the feed's untrusted list, passed through unread -- the
 * core decides (`packages/core/supervision/schemaPath.ts`). A feed item with no
 * list still gets weighed: a candidate that only drops snapshots needs none. */
export function macSchemaPath({ directory, schemaPaths, trustedPublicKey }) {
  return {
    schemaPaths: schemaPaths ?? null, trustedPublicKey,
    inventory: migrationInventory(directory),
    journal: readFileSync(path.join(directory, "meta/_journal.json"), "utf8"),
  };
}

const ticketPath = (root) => path.join(root, "mac-update.json");
export const macUpdateTicket = (root) => readJson(ticketPath(root), null);
// A transition is over only in these states: its receipt has been written and
// the next update may be prepared. Every other state -- including a `prepared`
// one whose new binary is already running -- still owes its completion.
const TERMINAL = ["applied", "rolled_back", "cancelled"];

/** Sparkle owns artifact signature verification and replacement. This is its
 * local maintenance boundary: the supervisor has torn down its groups before
 * calling, and remains suspended until relaunch. No provider is called here. */
export async function prepareMacUpdate({ root, env, version, schemaHash, targetVersion, targetSchemaHash, schemaPath, bundle,
  maintenance, snapshot = localSnapshot, preserve = (source, target) => cpSync(source, target, { recursive: true, errorOnExist: true, force: false }) }) {
  return withLifecycleLock(root, async () => {
    const previous = macUpdateTicket(root);
    // An update prepared by this same app that no candidate ever reached -- the
    // download failed, or the app quit before Sparkle installed -- began no
    // migration, and is prepared again rather than left to block the next one.
    const unreached = previous?.state === "prepared" && previous.migrationStarted === false
      && previous.version === version && previous.schemaHash === schemaHash;
    if (previous && !TERMINAL.includes(previous.state) && !unreached) throw new Error("update_recovery_required");
    const ticket = { state: "preparing", version, schemaHash, targetVersion, targetSchemaHash, migrationStarted: false };
    atomicWrite(ticketPath(root), JSON.stringify(ticket));
    const name = `before-mac-update-${Date.now()}.json`;
    try {
      let backup;
      try { backup = snapshot({ root, output: snapshotPath(root, name), env, version }); }
      catch (error) {
        await maintenance("backup-receipt", { outcome: "failed", name, version, detail: "snapshot_failed" });
        throw error;
      }
      await maintenance("backup-receipt", { outcome: "verified", name, sha256: backup.sha256, version });
      ticket.backup = { name, sha256: backup.sha256 };
      atomicWrite(ticketPath(root), JSON.stringify(ticket));
      const admission = await maintenance("update-admission", {
        manifest: {}, trustedPublicKey: null, currentSchemaHash: schemaHash,
        candidateSchemaHash: targetSchemaHash, schemaPath, isFirstInstall: false,
        backupOnDisk: snapshotVerifies(root, name, backup.sha256),
      });
      if (!admission.allowed) throw new Error(admission.refusal);
      const prior = path.join(root, "mac-prior", `${Date.now()}`, "Engager.app");
      preserve(bundle, prior);
      ticket.prior = prior;
      if (!snapshotVerifies(root, name, backup.sha256)) throw new Error("update_requires_verified_backup");
      const prepared = { ...ticket, state: "prepared", backup: { name, sha256: backup.sha256 }, prior };
      atomicWrite(ticketPath(root), JSON.stringify(prepared));
      return prepared;
    } catch (error) {
      atomicWrite(ticketPath(root), JSON.stringify({ ...ticket, state: "recovery_required" }));
      await maintenance("update-receipt", { outcome: "paused_recovery", name: targetVersion, detail: "update_recovery_required" });
      throw error;
    }
  });
}

/** Engager Dev's stand-in for the OLD app preparing its own update: Dev has no
 * Sparkle, no release key and an installed binary whose edge list cannot know
 * a newer migration, so `scripts/dev/app.mjs install` asks the INCOMING bundle
 * before it swaps. The transition is the one production prepares -- verified
 * backup, prior bundle, the exact candidate pinned -- from the schema the
 * closed ticket and the applied history both say the database is at, and only
 * across an edge the incoming core has reviewed. Every refusal comes before
 * the first write; the next ordinary launch finishes it through
 * `finishMacUpdate` unchanged. */
export async function prepareDevelopmentMacUpdate({ development, root, version, schemaHash, bundle, ready, verifyHistory,
  maintenance, ...prepare }) {
  if (!development) throw new Error("operation_unavailable_outside_development_app");
  const installed = path.join(bundle, "Contents/Resources/cli/dist/migrations");
  const previous = macUpdateTicket(root);
  // No ticket: no launch ever migrated this state, and its first one prepares.
  if (!previous) return { state: "none" };
  const unreached = previous.state === "prepared" && previous.migrationStarted === false;
  if (!TERMINAL.includes(previous.state) && !unreached) throw new Error("development_update_requires_closed_ticket");
  const from = unreached ? { version: previous.version, schemaHash: previous.schemaHash }
    : { version: previous.targetVersion, schemaHash: previous.targetSchemaHash };
  if (from.schemaHash !== migrationFingerprint(installed)) throw new Error("development_update_installed_schema_mismatch");
  if (from.schemaHash === schemaHash) throw new Error("development_update_same_schema");
  await ready();
  if (!maintenance("update-edge", { from: from.schemaHash, to: schemaHash }).allowed) {
    throw new Error(`development_update_no_reviewed_edge: this build reviews no update from ${from.schemaHash.slice(0, 8)} to ${schemaHash.slice(0, 8)}`);
  }
  await verifyHistory(installed);
  return prepareMacUpdate({ ...prepare, root, bundle, maintenance, version: from.version, schemaHash: from.schemaHash, targetVersion: version, targetSchemaHash: schemaHash });
}

/** Sparkle must already have cancelled its installer. This never restores
 * data and cannot clear a ticket once any migration may have begun. */
export async function cancelMacUpdate({ root, version, schemaHash, maintenance }) {
  return withLifecycleLock(root, () => {
    const ticket = macUpdateTicket(root);
    if (!ticket) return { state: "cancelled" };
    if (ticket.state === "cancelled" && ticket.version === version && ticket.schemaHash === schemaHash) return ticket;
    if (ticket.migrationStarted !== false || ticket.version !== version || ticket.schemaHash !== schemaHash) {
      throw new Error("update_recovery_required: cancellation cannot clear a possible migration");
    }
    maintenance("update-receipt", { kind: "rollback", outcome: "applied", name: version, detail: "cancelled_before_migration" });
    const cancelled = { ...ticket, state: "cancelled" };
    atomicWrite(ticketPath(root), JSON.stringify(cancelled));
    return cancelled;
  });
}

/** Applies the core's retention plan to this install's snapshots, so the Mac
 * path bounds what it writes instead of growing a dump per launch forever.
 * `keepNames` are never pruned whatever the plan says: they are the snapshots
 * the CURRENT ticket would recover from. Retention is housekeeping — a core
 * that cannot answer must not wedge a launch that already has its backup. */
function pruneMacSnapshots({ root, maintenance, keepNames }) {
  const keep = new Set(keepNames.filter(Boolean));
  try {
    const candidates = snapshotInventory(root)
      .map((entry) => ({ name: entry.name, at: entry.at, verified: snapshotVerifies(root, entry.name, entry.sha256) }));
    const plan = maintenance("backup-plan", { candidates });
    for (const pruned of pruneSnapshots(root, plan.prune.filter((name) => !keep.has(name)))) {
      maintenance("backup-receipt", { outcome: "pruned", name: pruned });
    }
  } catch { /* keeping every snapshot is safe; failing the launch is not */ }
}

/** Runs before every Mac preflight migration. An interrupted migration is
 * never automatically retried, and an incompatible old app never opens the
 * database. Recovery preserves the backup and prior bundle; no down-migration. */
export function finishMacUpdate({ root, version, schemaHash, migrate, maintenance, recover = false, env, snapshot = localSnapshot,
  pendingMigrations }) {
  let ticket = macUpdateTicket(root);
  // Preparation is what takes the verified backup and pins the exact candidate,
  // so a call with no ticket holds neither and may not reach the migrator.
  // Ordinary preflight prepares before it finishes; `mac-update recover` does
  // not, and a preparation that failed before writing its ticket leaves an owner
  // with a recovery instruction and no transition to recover. Neither is
  // answered by inventing one over the database this was meant to protect.
  if (!ticket) {
    return { ok: false, output: recover
      ? "update_requires_prepared_update: no prepared update was found, so this install has neither the verified backup nor the exact candidate recovery requires. No migration was started and nothing was changed. Reopen Engager with this bundle: an ordinary launch prepares its own verified backup before it migrates. Retained data, snapshots and the preserved prior app must not be deleted."
      : "update_requires_prepared_update: prepare this update before finishing it" };
  }
  if (!["preparing", "prepared", "migrating", ...TERMINAL, "recovery_required"].includes(ticket.state)) {
    return { ok: false, output: "update_ticket_invalid" };
  }
  const failed = ["preparing", "migrating", "recovery_required"].includes(ticket.state);
  if (failed && !recover) {
    return { ok: false, output: "update_recovery_required: quit Engager, then run mac-update recover with this bundle" };
  }
  // Once a migration might have run, recovery is forward-only in the exact
  // candidate. A successful terminal receipt is required before binary rollback.
  if (failed && ticket.migrationStarted !== false && (version !== ticket.targetVersion || schemaHash !== ticket.targetSchemaHash)) {
    return { ok: false, output: "update_recovery_requires_exact_candidate" };
  }
  // With nothing to migrate, two version mismatches are ordinary launches, not
  // rollbacks. The OLD app may open again while its prepared update is still
  // downloading -- Sparkle downloads and stages after the owner's Install
  // reply, and the Set up window runs its own preflight meanwhile -- and the
  // ticket stays for the candidate that finishes it. A binary at a closed
  // transition's own schema -- an update Sparkle installed after that
  // transition had closed -- opens as any up-to-date launch does.
  const unmigrated = pendingMigrations === false && !recover;
  const waiting = unmigrated && ticket.state === "prepared" && ticket.migrationStarted === false
    && version === ticket.version && schemaHash === ticket.schemaHash;
  const settled = unmigrated && TERMINAL.includes(ticket.state) && schemaHash === ticket.targetSchemaHash;
  let kind = "update";
  if (!waiting && !settled && (version !== ticket.targetVersion || schemaHash !== ticket.targetSchemaHash)) {
    const rollback = ticket.migrationStarted === false && (ticket.state === "cancelled" || recover)
      ? { allowed: true } : maintenance("rollback-admission", {
      priorPayload: ticket.prior, currentSchemaHash: ticket.targetSchemaHash, priorSchemaHash: schemaHash,
    });
    if (!rollback.allowed || version !== ticket.version || schemaHash !== ticket.schemaHash) {
      maintenance("update-receipt", { kind: "rollback", outcome: "paused_recovery", name: version, detail: "rollback_schema_incompatible" });
      return { ok: false, output: "rollback_schema_incompatible: use the exact prepared candidate" };
    }
    kind = "rollback";
  }
  // Never trust an applied ticket as database schema evidence: a database may
  // have been restored independently, so the idempotent migrator re-runs on
  // every launch. But an ordinary launch of an up-to-date install changes no
  // schema, and dumping, encrypting and re-verifying the WHOLE database on
  // each of those launches is unbounded cost protecting nothing. A snapshot is
  // required whenever a schema change is actually possible: something pending
  // (a restored older database lands here), an unknown pending state, an
  // owner recovery, a failed ticket, or a rollback transition.
  // It is also only an ORDINARY launch once the ticket is terminal, or while the
  // old app waits on its prepared update. A prepared ticket whose candidate is
  // now running is an update in progress, whatever the migrator would find: it
  // must take the completion path below so its receipt is recorded and the
  // next update can be prepared.
  const verifying = unmigrated && kind === "update" && (TERMINAL.includes(ticket.state) || waiting);
  if (verifying) {
    let verification;
    try { verification = migrate(); } catch { verification = { ok: false, output: "migration_failed" }; }
    if (verification.ok) return verification;
    // The migrator disagreed with the history check: that IS uncertainty, so
    // it pauses for the same owner-driven recovery as any failed migration.
    maintenance("update-receipt", { kind, outcome: "paused_recovery", name: version, detail: "migration_failed_forward_recovery_required" });
    atomicWrite(ticketPath(root), JSON.stringify({ ...ticket, state: "recovery_required" }));
    return { ok: false, output: `${verification.output}\nupdate_recovery_required: quit Engager, then run mac-update recover with this bundle` };
  }
  if (env) {
    const retained = ticket.backup?.name;
    const name = `before-mac-preflight-${Date.now()}.json`;
    let backup;
    try { backup = snapshot({ root, output: snapshotPath(root, name), env, version }); }
    catch (error) {
      // Actionable, and NOT "run the same recovery again": recovery takes this
      // very snapshot, so repeating it cannot succeed until the cause is gone.
      const detail = error instanceof Error ? error.message : "snapshot_failed";
      try { maintenance("backup-receipt", { outcome: "failed", name, version, detail }); } catch { /* receipt is best effort here */ }
      return { ok: false, output: `update_requires_verified_backup: ${detail}\nNo migration was started and nothing was changed. Free disk space, keep the local database reachable, then relaunch Engager; running mac-update recover again fails the same way until this is fixed. Retained data, snapshots and the preserved prior app must not be deleted.` };
    }
    maintenance("backup-receipt", { outcome: "verified", name, sha256: backup.sha256, version });
    ticket = { ...ticket, backup: { name, sha256: backup.sha256 } };
    pruneMacSnapshots({ root, maintenance, keepNames: [name, retained] });
  }
  if (!ticket.backup || !snapshotVerifies(root, ticket.backup.name, ticket.backup.sha256)) {
    return { ok: false, output: "update_requires_verified_backup" };
  }
  ticket = { ...ticket, migrationStarted: true };
  atomicWrite(ticketPath(root), JSON.stringify({ ...ticket, state: "migrating" }));
  let result;
  try { result = migrate(); } catch { result = { ok: false, output: "migration_failed" }; }
  maintenance("update-receipt", { kind, outcome: result.ok ? "applied" : "paused_recovery", name: version, detail: result.ok ? null : "migration_failed_forward_recovery_required" });
  // A completed rollback/cancellation closes the abandoned transition. Future
  // launches recover this admitted source, not the refused feed's target. Keep
  // that original target as provenance, and require new preparation to retry it.
  if (result.ok && kind === "rollback") ticket = { ...ticket,
    previousTargetVersion: ticket.previousTargetVersion ?? ticket.targetVersion,
    previousTargetSchemaHash: ticket.previousTargetSchemaHash ?? ticket.targetSchemaHash,
    targetVersion: version, targetSchemaHash: schemaHash };
  atomicWrite(ticketPath(root), JSON.stringify({ ...ticket, state: result.ok ? (kind === "rollback" ? "rolled_back" : "applied") : "recovery_required" }));
  return result;
}
