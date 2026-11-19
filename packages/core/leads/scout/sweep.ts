import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  leadThreadReads,
  leadSourceReads,
  searches,
  type Channel,
  type LanguageType,
  type Search,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { commentCountOf } from "../../ai/rank";
import { envInt } from "../../config";
import { connectorFailureRefusal, isGrant, type CapabilitySurface } from "../../connector/resolve";
import { PAGE_LIMIT } from "../../linkedin/searchLimits";
import { MAX_SEARCH_ORS, orOperators, STRIKE_SPACING_MS } from "../../linkedin/searchRefusal";
import { authorIdentity } from "../../people/key";
import type { CapabilityGrant } from "../../jobs/context";
import { isConnectorBackoff, isSearchTooLarge } from "../../linkedin/connectorError";
import { MAX_THREAD_COMMENTS, type DriverPost, type PostThread } from "../../linkedin/driver";
import { truncateChars } from "../../operations/postSnippets";
import { THREAD_READ_TTL_MS } from "../../operations/researchReads";
import {
  channelCeilings,
  DAILY_SEARCH_LIMIT,
  reserveDiscoverCall,
  reserveResearchRead,
} from "../../ratelimit/ledger";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { refuseChannel, type Refusal } from "../../refusal";
import { lockRoomEvidence } from "../../rooms/eligibility";
import { rememberExcludedRoomAliases, withoutExcludedRoomComments } from "../../rooms/retention";
import { localClock } from "../../time";
import type { LeadRunCounts } from "./counts";
import type { LeadSweepShape } from "./shape";
import { writeSignals, type SignalInput } from "./signals";

/**
 * THE SWEEP: what Scout reads of the search map, as people's own words. It
 * reads search pages, and the comments under the threads it opens, through the
 * same reservations every read on the account takes; it reads public posts and
 * comments and nothing else, and writes `lead_signals` and the map's own rows.
 * Find posts' sweep (`discovery.ts`) is not touched: nothing here reads or
 * writes `discovered_posts`, `candidate_research` or `discovery_sources`.
 */

/** Threads one run opens: the most-commented posts it read, once it has read
 *  the map. */
export function leadThreadsPerRun(): number {
  return Math.max(0, envInt("ENGAGER_LEAD_THREADS_PER_RUN", 12));
}

/** Search pages one run may read across every row, so a long map cannot run
 *  away with the account's day. The account's hourly and daily pages bind
 *  under it. */
export function leadPagesPerRun(): number {
  return Math.max(1, envInt("ENGAGER_LEAD_PAGES_PER_RUN", 20));
}

/** How long a row read to its last page waits before it can be read from the
 *  top again, for posts newer than the ones it read. */
const DRY_ROW_WAIT_MS = 24 * 3_600_000;

/** What Scout says where the account could not be reached for the threads. */
const THREADS_UNREACHABLE = "the account could not be reached for them";

/** The most of a post or comment kept as a person's words. */
const WORDS_MAX_CHARS = 4_000;

const DAY = 86_400_000;

export type SweepInput = {
  organizationId: string;
  campaign: { id: number; maxPostAgeDays: number };
  runId: number;
  /** What this run's depth reads of the map (`leadRunShapeFor`). */
  shape: LeadSweepShape;
  now: number;
  grant: CapabilityGrant;
  /** The run's counters; the sweep adds the reads and pages it spent. */
  counts: LeadRunCounts;
  /** Write the counters as they stand, between reads. */
  report: () => Promise<void>;
  /** Renew the lease and say whether the run may go on; asked before every
   *  read of the account. */
  continueRun: () => Promise<boolean>;
  /** Asked after each row's pages and each thread have landed their words:
   *  whether the steps after the sweep can take more. A sweep told no stops and
   *  keeps what it read; one with no answer reads on. */
  mayReadMore?: () => Promise<boolean>;
};

/** A company page that wrote a post whose thread the sweep opened. A page is
 *  never a signal or a lead; the plan starts reading it as a source when buyers
 *  were in the thread (`leads/scout/mapPlan.ts`). */
export type CompanyThread = { postUrn: string; profileId: string; name: string | null };

