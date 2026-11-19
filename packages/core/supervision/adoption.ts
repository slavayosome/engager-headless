import { serviceAdmission, type ServiceDecision } from "@engager/billing/capabilities";
import type { EntitlementDecision } from "@engager/billing/entitlementCache";
import type { CommercialProjection } from "@engager/billing/projection";
import type { Tx } from "@engager/database/tenant";
import { claimSupervision, type SupervisionClaim, type Supervisor } from "./record";

/**
 * WHO IS ALLOWED TO SUPERVISE THIS INSTALL — the commercial half, kept out of
 * `record.ts` so mutual exclusion and payment never share a function.
 *
 * The rule this module exists to hold is the lapse rule from PRODUCT.md, in
 * one place:
 *
 * > A lapse stops new MANAGED supervisor work. Installed UI retains free
 * > manual/recovery/data surfaces. Self-managed continuation changes who
 * > supervises the same core and preserves the existing publish settings
 * > without silently starting a catch-up run.
 *
 * The asker is the Mac app, over its loopback bridge; the dashboard offered a
 * "Run self-managed" control until the Settings split removed it, because the
 * free tier has no dashboard and choosing to be unsupervised is not a state
 * that app can be the place for. So an unentitled machine is refused MANAGED
 * supervision and left on the self-managed continuation — it is never silently
 * downgraded (an owner who paid must be told their machine stopped being the
 * maintained one) and it is never locked out of its own data (`freeCore` is
 * invariantly available).
 */
export type SupervisionAdmission = ServiceDecision & {
  /** The supervisor this decision actually grants. `managed_desktop` only on
   *  an allowed managed request; every other cell grants nothing and leaves
   *  whatever supervisor the install already had. */
  supervisor: Supervisor | null;
  /** Invariant in every cell, for every entitlement decision: reading,
   *  drafting, exporting, stopping and reconciling are not commercial. */
  freeCore: "available";
  /** True whenever the machine may still be told to run itself — which is
   *  every cell. */
  selfManagedOffered: boolean;
};

/**
 * The managed grant, derived from the ONE commercial projection and this
 * machine's own verified capability — never from `license.json` read directly,
 * and never from a caller-supplied boolean.
 *
 * Both halves must agree, and the DEVICE half is never optional: the signed
 * claim says THIS Mac holds one of the account's seats, and a machine with a
 * valid account and no seat is not a maintained Mac.
 *
 * The ACCOUNT half is the projection wherever the projection has an opinion — a
 * signed claim for a subscription it has since cancelled is a revoked one, and
 * the newer negative always wins, which is why it is consulted even when the
 * cached claim verifies. Where it says `no_account` it is not disagreeing but
 * silent, because a Mac install's database has no subscription rows to hold; the
 * claim then stands in for it (see below).
 */
export function supervisionAdmission(input: {
  requested: Supervisor;
  projection: CommercialProjection;
  /** This machine's verified `desktop_managed` decision, or null when it holds
   *  no seat at all. */
  capability: EntitlementDecision | null;
}): SupervisionAdmission {
  const free = { freeCore: "available" } as const;
  if (input.requested === "self_managed") {
    // Self-managed supervision is the free core supervising itself. It asks no
    // commercial question at all, so there is none to answer here.
    const decision = serviceAdmission({
      service: "self_local",
    });
    return {
      ...decision,
      ...free,
      supervisor: decision.allowed ? "self_managed" : null,
      selfManagedOffered: decision.allowed,
    };
  }
  const projectionGrants =
    input.projection.capabilities.includes("desktop_managed");
  const deviceVerified =
    input.capability?.allowed === true &&
    input.capability.capability === "desktop_managed";
  // A MAC INSTALL'S OWN DATABASE HOLDS NO SUBSCRIPTION ROWS. Provider events
  // land on the cloud (`packages/billing/webhooks.ts` is the only writer), so on
  // a laptop `no_account` is the absence of evidence, not evidence of absence —
  // and requiring the local projection there refuses every maintained Mac there
  // is. The signed claim is what the account says in that case: the control
  // plane issued it FROM that projection, against this device's seat, for a
  // bounded term (`apps/cloud/lib/issuance.ts`), so it carries the same fact one
  // hop further out.
  //
  // It stands in only where the local projection is silent. A projection that
  // has an opinion always wins, which is what keeps "the newer negative beats a
  // cached claim" true on a hosted tenant: a cancellation projected there refuses
  // the machine even while its claim is still inside its own expiry.
  const claimStandsInForTheAccount =
    input.projection.state === "no_account" && deviceVerified;
  const decision = serviceAdmission({
    service: "managed_desktop",
    grant:
      (projectionGrants || claimStandsInForTheAccount) && deviceVerified
        ? {
            capability: "desktop_managed",
            // The claim's own paid generation when it is the authority: a
            // `no_account` projection reports generation 0, which
            // `serviceAdmission` refuses outright, and reporting it for a machine
            // admitted on its claim would be reporting a number nobody paid.
            generation: projectionGrants
              ? input.projection.generation
              : (input.capability?.claims?.generation ?? 0),
            valid: true,
          }
        : undefined,
  });
  return {
    ...decision,
    ...free,
    supervisor: decision.allowed ? "managed_desktop" : null,
    selfManagedOffered: true,
  };
}

export type SupervisionAdoption =
  | { status: "adopted"; admission: SupervisionAdmission; claim: SupervisionClaim }
  | { status: "refused"; admission: SupervisionAdmission };

/**
 * Take supervision if the commercial answer allows it. One call so no caller
 * can claim the holder first and check entitlement afterwards.
 *
 * A refusal writes nothing: the previous supervisor's record, its restart
 * history and its last diagnosis all stay exactly as they were, which is what
 * makes "your Mac service ended, and here is what it was doing" honest.
 */
export async function adoptSupervision(
  tx: Tx,
  input: {
    organizationId: string;
    holderId: string;
    requested: Supervisor;
      projection: CommercialProjection;
    capability: EntitlementDecision | null;
    now: number;
  },
): Promise<SupervisionAdoption> {
  const admission = supervisionAdmission(input);
  if (!admission.allowed || admission.supervisor === null) {
    return { status: "refused", admission };
  }
  const claim = await claimSupervision(tx, {
    organizationId: input.organizationId,
    holderId: input.holderId,
    supervisor: admission.supervisor,
    now: input.now,
  });
  return { status: "adopted", admission, claim };
}
