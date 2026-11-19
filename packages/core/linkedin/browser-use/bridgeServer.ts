import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { config } from "../../config";
import {
  browserMediaChildEnv,
  markLocalBridgeOwner,
} from "../resolve";
import type { WindowPlace } from "../driver";
import { browserProfileDir } from "../session";
import { startSuspensionWatch, suspensionWatch, WAKING_REASON } from "../../supervision/suspension";
import {
  bridgeFilePath,
  removeBridgeFile,
  writeBridgeFile,
} from "./bridgeFile";
import {
  BrowserUseTransportError,
  DEFAULT_TIMEOUT_MS,
  type BrowserUseRequestOptions,
  type BrowserUseTransport,
} from "./client";
import { discoverBridge, HttpBrowserUseTransport } from "./remoteTransport";
import { SubprocessBrowserUseTransport } from "./subprocessTransport";
import { RECYCLE_HOUR } from "./sessionPolicy";
import {
  BROWSER_USE_PROTOCOL_VERSION,
  BrowserUseRequestSchema,
  type BrowserUseRequest,
  type BrowserUseResponse,
} from "./protocol";

/**
 * The browser bridge: the agent's standing browser holder, serving the
 * sidecar wire protocol over loopback HTTP so every other process — the
 * dashboard's chat MCP child, one-shot `engager call` sessions, `mcp --http`
 * — reaches ONE Chromium instead of quitting and relaunching it around the
 * journal flock. The open/close churn the owner watched all day was exactly
 * that hand-off.
 *
 * EVERYTHING routes through one FIFO, the agent's own jobs included: the
 * subprocess transport tolerates interleaved frames (python serializes on its
 * stdin), but a page a write goes from is kept between the requests of one
 * send (the reconcile read, the write, the like that rides it), and an op in
 * between would move the tab. `queuedOwnerTransport()` is therefore the ONLY
 * way this process touches the sidecar. Exactly-once stays in the python
 * journal; the queue only keeps the page intact, and a request that lands
 * between two of a send's is no more than one more page visit.
 *
 * A remote `shutdown` is refused: one caller finishing must never take the
 * install's Chrome with it. The browser closes only with this process — or on
 * the nightly recycle, when the queue is empty.
 */

const RECYCLE_CHECK_MS = 15 * 60_000;
/** How many times the first operation after a wake asks whether the session is
 *  back before it goes ahead anyway, and how far apart. */
export const WAKE_PROBE_ATTEMPTS = 3;
export const WAKE_PROBE_RETRY_MS = 10_000;

type BridgeState = {
  discoveryFile: string;
  sessionOnly: boolean;
  transport: SubprocessBrowserUseTransport;
  /** The standing holder this session handed the profile to, once its bridge
   *  came up behind a fallback sidecar. Every request goes there from then on. */
  standing: HttpBrowserUseTransport | null;
  /** The fallback's window while it is up for the owner (`noteWindow`), with
   *  the area it was put in: what a handover owes them on the holder's side. */
  shownWindow: { place?: WindowPlace } | null;
  browserReady: boolean;
  /** The wake (`SuspensionWatch.lastWakeAt`) the session was last probed
   *  after, so each wake is probed once and not once per operation. */
  probedWake: number | null;
  agentReady: boolean;
  server: Server;
  port: number;
  /** The readiness listener on the private network, null on every install
   *  that does not configure one — which is all of them but the container. */
  healthServer: Server | null;
  healthPort: number | undefined;
  healthProbe?: () => Promise<boolean>;
  token: string;
  tail: Promise<void>;
  queueDepth: number;
  busy: boolean;
  /** When this bridge last did any browser work. */
  lastActivityAt: number;
  recycleTimer: ReturnType<typeof setInterval>;
  lastRecycleDay: string | null;
  closed: boolean;
};

let state: BridgeState | null = null;

function protocolError(
  request: Pick<BrowserUseRequest, "id" | "op">,
  code: string,
  message: string,
  retryable?: boolean,
): BrowserUseResponse {
  return {
    v: BROWSER_USE_PROTOCOL_VERSION,
    id: request.id,
    op: request.op,
    ok: false,
    error: { code, message, ...(retryable ? { retryable } : {}) },
  } as BrowserUseResponse;
}

