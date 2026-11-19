import type { ResolvedStyleRules } from "@engager/database/schema";
import { authoredTextCharacterViolation } from "./authoredText";

export type IntakeGateViolation = { rule: string; detail: string };

/** The fewest consecutive words two texts may share before the later one is
 *  a repeat of the earlier. */
export const REPEATED_RUN_WORDS = 8;

/** How far back a comment the account sent still counts as one it said. */
export const REPEATED_WINDOW_MS = 14 * 86_400_000;

function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The longest run of words `text` shares, word for word, with the first text in
 * `sent` that shares one of {@link REPEATED_RUN_WORDS} or more — case and
 * punctuation set aside — or null when it repeats none of them.
 */
export function repeatedRun(text: string, sent: readonly string[]): string | null {
  const own = wordsOf(text);
  const starts = new Map<string, number>();
  for (let at = 0; at + REPEATED_RUN_WORDS <= own.length; at += 1) {
    const run = own.slice(at, at + REPEATED_RUN_WORDS).join(" ");
    if (!starts.has(run)) starts.set(run, at);
  }
  if (starts.size === 0) return null;
  for (const earlier of sent) {
    const theirs = wordsOf(earlier);
    for (let at = 0; at + REPEATED_RUN_WORDS <= theirs.length; at += 1) {
      const start = starts.get(theirs.slice(at, at + REPEATED_RUN_WORDS).join(" "));
      if (start === undefined) continue;
      let length = REPEATED_RUN_WORDS;
      while (own[start + length] !== undefined && own[start + length] === theirs[at + length]) length += 1;
      return own.slice(start, start + length).join(" ");
    }
  }
  return null;
}

/** The deterministic hard gate shared by client-authored comments and replies.
 *  `ownerStory` says the draft tells one of the owner's documented stories.
 *  `sent` is what the account sent, or has approved, lately (`sentTexts`): a
 *  draft that repeats a long run of it is refused, to be told in fresh words.
 *  Only an agent's draft is passed it — words the owner wrote are never
 *  refused for repeating. */
export function intakeGateViolations(
  text: string,
  rules: ResolvedStyleRules,
  opts: { ownerStory?: boolean; sent?: readonly string[] } = {},
): IntakeGateViolation[] {
  const textBoundary = authoredTextCharacterViolation(text);
  const repeated = opts.sent ? repeatedRun(text, opts.sent) : null;
  // Editorial choices require semantic judgment against the effective owner
  // instructions. Intake must not reintroduce an independent style policy.
  return [
    ...(textBoundary ? [{ rule: "text_boundary", detail: textBoundary }] : []),
    ...(repeated
      ? [{
          rule: "repeated_phrasing",
          detail: `repeats "${repeated.split(" ").slice(0, 12).join(" ")}" word for word from a comment already sent; tell it in fresh words`,
        }]
      : []),
  ];
}
