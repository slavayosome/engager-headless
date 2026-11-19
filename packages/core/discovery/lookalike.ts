import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, channels, engagedProfiles, conversations, searchLookalikes, type LookalikeProposalJson, type PostThreadJson } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { lockPauses, pausesTouching, scopesOf } from "../actions/pause";
import { scopedStop } from "../actions/stops";
import { effectiveAudience } from "../audience/model";
import { enqueue } from "../jobs/queue";
import { lockSearchMap, phraseSource } from "../leads/scout/map";
import { addSearchSource, addPhrase, placeOfLink } from "../leads/scout/mapEdits";
import { postUrnFromUrl, linkedinPostUrl } from "../linkedin/postUrl";
import { THREAD_READ_TTL_MS } from "../operations/researchReads";
import { getSystemState, lockEngagementSafety } from "../ratelimit/killswitch";
import { lockRoomEvidence } from "../rooms/eligibility";
import { excludedRoomKeys } from "../rooms/retention";
import { selectRoomPeople } from "../rooms/room";

export const LOOKALIKE_READ_FAILED = "Engager couldn't read that post's comments.";
export const lookalikeHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse(code: string, message: string): never { throw new AppError(code, message, 409); }

/** No source text is retained for lookalikes. The guard binds the Audience,
 * connected account and exclusion set; an exclusion invalidates cached
 * suggestions rather than retaining a shadow directory of comment authors. */
export async function lookalikeContext(tx: Tx, campaignId: number) {
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  await lockRoomEvidence(tx);
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).for("update");
  if (!campaign || campaign.deletedAt !== null || campaign.status === "archived") {
    refuse("campaign_not_found", "This campaign is no longer available.");
  }
  const [channel] = campaign.channelId == null ? [] : await tx.select().from(channels).where(eq(channels.id, campaign.channelId));
  if (!channel?.externalAccountId || (channel.executionAccountId !== null && channel.executionAccountId !== channel.externalAccountId)) {
    refuse("account_unavailable", "Connect this campaign's LinkedIn account before reading a room.");
  }
  const safety = await getSystemState(tx);
  if (safety?.killSwitch || channel.pausedUntil !== null && channel.pausedUntil > Date.now() ||
    await scopedStop(tx, { campaignId, channelId: channel.id, origin: "owner" })) {
    refuse("lookalike_stopped", "Reading is stopped. No new room was read.");
  }
  const excluded = await excludedRoomKeys(tx);
  const blocked = await tx.select({ profileId: engagedProfiles.profileId }).from(engagedProfiles)
    .where(eq(engagedProfiles.doNotEngage, true));
  for (const person of blocked) excluded.add(`p.${person.profileId}`);
  const closed = await tx.select({ profileId: conversations.authorProfileId }).from(conversations)
    .where(and(eq(conversations.channelId, channel.id), sql`${conversations.closedReason} is not null`,
      sql`not exists (select 1 from conversations newer where newer.channel_id = ${conversations.channelId}
        and newer.author_profile_id = ${conversations.authorProfileId} and newer.id > ${conversations.id})`));
  for (const person of closed) excluded.add(`p.${person.profileId}`);
  const stops = await pausesTouching(tx, scopesOf({ channelId: channel.id, campaignId, conversationId: null }), 0);
  const contextRevision = lookalikeHash({ audience: effectiveAudience(campaign),
    safetyRevision: safety?.updatedAt ?? null, stopGeneration: Math.max(0, ...stops.map((stop) => stop.generation)), channel: {
    id: channel.id, account: channel.externalAccountId, executionAccount: channel.executionAccountId,
    epoch: channel.executionEpoch, runtime: channel.executionRuntimeId, state: channel.executionState,
  }, excluded: [...excluded].sort() });
  return { campaign, channel, excluded, contextRevision };
}