/**
 * The FIFO itself — one turn of the queue, whatever runs inside it.
 *
 * It takes a body rather than a frame because the session swap is not a frame:
 * the recycle shuts the sidecar down, and that must happen with the queue held
 * or an op lands across it.
 */
async function runExclusive<T>(
  bridge: BridgeState,
  operation: () => Promise<T>,
  recordActivity = true,
): Promise<T> {
  bridge.queueDepth += 1;
  if (recordActivity) bridge.lastActivityAt = Date.now();
  try {
    const run = bridge.tail.then(async () => {
      bridge.busy = true;
      try {
        return await operation();
      } finally {
        bridge.busy = false;
      }
    });
    // A failed op cannot poison the queue.
    bridge.tail = run.then(() => undefined, () => undefined);
    return await run;
  } finally {
    bridge.queueDepth -= 1;
  }
}

/** One op through the FIFO. */
async function enqueue(
  bridge: BridgeState,
  request: BrowserUseRequest,
  options?: BrowserUseRequestOptions,
): Promise<BrowserUseResponse> {
  const deadline = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return runExclusive(bridge, async () => {
    if (bridge.closed) throw new BrowserUseTransportError("Browser session is closed");
    // A caller that stopped waiting must not leave an operation in the queue.
    if (options?.signal?.aborted || Date.now() >= deadline) {
      return protocolError(request, "ABANDONED", "the caller gave up before this ran", true);
    }
    const standing = await standingHolder(bridge);
    // Finding the holder and closing the fallback spent some of the caller's
    // time; a write must not go out after the caller has given up.
    if (options?.signal?.aborted || Date.now() >= deadline) {
      return protocolError(request, "ABANDONED", "the caller gave up before this ran", true);
    }
    if (standing) {
      try {
        return await standing.send(resurfaced(bridge, request), { ...options, timeoutMs: deadline - Date.now() });
      } catch (error) {
        // A holder that went away (agent restart: new port, new token) is
        // found again, or this session's own sidecar starts again, next turn.
        bridge.standing = null;
        throw error;
      }
    }
    const left = await afterWake(bridge, request, deadline - Date.now());
    if (left === 0) {
      return protocolError(request, "MACHINE_WAKING", WAKING_REASON, true);
    }
    if (options?.signal?.aborted || Date.now() >= deadline) {
      return protocolError(request, "ABANDONED", "the caller gave up before this ran", true);
    }
    return sendToSidecar(
      bridge,
      request,
      { ...options, timeoutMs: Math.min(left ?? Infinity, deadline - Date.now()) },
    );
  });
}

/**
 * Whether the fallback's window is up for the owner after `request`, read the
 * way the sidecar reads it: a probe they are watching, a reveal and a restart
 * bring it up, and any unattended op hides it again (`rehide_if_needed`).
 */
function noteWindow(bridge: BridgeState, request: BrowserUseRequest): void {
  if (!bridge.sessionOnly) return;
  const shown = (place: WindowPlace | undefined) => { bridge.shownWindow = place ? { place } : {}; };
  switch (request.op) {
    case "ensure_session":
      if (request.params.interactive !== true) bridge.shownWindow = null;
      else if (request.params.surface !== false) shown(request.params.place);
      return;
    case "set_window_visibility":
      if ("reveal" in request.params) shown(request.params.place);
      else if (request.params.window === "hidden") bridge.shownWindow = null;
      return;
    case "restart_browser":
      shown(request.params.place);
      return;
    case "warm_browser":
      return;
    default:
      bridge.shownWindow = null;
  }
}

/**
 * The first operation handed over, with the owner's window owed to it. The
 * fallback's Chromium went with the handover, and the holder's own is hidden:
 * a sign-in wait chained onto the one that opened the window watches without
 * surfacing (`surface: false`), so the owner saw their sign-in window close and
 * nothing come back until they asked again. The first probe they are watching
 * therefore surfaces it again, in the area the fallback's was in.
 */
function resurfaced(bridge: BridgeState, request: BrowserUseRequest): BrowserUseRequest {
  const owed = bridge.shownWindow;
  bridge.shownWindow = null;
  if (!owed || request.op !== "ensure_session" || request.params.interactive !== true) return request;
  const { surface: _watching, ...params } = request.params;
  return { ...request, params: { ...(owed.place ? { place: owed.place } : {}), ...params } };
}

