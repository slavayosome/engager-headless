import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import {
  campaigns,
  discoveredPosts,
  incomingComments,
  messages,
  organizations,
  rateLimitLedger,
  type Campaign,
  type Channel,
  type Message,
} from "@engager/database/schema";
import { sql } from "drizzle-orm";
import type { Tx } from "@engager/database/tenant";
import { enqueueActionDispatch } from "../actions/drain";
import { linkedinPostUrl } from "../linkedin/postUrl";
import { fnvHash, mulberry32 } from "../pacing";
import {
  channelCeilings,
  channelWarmupClock,
  pacingPolicy,
  type SendOrigin,
} from "../ratelimit/ledger";
import {
  activeWindowState,
  DAY_KEYS,
  driftPastOpen,
  isAllowedDay,
  isAlwaysOpen,
  localDay,
  withinActiveWindow,
  workDay,
} from "../time";

/**
 * The org's posting schedule, two-sided:
 *
 *  - `assignSlots` PLANS: when a message becomes approved+enqueued it gets a
 *    durable `messages.scheduledAt` slot drawn from a HUMAN-DAY plan — 1–3
 *    committed sessions (2–5 comments minutes apart) plus scattered drive-by
 *    singles, with the day's volume breathing between 55–100% of the daily cap.
 *    The plan is the ONLY pacer — no hourly grid exists anywhere. Deterministic
 *    per local day, persisted once; volume whose anchors passed with nothing
 *    to send is made up later the SAME day (`makeUpPoints`), never carried
 *    past it. Every hard gate (daily caps × warm-up,
 *    active hours, org ceilings, min-gap floor) is honored at assignment AND
 *    re-checked by canEngage at send time. A slot is a plan, not a bypass.
 *  - `projectSchedule` READS: stored slots verbatim (source:"scheduled") plus a
 *    deterministic forward simulation for slotless legacy rows
 *    (source:"projected") walking the same gates from the ledger's state.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const SNIPPET_LEN = 120;

const NOTE =
  "source:'scheduled' items are persisted slots (stable, jittered at assignment; caps/active-hours still gate each send). source:'projected' items are simulations for slotless legacy rows — retries, pauses, and new submissions shift them.";

export type ScheduleItem = {
  /** "scheduled" = the message's persisted slot (stable across reads);
   *  "projected" = simulated for slotless legacy rows (shifts with state). */
  source: "scheduled" | "projected";
  projectedAt: number;
  messageId: number;
  campaignId: number;
  campaignName: string;
  kind: Message["kind"];
  commentType: string | null;
  /**
   * WHOSE VOLUME THIS SLOT IS — `messages.publishOrigin` verbatim, and the sole
   * input to which set of gates produced the time beside it (INV-1). "owner"
   * rows are the owner's own words and are only spaced; "worker" rows are a
   * worker's and carry the caps, the window and the human-day plan.
   *
   * A reader that cannot see this cannot explain its own schedule: two rows
   * minutes apart at 3am and two rows an hour apart at noon are the same
   * correct plan under different origins.
   */
  publishOrigin: SendOrigin;
  /** Post author (comments) or comment author (replies). */
  targetAuthor: string | null;
  /** Excerpt of the post / incoming comment being responded to. */
  targetSnippet: string;
  /** LinkedIn permalink of the action target post (comments: the discovered post;
   *  replies: the user's own post the incoming comment sits on). */
  targetUrl: string | null;
  draftPreview: string;
  /** Projected send falls past the campaign's maxPostAgeDays for this post.
   *  Advisory only: the freshness window binds at triage and draft selection,
   *  not at send, so an approved row still posts — it just lands stale. */
  willAgeOut: boolean;
};

export type ScheduleProjection = {
  generatedAt: number;
  windowHours: number;
  items: ScheduleItem[];
  /** Approved messages whose projected slot falls beyond the window. */
  beyondWindow: number;
  /** Messages projected to age out before their slot (subset of items/beyondWindow). */
  agingOutRisk: number;
  note: string;
};

function snippet(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_LEN ? `${t.slice(0, SNIPPET_LEN - 1)}…` : t;
}

/** Ledger timestamps (asc) since `since` — the ACCOUNT's, across every
 *  campaign feeding it. The campaign scope is gone on purpose: one ledger day
 *  and one cap bind whichever campaign spends (INV-4). */
async function ledgerDayTs(
  tx: Tx,
  actions: Message["kind"][],
  since: number,
): Promise<number[]> {
  const conds = [inArray(rateLimitLedger.action, actions), gte(rateLimitLedger.ts, since)];
  const rows = await tx
    .select({ ts: rateLimitLedger.ts })
    .from(rateLimitLedger)
    .where(and(...conds))
    .orderBy(asc(rateLimitLedger.ts));
  return rows.map((r) => r.ts);
}

type Gates = {
  minGap: number;
  dailyCap: number; // 0 = uncapped
  activeHours: Channel["activeHours"];
  activeDays: Channel["activeDays"];
};

/** The plan's pairwise floor never drops below this, whatever the campaign's
 *  minDelaySec says — two sends in the same instant is a bot signature and a
 *  misconfigured 0 must not disable spacing. Mirrors canEngage's clamp. */
const MIN_FLOOR_MS = 30_000;

/** Account-wide lane shared by every campaign (ONE LinkedIn account): the org
 *  min-gap + daily ceiling, applied against ALL sends/slots regardless of lane. */
type OrgLane = {
  gapMs: number; // 0 = disabled
  dailyCap: number; // 0 = disabled
  /** Sorted asc: real ledger sends + already-planned slots, org-wide. */
  sent: number[];
};

/** Insert keeping the array sorted asc (lanes can hold future slots, so a plain
 *  push is not always monotonic). */
