import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The recovery-only execution scope.
 *
 * After cancellation stops a tenant's ordinary worker, the controller may still
 * need to finish an existing obligation — reconcile a send whose outcome is
 * unknown, stop a session, complete an owner-requested export. ADR-06 allows
 * that as a time- and resource-bounded task using the SAME core operations,
 * with one hard rule: it exists only to resolve what already happened.
 *
 * So the scope is a refusal, not a capability. Inside it a process may not
 * claim ordinary queue work, draft, publish, spend the tenant's own allowance
 * or activate a tenant. Those are the ways a "recovery" task could quietly
 * become a way to buy paid execution after the subscription that funded it
 * ended.
 *
 * A-503 also asks that recovery cannot RESET a cancelled tenant's commercial
 * generation, and there is deliberately no action for that here: nothing in
 * this runtime resets one. Generations are monotone and assigned once under an
 * organization-wide lock (`assignCommercialGeneration`), from the Stripe
 * webhook and the owner's own offer change — neither of which a recovery task
 * enters. A fence naming an operation no code performs would claim a guarantee
 * it does not enforce; the guarantee here is that the operation does not exist.
 *
 * It is an AsyncLocalStorage scope rather than a flag on a context object
 * because the operations it fences are reached through several call paths that
 * do not share one context, and a fence one caller can forget to pass is not a
 * fence.
 */

export type RecoveryTask = {
  /** Durable id of the recovery task, for receipts and diagnostics. */
  taskId: string;
  organizationId: string;
  /** Why the controller opened it — reconciliation, stop, or owner export. */
  reason: "reconcile" | "stop" | "export";
  /** Recovery adapters must stop at this signal; it never authorizes a write. */
  signal?: AbortSignal;
};

/** The operations recovery is not allowed to perform. Named individually so a
 *  refusal says which rule it enforced. */
export type FencedAction =
  | "claim_queue_job"
  | "draft"
  | "publish"
  | "tenant_allowance"
  | "activate_tenant";

export class RecoveryOnlyRefusal extends Error {
  readonly code = "recovery_only";
  readonly status = 403;

  constructor(
    readonly action: FencedAction,
    readonly task: RecoveryTask,
  ) {
    super(
      `recovery_only: a recovery task may not ${action.replaceAll("_", " ")}`,
    );
    this.name = "RecoveryOnlyRefusal";
  }
}

const store = new AsyncLocalStorage<RecoveryTask>();

/** Run `fn` as a recovery-only task. Nested scopes keep the outermost task. */
export function withRecoveryOnlyScope<T>(
  task: RecoveryTask,
  fn: () => Promise<T>,
): Promise<T> {
  const current = store.getStore();
  return store.run(current ?? task, fn);
}

export function currentRecoveryTask(): RecoveryTask | undefined {
  return store.getStore();
}

/** Refuse `action` when this execution is a recovery task. A no-op otherwise,
 *  so ordinary paid and free execution pays nothing for the fence. */
export function assertNotRecoveryOnly(action: FencedAction): void {
  const task = store.getStore();
  if (task) throw new RecoveryOnlyRefusal(action, task);
}
