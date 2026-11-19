/**
 * The telemetry catalog: every event an install may send, declared once with
 * the question it answers, its properties and its daily volume. `track()`
 * (analytics.ts) accepts nothing else, the cloud relay re-validates against it,
 * and `docs/generated/telemetry.md` (and the Usage data page in Settings) are
 * rendered from it, so the privacy page cannot say anything the code does not
 * do.
 *
 * A property is an enum, a number, a boolean, a `version` string or a
 * `hashedId`. There is no other kind of string: an event cannot carry a post,
 * a name, a URL, a keyword or a message because no schema here has a place to
 * put one. `events.test.ts` fails on any other `z.string()`.
 *
 * Adding an event: answer one of the six questions below, declare it here, add
 * its name to EVENT_NAMES, run `npm run docs:generate`. An event that answers
 * none of them is not added.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DURATION_BUCKETS,
  HOURS_BUCKETS,
  LENGTH_BUCKETS,
  REASON_CLASSES,
  RETENTION_BUCKETS,
} from "./classify";
import { ERROR_NAMES } from "./errorNames";
import { UI_ACTIONS } from "./uiActions";
import { DASHBOARD_ROUTES } from "./routes";

export const TELEMETRY_QUESTIONS = {
  Q1: "Activation: do new installs reach their first confirmed send, where do they drop, and how long does it take?",
  Q2: "Core loop: does Scout find conversations worth joining, and does the owner join them, in their own words or from an agent draft?",
  Q3: "Outcomes: does joining conversations bring engagement back? The north star is people who came back per active install per week.",
  Q4: "Reliability: where do LinkedIn reads and writes, workers and the owner's agent break, how often, and on which version?",
  Q5: "Safety: do caps, Stop and pacing protect accounts, how many owners trust Automatic, and does any account see restriction signals?",
  Q6: "Retention and usage: who comes back each week, which surfaces they use, and how fast versions are adopted.",
} as const;

export type TelemetryQuestion = keyof typeof TELEMETRY_QUESTIONS;

/** What no event ever carries. Rendered into the generated page verbatim. */
export const NEVER_COLLECTED = [
  "post, comment, reply, DM, draft, angle or brief text",
  "names, headlines, LinkedIn URLs, urns or vanity slugs",
  "search keywords, campaign or product names, emails, file paths",
  "IP addresses in any event (the relay sees the address a request comes from only to rate-limit it, keeps a keyed hash of it and forwards none; PostHog never receives it)",
  "free-form error messages",
] as const;

/** What the cloud relay admits from one install in a day
 * (`TELEMETRY_INSTALL_DAILY_EVENTS` in apps/cloud/lib/auth/publicRateLimit.ts, which
 * observability cannot import; the relay route's test pins the two equal). The
 * per-event daily caps below are per process, so this is the only bound on the
 * install as a whole. */
export const RELAY_EVENTS_PER_INSTALL_PER_DAY = 2_000;

const HASHED_ID_PATTERN = /^[0-9a-f]{16}$/;
// Digits, and a prerelease only from the tags a release can carry: the suffix
// cannot hold free text.
const VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-(?:alpha|beta|rc)\.[0-9]{1,3})?$/;

/** sha256, first 16 hex characters. One-way: it lets two events be told apart
 * (the same error twice, the same org) and tells nobody what they were about. */
export function hashedId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The two string shapes a property may take. Held by identity: the schema test
 * compares against these exact objects, so a look-alike regex cannot pass. */
export const versionProperty = z.string().regex(VERSION_PATTERN);
export const hashedIdProperty = z.string().regex(HASHED_ID_PATTERN);
/** Context only: the commit a build was cut from. A git hash names a revision of
 * this repository, not a person; event properties cannot use it. */
const commitProperty = z.string().regex(/^(?:[0-9a-f]{7,40}|unknown)$/);
const countProperty = z.number().int().min(0).max(1_000_000);
const flagProperty = z.boolean();

export const PLACEMENTS = ["mac", "checkout", "hosted"] as const;
/** Where an event came from: an install's placement, or `service` for one
 * Engager's own service saw with no install behind it (SERVICE_EVENT_NAMES). */
export const CONTEXT_PLACEMENTS = [...PLACEMENTS, "service"] as const;
export const DEPLOYMENT_ENVS = ["local", "test", "dev", "prod", "cloud"] as const;
/** `unknown` is a Mac process that cannot read its own plan (the free MCP
 * server) with no fresh hint from one that can. */
