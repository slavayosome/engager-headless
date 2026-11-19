import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { authorProfiles, campaigns, candidateResearch, discoveredPosts, roomSnapshots } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { CapabilitySurface } from "../connector/resolve";
import {
  MAX_THREAD_COMMENTS,
  type AuthorProfileRead,
  type PostThread,
} from "../linkedin/driver";
import { channelCeilings, reserveResearchRead } from "../ratelimit/ledger";
import { truncateChars } from "./postSnippets";
import { lockRoomEvidence, ROOM_RETENTION_MS } from "../rooms/eligibility";
import { excludedRoomKeys, rememberExcludedRoomAliases, withoutExcludedRoomComments } from "../rooms/retention";
import { roomPeople } from "../rooms/read";
import { readRoomInsights } from "../rooms/insights";
import { authorIdentity } from "../people/key";

export type RoomDraftingContext = {
  people: Array<{ name: string | null; headline: string | null; comment: string; pain: string | null }>;
  insights: Array<{ kind: "pain" | "objection" | "open_question"; text: string;
    sources: Array<{ name: string | null; comment: string }> }>;
};

export function canAnswerRoom(room: RoomDraftingContext | null | undefined): boolean {
  return room?.insights.some((insight) => insight.kind === "pain" || insight.kind === "open_question") ?? false;
}

/** One bounded source for post drafts and per-person replies. Partial erasure
 * removes the affected people and citations; an old Audience never supplies
 * current drafting evidence. Unjudged posts keep their original context. */
