import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `use` with a fresh temporary directory, removed when it ends. */
export function withTempDir<T>(prefix: string, use: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const done = () => rmSync(root, { recursive: true, force: true });
  let result: T;
  try {
    result = use(root);
  } catch (error) {
    done();
    throw error;
  }
  if (!(result instanceof Promise)) {
    done();
    return result;
  }
  return result.finally(done) as T;
}
