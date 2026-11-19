import { and, eq, sql } from "drizzle-orm";
import { actions, conversations, type ActionRow } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { approveAction } from "../actions/approval";
import { ActionLedgerError } from "../actions/errors";
import { reserveAction } from "../actions/ledger";
import { notPermitted, ownerCampaignFor, ownerRefusal } from "../actions/ownerPress";
import { currentGeneration } from "../actions/pause";
import { openOwnerConversation, recordIncomingInvitation } from "../conversations/record";
import { findPerson } from "../people/directory";
import { personKey } from "../people/key";
import { acceptanceTarget } from "./accept";
import { InvitationError, lockInvitation } from "./link";
import { updateInvitation } from "./observe";

/**
 * AN ACCEPTANCE THE OWNER PRESSED — Accept invite on the header of someone who
 * invited the account, whether or not any campaign proposed it (INV-1,
 * INV-27). The press is the owner's yes: the request is tied to a
 * conversation by the owner's word (`user_confirmed_link`), one `accept_invite`
 * row is reserved through the ledger's one door as theirs (`origin: owner`),
 * and the press approves it. The dispatch gate then does for it what it does
 * for any approved acceptance (`acceptInviteOperation`): reads the invitations
 * page's data and presses Accept only on the one request that data lists as
 * this sender's, Pending, then confirms it from the sender's own profile.
 *
 * Where the worker already proposed an acceptance and it waits for a yes, the
 * press is that yes, as Accept once always was. Where the request is tied to a
 * conversation, that conversation is the one it rides on; where it is tied to
 * none, the owner's press ties it to one opened for the purpose
 * (`openOwnerConversation`) — there is no reply to name, so the link names none.
 * That conversation is a running campaign's if one touched the sender, and
 * nobody's if none did: the acceptance is then the owner's own, on the
 * account alone, which no campaign's Stop, pause or policy governs and no
 * campaign is credited with (`ownerCampaignFor`).
 */

/** The acceptance row already on the ledger for one request, newest first. */
async function acceptanceOn(tx: Tx, channelId: number, invitationId: string): Promise<ActionRow | null> {
  const [row] = await tx
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.channelId, channelId),
        eq(actions.kind, "accept_invite"),
        sql`${actions.target} ->> 'id' = ${invitationId}`,
      ),
    )
    .orderBy(sql`${actions.id} desc`)
    .limit(1);
  return row ?? null;
}

export async function ownerAccept(
  tx: Tx,
  input: {
    incomingInvitationId: number;
    /** The campaign the page acted from, for a request tied to no conversation. */
    campaignId?: number | null;
    by: string;
    now?: number;
  },
): Promise<{ action: ActionRow }> {
  const now = input.now ?? Date.now();
  const invitation = await lockInvitation(tx, input.incomingInvitationId);
  if (invitation.status !== "pending") {
    throw new InvitationError(
      "invitation_not_pending",
      invitation.status === "accepted"
        ? "You accepted this request already."
        : "LinkedIn no longer lists this request, so there is nothing to accept.",
      "Nothing to accept.",
    );
  }
  // Where the worker's acceptance waits for a yes, the press is that yes.
  const open = await acceptanceOn(tx, invitation.channelId, invitation.invitationId);
  if (open?.status === "awaiting_review") {
    return approveAction(tx, { id: open.id, approver: input.by, now });
  }

  const key = personKey({ profileId: invitation.senderProfileId });
  const person = key === null ? null : await findPerson(tx, key);
  if (person?.relationship === "connected") {
    throw notPermitted("You're already connected.", "Nothing to accept.");
  }

  // The conversation the request is tied to, else the one they already have.
  const knownId = invitation.conversationId ?? person?.conversationId ?? null;
  const [known] = knownId === null ? [] : await tx.select().from(conversations).where(eq(conversations.id, knownId));
  const campaign = await ownerCampaignFor(tx, {
    person: person ?? { campaigns: [] },
    conversation: known ?? null,
    asked: input.campaignId ?? null,
  });
  const conversation =
    known ??
    (await openOwnerConversation(tx, {
      channelId: invitation.channelId,
      campaignId: campaign?.id ?? null,
      profileId: invitation.senderProfileId,
      now,
    }));

  let eventId = invitation.conversationEventId;
  if (invitation.attribution === "unmatched" || invitation.conversationId === null) {
    const recorded = await recordIncomingInvitation(tx, {
      conversationId: conversation.id,
      invitation: {
        invitationId: invitation.invitationId,
        senderProfileId: invitation.senderProfileId,
        senderUrl: invitation.senderUrl,
        observedAt: invitation.observedAt,
        link: { method: "user_confirmed_link", replyEventId: null, confirmedBy: input.by, confirmedAt: now },
      },
      now,
    });
    if (!recorded) {
      throw new ActionLedgerError("conversation_not_found", "That conversation is not on this account.", "Reload the Inbox.");
    }
    eventId = recorded.event.id;
    await updateInvitation(tx, invitation.id, {
      attribution: "user_confirmed_link",
      attributionEvidence: {
        method: "user_confirmed_link",
        profileId: invitation.senderProfileId,
        conversationId: conversation.id,
        replyEventId: null,
        confirmedBy: input.by,
        confirmedAt: now,
      },
      conversationId: conversation.id,
      conversationEventId: eventId,
      updatedAt: now,
    });
  }

  const reserved = await reserveAction(tx, {
    channelId: invitation.channelId,
    campaignId: conversation.owningCampaignId,
    conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId,
    kind: "accept_invite",
    purpose: "acceptance",
    target: acceptanceTarget(invitation),
    candidate: {
      text: null,
      sources: eventId === null ? [] : [{ eventId, contentHash: null }],
      versions: { strategy: null, facts: [], memory: null, voice: null },
    },
    origin: "owner",
    mode: "review",
    generationSeen: await currentGeneration(tx),
    // An acceptance the owner skipped, or the gate stopped before its press, is
    // the same request again on their press; the gate reads the request's own
    // page data before it presses anything.
    retakeUnclicked: true,
    now,
  });
  if (reserved.status === "refused") {
    throw ownerRefusal(reserved.reason, ["Engager will not accept it now.", "Accept it on LinkedIn."]);
  }
  if (reserved.status === "duplicate") {
    throw notPermitted(
      reserved.action.status === "confirmed" ? "You accepted this request already." : "Accepting this request is already on its way.",
      "Engager settles it by reading, never by pressing Accept again.",
    );
  }
  return approveAction(tx, { id: reserved.action.id, approver: input.by, now });
}
