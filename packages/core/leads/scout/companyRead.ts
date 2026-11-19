import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  authorProfiles,
  companyReads,
  leads,
  leadSignals,
  type AuthorProfileReadJson,
  type CompanyNotRead,
  type CompanyPageReadJson,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { isGrant } from "../../connector/resolve";
import type { CapabilityGrant } from "../../jobs/context";
import { isConnectorBackoff } from "../../linkedin/connectorError";
import { truncateChars } from "../../operations/postSnippets";
import { PROFILE_READ_TTL_MS, profileReads } from "../../operations/researchReads";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { channelCeilings, reserveResearchRead } from "../../ratelimit/ledger";
import type { LeadRunCounts } from "./counts";

/**
 * DEEP'S COMPANY PAGE READ (US-LMF-02): the company page behind each buyer
 * Research read, so fit rests on the company's own size and industry. It runs
 * at Deep alone, after the profile read and before the qualify call, and only
 * for someone the screen named a buyer: never a peer, a competitor, a partner
 * or noise. The page is the one their profile's current role links to
 * (`currentRole.companyRef`); a profile that links none reads none.
 *
 * Each read reserves one of the account's daily profile reads before the page
 * loads (`reserveResearchRead`), from the budget every campaign on the account
 * shares. One read answers everyone at that company for 14 days
 * (`PROFILE_READ_TTL_MS`) and spends nothing more. A refusal — the day's reads
 * spent, the window, a pause, the stop, a cap of 0 — reads no more pages this
 * run, and the people left are qualified from their profile. A read that fails
 * is not tried again for {@link FAILED_READ_BACKOFF_MS}, by anyone at that
 * company: the next lead there is judged from their profile without another
 * read reserved.
 *
 * It reads the page's own public data and nothing else: no people, no email,
 * no enrichment vendor. It follows, messages and engages nothing, and what the
 * page says is LinkedIn text, held as data.
 */

/** What a company page read covers, in the owner's words (What Scout read). */
export const COMPANY_READ_FIELDS = "size, industry";

/** The most of a page's text kept. */
const ABOUT_MAX_CHARS = 2_000;

/** How long a company whose page failed to read is left alone. */
export const FAILED_READ_BACKOFF_MS = 30 * 60_000;

/** What the run says, once, where pages went unread for the run's own
 *  reason. */
const HELD_NOTES: Partial<Record<CompanyNotRead, string>> = {
  reads_spent: "Company pages not read — today's profile reads ran out, so the rest are judged from their profile",
  unsupported: "Company pages not read — this connection cannot read company pages",
};

export type CompanyReadInput = {
  organizationId: string;
  campaign: { id: number };
  /** The people Research left a read for this run, in its order. */
  leadIds: readonly number[];
  now: number;
  grant: CapabilityGrant;
  /** The run's counters; each read reserved counts among its profile reads. */
  counts: LeadRunCounts;
  report: () => Promise<void>;
  continueRun: () => Promise<boolean>;
};

export type CompanyReadResult = {
  /** Pages read now, from the account's profile reads. */
  read: number;
  /** People a read inside its window answered, which spent nothing. */
  cached: number;
  /** What else the reads say of themselves, in the owner's words. */
  notes: string[];
};

/** The read of a company page still inside its window, if any. */
export async function freshCompanyRead(
  tx: Tx,
  companyRef: string,
  now: number,
): Promise<{ read: CompanyPageReadJson; readAt: number } | null> {
  const [row] = await tx
    .select({ read: companyReads.read, readAt: companyReads.readAt })
    .from(companyReads)
    .where(and(eq(companyReads.companyRef, companyRef), gte(companyReads.readAt, now - PROFILE_READ_TTL_MS)));
  return row ?? null;
}

/** The page as it is kept: bounded, still LinkedIn text held as data. */
function kept(read: CompanyPageReadJson, companyRef: string): CompanyPageReadJson {
  return {
    ...read,
    companyRef,
    ...(read.about === undefined ? {} : { about: truncateChars(read.about, ABOUT_MAX_CHARS) }),
  };
}

/** A company page read kept for everyone at that company, over any older one. */
export async function storeCompanyRead(tx: Tx, companyRef: string, page: CompanyPageReadJson, readAt: number): Promise<void> {
  const read = kept(page, companyRef);
  await tx
    .insert(companyReads)
    .values({ companyRef, read, readAt })
    .onConflictDoUpdate({ target: [companyReads.organizationId, companyReads.companyRef], set: { read, readAt } });
}

/** Keep why a person's page went unread; a note that says what it said leaves
 *  the row alone, so a failure's backoff is not renewed by being asked again. */
async function noteLead(tx: Tx, leadId: number, why: CompanyNotRead | null): Promise<void> {
  await tx
    .update(leads)
    .set({ companyNotRead: why, updatedAt: Date.now() })
    .where(and(eq(leads.id, leadId), sql`${leads.companyNotRead} is distinct from ${why}`));
}

/** The company page each of these people's profile links to, as the run reads
 *  it; who has none is left out. */
function companyOf(read: AuthorProfileReadJson | undefined): string | null {
  return read?.currentRole?.companyRef ?? null;
}

/** The companies this campaign's people link to whose page failed to read
 *  within the backoff: one of them was last noted failed since. */
