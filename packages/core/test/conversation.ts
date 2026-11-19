import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { expect } from "vitest";
import {
  channels,
  commentWatches,
  discoveredPosts,
  incomingComments,
  messages,
  workers,
} from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { activateStrategy } from "../strategy/activate";
import type { CampaignAgentStrategy } from "../strategy/contract";
import { conversationCampaign, withActionModes } from "../strategy/strategy.fixture";
import { seedBlankStrategy } from "../strategy/seed";
import { injectedGrant, type CapabilityGrant } from "../jobs/context";
import { handlePollIncoming } from "../jobs/handlers/pollIncoming";
import { handleProcessIncomingPhased } from "../jobs/handlers/processIncoming";
import type { CommentRepliesRead, CommentReply } from "../linkedin/driver";
import { MockDriver } from "../linkedin/mock";
import { ambassadorIdFor } from "../operations/workers";
import { resetPacing } from "../pacing";
import { withEntryBoundary } from "./boundary";
import { mkCampaignFor, mkOrg } from "./db";
import { stageStrategyVersion } from "./strategies";
import { FakeLLM } from "./fakes";

/**
 * A campaign whose Ambassador has one person-to-person
 * step, Handle a reply, with a posted comment of ours under a due watch —
 * and the thread read and processIncoming that put a reply on a conversation. The
 * agent step suites build on it: the unit of their work is a reply observed
 * the way production observes one.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const commentUrn = (post: string, id: string) =>
  `urn:li:comment:(activity:${post.split(":").pop()},${id})`;

/** A campaign whose one Ambassador step is Handle a reply, allowed every tool
 *  a case proposes; Reply, Like and DM at Ask me. */
export function handleReplyStrategy(campaignId: number): CampaignAgentStrategy {
  const base = withActionModes(conversationCampaign(), {
    public_reply: "review",
    like_target: "review",
    dm: "review",
  });
  const step = base.steps!.find((s) => s.step_id === "handle_reply")!;
  return {
    ...base,
    campaign_id: campaignId,
    steps: [
      {
        ...step,
        instructions: "Answer their point in one or two sentences.",
        context_refs: ["verified_thread", "campaign_voice", "product_facts", "relationship_state"],
        allowed_tools: [
          "read_thread",
          "read_profile",
          "draft_comment",
          "draft_dm",
          "reply_public",
          "like_target",
          "send_dm",
        ],
      },
    ],
    action_bindings: base.action_bindings!.filter((b) => b.owner_step_id === "handle_reply"),
  };
}

export type Fixture = {
  orgId: string;
  campaignId: number;
  ambassadorId: number;
  post: string;
  ours: string;
  watchId: number;
  driver: MockDriver;
  asked: unknown[];
  grant: CapabilityGrant;
};

