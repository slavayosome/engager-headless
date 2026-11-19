import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { campaigns, channels, leads, leadSignals, type Lead } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { openPauses, scopesOf } from "../../actions/pause";
import { enqueue } from "../../jobs/queue";
import { freshProfileRead } from "../../operations/researchReads";
import { getSystemState } from "../../ratelimit/killswitch";
import { profileReadsLeft } from "../../ratelimit/ledger";
import { driftPastOpen, withinActiveWindow } from "../../time";
import { asideNow } from "../setAside";
import { leadStandings } from "./eligibility";
import { profilesHeldNote } from "./research";

/**
 * THE OWNER'S RESEARCH PRESS: Research on one Signal, or on the newest ten.
 * The press reads nothing itself. It freezes who is to be read, takes reads
 * for them from what the account has left today, marks each "Researching…"
 * and queues one `research_signals` job with their ids, which reads, qualifies
 * and serves each in order under the account's run lease
 * (`jobs/handlers/researchSignals.ts`). It never raises a cap and never takes
 * more reads than are left; a person whose profile was read inside its window
 * takes none. Outside the account's active hours the job waits for them to
 * open, and the request is dated from then. Under the kill switch, a pause or
 * a Stop on the account or the campaign it queues nothing, and says why. It
 * sends nothing and drafts nothing.
 */

/** The most people one press researches. */
export const RESEARCH_PRESS_MAX = 10;

/** How long a press waits for the account's run lease before it gives up. */
export const PRESS_WAIT_MS = 60 * 60_000;
/** How long "Researching…" can stand: the wait, the job's own budget
 *  (`TYPE_BUDGET_MS.research_signals`) and a margin. A request older than this
 *  belongs to a job that died: its person is a Signal again, and no read is
 *  promised for them. Whatever shows the pill asks the same. */
export const RESEARCH_PENDING_MS = PRESS_WAIT_MS + 20 * 60_000 + 5 * 60_000;

/** The Signals one press asks for: these, or the campaign's newest. */
export type ResearchPress = { campaignId: number; now: number } & (
  | { leadIds: readonly number[] }
  | { newest: number }
);

export type ResearchPressResult = {
  /** The people queued: "10 profile reads reserved". */
  queued: number;
  /** The profile reads left today once those are taken. */
  readsLeft: number;
  /** Why nothing was queued, in the owner's words, where the account or the
   *  campaign is stopped; null otherwise. */
  refused: string | null;
};

/**
 * Why Research may not be pressed on a campaign now, in the owner's words: the
 * kill switch, the account paused, or a Stop on the account or the campaign.
 * Null when it may.
 */
export async function researchRefusal(tx: Tx, campaign: { id: number; channelId: number }, now: number): Promise<string | null> {
  const state = await getSystemState(tx);
  if (state?.killSwitch) return profilesHeldNote("kill switch", null);
  if (state?.pausedUntil && state.pausedUntil > now) return profilesHeldNote("paused", null);
  const [stop] = await openPauses(tx, scopesOf({ channelId: campaign.channelId, campaignId: campaign.id, conversationId: null }));
  if (!stop) return null;
  return `Research not run — ${stop.scope === "account" ? "the account" : "this campaign"} is stopped`;
}