function insertSorted(arr: number[], v: number): void {
  let i = arr.length;
  while (i > 0 && arr[i - 1]! > v) i--;
  arr.splice(i, 0, v);
}

/** Latest timestamp ≤ t in a sorted-asc array (the org min-gap looks backward;
 *  a future slot from another campaign must not push today's candidate past it). */
function latestAtOrBefore(sorted: number[], t: number): number | null {
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]! <= t) return sorted[i]!;
  }
  return null;
}

/** Earliest timestamp > t in a sorted-asc array (the org min-gap also looks
 *  forward: a candidate must not land just before another campaign's slot). */
function earliestAfter(sorted: number[], t: number): number | null {
  for (const ts of sorted) if (ts > t) return ts;
  return null;
}

/** How many of `sorted` fall inside `day` — the sends it already holds and the
 *  slots planned into it alike, since a candidate can settle into a hole before
 *  slots already planned (the earliest free anchor, a made-up slot). */
function countInDay(sorted: number[], day: { open: number; next: number }): number {
  let n = 0;
  for (const ts of sorted) if (ts >= day.open && ts < day.next) n++;
  return n;
}

/** Advance `cursor` to the first instant every campaign gate clears, given the
 *  (real + projected) send timestamps so far. Bounded fixed-point loop. The
 *  optional org lane folds the account-wide min-gap + daily ceiling into the same
 *  fixed point. The min-gap looks at the candidate's NEIGHBORS in `sent` (backward
 *  and forward), not the lane's max — a candidate may settle into a hole between
 *  existing slots, so a vacated plan refills instead of growing past its tail. */