export const PLANS = ["free", "trial", "paid", "hosted", "unknown"] as const;
export const AGENT_ADAPTERS = ["claude", "codex", "gemini", "opencode"] as const;
export const OS_MAJORS = [
  "linux",
  "windows",
  "other",
  "macos-11", "macos-12", "macos-13", "macos-14", "macos-15", "macos-16", "macos-17",
  "macos-18", "macos-19", "macos-20", "macos-21", "macos-22", "macos-23", "macos-24",
  "macos-25", "macos-26", "macos-27", "macos-28", "macos-29", "macos-30", "macos-31",
  "macos-32", "macos-33", "macos-34", "macos-35", "macos-36", "macos-37", "macos-38",
  "macos-39", "macos-40",
] as const;

/** Context every event carries, validated by the relay with the same schema. */
export const CONTEXT_SCHEMA = z
  .object({
    app_version: versionProperty,
    build_sha: commitProperty,
    placement: z.enum(CONTEXT_PLACEMENTS),
    deployment_env: z.enum(DEPLOYMENT_ENVS),
    os_major: z.enum(OS_MAJORS),
    plan: z.enum(PLANS),
    agent_adapter: z.enum([...AGENT_ADAPTERS, "none"]),
    install_age_days: countProperty,
  })
  .strict();
export type TelemetryContext = z.infer<typeof CONTEXT_SCHEMA>;

/** The stored mode keys a campaign sets an action's mode on. Spelled again from
 * packages/core/strategy/catalog.ts (observability cannot import core); a
 * core test pins the two copies equal. */
export const MODE_KEYS = [
  "publish_comment",
  "public_reply",
  "room_reply",
  "like_target",
  "invite",
  "accept_invite",
  "dm",
  "followup",
] as const;
/** What an action is set to. The product's "Ask me" is stored as `review`. */
export const MODE_NAMES = ["off", "ask", "auto"] as const;

type ModeCountKey = `${(typeof MODE_KEYS)[number]}_${(typeof MODE_NAMES)[number]}`;
const modeCounts = Object.fromEntries(
  MODE_KEYS.flatMap((key) => MODE_NAMES.map((mode) => [`${key}_${mode}`, countProperty])),
) as Record<ModeCountKey, typeof countProperty>;

/** A daily cap, bucketed: the number says how careful an owner is, not who. */
export const CAP_BUCKETS = ["default", "0", "1-5", "6-10", "11-20", "21-40", "41+"] as const;

export const LINKEDIN_SESSIONS = ["connected", "expired", "challenge", "restricted", "none"] as const;

export const DASHBOARD_ERROR_KINDS = ["render", "script", "promise", "action", "fetch"] as const;

export const ONBOARDING_STEPS = ["linkedin", "product", "campaign", "done"] as const;

/** Set up Engager on a Mac, before the agent's first start: the window opened
 * on a Mac that had never been set up, and every This Mac row was done. */
export const SETUP_STAGES = ["opened", "machine_ready"] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];

/** What an owner can send, in the vocabulary the catalog counts. */
export const SEND_KINDS = [
  "comment",
  "reply",
  "room_reply",
  "like_post",
  "like_reply",
  "invite",
  "accept",
  "ignore",
  "dm",
  "withdraw",
] as const;

/** The job types the worker runs, spelled again from the `jobs.type` enum in
 * packages/database/schema.ts (observability cannot import the database); a
 * core test pins the two copies equal. */
export const JOB_TYPES = [
  "reconcile_message_write",
  "poll_incoming",
  "process_incoming",
  "monitor_engagement",
  "distill",
  "search_lookalike",
  "refresh_brain",
  "compile_campaign",
  "ingest_product",
  "notify_lead",
  "check_stale_leads",
  "forget_spotted",
  "install_active",
  "seed_brain",
  "recalibrate_voice",
  "reconcile_trial_renewal",
  "worker_run",
  "activate_strategy",
  "agent_step_timeout",
  "dispatch_actions",
  "invitation_watch",
  "redraft_for_voice",
  "redraft_comments",
  "redraft_room_reply",
  "redraft_action",
  "live_check_read",
  "reproject_campaigns",
  "inbox_check",
  "withdrawal_read",
  "owner_invite_member",
  "relearn_voice_description",
  "file_bug_report",
  "invite_note_check",
  "lead_lifecycle",
  "research_signals",
  "lead_screen",
  "lead_judge",
] as const;

/** A worker run's phases (`worker_runs.phase`). */
export const RUN_PHASES = [
  "discover",
  "triage",
  "verify",
  "draft",
  "publish",
  "converse",
  "sweep",
  "screen",
  "research",
  "qualify",
  "serve",
  "done",
] as const;

/** What an agent call was for. `other` is a call site nobody has named yet. */
export const AGENT_PURPOSES = ["triage", "draft", "research", "chat", "brain", "ingest", "report", "other"] as const;

/** What a draft or a decision is for. */
export const DRAFT_FOR = ["comment", "reply", "room_reply", "dm", "invite_note"] as const;