export type SweepResult = {
  /** The first thing that kept the sweep from reading what it meant to: the
   *  account unreachable, or its search pages spent. */
  refusal: Refusal | null;
  /** The map has no phrase or source at all, so nothing was a measurement. */
  emptyMap: boolean;
  /** The people's words it met for the first time: posts and comments the
   *  campaign held no signal for. */
  fresh: number;
  notes: string[];
  /** The threads it opened under a company page's post. */
  companyThreads: CompanyThread[];
};

/** A post whose thread may be opened, with the row that found it. */
type Room = {
  postUrn: string;
  url: string | null;
  commentCount: number | null;
  postedAt: number | null;
  phraseId: number;
  languageType: LanguageType | null;
  /** A One thread row names the room itself, so it comes before any other. */
  named: boolean;
};

/** What the sweep carries from row to row. */
type Sweep = SweepInput & {
  result: SweepResult;
  /** The connected account's own profile id: its posts are never a lead's. */
  account: string | null;
  driver: CapabilitySurface<"discover">;
  pagesLeft: number;
  /** False once the account's search pages are spent or it refuses. */
  searching: boolean;
  /** The run lost its lease, the account throttled or the steps after the
   *  sweep can take no more: nothing more is read. */
  stopped: boolean;
  rooms: Room[];
  pagesSinceGate: number;
};

export async function sweepSearches(input: SweepInput): Promise<SweepResult> {
  const { organizationId, campaign, shape } = input;
  const result: SweepResult = { refusal: null, emptyMap: false, fresh: 0, notes: [], companyThreads: [] };
  const setup = await withOrg(organizationId, async (tx) => ({
    rows: await readableRows(tx, campaign.id, shape, input.now),
    mapRows: await mapSize(tx, campaign.id),
    account: (await channelCeilings(tx))?.externalAccountId ?? null,
    discover: await input.grant(tx, "discover"),
    threads: shape.threads ? await input.grant(tx, "thread_read") : null,
  }));
  if (setup.mapRows === 0) {
    result.emptyMap = true;
    return result;
  }
  if (!isGrant(setup.discover)) {
    result.refusal = setup.discover;
    return result;
  }
  if (setup.rows.length === 0) {
    result.notes.push("Nothing to read: this Scout's map has no active row at this search depth");
    return result;
  }

  const sweep: Sweep = {
    ...input,
    result,
    account: setup.account,
    driver: setup.discover.use,
    pagesLeft: leadPagesPerRun(),
    searching: true,
    stopped: false,
    rooms: [],
    pagesSinceGate: 0,
  };
  await stopWhenFull(sweep);
  for (const row of setup.rows) {
    if (sweep.stopped || !sweep.searching || sweep.pagesLeft <= 0) break;
    await readRow(sweep, row);
  }
  if (setup.threads === null) return result;
  if (!isGrant(setup.threads)) {
    result.notes.push(`Threads not opened — ${setup.threads.detail ?? THREADS_UNREACHABLE}`);
    return result;
  }
  await stopWhenFull(sweep);
  if (sweep.stopped) return result;
  await openRooms(sweep, setup.threads.use);
  return result;
}

async function pageLanded(sweep: Sweep): Promise<void> {
  sweep.pagesSinceGate++;
  if (sweep.pagesSinceGate >= Math.max(1, envInt("ENGAGER_LEAD_SWEEP_GATE_PAGES", 3))) {
    sweep.pagesSinceGate = 0;
    await stopWhenFull(sweep);
  }
}

/** Stop the sweep where the steps after it can take no more words. */
async function stopWhenFull(sweep: Sweep): Promise<void> {
  if (sweep.stopped || !sweep.mayReadMore) return;
  if (!(await sweep.mayReadMore())) sweep.stopped = true;
}

/** The rows a run of this shape reads: the campaign's active ones in its
 *  lanes, and the ones read to their last page whose wait is over — the
 *  owner's pins first, then by how long since each was checked; or, where the
 *  shape reads some language types first, those, a pin before the rest within
 *  them, then the rest by the buyers each found. A row parked for a refusal,
 *  or by the owner, waits for no time and is not read. A company page is kept
 *  on the map and not read yet, whatever its state: no read or search is spent
 *  on it until one can be (`map.ts`). */