function nextClearSlot(cursor: number, sent: number[], g: Gates, org?: OrgLane): number {
  let t = cursor;
  for (let i = 0; i < 60; i++) {
    let moved = false;
    if (g.minGap > 0) {
      const prev = latestAtOrBefore(sent, t);
      if (prev != null && t < prev + g.minGap) {
        t = prev + g.minGap;
        moved = true;
      }
      // Forward conflict: landing just before an already-planned slot would
      // squeeze that slot's spacing — hop past it and re-check.
      const next = earliestAfter(sent, t);
      if (next != null && next - t < g.minGap) {
        t = next + g.minGap;
        moved = true;
      }
    }
    const win = withinActiveWindow(t, g.activeHours, g.activeDays);
    if (!win.within && win.nextOpen > t) {
      t = driftPastOpen(win.nextOpen);
      moved = true;
    }
    // A full day hands the candidate to the next one, just past its opening.
    if (g.dailyCap > 0) {
      const day = workDay(t, g.activeHours, g.activeDays);
      if (countInDay(sent, day) >= g.dailyCap) {
        t = driftPastOpen(day.next);
        moved = true;
      }
    }
    if (org) {
      if (org.gapMs > 0) {
        const prev = latestAtOrBefore(org.sent, t);
        if (prev != null && t < prev + org.gapMs) {
          t = prev + org.gapMs;
          moved = true;
        }
        // Forward conflict: day-plan anchors are independent per campaign, so a
        // candidate can land just BEFORE a sibling campaign's slot — hop past it.
        const next = earliestAfter(org.sent, t);
        if (next != null && next - t < org.gapMs) {
          t = next + org.gapMs;
          moved = true;
        }
      }
      if (org.dailyCap > 0) {
        const day = workDay(t, g.activeHours, g.activeDays);
        if (countInDay(org.sent, day) >= org.dailyCap) {
          t = driftPastOpen(day.next);
          moved = true;
        }
      }
    }
    if (!moved) return t;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Slot assignment (the PLAN side)
// ---------------------------------------------------------------------------

export type SlotItem = {
  messageId: number;
  kind: Message["kind"];
  /** For comments: when the action target post was published (age-out math). */
  targetPostedAt?: number | null;
};

export type AssignedSlot = {
  messageId: number;
  scheduledAt: number;
  /** The slot falls past the campaign's maxPostAgeDays for this post. Advisory
   *  only — the freshness window binds at triage and draft selection, so the
   *  row still sends; it just lands stale. Surface it so the submitter knows. */
  willAgeOut: boolean;
};

/** Replies answer a live conversation — pace them promptly but variably (the
 *  floor is usually the org min-action gap; 1.8× this is the jitter ceiling). */
const REPLY_AVG_GAP_MS = 3 * 60_000;

/** One human-random gap: uniform in [floor, max(floor, 1.8×avg)]. Used by the
 *  reply lane and as the comment lane's fallback when the day-plan walker finds
 *  no anchor (pathological batch vs caps); `rng` is injectable for tests. */
function jitterGap(floorMs: number, avgMs: number, rng: () => number): number {
  const maxMs = Math.max(floorMs, Math.floor(1.8 * avgMs));
  return Math.floor(floorMs + rng() * (maxMs - floorMs));
}

// ---------------------------------------------------------------------------
// The human-day plan: comments follow a realistic daily rhythm, not a drizzle.
// A day is 1–3 committed SESSIONS (a burst of comments minutes apart — "I sat
// down to do LinkedIn") plus scattered DRIVE-BY SINGLES ("a post popped into my
// feed"), inside the campaign's active hours; the day's total volume BREATHES
// between 55% and 100% of the (warm-up-adjusted) daily cap. The plan is
// deterministic per (org, campaign, local day) via a seeded PRNG — every
// submit/read that day derives the identical plan, no storage needed.
// ---------------------------------------------------------------------------

/** YYYY-MM-DD of `ms` in the campaign's timezone (en-CA formats ISO-style).
 *  Exported so day-scoped demand math (batch.ts) uses the SAME day boundary
 *  the plan seeds with. */
export function localDateStr(ms: number, tz: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

type DayWindow = { open: number; close: number };

/** The first activity of a day drifts past the window open — a fixed daily
 *  start time is its own bot signature. */
const FIRST_DRIFT_MAX_MS = 40 * 60_000;
/** A session must start early enough to finish before the window closes. */
const SESSION_TAIL_MS = 45 * 60_000;
const SESSION_GAP_MIN_MS = 2 * 60_000;
const SESSION_GAP_MAX_MS = 8 * 60_000;
/** Day volume breathes in [55%, 100%] of the effective daily cap. */
const DAY_VOLUME_MIN = 0.55;

/**
 * One local day's comment anchors (sorted ms timestamps). Deterministic for a
 * given (CHANNEL, window): the seed is the channel + local date, so every
 * campaign feeding one account draws the SAME day plan and an anchor one
 * campaign's slot holds is consumed for the other (INV-4). The window and its
 * timezone are the account's too, so one row answers both.
 */
function planDayAnchors(opts: {
  channel: Channel;
  window: DayWindow;
  effDaily: number;
  floorGapMs: number;
}): number[] {
  const w = opts.window;
  const span = w.close - w.open;
  if (span <= 0 || opts.effDaily <= 0) return [];
  const mid = w.open + span / 2;
  const rng = mulberry32(
    fnvHash(
      `${opts.channel.id}:${localDateStr(mid, opts.channel.activeHours?.tz)}`,
    ),
  );

  const target = Math.max(1, Math.round(opts.effDaily * (DAY_VOLUME_MIN + rng() * (1 - DAY_VOLUME_MIN))));
  const usableOpen = w.open + rng() * Math.min(FIRST_DRIFT_MAX_MS, span / 4);

  const anchors: number[] = [];
  let remaining = target;
  // A human session: sat down and commented on a handful of posts, minutes apart.
  const maxSession = 5;
  const sessions = 1 + Math.floor(rng() * 3); // 1..3 committed sessions
  for (let s = 0; s < sessions && remaining >= 2 && maxSession >= 2; s++) {
    const size = Math.min(remaining, 2 + Math.floor(rng() * (maxSession - 1)));
    const latestStart = w.close - SESSION_TAIL_MS;
    if (latestStart <= usableOpen) break;
    let t = usableOpen + rng() * (latestStart - usableOpen);
    for (let i = 0; i < size; i++) {
      anchors.push(Math.round(t));
      t += Math.max(
        opts.floorGapMs,
        SESSION_GAP_MIN_MS + rng() * (SESSION_GAP_MAX_MS - SESSION_GAP_MIN_MS),
      );
    }
    remaining -= size;
  }
  // Drive-by singles for whatever the sessions didn't consume.
  while (remaining > 0) {
    anchors.push(Math.round(usableOpen + rng() * (w.close - usableOpen)));
    remaining--;
  }

  anchors.sort((a, b) => a - b);
  // Enforce the pairwise floor by nudging forward; drop what falls off the day.
  const out: number[] = [];
  for (const a of anchors) {
    const t = out.length > 0 ? Math.max(a, out[out.length - 1]! + opts.floorGapMs) : a;
    if (t < w.close) out.push(t);
  }
  return out;
}

/**
 * Where the open window's MISSED volume goes: the plan's anchors that passed
 * with nothing approved to send. The day's volume is the plan's, not its
 * anchors' — an owner who approves a batch at 17:36 has the rest of the day,
 * not just the anchors still ahead of it. What is owed is exactly what the
 * window has neither spent (`held`: the lane's sends and slots inside it) nor
 * still has free ahead (`free`), so the day's total stays the plan's count.
 *
 * Each point goes into the widest gap left in `[now, close)` between what is
 * fixed, jittered inside it, so the made-up volume spreads over the rest of the
 * day as drive-by singles instead of queueing behind `now`. Seeded per
 * (channel, local day) like the plan itself; the caller's gates still decide
 * whether a point fits, and one that does not fit before close is not owed today.
 */
function makeUpPoints(opts: {
  channel: Channel;
  window: DayWindow;
  anchors: number[];
  held: number[];
  free: number[];
  now: number;
}): number[] {
  const w = opts.window;
  const owed = opts.anchors.length - opts.held.length - opts.free.length;
  const start = Math.max(opts.now, w.open);
  if (owed <= 0 || start >= w.close) return [];
  const rng = mulberry32(
    fnvHash(
      `${opts.channel.id}:${localDateStr(w.open + (w.close - w.open) / 2, opts.channel.activeHours?.tz)}:make-up`,
    ),
  );
  const fixed = [...opts.held, ...opts.free].filter((t) => t >= start && t < w.close);
  fixed.sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < owed; i++) {
    let from = start;
    let widest = { from: start, span: -1 };
    for (const t of [...fixed, w.close]) {
      if (t - from > widest.span) widest = { from, span: t - from };
      from = t;
    }
    const point = Math.round(widest.from + widest.span * (0.3 + 0.4 * rng()));
    insertSorted(fixed, point);
    out.push(point);
  }
  return out.sort((a, b) => a - b);
}

/**
 * How many days the always-open walk below will skip before concluding there is
 * nothing to walk. A bound, not a policy: `activeDays` holds weekday keys, so a
 * whole week without an allowed one means the row names days `DAY_KEYS` does not
 * have. The writer rejects that (`orgSettings.ts:141-145`), which is the only
 * reason this is unreachable — and exactly why it exists, because an unbounded
 * skip would HANG the walker on an unvalidated row where the scanner merely
 * degrades. Deleting it must be a deliberate act, so it has a name.
 */
const MAX_SKIPPED_DAYS = DAY_KEYS.length;

/**
 * Enumerate the account's open windows walking forward from `from` — one per
 * active day, DST-correct via activeWindowState's scanner. A 24/7 account plans
 * per calendar day: the rhythm still applies, there is just no sleep window (set
 * activeHours for that).
 *
 * A window that never closes takes its own branch, because `activeWindowState`
 * answers a different question than this one. It reports the contiguous open
 * PERIOD around an instant — a full scan horizon in each direction when nothing
 * ever closes — while `planDayAnchors` above distributes ONE day's volume into
 * whatever window it is handed, so the scanner's answer spread a single day's
 * comments across sixteen days. Both spellings of 24/7 come here: no
 * `activeHours` at all, and the `start == end` that `time.ts` degenerates to
 * always-open, which is the only 24/7 the safety form can express.
 *
 * `activeDays` binds exactly where the send gate binds it — with `activeHours`
 * present, never without (`time.ts:136-143` returns before it looks) — so the
 * plan can be neither stricter nor looser than what `canEngage` will pass. A
 * null window carries no timezone either, and UTC is all it ever had.
 */
function* dayWindows(c: Channel, from: number): Generator<DayWindow> {
  if (isAlwaysOpen(c.activeHours)) {
    const tz = c.activeHours?.tz || "UTC";
    const days = c.activeHours ? c.activeDays : null;
    let day = localDay(from, tz);
    let skipped = 0;
    while (skipped <= MAX_SKIPPED_DAYS) {
      const next = localDay(day.start + 36 * HOUR, tz);
      if (isAllowedDay(day.day, days)) {
        yield { open: day.start, close: next.start };
        skipped = 0;
      } else skipped++;
      day = next;
    }
    return;
  }
  let probe = from;
  for (;;) {
    const st = activeWindowState(probe, c.activeHours, c.activeDays);
    yield { open: st.openedAt, close: st.nextClose };
    probe = st.nextClose + 5 * 60_000;
  }
}

/** How far ahead the anchor walker searches before falling back to jitterGap. */
const PLAN_HORIZON_DAYS = 21;

/** The comment lane's pairwise floor. MUST stay the single source for both
 *  assignSlots and the runner work order — if these diverge, the work order's
 *  anchor count no longer matches what assignment will actually produce. Both
 *  spacings are the account's, so one row is the whole input. */
export function commentFloorGapMs(c: Channel): number {
  return Math.max(
    Math.max(c.minDelaySec, 30) * 1000,
    c.minActionGapSec * 1000,
    MIN_FLOOR_MS,
  );
}

/** Anchors of the deterministic human-day plan falling in [from, to). Pure —
 *  the plan is seeded per (CHANNEL, local day), so the same range always yields
 *  the same anchors for every campaign on that account. Used by the runner work
 *  order to size a wake window; pass the same channel/effDaily/floorGapMs
 *  assignSlots would use. */
export function anchorsInRange(
  c: Channel,
  opts: {
    from: number;
    to: number;
    effDaily: number;
    floorGapMs: number;
  },
): number[] {
  const out: number[] = [];
  const limit = opts.from + PLAN_HORIZON_DAYS * DAY;
  for (const w of dayWindows(c, opts.from)) {
    if (w.open >= opts.to || w.open > limit) break;
    const anchors = planDayAnchors({
      channel: c,
      window: w,
      effDaily: opts.effDaily,
      floorGapMs: opts.floorGapMs,
    });
    for (const a of anchors) if (a >= opts.from && a < opts.to) out.push(a);
  }
  return out;
}

/**
 * THE REST OF THE ACCOUNT'S DAY, as `assignSlots` will spend it on unattended
 * comments: the plan's anchors still ahead in the window it is spending (or
 * the next one, before it opens) and the make-up for volume that passed with
 * nothing sent (`makeUpPoints`). The same window, plan, inputs and make-up
 * assignment reaches for, read without a write. `close` is where that day
 * ends, so a reader walking further picks the plan up there.
 *
 * Counted as if no committed worker comment held any of it. Those rows
 * are supply, and every reader of the plan subtracts supply by count
 * (`committedWorkerSupply`): a row slotted in the window holds one of
 * these slots, and a slotless one takes one the moment it slots. Everything
 * else the window holds — what already went out, whoever wrote it, and the
 * owner's own approved sends — is what the day's volume is net of, as
 * `assignSlots` holds it.
 *
 * Times, never gate-checked: the caps, the gaps and the window bind at
 * assignment and again at send, so a slot here is room in the plan, not a
 * send time.
 */
export async function restOfDayPlan(
  tx: Tx,
  channel: Channel,
  now: number,
): Promise<{ slots: number[]; close: number }> {
  const [window] = dayWindows(channel, now);
  if (!window) return { slots: [], close: now };
  const anchors = planDayAnchors({
    channel,
    window,
    effDaily: pacingPolicy(channel, "worker", now).commentDailyCap,
    floorGapMs: commentFloorGapMs(channel),
  });
  const inWindow = and(gte(messages.scheduledAt, window.open), lt(messages.scheduledAt, window.close));
  const pending = await tx
    .select({ ts: messages.scheduledAt })
    .from(messages)
    .where(
      and(
        inArray(messages.status, ["approved", "posting"]),
        inArray(messages.kind, ["comment", "room_reply"]),
        or(ne(messages.kind, "comment"), ne(messages.publishOrigin, "worker")),
        inWindow,
      ),
    );
  const held = [
    ...(await ledgerDayTs(tx, ["comment", "room_reply"], window.open)).filter((t) => t < window.close),
    ...pending.map((p) => p.ts!),
  ];
  const free = anchors.filter((a) => a >= now);
  const madeUp = makeUpPoints({ channel, window, anchors, held, free, now });
  return { slots: [...free, ...madeUp].sort((a, b) => a - b), close: window.close };
}

/**
 * Assign persisted send slots to newly-approved messages, appending after
 * everything already planned or sent: comments consume the human-day plan's
 * anchors (sessions + singles + breathing volume), replies keep a prompt
 * jittered lane. Runs inside the caller's org-scoped tx; a per-org advisory
 * xact lock serializes concurrent assignments so two submits can't both plan
 * from the same "last slot". Honors every gate the publisher enforces (caps ×
 * warm-up, active hours, org ceilings) at assignment — and canEngage re-checks
 * them all at send time, so a stale plan degrades safely.
 */
export async function assignSlots(
  tx: Tx,
  opts: {
    campaign: Campaign;
    items: SlotItem[];
    /** `messages.origin` for this batch — who authorized these sends. Owner
     *  saves are slotted one at a time; worker output arrives in batches,
     *  so one origin per call is the real shape. Omitted defaults to
     *  "worker", the paced branch, so a caller that forgets fails closed. */
    origin?: SendOrigin;
    now?: number;
    /** Deterministic randomness for tests; defaults to Math.random. */
    rng?: () => number;
  },
): Promise<AssignedSlot[]> {
  if (opts.items.length === 0) return [];
  const c = opts.campaign;
  const now = opts.now ?? Date.now();
  const rng = opts.rng ?? Math.random;
  const origin = opts.origin ?? "worker";

  // Every org has this row (migration seed / bootstrapLocalOrg). Its absence is
  // a broken install, and slotting nothing is the fail-closed answer: an
  // unpaced send is the one outcome this function must never produce.
  const channel = await channelCeilings(tx);
  if (!channel) return [];

  // Keyed on the CHANNEL, not the org. A narrowing: identical behavior while
  // one org has one account, and the day two do, planning on one stops
  // serializing against planning on the other.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('slots:' || ${channel.id}))`,
  );

  // Which volume controls bind is the SEND's call (pacingPolicy): an
  // owner-authored batch plans a pure min-gap chain — cap 0 (uncapped),
  // window null (24/7), no account daily ceiling, no human-day anchors.
  // Unattended work keeps the ramped caps (comment lane honors the absolute
  // warm-up start rate; the reply lane keeps the ratio ramp) and the window.
  const policy = pacingPolicy(channel, origin, now);
  const effComment = policy.commentDailyCap;
  const effReply = policy.replyDailyCap;
  const orgGapMs = channel.minActionGapSec * 1000;
  // The window the plan is spending now (or the next one, before it opens).
  // Its sends are what a make-up is net of, and a window can run past a day —
  // a 25-hour local day, a window that closes a minute before it opens.
  const [firstWindow] = dayWindows(channel, now);
  const since = Math.min(now - DAY, firstWindow?.open ?? now);

  // Already-planned slots consume caps and pace the lanes exactly like real
  // sends. The day the caps count, and the trailing one the spacing looks back
  // over, + everything still in the future.
  const pending = await tx
    .select({
      ts: messages.scheduledAt,
      campaignId: messages.campaignId,
      kind: messages.kind,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.status, ["approved", "posting"]),
        isNotNull(messages.scheduledAt),
        gte(messages.scheduledAt, since),
      ),
    );

  // Every approved/posting slot and every ledger send ON THE ACCOUNT, not just
  // this campaign's. That is what makes an anchor another campaign's slot holds
  // actually consumed here, instead of two campaigns each planning onto their
  // own copy of one list.
  const laneSent = async (kind: "comment" | "reply"): Promise<number[]> => {
    const arr = [
      ...(await ledgerDayTs(tx, kind === "comment" ? ["comment", "room_reply"] : ["reply"], since)),
      ...pending.filter((p) => (p.kind === "room_reply" ? "comment" : p.kind) === kind).map((p) => p.ts!),
    ];
    arr.sort((a, b) => a - b);
    return arr;
  };

  const floorGapMs = commentFloorGapMs(channel);
  // Fallback spacing (anchor walker exhausted its horizon — pathological batch):
  // spread the day's volume across the active window rather than inventing a
  // grid. Curate has no window and no cap — its spacing IS the floor gap.
  const windowSpanMs = firstWindow ? firstWindow.close - firstWindow.open : DAY;
  const lanes = {
    comment: {
      sent: await laneSent("comment"),
      gates: {
        minGap: floorGapMs,
        dailyCap: effComment,
        activeHours: policy.activeHours,
        activeDays: policy.activeDays,
      } satisfies Gates,
      avgGapMs: policy.useDayPlanAnchors
        ? Math.max(
            floorGapMs,
            Math.floor(windowSpanMs / Math.max(1, effComment)),
          )
        : floorGapMs,
    },
    reply: {
      sent: await laneSent("reply"),
      gates: {
        minGap: floorGapMs,
        dailyCap: effReply,
        activeHours: policy.activeHours,
        activeDays: policy.activeDays,
      } satisfies Gates,
      avgGapMs: Math.max(floorGapMs, REPLY_AVG_GAP_MS),
    },
  };
  const orgSent = [
    ...(await ledgerDayTs(tx, ["comment", "reply", "room_reply"], since)),
    ...pending.map((p) => p.ts!),
  ];
  orgSent.sort((a, b) => a - b);
  const orgLane: OrgLane = {
    gapMs: orgGapMs,
    dailyCap: policy.channelDailyCapApplies ? channel.dailyEngageCap : 0,
    sent: orgSent,
  };

  // Comments follow the human-day plan: the next unconsumed anchor strictly
  // after everything already sent/planned. No bookkeeping needed — lanes append
  // after their max, so earlier slots (and real ledger sends) sit on or past
  // their anchors and "first anchor > last" naturally skips them.
  const planCache = new Map<number, number[]>();
  const planFor = (w: DayWindow): number[] => {
    let anchors = planCache.get(w.open);
    if (!anchors) {
      anchors = planDayAnchors({
        channel,
        window: w,
        effDaily: effComment,
        floorGapMs,
      });
      planCache.set(w.open, anchors);
    }
    return anchors;
  };
  const nextAnchor = (after: number): number | null => {
    const limit = now + PLAN_HORIZON_DAYS * DAY;
    for (const w of dayWindows(channel, Math.max(now, after))) {
      if (w.open > limit) return null;
      for (const a of planFor(w)) if (a > after && a >= now) return a;
    }
    return null;
  };
  // The open window's missed volume, as the earliest made-up slot that clears
  // every gate before the window closes — or null when nothing is owed or
  // nothing owed still fits today.
  const makeUpSlot = (sent: number[], gates: Gates): number | null => {
    if (!firstWindow) return null;
    const anchors = planFor(firstWindow);
    const points = makeUpPoints({
      channel,
      window: firstWindow,
      anchors,
      held: sent.filter((t) => t >= firstWindow.open && t < firstWindow.close),
      free: anchors.filter((a) => a >= now && nextClearSlot(a, sent, gates, orgLane) === a),
      now,
    });
    for (const point of points) {
      const t = nextClearSlot(point, sent, gates, orgLane);
      if (t < firstWindow.close) return t;
    }
    return null;
  };

  const out: AssignedSlot[] = [];
  for (const item of opts.items) {
    const laneKind = item.kind === "room_reply" ? "comment" : item.kind;
    const lane = lanes[laneKind];
    const last = lane.sent[lane.sent.length - 1] ?? 0;
    const fallback = Math.max(now, last > 0 ? last + jitterGap(floorGapMs, lane.avgGapMs, rng) : now);
    // Comments take the EARLIEST FREE anchor from now forward — an anchor already
    // held by a planned slot (or one the gates move off its time) is skipped, so
    // capacity vacated by posted/unqueued/re-planned messages refills instead of
    // every new item appending after a possibly far-future tail (one stale slot
    // must not drag the whole queue days out). One deliberate exception: a
    // COLD-START lane (nothing sent or planned in the trailing day) posts its
    // first item promptly — a human who just set this up / just submitted is at
    // the keyboard right now, and instant first feedback matters. Everything
    // after joins the plan. A made-up slot earlier than that anchor wins: the
    // day's missed volume goes out today before the plan reaches for tomorrow.
    let at: number | null = null;
    if (laneKind === "comment" && last > 0 && policy.useDayPlanAnchors) {
      for (let a = nextAnchor(0); a != null; a = nextAnchor(a)) {
        if (nextClearSlot(a, lane.sent, lane.gates, orgLane) === a) {
          at = a;
          break;
        }
      }
      const madeUp = makeUpSlot(lane.sent, lane.gates);
      if (madeUp != null && (at == null || madeUp < at)) at = madeUp;
    }
    at ??= nextClearSlot(
      laneKind === "comment" && last === 0 ? now : fallback,
      lane.sent,
      lane.gates,
      orgLane,
    );
    insertSorted(lane.sent, at);
    insertSorted(orgSent, at);
    const willAgeOut =
      item.kind === "comment" &&
      c.maxPostAgeDays > 0 &&
      item.targetPostedAt != null &&
      at - item.targetPostedAt > c.maxPostAgeDays * DAY;
    out.push({ messageId: item.messageId, scheduledAt: at, willAgeOut });
    await tx
      .update(messages)
      .set({ scheduledAt: at })
      .where(eq(messages.id, item.messageId));
  }
  return out;
}

