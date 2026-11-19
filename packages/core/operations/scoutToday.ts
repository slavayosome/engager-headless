/**
 * Rate model for the finite daily Scout shortlist (founder decision
 * 2026-07-17: fixed rate, no user-facing dial). Admission is paced to
 * `SCOUT_HOURLY_MAX` picks per hour — hourly pacing keeps the pool fresh all day
 * instead of dumping one morning batch — under a hard `SCOUT_TODAY_MAX`
 * ceiling per campaign-local day, which keeps Today a finite curated list
 * rather than another infinite feed.
 *
 * This is a deliberately import-free leaf module so client components can
 * derive customer copy ("up to N picks a day", "up to N fresh picks each
 * hour") from the same constants the cohort fill enforces, without pulling
 * the server-only Scout read model into a browser bundle.
 */
export const SCOUT_HOURLY_MAX = 5;
export const SCOUT_TODAY_MAX = 20;
