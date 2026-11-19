import type { Tx } from "@engager/database/tenant";
import { managedAccess, managedAppArmed } from "./entitlementClient";

export { LICENSE_HOLD_RECHECK_MS } from "./entitlementClient";

export type RuntimeEntitlement =
  | { allowed: true; source: "core_local" }
  | { allowed: false; reason: "subscription_inactive" };

/** Background work can also be held by the managed desktop seat. */
export type BackgroundEntitlement =
  | Extract<RuntimeEntitlement, { allowed: true }>
  | { allowed: false; reason: "subscription_inactive" | "license_lapsed" };

/** Local execution does not depend on billing history. */
export async function runtimeEntitlement(
  _tx: Tx,
  _organizationId: string,
  _opts: { lock?: boolean; now?: number } = {},
): Promise<RuntimeEntitlement> {
  return { allowed: true, source: "core_local" };
}

/** Managed desktop background work uses the same signed seat decision as the app. */
export async function backgroundEntitlement(
  tx: Tx,
  organizationId: string,
  opts: { lock?: boolean; now?: number } = {},
): Promise<BackgroundEntitlement> {
  const entitlement = await runtimeEntitlement(tx, organizationId, opts);
  if (!entitlement.allowed || entitlement.source !== "core_local" || !managedAppArmed()) return entitlement;
  return managedAccess({ now: opts.now === undefined ? undefined : new Date(opts.now) }).allowed
    ? entitlement : { allowed: false, reason: "license_lapsed" };
}
