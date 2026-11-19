import { truncateChars } from "../../operations/postSnippets";

/**
 * The small text helpers Find leads' stages share: how a limit counts, how a
 * model's sentence is kept, how a day is written in a prompt.
 */

/** A text's length in characters, as the limits count it: by code point. */
export const chars = (text: string): number => Array.from(text).length;

/** A model's sentence as it is kept: one line, cut to `max` characters; null
 *  when nothing is left. */
export const oneLine = (text: string | null | undefined, max: number): string | null => {
  const clean = text?.replace(/\s+/g, " ").trim();
  return clean ? truncateChars(clean, max) : null;
};

/** A moment as the day a prompt names it (UTC). */
export const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