export async function baseAmbassador(
  edit: (doc: CampaignAgentStrategy) => CampaignAgentStrategy = (doc) => doc,
): Promise<Fixture> {
  const orgId = await mkOrg();
  const campaignId = await mkCampaignFor(orgId, { status: "active" });
  // The campaign's v1 from its rows, then the version under test over it —
  // activated, so the Ambassador's row is the projection's, as in production.
  await withOrg(orgId, async (tx) => {
    await seedBlankStrategy(tx, campaignId, Date.now());
    const version = await stageStrategyVersion(
      tx,
      campaignId,
      () => edit(handleReplyStrategy(campaignId)),
      Date.now() - 60_000,
    );
    await activateStrategy(tx, { campaignId, version });
  });
  const [ambassador] = await withOrg(orgId, (tx) =>
    tx
      .select()
      .from(workers)
      .where(and(eq(workers.campaignId, campaignId), eq(workers.type, "ambassador"))),
  );
  expect(ambassador).toMatchObject({ conversationEnabled: true, auto: true });

  const post = `urn:li:activity:${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const ours = commentUrn(post, randomUUID().replace(/-/g, "").slice(0, 12));
  const watchId = await withOrg(orgId, async (tx) => {
    const [discovered] = await tx
      .insert(discoveredPosts)
      .values({ campaignId, postUrn: post, contentText: "What should we measure first?" })
      .returning();
    const [message] = await tx
      .insert(messages)
      .values({
        kind: "comment",
        campaignId,
        discoveredPostId: discovered!.id,
        proposedText: "Time to first useful action.",
        status: "posted",
        dedupeKey: `dk-${randomUUID()}`,
        externalUrn: ours,
        postedAt: Date.now() - 2 * DAY,
      })
      .returning();
    const [watch] = await tx
      .insert(commentWatches)
      .values({
        messageId: message!.id,
        campaignId,
        postUrn: post,
        commentUrn: ours,
        nextCheckAt: Date.now() - 1_000,
        expiresAt: Date.now() + 5 * DAY,
        createdAt: Date.now() - 2 * DAY,
      })
      .returning();
    return watch!.id;
  });
  const driver = new MockDriver({ incoming: [] });
  const asked: unknown[] = [];
  const grant: CapabilityGrant = (tx, kinds) => {
    asked.push(kinds);
    return injectedGrant(driver)(tx, kinds);
  };
  return { orgId, campaignId, ambassadorId: ambassador!.id, post, ours, watchId, driver, asked, grant };
}

/** The campaign's posted comment under a due watch, with the driver and grant a
 *  thread read takes: `baseAmbassador`'s fixture for a campaign whose strategy
 *  the case has already set up. */
export async function watchedComment(orgId: string, campaignId: number): Promise<Fixture & { channelId: number }> {
  const post = "urn:li:activity:1456789", ours = commentUrn(post, "123");
  const { watchId, ambassadorId, channelId } = await withOrg(orgId, async (tx) => {
    const [channel] = await tx.select().from(channels);
    const [discovered] = await tx.insert(discoveredPosts).values({ campaignId, postUrn: post, contentText: "A question" }).returning();
    const [message] = await tx.insert(messages).values({ kind: "comment", campaignId, discoveredPostId: discovered!.id,
      proposedText: "Time to first useful action.", status: "posted", dedupeKey: `dk-${randomUUID()}`, externalUrn: ours, postedAt: Date.now() - 2 * HOUR }).returning();
    const [watch] = await tx.insert(commentWatches).values({ campaignId, messageId: message!.id, postUrn: post, commentUrn: ours,
      nextCheckAt: Date.now() - 1_000, expiresAt: Date.now() + DAY, createdAt: Date.now() - 2 * HOUR }).returning();
    return { watchId: watch!.id, ambassadorId: (await ambassadorIdFor(tx, campaignId))!, channelId: channel!.id };
  });
  const driver = new MockDriver({ incoming: [] });
  return { orgId, campaignId, ambassadorId, post, ours, watchId, driver, asked: [], grant: injectedGrant(driver), channelId };
}

export function reply(f: Fixture, id: string, text: string, person = "ACoAAAda"): CommentReply {
  return {
    replyUrn: commentUrn(f.post, id),
    author: {
      profileId: person,
      displayName: `Name of ${person}`,
      profileUrl: `https://www.linkedin.com/in/${person}/`,
      isSelf: false,
    },
    text,
    textHash: sha(text),
    postedAt: Date.now() - HOUR,
    observedAt: Date.now(),
    isDirectChild: true,
  };
}

export function thread(f: Fixture, replies: CommentReply[]): CommentRepliesRead {
  return {
    comment: {
      present: true,
      urn: f.ours,
      resolvedId: f.ours,
      authorIsSelf: true,
      textHash: sha("Time to first useful action."),
      replyCount: replies.length,
      replyRows: replies.length,
    },
    replies,
    truncated: false,
    pageFingerprint: "0123456789abcdef",
    selectorPack: "linkedin-2026-10-11.1",
  };
}

/** The thread read observes `replies`; processIncoming classifies each new
 *  row and records it on its conversation. */
export async function observe(f: Fixture, replies: CommentReply[], llm = new FakeLLM()): Promise<void> {
  await readThread(f, replies);
  await reprocess(f, llm);
}

/** The thread read alone: each new reply lands `new`, for processIncoming. */
export async function readThread(f: Fixture, replies: CommentReply[]): Promise<void> {
  f.driver.commentReplies.set(f.ours, thread(f, replies));
  await withOrg(f.orgId, async (tx) => {
    await resetPacing(tx, "poll_incoming");
    await tx
      .update(commentWatches)
      .set({ nextCheckAt: Date.now() - 1_000 })
      .where(eq(commentWatches.id, f.watchId));
  });
  await handlePollIncoming({ organizationId: f.orgId, grant: injectedGrant(f.driver) }, {});
}

/** Run process_incoming over every thread row still `new` — which, on a
 *  flagged campaign, is every reply: the step answers it, not the lane. */
export async function reprocess(f: Fixture, llm = new FakeLLM()): Promise<void> {
  const rows = await withOrg(f.orgId, (tx) =>
    tx
      .select({ id: incomingComments.id })
      .from(incomingComments)
      .where(eq(incomingComments.status, "new"))
      .orderBy(asc(incomingComments.id)),
  );
  for (const row of rows) {
    await withEntryBoundary(() =>
      handleProcessIncomingPhased(
        { organizationId: f.orgId, grant: injectedGrant(new MockDriver()), llm },
        { incomingCommentId: row.id },
      ),
    );
  }
}

/** A new comment on the owner's own post, by someone called Jordan. */
export async function ownPostComment(orgId: string, over: { commentUrn: string; authorProfileId: string; text: string }): Promise<number> {
  const [row] = await withOrg(orgId, (tx) => tx.insert(incomingComments).values({ ownPostUrn: "urn:li:activity:1234", authorName: "Jordan", postText: "A post", source: "own_post", status: "new", ...over }).returning());
  return row!.id;
}