async function recentlyFailed(tx: Tx, campaignId: number, now: number): Promise<string[]> {
  const ref = sql<string | null>`${authorProfiles.profileRead} -> 'currentRole' ->> 'companyRef'`;
  const rows = await tx
    .selectDistinct({ ref })
    .from(leads)
    .innerJoin(authorProfiles, and(eq(authorProfiles.organizationId, leads.organizationId), eq(authorProfiles.profileId, leads.profileId)))
    .where(and(eq(leads.campaignId, campaignId), eq(leads.companyNotRead, "failed"), gte(leads.updatedAt, now - FAILED_READ_BACKOFF_MS)));
  return rows.flatMap((row) => (row.ref ? [row.ref] : []));
}

/**
 * Read the company page of each researched buyer, once a company. Each person
 * and each read is its own short transaction, so a lost lease or a thrown read
 * keeps what landed. Why a person's page went unread is kept on them, for What
 * Scout read; a page read, or answered from its window, clears it.
 */
export async function readLeadCompanies(input: CompanyReadInput): Promise<CompanyReadResult> {
  const { organizationId, counts, now } = input;
  const result: CompanyReadResult = { read: 0, cached: 0, notes: [] };
  if (input.leadIds.length === 0) return result;
  const setup = await withOrg(organizationId, async (tx) => {
    const people = await tx.select().from(leads).where(inArray(leads.id, [...input.leadIds]));
    // A lead's own role is null until Qualify, so the screen's is the one to
    // ask: the role on the newest words of theirs it passed.
    const screened = new Map<number, string | null>();
    const words = await tx
      .select({ leadId: leadSignals.leadId, role: leadSignals.role })
      .from(leadSignals)
      .where(and(inArray(leadSignals.leadId, people.map((lead) => lead.id)), eq(leadSignals.verdict, "passed")))
      .orderBy(desc(sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`), desc(leadSignals.id));
    for (const { leadId, role } of words) if (leadId !== null && !screened.has(leadId)) screened.set(leadId, role);
    const buyers = people.filter((lead) => screened.get(lead.id) === "buyer" && (lead.role === null || lead.role === "buyer"));
    const reads = await profileReads(tx, buyers.map((lead) => lead.profileId));
    return {
      // The screen named them buyers; Research has not judged them otherwise.
      people: buyers.map((lead) => ({ lead, companyRef: companyOf(reads.get(lead.profileId)?.read) })),
      grant: await input.grant(tx, "profile_read"),
    };
  });
  const read = isGrant(setup.grant) ? setup.grant.use.readCompanyPage?.bind(setup.grant.use) : undefined;
  /** Why no more pages are read this run, once something said so. */
  let held: CompanyNotRead | null = read ? null : "unsupported";
  /** The companies whose page failed to read lately, in an earlier run or
   *  this one. */
  const failed = new Set(await withOrg(organizationId, (tx) => recentlyFailed(tx, input.campaign.id, now)));
  const noted = new Set<CompanyNotRead>();
  const order = new Map(input.leadIds.map((id, at) => [id, at]));
  for (const { lead, companyRef } of setup.people.sort((a, b) => order.get(a.lead.id)! - order.get(b.lead.id)!)) {
    if (!(await input.continueRun())) break;
    const answer = await withOrg(organizationId, async (tx) => {
      if (companyRef === null) return "no_company_page" as const;
      if (await freshCompanyRead(tx, companyRef, now)) return "cached" as const;
      if (held !== null) return held;
      if (failed.has(companyRef)) return "failed" as const;
      const channel = await channelCeilings(tx);
      const reserved = channel
        ? await reserveResearchRead({ db: tx, read: "profile_read", channel, campaignId: input.campaign.id, now })
        : { ok: false as const };
      return reserved.ok ? ("reserved" as const) : ("reads_spent" as const);
    });
    if (answer === "cached") {
      result.cached += 1;
      await withOrg(organizationId, (tx) => noteLead(tx, lead.id, null));
      continue;
    }
    if (answer !== "reserved") {
      if (answer === "reads_spent") held = answer;
      const note = HELD_NOTES[answer];
      if (note && !noted.has(answer)) {
        noted.add(answer);
        result.notes.push(note);
      }
      await withOrg(organizationId, (tx) => noteLead(tx, lead.id, answer));
      continue;
    }
    counts.profileReadsCount += 1;
    await input.report();

    let page: CompanyPageReadJson;
    try {
      page = await read!(companyRef!);
    } catch (error) {
      failed.add(companyRef!);
      if (isConnectorBackoff(error)) {
        // The throttle is the account's: pause it, so nothing else on it
        // walks into the same wall, and read no more pages.
        const reason = await pauseChannelForConnectorBackoff(organizationId, error);
        held = "failed";
        result.notes.push(
          reason === "checkpoint"
            ? "Company pages stopped — LinkedIn asked for a check on the account, so Scout paused it"
            : "Company pages stopped — LinkedIn is slowing the account down, so Scout paused it",
        );
      }
      // eslint-disable-next-line no-console
      console.warn(`[find_leads] campaign ${input.campaign.id} company page read failed:`, error instanceof Error ? error.message : error);
      await withOrg(organizationId, (tx) => noteLead(tx, lead.id, "failed"));
      continue;
    }
    await withOrg(organizationId, async (tx) => {
      await storeCompanyRead(tx, companyRef!, page, now);
      await noteLead(tx, lead.id, null);
    });
    result.read += 1;
  }
  return result;
}
