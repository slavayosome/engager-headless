import { and, eq, gte, inArray, isNotNull, like, not, notInArray, sql, type SQL } from "drizzle-orm";
import { composerDrafts, discoveredPosts, messages, type Campaign, type SearchDepth } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { telemetryEnabled, track } from "@engager/observability/analytics";
import { boxKey } from "../composer/drafts";
import { readSearchDepth, type DepthCampaign } from "../strategy/searchDepth";
import { firstLookTally, type FirstLookEnding, type FirstLookTally } from "../workers/firstLook";

/**
 * A CAMPAIGN'S FIRST RESULTS (US-DEP-17): its first matched post
 * (`first_match_visible`) and its first draft (`first_draft_ready`), each told
 * once, with the search depth the campaign reads and how long after its create.
 *
 * "First" is read off the rows after the write committed — nothing of the
 * kind on the campaign but what just landed — so two writes landing at once
 * can both miss it but never both send it: a first claimed twice is worse
 * than one missed. Telemetry never fails the write it reports.
 */

type FirstsCampaign = DepthCampaign & Pick<Campaign, "createdAt">;

/** Drafts that just landed: agent drafts put in these posts' comment boxes
 *  from `since` on, or comments a worker wrote to wait for a yes. */
export type LandedDrafts =
  | { boxes: { postIds: readonly number[]; since: number } }
  | { messageIds: readonly number[] };

/**
 * The drafts that just landed hold the campaign's first: no other comment box
 * of the campaign holds an agent's draft — the landed boxes' older angles
 * included — and no worker wrote any other comment for it.
 */
export async function trackFirstDraft(
  organizationId: string,
  campaign: FirstsCampaign,
  landed: LandedDrafts,
): Promise<void> {
  const boxes = "boxes" in landed ? landed.boxes : null;
  const messageIds = "messageIds" in landed ? landed.messageIds : [];
  if ((boxes?.postIds.length ?? 0) === 0 && messageIds.length === 0) return;
  const first = await firstOf(organizationId, campaign, async (tx) => {
    const angles: SQL[] = [eq(composerDrafts.campaignId, campaign.id), like(composerDrafts.boxKey, "comment:%")];
    if (boxes && boxes.postIds.length > 0) {
      const keys = boxes.postIds.map((id) => boxKey({ kind: "comment", discoveredPostId: id }));
      angles.push(not(and(inArray(composerDrafts.boxKey, keys), gte(composerDrafts.createdAt, boxes.since))!));
    }
    const [earlierAngle] = await tx.select({ id: composerDrafts.id }).from(composerDrafts).where(and(...angles)).limit(1);
    if (earlierAngle) return false;
    const comments: SQL[] = [
      eq(messages.campaignId, campaign.id),
      eq(messages.kind, "comment"),
      isNotNull(messages.workerRunId),
    ];
    if (messageIds.length > 0) comments.push(notInArray(messages.id, [...messageIds]));
    const [earlierComment] = await tx.select({ id: messages.id }).from(messages).where(and(...comments)).limit(1);
    return earlierComment === undefined;
  });
  if (first) track("first_draft_ready", first);
}

/**
 * A Quick campaign's first look ended, told once by whatever ended it, with
 * the rounds it ran and what they matched and drafted: read off the Scout's
 * rows unless the caller has the tally in hand. Like every report here it
 * never fails the run it describes.
 */
export async function trackFirstLookFinished(
  organizationId: string,
  workerId: number,
  ending: FirstLookEnding,
  tally?: FirstLookTally,
): Promise<void> {
  if (!telemetryEnabled()) return;
  try {
    const counted = tally ?? (await withOrg(organizationId, (tx) => firstLookTally(tx, workerId)));
    track("first_look_finished", {
      rounds: counted.rounds,
      matched: counted.matched,
      drafted: counted.drafted,
      stop_reason: ending,
    });
  } catch {
    // Reports less; the first look already ended.
  }
}

/** What a first says — the depth the campaign reads and how long after its
 *  create — when `isFirst` finds it is one; null otherwise, with telemetry
 *  off, or on any failure: it reports less, and the write already landed. */
async function firstOf(
  organizationId: string,
  campaign: FirstsCampaign,
  isFirst: (tx: Tx) => Promise<boolean>,
): Promise<{ depth: SearchDepth; ms_since_create: number } | null> {
  if (!telemetryEnabled()) return null;
  try {
    const depth = await withOrg(organizationId, async (tx) =>
      (await isFirst(tx)) ? readSearchDepth(tx, campaign) : null,
    );
    return depth === null ? null : { depth, ms_since_create: Math.max(0, Date.now() - campaign.createdAt) };
  } catch {
    return null;
  }
}
