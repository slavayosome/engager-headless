import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  jobs,
  stepRuns,
  workers,
  type ConversationEventRow,
  type ConversationEventType,
  type StepRunRow,
  type StepWait,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { WorkerRunPayload } from "../jobs/handlers/workerRun";
import { enqueue } from "../jobs/queue";
import { locateQuote } from "../conversations/classify";
import { MAX_WAIT_HOURS, type WaitEvent, type WaitRequest } from "./result";
import { plansEvent } from "./select";

/**
 * WAITS ARE JOBS (spec §08). A step that ends `waiting` names the event it
 * waits for, the conversation it must come from, when it expires and what the
 * expiry does; arming it enqueues one `agent_step_timeout` job at the expiry.
 * The wait is consumed ONCE — by a matching conversation event that wakes the
 * Ambassador, which cancels the timeout, or by the timeout, which wakes it or
 * hands the conversation to a person — so a replayed event, or a timeout that lost
 * the race, finds it consumed and does nothing. A matching event that wakes
 * nothing — a reply the eligibility table sent to a person, or one on a paused
 * campaign — leaves the wait and its timeout standing, so the checkpoint is
 * never left waiting with nothing to end it.
 *
 * A step may name the time itself — "wake me Tuesday at nine, because they
 * said 'ping me Tuesday'" ({@link judgeWait}): the same wait, its expiry an
 * instant the step chose, still ended early by the person's next message.
 * The server only bounds it. Whatever wakes it, the step reads the
 * conversation afresh and decides again. A newer decision of the same step on
 * the conversation supersedes an older wait ({@link supersedeWaits}), and the owner
 * can move or cancel one (`agentStep/wakes.ts`).
 *
 * New replies wake the conversation and reset nothing: caps, opt-outs and every
 * counter are where the event found them.
 */

const HOUR = 3_600_000;

/** How long a step waits when its result names no expiry. */
export const DEFAULT_WAIT_HOURS = 48;

/** The entry event a conversation event is — what a wait matches against. */
export function entryEventOf(type: ConversationEventType): WaitEvent | "room_member_spotted" | null {
  switch (type) {
    case "room_member_spotted":
      return "room_member_spotted";
    case "reply_observed":
    case "reply_edited":
      return "direct_reply";
    case "inbound_message_observed":
      return "inbound_dm";
    case "invitation_accepted":
    case "incoming_invitation_observed":
      return "invitation_status";
    case "booking_verified":
    case "activation_verified":
    case "payment_verified":
      return "outcome_evidence";
    default:
      return null;
  }
}

/** Persisted in waits already stored: the key keeps its `journey:` prefix. */
export function conversationCorrelation(conversationId: number): string {
  return `journey:${conversationId}`;
}

/** The wait a `waiting` result asks for: its own request, else the step's
 *  entry event for the default expiry, handed to a person at the end. Pure. */
export function waitFor(
  request: WaitRequest | null,
  fallback: { conversationId: number; event: WaitEvent },
  now: number,
): StepWait {
  return {
    event: request?.event ?? fallback.event,
    correlation: conversationCorrelation(fallback.conversationId),
    expiresAt: now + (request?.expires_in_hours ?? DEFAULT_WAIT_HOURS) * HOUR,
    onTimeout: request?.on_timeout ?? "escalate",
    timeoutJobId: null,
    consumedAt: null,
    consumedBy: null,
  };
}

/** Why a wait a step asked for is not armed. */
export const WAKE_REFUSALS = [
  /** `wake_at` is not an ISO 8601 time with its offset. */
  "wake_time_invalid",
  /** Not after now, or further out than a step may wait. */
  "wake_out_of_range",
  /** A named time with no ref, or a ref that is not an event of the
   *  conversation the step was handed. */
  "wake_unresolved_evidence",
  /** A quote that is not the person's own words, verbatim, in a message of
   *  theirs the wait cites. */
  "wake_unquoted",
] as const;
export type WakeRefusal = (typeof WAKE_REFUSALS)[number];

/** The words of each event a wait may cite, by ref, and whether the person
 *  wrote them. */
export type CitedWords = ReadonlyMap<string, { content: string; theirs: boolean }>;

const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The wait a `waiting` result asks for, bounded by the server — or why it is
 * not armed. A plain request is {@link waitFor}'s. A named time (`wake_at`)
 * must be an instant with its offset, after now and within
 * {@link MAX_WAIT_HOURS}, and rest on at least one ref; every ref a wait cites
 * must be an event of the conversation the step was handed; a quote must
 * stand verbatim, as whole words, in a message of the person's that it cites —
 * never the step's paraphrase, never our own words. Nothing here reads a date
 * out of anyone's words: the step names the time, and the server checks what
 * it says the time rests on. Pure.
 */
