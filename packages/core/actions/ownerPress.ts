import { eq, inArray } from "drizzle-orm";
import { campaigns, type ConversationRow } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { Person } from "../people/directory";
import { ActionLedgerError } from "./errors";

/**
 * WHAT AN OWNER'S PRESS ON A PERSON SHARES — Invite, Accept invite, Like and
 * DM (`ownerInvite.ts`, `invitations/ownerAccept.ts`, `ownerLike.ts`,
 * `ownerDm.ts`): the campaign a press rides on, and the words a refusal is
 * given in. Nothing here writes.
 */

export function notPermitted(message: string, recovery: string): ActionLedgerError {
  return new ActionLedgerError("action_not_permitted", message, recovery);
}

/** What a press says when the campaign it would go out under cannot send:
 *  there is none, or it is archived. */
export type CampaignWords = { none: [message: string, recovery: string]; archived: string };

/** The campaign an owner's press goes out under, which must still exist and
 *  have an account to send from. A PAUSED one counts: Pause only stops new
 *  runs, and the gate does not hold an owner's own send for it (`canEngage`);
 *  its Stop sending, the account's Stop and the kill switch still do, at the
 *  press and again at the gate. An archived one sends nothing. */
export async function pressCampaign(tx: Tx, campaignId: number | null, words: CampaignWords) {
  const [campaign] =
    campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign || campaign.channelId === null) throw notPermitted(...words.none);
  if (campaign.status === "archived") {
    throw notPermitted(`${campaign.name} is archived, so nothing goes out from it.`, words.archived);
  }
  return { id: campaign.id, channelId: campaign.channelId };
}

const PRESS_WORDS: CampaignWords = {
  none: ["That campaign sends from no account, so nothing goes out from it.", "Do it on LinkedIn."],
  archived: "Do it on LinkedIn.",
};

/**
 * The campaign an owner's press on a person goes out under, or null when it
 * goes out under none: the account's alone.
 *
 * Their conversation's campaign where they have one — null when it has none —
 * else, for someone met only in posts and replies, a running campaign that
 * touched them: the one the page acted from, else the one that touched them
 * last; a paused one only where none is running. Someone no campaign touched
 * is nobody's: the press is the owner's own and rides no campaign, so no
 * campaign's Stop, pause or policy governs it and none is credited with what
 * comes of it. A campaign that touched them is named whether or not it
 * sends; if every one is archived, the press is refused with the newest, not
 * handed to a campaign that never reached them.
 */
export async function ownerCampaignFor(
  tx: Tx,
  input: {
    person: Pick<Person, "campaigns">;
    conversation: Pick<ConversationRow, "owningCampaignId"> | null;
    /** The campaign the page acted from. */
    asked: number | null;
  },
): Promise<{ id: number; channelId: number } | null> {
  const { person, conversation, asked } = input;
  if (conversation) {
    return conversation.owningCampaignId === null ? null : pressCampaign(tx, conversation.owningCampaignId, PRESS_WORDS);
  }
  const touched = person.campaigns.map((campaign) => campaign.id);
  if (touched.length === 0) return null;
  const preferred = asked !== null && touched.includes(asked) ? [asked] : [];
  const order = [...preferred, ...touched.filter((id) => id !== asked)];
  const rows = new Map(
    (await tx.select().from(campaigns).where(inArray(campaigns.id, touched))).map((row) => [row.id, row]),
  );
  // A running campaign first, then a paused one, which an owner's press passes.
  for (const status of ["active", "paused"] as const) {
    for (const id of order) {
      const row = rows.get(id);
      if (row?.status === status && row.channelId !== null) return { id: row.id, channelId: row.channelId };
    }
  }
  return pressCampaign(tx, order[0]!, PRESS_WORDS);
}

/** What the ledger's door refusing an owner's press means to them: the words
 *  the owner actions give for the same Stop, exclusion or closing. */
export function ownerRefusal(reason: string, fallback: [message: string, recovery: string]): ActionLedgerError {
  if (reason === "excluded") {
    return notPermitted(
      "They are on your do-not-engage list.",
      "Nothing reaches them from this account until you lift it on the Channel's blocklist.",
    );
  }
  if (reason.startsWith("paused:") || reason.startsWith("superseded:") || reason === "held:paused") {
    return new ActionLedgerError("action_stopped", "A Stop holds this conversation.", "Resume it first.");
  }
  if (reason === "conversation_closed") {
    return new ActionLedgerError("conversation_closed", "This conversation is closed.", "Nothing is sent in it.");
  }
  if (reason === "human_owned") {
    return new ActionLedgerError(
      "action_stopped",
      "You took this conversation over, so Engager sends nothing in it.",
      "Answer them on LinkedIn, or hand it back to write here.",
    );
  }
  if (reason === "held:uncertain") {
    return notPermitted(
      "An earlier send to them has not been confirmed yet.",
      "Nothing more goes to them until Engager has read where it landed.",
    );
  }
  if (reason === "held:blocked") {
    return notPermitted("LinkedIn warned about sending to them, so nothing goes out.", "Do it on LinkedIn if you still want to.");
  }
  if (reason.startsWith("held:")) {
    return notPermitted("This conversation is held right now.", "Read where it stands on this page.");
  }
  return notPermitted(...fallback);
}
