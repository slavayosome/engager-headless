import { roomOnly, type RoomEvidence } from "../rooms/presentation";
import type { PostEvidence } from "./itemEvidence";
import type { PersonThread } from "./threads";

/**
 * WHY SCOUT PUT AN ITEM IN FRONT OF THE OWNER, in one plain sentence from
 * stored rows (`itemEvidence.ts`), the reasons and numbers behind it one
 * press away. Pure: names and counts in, words out. The sentence says only
 * why the item is there; what has happened since is the thread's, and no one's
 * pronouns are guessed.
 *
 * The first rule that fits applies. An item no rule fits has no note: the
 * owner's comment on a post Scout never matched.
 */

/** What brought the item, by the rows it was cut from. */
export type WhySubject =
  /** Their own post. */
  | { kind: "post" }
  /** A comment of theirs Scout read in a room, under `author`'s post. */
  | { kind: "room_comment"; author: string | null }
  /** Their reply under the owner's comment on `author`'s post, and whether
   *  their invitation is tied to it. */
  | { kind: "reply"; author: string | null; invited: boolean }
  /** Their comment on the owner's own post. */
  | { kind: "comment_on_yours" }
  /** Their invitation, tied to no reply. */
  | { kind: "invitation" };

/** One reason behind the sentence: plain words, or what the room says, whose
 *  source comments open on press. */
export type WhyPoint =
  | { kind: "text"; text: string }
  | {
      kind: "insight";
      label: "Pains" | "Pushback" | "Still asking";
      text: string;
      sources: Array<{ name: string | null; text: string }>;
    };

export type WhyPicked = {
  summary: string;
  points: WhyPoint[];
  /** One quiet line of numbers; null with none to show. */
  foot: string | null;
};

const STALE = "Audience evidence needs another read.";
const FIRST_PAGE = "The first page qualified this room; the combined read has no confirmed matches.";

const INSIGHT_LABEL = { pain: "Pains", objection: "Pushback", open_question: "Still asking" } as const;

/** The subject of an item, from its thread; null for an item that is none of
 *  these, which has no note. `invited`: their invitation is tied to the
 *  thread's reply. */
export function whySubject(
  item: { key: string },
  thread: Pick<PersonThread, "kind" | "postAuthor" | "room"> | undefined,
  invited: boolean,
): WhySubject | null {
  if (item.key.startsWith("invitation:")) return { kind: "invitation" };
  if (!thread) return item.key.startsWith("post:") ? { kind: "post" } : null;
  switch (thread.kind) {
    case "their_post":
      return { kind: "post" };
    case "spotted_in":
      return { kind: "room_comment", author: thread.room?.author ?? thread.postAuthor };
    case "their_reply":
      return { kind: "reply", author: thread.postAuthor, invited };
    case "own_post":
      return { kind: "comment_on_yours" };
  }
}

export function whyPicked(input: {
  /** The person's first name. */
  first: string;
  subject: WhySubject;
  evidence: PostEvidence | null;
}): WhyPicked | null {
  const { first, subject, evidence } = input;
  const summary = summaryOf(first, subject, evidence);
  if (summary === null) return null;
  return { summary, points: pointsOf(evidence), foot: footOf(first, subject, evidence) };
}

/** "1 person who fits is" or "3 people who fit are". */
function people(fits: number): string {
  return fits === 1 ? "1 person who fits is" : `${fits} people who fit are`;
}

/** How a room reads in a sentence: not current, qualified by its first page
 *  alone, with someone who fits, or with no one. */
function roomState(room: RoomEvidence): "stale" | "first_page" | "fits" | "none" {
  if (room.stale) return "stale";
  if (room.fits > 0) return "fits";
  return room.firstPageFits !== undefined ? "first_page" : "none";
}

function summaryOf(first: string, subject: WhySubject, evidence: PostEvidence | null): string | null {
  switch (subject.kind) {
    case "invitation":
      return `${first} invited you to connect.`;
    case "comment_on_yours":
      return `${first} commented on your post.`;
    case "reply":
      return `${first} replied under your comment on ${
        subject.author ? `${subject.author}’s post` : "a post"
      }${subject.invited ? ", then invited you to connect." : "."}`;
    case "room_comment":
      return roomCommentSummary(first, subject.author, evidence);
    case "post":
      return postSummary(first, evidence);
  }
}

