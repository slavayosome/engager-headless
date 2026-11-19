import type { WorkerRun } from "@engager/database/schema";

/**
 * Why a run never started — the whole vocabulary, in one place.
 *
 * A skip reason is RUNTIME TEXT, not documentation (INV-8). The owner's agent
 * is told, in the `get_run` description, to read one and act on it. So
 * a member is only real when two things are true at once:
 *
 *   1. some code path actually WRITES it;
 *   2. the `get_run` description names it and says what it means.
 *
 * It was three until T-8.12, when `skills/engager-workers` was retired and
 * the prose its `references/runs.md` carried moved into that description — one
 * fewer place to say it, not one fewer thing held true.
 *
 * `not_entitled`, `no_candidates` and `caps_exhausted` had (2) and never had
 * (1) — for their whole life the product told the agent to look for answers the
 * server could not give. `skipReasons.test.ts` is what makes that unrepeatable:
 * it holds the two to each other, in both directions.
 *
 * It works the other way too, and `outside_window` is the case: a closed window
 * stopped being a reason not to start (T-7.6 — an anchor half an hour out is a
 * reason to wake, and the send is fenced at send time anyway), the branch that
 * wrote it went, and the guard then refused to let the member outlive its
 * writer.
 *
 * Adding a member is therefore never a one-line change. It is a full INV-8
 * landing — the writer, the description, `npm run docs:generate` and the
 * regenerated parity snapshot — in the same commit. That cost is the point.
 */
export type SkipReason = NonNullable<WorkerRun["skipReason"]>;

/**
 * The set as a VALUE, because the guard has to iterate it and a TypeScript
 * union cannot be iterated. `satisfies` keeps it inside the schema's enum;
 * the exhaustiveness pin below keeps the schema inside it.
 */
export const SKIP_REASONS = [
  "authority_elsewhere",
  "backlog",
  "campaign_locked",
  "campaign_stopped",
  "channel_not_connected",
  "connector_unsupported",
  "conversation_not_runnable",
  "kill_switch",
  "leads_off",
  "nothing_needed",
  "organization_paused",
  "target_paused",
] as const satisfies readonly SkipReason[];

/**
 * Exhaustiveness, the same shape `jobs/worker.ts`'s `ALL_TYPES` uses: a schema
 * member missing from `SKIP_REASONS` is a COMPILE error, so the list can never
 * silently fall behind `worker_runs.skip_reason` and leave a reason the
 * guard below never checks.
 */
const _skipReasonsExhaustive: Exclude<
  SkipReason,
  (typeof SKIP_REASONS)[number]
> extends never
  ? true
  : never = true;
void _skipReasonsExhaustive;
