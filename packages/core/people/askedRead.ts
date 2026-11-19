import { and, eq, inArray, like } from "drizzle-orm";
import { jobs, type CompanyPageReadJson } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { openPauses, scopesOf } from "../actions/pause";
import type { CapabilitySurface } from "../connector/resolve";
import { enqueue } from "../jobs/queue";
import { freshCompanyRead, storeCompanyRead } from "../leads/scout/companyRead";
import { pressReadsLeft } from "../leads/scout/press";
import { profilesHeldNote } from "../leads/scout/research";
import { isConnectorBackoff } from "../linkedin/connectorError";
import type { AuthorProfileRead } from "../linkedin/driver";
import { profileReads, storeProfileRead } from "../operations/researchReads";
import { getSystemState, pauseChannelForConnectorBackoff } from "../ratelimit/killswitch";
import { channelCeilings, reserveResearchRead } from "../ratelimit/ledger";
import { driftPastOpen, withinActiveWindow } from "../time";
import { authorIdentity } from "./key";

/**
 * THE OWNER'S ASKED READ: one person's LinkedIn profile and the page of the
 * company it names, read now because the owner asked for it by name, whatever
 * stage that person is at. The ask reads nothing itself: it queues one
 * `research_signals` job (`trigger: "ask"`), which reads under the account's
 * run lease, in Engager's own browser, each page reserved first from the
 * account's daily profile reads. A profile read inside {@link ASKED_READ_FRESH_MS}
 * and a company page inside its window answer without a read, so asking twice
 * spends nothing more. It never raises a cap: the kill switch, a pause, a Stop,
 * reads turned off or the day's reads spent refuse it and say why, and outside
 * the account's hours it waits for them. It judges, drafts and sends nothing;
 * what it reads is LinkedIn text, held as data.
 */

/** How long a profile read answers an ask before the ask reads again. */
export const ASKED_READ_FRESH_MS = 24 * 3_600_000;

export type AskedReadPayload = { trigger: "ask"; profileId: string; campaignId: number | null; requestedAt: number };

export type AskedReadPress = {
  /** The job queued, or null where nothing was. */
  jobId: number | null;
  /** When the reads start: now, or when the account's hours open. */
  startsAt: number | null;
  /** The profile reads left today once these are taken. */
  readsLeft: number;
  /** Why nothing was queued, in the owner's words; null otherwise. */
  refused: string | null;
  /** Nothing to read: what is stored is still fresh. */
  upToDate: boolean;
};

/** The company page a stored profile read names, and which of the two reads an
 *  ask would still make. */
async function owed(tx: Tx, profileId: string, now: number) {
  const stored = (await profileReads(tx, [profileId])).get(authorIdentity(profileId));
  const profile = !stored || stored.readAt < now - ASKED_READ_FRESH_MS;
  const companyRef = stored?.read.currentRole?.companyRef ?? null;
  // A profile about to be read again may name another company: its page is
  // counted as owed, and the job finds out.
  const company = profile || (companyRef !== null && (await freshCompanyRead(tx, companyRef, now)) === null);
  return { profile, company, companyRef };
}

/** Queue the owner's asked read of one person. */
export async function askRead(tx: Tx, input: { profileId: string; campaignId: number | null; now: number }): Promise<AskedReadPress> {
  const { profileId, campaignId, now } = input;
  const none = { jobId: null, startsAt: null, upToDate: false };
  const channel = await channelCeilings(tx);
  if (!channel) return { ...none, readsLeft: 0, refused: profilesHeldNote("no_channel", null) };
  const readsLeft = await pressReadsLeft(tx, channel.id, now);
  const state = await getSystemState(tx);
  const [stop] = await openPauses(tx, scopesOf({ channelId: channel.id, campaignId, conversationId: null }));
  const refused = state?.killSwitch
    ? profilesHeldNote("kill switch", null)
    : state?.pausedUntil && state.pausedUntil > now
      ? profilesHeldNote("paused", null)
      : stop
        ? `Research not run — ${stop.scope === "account" ? "the account" : "this campaign"} is stopped`
        : channel.dailyProfileReadCap <= 0
          ? profilesHeldNote("profile_read_off", null)
          : null;
  if (refused !== null) return { ...none, readsLeft, refused };
  const need = await owed(tx, profileId, now);
  if (!need.profile && !need.company) return { ...none, readsLeft, refused: null, upToDate: true };
  if (readsLeft === 0) return { ...none, readsLeft, refused: profilesHeldNote("profile_read_daily_cap", null) };
  const window = withinActiveWindow(now, channel.activeHours, channel.activeDays);
  const startsAt = window.within ? now : driftPastOpen(window.nextOpen);
  const left = Math.max(0, readsLeft - (need.profile ? 1 : 0) - (need.company ? 1 : 0));
  const key = `research_ask:${authorIdentity(profileId)}`;
  // One ask of a person at a time: a second while the first waits joins it.
  const [waiting] = await tx
    .select({ id: jobs.id, nextRunAt: jobs.nextRunAt })
    .from(jobs)
    .where(and(eq(jobs.organizationId, channel.organizationId), like(jobs.idempotencyKey, `${key}:%`), inArray(jobs.status, ["queued", "running"])));
  if (waiting) return { jobId: waiting.id, startsAt: waiting.nextRunAt, readsLeft: left, refused: null, upToDate: false };
  const payload: AskedReadPayload = { trigger: "ask", profileId, campaignId, requestedAt: startsAt };
  const jobId = await enqueue(tx, { type: "research_signals", payload, nextRunAt: startsAt, idempotencyKey: `${key}:${startsAt}`, maxAttempts: 3 });
  return { jobId, startsAt, readsLeft: left, refused: null, upToDate: false };
}

