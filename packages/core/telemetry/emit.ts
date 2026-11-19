/**
 * The core loop's usage-data emitters (US-TEL-05, -06): one small function per
 * event, called from the write that made it true. Each takes facts the product
 * already holds, turns them into the catalog's enums, counts and buckets, and
 * drops the originals. None throws, and every one sent from inside a
 * transaction waits for the commit (`afterCommit`): an event describes what
 * happened, not what was attempted.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { searches, roomSnapshots } from "@engager/database/schema";
import { afterCommit, withOrg, type Tx } from "@engager/database/tenant";
import { telemetryEnabled, track } from "@engager/observability/analytics";
import {
  durationBucket,
  hoursBucket,
  lengthBucket,
  reasonClassOf,
  retentionBucket,
} from "@engager/observability/classify";
import {
  AGENT_ADAPTERS,
  type DRAFT_FOR,
  MODE_KEYS,
  type SEND_KINDS,
  type TelemetryProps,
} from "@engager/observability/events";
import { claimMilestone } from "@engager/observability/telemetryState";
import type { DraftRequest } from "../chat/requestedDraft";

/** Run `send` once `tx` commits, or now when there is no transaction to wait for. */
export function afterCommitOrNow(tx: Tx | undefined, send: () => void): void {
  if (tx) afterCommit(tx, send);
  else send();
}

/** Who asked, as the funnel names it. The chat's tools run in a child process
 * launched with ENGAGER_TELEMETRY_SURFACE=chat; any other MCP caller is the
 * owner's own agent; the dashboard's actors are the Inbox. */
export function surfaceOfActor(actor: string): "inbox" | "chat" | "mcp" {
  if (/^(agent|mcp):/.test(actor)) return mcpSurface();
  return "inbox";
}

export function mcpSurface(): "chat" | "mcp" {
  return process.env.ENGAGER_TELEMETRY_SURFACE === "chat" ? "chat" : "mcp";
}

type SendKind = (typeof SEND_KINDS)[number];

/**
 * A send settled. A confirmed one also claims the install's firsts: the first
 * confirmed send of any kind carries `first_of_install` and the seconds since
 * the install began, and the first of its kind says so. A claim happens once,
 * on disk, so a restart or a second process cannot claim it again.
 */
export function trackSendSettled(
  input: {
    kind: SendKind;
    outcome: TelemetryProps<"send_settled">["outcome"];
    reason?: unknown;
    origin: "owner" | "worker";
    /** When the send began, for its latency; unknown reads as instant. */
    startedAt?: number | null;
    settledAt?: number;
  },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () => {
    const settledAt = input.settledAt ?? Date.now();
    let firstOfInstall: { secondsSinceInstall: number } | null = null;
    let firstOfKind = false;
    if (input.outcome === "confirmed") {
      firstOfKind = claimMilestone(`kind_${input.kind}`, settledAt) !== null;
      firstOfInstall = claimMilestone("first_send", settledAt);
    }
    track("send_settled", {
      kind: input.kind,
      outcome: input.outcome,
      reason_class: input.outcome === "confirmed" ? "none" : reasonClassOf(input.reason ?? "outcome_unknown"),
      origin: input.origin,
      first_of_kind: firstOfKind,
      latency_bucket: durationBucket(input.startedAt == null ? 0 : settledAt - input.startedAt),
      ...(firstOfInstall
        ? { first_of_install: true, seconds_since_install: firstOfInstall.secondsSinceInstall }
        : {}),
    });
  });
}

/** A comment, reply, DM or note was decided. Nothing of its words travels: the
 * length is a bucket, and how much of an agent draft survived is a bucket. */
export function trackMessageDecided(
  input: {
    decision: TelemetryProps<"message_decided">["decision"];
    for: TelemetryProps<"message_decided">["for"];
    origin: "owner" | "worker";
    written: TelemetryProps<"message_decided">["written"];
    /** Percent of an agent draft that survived into the sent words; null when
     *  there was no draft to keep. */
    retentionPercent?: number | null;
    characters?: number;
  },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () =>
    track("message_decided", {
      decision: input.decision,
      for: input.for,
      origin: input.origin,
      written: input.written,
      assist_retention_bucket: retentionBucket(input.retentionPercent),
      length_bucket: lengthBucket(input.characters ?? 0),
    }),
  );
}

export function trackDraftRequested(
  input: TelemetryProps<"draft_requested">,
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () => track("draft_requested", input));
}

export function trackDraftDelivered(
  input: {
    kind: TelemetryProps<"draft_delivered">["kind"];
    outcome: TelemetryProps<"draft_delivered">["outcome"];
    durationMs: number;
  },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () =>
    track("draft_delivered", {
      kind: input.kind,
      outcome: input.outcome,
      duration_bucket: durationBucket(input.durationMs),
    }),
  );
}

/** A reply let go with Don't reply, or taken back with Undo. Who chose it
 * names the surface — the owner's press is the Inbox's, the agent's comes over
 * MCP — and nothing of the reply travels: not its words, its writer or its
 * urn. */