/** A campaign's search depth, spelled again from `SEARCH_DEPTHS` in
 * packages/database/schema.ts (observability cannot import the database); a
 * core test pins the two copies equal. */
export const SEARCH_DEPTHS = ["quick", "standard", "deep"] as const;

/** The longest wait a first-result timing reports, in milliseconds: thirty
 * days. A sender clamps to it, so a campaign first started a month after it
 * was created still reports rather than failing validation. */
export const MAX_MS_SINCE_CREATE = 30 * 24 * 60 * 60 * 1_000;
const msSinceCreateProperty = z.number().int().min(0).max(MAX_MS_SINCE_CREATE);

/** What a person's own words show, as the lead funnel counts it: Scout's
 *  intents (`SCOUT_INTENTS` in packages/database/schema.ts) in short, and
 *  `none` for a Signal no qualify call has judged. */
export const FUNNEL_INTENTS = ["asking", "problem", "topic", "none"] as const;
/** How well a person fits (`LEAD_FITS`), and `unchecked` for one no fit check
 *  has judged. */
export const FUNNEL_FITS = ["strong", "fits", "weak", "unchecked"] as const;

export const EVENT_NAMES = [
  "telemetry_dropped",
  "install_started",
  "onboarding_step_completed",
  "agent_connected",
  "linkedin_connected",
  "campaign_created",
  "campaign_started",
  "scout_run_finished",
  "room_read",
  "lookalike_proposed",
  "room_people_spotted",
  "search_intent_yield",
  "audience_theme_kept",
  "spotted_forgotten",
  "inbox_item_opened",
  "draft_requested",
  "draft_delivered",
  "message_decided",
  "send_settled",
  "engagement_received",
  "linkedin_read_failed",
  "linkedin_session_changed",
  "worker_run_failed",
  "agent_call_failed",
  "job_failed",
  "cap_reached",
  "stop_changed",
  "mode_changed",
  "restriction_signal",
  "page_viewed",
  "ui_action",
  "install_active",
  "app_updated",
  "dashboard_error",
  "server_error",
  "campaign_depth_set",
  "first_match_visible",
  "first_draft_ready",
  "first_look_finished",
  "reply_dismissed",
  "invite_note_checked",
  "lead_served",
  "lead_rated",
  "signal_researched",
  "lead_contacted",
  "relationship_started",
  "inbox_person_read",
  "scout_step_switched",
  "setup_stage_reached",
  "account_signed_in",
  "plan_started",
  "dmg_download_started",
] as const;
export type TelemetryEventName = (typeof EVENT_NAMES)[number];

/** Events Engager's own service sends, with no install behind them. No install
 * may send one: `track()` does not take them and the relay refuses them. */
export const SERVICE_EVENT_NAMES = ["dmg_download_started"] as const satisfies readonly TelemetryEventName[];
export type ServiceEventName = (typeof SERVICE_EVENT_NAMES)[number];
export type InstallEventName = Exclude<TelemetryEventName, ServiceEventName>;

export function isServiceEvent(name: TelemetryEventName): name is ServiceEventName {
  return (SERVICE_EVENT_NAMES as readonly string[]).includes(name);
}

type EventDefinition<Shape extends z.ZodRawShape> = {
  questions: readonly TelemetryQuestion[];
  description: string;
  maxPerInstallPerDay: number;
  properties: z.ZodObject<Shape, "strict">;
};

function event<Shape extends z.ZodRawShape>(
  definition: Omit<EventDefinition<Shape>, "properties"> & { properties: Shape },
): EventDefinition<Shape> {
  return { ...definition, properties: z.object(definition.properties).strict() };
}

