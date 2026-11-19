import cron from "node-cron";
import { eq } from "drizzle-orm";
import { backgroundEntitlement } from "@engager/billing/entitlement";
import { db as baseDb } from "@engager/database";
import { campaigns, organizations } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { scheduleInvitationWatches } from "../actions/invite";
import { settleExpiredTasks } from "../tasks/task";
import { pruneBugReports, settleStrandedReports } from "../reports/store";
import { wakeStalledPhases } from "../leads/scout/check";
import { dueWorkers } from "../operations/workers";
import { isSupportedPublicCampaignRuntime } from "../operations/campaigns";
import { channelCeilings } from "../ratelimit/ledger";
import { runtimeInstanceId } from "../execution/authority";
import { recordMissedRun, wakeWentUnserved } from "../supervision/missedRuns";
import {
  heldByAnother,
  readSupervision,
  renewSupervision,
  resumeSupervisionAtRuntimeBoot,
  type SupervisionClaim,
} from "../supervision/record";
import type { WorkerRunPayload } from "./handlers/workerRun";
import { enqueue } from "./queue";

type BaseDb = typeof baseDb;

/**
 * The check for Find leads steps that have work and no job to do it
 * (`wakeStalledPhases`), in a savepoint of its own: one that fails is a tick
 * without it, never a tick without the rest of what the transaction enqueues.
 */
