import { and, eq } from "drizzle-orm";
import {
  searchChanges,
  searches,
  searchLookalikes,
  type Campaign,
  type PostThreadJson,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../../ai/client";
import { authorIdentity } from "../../people/key";
import { getCampaign } from "../../operations/campaigns";
import { truncateChars } from "../../operations/postSnippets";
import { channelCeilings } from "../../ratelimit/ledger";
import { dismissedAuthors, lockSearchMap } from "./map";
import { inReach } from "./mapEdits";
import { planFromRoom, roomProposals } from "./mapPlan";
import { readFindLeadsStep } from "./phase";
import { keepThreadComments, parkReadRoom, recordThreadRead } from "./sweep";

/**
 * FIND MORE LIKE THIS POST, on a campaign that finds leads. The room is read
 * as Find posts reads it — the same `search_lookalikes` row and job, one thread
 * read from the account's daily reads (`jobs/handlers/searchLookalike.ts`) —
 * and the post becomes a One thread row of the owner's, whose comment authors wait
 * as signals for the next run's screen. One plan call on the room proposes
 * phrases, and its author as a source when they are a peer or a competitor;
 * the proposals are held on the lookalike row, as Find posts holds its own,
 * and land on the map only when the owner presses Add (`addLookalikeSearch`).
 * Nothing lands in `discovery_sources`, nothing Scout proposes goes live
 * unasked, no comment author is contacted, and no profile is read.
 */

type Scope = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

/** How much of a post's opening names its row. */
const TERM_OPENING_CHARS = 80;

/** What a One thread row is called: the post's opening words, as the room rows
 *  of Where buyers gather show a room, else its activity id. Never its author's
 *  name, which Never engage would then have to find here too. */
function roomTerm(thread: PostThreadJson): string {
  const opening = truncateChars(thread.fullText.replace(/\s+/g, " ").trim(), TERM_OPENING_CHARS);
  return opening || `Post ${thread.postUrn.split(":").at(-1)}`;
}

/** A post the owner pointed Scout at, as a One thread row of theirs: read just
 *  now, so it waits before it is read again. One already on the map stays as
 *  it is; one retired comes back. */
async function followRoom(tx: Tx, campaignId: number, thread: PostThreadJson, now: number): Promise<number> {
  await lockSearchMap(tx, campaignId);
  const sourceKey = `post:${thread.postUrn}`;
  const [held] = await tx
    .select()
    .from(searches)
    .where(and(eq(searches.campaignId, campaignId), eq(searches.sourceKey, sourceKey)));
  if (held && held.status !== "retired") return held.id;
  const term = roomTerm(thread);
  const values = { term, status: "parked" as const, retiredAt: null, retiredBy: null, origin: "owner" as const, updatedAt: now };
  const [row] = held
    ? await tx.update(searches).set(values).where(eq(searches.id, held.id)).returning({ id: searches.id })
    : await tx
        .insert(searches)
        .values({ ...values, campaignId, sourceKey, lane: "one_thread", targetRef: thread.postUrn, languageType: null, createdAt: now })
        .returning({ id: searches.id });
  await tx.insert(searchChanges).values({
    campaignId,
    phraseId: row!.id,
    runId: null,
    actor: "owner",
    action: "add",
    term,
    rationale: null,
    createdAt: now,
  });
  return row!.id;
}

/**
 * Land one room the account just read onto the campaign's search map, for
 * the lookalike request still reading it. Each database step is its own short
 * transaction through `scope`, and `beforeExternal` is asked before the plan
 * call and before its result lands, so a lost lease or a revoked session
 * stops it there. A model that cannot answer is the caller's failure: the room
 * row and its comment authors, already read, stay for the next run.
 */
export async function readRoomOntoMap(input: {
  scope: Scope;
  campaignId: number;
  lookalikeId: number;
  thread: PostThreadJson;
  llm: LLM;
  now: number;
  beforeExternal: () => Promise<void>;
}): Promise<void> {
  const { scope, campaignId, thread, now } = input;
  const landed = await scope(async (tx) => {
    const [request] = await tx
      .select()
      .from(searchLookalikes)
      .where(and(eq(searchLookalikes.campaignId, campaignId), eq(searchLookalikes.id, input.lookalikeId)))
      .for("update");
    const campaign = await getCampaign(tx, campaignId);
    if (!request || request.status !== "reading" || !campaign) return null;
    const visible = await recordThreadRead(tx, campaignId, request.postUrn, thread, null, now);
    const phraseId = await followRoom(tx, campaignId, { ...thread, postUrn: request.postUrn }, now);
    await parkReadRoom(tx, phraseId, now);
    await keepThreadComments(tx, {
      campaignId,
      postUrn: request.postUrn,
      thread: visible,
      url: request.url,
      phraseId,
      languageType: null,
      runId: null,
      now,
    });
    return {
      campaign,
      visible,
      instructions: (await readFindLeadsStep(tx, campaign))?.instructions ?? [],
      author: await readableAuthor(tx, campaign, thread),
    };
  });
  if (!landed) return;
  await input.beforeExternal();
  const plan = await planFromRoom({ campaign: landed.campaign, thread: landed.visible, instructions: landed.instructions, llm: input.llm });
  await input.beforeExternal();
  const commentAuthors = landed.visible.comments.flatMap((comment) => [comment.authorName, comment.authorProfileId, comment.memberUrn]);
  const proposals = roomProposals({
    campaign: landed.campaign,
    plan,
    author: landed.author,
    commentAuthors: commentAuthors.filter((name): name is string => !!name),
  });
  await scope(async (tx) => {
    await tx
      .update(searchLookalikes)
      .set({
        status: "read",
        readAt: now,
        proposals,
        authorProfileId: thread.author?.profileId ? authorIdentity(thread.author.profileId) : null,
        authorName: thread.author?.name ?? null,
        authorHeadline: thread.author?.headline ?? null,
        opening: [...thread.fullText].slice(0, 280).join(""),
        comments: thread.counts.comments,
      })
      .where(and(eq(searchLookalikes.id, input.lookalikeId), eq(searchLookalikes.status, "reading")));
  });
}

/** The post's author, when Scout may read them as a source: not the connected
 *  account, within the owner's reach, and not one the owner dismissed from
 *  Where buyers gather. */
async function readableAuthor(
  tx: Tx,
  campaign: Campaign,
  thread: PostThreadJson,
): Promise<{ profileId: string; name: string | null; isCompany: boolean } | null> {
  const author = thread.author;
  if (!author?.profileId) return null;
  const identity = authorIdentity(author.profileId);
  const account = (await channelCeilings(tx))?.externalAccountId ?? null;
  if (account !== null && authorIdentity(account) === identity) return null;
  if (!(await inReach(tx, campaign.id, identity))) return null;
  if ((await dismissedAuthors(tx, campaign.id)).has(identity)) return null;
  return { profileId: identity, name: author.name ?? null, isCompany: author.isCompany };
}
