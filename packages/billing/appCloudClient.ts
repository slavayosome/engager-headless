import { CLOUD_BASE_URL } from "./controlOrigin";

declare const __ENGAGER_APP_CLOUD_ORIGIN__: string;

/** The dashboard always trusts the cloud selected when it was built. Runtime
 * .env flags cannot replace the subscription authority. Rehearsal builds have
 * their own fixed dev origin and never ship as a production Mac artifact. */
export function appCloudOrigin(): string {
  return typeof __ENGAGER_APP_CLOUD_ORIGIN__ === "undefined" ? CLOUD_BASE_URL : __ENGAGER_APP_CLOUD_ORIGIN__;
}

/** One bounded request. Auth codes are single-use, so uncertain mutations must
 * not be blindly replayed; the user can start a fresh sign-in if delivery fails. */
export async function appCloudPost(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  if (!path.startsWith("/api/") || path.includes("?")) throw new Error("Invalid app cloud path");
  const response = await fetch(`${appCloudOrigin()}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    redirect: "error", cache: "no-store", body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, json: await response.json() };
}
