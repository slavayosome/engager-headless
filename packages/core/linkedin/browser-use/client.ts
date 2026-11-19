import { randomUUID } from "node:crypto";
import {
  BROWSER_USE_PROTOCOL_VERSION,
  BrowserUseRequestSchema,
  type BrowserUseDiagnostic,
  type BrowserUseOperation,
  type BrowserUseRequest,
  type BrowserUseRequestFor,
  type BrowserUseResponse,
  type BrowserUseSuccessResponseFor,
} from "./protocol";
import { ConnectorError } from "../connectorError";
import { BrowserUseTransportError } from "./transportError";
import { trackReadFailure } from "./readFailure";

/** Must stay comfortably above a send's POST at its worst (backend.py): the
 *  post's page opened again where the tab has left it, the wait for the headers
 *  its own client names it by, the one POST's own timeout (`SEND_TIMEOUT_MS` in
 *  comment_write.py) and the read back of an answer that settles nothing
 *  (`WRITE_READ_BACKS`). A write timeout is treated as ambiguous, so cutting
 *  this below that budget would manufacture UNCERTAIN writes out of comments
 *  that actually landed. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export type BrowserUseRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Injectable seam used by unit tests; CI never starts a browser or Python. */
export interface BrowserUseTransport {
  send(
    request: BrowserUseRequest,
    options?: BrowserUseRequestOptions,
  ): Promise<BrowserUseResponse>;
  close(): Promise<void>;
}

/**
 * Codes the sidecar uses for "the ACCOUNT is being challenged", as opposed to
 * "the operation failed".
 *
 * `backend.py` raises exactly three: `CHECKPOINT_REQUIRED` and
 * `ACCOUNT_RESTRICTED` from its wall classifier, and `CHECKPOINT_REQUIRED`
 * again from the post-click challenge branch of a write. The wire schema
 * (`BrowserUseProtocolErrorSchema`) still carries `retryable` and
 * `rateLimited` but has NO checkpoint flag, so this inference — code in, this
 * set — is the WHOLE classification, not a fallback beside a reported one.
 * Widening the protocol is the proper fix and belongs with the connector
 * phase. Case is folded at the membership test so both the sidecar's
 * uppercase vocabulary and the lowercase legs below live in one set.
 */
const CHECKPOINT_CODES = new Set([
  "checkpoint",
  "challenge",
  "checkpoint_required",
  "account_restricted",
]);

/**
 * Codes that mean NOBODY IS SIGNED IN. One connector emits one of them today:
 * the sidecar's `LOGIN_REQUIRED`, which its wall classifier raises for a page
 * sitting on `/login`, `/authwall` or `/uas/`. `auth_required` and
 * `session_invalid` are carried across from the set below unproduced, exactly
 * as they arrived there — a code nothing emits classifies as nothing, and
 * dropping the two would silently move them from "signed out" to "an ordinary
 * failed call" the day something does emit one.
 *
 * Split out of `CHECKPOINT_CODES`, where all three used to sit. A challenge and
 * a signed-out session are different conditions with different remedies, and
 * treating the second as the first is what let a sweep on a blank free install
 * park the account for fifteen minutes as `checkpoint` and then answer `0
 * found` off its own pause once the owner had signed back in (2026-09-15).
 */
const SIGN_IN_CODES = new Set([
  "auth_required",
  "login_required",
  "session_invalid",
]);

/**
 * The sidecar's code for "this page is not one I recognise" — a read that
 * found an unknown structure and refused to guess at it. It arrives with a
 * `diagnostic` (the page's shape fingerprint and a redacted excerpt) so the
 * selector pack can be repaired from the log line alone.
 */
export const BROWSER_UI_DRIFT_CODE = "UI_DRIFT";

/**
 * The sidecar's code for a search LinkedIn refused as too large — its HTTP
 * 413, which a boolean query with more than three ORs gets whatever its
 * length. Carried as that status, the one `isSearchTooLarge` reads for any
 * connector.
 */
export const BROWSER_SEARCH_TOO_LARGE_CODE = "SEARCH_TOO_LARGE";

export class BrowserUseRemoteError extends ConnectorError {
  readonly code: string;
  readonly diagnostic?: BrowserUseDiagnostic;
  /** The sidecar refused before it pressed anything: the write did not go out. */
  readonly notAttempted: boolean;

  constructor(input: {
    code: string;
    message: string;
    retryable?: boolean;
    rateLimited?: boolean;
    notAttempted?: boolean;
    diagnostic?: BrowserUseDiagnostic;
  }) {
    super(input.message, {
      retryable: input.retryable ?? false,
      rateLimited: input.rateLimited ?? false,
      checkpoint: CHECKPOINT_CODES.has(input.code.toLowerCase()),
      signIn: SIGN_IN_CODES.has(input.code.toLowerCase()),
      drift: input.code === BROWSER_UI_DRIFT_CODE,
      ...(input.code === BROWSER_SEARCH_TOO_LARGE_CODE ? { status: 413 } : {}),
    });
    this.name = "BrowserUseRemoteError";
    this.code = input.code;
    this.notAttempted = input.notAttempted ?? false;
    if (input.diagnostic) this.diagnostic = input.diagnostic;
  }
}

