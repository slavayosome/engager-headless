/**
 * The transport half of INV-19's local relay. A packaged local install ships
 * no PostHog key at all, so its events' only legal destination is the cloud
 * route (`apps/cloud/app/api/telemetry/route.ts`). This module POSTs one batch
 * there. It mints nothing (`installId` is an explicit argument) and knows
 * nothing about the catalog: validation lives in `analytics.ts`, its only
 * caller, and again in the route.
 *
 * Mirrors — does not import — the fetch idiom of `request()` in
 * packages/billing/licenseClient.ts: a single POST, `content-type:
 * application/json`, and an `AbortSignal` timeout. Unlike `request()` it never
 * retries: `licenseClient`'s `MAX_ATTEMPTS` budget exists because a license
 * answer is load-bearing, and a dropped batch is not worth a retry storm. And
 * it never throws: a failed flush drops its batch, because telemetry must
 * never break a product path.
 */
import { CLOUD_BASE_URL } from "@engager/billing/controlOrigin";

const RELAY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Where a batch goes when no origin is registered: `ENGAGER_CLOUD_URL` when
 * set, so a rehearsal's batches never reach the canonical cloud, else the
 * canonical cloud. A process that carries the licence gate registers
 * `cloudBaseUrl` (the agent, the dashboard), which ignores that variable on a
 * gated build; this module reads the variable itself. Usage data
 * carries no credential, so an override on a gated machine redirects nothing
 * but the owner's own batches.
 */
function defaultOrigin(): string {
  const override = process.env.ENGAGER_CLOUD_URL?.trim();
  return override ? override.replace(/\/+$/, "") : CLOUD_BASE_URL;
}

let originSource: () => string = defaultOrigin;

export function registerRelayOrigin(source: (() => string) | null): void {
  originSource = source ?? defaultOrigin;
}

/** One queued event as it travels: the validated properties, the context the
 * flush attached, the PostHog groups, and when it happened. */
export type WireEvent = {
  event: string;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
  groups?: Record<string, string>;
  timestamp: string;
};

/** The most events one request may carry; the route enforces the same number. */
export const MAX_WIRE_BATCH = 50;

export async function relayBatch(opts: {
  installId: string;
  events: WireEvent[];
}): Promise<void> {
  for (let start = 0; start < opts.events.length; start += MAX_WIRE_BATCH) {
    try {
      await fetch(`${originSource()}/api/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installId: opts.installId,
          events: opts.events.slice(start, start + MAX_WIRE_BATCH),
        }),
        signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network error, connection refused, and an aborted (timed-out) signal
      // all land here. A non-2xx response does not: `fetch` resolves rather
      // than rejects for a 4xx/5xx, so that case is already covered without a
      // status check — this module never inspects the response at all.
    }
  }
}
