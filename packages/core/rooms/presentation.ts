/** `author_maybe` is a post Research left to the owner: in the deck, never
 * drafted, replied to or counted as confirmed by a worker. */
export type JoinLens = "none" | "author" | "room" | "both" | "author_maybe";
export type RoomEvidence = {
  fits: number;
  judged: number;
  pages: 1 | 2;
  commentsRead: number;
  totalComments: number;
  coverage: "complete" | "sampled" | "budget_limited";
  stale: boolean;
  firstPageFits?: number;
};

/** The card and the database use the same bounded room contribution. */
export function worthJoining(fit: number | null, lens?: JoinLens | null, room?: RoomEvidence | null) {
  const roomWorth = room && !room.stale && (lens === "room" || lens === "both")
    ? Math.min(1, 0.8 + 0.02 * room.fits) : 0;
  return Math.max(fit ?? 0, roomWorth);
}

/** A post whose room Research liked and whose author it did not: the owner
 * answers the people in the comments, and there is no comment on the post
 * itself. */
export function roomOnly({ joinLens, authorFit }: {
  joinLens: JoinLens | null;
  authorFit: "fits" | "maybe" | "not" | null;
}): boolean {
  return joinLens === "room" && authorFit === "not";
}

export function whyJoin(lens: JoinLens, fits: number, firstPageFits?: number): string | null {
  if ((lens === "room" || lens === "both") && fits === 0 && firstPageFits !== undefined) {
    return `${lens === "both" ? "The author fits. " : ""}The first page qualified this room; the combined read has no confirmed matches.`;
  }
  const people = fits === 1 ? "1 person who fits is" : `${fits} people who fit are`;
  if (lens === "room") return `Join for the room: ${people} in the comments.`;
  if (lens === "author") return "Join for the author.";
  if (lens === "both") return `Join for both: the author fits, and ${people} in the comments.`;
  if (lens === "author_maybe") return "Your call: the author may fit your audience.";
  return null;
}