/** The transport failure both halves share. It lives in `./transportError.ts`
 *  so the taxonomy stays a leaf every bundled module can reach; re-exported
 *  here because every existing caller spells it from the client. */
export { BrowserUseTransportError } from "./transportError";

export class BrowserUseTimeoutError extends BrowserUseTransportError {
  constructor(readonly timeoutMs: number) {
    super(`Browser Use request exceeded ${timeoutMs}ms`);
    this.name = "BrowserUseTimeoutError";
  }
}

/**
 * The sidecar's own code for "another process already holds this browser
 * profile" — `SidecarError("JOURNAL_LOCKED", …)` in journal.py.
 *
 * Spelled here and again in `connector/resolve.ts`, which maps it to a
 * `profile_in_use` refusal: that module resolves a BINDING and opens nothing,
 * so it reads the code structurally instead of importing the class that the
 * transport raises. The suite pins the two copies equal.
 */
export const BROWSER_PROFILE_LOCKED_CODE = "JOURNAL_LOCKED";

/**
 * A second sidecar tried to open a profile the first one holds.
 *
 * `DurableJournal` takes a NON-BLOCKING flock, so this fails fast rather than
 * deadlocking — but it fails before the ready event, which means bridge.py
 * prints it to stderr and exits instead of framing it: the code itself never
 * crosses the process boundary, only the message does. Recognising that
 * message is what turns "exited before ready (code=1)" — indistinguishable
 * from any other startup crash — into a condition callers can name.
 *
 * Retryable, because the profile frees when the other process lets go; and
 * neither rate-limited nor a checkpoint, so `isConnectorBackoff` stays false —
 * two local processes colliding is not the ACCOUNT under strain, and must
 * never pause it.
 */
export class BrowserUseProfileInUseError extends BrowserUseTransportError {
  readonly code = BROWSER_PROFILE_LOCKED_CODE;

  constructor(detail: string) {
    super(`Another process already holds the Browser Use profile: ${detail}`);
    this.name = "BrowserUseProfileInUseError";
  }
}

type ParamsFor<Op extends BrowserUseOperation> =
  BrowserUseRequestFor<Op>["params"];
type ResultFor<Op extends BrowserUseOperation> =
  BrowserUseSuccessResponseFor<Op>["result"];

/**
 * Every construction states its transport. The subprocess sidecar is one
 * transport among others, and it lives in `./subprocessTransport.ts` — the
 * module that resolves the `python/` project directory from `import.meta.url`
 * and spawns a process. Requiring the seam HERE is what keeps this file
 * transport-independent: a bundled app (the Next dashboard) can build the
 * bridge client without evaluating a subprocess import, and no caller can
 * silently acquire a second browser holder by omitting an argument.
 */
export type BrowserUseClientOptions = {
  transport: BrowserUseTransport;
  defaultTimeoutMs?: number;
};

/** Typed operation client shared by the driver and the standalone spike. */
export class BrowserUseClient {
  readonly transport: BrowserUseTransport;
  private readonly defaultTimeoutMs: number;
  private closed = false;

  constructor(options: BrowserUseClientOptions) {
    this.transport = options.transport;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<Op extends BrowserUseOperation>(
    op: Op,
    params: ParamsFor<Op>,
    options: BrowserUseRequestOptions = {},
  ): Promise<ResultFor<Op>> {
    if (this.closed) {
      throw new BrowserUseTransportError("Browser Use client is closed");
    }
    const request = BrowserUseRequestSchema.parse({
      v: BROWSER_USE_PROTOCOL_VERSION,
      id: randomUUID(),
      op,
      params,
    }) as BrowserUseRequestFor<Op>;
    try {
      const response = await this.transport.send(request, {
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        signal: options.signal,
      });
      if (response.id !== request.id || response.op !== op) {
        throw new BrowserUseTransportError(
          "Browser Use transport returned a mismatched response",
        );
      }
      if (!response.ok) {
        throw new BrowserUseRemoteError(response.error);
      }
      return response.result as ResultFor<Op>;
    } catch (error) {
      // Usage data: a read that failed, counted by kind and class. An abort
      // the caller asked for is not one.
      if (!options.signal?.aborted) trackReadFailure(op, error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("shutdown", {});
    } catch {
      // A crashed or already-stopped child still needs local transport cleanup.
    } finally {
      this.closed = true;
      await this.transport.close();
    }
  }
}
