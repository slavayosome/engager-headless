/**
 * Small, dependency-free decoders shared by every read that describes a
 * discovered post outside the full Radar row: the deck-focus read, the
 * drafting context, and the Radar workspace itself. One implementation so
 * "how many reactions does this post have" can never answer differently
 * per surface.
 */

/** Enough of a post to recognise which one is meant, and no more. */
export const POST_EXCERPT_LIMIT = 200;

/**
 * Cut a string to `limit` CHARACTERS — code points, never UTF-16 units.
 *
 * `slice()` counts units, and LinkedIn is full of text that is nothing but
 * surrogate pairs: the 𝗯𝗼𝗹𝗱 and 𝘪𝘵𝘢𝘭𝘪𝘤 letters people style posts with are all
 * astral. Cutting one in half leaves a LONE SURROGATE, which is a valid
 * JavaScript string and invalid JSON — Postgres rejects it with "Unicode low
 * surrogate must follow a high surrogate", so a deck payload carrying one blew
 * up the whole chat transcript insert and lost the turn.
 */
export function truncateChars(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join("");
}

export function postExcerpt(
  contentText: string | null,
  limit = POST_EXCERPT_LIMIT,
): string | null {
  if (!contentText) return null;
  const flat = contentText.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  const cut = truncateChars(flat, limit);
  return cut === flat ? flat : `${cut}…`;
}

/** Provider metric payloads are untyped jsonb with per-provider key spellings;
 *  read the first finite non-negative hit. */
function metricCount(metrics: unknown, keys: string[]): number {
  if (!metrics || typeof metrics !== "object") return 0;
  const values = metrics as Record<string, unknown>;
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return 0;
}

export type PostEngagement = { comments: number; reactions: number };

export function engagementCounts(metrics: unknown): PostEngagement {
  return {
    comments: metricCount(metrics, [
      "comments",
      "numComments",
      "comment_count",
      "commentCount",
    ]),
    reactions: metricCount(metrics, [
      "reactions",
      "likes",
      "numLikes",
      "reaction_count",
      "totalReactions",
    ]),
  };
}
