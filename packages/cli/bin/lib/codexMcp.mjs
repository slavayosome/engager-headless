import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWrite, noSymlinks } from "./ownedFiles.mjs";
import { upsertCodexMcpBlock } from "./shim.mjs";

/** ChatGPT desktop and Codex CLI share this host configuration. Prepare it
 * even before either client has run, so installing the client later needs
 * no second Engager setup. */
export function writeCodexMcp({ codexHome, invocation }) {
  const configPath = path.join(codexHome, "config.toml");
  noSymlinks(configPath);
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const hadEntry = /^\[mcp_servers\.engager-local\]/m.test(current);
  const next = upsertCodexMcpBlock(current, invocation);
  if (next === current) return { configPath, state: "current" };
  atomicWrite(configPath, next);
  return { configPath, state: hadEntry ? "repaired" : "registered" };
}
