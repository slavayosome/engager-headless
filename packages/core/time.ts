import type { ActiveHours } from "@engager/database/schema";

/** The day vocabulary `isAllowedDay` matches against. Exported so the writer
 *  that validates an `activeDays` patch names the SAME list the reader compares
 *  to: a hand-copied list that drifts lets a day name persist that can never
 *  match, which closes the window forever without raising anything. */
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * One formatter per timezone, for the life of the process.
 *
 * `Intl.DateTimeFormat` is stateless once built and its CONSTRUCTION is the
 * expensive half — and `activeWindowState` below scans in five-minute steps
 * across eight days, so a formatter built per step made one window question
 * cost 2304 of them. Measured at 5.3ms per `withinActiveWindow` call, which
 * `assignSlots` then pays up to sixty times per item inside `nextClearSlot`'s
 * fixed point: the account's day plan took a fifth of a second to walk, a
 * saturated-cap assignment took seconds, and a suite test tipped over vitest's
 * five-second budget often enough to read as a flake. `canEngage` pays it on
 * every send, too.
 *
 * Unbounded by design: the key space is IANA timezone names actually stored on
 * a `channels` row, which is one per install and a handful per host.
 */
const tzFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = tzFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    tzFormatters.set(tz, fmt);
  }
  return fmt;
}

