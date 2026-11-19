import { licenseRequired } from "./licenseMode";
import { CLOUD_BASE_URL } from "@engager/common/controlOrigin";

/** Where the cloud is, stated once -- and in a module with no Node
 * imports, because the dashboard's sign-in page (a client component) links
 * here too: `licenseClient.ts` pulls `node:crypto`/`fs`/`os`/`path` into
 * whatever imports it, and a browser bundle cannot take those.
 *
 * The constant itself and the control origin moved one file down, to
 * `controlOrigin.ts`, which imports nothing, so core can read them without
 * reaching `licenseMode.ts`. Both are re-exported here so every
 * import site keeps working. */
export { CLOUD_BASE_URL, checkpointControlOrigin } from "@engager/common/controlOrigin";

/** The baked constant is the base URL everywhere the gate is armed (INV-18).
 * The override is read only when `licenseRequired()` is false -- the same
 * idiom verifyLicenseToken already uses for its `publicKey` override
 * (packages/core/entitlements/license.ts:128) -- because on a gated machine `.env` is
 * user-writable, so a runtime-readable base URL would be a self-signed
 * license. */
export function cloudBaseUrl(): string {
  if (!licenseRequired()) {
    const override = process.env.ENGAGER_CLOUD_URL?.trim();
    if (override) return override.replace(/\/+$/, "");
  }
  return CLOUD_BASE_URL;
}