export async function readRoomForDrafting(tx: Tx, discoveredPostId: number): Promise<RoomDraftingContext | null> {
  const [row] = await tx.select({ summary: candidateResearch.roomSummary, revision: roomSnapshots.audienceRevision,
    currentRevision: campaigns.audienceRevision, readAt: roomSnapshots.readAt, author: discoveredPosts.authorProfileId })
    .from(candidateResearch)
    .innerJoin(campaigns, eq(campaigns.id, candidateResearch.campaignId))
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, candidateResearch.discoveredPostId))
    .innerJoin(roomSnapshots, eq(roomSnapshots.id, candidateResearch.roomSnapshotId))
    .where(and(eq(candidateResearch.discoveredPostId, discoveredPostId), eq(candidateResearch.verdict, "confirmed")));
  const now = Date.now();
  if (!row?.summary || row.revision !== row.currentRevision || row.readAt <= now - ROOM_RETENTION_MS || row.readAt > now) return null;
  const excluded = await excludedRoomKeys(tx);
  if (row.author && excluded.has(`p.${authorIdentity(row.author)}`)) return null;
  const people = (await roomPeople(tx, { discoveredPostIds: [discoveredPostId] })).get(discoveredPostId);
  if (!people) return null;
  const insights = (await readRoomInsights(tx, [discoveredPostId], now)).get(discoveredPostId) ?? [];
  return {
    people: people.fits.slice(0, 8).map((person) => ({ name: person.name, headline: person.headline,
      comment: truncateChars(person.comment, 280), pain: person.painText })),
    insights: insights.map((insight) => ({ kind: insight.kind, text: insight.text,
      sources: insight.sources.slice(0, 8).map((source) => ({ name: source.authorName, comment: truncateChars(source.text, 280) })) })),
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A thread moves while it is open, so a read of it is good for hours. */
export const THREAD_READ_TTL_MS = 6 * HOUR;
/** A profile barely moves, and one read serves every post by that author. */
export const PROFILE_READ_TTL_MS = 14 * DAY;
/** Comments a thread read asks for when the caller names no number. */
export const DEFAULT_MAX_THREAD_COMMENTS = 20;

/** The candidate a read is for. */
export type ResearchTarget = {
  campaignId: number;
  discoveredPostId: number;
};

export type ResearchReadResult<T> =
  /** Read now, and stored on the candidate's research row. */
  | { status: "read"; value: T; readAt: number }
  /** A read still inside its TTL answered; nothing was spent. */
  | { status: "cached"; value: T; readAt: number }
  /** The account's read budget, window or stops said no; nothing was read. */
  | { status: "refused"; reason: string; retryAt?: number }
  /** The connector has no such read. */
  | { status: "unsupported" };

type ThreadReadResult = ResearchReadResult<PostThread> & { returnedComments?: number };

/**
 * One post read in full with its thread, for verifying the candidate it is.
 *
 * A read inside {@link THREAD_READ_TTL_MS} answers from the candidate's
 * research row and spends nothing. Otherwise the read is reserved against the
 * account's daily budget in a transaction of its own — so a read that then
 * fails has still spent its row — performed outside any transaction, and its
 * snapshot stored on the research row with no verdict. Each step is its own
 * `withOrg`, because a page load must never hold a database transaction open.
 *
 * Nothing here serializes two reads of one post: the caller holds the
 * account's session lease, which no sweep or send shares, so two reads of one
 * candidate cannot both miss the cache.
 */
export async function readPostThread(opts: {
  organizationId: string;
  driver: CapabilitySurface<"thread_read">;
  target: ResearchTarget & { postUrn: string };
  maxComments?: number;
  now?: number;
  /** Awaited once the cache has missed and the budget has said yes, just
   *  before the page loads — where a caller spaces its page loads. */
  beforeLoad?: () => Promise<void>;
}): Promise<ThreadReadResult> {
  const { organizationId, driver, target } = opts;
  const now = opts.now ?? Date.now();
  if (!driver.readPostThread) return { status: "unsupported" };
  // Bounded before the budget is spent: a connector refuses an out-of-range
  // ask, and by then its row would already be gone.
  const maxComments = Math.min(
    MAX_THREAD_COMMENTS,
    Math.max(0, Math.floor(opts.maxComments ?? DEFAULT_MAX_THREAD_COMMENTS)),
  );

  const cached = await withOrg(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        thread: candidateResearch.thread,
        readAt: candidateResearch.threadReadAt,
        pages: roomSnapshots.pages,
      })
      .from(candidateResearch)
      .leftJoin(roomSnapshots, eq(roomSnapshots.id, candidateResearch.roomSnapshotId))
      .where(
        and(
          eq(candidateResearch.discoveredPostId, target.discoveredPostId),
          gte(candidateResearch.threadReadAt, now - THREAD_READ_TTL_MS),
        ),
      );
    // A cached preview is sufficient only when it already contains the
    // requested sample or every comment the provider reports.
    // A combined read cannot pretend to be a fresh first page. It may contain
    // page-two people even when exclusions left fewer than fifty comments.
    return row?.thread && row.pages !== 2 && row.readAt != null && row.thread.comments.length >= Math.min(maxComments, row.thread.counts.comments)
      ? { thread: await withoutExcludedRoomComments(tx, row.thread), readAt: row.readAt }
      : null;
  });
  if (cached) {
    return { status: "cached", value: cached.thread, readAt: cached.readAt, returnedComments: cached.thread.comments.length };
  }

  const refused = await reserve(organizationId, {
    read: "thread_read",
    campaignId: target.campaignId,
    now,
  });
  if (refused) return refused;
  await opts.beforeLoad?.();

  const thread = await driver.readPostThread(target.postUrn, { maxComments });
  const value = await withOrg(organizationId, async (tx) => {
    await lockRoomEvidence(tx);
    await rememberExcludedRoomAliases(tx, thread, now);
    const filtered = await withoutExcludedRoomComments(tx, thread);
    await storeResearch(tx, target, { thread: filtered, threadReadAt: now });
    return filtered;
  });
  return { status: "read", value, readAt: now, returnedComments: thread.comments.length };
}

/** An additional page is its own budgeted read. It bypasses the cache and
 * leaves the first-page snapshot intact; the caller commits combined evidence
 * only after it has been judged. */
