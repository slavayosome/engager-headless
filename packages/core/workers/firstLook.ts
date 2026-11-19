import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import {
  workerRuns,
  composerDrafts,
  discoveredPosts,
  jobs,
  type WorkerRun,
  type Campaign,
  type DiscoveredPost,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { AgentCliError } from "../ai/agentCli/types";
import { boxKey } from "../composer/drafts";
import { scoutIdFor } from "../operations/workers";
import type { SkipReason } from "./skipReasons";

/**
 * A QUICK CAMPAIGN'S FIRST LOOK (SPEC §4.3): the campaign's first Scout runs,
 * in short rounds that end with its first matches in Inbox and its top five
 * matches drafted — or, where its Scout finds leads (US-LMF-06), with the
 * people who passed the screen on Leads as Signals and nothing drafted.
 *
 * It keeps no table. Each round is an ordinary Scout run stamped with its
 * round (`worker_runs.first_look_round`), the posts its first round
 * drafted ride on the same row, and everything the first look needs to know
 * about itself — whether it has begun, how far it got, what it matched and
 * drafted — is read off those rows here. A Find leads round's matches are the
 * people its screen let in (`lead_screened_in_count`), and it drafts none.
 */

/** A first look stops after this many rounds… */
export const FIRST_LOOK_ROUNDS = 3;
/** …or once its rounds have matched this many posts, or people… */
export const FIRST_LOOK_MATCHES = 10;
/** …and drafts, in its first round, at most this many of the best. */
export const FIRST_LOOK_DRAFTS = 5;

/** Why a first look stopped by its own arithmetic, in `first_look_finished`'s words. */
export type FirstLookStop = "rounds_done" | "enough_matches" | "searches_dry";

/** Every way a first look ends: those, and the outside forces that cut it
 *  short — a round out of time, a round that failed for good, the campaign
 *  paused or stopped — or the caller's own agent finishing it in session. */
export type FirstLookEnding =
  | FirstLookStop
  | "over_budget"
  | "failed"
  | "paused"
  | "stopped"
  | "in_session_done";

/** The first look a skipped round ends, in `first_look_finished`'s words. A
 *  skipped round queues no next one, so whatever kept it from running ends the
 *  first look: a Pause, a Stop, the kill switch, or the account out of reach.
 *  Null for the lease, which a round meets by waiting for it, never by skipping. */
export function skippedFirstLookEnding(reason: SkipReason): FirstLookEnding | null {
  switch (reason) {
    case "target_paused":
    case "organization_paused":
      return "paused";
    case "campaign_stopped":
    case "kill_switch":
      return "stopped";
    case "campaign_locked":
      return null;
    case "authority_elsewhere":
    case "backlog":
    case "channel_not_connected":
    case "connector_unsupported":
    case "conversation_not_runnable":
    case "leads_off":
    case "nothing_needed":
      return "failed";
  }
}

/** The one job a round may be: delivered twice, it is still one run. */
export function firstLookKey(workerId: number, round: number): string {
  return `worker:${workerId}:firstlook:${round}`;
}

/**
 * Whether this Scout run of a Quick campaign is the first round of its first
 * look: the campaign's first run. Its Scout has run nothing yet but skips and
 * tests before Start — a skip read nothing, and a plain test is not the first
 * look its Start begins — and no first look of its own has closed a round. A
 * test that WAS a first look carries its round, so a campaign whose first look
 * ran before its Start gets no second one; a first round that failed, or that
 * the machine slept through, closed nothing, so its job's next attempt is that
 * first round again. Asked under the channel's run lease, so two runs cannot
 * both be first.
 */
export async function beginsFirstLook(tx: Tx, workerId: number): Promise<boolean> {
  const [earlier] = await tx
    .select({ id: workerRuns.id })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, workerId),
        sql`case when ${workerRuns.firstLookRound} is null
          then ${workerRuns.status} <> 'skipped' and not ${workerRuns.isTest}
          else ${workerRuns.status} in ('running', 'succeeded', 'partial') end`,
      ),
    )
    .limit(1);
  return earlier === undefined;
}

/** What the worker's latest first look has done so far, over its rounds. */
export type FirstLookTally = { rounds: number; matched: number; drafted: number };

