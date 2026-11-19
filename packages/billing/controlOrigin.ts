/** Where the Engager-owned cloud is, in a module that imports NOTHING.
 *
 * `cloudUrl.ts` states why the base URL cannot live beside `licenseClient.ts`
 * (a browser bundle cannot take `node:crypto`). This file states the second
 * reason it cannot live beside `licenseRequired()` either: the FREE MCP graph
 * reaches the control origin now — a hosted browser session asks the
 * controller for a fleet permit — and P1's packaged-build boundary keeps every
 * license-gate module out of that graph
 * (`packages/cli/build.e2e.test.ts:47-56`).
 *
 * `cloudUrl.ts` re-exports both names, so every existing import site is
 * unchanged and there is still exactly one answer to "where is the cloud". */

export const CLOUD_BASE_URL = "https://cloud.getengager.com";

declare const __ENGAGER_CHECKPOINT_ORIGIN__: string;

/** Only the canonical CLI build can select a rehearsal relay destination.
 * Its tenant marker proves this image belongs to the allocating control
 * service; it cannot redirect the scoped credential. Existing production
 * tenants without the additive marker keep the fixed production endpoint. */
export function checkpointControlOrigin(): string {
  const origin = typeof __ENGAGER_CHECKPOINT_ORIGIN__ === "undefined"
    ? CLOUD_BASE_URL : __ENGAGER_CHECKPOINT_ORIGIN__;
  const expected = process.env.ENGAGER_CLOUD_NOTIFICATION_ORIGIN;
  if ((expected !== undefined || origin !== CLOUD_BASE_URL) && expected !== origin) {
    throw new Error("Cloud checkpoint control origin does not match this worker image");
  }
  return origin;
}