export function trackReplyDismissed(
  input: {
    action: TelemetryProps<"reply_dismissed">["action"];
    source: TelemetryProps<"reply_dismissed">["source"];
    by: "owner" | "agent";
  },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () =>
    track("reply_dismissed", {
      action: input.action,
      source: input.source,
      surface: input.by === "owner" ? "inbox" : "mcp",
    }),
  );
}

/** The conversation of an accepted invitation sent with a note was read for
 * that note. Only the outcome travels: not the note, the person or the
 * conversation. */
export function trackInviteNoteChecked(
  input: { outcome: TelemetryProps<"invite_note_checked">["outcome"] },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () => track("invite_note_checked", { outcome: input.outcome }));
}

/** Someone came back (the north star's numerator). */
export function trackEngagement(
  input: {
    kind: TelemetryProps<"engagement_received">["kind"];
    /** When our send happened and when they answered, in ms. */
    sentAt: number | null;
    receivedAt: number;
  },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () =>
    track("engagement_received", {
      kind: input.kind,
      hours_since_send_bucket: hoursBucket(input.sentAt == null ? 0 : input.receivedAt - input.sentAt),
    }),
  );
}

/**
 * A Scout run ended: ONE event for the run, whatever it read. The counts are
 * the run row's own (the rows the server wrote), the searches are counted
 * here, and the first run that matched anything claims the install's first
 * match. Room counts come from the run's stored discovery counters. Never throws.
 */
export async function trackScoutRun(input: {
  organizationId: string;
  campaignId: number;
  runId: number;
  trigger: "schedule" | "manual" | "agent" | "event" | "match";
  status: "succeeded" | "partial" | "failed";
  discovered: number;
  triaged: number;
  matched: number;
  startedAt: number;
}): Promise<void> {
  try {
    if (!telemetryEnabled()) return;
    const { activeSearches, spotted } = await withOrg(input.organizationId, async (tx) => {
      const [searchCount] = await tx
        .select({ active: count() })
        .from(searches)
        .where(and(eq(searches.campaignId, input.campaignId), eq(searches.status, "active")));
      const [spotted] = await tx.select({
        count: sql<number>`coalesce(sum((${roomSnapshots.summary}->>'newlySpotted')::int), 0)::int`,
      }).from(roomSnapshots).where(and(eq(roomSnapshots.campaignId, input.campaignId), eq(roomSnapshots.runId, input.runId)));
      return { activeSearches: searchCount, spotted };
    });
    const now = Date.now();
    const first =
      input.status !== "failed" && input.matched > 0 ? claimMilestone("first_match", now) : null;
    track("scout_run_finished", {
      trigger: input.trigger === "manual" || input.trigger === "agent" ? "manual" : "scheduled",
      outcome: input.status === "succeeded" ? "ok" : input.status,
      posts_read: input.discovered,
      matched: input.matched,
      rejected: Math.max(0, input.triaged - input.matched),
      searches_active: activeSearches?.active ?? 0,
      duration_bucket: durationBucket(now - input.startedAt),
      ...(first ? { first_of_install: true, seconds_since_install: first.secondsSinceInstall } : {}),
    });
    track("room_people_spotted", { count: spotted?.count ?? 0 });
  } catch {
    // Reports less; the run is already recorded.
  }
}

/**
 * The owner saved their own words as a comment or reply (save = send). What the
 * save was measured against decides how to name it: no draft in reach, or none
 * of it kept, is their own; a little of it kept is an edit; all of it, the
 * draft as it was. The words are measured and dropped here.
 */
export function trackOwnerSave(
  input: { for: "comment" | "reply"; retention: number | null | undefined; characters: number },
  tx?: Tx,
): void {
  const retention = input.retention ?? null;
  const written: TelemetryProps<"message_decided">["written"] =
    retention === null || retention <= 0.01 ? "own" : retention >= 0.995 ? "kept_draft" : "edited_draft";
  trackMessageDecided(
    {
      decision: "approved",
      for: input.for,
      origin: "owner",
      written,
      retentionPercent: retention === null ? null : retention * 100,
      characters: input.characters,
    },
    tx,
  );
}

/** A queued DM or invitation note was approved, skipped or unscheduled. Other
 * actions (a like, an acceptance) carry no words and are not decisions about
 * any. */
export function trackActionDecided(
  action: { kind: string; origin: string; candidate: { text: string | null } },
  decision: TelemetryProps<"message_decided">["decision"],
  extra: { written?: TelemetryProps<"message_decided">["written"]; retentionPercent?: number | null } = {},
  tx?: Tx,
): void {
  const subject = action.kind === "dm" || action.kind === "followup" ? "dm" : action.kind === "invite" ? "invite_note" : null;
  if (subject === null) return;
  trackMessageDecided(
    {
      decision,
      for: subject,
      origin: action.origin === "owner" ? "owner" : "worker",
      written: decision === "approved" ? (extra.written ?? "kept_draft") : "none",
      retentionPercent: decision === "approved" ? (extra.retentionPercent ?? 100) : null,
      characters: action.candidate.text?.length ?? 0,
    },
    tx,
  );
}