function partsInTz(ts: number, tz: string): { minutesOfDay: number; day: string } {
  const fmt = formatterFor(tz);
  let hour = 0;
  let minute = 0;
  let day = "mon";
  for (const p of fmt.formatToParts(new Date(ts))) {
    if (p.type === "hour") hour = parseInt(p.value, 10) % 24;
    else if (p.type === "minute") minute = parseInt(p.value, 10);
    else if (p.type === "weekday") day = p.value.slice(0, 3).toLowerCase();
  }
  return { minutesOfDay: hour * 60 + minute, day };
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * The local calendar day containing `ts` in `tz`: the instant it begins and the
 * `DAY_KEYS` name it falls on. The day planner needs both — the boundary to cut
 * one window per day out of a window that never closes, the name to drop the
 * days `activeDays` excludes.
 *
 * Two probes rather than offset arithmetic. Subtracting the local minutes-of-day
 * lands on midnight only when no DST shift sits between it and `ts`, so the
 * second probe reads where that landed and corrects: a small minutes-of-day is
 * past midnight, a large one is the evening before. A day whose midnight does
 * not exist at all (a shift AT midnight — São Paulo before 2019) resolves to the
 * day's first existing instant, which is what its start means there.
 */
export function localDay(ts: number, tz: string): { start: number; day: string } {
  let start = Math.floor(ts / 60_000) * 60_000 - partsInTz(ts, tz).minutesOfDay * 60_000;
  let landed = partsInTz(start, tz);
  if (landed.minutesOfDay !== 0) {
    const drift =
      landed.minutesOfDay > 12 * 60 ? landed.minutesOfDay - 24 * 60 : landed.minutesOfDay;
    start -= drift * 60_000;
    landed = partsInTz(start, tz);
  }
  return { start, day: landed.day };
}

/**
 * The wall-clock time `ts` shows in `tz`, as `HH:MM` — how the account's window
 * is said back to the owner ("opens at 09:00"). Read through the formatter the
 * window check itself uses, so the time named is the time it opens at.
 */
export function localClock(ts: number, tz: string): string {
  const { minutesOfDay } = partsInTz(ts, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutesOfDay / 60))}:${pad(minutesOfDay % 60)}`;
}

export function isAllowedDay(day: string, activeDays?: string[] | null): boolean {
  if (!activeDays || activeDays.length === 0) return true;
  return activeDays.map((d) => d.toLowerCase()).includes(day);
}

const STEP_MS = 5 * 60 * 1000;
// Scan horizon: 8 days of 5-minute steps. Long enough to find the next open/close
// across a multi-day activeDays gap (e.g. a Mon–Fri campaign on a Friday night).
const SCAN_STEPS = (8 * 24 * 60) / 5;
const SCAN_HORIZON_MS = SCAN_STEPS * STEP_MS;

export type ActiveWindowState = {
  /** Whether `now` is inside the active hours/days window. */
  within: boolean;
  /** When `within`, equals `now`; otherwise the next instant the window opens. */
  nextOpen: number;
  /** The next instant the window closes (from `now` when within, else after `nextOpen`). */
  nextClose: number;
  /** The instant the CURRENT (or upcoming) open window began — the gather clock's
   *  origin. When `within`, the start of this contiguous open period; when
   *  outside, equals `nextOpen` (the upcoming open). */
  openedAt: number;
};

/**
 * Whether these hours never close — no window at all, or the degenerate
 * `start == end` spelling the scanner below reads as 24/7.
 *
 * Exported because the day planner cannot use the scanner's answer for such a
 * window (one open period a full horizon wide, where it needs a day) and must
 * cut its own — and the rule that makes a window always-open belongs beside the
 * scanner that applies it, not re-derived from HH:MM strings at a call site.
 */
export function isAlwaysOpen(activeHours?: ActiveHours | null): boolean {
  if (!activeHours) return true;
  return hhmmToMinutes(activeHours.start) === hhmmToMinutes(activeHours.end);
}

/**
 * The first instant in `(lo, hi]` where `check` reads what it reads at `hi`,
 * given that it reads the opposite at `lo`. The scan below only brackets an
 * edge to its 5-minute step; every edge it reports is bisected to the instant
 * itself, because a bracketed edge lands at the caller's phase on that grid —
 * and the day planner seeds a whole day's anchors off `openedAt`/`nextClose`,
 * so two reads seconds apart drew two different plans.
 */
function edgeBetween(lo: number, hi: number, check: (ts: number) => boolean): number {
  const want = check(hi);
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (check(mid) === want) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Full active-window state in the campaign's timezone, scanned in 5-minute steps
 * and each edge bisected exact (DST-correct without manual offset math). Powers the capacity planner's gather
 * clock (`openedAt`) and the dashboard card (`nextOpen`/`nextClose`). With no
 * `activeHours` the window is always open: `openedAt` is set a full scan-horizon in
 * the past so the gather TIME gate always clears (a 24/7 campaign has no daily
 * window reset to wait on).
 */
export function activeWindowState(
  now: number,
  activeHours?: ActiveHours | null,
  activeDays?: string[] | null,
): ActiveWindowState {
  if (!activeHours) {
    return {
      within: true,
      nextOpen: now,
      nextClose: now + SCAN_HORIZON_MS,
      openedAt: now - SCAN_HORIZON_MS,
    };
  }
  const tz = activeHours.tz || "UTC";
  const start = hhmmToMinutes(activeHours.start);
  const end = hhmmToMinutes(activeHours.end);
  // end <= start wraps past midnight: "22:00"→"06:00" spans two calendar days,
  // and end "00:00" means "until end of day" (a plain `< 0` would make the
  // window NEVER open — every send bounces and the day planner degrades to one
  // 8-day pseudo-window). start == end degenerates to always-open (24/7).
  // Note the day check uses the CURRENT calendar day: a wrapped Fri 22:00–06:00
  // window's after-midnight tail counts as Saturday for activeDays purposes.
  const wraps = end <= start;

  const check = (ts: number): boolean => {
    const { minutesOfDay, day } = partsInTz(ts, tz);
    if (!isAllowedDay(day, activeDays)) return false;
    return wraps
      ? minutesOfDay >= start || minutesOfDay < end
      : minutesOfDay >= start && minutesOfDay < end;
  };

  if (check(now)) {
    // Inside the window: scan BACK for the open instant, FORWARD for the close.
    let openedAt = now;
    for (let i = 1; i <= SCAN_STEPS; i++) {
      const ts = now - i * STEP_MS;
      if (!check(ts)) {
        openedAt = edgeBetween(ts, openedAt, check);
        break;
      }
      openedAt = ts;
    }
    let nextClose = now + SCAN_HORIZON_MS;
    for (let i = 1; i <= SCAN_STEPS; i++) {
      const ts = now + i * STEP_MS;
      if (!check(ts)) {
        nextClose = edgeBetween(ts - STEP_MS, ts, check);
        break;
      }
    }
    return { within: true, nextOpen: now, nextClose, openedAt };
  }

  // Outside the window: find the next open, then the close after it.
  let nextOpen = now + 60 * 60 * 1000;
  for (let i = 1; i <= SCAN_STEPS; i++) {
    const ts = now + i * STEP_MS;
    if (check(ts)) {
      nextOpen = edgeBetween(ts - STEP_MS, ts, check);
      break;
    }
  }
  let nextClose = nextOpen + SCAN_HORIZON_MS;
  for (let i = 1; i <= SCAN_STEPS; i++) {
    const ts = nextOpen + i * STEP_MS;
    if (!check(ts)) {
      nextClose = edgeBetween(ts - STEP_MS, ts, check);
      break;
    }
  }
  return { within: false, nextOpen, nextClose, openedAt: nextOpen };
}

/**
 * The instant a local day whose midnight is `dayStart` reaches `minutes` past
 * it on the wall clock — offset arithmetic plus one probe, as `localDay` does,
 * so a DST shift between midnight and the opening lands on the clock time.
 */
function clockOnDay(dayStart: number, tz: string, minutes: number): number {
  const at = dayStart + minutes * 60_000;
  let drift = partsInTz(at, tz).minutesOfDay - minutes;
  if (drift > 12 * 60) drift -= 24 * 60;
  else if (drift < -12 * 60) drift += 24 * 60;
  return at - drift * 60_000;
}

/**
 * The day of the owner's hours that `ts` counts toward: from the latest
 * opening of their hours at or before it — on a day `activeDays` allows — to
 * the next one. A window's after-midnight tail and the night after it belong to
 * the day that opened last, so the owner's own sends there spend it too. Hours
 * that never close open at local midnight, the days the day plan cuts for them.
 *
 * Read off the wall clock rather than `activeWindowState`'s scan, whose
 * five-minute steps can miss a closure shorter than a step (00:00–23:59) and
 * report one open period eight days wide. The daily caps count inside this day
 * rather than a trailing 24 hours, so volume made up late in one window never
 * spends the next one's.
 */
export function workDay(
  ts: number,
  activeHours?: ActiveHours | null,
  activeDays?: string[] | null,
): { open: number; next: number } {
  const tz = activeHours?.tz || "UTC";
  const minutes = isAlwaysOpen(activeHours) ? 0 : hhmmToMinutes(activeHours!.start);
  const days = activeHours ? activeDays : null;
  let day = localDay(ts, tz);
  let open = clockOnDay(day.start, tz, minutes);
  for (let i = 0; (open > ts || !isAllowedDay(day.day, days)) && i <= DAY_KEYS.length; i++) {
    day = localDay(day.start - 1, tz);
    open = clockOnDay(day.start, tz, minutes);
  }
  let after = localDay(day.start + 36 * 60 * 60 * 1000, tz);
  for (let i = 0; !isAllowedDay(after.day, days) && i < DAY_KEYS.length; i++) {
    after = localDay(after.start + 36 * 60 * 60 * 1000, tz);
  }
  return { open, next: clockOnDay(after.start, tz, minutes) };
}

/** How far past an opening window a hop onto it lands, at most. */
const OPEN_DRIFT_MAX_MS = 5 * 60_000;

/**
 * `openAt` plus a drift under five minutes, fixed per opening instant: what a
 * send or read held for the window waits for, rather than the open itself.
 * Every hop onto one morning agrees, and the next morning's lands elsewhere —
 * an exact open would start the account's day on the same minute every day,
 * the fixed daily start the day plan's own first-activity drift exists to avoid.
 */
export function driftPastOpen(openAt: number): number {
  const minute = Math.floor(openAt / 60_000);
  return openAt + ((Math.imul(minute, 0x9e3779b1) >>> 0) % OPEN_DRIFT_MAX_MS);
}

/**
 * Whether `now` falls inside the campaign's active hours/days in its timezone.
 * When outside, `nextOpen` is the next timestamp the window opens. Thin wrapper over
 * `activeWindowState` (preserved so the single ledger gate keeps its narrow shape).
 */
export function withinActiveWindow(
  now: number,
  activeHours?: ActiveHours | null,
  activeDays?: string[] | null,
): { within: boolean; nextOpen: number } {
  const s = activeWindowState(now, activeHours, activeDays);
  return { within: s.within, nextOpen: s.nextOpen };
}
