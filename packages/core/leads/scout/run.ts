import { sql } from "drizzle-orm";
import type { Campaign, SearchDepth } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import type { LLM } from "../../ai/client";
import type { CapabilityGrant } from "../../jobs/context";
import type { Refusal } from "../../refusal";
import { wakePhasesWithWork } from "./check";
import type { LeadRunCounts } from "./counts";
import type { FindLeadsStep } from "./phase";
import { planSearchMap, seedSearchMap } from "./mapPlan";
import { mergeSignals } from "./merge";
import { pipelineCounts, sweepGate } from "./queues";
import { screenSignals } from "./screen";
import { leadRunShapeFor, RESEARCH_OFF_NOTE } from "./shape";
import { pruneThreadReads, sweepSearches } from "./sweep";
import { wakeLeadPhase } from "./wake";

/**
 * ONE FIND LEADS RUN: seed an empty search map and sweep it into people's
 * words, then hand them to the steps that carry them on — Screen, Read profiles
 * and Judge (`wake.ts`), each a job of its own that waits for no run. The run
 * wakes Screen as each phrase's pages land, stops sweeping where those steps are
 * behind (`sweepGate`) and wakes whatever has work when it ends. A test before
 * Start and a first look's round screen what they read themselves, because
 * their result is who passed: the test merges no one into a lead, and the first
 * look makes the people who pass Signals. Orchestration only. The worker run
 * (`jobs/handlers/workerRun.ts`) owns the row, the lease and the clock, and
 * hands this its own seams, so a phase cannot outlive the lease or write a
 * number the row did not take: each phase adds to `counts` as its rows land and
 * calls `report` between model calls, and a run that throws or loses its lease
 * keeps what it did.
 */
export type FindLeadsRun = {
  organizationId: string;
  campaign: Campaign;
  /** The account the run reads with, whose profile reads left today the sweep
   *  gate counts. */
  channelId: number;
  runId: number;
  depth: SearchDepth;
  step: FindLeadsStep;
  /** The sweep may read the account: Find is On or this is a test, and the
   *  account's window is open. */
  sweep: boolean;
  /** A test before Start: it sweeps and screens, and merges no one into a
   *  lead. */
  test: boolean;
  /** A first look's round: a Quick run of its own that screens and merges what
   *  it reads, and that no backlog holds back. */
  firstLook: boolean;
  now: number;
  grant: CapabilityGrant;
  llm: LLM;
  counts: LeadRunCounts;
  /** Move the row to a phase, writing it. */
  enter: (phase: "sweep" | "screen") => Promise<void>;
  /** Write the row's counters as they stand. Best effort. */
  report: () => Promise<void>;
  /** Renew the lease and say whether the run may go on. */
  continueRun: () => Promise<boolean>;
};

export type FindLeadsOutcome = {
  /** The sweep could not reach the account, or its day of search pages was
   *  spent. */
  refusal: Refusal | null;
  /** The map held nothing to listen for, so the sweep is no measurement. */
  emptyMap: boolean;
  /** The sweep read nothing it had not met before: its rows held no new
   *  words, its pages were refused, or the map had nothing to read at this
   *  depth. A first look stops on it. False for a run that did not sweep. */
  dry: boolean;
  /** What else the run says of itself, in the owner's words. */
  notes: string[];
};

/**
 * Run `body`, then `after` whether or not it threw. When both throw it is
 * `body`'s error that goes on: what failed first is what the run reports.
 */
async function thenAlways(body: () => Promise<void>, after: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    // eslint-disable-next-line no-console
    await after().catch((later) => console.warn("[find_leads] a step after a failure failed too:", later instanceof Error ? later.message : later));
    throw error;
  }
  await after();
}

