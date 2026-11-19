import { and, asc, eq, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  type ActiveHours,
  campaigns,
  channels,
  incomingComments,
  messages,
  organizations,
} from "@engager/database/schema";
import { assertValidActiveHours } from "../campaigns/activeHours";
import { wakeHeldReads } from "../leads/scout/wake";
import { PUBLIC_CAMPAIGN_NUMERIC_LIMITS } from "../campaigns/defaults";
import { DEFAULT_NETWORK } from "../network/registry";
import { INBOX_CHECK_MINUTES, REPLY_CHECK_MINUTES } from "../pacing";
import { lockEngagementSafety, setKillSwitch } from "../ratelimit/killswitch";
import { DAY_KEYS } from "../time";
import {
  InvalidCampaignInputError,
  InvalidCampaignScheduleError,
} from "./campaigns";
import { suspendWorkerPublishing } from "./learningSignals";
import {
  DAILY_READ_CAP_BOUNDS,
  DAILY_REPLY_CHECK_CAP_BOUNDS,
  SEARCH_CAP_BOUNDS,
} from "./readBudgets";
import { WRITE_AHEAD, type WriteAhead } from "./writeAhead";
import type { Tx } from "@engager/database/tenant";
import { trackStopChanged } from "../telemetry/emit";

/**
 * EVERY number that paces the connected account, in one place — the two ceilings
 * `canEngage` has always enforced org-wide, plus the ten knobs Phase 4 moved
 * off the campaign onto the `channels` row. One LinkedIn account per org, one
 * exposure budget (INV-4): the campaign says WHAT to hunt for, this says how
 * fast the account may act.
 *
 * Ten and not eleven since T-11.7: the lane delay's CEILING half was the one
 * member no gate, plan or projection ever read, so it left the type with its
 * column and `minDelaySec` stands alone.
 *
 * This is now the ONLY write surface for them. The campaign→channel mirror
 * that carried them during the move is retired in the same landing, because a
 * surviving mirror would silently revert the account's caps to a campaign row's
 * frozen values on the next edit or activation.
 *
 * 0 disables a limit where a limit is optional. Bounds keep a typo from turning
 * the ceiling into a firehose or freezing the account for a day; the ten
 * reuse `PUBLIC_CAMPAIGN_NUMERIC_LIMITS`, the same bounds their public schema
 * carried as campaign inputs.
 *
 * The two research-read budgets ride along because they are the account's
 * too, but they meter reads rather than exposure, and their 0 means the
 * opposite: no reads at all, not no limit. The two discovery search limits, a
 * day and an hour, ride along the same way and have no top besides: the
 * product advises past a number and never refuses (INV-6). So do the two check
 * cadences:
 * minutes between looks for replies and for messages, each always jittered
 * and always inside the active window, with no 0 at all. And so does the
 * reply-check budget: a read budget kept apart from Research's, never 0. And
 * so does how far ahead an Automatic Comment step writes: a choice of two
 * that sizes drafting and never a send.
 */
export type OrgSafety = {
  dailyEngageCap: number;
  minActionGapSec: number;
  dailyCommentCap: number;
  dailyReplyCap: number;
  perProfileDayCap: number;
  perProfileWeekCap: number;
  perProfileMonthCap: number;
  minDelaySec: number;
  /** The ramp's length; 0 is Off — no ramp, every cap as set. */
  warmupWeeks: number;
  /** Null = the default ramp from 25% of `dailyCommentCap`. */
  warmupStartRate: number | null;
  activeHours: ActiveHours | null;
  activeDays: string[] | null;
  /** Research reads a day, spent verifying matches; 0 turns the read off. */
  dailyThreadReadCap: number;
  dailyProfileReadCap: number;
  /** Discovery searches the account may make in a rolling 24 hours and in an
   *  hour, across every campaign on it (`discoverBudget`). No ceiling; 0 turns
   *  discovery reads off. */
  dailySearchPageCap: number;
  hourlySearchCap: number;
  /** Reply and DM checks a day — reads of the threads under our own comments,
   *  of the notification cards, and of the inbox and its conversations — on a
   *  budget of their own, so Research never spends them (`reserveReplyCheck`). */
  dailyReplyCheckCap: number;
  /** A fresh comment watch's check cadence, in minutes (`REPLY_CHECK_MINUTES`). */
  replyCheckBaseMin: number;
  /** The light inbox check's cadence, in minutes (`INBOX_CHECK_MINUTES`). */
  inboxCheckBaseMin: number;
  /** How far ahead an Automatic Comment step writes into the day plan
   *  (`computeCommentDemand`): its next few slots, or the rest of the day. */
  writeAhead: WriteAhead;
};

