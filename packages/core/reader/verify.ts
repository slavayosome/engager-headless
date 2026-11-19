import { createHash } from "node:crypto";
import { commentId } from "../linkedin/commentThread";
import {
  dmWordsHash,
  type AgentPage,
  type CommentReply,
  type DmMessage,
  type DmThreadRead,
  type InboxThread,
} from "../linkedin/driver";
import type { CommentRepliesAnswer, DmThreadAnswer, InboxAnswer } from "./answers";
import {
  normalizeWords,
  parsePage,
  profileKey,
  profileSlug,
  profileUrl,
  saysWords,
  showsCount,
  threadIdOf,
  type PageItem,
  type ParsedPage,
} from "./representation";

/**
 * VERIFY EVERYTHING AGAINST THE PAGE. A model's answer is a claim about the
 * page it was shown; each claim stands only where the page itself says it.
 *
 *  - every urn, profile and thread id it cites is an anchor of the page, and
 *    each one where it belongs — a reply's author is linked from the reply's
 *    own row outside its words, a message's urn is a message the page holds;
 *  - a reply is one the PAGE marks a reply to our comment: the model's say
 *    is never asked;
 *  - every word it quotes is the page's, in the body of the row it names, and
 *    a count is one our row's own controls show, never its words;
 *  - our comment is the watch's own comment, by its id, and linked from our
 *    own profile.
 *
 * A row that fails is dropped and counted by reason; an answer whose frame
 * fails — our comment not on the page, a conversation that is not the one
 * asked for — yields nothing at all. What is left is a read like the
 * connector's own, and a read is all it ever is: nothing here is evidence
 * that a write happened (INV-2/INV-3).
 */

export type DropReason =
  | "not_on_page"
  | "duplicate"
  | "our_own_comment"
  | "not_a_reply_to_ours"
  | "older_than_our_comment"
  | "author_not_on_row"
  | "text_not_on_row"
  | "no_thread_id"
  | "participant_not_on_page"
  | "excerpt_not_on_page"
  | "author_not_a_participant";

export type Dropped = Partial<Record<DropReason, number>>;

function drop(dropped: Dropped, reason: DropReason): void {
  dropped[reason] = (dropped[reason] ?? 0) + 1;
}

