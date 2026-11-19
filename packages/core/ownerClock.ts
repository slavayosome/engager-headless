import { channels } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * THE OWNER'S CLOCK — the one zone every time said to the owner is in, by an
 * agent as by the dashboard.
 *
 * The dashboard prints in the browser's zone (`apps/dashboard/lib/dates.ts`),
 * and the runtime runs on the owner's Mac beside that browser, so the
 * runtime's own zone comes first. Then the zone of the channel's sending
 * window, which the owner's browser set when they drew one. Else there is
 * none, and a time is said relative to now. Bare UTC is never the owner's: it
 * is what a process with no TZ reports, and a Mac in London answers
 * Europe/London.
 */
const NO_ZONE = /^(?:Etc\/)?(?:UTC|UCT|GMT|Universal|Zulu|Greenwich)(?:[+-]0)?$/i;

/** `zone` in the runtime's canonical spelling when it is a real place's zone, else null. */
export function knownZone(zone: string | null | undefined): string | null {
  if (!zone || NO_ZONE.test(zone)) return null;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    return NO_ZONE.test(resolved) ? null : resolved;
  } catch {
    return null;
  }
}

export function ownerTimeZone(
  channelZone?: string | null,
  systemZone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  return knownZone(systemZone) ?? knownZone(channelZone);
}

/** The owner's zone, reading the channel only when the runtime has none. */
export async function readOwnerTimeZone(tx: Tx): Promise<string | null> {
  const zone = ownerTimeZone(null);
  if (zone) return zone;
  const [channel] = await tx.select({ activeHours: channels.activeHours }).from(channels).limit(1);
  return ownerTimeZone(channel?.activeHours?.tz);
}

/** One formatter per zone: the key space is the owner's zone, one per install. */
const clocks = new Map<string, Intl.DateTimeFormat>();

/** `zone`'s offset from UTC at `at`, as `+08:00`, and in minutes. */
export function zoneOffset(zone: string, at: number): { label: string; minutes: number } {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return { label: "+00:00", minutes: 0 };
  const minutes = (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  return { label: `${match[1]}${match[2]}:${match[3]}`, minutes };
}

/** `ms` as an ISO moment on `zone`'s wall clock: `2026-10-29T19:50:00+08:00`. */
export function localIso(ms: number, zone: string): string {
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    clocks.set(zone, clock);
  }
  const part = Object.fromEntries(clock.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}${zoneOffset(zone, ms).label}`;
}

/** The fields read results carry a moment in: `createdAt`, `at`, `pausedUntil`, `healthySince`, `paidThrough`, `missedFrom`, `periodStart`. */
const TIME_KEY = /(?:At|^at|^ts|Since|Until|Through|From|Start)$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

function momentOf(value: unknown): number | null {
  // Epoch milliseconds between 2001 and 2286, which no id or count reaches.
  if (typeof value === "number") return value >= 1e12 && value < 1e13 ? value : null;
  return typeof value === "string" && ISO_UTC.test(value) ? Date.parse(value) : null;
}

/**
 * `value` with a `…Local` twin beside each moment it holds — `nextRunAt` gains
 * `nextRunAtLocal: "2026-10-29T19:50:00+08:00"` — so an agent reads the
 * owner's wall clock off the result instead of doing zone arithmetic on an
 * epoch, which is how an answer came out "11:39 UTC". Additive: every id and
 * epoch other code reads stays where it was.
 */
export function withLocalTimes(value: unknown, zone: string): unknown {
  if (Array.isArray(value)) return value.map((item) => withLocalTimes(item, zone));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = withLocalTimes(field, zone);
    const ms = TIME_KEY.test(key) && !(`${key}Local` in value) ? momentOf(field) : null;
    if (ms !== null) out[`${key}Local`] = localIso(ms, zone);
  }
  return out;
}
