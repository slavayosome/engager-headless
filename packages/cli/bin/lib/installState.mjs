import path from "node:path";
import { readJson } from "./ownedFiles.mjs";
const PAYLOAD_FORMAT = "engager-core-1";
export function installState(root) {
  const state = readJson(path.join(root, "installation.json"), null);
  if (state && (state.format !== PAYLOAD_FORMAT || !/^[a-f0-9-]{36}$/.test(state.id))) throw new Error("installation_manifest_invalid");
  return state;
}
