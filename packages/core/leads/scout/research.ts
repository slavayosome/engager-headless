import { and, desc, eq, sql } from "drizzle-orm";
import {
  leads,
  leadSignals,
  type AuthorProfileReadJson,
  type Channel,
  type CompanyNotRead,
  type LeadSignalRow,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { connectorFailureRefusal, type CapabilitySurface } from "../../connector/resolve";
import { currentSearchDepth } from "../../strategy/searchDepth";
import { ConnectorError, isConnectorBackoff, isConnectorSignIn } from "../../linkedin/connectorError";
import { freshProfileRead, profileReads, rememberPlace, storeProfileRead } from "../../operations/researchReads";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { channelCeilings, reserveResearchRead } from "../../ratelimit/ledger";
import { lockRoomEvidence } from "../../rooms/eligibility";
import { localClock } from "../../time";
import { commentAuthors } from "../list";
import type { LeadRunCounts } from "./counts";
import { COMPANY_READ_FIELDS, freshCompanyRead } from "./companyRead";
import { leadStandings } from "./eligibility";
import { LEAD_STEP_HOLD_MS } from "./wake";

/**
 * RESEARCH: the profile behind each person who passed the screen. One profile
 * read per person, from the account's daily profile reads that every campaign
 * on the channel shares, and none for a person whose profile was read inside
 * its window. It reads the profile and nothing else: no email finding, no
 * enrichment vendor and, below Deep, no company page.
 *
 * Every read lands on the person's row in `author_profiles`
 * (`operations/researchReads.ts`), the one cache a room's places and Find
 * leads' Research share: a person read by either is not read again.
 */

/** The refusals that lift on their own, at the time the ledger names: the day's
 *  profile reads spent and the account's window shut. */
const LIFTS_AT_RETRY = new Set(["profile_read_daily_cap", "outside_active_hours"]);

/** The reads the connector may fail for one person before Read profiles sets
 *  them aside. */
const READ_TRIES = 3;

/** A connector that cannot reach the account is not a fault of the person the
 * read happened to be on. */
function accountReadFailure(error: unknown): boolean {
  const refusal = connectorFailureRefusal(error);
  return (
    isConnectorBackoff(error) ||
    isConnectorSignIn(error) ||
    refusal?.code === "profile_in_use" ||
    (error instanceof ConnectorError && error.retryable)
  );
}

/** Why Read profiles set a person aside whom the owner's rules put out of
 *  reach, in the owner's words. */
export const OUT_OF_REACH_NOTE = "Not read: they are no longer within your reach.";

/** What a profile read that landed leaves of the failed reads counted on a
 *  person and of the hold they earned: a hold for a judgment is left alone. */
const READ_LANDED = {
  readTries: 0,
  pipelineHold: sql`case when ${leads.pipelineHold} = 'unread' then null else ${leads.pipelineHold} end`,
  pipelineHoldNote: sql`case when ${leads.pipelineHold} = 'unread' then null else ${leads.pipelineHoldNote} end`,
};

/** What a profile read covers, in the owner's words (the Leads page's "What
 *  Scout read"). */
export const PROFILE_READ_FIELDS = "headline, About, current role, company size, country";

/** What no read of Scout's covers, which the Leads page says it did not read:
 *  their company page until Deep reads it, and their comment history. */
export const NOT_READ = ["company_page", "comment_history"] as const;
export type NotRead = (typeof NOT_READ)[number];

/** Why Deep read no company page for them, in the owner's words (no board
 *  copy). `{company}` is the company their profile names. */
const COMPANY_NOT_READ_WORDS: Readonly<Record<CompanyNotRead, string>> = {
  no_company_page: "Not read: no company page on their profile.",
  unsupported: "Not read: {company}'s company page: this connection cannot read company pages.",
  reads_spent: "Not read: {company}'s company page: today's profile reads ran out.",
  failed: "Not read: {company}'s company page: the read failed.",
};

/** A Signal has no profile yet; this is what the page says of it. */
export const ARRIVES_WITH_RESEARCH = "Profile, company and recent posts arrive with Research.";

/** Why no more profiles are read, in the owner's words: the day's reads
 *  spent, the window shut (with the time it opens), a stop or a pause on the
 *  account, profile reads turned off, or no account to read with. */
export function profilesHeldNote(
  reason: string,
  channel: Pick<Channel, "activeHours"> | null,
  retryAt?: number,
): string {
  switch (reason) {
    case "profile_read_daily_cap":
      return "Profile read limit reached — Scout researches more people tomorrow";
    case "outside_active_hours":
      return channel && retryAt !== undefined
        ? `Research waits for your window, which opens at ${localClock(retryAt, channel.activeHours?.tz || "UTC")}`
        : "Research waits for your window to open";
    case "profile_read_off":
      return "Research not run — profile reads are turned off for this account";
    case "no_channel":
      return "Research not run — no account is connected";
    case "kill switch":
      return "Research not run — Engager is stopped";
    default:
      return "Research not run — the account is paused for now";
  }
}

/**
 * A read the connector failed for one person, counted on them: at
 * `READ_TRIES` they are set aside from Read profiles with the connector's
 * reason, and the queue moves on to the next. A press can still read them.
 */
async function countFailedRead(tx: Tx, leadId: number, reason: string): Promise<void> {
  const tries = sql`${leads.readTries} + 1`;
  await tx
    .update(leads)
    .set({
      readTries: tries,
      pipelineHold: sql`case when ${tries} >= ${READ_TRIES} then 'unread' else ${leads.pipelineHold} end`,
      pipelineHoldNote: sql`case when ${tries} >= ${READ_TRIES} then ${reason} else ${leads.pipelineHoldNote} end`,
      updatedAt: Date.now(),
    })
    .where(eq(leads.id, leadId));
}

/** Set a person aside from Read profiles at once, with the reason in the
 *  owner's words: the read queue takes no one it has set aside. */
export async function setAsideUnread(tx: Tx, leadId: number, note: string): Promise<void> {
  await tx.update(leads).set({ pipelineHold: "unread", pipelineHoldNote: note, updatedAt: Date.now() }).where(eq(leads.id, leadId));
}

/** What one lead's research came to. */
export type LeadReadResult =
  /** A read inside its window answered; nothing was spent. */
  | { status: "cached" }
  /** Read now, from the account's budget. */
  | { status: "read" }
  /** The person went out of reach, or off the map, while the read was out. */
  | { status: "gone" }
  /** The budget, the window or a stop said no, LinkedIn throttled the
   *  account, or the connector reads no profile; nothing more is read. Where
   *  the day's reads or the window said no, `retryAt` is when they free. */
  | { status: "stopped"; note: string; retryAt?: number }
  /** The connector could not read this one profile, and its read is spent. */
  | { status: "failed"; note: string };

/**
 * One person's profile, from the read they already have or a new one. A read
 * inside its window answers and spends nothing; otherwise one reservation in a
 * short transaction of its own, then the read outside any transaction, then it
 * is stored, with the country it names, unless the person went out of reach
 * meanwhile. A read the connector then fails has still spent its row.
 */
export async function readLeadProfile(input: {
  organizationId: string;
  campaignId: number;
  leadId: number;
  now: number;
  driver: CapabilitySurface<"profile_read">;
  /** Their current role too, where the run goes on to their company's page. */
  role?: boolean;
  counts: LeadRunCounts;
  report: () => Promise<void>;
}): Promise<LeadReadResult> {
  const { organizationId, campaignId, leadId, now, driver, counts } = input;
  const standing = await withOrg(organizationId, async (tx) => {
    await lockRoomEvidence(tx);
    const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
    if (!lead) return null;
    const [person] = await leadStandings(tx, campaignId, [leadId]);
    if (!person?.eligible) return null;
    const cached = (await freshProfileRead(tx, lead.profileId, now)) !== null;
    if (cached) await tx.update(leads).set({ ...READ_LANDED, updatedAt: Date.now() }).where(eq(leads.id, leadId));
    return { lead, cached };
  });
  if (standing === null) return { status: "gone" };
  if (standing.cached) return { status: "cached" };
  if (!driver.readAuthorProfile) {
    return { status: "stopped", note: "Research not run — this connector cannot read profiles" };
  }

  const reserved = await withOrg(organizationId, async (tx) => {
    const channel = await channelCeilings(tx);
    if (!channel) return { ok: false as const, reason: "no_channel", retryAt: undefined, channel };
    const decision = await reserveResearchRead({
      db: tx,
      read: "profile_read",
      channel,
      campaignId,
      profileId: standing.lead.profileId,
      now,
    });
    return { ...decision, channel };
  });
  if (!reserved.ok) {
    return {
      status: "stopped",
      note: profilesHeldNote(reserved.reason, reserved.channel, reserved.retryAt),
      ...(LIFTS_AT_RETRY.has(reserved.reason) && reserved.retryAt !== undefined ? { retryAt: reserved.retryAt } : {}),
    };
  }
  counts.profileReadsCount += 1;
  await input.report();

  let read: AuthorProfileReadJson;
  try {
    read = await driver.readAuthorProfile(standing.lead.profileId, { role: input.role });
  } catch (error) {
    if (isConnectorBackoff(error)) {
      // The throttle is the account's: pause it, so the other lanes stop
      // hitting the same wall instead of each discovering it alone.
      const reason = await pauseChannelForConnectorBackoff(organizationId, error);
      return {
        status: "stopped",
        note:
          reason === "checkpoint"
            ? "Research stopped — LinkedIn asked for a check on the account, so Scout paused it"
            : "Research stopped — LinkedIn is slowing the account down, so Scout paused it",
        retryAt: Date.now() + LEAD_STEP_HOLD_MS,
      };
    }
    if (accountReadFailure(error)) {
      const reason = connectorFailureRefusal(error)?.detail ?? "the account could not be reached";
      return { status: "stopped", note: `Research stopped — ${reason}`, retryAt: Date.now() + LEAD_STEP_HOLD_MS };
    }
    // eslint-disable-next-line no-console
    console.warn(`[find_leads] campaign ${campaignId} profile read failed:`, error instanceof Error ? error.message : error);
    const reason = connectorFailureRefusal(error)?.detail ?? "the profile could not be read";
    await withOrg(organizationId, (tx) => countFailedRead(tx, leadId, reason));
    return { status: "failed", note: `Research stopped — ${reason}` };
  }

  const stored = await withOrg(organizationId, async (tx) => {
    // Never engage takes this lock before it erases: a person put out of reach
    // while the read was out leaves nothing behind.
    await lockRoomEvidence(tx);
    const [person] = await leadStandings(tx, campaignId, [leadId]);
    if (!person?.eligible) return false;
    const placed = { ...read, ...(await rememberPlace(tx, standing.lead.profileId, read, now)) };
    await storeProfileRead(tx, standing.lead.profileId, placed, now);
    await tx.update(leads).set({ ...READ_LANDED, updatedAt: Date.now() }).where(eq(leads.id, leadId));
    return true;
  });
  return stored ? { status: "read" } : { status: "gone" };
}

/** One signal item of theirs that Scout read. */
export type LeadSignalRead = {
  kind: "post" | "comment";
  /** When they wrote it, else when Scout met it. */
  at: number;
  /** A post's comment count when it was read. */
  comments: number | null;
  /** Whose post a comment sits under, when Scout knows it. */
  under: string | null;
};

/** What Scout read about one person, for the Leads page's right panel. */
export type LeadReads = {
  signals: LeadSignalRead[];
  /** The profile read and when; null for a Signal. */
  profile: { readAt: number; fields: string } | null;
  /** The recent posts inside that read, newest first. */
  recentPosts: Array<{ postUrn: string; postedAt: number | null }>;
  /** Their company's page, where Deep read it inside its window: when, and
   *  what the read covers. */
  company: { readAt: number; fields: string } | null;
  /** About's Size and Industry: the company page's where one was read, else
   *  the size their profile names; an industry only a company page says. */
  about: { size: string | null; industry: string | null };
  /** What Scout did not read. */
  notRead: readonly NotRead[];
  /** Why Deep left their company page unread, where it tried and the
   *  campaign is still at Deep. */
  companyNote: string | null;
  /** What a Signal shows where the profile would be. */
  waiting: string | null;
};

/**
 * What Scout read about a lead: each item of theirs it met and when, the
 * profile read and the posts inside it, and what it did not read. Null when
 * there is no such lead in this organization.
 */
export async function leadReads(tx: Tx, leadId: number): Promise<LeadReads | null> {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return null;
  const mine: LeadSignalRow[] = await tx
    .select()
    .from(leadSignals)
    .where(and(eq(leadSignals.leadId, leadId), eq(leadSignals.verdict, "passed")))
    .orderBy(desc(sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`), desc(leadSignals.id));
  // A comment sits under someone's post: the author of the post when Scout
  // met the post itself, else the creator or competitor whose thread it read.
  const under = await commentAuthors(tx, mine);
  const stored = (await profileReads(tx, [lead.profileId])).get(lead.profileId);
  const read = stored?.read;
  const role = read?.currentRole;
  const company = role?.companyRef ? await freshCompanyRead(tx, role.companyRef, Date.now()) : null;
  return {
    signals: mine.map((signal) => ({
      kind: signal.kind,
      at: signal.saidAt ?? signal.seenAt,
      comments: signal.commentCount,
      under: under.get(signal.id) ?? null,
    })),
    profile: stored ? { readAt: stored.readAt, fields: PROFILE_READ_FIELDS } : null,
    recentPosts: [...(read?.recentPosts ?? [])]
      .map((post) => ({ postUrn: post.postUrn, postedAt: post.postedAt ?? null }))
      .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0)),
    company: company ? { readAt: company.readAt, fields: COMPANY_READ_FIELDS } : null,
    about: {
      size: company?.read.size ?? role?.companySize ?? null,
      industry: company?.read.industry ?? null,
    },
    notRead: company ? NOT_READ.filter((item) => item !== "company_page") : NOT_READ,
    // Only Deep tries a page, so what a Deep run left unread is said while the
    // campaign is at Deep, or while a page is stored to show beside it.
    companyNote:
      company || lead.companyNotRead === null || (await currentSearchDepth(tx, lead.campaignId!)) !== "deep"
        ? null
        : COMPANY_NOT_READ_WORDS[lead.companyNotRead].replace("{company}", role?.company ?? "Their company"),
    waiting: read ? null : ARRIVES_WITH_RESEARCH,
  };
}
