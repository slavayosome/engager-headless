import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { agentFailure, agentStateDirectory, withAgentLock } from "./state";

/**
 * Paths the owner explicitly chose in Advanced, for the scan to look at.
 *
 * §8's rule is that the REGULAR scan request supplies no search root: the
 * browser names a candidate id and nothing else. The advanced control is the
 * one place a path is typed, and it is not a bypass — the server checks the
 * path's basename against the registered adapters, probes it with the same
 * bounded discovery every other candidate goes through, and only then
 * remembers it here so the candidate stays resolvable on the next scan. Like
 * a saved selection's own pin, it widens WHERE Engager looks without widening
 * WHAT it will run.
 *
 * It is deliberately NOT part of `state.json`: this is search configuration,
 * not a selection or a claim, and it must never be able to make the queue
 * unreadable. The list is bounded; the oldest entries fall off.
 */
const MAX_PATHS = 8;

const storeSchema = z
  .object({
    version: z.literal(1),
    paths: z
      .array(z.object({ adapterId: z.string(), path: z.string() }).strict())
      .max(MAX_PATHS),
  })
  .strict();

type ExplicitPathStore = z.infer<typeof storeSchema>;

function storeFile(): string {
  return join(agentStateDirectory(), "explicit-paths.json");
}

function readStore(): ExplicitPathStore {
  try {
    return storeSchema.parse(JSON.parse(readFileSync(storeFile(), "utf8")));
  } catch {
    return { version: 1, paths: [] };
  }
}

/** The remembered paths per adapter, for the scan's pin set. A malformed or
 *  missing store reads as none, exactly as a missing selection does. */
export function rememberedAgentPaths(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const entry of readStore().paths) {
    if (!isAbsolute(entry.path)) continue;
    const known = (found[entry.adapterId] ??= []);
    if (!known.includes(entry.path)) known.push(entry.path);
  }
  return found;
}

/** Remember one validated path, newest first and bounded. */
export async function rememberAgentPath(
  adapterId: string,
  path: string,
): Promise<void> {
  if (!isAbsolute(path)) throw agentFailure("agent_absolute_path_required");
  await withAgentLock("explicit-paths", async () => {
    const directory = agentStateDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = readStore();
    const paths = [
      { adapterId, path },
      ...store.paths.filter(
        (entry) => !(entry.adapterId === adapterId && entry.path === path),
      ),
    ].slice(0, MAX_PATHS);
    const temporary = join(directory, `${randomUUID()}.paths.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, paths }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, storeFile());
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
}
