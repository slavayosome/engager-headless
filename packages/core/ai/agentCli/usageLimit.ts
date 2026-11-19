/**
 * When a usage limit lifts, read from the words a CLI prints about it, and
 * kept as a number (US-ONE-06): the adapter turns the reset into epoch
 * milliseconds here and drops the text, so no vendor string travels past the
 * parse and the owner's sentence is built from a typed field.
 *
 * Each form below is one the vendors' own CLIs print today, pinned by canned
 * strings in `usageLimit.test.ts` — and UNVERIFIED against a live account:
 * no test ever drives a real agent into its limit. A form this does not
 * recognise answers `undefined`, which the sentence handles ("Try again
 * later"); a wrong guess would put a false time in front of the owner, so
 * anything implausible — in the past, or more than a month out — is dropped
 * too.
 *
 *  - Claude Code, older: `Claude AI usage limit reached|1760468400` (epoch
 *    seconds after a pipe).
 *  - Claude Code, newer: `resets 3pm (Asia/Singapore)`, `will reset at 7:30pm
 *    (America/New_York)` — a wall-clock time in the zone named in brackets.
 *  - Codex: `try again at 3:15 PM`, `try again at Nov 6th, 2025 3:15 PM` (the
 *    Mac's own zone), and `try again in 3 days 4 hours 12 minutes`.
 */

const MONTH = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MAX_AHEAD_MS = 31 * 24 * 60 * 60 * 1000;

export type UsageLimitClock = {
  /** Epoch ms. Injected by tests; production reads the clock. */
  now?: number | undefined;
  /** The zone a time with no zone of its own is read in; the Mac's own. */
  timeZone?: string | undefined;
};

export function parseUsageLimitReset(
  text: string,
  clock: UsageLimitClock = {},
): number | undefined {
  const now = clock.now ?? Date.now();
  const plausible = (ms: number | undefined): number | undefined =>
    ms !== undefined && Number.isFinite(ms) && ms > now && ms - now <= MAX_AHEAD_MS
      ? Math.round(ms)
      : undefined;

  const epoch = /limit reached\|(\d{10,13})\b/i.exec(text);
  if (epoch) {
    const value = Number(epoch[1]);
    return plausible(value < 1e12 ? value * 1000 : value);
  }

  const wall =
    /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b(?:\s*\(([A-Za-z_+\-0-9]+(?:\/[A-Za-z_+\-0-9]+)*)\))?/i.exec(
      text,
    );
  if (wall) {
    const hour = clock12(Number(wall[1]), wall[3]!);
    const minute = Number(wall[2] ?? 0);
    if (hour === undefined || minute > 59) return undefined;
    return plausible(nextWallTime(hour, minute, wall[4] ?? clock.timeZone, now));
  }

  const at =
    /try again at (?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2})\s*([AP])M/i.exec(
      text,
    );
  if (at) {
    const hour = clock12(Number(at[4]), at[6]!);
    const minute = Number(at[5]);
    if (hour === undefined || minute > 59) return undefined;
    if (at[1] === undefined) return plausible(nextWallTime(hour, minute, clock.timeZone, now));
    const month = MONTH.indexOf(at[1].toLowerCase());
    if (month < 0) return undefined;
    return plausible(
      zonedInstant(Number(at[3]), month + 1, Number(at[2]), hour, minute, clock.timeZone),
    );
  }

  const after = /try again in ((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)[\s,]*(?:and\s+)?)+)/i.exec(
    text,
  );
  if (after) {
    let total = 0;
    for (const [, amount, unit] of after[1]!.matchAll(/(\d+)\s*(day|hour|hr|minute|min|second|sec)/gi)) {
      const seconds = { day: 86_400, hour: 3_600, hr: 3_600, minute: 60, min: 60, second: 1, sec: 1 }[
        unit!.toLowerCase() as "day"
      ];
      total += Number(amount) * seconds * 1000;
    }
    return total > 0 ? plausible(now + total) : undefined;
  }
  return undefined;
}

function clock12(hour: number, meridiem: string): number | undefined {
  if (hour < 1 || hour > 12) return undefined;
  const pm = meridiem.toLowerCase() === "p";
  return (hour % 12) + (pm ? 12 : 0);
}

/** The zone's wall clock minus UTC at one instant, in ms, to the minute. */
function offsetAt(instant: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return wall - Math.floor(instant / 60_000) * 60_000;
}

/** The instant a wall-clock time falls on in a zone; two passes settle a
 *  time that sits across a daylight-saving edge. An unknown zone name is
 *  `undefined`, never the Mac's own zone passed off as it. */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string | undefined,
): number | undefined {
  try {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = guess - offsetAt(guess, timeZone);
    return guess - offsetAt(first, timeZone);
  } catch {
    return undefined;
  }
}

/** The next time the zone's clock reads `hour:minute`, today if it has not
 *  passed there yet and tomorrow if it has. */
function nextWallTime(
  hour: number,
  minute: number,
  timeZone: string | undefined,
  now: number,
): number | undefined {
  let today: { year: number; month: number; day: number };
  try {
    const wall = new Date(now + offsetAt(now, timeZone));
    today = {
      year: wall.getUTCFullYear(),
      month: wall.getUTCMonth() + 1,
      day: wall.getUTCDate(),
    };
  } catch {
    return undefined;
  }
  const candidate = zonedInstant(today.year, today.month, today.day, hour, minute, timeZone);
  if (candidate === undefined) return undefined;
  if (candidate > now) return candidate;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return zonedInstant(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
}