/**
 * The row before the latest first look of this Scout — it owns the rows after
 * it that are a first look's — or null for a Scout that never began one.
 * See `firstLookTally` for why those rows are this first look's and no other's.
 */
async function firstLookSince(tx: Tx, workerId: number): Promise<number | null> {
  const [newest] = await tx
    .select({ id: workerRuns.id })
    .from(workerRuns)
    .where(and(eq(workerRuns.workerId, workerId), eq(workerRuns.firstLookRound, 1)))
    .orderBy(desc(workerRuns.id))
    .limit(1);
  if (!newest) return null;
  const [closed] = await tx
    .select({ id: workerRuns.id })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, workerId),
        isNotNull(workerRuns.firstLookRound),
        lt(workerRuns.id, newest.id),
        sql`not (${workerRuns.firstLookRound} = 1 and ${workerRuns.status} in ('failed', 'interrupted'))`,
      ),
    )
    .orderBy(desc(workerRuns.id))
    .limit(1);
  return closed?.id ?? 0;
}

async function tallySince(tx: Tx, workerId: number, since: number): Promise<FirstLookTally> {
  const [tally] = await tx
    .select({
      rounds: sql<number>`coalesce(max(${workerRuns.firstLookRound}) filter (where ${workerRuns.status} <> 'skipped'), 0)::int`,
      // A round let people in as Signals.
      matched: sql<number>`coalesce(sum(${workerRuns.leadScreenedInCount}), 0)::int`,
      drafted: sql<number>`coalesce(sum(cardinality(${workerRuns.firstLookPostIds})), 0)::int`,
    })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, workerId),
        isNotNull(workerRuns.firstLookRound),
        gt(workerRuns.id, since),
      ),
    );
  return tally ?? { rounds: 0, matched: 0, drafted: 0 };
}

/**
 * The latest first look of this Scout, from its rows: every round since its
 * newest first round, `rounds` counting those that ran rather than skipped.
 * Rounds run one at a time on the channel's lease and a new first look starts
 * only when none is queued or running, so those rows are this first look's
 * and no other's.
 *
 * A first round that failed or that the machine slept through closed nothing,
 * and its job's next attempt is that first round again (`beginsFirstLook`), so
 * the attempts are one round: the first look starts after the last row that
 * was not such an attempt, and what an earlier attempt matched and drafted
 * still counts.
 */
export async function firstLookTally(tx: Tx, workerId: number): Promise<FirstLookTally> {
  const since = await firstLookSince(tx, workerId);
  return since === null ? { rounds: 0, matched: 0, drafted: 0 } : tallySince(tx, workerId, since);
}

/** What cut a first look short that its owner can act on: the agent's own
 *  refusal, as its CLI named it (`agent_timeout` among them), or any other
 *  failure of a round. */
export type FirstLookFault = "quota_exhausted" | "authentication_required" | "agent_timeout" | "failed";

const AGENT_FAULTS: readonly FirstLookFault[] = ["quota_exhausted", "authentication_required", "agent_timeout"];

/** The fault a failed round recorded: its `error` is the agent CLI's refusal
 *  code when that is what threw, and whatever else threw otherwise. */
export function firstLookFault(error: string | null): FirstLookFault {
  return AGENT_FAULTS.find((fault) => error === fault) ?? "failed";
}

export function firstLookAgentFailure(error: unknown): NonNullable<WorkerRun["agentFailure"]> | null {
  if (!(error instanceof AgentCliError)) return null;
  const reason = firstLookFault(error.cause?.code ?? error.message);
  if (reason === "failed") return null;
  const { adapterId, resetsAt } = error.cause ?? {};
  return { reason,
    ...(adapterId === "claude" || adapterId === "codex" ? { adapterId } : {}),
    ...(typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt < 8.64e15 ? { resetsAt } : {}) };
}

/** A campaign's first look as its pages say it: the round it reached of the
 *  rounds it may take, what it matched and drafted, and whether it is over. */
export type FirstLookProgress = {
  campaignId: number;
  round: number;
  of: number;
  matched: number;
  drafted: number;
  done: boolean;
  /** The newest round's run, which its run page opens. */
  runId: number;
  /** When that round began, which the posts it found follow. */
  roundStartedAt: number;
  /** When the last round ended; null while the first look goes on. */
  finishedAt: number | null;
  /** Why an over first look stopped where its last round failed — the fault
   *  and when it struck; null while it goes on and when it ended as it should. */
  stopped: { reason: FirstLookFault; at: number; adapterId?: string; resetsAt?: number; jobId?: number } | null;
};

