import { db as baseDb } from "@engager/database";
import { isLocalDeployment, resolveDeploymentEnvironment } from "@engager/database/environment";
import { holdExecutorLock, type ExecutorLock } from "@engager/database/executorLock";
import type { Job, JobResultValue } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import { reasonClassOf } from "@engager/observability/classify";
import { config } from "../config";
import { llmWithSignal, type LLM } from "../ai/client";
import { boundaryModelScopeFor } from "../ai/modelFor";
import { withUsageContext } from "../ai/usage";
import { hostedJobSpendAccess } from "../entitlements/hosted";
import type { Refusal } from "../refusal";
import {
  capabilityGrant,
  type CapabilityGrant,
  type HandlerCtx,
} from "./context";
import { handleRecalibrateVoice } from "./handlers/recalibrateVoice";
import { handleRelearnVoiceDescription } from "./handlers/relearnVoiceDescription";
import { handleFileBugReport } from "./handlers/fileBugReport";
import { handleForgetSpotted } from "./handlers/forgetSpotted";
import { handleInstallActive } from "./handlers/installActive";
import { handleCompileCampaign } from "./handlers/compileCampaign";
import { handleWorkerRun, releaseRunsLeftRunning } from "./handlers/workerRun";
import { handleDistillPhased } from "./handlers/distill";
import { handleSearchLookalike } from "./handlers/searchLookalike";
import { handleSeedBrain } from "./handlers/seedBrain";
import { releaseLocalBrowser } from "../linkedin/resolve";
import { assertNotRecoveryOnly } from "./recoveryScope";
import {
  ABORT_SETTLE_MS,
  HARD_KILL_GRACE_MS,
  MAX_DRAIN_MS,
  MIN_CLAIM_BUDGET_MS,
} from "./drainBounds";
// Re-exported so every existing caller of the drain still asks the drain for
// its own floor; the number itself lives in a leaf module a surface can read
// without importing an engine.
export { MAX_DRAIN_MS, MIN_DRAIN_MS } from "./drainBounds";
import { handleIngestProduct } from "./handlers/ingestProduct";
import { handlePollIncoming } from "./handlers/pollIncoming";
import { handleInboxCheck } from "./handlers/inboxCheck";
import { handleMonitorEngagement } from "./handlers/monitorEngagement";
import { handleCheckStaleLeads } from "./handlers/checkStaleLeads";
import { handleLeadJudge } from "./handlers/leadJudge";
import { handleLeadScreen } from "./handlers/leadScreen";
import { handleLeadLifecycle } from "./handlers/leadLifecycle";
import { handleNotifyLead } from "./handlers/notifyLead";
import { handleReconcileMessageWrite } from "./handlers/reconcileMessageWrite";
import { handleProcessIncomingPhased } from "./handlers/processIncoming";
import { handleRefreshBrain } from "./handlers/refreshBrain";
import { handleActivateStrategy } from "./handlers/activateStrategy";
import { handleReprojectCampaigns } from "./handlers/reprojectCampaigns";
import { handleAgentStepTimeout } from "./handlers/agentStepTimeout";
import { handleDispatchActions } from "./handlers/dispatchActions";
import { handleInvitationWatch, handleWithdrawalRead } from "./handlers/invitationWatch";
import { handleInviteNoteCheck } from "./handlers/inviteNoteCheck";
import { handleOwnerInviteMember } from "./handlers/ownerInviteMember";
import { handleResearchSignals } from "./handlers/researchSignals";
import { handleLiveCheckRead } from "./handlers/liveCheckRead";
import { handleRedraftForVoice } from "./handlers/redraftForVoice";
import { handleRedraftAction } from "./handlers/redraftAction";
import { handleRedraftComments } from "./handlers/redraftComments";
import { handleRedraftRoomReply } from "./handlers/redraftRoomReply";
import { runtimeInstanceId } from "../execution/authority";
import { beatRuntimeHeartbeat } from "../tasks/liveness";
import { startSuspensionWatch } from "../supervision/suspension";
import { clearRuntimeForServedOrgs, startRuntimeBeat } from "./runtimeBeat";
import {
  claimNextJob,
  completeJob,
  extendLease,
  failJob,
  LEASE_MS,
  RescheduleError,
} from "./queue";

/**
 * What a handler reports having done, persisted onto the job row by
 * `completeJob`.
 *
 * Counts, and only ones the SERVER observed — the register that shows them
 * exists because "the job finished" and "the job accomplished something" turned
 * out to be different facts. The refusal arm splits the third one off: a job
 * that reported zero could equally have swept and found nothing or never
 * reached the account at all, and until this arm existed both wrote the same
 * row.
 *
 * A refused job COMPLETES. Nothing crashed and nothing is owed a retry with a
 * consumed attempt — the account said no, which is an outcome, so it lands on
 * the row that records outcomes rather than on `failJob`'s crash path.
 * Rendering is T-5.10's.
 */
export type JobResult = Record<string, number> | { refusal: Refusal };

