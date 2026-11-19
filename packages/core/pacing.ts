/**
 * Anti-fixed-interval pacing. LinkedIn's guidance is explicit: polling
 * "every hour or at fixed times" trips LinkedIn's automation detection — reads
 * should happen a few times a day at RANDOMLY spaced intervals. The scheduler's
 * 5-minute cron stays fixed (it has to — QStash/Vercel fire on schedule), so the
 * randomness lives here instead: every recurring provider read persists a jittered
 * next-due timestamp (`pacing_state`) and self-gates on it; the cron tick is just
 * a heartbeat that asks "is this due yet?".
 */
import { and, eq, gt, lt, lte } from "drizzle-orm";
import { pacingState } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/** One jittered interval: uniform in [0.7×base, 1.3×base]. `rng` injectable for tests. */
export function jitteredIntervalMs(baseMs: number, rng: () => number = Math.random): number {
  return Math.floor(baseMs * (0.7 + rng() * 0.6));
}

/** FNV-1a — cheap deterministic string hash (seeds the day-plan + window PRNGs). */
export function fnvHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny seeded PRNG (uniform [0,1)); determinism is the point. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic per-window jitter: stable for the whole window (windowKey =
 * floor(now / baseMs)), changes at the boundary. Used by `report_runner_status`
 * so repeated ~5-min control polls inside one wake window all see ONE value —
 * v0.4.x CLIs adopt+persist the pushed cadence on every CHANGE and `Math.min`-
 * shorten their next wake, so a fresh random draw per poll would churn their
 * config and ratchet the cadence toward the low bound.
 */
export function jitteredIntervalForWindow(
  baseMs: number,
  seed: string,
  now: number,
  spread: { lo: number; hi: number } = { lo: 0.75, hi: 1.25 },
): number {
  const windowKey = Math.floor(now / baseMs);
  const rng = mulberry32(fnvHash(`${seed}:${windowKey}`));
  return Math.floor(baseMs * (spread.lo + rng() * (spread.hi - spread.lo)));
}

/**
 * Gate-then-advance for a recurring paced run. Returns `{due:false}` while
 * `now < nextRunAt`; when due, CAS-advances `nextRunAt` to now + jittered base
 * and returns `{due:true}` — so of two workers racing the same slot exactly one
 * wins. A missing row upserts with `nextRunAt=0` (immediately due): first sight
 * behaves like today, pacing starts after the first run.
 *
 * Advances on CLAIM, not on success — deliberate. A failed run's retry story
 * belongs to the job layer (`RescheduleError`); advancing first means a
 * persistently failing fetch waits out the full jittered window instead of
 * hammering the provider every 5-minute slot.
 */
/**
 * When this paced kind last CLAIMED a run, or null if it never has.
 *
 * Read-only, and deliberately separate from `claimPacedRun`: a press is not
 * subject to the schedule's cadence — Run now means now — but it still has to
 * know whether the account was swept a moment ago, so it can judge what landed
 * instead of reading the same searches twice.
 */
export async function lastPacedRunAt(
  tx: Tx,
  kind: string,
): Promise<number | null> {
  const [row] = await tx
    .select({ updatedAt: pacingState.updatedAt })
    .from(pacingState)
    .where(eq(pacingState.kind, kind));
  return row?.updatedAt ?? null;
}

/**
 * Record a run this kind just made OUTSIDE the gate — a press, which never
 * asked permission but must still count as the account having been swept. Same
 * write `claimPacedRun` makes when it wins, so the next scheduled slot is
 * measured from the real last sweep rather than from the last scheduled one.
 */
export async function stampPacedRun(
  tx: Tx,
  kind: string,
  baseMs: number,
  now: number,
  rng: () => number = Math.random,
): Promise<void> {
  const nextRunAt = now + jitteredIntervalMs(baseMs, rng);
  // The row is keyed (organizationId, kind) — the org half comes from the
  // tenant scope this tx already carries, so the conflict target names both.
  await tx
    .insert(pacingState)
    .values({ kind, nextRunAt, updatedAt: now })
    .onConflictDoUpdate({
      target: [pacingState.organizationId, pacingState.kind],
      set: { nextRunAt, updatedAt: now },
    });
}