export function judgeWait(
  request: WaitRequest | null,
  fallback: { conversationId: number; event: WaitEvent },
  conversation: { evidence: ReadonlySet<string>; words: CitedWords },
  now: number,
): { ok: true; wait: StepWait } | { ok: false; reason: WakeRefusal } {
  const base = waitFor(request, fallback, now);
  if (!request) return { ok: true, wait: base };
  const refs = [...new Set(request.evidence_refs)];
  const quote = request.quote?.trim() || null;
  if (request.wake_at === null && refs.length === 0 && quote === null) return { ok: true, wait: base };

  let expiresAt = base.expiresAt;
  if (request.wake_at !== null) {
    const at = ISO_WITH_OFFSET.test(request.wake_at) ? Date.parse(request.wake_at) : Number.NaN;
    if (!Number.isFinite(at)) return { ok: false, reason: "wake_time_invalid" };
    if (at <= now || at > now + MAX_WAIT_HOURS * HOUR) return { ok: false, reason: "wake_out_of_range" };
    if (refs.length === 0) return { ok: false, reason: "wake_unresolved_evidence" };
    expiresAt = at;
  }
  const resolves = (ref: string) => conversation.evidence.has(ref) && conversation.words.has(ref);
  if (!refs.every(resolves)) return { ok: false, reason: "wake_unresolved_evidence" };
  let quotedEventId: number | null = null;
  if (quote !== null) {
    const source = refs.find((ref) => {
      const words = conversation.words.get(ref)!;
      return words.theirs && locateQuote(words.content, quote) !== null;
    });
    if (source === undefined) return { ok: false, reason: "wake_unquoted" };
    quotedEventId = Number(source.slice("event:".length));
  }
  return {
    ok: true,
    wait: { ...base, expiresAt, named: request.wake_at !== null, evidenceRefs: refs, quote, quotedEventId },
  };
}

/** The person's own words, wherever they write them. */
const THEIR_WORDS: ReadonlySet<string> = new Set<WaitEvent>(["direct_reply", "inbound_dm"]);

/** Whether a conversation event ends this wait: unconsumed, from the conversation it
 *  names, and the event it waits for — where that is the person writing, a
 *  message from them in either place, since any word of theirs is what the
 *  step waited to read. Pure. */
export function waitMatches(
  wait: StepWait | null,
  event: { conversationId: number; type: ConversationEventType },
): boolean {
  const entry = entryEventOf(event.type);
  return (
    wait !== null &&
    wait.consumedAt === null &&
    wait.correlation === conversationCorrelation(event.conversationId) &&
    entry !== null &&
    (entry === wait.event || (THEIR_WORDS.has(entry) && THEIR_WORDS.has(wait.event)))
  );
}

/** Arm a waiting checkpoint's expiry: one job, keyed on the checkpoint, so
 *  arming it twice arms one. Returns the wait carrying the job's id. */
export async function armWaitTimeout(
  tx: Tx,
  stepRunId: number,
  wait: StepWait,
): Promise<StepWait> {
  const timeoutJobId = await enqueue(tx, {
    type: "agent_step_timeout",
    payload: { stepRunId },
    nextRunAt: wait.expiresAt,
    idempotencyKey: `agent_step_timeout:${stepRunId}`,
  });
  return { ...wait, timeoutJobId };
}

/**
 * A conversation event was recorded, in the transaction that recorded it. When it
 * is an event a step answers — judged `eligible`, and one a wake plans
 * ({@link plansEvent}) — wake the campaign's Ambassador for it, one wake per
 * event, keyed on it, and consume every wait it ends, cancelling each one's
 * timeout: the wake serves the conversation now. An event that wakes nothing
 * consumes nothing, so a wait the woken run would never answer keeps its own
 * timeout — except the invitation's answer: a wait on `invitation_status`
 * waited for exactly that, and nothing is left to wait for once it came,
 * woken or not. The caller records an event once, so a replay of it reaches
 * none of this.
 */
export async function conversationEventArrived(
  tx: Tx,
  input: {
    campaignId: number;
    event: Pick<ConversationEventRow, "id" | "conversationId" | "type" | "decision">;
    now: number;
  },
): Promise<{ consumed: number; wake: number | null }> {
  const { event, now } = input;
  const answered =
    (event.decision as { decision?: unknown } | null)?.decision === "eligible" &&
    (await plansEvent(tx, input.campaignId, event.type));
  const wake = answered
    ? await wakeAmbassador(tx, input.campaignId, `journey_event:${event.id}`)
    : null;
  if (wake === null && entryEventOf(event.type) !== "invitation_status") return { consumed: 0, wake };
  const waiting = await tx
    .select()
    .from(stepRuns)
    .where(
      and(
        eq(stepRuns.conversationId, event.conversationId),
        eq(stepRuns.status, "waiting"),
        sql`${stepRuns.wait}->>'consumedAt' is null`,
      ),
    )
    .for("update");
  let consumed = 0;
  for (const row of waiting) {
    if (!waitMatches(row.wait, event)) continue;
    await consumeWait(tx, row, "event", now);
    consumed += 1;
  }
  return { consumed, wake };
}