export async function readPostThreadPage(opts: {
  organizationId: string;
  driver: CapabilitySurface<"thread_read">;
  target: ResearchTarget & { postUrn: string };
  start: number;
  order?: "relevance" | "recent";
  now?: number;
  beforeLoad?: () => Promise<void>;
}): Promise<ResearchReadResult<PostThread>> {
  if (!Number.isInteger(opts.start) || opts.start < 0 || opts.start > 100) throw new RangeError("Thread page start must be an integer from 0 to 100.");
  if (!opts.driver.readPostThread) return { status: "unsupported" };
  const now = opts.now ?? Date.now();
  const refused = await reserve(opts.organizationId, { read: "thread_read", campaignId: opts.target.campaignId, now });
  if (refused) return refused;
  await opts.beforeLoad?.();
  const value = await opts.driver.readPostThread(opts.target.postUrn, {
    maxComments: MAX_THREAD_COMMENTS, start: opts.start, order: opts.order ?? "relevance",
  });
  const filtered = await withOrg(opts.organizationId, async (tx) => {
    await rememberExcludedRoomAliases(tx, value, now);
    return withoutExcludedRoomComments(tx, value);
  });
  return { status: "read", value: filtered, readAt: now };
}

/** Where a profile read placed the person: what their location names, or
 *  null for none. */
export type PersonPlace = { country: string | null };

/**
 * Where one of a room's fitting people is: their profile read for the country
 * its location names, under the account's research budget, as an author's
 * is. The read also visits their profile. What it found lands on the person's
 * cache row, which {@link knownPlaces} answers from. Check it again here so
 * a read completed since the caller's batch lookup is not spent twice.
 */
export async function readPersonPlace(opts: {
  organizationId: string;
  driver: CapabilitySurface<"profile_read">;
  campaignId: number;
  profileId: string;
  now?: number;
  /** See {@link readPostThread}. */
  beforeLoad?: () => Promise<void>;
}): Promise<ResearchReadResult<PersonPlace>> {
  const { organizationId, driver } = opts;
  const now = opts.now ?? Date.now();
  const cached = await withOrg(organizationId, async (tx) =>
    (await knownPlaces(tx, [opts.profileId], now)).get(authorIdentity(opts.profileId)),
  );
  if (cached) return { status: "cached", value: { country: cached.country }, readAt: cached.readAt };
  if (!driver.readAuthorProfile) return { status: "unsupported" };
  const refused = await reserve(organizationId, {
    read: "profile_read",
    campaignId: opts.campaignId,
    profileId: opts.profileId,
    now,
  });
  if (refused) return refused;
  await opts.beforeLoad?.();
  const read = await driver.readAuthorProfile(opts.profileId);
  const place = await withOrg(organizationId, async (tx) => {
    const found = await rememberPlace(tx, opts.profileId, read, now);
    await storeProfileRead(tx, opts.profileId, { ...read, ...found }, now);
    return found;
  });
  return { status: "read", value: { country: place.country ?? null }, readAt: now };
}

/** The most of a profile's text kept on the person's row. */
const ABOUT_MAX_CHARS = 2_000;
const RECENT_POSTS_MAX = 10;
const RECENT_POST_MAX_CHARS = 1_000;

/** A profile read, and when it was made. */
export type StoredProfileRead = { read: AuthorProfileRead; readAt: number };

/** The profile reads these people have, by profile id, however old. A
 *  person is read once, whichever path read them: Research, a lead's
 *  qualify, a room's places. */
export async function profileReads(tx: Tx, profileIds: readonly string[]): Promise<Map<string, StoredProfileRead>> {
  const ids = [...new Set(profileIds.map(authorIdentity))];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ profileId: authorProfiles.profileId, read: authorProfiles.profileRead, readAt: authorProfiles.profileReadAt })
    .from(authorProfiles)
    .where(and(inArray(authorProfiles.profileId, ids), isNotNull(authorProfiles.profileRead)));
  return new Map(rows.flatMap((row) => (row.read && row.readAt !== null ? [[row.profileId, { read: row.read, readAt: row.readAt }] as const] : [])));
}

/** A read of this person still inside {@link PROFILE_READ_TTL_MS}, if any. */
export async function freshProfileRead(tx: Tx, profileId: string, now: number): Promise<StoredProfileRead | null> {
  const stored = (await profileReads(tx, [profileId])).get(authorIdentity(profileId));
  return stored && stored.readAt >= now - PROFILE_READ_TTL_MS ? stored : null;
}

