import type { incomingComments, roomMembers } from "@engager/database/schema";
import type { Send, SendState } from "./sendState";
import type { Standing } from "./standing";
import type { Wait, WaitAbout } from "./waits";

/**
 * ONE STATUS PER ITEM — what is happening in one place the owner talks with
 * someone (their post, their comment, a reply under ours, an invite, their
 * messages), in the words every row, item and thread header shows, under
 * the family that sets its mark: Needs a check, Your turn, In progress,
 * Waiting on them, Done. A row shows its person's most urgent item, and the
 * header reads the same item, so the two never disagree.
 *
 * The first status that holds, in the order {@link CASES} ranks them, is the
 * item's. Each kind of fact reaches its status through a switch with no
 * default, so a new wait, send, hold, standing or reply status fails the
 * typecheck until it has one. A status names the event it is about — their
 * reply, our draft, our yes — and, where its label names a moment, that
 * moment, for the UI to print in the owner's zone (`components/LocalTime`):
 * it never prints a time, and its words are Engager's alone, never a name,
 * a headline or anything LinkedIn holds.
 *
 * Pure, and free of the database, so the client bundle can take it, as
 * `sendState.ts` is: the Inbox's reads gather the facts it is given.
 */

/** How urgent an item is, which sets its mark: Needs a check, Your turn,
 *  In progress, Waiting on them, Done. */
export type StatusFamily = "problem" | "turn" | "progress" | "wait" | "done";

/** The families, most urgent first. */
export const FAMILY_RANK: Record<StatusFamily, number> = { problem: 0, turn: 1, progress: 2, wait: 3, done: 4 };

/** An item that needs the owner's words, yes or check. */
export function isYourTurn(family: StatusFamily): family is "problem" | "turn" {
  return family === "problem" || family === "turn";
}

/** What happened at the moment a status is dated by, as a row says it:
 *  "replied 3h ago", "queued 1d ago". */
export type EventVerb =
  | "posted"
  | "commented"
  | "spotted"
  | "replied"
  | "invited you"
  | "messaged"
  | "accepted"
  | "drafted"
  | "queued"
  | "sent";

export type ItemStatus = {
  family: StatusFamily;
  label: string;
  /** The moment the label names — the slot "Goes out" goes out at, or the
   *  opening of the account's hours — null where it names none. */
  labelAt: number | null;
  /** The moment the status is about: "They replied" is dated by their
   *  reply, "Invite waits for your yes" by the draft. Null where the item
   *  holds no moment at all: one is never made up. */
  event: { verb: EventVerb; at: number } | null;
};

type ItemEvent = NonNullable<ItemStatus["event"]>;

/** The status of someone's comment or reply, as `incoming_comments` keeps
 *  it. */
type ReplyStatus = (typeof incomingComments.$inferSelect)["status"];

/** How a room comment's writer fits the campaign's audience. */
type RoomFit = (typeof roomMembers.$inferSelect)["fit"];

/** Their newest words on an item, and when. */
export type TheirWords =
  /** Their post, or a message of theirs. */
  | { kind: "post" | "dm"; at: number }
  /** Their comment on the owner's own post, or their reply under ours, as
   *  `incoming_comments` keeps it; `reading` while Engager still reads it —
   *  its intake job, or the step its conversation event woke, queued or running
   *  (`waits.ts`). A `dismissed` one nobody will answer: the owner's Don't
   *  reply, or the agent's judgment that it needs none. */
  | { kind: "comment" | "reply"; at: number; status: ReplyStatus; reading: boolean };

/** A send of ours on its way out on the item, and when it was put on its
 *  way: the owner's yes, or the gate's reservation of an Automatic one. */
export type ItemSend = Send & { queuedAt: number };

/** The invite on an item, and where it stands. */
export type ItemInvite =
  /** Their invitation to the account, received `at` — its `received_at`,
   *  else when Engager first saw it. */
  | { from: "them"; at: number; goneAt: number | null }
  /** An invite of ours that went out (`invitation_confirmed`), and the first
   *  answer since: their acceptance, our withdrawal, or LinkedIn no longer
   *  listing it. */
  | { from: "us"; sentAt: number; answer: { kind: "accepted" | "withdrawn" | "gone"; at: number } | null };

/** An item nothing of ours has touched. */
export type Untouched =
  /** A comment of theirs Scout read in a room. It keeps no time of its own,
   *  so it is dated by the room's read. */
  | { kind: "room_comment"; fit: RoomFit; skipped: boolean; readAt: number }
  /** Words of theirs Find leads stored (`lead_signals`), a post or a comment
   *  of theirs, `at` they wrote them, else when Scout saw them. */
  | { kind: "signal"; at: number };