/**
 * THE STANDING HOLDER, WHEN IT CAME UP BEHIND THIS SESSION'S FALLBACK.
 *
 * A session bridge starts its own sidecar only because no standing bridge was
 * reachable, and the agent can come up a moment later: its sidecar then waits
 * for the profile this one holds, and each side waits on the other. So before
 * every operation a session bridge asks once more, and on finding the holder
 * it lets the profile go: the child is retired, whatever the browser looked
 * like, and only once it has exited and released the journal is anything sent
 * over. This runs inside the FIFO, so
 * an operation in flight finishes first and no write is cut in two, and the
 * session's bridge keeps answering its own callers by forwarding, so none of
 * them needs to learn the holder moved.
 *
 * Null while there is no holder to hand over to, or the fallback could not be
 * closed (logged); the operation then runs on the sidecar it is on.
 */
async function standingHolder(bridge: BridgeState): Promise<HttpBrowserUseTransport | null> {
  if (!bridge.sessionOnly) return null;
  if (bridge.standing) return bridge.standing;
  const endpoint = await discoverBridge(fetch, bridgeFilePath());
  if (!endpoint) return null;
  try {
    await bridge.transport.retire();
  } catch (error) {
    console.error(
      `[browser-bridge] could not close the fallback sidecar for the standing bridge: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  bridge.browserReady = false;
  bridge.standing = new HttpBrowserUseTransport(endpoint);
  return bridge.standing;
}

/**
 * THE FIRST OPERATION AFTER A WAKE MEETS A SESSION THAT IS BACK.
 *
 * A browser that slept comes back in pieces: the CDP socket reconnects, the
 * page it held may be gone ("No web contents in the action target"), and the network
 * can trail the lid by seconds. The sidecar reads every page it cannot place on
 * LinkedIn as `login_required`, so a read in that window is an owner told to
 * sign in again with a session that was fine (2026-10-19, three seconds after
 * the lid opened). Inside the queue, so every caller waits behind the one probe:
 * first for the machine to stay awake (`SuspensionWatch.settled`), then for
 * `ensure_session` — the check every read opens with anyway — to answer, a few
 * times apart. A session still not back after that is answered by the operation
 * itself, which is then the truth. A sleep inside the probes starts it over.
 *
 * The wait is spent out of the operation's own timeout, because a remote
 * caller gives up on its timeout and the bridge would still run what it
 * abandoned. So the operation gets what is left, and one the wake took all of
 * is answered `MACHINE_WAKING`, retryable, with nothing sent.
 *
 * The time the operation has left, or null when there was no wake to wait on.
 */
async function afterWake(
  bridge: BridgeState,
  request: BrowserUseRequest,
  timeoutMs: number,
): Promise<number | null> {
  if (
    request.op === "warm_browser" ||
    request.op === "shutdown" ||
    request.op === "set_window_visibility" ||
    request.op === "restart_browser" ||
    request.op === "close_browser"
  ) return null;
  const pending = suspensionWatch.lastWakeAt();
  if (pending === null || pending === bridge.probedWake) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await suspensionWatch.settled(deadline))) return 0;
    const woke = suspensionWatch.lastWakeAt();
    for (let attempt = 1; ; attempt++) {
      let back = false;
      try {
        const response = await sendToSidecar(
          bridge,
          {
            v: BROWSER_USE_PROTOCOL_VERSION,
            id: randomUUID(),
            op: "ensure_session",
            params: {},
          } as BrowserUseRequest,
          { timeoutMs: Math.max(1, deadline - Date.now()) },
        );
        back = response.ok && response.op === "ensure_session" && response.result.ok;
      } catch {
        // A sidecar that did not answer is a probe that did not pass.
      }
      if (back || attempt >= WAKE_PROBE_ATTEMPTS) break;
      if (deadline - Date.now() <= WAKE_PROBE_RETRY_MS) break;
      await new Promise((resolve) => setTimeout(resolve, WAKE_PROBE_RETRY_MS));
    }
    if (suspensionWatch.lastWakeAt() === woke) {
      bridge.probedWake = woke;
      return Math.max(0, deadline - Date.now());
    }
  }
}

/**
 * The send, and what it says about the browser: a transport that throws or a
 * `BROWSER_UNAVAILABLE` answer means the sidecar's browser is not up, so the
 * next wake or eager start knows to ask again.
 */
async function sendToSidecar(
  bridge: BridgeState,
  request: BrowserUseRequest,
  options?: BrowserUseRequestOptions,
): Promise<BrowserUseResponse> {
  noteWindow(bridge, request);
  let response: BrowserUseResponse;
  try {
    response = await bridge.transport.send(request, options);
  } catch (error) {
    bridge.browserReady = false;
    throw error;
  }
  if (response.ok) bridge.browserReady = true;
  else if (response.error.code === "BROWSER_UNAVAILABLE") {
    bridge.browserReady = false;
  }
  return response;
}

/** Called only once the agent has started both worker lanes and scheduler. */
export function markAgentReady(): void {
  if (state) state.agentReady = true;
}

/** The one transport this process's own drivers use — same FIFO
 *  as every remote caller. Throws before `startBrowserBridge()`. */
export function queuedOwnerTransport(): BrowserUseTransport {
  const bridge = state;
  if (!bridge) {
    throw new Error("browser bridge is not started in this process");
  }
  return {
    send: (request, options) =>
      enqueue(bridge, request, options),
    // The bridge owns the sidecar's lifecycle; a driver letting go of its
    // client must not take the install's browser with it.
    close: async () => {},
  };
}

/**
 * A clean daily Chrome restart, only when nothing is happening: queue empty,
 * once per local day at RECYCLE_HOUR. The next op relaunches
 * lazily (hidden, as ever). Exported for the test's clock.
 *
 * THE PRECONDITION IS THE INV-10 GUARANTEE, and it is unchanged: a non-empty
 * queue skips the day entirely, so the browser is never closed
 * in the middle of a write and nothing is replayed across the boundary.
 */
export async function recycleIfIdle(now: Date = new Date()): Promise<boolean> {
  const bridge = state;
  if (!bridge || bridge.closed) return false;
  const day = now.toDateString();
  const hour = now.getHours();
  if (
    bridge.closed || hour !== RECYCLE_HOUR ||
    bridge.lastRecycleDay === day ||
    bridge.queueDepth > 0
  ) {
    return false;
  }
  bridge.lastRecycleDay = day;
  if (bridge.sessionOnly && !bridge.browserReady) {
    // The refusal `stopBrowserBridge` makes, for the same reason: no operation
    // has opened this lazy session, and `send` starts the sidecar to deliver
    // whatever it is given — so the recycle would LAUNCH the browser it exists
    // to close. The day is spent either way; a browser that never started is
    // not the weeks-old Chromium this hour is here for.
    return false;
  }
  try {
    await runExclusive(bridge, async () => {
      await bridge.transport.send({
        v: BROWSER_USE_PROTOCOL_VERSION,
        id: randomUUID(),
        op: "shutdown",
        params: {},
      } as BrowserUseRequest);
      // The sidecar took the browser with it (`service.stopped` ends its loop),
      // so a session holder's teardown must find its own guard armed rather
      // than respawn a child only to shut it down again.
      bridge.browserReady = false;
      bridge.shownWindow = null;
    });
    // Never stdout: a session holder shares the MCP process whose stdout is the
    // JSON-RPC channel.
    console.error("[browser-bridge] nightly recycle: browser closed cleanly");
  } catch (error) {
    console.error(
      `[browser-bridge] nightly recycle failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return true;
}

/**
 * Publish (or republish) the discovery file. Never fatal: no file means no
 * remote callers find us — the owner still gets the persistent browser, and
 * other processes fall back to their own sidecars exactly as before the bridge
 * existed. The agent starting is worth more than the file.
 */
function publishBridgeFile(bridge: BridgeState): void {
  try {
    writeBridgeFile({
      protocolVersion: BROWSER_USE_PROTOCOL_VERSION,
      port: bridge.port,
      token: bridge.token,
      pid: process.pid,
      profileDir: browserProfileDir(),
      startedAt: Date.now(),
    }, bridge.discoveryFile);
  } catch (error) {
    console.error(
      `[browser-bridge] could not write the discovery file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Readiness, and only readiness — the four facts both listeners may state.
 *
 * The loopback handler spreads `profileDir` onto this at its own call site,
 * so the private-network payload cannot grow a field by omission: anything
 * this process knows and the network has no business with is ADDED on the one
 * path that may carry it, never filtered out of the other.
 */
function healthPayload(bridge: BridgeState): {
  ok: boolean;
  busy: boolean;
  queueDepth: number;
  protocolVersion: number;
} {
  return {
    ok: bridge.agentReady && !bridge.closed,
    busy: bridge.busy,
    queueDepth: bridge.queueDepth,
    protocolVersion: BROWSER_USE_PROTOCOL_VERSION,
  };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start the bridge: mark this process the owner, build the ONE subprocess
 * transport, listen on loopback, and publish the discovery file. Returns null
 * — degrading to per-process behavior on a local install — when this
 * install's bridge is already up in another process, or no port can be bound.
 * A hosted agent fails startup without its standing holder.
 *
 * The sidecar holds no write gate of its own: this process is the one that may
 * later be granted write authority, and with a persistent sidecar the argv can
 * no longer follow a per-job flag read. The owner's live-writes switch is the
 * one gate — `canEngage` re-reads `writes_enabled` per write, and a driver
 * constructed with it off sends no write request — and the python side still
 * journals every write as CLICKING before its POST.
 */
export async function startBrowserBridge(options?: {
  /** Private, lazy local holder for one MCP process and its drain children. */
  sessionFile?: string;
  /** Test seam only — production always builds the subprocess transport. */
  transport?: () => SubprocessBrowserUseTransport;
  /** Agent DB/scheduler health, exposed only through the private listener. */
  healthProbe?: () => Promise<boolean>;
}): Promise<{
  port: number;
  /** Absent unless the readiness listener was asked for and bound; a test
   *  asking for port 0 reads back what the OS gave it. */
  healthPort?: number;
  close: () => Promise<void>;
} | null> {
  if (state) {
    return {
      port: state.port,
      ...(state.healthPort === undefined ? {} : { healthPort: state.healthPort }),
      close: stopBrowserBridge,
    };
  }
  // The same switch that stops clients routing stops the server serving —
  // one knob, both halves. It is also what keeps a harness-spawned agent
  // (the e2e ready-line suite) from launching a real Chromium.
  if (!options?.sessionFile && !config.browserUse.bridgeEnabled()) return null;
  const buildTransport =
    options?.transport ?? subprocessTransportFactory(Boolean(options?.sessionFile));
  const token = randomBytes(32).toString("base64url");
  const port = options?.sessionFile ? 0 : config.browserUse.bridgePort();

  const bridge: BridgeState = {
    discoveryFile: options?.sessionFile ?? bridgeFilePath(),
    sessionOnly: Boolean(options?.sessionFile),
    transport: buildTransport(),
    standing: null,
    shownWindow: null,
    browserReady: false,
    probedWake: null,
    agentReady: Boolean(options?.sessionFile),
    server: createServer(),
    port,
    healthServer: null,
    healthPort: undefined,
    healthProbe: options?.healthProbe,
    token,
    tail: Promise.resolve(),
    queueDepth: 0,
    busy: false,
    lastActivityAt: Date.now(),
    recycleTimer: setInterval(() => {
      void recycleIfIdle();
    }, RECYCLE_CHECK_MS),
    lastRecycleDay: null,
    closed: false,
  };
  bridge.recycleTimer.unref?.();
  // What `afterWake` asks about: this process has to be watching for a sleep.
  startSuspensionWatch();
  // Long interactive probes (a 90s sign-in wait) must not be cut by Node's
  // default request timeout.
  bridge.server.requestTimeout = 0;

  bridge.server.on("request", (req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ...healthPayload(bridge),
            profileDir: browserProfileDir(),
          }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/browser") {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${bridge.token}`) {
        res.statusCode = 401;
        res.end();
        return;
      }
      let response: BrowserUseResponse;
      let parsedRequest: BrowserUseRequest | null = null;
      try {
        const parsed = BrowserUseRequestSchema.safeParse(
          JSON.parse(await readBody(req)),
        );
        if (!parsed.success) {
          res.statusCode = 400;
          res.end();
          return;
        }
        parsedRequest = parsed.data;
        if (parsedRequest.op === "shutdown") {
          response = protocolError(
            parsedRequest,
            "REMOTE_SHUTDOWN_FORBIDDEN",
            "the bridge's browser outlives its callers; only the owning process shuts it down",
          );
        } else {
          const rawTimeout = Number(req.headers["x-engager-timeout-ms"]);
          const timeoutMs =
            Number.isFinite(rawTimeout) && rawTimeout > 0
              ? Math.floor(rawTimeout)
              : undefined;
          response = await enqueue(
            bridge,
            parsedRequest,
            timeoutMs ? { timeoutMs } : undefined,
          );
        }
      } catch (error) {
        if (!parsedRequest) {
          res.statusCode = 400;
          res.end();
          return;
        }
        response = protocolError(
          parsedRequest,
          "BRIDGE_TRANSPORT",
          error instanceof Error ? error.message : String(error),
        );
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response));
    })();
  });

  const listen = (on: number) =>
    new Promise<boolean>((resolve) => {
      const refused = () => resolve(false);
      bridge.server.once("error", refused);
      bridge.server.listen(on, "127.0.0.1", () => {
        bridge.server.off("error", refused);
        resolve(true);
      });
    });
  // The configured port is a preference, not an address: every caller reads
  // the port out of the discovery file. Held by somebody else's program, it
  // costs nothing to take another. Held by this install's own bridge, it is
  // the one holder there may be, and this process goes without.
  const bound =
    (await listen(port)) ||
    (port !== 0 &&
      (await discoverBridge(fetch, bridge.discoveryFile)) === null &&
      (await listen(0)));
  if (!bound) {
    clearInterval(bridge.recycleTimer);
    await bridge.transport.close().catch(() => undefined);
    console.error(
      `[browser-bridge] could not bind 127.0.0.1:${port} — running without a bridge (per-process sidecars)`,
    );
    return null;
  }
  // Port 0 asks the OS for an ephemeral port (the test suites' isolation);
  // the discovery file always carries the port actually bound.
  const address = bridge.server.address();
  if (address !== null && typeof address === "object") {
    bridge.port = address.port;
  }

  try {
    if (!options?.sessionFile) await startHealthListener(bridge);
  } catch (error) {
    clearInterval(bridge.recycleTimer);
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    await bridge.transport.close().catch(() => undefined);
    throw error;
  }

  state = bridge;
  markLocalBridgeOwner(true, Boolean(options?.sessionFile));
  publishBridgeFile(bridge);
  console.error(`[browser-bridge] serving on 127.0.0.1:${bridge.port}`);
  return {
    port: bridge.port,
    ...(bridge.healthPort === undefined
      ? {}
      : { healthPort: bridge.healthPort }),
    close: stopBrowserBridge,
  };
}

