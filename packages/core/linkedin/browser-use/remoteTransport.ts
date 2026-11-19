import { randomUUID } from "node:crypto";
import {
  BrowserUseResponseSchema,
  type BrowserUseRequest,
  type BrowserUseResponse,
} from "./protocol";
import {
  BrowserUseTimeoutError,
  BrowserUseTransportError,
  type BrowserUseRequestOptions,
  type BrowserUseTransport,
} from "./client";
import { readBridgeFile, type BrowserBridgeFile } from "./bridgeFile";
import { browserProfileDir } from "../session";

/**
 * The remote half of the browser bridge: the sidecar wire protocol over
 * loopback HTTP to the one standing holder (the agent), instead of a
 * subprocess of our own.
 *
 * Same seam the subprocess transport implements, same error taxonomy: a
 * bridge that cannot be reached, answers incoherently, or times out is a
 * retryable `BrowserUseTransportError` — a dead bridge is not the account
 * being throttled, exactly as a dead sidecar never was. An ambiguous
 * `write` timeout flows into the journal's reconcile path unchanged.
 *
 * `close()` is a no-op on purpose: the browser belongs to the bridge's
 * process, and the server refuses a remote `shutdown` op for the same reason
 * — one caller finishing must never take the install's Chrome with it.
 */

/** Slack over the op's own timeout, so the server's timer fires first and the
 *  client still never hangs on a wedged bridge. */
const REMOTE_TIMEOUT_SLACK_MS = 5_000;
/** A health probe is a liveness question; anything slow is an answer. */
const HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export type BridgeEndpoint = { url: string; token: string };

export class HttpBrowserUseTransport implements BrowserUseTransport {
  constructor(
    private readonly endpoint: BridgeEndpoint,
    /** Test seam: production always waits the full slack. */
    private readonly slackMs: number = REMOTE_TIMEOUT_SLACK_MS,
  ) {}

  async send(
    request: BrowserUseRequest,
    options?: BrowserUseRequestOptions,
  ): Promise<BrowserUseResponse> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs + this.slackMs,
    );
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(`${this.endpoint.url}/browser`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.endpoint.token}`,
          "x-engager-timeout-ms": String(timeoutMs),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BrowserUseTransportError(
          `browser bridge answered ${response.status}`,
        );
      }
      const parsed = BrowserUseResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new BrowserUseTransportError(
          "browser bridge returned a malformed response",
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof BrowserUseTransportError) throw error;
      if (controller.signal.aborted && !options?.signal?.aborted) {
        throw new BrowserUseTimeoutError(timeoutMs);
      }
      throw new BrowserUseTransportError(
        `browser bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  async close(): Promise<void> {
    // The bridge's browser outlives every caller by design.
  }
}

/**
 * The reachable bridge for THIS caller's session, or null.
 *
 * Three gates, all cheap: the file exists and speaks our protocol version;
 * its profile directory is our profile directory; and `/health` answers within
 * a second. A stale file — the agent crashed without cleanup — fails the probe
 * and falls through to the subprocess path, where the journal flock still
 * guards the profile.
 *
 * `file` is whose bridge to look for: this session's own by default, and the
 * install's standing holder (`bridgeFilePath()`) for a session that already
 * holds a fallback sidecar.
 */
export async function discoverBridge(
  fetchImpl: typeof fetch = fetch,
  file: string | undefined = process.env.ENGAGER_BROWSER_SESSION_FILE,
): Promise<BridgeEndpoint | null> {
  const entry = readBridgeFile(file);
  if (!entry) return null;
  if (entry.pid === process.pid) return null;
  if (entry.profileDir !== browserProfileDir()) return null;
  const url = `http://127.0.0.1:${entry.port}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${url}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const health = (await response.json()) as { ok?: boolean };
      if (health.ok !== true) return null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
  return { url, token: entry.token };
}

export type { BrowserBridgeFile };
