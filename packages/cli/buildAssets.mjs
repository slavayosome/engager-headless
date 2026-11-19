import { cpSync } from "node:fs";
import path from "node:path";

/** Next standalone includes loaded .env files. Apply the same release filter
 * to every copied tree so developer credentials cannot enter a CLI or app. */
export function copyRuntimeAssets(source, destination, keep = () => true) {
  cpSync(source, destination, {
    recursive: true,
    filter: (file) => {
      const name = path.basename(file);
      return keep(file) && !/^(?:tests|__tests__|\.venv|__pycache__|\.pytest_cache|\.ruff_cache|\.git|\.ssh|\.DS_Store)$/.test(name)
        && !/^\.env(?:\.|$)/.test(name)
        && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
        && !/\.(?:pem|key|p12)$/.test(name);
    },
  });
}