/**
 * The readiness listener, when the container asks for one. Both keys unset —
 * every install that exists today — creates no second server at all, so the
 * loopback bridge is exactly what it was.
 *
 * `GET /health` answers with no `authorization` check because a platform
 * health check sends no bearer; the token is minted for and read by the
 * loopback server alone, and every other method-and-path pair here — `POST
 * /browser` included — gets a bare 404. So reaching the private address buys
 * a caller readiness and nothing else.
 *
 * A local bind failure leaves this optional listener absent. The hosted
 * startup caller requires it before the agent can begin taking work.
 */
async function startHealthListener(bridge: BridgeState): Promise<void> {
  const host = config.browserUse.healthHost();
  const port = config.browserUse.healthPort();
  if (!host || port === undefined) return;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      void (async () => {
        const payload = healthPayload(bridge);
        if (bridge.healthProbe) {
          payload.ok = (await bridge.healthProbe().catch(() => false)) && payload.ok;
        }
        res.statusCode = payload.ok ? 200 : 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
      })();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
  if (!bound) {
    console.error(
      `[browser-bridge] could not bind the health probe on ${host}:${port} — running without one`,
    );
    return;
  }
  bridge.healthServer = server;
  const address = server.address();
  bridge.healthPort =
    address !== null && typeof address === "object" ? address.port : port;
  console.log(
    `[browser-bridge] health probe on ${host}:${bridge.healthPort}`,
  );
}