export async function runFindLeads(run: FindLeadsRun): Promise<FindLeadsOutcome> {
  const outcome: FindLeadsOutcome = { refusal: null, emptyMap: false, dry: false, notes: [] };
  const shape = leadRunShapeFor(run.depth);
  // A test and a first look's round end in who passed, so they screen what they
  // read themselves; any other run hands its words to Screen.
  const screensItself = run.test || run.firstLook;
  // A step woken for a campaign that is not Active would end without work.
  const handsOff = run.campaign.status === "active";
  // The thread reads that have aged out are forgotten whether or not this run
  // reads the account.
  await withOrg(run.organizationId, (tx) => pruneThreadReads(tx, run.campaign.id, run.now));
  // An empty map is started from the audience's pains before anything is read
  // from it. A test changes no phrase, so it listens to what is there.
  if (!run.test && run.step.find) {
    await seedSearchMap({
      organizationId: run.organizationId,
      campaign: run.campaign,
      runId: run.runId,
      now: run.now,
      instructions: run.step.instructions,
      llm: run.llm,
      continueRun: run.continueRun,
    });
  }
  if (run.sweep) {
    await run.enter("sweep");
    // What a phrase's pages kept is Screen's from then on, and reading further
    // only lengthens what the steps after the sweep have to work through, so a
    // sweep ends where they are behind.
    const mayReadMore = async (): Promise<boolean> => {
      const { note } = await withOrg(run.organizationId, async (tx) => {
        const gate = await sweepGate(tx, run.campaign.id, run.channelId, run.now);
        if (handsOff && gate.counts.toScreen > 0) await wakeLeadPhase(tx, "screen", run.campaign.id);
        return gate;
      });
      if (note === null) return true;
      outcome.notes.push(note);
      return false;
    };
    const swept = await sweepSearches({
      organizationId: run.organizationId,
      campaign: run.campaign,
      runId: run.runId,
      shape: shape.sweep,
      now: run.now,
      grant: run.grant,
      counts: run.counts,
      report: run.report,
      continueRun: run.continueRun,
      ...(screensItself ? {} : { mayReadMore }),
    });
    outcome.refusal = swept.refusal;
    outcome.emptyMap = swept.emptyMap;
    outcome.dry = swept.fresh === 0;
    outcome.notes.push(...swept.notes);
    // The sweep persists each word with this run before anything downstream
    // sees it. A Find leads run now ends here, so its Found counter is the
    // people in those persisted receipts rather than Screen's later tally.
    run.counts.leadFoundCount = await withOrg(run.organizationId, async (tx) => {
      const read = await tx.execute<{ n: number }>(sql`select count(distinct person_key)::int as n from lead_signals where campaign_id = ${run.campaign.id} and run_id = ${run.runId}`);
      return read.rows[0]!.n;
    });
    await run.report();
  }

  if (screensItself) {
    await run.enter("screen");
    await thenAlways(
      async () => {
        await screenSignals({
          organizationId: run.organizationId,
          campaign: run.campaign,
          instructions: run.step.instructions,
          llm: run.llm,
          counts: run.counts,
          report: run.report,
          continueRun: run.continueRun,
        });
      },
      // Whoever passed before a screen failed is still merged; the failure
      // goes on. A test merges no one: it writes no lead.
      async () => {
        if (run.test) return;
        await mergeSignals({
          organizationId: run.organizationId,
          campaign: run.campaign,
          depth: run.depth,
          counts: run.counts,
          report: run.report,
          continueRun: run.continueRun,
        });
      },
    );
  }
  if (run.test) return outcome;

  // First-look rounds still tune the map between rounds. They run before the
  // campaign is active, so Judge cannot make the normal finished-pass plan.
  if (run.firstLook && run.step.find && (await run.continueRun())) {
    const planned = await planSearchMap({
      organizationId: run.organizationId,
      campaign: run.campaign,
      now: run.now,
      instructions: run.step.instructions,
      llm: run.llm,
      forcePass: run.runId,
      continueRun: run.continueRun,
    });
    if (planned?.unanswered) outcome.notes.push("The search map was not tuned — the agent did not answer");
  }

  // The depth carries people past Signal, and the owner's Research switch is
  // what stops it: say so on the run, which left them as they were.
  if (shape.research && !run.step.research) outcome.notes.push(RESEARCH_OFF_NOTE);

  // Whatever waits, from this run or before it, is the steps' to take now
  // rather than at the next check.
  if (handsOff) {
    await withOrg(run.organizationId, async (tx) => {
      await wakePhasesWithWork(tx, run.campaign, run.step, await pipelineCounts(tx, run.campaign.id, run.now), run.now);
    });
  }
  return outcome;
}
