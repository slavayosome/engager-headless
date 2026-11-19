import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { copyFile, link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CODEX_DISABLED_FEATURES,
  CODEX_JUDGMENT_PROFILE,
  codexPermissionArgs,
} from "./codex";
import { CODEX_SELF_TEST_VERSION } from "./codexSelfTest";
import { agentStateDirectory } from "./state";

/**
 * THE CODEX SANDBOX PROOF: what `codexSelfTest.ts` established about one
 * binary on this machine, written once and read before every run.
 *
 * Codex keeps judgment inside its own macOS sandbox under the permission
 * profile `buildArgs` names, and flag presence cannot show that sandbox
 * enforcing anything. The self-test can, but it spawns about a dozen sandboxed
 * processes, so it runs where an owner is waiting for an answer (discovery,
 * repair) and execution reads its verdict instead of repeating it.
 *
 * The record is keyed by everything the verdict depends on: the exact binary
 * and the version it reports, the platform, what the self-test held it to —
 * the profile's own argv and `CODEX_DISABLED_FEATURES`, hashed, so an edit to
 * either orphans every earlier proof — and the self-test's version. It is not keyed by model, provider or auth route: the
 * self-test exercises the sandbox, which none of those change.
 *
 * Only passes are written. A failure is reported to the owner and asked again
 * on the next scan, so an update that fixes the sandbox is noticed without a
 * record to clear.
 */
const proofSchema = z
  .object({
    version: z.literal(1),
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
    observedVersion: z.string().min(1),
    platform: z.string().min(1),
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    selfTestVersion: z.number().int(),
    /** The checks that passed, by name, for an audit of what was asked. */
    checks: z.array(z.string()),
    /** `codex features list` with Engager's overrides applied: diagnosis for
     *  a later release that turns on a feature `CODEX_DISABLED_FEATURES`
     *  does not name. Never consulted as a verdict. */
    enabledFeatures: z.array(z.string()),
    recordedAt: z.number(),
  })
  .strict();

export type CodexSandboxProof = z.infer<typeof proofSchema>;

export type CodexProofKey = Pick<
  CodexSandboxProof,
  | "executableSha256"
  | "observedVersion"
  | "platform"
  | "profileDigest"
  | "selfTestVersion"
>;

/** The key for one installation, under the profile execution uses today. */
export function codexProofKey(installation: {
  executableIdentity: string;
  observedVersion: string;
}): CodexProofKey {
  return {
    executableSha256: installation.executableIdentity,
    observedVersion: installation.observedVersion,
    platform: process.platform,
    profileDigest: createHash("sha256")
      .update(
        JSON.stringify([
          codexPermissionArgs(CODEX_JUDGMENT_PROFILE),
          CODEX_DISABLED_FEATURES,
        ]),
      )
      .digest("hex"),
    selfTestVersion: CODEX_SELF_TEST_VERSION,
  };
}

function proofDirectory(): string {
  return join(agentStateDirectory(), "codex-proofs");
}

/** Named for the whole key, so a binary proved under an older profile or
 *  self-test never answers for the current one. */
function proofFile(key: CodexProofKey): string {
  const name = createHash("sha256")
    .update(
      JSON.stringify([
        key.executableSha256,
        key.observedVersion,
        key.platform,
        key.profileDigest,
        key.selfTestVersion,
      ]),
    )
    .digest("hex");
  return join(proofDirectory(), `${name}.json`);
}

/** `link`, or on a filesystem without hard links an exclusive copy: neither
 *  ever overwrites, and both refuse an existing name with `EEXIST`. */
async function publish(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

/**
 * Publish a passing self-test. `link` refuses an existing name, and an
 * existing name is usually another scan that proved the same key first — the
 * same verdict about the same binary — so a refusal is success once that
 * record reads back as this key's proof. One that does not (a torn copy from
 * `publish`'s fallback) is replaced once rather than left to refuse forever.
 */
export async function recordCodexSandboxProof(
  key: CodexProofKey,
  evidence: Pick<CodexSandboxProof, "checks" | "enabledFeatures">,
): Promise<void> {
  const record: CodexSandboxProof = proofSchema.parse({
    version: 1,
    ...key,
    checks: evidence.checks,
    enabledFeatures: evidence.enabledFeatures,
    recordedAt: Date.now(),
  });
  await mkdir(proofDirectory(), { recursive: true, mode: 0o700 });
  const temporary = join(proofDirectory(), `${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await publish(temporary, proofFile(key));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (readCodexSandboxProof(key)) return;
        if (attempt > 0) throw error;
        await unlink(proofFile(key)).catch(() => {});
      }
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** The proof for exactly this key, or undefined. A missing, malformed or
 *  foreign record is no proof, never an error. */
export function readCodexSandboxProof(
  key: CodexProofKey,
): CodexSandboxProof | undefined {
  try {
    const parsed = proofSchema.parse(
      JSON.parse(readFileSync(proofFile(key), "utf8")),
    );
    return parsed.executableSha256 === key.executableSha256 &&
      parsed.observedVersion === key.observedVersion &&
      parsed.platform === key.platform &&
      parsed.profileDigest === key.profileDigest &&
      parsed.selfTestVersion === key.selfTestVersion
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