async function readableRows(tx: Tx, campaignId: number, shape: LeadSweepShape, now: number): Promise<Search[]> {
  const order = shape.first.length
    ? [
        sql`case when ${inArray(searches.languageType, [...shape.first])} then 0 else 1 end`,
        desc(searches.pinned),
        desc(searches.buyers),
      ]
    : [desc(searches.pinned)];
  const rows = tx
    .select()
    .from(searches)
    .where(
      and(
        eq(searches.campaignId, campaignId),
        or(
          eq(searches.status, "active"),
          and(
            eq(searches.status, "parked"),
            isNull(searches.refusedAt),
            lte(searches.nextReadAt, now),
          ),
        ),
        inArray(searches.lane, shape.lanes.filter((lane) => lane !== "competitors")),
      ),
    )
    .orderBy(
      ...order,
      sql`${searches.lastCheckedAt} asc nulls first`,
      asc(searches.id),
    )
    .$dynamic();
  return shape.maxRows === null ? rows : rows.limit(shape.maxRows);
}

/** Whether a row the run set out to read is still on the map: not retired by
 *  the owner, and not erased with a person put out of reach. A source taken
 *  off the map is never read again, not even by the run already reading it. */
async function stillSearch(tx: Tx, phraseId: number): Promise<boolean> {
  const [row] = await tx
    .select({ status: searches.status })
    .from(searches)
    .where(eq(searches.id, phraseId));
  return row !== undefined && row.status !== "retired";
}

/** Rows on the map that are not retired, whatever their lane or state. */
async function mapSize(tx: Tx, campaignId: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(searches)
    .where(and(eq(searches.campaignId, campaignId), ne(searches.status, "retired")));
  return row?.n ?? 0;
}

/** Whether this profile is the connected account's own. */
function isAccount(sweep: Sweep, profileId: string | undefined): boolean {
  return sweep.account !== null && profileId !== undefined && authorIdentity(profileId) === authorIdentity(sweep.account);
}

/** Whether a post is older than the campaign reads. */
function agedOut(sweep: Sweep, postedAt: number | null | undefined): boolean {
  const days = sweep.campaign.maxPostAgeDays;
  return days > 0 && postedAt != null && sweep.now - postedAt > days * DAY;
}

