/**
 * THE BOUNDS ON THE ACCOUNT'S DAILY READ BUDGETS — dependency-free, so the
 * page that edits them states the same range `orgSafetyAfter` clamps to.
 */

/** Bounds on the two research-read budgets. As with searches there is no
 *  ceiling to hold the owner to (INV-6): each read is a page load on the real
 *  account, so the product advises past `READ_CAP_ADVISORY` and never refuses.
 *  0 turns that read off. */
export const DAILY_READ_CAP_BOUNDS = { min: 0, max: Number.MAX_SAFE_INTEGER } as const;

/** Past this many a day, more post or profile reads raise the chance LinkedIn
 *  restricts the account. Said on the Limits page and in the tools; nothing is
 *  refused. */
export const READ_CAP_ADVISORY = 200;

/** Bounds on the reply-check budget. No 0: seeing what people wrote back is
 *  the point of commenting, so the floor still checks a handful of threads. */
export const DAILY_REPLY_CHECK_CAP_BOUNDS = { min: 20, max: 300 } as const;

/** Bounds on the account's discovery search limits, a day and an hour. There
 *  is no ceiling to hold the owner to (INV-6): the product advises at the
 *  numbers below and never refuses, so the only top is the largest whole
 *  number a column can store exactly. 0 turns discovery reads off. */
export const SEARCH_CAP_BOUNDS = { min: 0, max: Number.MAX_SAFE_INTEGER } as const;

/** Past these, more searches raise the chance LinkedIn restricts the account.
 *  Said as a warning on the Limits page and in the tools; nothing is refused. */
export const SEARCH_CAP_ADVISORY = { daily: 300, hourly: 120 } as const;