async function checkStalledSteps(tx: Tx, now: number): Promise<void> {
  try {
    await tx.transaction((savepoint) => wakeStalledPhases(savepoint, now));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[scheduler] the check for stalled Find leads steps failed:", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Whether the tick arms new product work under this supervision: not while
 * another installation holds the data, the machine is asleep, or a supervisor
 * has spent its retries and waits on the owner. Exported so Keep this Mac
 * awake (`keepAwakeHolder.ts`) holds the Mac for nothing the tick would not arm.
 */
export function supervisionArmsWork(supervision: SupervisionClaim): boolean {
  return !(
    supervision.status === "held_elsewhere" ||
    supervision.record.state === "paused" ||
    supervision.record.state === "recovery_required"
  );
}

/**
 * Enqueue the periodic work for every org. Idempotency keys bucket by a 5-minute
 * slot so a double-fire (or an overlapping manual run) cannot enqueue duplicate
 * jobs.
 *
 * MULTI-TENANT: `campaigns` is RLS-scoped, so we cannot scan it on the base db.
 * We enumerate orgs on the base db (the `organizations` table is not org-scoped),
 * then enter each org's `withOrg` tx to read its active campaigns + enqueue work
 * (which stamps organization_id via the GUC default).
 */
export async function enqueueDueWork(db: BaseDb = baseDb): Promise<void> {
  // Core scheduling never contacts commercial services. Authority is checked
  // from the channel at worker claim and again at dispatch.
  const now = Date.now();
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const org of orgs) {
    await enqueueDueWorkForOrg(org.id, now);
  }
}

/** One org's slice of the periodic work — exported so tests can drive a single
 *  org without enumerating the whole (shared) organizations table. */
export async function enqueueDueWorkForOrg(orgId: string, now: number): Promise<void> {
  const slot = Math.floor(now / (5 * 60_000));
  const daySlot = Math.floor(now / (24 * 60 * 60_000));
  const org = { id: orgId };
  await withOrg(org.id, async (tx) => {
      // Prepared external work the owner's agent walked away from: settle the
      // expired stages so their run stops reporting "awaiting agent" forever.
      // Before the entitlement gate on purpose — this only tells the truth
      // about rows that already exist. It enqueues nothing and spends nothing.
      await settleExpiredTasks(tx, now);
      // The same for the owner's problem reports: one whose delivery job is
      // gone is failed so it offers Retry, and one sent long ago is pruned.
      await settleStrandedReports(tx, now);
      await pruneBugReports(tx, now);
      // Retention has no provider work and remains due even while paused,
      // without a paid plan, or supervised by another installation.
      await enqueue(tx, {
        type: "forget_spotted",
        payload: {},
        idempotencyKey: `forget_spotted:${org.id}:${daySlot}`,
      });
      // Keep this installation's supervision claim alive — never a change of
      // supervisor (see `renewSupervision`). It is the scheduler's job because
      // the tick is the one thing that is running whenever this install is
      // supervising itself at all, which is also why the renewal is allowed to
      // record that this runtime is UP: a supervisor that left a `paused` or
      // `recovery_required` record behind and never came back must not hold the
      // free core's work for ever.
      const supervision = await renewSupervision(tx, {
        organizationId: org.id,
        holderId: runtimeInstanceId(),
        now,
      });
      // A machine that is asleep, or a supervisor that has spent its retry
      // budget and is waiting for an owner, arms no new product work. This is
      // the quiescing half of ADR-08's sleep rule and it is deliberately
      // narrow: retention still runs, nothing already dispatched is touched,
      // and no receipt is resolved by it. `stopped` and `starting` do NOT
      // block — an install nobody has claimed supervision of is the ordinary
      // free case, and a wake revalidates through `starting`.
      //
      // `held_elsewhere` blocks for a different reason and with the same
      // narrowness: a live claim from ANOTHER installation root — a restored
      // archive, a copy-back still in flight — means this process is not the
      // one watching this data, and arming its work would be the second
      // executor ADR-02 exists to prevent. The claim expires on its own lease,
      // so this resolves with no owner action once the other side is gone.
      if (!supervisionArmsWork(supervision)) return;
      // Enqueueing arms future spend, so serialize this short scheduler
      // transaction with cancellation instead of relying on a stale read.
      const entitlement = await backgroundEntitlement(tx, org.id, { lock: true, now });
      if (!entitlement.allowed) {
        // No discovery, polling,
        // drafting, notifications, or other product work is generated. The
        // usage-data heartbeat is not product work: a lapsed install that is
        // still open is one the team needs to count.
        await enqueue(tx, {
          type: "install_active",
          payload: {},
          idempotencyKey: `install_active:${org.id}:${daySlot}`,
        });
        return;
      }
      const active = await tx
        .select({
          id: campaigns.id,
          status: campaigns.status,
          discovery: campaigns.discovery,
        })
        .from(campaigns)
        .where(eq(campaigns.status, "active"));

      // Every active campaign gets its own upkeep; the channel budget, not a
      // head count, is what keeps several of them from over-spending.
      const supportedActive = active.filter(isSupportedPublicCampaignRuntime);

      for (const c of supportedActive) {
        // NO unconditional discovery sweep here, deliberately.
        //
        // Radar is manual by design: the pool fills when the owner presses
        // Discover (which enqueues `discover_posts` with `manual: true`), or
        // when a worker they created and switched on comes due — the run
        // handler sweeps inline as its first stage. A campaign with no
        // worker and no button press has an empty Radar, and the Radar
        // header says WHICH kind of empty rather than leaving it ambiguous.
        //
        // The first-sweep kicks on campaign create/activate survive — those are
        // owner acts, not a standing schedule.

        // There is no server drafter: the owner's agent writes, and an
        // Ambassador writes through the same intake.
        // Once per day: distill feedback into the campaign's house style.
        await enqueue(tx, {
          type: "distill",
          payload: { campaignId: c.id },
          idempotencyKey: `distill:${c.id}:${daySlot}`,
        });
        // Once per day: self-heal the campaign's compiled focus brief (the
        // sourceHash no-op skips it unless objective/angle/products/Brain changed).
        // Distinct `compile:nightly:` namespace so a daySlot integer can never
        // alias the coarse `compile:ver:<version>` key (permanent unique index).
        await enqueue(tx, {
          type: "compile_campaign",
          payload: { campaignId: c.id },
          idempotencyKey: `compile:nightly:${c.id}:${daySlot}`,
        });
      }

      // Workers: the ONE path by which anything in this product runs
      // unattended, and the only reader of `auto` on this side of the product.
      // Enqueued when the owner turned Auto on and the wake has arrived — Auto
      // off, nothing runs here, which is what makes Radar honestly manual and
      // is ALSO why Run now is not routed through this loop. The handler owns
      // the channel lease, so two due workers on one account serialize rather
      // than race.
      //
      // COALESCING IS ALREADY STRUCTURAL, and P6 does not add a second
      // mechanism for it: a worker carries ONE `nextRunAt`, the key below is
      // that exact wake, and `reArmedWake` advances it after the run. Ten hours
      // of sleep therefore produce one job per worker, never one per missed
      // tick. What is new is the RECORD — how many of the account's own plan
      // slots went unserved, and why — so a wake can say what it slept through
      // instead of silently arming one run and losing the rest.
      const due = await dueWorkers(tx, now);
      const missedChannel = due.length > 0 ? await channelCeilings(tx) : null;
      for (const worker of due) {
        // Annotated like the other two enqueue sites: the payload reaches
        // `enqueue` as `unknown`, and `workerRunState` reads this key back out
        // of the jsonb by name, so an unchecked misspelling here is a queued run
        // the Run now button reports as idle.
        const payload: WorkerRunPayload = {
          workerId: worker.id,
          trigger: "schedule",
        };
        const idempotencyKey = `worker:${worker.id}:${worker.nextRunAt}`;
        await enqueue(tx, {
          type: "worker_run",
          payload,
          // Keyed on the worker's own wake, not the tick slot: a wake further
          // out than five minutes must not re-enqueue on every tick, and a
          // double-fire of the same wake must collapse to one run.
          idempotencyKey,
        });
        // Evidence only, and only of a gap there is evidence for. An overdue
        // wake is not by itself a missed one: it stays due until its run
        // re-arms it, which is after the work, so a run queued behind a busy
        // lane — a start's first sweep — is overdue on a machine that was up
        // all along. `wakeWentUnserved` asks the supervision history and the
        // wake's own job instead.
        //
        // `recordMissedRun` enqueues nothing and cannot: the single enqueue
        // above is the whole of what a gap produces, which is what keeps a
        // long outage from becoming a catch-up storm.
        if (
          missedChannel &&
          worker.nextRunAt !== null &&
          (await wakeWentUnserved(tx, {
            organizationId: org.id,
            idempotencyKey,
            from: worker.nextRunAt,
            to: now,
          }))
        ) {
          await recordMissedRun(tx, {
            organizationId: org.id,
            workerId: worker.id,
            missedFrom: worker.nextRunAt,
            channel: missedChannel,
            now,
          });
        }
      }

      // Find leads steps with work in their queue and no job to do it: a
      // crash, a quit or a sleep left them there. One job a step, none for a
      // campaign that is paused or stopped, nothing read from LinkedIn.
      await checkStalledSteps(tx, now);

      // A pending invitation's person is read on a backoff from its send. A
      // watch still queued a day out — from before that — is brought up to
      // its next point here, since its own handler only picks one after the
      // read it waits for. Moves a time, enqueues nothing, reads nothing; the
      // account's read budget still gates each wake.
      await scheduleInvitationWatches(tx, org.id, now);

      // Per-org incoming polling.
      await enqueue(tx, {
        type: "poll_incoming",
        payload: {},
        idempotencyKey: `poll_incoming:${org.id}:${slot}`,
      });
      // The account's light inbox check. Enqueued every slot; the handler
      // self-gates on the account's jittered "Check messages every", its
      // window, its stops and whether any campaign reads DMs at all, so most
      // slots are cheap no-ops.
      await enqueue(tx, {
        type: "inbox_check",
        payload: {},
        idempotencyKey: `inbox_check:${org.id}:${slot}`,
      });
      // Engagement monitor: replies/reactions on comments WE posted. Enqueued
      // every slot; the handler self-gates per watch on jittered nextCheckAt
      // (plus a ~75min-jittered counter sweep), so most slots are cheap no-ops.
      await enqueue(tx, {
        type: "monitor_engagement",
        payload: {},
        idempotencyKey: `monitor:${org.id}:${slot}`,
      });
      // Once per day: re-assess brain coverage and top up interview questions
      // for any slot still weak (the "come back later" check).
      await enqueue(tx, {
        type: "refresh_brain",
        payload: {},
        idempotencyKey: `refresh_brain:${org.id}:${daySlot}`,
      });

      // Once per day: nudge the owner about hot leads that got their email but
      // no human touch for ~2 days ("sometime" means never without a nudge).
      // Unconditional — the handler is a cheap no-op when nothing is stale.
      await enqueue(tx, {
        type: "check_stale_leads",
        payload: {},
        idempotencyKey: `stale_leads:${org.id}:${daySlot}`,
      });

      // Once per day: fold the Find leads people nobody answered in 14 days
      // into No answer. Database only; a cheap no-op without any.
      await enqueue(tx, {
        type: "lead_lifecycle",
        payload: {},
        idempotencyKey: `lead_lifecycle:${org.id}:${daySlot}`,
      });

      // Once per day: the usage-data heartbeat (what this install has set up).
      await enqueue(tx, {
        type: "install_active",
        payload: {},
        idempotencyKey: `install_active:${org.id}:${daySlot}`,
      });
  });
}

/**
 * This runtime coming up, recorded once per process.
 *
 * A `Paused` or `Needs recovery` record left behind by a supervisor that is
 * gone must not outlive the owner starting the runtime again — which is the
 * runbook's own instruction, and the thing a renewal cannot say on its own:
 * the agent's ticks keep this installation root's lease live, so the record
 * never looks unheld. A start does say it, exactly once, and it grants no
 * retries (`resumeSupervisionAtRuntimeBoot`).
 *
 * Exported so it is testable as itself; `startScheduler` is its one caller.
 */
export async function recordRuntimeBoot(db: BaseDb = baseDb): Promise<void> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const org of orgs) {
    await withOrg(org.id, (tx) =>
      resumeSupervisionAtRuntimeBoot(tx, {
        organizationId: org.id,
        holderId: runtimeInstanceId(),
        now: Date.now(),
      }),
    );
  }
}

