import { eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, channels, leads, leadSignals, type Lead, type LeadSourcedReplyTarget } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { authorIdentity } from "../people/key";
import { assertPostUrn, normalizePostUrn } from "../linkedin/postUrn";
import { memberId } from "../people/key";
import { lockRoomEvidence, ROOM_RETENTION_MS } from "../rooms/eligibility";
import { RATING_WORDS } from "./rating";
import { leadStandings, standingsOf } from "./scout/eligibility";
import { standsAside } from "./setAside";

/**
 * A REPLY UNDER A LEAD'S COMMENT, read from where Scout found it: the signal
 * the sweep's thread read kept — the post, the comment, its author — never a
 * room. A lead's comment is never read into one, and none is made up for it.
 *
 * Read again at every save, queue and send, as a room reply's room is
 * (`rooms/replySource.ts`): the signal is still theirs and this campaign's,
 * the account is the one connected, the author is a person and not the
 * account, the comment is inside the window room evidence is kept for, and
 * the person is one the page still offers and the owner's rules still let
 * Engager reach. Each refusal says so in a room reply's words where one fits.
 */

/** A reply under a lead's comment, under the campaign and account it goes out
 *  on. */
export type LeadReplySource = LeadSourcedReplyTarget & { organizationId: string; channelId: number; campaignId: number };

const refused = (code: string, message: string) => new AppError(code, message, 409);

/**
 * Why nothing is written to a person unasked, as the refusal Queue gives; null
 * where nothing turns them away. Scout read them as other than a buyer, or the
 * owner rated them a peer or not a fit, or they stand aside now (`aside`, as
 * `standsAside` or `asideAmong` read it: their newer words may have undone a
 * set-aside the row still holds). A rating holds after Bring back now: only
 * rating them Right person again lets the owner write to them.
 *
 * The one answer the owner's Queue (`leadTurnedAway`) and a step's own
 * openers (`leadOpenersOwed`, which asks it of many leads at once) both read,
 * so what Queue refuses an Automatic step never queues.
 */
export function turnedAway(lead: Pick<Lead, "role" | "rating">, aside: boolean): AppError | null {
  if (lead.role !== null && lead.role !== "buyer") {
    return refused("lead_not_a_buyer", "Scout read this person as someone other than a buyer, so Engager does not write to them.");
  }
  if (lead.rating === "a_peer" || lead.rating === "not_a_fit") {
    return refused("lead_rated_out", `You rated this person ${RATING_WORDS[lead.rating]}, so nothing is queued to them.`);
  }
  return aside ? refused("lead_set_aside", "You set this person aside, so nothing is queued to them.") : null;
}

/** {@link turnedAway} for one lead, the set-aside read as it stands now. */
export async function leadTurnedAway(tx: Tx, lead: Pick<Lead, "id" | "role" | "rating">): Promise<AppError | null> {
  return turnedAway(lead, await standsAside(tx, lead.id));
}

/** The comment a lead's reply answers, as its signal stands now. The caller
 *  compares it with what a draft or a message froze. */
export async function readLeadReplySource(tx: Tx, signalId: number, options: { now?: number } = {}): Promise<LeadReplySource> {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(signalId) || signalId <= 0) {
    throw refused("room_target_invalid", "Select the person and the exact comment to answer.");
  }
  // The lock Never engage takes: an exclusion lands before this or after it.
  await lockRoomEvidence(tx);
  const [row] = await tx
    .select({ signal: leadSignals, lead: leads, campaign: campaigns, channel: channels })
    .from(leadSignals)
    .innerJoin(leads, eq(leads.id, leadSignals.leadId))
    .innerJoin(campaigns, eq(campaigns.id, leadSignals.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId))
    .where(eq(leadSignals.id, signalId));
  if (!row) throw refused("room_target_missing", "That person or room is no longer available.");
  const { signal, lead, campaign, channel } = row;
  if (signal.kind !== "comment" || signal.commentUrn === null || signal.verdict !== "passed") {
    throw refused("room_target_missing", "That person or room is no longer available.");
  }
  if (lead.campaignId !== signal.campaignId) throw refused("room_source_mismatch", "That room does not belong to this campaign.");
  const account = channel.externalAccountId?.trim();
  if (!account || (channel.executionAccountId && channel.executionAccountId !== account)) {
    throw refused("room_account_unavailable", "Reconnect the LinkedIn account before choosing this reply target.");
  }
  // Only a member urn names a person: a company page's comment has none.
  if (signal.memberUrn === null || memberId(signal.memberUrn) === null) {
    throw refused("lead_author_unresolved", "Scout kept no person behind this comment, so there is no one to answer.");
  }
  if (authorIdentity(lead.profileId) === authorIdentity(account) || signal.memberUrn === account) {
    throw refused("room_author_not_eligible", "Choose another person's comment to answer.");
  }
  if (signal.seenAt <= now - ROOM_RETENTION_MS) {
    throw refused("lead_evidence_expired", "Scout read this comment too long ago to answer it now.");
  }
  const turnedAway = await leadTurnedAway(tx, lead);
  if (turnedAway) throw turnedAway;
  // The lead's profile id misses an exclusion keyed only on the comment author's
  // member id (`m.<id>`), which the signal's member urn finds.
  const [standing] = await leadStandings(tx, campaign.id, [lead.id]);
  const [commentAuthor] = await standingsOf(tx, [signal.id]);
  if (!standing?.eligible || !commentAuthor?.eligible) {
    throw refused("room_person_excluded", "This person cannot be contacted from the room.");
  }
  const postUrn = normalizePostUrn(signal.postUrn);
  assertPostUrn(postUrn);
  return {
    source: "lead",
    organizationId: campaign.organizationId,
    channelId: channel.id,
    campaignId: campaign.id,
    accountProfileId: account,
    postUrn,
    parentCommentUrn: signal.commentUrn,
    personKey: `p.${lead.profileId}`,
    profileId: lead.profileId,
    memberUrn: signal.memberUrn,
    leadId: lead.id,
    signalId: signal.id,
    evidenceReadAt: signal.seenAt,
    selectedBy: "owner",
  };
}
