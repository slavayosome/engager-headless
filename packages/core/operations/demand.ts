import { and, eq, inArray, not, notExists, or, sql } from "drizzle-orm";
import {
  discoveredPosts,
  messages,
  type Campaign,
  type Channel,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ACTIONABLE_CANDIDATE_STATUSES } from "../operations/postStatus";
import { effectiveDailyCommentCap } from "../ratelimit/ledger";
import { workDay } from "../time";
import { forOwnerSql, roomOnlySql } from "../rooms/evidence";
import { anchorsInRange, commentFloorGapMs, restOfDayPlan } from "./schedule";

/**
 * How much comment work a connected account needs RIGHT NOW — one answer,
 * derived from rows at a pinned clock rather than configured per worker.
 *
 * A worker is a top-up on the account it feeds, and the account is the
 * `channels` row (INV-4). Both triggers the phase wires — the schedule and the
 * owner's own button — consume THIS function, because two arithmetics in two
 * files is how a product grows two answers to one question (INV-5):
 *
 *   publish ON   drafts = max(0, ask − committed worker supply)
 *                  next_few     ask = min(AUTOMATIC_BUFFER, anchors in the
 *                                         top-up horizon)
 *                  rest_of_day  ask = every slot the account's day has left,
 *                                         inside the top-up horizon
 *   publish OFF  drafts = max(0, min(cap − posted − committed,
 *                                    cap − this campaign's drafts waiting))
 *
 * A DRAFT WAITING FOR A YES HOLDS NO SLOT (the owner's rule, 2026-10-15). Only a
 * comment that went out, or one the owner approved and the account is sending,
 * counts against the day: a draft the owner may still reject would otherwise
 * starve the plan it never entered — and another campaign's waiting drafts
 * starved this one's Scout. The day's posted and committed counts are the
 * ACCOUNT's, the one budget every campaign spends.
 *
 * The one bound waiting drafts put on drafting is the BACKLOG, and it is the
 * campaign's own, on the arm whose output waits. Publish off, every draft waits
 * for a yes, so drafting never takes THIS campaign's waiting drafts past a
 * day's cap: while that many wait nothing more is drafted, and an owner who
 * stops reviewing stops the writing rather than burying themselves. Another
 * campaign's unreviewed drafts are that campaign's backlog and never starve
 * this one. Publish on, nothing waits for a yes — an armed draft is a send —
 * so that arm has no backlog term at all; what bounds it is the committed
 * supply, and the send-time cap and pacing bind as they always did.
 *
 * DRAFTING IS NOT POSTING, and the two lines say so from opposite ends. Posting
 * is paced by the day plan's slots whatever either line answers — an armed draft
 * takes the next open anchor and nothing else does — so neither line has to be
 * the plan to keep the account paced.
 *
 * Publish on, a draft is a send, so the worker writes into the plan as far
 * ahead as the account writes — its next few slots or the rest of its day
 * (`AUTOMATIC_BUFFER`) — and comes back for what that leaves (`nextWakeAt`
 * aims at the first slot the supply does not cover). Publish off, nothing
 * sends until the owner says yes, so the worker drafts what the account can
 * still post today — the day's budget, read by `daySlots` — and, while its
 * campaign's backlog is a day's cap deep, the wake is the day's recheck rather
 * than an anchor per skipped run.
 *
 * `demandTriage` is a third, INDEPENDENT arm at the bottom of this file. It
 * answers the same question one step earlier in the funnel — how much curation
 * a campaign's candidate pool needs — from candidates rather than from the day
 * plan, and nothing composes the two. `daySlots` beside it is the fourth: how
 * many conversations today still has room for, which only a campaign that
 * verifies reads.
 */

/**
 * Supply is a comment the account is committed to sending: approved — slotted
 * or not — or going out now.
 *
 * `proposed` is not: it waits on a yes that may be a no, and it bounds only the
 * publish-off arm's drafting, through its own campaign's backlog
 * (`underBacklog`). `posted`, `failed`, `rejected` and
 * `suppressed_dryrun` are done with. `needs_review` is an unverified send
 * awaiting a human (schema.ts:2361-2362), not a draft anyone is waiting on —
 * counting it would park demand behind a row that may already be live on
 * LinkedIn.
 */
const COMMITTED_STATUSES = ["approved", "posting"] as const;