/**
 * A campaign's latest first look, read off its Scout's rows — or null for a
 * campaign whose Scout never ran a round of one. It is over once no round of
 * it is queued or running.
 */
export async function campaignFirstLook(
  tx: Tx,
  organizationId: string,
  campaignId: number,
): Promise<FirstLookProgress | null> {
  const scoutId = await scoutIdFor(tx, campaignId);
  if (scoutId === null) return null;
  const since = await firstLookSince(tx, scoutId);
  if (since === null) return null;
  const tally = await tallySince(tx, scoutId, since);
  if (tally.rounds === 0) return null;
  const [latest] = await tx
    .select({
      id: workerRuns.id,
      status: workerRuns.status,
      startedAt: workerRuns.startedAt,
      finishedAt: workerRuns.finishedAt,
      error: workerRuns.error,
      agentFailure: workerRuns.agentFailure,
      firstLookRound: workerRuns.firstLookRound,
      jobId: workerRuns.jobId,
    })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, scoutId),
        isNotNull(workerRuns.firstLookRound),
        gt(workerRuns.id, since),
        ne(workerRuns.status, "skipped"),
      ),
    )
    .orderBy(desc(workerRuns.id))
    .limit(1);
  if (!latest) return null;
  const [running] = await tx
    .select({ id: workerRuns.id })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, scoutId),
        eq(workerRuns.status, "running"),
        isNotNull(workerRuns.firstLookRound),
      ),
    )
    .limit(1);
  const [queued] = running
    ? []
    : await tx
        .select({
          round: sql<string | null>`${jobs.payload}->'firstLook'->>'round'`,
          createdAt: jobs.createdAt,
          status: jobs.status,
          lastError: jobs.lastError,
        })
        .from(jobs)
        .where(
          and(
            // `jobs` is outside RLS, so the org is stated.
            eq(jobs.organizationId, organizationId),
            eq(jobs.type, "worker_run"),
            inArray(jobs.status, ["queued", "running"]),
            sql`${jobs.payload}->>'workerId' = ${String(scoutId)}`,
            latest.status === "failed" && latest.jobId !== null
              ? eq(jobs.id, latest.jobId)
              : sql`${jobs.payload}->'firstLook' is not null`,
          ),
        )
        .limit(1);
  // A first round queued after the last round began, where that round did not
  // fail, is a first look run again that has not begun: the rounds read are
  // the one before it. (After a failed round it is that round's retry.)
  if (queued?.round === "1" && latest.status !== "failed" && queued.createdAt > latest.startedAt) return null;
  const done = !running && !queued;
  // A queued failed attempt is backing off, not executing. Keep its reason
  // until the queue claims it or the owner explicitly expedites that retry.
  const stopped = !running && latest.status === "failed" && (!queued || (queued.status === "queued" && queued.lastError !== null));
  return {
    campaignId,
    round: tally.rounds,
    of: FIRST_LOOK_ROUNDS,
    matched: tally.matched,
    drafted: tally.drafted,
    done,
    runId: latest.id,
    roundStartedAt: latest.startedAt,
    finishedAt: done ? latest.finishedAt : null,
    stopped:
      stopped
        ? { reason: firstLookFault(latest.error), ...latest.agentFailure, at: latest.finishedAt ?? latest.startedAt,
            ...(latest.jobId === null ? {} : { jobId: latest.jobId }) }
        : null,
  };
}

/**
 * Why the first look stops after this round, or null when it goes on: three
 * rounds run, ten matches found, or searches — a Find leads first look's
 * phrases — with nothing left to read.
 */
export function firstLookStop(input: {
  round: number;
  matched: number;
  searchesDry: boolean;
}): FirstLookStop | null {
  if (input.matched >= FIRST_LOOK_MATCHES) return "enough_matches";
  if (input.searchesDry) return "searches_dry";
  if (input.round >= FIRST_LOOK_ROUNDS) return "rounds_done";
  return null;
}

/**
 * The posts among `postIds` whose comment box already holds a draft. A first
 * look never delivers to one: every distinct text is an angle row of its own,
 * with no cap per box, so a second delivery would only pile angles on the
 * owner — and a box the owner asked a draft for is theirs already.
 */
