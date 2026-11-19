import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  campaigns,
  jobs,
  roomSnapshots,
  workers,
  type Campaign,
  type WorkerRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { openPauses, scopesOf } from "../actions/pause";
import { loadStrategy } from "../agentStep/select";
import { modeFor } from "../strategy/mode";
import type { WorkerRunPayload } from "../jobs/handlers/workerRun";
import { enqueue } from "../jobs/queue";
import { getSystemState } from "../ratelimit/killswitch";

/**
 * THE AMBASSADOR'S STARTS THAT A SCOUT RUN PRODUCES, made real.
 *
 * Comment on posts is seeded to start "When a post is matched"
 * (`candidate_matched`) and Meet the room "When Research spots someone who
 * fits" (`room_member_spotted`), and until this read them both were labels:
 * the Ambassador ran on the wake it shares with the Scout. On 2026-10-19 at
 * 15:15 it ran first and drafted nothing, and the seven matches the Scout
 * confirmed by 15:30 waited for the next wake, at 17:10. A Scout run that
 * confirmed what one of those steps starts on now wakes the Ambassador right
 * after it.
 *
 * The run enqueued is `trigger: "match"`: the schedule's run in everything it
 * does — it sizes itself off the day plan and the caps, arms only where an
 * action is Automatic, and every send still meets `canEngage` and the
 * exactly-once path — except that it leaves the wake where the schedule put
 * it. Nothing here sends, and nothing here decides what is drafted: a match
 * left to the owner (`author_maybe`) is still not the worker's.
 *
 * It wakes only a worker the server wakes at all and a run that would not
 * record a skip: the campaign Active and on its strategy, the step on and
 * still starting on what the run produced, and no stop on the org, the
 * account or the campaign. One run at a time is enough: a run of the
 * Ambassador's comment work already queued or under way — the schedule's, a
 * campaign press's, an earlier match's — sizes itself under the account's
 * lease, so after this Scout, and reads what it confirmed. An event wake does
 * not count; it drafts no comment. Keyed on the Scout run, so the same run
 * never wakes it twice. A lead the Judge serves has no run to key on: its
 * wake is keyed on the `lead_served` event instead, and it answers no room a
 * run read.
 *
 * Null when nothing was enqueued.
 */
export async function wakeAmbassadorOnMatch(
  tx: Tx,
  input: {
    organizationId: string;
    campaignId: number;
    channelId: number;
    now: number;
  } & ({ scoutRunId: number } | { scoutRunId?: undefined; servedEventId: number }),
): Promise<number | null> {
  const [campaign] = await tx
    .select({
      id: campaigns.id,
      status: campaigns.status,
      channelId: campaigns.channelId,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), isNull(campaigns.deletedAt)));
  if (campaign?.status !== "active") return null;

  const [ambassador] = await tx
    .select({
      id: workers.id,
      auto: workers.auto,
      draftEnabled: workers.draftEnabled,
      conversationEnabled: workers.conversationEnabled,
    })
    .from(workers)
    .where(and(eq(workers.campaignId, campaign.id), eq(workers.type, "ambassador")))
    .orderBy(asc(workers.id))
    .limit(1);
  if (!ambassador?.auto) return null;
  if (!(await startsOnThisRun(tx, campaign, ambassador, input.scoutRunId))) return null;

  const system = await getSystemState(tx);
  if (system?.killSwitch === true) return null;
  if (system?.pausedUntil != null && system.pausedUntil > input.now) return null;
  const scopes = scopesOf({
    channelId: input.channelId,
    campaignId: campaign.id,
    conversationId: null,
  });
  if ((await openPauses(tx, scopes)).length > 0) return null;

  const pending = await tx
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(
      and(
        // `jobs` is outside RLS, so the org is stated.
        eq(jobs.organizationId, input.organizationId),
        eq(jobs.type, "worker_run"),
        inArray(jobs.status, ["queued", "running"]),
        sql`${jobs.payload}->>'workerId' = ${String(ambassador.id)}`,
        sql`${jobs.payload}->>'trigger' is distinct from 'event'`,
      ),
    );
  if (pending.some((job) => job.status === "queued")) return null;

  const payload: WorkerRunPayload = { workerId: ambassador.id, trigger: "match" };
  const answered = input.scoutRunId === undefined ? `lead:${input.servedEventId}` : input.scoutRunId;
  return enqueue(tx, {
    type: "worker_run",
    payload,
    idempotencyKey: `worker:${ambassador.id}:matched:${answered}`,
  });
}

/**
 * Whether a step the Ambassador has on starts on what this Scout run
 * produced: Comment on posts on its matches — its caller asks only after a
 * run that confirmed one — or Meet the room on a person who fits, newly
 * spotted in a room the run read; on a campaign that finds leads, Comment on
 * posts on a served lead, not Off — its caller asks only after a run that
 * served a lead an opener is drafted for. A step whose start the owner moved
 * to the campaign's wake is answered by the wake.
 */
async function startsOnThisRun(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
  ambassador: Pick<WorkerRow, "draftEnabled" | "conversationEnabled">,
  scoutRunId: number | undefined,
): Promise<boolean> {
  const strategy = await loadStrategy(tx, campaign);
  if (!strategy) return false;
  const steps = strategy.document.steps ?? [];
  const opening = new Set(
    steps
      .filter((step) => step.catalog_step === "comment_on_posts" && step.entry.event === "lead_served")
      .map((step) => step.step_id),
  );
  const commentMode = (await modeFor(tx, { campaignId: campaign.id, capability: "publish_comment", target: "post" })).effective ?? "off";
  if (opening.size > 0 && commentMode !== "off") {
    return true;
  }
  const comment = steps.some(
    (step) =>
      step.catalog_step === "comment_on_posts" && step.entry.event === "candidate_matched",
  );
  // Comment's switch is the row's own.
  if (commentMode !== "off" && comment) return true;

  const room = steps.find(
    (step) =>
      step.catalog_step === "meet_the_room" && step.entry.event === "room_member_spotted",
  );
  if (!ambassador.conversationEnabled || !room || scoutRunId === undefined) return false;
  // The row's switch is every person-to-person step's; this one's own is an
  // action on it the owner has not set Off.
  const roomMode = (await modeFor(tx, { campaignId: campaign.id, capability: "reply_to_comment", target: "room_comment", stepId: room.step_id })).effective ?? "off";
  const roomOn = roomMode === "review" || roomMode === "auto";
  if (!roomOn) return false;
  const [spotted] = await tx
    .select({ id: roomSnapshots.id })
    .from(roomSnapshots)
    .where(
      and(
        eq(roomSnapshots.campaignId, campaign.id),
        eq(roomSnapshots.runId, scoutRunId),
        // A room on a post left to the owner is theirs alone to join.
        inArray(roomSnapshots.joinLens, ["author", "room", "both"]),
        sql`(${roomSnapshots.summary}->>'newlySpotted')::int > 0`,
      ),
    )
    .limit(1);
  return spotted !== undefined;
}