/**
 * A SEND THE PAUSE HOLDS (owner decision, 2026-10-13): an approved UNATTENDED
 * message on a Paused campaign takes no slot, never fails for the pause, and
 * goes out after the Resume, which plans it (`scheduleHeldSends`). The send
 * gate's own `campaign_paused` is a re-plan onto the account's next slot every
 * half hour, which kept an anchor of the day plan and a time on the row that
 * was never true; nothing offers a held send to the gate. Its post job finds
 * it held and looks again later, with no refusal, because nothing is wrong
 * with the send.
 *
 * Not the owner's own: Pause only stops new runs (founder rule, 2026-10-15),
 * so a message the owner wrote, or rewrote before approving, takes its slot
 * and goes out under the pause, spaced like any of theirs. Their Stop
 * sending, the account's Stop and the kill switch still hold it at the gate.
 */
export function heldForResume(
  message: Pick<Message, "status" | "publishOrigin">,
  campaign: Pick<Campaign, "status">,
): boolean {
  return message.status === "approved" && campaign.status === "paused" && message.publishOrigin === "worker";
}

/** How many sends each of these campaigns' pause holds (`heldForResume`),
 *  for the campaigns that hold any: what the pause owes its Resume. */
export async function countHeldSends(tx: Tx, campaignIds: readonly number[]): Promise<Map<number, number>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await tx
    .select({ campaignId: messages.campaignId, held: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .where(
      and(
        inArray(messages.campaignId, [...campaignIds]),
        eq(campaigns.status, "paused"),
        eq(messages.status, "approved"),
        eq(messages.publishOrigin, "worker"),
      ),
    )
    .groupBy(messages.campaignId);
  return new Map(rows.map((row) => [row.campaignId!, row.held]));
}

/**
 * Plan what the pause held, now that the campaign runs again: its approved
 * messages with no slot (approved while it was paused) or a slot the pause let
 * pass. A passed slot is cleared first, so the plan does not count it spent;
 * each origin is planned under its own pacing, as at approval. The account's
 * drain is woken to meet each one at its new slot. How many it planned.
 */
export async function scheduleHeldSends(
  tx: Tx,
  campaign: Campaign,
  now: number = Date.now(),
): Promise<number> {
  const held = await tx
    .select({
      id: messages.id,
      kind: messages.kind,
      publishOrigin: messages.publishOrigin,
      targetPostedAt: discoveredPosts.postedAt,
    })
    .from(messages)
    .leftJoin(discoveredPosts, eq(discoveredPosts.id, messages.discoveredPostId))
    .where(
      and(
        eq(messages.campaignId, campaign.id),
        eq(messages.status, "approved"),
        or(isNull(messages.scheduledAt), lte(messages.scheduledAt, now)),
      ),
    )
    .orderBy(asc(messages.id));
  if (held.length === 0) return 0;
  await tx
    .update(messages)
    .set({ scheduledAt: null })
    .where(inArray(messages.id, held.map((message) => message.id)));
  for (const origin of ["owner", "worker"] as const) {
    await assignSlots(tx, {
      campaign,
      origin,
      now,
      items: held
        .filter((message) => message.publishOrigin === origin)
        .map((message) => ({
          messageId: message.id,
          kind: message.kind,
          targetPostedAt: message.targetPostedAt,
        })),
    });
  }
  if (campaign.channelId !== null) await enqueueActionDispatch(tx, campaign.channelId, now);
  return held.length;
}

export async function projectSchedule(
  tx: Tx,
  opts: { windowHours?: number; campaignId?: number; now?: number } = {},
): Promise<ScheduleProjection> {
  const now = opts.now ?? Date.now();
  const windowHours = Math.min(168, Math.max(1, opts.windowHours ?? 24));
  const windowEnd = now + windowHours * HOUR;

  const campaignRows = await tx
    .select()
    .from(campaigns)
    .where(
      opts.campaignId != null
        ? eq(campaigns.id, opts.campaignId)
        : eq(campaigns.status, "active"),
    );

  // ONE policy pair for the ACCOUNT, not one per campaign row: every number
  // `pacingPolicy` reads now lives on the channel, so a per-campaign pair would
  // be the same pair computed N times.
  const channel = await channelCeilings(tx);
  if (!channel) {
    return {
      generatedAt: now,
      windowHours,
      items: [],
      beyondWindow: 0,
      agingOutRisk: 0,
      note: NOTE,
    };
  }
  const byOrigin = {
    owner: pacingPolicy(channel, "owner", now),
    worker: pacingPolicy(channel, "worker", now),
  } as const;
  // The account's, like the policy pair: one spacing floor for every campaign
  // row below.
  const floorGap = Math.max(
    Math.max(channel.minDelaySec, 30) * 1000,
    MIN_FLOOR_MS,
  );
  // The owner's day, which the caps count, can open more than 24 hours back.
  const since = Math.min(now - DAY, workDay(now, channel.activeHours, channel.activeDays).open);
  const projected: ScheduleItem[] = [];
  // Whether the org daily ceiling shifts each ITEM, for the cross-campaign
  // pass below. Per message, not per campaign: one campaign can hold both
  // owner-authored rows (spacing only) and worker rows (fully paced), and
  // a per-campaign answer would have to lie about one of them.
  const orgCapApplies = new Map<number, boolean>();

  for (const c of campaignRows) {
    // Approved comments (FIFO by createdAt — the paced publisher drains in order).
    const commentRows = await tx
      .select({
        id: messages.id,
        kind: messages.kind,
        publishOrigin: messages.publishOrigin,
        commentType: messages.commentType,
        text: messages.proposedText,
        finalText: messages.finalText,
        createdAt: messages.createdAt,
        scheduledAt: messages.scheduledAt,
        author: sql<string | null>`case when ${messages.kind} = 'comment' then ${discoveredPosts.authorName}
          when ${messages.roomReplyTarget}->>'source' = 'lead'
            then (select name from lead_signals where id = (${messages.roomReplyTarget}->>'signalId')::bigint)
          else (select name from room_members where id = (${messages.roomReplyTarget}->>'roomMemberId')::bigint) end`,
        // A reply under a lead's comment has no post row: its words and its
        // post are the signal's and the campaign's.
        postText: sql<string | null>`case when ${messages.roomReplyTarget}->>'source' = 'lead'
          then (select words from lead_signals where id = (${messages.roomReplyTarget}->>'signalId')::bigint)
          else ${discoveredPosts.contentText} end`,
        postedAt: discoveredPosts.postedAt,
        postUrn: sql<string | null>`case when ${messages.roomReplyTarget}->>'source' = 'lead'
          then ${messages.roomReplyTarget}->>'postUrn' else ${discoveredPosts.postUrn} end`,
        postLink: discoveredPosts.url,
      })
      .from(messages)
      .leftJoin(discoveredPosts, sql`${discoveredPosts.id} = coalesce(${messages.discoveredPostId},
        case when ${messages.kind} = 'room_reply' then (${messages.roomReplyTarget}->>'discoveredPostId')::bigint end)`)
      .where(
        and(
          eq(messages.campaignId, c.id),
          inArray(messages.kind, ["comment", "room_reply"]),
          eq(messages.status, "approved"),
        ),
      )
      .orderBy(asc(messages.createdAt));

    const replyRows = await tx
      .select({
        id: messages.id,
        publishOrigin: messages.publishOrigin,
        text: messages.proposedText,
        finalText: messages.finalText,
        createdAt: messages.createdAt,
        scheduledAt: messages.scheduledAt,
        author: incomingComments.authorName,
        incomingText: incomingComments.text,
        ownPostUrn: incomingComments.ownPostUrn,
      })
      .from(messages)
      .leftJoin(incomingComments, eq(messages.incomingCommentId, incomingComments.id))
      .where(
        and(
          eq(messages.campaignId, c.id),
          eq(messages.kind, "reply"),
          eq(messages.status, "approved"),
        ),
      )
      .orderBy(asc(messages.createdAt));

    // Seed with the ACCOUNT's real ledger state so the first slot respects what
    // already posted this hour/today — the same set `assignSlots` now consumes,
    // so a projection cannot disagree with the plan it is projecting. Stored
    // slots join the lanes up front: slotless legacy rows must simulate AROUND
    // the committed plan.
    const commentSent = await ledgerDayTs(tx, ["comment", "room_reply"], since);
    const replySent = await ledgerDayTs(tx, ["reply"], since);
    for (const m of commentRows) if (m.scheduledAt != null) insertSorted(commentSent, m.scheduledAt);
    for (const m of replyRows) if (m.scheduledAt != null) insertSorted(replySent, m.scheduledAt);

    /** This row's gates, from this row's provenance. Min-gap is unconditional. */
    const gatesFor = (
      origin: SendOrigin,
      lane: "comment" | "reply",
    ): Gates => {
      const policy = byOrigin[origin];
      return {
        minGap: floorGap,
        dailyCap:
          lane === "comment" ? policy.commentDailyCap : policy.replyDailyCap,
        activeHours: policy.activeHours,
        activeDays: policy.activeDays,
      };
    };

    for (const m of commentRows) {
      const scheduled = m.scheduledAt != null;
      const at = scheduled
        ? m.scheduledAt!
        : nextClearSlot(
            now,
            commentSent,
            gatesFor(m.publishOrigin, "comment"),
          );
      if (!scheduled) insertSorted(commentSent, at);
      orgCapApplies.set(m.id, byOrigin[m.publishOrigin].channelDailyCapApplies);
      const willAgeOut =
        c.maxPostAgeDays > 0 &&
        m.postedAt != null &&
        at - m.postedAt > c.maxPostAgeDays * DAY;
      projected.push({
        source: scheduled ? "scheduled" : "projected",
        projectedAt: at,
        messageId: m.id,
        campaignId: c.id,
        campaignName: c.name,
        kind: m.kind,
        commentType: m.commentType,
        publishOrigin: m.publishOrigin,
        targetAuthor: m.author,
        targetSnippet: snippet(m.postText),
        targetUrl: m.postUrn ? linkedinPostUrl(m.postLink, m.postUrn) : null,
        draftPreview: snippet(m.finalText ?? m.text),
        willAgeOut,
      });
    }

    for (const m of replyRows) {
      const scheduled = m.scheduledAt != null;
      const at = scheduled
        ? m.scheduledAt!
        : nextClearSlot(now, replySent, gatesFor(m.publishOrigin, "reply"));
      if (!scheduled) insertSorted(replySent, at);
      orgCapApplies.set(m.id, byOrigin[m.publishOrigin].channelDailyCapApplies);
      projected.push({
        source: scheduled ? "scheduled" : "projected",
        projectedAt: at,
        messageId: m.id,
        campaignId: c.id,
        campaignName: c.name,
        kind: "reply",
        commentType: null,
        publishOrigin: m.publishOrigin,
        targetAuthor: m.author,
        targetSnippet: snippet(m.incomingText),
        targetUrl: m.ownPostUrn ? linkedinPostUrl(null, m.ownPostUrn) : null,
        draftPreview: snippet(m.finalText ?? m.text),
        willAgeOut: false,
      });
    }
  }

  // Org-level pass across campaigns: the account-wide min gap + daily ceiling
  // couple the per-campaign lanes (N campaigns share ONE LinkedIn account).
  // Persisted slots are NEVER shifted here (stable across reads — assignSlots
  // already walked the org lane); they only feed the state projections respect.
  projected.sort((a, b) => a.projectedAt - b.projectedAt);
  const orgGap = channel.minActionGapSec * 1000;
  const orgSent = await ledgerDayTs(tx, ["comment", "reply", "room_reply"], since);
  let prev = orgSent[orgSent.length - 1] ?? 0;
  for (const item of projected) {
    if (item.source === "scheduled") {
      insertSorted(orgSent, item.projectedAt);
      prev = Math.max(prev, item.projectedAt);
      continue;
    }
    let t = item.projectedAt;
    if (t < prev) t = prev; // keep the merged lane monotonic
    if (orgGap > 0 && prev > 0 && t < prev + orgGap) t = prev + orgGap;
    // The org daily ceiling binds Review/Auto sends only; the org min gap
    // above spaces everything, Curate included.
    if (channel.dailyEngageCap > 0 && orgCapApplies.get(item.messageId) !== false) {
      const day = workDay(t, channel.activeHours, channel.activeDays);
      if (countInDay(orgSent, day) >= channel.dailyEngageCap) t = driftPastOpen(day.next);
    }
    item.projectedAt = t;
    insertSorted(orgSent, t);
    prev = Math.max(prev, t);
  }

  const within = projected.filter((i) => i.projectedAt <= windowEnd);
  return {
    generatedAt: now,
    windowHours,
    items: within,
    beyondWindow: projected.length - within.length,
    agingOutRisk: projected.filter((i) => i.willAgeOut).length,
    note: NOTE,
  };
}

// Direct unit-test access to the day-plan generator (rhythm/breathing/determinism
// assertions without driving the whole assignSlots DB walk). `MAX_SKIPPED_DAYS`
// rides along so the walker's own bound is what a test bounds its take by.
export const __test = { planDayAnchors, makeUpPoints, nextClearSlot, dayWindows, MAX_SKIPPED_DAYS };
