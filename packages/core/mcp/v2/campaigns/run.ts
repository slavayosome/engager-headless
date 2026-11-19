import { z } from "zod";
import { eq } from "drizzle-orm";
import { workerRuns } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { listRunPlans } from "../../../dispatcher/runAttempts";
import { readRunOverlay } from "../../../agentStep/overlay";
import { mapChanges } from "../../../leads/scout/mapSummary";
import { campaignRunNeighbours, getCampaignRun } from "../../../operations/campaignWorkspace";
import { firstLookRoundView } from "../../../workers/firstLook";
import { profileReadsLeft, threadReadsToday } from "../../../ratelimit/ledger";
import { errorResult, jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { parseRef } from "../refs";
import { fenceByShape } from "../fence";
import { listRunOutput } from "../../../operations/runOutput";
import { runPeople } from "../../../leads/scout/queues";
import { PEOPLE_COUNTERS, countsPeopleFromRows, type PeopleCountedRun } from "../../../leads/scout/counts";
import { pageRunPeople } from "../../../operations/runPeople";

/** A run's `error` column also carries what a run that did not fail had to
 *  say — a sweep stopped behind its backlog, openers kept for next time — so an
 *  agent reads that as the run's note, and only a failed run's as its error.
 *  A Find leads run that only read also leaves off the counters of what became
 *  of its people: they are zeros there, and the tally beside them (`counts`,
 *  from the rows) is the answer. */
export function runForAgent<T extends PeopleCountedRun & { status: string; error: string | null }>(run: T): Partial<T> & { note: string | null } {
  const failed = run.status === "failed";
  const dead: readonly string[] = countsPeopleFromRows(run) ? PEOPLE_COUNTERS : [];
  const kept = Object.fromEntries(Object.entries(run).filter(([name]) => !dead.includes(name))) as Partial<T>;
  return { ...kept, error: failed ? run.error : null, note: failed ? null : run.error };
}

/** One read never carries more than this many plans or agent steps. */
const PLAN_CAP = 100;
const STEP_CAP = 100;

export const runTools: readonly V2Tool[] = [defineTool({
  name: "get_run", kind: "read", description: "Read one run and its recorded items, plans and agent steps. See engager-campaigns.",
  input: z.object({ runId: z.number().int().positive(), include: z.array(z.enum(["phases", "items", "plans", "judge", "steps", "tool_calls", "reads", "errors"])).optional(), cursor: z.string().min(1).optional() }),
  handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
    const [row] = await tx.select({ campaignId: workerRuns.campaignId }).from(workerRuns).where(eq(workerRuns.id, input.runId));
    if (!row) return errorResult("Run not found.", { code: "not_found", status: 404 });
    const run = await getCampaignRun(tx, row.campaignId, input.runId);
    if (!run) return errorResult("Run not found.", { code: "not_found", status: 404 });
    const wants = (part: string) => input.include?.includes(part as never) ?? false;
    const isAmbassador = run.worker.type === "ambassador";
    let afterMessage = 0;
    let afterPerson: string | null = null;
    if (isAmbassador && input.cursor) {
      const parsed = parseRef(input.cursor, ["msg"]);
      if (parsed.kind !== "msg") throw new Error("unreachable ref kind");
      afterMessage = parsed.id;
    } else if (input.cursor) {
      const parsed = parseRef(input.cursor, ["person"]);
      if (parsed.kind !== "person") throw new Error("unreachable ref kind");
      afterPerson = parsed.key;
    }
    const page = wants("items") && !isAmbassador ? await pageRunPeople(tx, row.campaignId, input.runId, afterPerson) : null;
    const outputPage = wants("items") && isAmbassador ? await listRunOutput(tx, input.runId, 101, afterMessage) : [];
    const items = page?.people.map(person => {
      const ref = person.leadId ? `lead:${person.leadId}` : `person:${person.key}`;
      parseRef(ref, ["lead", "person"]);
      return { ...person, ref };
    }) ?? [];
    // The dashboard's own rule: a Find leads run that only read has its people tallied from their rows, and its columns say none of it.
    const people = countsPeopleFromRows(run.run) ? (await runPeople(tx, row.campaignId, [input.runId])).get(input.runId) ?? null : null;
    return jsonResult(fenceByShape({ ...run, run: runForAgent(run.run), ...(people && { counts: people }),
      neighbours: await campaignRunNeighbours(tx, row.campaignId, run.run),
      firstLook: await firstLookRoundView(tx, ctx.organizationId, run.run),
      ...(wants("items") && { items, nextCursor: isAmbassador ? (outputPage.length > 100 ? `msg:${outputPage[99]!.id}` : null) : page?.next ? `person:${page.next}` : null, ...(isAmbassador ? { output: outputPage.slice(0, 100).map(item => { const ref = `msg:${item.id}`; parseRef(ref, ["msg"]); return { ...item, ref }; }) } : input.cursor ? {} : { mapChanges: await mapChanges(tx, row.campaignId, { runId: input.runId }) }) }),
      ...((wants("plans") || wants("judge")) && { plans: await listRunPlans(tx, input.runId, PLAN_CAP + 1).then(({ plans, ...rest }) => ({ ...rest, plans: plans.slice(0, PLAN_CAP), plansTruncated: plans.length > PLAN_CAP })) }),
      ...((wants("steps") || wants("tool_calls")) && { overlay: await readRunOverlay(tx, input.runId).then(overlay => overlay && { ...overlay, steps: overlay.steps.slice(0, STEP_CAP), stepsTruncated: overlay.steps.length > STEP_CAP }) }),
      ...(wants("reads") && { reads: { threadReadsToday: await threadReadsToday(tx, run.run.channelId), profileReadsLeft: await profileReadsLeft(tx, run.run.channelId) } }),
    }));
  }),
})];