/** What one item holds. */
export type ItemFacts = {
  /** What waits on the owner there (`waits.ts`). */
  waits: readonly Wait[];
  sends: readonly ItemSend[];
  theirs: TheirWords | null;
  /** When our newest words there went out: a comment or reply posted, an
   *  invite or message confirmed. */
  oursAt: number | null;
  invite: ItemInvite | null;
  untouched: Untouched | null;
  /** While the watch on our comment there is active, when it ends
   *  (`PersonThread.watchUntil`). */
  watchUntil: number | null;
  /** When they liked our words there (`engagement_events` `like_received`). */
  likedAt: number | null;
  /** Where things stand with the person (`standing.ts`). */
  standing: Standing | null;
  /** When Scout read the item, for one it read and the owner never joined
   *  (`untouched`): a matched post when it found it, a room comment when the
   *  room was read, a stored signal when it was seen. */
  scoutReadAt: number | null;
  /** When our first words to this person went out, on any of their items:
   *  with `scoutReadAt`, whether Scout found an item before the owner met
   *  them. */
  firstSendAt: number | null;
  /** The instant the watch is read against. */
  now: number;
};

/**
 * Every status an item can have, ranked in the order they are read: the
 * first that holds is the item's. Statuses that share a rank are one status
 * told two or three ways. Closed comes first: someone who asked not to be
 * contacted, or that the owner excluded, is never anyone's turn, whatever
 * still waits on their items. After it the families fall in `FAMILY_RANK`'s
 * order, but for Came back: a reply that came back while its Reply step was
 * Off is Done, yet it reads before anything waits on their answer — they
 * gave it — and after any yes the item still owes and any send of ours on
 * its way. It reads only while theirs is the newest word there: once a send
 * of ours has gone out after it (an invite, say), that send answered the
 * turn and the item reads by it.
 */
const CASES = {
  closed: { rank: 1, family: "done", label: "Closed" },
  failed: { rank: 2, family: "problem", label: "Not posted" },
  unclear: { rank: 3, family: "problem", label: "Outcome unclear" },
  like_unclear: { rank: 3, family: "problem", label: "Like unclear" },
  invited_you: { rank: 4, family: "turn", label: "They invited you" },
  messaged_you: { rank: 5, family: "turn", label: "They messaged you" },
  invite_to_approve: { rank: 6, family: "turn", label: "Invite waits for your yes" },
  message_to_approve: { rank: 7, family: "turn", label: "Message waits for your yes" },
  like_to_approve: { rank: 8, family: "turn", label: "Like waits for your yes" },
  replied: { rank: 9, family: "turn", label: "They replied" },
  draft: { rank: 10, family: "turn", label: "Your turn" },
  matched: { rank: 11, family: "turn", label: "Your turn" },
  spotted: { rank: 12, family: "turn", label: "Your turn" },
  reading: { rank: 13, family: "progress", label: "Reading their reply" },
  goes_out: { rank: 14, family: "progress", label: "Goes out" },
  queued: { rank: 15, family: "progress", label: "Queued" },
  active_hours: { rank: 16, family: "progress", label: "Goes out" },
  campaign_paused: { rank: 17, family: "progress", label: "Goes out after you resume" },
  writes_off: { rank: 18, family: "progress", label: "Held · sending is off" },
  held: { rank: 19, family: "progress", label: "Held" },
  review_hold: { rank: 19, family: "progress", label: "Held · waits for your review" },
  relationship_check: { rank: 19, family: "progress", label: "Held · checking whether you're connected" },
  sending: { rank: 20, family: "progress", label: "Sending" },
  checking: { rank: 21, family: "progress", label: "Checking" },
  came_back: { rank: 22, family: "done", label: "Came back" },
  invite_pending: { rank: 23, family: "wait", label: "Invite pending" },
  waiting: { rank: 24, family: "wait", label: "Waiting for their answer" },
  yours: { rank: 25, family: "wait", label: "Yours" },
  not_replying: { rank: 26, family: "done", label: "Not replying" },
  moved: { rank: 27, family: "done", label: "Moved to Messages" },
  liked: { rank: 28, family: "done", label: "Done · they liked it" },
  incoming_invite_gone: { rank: 29, family: "done", label: "Invitation no longer listed" },
  invite_gone: { rank: 29, family: "done", label: "Invite no longer pending" },
  booked: { rank: 30, family: "done", label: "Booked" },
  activated: { rank: 30, family: "done", label: "Activated" },
  paid: { rank: 30, family: "done", label: "Paid" },
  done: { rank: 31, family: "done", label: "Done" },
} as const satisfies Record<string, { rank: number; family: StatusFamily; label: string }>;

