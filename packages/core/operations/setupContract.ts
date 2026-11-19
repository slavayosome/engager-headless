import { resolveDeploymentEnvironment } from "@engager/database/environment";

/**
 * The local-first setup completion contract is in force: an explicit "local"
 * or "cloud" deployment. Under it, LinkedIn connection follows the DRIVER (not
 * a stored hosted secret), the Manual stamp is the completion evidence (no
 * subscription), and the retired hosted preview flow is not required. A cloud
 * tenant is the SAME org on a remote database rather than the laptop's, so it
 * takes the same contract; inheriting the hosted one would re-land phase 15's
 * hazard — the guarded trial, retired setup path — on
 * a paying tenant.
 * Deliberately NOT the wider isLocalDeployment(): "test" is where CI
 * exercises the HOSTED contract, so it must stay hosted-strict —
 * local-contract tests opt in by stubbing ENGAGER_DEPLOYMENT_ENV=local.
 *
 * This predicate is about WHERE the product runs, not WHETHER it is paid —
 * it deliberately does not also check paywall enforcement. Arming the
 * paywall gate must never flip a local install onto the hosted contract's
 * deleted fences (the subscription-backed completion evidence) and brick setup on the machine that
 * just paid. The predicate fails toward hosted strictness on its own:
 * resolveDeploymentEnvironment() throws on an unrecognized marker, so a
 * hosted runtime can never wander into this contract by accident.
 */
export function localSetupContract(): boolean {
  try {
    const environment = resolveDeploymentEnvironment();
    return environment === "local" || environment === "cloud";
  } catch {
    return false;
  }
}