/**
 * The column and this type are the SAME type — asserted, not assumed.
 *
 * `packages/database` cannot import core, so `JobResultValue` restates this
 * shape, and `completeJob`'s call site alone proves only that a `JobResult` is
 * WRITABLE to the column: a field added here would be written and stay
 * invisible to every reader typed off the column. The idiom is
 * `connector/binding.ts`'s, and it lives in this module because this is the
 * only one that can see both names.
 *
 * TWO assertions, because one of them is not enough and the difference is not
 * obvious. Structural equality catches a changed or widened member — a fifth
 * rung on `RefusalLayer` fails here rather than at whatever reads the column.
 * It does NOT catch an added OPTIONAL field, since a value missing `hint?` is
 * still assignable both ways; the key-set equality is what catches that, and it
 * is the direction a refusal is most likely to grow.
 *
 * What NEITHER reaches: `$type` is a compile-time cast, so nothing validates
 * rows already sitting in `jobs.result` under an earlier shape. Harmless today
 * — every stored row is the counts arm, which is still a valid member — but
 * T-5.10 is the first code to parse them, and it reads what is there rather
 * than what this type says.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type RefusalArm<T> = Extract<T, { refusal: unknown }>["refusal"];
const JOB_RESULT_IS_THE_COLUMN: Equal<JobResult, JobResultValue> = true;
const JOB_RESULT_HAS_THE_COLUMNS_FIELDS: Equal<
  keyof RefusalArm<JobResult>,
  keyof RefusalArm<JobResultValue>
> = true;
void JOB_RESULT_IS_THE_COLUMN;
void JOB_RESULT_HAS_THE_COLUMNS_FIELDS;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (ctx: HandlerCtx, payload: any) => Promise<JobResult | void>;

// Unregistered job types dead-letter in runOnce rather than crash the worker.
// To add a job type: add it to the schema's job-type union and register a handler
// here (or in SELF_SCOPED below).
const HANDLERS: Partial<Record<Job["type"], Handler>> = {
  forget_spotted: handleForgetSpotted,
  // Daily fold of unanswered Find leads people into No answer: pure DB work, so
  // one org-scoped tx is correct and no provider call happens inside.
  lead_lifecycle: handleLeadLifecycle,
  // Usage data: rows in, one event out. No provider call, nothing held open.
  install_active: handleInstallActive,
  // A scheduled strategy version reaching its instant. Activation is one
  // transaction by contract — version flip and projection together — so the
  // org-scoped tx this lane opens is the one it needs.
  activate_strategy: handleActivateStrategy,
  reproject_campaigns: handleReprojectCampaigns,
  // An agent step's wait reaching its expiry: consume it and wake or
  // escalate, in one org-scoped tx with no provider call inside.
  agent_step_timeout: handleAgentStepTimeout,
};

/** Context a self-scoped handler gets instead of an open `withOrg` tx. */
export type SelfScopedCtx = {
  organizationId: string;
  jobId?: number;
  jobType?: Job["type"];
  jobLeaseToken?: string;
  /** Failed attempts on the claimed queue row, never an input from its payload. */
  jobAttempts?: number;
  /** The attempts the queue row may fail before it dies, so a handler can tell
   *  a failure the queue will retry from the one that is final. */
  jobMaxAttempts?: number;
  /** A capability on this org's account, or the reason there is none. A
   *  SELF_SCOPED handler gets no `withOrg` tx from the worker, so it opens its
   *  own short one and hands it here — see `CapabilityGrant`, and `grantFor`
   *  for what an unfilled seam means. */
  grant?: CapabilityGrant;
  llm?: LLM;
  /** See HandlerCtx.signal — the job's wall-clock budget; check between steps. */
  signal?: AbortSignal;
  /** How a handler running IN SESSION re-authorizes hosted spend, having no
   *  queue lease to fence on. The worker never sets it; `runInSession` does.
   *  See `HostedJobExecution.interactiveAuthorizer` for why it has two arms. */
  interactiveAuthorizer?: {
    assertInTx: (tx: Tx) => Promise<void>;
    assertBeforeProvider: () => Promise<void>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SelfScopedHandler = (
  ctx: SelfScopedCtx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
) => Promise<JobResult | void>;

// Handlers that MUST manage their own org-scoping + connection discipline, so the
// worker does NOT wrap them in `withOrg`. `compile_campaign` releases the pooled
// connection across its Haiku call (snapshot→release→LLM→short-write CAS) — wrapping
// it in `withOrg` would hold the connection across the LLM call (133f979).
const SELF_SCOPED: Partial<Record<Job["type"], SelfScopedHandler>> = {
  // Managed cognition lanes: detached DB snapshots -> provider work with no
  // connection held -> exact lease/entitlement CAS apply.
  process_incoming: handleProcessIncomingPhased,
  distill: handleDistillPhased,
  search_lookalike: handleSearchLookalike,
  compile_campaign: handleCompileCampaign,
  // Read-side handlers that hit the provider manage their own short txs (snapshot/reserve →
  // release → provider/Haiku with NO connection held → short write) so they never pin the
  // only pooled connection across a network/LLM call at ENGAGER_PG_POOL_MAX=1.
  // One worker run spans a browser sweep AND two agent-CLI calls; a withOrg
  // wrapper would pin the only pooled connection across both. It takes the
  // channel run lease instead, and every DB touch inside is its own short
  // transaction.
  worker_run: handleWorkerRun,
  poll_incoming: handlePollIncoming,
  monitor_engagement: handleMonitorEngagement,
  // Capacity-aware selection: runs everything in ONE org-scoped tx under a per-org
  // advisory lock (lock-first), so it must NOT be wrapped in the worker's withOrg.
  // Voice import: fetchOwnPosts (provider) + learnVoice (LLM) between short txs.
  // Brain seed from the owner's own posts: browser sweep -> chunked extraction,
  // every chunk written through in its own short scope.
  seed_brain: handleSeedBrain,
  // An owner's live check's read: one page load on the account between short
  // scopes, its result kept on the check.
  live_check_read: handleLiveCheckRead,
  // Steady-state fallback recalibration from the voice_samples corpus: cadence
  // self-gate snapshot -> LLM continuation with no connection held -> Voice
  // revision-fenced apply. The client playbook is primary; this is the 72h net.
  recalibrate_voice: handleRecalibrateVoice,
  // A new voice's description drafted from the owner's own writing: the
  // account's reads and a distillation with no connection held, then one
  // short write of the proposal.
  relearn_voice_description: handleRelearnVoiceDescription,
  // Daily Brain assessment/refill: short snapshot -> provider preparation ->
  // short version-fenced apply. Never pin the pool across either LLM call.
  refresh_brain: handleRefreshBrain,
  // Product ingest: commit the facts (so the wizard's product card shows immediately),
  // THEN pre-generate the campaign suggestion in a separate tx — the second LLM must not
  // hold the facts hostage in the same transaction / pin the connection across it.
  ingest_product: handleIngestProduct,
  reconcile_message_write: handleReconcileMessageWrite,
  // Hot-lead notification: snapshot → profile-budgeted enrichment + email with
  // no connection held → short notifiedAt write.
  notify_lead: handleNotifyLead,
  // Daily stale-hot-lead digest: snapshot → email → nudgedAt write.
  check_stale_leads: handleCheckStaleLeads,
  // Trial renewal is released only from immutable activation authority. Stripe
  // runs between two short DB scopes, never inside a held org transaction.
  // The dispatch gate commits `dispatching` before the click and settles after
  // it, each in its own short transaction — the action ledger's two-phase send.
  dispatch_actions: handleDispatchActions,
  // A profile page load between two short transactions, as the gate's own
  // preflight read is.
  invitation_watch: handleInvitationWatch,
  withdrawal_read: handleWithdrawalRead,
  // The conversation read for an accepted invitation's note: up to the list
  // and one conversation, between short transactions, as the inbox check is.
  invite_note_check: handleInviteNoteCheck,
  owner_invite_member: handleOwnerInviteMember,
  // The owner's Research press: each person's profile read, then a qualify
  // call, between short transactions under the account's run lease.
  research_signals: handleResearchSignals,
  // The account's light inbox check: the inbox read and each conversation's
  // page load between short transactions, as a wake's own inbox read is.
  inbox_check: handleInboxCheck,
  // A voice update's redraft: one model call per waiting draft, each made
  // with no transaction held and written back in its own short one.
  redraft_for_voice: handleRedraftForVoice,
  // A comment the owner asked for again: a writer call and an evidence review
  // per batch, no transaction held, each completion its own short one.
  redraft_comments: handleRedraftComments,
  redraft_room_reply: handleRedraftRoomReply,
  // A DM the owner asked for again: one writer call, no transaction held, the
  // words kept in their own short one.
  redraft_action: handleRedraftAction,
  // A problem report: the owner's agent writes it up, then one POST to the
  // cloud relay — neither with a transaction held, each row write its own.
  file_bug_report: handleFileBugReport,
  // One campaign's Screen and Judge: the owner's agent over a batch of words or
  // one person, with no transaction held and no account touched.
  lead_screen: handleLeadScreen,
  lead_judge: handleLeadJudge,
};

/** Every job type this worker has a handler for, either way. A type missing
 *  here dead-letters in `runOnce`, so the wiring test checks everything the
 *  scheduler enqueues against it. */
export function registeredJobTypes(): ReadonlySet<string> {
  return new Set([...Object.keys(HANDLERS), ...Object.keys(SELF_SCOPED)]);
}

/**
 * The lease of every job this process is running right now, across its lanes.
 * Handed to the reaper on every claim (`claimNextJob`): a job in this set is
 * alive by definition, however stale its `lockedAt` looks after a sleep.
 */
const heldLeases = new Set<string>();

/** Where the worker runs the claim/complete/fail bookkeeping (cross-org, NOT RLS). */
export type WorkerCtx = {
  db?: typeof baseDb;
  /** Deterministic failure seam for the initial hosted entitlement lookup. */
  hostedSpendAccess?: typeof hostedJobSpendAccess;
  /**
   * Optional capability seam. When supplied (tests, local single-account runs)
   * it answers every capability question for every job; when omitted — the
   * production default, since both entry points start as `runLoop({})` — each
   * grant resolves the job org's own channel row. `capabilityGrant` is the one
   * place that default lives; a suite that means one particular connector
   * states it with `injectedGrant`.
   */
  grant?: CapabilityGrant;
  llm?: LLM;
};

/**
 * Claim and run a single due job to completion. Returns false when the queue is
 * empty.
 *
 * TENANCY: the claim + complete/fail bookkeeping run on the BASE db (the `jobs`
 * table is not RLS-protected, so the worker scans across ALL orgs); the handler
 * itself runs inside `withOrg(job.organizationId, …)` so every query it makes is
 * scoped to the job's org via RLS + the `app.current_org` GUC.
 *
 * CONNECTION DISCIPLINE (load-bearing): `withOrg` opens a transaction that holds a
 * SINGLE pooled connection for the whole callback. The complete/fail bookkeeping
 * therefore runs in a SEPARATE phase AFTER `withOrg` returns and frees that
 * connection. Doing it inside the callback would need a second connection and
 * DEADLOCK forever at `ENGAGER_PG_POOL_MAX=1` — pg's pool has no acquire timeout,
 * so the job (and the whole queue behind it) hangs until the function is killed.
 *
 * `opts.ownOrgs` (tests only) restricts the claim to a set of org ids so
 * concurrent test files sharing the un-RLS'd `jobs` table never claim each
 * other's jobs. Production callers omit it and process every org.
 */
export async function runOnce(
  baseCtx: WorkerCtx,
  opts?: {
    ownOrgs?: Set<string>;
    /** The MOST wall-clock this drainer can give any job (its remaining runway). */
    timeoutMs?: number;
    /** Generic per-job budget for types without a TYPE_BUDGET_MS entry. */
    defaultBudgetMs?: number;
    /** Job types this drainer must not claim (budget exceeds its runway). */
    excludeTypes?: Job["type"][];
    /** Orphan-rescue age for excluded types (see claimNextJob). The prep lanes pass
     *  Infinity: they must NEVER claim a posting job no matter how stale it is —
     *  posting belongs to the serial main lane, always. */
    rescueAfterMs?: number;
    /** Heartbeat interval override (tests). Default LEASE_MS/2, unbudgeted runs only. */
    heartbeatMs?: number;
  },
): Promise<boolean> {
  // A recovery task exists to resolve an obligation that already happened. It
  // may never take ordinary queue work, whose whole purpose is to start new
  // work the cancelled subscription no longer pays for.
  assertNotRecoveryOnly("claim_queue_job");
  const db = baseCtx.db ?? baseDb;
  const onlyOrgs = opts?.ownOrgs ? [...opts.ownOrgs] : undefined;
  const job = await claimNextJob(
    db,
    Date.now(),
    undefined,
    onlyOrgs,
    opts?.excludeTypes,
    opts?.rescueAfterMs,
    [...heldLeases],
  );
  if (!job) return false;
  // A claim always stamps a token; the guard is for the type, not the row.
  const lease = job.leaseToken;
  if (lease) heldLeases.add(lease);
  try {
    return await runClaimed(baseCtx, db, job, opts);
  } finally {
    if (lease) heldLeases.delete(lease);
  }
}

/** `runOnce` past its claim: one job's handler and its bookkeeping. */
async function runClaimed(
  baseCtx: WorkerCtx,
  db: typeof baseDb,
  job: Job,
  opts: Parameters<typeof runOnce>[1],
): Promise<boolean> {
  const handler = HANDLERS[job.type];
  const selfScoped = SELF_SCOPED[job.type];
  if (!handler && !selfScoped) {
    // Unregistered job types dead-letter rather than crash the worker.
    await failJob(db, job, `no handler for job type "${job.type}"`);
    return true;
  }

  const boundedPrepaymentOrRecovery = new Set<Job["type"]>([
    "forget_spotted",
    // Usage data is sent by every install, a lapsed plan included.
    "install_active",
  ]);
  // The effective budget: never more than what the drainer allows (its runway,
  // via opts.timeoutMs), and never more than the type's nominal budget (falling
  // back to the drainer's default). A slow-by-design type that WAS claimable
  // (runway covered its budget) gets its full budget, not the generic default.
  // No opts.timeoutMs (continuous worker) → unbudgeted.
  const cap = opts?.timeoutMs;
  const nominal = TYPE_BUDGET_MS[job.type] ?? opts?.defaultBudgetMs ?? cap ?? 0;
  const timeoutMs = cap && cap > 0 ? Math.min(cap, nominal) : undefined;

  // Heartbeat (continuous worker only — a budgeted job finishes well inside the
  // lease): extend lockedAt while the job legitimately runs past LEASE_MS, so a
  // concurrent serverless drain's reaper doesn't count a healthy slow job as a
  // failed attempt and hand it to a second worker mid-run. Token-guarded — once
  // reaped (shouldn't happen while beating), the extension misses and stops.
  // The interval query waits its turn on the base pool (never inside the
  // handler's tx), so it cannot deadlock even at pool max 1 — worst case it
  // fires late, which is harmless.
  //
  // The SAME timer also writes this runtime's `runtime_heartbeats` row for the
  // job's org. Two facts, one cadence: the lease says "this row is still being
  // worked", the beat says "a process is here at all" — which is what an
  // interactive tool has to know BEFORE it queues anything (`agentHealthy`).
  // `runLoop` beats for every served org on its own timer as well, so an idle
  // worker stays alive to a reader; this arm is what keeps a BUSY one alive
  // when one long job outlasts a whole beat window.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (!timeoutMs || timeoutMs <= 0) {
    const beat = () => {
      void extendLease(db, job).catch(() => {});
      void withOrg(job.organizationId, (tx) =>
        beatRuntimeHeartbeat(tx, runtimeInstanceId()),
      ).catch(() => {});
    };
    beat();
    heartbeat = setInterval(beat, opts?.heartbeatMs ?? LEASE_MS / 2);
    heartbeat.unref?.();
  }

  // Phase 1 — run the handler. A normal handler runs INSIDE the org-scoped tx
  // (holding the only pooled connection at pool max 1, so it does NO base-db
  // bookkeeping — that's phase 2). A SELF_SCOPED handler manages its own (short)
  // tx scopes instead, so the worker must NOT open one around it.
  let reschedule: RescheduleError | null = null;
  let error: string | null = null;
  let accessDenied: { reason: string; countAttempt: boolean } | null = null;
  /** The handler's receipt, written onto the row by completeJob in phase 2. */
  let result: JobResult | null = null;
  // The job's wall-clock budget as a REAL cancellation signal: bound to every LLM
  // call the handler makes (llmWithSignal) and exposed on the handler ctx so
  // multi-step handlers can stop between steps. Only aborted when a timeout is set
  // (serverless drain) — on es2/runLoop it never fires.
  const budget = new AbortController();
  try {
    // Claim already committed, so entitlement lookup belongs inside the caught
    // execution boundary. A transient lookup error is recorded immediately
    // instead of leaving this row running until its lease is reaped.
    if (!boundedPrepaymentOrRecovery.has(job.type)) {
      const entitlement = await withOrg(job.organizationId, (tx) =>
        (baseCtx.hostedSpendAccess ?? hostedJobSpendAccess)(
          tx,
          job.organizationId,
          job.type,
          {
            currentJobId: job.id,
            currentJobLeaseToken: job.leaseToken ?? undefined,
          },
        ),
      );
      if (!entitlement.allowed) {
        accessDenied = {
          reason: entitlement.reason,
          countAttempt: entitlement.reason !== "subscription_inactive",
        };
      }
    }

    // Record any AI spend this job incurs, attributed to the org/job/stage and
    // flushed AFTER all txs close (phase-2 safe — see withUsageContext). The
    // scope also carries the (agent, model-per-role) this job resolves with, so
    // every model call underneath reads one answer instead of a global.
    if (!accessDenied) {
      await withUsageContext(
        {
          organizationId: job.organizationId,
          jobId: job.id,
          jobLeaseToken: job.leaseToken ?? null,
          requestId: `worker:${job.id}:${job.leaseToken ?? "unleased"}`,
          budgetTool: job.type,
          source: "worker",
          stage: job.type,
          ...(await boundaryModelScopeFor(job.organizationId)),
        },
        async () => {
          // Bind the injected (or lazily-resolved configured) LLM to the budget signal:
          // when the budget expires, in-flight LLM calls CANCEL instead of running on
          // abandoned — and per-request retries are disabled (a retry under an expiring
          // budget is a doomed request we'd pay for).
          const jobLlm =
            timeoutMs && timeoutMs > 0
              ? llmWithSignal(baseCtx.llm, budget.signal)
              : baseCtx.llm;
          // The capability seam both arms hand down. Per-tenant resolution moved
          // INTO it: a handler names the kind it needs and receives only that,
          // where the worker used to resolve one whole driver per job and pass
          // it to everything.
          const grant = capabilityGrant(baseCtx);
          const run = (async () => {
            if (selfScoped) {
              result =
                (await selfScoped(
                  {
                    organizationId: job.organizationId,
                    jobId: job.id,
                    jobType: job.type,
                    jobLeaseToken: job.leaseToken ?? undefined,
                    jobAttempts: job.attempts,
                    jobMaxAttempts: job.maxAttempts,
                    grant,
                    llm: jobLlm,
                    signal: budget.signal,
                  },
                  job.payload ?? {},
                )) ?? null;
              return;
            }
            await withOrg(job.organizationId, async (tx) => {
              result =
                (await handler!(
                  {
                    db: tx,
                    grant,
                    jobId: job.id,
                    jobType: job.type,
                    jobLeaseToken: job.leaseToken ?? undefined,
                    llm: jobLlm,
                    signal: budget.signal,
                  },
                  job.payload ?? {},
                )) ?? null;
            });
          })();

          // Per-job wall-clock budget (serverless drain only — runLoop/tests omit it).
          // Without it a slow job runs uncapped toward the function's hard kill, so the
          // phase-2 complete/fail bookkeeping below never runs and the row is orphaned in
          // `running`. Racing a timeout lets that bookkeeping run: the timeout throws a
          // normal Error → the catch below records a real failure (attempt counted →
          // backoff → eventual dead-letter) instead of a silent process-kill.
          if (!timeoutMs || timeoutMs <= 0) {
            await run;
            return;
          }
          // Swallow the run's eventual settle so a late rejection can't surface as an
          // unhandled rejection after the failure is already recorded.
          run.catch(() => {});
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              run,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `job exceeded ${timeoutMs}ms wall-clock budget`,
                      ),
                    ),
                  timeoutMs,
                );
              }),
            ]);
          } catch (e) {
            // Budget expired (or the run threw — aborting then is a no-op): CANCEL the
            // in-flight work and wait (bounded) for the handler to actually unwind, so
            // it releases its pooled connection and stops mutating BEFORE phase 2
            // records the failure — no abandoned execution racing the retry.
            budget.abort();
            await Promise.race([run.catch(() => {}), sleep(ABORT_SETTLE_MS)]);
            throw e;
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      );
    }
  } catch (e) {
    if (e instanceof RescheduleError) {
      reschedule = e;
    } else if (isBrowserSessionBusy(e)) {
      // Another process holds the local browser session — observed live as the
      // sidecar's journal lock ("journal is already in use") surfacing to the
      // caller as "subprocess exited before ready". Typically an interactive
      // MCP session driving the same profile. Not a job failure: back off and
      // retry once that session has let go, without burning an attempt.
      //
      // Ninety seconds, because the holder now releases on its own: an idle
      // sidecar hands the profile back after DEFAULT_IDLE_RELEASE_MS. The
      // quarter-hour this used to wait was written when nothing ever let go,
      // and it is the difference between the Brain seed landing while the owner
      // is still in the setup conversation and it landing after they gave up.
      reschedule = new RescheduleError(
        "browser session busy (another process holds the profile)",
        Date.now() + 90_000,
      );
    } else {
      error = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.error(`[worker] job ${job.id} (${job.type}) failed: ${error}`);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  // Phase 2 — record the outcome on the base pool, AFTER the tx connection is freed.
  // All three writes are lease-token-guarded: if this job was reaped mid-run (lease
  // expired without a heartbeat), the reaper already recorded the attempt and the
  // job may be re-running elsewhere — these become no-ops instead of stomping it.
  if (accessDenied) {
    await failJob(db, job, accessDenied.reason, {
      retryAt: Date.now() + 6 * 60 * 60_000,
      countAttempt: accessDenied.countAttempt,
    });
  } else if (reschedule) {
    // Not a failure — caps/windows clear on their own; don't burn an attempt.
    // The refusal behind it (or null: this hold is pacing) is the row's
    // receipt, so Activity can show a send the account cannot make.
    await failJob(db, job, reschedule.message, {
      retryAt: reschedule.retryAt,
      countAttempt: false,
      result: reschedule.refusal ? { refusal: reschedule.refusal } : null,
    });
  } else if (error !== null) {
    await failJob(db, job, error);
    // Usage data: a failed attempt, by job type and the class of its reason
    // (the error text is read and dropped).
    track("job_failed", { type: job.type, reason_class: reasonClassOf(error), attempt: job.attempts + 1 });
  } else {
    await completeJob(db, job, result);
  }
  return true;
}

/**
 * The local browser sidecar failed to START because another process already
 * holds the session (exclusive journal lock, then the Chromium profile lock).
 * Matched by NAME so this module never static-imports the browser-use graph,
 * and scoped to STARTUP only — a timeout or protocol error mid-request is
 * ambiguous and must keep failing loudly, not reschedule.
 *
 * Two shapes, because the transport now diagnoses the lock rather than
 * reporting it as an anonymous crash: `BrowserUseProfileInUseError` IS this
 * condition, named, and the message-matched startup failure remains for a
 * sidecar that died before it could say why. Recognising only the second would
 * send the interactive-MCP-holds-the-profile case — the one this predicate
 * exists for — to the generic branch, burning an attempt per collision until
 * the job dead-letters.
 */
function isBrowserSessionBusy(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    e.name === "BrowserUseProfileInUseError" ||
    (e.name === "BrowserUseTransportError" &&
      e.message.includes("exited before ready"))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

/** The time fence on what the runtime releases as it starts: what was touched
 *  within this span before the boot is left to a second pass this long after
 *  it. A second guard behind the executor lock, sized to a bounded drain's
 *  budget and its parent's kill margin past it (`drainChild.mjs`). */
const START_RELEASE_FENCE_MS = MAX_DRAIN_MS + 30_000;

/** A real local install, where this process may release what a quit left.
 *  Not `test`: suites share one database, and a release there is scoped by the
 *  suite itself (`releaseRunsLeftRunning`'s `onlyOrgs`). */
function releasesAtStart(): boolean {
  return isLocalDeployment() && resolveDeploymentEnvironment() !== "test";
}

/**
 * Long-running loop (used by the local single-process runner; the serverless
 * deployment calls `runOnce` from a batch-drain route instead). When `baseCtx`
 * omits a grant, each capability a job asks for resolves against that job org's
 * own channel row. Not exercised by tests.
 */
export async function runLoop(
  baseCtx: WorkerCtx,
  opts?: { idleMs?: number; prepConcurrency?: number },
): Promise<void> {
  const idleMs = opts?.idleMs ?? 3000;
  // Extra CONCURRENT lanes for PREP_TYPES only (interactive onboarding work a
  // user is watching). The main lane claims every non-prep job serially — its
  // single-concurrency + jitter gap is the posting pace. Requires pool headroom:
  // set ENGAGER_PG_POOL_MAX >= 1 + prepConcurrency on the host (at pool 1 the
  // lanes still work — short txs interleave — but DB access serializes).
  const prepConcurrency = Math.max(
    0,
    opts?.prepConcurrency ?? Number(process.env.ENGAGER_PREP_CONCURRENCY ?? 2),
  );

  // Graceful shutdown: a CD redeploy sends SIGTERM — WITHOUT this handler the
  // current job dies mid-run, its row sits `running` for the full LEASE_MS until
  // the reaper burns an attempt on it, and (for long types the serverless drain
  // won't claim) onboarding stalls for minutes. Instead: every lane finishes its
  // in-flight job, skips claiming another, exits clean. systemd's stop timeout
  // (default 90s) still SIGKILLs a truly long job — the lease/reap machinery
  // remains the backstop for that.
  let stopping: string | null = null;
  const requestStop = (signal: string) => {
    stopping = signal;
    // eslint-disable-next-line no-console
    console.log(
      `[worker] ${signal} received — finishing in-flight jobs, then exiting`,
    );
  };
  process.once("SIGTERM", () => requestStop("SIGTERM"));
  process.once("SIGINT", () => requestStop("SIGINT"));

  // Clear boot banner so the worker's startup is easy to spot and trace in logs.
  // eslint-disable-next-line no-console
  console.log(
    `[worker] booting: pid=${process.pid} connector=${baseCtx.grant ? "injected" : "per-org"} prepLanes=${prepConcurrency} idleMs=${idleMs} at ${new Date().toISOString()}`,
  );

  // This process's share of the executor lock, taken before any lane claims
  // and held until it stops: it is how every other process of the install
  // knows this one is alive (`executorLock.ts`), so a process that cannot take
  // it claims nothing until it can. Then a worker run still `running` is
  // released now rather than holding its channel for the abandoned-run reaper's
  // 35 minutes — only while no other process holds the lock, and only what
  // nothing has touched within the fence; what is newer, or what another live
  // process held at the first pass, is tried once more a fence after the boot
  // and otherwise left to the reaper (`releaseRunsLeftRunning`). Local only: a
  // hosted continuous worker shares its queue with serverless drains that hold
  // no lock.
  let executorLock: ExecutorLock | null = null;
  if (releasesAtStart()) {
    while (!executorLock && !stopping) {
      executorLock = await holdExecutorLock().catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[worker] executor lock unavailable, claiming nothing yet:", e instanceof Error ? e.message : e);
        return null;
      });
      if (!executorLock) await sleep(idleMs);
    }
    const lock = executorLock;
    if (lock) {
      const bootedAt = Date.now();
      const release = (before: number) =>
        releaseRunsLeftRunning(before, { lock, spareLeaseTokens: heldLeases }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error("[worker] could not release runs a quit left running:", e);
        });
      await release(bootedAt - START_RELEASE_FENCE_MS);
      setTimeout(() => void release(bootedAt), START_RELEASE_FENCE_MS).unref?.();
    }
  }

  const lane = async (
    pace: "posting" | "prep",
    laneOpts?: Parameters<typeof runOnce>[1],
  ) => {
    for (;;) {
      if (stopping) return;
      let did = false;
      try {
        // No per-job browser release anymore: this process is the standing
        // holder (the browser bridge), and Chrome lives for the process's
        // life. The per-job lease existed so OTHER processes could grab the
        // profile between jobs — they reach the browser through the bridge
        // now, so handing the profile back per job would only re-create the
        // open/close churn the bridge removed.
        did = await runOnce(baseCtx, laneOpts);
      } catch (e) {
        // A transient infra error (e.g. Neon dropped the connection mid-claim) must NOT
        // kill the lane — log, back off, and the next iteration reconnects. Per-job
        // failures are already handled inside runOnce; this catches the layer below it.
        // eslint-disable-next-line no-console
        console.error(
          "[worker] runOnce error (continuing):",
          e instanceof Error ? e.message : e,
        );
        await sleep(idleMs);
        continue;
      }
      if (stopping) return; // exit check before sleeping — don't linger on shutdown
      // Main lane: single-concurrency + a human-ish gap naturally paces posting.
      // Prep lanes: no pacing needed (nothing posts) — just a short breather.
      await sleep(
        did ? (pace === "posting" ? jitter(800, 2500) : 250) : idleMs,
      );
    }
  };

  // Proof of life for every org this process serves, on the job heartbeat's own
  // cadence. It starts BEFORE the lanes and stops with them: a tool that reads
  // it while the loop is up must never be told to wait for a process that is
  // going away, and one that reads it a moment after SIGTERM finds a row that
  // ages out of the window on its own.
  const stopRuntimeBeat = startRuntimeBeat(
    baseCtx.db ?? baseDb,
    LEASE_MS / 2,
  );
  // A worker run cut by a sleep says so instead of failing, and a run that
  // would start mid-wake waits for the machine (`supervision/suspension.ts`).
  startSuspensionWatch();

  // The Find leads steps only call the owner's agent, so where prep lanes run
  // they never hold the posting lane; with none, the posting lane takes them.
  const lanes = [
    lane("posting", prepConcurrency > 0 ? { excludeTypes: [...LEAD_STEP_TYPES], rescueAfterMs: Number.POSITIVE_INFINITY } : {}),
  ];
  for (let i = 0; i < prepConcurrency; i++) {
    lanes.push(
      lane("prep", {
        excludeTypes: NON_PREP_TYPES,
        // NEVER rescue a non-prep (posting!) job into a concurrent lane.
        rescueAfterMs: Number.POSITIVE_INFINITY,
      }),
    );
  }
  await Promise.all(lanes);
  stopRuntimeBeat();
  // The beat outlives the loop by up to RUNTIME_HEARTBEAT_STALE_MS unless the
  // exit says otherwise, and a graceful exit knows better than the clock: an
  // owner who quits and immediately asks for a seed should route into their own
  // session now, not in three minutes. A crash still falls back to staleness.
  await clearRuntimeForServedOrgs(baseCtx.db ?? baseDb, runtimeInstanceId());
  await executorLock?.release();
  // Nothing of this process may outlive it. A sidecar is a child holding a real
  // Chrome and the machine's one browser profile, and an exit that leaves it
  // running leaves the next process — or the next boot of this one — waiting on
  // a profile whose owner is gone. Jobs release it as they finish; this is the
  // same release for the case where the loop itself is what ended.
  await releaseLocalBrowser();
  // eslint-disable-next-line no-console
  console.log(`[worker] stopped cleanly (${stopping})`);
}