/**
 * Global hard stop PLUS the three-mode rule that a kill-switch trip drops
 * Auto to Review, visibly (down-shifts never need permission; turning
 * publishing back on is the owner's own act). ONE implementation shared by the
 * MCP `stop` tool and the local dashboard, so the drop rule can
 * never diverge.
 */
export async function applyKillSwitch(
  tx: Tx,
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  await setKillSwitch(tx, enabled);
  if (enabled) {
    await suspendWorkerPublishing(tx, organizationId, "kill_switch");
  }
  // Usage data: the owner's Stop everything, pressed or lifted. Nothing else
  // calls this (a pause Engager puts on itself is a different record).
  trackStopChanged({ scope: "everything", on: enabled, by: "owner" }, tx);
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(v)));

/** The same clamp against a `PUBLIC_CAMPAIGN_NUMERIC_LIMITS` entry, so the
 *  eleven moved knobs keep the exact bounds their campaign schema carried. */
const clampTo = (v: number, bounds: { min: number; max: number }) =>
  clamp(v, bounds.min, bounds.max);

/**
 * The ceilings now live on the CHANNEL — the connected account that actually
 * owns the exposure (INV-4). The name and signature are unchanged on purpose:
 * the `get_channel` / `update_channel` MCP tools, the dashboard safety
 * page and actions, and `firstRadar`'s planner clamp all repoint without an
 * edit, and the surfaces that already describe this cap as account-level become
 * TRUE by the move with their text untouched.
 *
 * `channels` is RLS-forced and every caller runs inside a `withOrg` tx, so the
 * explicit organization predicate the `organizations` read needed is gone —
 * that table sits outside RLS; this one does not.
 */
export async function getOrgSafety(
  tx: Tx,
  _organizationId: string,
): Promise<OrgSafety | null> {
  const [row] = await tx
    .select({
      dailyEngageCap: channels.dailyEngageCap,
      minActionGapSec: channels.minActionGapSec,
      dailyCommentCap: channels.dailyCommentCap,
      dailyReplyCap: channels.dailyReplyCap,
      perProfileDayCap: channels.perProfileDayCap,
      perProfileWeekCap: channels.perProfileWeekCap,
      perProfileMonthCap: channels.perProfileMonthCap,
      minDelaySec: channels.minDelaySec,
      warmupWeeks: channels.warmupWeeks,
      warmupStartRate: channels.warmupStartRate,
      activeHours: channels.activeHours,
      activeDays: channels.activeDays,
      dailyThreadReadCap: channels.dailyThreadReadCap,
      dailyProfileReadCap: channels.dailyProfileReadCap,
      dailySearchPageCap: channels.dailySearchPageCap,
      hourlySearchCap: channels.hourlySearchCap,
      dailyReplyCheckCap: channels.dailyReplyCheckCap,
      replyCheckBaseMin: channels.replyCheckBaseMin,
      inboxCheckBaseMin: channels.inboxCheckBaseMin,
      writeAhead: channels.writeAhead,
    })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .orderBy(asc(channels.id))
    .limit(1);
  return row ?? null;
}

/**
 * What this patch WOULD store, given what is stored now.
 *
 * Extracted from `updateOrgSafety` for one caller that has to know the answer
 * without writing it: chat's pending change draws a before → after card, and
 * the "after" on it has to be the number the account will actually hold, not
 * the number the model named. Every one of these knobs is clamped rather than
 * refused, so the two can differ — a proposal of 400 comments a day lands as
 * 100 — and a card that promised 400 would be the product lying about the
 * change the owner just approved.
 *
 * Pure, and the WHOLE decision: validation throws from here too, so a proposal
 * is refused by exactly what refuses the page's save. The write below is all
 * that is left outside it, which is what makes "the card shows what the save
 * stores" an equality between two calls of one function rather than two
 * implementations someone has to keep in step.
 */
