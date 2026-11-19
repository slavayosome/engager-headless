import type { LeadSignalRow } from "@engager/database/schema";
import { chars } from "./text";

/**
 * THE SCREEN RULE: a comment too short to hold a thought, with no question in
 * it, has no words of its own for the model to judge ("great post", "congrats",
 * an emoji). It reads the stored words and nothing else, so it needs no model
 * call and no LinkedIn read, and a post is never judged by it: a post is the
 * person's own thing to say, however short.
 */

/** A comment with fewer characters than this, and no question, is dropped. */
export const SCREEN_RULE_MIN_CHARS = 60;

/** What keeps a short comment: someone asking is not someone with nothing to say. */
export const SCREEN_RULE_QUESTION_MARK = "?";

/** The note a word dropped by the rule keeps in place of a model's. */
export const SCREEN_RULE_NOTE = "Dropped by rule: a short comment with no question";

/** Whether the rule drops these stored words. */
export function screenRuleDrops(word: Pick<LeadSignalRow, "kind" | "words">): boolean {
  return (
    word.kind === "comment" && chars(word.words) < SCREEN_RULE_MIN_CHARS && !word.words.includes(SCREEN_RULE_QUESTION_MARK)
  );
}
