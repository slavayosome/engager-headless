import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants } from "node:fs";
import { copyFile, link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentFailure, agentStateDirectory } from "./state";
import type { AgentModelCatalog, ResolvedAgentSelection } from "./types";

/**
 * WHY THIS IS A SIDECAR AND NOT A FIELD ON THE SELECTION.
 *
 * A selection is a WIRE shape: it lives inside `state.json` under a strict
 * schema that older processes sharing the same installation — a second
 * dashboard, an app rollback, a worker started before an upgrade — parse with
 * THEIR copy of the schema. Adding a field there is not an expand:
 * `selectionSchema` is `.strict()`, so a build that predates the field rejects
 * the whole selection, and with it the queue and claims beside it, for an
 * install that did nothing but configure an agent.
 *
 * The admission record has a second property the selection cannot carry
 * anyway: it must be IMMUTABLE and FULLY BOUND. The catalog read that admitted
 * a dynamic model was about one exact executable, version, adapter contract,
 * auth route, provider and profile; a record that re-derived any of those at
 * read time would silently re-admit the model under a contract that changed
 * underneath it. Here every one of them is written down as they were at
 * admission, and the reader refuses when the CURRENT adapter contract or the
 * selection's own binding disagrees.
 *
 * The record is referenced by the selection's existing `configRevision` — the
 * one field that already changes whenever a configuration is written — so no
 * new field and no new wire shape is needed, and an evicted or refreshed UI
 * catalog cannot take a working model away with it.
 */
const admissionSchema = z
  .object({
    version: z.literal(1),
    /** The selection revision this admitted. The file is named for it. */
    configRevision: z.string().min(1),
    purpose: z.enum(["background", "chat"]),
    adapterId: z.string(),
    /** The adapter contract as it stood at admission. Mismatch = refuse. */
    adapterContractVersion: z.string(),
    executableIdentity: z.string(),
    observedVersion: z.string(),
    providerRef: z.string(),
    authRoute: z.string(),
    authStorePath: z.string().optional(),
    /** The catalog read this came from, for correlation with the cache. */
    catalogRevision: z.string(),
    recordedAt: z.number(),
    /** Only the ids this configuration may ask for — its primary model and the
     *  role models prepared with it. */
    options: z.array(
      z.object({ id: z.string(), providerRef: z.string() }).strict(),
    ),
  })
  .strict();

export type AgentAdmission = z.infer<typeof admissionSchema>;

function admissionDirectory(): string {
  return join(agentStateDirectory(), "admissions");
}

function admissionFile(configRevision: string): string {
  // The revision is a UUID the server minted, but a file name is a boundary:
  // anything outside the alphabet this module writes is refused rather than
  // joined onto a path.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(configRevision))
    throw agentFailure("agent_admission_invalid");
  return join(admissionDirectory(), `${configRevision}.json`);
}

/**
 * Write one admission record for a prepared selection, BEFORE the selection is
 * activated. A configuration that fails after this point leaves an orphan
 * record and nothing else: an orphan is invisible to every reader, while a
 * selection without its record would refuse the very model it was saved for.
 *
 * Every binding field is taken from the CATALOG, never from the selection, and
 * a catalog that is not about this exact selection is refused outright. The
 * two are the same fact at every legitimate call site — a selection is only
 * ever prepared or extended from evidence that passed the binding check — so
 * deriving the record from the evidence is what makes "never restamp foreign
 * evidence with current values" true by construction rather than by review.
 *
 * `wx` is the immutability: a revision names exactly one admission, and a
 * second write for the same revision is a bug this refuses rather than
 * overwrites.
 */
