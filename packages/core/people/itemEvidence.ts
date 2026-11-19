import { and, eq, inArray } from "drizzle-orm";
import { candidateResearch, discoveredPosts } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { verifiedResearchSummaries, type VerifiedResearchSummary } from "../operations/researchReads";
import { roomEvidence } from "../rooms/evidence";
import { readRoomInsights, type RoomInsight } from "../rooms/insights";
import type { JoinLens, RoomEvidence } from "../rooms/presentation";

/**
 * WHAT SCOUT STORED ABOUT A POST, FOR THE NOTE ON ITS ITEM ("Why Scout picked
 * this", `whyPicked.ts`): the lens and the author's fit from the post's
 * current confirmed read, the room's counts, how the post was found, Scout's
 * words on it and Research's, the room's insights, and who is already in the
 * comments.
 *
 * Reads only, inside the caller's `withOrg`: every figure is a stored row's,
 * never a model's prose, and nothing is read from LinkedIn or charged to the
 * read budget. Every word that came off LinkedIn or out of a model comes back
 * verbatim, for a surface to render as plain text. A post with no confirmed
 * read has none of the read's parts, and a room whose read is no longer
 * current comes back `stale` with no insights.
 */
export type PostEvidence = {
  /** The confirmed read's join lens and the author's fit; null with no read. */
  lens: JoinLens | null;
  authorFit: "fits" | "maybe" | "not" | null;
  /** The room's counts at the confirmed read, `stale` once it is not current
   *  (`roomEvidence`). */
  room: RoomEvidence | null;
  /** Scout ranked the post, with a reason (`discovered_posts.agent_rank_reason`). */
  matched: boolean;
  /** Scout's own words on why the post is worth joining (`whyThisPost`). */
  why: string | null;
  /** The confirmed read's one line on the post and its thread. */
  reason: string | null;
  insights: RoomInsight[];
  /** The most-reacted comments, for the posts whose room judged no one to
   *  fit. */
  topComments: VerifiedResearchSummary["topComments"];
};

export async function readItemEvidence(
  tx: Tx,
  postIds: readonly number[],
  now = Date.now(),
): Promise<Map<number, PostEvidence>> {
  const ids = [...new Set(postIds)];
  if (ids.length === 0) return new Map();
  const posts = await tx
    .select({
      id: discoveredPosts.id,
      campaignId: discoveredPosts.campaignId,
      agentRankReason: discoveredPosts.agentRankReason,
      agentAngle: discoveredPosts.agentAngle,
    })
    .from(discoveredPosts)
    .where(inArray(discoveredPosts.id, ids));
  const reads = new Map(
    (
      await tx
        .select({
          postId: candidateResearch.discoveredPostId,
          lens: candidateResearch.joinLens,
          authorFit: candidateResearch.authorFit,
        })
        .from(candidateResearch)
        .where(and(inArray(candidateResearch.discoveredPostId, ids), eq(candidateResearch.verdict, "confirmed")))
    ).map((read) => [read.postId, read] as const),
  );
  const rooms = await roomEvidence(tx, ids, now);
  const research = await verifiedResearchSummaries(tx, ids);
  const insights = await readRoomInsights(tx, ids, now);
  return new Map(
    posts.map((post) => {
      const read = reads.get(post.id);
      const found = research.get(post.id);
      return [
        post.id,
        {
          lens: read?.lens ?? null,
          authorFit: read?.authorFit ?? null,
          room: rooms.get(post.id)?.room ?? null,
          matched: Boolean(post.agentRankReason?.trim()),
          why: cleanReason(post.agentRankReason) ?? cleanReason(post.agentAngle),
          reason: found?.reason ?? null,
          insights: insights.get(post.id) ?? [],
          topComments: found?.topComments ?? [],
        },
      ] as const;
    }),
  );
}

function cleanReason(value: string | null): string | null {
  const clean = value?.replace(/\s+/g, " ").trim();
  return !clean ? null : clean.length <= 300 ? clean : `${clean.slice(0, 299).trimEnd()}…`;
}