export function orgSafetyAfter(
  current: OrgSafety,
  patch: Partial<OrgSafety>,
): OrgSafety {
  if (patch.activeHours) assertValidActiveHours(patch.activeHours);
  if (patch.activeDays?.length === 0) throw new InvalidCampaignScheduleError();
  // Day NAMES, not just a non-empty list. `isAllowedDay` compares against
  // `DAY_KEYS`, so a misspelled day is not an error anywhere downstream — it
  // simply never matches, and the window closes forever without raising. The
  // campaign path checked this before the move; the check belongs to whichever
  // surface writes the column.
  for (const day of patch.activeDays ?? []) {
    if (!DAY_KEYS.includes(day.toLowerCase() as (typeof DAY_KEYS)[number])) {
      throw new InvalidCampaignInputError("activeDays", DAY_KEYS);
    }
  }
  if (patch.writeAhead !== undefined && !WRITE_AHEAD.includes(patch.writeAhead)) {
    throw new InvalidCampaignInputError("writeAhead", WRITE_AHEAD);
  }
  const limits = PUBLIC_CAMPAIGN_NUMERIC_LIMITS;
  const warmupWeeks = patch.warmupWeeks ?? current.warmupWeeks;
  // `??` for the numbers, `!== undefined` for the three nullable fields: a
  // caller clearing `warmupStartRate` back to the default ramp, or detaching a
  // window, sends an explicit null that `??` would silently read as "unchanged".
  const next: OrgSafety = {
    dailyEngageCap: clamp(patch.dailyEngageCap ?? current.dailyEngageCap, 0, 1000),
    minActionGapSec: clamp(patch.minActionGapSec ?? current.minActionGapSec, 0, 3600),
    dailyCommentCap: clampTo(
      patch.dailyCommentCap ?? current.dailyCommentCap,
      limits.dailyCommentCap,
    ),
    dailyReplyCap: clampTo(patch.dailyReplyCap ?? current.dailyReplyCap, limits.dailyReplyCap),
    perProfileDayCap: clampTo(
      patch.perProfileDayCap ?? current.perProfileDayCap,
      limits.perProfileDayCap,
    ),
    perProfileWeekCap: clampTo(
      patch.perProfileWeekCap ?? current.perProfileWeekCap,
      limits.perProfileWeekCap,
    ),
    perProfileMonthCap: clampTo(
      patch.perProfileMonthCap ?? current.perProfileMonthCap,
      limits.perProfileMonthCap,
    ),
    minDelaySec: clampTo(patch.minDelaySec ?? current.minDelaySec, limits.delaySec),
    // Only an explicit 0 is Off: a stray fraction or a negative rounds to the
    // shortest ramp, never to no ramp at all.
    warmupWeeks: warmupWeeks === 0 ? 0 : clampTo(warmupWeeks, limits.warmupWeeks),
    warmupStartRate:
      patch.warmupStartRate !== undefined
        ? patch.warmupStartRate === null
          ? null
          : clampTo(patch.warmupStartRate, limits.warmupStartRate)
        : current.warmupStartRate,
    activeHours:
      patch.activeHours !== undefined ? patch.activeHours : current.activeHours,
    activeDays: patch.activeDays !== undefined ? patch.activeDays : current.activeDays,
    dailyThreadReadCap: clampTo(
      patch.dailyThreadReadCap ?? current.dailyThreadReadCap,
      DAILY_READ_CAP_BOUNDS,
    ),
    dailyProfileReadCap: clampTo(
      patch.dailyProfileReadCap ?? current.dailyProfileReadCap,
      DAILY_READ_CAP_BOUNDS,
    ),
    dailySearchPageCap: clampTo(
      patch.dailySearchPageCap ?? current.dailySearchPageCap,
      SEARCH_CAP_BOUNDS,
    ),
    hourlySearchCap: clampTo(
      patch.hourlySearchCap ?? current.hourlySearchCap,
      SEARCH_CAP_BOUNDS,
    ),
    dailyReplyCheckCap: clampTo(
      patch.dailyReplyCheckCap ?? current.dailyReplyCheckCap,
      DAILY_REPLY_CHECK_CAP_BOUNDS,
    ),
    replyCheckBaseMin: clampTo(
      patch.replyCheckBaseMin ?? current.replyCheckBaseMin,
      REPLY_CHECK_MINUTES,
    ),
    inboxCheckBaseMin: clampTo(
      patch.inboxCheckBaseMin ?? current.inboxCheckBaseMin,
      INBOX_CHECK_MINUTES,
    ),
    writeAhead: patch.writeAhead ?? current.writeAhead,
  };
  return next;
}

