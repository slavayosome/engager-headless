import {
  isHostedRuntimeEnvironment,
  resolveDeploymentEnvironment,
} from "@engager/database/environment";
import { ENGAGER_OFFERS, OFFER_IDS } from "./offer";

export type BillingRuntimeConfig =
  | { mode: "configured" }
  | { mode: "disabled" }
  | { mode: "invalid"; reason: string };

/** The operator bypass is deliberately a local/test convenience only. A typo,
 * missing environment marker, or hosted deployment always leaves enforcement on. */
export function paywallEnforcementEnabled(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (processEnv.ENGAGER_PAYWALL_ENABLED !== "false") return true;
  try {
    resolveDeploymentEnvironment(processEnv);
    return isHostedRuntimeEnvironment(processEnv);
  } catch {
    return true;
  }
}

/** The credentials every paid deployment needs whatever it sells. The two
 * purchasable Price ids are NOT here: they are the offer catalogue's own envs
 * (`STRIPE_PRICE_MAC_MONTHLY`, `STRIPE_PRICE_CLOUD_MONTHLY`), checked below
 * against `ENGAGER_OFFERS` so adding an offer cannot leave its price unchecked.
 * The retired Pro plan's `STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_YEARLY` were
 * required here until phase 36 and sold nothing: a deployment configured with
 * exactly the two real prices refused to boot, and an operator who satisfied
 * this list learned nothing about whether Checkout could charge anybody. */
const REQUIRED_BILLING_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
] as const;

const BILLING_ENV_FORMATS: Partial<
  Record<(typeof REQUIRED_BILLING_ENV)[number], RegExp>
> = {
  STRIPE_SECRET_KEY: /^(?:sk|rk)_(?:test|live)_\S+$/,
  STRIPE_WEBHOOK_SECRET: /^whsec_\S+$/,
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID: /^bpc_\S+$/,
};

/** Fail-closed configuration readiness for the paid launch. Provider-side Price
 *  amount/interval and Portal policy are verified by the Checkout/Portal paths;
 *  this catches the earlier customer-visible dead end where the app deployed
 *  without one of the required credentials, or without the Stripe Price env a
 *  catalogued offer names — the shape phase 36 found, where the checklist told
 *  the operator to set a variable the code no longer reads. */
export function billingRuntimeConfig(
  processEnv: NodeJS.ProcessEnv = process.env,
): BillingRuntimeConfig {
  let deployment: ReturnType<typeof resolveDeploymentEnvironment>;
  try {
    deployment = resolveDeploymentEnvironment(processEnv);
  } catch (error) {
    return {
      mode: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "Invalid deployment environment",
    };
  }
  const hosted = isHostedRuntimeEnvironment(processEnv);
  if (hosted && deployment !== "dev" && deployment !== "prod") {
    return {
      mode: "invalid",
      reason:
        "ENGAGER_DEPLOYMENT_ENV must be dev or prod on a hosted platform",
    };
  }
  if (hosted && processEnv.ENGAGER_PAYWALL_ENABLED === "false") {
    return {
      mode: "invalid",
      reason:
        "ENGAGER_PAYWALL_ENABLED=false is permitted only in local/test runtimes",
    };
  }
  const values = Object.fromEntries(
    REQUIRED_BILLING_ENV.map((key) => [key, processEnv[key]?.trim() ?? ""]),
  ) as Record<(typeof REQUIRED_BILLING_ENV)[number], string>;
  const present = REQUIRED_BILLING_ENV.filter((key) => values[key]);
  if (present.length === 0 && !hosted) return { mode: "disabled" };
  const missing = REQUIRED_BILLING_ENV.filter((key) => !values[key]);
  if (missing.length > 0) {
    return {
      mode: "invalid",
      reason: `Paid billing is missing required configuration: ${missing.join(", ")}`,
    };
  }
  const malformed = REQUIRED_BILLING_ENV.filter((key) => {
    const expected = BILLING_ENV_FORMATS[key];
    return expected ? !expected.test(values[key]) : false;
  });
  if (malformed.length > 0) {
    return {
      mode: "invalid",
      reason: `Paid billing has malformed Stripe configuration: ${malformed.join(", ")}`,
    };
  }
  const requiredKeyMode = deployment === "prod" ? "live" : "test";
  if (
    hosted &&
    !new RegExp(`^(?:sk|rk)_${requiredKeyMode}_\\S+$`).test(
      values.STRIPE_SECRET_KEY,
    )
  ) {
    return {
      mode: "invalid",
      reason: `STRIPE_SECRET_KEY must be a ${requiredKeyMode}-mode restricted or secret key when ENGAGER_DEPLOYMENT_ENV=${deployment}`,
    };
  }
  const priceFailure = offerPriceEnvFailure(processEnv);
  if (priceFailure) return { mode: "invalid", reason: priceFailure };
  return { mode: "configured" };
}

/** The named failure a dev or prod deployment earns when a catalogued offer's
 * Stripe Price env is absent: `offer_price_env_missing:<NAME>`, naming the
 * FIRST missing variable in catalogue order so an operator repairs a variable
 * rather than a sentence. `offerPriceId` has no fallback, so an absent env is
 * not a degraded sale — Checkout refuses `offer_not_configured` and that offer
 * cannot be bought at all. Local and test deployments sell nothing and are
 * exempt. Returns undefined when nothing is missing. */
export function offerPriceEnvFailure(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let deployment: ReturnType<typeof resolveDeploymentEnvironment>;
  try {
    deployment = resolveDeploymentEnvironment(processEnv);
  } catch {
    // An unresolvable marker is somebody else's finding, twice over, and
    // answering it here would report the wrong variable: `billingRuntimeConfig`
    // returns the resolver's own message before ever calling this, and the
    // database marker check refuses the runtime outright. This function
    // answers one question — about dev and prod — and says nothing otherwise.
    return undefined;
  }
  if (deployment !== "dev" && deployment !== "prod") return undefined;
  const missing = OFFER_IDS.map((id) => ENGAGER_OFFERS[id].priceEnv).find(
    (name) => !processEnv[name]?.trim(),
  );
  return missing ? `offer_price_env_missing:${missing}` : undefined;
}

/** The startup assertion: the same check as a throw, for the preflight paths
 * that must stop a deployment before it provisions rather than answer a
 * caller. Fails closed — a dev or prod service missing either real Price env
 * never reaches the work. */
export function assertOfferPriceEnvConfigured(
  processEnv: NodeJS.ProcessEnv = process.env,
): void {
  const failure = offerPriceEnvFailure(processEnv);
  if (failure) throw new Error(failure);
}
