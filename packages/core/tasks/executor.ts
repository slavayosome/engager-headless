import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { jobs, type Job } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { McpCtx } from "../mcp/context";
import { capabilityGrant, type CapabilityGrant } from "../jobs/context";
import type { CapabilityKind } from "../connector/capabilities";
import { handleSeedBrain } from "../jobs/handlers/seedBrain";
import { fetchProductSourceCorpus } from "../products/ingest";
import { IN_SESSION_BOUND_MS } from "./bound";
import { withExternalJudgment, type DeferredTask } from "./judgment";
import { startTask } from "./task";

/**
 * How long an in-session run may hold the caller's tool call.
 *
 * An MCP tool call is a chat turn. A browser sweep of 25 own posts is seconds;
 * a cold sidecar boot behind it is not, and the owner meeting a transport
 * timeout is the failure this whole fallback exists to remove. So the run is
 * RACED, never cancelled: past the bound the reply says the work started, the
 * work keeps going on this same server process, and the task it prepares
 * surfaces on the next `get_status` / `get_task`. Own-post
 * sweeps land well inside it and stay synchronous.
 *
 * Re-exported from `./bound`, which is where it lives so the prepared discovery
 * sweep can hold the same bound without importing this module back.
 */
export { IN_SESSION_BOUND_MS };

/** `StartTask`'s `sourceText` bound, minus headroom for the envelope. */
const MAX_DEFERRED_CORPUS_CHARS = 60_000;

export type InSessionResult = {
  mode: "in_session";
  /** Prepared task ids — the owner's agent submits these. Absent while the
   *  run is still going (`started`), because none exists yet. */
  taskIds?: string[];
  /** The kinds behind `taskIds`, in the same order. Only what was actually
   *  PREPARED: a kind this run could not turn into a task belongs in
   *  `unprepared`, never here, or the caller reads an owed task it will never
   *  be handed. */
  pendingTasks?: string[];
  /** Model work this run deferred and could NOT prepare, with the reason.
   *  Absent when there is none, which is the ordinary case. */
  unprepared?: { kind: string; reason: string }[];
  /** The bound was hit: the work continues in this process's background. */
  started?: boolean;
};

/** The job handlers an interactive tool may run inline. Deliberately a short,
 *  explicit map rather than the worker's registry: the worker's map pulls in
 *  posting, the drain and the whole lane model, none of which an MCP tool may
 *  reach, and a handler that is unsafe to run inside a chat turn must be a
 *  visible omission rather than an accident of import order.
 *
 *  `ingest_product` is such an omission, and the reason is worth keeping: its
 *  handler STAMPS the product (`crawling` -> `suggesting` -> `done` | `failed`)
 *  and treats an unfinished extraction as a failure to show the owner. Running
 *  it with the model phase deferred would stamp `failed` on a product whose
 *  crawl succeeded. `ingestProductInSession` below does the crawl half and owes
 *  the task instead, off the same `fetchProductSourceCorpus`. */
const IN_SESSION_HANDLERS = {
  seed_brain: handleSeedBrain,
} satisfies Partial<
  Record<
    Job["type"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx: any, payload: any) => Promise<unknown>
  >
>;

export type InSessionJobType = keyof typeof IN_SESSION_HANDLERS;

/**
 * Clear the queue row the background path would have used.
 *
 * A free install accumulated these: `seed_brain` enqueued a job
 * whose idempotency key then BLOCKED every later attempt, so the tool answered
 * `already_running` about a row that had never been claimed and never would be.
 * Running the work in session settles that obligation, so the row goes with it
 * — only ever a row that is still `queued` (never `running`: something else is
 * holding it, and stealing its key is how a seed runs twice).
 */
async function consumeIdempotencyKey(
  ctx: Pick<McpCtx, "organizationId">,
  idempotencyKey: string,
): Promise<number | null> {
  return withOrg(ctx.organizationId, async (tx) => {
    const [row] = await tx
      .delete(jobs)
      .where(
        and(
          eq(jobs.organizationId, ctx.organizationId),
          eq(jobs.idempotencyKey, idempotencyKey),
          inArray(jobs.status, ["queued"]),
        ),
      )
      .returning({ id: jobs.id });
    return row?.id ?? null;
  });
}

