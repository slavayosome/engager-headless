/**
 * How much of an agent-offered draft survives in the text a human saved, and
 * how much of that text the owner supplied in the first place.
 *
 * Shared verbatim by the server (which freezes both ratios onto the response at
 * save time) and by the First-Radar widget (which renders the live authorship
 * label as the owner types). One implementation, so the label can never promise
 * something calibration will not honour.
 *
 * Deliberately dependency-free and browser-safe: no node builtins, no imports.
 */

/** At or above this, the saved text is mostly the agent's and is excluded from
 *  the voice corpus. Tuned as policy, not as a durable contract — the stored
 *  value is the measured ratio, so this can move without a migration. */
export const FIRST_RADAR_ASSIST_RETENTION_MAX = 0.5;

/**
 * At or above this share of the saved text traced back to the OWNER'S own
 * words, retention against the agent's draft stops meaning the agent wrote it.
 *
 * Set to the same 0.5 as the retention ceiling on purpose: the two measures are
 * the same containment on the same normalized text, so one bar answers both
 * "mostly the agent's" and "mostly theirs to begin with" rather than inventing a
 * second, unexplainable number.
 */
export const OWNER_ORIGIN_MIN = 0.5;

/**
 * How many of the most recent offered drafts a saved comment is scored
 * against.
 *
 * This exists so the LIVE label and the SAVE-TIME measurement can agree
 * exactly. The card cannot hold an unbounded draft history — the payload is
 * re-fetched on every poll — so the server measures against the same bounded
 * window the card was given rather than against everything it has ever stored.
 * Without the shared bound the label silently over-promises: score against the
 * newest draft alone and an owner who re-rolls, then goes back to an earlier
 * draft, is told "your words" and saved as assisted.
 *
 * Widened deliberately past any real session (drafts per finding run 1-3), so
 * the residual gap needs an owner to reproduce a draft older than this window
 * from outside the card.
 */
export const ASSIST_RETENTION_WINDOW = 5;

/**
 * The drafts a comment is measured against: newest first, bounded by
 * {@link ASSIST_RETENTION_WINDOW}. Both the server and the widget go through
 * here so neither can drift from the other by slicing differently.
 *
 * Owner-supplied wording is bounded by the same window, for the same reason:
 * the card can only be handed so much, and whatever it was handed is what the
 * save must score.
 */
export function retentionWindow(offered: readonly string[]): string[] {
  return offered.slice(0, ASSIST_RETENTION_WINDOW);
}

/**
 * How much owner-supplied wording one finding retains. Bounded well past the
 * scoring window so an owner who dictates, re-rolls, then dictates again keeps
 * the earlier phrasing on file — and capped so an abandoned session cannot grow
 * the row without bound.
 */
export const OWNER_WORDS_LIMIT = 10;

/**
 * Record wording the owner supplied, newest first.
 *
 * Append-only within a finding: `seedText` and a chat instruction are both
 * cleared every round, but authorship is measured only when the owner SAVES, so
 * anything dropped in between would silently become the agent's. Duplicates fold
 * together on the normalized form, so re-sending the same sentence on every
 * redraft cannot crowd out what they said earlier.
 */
export function recordOwnerWords(
  existing: readonly string[] | null | undefined,
  added: string | null | undefined,
): string[] {
  const kept = (existing ?? []).filter((value) => value.trim().length > 0);
  const value = added?.trim() ?? "";
  if (value.length === 0) return kept.slice(0, OWNER_WORDS_LIMIT);
  const key = normalizeForProvenance(value).join(" ");
  const withoutDuplicate = kept.filter(
    (entry) => normalizeForProvenance(entry).join(" ") !== key,
  );
  return [value, ...withoutDuplicate].slice(0, OWNER_WORDS_LIMIT);
}

/** Below this many words, n-gram containment is meaningless, so the comparison
 *  falls back to exact normalized equality. */
const MIN_GRAM_WORDS = 6;
const GRAM_SIZE = 3;

/**
 * Fold away everything a human might change without changing authorship:
 * unicode form, case, punctuation, and whitespace runs. What survives is the
 * word sequence.
 */
