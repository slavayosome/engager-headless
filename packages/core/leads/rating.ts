import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  leadRatings,
  leads,
  leadSignals,
  searches,
  type LeadFit,
  type LeadRating,
  type LeadRole,
  type ScoutIntent,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { truncateChars } from "../operations/postSnippets";
import { trackLeadRated } from "../telemetry/leadFunnel";
import { standsAside, storedAside } from "./setAside";

/**
 * THE OWNER'S RATING: their answer to "Is this right?" on a person Scout
 * judged. It teaches Scout's next run and gates nothing: no run, step or send
 * waits on it, nothing is sent or drafted, and Not a fit is not do-not-engage —
 * the person's conversation, Activity and the caps are as they were.
 *
 * What it changes on the lead: Not a fit and A peer set them aside with that
 * reason (`leads/setAside.ts`), where words they say later never bring them
 * back on their own, and A peer makes them a peer as well, which no step
 * contacts; Right person and Wrong intent leave them where they are. No answer
 * moves a stage. What it teaches: the next qualify
 * call on the campaign takes it as an example (`ratingExamples`), and the
 * search row that found the person's newest words counts them as the owner
 * said, in place of what Scout said.
 */

/** The owner's words for each answer, as a prompt and a read say them. */
export const RATING_WORDS: Record<LeadRating, string> = {
  right_person: "right person",
  a_peer: "a peer",
  not_a_fit: "not a fit",
  wrong_intent: "wrong intent",
};

/** A search row's three counts of people. */
type Counted = "buyers" | "peers" | "noise";

/** What the search map counted a person as, by the role Scout gave them. */
function countedAs(role: LeadRole): Counted {
  if (role === "buyer") return "buyers";
  return role === "peer" || role === "competitor" ? "peers" : "noise";
}

/** What the map counts them as once the owner has answered. Wrong intent says
 *  nothing of who they are, so they stay as Scout counted them. */
function ratedAs(verdict: LeadRating, scoutRole: LeadRole): Counted {
  switch (verdict) {
    case "right_person":
      return "buyers";
    case "a_peer":
      return "peers";
    case "not_a_fit":
      return "noise";
    case "wrong_intent":
      return countedAs(scoutRole);
  }
}

/** One person moved in or out of a search row's count. A count Scout never
 *  made is not taken below nothing. */
async function count(tx: Tx, at: { phraseId: number | null; as: Counted }, delta: 1 | -1): Promise<void> {
  if (at.phraseId === null) return;
  const column = searches[at.as];
  await tx
    .update(searches)
    .set({ [at.as]: sql`greatest(${column} + ${delta}, 0)` })
    .where(eq(searches.id, at.phraseId));
}

export type LeadRatingResult = {
  leadId: number;
  verdict: LeadRating;
  ratedAt: number;
  /** The search row whose counts the answer moved; null when no row of the
   *  map found their words. */
  phraseId: number | null;
};

/**
 * Rate one lead, in the caller's transaction. A second answer replaces the
 * first: what the first did to the lead and to the map is undone, then this
 * one lands. Null when there is no such lead in this organization; refused for
 * a person Scout has not judged, who has nothing yet to be right or wrong
 * about.
 */