/**
 * Serverless batch drain: claim + run jobs until the queue is empty, a job-count
 * budget, or a wall-clock budget (so the function returns before the platform
 * timeout). This REPLACES the long-running `runLoop` on Vercel — the QStash-
 * triggered `/api/jobs/drain` route calls it. Concurrent drains are safe because
 * `claimNextJob` uses `FOR UPDATE SKIP LOCKED`. Posting pace is still enforced by
 * `canEngage` (a min-gap miss throws RescheduleError → requeues for a later tick),
 * not by this loop.
 */

/**
 * Nominal wall-clock budgets for job types that are SLOW BY DESIGN (crawl + LLM
 * chains, paginated provider sweeps, multi-campaign distills). A drainer whose
 * remaining runway is below a type's budget does not claim it — on the 60s
 * serverless drain that routes these to the continuous es2 worker (unbudgeted,
 * heartbeats its lease) instead of burning an attempt per doomed claim. If no
 * continuous worker is running they wait as `queued` — visible and recoverable,
 * unlike five futile serverless attempts dead-lettering them.
 */
export const TYPE_BUDGET_MS: Partial<Record<Job["type"], number>> = {
  ingest_product: 120_000, // Firecrawl crawl + extract LLM + suggest LLM
  distill: 120_000, // per-campaign feedback distill chain
  recalibrate_voice: 120_000, // sample-corpus continuation learn (LLM, no driver)
  relearn_voice_description: 120_000, // own posts + comments, distillation LLM calls
  refresh_brain: 120_000, // LinkedIn re-seed: fetch + LLM re-chunk
  // Own-posts sweep plus one agent-CLI spawn per corpus chunk. The corpus is
  // capped at 50k chars and chunks at 16k, so four extractions at ~19s each
  // (measured, Haiku 4.5) on top of the sweep — never a serverless drain.
  seed_brain: 240_000,
  reconcile_message_write: 120_000,
  monitor_engagement: 120_000, // sweep + per-watch reply/reaction drill-ins
  // A browser sweep plus a cold agent-CLI triage turn. Measured at ~170s for
  // 25 posts against the CLI's own 180s ceiling, so this belongs to the
  // continuous worker and must never be claimed by a short serverless drain.
  notify_lead: 90_000, // profile-budgeted enrichment + email send
  // Up to DRAIN_LIMIT likes, each a thread read and a page load with the like
  // op's own confirmation wait — never a short serverless drain.
  dispatch_actions: 240_000,
  // One profile read: a page load and its top card's hydration wait.
  invitation_watch: 90_000,
  withdrawal_read: 90_000,
  // The inbox list and one conversation's history or page.
  invite_note_check: 150_000,
  owner_invite_member: 90_000,
  // Up to ten profile reads, each with a qualify call: 10 × (90s read + 30s agent-CLI turn).
  research_signals: 1_200_000,
  // One read op — a profile, the invitations page or one conversation.
  live_check_read: 90_000,
  // The inbox page plus up to three spaced conversation reads, each message a
  // classification call — never a short serverless drain.
  inbox_check: 180_000,
  // The agent's write-up (bounded at 120s) and one relay POST (60s).
  file_bug_report: 200_000,
};