export function normalizeForProvenance(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

function grams(words: string[], size: number): string[] {
  if (words.length < size) return [];
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) {
    out.push(words.slice(i, i + size).join(" "));
  }
  return out;
}

/**
 * The share of the SAVED text's word 3-grams that also appear in the draft.
 *
 * Directional on purpose. Measuring what the human kept — not what the draft
 * lost — means padding a draft with extra sentences cannot dilute the score,
 * and a short verbatim keep still reads as fully assisted.
 */
function containment(saved: string[], draft: string[]): number {
  if (saved.length < MIN_GRAM_WORDS || draft.length < MIN_GRAM_WORDS) {
    return saved.length > 0 && saved.join(" ") === draft.join(" ") ? 1 : 0;
  }
  const savedGrams = grams(saved, GRAM_SIZE);
  if (savedGrams.length === 0) {
    return saved.join(" ") === draft.join(" ") ? 1 : 0;
  }
  const draftGrams = new Set(grams(draft, GRAM_SIZE));
  let kept = 0;
  for (const gram of savedGrams) if (draftGrams.has(gram)) kept += 1;
  return kept / savedGrams.length;
}

/**
 * The best containment of the saved text across a set of comparison texts, and
 * which one won. Shared by both measures so neither can drift from the other.
 */
function bestContainment(
  saved: string,
  sources: readonly string[],
): { score: number; matchedIndex: number | null } {
  const savedWords = normalizeForProvenance(saved);
  if (savedWords.length === 0 || sources.length === 0) {
    return { score: 0, matchedIndex: null };
  }
  let best = 0;
  let bestIndex: number | null = null;
  for (let index = 0; index < sources.length; index += 1) {
    const score = containment(
      savedWords,
      normalizeForProvenance(sources[index] ?? ""),
    );
    if (bestIndex === null || score > best) {
      best = score;
      bestIndex = index;
    }
  }
  return { score: best, matchedIndex: bestIndex };
}

export type AssistRetention = {
  /** 0 = none of the agent's wording survived, 1 = all of it did. */
  retention: number;
  /** Index in `offered` of the draft the saved text most resembles. */
  matchedIndex: number | null;
};

/**
 * Score the saved text against EVERY draft that was offered for this post, not
 * just the last one. An owner who re-rolls three times and then goes back to
 * near-verbatim draft #1 is still assisted.
 */
export function assistRetention(
  saved: string,
  offered: readonly string[],
): AssistRetention {
  const { score, matchedIndex } = bestContainment(saved, offered);
  return { retention: score, matchedIndex };
}

export type OwnerOrigin = {
  /** 0 = none of the saved text traces to the owner's own words, 1 = all of it. */
  origin: number;
  /** Index in `ownerWords` of the source the saved text most resembles. */
  matchedIndex: number | null;
};

/**
 * How much of the saved text the OWNER supplied — measured against the words
 * they actually contributed: what they typed in the box before pressing Improve
 * mine, and what they dictated to their agent in chat.
 *
 * This exists because retention alone cannot tell authorship from CHANNEL. An
 * owner who says "put it like this: …" and keeps what comes back reads as fully
 * assisted — retention 1.0 — while every word is theirs. Measuring the same
 * containment against their own text recovers the difference.
 *
 * Directional exactly like {@link assistRetention}, and for the same reason: a
 * long rambling chat message cannot dilute a short comment drawn out of it, and
 * a comment that merely brushes past what they said scores low.
 */
export function ownerOrigin(
  saved: string,
  ownerWords: readonly string[],
): OwnerOrigin {
  const { score, matchedIndex } = bestContainment(saved, ownerWords);
  return { origin: score, matchedIndex };
}

/**
 * True when the saved text kept enough of a draft to be agent-assisted AND the
 * owner did not supply those words to begin with.
 *
 * Owner-origin can only ever RESCUE text from the assisted bucket, never push
 * text into it: a comment that retained nothing from any draft is the owner's
 * regardless. So a wrong or missing owner-origin measurement degrades to
 * exactly the old behaviour.
 */
