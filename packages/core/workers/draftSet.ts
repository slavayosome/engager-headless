import type { DraftTrace } from "@engager/database/schema";

/**
 * A comment's judged set, as its trace keeps it: the draft Engager picked, the
 * others it beat, and the swap between them. Sets that exist are read here;
 * none is written any more — the draft dispatcher writes and judges against
 * its plan (`dispatcher/phase.ts`).
 */

/** A judged set as a comment's trace keeps it (`DraftTrace.pick`). */
export type TracedPick = NonNullable<DraftTrace["pick"]>;

/** One draft of a comment's judged set: its number in the set — 1 is the one
 *  Engager picked — its move and words, whether it is in the box, and, for a
 *  draft the owner asked their agent for, the angle it was written from. */
export type SetDraft = {
  draft: number;
  move: string;
  text: string;
  inBox: boolean;
  asked: boolean;
  angle: string | null;
};

/** A draft's number in its set, read where `pick.others` holds it. */
const otherNumber = (other: TracedPick["others"][number], index: number) => other.draft ?? index + 2;

/** Every draft of the set a comment was picked from, in the set's order,
 *  given the words in its box as they were drafted. */
export function setDrafts(pick: TracedPick, boxText: string): SetDraft[] {
  return [
    {
      draft: pick.draft ?? 1,
      move: pick.move,
      text: boxText,
      inBox: true,
      asked: pick.asked === true,
      angle: pick.angle ?? null,
    },
    ...pick.others.map((other, index) => ({
      draft: otherNumber(other, index),
      move: other.move,
      text: other.text,
      inBox: false,
      asked: other.asked === true,
      angle: other.angle ?? null,
    })),
  ].sort((a, b) => a.draft - b.draft);
}

/** The number the next draft to join a set takes: one past its last. */
export function nextDraftNumber(pick: TracedPick): number {
  return Math.max(pick.draft ?? 1, ...pick.others.map(otherNumber)) + 1;
}

/**
 * The set with draft `variant` in the box: it and the draft there trade
 * places, each keeping its number, and its owner story, rationale and — for
 * one the owner asked for — the angle it came from with its words. Null where
 * no draft of that number is out of the box.
 */
export function swapPick(
  pick: TracedPick,
  box: { text: string; ownerStoryId: number | null; rationale?: string },
  variant: number,
): { pick: TracedPick; chosen: TracedPick["others"][number] } | null {
  const index = pick.others.findIndex((other, at) => otherNumber(other, at) === variant);
  const chosen = pick.others[index];
  if (!chosen) return null;
  const others = pick.others.map((other, at) =>
    at === index
      ? {
          move: pick.move,
          text: box.text,
          draft: pick.draft ?? 1,
          ...(box.ownerStoryId != null ? { ownerStoryId: box.ownerStoryId } : {}),
          ...(box.rationale ? { rationale: box.rationale } : {}),
          ...askedFrom(pick),
        }
      : { ...other, draft: otherNumber(other, at) },
  );
  const { asked: _asked, angle: _angle, ...judged } = pick;
  return { pick: { ...judged, move: chosen.move, draft: variant, others, ...askedFrom(chosen) }, chosen };
}

/** Where a draft the owner asked for came from, as it travels with its words. */
function askedFrom(draft: { asked?: true; angle?: string }): { asked?: true; angle?: string } {
  return {
    ...(draft.asked ? { asked: true as const } : {}),
    ...(draft.angle !== undefined ? { angle: draft.angle } : {}),
  };
}