/** What a cancelled timeout job says ended it. */
const CONSUMED_BY: Record<Exclude<NonNullable<StepWait["consumedBy"]>, "timeout">, string> = {
  event: "superseded: the awaited event arrived",
  superseded: "superseded: a newer decision of the step",
  owner: "superseded: cancelled by the owner",
};

/** Mark a checkpoint's wait consumed and cancel its timeout if it has not
 *  run — the same cancel the post-job projection writes for a withdrawn
 *  send. A timeout already running finds the wait consumed and stops. */
export async function consumeWait(
  tx: Tx,
  row: Pick<StepRunRow, "id" | "wait">,
  by: NonNullable<StepWait["consumedBy"]>,
  now: number,
): Promise<void> {
  if (!row.wait) return;
  await tx
    .update(stepRuns)
    .set({ wait: { ...row.wait, consumedAt: now, consumedBy: by }, updatedAt: now })
    .where(eq(stepRuns.id, row.id));
  if (by !== "timeout" && row.wait.timeoutJobId !== null) {
    await tx
      .update(jobs)
      .set({
        status: "done",
        lastError: CONSUMED_BY[by],
        updatedAt: now,
      })
      .where(
        and(
          // `jobs` is outside RLS, so the org predicate is explicit: the
          // transaction's own.
          sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
          eq(jobs.id, row.wait.timeoutJobId),
          eq(jobs.status, "queued"),
        ),
      );
  }
}

/** Move a checkpoint's wait to end at `at`, its timeout job with it. False,
 *  with nothing written, when that job is no longer queued: it is firing now
 *  and the step is being woken. */
export async function moveWaitExpiry(
  tx: Tx,
  row: Pick<StepRunRow, "id" | "wait">,
  at: number,
  now: number,
  movedBy?: string,
): Promise<boolean> {
  const wait = row.wait!;
  if (wait.timeoutJobId !== null) {
    const moved = await tx
      .update(jobs)
      .set({ nextRunAt: at, updatedAt: now })
      .where(
        and(
          // `jobs` is outside RLS, so the org predicate is explicit: the
          // transaction's own.
          sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
          eq(jobs.id, wait.timeoutJobId),
          eq(jobs.status, "queued"),
        ),
      )
      .returning({ id: jobs.id });
    if (moved.length === 0) return false;
  }
  await tx
    .update(stepRuns)
    .set({ wait: { ...wait, expiresAt: at, ...(movedBy === undefined ? {} : { movedBy }) }, updatedAt: now })
    .where(eq(stepRuns.id, row.id));
  return true;
}

/**
 * A newer decision of a step on a conversation supersedes every wait its earlier
 * checkpoints still hold there: whatever it decided, it read the conversation
 * as it stands now, so an older "wake me then" no longer speaks for it.
 * Returns how many.
 */
export async function supersedeWaits(
  tx: Tx,
  input: { conversationId: number; stepId: string; decidedBy: number; now: number },
): Promise<number> {
  const older = await tx
    .select()
    .from(stepRuns)
    .where(
      and(
        eq(stepRuns.conversationId, input.conversationId),
        eq(stepRuns.stepId, input.stepId),
        eq(stepRuns.status, "waiting"),
        ne(stepRuns.id, input.decidedBy),
        sql`${stepRuns.wait}->>'consumedAt' is null`,
      ),
    )
    .for("update");
  for (const row of older) await consumeWait(tx, row, "superseded", input.now);
  return older.length;
}

/**
 * Enqueue the campaign's Ambassador for its conversation work — only while
 * the server wakes it at all (`auto`: the campaign Active and a step on), so a
 * paused campaign wakes neither its schedule nor its events. Null when there
 * is no Ambassador to wake, or the key already woke one.
 */
export async function wakeAmbassador(
  tx: Tx,
  campaignId: number,
  idempotencyKey: string,
): Promise<number | null> {
  const [ambassador] = await tx
    .select({ id: workers.id })
    .from(workers)
    .where(
      and(
        eq(workers.campaignId, campaignId),
        eq(workers.type, "ambassador"),
        eq(workers.conversationEnabled, true),
        eq(workers.auto, true),
      ),
    )
    .orderBy(asc(workers.id))
    .limit(1);
  if (!ambassador) return null;
  const payload: WorkerRunPayload = { workerId: ambassador.id, trigger: "event" };
  return enqueue(tx, { type: "worker_run", payload, idempotencyKey });
}

/** The waiting checkpoints a timeout may still consume. */
export function unconsumed(row: Pick<StepRunRow, "status" | "wait">): boolean {
  return row.status === "waiting" && row.wait !== null && row.wait.consumedAt === null;
}
