import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { campaigns, leads, leadSignals, type LeadSignalRow, type SearchDepth } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { authorIdentity } from "../../people/key";
import { channelCeilings } from "../../ratelimit/ledger";
import { lockRoomEvidence } from "../../rooms/eligibility";
import { trackLeadServed } from "../../telemetry/leadFunnel";
import type { LeadRunCounts } from "./counts";
import { standingsOf } from "./eligibility";
import { putLeadAngles } from "./opener";
import { leadStage } from "../read";

/**
 * THE MERGE: everything one person said sits on one row. A person whose words
 * passed the screen gets a `leads` row at stage Signal, or their existing one,
 * and every passed signal of theirs links to it; a Signal's box takes the ways
 * in the screen read in their words. It reads nothing from LinkedIn and calls
 * no model.
 *
 * A person is keyed by their profile id, which a `leads` row requires: a person
 * LinkedIn names only by member urn merges only once the member directory ties
 * that urn to a profile, and until then their signals wait unlinked.
 */

export type MergeInput = {
  organizationId: string;
  campaign: { id: number };
  /** The depth the run reads at, which a new Signal is served at. */
  depth: SearchDepth;
  /** The run's counters; the merge counts the people who were already leads. */
  counts: LeadRunCounts;
  /** Write the counters as they stand. */
  report: () => Promise<void>;
  /** Renew the lease and say whether the run may go on. */
  continueRun: () => Promise<boolean>;
};

/** The newest of these signals' value for a field they carry. */
function newest(signals: readonly LeadSignalRow[], field: "name" | "headline"): string | null {
  return (
    [...signals]
      .sort((a, b) => (b.saidAt ?? b.seenAt) - (a.saidAt ?? a.seenAt) || b.id - a.id)
      .find((signal) => signal[field] !== null)?.[field] ?? null
  );
}

/** The ways in the screen read in the newest of these signals that has any. */
function newestAngles(signals: readonly LeadSignalRow[]): LeadSignalRow["angles"] {
  return (
    [...signals]
      .sort((a, b) => (b.saidAt ?? b.seenAt) - (a.saidAt ?? a.seenAt) || b.id - a.id)
      .find((signal) => (signal.angles?.length ?? 0) > 0)?.angles ?? null
  );
}

export async function mergeSignals(input: MergeInput): Promise<void> {
  const { organizationId, campaign, counts } = input;
  const { signals, profileOf } = await withOrg(organizationId, async (tx) => {
    const unlinked = await tx
      .select()
      .from(leadSignals)
      .where(
        and(
          eq(leadSignals.campaignId, campaign.id),
          eq(leadSignals.verdict, "passed"),
          isNull(leadSignals.leadId),
        ),
      )
      .orderBy(leadSignals.id);
    const standing = await standingsOf(tx, unlinked.map((signal) => signal.id));
    const profileIds = new Map(standing.flatMap((signal) => (signal.profileId === null ? [] : [[signal.id, signal.profileId] as const])));
    return {
      signals: unlinked,
      profileOf: new Map([...profileIds].map(([id, profileId]) => [id, authorIdentity(profileId)] as const)),
    };
  });

  // One person with three signals in a run is one person.
  const byPerson = new Map<string, LeadSignalRow[]>();
  for (const signal of signals) {
    const profile = profileOf.get(signal.id);
    if (profile) byPerson.set(profile, [...(byPerson.get(profile) ?? []), signal]);
  }

  for (const [profile, theirs] of byPerson) {
    if (!(await input.continueRun())) return;
    const merged = await withOrg(organizationId, async (tx) => {
      // Never engage takes this lock before it erases: a person put out of
      // reach since the screen leaves no row behind.
      await lockRoomEvidence(tx);
      const ids = theirs.map((signal) => signal.id);
      const standing = await standingsOf(tx, ids);
      const account = (await channelCeilings(tx))?.externalAccountId ?? null;
      if (
        standing.some(
          (signal) =>
            !signal.eligible ||
            (account !== null && signal.profileId !== null && authorIdentity(account) === authorIdentity(signal.profileId)),
        )
      ) {
        await tx.delete(leadSignals).where(inArray(leadSignals.id, ids));
        return false;
      }
      const findLead = () => tx.select().from(leads).where(eq(leads.profileId, profile));
      const [existing] = await findLead();
      const [inserted] = existing
        ? []
        : await tx
            .insert(leads)
            .values({
              profileId: profile,
              campaignId: campaign.id,
              name: newest(theirs, "name"),
              headline: newest(theirs, "headline"),
              origin: "find_leads",
              stage: "signal",
              // Nothing has come back from them yet.
              touchCount: 0,
            })
            // A concurrent intake or run for the same person leaves one row.
            .onConflictDoNothing({ target: [leads.organizationId, leads.profileId] })
            .returning();
      const lead = existing ?? inserted ?? (await findLead())[0]!;
      // A person new to Leads arrives as a Signal: their words passed the screen.
      if (inserted) trackLeadServed({ stage: "signal", lead: inserted, depth: input.depth }, tx);
      // A person follows the campaign that found them. One whose campaign was
      // deleted is found again by this one, which they follow now, so their
      // opener is queued from a campaign that stands.
      if (existing?.campaignId != null && existing.campaignId !== campaign.id) {
        const [gone] = await tx
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(and(eq(campaigns.id, existing.campaignId), isNotNull(campaigns.deletedAt)));
        if (gone) {
          await tx.update(leads).set({ campaignId: campaign.id, updatedAt: Date.now() }).where(eq(leads.id, existing.id));
        }
      }
      await tx
        .update(leadSignals)
        .set({ leadId: lead.id })
        .where(and(inArray(leadSignals.id, ids), isNull(leadSignals.leadId)));
      // What the screen read in their newest words is their way in until
      // Qualify judges them.
      const angles = newestAngles(theirs);
      if (lead.qualification === null && angles) await putLeadAngles(tx, lead, angles);
      // A person already past Signal keeps their stage and gains what they said.
      return existing !== undefined && leadStage(existing) !== "signal";
    });
    if (merged) counts.leadMergedCount += 1;
  }
  await input.report();
}
