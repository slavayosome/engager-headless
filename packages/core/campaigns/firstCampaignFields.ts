import { z } from "zod";

/**
 * THE FIRST CAMPAIGN'S FIELDS, AS ITS SETUP SCREENS BOUND THEM — the one home
 * of the numbers the owner's line, the agent's draft and the owner's edits all
 * answer to, so the screens, the agent's answer schema and the stored working
 * copy never disagree. Each number is the limit of the place the field ends up:
 * a campaign's name, the audience's `who.summary` and `who.signals`
 * (`audience/model.ts`) and a Scout's searches (`confirmedScoutSchema`).
 *
 * Client-safe: zod alone, so a setup screen can import it.
 */
export const FIRST_CAMPAIGN = {
  lineMin: 10,
  lineMax: 500,
  nameMax: 200,
  audienceMax: 500,
  topicsMax: 12,
  topicMax: 60,
  searchesMax: 5,
  searchMax: 100,
} as const;

/** The owner's line, as the server takes it: trimmed, at least the existing
 *  Scout minimum, and what `who.summary` can hold. */
export const firstCampaignLineSchema = z
  .string()
  .trim()
  .min(FIRST_CAMPAIGN.lineMin, "Describe whose posts you want to find.")
  .max(FIRST_CAMPAIGN.lineMax, `Keep your line to ${FIRST_CAMPAIGN.lineMax} characters or fewer.`);

/** Whether a line is long enough to draft from. Leading and trailing spaces
 *  are not counted. */
export function lineReady(line: string): boolean {
  return line.trim().length >= FIRST_CAMPAIGN.lineMin;
}

/** The values with a repeat of an earlier one (ignoring case) dropped. */
export function uniqueIgnoringCase(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase("en");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The searches a textarea holds: one per line, blank lines dropped. */
export function searchLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The topics with `raw` added, or the same topics when it adds nothing: an
 *  empty topic, one already there (ignoring case), or a full row. */
export function withTopic(topics: readonly string[], raw: string): string[] {
  const topic = raw.trim().slice(0, FIRST_CAMPAIGN.topicMax);
  if (!topic || topics.length >= FIRST_CAMPAIGN.topicsMax) return [...topics];
  return uniqueIgnoringCase([...topics, topic]);
}

/**
 * Why a draft cannot continue yet, in the owner's words, or null when it can.
 * The searches are the owner's list, so what is checked is the list as the
 * textarea holds it.
 */
export function draftBlocker(draft: { name: string; audience: string; searches: readonly string[] }): string | null {
  if (!draft.name.trim()) return "Give the campaign a name.";
  if (!draft.audience.trim()) return "Describe who you want to reach.";
  if (draft.searches.length === 0) return "Keep at least one search for this Scout to run.";
  if (draft.searches.length > FIRST_CAMPAIGN.searchesMax) return "Keep five searches or fewer.";
  if (draft.searches.some((search) => search.length > FIRST_CAMPAIGN.searchMax))
    return `Keep each search to ${FIRST_CAMPAIGN.searchMax} characters or fewer.`;
  return null;
}
