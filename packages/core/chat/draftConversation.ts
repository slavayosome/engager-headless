import type { Tx } from "@engager/database/tenant";
import { openComposerBox, type ComposerBox } from "../composer/drafts";
import { askedBox } from "../composer/requests";
import { findPerson } from "../people/directory";
import { personKey } from "../people/key";
import type { DraftRequest } from "./requestedDraft";

/**
 * A DRAFT'S CONVERSATION, NAMED FOR WHAT IT IS — "Comment for Ana Sousa",
 * "Reply to Maya Lindqvist", "Message to Ravi Menon" — and bound to the box
 * the owner asked for words in, so every version the conversation writes
 * lands there (`chat/broker.ts`). Read when the conversation opens, before any
 * agent call; null for an ask whose words land in no box of the owner's.
 */
export type DraftConversation = { boxKey: string; title: string; personName: string | null };

/** What the words in each kind of box are, as History names the conversation. */
const NAMED: Record<ComposerBox["kind"], { noun: string; untitled: string }> = {
  comment: { noun: "Comment for", untitled: "Comment draft" },
  lead: { noun: "Comment for", untitled: "Opener draft" },
  reply: { noun: "Reply to", untitled: "Reply draft" },
  room: { noun: "Reply to", untitled: "Reply draft" },
  dm: { noun: "Message to", untitled: "Message draft" },
  invite: { noun: "Invite note for", untitled: "Invite note draft" },
};

export async function draftConversation(tx: Tx, request: DraftRequest): Promise<DraftConversation | null> {
  const named = await askedBox(tx, request);
  return named === null ? null : boxConversation(tx, named);
}

/** The conversation for the words a box already holds, named the same way: a
 *  draft a worker wrote has none until the owner goes on with it in chat. */
export async function boxConversation(tx: Tx, box: string): Promise<DraftConversation | null> {
  // A box that takes no more words still names its conversation: the turn
  // itself is what refuses, and says why.
  const open = await openComposerBox(tx, box).catch(() => null);
  if (open === null) return null;
  const key =
    open.box.kind === "invite"
      ? open.box.personKey
      : personKey({ profileId: open.profileId, incomingCommentId: open.box.kind === "reply" ? open.box.incomingCommentId : null });
  const personName = (key === null ? null : (await findPerson(tx, key))?.name?.trim()) || null;
  const { noun, untitled } = NAMED[open.box.kind];
  return { boxKey: open.key, title: personName ? `${noun} ${personName}` : untitled, personName };
}
