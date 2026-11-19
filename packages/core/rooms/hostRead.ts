import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { campaigns, channels, discoveredPosts, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { effectiveAudience } from "../audience/model";
import { isActionableCandidateStatus } from "../operations/postStatus";
import { config } from "../config";
import { contextHash } from "../tasks/hash";
import { AuthorProfileReadSchema, PostThreadSchema } from "../linkedin/browser-use/protocol";
import { MAX_THREAD_COMMENTS } from "../linkedin/driver";
import { authorIdentity } from "../people/key";
import { lockRoomEvidence } from "./eligibility";
import { roomJudgmentSchema } from "./judgment";
import { selectRoomPeople } from "./room";

const LIFETIME = 30 * 60_000;
const PREFIX = "host-room-read-v1";
export const hostRoomThreadSchema = PostThreadSchema.extend({ comments: PostThreadSchema.shape.comments.max(MAX_THREAD_COMMENTS) });
export const hostRoomReadSchema = z.object({
  campaignId: z.number().int().positive(),
  discoveredPostId: z.number().int().positive(),
  audienceRevision: z.number().int().nonnegative(),
  thread: hostRoomThreadSchema,
  author: AuthorProfileReadSchema,
  readAt: z.number().int().positive(),
  pages: z.literal(1),
  orders: z.array(z.enum(["relevance", "recent"])).length(1),
  coverage: z.enum(["complete", "sampled", "budget_limited"]),
}).strict().superRefine((read, issue) => {
  if (read.orders.length !== read.pages || read.thread.comments.length > read.pages * MAX_THREAD_COMMENTS) {
    issue.addIssue({ code: "custom", message: "The page count must match its orders and bounded comment read." });
  }
  if (read.coverage === "complete" && read.thread.counts.comments > read.thread.comments.length) {
    issue.addIssue({ code: "custom", message: "A partial comment read cannot claim complete coverage." });
  }
});
export type HostRoomRead = z.infer<typeof hostRoomReadSchema>;

export const hostRoomJudgmentsSchema = z.object({
  contextToken: z.string().min(1).max(4096),
  readAt: z.number().int().positive(),
  pages: z.literal(1),
  orders: z.array(z.enum(["relevance", "recent"])).length(1),
  coverage: z.enum(["complete", "sampled", "budget_limited"]),
  authorFit: z.enum(["fits", "maybe", "not"]),
  judgments: z.array(roomJudgmentSchema).max(MAX_THREAD_COMMENTS),
  contentFault: z.enum(["off_topic", "engagement_bait", "no_contribution_possible"]).optional(),
}).strict();
export type HostRoomJudgments = z.infer<typeof hostRoomJudgmentsSchema>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const claimsSchema = z.object({
  organizationId: z.string().uuid(),
  credential: hash,
  campaignId: z.number().int().positive(),
  postId: z.number().int().positive(),
  audienceRevision: z.number().int().nonnegative(),
  input: hash,
  guard: hash,
  people: hash,
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict();
type Claims = z.infer<typeof claimsSchema>;

function signature(payload: string) {
  const key = Buffer.from(config.masterKey(), "base64");
  if (key.length !== 32) throw new Error("ENGAGER_MASTER_KEY must decode to 32 bytes");
  return createHmac("sha256", key).update(`${PREFIX}:${payload}`).digest();
}

function stale(detail: string): never {
  throw new AppError("research_context_stale", `${detail} Prepare this room read again against the current Audience.`, 409);
}

function readClaims(token: string, now: number): Claims {
  if (typeof token !== "string" || token.length > 4096) stale("The room read receipt is invalid.");
  const [version, payload, signed, extra] = token.split(".");
  if (version !== PREFIX || !payload || !signed || extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signed)) stale("The room read receipt is invalid.");
  const received = Buffer.from(signed, "base64url");
  const expected = signature(payload);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) stale("The room read receipt is invalid.");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { stale("The room read receipt is invalid."); }
  const parsed = claimsSchema.safeParse(value);
  if (!parsed.success || parsed.data.issuedAt > now || parsed.data.expiresAt <= now ||
    parsed.data.expiresAt - parsed.data.issuedAt !== LIFETIME) stale("The room read receipt expired or is invalid.");
  return parsed.data;
}

/** The caller already has this browser read. Freeze only hashes of its
 * content and identity set; the receipt retains no person names or words. */
async function currentRead(tx: Tx, input: HostRoomRead, now: number) {
  await lockRoomEvidence(tx);
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId)).for("update");
  if (!campaign || !campaign.verifyStage || campaign.status === "archived") stale("Research is unavailable for this campaign.");
  if (campaign.audienceRevision !== input.audienceRevision) stale("The Audience changed.");
  const [post] = await tx.select().from(discoveredPosts)
    .where(and(eq(discoveredPosts.id, input.discoveredPostId), eq(discoveredPosts.campaignId, campaign.id))).for("update");
  if (!post || !isActionableCandidateStatus(post.status) || post.verifyVerdict !== null) stale("This candidate is no longer awaiting Research.");
  if (post.postUrn !== input.thread.postUrn || (post.authorProfileId !== null &&
    authorIdentity(post.authorProfileId) !== authorIdentity(input.author.profileId))) stale("The post or its author changed.");
  if (input.readAt > now || input.readAt <= now - LIFETIME) stale("Read this room again before judging it.");
  const [channel] = campaign.channelId === null ? [] : await tx.select({ id: channels.id, network: channels.network,
    externalAccountId: channels.externalAccountId, executionAccountId: channels.executionAccountId,
    executionEpoch: channels.executionEpoch, executionRuntimeId: channels.executionRuntimeId,
    executionState: channels.executionState }).from(channels).where(eq(channels.id, campaign.channelId));
  if (!channel || !channel.externalAccountId || (channel.executionAccountId !== null &&
    channel.executionAccountId !== channel.externalAccountId)) stale("The connected account is unavailable.");
  const people = await selectRoomPeople(tx, campaign, input.thread, post.authorProfileId ?? input.author.profileId);
  const guard = contextHash({ audience: effectiveAudience(campaign), channel,
    post: { id: post.id, postUrn: post.postUrn, authorProfileId: post.authorProfileId, contentText: post.contentText, postedAt: post.postedAt } });
  // Include canonical identities and every assigned evidence reference, not
  // just the denominator: an alias or exclusion changes what a verdict means.
  return { campaign, post, people, guard, peopleHash: contextHash(people) };
}