export async function updateOrgSafety(
  tx: Tx,
  organizationId: string,
  patch: Partial<OrgSafety>,
): Promise<OrgSafety | null> {
  const current = await getOrgSafety(tx, organizationId);
  if (!current) return null;
  const next = orgSafetyAfter(current, patch);
  // No delay-ORDER refusal here any more, because there is no pair left to
  // order: the ceiling half had no reader anywhere in the engine, and the check
  // existed only to keep the two sides of a limit nothing enforced consistent
  // with each other. `minDelaySec` is a floor, and a floor is complete alone —
  // `canEngage` and `commentFloorGapMs` clamp it to 30s and space every send by
  // it, whoever wrote them.
  //
  // The channel row is where every one of these numbers lives — it is what
  // `canEngage` reads.
  //
  // Warm-up turned back on ramps from now: its clock was stamped when
  // publishing was first armed, and a ramp counted from then would have
  // nothing left to ramp. An account never armed keeps no clock, and takes its
  // stamp when it is (`stampChannelWarmupStart`).
  const now = Date.now();
  const rampRestarts = current.warmupWeeks === 0 && next.warmupWeeks > 0;
  await tx
    .update(channels)
    .set({
      ...next,
      ...(rampRestarts
        ? { warmupStartedAt: sql`case when ${channels.warmupStartedAt} is null then null else ${now}::bigint end` }
        : {}),
      updatedAt: now,
    })
    .where(eq(channels.network, DEFAULT_NETWORK));
  // More profile reads free whoever the spent ones held, now rather than when
  // the next old read ages out.
  if (next.dailyProfileReadCap > current.dailyProfileReadCap) await wakeHeldReads(tx, organizationId);
  return next;
}

/**
 * Org-level policy for replying to comments on the org's OWN posts. Own posts
 * exist independently of campaigns (a campaign engages OTHER people's posts;
 * its Reply mode gates only thread replies that campaign started), so this
 * lives next to the other account-level knobs. null = feature off.
 */
export type OwnPostReplies = {
  mode: "off" | "review" | "auto";
  sensitivity_gate: boolean;
  prompt: string;
};

export const OWN_POST_REPLIES_DEFAULTS: OwnPostReplies = {
  mode: "off",
  sensitivity_gate: true,
  prompt: "Reply warmly, answer the question, never pitch.",
};

/** GUC-scoped variant for job handlers (HandlerCtx carries no org id): resolves
 *  the org from `app.current_org` set by the enclosing withOrg tx. */
export async function getOwnPostRepliesScoped(tx: Tx): Promise<OwnPostReplies> {
  const [org] = await tx
    .select({ ownPostReplies: organizations.ownPostReplies })
    .from(organizations)
    .where(
      sql`${organizations.id} = nullif(current_setting('app.current_org', true), '')::uuid`,
    );
  return org?.ownPostReplies ?? OWN_POST_REPLIES_DEFAULTS;
}

/** Whether the current org's Find leads screen drops a short comment with no
 *  question by rule, before any model call (`organizations.lead_screen_rule`,
 *  off by default). */
export async function leadScreenRuleOn(tx: Tx): Promise<boolean> {
  const [org] = await tx
    .select({ leadScreenRule: organizations.leadScreenRule })
    .from(organizations)
    .where(
      sql`${organizations.id} = nullif(current_setting('app.current_org', true), '')::uuid`,
    );
  return org?.leadScreenRule ?? false;
}

