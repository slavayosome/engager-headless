import { ConnectorError } from "../connectorError";

/**
 * The transport failed — the sidecar could not be reached, answered
 * incoherently, or timed out, or a cloud request did the same.
 *
 * A `ConnectorError` because it IS a layer-4 physical failure — but neither
 * rate-limited nor a checkpoint, so `isConnectorBackoff` deliberately does not
 * match it. A dead sidecar is not the account being throttled, and treating it
 * as one would auto-pause an account over a local crash.
 *
 * It lives in a leaf module of its own, beside `./client.ts` rather than in
 * it, for the same reason `connector/resolve.ts` re-spells
 * `BROWSER_PROFILE_LOCKED_CODE` instead of importing it: a module a bundled app
 * reaches should carry the taxonomy and nothing else. The subprocess
 * transport (`./subprocessTransport.ts`) resolves its `python/` sidecar
 * directory from `import.meta.url`, which a bundler cannot follow; this file
 * keeps every module that only needs the failure class out of that graph. One
 * class, one import, no subprocess.
 */
export class BrowserUseTransportError extends ConnectorError {
  /** The word a failed look carries up to the probe, the same one the bridge
   *  answers a transport failure with (`bridgeServer.ts`). A subclass that
   *  knows more says so with a code of its own. */
  readonly code: string = "BRIDGE_TRANSPORT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, { retryable: true });
    this.name = "BrowserUseTransportError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