/** A profile read on the person's cache row, bounded, still LinkedIn text held
 *  as data. An older read never replaces a newer one. */
export async function storeProfileRead(tx: Tx, profileId: string, read: AuthorProfileRead, readAt: number): Promise<void> {
  const kept: AuthorProfileRead = {
    ...read,
    ...(read.about === undefined ? {} : { about: truncateChars(read.about, ABOUT_MAX_CHARS) }),
    recentPosts: read.recentPosts
      .slice(0, RECENT_POSTS_MAX)
      .map((post) => ({ ...post, text: truncateChars(post.text, RECENT_POST_MAX_CHARS) })),
  };
  await tx
    .insert(authorProfiles)
    .values({ profileId: authorIdentity(profileId), profileRead: kept, profileReadAt: readAt, fetchedAt: 0 })
    .onConflictDoUpdate({
      target: [authorProfiles.organizationId, authorProfiles.profileId],
      set: { profileRead: kept, profileReadAt: readAt },
      setWhere: or(isNull(authorProfiles.profileReadAt), lte(authorProfiles.profileReadAt, readAt)),
    });
}

/** Where a profile read inside {@link PROFILE_READ_TTL_MS} placed each of
 *  these people, by profile id; a person not in the map has no such read. */
export async function knownPlaces(
  tx: Tx,
  profileIds: readonly string[],
  now: number,
): Promise<Map<string, PersonPlace & { readAt: number }>> {
  const ids = [...new Set(profileIds.map(authorIdentity))];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ profileId: authorProfiles.profileId, country: authorProfiles.country, readAt: authorProfiles.countryReadAt })
    .from(authorProfiles)
    .where(and(inArray(authorProfiles.profileId, ids), gte(authorProfiles.countryReadAt, now - PROFILE_READ_TTL_MS)));
  return new Map(rows.map((row) => [row.profileId, { country: row.country, readAt: row.readAt! }]));
}

/**
 * A profile read's place on the person's cache row, and the place it leaves
 * there — a Research read's, or a relationship read's that looked
 * (`conversations/record.ts`). A read that names no country leaves the one an
 * earlier read found, and its geo: a known place is never overwritten by an
 * unknown one, on the row or in what this returns to the read.
 */
export async function rememberPlace(
  tx: Tx,
  profileId: string,
  read: Pick<AuthorProfileRead, "country" | "geoUrn">,
  readAt: number,
): Promise<Pick<AuthorProfileRead, "country" | "geoUrn">> {
  const [row] = await tx
    .insert(authorProfiles)
    .values({
      profileId: authorIdentity(profileId),
      country: read.country ?? null,
      geoUrn: read.geoUrn ?? null,
      countryReadAt: readAt,
      fetchedAt: 0,
    })
    .onConflictDoUpdate({
      target: [authorProfiles.organizationId, authorProfiles.profileId],
      set: {
        country: sql`coalesce(excluded.country, ${authorProfiles.country})`,
        geoUrn: sql`coalesce(excluded.geo_urn, ${authorProfiles.geoUrn})`,
        countryReadAt: sql`greatest(excluded.country_read_at, ${authorProfiles.countryReadAt})`,
      },
    })
    .returning({ country: authorProfiles.country, geoUrn: authorProfiles.geoUrn });
  return { ...(row?.country ? { country: row.country } : {}), ...(row?.geoUrn ? { geoUrn: row.geoUrn } : {}) };
}

/** The read's reservation, committed on its own; null when it may proceed. */
async function reserve(
  organizationId: string,
  opts: {
    read: "thread_read" | "profile_read";
    campaignId: number;
    profileId?: string;
    now: number;
  },
): Promise<Extract<ResearchReadResult<never>, { status: "refused" }> | null> {
  return withOrg(organizationId, async (tx) => {
    const channel = await channelCeilings(tx);
    if (!channel) return { status: "refused", reason: "no_channel" };
    const decision = await reserveResearchRead({ db: tx, channel, ...opts });
    if (decision.ok) return null;
    return {
      status: "refused",
      reason: decision.reason,
      ...(decision.retryAt != null ? { retryAt: decision.retryAt } : {}),
    };
  });
}

