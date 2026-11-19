/**
 * Client-safe words for a send as Activity's tables list it — what it is and
 * whose yes, if anyone's, it went out on — and the filter Sent offers. Type-only
 * imports: a value import of the schema drags it into the browser bundle.
 */

import type { ActionKind } from "@engager/database/schema";

/**
 * Whose a send is, under its action: the owner's own words; a draft or a
 * note the owner said yes to; a yes to an action with no words; nobody's yes
 * at all; or a like that rode a comment or a reply out.
 */
export type SendLabel =
  | "Your words"
  | "Approved draft"
  | "Approved note"
  | "Approved"
  | "Automatic"
  | "With the comment"
  | "With the reply";

/** A comment or a reply: the owner's own words, else a draft the owner said
 *  yes to — moved from waiting to approved, or their agent's words queued
 *  untouched from their own box — else one that went out with no yes. Owner
 *  means authorship (`messages.publishOrigin`), never approval. */
export function messageSendLabel(message: { publishOrigin: string; approved: boolean }): SendLabel {
  if (message.publishOrigin === "owner") return "Your words";
  return message.approved ? "Approved draft" : "Automatic";
}

/** A like, invite, acceptance, DM or follow-up on the action ledger: words the
 *  owner wrote, else what their yes was to — the invitation's note, the
 *  message's draft, or the action itself where it carries no words — else
 *  nobody's yes. */
export function ledgerSendLabel(action: {
  kind: ActionKind;
  origin: "owner" | "worker";
  approved: boolean;
  hasText: boolean;
}): SendLabel {
  if (action.origin === "owner") return "Your words";
  if (!action.approved) return "Automatic";
  if (!action.hasText) return "Approved";
  return action.kind === "invite" ? "Approved note" : "Approved draft";
}

/** A like that went out with a send: under the comment's post, or on the
 *  comment a reply answered. */
export function companionLikeLabel(sendKind: "comment" | "reply" | "room_reply"): SendLabel {
  return sendKind === "comment" ? "With the comment" : "With the reply";
}
