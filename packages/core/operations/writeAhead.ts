/**
 * "WRITE COMMENTS AHEAD" — how far into the account's day plan an Automatic
 * Comment step drafts (`computeCommentDemand`). Dependency-free, so the page
 * that switches it says the values `orgSafetyAfter` accepts.
 *
 * `next_few` keeps the plan's next few slots supplied; `rest_of_day` every
 * slot the account's day has left, as `channels.write_ahead` stores them.
 */
export const WRITE_AHEAD = ["next_few", "rest_of_day"] as const;
export type WriteAhead = (typeof WRITE_AHEAD)[number];

/** The two values as the owner reads them, on the Limits tab and a chat card. */
export const WRITE_AHEAD_WORDS: Record<WriteAhead, string> = {
  next_few: "Next few",
  rest_of_day: "Rest of the day",
};