export async function recordAdmission(
  selection: ResolvedAgentSelection,
  catalog: AgentModelCatalog,
  modelRefs: readonly string[],
): Promise<void> {
  if (
    catalog.adapterId !== selection.adapterId ||
    catalog.executableIdentity !== selection.executableIdentity ||
    catalog.observedVersion !== selection.observedVersion ||
    catalog.providerRef !== selection.providerRef ||
    catalog.authRoute !== selection.authRoute ||
    (catalog.authStorePath ?? undefined) !==
      (selection.authStorePath ?? undefined)
  )
    throw agentFailure("agent_admission_invalid");
  await mkdir(admissionDirectory(), { recursive: true, mode: 0o700 });
  const wanted = new Set([selection.modelRef, ...modelRefs]);
  const options = catalog.options
    .filter((option) => wanted.has(option.id))
    .map((option) => ({ id: option.id, providerRef: option.providerRef }));
  if (options.length === 0) return;
  const record: AgentAdmission = {
    version: 1,
    configRevision: selection.configRevision,
    purpose: selection.purpose,
    adapterId: catalog.adapterId,
    adapterContractVersion: catalog.adapterContractVersion,
    executableIdentity: catalog.executableIdentity,
    observedVersion: catalog.observedVersion,
    providerRef: catalog.providerRef,
    authRoute: catalog.authRoute,
    ...(catalog.authStorePath ? { authStorePath: catalog.authStorePath } : {}),
    catalogRevision: catalog.revision,
    recordedAt: Date.now(),
    options,
  };
  const directory = admissionDirectory();
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    // `link`, not `rename`: a rename would silently replace an existing record
    // for the same revision, and the record's whole promise is that it is the
    // one written at admission. A link publishes atomically and refuses an
    // existing name; a filesystem without hard links (an exotic state root)
    // falls back to an exclusive copy, which still never overwrites.
    try {
      await link(temporary, admissionFile(selection.configRevision));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
      await copyFile(
        temporary,
        admissionFile(selection.configRevision),
        constants.COPYFILE_EXCL,
      );
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/**
 * The record bound to one selection revision, or undefined when there is none
 * or it cannot be trusted. A missing, malformed or foreign record is not an
 * error: a declared model needs no record at all, and the caller's next
 * question (`resolveModelRoute`) is what decides whether anything admits the
 * id.
 */
export function readAdmission(
  configRevision: string,
): AgentAdmission | undefined {
  try {
    const parsed = admissionSchema.parse(
      JSON.parse(readFileSync(admissionFile(configRevision), "utf8")),
    );
    return parsed.configRevision === configRevision ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The record as a catalog, so a reader can hand the evidence back to the ONE
 * route resolver. The reader compares every binding field before calling this,
 * so what comes back is what the installation reported at admission — never a
 * value re-derived from the binary in front of it.
 */
export function catalogFromAdmission(
  record: AgentAdmission,
): AgentModelCatalog {
  return {
    adapterId: record.adapterId,
    providerRef: record.providerRef,
    executableIdentity: record.executableIdentity,
    observedVersion: record.observedVersion,
    adapterContractVersion: record.adapterContractVersion,
    authRoute: record.authRoute,
    ...(record.authStorePath ? { authStorePath: record.authStorePath } : {}),
    revision: record.catalogRevision,
    fetchedAt: record.recordedAt,
    source: "the selection's own admission record",
    listUnsupported: false,
    partial: false,
    options: record.options.map((option) => ({
      id: option.id,
      label: option.id,
      providerRef: option.providerRef,
      certainty: "listed",
    })),
  };
}

/**
 * Whether a record is about exactly this selection under exactly this adapter
 * contract. Every field is compared: identity and version cannot re-admit a
 * model for a replaced binary, the contract cannot re-admit one for changed
 * argv, and the route/provider/profile cannot re-admit one on another account.
 */
export function admissionBoundTo(
  record: AgentAdmission,
  selection: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "executableIdentity"
    | "observedVersion"
    | "providerRef"
    | "authRoute"
    | "authStorePath"
  >,
  adapterContractVersion: string,
): boolean {
  return (
    record.adapterId === selection.adapterId &&
    record.adapterContractVersion === adapterContractVersion &&
    record.executableIdentity === selection.executableIdentity &&
    record.observedVersion === selection.observedVersion &&
    record.providerRef === selection.providerRef &&
    record.authRoute === selection.authRoute &&
    (record.authStorePath ?? undefined) === (selection.authStorePath ?? undefined)
  );
}
