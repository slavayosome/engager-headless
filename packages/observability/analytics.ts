/**
 * Server-side product telemetry for Engager (PostHog, via `posthog-node`).
 *
 * A local install sends anonymous product telemetry to Engager's relay,
 * disclosed in the Terms and Privacy Policy; it makes no other provider call
 * without the owner's selection. (INV-19: telemetry is mandatory, so there is
 * no opt-in and no owner-facing off switch. The operator's `ENGAGER_TELEMETRY=off`
 * and the `test` environment exist for CI and development only.)
 *
 * Server-only: no `posthog-js`, no React, no session replay, no surveys. What
 * an event may carry is decided in `events.ts`; this module is the pipe.
 *
 *   track(event, properties)  validates against the catalog, applies the
 *                             event's daily cap, and enqueues. Synchronous,
 *                             never throws, never awaits the network.
 *   flushTelemetry()          sends the queue as one batch. Runs every 30 s or
 *                             at 50 events, and on exit. A failed flush drops
 *                             its batch, and one that never answers is given up
 *                             on: telemetry never blocks or fails a product
 *                             path.
 *   shutdownAnalytics()       the exit flush, bounded to a moment: a relay that
 *                             never answers cannot hold a process open.
 *
 * The subject of every event is the anonymous per-install id
 * (`readInstallId()`), never a caller-supplied id, and it is read at flush
 * time, so an install that never emits never writes it.
 *
 * Transport selection (INV-19) is an ALLOWLIST, read from
 * `ENGAGER_DEPLOYMENT_ENV` as a plain string: only `"dev"` and `"prod"` take
 * the direct `posthog-node` client below. `"local"`, `"test"`, `"cloud"`, an
 * unset variable, and anything unrecognised all take the relay — a local
 * install ships no provider key, so its only legal destination is the cloud
 * route (`relay.ts`), never the PostHog host directly. An allowlist rather
 * than a `"local"` blacklist so an unset or mistyped variable fails CLOSED
 * (toward the relay). Deliberately NOT imported from
 * `packages/database/environment.ts`: reading the value as a plain string keeps
 * this module's graph clear of `@engager/database`.
 */
import { randomBytes } from "node:crypto";
import { resolveTelemetryContext } from "./context";
import {
  CONTEXT_SCHEMA,
  EVENTS,
  EVENT_NAMES,
  isServiceEvent,
  type InstallEventName,
  type ServiceEventName,
  type TelemetryEventName,
  type TelemetryProps,
} from "./events";
import { readInstallId } from "./installId";
import { relayBatch, type WireEvent } from "./relay";

// Minimal structural view of the `posthog-node` client we use.
type PostHogLike = {
  capture(args: {
    event: string;
    distinctId: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
    timestamp?: Date;
    disableGeoip?: boolean;
  }): void;
  on(event: "error", listener: (error: unknown) => void): () => void;
  shutdown(shutdownTimeoutMs?: number): Promise<void>;
};

type PostHogCtor = new (
  key: string,
  opts: {
    host?: string;
    flushAt?: number;
    flushInterval?: number;
    fetchRetryCount?: number;
    disableGeoip?: boolean;
  },
) => PostHogLike;

export type TelemetryTransport = (batch: {
  installId: string;
  events: WireEvent[];
}) => Promise<void>;

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_AT = 50;
// A bound on memory when the network is down for hours: the oldest events go.
const MAX_QUEUE = 500;
// One flush never outlives this, whatever the transport does: a black-holed
// relay holds a request open for its own 10 s timeout per batch, and a stuck
// flush would otherwise block the next one (`flushTelemetry` waits on it).
const FLUSH_TIMEOUT_MS = 12_000;
// How long a process on its way out waits for its last events. Telemetry is
// worth a moment at exit, never a stall.
const SHUTDOWN_BUDGET_MS = 1_500;
// How long one direct send waits for PostHog before it gives the batch up.
// Inside FLUSH_TIMEOUT_MS so `within` never has to cut a send short.
const DIRECT_SEND_TIMEOUT_MS = 10_000;
// How far back / forward the relay will believe an event's own clock.
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_EVENT_FUTURE_MS = 60 * 60_000;

type Queued = {
  event: TelemetryEventName;
  properties: Record<string, unknown>;
  timestamp: string;
};

let transportOverride: TelemetryTransport | null = null;
let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let exitHookInstalled = false;

let dayKey = "";
let sentToday = new Map<string, number>();
let droppedToday = new Map<string, number>();
let reportedDropsToday = new Set<string>();

function posthogKey(): string | undefined {
  return process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
}

