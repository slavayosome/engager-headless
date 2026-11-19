import { homedir } from "node:os";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { agentFailure } from "./state";

/** Dev uses Claude's file fallback without invoking the macOS Keychain. */
export function agentExecutablePath(): string {
  const ordinary = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  if (process.env.ENGAGER_DEV_APP !== "1") return ordinary;
  const opener = process.env.ENGAGER_DEV_BROWSER_OPENER;
  if (!opener || !isAbsolute(opener)) throw agentFailure("agent_dev_keychain_guard_required");
  const directory = join(dirname(opener), "dev-agent-bin");
  const guard = join(directory, "security");
  try {
    if (!lstatSync(guard).isFile()) throw new Error("guard must be a regular file");
    accessSync(guard, constants.X_OK);
    if (realpathSync(guard) !== guard) throw new Error("redirected guard");
  } catch {
    throw agentFailure("agent_dev_keychain_guard_required");
  }
  return `${directory}:${ordinary}`;
}

/** A saved selection cannot redirect a Dev probe or inference to owner auth. */
export function isolatedAuthStore(adapter: "claude" | "codex", requested?: string): string | undefined {
  if (process.env.ENGAGER_DEV_APP !== "1") return requested;
  const expected = join(homedir(), `.${adapter}`);
  if (requested && resolve(requested) !== expected) throw agentFailure("agent_auth_store_path_invalid");
  return expected;
}