export async function claimPacedRun(
  tx: Tx,
  kind: string,
  baseMs: number,
  now: number,
  rng: () => number = Math.random,
): Promise<{ due: boolean; nextRunAt: number }> {
  await tx
    .insert(pacingState)
    .values({ kind, nextRunAt: 0, updatedAt: now })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ nextRunAt: pacingState.nextRunAt })
    .from(pacingState)
    .where(eq(pacingState.kind, kind));
  const current = row?.nextRunAt ?? 0;
  if (now < current) return { due: false, nextRunAt: current };

  const nextRunAt = now + jitteredIntervalMs(baseMs, rng);
  const advanced = await tx
    .update(pacingState)
    .set({ nextRunAt, updatedAt: now })
    .where(and(eq(pacingState.kind, kind), eq(pacingState.nextRunAt, current)))
    .returning({ nextRunAt: pacingState.nextRunAt });
  if (advanced.length === 0) {
    // Lost the CAS — another worker claimed this run in the same slot.
    const [fresh] = await tx
      .select({ nextRunAt: pacingState.nextRunAt })
      .from(pacingState)
      .where(eq(pacingState.kind, kind));
    return { due: false, nextRunAt: fresh?.nextRunAt ?? nextRunAt };
  }
  return { due: true, nextRunAt };
}

/**
 * Singleflight lease over the same `pacing_state` row, for work that must never
 * run twice at once — a discovery sweep drives ONE real browser profile, and two
 * concurrent sweeps interleave requests on it, double the account's read traffic,
 * and can trip the sidecar's per-request timeout into killing the whole browser
 * generation. `claimPacedRun` cannot do this job: it gates on a *cadence* and
 * advances on claim, so it cannot be released early and says nothing about
 * whether a run is still in flight.
 *
 * `nextRunAt` is reused as the lease expiry, so a process that dies mid-run
 * self-heals after `ttlMs` instead of wedging the key forever. Callers extend a
 * long run with `renewExclusiveRun` and MUST release in a `finally`. Use a kind
 * namespace distinct from any pacing key on the same org (`discover-lock:` vs
 * `discover:`), or the two meanings of the column collide.
 */
export type ExclusiveRunClaim = {
  claimed: boolean;
  /** The expiry this claimant owns. Carry it into renew/release — it is the
   *  fence that makes those operations safe. */
  expiresAt: number;
};

export async function claimExclusiveRun(
  tx: Tx,
  kind: string,
  ttlMs: number,
  now: number,
): Promise<ExclusiveRunClaim> {
  await tx
    .insert(pacingState)
    .values({ kind, nextRunAt: 0, updatedAt: now })
    .onConflictDoNothing();
  // One statement, so two racing claimants cannot both read "free" and write.
  const claimed = await tx
    .update(pacingState)
    .set({ nextRunAt: now + ttlMs, updatedAt: now })
    .where(and(eq(pacingState.kind, kind), lte(pacingState.nextRunAt, now)))
    .returning({ nextRunAt: pacingState.nextRunAt });
  return {
    claimed: claimed.length > 0,
    expiresAt: claimed[0]?.nextRunAt ?? 0,
  };
}

/**
 * Push a held lease out by another `ttlMs`, and report the new expiry.
 *
 * FENCED on the expiry the caller currently owns: if the lease already lapsed
 * and someone else claimed it, this matches nothing and returns null, so the
 * old holder learns it lost the lease at renew time instead of silently
 * extending a stranger's lease. Callers must adopt the returned expiry.
 */
export async function renewExclusiveRun(
  tx: Tx,
  kind: string,
  ttlMs: number,
  now: number,
  expectedExpiry: number,
): Promise<number | null> {
  const renewed = await tx
    .update(pacingState)
    .set({ nextRunAt: now + ttlMs, updatedAt: now })
    .where(
      and(
        eq(pacingState.kind, kind),
        eq(pacingState.nextRunAt, expectedExpiry),
        gt(pacingState.nextRunAt, now),
      ),
    )
    .returning({ nextRunAt: pacingState.nextRunAt });
  return renewed[0]?.nextRunAt ?? null;
}

/**
 * Free the lease for the next caller. Always call this in a `finally`.
 *
 * FENCED on `expectedExpiry` for the reason the whole lease exists: a run whose
 * lease lapsed mid-flight, and whose key was then re-claimed by the next run,
 * must not free the NEW holder's lease on its way out. Unfenced, the failure is
 * two concurrent runs on one campaign — precisely what this prevents.
 */
