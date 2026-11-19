import type { Lead, LeadIntent, LeadStage } from "@engager/database/schema";
import { leadStage } from "./read";
import { REPEAT_ENGAGER_TOUCHES } from "./scoring";

/**
 * HOW INTERESTED A CONTACTED PERSON IS, from what they wrote to the owner and
 * when, and nothing else: the topic only is Cold, a positive word or a habit
 * of writing is Warm, an ask or a question about the product is Hot, and a
 * month of silence is Dormant. A no to the owner's offer is Declined, whatever
 * came before it and however often they wrote (`people/declined.ts`). Their headline, company, fit and followers are
 * who they are, not how interested they are, and a like says nothing: neither
 * reaches this function. Pure and client-safe.
 *
 * It is not `leads.tier`, which scores intent against authority and counts
 * likes as touches (`scoring.ts`) so the hot-lead email can fire; nothing here
 * reads it.
 */

/** Words older than this make a person Dormant. */
export const DORMANT_AFTER_DAYS = 30;
const DAY = 86_400_000;

export type Warmth = "hot" | "warm" | "cold";
export type LeadTemperature =
  | { temperature: Warmth }
  /** Quiet for 30 days. `was` is what their words would read as without the
   *  date, so a Dormant person keeps the heat they left with. */
  | { temperature: "dormant"; was: Warmth }
  /** They said no to what the owner offered, at this moment, and nothing
   *  since has reopened it. */
  | { temperature: "declined"; at: number };

export type TemperatureInput = {
  stage: LeadStage;
  /** The best intent their words have shown (`leads.intent_level`). */
  intentLevel: LeadIntent;
  /** How many times they have written to the owner. */
  wordTouches: number;
  /** When the newest of those words arrived; null when they never wrote. */
  lastWordsAt: number | null;
  /** When they said no, where their newest word on the offer is one. */
  declinedAt?: number | null;
};

/** The temperature of a person, or null before the owner has written to them. */
export function leadTemperature(input: TemperatureInput, now: number): LeadTemperature | null {
  if (input.stage === "signal" || input.stage === "lead") return null;
  if (input.declinedAt != null) return { temperature: "declined", at: input.declinedAt };
  const warmth: Warmth =
    input.intentLevel === "explicit_ask" || input.intentLevel === "product_question"
      ? "hot"
      : input.intentLevel === "positive_signal" || input.wordTouches >= REPEAT_ENGAGER_TOUCHES
        ? "warm"
        : "cold";
  // Someone who never wrote has no quiet to count.
  if (input.lastWordsAt !== null && now - input.lastWordsAt > DORMANT_AFTER_DAYS * DAY) {
    return { temperature: "dormant", was: warmth };
  }
  return { temperature: warmth };
}

/** The same, for a stored lead: stage through `leadStage`, so a row today's
 *  intake wrote reads as the Relationship it is. */
export function leadTemperatureOf(
  lead: Pick<Lead, "stage" | "intentLevel" | "wordTouchCount" | "lastWordsAt">,
  now: number,
  declinedAt: number | null = null,
): LeadTemperature | null {
  return leadTemperature(
    {
      stage: leadStage(lead),
      intentLevel: lead.intentLevel,
      wordTouches: lead.wordTouchCount,
      lastWordsAt: lead.lastWordsAt,
      declinedAt,
    },
    now,
  );
}