/** How many rows a verification dropped, whatever the reasons. */
export function droppedCount(dropped: Dropped): number {
  return Object.values(dropped).reduce((sum, count) => sum + (count ?? 0), 0);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A comment id's own time: LinkedIn ids are snowflakes, milliseconds in
 *  the high bits. Null for an id that is not one, or a time no comment has. */
export function commentTime(urn: string): number | null {
  const id = commentId(urn);
  if (!/^\d{1,25}$/.test(id)) return null;
  const ms = Number(BigInt(id) >> 22n);
  return ms < 1104537600000 || ms > Date.now() + 86_400_000 ? null : ms;
}

function itemNamed(page: ParsedPage, urn: string): PageItem | undefined {
  return page.items.find((item) => item.urn === urn);
}

function itemByComment(page: ParsedPage, urn: string): PageItem | undefined {
  const id = commentId(urn);
  return page.items.find((item) => item.urn.startsWith("urn:li:comment:") && commentId(item.urn) === id);
}

// ---- comment_replies ------------------------------------------------------

export type VerifiedReplies =
  | {
      status: "verified";
      /** Our comment as the page keys it. */
      resolvedUrn: string;
      /** The replies to our comment the page shows, each one checked. */
      replies: CommentReply[];
      /** The counts our row's controls show, where they show them. */
      reactionCount: number | null;
      replyCount: number | null;
      dropped: Dropped;
    }
  | {
      status: "unverified";
      /** `comment_not_on_page`: the page holds no row with our comment's id;
       *  `comment_mismatch`: the answer named another comment as ours, or
       *  said ours was not there when it is; `not_our_comment`: the row is
       *  not linked from the connected account's profile. */
      reason: "comment_not_on_page" | "comment_mismatch" | "not_our_comment";
    };

export function verifyCommentReplies(
  page: AgentPage,
  answer: CommentRepliesAnswer,
  watched: { commentUrn: string },
): VerifiedReplies {
  const parsed = parsePage(page.text);
  const ours = itemByComment(parsed, watched.commentUrn);
  if (!ours) return { status: "unverified", reason: "comment_not_on_page" };
  if (!answer.our_comment.found || commentId(answer.our_comment.urn) !== commentId(ours.urn)) {
    return { status: "unverified", reason: "comment_mismatch" };
  }
  const own = profileKey(page.ownProfileUrl);
  if (own === null || !ours.authors.has(own)) {
    return { status: "unverified", reason: "not_our_comment" };
  }
  const oursId = commentId(ours.urn);
  const oursAt = commentTime(ours.urn);
  const dropped: Dropped = {};
  const seen = new Set<string>([oursId]);
  const replies: CommentReply[] = [];
  for (const claimed of answer.replies) {
    const row = itemNamed(parsed, claimed.urn) ?? itemByComment(parsed, claimed.urn);
    if (!row || !row.urn.startsWith("urn:li:comment:")) {
      drop(dropped, "not_on_page");
      continue;
    }
    const id = commentId(row.urn);
    if (id === oursId) {
      drop(dropped, "our_own_comment");
      continue;
    }
    if (seen.has(id)) {
      drop(dropped, "duplicate");
      continue;
    }
    // Which comment a row answers is the page's word: its nesting, or the
    // thread beside a comment its own reply count vouches for.
    if (row.kind !== "reply" || row.parent === null || commentId(row.parent) !== oursId) {
      drop(dropped, "not_a_reply_to_ours");
      continue;
    }
    const postedAt = commentTime(row.urn);
    if (oursAt !== null && postedAt !== null && postedAt < oursAt) {
      drop(dropped, "older_than_our_comment");
      continue;
    }
    const author = profileKey(claimed.author_profile);
    if (author === null || !row.authors.has(author)) {
      drop(dropped, "author_not_on_row");
      continue;
    }
    if (!saysWords(row.body, claimed.text)) {
      drop(dropped, "text_not_on_row");
      continue;
    }
    seen.add(id);
    const text = normalizeWords(claimed.text);
    const name = claimed.author_name !== null && saysWords(row.controls, claimed.author_name)
      ? normalizeWords(claimed.author_name)
      : undefined;
    replies.push({
      replyUrn: row.urn,
      author: {
        profileId: profileSlug(author),
        ...(name ? { displayName: name } : {}),
        profileUrl: profileUrl(author),
        isSelf: author === own,
      },
      text,
      textHash: sha256(text),
      ...(postedAt !== null ? { postedAt } : {}),
      observedAt: page.observedAt,
      isDirectChild: true,
    });
  }
  // A count stands where our row's own controls say it — never in its words,
  // or a nested reply's, which can say any number.
  const counted = (count: number | null) =>
    count !== null && showsCount(ours.controls, count) ? count : null;
  return {
    status: "verified",
    resolvedUrn: ours.urn,
    replies,
    reactionCount: counted(answer.our_comment.reaction_count),
    replyCount: counted(answer.our_comment.reply_count),
    dropped,
  };
}

// ---- inbox ----------------------------------------------------------------

export type VerifiedInbox = { threads: InboxThread[]; dropped: Dropped };

/** A "You:" a card puts before the account's own last message. */
const SELF_PREFIX = /^you\s*:\s*/i;

export function verifyInbox(page: AgentPage, answer: InboxAnswer): VerifiedInbox {
  const parsed = parsePage(page.text);
  const own = profileKey(page.ownProfileUrl);
  // The open conversation is the address bar's word, not the page's.
  const open = threadIdOf(page.url);
  const dropped: Dropped = {};
  const seen = new Set<string>();
  const threads: InboxThread[] = [];
  for (const claimed of answer.threads) {
    if (claimed.thread_id === null) {
      drop(dropped, "no_thread_id");
      continue;
    }
    if (!parsed.threads.has(claimed.thread_id) && claimed.thread_id !== open) {
      drop(dropped, "not_on_page");
      continue;
    }
    if (seen.has(claimed.thread_id)) {
      drop(dropped, "duplicate");
      continue;
    }
    const participants = claimed.participants.flatMap((person) => {
      const key = person.profile === null ? null : profileKey(person.profile);
      if (key !== null && key === own) return [];
      if (!saysWords(parsed.words, person.name)) return [];
      const linked = key !== null && parsed.profiles.has(key) ? key : null;
      return [
        {
          profileId: linked === null ? null : profileSlug(linked),
          profileUrl: linked === null ? null : profileUrl(linked),
          displayName: normalizeWords(person.name),
        },
      ];
    });
    if (participants.length === 0) {
      drop(dropped, "participant_not_on_page");
      continue;
    }
    const excerpt = normalizeWords(claimed.last_message_excerpt).replace(SELF_PREFIX, "");
    if (excerpt.length > 0 && !saysWords(parsed.words, excerpt)) {
      drop(dropped, "excerpt_not_on_page");
      continue;
    }
    seen.add(claimed.thread_id);
    threads.push({
      threadId: claimed.thread_id,
      participants,
      group: claimed.group || participants.length > 1,
      lastMessage: { textHash: sha256(excerpt), fromSelf: claimed.last_message_from_self, at: null },
      unread: claimed.unread,
    });
  }
  return { threads, dropped };
}

// ---- dm_thread ------------------------------------------------------------

export type VerifiedDmThread =
  | {
      status: "verified";
      /** Everything a conversation read carries but its composer, which the
       *  agent reader never reads: the caller keeps the one it knows. */
      read: Omit<DmThreadRead, "composer">;
      dropped: Dropped;
    }
  | {
      status: "unverified";
      /** `thread_mismatch`: the page is not the conversation asked for;
       *  `participants_not_on_page`: no one in it but the account could be
       *  told by a profile the page links. */
      reason: "thread_mismatch" | "participants_not_on_page";
    };

export function verifyDmThread(
  page: AgentPage,
  answer: DmThreadAnswer,
  threadId: string,
): VerifiedDmThread {
  if (threadIdOf(page.url) !== threadId) return { status: "unverified", reason: "thread_mismatch" };
  const parsed = parsePage(page.text);
  const own = profileKey(page.ownProfileUrl);
  if (own === null) return { status: "unverified", reason: "participants_not_on_page" };
  const dropped: Dropped = {};
  const others = new Map<string, string>();
  for (const person of answer.participants) {
    const key = profileKey(person.profile);
    if (key === null || key === own) continue;
    if (!parsed.profiles.has(key) || !saysWords(parsed.words, person.name)) {
      drop(dropped, "participant_not_on_page");
      continue;
    }
    if (!others.has(key)) others.set(key, normalizeWords(person.name));
  }
  if (others.size === 0) return { status: "unverified", reason: "participants_not_on_page" };

  const seen = new Set<string>();
  const messages: { order: number; message: DmMessage }[] = [];
  for (const claimed of answer.messages) {
    const item = itemNamed(parsed, claimed.urn);
    if (!item) {
      drop(dropped, "not_on_page");
      continue;
    }
    if (seen.has(item.urn)) {
      drop(dropped, "duplicate");
      continue;
    }
    const author = profileKey(claimed.author_profile);
    if (author === null || (author !== own && !others.has(author)) || !parsed.profiles.has(author)) {
      drop(dropped, "author_not_a_participant");
      continue;
    }
    if (!saysWords(item.words, claimed.text)) {
      drop(dropped, "text_not_on_row");
      continue;
    }
    seen.add(item.urn);
    const text = normalizeWords(claimed.text);
    messages.push({
      order: item.order,
      message: {
        messageId: item.urn,
        fromSelf: author === own,
        authorProfileId: profileSlug(author),
        text,
        textHash: dmWordsHash(text),
        sentAt: null,
        observedAt: page.observedAt,
      },
    });
  }
  return {
    status: "verified",
    read: {
      threadId,
      participants: [
        { profileId: profileSlug(own), profileUrl: profileUrl(own), displayName: "", isSelf: true },
        ...[...others].map(([key, name]) => ({
          profileId: profileSlug(key),
          profileUrl: profileUrl(key),
          displayName: name,
          isSelf: false,
        })),
      ],
      group: answer.group || others.size > 1,
      // Oldest first, as the page holds them.
      messages: messages.sort((a, b) => a.order - b.order).map((entry) => entry.message),
      // Nothing was scrolled: older history may wait unloaded.
      complete: false,
      observedAt: page.observedAt,
      sessionId: page.sessionId,
      pageFingerprint: page.pageFingerprint,
      selectorPack: page.selectorPack,
      reader: "agent",
    },
    dropped,
  };
}
