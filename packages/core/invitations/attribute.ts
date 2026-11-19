import type { IncomingInvitation } from "../linkedin/driver";

/**
 * WHO AN INVITATION IS FROM, IN TERMS OF A CONVERSATION (spec §15: "attribute
 * an incoming invite through verified identity plus an explicit exchange
 * reference or user-confirmed link"; INV-30). Pure.
 *
 * An invitation is `verified` when its sender — the provider's id for them, as
 * the account's own invitations page linked them — is the author of a reply a
 * conversation on this account recorded: the same id the thread read identified
 * them by. Nothing else verifies it. A sender who merely shares a replier's
 * name, or whose invitation arrived just after a reply, is `unmatched`; the
 * conversations whose replier shares the name are named as a hint for the owner's
 * own link, and are never a link themselves.
 */

/** One reply a conversation on the account recorded, and who wrote it. */
export type Exchange = {
  conversationId: number;
  /** The replier, as the thread read identified them. */
  profileId: string;
  /** The name the thread read showed beside the reply; display only. */
  displayName: string | null;
  /** The conversation's `reply_observed` event — the exchange an attribution
   *  cites. */
  replyEventId: number;
  /** The conversation is closed: an opt-out or the owner's exclusion stands. */
  closed: boolean;
};

export type InvitationAttributionResult =
  | { status: "verified"; conversationId: number; replyEventId: number }
  | { status: "unmatched"; nameMatches: number[] };

/** The same name, compared the way a person reading it would: case, width
 *  and spacing aside. */
export function sameName(a: string | null, b: string | null): boolean {
  const norm = (value: string) => value.normalize("NFKC").toLocaleLowerCase().split(/\s+/).join(" ").trim();
  return a !== null && b !== null && norm(a) !== "" && norm(a) === norm(b);
}

export function attributeInvitation(
  invitation: Pick<IncomingInvitation, "sender">,
  exchanges: readonly Exchange[],
): InvitationAttributionResult {
  const sender = invitation.sender;
  // The person's open conversation first, the latest reply in it first: a closed
  // conversation still verifies — its closure is the eligibility table's to apply.
  const [match] = exchanges
    .filter((exchange) => exchange.profileId === sender.profileId)
    .sort((a, b) => Number(a.closed) - Number(b.closed) || b.replyEventId - a.replyEventId);
  if (match) {
    return { status: "verified", conversationId: match.conversationId, replyEventId: match.replyEventId };
  }
  return {
    status: "unmatched",
    nameMatches: [
      ...new Set(
        exchanges
          .filter((exchange) => sameName(exchange.displayName, sender.displayName))
          .map((exchange) => exchange.conversationId),
      ),
    ].sort((a, b) => a - b),
  };
}