/**
 * The tick's check for stalled Find leads steps, once as this runtime comes up,
 * so what a crash, a quit or a sleep left waiting does not wait for the first
 * tick. It takes the tick's gates: nothing is woken for an organization whose
 * data another installation holds, or whose plan does not allow the work.
 *
 * Exported so it is testable as itself; `startScheduler` is its one caller.
 */
export async function wakeStalledPhasesAtBoot(db: BaseDb = baseDb): Promise<void> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const org of orgs) {
    await withOrg(org.id, async (tx) => {
      const now = Date.now();
      if (heldByAnother(await readSupervision(tx, org.id), runtimeInstanceId(), now)) return;
      if (!(await backgroundEntitlement(tx, org.id, { lock: true })).allowed) return;
      await checkStalledSteps(tx, now);
    });
  }
}

export async function startScheduler(): Promise<void> {
  // Before the first tick, and never again in this process: the runtime is up.
  try {
    await recordRuntimeBoot();
  } catch (e) {
    // A record that could not be read is not a reason to run no scheduler.
    // eslint-disable-next-line no-console
    console.error("[scheduler] could not record this runtime's start", e);
  }
  try {
    // Then the check the tick makes, ahead of the first tick.
    await wakeStalledPhasesAtBoot();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[scheduler] could not wake the steps a stop left waiting", e);
  }
  cron.schedule("*/5 * * * *", () => {
    enqueueDueWork().catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[scheduler]", e);
    });
  });
  // eslint-disable-next-line no-console
  console.log("[scheduler] started (every 5 min)");
}