function roomCommentSummary(first: string, author: string | null, evidence: PostEvidence | null): string | null {
  const room = evidence?.room;
  if (!evidence || !room) return null;
  const state = roomState(room);
  if (roomOnly({ joinLens: evidence.lens, authorFit: evidence.authorFit }) && (state === "stale" || state === "fits")) {
    const who = author ?? "The author";
    return state === "stale"
      ? `${who} isn’t your audience, so there is no comment on the post itself. ${STALE}`
      : `${who} isn’t your audience, but ${people(room.fits)} in the comments. Reply to them; there is no comment on the post itself.`;
  }
  if (state === "stale") return STALE;
  const under = author ? `${author}’s post` : "the post";
  if (room.fits === 0) return `${first} commented under ${under}.`;
  return room.fits === 1
    ? `${first} is the one person who fits in the comments under ${under}.`
    : `${first} is one of ${room.fits} people who fit in the comments under ${under}.`;
}

function postSummary(first: string, evidence: PostEvidence | null): string | null {
  if (!evidence) return null;
  const room = evidence.room;
  const state = room ? roomState(room) : "none";
  switch (evidence.lens) {
    case "both": {
      if (state === "stale") return `${first} fits. ${STALE}`;
      if (state === "first_page") return `${first} fits. ${FIRST_PAGE}`;
      return state === "fits" && room
        ? `${first} fits, and ${people(room.fits)} in the comments.`
        : `${first} fits.`;
    }
    case "author":
      return `${first} fits.`;
    case "author_maybe":
      return `Your call: ${first} may fit your audience.`;
    case "room":
      if (state === "stale") return STALE;
      if (state === "first_page") return FIRST_PAGE;
      if (state === "fits" && room) return `${people(room.fits)} in the comments of ${first}’s post.`;
      break;
  }
  return evidence.matched ? `Scout matched ${first}’s post to this campaign.` : null;
}

/** Behind More, in order: why the post, the read's line, what the room says,
 *  and who is already in the comments when no one was judged to fit. */
function pointsOf(evidence: PostEvidence | null): WhyPoint[] {
  if (!evidence) return [];
  const points: WhyPoint[] = [];
  if (evidence.why) points.push({ kind: "text", text: evidence.why });
  if (evidence.reason) points.push({ kind: "text", text: evidence.reason });
  for (const insight of evidence.insights) {
    if (insight.sources.length === 0) continue;
    points.push({
      kind: "insight",
      label: INSIGHT_LABEL[insight.kind],
      text: insight.text,
      sources: insight.sources.map((source) => ({ name: source.authorName, text: source.text })),
    });
  }
  if (!evidence.room?.fits) {
    for (const comment of evidence.topComments) {
      points.push({ kind: "text", text: `${comment.authorName}: “${comment.text}”` });
    }
  }
  return points;
}

/** The numbers, each only where its row exists. */
function footOf(first: string, subject: WhySubject, evidence: PostEvidence | null): string | null {
  const room = evidence?.room;
  const parts: string[] = [];
  if (room) {
    parts.push(
      `Scout read ${room.commentsRead} of ${room.totalComments} comments`,
      `${room.fits} of ${room.judged} people it judged fit your audience`,
    );
    if (room.coverage === "budget_limited") parts.push("read budget reached");
  }
  const found = foundPart(first, subject, evidence);
  if (found) parts.push(found);
  if (parts.length === 0) return null;
  const line = parts.join(" · ");
  return `${room?.stale ? "Previous read: " : ""}${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/** How they were found. */
function foundPart(first: string, subject: WhySubject, evidence: PostEvidence | null): string | null {
  switch (subject.kind) {
    case "reply":
      return `found through ${first}’s reply to your comment`;
    case "comment_on_yours":
      return `found through ${first}’s comment on your post`;
    case "invitation":
      return `found through ${first}’s invitation`;
    case "post":
    case "room_comment":
      return null;
  }
}
