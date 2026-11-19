import type { Job } from "@engager/database/schema";
import { resolveDeploymentEnvironment } from "@engager/database/environment";
import { withOrg, type Tx } from "@engager/database/tenant";
import { hostedJobSpendAccess } from "../entitlements/hosted";
import { RescheduleError } from "./queue";

const SUBSCRIPTION_RECHECK_MS = 6 * 60 * 60_000;

export type HostedJobExecution = {
  organizationId: string;
  jobId?: number;
  jobType?: Job["type"];
  jobLeaseToken?: string;
  signal?: AbortSignal;
  /** Explicit unit-test authorization seam. Rejected outside the test DB/env. */
  hostedJobTestAuthorizer?: {
    assertInTx: (tx: Tx) => Promise<void>;
    assertBeforeProvider: () => Promise<void>;
  };
  /**
   * How an IN-SESSION execution re-authorizes, having no queue lease to fence
   * on.
   *
   * `withHostedJobIdentity` returns `undefined` when a context carries no job
   * identity at all, and the boundary then allowed the phase — correct for the
   * direct operation tests it was written for, and wrong the moment a real
   * execution had no job row. A lapsed hosted org's in-session seed ran the
   * browser sweep with no entitlement check because of exactly that gap. The
   * MCP boundary that started the run supplies its own re-authorization here,
   * and it is checked at every boundary a queued run would have been.
   *
   * TWO ARMS, for the same reason the test seam above has two. The in-tx
   * boundary already holds a transaction and the provider boundary does not; a
   * single closure would have to open its own `withOrg` — which is exactly what
   * the MCP authorizer does — and running that inside
   * `assertHostedJobSpendStillAllowedInTx`'s transaction is a nested acquire
   * that never returns at `ENGAGER_PG_POOL_MAX=1`. Each arm re-authorizes on
   * the connection its own caller already has.
   */
  interactiveAuthorizer?: {
    assertInTx: (tx: Tx) => Promise<void>;
    assertBeforeProvider: () => Promise<void>;
  };
};

function testAuthorizer(ctx: HostedJobExecution) {
  const injected = ctx.hostedJobTestAuthorizer;
  if (!injected) return null;
  if (resolveDeploymentEnvironment() !== "test") {
    throw new HostedJobSpendRevokedError("test_authorizer_outside_test");
  }
  return injected;
}

export class HostedJobSpendRevokedError extends RescheduleError {
  constructor(readonly reason: string) {
    super(reason, Date.now() + SUBSCRIPTION_RECHECK_MS);
    this.name = "HostedJobSpendRevokedError";
  }
}

/** Re-authorize a claimed job immediately before a later provider or economic
 * phase: any subscription cancellation committed since the claim is observed
 * here, and the job's own lease must still be this execution's. */
export async function assertHostedJobSpendStillAllowed(
  ctx: HostedJobExecution,
): Promise<void> {
  assertHostedJobExecutionActive(ctx);
  const injected = testAuthorizer(ctx);
  if (injected) {
    await injected.assertBeforeProvider();
    assertHostedJobExecutionActive(ctx);
    return;
  }
  const interactive = ctx.interactiveAuthorizer;
  if (interactive) {
    await interactive.assertBeforeProvider();
    assertHostedJobExecutionActive(ctx);
    return;
  }
  await withHostedJobIdentity(ctx, async () =>
    withOrg(ctx.organizationId, (tx) =>
      assertHostedJobSpendStillAllowedAtBoundary(tx, ctx),
    ),
  );
  assertHostedJobExecutionActive(ctx);
}

/**
 * Re-authorize on the caller's transaction immediately before a mutation.
 * Besides observing cancellation, keeping the job/subscription share locks until
 * commit closes the check-to-write race left by a separate authorization query.
 */
export async function assertHostedJobSpendStillAllowedInTx(
  tx: Tx,
  ctx: HostedJobExecution,
): Promise<void> {
  return assertHostedJobSpendStillAllowedAtBoundary(tx, ctx);
}

async function assertHostedJobSpendStillAllowedAtBoundary(
  tx: Tx,
  ctx: HostedJobExecution,
): Promise<void> {
  assertHostedJobExecutionActive(ctx);
  const injected = testAuthorizer(ctx);
  if (injected) {
    await injected.assertInTx(tx);
    assertHostedJobExecutionActive(ctx);
    return;
  }
  const interactive = ctx.interactiveAuthorizer;
  if (interactive) {
    // The CALLER'S transaction, never a second one: this arm exists so an
    // in-session handler can re-authorize at an in-tx boundary without the
    // nested acquire that hangs forever at pool max 1.
    await interactive.assertInTx(tx);
    assertHostedJobExecutionActive(ctx);
    return;
  }
  await withHostedJobIdentity(
    ctx,
    async ({ jobId, jobType, jobLeaseToken }) => {
      const access = await hostedJobSpendAccess(
        tx,
        ctx.organizationId,
        jobType,
        { currentJobId: jobId, currentJobLeaseToken: jobLeaseToken },
      );
      if (!access.allowed) throw new HostedJobSpendRevokedError(access.reason);
    },
  );
  assertHostedJobExecutionActive(ctx);
}

function assertHostedJobExecutionActive(ctx: HostedJobExecution): void {
  if (ctx.signal?.aborted) {
    throw new HostedJobSpendRevokedError("job_aborted");
  }
}

async function withHostedJobIdentity<T>(
  ctx: HostedJobExecution,
  operation: (identity: {
    jobId: number;
    jobType: Job["type"];
    jobLeaseToken: string;
  }) => Promise<T>,
): Promise<T | undefined> {
  const { jobId, jobType, jobLeaseToken } = ctx;
  const hasAnyIdentity =
    jobId != null || jobType != null || jobLeaseToken != null;
  if (!hasAnyIdentity) return undefined;
  if (jobId == null || jobType == null || jobLeaseToken == null) {
    throw new HostedJobSpendRevokedError("job_lease_lost");
  }
  return operation({ jobId, jobType, jobLeaseToken });
}