/** Serializes the presses on one account, so two cannot take the same read. */
async function lockPresses(tx: Tx, channelId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('research_press:' || coalesce(current_setting('app.current_org', true), '') || ':' || ${String(channelId)}))`,
  );
}

/**
 * The profile reads a press can still take on an account today: what is left
 * of its daily reads, less one for each person an earlier press queued that
 * has no profile read of theirs to go on and is not yet read. The Leads page's
 * "1 of today's 12 remaining profile reads".
 */
export async function pressReadsLeft(tx: Tx, channelId: number, now: number): Promise<number> {
  const waiting = await tx
    .select({ lead: leads })
    .from(leads)
    .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .where(and(eq(campaigns.channelId, channelId), gt(leads.researchRequestedAt, now - RESEARCH_PENDING_MS)));
  let promised = 0;
  for (const { lead } of waiting) if ((await freshProfileRead(tx, lead.profileId, now)) === null) promised += 1;
  return Math.max(0, (await profileReadsLeft(tx, channelId, now)) - promised);
}

/** Where one Signal's Research stands, as the Leads page's pane says it. */
export type SignalResearch = {
  /** `running` while a press's read is out, `waiting` while it waits for the
   *  account's active hours; else `ready` to press, `spent` with no reads
   *  left today, `off` with the account's profile reads turned off. */
  state: "ready" | "running" | "waiting" | "spent" | "off";
  /** The reads a press can still take on the account today. */
  readsLeft: number;
  /** When a read of theirs inside its window was made: a press on them
   *  spends none. */
  cachedAt: number | null;
};

/** Where Research stands for one lead; null when there is no such lead, or
 *  no account its campaign reads with. */
export async function signalResearch(tx: Tx, leadId: number, now: number): Promise<SignalResearch | null> {
  const [row] = await tx
    .select({ lead: leads, channelId: channels.id, cap: channels.dailyProfileReadCap })
    .from(leads)
    .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId))
    .where(eq(leads.id, leadId));
  if (!row) return null;
  const readsLeft = await pressReadsLeft(tx, row.channelId, now);
  const asked = row.lead.researchRequestedAt;
  const cachedAt = (await freshProfileRead(tx, row.lead.profileId, now))?.readAt ?? null;
  const state =
    asked !== null && asked > now
      ? "waiting"
      : asked !== null && asked > now - RESEARCH_PENDING_MS
        ? "running"
        : cachedAt !== null
          ? "ready"
          : row.cap <= 0
            ? "off"
            : readsLeft === 0
              ? "spent"
              : "ready";
  return { state, readsLeft, cachedAt };
}

/**
 * Press Research on a campaign's Signals: the leads named, or its newest `n`
 * (at most {@link RESEARCH_PRESS_MAX}), among those still Signals who are a
 * buyer or not yet judged one, within the owner's reach, not already waiting
 * on a press, newest words first; the newest are taken from the Signals the
 * Leads page lists, so none set aside. Null when the campaign is none of this
 * organization's.
 */
export async function researchSignals(tx: Tx, input: ResearchPress): Promise<ResearchPressResult | null> {
  const { campaignId, now } = input;
  const [campaign] = await tx.select({ channelId: campaigns.channelId }).from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  if (campaign.channelId === null) return { queued: 0, readsLeft: 0, refused: null };
  await lockPresses(tx, campaign.channelId);
  const refused = await researchRefusal(tx, { id: campaignId, channelId: campaign.channelId }, now);
  if (refused !== null) return { queued: 0, readsLeft: await pressReadsLeft(tx, campaign.channelId, now), refused };

  const named = "leadIds" in input ? input.leadIds.slice(0, RESEARCH_PRESS_MAX) : null;
  const most = "leadIds" in input ? RESEARCH_PRESS_MAX : Math.min(Math.max(0, input.newest), RESEARCH_PRESS_MAX);
  if (named?.length === 0 || most === 0) {
    return { queued: 0, readsLeft: await pressReadsLeft(tx, campaign.channelId, now), refused: null };
  }
  const said = sql<number>`max(coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt}))`;
  const signals = await tx
    .select({ lead: leads })
    .from(leads)
    .innerJoin(
      leadSignals,
      and(eq(leadSignals.organizationId, leads.organizationId), eq(leadSignals.leadId, leads.id), eq(leadSignals.verdict, "passed")),
    )
    .where(
      and(
        eq(leads.campaignId, campaignId),
        eq(leads.origin, "find_leads"),
        eq(leads.stage, "signal"),
        or(isNull(leads.role), eq(leads.role, "buyer")),
        or(isNull(leads.researchRequestedAt), lte(leads.researchRequestedAt, now - RESEARCH_PENDING_MS)),
        sql`${leads.rating} is distinct from 'not_a_fit'`,
        named ? inArray(leads.id, [...named]) : sql`not ${asideNow}`,
      ),
    )
    .groupBy(leads.id)
    .orderBy(desc(said), desc(leads.id));
  const reachable = new Set(
    (await leadStandings(tx, campaignId, signals.map(({ lead }) => lead.id))).filter((one) => one.eligible).map((one) => one.id),
  );
  const frozen: Lead[] = signals
    .map(({ lead }) => lead)
    .filter((lead) => reachable.has(lead.id))
    .slice(0, most);

  let readsLeft = await pressReadsLeft(tx, campaign.channelId, now);
  const taken: number[] = [];
  for (const lead of frozen) {
    if ((await freshProfileRead(tx, lead.profileId, now)) === null) {
      if (readsLeft === 0) continue;
      readsLeft -= 1;
    }
    taken.push(lead.id);
  }
  if (taken.length > 0) {
    // Outside the account's hours the reads wait for them: the request, and
    // every window measured from it, starts a little after they open, as every
    // other read or send held for the window does.
    const [account] = await tx
      .select({ activeHours: channels.activeHours, activeDays: channels.activeDays })
      .from(channels)
      .where(eq(channels.id, campaign.channelId));
    const window = withinActiveWindow(now, account?.activeHours, account?.activeDays);
    const startAt = window.within ? now : driftPastOpen(window.nextOpen);
    await tx.update(leads).set({ researchRequestedAt: startAt, updatedAt: Date.now() }).where(inArray(leads.id, taken));
    await enqueue(tx, {
      type: "research_signals",
      payload: { campaignId, leadIds: taken, requestedAt: startAt, trigger: named ? "press" : "batch" },
      nextRunAt: startAt,
      idempotencyKey: `research_signals:${campaignId}:${startAt}:${taken.join(",")}`,
    });
  }
  return { queued: taken.length, readsLeft, refused: taken.length === 0 && frozen.length > 0 && readsLeft === 0 ? "Daily profile reads are spent." : null };
}