/** One row of the map: its pages, or for a One thread row its room. */
async function readRow(sweep: Sweep, row: Search): Promise<void> {
  const { organizationId, campaign, now } = sweep;
  if (row.lane === "one_thread") {
    if (row.targetRef) {
      sweep.rooms.push({
        postUrn: row.targetRef,
        url: null,
        commentCount: null,
        postedAt: null,
        phraseId: row.id,
        languageType: null,
        named: true,
      });
    }
    return;
  }
  const kind = row.lane === "keywords" ? "search" : "author";
  const term = kind === "search" ? row.term : row.targetRef;
  if (!term) return;
  // A search LinkedIn refuses for its size is parked before a request is spent
  // on it, as Find posts parks one.
  if (kind === "search" && orOperators(term) > MAX_SEARCH_ORS) {
    await withOrg(organizationId, (tx) => parkRefused(tx, row.id, now));
    return;
  }

  // A shape that reads its own pages reads from the top, newest first, and
  // leaves the row's cursor and order where they were.
  const own = sweep.shape.pagesPerRow === null;
  let cursor = own ? row.cursor : null;
  const pages = Math.min(sweep.shape.pagesPerRow ?? row.pagesPerSweep, sweep.pagesLeft);
  for (let page = 0; page < pages; page++) {
    if (!(await sweep.continueRun())) {
      sweep.stopped = true;
      return;
    }
    const reserved = await withOrg(organizationId, async (tx) =>
      (await stillSearch(tx, row.id)) ? reserveDiscoverCall({ db: tx, campaignId: campaign.id, now }) : null,
    );
    // The owner retired it, or Never engage erased it, while the run read.
    if (reserved === null) return;
    if (!reserved.ok) {
      // The account's pages are spent for the hour or the day: the run's
      // searching ends and what it read stays.
      sweep.searching = false;
      sweep.result.refusal ??=
        reserved.reason === DAILY_SEARCH_LIMIT
          ? refuseChannel(DAILY_SEARCH_LIMIT, reserved.detail, reserved.retryAt)
          : refuseChannel(reserved.reason ?? "discover_capped", undefined, reserved.retryAt);
      return;
    }
    sweep.counts.searchPagesCount += 1;
    sweep.pagesLeft -= 1;

    let posts: DriverPost[];
    let nextCursor: string | null;
    let expired: boolean;
    try {
      const found = await sweep.driver.discoverPosts({
        term,
        cursor,
        limit: PAGE_LIMIT,
        kind,
        ...(kind === "search" ? { sort: own ? row.sort : ("latest" as const), datePosted: row.datePosted } : {}),
      });
      posts = found.posts;
      expired = found.cursorState === "expired";
      nextCursor = expired ? null : found.nextCursor;
    } catch (error) {
      if (isSearchTooLarge(error)) await withOrg(organizationId, (tx) => strikeTooLarge(tx, row.id, now));
      await readFailed(sweep, error);
      return;
    }

    const rooms = await withOrg(organizationId, async (tx) => {
      const landed = await landPosts(sweep, tx, row, posts);
      await tx
        .insert(leadSourceReads)
        .values({ campaignId: campaign.id, runId: sweep.runId, phraseId: row.id, readAt: now })
        .onConflictDoNothing();
      if (!own) {
        await tx
          .update(searches)
          .set({ lastSweptAt: now, lastCheckedAt: now, refusedAt: null, updatedAt: now })
          .where(and(eq(searches.id, row.id), ne(searches.status, "retired")));
        return landed;
      }
      // Only the run that owns the cursor it read moves it: a concurrent read
      // of the same row loses the swap and leaves it where it was. A row the
      // owner retired meanwhile stays retired.
      await tx
        .update(searches)
        .set({
          cursor: nextCursor,
          lastSweptAt: now,
          lastCheckedAt: now,
          // A page that was read clears the mark of a refusal.
          refusedAt: null,
          // A row with no next page has been read to its last; one that had
          // been waiting out its time is active again from the top.
          ...(nextCursor === null && !expired
            ? { status: "parked" as const, nextReadAt: now + DRY_ROW_WAIT_MS }
            : row.status === "parked"
              ? { status: "active" as const, nextReadAt: null }
              : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(searches.id, row.id),
            ne(searches.status, "retired"),
            sql`${searches.cursor} is not distinct from ${cursor}`,
          ),
        );
      return landed;
    });
    sweep.rooms.push(...rooms);
    sweep.counts.leadReadCount += posts.length;
    await sweep.report();
    await pageLanded(sweep);
    if (sweep.stopped) return;

    // An expired cursor starts over from the top at the next visit.
    if (expired || nextCursor === null) return;
    cursor = nextCursor;
  }
}

/** Keep the people a page's posts name, and the rooms worth opening. */
async function landPosts(sweep: Sweep, tx: Tx, row: Search, posts: DriverPost[]): Promise<Room[]> {
  const rooms: Room[] = [];
  const signals: SignalInput[] = [];
  for (const post of posts) {
    // Older than the campaign reads is skipped, with its comments; the
    // account's own posts are never a lead's room.
    if (agedOut(sweep, post.postedAt) || isAccount(sweep, post.authorProfileId)) continue;
    const commentCount = commentCountOf(post.metrics);
    rooms.push({
      postUrn: post.postUrn,
      url: post.url ?? null,
      commentCount,
      postedAt: post.postedAt ?? null,
      phraseId: row.id,
      languageType: row.languageType,
      named: false,
    });
    const words = post.contentText.trim();
    // A company page is read and counted, never a person; so is a source's own
    // post, whose author is who Scout listens to and not who it looks for.
    if (row.lane !== "keywords" || post.authorIsCompany || !post.authorProfileId || words.length === 0) continue;
    signals.push({
      campaignId: sweep.campaign.id,
      profileId: post.authorProfileId,
      name: post.authorName,
      headline: post.authorHeadline,
      headlineFrom: post.authorHeadline ? "search" : null,
      kind: "post",
      postUrn: post.postUrn,
      url: post.url,
      words: truncateChars(words, WORDS_MAX_CHARS),
      saidAt: post.postedAt,
      commentCount,
      languageType: row.languageType,
      phraseId: row.id,
      runId: sweep.runId,
      seenAt: sweep.now,
    });
  }
  sweep.result.fresh += await writeSignals(tx, signals);
  return rooms;
}

/** A read that failed: the account's throttle ends the run's reading, and any
 *  other fault is carried as the run's refusal and stops what failed. */
async function readFailed(sweep: Sweep, error: unknown): Promise<void> {
  if (isConnectorBackoff(error)) {
    // The throttle is the account's: pause it, so the other lanes stop hitting
    // the same wall instead of each discovering it alone.
    const reason = await pauseChannelForConnectorBackoff(sweep.organizationId, error);
    sweep.result.notes.push(
      reason === "checkpoint"
        ? "Reading stopped — LinkedIn asked for a check on the account, so Scout paused it"
        : "Reading stopped — LinkedIn is slowing the account down, so Scout paused it",
    );
    sweep.stopped = true;
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[find_leads] campaign ${sweep.campaign.id} read failed:`,
    error instanceof Error ? error.message : error,
  );
  sweep.result.refusal ??= connectorFailureRefusal(error);
}

/**
 * Why no more threads open, in the owner's words: the day's thread reads
 * spent, the account's window shut (with the time it opens), a stop or a pause
 * on the account, thread reads turned off, or no account to read with.
 */
export function threadsHeldNote(
  reason: string,
  channel: Pick<Channel, "activeHours"> | null,
  retryAt?: number,
): string {
  switch (reason) {
    case "thread_read_daily_cap":
      return "Thread read limit reached — Scout opens more threads tomorrow";
    case "outside_active_hours":
      return channel && retryAt !== undefined
        ? `Threads wait for your window, which opens at ${localClock(retryAt, channel.activeHours?.tz || "UTC")}`
        : "Threads wait for your window to open";
    case "thread_read_off":
      return "Threads not opened — thread reads are turned off for this account";
    case "no_channel":
      return "Threads not opened — no account is connected";
    case "kill switch":
      return "Threads not opened — Engager is stopped";
    default:
      return "Threads not opened — the account is paused for now";
  }
}

/**
 * Open the rooms worth opening: the ones the owner named, then the most
 * commented, up to the run's threads, each inside the account's daily thread
 * reads and not again within its window. Each read is reserved before the
 * page loads, so one that then fails has still spent its row.
 */
async function openRooms(sweep: Sweep, driver: CapabilitySurface<"thread_read">): Promise<void> {
  const { organizationId, campaign, counts, now } = sweep;
  if (sweep.stopped || !driver.readPostThread) return;
  const unique = new Map<string, Room>();
  for (const room of sweep.rooms) {
    const kept = unique.get(room.postUrn);
    if (!kept || (room.named && !kept.named)) unique.set(room.postUrn, room);
  }
  const queue = [...unique.values()]
    .filter((room) => room.named || (room.commentCount ?? 1) > 0)
    .sort(
      (a, b) =>
        Number(b.named) - Number(a.named) ||
        (b.commentCount ?? 0) - (a.commentCount ?? 0) ||
        (b.postedAt ?? 0) - (a.postedAt ?? 0),
    );
  let opened = 0;
  for (const room of queue) {
    if (opened >= leadThreadsPerRun()) return;
    if (!(await sweep.continueRun())) {
      sweep.stopped = true;
      return;
    }
    const reserved = await withOrg(organizationId, async (tx) => {
      // Read inside its window, or found by a row no longer on the map.
      if ((await readRecently(tx, campaign.id, room.postUrn, now)) || !(await stillSearch(tx, room.phraseId))) {
        return "skip" as const;
      }
      const channel = await channelCeilings(tx);
      if (!channel) return { ok: false as const, reason: "no_channel", retryAt: undefined, channel };
      const decision = await reserveResearchRead({ db: tx, read: "thread_read", channel, campaignId: campaign.id, now });
      return { ...decision, channel };
    });
    if (reserved === "skip") continue;
    if (!reserved.ok) {
      // The read budget, the window or a stop said no: nothing more opens.
      sweep.result.notes.push(threadsHeldNote(reserved.reason, reserved.channel, reserved.retryAt));
      return;
    }
    opened += 1;
    counts.threadReadsCount += 1;
    let thread: PostThread;
    try {
      thread = await driver.readPostThread(room.postUrn, { maxComments: MAX_THREAD_COMMENTS });
    } catch (error) {
      await readFailed(sweep, error);
      return;
    }
    counts.leadReadCount += thread.comments.length + (room.named ? 1 : 0);
    await withOrg(organizationId, (tx) => landThread(sweep, tx, room, thread));
    await sweep.report();
    await pageLanded(sweep);
    if (sweep.stopped) return;
  }
}

/** Keep the people a thread's comments name. */
async function landThread(sweep: Sweep, tx: Tx, room: Room, thread: PostThread): Promise<void> {
  const { campaign, now } = sweep;
  const visible = await recordThreadRead(tx, campaign.id, room.postUrn, thread, sweep.runId, now);
  if (room.named) await parkReadRoom(tx, room.phraseId, now);
  if (agedOut(sweep, thread.postedAt ?? room.postedAt)) return;
  if (thread.author?.isCompany && !isAccount(sweep, thread.author.profileId)) {
    sweep.result.companyThreads.push({ postUrn: room.postUrn, profileId: thread.author.profileId, name: thread.author.name ?? null });
  }
  sweep.result.fresh += await keepThreadComments(tx, {
    campaignId: campaign.id,
    postUrn: room.postUrn,
    thread: visible,
    url: room.url,
    phraseId: room.phraseId,
    languageType: room.languageType,
    runId: sweep.runId,
    now,
    lockHeld: true,
  });
}

/** A One thread row whose room was just read: it waits, and is read again
 *  from the top once newer comments can have landed. */
export async function parkReadRoom(tx: Tx, phraseId: number, now: number): Promise<void> {
  await tx
    .update(searches)
    .set({ status: "parked", cursor: null, lastSweptAt: now, lastCheckedAt: now, nextReadAt: now + DRY_ROW_WAIT_MS, updatedAt: now })
    // A row the owner retired while its room was read stays retired.
    .where(and(eq(searches.id, phraseId), ne(searches.status, "retired")));
}

/**
 * A thread read for a campaign, as every reader records one, under the lock
 * Never engage takes: the aliases its comments reveal of people the owner
 * excluded are remembered, the read's time is kept so it is not read again
 * inside its window, and what comes back is the thread without anyone the
 * owner excluded.
 */
export async function recordThreadRead(
  tx: Tx,
  campaignId: number,
  postUrn: string,
  thread: PostThread,
  runId: number | null,
  now: number,
): Promise<PostThread> {
  await lockRoomEvidence(tx);
  await rememberExcludedRoomAliases(tx, thread, now);
  const visible = await withoutExcludedRoomComments(tx, thread);
  await tx
    .insert(leadThreadReads)
    .values({
      campaignId,
      postUrn,
      readAt: now,
      runId,
      authorCompanyRef: thread.author?.isCompany ? thread.author.profileId : null,
      authorCompanyName: thread.author?.isCompany ? thread.author.name ?? null : null,
    })
    .onConflictDoUpdate({
      target: [leadThreadReads.organizationId, leadThreadReads.campaignId, leadThreadReads.postUrn],
      set: {
        readAt: now,
        runId,
        authorCompanyRef: thread.author?.isCompany ? thread.author.profileId : null,
        authorCompanyName: thread.author?.isCompany ? thread.author.name ?? null : null,
      },
    });
  await pruneThreadReads(tx, campaignId, now);
  return visible;
}

/**
 * Keep the people a thread's comments name as signals found by `phraseId`,
 * waiting for the screen: each person's own words, never the account's, a
 * company's or the post author's answering under their own post (the source,
 * under a source's post). Each is written through `writeSignal`, so anyone out
 * of the owner's reach leaves nothing. Returns how many the campaign had not
 * met before.
 */
export async function keepThreadComments(
  tx: Tx,
  input: {
    campaignId: number;
    postUrn: string;
    thread: PostThread;
    url: string | null;
    phraseId: number;
    languageType: LanguageType | null;
    runId: number | null;
    now: number;
    lockHeld?: boolean;
  },
): Promise<number> {
  const { thread } = input;
  const signals: SignalInput[] = [];
  for (const comment of thread.comments) {
    const words = comment.text.trim();
    if (comment.isOwner || comment.authorIsCompany || words.length === 0) continue;
    if (thread.author && comment.authorProfileId && authorIdentity(comment.authorProfileId) === authorIdentity(thread.author.profileId)) continue;
    signals.push({
      campaignId: input.campaignId,
      profileId: comment.authorProfileId,
      memberUrn: comment.memberUrn,
      name: comment.authorName,
      headline: comment.authorHeadline,
      headlineFrom: comment.authorHeadline ? "comment" : null,
      kind: "comment",
      postUrn: input.postUrn,
      commentUrn: comment.commentUrn,
      url: input.url,
      words: truncateChars(words, WORDS_MAX_CHARS),
      commentCount: thread.counts.comments,
      languageType: input.languageType,
      phraseId: input.phraseId,
      runId: input.runId,
      seenAt: input.now,
    });
  }
  return writeSignals(tx, signals, input.lockHeld);
}

/** Forget the thread reads older than the window: they cannot suppress
 *  anything, and a run that lands no thread would otherwise keep them. */
export async function pruneThreadReads(tx: Tx, campaignId: number, now: number): Promise<void> {
  await tx
    .delete(leadThreadReads)
    .where(and(eq(leadThreadReads.campaignId, campaignId), lt(leadThreadReads.readAt, now - THREAD_READ_TTL_MS)));
}

/** Whether this thread was read for the campaign inside its window. */
async function readRecently(tx: Tx, campaignId: number, postUrn: string, now: number): Promise<boolean> {
  const [row] = await tx
    .select({ at: leadThreadReads.readAt })
    .from(leadThreadReads)
    .where(
      and(
        eq(leadThreadReads.campaignId, campaignId),
        eq(leadThreadReads.postUrn, postUrn),
        gt(leadThreadReads.readAt, now - THREAD_READ_TTL_MS),
      ),
    );
  return row !== undefined;
}

/** Parks a row LinkedIn refuses outright: the rotation never sends it again. */
async function parkRefused(tx: Tx, rowId: number, now: number): Promise<void> {
  await tx
    .update(searches)
    .set({ status: "parked", refusedAt: now, updatedAt: now })
    .where(and(eq(searches.id, rowId), eq(searches.status, "active")));
}

/**
 * A search LinkedIn refused as too large. The first marks the row (still
 * active, `refusedAt` set); a later one parks it, but only when the refusal is
 * about the search and not the moment: it comes `STRIKE_SPACING_MS` after the
 * first, and another row was read since (the rules Find posts parks a search
 * by, `discovery/refused.ts`). A page read clears the mark.
 */
async function strikeTooLarge(tx: Tx, rowId: number, now: number): Promise<void> {
  const [row] = await tx
    .select({ refusedAt: searches.refusedAt, lane: searches.lane })
    .from(searches)
    .where(and(eq(searches.id, rowId), eq(searches.status, "active")))
    .for("update");
  // Only a phrase is written shorter; an author's feed has nothing to shorten.
  if (!row || row.lane !== "keywords") return;
  if (row.refusedAt === null) {
    await tx.update(searches).set({ refusedAt: now, updatedAt: now }).where(eq(searches.id, rowId));
    return;
  }
  if (now - row.refusedAt < STRIKE_SPACING_MS) return;
  const [other] = await tx
    .select({ id: searches.id })
    .from(searches)
    .where(and(gt(searches.lastSweptAt, row.refusedAt), ne(searches.id, rowId)))
    .limit(1);
  if (other) await parkRefused(tx, rowId, now);
}