export async function requestLookalike(tx: Tx, campaignId: number, url: string,
  options: { hostRead?: boolean; now?: number } = {}) {
  const postUrn = postUrnFromUrl(url);
  if (!postUrn) refuse("not_a_post", "This isn't a LinkedIn post link.");
  const now = options.now ?? Date.now();
  const current = await lookalikeContext(tx, campaignId);
  // A campaign that finds leads reads the room onto its own map
  // (`leads/scout/room.ts`), never into these searches.
  const target = "lead_searches";
  await lockSearchMap(tx, campaignId);
  const [cached] = await tx.select().from(searchLookalikes).where(and(
    eq(searchLookalikes.campaignId, campaignId), eq(searchLookalikes.postUrn, postUrn), eq(searchLookalikes.target, target),
    eq(searchLookalikes.contextRevision, current.contextRevision),
    inArray(searchLookalikes.status, ["read", "reading"]),
    sql`coalesce(${searchLookalikes.readAt}, ${searchLookalikes.createdAt}) >= ${now - THREAD_READ_TTL_MS}`,
    sql`coalesce(${searchLookalikes.readAt}, ${searchLookalikes.createdAt}) <= ${now}`,
  )).orderBy(desc(searchLookalikes.id)).limit(1);
  if (cached && !(cached.status === "reading" && cached.readStartedAt !== null && cached.readStartedAt < now - 10 * 60_000)) return cached;
  if (cached) await failLookalike(tx, campaignId, cached.id, "read_failed", "read_interrupted");
  const [row] = await tx.insert(searchLookalikes).values({ campaignId, channelId: current.channel.id,
    audienceRevision: current.campaign.audienceRevision, contextRevision: current.contextRevision,
    postUrn, url: linkedinPostUrl(null, postUrn), status: "reading", reader: options.hostRead ? "agent" : "server", target, createdAt: now }).returning();
  if (!options.hostRead) await enqueue(tx, { type: "search_lookalike", payload: { campaignId, lookalikeId: row!.id },
    idempotencyKey: `search-lookalike:${row!.id}` });
  return row!;
}

/** Request a room read and wait for its existing worker to finish. */
export async function requestAndWaitSearchLookalike(
  scope: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>,
  campaignId: number,
  url: string,
  signal: AbortSignal,
) {
  const row = await scope(tx => requestLookalike(tx, campaignId, url));
  const deadline = Date.now() + 90_000;
  while (true) {
    const current = await scope(tx => readLookalike(tx, campaignId, row.id));
    if (current.status !== "reading" || Date.now() >= deadline) return { ...current, lookalikeId: row.id };
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new AppError("request_cancelled", "The room request remains saved.", 409)); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(3000, deadline - Date.now()));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export async function readLookalike(tx: Tx, campaignId: number, lookalikeId: number) {
  const [row] = await tx.select().from(searchLookalikes).where(and(
    eq(searchLookalikes.campaignId, campaignId), eq(searchLookalikes.id, lookalikeId),
    eq(searchLookalikes.target, "lead_searches")));
  if (!row) refuse("lookalike_not_found", "That room request is no longer available.");
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign || campaign.deletedAt !== null) refuse("campaign_not_found", "This campaign is no longer available.");
  let stale = true;
  try { stale = row.contextRevision !== (await lookalikeContext(tx, campaignId)).contextRevision; }
  catch (error) { if (!(error instanceof AppError)) throw error; }
  const pains = effectiveAudience(campaign).profile.pains;
  const interrupted = row.status === "reading" && row.readStartedAt !== null && row.readStartedAt < Date.now() - 10 * 60_000;
  return { ...row, ...(interrupted ? { status: "failed" as const, failure: "read_failed" as const, refusalReason: "read_interrupted" } : {}),
    stale, painTexts: row.pains.flatMap((heard) => {
    const pain = pains.find((pain) => pain.id === heard.painId && pain.status === "active");
    return pain ? [pain.text] : [];
  }) };
}

export async function latestLookalike(tx: Tx, campaignId: number) {
  const [row] = await tx.select({ id: searchLookalikes.id }).from(searchLookalikes)
    .where(and(eq(searchLookalikes.campaignId, campaignId), eq(searchLookalikes.target, "lead_searches")))
    .orderBy(desc(searchLookalikes.id)).limit(1);
  return row ? readLookalike(tx, campaignId, row.id) : null;
}

export type LookalikeView = Awaited<ReturnType<typeof readLookalike>>;

/** Freeze references only in memory. Neither the thread nor the selected
 * people are stored on the request, job or result. */
export async function prepareLookalike(tx: Tx, campaignId: number, lookalikeId: number, thread: PostThreadJson) {
  if (!thread.author?.profileId) refuse("lookalike_author_missing", "The read must identify the post's actual author before judging its room.");
  const current = await lookalikeContext(tx, campaignId);
  const [row] = await tx.select().from(searchLookalikes).where(and(eq(searchLookalikes.campaignId, campaignId),
    eq(searchLookalikes.id, lookalikeId), eq(searchLookalikes.target, "lead_searches"))).for("update");
  if (!row || row.status !== "reading" || row.contextRevision !== current.contextRevision || row.postUrn !== thread.postUrn) {
    refuse("lookalike_stale", "The account, Audience or room request changed. Read the room again.");
  }
  const people = await selectRoomPeople(tx, current.campaign, thread, thread.author?.profileId ?? null);
  return { ...current, row, people, peopleHash: lookalikeHash(people) };
}