/**
 * PREP jobs: interactive onboarding/config work a user is actively WATCHING (the
 * wizard's live progress panel). Safe to run CONCURRENTLY — all SELF_SCOPED
 * (short txs, mostly network/LLM time) and none writes to LinkedIn. Everything
 * else — posting above all — stays on the single serial main lane:
 * single-concurrency plus the jitter gap is part of the account-safety pacing.
 * Measured cost of NOT doing this: import_voice and ingest_product enqueued
 * together ran serially — the user waited the SUM (~150s) instead of the max.
 */
const PREP_TYPES: ReadonlySet<Job["type"]> = new Set<Job["type"]>([
  "ingest_product",
  "compile_campaign",
  // The owner watches "Sending report…" in the sidebar, and a report touches
  // neither the browser nor the account: an agent call and one POST.
  "file_bug_report",
  // Scout's Screen and Judge make model calls and nothing else: no browser and
  // no account, so a post or a sweep never waits behind them.
  "lead_screen",
  "lead_judge",
]);

/** The Find leads steps that only call the owner's agent. They are prep work,
 *  and the posting lane leaves them to the prep lanes whenever any run. */
export const LEAD_STEP_TYPES: readonly Job["type"][] = ["lead_screen", "lead_judge"];

/** Every job type that is NOT prep — the prep lanes' exclusion list. Kept as an
 *  explicit satisfies-checked list so a new schema type can't silently slip into
 *  the concurrent lane.
 *
 *  `seed_brain` belongs HERE and not in PREP_TYPES, though it is onboarding
 *  work the owner is watching: it drives the browser, and a local install has
 *  exactly ONE browser profile. Run concurrently with another browser job it
 *  raced for that profile, and Chrome's own user-data-dir lock turned the loser
 *  into a 30s `BrowserStartEvent` timeout rather than a clean wait. The serial
 *  main lane is what makes "one sidecar, one profile holder" true. */
