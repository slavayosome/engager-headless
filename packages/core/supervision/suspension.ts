/**
 * THIS PROCESS'S OWN EVIDENCE THAT THE MACHINE SLEPT.
 *
 * The maintained Mac app reports a closed lid to the core (`sleepWake.ts`), but
 * only when it is there, only on a full wake, and only as an aid to the missed-
 * run cause. A run already under way needs something it can ask itself, in the
 * process doing the work, whoever supervises it: did the machine stop under me?
 *
 * Neither clock answers that on its own. On macOS the monotonic clock Node reads
 * (`process.hrtime`, `performance.now`) counts sleep exactly as the wall clock
 * does, and so do timers: a sixty-second request timeout set before the lid
 * closed fires on the first dark wake after it, an hour later in wall terms and
 * with no time awake in between. What a sleep does leave is a hole in the
 * process's own activity, so the watch samples the wall clock on a short
 * interval and calls any gap far longer than that interval a suspension. A dark
 * wake runs the overdue sample at once, which is what makes a dark wake visible
 * at all — the app hears no wake notification for one.
 *
 * An event loop blocked for half a minute leaves the same hole and reads the
 * same way. Nothing in this process blocks that long, and a run whose loop did
 * would have its deadlines broken in exactly the way a sleep breaks them.
 */

/** What a job, a read or a send that met a machine still waking is refused
 *  with. Nothing went out, and it runs again once the machine has stayed up. */
export const WAKING_REASON = "the machine is waking from sleep";

/** How often the watch samples the clock. */
export const SUSPENSION_TICK_MS = 5_000;

/** A gap between two samples longer than this is the machine having stopped,
 *  not a tick running late. */
export const SUSPENSION_GAP_MS = 30_000;

/**
 * How long the machine must stay awake after a suspension before it counts as
 * awake again.
 *
 * A dark wake lasts seconds and the next sleep follows it, so the first sample
 * after a gap cannot tell one from the owner opening the lid. A minute of
 * samples with no new gap can: a dark wake never lasts it, and the network and
 * the browser's own reconnect are back well inside it. On 2026-10-19 the first
 * read three seconds after the lid opened met a page that had not reloaded yet,
 * and every read from the next minute on went through.
 */
export const WAKE_SETTLE_MS = 60_000;

/** Enough to cover a night of dark wakes; older ones answer no question. */
const KEPT_SUSPENSIONS = 64;

/** A stretch the process did not run: the last sample before it and the first
 *  after it, both wall-clock. */
export type Suspension = { from: number; to: number };

export class SuspensionWatch {
  private lastSample: number | null = null;
  private readonly suspensions: Suspension[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Idempotent: every holder of work that a sleep can cut starts it, and the
   *  process has one watch. */
  start(): void {
    if (this.timer !== null) return;
    this.lastSample = this.clock();
    this.timer = setInterval(() => this.observe(), SUSPENSION_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.lastSample = null;
    this.suspensions.length = 0;
  }

  /**
   * Take a sample now. Every question below takes one first, because the
   * interval's own sample is not guaranteed to run before the caller that
   * woke with it: a timer that counted the sleep fires at the same dark wake.
   *
   * A watch that was never started says nothing at all. Its samples would be
   * whenever somebody happened to ask, and two questions an hour apart in an
   * idle process are not a suspension.
   */
  observe(): void {
    if (this.timer === null || this.lastSample === null) return;
    const now = this.clock();
    if (now - this.lastSample > SUSPENSION_GAP_MS) {
      this.suspensions.push({ from: this.lastSample, to: now });
      if (this.suspensions.length > KEPT_SUSPENSIONS) this.suspensions.shift();
    }
    // A clock stepped backwards moves the sample with it, so the step forward
    // that corrects it is not read as a second sleep.
    this.lastSample = now;
  }

  /** The first suspension that ended after `from` — what a run that started
   *  then slept through — or null when the process ran the whole time. */
  suspendedSince(from: number): Suspension | null {
    this.observe();
    return this.suspensions.find((suspension) => suspension.to > from) ?? null;
  }

  /** When the latest suspension ended, or null when there has been none. */
  lastWakeAt(): number | null {
    this.observe();
    return this.suspensions.at(-1)?.to ?? null;
  }

  /** Until when the machine is still waking up — `WAKE_SETTLE_MS` past the
   *  latest suspension — or null when it is awake. */
  unsettledUntil(): number | null {
    const woke = this.lastWakeAt();
    if (woke === null) return null;
    const until = woke + WAKE_SETTLE_MS;
    return this.clock() < until ? until : null;
  }

  /**
   * Whether the machine is awake by `deadline`, waiting until it is. A dark
   * wake that ends in another sleep leaves a new gap for the next sample,
   * which moves the wait on with it, so this answers true only after a minute
   * the machine actually stayed up — and false once the deadline comes first.
   */
  async settled(deadline = Number.POSITIVE_INFINITY): Promise<boolean> {
    for (;;) {
      const until = this.unsettledUntil();
      if (until === null) return true;
      const now = this.clock();
      if (now >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(until, deadline) - now));
    }
  }
}

/** The process's one watch. `startSuspensionWatch` is idempotent, and the job
 *  worker and the browser bridge both call it. */
export const suspensionWatch = new SuspensionWatch();

export function startSuspensionWatch(): void {
  suspensionWatch.start();
}
