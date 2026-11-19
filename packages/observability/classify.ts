/**
 * Free-form facts, turned into the fixed vocabularies the catalog allows.
 *
 * The product explains itself in sentences and codes (`outside_active_hours`,
 * `posting interrupted mid-flight`, a provider's error). Telemetry never carries
 * those: each one is mapped here to a class from a short fixed list, and the
 * original is read and dropped. A reason nobody has mapped is `other`, not a
 * new string. Pure and dependency-free, so any process can use it.
 */

export const REASON_CLASSES = [
  "none",
  "cap",
  "outside_window",
  "stopped",
  "writes_off",
  "authority",
  "not_connected",
  "session_expired",
  "challenge",
  "restricted",
  "rate_limited",
  "ui_drift",
  "read_failed",
  "timeout",
  "network",
  "http_4xx",
  "http_5xx",
  "invitation_not_listed",
  "target_gone",
  "already_done",
  "do_not_engage",
  "composer_blocked",
  "outcome_unknown",
  "agent_failed",
  "entitlement",
  "other",
] as const;

export type ReasonClass = (typeof REASON_CLASSES)[number];

// Order matters: the first rule that matches names the class, so the specific
// ones come before the general ones.
const RULES: ReadonlyArray<readonly [RegExp, ReasonClass]> = [
  [/checkpoint|challenge|captcha|verification_required/i, "challenge"],
  [/account_restricted|restricted/i, "restricted"],
  [/login_required|session_expired|signed_out|not_signed_in|session_lost|session/i, "session_expired"],
  [/not_connected|channel_not_connected|no_session|not_configured/i, "not_connected"],
  [/outside_active|active_hours|active_window|outside_window/i, "outside_window"],
  [/kill_switch|stopped|paused|\bstop\b|campaign_paused|campaign_archived/i, "stopped"],
  [/writes_off|writes_disabled|live_check_pending|operation_unavailable/i, "writes_off"],
  [/authority|epoch|fence|transfer|account_mismatch|account_unverified/i, "authority"],
  [/do_not_engage|opted_out|opt_out/i, "do_not_engage"],
  [/rate.?limit|too_many|throttl|\b429\b/i, "rate_limited"],
  [/\bcap\b|_cap|cap_|limit_reached|daily|per_profile|exposure|min_gap|min_delay/i, "cap"],
  [/invitation_not_listed|not_listed|not_pending|invitation_not/i, "invitation_not_listed"],
  [/already|noop|no_op/i, "already_done"],
  [/not_found|deleted|removed|gone|unavailable_post|target_missing/i, "target_gone"],
  [/composer|human_draft|draft_in_composer/i, "composer_blocked"],
  [/ui_drift|selector|markup|layout|drift|unexpected_page|unexpected_dom/i, "ui_drift"],
  [/timeout|timed.?out|deadline/i, "timeout"],
  [/outcome_unknown|interrupted|mid-?flight|uncertain|unverified/i, "outcome_unknown"],
  [/econn|enotfound|network|socket|fetch failed|offline|connection/i, "network"],
  [/\b5\d\d\b|server error|bad gateway|unavailable/i, "http_5xx"],
  [/\b4\d\d\b|forbidden|unauthori[sz]ed|bad request/i, "http_4xx"],
  [/read_failed|read failed|could not read|parse/i, "read_failed"],
  [/agent|model|llm|schema|json|crash|refus/i, "agent_failed"],
  [/entitlement|subscription|licen[cs]e|paid|spend|budget|credit/i, "entitlement"],
];

/** The class of a reason code or sentence. `none` for no reason at all. */
export function reasonClassOf(raw: unknown): ReasonClass {
  if (raw === null || raw === undefined || raw === "") return "none";
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  for (const [pattern, name] of RULES) if (pattern.test(text)) return name;
  return "other";
}

export const DURATION_BUCKETS = [
  "under_10s",
  "10_30s",
  "30_60s",
  "1_3m",
  "3_10m",
  "over_10m",
] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

/** How long something took, in the buckets the catalog allows. */
export function durationBucket(ms: number): DurationBucket {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return "under_10s";
  if (seconds < 30) return "10_30s";
  if (seconds < 60) return "30_60s";
  if (seconds < 180) return "1_3m";
  if (seconds < 600) return "3_10m";
  return "over_10m";
}

export const HOURS_BUCKETS = [
  "under_1h",
  "1_6h",
  "6_24h",
  "1_3d",
  "3_7d",
  "over_7d",
] as const;
export type HoursBucket = (typeof HOURS_BUCKETS)[number];

/** How long after a send something came back. */
export function hoursBucket(ms: number): HoursBucket {
  const hours = Math.max(0, ms) / 3_600_000;
  if (hours < 1) return "under_1h";
  if (hours < 6) return "1_6h";
  if (hours < 24) return "6_24h";
  if (hours < 72) return "1_3d";
  if (hours < 168) return "3_7d";
  return "over_7d";
}

export const LENGTH_BUCKETS = [
  "under_100",
  "100_300",
  "300_600",
  "600_1200",
  "over_1200",
] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

/** How long a message is, in characters. The length of a text says nothing of it. */
export function lengthBucket(characters: number): LengthBucket {
  if (characters < 100) return "under_100";
  if (characters < 300) return "100_300";
  if (characters < 600) return "300_600";
  if (characters < 1200) return "600_1200";
  return "over_1200";
}

export const RETENTION_BUCKETS = ["none", "0", "1-25", "26-50", "51-75", "76-99", "100"] as const;
export type RetentionBucket = (typeof RETENTION_BUCKETS)[number];

/** How much of an agent draft survived into what the owner sent, in percent.
 *  `none` when there was no draft to keep. */
export function retentionBucket(percent: number | null | undefined): RetentionBucket {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "none";
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  if (value === 0) return "0";
  if (value <= 25) return "1-25";
  if (value <= 50) return "26-50";
  if (value <= 75) return "51-75";
  if (value < 100) return "76-99";
  return "100";
}
