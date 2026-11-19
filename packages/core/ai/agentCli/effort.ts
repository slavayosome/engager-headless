import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentFailure, agentStateDirectory } from "./state";

/**
 * THE OWNER'S EFFORT, AS A SIDECAR, for the same reason `admission.ts` is one.
 *
 * A selection lives in `state.json` under a strict, versioned schema that older
 * processes sharing this installation parse with their own copy; a new field
 * there makes them reject the whole state, queue and claims included. So the
 * effort is written beside it, keyed by the selection's `configRevision` (the
 * one field that already changes on every save) and bound to the model it was
 * validated for. A chat-model move or any re-save mints a new revision, so a
 * level chosen for one model can never ride along to another.
 *
 * Read failures are silent by design: no record means "agent default", which
 * is exactly how every selection behaved before this file existed.
 */
export const EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,23}$/;

const effortSchema = z
  .object({
    version: z.literal(1),
    configRevision: z.string().min(1),
    modelRef: z.string().min(1),
    effort: z.string().regex(EFFORT_LEVEL),
  })
  .strict();

function effortDirectory(): string {
  return join(agentStateDirectory(), "efforts");
}

function effortFile(configRevision: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(configRevision))
    throw agentFailure("agent_effort_invalid");
  return join(effortDirectory(), `${configRevision}.json`);
}

/** Written before the selection is activated; an orphan is invisible. */
export async function recordSelectedEffort(
  configRevision: string,
  modelRef: string,
  effort: string,
): Promise<void> {
  const record = effortSchema.parse({ version: 1, configRevision, modelRef, effort });
  await mkdir(effortDirectory(), { recursive: true, mode: 0o700 });
  const temporary = join(effortDirectory(), `${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, effortFile(configRevision));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** The effort saved for this revision, only when `model` is the model it was
 *  saved for; anything else (no record, malformed, another model) is the
 *  agent's default. */
export function readSelectedEffort(
  configRevision: string,
  model: string,
): string | undefined {
  try {
    const parsed = effortSchema.parse(
      JSON.parse(readFileSync(effortFile(configRevision), "utf8")),
    );
    return parsed.configRevision === configRevision && parsed.modelRef === model
      ? parsed.effort
      : undefined;
  } catch {
    return undefined;
  }
}