/**
 * Launch the browser now rather than on the first job — the founder's call:
 * the one launch happens at app start, never mid-day while the owner works,
 * and on the owner's Hidden it is created off every display, so nothing of it
 * reaches the screen. Warming launches the browser without navigating to
 * LinkedIn or reading the account; a connection check or job owns that probe.
 * A launch failure is logged instead of fatal.
 */
export async function eagerBrowserStart(): Promise<boolean> {
  const bridge = state;
  if (!bridge || bridge.closed) return false;
  try {
    const response = await enqueue(bridge, {
      v: BROWSER_USE_PROTOCOL_VERSION,
      id: randomUUID(),
      op: "warm_browser",
      params: {},
    } as BrowserUseRequest, { timeoutMs: 120_000 });
    if (response.ok) console.log("[browser-bridge] browser warmed at startup");
    return response.ok;
  } catch (error) {
    console.error(
      `[browser-bridge] eager browser start failed (first job will retry): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Tear the bridge down: discovery file first (no new callers), then the
 *  sidecar — whose `close()` sends the protocol `shutdown`, the one reliable
 *  way to take Chrome with it. */
export async function stopBrowserBridge(): Promise<void> {
  const bridge = state;
  if (!bridge || bridge.closed) return;
  bridge.closed = true;
  state = null;
  markLocalBridgeOwner(false);
  removeBridgeFile(bridge.discoveryFile);
  clearInterval(bridge.recycleTimer);
  // Kept-alive client connections would hold `close()` open indefinitely —
  // callers reconnect or fall back; nothing graceful is owed a dying bridge.
  bridge.server.closeAllConnections?.();
  await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
  if (bridge.healthServer) {
    const health = bridge.healthServer;
    health.closeAllConnections?.();
    await new Promise<void>((resolve) => health.close(() => resolve()));
  }
  try {
    if (bridge.sessionOnly && !bridge.browserReady) {
      // No operation has opened this lazy session; shutdown must not launch it.
      await bridge.transport.close();
      return;
    }
    await bridge.transport.send(
      {
        v: BROWSER_USE_PROTOCOL_VERSION,
        id: randomUUID(),
        op: "shutdown",
        params: {},
      } as BrowserUseRequest,
      { timeoutMs: 25_000 },
    );
  } catch {
    // A sidecar that never started, or died already, is shut down.
  }
  await bridge.transport.close();
}

/**
 * The production sidecar.
 *
 * It holds the profile for the life of the process, except in a
 * session-only holder: that one is the reluctant holder
 * `ENGAGER_BROWSER_IDLE_RELEASE_MS` exists for (the dashboard's chat child), and
 * it hands the profile back once it has been idle that long, so the agent's
 * standing browser can take it. The agent's own holder never reads the switch.
 */
function subprocessTransportFactory(
  sessionOnly: boolean,
): () => SubprocessBrowserUseTransport {
  return () => {
    const profileDir = config.browserUse.profileDir();
    const browserExecutable = config.browserUse.executable();
    const hidden = config.browserUse.hidden();
    const transport: SubprocessBrowserUseTransport =
      new SubprocessBrowserUseTransport({
        ...(profileDir ? { profileDir } : {}),
        ...(browserExecutable ? { browserExecutable } : {}),
        ...(hidden ? { browserHidden: hidden } : {}),
        env: browserMediaChildEnv(),
        idleReleaseMs: sessionOnly ? config.browserUse.idleReleaseMs() : 0,
        coordinateIdleRelease: async (release) => {
          const bridge = state;
          if (!bridge || bridge.closed || bridge.transport !== transport) return;
          const lastActivityAt = bridge.lastActivityAt;
          await runExclusive(bridge, async () => {
            if (!bridge.closed && bridge.transport === transport && bridge.lastActivityAt === lastActivityAt) await release();
          }, false);
        },
        // A browser handed back is no longer open, and the teardown and the
        // nightly recycle must not start a sidecar only to shut it down again.
        onIdleRelease: () => {
          if (state?.transport === transport) {
            state.browserReady = false;
            state.shownWindow = null;
          }
        },
      });
    return transport;
  };
}