/** Engager's PostHog project lives in the EU region; `POSTHOG_HOST` overrides. */
export const POSTHOG_INGESTION_HOST = "https://eu.i.posthog.com";

function posthogHost(): string {
  return (
    process.env.POSTHOG_HOST ??
    process.env.NEXT_PUBLIC_POSTHOG_HOST ??
    POSTHOG_INGESTION_HOST
  );
}

// The only two values that reach a provider directly. Everything else —
// "local", "test", "cloud", unset, and any unrecognised spelling — takes the
// relay. See the module doc for why this is an allowlist and not a "local"
// check.
const DIRECT_CLIENT_DEPLOYMENT_ENVIRONMENTS = new Set(["dev", "prod"]);

export function usesDirectClient(): boolean {
  return DIRECT_CLIENT_DEPLOYMENT_ENVIRONMENTS.has(process.env.ENGAGER_DEPLOYMENT_ENV ?? "");
}

/**
 * Whether this process sends telemetry. On for every placement. Off only for
 * the operator: `ENGAGER_TELEMETRY=off` (CI, development, a bench), and by
 * default in the `test` deployment environment so unit tests never emit.
 * `ENGAGER_TELEMETRY=on` forces it back on under `test` for the suites that
 * exercise the pipe itself. Nothing in the product sets either value; there is
 * no owner-facing switch (INV-19).
 */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const switchValue = (env.ENGAGER_TELEMETRY ?? "").trim().toLowerCase();
  if (switchValue === "off") return false;
  if (switchValue === "on") return true;
  return (env.ENGAGER_DEPLOYMENT_ENV ?? "") !== "test";
}

/** How one direct send ended. Everything but `sent` is a batch that never
 * reached PostHog, named so the relay can say why (`RelayReport`). */
type DirectOutcome =
  | "sent"
  | "no_direct_client"
  | "no_key"
  | "client_import_failed"
  | "send_failed";

/**
 * Send one batch to PostHog from this process. The only place an event
 * reaches the provider: `flushTelemetry()` on the hosted app itself, and the
 * relay route for everyone else's. Never throws.
 *
 * One short-lived client per batch, closed with `shutdown()`, never `flush()`:
 * `posthog-node`'s `capture()` only enqueues once a few promise ticks have
 * run, so a `flush()` straight after it reads an empty queue and sends
 * nothing, and with the client's own timer off the events would sit there
 * until the process died. `shutdown()` waits for those pending captures and
 * then flushes, which is the pattern PostHog documents for serverless
 * functions, where a request that returns before its events leave loses them.
 *
 * Checked before the key is even read: a "somehow present" key on a
 * relay-branch deployment environment must not buy its way to a direct client
 * (INV-19).
 */
async function sendDirect(installId: string, events: WireEvent[]): Promise<DirectOutcome> {
  if (!usesDirectClient()) return "no_direct_client";
  const key = posthogKey();
  if (!key) return "no_key"; // not configured
  let PostHog: PostHogCtor;
  try {
    PostHog = ((await import("posthog-node")) as unknown as { PostHog: PostHogCtor }).PostHog;
  } catch {
    return "client_import_failed";
  }
  try {
    // The send is explicit and a failed one drops its batch, so the client's
    // own timer and retries stay off.
    const ph = new PostHog(key, {
      host: posthogHost(),
      flushAt: 1_000,
      flushInterval: 0,
      fetchRetryCount: 0,
      disableGeoip: true,
    });
    // `shutdown()` swallows a failed flush, so the client's error event is the
    // only place a rejected batch shows.
    let failed = false;
    ph.on("error", () => {
      failed = true;
    });
    for (const wire of events) {
      ph.capture({
        event: wire.event,
        distinctId: installId,
        properties: { ...wire.properties, ...wire.context },
        ...(wire.groups ? { groups: wire.groups } : {}),
        timestamp: new Date(wire.timestamp),
        disableGeoip: true,
      });
    }
    await ph.shutdown(DIRECT_SEND_TIMEOUT_MS);
    return failed ? "send_failed" : "sent";
  } catch {
    return "send_failed";
  }
}

async function sendBatch(installId: string, events: WireEvent[]): Promise<void> {
  if (transportOverride) return transportOverride({ installId, events });
  if (usesDirectClient()) {
    await sendDirect(installId, events);
    return;
  }
  return relayBatch({ installId, events });
}

function rollDay(now: number): void {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today === dayKey) return;
  dayKey = today;
  sentToday = new Map();
  droppedToday = new Map();
  reportedDropsToday = new Set();
}

