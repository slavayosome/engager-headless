export type Service = "self_local" | "managed_desktop";
export type Capability = "core_local" | "desktop_managed";
export type RecoveryAction =
  | "read" | "export" | "stop" | "disconnect" | "reconcile"
  | "prepare_restore" | "revoke_credential";
export type ServiceDecision = {
  allowed: boolean;
  capability: Capability;
  reason: "available" | "subscription_inactive";
  recovery: "none" | "run_self_managed" | "renew_service";
  generation: number | null;
};

/** Common predicate. Only a verified commercial projection may supply a paid
 * grant. P4 issues the new signed projection; P1 introduces no paid grant. */
export function serviceAdmission(input: {
  service: Service;
  grant?: { capability: "desktop_managed"; generation: number; valid: boolean };
}): ServiceDecision {
  const capability: Capability = input.service === "self_local" ? "core_local" : "desktop_managed";
  const allowed = capability === "core_local" ||
    (input.grant?.valid === true && input.grant.capability === capability &&
      Number.isSafeInteger(input.grant.generation) && input.grant.generation > 0);
  return {
    allowed, capability, reason: allowed ? "available" : "subscription_inactive",
    recovery: allowed ? "none" : "run_self_managed",
    generation: input.grant?.generation ?? null,
  };
}

/** This is commercial admission only. Callers still authorize the owner, org,
 * credential and the exact recovery side effect through their normal boundary. */
export function recoveryAdmission(action: RecoveryAction): boolean {
  return ["read", "export", "stop", "disconnect", "reconcile", "prepare_restore", "revoke_credential"].includes(action);
}