export function isAssisted(
  retention: number | null | undefined,
  origin?: number | null | undefined,
): boolean {
  if (retention == null || retention < FIRST_RADAR_ASSIST_RETENTION_MAX) {
    return false;
  }
  return !(origin != null && origin >= OWNER_ORIGIN_MIN);
}

/**
 * Both halves of authorship for words the owner saved from a box their agent
 * offered words for — a reply, a DM: how much of the agent's words the saved
 * text kept, and how much of it the owner had typed before them, each over the
 * window a saved comment is measured in. Null when no agent words were
 * offered, where the text is the owner's by construction.
 */
export function measureBoxAssist(
  saved: string,
  assistTexts: readonly string[] | undefined,
  ownerWords: readonly string[] | undefined,
): { assistRetention: number; ownerOrigin: number | null } | null {
  const offered = retentionWindow(assistTexts ?? []);
  if (offered.length === 0) return null;
  const typed = retentionWindow(ownerWords ?? []);
  return {
    assistRetention: assistRetention(saved, offered).retention,
    ownerOrigin: typed.length > 0 ? ownerOrigin(saved, typed).origin : null,
  };
}

/** A text's identity as a box holds it: its characters, surrounding space
 *  trimmed and whitespace runs folded. */
function foldSpace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * True when the saved text IS one of the texts the agent offered, untouched:
 * the same characters once whitespace is folded. Any other change, one comma
 * included, is an edit, and an edit keeps the measures above.
 *
 * The owner's press on their agent's words left as they were approves those
 * words; it does not author them. A save that is this goes out as the agent's
 * (`messages.publishOrigin = 'worker'`), where caps bind, however it was
 * pressed.
 */
export function isUntouchedOffer(saved: string, offered: readonly string[]): boolean {
  const key = foldSpace(saved);
  return key.length > 0 && offered.some((text) => foldSpace(text) === key);
}

/**
 * Word-level normalized Levenshtein distance over the provenance-normalized
 * token sequences: 0 = the same words in the same order, 1 = nothing shared.
 * Word-level on purpose — {@link normalizeForProvenance} already folds case,
 * punctuation, and whitespace, so a threshold like 0.2 reads as "at most a
 * fifth of the words changed" and punctuation churn cannot move it.
 */
export function normalizedEditDistance(a: string, b: string): number {
  const wordsA = normalizeForProvenance(a);
  const wordsB = normalizeForProvenance(b);
  if (wordsA.length === 0 && wordsB.length === 0) return 0;
  if (wordsA.length === 0 || wordsB.length === 0) return 1;
  let prev: number[] = Array.from({ length: wordsB.length + 1 }, (_, j) => j);
  for (let i = 1; i <= wordsA.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= wordsB.length; j += 1) {
      current.push(
        Math.min(
          prev[j]! + 1,
          current[j - 1]! + 1,
          prev[j - 1]! + (wordsA[i - 1] === wordsB[j - 1] ? 0 : 1),
        ),
      );
    }
    prev = current;
  }
  return prev[wordsB.length]! / Math.max(wordsA.length, wordsB.length);
}

export type DraftFit = {
  /** Normalized word-level edit distance to the closest offered draft. */
  distance: number;
  /** Index in `offeredDrafts` of the closest draft. */
  matchedIndex: number | null;
};

/**
 * The closest offered DRAFT to the saved text — drafts only, never angles: an
 * angle is a hint the owner writes FROM, so keeping one verbatim is a
 * retention question, not a draft-fit question. Null when nothing was
 * offered — no draft, no fit to measure (never conflate with distance 1).
 */
export function bestDraftFit(
  saved: string,
  offeredDrafts: readonly string[],
): DraftFit | null {
  if (offeredDrafts.length === 0) return null;
  let best: DraftFit | null = null;
  for (let index = 0; index < offeredDrafts.length; index += 1) {
    const distance = normalizedEditDistance(saved, offeredDrafts[index] ?? "");
    if (best === null || distance < best.distance) {
      best = { distance, matchedIndex: index };
    }
  }
  return best;
}