/**
 * How far ahead the publish-on arm tops the plan up.
 *
 * A CODE CONSTANT, channel-scoped in effect: it is only ever applied to one
 * channel's own day plan, so the account it bounds is the account the arm is
 * already about. A per-worker column would say the same thing worse — it would
 * hand two workers on one account two lookaheads onto ONE plan (INV-4), where
 * the shorter one re-requests every anchor the longer one already filled, and
 * it would spend a column on a number no owner has a reason to move (D28).
 *
 * NOT `PLAN_HORIZON_DAYS` (`schedule.ts:371`), which is a different job: that
 * one is the walker's own SEARCH bound — how many day windows it will walk
 * before giving up, after which `anchorsInRange` truncates and `assignSlots`
 * falls back to `jitterGap` (`schedule.ts:548-563`, `:570`). This one is the
 * ASK. They never meet: a day is far inside three weeks, so the walker's
 * `w.open >= opts.to` break fires first on every call this module makes and the
 * search bound is inert here. Unifying them would give the assigner a one-day
 * reach and this arm a three-week one, both wrong.
 *
 * Exported so the guard at the foot of `demand.test.ts` can pin its value;
 * nothing outside this module reads it.
 */
export const TOP_UP_HORIZON_MS = 24 * 60 * 60_000;

/**
 * How many of the plan's next slots a publish-on worker keeps supplied when
 * the account writes the next few ahead (`channels.write_ahead`), counting the
 * comments it has drafted and armed that have not left the account yet.
 *
 * The account chooses between two prices for the same posting. NEXT FEW pays
 * in catching up: three slots covered and every later one left to a run that
 * reads a fresher pool, because an armed draft is a send waiting for its slot
 * and the post it answers ages while it waits — but a day the Mac slept
 * through comes back three slots at a time. REST OF THE DAY pays in age: one
 * run supplies every slot the day has left (`restOfDayPlan`), the same-day
 * make-up included, so a wake after a sleep refills the whole day at once and
 * the earliest of those comments wait longest for their slot.
 *
 * Neither moves a send. Each comment still goes out at its slot under the
 * caps, the gaps, the window and the Stop, and the wake aims at the first slot
 * the supply does not cover — the next one past the buffer, or the next day's
 * first once the day is supplied.
 */
export const AUTOMATIC_BUFFER = 3;

export type CommentDemand = {
  /** What a worker should draft now. */
  drafts: number;
  /** Publish-on: plan slots in the horizon, or left in the day when the
   *  account writes the rest of it ahead. Publish-off: the day's comments
   *  (`daySlots`' cap) — the budget an unarmed worker drafts against. */
  anchors: number;
  /** What already counts against `anchors`. Publish-on: every committed
   *  worker comment. Publish-off: every comment posted in the last day or
   *  committed to sending. Never a draft waiting for a yes. */
  supply: number;
};

/**
 * `wanted`, under the one bound drafts waiting for the owner's yes put on
 * drafting: never past a day's cap of them waiting, so none while that many
 * wait. Never negative — a stage is never handed one.
 */
function underBacklog(wanted: number, cap: number, waiting: number): number {
  return Math.max(0, Math.min(wanted, cap - waiting));
}

/**
 * Every comment of one campaign waiting for the owner's yes — every origin.
 * The backlog `underBacklog` bounds; never supply. The campaign's own, because
 * the yes is asked of the owner per campaign, and a campaign whose owner has
 * not caught up is no reason to stop another's.
 */
export async function waitingForYes(tx: Tx, campaignId: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.kind, "comment"),
        eq(messages.status, "proposed"),
        eq(messages.campaignId, campaignId),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Whether a campaign's backlog is a day's cap deep: its drafts waiting for a
 * yes are as many as the account may post in a day. Publish-off drafts nothing
 * while it is, and `nextWakeAt` wakes its workers for the recheck rather than
 * an anchor.
 */
export async function backlogFull(
  tx: Tx,
  channel: Channel,
  campaignId: number,
  now: number,
): Promise<boolean> {
  return (await waitingForYes(tx, campaignId)) >= effectiveDailyCommentCap(channel, now);
}