/** What one page of an asked read came to. */
export type AskedPage =
  /** Read now, from the account's daily reads. */
  | "read"
  /** A read still fresh answered; nothing was spent. */
  | "kept"
  /** The profile names no company page. */
  | "none"
  /** This connection reads no such page. */
  | "unsupported"
  /** The page could not be read; its read is spent. */
  | "failed"
  /** The budget, the window or a stop said no; nothing was read. */
  | "refused";

export type AskedReadResult = { profile: AskedPage; company: AskedPage; note?: string };

/**
 * Make the reads an ask is owed, the profile first: its current role is what
 * names the company page. Each read is reserved in a short transaction of its
 * own, made outside any, then stored. LinkedIn slowing the account pauses it
 * and ends the ask; a refusal ends it too.
 */
export async function readAsked(input: {
  organizationId: string;
  profileId: string;
  campaignId: number | null;
  driver: CapabilitySurface<"profile_read">;
}): Promise<AskedReadResult> {
  const { organizationId, profileId, campaignId, driver } = input;
  /** Take one of the day's reads; the note says why not. */
  const reserve = (visits: string | null) =>
    withOrg(organizationId, async (tx) => {
      const channel = await channelCeilings(tx);
      if (!channel) return profilesHeldNote("no_channel", null);
      const decision = await reserveResearchRead({ db: tx, read: "profile_read", channel, campaignId, profileId: visits, now: Date.now() });
      return decision.ok ? null : profilesHeldNote(decision.reason, channel, decision.retryAt);
    });
  /** One page loaded; a throttle pauses the account for everything on it. */
  const load = async <T>(page: () => Promise<T>): Promise<{ value: T } | { note?: string }> => {
    try {
      return { value: await page() };
    } catch (error) {
      if (!isConnectorBackoff(error)) return {};
      const reason = await pauseChannelForConnectorBackoff(organizationId, error);
      return {
        note:
          reason === "checkpoint"
            ? "Research stopped — LinkedIn asked for a check on the account, so it is paused"
            : "Research stopped — LinkedIn is slowing the account down, so it is paused",
      };
    }
  };

  let profile: AskedPage = "kept";
  if ((await withOrg(organizationId, (tx) => owed(tx, profileId, Date.now()))).profile) {
    if (!driver.readAuthorProfile) return { profile: "unsupported", company: "refused" };
    const held = await reserve(profileId);
    if (held !== null) return { profile: "refused", company: "refused", note: held };
    const loaded = await load<AuthorProfileRead>(() => driver.readAuthorProfile!(profileId, { role: true }));
    if ("value" in loaded) {
      await withOrg(organizationId, (tx) => storeProfileRead(tx, profileId, loaded.value, Date.now()));
      profile = "read";
    } else {
      if (loaded.note) return { profile: "failed", company: "refused", note: loaded.note };
      profile = "failed";
    }
  }

  const need = await withOrg(organizationId, (tx) => owed(tx, profileId, Date.now()));
  const companyRef = need.companyRef;
  if (companyRef === null) return { profile, company: "none" };
  if (await withOrg(organizationId, (tx) => freshCompanyRead(tx, companyRef, Date.now()))) return { profile, company: "kept" };
  if (!driver.readCompanyPage) return { profile, company: "unsupported" };
  const held = await reserve(null);
  if (held !== null) return { profile, company: "refused", note: held };
  const loaded = await load<CompanyPageReadJson>(() => driver.readCompanyPage!(companyRef));
  if (!("value" in loaded)) return { profile, company: "failed", ...(loaded.note ? { note: loaded.note } : {}) };
  await withOrg(organizationId, (tx) => storeCompanyRead(tx, companyRef, loaded.value, Date.now()));
  return { profile, company: "read" };
}