/** Write a candidate's thread read, leaving the rest of its research and any
 *  verdict as they are. A null read time is research no read of this server
 *  made — a host's — which the read cache above never serves. */
export async function storeResearch(
  tx: Tx,
  target: ResearchTarget,
  read: { thread: PostThread; threadReadAt: number | null },
): Promise<void> {
  const now = Date.now();
  await lockRoomEvidence(tx);
  await rememberExcludedRoomAliases(tx, read.thread, now);
  const stored = { ...read, thread: await withoutExcludedRoomComments(tx, read.thread) };
  await tx
    .insert(candidateResearch)
    .values({
      campaignId: target.campaignId,
      discoveredPostId: target.discoveredPostId,
      ...stored,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        candidateResearch.organizationId,
        candidateResearch.discoveredPostId,
      ],
      set: { ...stored, updatedAt: now },
    });
}

/** What drafting reads off a confirmed verify: the post's thread, its author,
 *  the play, and what the thread already said. */
export type VerifiedResearch = {
  thread: PostThread;
  author: AuthorProfileRead | null;
  play: NonNullable<(typeof candidateResearch.$inferSelect)["play"]>;
  authorReplyRate: number | null;
  alreadySaid: string[];
};

/**
 * The confirmed research behind one candidate, or null. Only a confirmation
 * carries a play, and only a read the verify stage judged is evidence a
 * writer may lean on.
 */
export async function readVerifiedResearch(
  tx: Tx,
  discoveredPostId: number,
): Promise<VerifiedResearch | null> {
  const [row] = await tx
    .select({
      thread: candidateResearch.thread,
      authorProfileId: discoveredPosts.authorProfileId,
      play: candidateResearch.play,
      authorReplyRate: candidateResearch.authorReplyRate,
      alreadySaid: candidateResearch.alreadySaid,
    })
    .from(candidateResearch)
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, candidateResearch.discoveredPostId))
    .where(
      and(
        eq(candidateResearch.discoveredPostId, discoveredPostId),
        eq(candidateResearch.verdict, "confirmed"),
      ),
    );
  if (!row?.thread || !row.play) return null;
  return {
    thread: await withoutExcludedRoomComments(tx, row.thread),
    author: row.authorProfileId ? ((await profileReads(tx, [row.authorProfileId])).get(authorIdentity(row.authorProfileId))?.read ?? null) : null,
    play: row.play,
    authorReplyRate: row.authorReplyRate,
    alreadySaid: row.alreadySaid,
  };
}

/** What a card shows of a confirmed verify: enough to say why it is worth
 *  a comment, without the whole read. Every word in it is the author's, the
 *  comment authors' or a model's reading of them: untrusted, shown as plain text. */
export type VerifiedResearchSummary = {
  play: VerifiedResearch["play"];
  counts: PostThread["counts"];
  authorReplyRate: number | null;
  alreadySaid: string[];
  authorHeadline: string | null;
  /** Who the author is, as their profile read says: their headline, else
   *  their role. */
  authorLine: string | null;
  /** The verify's one line on the post and its thread. */
  reason: string | null;
  /** Who is already in the thread: its most-reacted comments, the owner's
   *  own left out, each by name. */
  topComments: { authorName: string; text: string }[];
};

/** How many of the thread's comments a card names. */
export const TOP_COMMENTS = 3;
/** The most of one comment a card quotes. */
const TOP_COMMENT_TEXT_MAX = 280;

/** The confirmed research rows behind these candidates. */
async function confirmedResearch(tx: Tx, discoveredPostIds: number[]) {
  if (discoveredPostIds.length === 0) return [];
  const rows = await tx
    .select({
      discoveredPostId: candidateResearch.discoveredPostId,
      thread: candidateResearch.thread,
      authorProfileId: discoveredPosts.authorProfileId,
      play: candidateResearch.play,
      authorReplyRate: candidateResearch.authorReplyRate,
      alreadySaid: candidateResearch.alreadySaid,
      reason: candidateResearch.reason,
    })
    .from(candidateResearch)
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, candidateResearch.discoveredPostId))
    .where(
      and(
        inArray(candidateResearch.discoveredPostId, discoveredPostIds),
        eq(candidateResearch.verdict, "confirmed"),
      ),
    );
  const authors = await profileReads(tx, rows.flatMap((row) => (row.authorProfileId ? [row.authorProfileId] : [])));
  return Promise.all(rows.map(async ({ authorProfileId, ...row }) => ({ ...row,
    author: authorProfileId ? (authors.get(authorIdentity(authorProfileId))?.read ?? null) : null,
    thread: row.thread ? await withoutExcludedRoomComments(tx, row.thread) : null,
  })));
}