export const EVENTS = {
  telemetry_dropped: event({
    questions: ["Q4"],
    description:
      "An event was dropped on this install, at most once a day per event. The volume itself is the signal.",
    // One report per event and reason, per day.
    maxPerInstallPerDay: EVENT_NAMES.length * 2,
    properties: {
      event: z.enum(EVENT_NAMES),
      reason: z.enum(["invalid", "daily_cap"]),
    },
  }),
  install_started: event({
    questions: ["Q1"],
    description:
      "The first start of a new install, once. The top of the activation funnel.",
    maxPerInstallPerDay: 1,
    properties: { placement: z.enum(PLACEMENTS) },
  }),
  onboarding_step_completed: event({
    questions: ["Q1"],
    description: "The owner finished a step of setup: LinkedIn, product, campaign, or setup as a whole.",
    maxPerInstallPerDay: 10,
    properties: { step: z.enum(ONBOARDING_STEPS) },
  }),
  agent_connected: event({
    questions: ["Q1", "Q4"],
    description:
      "The owner tried to connect their agent (Claude, Codex, Gemini or OpenCode) and how it ended.",
    maxPerInstallPerDay: 20,
    properties: {
      adapter: z.enum([...AGENT_ADAPTERS, "unknown"]),
      outcome: z.enum(["ok", "not_found", "auth_failed", "refused"]),
    },
  }),
  linkedin_connected: event({
    questions: ["Q1", "Q4"],
    description:
      "The LinkedIn account became connected, or the owner's attempt to sign in did not get there (a failure, or a security checkpoint).",
    maxPerInstallPerDay: 20,
    properties: { outcome: z.enum(["connected", "failed", "challenge"]) },
  }),
  campaign_created: event({
    questions: ["Q1", "Q2"],
    description:
      "A campaign was created, where from (setup, the form, the chat or a copy) and at which search depth.",
    maxPerInstallPerDay: 50,
    properties: {
      source: z.enum(["onboarding", "form", "chat", "duplicate"]),
      depth: z.enum(SEARCH_DEPTHS),
    },
  }),
  campaign_started: event({
    questions: ["Q1", "Q2"],
    description:
      "A campaign was started for the first time: how many steps it has and whether it likes, invites or messages.",
    maxPerInstallPerDay: 50,
    properties: {
      steps_count: countProperty,
      has_like: flagProperty,
      has_invite: flagProperty,
      has_dm: flagProperty,
    },
  }),
  scout_run_finished: event({
    questions: ["Q1", "Q2"],
    description:
      "One Scout run ended: how many posts it read, how many matched and were rejected, how many searches were active and how long it took. One event per run, never per post. The first run that matched anything also says it was the install's first.",
    maxPerInstallPerDay: 100,
    properties: {
      trigger: z.enum(["manual", "scheduled"]),
      outcome: z.enum(["ok", "partial", "failed"]),
      posts_read: countProperty,
      matched: countProperty,
      rejected: countProperty,
      searches_active: countProperty,
      duration_bucket: z.enum(DURATION_BUCKETS),
      first_of_install: flagProperty.optional(),
      seconds_since_install: countProperty.optional(),
    },
  }),
  lookalike_proposed: event({
    questions: ["Q2"],
    description: "One requested room read settled with bounded search suggestions. Counts only; nothing was added by this event.",
    maxPerInstallPerDay: 200,
    properties: { adds: z.number().int().min(0).max(4) },
  }),
  room_read: event({
    questions: ["Q2"],
    description: "One room judgment committed. Distinct people reviewed, fits and maybes, the reason to join and pages read. No identity or content.",
    maxPerInstallPerDay: 200,
    properties: {
      judged: countProperty,
      fits: countProperty,
      maybe: countProperty,
      lens: z.enum(["none", "author", "room", "both", "author_maybe"]),
      pages: z.number().int().min(1).max(2),
    },
  }),
  room_people_spotted: event({
    questions: ["Q2"],
    description: "Distinct matching people observed by a Scout run. Count only; no identity or content.",
    maxPerInstallPerDay: 200,
    properties: { count: countProperty },
  }),
  search_intent_yield: event({
    questions: ["Q2"],
    description: "Current room yield summed across live searches of one intent after a plan commits. Counts can overlap between searches; no identity or content.",
    maxPerInstallPerDay: 200,
    properties: { intent: z.enum(["topic", "pain", "magnet_author", "lookalike"]), rooms: countProperty, fits: countProperty },
  }),
  audience_theme_kept: event({
    questions: ["Q2"],
    description: "The owner kept a room theme in Brain. Theme kind only; no text, identity or source.",
    maxPerInstallPerDay: 50,
    properties: { kind: z.enum(["pain", "objection", "open_question"]) },
  }),
  spotted_forgotten: event({
    questions: ["Q2"],
    description: "People whose untouched discovery evidence expired in daily retention. Count only.",
    maxPerInstallPerDay: 10,
    properties: { count: countProperty },
  }),
  inbox_item_opened: event({
    questions: ["Q2", "Q6"],
    description: "The owner opened a person in the Inbox: the kind of their newest answer and whether the row was on the list or the archive.",
    maxPerInstallPerDay: 300,
    properties: {
      kind: z.enum(["reply", "dm", "invite"]),
      tab: z.enum(["inbox", "archived"]),
    },
  }),
  draft_requested: event({
    questions: ["Q2"],
    description:
      "Someone asked the agent for angles, a draft or a redraft, for what, and from where: the Inbox, the chat or the owner's own agent over MCP.",
    maxPerInstallPerDay: 200,
    properties: {
      kind: z.enum(["angles", "draft", "redraft"]),
      for: z.enum(DRAFT_FOR),
      surface: z.enum(["inbox", "chat", "mcp"]),
    },
  }),
  draft_delivered: event({
    questions: ["Q2", "Q4"],
    description: "What became of a request for angles, a draft or a redraft, and how long it took.",
    maxPerInstallPerDay: 200,
    properties: {
      kind: z.enum(["angles", "draft", "redraft"]),
      outcome: z.enum(["ok", "failed", "timeout"]),
      duration_bucket: z.enum(DURATION_BUCKETS),
    },
  }),
  message_decided: event({
    questions: ["Q2", "Q3"],
    description:
      "A comment, reply, DM or invitation note was approved, rejected or unscheduled: whose words it is (written by the owner, edited from a draft or kept as drafted), how much of an agent draft survived, and how long it is. The words themselves are never sent.",
    maxPerInstallPerDay: 500,
    properties: {
      decision: z.enum(["approved", "rejected", "unscheduled"]),
      for: z.enum(DRAFT_FOR),
      origin: z.enum(["owner", "worker"]),
      written: z.enum(["own", "edited_draft", "kept_draft", "none"]),
      assist_retention_bucket: z.enum(RETENTION_BUCKETS),
      length_bucket: z.enum(LENGTH_BUCKETS),
    },
  }),
  send_settled: event({
    questions: ["Q1", "Q3", "Q4"],
    description:
      "A send to LinkedIn settled: what kind, whether it was confirmed, uncertain, not sent or failed, the class of the reason, who authored it, and how long it took. The first confirmed send of the install, and the first of each kind, say so.",
    maxPerInstallPerDay: 500,
    properties: {
      kind: z.enum(SEND_KINDS),
      outcome: z.enum(["confirmed", "uncertain", "not_sent", "failed"]),
      reason_class: z.enum(REASON_CLASSES),
      origin: z.enum(["owner", "worker"]),
      first_of_kind: flagProperty,
      latency_bucket: z.enum(DURATION_BUCKETS),
      first_of_install: flagProperty.optional(),
      seconds_since_install: countProperty.optional(),
    },
  }),
  engagement_received: event({
    questions: ["Q3"],
    description:
      "Someone came back: a reply to one of our comments, an accepted invitation or a DM reply, and how long after the send. This is the numerator of the north star, people who came back per active install per week.",
    maxPerInstallPerDay: 500,
    properties: {
      kind: z.enum(["reply_to_comment", "like_on_comment", "invite_accepted", "dm_reply", "mention"]),
      hours_since_send_bucket: z.enum(HOURS_BUCKETS),
    },
  }),
  linkedin_read_failed: event({
    questions: ["Q4"],
    description:
      "A read of a LinkedIn page failed: which kind of page, and why in seven words (the page changed, the read failed, the session expired, rate limited, an HTTP error, a timeout). A page change that hits everyone at once shows here within hours.",
    maxPerInstallPerDay: 200,
    properties: {
      reader: z.enum(["profile", "invitations", "conversation", "search", "feed", "comments", "me"]),
      reason: z.enum([
        "ui_drift",
        "read_failed",
        "session_expired",
        "rate_limited",
        "http_4xx",
        "http_5xx",
        "timeout",
      ]),
    },
  }),
  linkedin_session_changed: event({
    questions: ["Q4", "Q5"],
    description: "The connected LinkedIn account's session changed state.",
    maxPerInstallPerDay: 50,
    properties: { state: z.enum(["connected", "expired", "challenge", "restricted", "disconnected"]) },
  }),
  worker_run_failed: event({
    questions: ["Q4"],
    description: "A Scout or Ambassador run failed, in which phase, and the class of the reason.",
    maxPerInstallPerDay: 100,
    properties: {
      worker: z.enum(["scout", "ambassador"]),
      phase: z.enum(RUN_PHASES),
      reason_class: z.enum(REASON_CLASSES),
    },
  }),
  agent_call_failed: event({
    questions: ["Q4"],
    description:
      "A call to the owner's own agent failed: which agent, what the call was for, and how it failed. Successes are counted inside the run events, not one by one.",
    maxPerInstallPerDay: 100,
    properties: {
      adapter: z.enum(AGENT_ADAPTERS),
      purpose: z.enum(AGENT_PURPOSES),
      outcome: z.enum(["timeout", "schema_invalid", "auth", "refused", "crash"]),
    },
  }),
  job_failed: event({
    questions: ["Q4"],
    description: "A background job ended in failure: its type, the class of the reason, and which attempt it was.",
    maxPerInstallPerDay: 200,
    properties: {
      type: z.enum(JOB_TYPES),
      reason_class: z.enum(REASON_CLASSES),
      attempt: countProperty,
    },
  }),
  cap_reached: event({
    questions: ["Q5"],
    description: "A send was held because a daily cap was reached, at most once a day per kind and scope.",
    maxPerInstallPerDay: 50,
    properties: {
      kind: z.enum(SEND_KINDS),
      scope: z.enum(["account", "campaign"]),
    },
  }),
  stop_changed: event({
    questions: ["Q5"],
    description: "Stop was pressed or lifted, for everything or for one campaign, by the owner or by Engager.",
    maxPerInstallPerDay: 50,
    properties: {
      scope: z.enum(["everything", "campaign"]),
      on: flagProperty,
      actor: z.enum(["owner", "system"]),
    },
  }),
  mode_changed: event({
    questions: ["Q5"],
    description: "An action's mode changed between Off, Ask me and Automatic when a new version of a campaign came into force.",
    maxPerInstallPerDay: 100,
    properties: {
      kind: z.enum(MODE_KEYS),
      from: z.enum(MODE_NAMES),
      to: z.enum(MODE_NAMES),
    },
  }),
  restriction_signal: event({
    questions: ["Q5"],
    description: "LinkedIn showed a sign the account is under pressure: a security challenge, a restriction, or a warning banner.",
    maxPerInstallPerDay: 50,
    properties: { signal: z.enum(["challenge", "restricted", "warning_banner"]) },
  }),
  page_viewed: event({
    questions: ["Q6"],
    description:
      "A screen of the dashboard was opened, by its route template (for example /campaigns/[campaignId]/strategy), never by the path, an id or a query.",
    maxPerInstallPerDay: 1_000,
    properties: { route: z.enum(DASHBOARD_ROUTES) },
  }),
  ui_action: event({
    questions: ["Q6"],
    description:
      "The owner took one of a short list of actions in the dashboard: Run now, filtering the Inbox list, saving a strategy, setting a voice trait, sending a chat message, and a few more. Only the action's name is sent.",
    maxPerInstallPerDay: 500,
    properties: { action: z.enum(UI_ACTIONS) },
  }),
  install_active: event({
    questions: ["Q6", "Q5"],
    description:
      "Once a day while the agent runs: how much this install has set up. Counts of campaigns and workers, how many actions are Off, Ask me or Automatic, the daily comment and reply caps in buckets, the browser window choice and the LinkedIn session state.",
    maxPerInstallPerDay: 3,
    properties: {
      campaigns_active: countProperty,
      campaigns_total: countProperty,
      workers_auto: countProperty,
      ...modeCounts,
      browser_visibility: z.enum(["hidden", "shown"]),
      caps_comment: z.enum(CAP_BUCKETS),
      caps_reply: z.enum(CAP_BUCKETS),
      linkedin_session: z.enum(LINKEDIN_SESSIONS),
    },
  }),
  dashboard_error: event({
    questions: ["Q4"],
    description:
      "A page of the dashboard crashed or a request from it failed: which route, which kind, which error class, and a one-way hash of the message and of the first frame. The same error repeated within ten minutes is one event with a count. The message itself never leaves the page except inside a bug report the owner sends.",
    maxPerInstallPerDay: 100,
    properties: {
      route: z.enum(DASHBOARD_ROUTES),
      kind: z.enum(DASHBOARD_ERROR_KINDS),
      error_name: z.enum(ERROR_NAMES),
      message_hash: hashedIdProperty,
      frame_origin: z.enum(["own", "external", "none"]),
      frame_hash: hashedIdProperty.optional(),
      status: countProperty.optional(),
      count: countProperty,
    },
  }),
  server_error: event({
    questions: ["Q4"],
    description:
      "The dashboard's server threw while handling a request: which route and kind, which error class and a one-way hash of the message (or of Next's error digest).",
    maxPerInstallPerDay: 100,
    properties: {
      route: z.enum(DASHBOARD_ROUTES),
      kind: z.enum(["render", "route", "action", "middleware"]),
      error_name: z.enum(ERROR_NAMES),
      message_hash: hashedIdProperty,
    },
  }),
  app_updated: event({
    questions: ["Q6"],
    description: "The first start of a new version, so version adoption can be watched.",
    maxPerInstallPerDay: 3,
    properties: {
      from_version: versionProperty,
      to_version: versionProperty,
    },
  }),
  campaign_depth_set: event({
    questions: ["Q1", "Q2"],
    description:
      "A campaign's search depth was set, Quick, Standard or Deep: when it was created or by a later change, and whether the owner or their agent set it.",
    maxPerInstallPerDay: 100,
    properties: {
      depth: z.enum(SEARCH_DEPTHS),
      source: z.enum(["create", "change"]),
      by: z.enum(["owner", "agent"]),
    },
  }),
  first_match_visible: event({
    questions: ["Q1", "Q2"],
    description:
      "A campaign's first matched post was written, once per campaign: its search depth and how many milliseconds after the campaign was created.",
    maxPerInstallPerDay: 50,
    properties: { depth: z.enum(SEARCH_DEPTHS), ms_since_create: msSinceCreateProperty },
  }),
  first_draft_ready: event({
    questions: ["Q1", "Q2"],
    description:
      "A campaign's first draft was written, once per campaign: its search depth and how many milliseconds after the campaign was created.",
    maxPerInstallPerDay: 50,
    properties: { depth: z.enum(SEARCH_DEPTHS), ms_since_create: msSinceCreateProperty },
  }),
  first_look_finished: event({
    questions: ["Q1", "Q2"],
    description:
      "A Quick campaign's first look ended: how many rounds it ran, how many posts matched and were drafted, and why it stopped (its rounds ran out, it had enough matches, its searches ran dry, a round ran out of time, a round failed for good, the campaign was paused or stopped, or the owner's own agent finished it in session).",
    maxPerInstallPerDay: 50,
    properties: {
      rounds: countProperty,
      matched: countProperty,
      drafted: countProperty,
      stop_reason: z.enum([
        "rounds_done",
        "enough_matches",
        "searches_dry",
        "over_budget",
        "failed",
        "paused",
        "stopped",
        "in_session_done",
      ]),
    },
  }),
  reply_dismissed: event({
    questions: ["Q2"],
    description:
      "A reply someone left was let go with Don't reply, or brought back with Undo: which, where the reply was (on the owner's own post, or under a comment or reply of theirs) and from where, the Inbox or the owner's own agent over MCP. Nothing reaches LinkedIn either way.",
    maxPerInstallPerDay: 200,
    properties: {
      action: z.enum(["dont_reply", "undo"]),
      source: z.enum(["own_post", "our_comment_thread"]),
      surface: z.enum(["inbox", "mcp"]),
    },
  }),
  invite_note_checked: event({
    questions: ["Q2"],
    description:
      "After someone accepted an invitation sent with a note, one read of the conversation looked for that note: LinkedIn had carried it as the first message, had not (so it was reserved as a message of its own), or the conversation could not be read. Nothing is sent by the read.",
    maxPerInstallPerDay: 200,
    properties: {
      outcome: z.enum(["carried", "not_carried", "unreadable"]),
    },
  }),
  lead_served: event({
    questions: ["Q2"],
    description:
      "Find leads put a person on Leads: as a Signal, whose words passed the screen, or as a Lead, a buyer Research judged. What their words show, how well they fit and the campaign's search depth; never who they are or what they said.",
    maxPerInstallPerDay: 300,
    properties: {
      stage: z.enum(["signal", "lead"]),
      intent: z.enum(FUNNEL_INTENTS),
      fit: z.enum(FUNNEL_FITS),
      depth: z.enum(SEARCH_DEPTHS),
    },
  }),
  lead_rated: event({
    questions: ["Q2"],
    description:
      "The owner answered Is this right? on a lead Scout researched: the answer, and what the lead's words showed and how well Scout judged them to fit.",
    maxPerInstallPerDay: 200,
    properties: {
      rating: z.enum(["right_person", "peer", "not_a_fit", "wrong_intent"]),
      intent: z.enum(FUNNEL_INTENTS),
      fit: z.enum(FUNNEL_FITS),
    },
  }),
  signal_researched: event({
    questions: ["Q2", "Q4"],
    description:
      "Research judged a Signal: on the owner's press for the people they chose, on their press for the newest few, in a run, or by Judge, a step of its own. Whether it became a Lead, was judged no buyer, or its profile read was refused or failed.",
    maxPerInstallPerDay: 200,
    properties: {
      trigger: z.enum(["press", "batch", "run", "step"]),
      outcome: z.enum(["lead", "not_a_buyer", "refused", "failed"]),
    },
  }),
  lead_contacted: event({
    questions: ["Q2", "Q3"],
    description:
      "The first send that reached a person Find leads found settled: what it was, whether the owner wrote it or it went out unattended, what their words showed, how well they fit, and whether they were still a Signal.",
    maxPerInstallPerDay: 200,
    properties: {
      via: z.enum(["comment", "reply", "room_reply", "invite"]),
      origin: z.enum(["owner", "worker"]),
      intent: z.enum(FUNNEL_INTENTS),
      fit: z.enum(FUNNEL_FITS),
      from: z.enum(["signal", "lead"]),
    },
  }),
  relationship_started: event({
    questions: ["Q3"],
    description:
      "A person Find leads found answered for the first time and became a Relationship: how (a reply, a message, an invitation of theirs, or ours accepted), where they came from, and how long after the first send that reached them.",
    maxPerInstallPerDay: 200,
    properties: {
      kind: z.enum(["reply", "message", "invite_received", "invite_accepted"]),
      origin: z.enum(["find_leads", "inbound"]),
      hours_since_contact_bucket: z.enum([...HOURS_BUCKETS, "not_contacted"]),
    },
  }),
  inbox_person_read: event({
    questions: ["Q6"],
    description:
      "The owner opened a person in the Inbox: their temperature by their words to the owner (none before any), and whether they were unread.",
    maxPerInstallPerDay: 300,
    properties: {
      temperature: z.enum(["hot", "warm", "cold", "dormant", "none"]),
      was_unread: flagProperty,
    },
  }),
  scout_step_switched: event({
    questions: ["Q2"],
    description:
      "A campaign's Scout step was switched from Find posts to Find leads: on the card an upgrade drew, or in chat or by the owner's agent, and the campaign's search depth then.",
    maxPerInstallPerDay: 50,
    properties: {
      from: z.enum(["find_posts"]),
      to: z.enum(["find_leads"]),
      source: z.enum(["upgrade_card", "chat"]),
      depth: z.enum(SEARCH_DEPTHS),
    },
  }),
  setup_stage_reached: event({
    questions: ["Q1"],
    description:
      "Set up Engager reached a stage on a Mac that had never been set up, once each: the window opened, then every This Mac row was done. What comes before the install's first start.",
    maxPerInstallPerDay: SETUP_STAGES.length,
    properties: { stage: z.enum(SETUP_STAGES) },
  }),
  account_signed_in: event({
    questions: ["Q1"],
    description:
      "The owner signed in to their Engager account on this install: by email code or Google, and whether they came to sign in or to create an account.",
    maxPerInstallPerDay: 10,
    properties: {
      method: z.enum(["email", "google"]),
      intent: z.enum(["signin", "signup", "unstated"]),
    },
  }),
  plan_started: event({
    questions: ["Q1"],
    description:
      "This Mac's plan went from free to a trial or a paid plan, once per install.",
    maxPerInstallPerDay: 1,
    properties: {},
  }),
  dmg_download_started: event({
    questions: ["Q1"],
    description:
      "Someone followed Engager's download link and was sent to the newest build. Counted by Engager's own service under a random id made for that one download, so it says how many downloads started and nothing about who or which install.",
    maxPerInstallPerDay: 1,
    properties: {},
  }),
} as const satisfies Record<TelemetryEventName, EventDefinition<z.ZodRawShape>>;

