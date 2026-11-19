// The anonymous per-install subject every telemetry event carries (INV-19):
// sixteen random bytes, minted once, stored under ~/.engager, and never
// derived from anything identifying. Not a hash, not a digest, not a
// fingerprint of the hostname, the license, the org, or a machine id — a
// hash of a hostname is still a hostname to anyone holding the other half.
//
// The format is deliberately 32 lowercase hex characters with no dashes, so
// it falls outside the canonical UUID pattern T-27.3's scrubber strips from
// events wherever it appears — an install id shaped like a UUID would be
// scrubbed out of its own events.
import * as crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

// Same directory licenseFilePath already owns and the same HOME_DIR in
// packages/cli/bin/engager.mjs. The one override is `ENGAGER_INSTALL_ID_FILE`,
// set by the tenant provisioner (apps/cloud/lib/tenant.ts) to a file on the
// machine's volume: a hosted container's home directory is its image layer,
// so without it every restart would be a new install. A tenant machine created
// before the provisioner set it still names its volume through the browser
// journal and the vault, which the env contract has always required, so the id
// lives beside them and is stable without an env roll. A `filePath?` parameter
// is what tests use, the same shape packages/billing/license.ts's
// licenseFilePath uses.
export function installIdPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ENGAGER_INSTALL_ID_FILE?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".engager", "install-id");
}

let cachedInstallId: string | null | undefined;

/** Test-only: drop the memo so the next call re-reads the file. */
export function resetInstallIdCache(): void {
  cachedInstallId = undefined;
}

// Never throws: a missing file, an unreadable file, and a file whose
// contents do not match the pattern are all the same case — mint a new id
// and write it, rather than error.
//
// The one place this does NOT mint is when the write fails — an unwritable
// or non-existent home, a read-only container. That returns null rather than
// handing back the value just generated in memory: a per-process id that
// changes at every boot turns one install into a fresh install on every
// restart, and a telemetry counter keyed on that is worse than a counter
// that does not exist. Resolved once per process and memoized — track()
// fires on every funnel milestone, and an unwritable home should cost one
// failed writeFileSync per process rather than one per event.
export function readInstallId(filePath: string = installIdPath()): string | null {
  if (cachedInstallId !== undefined) return cachedInstallId;

  let raw: string | undefined;
  try {
    raw = readFileSync(filePath, "utf8").trim();
  } catch {
    raw = undefined;
  }
  if (raw !== undefined && INSTALL_ID_PATTERN.test(raw)) {
    cachedInstallId = raw;
    return cachedInstallId;
  }

  const minted = crypto.randomBytes(16).toString("hex");
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${minted}\n`);
  } catch {
    cachedInstallId = null;
    return cachedInstallId;
  }
  cachedInstallId = minted;
  return cachedInstallId;
}