export async function failLookalike(tx: Tx, campaignId: number, lookalikeId: number,
  failure: "read_refused" | "read_failed", reason: string | null = null) {
  await tx.update(searchLookalikes).set({ status: "failed", failure, refusalReason: reason, readAt: Date.now() })
    .where(and(eq(searchLookalikes.campaignId, campaignId), eq(searchLookalikes.id, lookalikeId), eq(searchLookalikes.status, "reading")));
}

/** The key the search map holds a stored proposal by: a phrase's, or the
 * place its source link names. */
function mapKeyOf(proposal: LookalikeProposalJson): string | null {
  if (proposal.source) return placeOfLink(proposal.source.link)?.sourceKey ?? null;
  const phrase = phraseSource(proposal.term);
  return phrase.ok ? phrase.sourceKey : null;
}

/** A proposal from a room read onto a search map lands only now, as an edit
 * of the owner's own: a phrase, grouped under Like a post, or a place to read,
 * under Audience magnet. Nothing of it was on the map before this press. */
async function addToSearchMap(tx: Tx, current: Awaited<ReturnType<typeof lookalikeContext>>,
  row: typeof searchLookalikes.$inferSelect, index: number, now: number) {
  const proposal = row.proposals[index]!;
  const sourceKey = mapKeyOf(proposal);
  if (!sourceKey || (!proposal.source && !proposal.languageType)) refuse("invalid_proposal", "That saved search is no longer valid.");
  if (proposal.state === "added") return { ok: true as const, sourceKey, message: "Already added." };
  if (row.contextRevision !== current.contextRevision || proposal.state !== "open") refuse("stale", "These suggestions changed. Read the room again.");
  const activePain = effectiveAudience(current.campaign).profile.pains.some((pain) => pain.status === "active" && pain.id === proposal.painId);
  if (proposal.painId && !activePain) refuse("stale", "That search no longer matches the current Audience.");
  const edit = proposal.source
    ? await addSearchSource(tx, row.campaignId, { link: proposal.source.link, name: proposal.displayName, role: proposal.source.role }, now)
    : await addPhrase(tx, row.campaignId, { term: proposal.term, languageType: proposal.languageType!, painId: proposal.painId, origin: "like_a_post" }, now);
  if (!edit.ok) refuse(edit.code, edit.message);
  await tx.update(searchLookalikes).set({ proposals: row.proposals.map((item, at) => at === index ? { ...item, state: "added" as const } : item) })
    .where(eq(searchLookalikes.id, row.id));
  return { ok: true as const, sourceKey, message: "Added. The next run reads it." };
}

/** Add only a server-stored proposal. Search identity and the original reason
 * survive a revival; an already-active source is never overwritten. A room
 * read onto a search map is added to the map instead, as the owner's. */
export async function addLookalikeSearch(tx: Tx, campaignId: number, lookalikeId: number, index: number, now = Date.now()) {
  const current = await lookalikeContext(tx, campaignId);
  await lockSearchMap(tx, campaignId);
  const [row] = await tx.select().from(searchLookalikes).where(and(eq(searchLookalikes.campaignId, campaignId),
    eq(searchLookalikes.id, lookalikeId), eq(searchLookalikes.target, "lead_searches"))).for("update");
  if (!row || row.status !== "read" || !Number.isInteger(index) || index < 0 || !row.proposals[index]) {
    refuse("invalid_proposal", "Choose a search from this room's saved suggestions.");
  }
  return addToSearchMap(tx, current, row, index, now);
}

export async function skipLookalikeProposal(tx: Tx, campaignId: number, lookalikeId: number, index: number) {
  await lockSearchMap(tx, campaignId);
  const [row] = await tx.select().from(searchLookalikes).where(and(eq(searchLookalikes.campaignId, campaignId),
    eq(searchLookalikes.id, lookalikeId), eq(searchLookalikes.target, "lead_searches"))).for("update");
  if (!row || row.status !== "read" || !Number.isInteger(index) || index < 0 || !row.proposals[index]) {
    refuse("invalid_proposal", "Choose a search from this room's saved suggestions.");
  }
  if (row.proposals[index]!.state !== "open") return;
  await tx.update(searchLookalikes).set({ proposals: row.proposals.map((item, at) => at === index ? { ...item, state: "skipped" as const } : item) })
    .where(eq(searchLookalikes.id, row.id));
}