const ALL_TYPES = [
  "poll_incoming",
  "process_incoming",
  "reconcile_message_write",
  "monitor_engagement",
  "distill",
  "search_lookalike",
  "refresh_brain",
  "compile_campaign",
  "ingest_product",
  "seed_brain",
  "recalibrate_voice",
  "notify_lead",
  "check_stale_leads",
  "forget_spotted",
  "install_active",
  "reconcile_trial_renewal",
  "worker_run",
  // The one-shot strategy seed. No PREP lane — nobody is waiting on it — and
  // no TYPE_BUDGET_MS entry: DB work with no provider call fits the default.
  // A scheduled strategy activation. Same lane decision as the seed: DB
  // work, no provider call, nobody watching it land.
  "activate_strategy",
  // An agent step's wait expiring. DB work only; what it wakes is a
  // `worker_run`, which takes its own lane.
  "agent_step_timeout",
  // Deliberately NOT in PREP_TYPES: it clicks on the account, and the serial
  // main lane is part of the account-safety pacing, as for a post.
  "dispatch_actions",
  // Deliberately NOT in PREP_TYPES: it drives the browser, and the serial main
  // lane is what makes "one sidecar, one profile holder" true.
  "invitation_watch",
  // Deliberately NOT in PREP_TYPES, for the same reason: one profile read.
  "withdrawal_read",
  // Deliberately NOT in PREP_TYPES either: it reads the account's conversations
  // in the browser, and the serial main lane is what makes "one sidecar, one
  // profile holder" true.
  "invite_note_check",
  // Deliberately NOT in PREP_TYPES either: one profile read, then the owner's
  // invite queued for the dispatch gate.
  "owner_invite_member",
  // Deliberately NOT in PREP_TYPES either, though the owner is watching it:
  // profile reads in the browser, one at a time.
  "research_signals",
  // Retired since Phase 56 (nothing enqueues it); its handler touches nothing.
  // A voice update's redraft. No PREP lane — nobody is watching it land — and
  // no TYPE_BUDGET_MS entry: a campaign's waiting drafts are few, each one
  // writer call.
  "redraft_for_voice",
  // A comment the owner asked for again. No PREP lane and no TYPE_BUDGET_MS
  // entry, as for a voice update's redraft: the asks are few, a writer call
  // and a review for every five.
  "redraft_comments",
  "redraft_room_reply",
  // A DM the owner asked for again. Same lane decision as a comment's: one
  // writer call, no browser.
  "redraft_action",
  // Deliberately NOT in PREP_TYPES, though the owner is watching it: it drives
  // the browser, and the serial main lane is what makes "one sidecar, one
  // profile holder" true.
  "live_check_read",
  // A live check's re-projection. Same lane decision as a scheduled
  // activation: DB work, no provider call, nobody watching it land.
  "reproject_campaigns",
  // Deliberately NOT in PREP_TYPES: it drives the browser, and the serial main
  // lane is what makes "one sidecar, one profile holder" true.
  "inbox_check",
  // Deliberately NOT in PREP_TYPES, though the owner may be watching its voice
  // say Drafting: it reads the account in the browser, as `seed_brain` does.
  "relearn_voice_description",
  "file_bug_report",
  // The daily fold of unanswered leads. No PREP lane — nobody is waiting on
  // it — and no TYPE_BUDGET_MS entry: DB work with no provider call fits the
  // default.
  "lead_lifecycle",
  // Scout's Screen and Judge: model calls only, so a PREP lane takes them. The
  // Research above is not one of them: it reads the account.
  "lead_screen",
  "lead_judge",
] as const satisfies readonly Job["type"][];
// Exhaustiveness: a schema job type missing from ALL_TYPES would be CLAIMABLE BY
// THE CONCURRENT PREP LANES (it wouldn't land in their exclusion list) — force a
// compile error instead so every new type gets an explicit lane decision.
const _allTypesExhaustive: Exclude<
  Job["type"],
  (typeof ALL_TYPES)[number]
