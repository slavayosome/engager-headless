import { createHash } from "node:crypto";
import type {
  ActionKind,
  ActionPurpose,
  ActionTarget,
} from "@engager/database/schema";

/**
 * WHAT ONE ACTION IS — its semantic identity, said once (spec §07, §15
 * "idempotency beyond transport retries"; INV-27). Pure.
 *
 * A browser click has no provider idempotency key, so the ledger mints its
 * own from the action's meaning, and the database's unique constraint is what
 * holds it: two wakes that propose the same action reserve one row.
 *
 *   reaction   account + post or comment + canonical target id + reaction — a
 *              post and a comment never collide, and a second like of one
 *              comment is the first, whichever target kind aimed it
 *   the rest   account + person + conversation + purpose + sequence, and a reply
 *              also the inbound event it answers — the second opener to one
 *              person in one conversation is the first, WHATEVER kind carries it
 *
 * The kind is deliberately not in the second shape (spec §15): what the key
 * guards is the person being opened to, pitched or followed up twice, and an
 * invitation's note that opened the conversation is the opener a DM would
 * otherwise repeat. An opener is always the first — sequence 1 — so a DM may
 * open only a conversation nothing else opened (the one contextual opener
 * after their comment-linked invitation was accepted): after an invitation's
 * note it is that note's duplicate, whatever kind carries it. Every other DM
 * continues a conversation (`reply`) or makes the offer (`cta`).
 * The note itself is not that opener's duplicate when it has to be sent as a
 * message: a DM of purpose `invite_note` carries the words of an accepted
 * invitation's note into the conversation they did not reach by themselves
 * (`actions/inviteNote.ts`). It is keyed apart from the invitation's `opener`
 * and is sequence 1 too — one per conversation, ever.
 * Person-purpose guards across conversations and campaigns (one invitation per
 * person, ever) are the eligibility table's (`conversations/eligibility.ts`), not
 * this key's.
 *
 * Edits change a row's revision and content hash, never its key.
 */

/** The purposes each kind may serve. A like is always a reaction and an
 *  acceptance always an acceptance; an invitation's note opens, a DM opens
 *  where nothing did, carries an invitation's note, continues or offers, a
 *  follow-up follows up, and a withdrawal only withdraws. */
export const KIND_PURPOSES = {
  like_target: ["reaction"],
  accept_invite: ["acceptance"],
  invite: ["opener"],
  dm: ["opener", "reply", "cta", "invite_note"],
  followup: ["followup"],
  withdraw_invite: ["withdrawal"],
  room_reply: ["reply"],
  reply: ["reply"],
  // A comment on a post is the first words to its author.
  comment: ["opener"],
} as const satisfies Record<ActionKind, readonly ActionPurpose[]>;

export function purposeAdmitted(kind: ActionKind, purpose: ActionPurpose): boolean {
  return (KIND_PURPOSES[kind] as readonly ActionPurpose[]).includes(purpose);
}

/** The reactions a like can carry. LinkedIn has others; the ledger knows the
 *  one the product sends. */
export type Reaction = "like";

export type ReactionKeyInput = {
  channelId: number;
  target: Pick<ActionTarget, "kind" | "id">;
  reaction: Reaction;
};

export type PersonKeyInput = {
  channelId: number;
  personId: string;
  conversationId: number;
  purpose: ActionPurpose;
  sequence: number;
  /** The inbound event a `reply` answers — required for that purpose and
   *  refused for every other. */
  inboundEventId?: number | null;
};

/** What a reaction is on: a post, or a comment — however the action aimed at
 *  it (their reply, the comment it answers, a room comment), one comment is
 *  one identity, so it is liked once. */
export function reactionOn(target: Pick<ActionTarget, "kind">): "post" | "comment" {
  return target.kind === "post" ? "post" : "comment";
}

export function reactionKey(input: ReactionKeyInput): string {
  return ["react", input.channelId, reactionOn(input.target), input.target.id, input.reaction].join(":");
}

/** The kinds whose words live on a `messages` row, the record every surface of
 *  them reads, and whose action only sends (`actions/messageSend.ts`). */
export const MESSAGE_SENDS = ["room_reply", "reply", "comment"] as const satisfies readonly ActionKind[];
export type MessageSendKind = (typeof MESSAGE_SENDS)[number];

export const isMessageSend = (kind: ActionKind): kind is MessageSendKind =>
  (MESSAGE_SENDS as readonly string[]).includes(kind);

/** One room reply per parent comment on an account: the comment's own dedupe
 *  key (`rooms/replySource.ts` `roomReplyKey`), under the channel. */
export function roomReplyActionKey(channelId: number, dedupeKey: string): string {
  return ["room", channelId, dedupeKey].join(":");
}

/** One public reply per comment it answers on an account: the message's own
 *  dedupe key, under the channel. */
export function replyActionKey(channelId: number, dedupeKey: string): string {
  return ["reply", channelId, dedupeKey].join(":");
}

/** One comment per post on an account: the message's own dedupe key (the
 *  campaign and the post), under the channel. */
export function commentActionKey(channelId: number, dedupeKey: string): string {
  return ["comment", channelId, dedupeKey].join(":");
}

export function personKey(input: PersonKeyInput): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error(`action sequence must be a positive integer, got ${input.sequence}`);
  }
  if ((input.purpose === "opener" || input.purpose === "invite_note") && input.sequence !== 1) {
    throw new Error(`an ${input.purpose} is the first of its conversation, never sequence ${input.sequence}`);
  }
  const answers = input.inboundEventId ?? null;
  if ((input.purpose === "reply") !== (answers !== null)) {
    throw new Error(
      input.purpose === "reply"
        ? "a reply's key binds the inbound event it answers"
        : `a ${input.purpose} answers no inbound event`,
    );
  }
  return [
    "person",
    input.channelId,
    input.personId,
    input.conversationId,
    input.purpose,
    input.sequence,
    ...(answers === null ? [] : [answers]),
  ].join(":");
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** What an approval binds of the words: the kind beside them, so an
 *  acceptance's empty text and a like's are two different contents. */
export function contentHash(kind: ActionKind, text: string | null): string {
  return sha256(JSON.stringify([kind, text]));
}

/** What an approval binds of the action target, in a canonical order. */
export function targetHash(target: ActionTarget): string {
  return sha256(JSON.stringify([target.kind, target.id, target.urn]));
}