type Case = keyof typeof CASES;

/** A status that holds on the item, before the first is chosen. */
type Holding = { is: Case; event: ItemEvent | null; labelAt?: number | null };

/** What an unclear wait is about where it is a like, as against a send. */
const LIKES: ReadonlySet<WaitAbout> = new Set<WaitAbout>(["like_target"]);

const THEIR_VERB: Record<TheirWords["kind"], EventVerb> = {
  post: "posted",
  comment: "commented",
  reply: "replied",
  dm: "messaged",
};

/**
 * The item's status: the first that holds of everything it holds, the
 * newest event first where two facts hold the same. The person's standing is
 * read after the item's own facts, so where both hold one status the item's
 * fact names its event.
 */
export function itemStatus(facts: ItemFacts): ItemStatus {
  const fromItem = [
    ...facts.waits.map((wait) => ofWait(wait, facts)),
    ...facts.sends.map(ofSend),
    facts.theirs && ofTheirs(facts.theirs, facts),
    facts.invite && ofInvite(facts.invite),
    facts.untouched && ofUntouched(facts.untouched),
    ofOurWords(facts),
  ].reduce<Holding | null>(
    (best, entry) => (entry && (best === null || readsBefore(entry, best)) ? entry : best),
    null,
  );
  const standing = facts.standing && ofStanding(facts.standing, facts);
  const first =
    standing && (fromItem === null || CASES[standing.is].rank < CASES[fromItem.is].rank) ? standing : fromItem;
  const { is, event, labelAt = null }: Holding = first ?? { is: "done", event: newest(facts) };
  return { family: CASES[is].family, label: CASES[is].label, labelAt, event };
}

/** A send of ours on its way out, as `sendInFlight` words it: `rank` is its
 *  status's, and `queuedAt` when it was put on its way — null for a send only
 *  the person's standing speaks for (`checking`, `held`). */
export type SendInFlight = { label: string; labelAt: number | null; queuedAt: number | null; rank: number };

/**
 * The send of ours on its way out on an item, worded as its status words it —
 * "Goes out" with its slot, "Queued", "Held · …", "Sending", "Checking" —
 * whatever else the item holds: a reply of theirs or a draft of ours reads
 * before a send in `itemStatus`, and a row still says the send is on its way.
 * The first of the item's sends to read, as `itemStatus` ranks them; null
 * with none on its way.
 */
export function sendInFlight(facts: ItemFacts): SendInFlight | null {
  const standing = facts.standing && ofStanding(facts.standing, facts);
  const first = [
    ...facts.sends.map((send) => ({ holding: ofSend(send), queuedAt: send.queuedAt })),
    ...(standing ? [{ holding: standing, queuedAt: null }] : []),
  ]
    // A reply still being read is no send of ours.
    .filter(({ holding }) => CASES[holding.is].family === "progress" && holding.is !== "reading")
    .reduce<{ holding: Holding; queuedAt: number | null } | null>(
      (best, entry) => (best === null || readsBefore(entry.holding, best.holding) ? entry : best),
      null,
    );
  return (
    first && {
      label: CASES[first.holding.is].label,
      labelAt: first.holding.labelAt ?? null,
      queuedAt: first.queuedAt,
      rank: CASES[first.holding.is].rank,
    }
  );
}

function readsBefore(a: Holding, b: Holding): boolean {
  const [first, second] = [CASES[a.is].rank, CASES[b.is].rank];
  return first < second || (first === second && momentOf(a.event) > momentOf(b.event));
}

/** When an event happened; an item with none reads as older than any. */
function momentOf(event: ItemEvent | null): number {
  return event?.at ?? Number.NEGATIVE_INFINITY;
}

/** What a wait holds. A DM draft beside a newer message of theirs, or the
 *  conversation held for the owner, is told by their message where nothing
 *  of ours is on its way (`ofTheirs`). */
