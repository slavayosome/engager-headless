import { and, desc, eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  incomingInvitations,
  conversationEvents,
  conversations,
  type IncomingInvitationRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { recordIncomingInvitation } from "../conversations/record";
import { reserveAcceptance, skipQueuedAcceptances, type AcceptanceReservation } from "./accept";
import { updateInvitation } from "./observe";

/**
 * The owner's own decisions on an incoming request, from the Inbox, on the
 * person who sent it. Neither touches LinkedIn.
 *
 * LINK — "this is the person who replied to …": the owner names the reply
 * whose author sent the invitation, and that word is the attribution
 * (`user_confirmed_link`, spec §15). It is the only way an invitation the
 * identity check could not verify reaches a conversation: the conversation of that
 * reply records it, takes `incoming_pending`, and Accept invite is reserved
 * for the owner's yes where the campaign binds it. A name or a time never
 * makes the link; the owner does, and only on a request still pending and not
 * already tied to one.
 *
 * DISMISS — hide the request here, and skip any acceptance waiting on it.
 * The invitation itself stays on LinkedIn, where the owner ignores or accepts
 * it themselves.
 */

export type InvitationRefusal =
  | "invitation_not_found"
  | "invitation_not_pending"
  | "invitation_already_linked"
  | "conversation_not_found"
  | "exchange_not_found";

export class InvitationError extends AppError {
  constructor(
    code: InvitationRefusal,
    message: string,
    readonly recovery: string,
  ) {
    super(
      code,
      message,
      code === "invitation_not_found" || code === "conversation_not_found" ? 404 : 409,
    );
  }
}

export async function lockInvitation(tx: Tx, id: number): Promise<IncomingInvitationRow> {
  const [row] = await tx
    .select()
    .from(incomingInvitations)
    .where(eq(incomingInvitations.id, id))
    .for("update");
  if (!row) {
    throw new InvitationError(
      "invitation_not_found",
      `Incoming request ${id} not found on this account.`,
      "Reload the Inbox.",
    );
  }
  return row;
}

export async function linkInvitation(
  tx: Tx,
  input: { id: number; conversationId: number; by: string; now?: number },
): Promise<{ invitation: IncomingInvitationRow; reservation: AcceptanceReservation }> {
  const now = input.now ?? Date.now();
  const invitation = await lockInvitation(tx, input.id);
  if (invitation.status !== "pending") {
    throw new InvitationError(
      "invitation_not_pending",
      `This request is ${invitation.status}; only a pending one can be linked.`,
      "Nothing to link.",
    );
  }
  if (invitation.attribution !== "unmatched") {
    throw new InvitationError(
      "invitation_already_linked",
      "This request is already tied to a conversation.",
      "Accept it, or leave it.",
    );
  }
  const [conversation] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.channelId, invitation.channelId)));
  if (!conversation) {
    throw new InvitationError(
      "conversation_not_found",
      "That conversation is not on this account.",
      "Pick a reply from the list under the request.",
    );
  }
  // The exchange the owner names: the person's latest reply under one of our
  // comments, as the conversation recorded it.
  const [exchange] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.type, "reply_observed")))
    .orderBy(desc(conversationEvents.id))
    .limit(1);
  if (!exchange) {
    throw new InvitationError(
      "exchange_not_found",
      "That conversation has no reply to link a request to.",
      "Pick a reply from the list under the request.",
    );
  }
  const recorded = await recordIncomingInvitation(tx, {
    conversationId: conversation.id,
    invitation: {
      invitationId: invitation.invitationId,
      senderProfileId: invitation.senderProfileId,
      senderUrl: invitation.senderUrl,
      observedAt: invitation.observedAt,
      link: { method: "user_confirmed_link", replyEventId: exchange.id, confirmedBy: input.by, confirmedAt: now },
    },
    now,
  });
  const linked = await updateInvitation(tx, invitation.id, {
    attribution: "user_confirmed_link",
    attributionEvidence: {
      method: "user_confirmed_link",
      profileId: invitation.senderProfileId,
      conversationId: conversation.id,
      replyEventId: exchange.id,
      confirmedBy: input.by,
      confirmedAt: now,
    },
    conversationId: conversation.id,
    conversationEventId: recorded!.event.id,
    updatedAt: now,
  });
  return { invitation: linked, reservation: await reserveAcceptance(tx, linked, now) };
}

/** Hide a pending request here, and skip the acceptance waiting on it. */
export async function dismissInvitation(
  tx: Tx,
  input: { id: number; by: string; now?: number },
): Promise<IncomingInvitationRow> {
  const now = input.now ?? Date.now();
  const invitation = await lockInvitation(tx, input.id);
  if (invitation.status !== "pending") {
    throw new InvitationError(
      "invitation_not_pending",
      `This request is ${invitation.status} already.`,
      "Nothing to dismiss.",
    );
  }
  await skipQueuedAcceptances(tx, invitation, { by: input.by, reason: "dismissed", now });
  return updateInvitation(tx, invitation.id, { status: "dismissed", statusAt: now, updatedAt: now });
}
