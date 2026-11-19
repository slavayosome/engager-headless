/**
 * BetScore lead-ranker observability (Part A6). Thin, dependency-light counters
 * that BOTH forward to `@engager/observability` (Sentry breadcrumb/event, no-op
 * when unconfigured) AND keep a process-local tally so tests can assert that a
 * fail-open / degraded path actually fired (the kill switch + dashboards must not
 * lie about whether ranking is really running).
 *
 * These are best-effort: recording a metric NEVER throws into the caller's hot
 * path.
 *
 * Kept dependency-light (no `@engager/observability` import) so it can be called
 * from the hot tx path without pulling Sentry/PostHog into `@engager/core`; a
 * configured deployment scrapes these via the structured `[lead_ranker]` log line.
 */
export type RankMetric =
  // Gate 1 (draft admission)
  | "gate1_admit"
  | "gate1_hold_below_floor"
  | "gate1_hold_over_budget"
  | "gate1_requeue" // a held post re-admitted by a later sweep
  | "gate1_degraded" // budget/score error → fail-open admit (FIFO)
  // Gate 2 (post-best-eligible)
  | "gate2_swap" // posted a DIFFERENT (higher-betScore) message than the job's own
  | "gate2_self" // job's own payload message was already the best eligible
  | "gate2_degraded"; // select error → fail-open post the job's own message (FIFO)

const counts: Record<RankMetric, number> = {
  gate1_admit: 0,
  gate1_hold_below_floor: 0,
  gate1_hold_over_budget: 0,
  gate1_requeue: 0,
  gate1_degraded: 0,
  gate2_swap: 0,
  gate2_self: 0,
  gate2_degraded: 0,
};

/** Increment a counter + emit a structured log line. Never throws. */
export function recordRankMetric(metric: RankMetric, extra?: Record<string, unknown>): void {
  counts[metric] += 1;
  try {
    // eslint-disable-next-line no-console
    console.debug(`[lead_ranker] ${metric}`, extra ?? {});
  } catch {
    /* observability is best-effort — never break the pipeline */
  }
}

/** Snapshot of the process-local counters (tests / debugging). */
export function rankMetricsSnapshot(): Record<RankMetric, number> {
  return { ...counts };
}
