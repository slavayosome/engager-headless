import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWrite, noSymlinks, readJson } from "./ownedFiles.mjs";

// `lstart` is rendered in the caller's locale — `Fri 11 Sep 12:05:03 2026`
// under en_SG, `Fri Sep 11 12:05:03 2026` under C. A birth time recorded by a
// core launched from one locale could never be matched from a shell running
// another, so `stop` and `uninstall` refused with `stop_ownership_unresolved`.
// Every inspection reads the C rendering, which keeps `born` one stable
// 24-character string whoever asks. Read per call, not once at import, so a
// locale the process picks up later cannot reach `ps` either.
const psEnv = () => ({ ...process.env, LC_ALL: "C" });

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=,pgid=,lstart=,command="], { encoding: "utf8", timeout: 2000, env: psEnv() });
  if (result.error) throw new Error("process_inspection_unavailable");
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
  return match ? { pid: Number(match[1]), pgid: Number(match[2]), born: match[3], command: match[4] } : null;
}
function groupAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  const result = spawnSync("/bin/ps", ["-axo", "pgid="], { encoding: "utf8", timeout: 2000, env: psEnv() });
  if (result.status !== 0) throw new Error("process_inspection_unavailable");
  return result.stdout.split("\n").some((line) => Number(line.trim()) === pgid);
}
export function ownedProcess(receipt) {
  const current = processIdentity(receipt.pid);
  return Boolean(current && current.pgid === receipt.pid && current.born === receipt.born && current.command.includes(`--engager-owner=${receipt.token}`));
}
export function lifecycleStatus(root) {
  const receipt = readJson(path.join(root, "process.json"), null);
  if (!receipt) return { state: "stopped" };
  if (receipt.version === 1 && receipt.state === "launching") return { state: "ownership_uncertain", receipt };
  if (receipt.version === 1 && receipt.state === "launch_failed") return { state: "stopped", receipt };
  if (receipt.version !== 1 || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 1 || !/^[0-9a-f-]{36}$/.test(receipt.token)) throw new Error("process_receipt_invalid");
  if (ownedProcess(receipt)) return { state: receipt.state === "running" ? "running" : "recovery_required", receipt };
  if (groupAlive(receipt.pid) || processIdentity(receipt.pid)) return { state: "ownership_uncertain", receipt };
  return { state: "stopped", receipt };
}
export async function withLifecycleLock(root, action) {
  noSymlinks(root); mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, "lifecycle.lock");
  try { mkdirSync(lock); }
  catch { throw new Error("lifecycle_busy:use_recover_after_interrupted_operation"); }
  atomicWrite(path.join(lock, "owner.json"), JSON.stringify(processIdentity(process.pid)));
  try { return await action(); } finally { rmSync(lock, { recursive: true }); }
}
export function recoverLifecycleLock(root) {
  const lock = path.join(root, "lifecycle.lock"); noSymlinks(lock);
  if (!existsSync(lock)) return;
  const owner = readJson(path.join(lock, "owner.json"), null);
  if (!owner || processIdentity(owner.pid)) throw new Error("lock_ownership_unresolved");
  rmSync(lock, { recursive: true });
}
export async function stopCore(root, { graceMs = 5000, killMs = 5000 } = {}) {
  const status = lifecycleStatus(root);
  if (status.state === "stopped") return status;
  if (status.state === "ownership_uncertain") throw new Error("stop_ownership_unresolved");
  const receipt = status.receipt;
  if (!ownedProcess(receipt)) throw new Error("stop_ownership_changed");
  atomicWrite(path.join(root, "process.json"), JSON.stringify({ ...receipt, state: "stopping" }));
  process.kill(-receipt.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(receipt.pid) && Date.now() < deadline) await delay(50);
  if (groupAlive(receipt.pid)) {
    // A surviving group without its identified leader is unresolved. Never
    // infer that a PID reused by another process still belongs to this install.
    if (!ownedProcess(receipt)) throw new Error("stop_group_ownership_unresolved");
    process.kill(-receipt.pid, "SIGKILL");
    const killDeadline = Date.now() + killMs;
    while (groupAlive(receipt.pid) && Date.now() < killDeadline) await delay(50);
  }
  if (groupAlive(receipt.pid)) throw new Error("stop_failed_processes_remain");
  const stopped = { ...receipt, state: "stopped", stoppedAt: new Date().toISOString(), teardown: "group_absent", delivery: "durable_receipts_preserved" };
  atomicWrite(path.join(root, "process.json"), JSON.stringify(stopped));
  return { state: "stopped", receipt: stopped };
}
export async function startCore({ root, command, args, env, ready = "[agent] ready", timeoutMs = 20000 }) {
  const status = lifecycleStatus(root);
  if (status.state !== "stopped") throw new Error("start_existing_process_requires_stop");
  const token = randomUUID();
  const log = path.join(root, "runtime.log"); noSymlinks(log);
  const fd = openSync(log, "w", 0o600);
  atomicWrite(path.join(root, "process.json"), JSON.stringify({ version: 1, token, state: "launching", startedAt: new Date().toISOString() }));
  const child = spawn(command, [...args, `--engager-owner=${token}`], { cwd: root, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => {
    atomicWrite(path.join(root, "process.json"), JSON.stringify({ version: 1, token, state: "launch_failed" }));
    reject(new Error("runtime_executable_unavailable"));
  }); });
  child.unref();
  const identity = processIdentity(child.pid);
  const receipt = { version: 1, token, pid: child.pid, born: identity?.born, state: "starting", startedAt: new Date().toISOString() };
  atomicWrite(path.join(root, "process.json"), JSON.stringify(receipt));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ownedProcess(receipt)) break;
    if (readFileSync(log, "utf8").includes(ready)) {
      atomicWrite(path.join(root, "process.json"), JSON.stringify({ ...receipt, state: "running" }));
      return lifecycleStatus(root);
    }
    await delay(100);
  }
  await stopCore(root);
  throw new Error("runtime_start_failed:see_local_runtime_log");
}
