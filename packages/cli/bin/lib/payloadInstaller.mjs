import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { atomicWrite, hash, inventory, noSymlinks, readJson } from "./ownedFiles.mjs";
import { lifecycleStatus } from "./coreLifecycle.mjs";
import { installState } from "./installState.mjs";
export { installState } from "./installState.mjs";

export const PAYLOAD_FORMAT = "engager-core-1";
export function verifyPayload(source, expectedHash, version) {
  noSymlinks(source);
  const bytes = readFileSync(path.join(source, "payload.json"));
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? "") || hash(bytes) !== expectedHash) throw new Error("artifact_hash_mismatch");
  const manifest = JSON.parse(bytes);
  if (manifest.format !== PAYLOAD_FORMAT || manifest.version !== version || !/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("artifact_version_unsupported");
  if (manifest.platform !== `${process.platform}-${process.arch}`) throw new Error("artifact_platform_unsupported");
  const actual = inventory(source).filter((f) => f.path !== "payload.json");
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("artifact_inventory_mismatch");
  for (const required of ["cli/bin/engager.mjs", "cli/dist/agent.mjs", "cli/dist/mcp.mjs", "cli/dist/core-command.mjs", "runtime-resources/node/bin/node", "runtime-resources/postgresql/bin/pg_ctl", "runtime-resources/uv/uv", "LICENSE"]) {
    if (!actual.some((f) => f.path === required)) throw new Error("artifact_incomplete");
  }
  if (JSON.parse(readFileSync(path.join(source, "cli/package.json"), "utf8")).version !== version) throw new Error("artifact_version_mismatch");
  return manifest;
}
const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
export function freeShim(root) {
  return `#!/bin/sh\n# Engager independent core; owned installation launcher.\nexport ENGAGER_HOME=${quote(root)}\nexec ${quote(path.join(root, "current/runtime-resources/node/bin/node"))} ${quote(path.join(root, "current/cli/bin/engager.mjs"))} "$@"\n`;
}
/** Copy a payload into the installation and prove the COPY, returning the
 *  directory this install would run from.
 *
 *  Idempotent: a destination already present is re-verified rather than replaced,
 *  because its name carries the manifest hash and a directory of that name can
 *  only hold those bytes. So a caller may stage early — `update` does, to put
 *  the candidate's own core somewhere it cannot change underneath the decision
 *  it is about to make — and `installPayload` will find the same verified
 *  directory a moment later instead of copying it twice.
 *
 *  Staging is not a transition: nothing points at the result and
 *  `installation.json` is untouched. It is also not free — a released payload
 *  is several hundred megabytes — so a caller that does not go on to install it
 *  owes `discardUnreferencedPayload`.
 *
 *  A copy that fails its own verification never becomes a payload directory at
 *  all: it is removed under the name it was copied to, so a tampered or
 *  truncated archive costs disk only while it is being read. */
