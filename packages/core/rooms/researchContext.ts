import { and, eq, inArray } from "drizzle-orm";
import { campaigns, channels, discoveredPosts, engagedProfiles, systemState, type Campaign, type DiscoveredPost } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { effectiveAudience } from "../audience/model";
import { isActionableCandidateStatus } from "../operations/postStatus";
import { contextHash } from "../tasks/hash";
import { authorIdentity } from "../people/key";
import { lockEngagementSafety } from "../ratelimit/killswitch";
import { perProfileCapRefusal } from "../ratelimit/ledger";
import { lockRoomEvidence } from "./eligibility";
import { excludedRoomKeys } from "./retention";

/** Short transactions freeze the read's authority. No transaction survives a
 * browser or model call; the same context is checked before each and at commit. */
export async function serverResearchContext(tx: Tx, campaign: Campaign, post: DiscoveredPost, now: number) {
  await lockEngagementSafety(tx);
  await lockRoomEvidence(tx);
  const [current] = await tx.select().from(campaigns).where(eq(campaigns.id, campaign.id)).for("update");
  if (!current || current.deletedAt !== null || !current.verifyStage || current.status === "archived" || current.status !== campaign.status ||
    current.audienceRevision !== campaign.audienceRevision || current.maxPostAgeDays !== campaign.maxPostAgeDays ||
    contextHash(effectiveAudience(current)) !== contextHash(effectiveAudience(campaign))) return null;
  const [candidate] = await tx.select().from(discoveredPosts)
    .where(and(eq(discoveredPosts.id, post.id), eq(discoveredPosts.campaignId, current.id))).for("update");
  if (!candidate || (!isActionableCandidateStatus(candidate.status) && candidate.status !== "draft_requested") ||
    candidate.verifiedAt !== post.verifiedAt || candidate.verifyVerdict !== post.verifyVerdict ||
    candidate.postUrn !== post.postUrn || candidate.authorProfileId !== post.authorProfileId ||
    candidate.contentText !== post.contentText || candidate.postedAt !== post.postedAt) return null;
  const [channel] = current.channelId === null ? [] : await tx.select().from(channels)
    .where(eq(channels.id, current.channelId)).for("share");
  const [stops] = await tx.select().from(systemState);
  if (!channel || !channel.externalAccountId || channel.executionState !== "active" ||
    (channel.executionAccountId !== null && channel.executionAccountId !== channel.externalAccountId) ||
    (channel.pausedUntil !== null && channel.pausedUntil > now) ||
    stops?.killSwitch || stops?.transferPaused || stops?.cloudPaused) return null;
  const authorId = candidate.authorProfileId ? authorIdentity(candidate.authorProfileId) : null;
  const [blocked] = authorId === null ? [] : await tx.select({ blocked: engagedProfiles.doNotEngage }).from(engagedProfiles)
    .where(and(inArray(engagedProfiles.profileId, [authorId, candidate.authorProfileId!]), eq(engagedProfiles.doNotEngage, true)));
  const excluded = await excludedRoomKeys(tx);
  const authorBlocked = blocked?.blocked === true || (authorId !== null && excluded.has(`p.${authorId}`));
  const authorContactEligible = authorId !== null && !authorBlocked &&
    await perProfileCapRefusal(tx, channel, authorId, now) === null;
  const guard = contextHash({ audience: effectiveAudience(current), maxPostAgeDays: current.maxPostAgeDays,
    channel: { id: channel.id, account: channel.externalAccountId, executionAccount: channel.executionAccountId,
      runtime: channel.executionRuntimeId, epoch: channel.executionEpoch, state: channel.executionState },
    stops: stops ?? null, authorBlocked,
    post: { id: candidate.id, urn: candidate.postUrn, author: candidate.authorProfileId,
      text: candidate.contentText, postedAt: candidate.postedAt } });
  return { campaign: current, post: candidate, guard, authorBlocked, authorContactEligible };
}