async function prepareDeferred(
  ctx: McpCtx,
  deferred: DeferredTask[],
  signal: AbortSignal,
  /** What makes these tasks SIBLINGS. One run's tasks are prepared from one
   *  picture of the org, so when one of them is accepted the others are the
   *  ones worth re-checking — see `cancelStaleSiblings` in `task.ts`. */
  sessionRunId: string,
): Promise<{
  ids: string[];
  kinds: string[];
  unprepared: { kind: string; reason: string }[];
}> {
  const ids: string[] = [];
  const kinds: string[] = [];
  const unprepared: { kind: string; reason: string }[] = [];
  for (const task of deferred) {
    // A task kind whose preparation needs a corpus it was never handed is a
    // task nobody can answer — skip it rather than raise `source_required` at
    // the owner, who did nothing wrong and cannot supply it either. It is
    // REPORTED, not silently dropped: a `pendingTasks` entry with no matching
    // id told the caller to go and submit something that does not exist.
    if (
      ["brain_notes", "voice_analysis", "product_facts"].includes(task.kind) &&
      !task.sourceText
    ) {
      unprepared.push({ kind: task.kind, reason: "no_source_text" });
      continue;
    }
    const prepared = await startTask(
      ctx,
      {
        taskKind: task.kind,
        ...(task.sourceText ? { sourceText: task.sourceText } : {}),
        ...(task.campaignId ? { campaignId: task.campaignId } : {}),
        ...(task.productId ? { productId: task.productId } : {}),
        ...(task.workerId ? { workerId: task.workerId } : {}),
      },
      signal,
      task.intent,
      sessionRunId,
    );
    ids.push(prepared.id);
    kinds.push(task.kind);
  }
  return { ids, kinds, unprepared };
}

/**
 * Run model-bearing work in the OWNER'S OWN SESSION.
 *
 * `work` runs under `withExternalJudgment`, so every phase inside it that was
 * about to spend a model call defers instead, handing back the corpus it had
 * already gathered. The I/O — the browser sweep, the crawl, the DB reads — runs
 * inline and for real; only the thinking moves. What comes back is task IDS,
 * not instructions: the caller reads the task, judges it, and submits, which
 * is the same durable path `start_task` has always served.
 *
 * The bound is on the CALLER'S patience, not on the work: past
 * `IN_SESSION_BOUND_MS` the reply says `started: true` and the run continues
 * here, preparing its tasks when it finishes.
 */