/**
 * Every committed worker-origin comment on the account.
 *
 * THE SCOPE IS THE CHANNEL, spelled as the org. `messages` carries no
 * `channel_id` and every org holds exactly one `channels` row, so the tenant
 * transaction's RLS already scopes this count to the one account — the same
 * known debt Phase 4 left where a per-network noun is spelled per-org. Two
 * publish-on workers on one account must share one buffer (INV-4); a
 * per-worker count would hand each of them a full one.
 *
 * THE ORIGIN IS THE worker'S. `pacingPolicy(channel, "owner", …)` returns
 * `useDayPlanAnchors: false` (ratelimit/ledger.ts:198-208): an owner-authored
 * send chains at min-gap and consumes no anchor, so it must not be subtracted
 * from a plan it never entered (INV-1). Owner rows no more fill the worker's
 * buffer than they consume its plan.
 *
 * NOT A DRAFT WAITING FOR A YES. A no frees nothing it held, so counting one
 * read a plan as supplied by rows that may never send — across campaigns, so
 * one campaign's unreviewed drafts slept another's Scout until the next day.
 *
 * THERE IS NO TIME BOUND. Every row counted here will consume an
 * anchor whenever its slot falls: one scheduled in the past has still not left
 * the account, and a slotless one takes an anchor the moment it slots. The case
 * that makes a bound actively wrong is a row PUSHED past a saturated cap —
 * `nextClearSlot` only ever advances (the cap push, `schedule.ts:180-189`) and
 * returns unconditionally (`:218`), so slot assignment has no refusal branch and
 * supply lands days out instead of not landing. Subtracting only what sits
 * inside the horizon reads that supply as absent and re-requests the plan it
 * already filled, every run, forever.
 *
 * Exported for the wake (`nextWakeAt`), which reads this same count as the
 * anchors it spends, so the two never disagree about what is supplied.
 */
export async function committedWorkerSupply(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.kind, "comment"),
        eq(messages.publishOrigin, "worker"),
        inArray(messages.status, [...COMMITTED_STATUSES]),
      ),
    );
  return row?.n ?? 0;
}

/** The day plan over the top-up horizon, read once for both readers of it:
 *  its anchors and the committed supply they are net of. */
async function readPlan(
  tx: Tx,
  channel: Channel,
  now: number,
): Promise<{ anchors: number; supply: number }> {
  // The plan's own inputs, verified against the assigner rather than
  // re-derived: `assignSlots` walks `planDayAnchors` with
  // `pacingPolicy(channel, "worker", now).commentDailyCap` — which is
  // `effectiveDailyCommentCap(channel, now)` (`ratelimit/ledger.ts:211`) —
  // and with `commentFloorGapMs(channel)` (`schedule.ts:463`, `:498`,
  // `:556-557`). Any other pair here would count anchors assignment will
  // never produce, which is the drift `commentFloorGapMs`'s own docstring
  // (`schedule.ts:373-376`) exists to forbid.
  const cap = effectiveDailyCommentCap(channel, now);
  const anchors = anchorsInRange(channel, {
    from: now,
    to: now + TOP_UP_HORIZON_MS,
    effDaily: cap,
    floorGapMs: commentFloorGapMs(channel),
  }).length;
  return { anchors, supply: await committedWorkerSupply(tx) };
}

/**
 * How much room the account's day plan has over the next day: its anchors in
 * the top-up horizon net of every committed worker comment.
 *
 * What the plan LACKS, which is not what a worker drafts. It is the number the
 * owner's agent reads as "the plan has room" (the queue read) and the
 * refill email counts in slots; an armed worker drafts as far into it as the
 * account writes ahead (`computeCommentDemand`), and the wake brings it back
 * for the rest.
 * It is the plan's room whoever has drafts waiting: a draft is not supply, and
 * what it takes of the room is the owner's yes to give.
 */
export async function planTopUp(
  tx: Tx,
  channel: Channel,
  now: number,
): Promise<CommentDemand> {
  const plan = await readPlan(tx, channel, now);
  return {
    drafts: Math.max(0, plan.anchors - plan.supply),
    anchors: plan.anchors,
    supply: plan.supply,
  };
}

/**
 * @param opts.channel the account the demand is about — the publish-on arm
 *   walks ITS day plan; the off arm reads ITS day.
 * @param opts.campaignId the campaign the worker serves — whose waiting drafts
 *   are the backlog the off arm is bounded by.
 * @param opts.publish whether the worker asking is armed to send.
 * @param now required, never defaulted: demand is only true at one instant,
 *   both arms read it, and every caller this phase wires already holds a
 *   clock.
 */
export async function computeCommentDemand(
  tx: Tx,
  opts: { channel: Channel; campaignId: number; publish: boolean },
  now: number,
): Promise<CommentDemand> {
  if (opts.publish) {
    if (opts.channel.writeAhead === "rest_of_day") {
      // The day the plan is spending, or the one it opens next — inside the
      // horizon, as the next few are: a day that opens past it is not yet
      // the account's to write for.
      const slots = (await restOfDayPlan(tx, opts.channel, now)).slots.filter(
        (slot) => slot < now + TOP_UP_HORIZON_MS,
      ).length;
      const supply = await committedWorkerSupply(tx);
      return { drafts: Math.max(0, slots - supply), anchors: slots, supply };
    }
    const plan = await readPlan(tx, opts.channel, now);
    return {
      drafts: Math.max(0, Math.min(AUTOMATIC_BUFFER, plan.anchors) - plan.supply),
      anchors: plan.anchors,
      supply: plan.supply,
    };
  }
  // The day's budget, from ONE read of the rows that spend it and of the
  // backlog that bounds it.
  const day = await daySlots(tx, opts.channel, now, opts.campaignId);
  return {
    drafts: day.toDraft,
    anchors: day.cap,
    supply: day.posted + day.queued,
  };
}

