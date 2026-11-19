/**
 * Server-side error/event monitoring for Engager (Sentry, via `@sentry/node`).
 *
 * Deliberately Prisma-free, React-free, and `@sentry/nextjs`-free: this runs in
 * the worker / scheduler / MCP / route-handler processes, not the browser. The
 * heavy `@sentry/node` dependency is imported LAZILY (dynamic `import()`) only on
 * the configured path, so importing this module never throws, never touches the
 * network, and works even before `@sentry/node` is installed. When `SENTRY_DSN`
 * is unset everything degrades to a plain `console` no-op.
 */

// Minimal structural view of the bits of `@sentry/node` we touch — avoids a
// type-level dependency on the package (which may not be installed yet).
type SentryLike = {
  init(opts: { dsn: string }): void;
  captureException(error: unknown): string;
  captureMessage(message: string): string;
  addBreadcrumb(breadcrumb: { message: string; data?: Record<string, unknown> }): void;
};

// Module-level guards so init is idempotent and capture paths can stay sync-ish.
let initialized = false;
let initInFlight: Promise<void> | null = null;
let sentry: SentryLike | null = null;

/** True when a Sentry DSN is configured. */
export function monitoringConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

/**
 * Initialize Sentry if `SENTRY_DSN` is set. Idempotent — repeated calls (even
 * concurrent ones) init at most once. No-op (resolves immediately) when unset.
 */
export async function initMonitoring(): Promise<void> {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // no-op: not configured
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    const mod = (await import("@sentry/node")) as unknown as SentryLike;
    mod.init({ dsn });
    sentry = mod;
    initialized = true;
  })();

  try {
    await initInFlight;
  } finally {
    initInFlight = null;
  }
}

/**
 * Report an error. Forwards to Sentry when initialized; otherwise logs to
 * `console.error`. Never throws.
 */
export function captureException(error: unknown): void {
  if (initialized && sentry) {
    sentry.captureException(error);
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[observability] captureException:", error);
}

/**
 * Record a named event. When Sentry is initialized, emits a message plus a
 * breadcrumb carrying `extra`; otherwise logs to `console.debug`. Never throws.
 */
export function captureEvent(name: string, extra?: Record<string, unknown>): void {
  if (initialized && sentry) {
    sentry.addBreadcrumb({ message: name, data: extra });
    sentry.captureMessage(name);
    return;
  }
  // eslint-disable-next-line no-console
  console.debug("[observability] event:", name, extra ?? {});
}