export async function boxesHoldingDrafts(tx: Tx, postIds: readonly number[]): Promise<Set<number>> {
  if (postIds.length === 0) return new Set();
  const keys = new Map(postIds.map((id) => [boxKey({ kind: "comment", discoveredPostId: id }), id]));
  const rows = await tx
    .selectDistinct({ boxKey: composerDrafts.boxKey })
    .from(composerDrafts)
    .where(inArray(composerDrafts.boxKey, [...keys.keys()]));
  return new Set(
    rows.flatMap((row) => {
      const id = keys.get(row.boxKey);
      return id === undefined ? [] : [id];
    }),
  );
}

/** One draft a first-look round put in a comment box, as its run page lists it. */
export type FirstLookRoundDraft = {
  discoveredPostId: number;
  authorName: string | null;
  authorProfileId: string | null;
  /** The angle's name, as the box names it ("Add", "Ask"…). */
  angle: string | null;
  text: string;
};

/** A first-look round as its run page reads it. */
export type FirstLookRoundView = {
  round: number;
  nextQueued: boolean;
  drafts: FirstLookRoundDraft[];
};

/**
 * A run's first-look round, or null when it was none.
 *
 * Its drafts are the boxes it drafted, read now: each one's first angle, which
 * is the first look's, since it delivers only to a box that holds none. A box
 * forgotten since — its author someone the owner chose never to engage — is
 * gone from the list with its words.
 *
 * `nextQueued` says this round queued the next one: a job for the next round
 * of this Scout created after this round began and before any later first
 * look's first round did.
 */
export async function firstLookRoundView(
  tx: Tx,
  organizationId: string,
  run: Pick<WorkerRun, "id" | "workerId" | "startedAt" | "firstLookRound" | "firstLookPostIds">,
): Promise<FirstLookRoundView | null> {
  if (run.firstLookRound == null) return null;
  const [later] = await tx
    .select({ startedAt: workerRuns.startedAt })
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.workerId, run.workerId),
        eq(workerRuns.firstLookRound, 1),
        gt(workerRuns.id, run.id),
      ),
    )
    .orderBy(asc(workerRuns.id))
    .limit(1);
  const [next] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        // `jobs` is outside RLS, so the org is stated.
        eq(jobs.organizationId, organizationId),
        eq(jobs.type, "worker_run"),
        sql`${jobs.payload}->>'workerId' = ${String(run.workerId)}`,
        sql`${jobs.payload}->'firstLook'->>'round' = ${String(run.firstLookRound + 1)}`,
        gte(jobs.createdAt, run.startedAt),
        ...(later ? [sql`${jobs.createdAt} < ${later.startedAt}`] : []),
      ),
    )
    .limit(1);
  const ids = run.firstLookPostIds;
  const posts =
    ids.length === 0
      ? []
      : await tx
          .select({
            id: discoveredPosts.id,
            authorName: discoveredPosts.authorName,
            authorProfileId: discoveredPosts.authorProfileId,
          })
          .from(discoveredPosts)
          .where(inArray(discoveredPosts.id, ids));
  const angles =
    ids.length === 0
      ? []
      : await tx
          .select({ boxKey: composerDrafts.boxKey, angle: composerDrafts.angle, text: composerDrafts.text })
          .from(composerDrafts)
          .where(
            and(
              inArray(composerDrafts.boxKey, ids.map((id) => boxKey({ kind: "comment", discoveredPostId: id }))),
              eq(composerDrafts.position, 1),
              ne(composerDrafts.state, "failed"),
            ),
          );
  const postById = new Map(posts.map((post) => [post.id, post]));
  const angleByBox = new Map(angles.map((row) => [row.boxKey, row]));
  return {
    round: run.firstLookRound,
    nextQueued: next !== undefined,
    drafts: ids.flatMap((id) => {
      const post = postById.get(id);
      const angle = angleByBox.get(boxKey({ kind: "comment", discoveredPostId: id }));
      if (!post || !angle?.text) return [];
      return [
        {
          discoveredPostId: id,
          authorName: post.authorName,
          authorProfileId: post.authorProfileId,
          angle: angle.angle,
          text: angle.text,
        },
      ];
    }),
  };
}