function ofWait(wait: Wait, facts: ItemFacts): Holding {
  const drafted = { verb: "drafted", at: wait.at } as const;
  switch (wait.kind) {
    case "failed":
      return { is: "failed", event: { verb: "queued", at: wait.at } };
    case "unclear":
      return { is: LIKES.has(wait.about) ? "like_unclear" : "unclear", event: { verb: "queued", at: wait.at } };
    case "accept_invite":
      return {
        is: "invited_you",
        event: { verb: "invited you", at: facts.invite?.from === "them" ? facts.invite.at : wait.at },
      };
    case "invite_to_approve":
      return { is: "invite_to_approve", event: drafted };
    case "dm_draft":
      // Beside a newer message of theirs too: a yes the owner owes never reads as a send of ours on its way.
      return { is: "message_to_approve", event: drafted };
    case "like_to_approve":
      return { is: "like_to_approve", event: drafted };
    case "reply_draft":
    case "held_reply":
    case "own_reply":
      // Dated by their reply: a held or own reply waits from it, a draft
      // from when it was drafted.
      return {
        is: "replied",
        event: {
          verb: "replied",
          at:
            wait.source !== "reply" && (facts.theirs?.kind === "comment" || facts.theirs?.kind === "reply")
              ? facts.theirs.at
              : wait.at,
        },
      };
    case "comment_draft":
    case "room_reply_draft":
      return { is: "draft", event: drafted };
    case "owner_held_dm":
      return { is: "yours", event: newest(facts) };
  }
}

/** Where a send of ours stands on its way out, dated by its yes. */
function ofSend(send: ItemSend): Holding {
  const event = { verb: "queued", at: send.queuedAt } as const;
  switch (send.state.phase) {
    case "queued":
      return send.state.at === null ? { is: "queued", event } : { is: "goes_out", event, labelAt: send.state.at };
    case "held":
      return {
        is: ofHold(send.state.because),
        event,
        labelAt: send.state.because === "active_hours" ? send.state.at : null,
      };
    case "sending":
      return { is: "sending", event };
    case "checking":
      return { is: "checking", event };
  }
}

function ofHold(because: SendState["because"]): Case {
  switch (because) {
    case "active_hours":
      return "active_hours";
    case "campaign_paused":
      return "campaign_paused";
    case "writes_off":
      return "writes_off";
    case "conversation_review":
      return "review_hold";
    case "relationship_check":
      return "relationship_check";
    case null:
      return "held";
  }
}

/** What their newest words hold of their own: a message later than ours
 *  that nothing of ours is on its way to answer, a reply Engager is still
 *  reading, one the owner chose not to answer, or one that came back while
 *  Reply was Off and that nothing of ours has gone out after. */
function ofTheirs(theirs: TheirWords, facts: ItemFacts): Holding | null {
  switch (theirs.kind) {
    case "post":
      return null;
    case "dm":
      return theirs.at > (facts.oursAt ?? -Infinity) && facts.sends.length === 0
        ? { is: "messaged_you", event: { verb: "messaged", at: theirs.at } }
        : null;
    case "comment":
    case "reply":
      if (theirs.reading) return { is: "reading", event: { verb: "replied", at: theirs.at } };
      return ofReplyStatus(theirs.status, theirs.at, facts.oursAt);
  }
}

/** A reply's own status, where it says more than what waits on it, our
 *  reply to it, or the watch on ours. `oursAt` is our newest send on the
 *  item: one after the reply has answered it, so it no longer came back. */
function ofReplyStatus(status: ReplyStatus, at: number, oursAt: number | null): Holding | null {
  switch (status) {
    case "dismissed":
      return { is: "not_replying", event: { verb: "replied", at } };
    // A policy let it go — Reply Off, own-post replies off, its campaign
    // gone — and nothing answers it unless the owner does: it waits on no one.
    case "ignored":
      return at > (oursAt ?? -Infinity) ? { is: "came_back", event: { verb: "replied", at } } : null;
    // It waits on the owner — held, or theirs to answer — or Engager still
    // reads it.
    case "new":
    // Our draft to it waits, is on its way, or was turned down.
    case "reply_proposed":
    // Our reply to it went out.
    case "replied":
      return null;
  }
}

function ofInvite(invite: ItemInvite): Holding | null {
  // Their invitation, pending, waits as `accept_invite`.
  if (invite.from === "them") {
    return invite.goneAt === null ? null : { is: "incoming_invite_gone", event: { verb: "invited you", at: invite.at } };
  }
  const sent = { verb: "sent", at: invite.sentAt } as const;
  switch (invite.answer?.kind) {
    case undefined:
      return { is: "invite_pending", event: sent };
    case "accepted":
      return { is: "moved", event: { verb: "accepted", at: invite.answer.at } };
    case "gone":
      return { is: "invite_gone", event: sent };
    case "withdrawn":
      return null;
  }
}

function ofUntouched(untouched: Untouched): Holding | null {
  switch (untouched.kind) {
    case "room_comment":
      return (untouched.fit === "fits" || untouched.fit === "maybe") && !untouched.skipped
        ? { is: "spotted", event: { verb: "spotted", at: untouched.readAt } }
        : null;
    case "signal":
      return { is: "spotted", event: { verb: "spotted", at: untouched.at } };
  }
}

