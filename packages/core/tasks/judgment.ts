import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One piece of model work this request owes the caller's own agent.
 *
 * `kind` alone is what the policy started with, and it is not enough to PREPARE
 * the task: `brain_notes`, `voice_analysis` and `product_facts` all require
 * the corpus the deferred phase was about to read. The phase that gathered it
 * is the only code that has it, so it hands it over here rather than letting
 * the executor re-fetch — a second browser sweep of the same 25 posts is
 * minutes of the account's own read budget for bytes we already held.
 */
export type DeferredTask = {
  kind: string;
  /** The corpus the model phase would have read, verbatim. */
  sourceText?: string;
  campaignId?: number;
  productId?: number;
  workerId?: number;
  /**
   * What the deferred phase was about to DO, for the apply to honour.
   *
   * SERVER-AUTHORED, and deliberately absent from `start_task`'s
   * public input: "archive every LinkedIn note" and "rewrite voice 7's post
   * channel" are decisions the phase already made, never claims a caller may
   * assert. The executor hands this to `startTask` as its own argument,
   * beside the frozen ids and the run id, and the task's apply reads it back.
   */
  intent?: TaskIntent;
  /**
   * What makes two deferrals THE SAME owed task. Defaults to the kind, which
   * is right for a seed — two chunks owe one extraction — and wrong for a
   * relearn on `both`: comment and post are two distillations over two
   * different corpora, and merging them dropped one of them silently.
   */
  dedupeKey?: string;
};

/** See `DeferredTask.intent`. Every field is optional: a phase states only
 *  what it actually decided, and an absent one means the apply's own default. */
export type TaskIntent = {
  /** `knowledge.source` to tag the notes this task writes. */
  knowledgeSource?: string;
  /** Archive every note carrying this source before the new ones land —
   *  `seedBackgroundPhased`'s `replaceSource`, moved to the moment the
   *  replacement actually arrives rather than the moment it was promised. */
  replaceSource?: string;
  /** WHERE the corpus came from, verbatim: `linkedin:<account>`, `url:<host>`,
   *  `file:<absolute path>` or `text:<attribution>`. Written onto every note
   *  and fact the submission stores, so "never invent Brain facts" has a name
   *  on it that a human can go back to and check. The deferring phase is the
   *  only code that knows — by the time the owner's agent submits, the source
   *  is long out of scope. */
  sourcePath?: string;
  /** Which voice row a `voice_analysis` submission writes, and which of that
   *  row's two output channels. */
  voiceId?: number;
  voiceTarget?: "comment" | "post";
  /** `persist: false` — hand back the analysis and write nothing. */
  persist?: boolean;
  /** A step of a first look owed to the caller (`run_campaign`): its sweep
   *  reads in Quick's shape, its triage and draft freeze the first look's
   *  posts, and each works the campaign though it waits for its Start. */
  firstLook?: true;
};

type ExternalJudgment = { pending: DeferredTask[] };
const policy = new AsyncLocalStorage<ExternalJudgment>();
const tasks: Record<string, string> = {
  ingest_product: "product_facts",
  seed_brain: "brain_notes",
  compile_campaign: "campaign_brief",
  import_voice: "voice_analysis",
  relearn_voice: "voice_analysis",
  recalibrate_voice: "voice_analysis",
  refresh_brain: "brain_notes",
  distill: "brain_notes",
  process_incoming: "reply",
};

/** Whether THIS request is running under the external-judgment policy at all.
 *  A phased function asks before it spends a model call, so the I/O it already
 *  did is kept and only the thinking is handed back. */
export function externalJudgmentActive(): boolean {
  return policy.getStore() !== undefined;
}

/**
 * Record one owed task, with whatever the deferring phase can say about it.
 * Returns false when no policy is in force, which is the signal a phased
 * function uses to carry on and call the model itself.
 *
 * Same-kind entries MERGE rather than repeat: two chunks of one seed owe one
 * `brain_notes` task, and the first corpus offered wins so a later, narrower
 * phase cannot quietly shrink what the owner's agent is asked to read.
 */
export function deferTask(task: DeferredTask): boolean {
  const current = policy.getStore();
  if (!current) return false;
  const key = task.dedupeKey ?? task.kind;
  const existing = current.pending.find(
    (item) => (item.dedupeKey ?? item.kind) === key,
  );
  if (!existing) {
    current.pending.push({ ...task });
    return true;
  }
  for (const [key, value] of Object.entries(task)) {
    if (key === "kind" || value === undefined) continue;
    if ((existing as Record<string, unknown>)[key] === undefined)
      (existing as Record<string, unknown>)[key] = value;
  }
  return true;
}

/** Request-local execution policy, never a worker/product mode. A deferred
 * judgment is returned to the caller instead of becoming a hidden queue job. */
export function deferInteractiveJob(type: string): boolean {
  const current = policy.getStore();
  if (!current || !tasks[type]) return false;
  return deferTask({ kind: tasks[type]! });
}

/** What THIS request has deferred so far. A durable receipt records it at the
 * moment it is written, so a replay reports the same owed work rather than the
 * empty list a second pass through the policy would produce. */
export function pendingTasks(): string[] {
  return (policy.getStore()?.pending ?? []).map((task) => task.kind);
}

/** The same owed work with the corpus attached — what the executor prepares
 *  tasks FROM, and deliberately not what a receipt carries: a task's source
 *  belongs in the task, never inlined into every reply that mentions it. */
export function pendingTaskRequests(): DeferredTask[] {
  return (policy.getStore()?.pending ?? []).map((task) => ({ ...task }));
}

export function assertServerJudgmentAllowed() {
  if (policy.getStore()) throw new Error("task_required");
}

export async function withExternalJudgment<T>(work: () => Promise<T>) {
  const state: ExternalJudgment = { pending: [] };
  const result = await policy.run(state, work);
  return {
    result,
    pendingTasks: state.pending.map((task) => task.kind),
    deferred: state.pending,
  };
}