/** What an app-owned draft request (the Inbox asking the chat agent) asks
 * for, as the catalog names it. */
export function draftRequestShape(request: DraftRequest): {
  kind: "angles" | "draft" | "redraft";
  for: (typeof DRAFT_FOR)[number];
} {
  if ("kind" in request) return { kind: request.composer?.kind === "redraft" ? "redraft" : "draft", for: request.kind === "invite" ||
    (request.kind === "room_reply" && request.deliverable === "invite_note") ? "invite_note"
    // A lead's opener is a comment under their words.
    : request.kind === "lead" ? "comment" : request.kind };
  return { kind: "angles", for: "comment" };
}

/** Whether a failure was the clock running out rather than the agent failing. */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /time(?:d)?[ _-]?out|aborted/i.test(`${error.name} ${error.message}`);
}

// ---- reliability and safety (US-TEL-06) ----------------------------------

let capDay = "";
const capReported = new Set<string>();

/** Test seam: forget which caps were already reported today. */
export function resetCapReports(): void {
  capDay = "";
  capReported.clear();
}

/** A send was held by a daily cap. Said once a day per kind and scope: the
 * gate is asked again every hour, and the hundredth refusal of one day is not
 * news. */
export function trackCapReached(
  input: { kind: (typeof SEND_KINDS)[number]; scope: "account" | "campaign" },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () => {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== capDay) {
      capDay = day;
      capReported.clear();
    }
    const key = `${input.kind}:${input.scope}`;
    if (capReported.has(key)) return;
    capReported.add(key);
    track("cap_reached", input);
  });
}

/** Stop pressed or lifted. `by` is read for who, never sent. */
export function trackStopChanged(
  input: { scope: "everything" | "campaign"; on: boolean; by: string },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () =>
    track("stop_changed", {
      scope: input.scope,
      on: input.on,
      actor: /^(system|engager)\b/i.test(input.by) ? "system" : "owner",
    }),
  );
}

type ModeName = "off" | "ask" | "auto";
const modeNameOf = (stored: unknown): ModeName =>
  stored === "auto" ? "auto" : stored === "review" ? "ask" : "off";

/** The modes that moved between two versions of a strategy, one event each,
 * by key (`modesByKey`). An absent mode reads as Off, as it does at the gate. */
export function trackModeChanges(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  tx?: Tx,
): void {
  for (const key of MODE_KEYS) {
    const from = modeNameOf(before?.[key]);
    const to = modeNameOf(after?.[key]);
    if (from !== to) afterCommitOrNow(tx, () => track("mode_changed", { kind: key, from, to }));
  }
}

/** A Scout or Ambassador run failed. The phase it reached and the class of the
 * reason; the reason's own words are read and dropped. */
export function trackWorkerRunFailed(input: {
  workerType: string;
  phase: TelemetryProps<"worker_run_failed">["phase"];
  reason: unknown;
}): void {
  track("worker_run_failed", {
    worker: input.workerType === "scout" ? "scout" : "ambassador",
    phase: input.phase,
    reason_class: reasonClassOf(input.reason),
  });
}

type AgentPurpose = TelemetryProps<"agent_call_failed">["purpose"];

/** What an agent call was for, from the call site's own label. A label nobody
 * has mapped is `other`, not a new string. */
export function agentPurposeOf(label: string | null | undefined): AgentPurpose {
  const text = label ?? "";
  if (/verify|evidence|judge|research/i.test(text)) return "research";
  if (/triage|filter|incoming_reading|relevance|sensitivity|intent/i.test(text)) return "triage";
  if (/draft|writer|redraft|reply|comment|invitation_note|lead_dm|\bdm\b|angle|slop|held/i.test(text)) return "draft";
  if (/voice|tone|distill|guidance|fact|brain/i.test(text)) return "brain";
  if (/products|campaigns|ingest|structural|suggest|hashtags/i.test(text)) return "ingest";
  return "other";
}

/** How an agent call failed, in five words, from the failure's own code. */
export function agentOutcomeOf(code: unknown): TelemetryProps<"agent_call_failed">["outcome"] {
  const text = typeof code === "string" ? code : code instanceof Error ? `${code.name} ${code.message}` : "";
  if (/time(?:d)?[ _-]?out|deadline|abort/i.test(text)) return "timeout";
  if (/schema|invalid_agent_output|invalid/i.test(text)) return "schema_invalid";
  if (/auth|login|quota|credential/i.test(text)) return "auth";
  if (/isolation|selection|refus|limits|stale|conflict|admission|unsupported|not_found/i.test(text)) return "refused";
  return "crash";
}

/** A call to the owner's own agent failed. The code is read and dropped. */
export function trackAgentCallFailed(input: {
  adapter: string;
  purpose: AgentPurpose;
  code: unknown;
}): void {
  if (!(AGENT_ADAPTERS as readonly string[]).includes(input.adapter)) return;
  track("agent_call_failed", {
    adapter: input.adapter as (typeof AGENT_ADAPTERS)[number],
    purpose: input.purpose,
    outcome: agentOutcomeOf(input.code),
  });
}