type ResearchRow = Awaited<ReturnType<typeof confirmedResearch>>[number];

/** The author as one line: their headline, else what they do and where. */
function authorLineOf(author: AuthorProfileRead | null): string | null {
  const headline = author?.headline?.trim();
  if (headline) return headline;
  const role = [author?.currentRole?.title?.trim(), author?.currentRole?.company?.trim()].filter(Boolean);
  return role.length > 0 ? role.join(" at ") : null;
}

/** The thread's most-reacted comments by people other than the owner, each
 *  by the name it was read under; one with no name is nobody to name. */
function topCommentsOf(thread: PostThread): VerifiedResearchSummary["topComments"] {
  return thread.comments
    .flatMap((comment) => {
      const authorName = comment.authorName?.trim();
      const text = comment.text.trim();
      return !comment.isOwner && authorName && text ? [{ authorName, text, reactions: comment.reactions }] : [];
    })
    .sort((a, b) => b.reactions - a.reactions)
    .slice(0, TOP_COMMENTS)
    .map(({ authorName, text }) => ({ authorName, text: truncateChars(text, TOP_COMMENT_TEXT_MAX) }));
}

function summaryOf(
  row: ResearchRow & { thread: PostThread; play: VerifiedResearch["play"] },
): VerifiedResearchSummary {
  return {
    play: row.play,
    counts: row.thread.counts,
    authorReplyRate: row.authorReplyRate,
    alreadySaid: row.alreadySaid,
    authorHeadline: row.author?.headline ?? null,
    authorLine: authorLineOf(row.author),
    reason: row.reason?.trim() || null,
    topComments: topCommentsOf(row.thread),
  };
}

/** The confirmed research behind each of these candidates, by post id. */
export async function verifiedResearchSummaries(
  tx: Tx,
  discoveredPostIds: number[],
): Promise<Map<number, VerifiedResearchSummary>> {
  return new Map(
    (await confirmedResearch(tx, discoveredPostIds)).flatMap((row) =>
      row.thread && row.play
        ? [[row.discoveredPostId, summaryOf({ ...row, thread: row.thread, play: row.play })] as const]
        : [],
    ),
  );
}

/** What a host drafting from the deck reads of a confirmed verify: the
 *  summary a card shows, plus the post itself, so nothing is drafted from the
 *  preview (spec 8). Bounded, because a deck holds many candidates; the whole
 *  read is get_drafting_context's. */
const DECK_RESEARCH_TEXT_MAX = 3_000;

export type DeckResearch = VerifiedResearchSummary & {
  fullText: string;
  mediaText: string | null;
  room?: RoomDraftingContext;
};

export async function deckResearch(
  tx: Tx,
  discoveredPostIds: number[],
): Promise<Map<number, DeckResearch>> {
  const rooms = new Map(await Promise.all(discoveredPostIds.map(async (id) => [id, await readRoomForDrafting(tx, id)] as const)));
  return new Map(
    (await confirmedResearch(tx, discoveredPostIds)).flatMap((row) =>
      row.thread && row.play
        ? [
            [
              row.discoveredPostId,
              {
                ...summaryOf({ ...row, thread: row.thread, play: row.play }),
                fullText: truncateChars(row.thread.fullText, DECK_RESEARCH_TEXT_MAX),
                mediaText: row.thread.mediaText ?? null,
                ...(rooms.get(row.discoveredPostId) ? { room: rooms.get(row.discoveredPostId)! } : {}),
              },
            ] as const,
          ]
        : [],
    ),
  );
}