export async function runPhasesInSession(
  ctx: McpCtx,
  work: () => Promise<unknown>,
  opts: {
    signal?: AbortSignal;
    idempotencyKey?: string;
    boundMs?: number;
    /** Task kinds this call owes even when nothing deferred — the seam a
     *  caller uses when its own corpus is what the task reads. */
    extraTasks?: DeferredTask[];
  } = {},
): Promise<InSessionResult> {
  // NOT the caller's signal for preparation. Past the bound this run outlives
  // the tool call, and a host that cancels the call would then abort the very
  // preparation the reply promised — leaving `started: true` with no task
  // ever appearing. The WORK may still honour `opts.signal` (a handler takes
  // it and can stop between phases); turning its result into a durable task
  // is this process's obligation from the moment it answered.
  const preparing = new AbortController().signal;
  if (opts.idempotencyKey)
    await consumeIdempotencyKey(ctx, opts.idempotencyKey);

  const run = (async (): Promise<InSessionResult> => {
    const external = await withExternalJudgment(work);
    const deferred = [...external.deferred, ...(opts.extraTasks ?? [])];
    const prepared = await prepareDeferred(
      ctx,
      deferred,
      preparing,
      randomUUID(),
    );
    return {
      mode: "in_session",
      taskIds: prepared.ids,
      pendingTasks: prepared.kinds,
      ...(prepared.unprepared.length
        ? { unprepared: prepared.unprepared }
        : {}),
    };
  })();

  const bound = opts.boundMs ?? IN_SESSION_BOUND_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overran = Symbol("overran");
  try {
    const raced = await Promise.race([
      run,
      new Promise<typeof overran>((resolve) => {
        timer = setTimeout(() => resolve(overran), bound);
        timer.unref?.();
      }),
    ]);
    if (raced !== overran) return raced;
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Past the bound. The tool call has answered, so a later failure must not
  // surface as an unhandled rejection against it — but it must not vanish
  // either: this is the one path where the promised task can fail to appear
  // and nothing else is watching.
  run.catch((error) => {
    // eslint-disable-next-line no-console
    console.error(
      `[in-session] work continued past the ${bound}ms bound and then failed; no task was prepared: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return { mode: "in_session", started: true };
}

/**
 * The same thing for work that already exists as a JOB HANDLER.
 *
 * The handler is given the self-scoped context the worker would have given it
 * with ONE field changed: `llm` is absent. That is what makes the phases split
 * — the I/O runs, the first model phase asks the policy and defers — and it is
 * also why nothing here re-implements a handler: the in-session path and the
 * background path are the same code, differing only in who thinks.
 */
export async function runInSession(
  ctx: McpCtx,
  jobType: InSessionJobType,
  payload: unknown = {},
  opts: {
    signal?: AbortSignal;
    idempotencyKey?: string;
    boundMs?: number;
    /** Capabilities the handler will ask for, RESOLVED HERE and frozen.
     *  A handler asks for its grant from inside its own `withOrg`, and the MCP
     *  context's accessor opens a transaction of its own — nesting the two
     *  deadlocks forever at `ENGAGER_PG_POOL_MAX=1`. Resolving before the
     *  handler starts is the discipline every MCP tool already follows: ask
     *  first, then open the transaction with the answer. */
    capabilities?: readonly [CapabilityKind, ...CapabilityKind[]];
    /**
     * How this run re-authorizes hosted spend. A handler fences on its queue
     * lease, and an in-session run has none — so without this a hosted org
     * whose subscription lapsed would get the whole browser sweep for free.
     * The caller passes the same MCP access assertions it would have used
     * inline, and they are checked at every boundary the queued path checks.
     *
     * Two arms because the handler has two kinds of boundary; see
     * `HostedJobExecution.interactiveAuthorizer`.
     */
    authorize?: {
      assertInTx: (tx: Tx) => Promise<void>;
      assertBeforeProvider: () => Promise<void>;
    };
  } = {},
): Promise<InSessionResult> {
  const handler = IN_SESSION_HANDLERS[jobType];
  // Before the capability resolves and before a single byte is read: the
  // entitlement question is asked FIRST, exactly as the tool would have asked
  // it before enqueueing.
  await opts.authorize?.assertBeforeProvider();
  const frozen = opts.capabilities
    ? await ctx.grant(...opts.capabilities)
    : null;
  const grant: CapabilityGrant = frozen
    ? ((async () => frozen) as CapabilityGrant)
    : capabilityGrant({});
  return runPhasesInSession(
    ctx,
    () =>
      handler(
        {
          organizationId: ctx.organizationId,
          // NO queue identity, deliberately. `jobType` without `jobId` and a
          // lease token reads to the hosted-spend fence as a job whose lease
          // was lost, and it would be lying anyway: there is no queue row here,
          // which is the whole point of running in session.
          grant,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.authorize ? { interactiveAuthorizer: opts.authorize } : {}),
        },
        payload,
      ),
    opts,
  );
}

/**
 * The product-link ingest, in session: crawl the site here, hand the bytes to
 * a prepared `product_facts` task, leave the product's own ingest stamps
 * alone. Those stamps describe a BACKGROUND run for the owner to watch;
 * nothing is running in the background, and a stamp claiming otherwise is the
 * kind of lie this whole phase exists to remove.
 */
export async function ingestProductInSession(
  ctx: McpCtx,
  input: { productId: number; link: string; signal?: AbortSignal },
): Promise<InSessionResult & { crawled: boolean; reason?: string }> {
  const corpus = await fetchProductSourceCorpus(input.link);
  if (!corpus.ok)
    return { mode: "in_session", crawled: false, reason: corpus.code };
  const prepared = await runPhasesInSession(ctx, async () => {}, {
    ...(input.signal ? { signal: input.signal } : {}),
    extraTasks: [
      {
        kind: "product_facts",
        productId: input.productId,
        sourceText: corpus.text.slice(0, MAX_DEFERRED_CORPUS_CHARS),
      },
    ],
  });
  return { ...prepared, crawled: true };
}
