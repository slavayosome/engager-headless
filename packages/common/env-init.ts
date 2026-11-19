import { readFileSync } from "node:fs";

/**
 * Load `.env` before later standalone-script imports evaluate configuration.
 * Existing process variables always win.
 */
function loadEnv(path = ".env"): void {
  const native = (
    process as unknown as { loadEnvFile?: (filename: string) => void }
  ).loadEnvFile;
  if (typeof native === "function") {
    try {
      native.call(process, path);
      return;
    } catch {
      // Missing local files are allowed; retain the fallback for older Node.
    }
  }

  try {
    const contents = readFileSync(path, "utf8");
    for (const line of contents.split("\n")) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (!match || line.trimStart().startsWith("#")) continue;
      const key = match[1]!;
      let value = match[2]!;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Standalone commands may receive their entire environment from the shell.
  }
}

loadEnv();