export async function releaseExclusiveRun(
  tx: Tx,
  kind: string,
  expectedExpiry: number,
  now: number,
): Promise<void> {
  await tx
    .update(pacingState)
    .set({ nextRunAt: 0, updatedAt: now })
    .where(
      and(
        eq(pacingState.kind, kind),
        eq(pacingState.nextRunAt, expectedExpiry),
      ),
    );
}

/**
 * Free a held lease whose holder is gone, without waiting out its TTL: one that
 * nobody has claimed or renewed since `before`. Only a caller that knows no
 * live holder can have last touched it that long ago may say so — the local
 * runtime as it starts (`releaseRunsLeftRunning`). The release is one
 * statement, so a claim landing at the same moment stamps a fresh `updatedAt`
 * and is left alone. Whether the lease is free now: false while a holder that
 * touched it at or after `before` still has it.
 */
export async function releaseAbandonedExclusiveRun(
  tx: Tx,
  kind: string,
  before: number,
  now: number,
): Promise<boolean> {
  const released = await tx
    .update(pacingState)
    .set({ nextRunAt: 0, updatedAt: now })
    .where(
      and(
        eq(pacingState.kind, kind),
        gt(pacingState.nextRunAt, now),
        lt(pacingState.updatedAt, before),
      ),
    )
    .returning({ kind: pacingState.kind });
  if (released.length > 0) return true;
  const [held] = await tx
    .select({ kind: pacingState.kind })
    .from(pacingState)
    .where(and(eq(pacingState.kind, kind), gt(pacingState.nextRunAt, now)));
  return held === undefined;
}

/**
 * The account's two check cadences, in minutes — the owner's "Check replies
 * every" and "Check messages every" on Limits, stored on the channel row.
 * Each is a BASE `jitteredIntervalMs` spreads ±30%, so no setting can make a
 * check fixed-interval. The bounds keep a typo from reading the account every
 * few minutes or from leaving a reply unseen for a day.
 */
export const REPLY_CHECK_MINUTES = { min: 30, max: 240, default: 60 } as const;
export const INBOX_CHECK_MINUTES = { min: 20, max: 240, default: 45 } as const;

/**
 * Decaying check cadence for a comment watch: LinkedIn engagement is heavily
 * front-loaded, so fresh comments are checked at the account's reply cadence
 * (about hourly by default), then the cadence decays — 6× it until day 7,
 * 12× it until the watch expires. Returned base feeds jitteredIntervalMs.
 */
export function watchCheckBaseMs(
  ageMs: number,
  replyCheckBaseMin: number = REPLY_CHECK_MINUTES.default,
): number {
  const young = replyCheckBaseMin * 60_000;
  if (ageMs < 48 * 3_600_000) return young; // <48h: the setting, ~1h
  if (ageMs < 7 * 86_400_000) return 6 * young; // 2-7d: ~6h
  return 12 * young; // beyond: ~12h until TTL
}

/**
 * Hold a paced kind until at least `notBefore`, landing it at a random point
 * in the `spreadMs` after it — so a check that waited out a closed window
 * does not fire at the same minute every morning. A row already due later is
 * left alone, which also makes repeated calls while the window stays shut a
 * no-op after the first.
 */
export async function deferPacedRun(
  tx: Tx,
  kind: string,
  notBefore: number,
  spreadMs: number,
  now: number,
  rng: () => number = Math.random,
): Promise<void> {
  await tx
    .insert(pacingState)
    .values({ kind, nextRunAt: 0, updatedAt: now })
    .onConflictDoNothing();
  await tx
    .update(pacingState)
    .set({ nextRunAt: notBefore + Math.floor(rng() * spreadMs) })
    .where(and(eq(pacingState.kind, kind), lt(pacingState.nextRunAt, notBefore)));
}

/** When a paced kind is next due, or null if it has never been paced. */
export async function pacedRunDueAt(tx: Tx, kind: string): Promise<number | null> {
  const [row] = await tx
    .select({ nextRunAt: pacingState.nextRunAt })
    .from(pacingState)
    .where(eq(pacingState.kind, kind));
  return row?.nextRunAt ?? null;
}

/** Test/ops helper: force a paced kind due NOW (e.g. after config changes). */
export async function resetPacing(tx: Tx, kind: string): Promise<void> {
  await tx.update(pacingState).set({ nextRunAt: 0, updatedAt: Date.now() }).where(eq(pacingState.kind, kind));
}