/** Our words posted: watched for their answer, else liked by them. */
function ofOurWords(facts: ItemFacts): Holding | null {
  if (facts.oursAt === null) return null;
  const sent = { verb: "sent", at: facts.oursAt } as const;
  if (facts.watchUntil !== null && facts.watchUntil > facts.now) return { is: "waiting", event: sent };
  return facts.likedAt === null ? null : { is: "liked", event: sent };
}

/** What the person's standing holds, dated by the item's newest moment where
 *  it names none of its own. Where the item holds the send a standing speaks
 *  for (`checking`, `held`), the send holds the same status, dated by its
 *  yes; where it does not, the send reads as queued at that newest moment,
 *  for the standing keeps no time of its own. */
function ofStanding(standing: Standing, facts: ItemFacts): Holding {
  switch (standing.kind) {
    case "spotted":
      return { is: "spotted", event: { verb: "spotted", at: standing.spottedAt } };
    case "closed":
      return { is: "closed", event: newest(facts) };
    case "outcome":
      return { is: standing.outcome, event: newest(facts) };
    case "yours":
      return { is: "yours", event: newest(facts) };
    case "checking":
    case "held": {
      const latest = newest(facts);
      return { is: standing.kind, event: latest && { verb: "queued", at: latest.at } };
    }
    case "invite_sent":
      return { is: "invite_pending", event: { verb: "sent", at: standing.at } };
    case "waiting":
      return { is: "waiting", event: facts.oursAt === null ? newest(facts) : { verb: "sent", at: facts.oursAt } };
    case "quiet":
      return { is: "done", event: newest(facts) };
  }
}

/** The newest thing that happened on the item, for a status that names no
 *  event of its own; null where it holds none. */
function newest(facts: ItemFacts): ItemEvent | null {
  const moments: ItemEvent[] = [];
  if (facts.theirs) moments.push({ verb: THEIR_VERB[facts.theirs.kind], at: facts.theirs.at });
  if (facts.oursAt !== null) moments.push({ verb: "sent", at: facts.oursAt });
  if (facts.invite?.from === "them") moments.push({ verb: "invited you", at: facts.invite.at });
  if (facts.invite?.from === "us") {
    moments.push({ verb: "sent", at: facts.invite.sentAt });
    // Their yes, and our withdrawal, are moments of their own; LinkedIn no
    // longer listing the invite is none.
    if (facts.invite.answer?.kind === "accepted") moments.push({ verb: "accepted", at: facts.invite.answer.at });
    if (facts.invite.answer?.kind === "withdrawn") moments.push({ verb: "sent", at: facts.invite.answer.at });
  }
  if (facts.untouched?.kind === "room_comment") moments.push({ verb: "spotted", at: facts.untouched.readAt });
  if (facts.untouched?.kind === "signal") moments.push({ verb: "spotted", at: facts.untouched.at });
  return moments.reduce<ItemEvent | null>(
    (latest, moment) => (latest === null || moment.at > latest.at ? moment : latest),
    null,
  );
}

/**
 * Whether Scout read an item the owner never joined, and when against the
 * owner's first words to the person: `before` if Scout read it before the
 * first send of ours to them (or nothing of ours has gone out at all),
 * `after` if after it; null for an item anything of ours was sent on, one
 * Scout did not read, or a room comment the owner let go of.
 */
export function notJoined(
  facts: Pick<ItemFacts, "untouched" | "oursAt" | "scoutReadAt" | "firstSendAt">,
): "before" | "after" | null {
  const { untouched, scoutReadAt, firstSendAt } = facts;
  if (untouched === null || facts.oursAt !== null || scoutReadAt === null) return null;
  if (untouched.kind === "room_comment" && untouched.skipped) return null;
  return firstSendAt === null || scoutReadAt <= firstSendAt ? "before" : "after";
}

/**
 * The item a row shows, of `items`: the most urgent family, then the newest
 * event — an item with none after every one that has one — then the key.
 * Null for no items.
 */
export function mostUrgent<T extends { key: string; status: ItemStatus }>(items: readonly T[]): T | null {
  return items.reduce<T | null>((top, item) => (top === null || byUrgency(item, top) < 0 ? item : top), null);
}

function byUrgency(a: { key: string; status: ItemStatus }, b: { key: string; status: ItemStatus }): number {
  const [aAt, bAt] = [momentOf(a.status.event), momentOf(b.status.event)];
  return (
    FAMILY_RANK[a.status.family] - FAMILY_RANK[b.status.family] ||
    Number(bAt > aAt) - Number(aAt > bAt) ||
    a.key.localeCompare(b.key)
  );
}
