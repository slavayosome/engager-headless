import { z } from "zod";

export const MAX_TEXT_CHARACTERS = 1_250 as const;
export const MAX_TEXT_UTF8_BYTES = 5_000 as const;

export const AUTHORED_TEXT_CHARACTER_ERROR =
  "text must not contain control, bidirectional-formatting, or invisible format characters" as const;

const CONTROL_CHARACTER = /\p{Cc}/u;
const FORMAT_CHARACTER = /\p{Cf}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const COMBINING_MARK = /\p{M}/u;
const EMOJI_MODIFIER = /[\u{1F3FB}-\u{1F3FF}]/u;
const RGI_EMOJI_TAG_SEQUENCES = [
  // England, Scotland, and Wales. These are the only RGI emoji tag sequences;
  // arbitrary tag payloads stay forbidden because their letters are invisible.
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}",
] as const;

function isEmojiJoiner(codePoints: readonly string[], index: number): boolean {
  let previous = index - 1;
  while (
    previous >= 0 &&
    (COMBINING_MARK.test(codePoints[previous]!) ||
      EMOJI_MODIFIER.test(codePoints[previous]!))
  ) {
    previous -= 1;
  }
  return (
    previous >= 0 &&
    EXTENDED_PICTOGRAPHIC.test(codePoints[previous]!) &&
    index + 1 < codePoints.length &&
    EXTENDED_PICTOGRAPHIC.test(codePoints[index + 1]!)
  );
}

function allowedEmojiTagIndexes(codePoints: readonly string[]): Set<number> {
  const allowed = new Set<number>();
  for (const sequence of RGI_EMOJI_TAG_SEQUENCES) {
    const expected = [...sequence];
    for (let start = 0; start <= codePoints.length - expected.length; start += 1) {
      if (expected.every((character, offset) => codePoints[start + offset] === character)) {
        for (let offset = 1; offset < expected.length; offset += 1) {
          allowed.add(start + offset);
        }
      }
    }
  }
  return allowed;
}

/** Shared raw-text security boundary for authored submissions. */
export function authoredTextCharacterViolation(value: string): string | null {
  const codePoints = [...value];
  const allowedTags = allowedEmojiTagIndexes(codePoints);
  const forbidden = codePoints.some((character, index) => {
    // Intentional multi-line comments/replies remain supported. All other C0
    // controls, DEL, and C1 controls are rejected rather than normalized away.
    if (character === "\t" || character === "\n") return false;
    if (CONTROL_CHARACTER.test(character)) return true;
    if (!FORMAT_CHARACTER.test(character) || allowedTags.has(index)) return false;
    return character !== "\u200D" || !isEmojiJoiner(codePoints, index);
  });
  return forbidden ? AUTHORED_TEXT_CHARACTER_ERROR : null;
}

const NormalizedAuthoredTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= MAX_TEXT_CHARACTERS, {
    message: `text must be at most ${MAX_TEXT_CHARACTERS} Unicode code points`,
  })
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= MAX_TEXT_UTF8_BYTES,
    { message: `text must be at most ${MAX_TEXT_UTF8_BYTES} UTF-8 bytes` },
  );

export const AuthoredTextSchema = z
  .string()
  .refine((value) => authoredTextCharacterViolation(value) === null, {
    message: AUTHORED_TEXT_CHARACTER_ERROR,
  })
  .pipe(NormalizedAuthoredTextSchema);

export const TRIAGE_ANGLE_MAX_CHARS = 280;

/**
 * Tolerant sanitizer for the OPTIONAL per-post angle (contract 1.2.0,
 * additive). The angle is a bonus field: a malformed, oversized, or
 * wrong-typed value must NEVER reject the verdict or the receipt — it
 * degrades to `undefined` (or is clamped) instead of failing validation.
 */
export function sanitizeTriageAngle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > TRIAGE_ANGLE_MAX_CHARS
    ? collapsed.slice(0, TRIAGE_ANGLE_MAX_CHARS)
    : collapsed;
}