export function stagePayload({ root, source, expectedHash, version }) {
  const current = `payloads/${version}-${expectedHash}`;
  const target = path.join(root, current);
  if (existsSync(target)) {
    try {
      verifyPayload(target, expectedHash, version);
      return { current, target };
    } catch (failure) {
      // A directory of these bytes that is no longer these bytes. Nothing
      // points at it, so it is a previous attempt's remains and this one
      // re-copies over them rather than refusing this version and hash for
      // good. If the install RUNS from it, that is damage the owner has to
      // hear about, not something to replace underneath a live payload.
      if (!discardUnreferencedPayload(root, current)) throw failure;
    }
  }
  const stage = path.join(root, `stage-${randomUUID()}`);
  try {
    cpSync(source, stage, { recursive: true, errorOnExist: true });
    verifyPayload(stage, expectedHash, version);
  } catch (failure) {
    rmSync(stage, { recursive: true, force: true });
    throw failure;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(stage, target);
  return { current, target };
}
/** Remove a payload THIS call staged and then could not install.
 *
 *  `current` and `previous` are the install and the way back from it, and
 *  neither is ever touched however the update went — that is what `uninstall`
 *  reports as `payloadsRetained`. What this removes is the copy an update made
 *  to read a candidate and then refused: unreferenced by construction,
 *  unreachable by `recover` and `rollback` alike, and several hundred megabytes
 *  that only a person deleting directories by hand would ever get back.
 *
 *  Only the paths that end WITHOUT moving the pointer call it, so payload
 *  history is not swept: roll back and then update, and the payload that was
 *  `previous` is left behind by a transition that succeeded. It is kept on
 *  purpose. An owner who has been moving between releases has directories they
 *  may yet want, and nothing here is a garbage collector for them.
 *
 *  An installation whose own manifest cannot be read keeps everything. Deciding
 *  what is unreferenced requires knowing what is referenced. */
export function discardUnreferencedPayload(root, current) {
  let state;
  try { state = installState(root); } catch { return false; }
  if (!current || current === state?.current || current === state?.previous) return false;
  // A switch interrupted after the pointer moved has already pointed at this
  // payload while `installation.json` still names the old one, and `recover`
  // finishes from exactly those two facts. Neither may be deleted underneath
  // it, so "unreferenced" means nothing names it — not merely that the last
  // written manifest does not.
  if (readJson(path.join(root, "pending-install.json"), null)?.current === current) return false;
  // The pointer is judged by the directory it RESOLVES to rather than by the
  // text of the link, so one rewritten by hand as an absolute path, or spelled
  // through a symlinked parent, still names this payload and still protects it.
  // A pointer that is THERE but leads nowhere keeps everything: `lstat` rather
  // than `exists` so a dangling link is seen at all, and an installation whose
  // pointer this cannot follow is one whose references it cannot enumerate.
  // Reclaiming disk is a convenience; a payload that cannot be SHOWN to be
  // unreferenced is not one to delete.
  try {
    const pointer = path.join(root, "current");
    if (lstatSync(pointer, { throwIfNoEntry: false }) && realpathSync(pointer) === realpathSync(path.join(root, current))) return false;
  } catch { return false; }
  rmSync(path.join(root, current), { recursive: true, force: true });
  return true;
}
/** Stage a payload and move the pointer to it.
 *
 *  `admittedSchemaHash` is the candidate fingerprint the CORE admitted, and it
 *  is the only schema this may install over an existing one. Omitted, the
 *  installed payload's own fingerprint stands in, so a caller that decided
 *  nothing can still only reinstall the schema already here.
 *
 *  This is the same guard `rollbackPayload` applies, for the same reason: the
 *  admission was made over a manifest read a moment ago, and if the bytes on
 *  disk disagree with it now, nothing has been decided about THESE bytes. What
 *  it is NOT is a second opinion — until 2026-09-15 this line compared the two
 *  installations' hashes directly, which refused every schema-changing update
 *  whatever the core had just allowed, and made `compatibleSchema`'s reviewed
 *  edge unreachable on the free path. */
export async function installPayload({ root, source, expectedHash, version, admittedSchemaHash = null, beforeSwitch = async () => {}, healthCheck = async () => {} }) {
  const manifest = verifyPayload(source, expectedHash, version);
  noSymlinks(root); mkdirSync(root, { recursive: true, mode: 0o700 });
  const previous = installState(root);
  if (lifecycleStatus(root).state !== "stopped") throw new Error("update_requires_stopped_core");
  if (previous && manifest.schemaHash !== (admittedSchemaHash ?? previous.schemaHash)) throw new Error("update_schema_compatibility_unverified");
  const shim = path.join(root, "bin/engager");
  if (existsSync(shim) && (!previous || hash(readFileSync(shim)) !== previous.shimHash)) throw new Error("launcher_user_edit_preserved");
  const pointer = path.join(root, "current");
  if (existsSync(pointer) && (!previous || readlinkSync(pointer) !== previous.current)) throw new Error("payload_pointer_ownership_unresolved");
  const { current, target } = stagePayload({ root, source, expectedHash, version });
  // Staged code must load and the existing data snapshot must be verified
  // before the pointer can change. Failure leaves the old payload in place —
  // and takes the copy with it, since nothing will ever point at a candidate
  // that could not pass these.
  try {
    await healthCheck(target);
    await beforeSwitch();
  } catch (failure) {
    discardUnreferencedPayload(root, current);
    throw failure;
  }
  const next = { format: PAYLOAD_FORMAT, id: previous?.id ?? randomUUID(), version, schemaHash: manifest.schemaHash, coreHash: manifest.coreHash, artifactHash: expectedHash, current, previous: previous?.current ?? null, shimHash: hash(freeShim(root)), state: "paused" };
  atomicWrite(path.join(root, "pending-install.json"), JSON.stringify(next));
  const temporary = path.join(root, `pointer-${randomUUID()}`);
  symlinkSync(current, temporary);
  renameSync(temporary, pointer);
  atomicWrite(path.join(root, "installation.json"), JSON.stringify(next, null, 2));
  atomicWrite(shim, freeShim(root), 0o755);
  rmSync(path.join(root, "pending-install.json"));
  return next;
}
export function recoverPayload(root) {
  const pending = readJson(path.join(root, "pending-install.json"), null);
  if (!pending) return installState(root);
  if (lifecycleStatus(root).state !== "stopped") throw new Error("recovery_requires_stopped_core");
  if (!/^payloads\/\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(pending.current)) throw new Error("installation_manifest_invalid");
  verifyPayload(path.join(root, pending.current), pending.artifactHash, pending.version);
  const pointer = path.join(root, "current");
  if (!existsSync(pointer) || readlinkSync(pointer) !== pending.current) throw new Error("installation_switch_not_completed:repeat_install");
  const shim = path.join(root, "bin/engager");
  const old = installState(root);
  if (existsSync(shim) && ![old?.shimHash, pending.shimHash].includes(hash(readFileSync(shim)))) throw new Error("launcher_user_edit_preserved");
  atomicWrite(path.join(root, "installation.json"), JSON.stringify(pending, null, 2));
  atomicWrite(shim, freeShim(root), 0o755);
  rmSync(path.join(root, "pending-install.json"));
  return pending;
}
/** Return the pointer to the payload this install ran before the current one.
 *
 *  Whether the rollback is SAFE is decided by the core
 *  (`rollbackAdmission`), which weighs the schema: an additive migration the
 *  prior binary cannot interpret makes a rollback a downgrade, and the honest
 *  outcome there is paused recovery with the data intact — never a
 *  down-migration and never an older binary started against a newer authority
 *  shape. This function performs the move the core already allowed and
 *  re-verifies the prior payload's own bytes before touching the pointer.
 *
 *  `previous` becomes the payload we came from, so a rollback is itself
 *  reversible by rolling forward. Data, snapshots and both payload directories
 *  are untouched. */
export function rollbackPayload(root, { version, schemaHash }) {
  const state = installState(root);
  if (!state?.previous) throw new Error("rollback_no_prior_payload");
  if (lifecycleStatus(root).state !== "stopped") throw new Error("rollback_requires_stopped_core");
  const target = path.join(root, state.previous);
  const manifest = JSON.parse(readFileSync(path.join(target, "payload.json"), "utf8"));
  verifyPayload(target, hash(readFileSync(path.join(target, "payload.json"))), manifest.version);
  if (manifest.version !== version || manifest.schemaHash !== schemaHash) {
    // The core decided against the manifest the caller read; if the bytes on
    // disk disagree with it now, nothing has been decided about THESE bytes.
    throw new Error("rollback_prior_payload_changed");
  }
  const pointer = path.join(root, "current");
  const next = { ...state, version: manifest.version, schemaHash: manifest.schemaHash, coreHash: manifest.coreHash, artifactHash: hash(readFileSync(path.join(target, "payload.json"))), current: state.previous, previous: state.current, state: "paused" };
  atomicWrite(path.join(root, "pending-install.json"), JSON.stringify(next));
  const temporary = path.join(root, `pointer-${randomUUID()}`);
  symlinkSync(next.current, temporary);
  renameSync(temporary, pointer);
  atomicWrite(path.join(root, "installation.json"), JSON.stringify(next, null, 2));
  atomicWrite(path.join(root, "bin/engager"), freeShim(root), 0o755);
  rmSync(path.join(root, "pending-install.json"));
  return next;
}

export function removeLauncher(root) {
  const state = installState(root);
  if (!state) throw new Error("installation_ownership_unknown");
  if (lifecycleStatus(root).state !== "stopped") throw new Error("uninstall_requires_stopped_core");
  const shim = path.join(root, "bin/engager"); noSymlinks(shim);
  if (existsSync(shim)) {
    if (hash(readFileSync(shim)) !== state.shimHash) throw new Error("launcher_user_edit_preserved");
    rmSync(shim);
  }
  atomicWrite(path.join(root, "installation.json"), JSON.stringify({ ...state, state: "uninstalled", dataPreserved: true }));
  return { state: "uninstalled", dataPreserved: true, payloadsRetained: true };
}