export async function getOwnPostReplies(
  tx: Tx,
  organizationId: string,
): Promise<OwnPostReplies | null> {
  const [org] = await tx
    .select({ ownPostReplies: organizations.ownPostReplies })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!org) return null;
  return org.ownPostReplies ?? OWN_POST_REPLIES_DEFAULTS;
}

export async function updateOwnPostReplies(
  tx: Tx,
  organizationId: string,
  patch: Partial<OwnPostReplies>,
): Promise<OwnPostReplies | null> {
  const [org] = await tx
    .select({ ownPostReplies: organizations.ownPostReplies })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  if (!org) return null;
  const current = org.ownPostReplies ?? OWN_POST_REPLIES_DEFAULTS;
  const next: OwnPostReplies = {
    mode: patch.mode ?? current.mode,
    sensitivity_gate: patch.sensitivity_gate ?? current.sensitivity_gate,
    prompt: patch.prompt ?? current.prompt,
  };
  const wasEffectiveAutoPost = current.mode === "auto";
  const willEffectiveAutoPost = next.mode === "auto";
  // No fence here at all (INV-6): arming the own-post reply lane is the
  // owner's choice of mode, and the sends it produces are capped like any
  // other unattended work because pacing reads each message's provenance
  // rather than a mode.
  await tx
    .update(organizations)
    .set({ ownPostReplies: next, updatedAt: Date.now() })
    .where(eq(organizations.id, organizationId));
  if (wasEffectiveAutoPost && !willEffectiveAutoPost) {
    await tx
      .update(messages)
      .set({ status: "proposed", scheduledAt: null })
      .where(
        and(
          eq(messages.kind, "reply"),
          eq(messages.status, "approved"),
          sql`exists (select 1 from ${incomingComments} where ${incomingComments.id} = ${messages.incomingCommentId} and ${incomingComments.source} = 'own_post')`,
        ),
      );
  }
  return next;
}

/**
 * Rename the org — the one identity field the owner may edit in-app. The slug
 * stays immutable: setup minted it as an identifier and identifiers do not
 * follow a display name around. Explicit id predicate because `organizations`
 * sits outside forced RLS (see the note above `getOrgSafety`).
 */
export async function renameOrganization(
  tx: Tx,
  organizationId: string,
  name: string,
): Promise<{ name: string; slug: string } | null> {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    throw new AppError(
      "invalid_org_name",
      "The organization name must not be empty",
      400,
    );
  }
  if (trimmed.length > 120) {
    throw new AppError(
      "invalid_org_name",
      "The organization name must be 120 characters or fewer",
      400,
    );
  }
  const [row] = await tx
    .update(organizations)
    .set({ name: trimmed, updatedAt: Date.now() })
    .where(eq(organizations.id, organizationId))
    .returning({ name: organizations.name, slug: organizations.slug });
  return row ?? null;
}

/**
 * This account's live write authority — the flag `canEngage` reads on every
 * send. False on a missing row: an install with no channel row has no account
 * to grant authority for, and fail-closed is the only honest answer.
 */
export async function getChannelWriteAuthority(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ writesEnabled: channels.writesEnabled })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .orderBy(asc(channels.id))
    .limit(1);
  return row?.writesEnabled ?? false;
}

/**
 * Flip the account's write authority. The DASHBOARD's own write switch is the
 * one caller that may enable — no MCP tool writes this, and the agent must
 * never flip it (the doctrine `ENGAGER_BROWSER_WRITES` carried, kept by the
 * column). Serialized under `lockEngagementSafety` beside the kill-switch and
 * pause writes it shares gates with.
 *
 * Deliberately NO side effect on queued work, in contrast to
 * `applyKillSwitch`'s drop rule: turning writes off is a hold, not a verdict —
 * approved messages stay approved and simply replan at the gate until the
 * owner turns it back on.
 */
export async function setChannelWriteAuthority(
  tx: Tx,
  enabled: boolean,
): Promise<boolean | null> {
  await lockEngagementSafety(tx);
  const [row] = await tx
    .update(channels)
    .set({ writesEnabled: enabled, updatedAt: Date.now() })
    .where(eq(channels.network, DEFAULT_NETWORK))
    .returning({ writesEnabled: channels.writesEnabled });
  return row?.writesEnabled ?? null;
}