export async function rateLead(
  tx: Tx,
  input: { leadId: number; verdict: LeadRating; now: number },
): Promise<LeadRatingResult | null> {
  const { verdict, now } = input;
  const [lead] = await tx.select().from(leads).where(eq(leads.id, input.leadId)).for("update");
  if (!lead) return null;
  if (lead.qualification === null || lead.role === null) {
    throw new AppError("lead_not_judged", "Scout has not judged this person yet: rate them once Research has.", 409);
  }
  const [prior] = await tx.select().from(leadRatings).where(eq(leadRatings.leadId, lead.id));
  // The role Scout gave them, which A peer overwrites on the lead.
  const scoutRole = prior?.scoutRole ?? lead.role;
  // The row that found their newest words when they were first rated, and kept
  // after: words that come later do not move what the first answer counted.
  const [newest] = prior
    ? []
    : await tx
        .select({ phraseId: leadSignals.phraseId })
        .from(leadSignals)
        .where(and(eq(leadSignals.leadId, lead.id), eq(leadSignals.verdict, "passed"), isNotNull(leadSignals.phraseId)))
        .orderBy(desc(sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`), desc(leadSignals.id))
        .limit(1);
  const phraseId = prior ? prior.phraseId : (newest?.phraseId ?? null);

  // What the earlier answer did comes off first, so only this one stands. A
  // set-aside the owner made before it is theirs, and stays theirs, unless
  // their newer words have undone it: that one is gone, and the answer dates
  // its own.
  let role = lead.role;
  let aside = (await standsAside(tx, lead.id)) ? storedAside(lead) : null;
  if (prior?.verdict === "a_peer" && role === "peer") role = prior.scoutRole;
  if (prior && aside?.reason === prior.verdict) aside = aside.at === prior.ratedAt ? null : { ...aside, reason: "owner" };
  if (verdict === "a_peer") role = "peer";
  if (verdict === "not_a_fit" || verdict === "a_peer") aside = { at: aside?.at ?? now, reason: verdict };
  await tx
    .update(leads)
    .set({
      role,
      setAsideAt: aside?.at ?? null,
      setAsideReason: aside?.reason ?? null,
      rating: verdict,
      ratedAt: now,
      updatedAt: Date.now(),
    })
    .where(eq(leads.id, lead.id));

  const was = prior
    ? { phraseId: prior.phraseId, as: ratedAs(prior.verdict, scoutRole) }
    : { phraseId, as: countedAs(scoutRole) };
  const is = { phraseId, as: ratedAs(verdict, scoutRole) };
  if (was.phraseId !== is.phraseId || was.as !== is.as) {
    await count(tx, was, -1);
    await count(tx, is, 1);
  }
  await tx
    .insert(leadRatings)
    .values({ leadId: lead.id, campaignId: lead.campaignId, verdict, phraseId, scoutRole, ratedAt: now })
    .onConflictDoUpdate({
      target: [leadRatings.organizationId, leadRatings.leadId],
      set: { campaignId: lead.campaignId, verdict, phraseId, ratedAt: now },
    });
  trackLeadRated({ rating: verdict, lead }, tx);
  return { leadId: lead.id, verdict, ratedAt: now, phraseId };
}

/** How many examples one qualify call holds. */
export const RATING_EXAMPLES = 6;
/** The most of a person's words an example quotes. */
const EXAMPLE_WORDS_MAX = 300;

/** One of the owner's answers, as a qualify call reads it: what Scout said of
 *  the person, what the owner said, and the words Scout judged. `words` is
 *  LinkedIn text, for the prompt to fence. */
export type RatingExample = {
  scoutRole: LeadRole;
  fit: LeadFit | null;
  intent: ScoutIntent | null;
  verdict: LeadRating;
  words: string;
};

/**
 * A campaign's newest ratings, newest first, at most {@link RATING_EXAMPLES},
 * as examples for its next qualify call. The words are the quote Scout kept,
 * else their newest words the screen passed; a person whose words are gone,
 * erased with the rest of what Scout kept of them, gives no example.
 */
export async function ratingExamples(tx: Tx, campaignId: number): Promise<RatingExample[]> {
  const rated = await tx
    .select({ rating: leadRatings, lead: leads })
    .from(leadRatings)
    .innerJoin(leads, and(eq(leads.organizationId, leadRatings.organizationId), eq(leads.id, leadRatings.leadId)))
    .where(eq(leadRatings.campaignId, campaignId))
    .orderBy(desc(leadRatings.ratedAt), desc(leadRatings.leadId))
    .limit(RATING_EXAMPLES);
  if (rated.length === 0) return [];
  const said = sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`;
  const signals = await tx
    .selectDistinctOn([leadSignals.leadId], { leadId: leadSignals.leadId, words: leadSignals.words })
    .from(leadSignals)
    .where(and(inArray(leadSignals.leadId, rated.map((row) => row.lead.id)), eq(leadSignals.verdict, "passed")))
    .orderBy(leadSignals.leadId, desc(said), desc(leadSignals.id));
  const newestWords = new Map(signals.map((signal) => [signal.leadId, signal.words] as const));
  return rated.flatMap(({ rating, lead }) => {
    const words = lead.intentQuote ?? newestWords.get(lead.id);
    if (!words) return [];
    return [
      {
        scoutRole: rating.scoutRole,
        fit: lead.fit,
        intent: lead.intent,
        verdict: rating.verdict,
        words: truncateChars(words, EXAMPLE_WORDS_MAX),
      },
    ];
  });
}

/** How many of the people each of a campaign's search rows found the owner
 *  rated, by answer: what the map's plan reads beside the counts. */
export async function ratingsByPhrase(tx: Tx, campaignId: number): Promise<Map<number, Partial<Record<LeadRating, number>>>> {
  const rows = await tx
    .select({ phraseId: leadRatings.phraseId, verdict: leadRatings.verdict, n: sql<number>`count(*)::int` })
    .from(leadRatings)
    .innerJoin(
      searches,
      and(eq(searches.organizationId, leadRatings.organizationId), eq(searches.id, leadRatings.phraseId)),
    )
    .where(eq(searches.campaignId, campaignId))
    .groupBy(leadRatings.phraseId, leadRatings.verdict);
  const byPhrase = new Map<number, Partial<Record<LeadRating, number>>>();
  for (const row of rows) {
    byPhrase.set(row.phraseId!, { ...byPhrase.get(row.phraseId!), [row.verdict]: row.n });
  }
  return byPhrase;
}
