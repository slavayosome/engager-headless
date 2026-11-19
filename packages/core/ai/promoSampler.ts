import { and, desc, eq } from "drizzle-orm";
import { messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * Decide promo vs neutral for the next comment, SMOOTHED over recent history so
 * the mix tracks `promoRatio` without random streaks of 5 promos in a row.
 */
export async function decideCommentType(
  tx: Tx,
  campaignId: number,
  promoRatio: number,
  window = 20,
): Promise<"promo" | "neutral"> {
  if (promoRatio <= 0) return "neutral";
  if (promoRatio >= 1) return "promo";

  const recent = await tx
    .select({ ct: messages.commentType })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), eq(messages.kind, "comment")))
    .orderBy(desc(messages.createdAt))
    .limit(window);

  if (recent.length === 0) return promoRatio >= 0.5 ? "promo" : "neutral";
  const promo = recent.filter((r) => r.ct === "promo").length;
  const share = promo / recent.length;
  return share < promoRatio ? "promo" : "neutral";
}

/**
 * Decide whether THIS draft gets the web-search (fact-check) path, SMOOTHED over
 * recent history exactly like the promo mix: search when the realized share of
 * fact-checked drafts is under `campaign.webFactsRatio`, skip when at/over. Not
 * per-draft dice — the deficit model converges to x/10 without streaks, and since
 * the capacity planner drafts best-posts-first each cycle, the searched slots
 * naturally land on the highest-value posts. Reads `trace.facts.enabled` (written
 * for every draft of a webFacts campaign, true or false).
 */
export async function decideWebFacts(
  tx: Tx,
  campaignId: number,
  ratio: number,
  window = 20,
): Promise<boolean> {
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;
  const share = await recentFactsShare(tx, campaignId, window);
  // Cold start (share null): SEARCH — the deficit smoothing corrects from draft
  // two onward. The old ratio>=0.5 rule made every sub-0.5 campaign start dark,
  // and on the client path (which records nothing between context calls) that
  // darkened the ENTIRE first batch.
  if (share === null) return true;
  return share < ratio;
}

/** Realized share of fact-checked drafts over the campaign's recent window
 *  (null = no history yet). Exposed to the client path so a batch agent can
 *  compute its own deficit — context calls don't write history, so per-call
 *  decisions can't smooth a batch; the agent allocates instead. */
export async function recentFactsShare(
  tx: Tx,
  campaignId: number,
  window = 20,
): Promise<number | null> {
  const recent = await tx
    .select({ trace: messages.trace })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), eq(messages.kind, "comment")))
    .orderBy(desc(messages.createdAt))
    .limit(window);
  if (recent.length === 0) return null;
  const searched = recent.filter((r) => r.trace?.facts?.enabled === true).length;
  return searched / recent.length;
}