function enqueue(item: Queued): void {
  queue.push(item);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("beforeExit", () => {
      if (queue.length > 0) void flushTelemetry();
    });
  }
  if (queue.length >= FLUSH_AT) {
    void flushTelemetry();
    return;
  }
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      void flushTelemetry();
    }, FLUSH_INTERVAL_MS);
    // A pending flush must never keep a short-lived process alive.
    timer.unref?.();
  }
}

/** Count a dropped event and, once a day per event and reason, say so. */
function drop(event: TelemetryEventName, reason: "invalid" | "daily_cap", now: number): void {
  const key = `${event}:${reason}`;
  droppedToday.set(key, (droppedToday.get(key) ?? 0) + 1);
  // The report itself is never reported: that would be a loop.
  if (event === "telemetry_dropped" || reportedDropsToday.has(key)) return;
  reportedDropsToday.add(key);
  enqueue({
    event: "telemetry_dropped",
    properties: { event, reason },
    timestamp: new Date(now).toISOString(),
  });
}

/**
 * Track a catalog event. No-op when telemetry is off. The event must be in
 * `events.ts`, enforced by the type, and its properties must satisfy that
 * event's strict schema, enforced here at runtime: an invalid event is dropped
 * and counted, never sent. Beyond `maxPerInstallPerDay` the event is dropped
 * too, with one `telemetry_dropped` a day to say so. Never throws, never
 * awaits the network — call it from anywhere, including inside a transaction.
 *
 * The PostHog `org` group comes from the registered context (`context.ts`),
 * hashed there; the org id itself never leaves the process.
 */
export function track<E extends InstallEventName>(
  event: E,
  properties: TelemetryProps<E>,
): void {
  try {
    if (!telemetryEnabled()) return;
    const now = Date.now();
    rollDay(now);
    const definition = EVENTS[event];
    if (!definition || isServiceEvent(event)) return;
    const parsed = definition.properties.safeParse(properties);
    if (!parsed.success) {
      drop(event, "invalid", now);
      return;
    }
    const sent = sentToday.get(event) ?? 0;
    if (sent >= definition.maxPerInstallPerDay) {
      drop(event, "daily_cap", now);
      return;
    }
    sentToday.set(event, sent + 1);
    enqueue({
      event,
      properties: parsed.data,
      timestamp: new Date(now).toISOString(),
    });
  } catch {
    // Telemetry must never break a product path.
  }
}

/** Resolve when `work` does, or after `ms`, whichever is first. `work` is left
 * running when the clock wins; its late failure is swallowed. */
async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), clock]);
  } finally {
    clearTimeout(timeout);
  }
}

async function doFlush(): Promise<void> {
  const batch = queue;
  queue = [];
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    const installId = readInstallId();
    if (installId === null) return; // no anonymous subject to send as
    const { context, groups } = await resolveTelemetryContext();
    const events: WireEvent[] = batch.map((item) => ({
      event: item.event,
      properties: item.properties,
      context,
      ...(groups ? { groups } : {}),
      timestamp: item.timestamp,
    }));
    await within(FLUSH_TIMEOUT_MS, sendBatch(installId, events));
  } catch {
    // A failed flush drops its batch.
  }
}

/** Send everything queued, now. Safe to call anytime; resolves when the batch
 * has been handed over or dropped. */
export async function flushTelemetry(): Promise<void> {
  if (flushing) await flushing;
  if (queue.length === 0) return;
  flushing = doFlush().finally(() => {
    flushing = null;
  });
  await flushing;
}

/** Why a relayed event did not reach PostHog. The first four are the relay
 * refusing the event itself (the second wall); the rest are the whole batch
 * going nowhere, and the route adds `install_budget` when an install is past
 * its day. */
export const RELAY_DROP_REASONS = [
  "unknown_event",
  "bad_properties",
  "bad_context",
  "stale",
  "disabled",
  "no_direct_client",
  "no_key",
  "client_import_failed",
  "send_failed",
  "install_budget",
] as const;
export type RelayDropReason = (typeof RELAY_DROP_REASONS)[number];

/** What became of one relayed batch, as counts only: nothing here can carry a
 * property, an install id or an address, so the route may log it whole. */
export type RelayReport = {
  received: number;
  accepted: number;
  dropped: Partial<Record<RelayDropReason, number>>;
};

/**
 * Validate a batch that arrived over the relay and forward what survives. The
 * relay is the second wall: it trusts nothing a client sent, so each event is
 * re-parsed against the catalog and the context schema, and only the parsed
 * output is forwarded — an `$ip`, an unknown property or a made-up event
 * cannot ride through. Forwards only from a deployment that holds the key
 * (`dev`/`prod`); anywhere else it drops. Never throws, and says what it did
 * with every event it was handed.
 */