export async function prepareHostRoomRead(tx: Tx, raw: unknown, credentialBinding: string, now = Date.now()) {
  const input = hostRoomReadSchema.parse(raw);
  const current = await currentRead(tx, input, now);
  const claims: Claims = { organizationId: current.campaign.organizationId, credential: contextHash(credentialBinding),
    campaignId: input.campaignId, postId: input.discoveredPostId, audienceRevision: input.audienceRevision,
    input: contextHash(input), guard: current.guard, people: current.peopleHash, issuedAt: now, expiresAt: now + LIFETIME };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { contextToken: `${PREFIX}.${payload}.${signature(payload).toString("base64url")}`,
    expiresAt: claims.expiresAt, audienceRevision: input.audienceRevision,
    people: current.people.map((person) => ({ personRef: person.ref,
      comments: person.comments.map((comment) => ({ evidenceRef: comment.ref,
        commentIndex: Number(comment.ref.slice("comment-".length)) })) })) };
}

/** Validate the frozen selection again inside the verdict's transaction.
 * This is evidence binding, never authorization to publish or call a model. */
export async function validateHostRoomRead(tx: Tx, campaign: Campaign, raw: unknown,
  token: string, credentialBinding: string, now = Date.now()) {
  const claims = readClaims(token, now);
  const input = hostRoomReadSchema.parse(raw);
  if (claims.organizationId !== campaign.organizationId || claims.campaignId !== campaign.id ||
    input.campaignId !== campaign.id || claims.credential !== contextHash(credentialBinding) ||
    claims.postId !== input.discoveredPostId || claims.audienceRevision !== input.audienceRevision ||
    claims.input !== contextHash(input)) stale("The submitted read does not match its frozen evidence.");
  const current = await currentRead(tx, input, now);
  if (current.guard !== claims.guard || current.peopleHash !== claims.people) stale("The selected people or campaign evidence changed.");
  return { ...current, input };
}