> extends never
  ? true
  : never = true;
void _allTypesExhaustive;
export const NON_PREP_TYPES: Job["type"][] = ALL_TYPES.filter(
  (t) => !PREP_TYPES.has(t),
);

export async function drainQueue(
  baseCtx: WorkerCtx,
  opts?: {
    maxMs?: number;
    maxJobs?: number;
    ownOrgs?: Set<string>;
    jobTimeoutMs?: number;
    /** ABSOLUTE epoch-ms of the platform's hard kill (route start + maxDuration).
     *  Every claimed job's budget is shrunk to fit inside it (minus grace), so the
     *  original PR#80 hole — claim at t=20s, budget 45s, killed at t=60s with the
     *  row orphaned in `running` — can't happen: the budget ALWAYS fires first and
     *  phase-2 bookkeeping runs. */
    hardDeadlineMs?: number;
  },
): Promise<{ processed: number }> {
  const deadline = Date.now() + (opts?.maxMs ?? 25_000);
  const maxJobs = opts?.maxJobs ?? 100;
  // Per-job budget so one slow job can't run uncapped into the platform's hard kill.
  // The serverless drain caps it; `runLoop` (es2, the uncapped long-job drainer) never
  // calls drainQueue, so it stays unbounded.
  const jobTimeoutMs = opts?.jobTimeoutMs ?? config.jobTimeoutMs;
  const hardDeadline = opts?.hardDeadlineMs ?? Number.POSITIVE_INFINITY;
  let processed = 0;
  while (processed < maxJobs && Date.now() < deadline) {
    const usable = hardDeadline - Date.now() - HARD_KILL_GRACE_MS;
    if (usable < MIN_CLAIM_BUDGET_MS) break; // not enough runway to finish ANY job safely
    // Slow-by-design types whose nominal budget exceeds the remaining runway are
    // not claimed — they belong to the continuous worker (see TYPE_BUDGET_MS).
    const excludeTypes = (
      Object.entries(TYPE_BUDGET_MS) as [Job["type"], number][]
    )
      .filter(([, budget]) => budget > usable)
      .map(([type]) => type);
    // Pass the RUNWAY as the cap; runOnce clamps it to the claimed type's nominal
    // budget (or this drain's default) — so a long type claimed with enough runway
    // gets its full budget instead of the generic one.
    const did = await runOnce(baseCtx, {
      ownOrgs: opts?.ownOrgs,
      // No hard deadline (tests / non-serverless callers): a huge cap defers the
      // budget entirely to the type/default nominal.
      timeoutMs: Number.isFinite(usable) ? usable : Number.MAX_SAFE_INTEGER,
      defaultBudgetMs: jobTimeoutMs,
      excludeTypes,
    });
    if (!did) break;
    processed++;
  }
  return { processed };
}