export async function acceptRelayedBatch(opts: {
  installId: string;
  events: readonly unknown[];
  now?: number;
}): Promise<RelayReport> {
  const now = opts.now ?? Date.now();
  const report: RelayReport = { received: opts.events.length, accepted: 0, dropped: {} };
  const drop = (reason: RelayDropReason, count = 1): void => {
    report.dropped[reason] = (report.dropped[reason] ?? 0) + count;
  };
  const valid: WireEvent[] = [];
  for (const raw of opts.events) {
    if (typeof raw !== "object" || raw === null) {
      drop("unknown_event");
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const name = candidate.event;
    if (
      typeof name !== "string" ||
      !(EVENT_NAMES as readonly string[]).includes(name) ||
      // An install has no business saying what only the service sees.
      isServiceEvent(name as TelemetryEventName)
    ) {
      drop("unknown_event");
      continue;
    }
    const definition = EVENTS[name as TelemetryEventName];
    const properties = definition.properties.safeParse(candidate.properties ?? {});
    if (!properties.success) {
      drop("bad_properties");
      continue;
    }
    const context = CONTEXT_SCHEMA.safeParse(candidate.context);
    if (!context.success) {
      drop("bad_context");
      continue;
    }
    const at = typeof candidate.timestamp === "string" ? Date.parse(candidate.timestamp) : NaN;
    if (!Number.isFinite(at) || at < now - MAX_EVENT_AGE_MS || at > now + MAX_EVENT_FUTURE_MS) {
      drop("stale");
      continue;
    }
    const org = (candidate.groups as { org?: unknown } | undefined)?.org;
    valid.push({
      event: name,
      properties: properties.data,
      context: context.data,
      ...(typeof org === "string" && /^[0-9a-f]{16}$/.test(org) ? { groups: { org } } : {}),
      timestamp: new Date(at).toISOString(),
    });
  }
  if (valid.length === 0) return report;
  if (!telemetryEnabled()) {
    drop("disabled", valid.length);
    return report;
  }
  const outcome = await deliver(opts.installId, valid);
  if (outcome === "sent") report.accepted = valid.length;
  else drop(outcome, valid.length);
  return report;
}

/** Hand validated events to PostHog from a deployment that holds the key. */
async function deliver(subject: string, events: WireEvent[]): Promise<DirectOutcome> {
  try {
    if (transportOverride) {
      await transportOverride({ installId: subject, events });
      return "sent";
    }
    return await sendDirect(subject, events);
  } catch {
    return "send_failed";
  }
}

/**
 * Report something Engager's own service saw with no install behind it: its
 * download link followed. The subject is a random id made for this one event,
 * so it counts and joins to nothing, and the context says `service` where an
 * install's would say where it runs. Sends only from a deployment that holds
 * the key, like the relay. Resolves once the event has left or been dropped,
 * with whether it left, so the caller can say when a count goes nowhere; never
 * throws.
 */
export async function reportServiceEvent<E extends ServiceEventName>(
  event: E,
  properties: TelemetryProps<E>,
): Promise<boolean> {
  try {
    if (!telemetryEnabled()) return false;
    const parsed = EVENTS[event].properties.safeParse(properties);
    if (!parsed.success) return false;
    const { context } = await resolveTelemetryContext();
    const outcome = await deliver(randomBytes(16).toString("hex"), [
      {
        event,
        properties: parsed.data,
        context: { ...context, placement: "service", plan: "unknown", install_age_days: 0 },
        timestamp: new Date().toISOString(),
      },
    ]);
    return outcome === "sent";
  } catch {
    // A download is never held up or failed by its own count.
    return false;
  }
}

/** What this process has dropped today, by `event:reason`. For tests and
 * `engager doctor`-style diagnostics; never sent. */
export function telemetryDropCounts(): Record<string, number> {
  return Object.fromEntries(droppedToday);
}

/** Test seam: replace the wire. A fake transport is how every suite asserts
 * what would have been sent, so no test ever reaches PostHog. */
export function setTelemetryTransport(transport: TelemetryTransport | null): void {
  transportOverride = transport;
}

/** Test seam: forget the queue, a flush still in flight, the daily counters and
 * the timer. */
export function resetTelemetryForTests(): void {
  queue = [];
  flushing = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  dayKey = "";
  sentToday = new Map();
  droppedToday = new Map();
  reportedDropsToday = new Set();
}

/**
 * Send what is queued, for at most `budgetMs`: a relay that never answers
 * cannot hold a process open. What has not left by then is dropped. Safe (and a
 * no-op) to call when telemetry is off or was never used. Never throws.
 */
export async function shutdownAnalytics(budgetMs: number = SHUTDOWN_BUDGET_MS): Promise<void> {
  await within(budgetMs, flushTelemetry());
}
