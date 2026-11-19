import { LicenseClientError } from "./licenseClient";
import { appCloudPost as cloudPost } from "./appCloudClient";
import { termsAcceptanceTime } from "./license";

export type EmailAuthFailure = "invalid_code" | "expired" | "rate_limited" | "browser_required" | "terms_required" | "no_account";
/** Why the code is being asked for. The cloud binds it into the challenge,
 * so start and verify must carry the same word; "signup" also requires the
 * ticked Terms box (`termsAccepted: true`) or the cloud answers
 * `terms_required` and creates nothing. */
export type EmailAuthIntent = "signin" | "signup";
export type AppAccountSelection = { status: "choose_account"; selectionToken: string; expiresIn: number; accounts: { id: string; name: string }[] };

export function accountSelection(value: unknown): AppAccountSelection | null {
  const body = value as AppAccountSelection | null;
  return body?.status === "choose_account" && typeof body.selectionToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.selectionToken) &&
    Number.isFinite(body.expiresIn) && body.expiresIn > 0 && body.expiresIn <= 300 && Array.isArray(body.accounts) && body.accounts.length > 0 &&
    body.accounts.every((account) => typeof account.id === "string" && /^[0-9a-f-]{36}$/i.test(account.id) && typeof account.name === "string") ? body : null;
}

function failure(status: number, json: unknown): EmailAuthFailure | null {
  const body = json as { status?: unknown; error?: unknown } | null;
  const word = body?.status ?? body?.error;
  if (status === 429 || word === "rate_limited") return "rate_limited";
  if (word === "organization_selection_required" || word === "mfa_required" || word === "browser_required") return "browser_required";
  if (word === "expired" || word === "expired_code") return "expired";
  if (word === "invalid_code" || word === "invalid_or_expired") return "invalid_code";
  if (word === "terms_required") return "terms_required";
  if (word === "no_account") return "no_account";
  return null;
}

/** Only the fields the caller actually set ride to the cloud, so a plain
 * sign-in request stays byte-identical to the one sent before sign-up
 * existed as a separate intent. */
function intentFields(input: { intent?: EmailAuthIntent; termsAccepted?: boolean }) {
  return {
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.termsAccepted !== undefined ? { termsAccepted: input.termsAccepted } : {}),
  };
}

export async function startEmailSignIn(input: { email: string; deviceBinding: string; intent?: EmailAuthIntent; termsAccepted?: boolean }) {
  const response = await cloudPost("/api/auth/email-code/start", { email: input.email, deviceBinding: input.deviceBinding, ...intentFields(input) });
  const refused = failure(response.status, response.json);
  if (refused) return { status: refused };
  const body = response.json as { status?: unknown; challengeId?: unknown; expiresIn?: unknown; resendAfter?: unknown } | null;
  if (response.status !== 200 || body?.status !== "sent" || typeof body.challengeId !== "string" ||
      typeof body.expiresIn !== "number" || !Number.isFinite(body.expiresIn) || body.expiresIn <= 0 ||
      typeof body.resendAfter !== "number" || !Number.isFinite(body.resendAfter) || body.resendAfter < 0) {
    throw new LicenseClientError("email sign-in could not start", response.status);
  }
  return { status: "sent" as const, challengeId: body.challengeId, expiresIn: body.expiresIn, resendAfter: body.resendAfter };
}

export async function verifyEmailSignIn(input: { email: string; challengeId: string; code: string; deviceBinding: string; intent?: EmailAuthIntent; termsAccepted?: boolean }) {
  const response = await cloudPost("/api/auth/email-code/verify", {
    email: input.email, challengeId: input.challengeId, code: input.code, deviceBinding: input.deviceBinding, ...intentFields(input),
  });
  const selection = response.status === 200 ? accountSelection(response.json) : null;
  if (selection) return selection;
  const refused = failure(response.status, response.json);
  if (refused) return { status: refused };
  const body = response.json as { status?: unknown; token?: unknown; refreshToken?: unknown; issuedAtSeconds?: unknown; termsAcceptedAt?: unknown } | null;
  if (response.status !== 200 || body?.status !== "verified" || typeof body.token !== "string" ||
      typeof body.refreshToken !== "string" || typeof body.issuedAtSeconds !== "number" || !Number.isFinite(body.issuedAtSeconds)) {
    throw new LicenseClientError("email sign-in could not complete", response.status);
  }
  return { status: "verified" as const, token: body.token, refreshToken: body.refreshToken, issuedAtSeconds: body.issuedAtSeconds,
    termsAcceptedAt: termsAcceptanceTime(body.termsAcceptedAt) };
}
