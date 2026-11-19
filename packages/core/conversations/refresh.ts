import { eq } from "drizzle-orm";
import { channels, conversations } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { conversationEventArrived } from "../agentStep/wait";
import type { CapabilitySurface } from "../connector/resolve";
import type { RelationshipRead } from "../linkedin/driver";
import { reserveResearchRead } from "../ratelimit/ledger";
import { recordRelationshipRead, type RecordedRelationship } from "./record";
import { relationshipOf } from "./relationship";

export type RelationshipRefresh =
  /** Read now, and recorded on the conversation. */
  | ({ status: "read"; read: RelationshipRead } & RecordedRelationship)
  /** Read now, and the page could not tell; recorded nowhere, as asked. */
  | { status: "unclear"; read: RelationshipRead }
  /** The account's read budget, window or stops said no; nothing was read. */
  | { status: "refused"; reason: string; retryAt?: number }
  /** The connector has no relationship read. */
  | { status: "unsupported" }
  /** The conversation is not this org's. */
  | { status: "not_found" };

/**
 * Read where the account stands with a conversation's person, and record it.
 *
 * The read is the person's own profile page, through the surface the caller
 * resolved for the conversation's account — the one session a relationship fact
 * about this conversation may come from (INV-30): never a cached read, another
 * account's, or a notification. It is reserved first as a `profile_read`
 * against that account's daily budget, in a transaction of its own, so a
 * read that then fails has still spent its row; performed outside any
 * transaction; and recorded in one (`recordRelationshipRead`).
 *
 * An acceptance the read records is a conversation event like a reply, whichever
 * caller made the read — the invitation's watch, an invite's or a
 * withdrawal's preflight, the owner's live check: in the transaction that
 * records it, it wakes the campaign's Ambassador and ends the step waits it
 * matches, where the eligibility table judged it a thing to answer and a
 * step of the strategy may send that answer (`conversationEventArrived`).
 *
 * A read that fails changes nothing — a page the connector does not
 * recognise, a sign-in wall or a page that will not load throws to the
 * caller with no event written and no column moved. A read that could not
 * tell is recorded, and sends the conversation to review — unless the caller says
 * it changes nothing (`recordUnclear: false`), as a watch that reads again
 * tomorrow does: then it comes back `unclear`, its budget row spent and
 * nothing else written.
 *
 * Nothing here serializes two reads of one person: the caller holds the
 * account's run lease, as the verify reads' callers do.
 */
export async function refreshRelationship(opts: {
  organizationId: string;
  driver: CapabilitySurface<"relationship">;
  conversationId: number;
  now?: number;
  /** Awaited once the budget has said yes, just before the page loads. */
  beforeLoad?: () => Promise<void>;
  /** False: a read that could not tell is not recorded. */
  recordUnclear?: boolean;
  /** Also look up where the person is, from the page the read loads, and
   *  keep it on their `author_profiles` row. */
  place?: boolean;
}): Promise<RelationshipRefresh> {
  const { organizationId, driver, conversationId } = opts;
  const now = opts.now ?? Date.now();
  if (!driver.readRelationship) return { status: "unsupported" };

  const reserved = await withOrg(organizationId, async (tx) => {
    const [row] = await tx
      .select({ conversation: conversations, channel: channels })
      .from(conversations)
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(eq(conversations.id, conversationId));
    if (!row) return { status: "not_found" } as const;
    const decision = await reserveResearchRead({
      db: tx,
      channel: row.channel,
      read: "profile_read",
      campaignId: row.conversation.owningCampaignId,
      profileId: row.conversation.authorProfileId,
      now,
    });
    if (!decision.ok) {
      return {
        status: "refused",
        reason: decision.reason,
        ...(decision.retryAt != null ? { retryAt: decision.retryAt } : {}),
      } as const;
    }
    return { status: "reserved", profileId: row.conversation.authorProfileId } as const;
  });
  if (reserved.status !== "reserved") return reserved;
  await opts.beforeLoad?.();

  const read = await driver.readRelationship({
    profileId: reserved.profileId,
    ...(opts.place ? { place: true as const } : {}),
  });
  if (opts.recordUnclear === false && relationshipOf(read, reserved.profileId) === "unknown") {
    return { status: "unclear", read };
  }
  const recorded = await withOrg(organizationId, async (tx) => {
    const written = await recordRelationshipRead(tx, { conversationId, read, now });
    const campaignId = written?.conversation.owningCampaignId ?? null;
    if (written?.accepted && campaignId !== null) {
      await conversationEventArrived(tx, { campaignId, event: written.accepted, now });
    }
    return written;
  });
  return recorded ? { status: "read", read, ...recorded } : { status: "not_found" };
}
