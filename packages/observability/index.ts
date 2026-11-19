/**
 * `@engager/observability` — server-side error monitoring (Sentry / `@sentry/node`)
 * and product telemetry (PostHog / `posthog-node`) for Engager's non-UI processes
 * (worker, scheduler, MCP, route handlers).
 *
 * Both providers degrade gracefully to a no-op when unconfigured: importing this
 * package never throws, never hits the network, and never requires the optional
 * deps to be installed (they are imported lazily, only on the configured path).
 */
export {
  captureEvent,
  captureException,
  initMonitoring,
  monitoringConfigured,
} from "./monitoring";

export {
  flushTelemetry,
  shutdownAnalytics,
  telemetryEnabled,
  track,
} from "./analytics";

export { hashedId } from "./events";
