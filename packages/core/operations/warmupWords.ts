/** The account's warm-up as the owner reads it, on the Limits tab and a chat
 *  card: zero weeks is Off (`channels.warmup_weeks`). Dependency-free, so a
 *  client page says it the same way. */
export const warmupWords = (weeks: number): string =>
  weeks === 0 ? "Off" : weeks === 1 ? "1 week" : `${weeks} weeks`;
