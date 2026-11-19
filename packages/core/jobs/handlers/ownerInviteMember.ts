import { eq } from "drizzle-orm";
import { channels } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { ActionLedgerError } from "../../actions/errors";
import { pausesTouching, scopesOf } from "../../actions/pause";
import { MEMBER_INVITE_REFUSALS, ownerInvite, type OwnerInviteMemberPayload } from "../../actions/ownerInvite";
import { isGrant } from "../../connector/resolve";
import { isConnectorBackoff } from "../../linkedin/connectorError";
import type { RelationshipRead } from "../../linkedin/driver";
import { claimExclusiveRun, releaseExclusiveRun } from "../../pacing";
import { memberId } from "../../people/key";
import { memberProfileOf, recordMemberProfile } from "../../people/memberProfile";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { reserveResearchRead } from "../../ratelimit/ledger";
import { roomInviteSource } from "../../rooms/inviteSource";
import { refuseWorker } from "../../refusal";
import { grantFor } from "../context";
import { RescheduleError } from "../queue";
import { assertHostedJobSpendStillAllowed, assertHostedJobSpendStillAllowedInTx } from "../spendAccess";
import type { JobResult, SelfScopedCtx } from "../worker";

const MINUTE = 60_000;
/** The account's run lease, held for the one profile read. */
const READ_LEASE_MS = 5 * MINUTE;

/** A deferred profile read carries the same room/account and Stop generation
 * as the owner's press. A Stop followed by Resume does not replay that press. */
async function checkRoomPress(tx: Tx, payload: OwnerInviteMemberPayload, now: number) {
  if (!payload.openedFrom) return;
  const source = await roomInviteSource(tx, { campaignId: payload.campaignId,
    personKey: `m.${memberId(payload.memberUrn)}`, openedFrom: payload.openedFrom, now });
  if (source.channelId !== payload.channelId || source.accountProfileId !== payload.roomAccountProfileId ||
    payload.generationSeen === undefined || !Number.isSafeInteger(payload.generationSeen) ||
    (await pausesTouching(tx, scopesOf({ channelId: payload.channelId, campaignId: payload.campaignId, conversationId: null }),
      payload.generationSeen)).length) {
    throw new ActionLedgerError("action_stopped", "This invite's account or Stop changed while the profile read waited.",
      "Reopen the room and press Send invite again if you still want to invite them.");
  }
}

/**
 * Worker handler for `owner_invite_member`: the owner's Invite on someone
 * Engager knows only by a member urn (`ownerInvite`). One read of their own
 * profile, asked for by the urn's id, in the account's session and holding
 * its run lease — never a press. Where the page's data binds that urn to a
 * public identifier (`memberProfileOf`), the pair is kept on their identity
 * row (`recordMemberProfile`), and the owner's invite is then reserved and
 * approved through the invite path everyone takes (`ownerInvite`): its
 * standing checks, the ledger's one door, the dispatch gate's read before
 * Send. A read that binds nothing, or a refusal of the invite, sends nothing
 * — and the job completes with that refusal, in the owner's plain words
 * ({@link MEMBER_INVITE_REFUSALS}), which their page says as a line
 * (`readMemberInviteRefusal`): the press returned long before, and would
 * otherwise stay "sending" for good. A grant, a lease, a budget or a page
 * that leaves nothing read tries again, never past `expiresAt`.
 */
export async function handleOwnerInviteMember(
  ctx: SelfScopedCtx,
  payload: OwnerInviteMemberPayload,
): Promise<JobResult> {
  const org = ctx.organizationId;
  const now = Date.now();
  if (now >= payload.expiresAt) return { expired: 1 };
  const id = memberId(payload.memberUrn);
  if (id === null) return { unresolved: 1 };
  const later = (ms: number) => Math.min(now + ms, payload.expiresAt);

  try {
    await withOrg(org, (tx) => checkRoomPress(tx, payload, now));
  } catch (error) {
    if (!(error instanceof ActionLedgerError)) throw error;
    return { refusal: refuseWorker(MEMBER_INVITE_REFUSALS.refused, `${error.message} ${error.recovery}`) };
  }

  const granted = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return grantFor(ctx, tx, "relationship");
  });
  if (!isGrant(granted)) {
    throw new RescheduleError(granted.detail ?? "LinkedIn account is not connected", later(5 * MINUTE), granted);
  }
  if (!granted.use.readRelationship) return { unsupported: 1 };
  await assertHostedJobSpendStillAllowed(ctx);
  const leaseKey = `worker-run:${payload.channelId}`;
  const lease = await withOrg(org, (tx) => claimExclusiveRun(tx, leaseKey, READ_LEASE_MS, now));
  if (!lease.claimed) throw new RescheduleError("lease_held", later(5 * MINUTE));
  let read: RelationshipRead;
  try {
    const metered = await withOrg(org, async (tx) => {
      const [channel] = await tx.select().from(channels).where(eq(channels.id, payload.channelId));
      return channel
        ? reserveResearchRead({ db: tx, channel, read: "profile_read", campaignId: payload.campaignId, now })
        : null;
    });
    if (metered === null) return { account_gone: 1 };
    if (!metered.ok) {
      throw new RescheduleError(metered.reason, Math.min(metered.retryAt ?? now + 60 * MINUTE, payload.expiresAt));
    }
    read = await granted.use.readRelationship({ profileId: id });
  } catch (error) {
    if (error instanceof RescheduleError) throw error;
    if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(org, error);
    throw new RescheduleError(`unreadable: ${error instanceof Error ? error.message : String(error)}`, later(60 * MINUTE));
  } finally {
    await withOrg(org, (tx) => releaseExclusiveRun(tx, leaseKey, lease.expiresAt, Date.now()));
  }

  const profileId = memberProfileOf(read, payload.memberUrn);
  if (profileId === null) {
    return {
      refusal: refuseWorker(
        MEMBER_INVITE_REFUSALS.unbound,
        "LinkedIn's page for them did not show an address to invite them by, so nothing was sent.",
      ),
    };
  }
  try {
    await withOrg(org, async (tx) => {
      await checkRoomPress(tx, payload, Date.now());
      await recordMemberProfile(tx, { channelId: payload.channelId, profileId, read });
      await ownerInvite(tx, {
        personKey: `p.${profileId}`,
        campaignId: payload.campaignId,
        note: payload.note,
        by: payload.by,
        assistTexts: payload.assistTexts,
        ownerWords: payload.ownerWords,
        openedFrom: payload.openedFrom,
        now: Date.now(),
      });
    });
  } catch (error) {
    if (!(error instanceof ActionLedgerError)) throw error;
    // Where they stand ruled the invite out: the identifier is still theirs.
    await withOrg(org, (tx) => recordMemberProfile(tx, { channelId: payload.channelId, profileId, read }));
    return { refusal: refuseWorker(MEMBER_INVITE_REFUSALS.refused, `${error.message} ${error.recovery}`) };
  }
  return { invited: 1 };
}