export type TelemetryProps<E extends TelemetryEventName> = z.input<
  (typeof EVENTS)[E]["properties"]
>;

export type PropertyKind = "enum" | "count" | "flag" | "version" | "hashed id" | "commit";

export type PropertyDescription = {
  name: string;
  kind: PropertyKind;
  optional: boolean;
  values: readonly string[];
};

/** The shape of one property schema, or null for a kind the catalog does not
 * allow. The schema test and the documentation both read it, so a property
 * that cannot be described cannot ship. */
export function describeProperty(
  name: string,
  schema: z.ZodTypeAny,
): PropertyDescription | null {
  let inner = schema;
  let optional = false;
  while (inner instanceof z.ZodOptional) {
    optional = true;
    inner = inner._def.innerType;
  }
  if (inner === versionProperty) return { name, kind: "version", optional, values: [] };
  if (inner === hashedIdProperty) return { name, kind: "hashed id", optional, values: [] };
  if (inner === commitProperty) return { name, kind: "commit", optional, values: [] };
  if (inner instanceof z.ZodEnum) {
    return { name, kind: "enum", optional, values: inner.options as string[] };
  }
  if (inner instanceof z.ZodNumber) return { name, kind: "count", optional, values: [] };
  if (inner instanceof z.ZodBoolean) return { name, kind: "flag", optional, values: [] };
  return null;
}

export type EventDescription = {
  name: TelemetryEventName;
  /** Who sends it: an install, or Engager's own service. */
  sentBy: "install" | "service";
  questions: readonly TelemetryQuestion[];
  description: string;
  maxPerInstallPerDay: number;
  properties: PropertyDescription[];
};

export function describeEvents(): EventDescription[] {
  return EVENT_NAMES.map((name) => {
    const definition: EventDefinition<z.ZodRawShape> = EVENTS[name];
    return {
      name,
      sentBy: isServiceEvent(name) ? "service" : "install",
      questions: definition.questions,
      description: definition.description,
      maxPerInstallPerDay: definition.maxPerInstallPerDay,
      properties: Object.entries(definition.properties.shape).map(([key, schema]) => {
        const described = describeProperty(key, schema);
        if (!described || described.kind === "commit") {
          throw new Error(`${name}.${key} is not an allowed telemetry property kind`);
        }
        return described;
      }),
    };
  });
}

export function describeContext(): PropertyDescription[] {
  return Object.entries(CONTEXT_SCHEMA.shape).map(([key, schema]) => {
    const described = describeProperty(key, schema);
    if (!described) throw new Error(`context.${key} is not an allowed telemetry property kind`);
    return described;
  });
}