/**
 * How many conversations today still has room for — spec 6's fill-the-day
 * arithmetic, one answer for the scout that verifies and the Ambassador that
 * drafts (INV-5):
 *
 *   open    = max(0, cap − posted today − approved or sending)
 *   toDraft = max(0, min(open, cap − this campaign's drafts waiting on a yes))
 *   toFind  = max(0, toDraft − confirmed matches nothing is written for yet)
 *
 * A draft waiting on a yes takes no slot of the day — the owner may say no —
 * and bounds it only as the campaign's backlog: drafting never takes that past
 * a day's cap, so a day's cap of them stops the drafting, and with it the
 * finding (`underBacklog`). Another campaign's waiting drafts are not this
 * one's backlog. A worker whose drafts never wait (publish on) is bounded by
 * `open` alone.
 *
 * EVERY ORIGIN counts, unlike `committedWorkerSupply` above. That one sizes
 * the plan's anchors, which the owner's own comment never takes; this sizes how
 * many conversations to put in front of the owner in a day, and one they wrote
 * themselves is one of them. The cap is the day's yardstick here, never a
 * ceiling on the owner: nothing reads this to refuse their words.
 *
 * Comments only: a reply is paced by caps of its own and takes no slot here.
 *
 * The account's work day (`workDay`), like every daily cap the ledger
 * enforces. What the day has spent — posted, approved or sending — is the
 * org's, which is the account's for the reason `committedWorkerSupply` gives.
 * The drafts waiting and the confirmed matches are the campaign's: the day's
 * slots are the account's one budget, but a campaign's Ambassador drafts only
 * its own campaign's matches, so a match confirmed on another campaign fills
 * no slot of this one's. Nor
 * does one Research left to the owner (`author_maybe`), or a room-only one
 * whose author isn't the audience (`roomOnlySql`), until they ask for its
 * draft: the Ambassador never writes it, so the Scout keeps finding.
 */
export type DaySlots = {
  cap: number;
  posted: number;
  queued: number;
  /** This campaign's drafts waiting on a yes. */
  waiting: number;
  confirmed: number;
  open: number;
  toDraft: number;
  toFind: number;
};

export async function daySlots(
  tx: Tx,
  channel: Channel,
  now: number,
  campaignId: number,
): Promise<DaySlots> {
  const cap = effectiveDailyCommentCap(channel, now);
  const dayOpen = workDay(now, channel.activeHours, channel.activeDays).open;
  const [comments] = await tx
    .select({
      posted: sql<number>`count(*) filter (where ${messages.status} = 'posted' and ${messages.postedAt} >= ${dayOpen})::int`,
      queued: sql<number>`count(*) filter (where ${messages.status} in ('approved', 'posting'))::int`,
      waiting: sql<number>`count(*) filter (where ${messages.status} = 'proposed' and ${messages.campaignId} = ${campaignId})::int`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.kind, "comment"),
        inArray(messages.status, ["posted", "approved", "posting", "proposed"]),
      ),
    );
  const [found] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(discoveredPosts)
    .where(
      and(
        eq(discoveredPosts.verifyVerdict, "confirmed"),
        eq(discoveredPosts.campaignId, campaignId),
        inArray(discoveredPosts.status, [...ACTIONABLE_CANDIDATE_STATUSES, "draft_requested"]),
        or(eq(discoveredPosts.status, "draft_requested"), not(forOwnerSql())),
        or(eq(discoveredPosts.status, "draft_requested"), not(roomOnlySql())),
        notExists(
          tx
            .select({ id: messages.id })
            .from(messages)
            .where(eq(messages.discoveredPostId, discoveredPosts.id)),
        ),
      ),
    );
  const posted = comments?.posted ?? 0;
  const queued = comments?.queued ?? 0;
  const waiting = comments?.waiting ?? 0;
  const confirmed = found?.n ?? 0;
  const open = Math.max(0, cap - posted - queued);
  const toDraft = underBacklog(open, cap, waiting);
  return {
    cap,
    posted,
    queued,
    waiting,
    confirmed,
    open,
    toDraft,
    toFind: Math.max(0, toDraft - confirmed),
  };
}
