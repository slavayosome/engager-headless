import { and, eq } from "drizzle-orm";
import { jobs, type Job } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";

export type JobLeaseExecution = {
  organizationId: string;
  jobId?: number;
  jobType?: Job["type"];
  jobLeaseToken?: string;
};

export class JobLeaseLostError extends Error {
  readonly code = "job_lease_lost" as const;

  constructor() {
    super("job lease is no longer held by this execution");
    this.name = "JobLeaseLostError";
  }
}

/** Exact queue ownership predicate. The row id is durable and reusable; the
 * lease token identifies one execution of that row. Hold a shared row lock until
 * the caller's transaction ends so a concurrent reaper cannot change ownership
 * halfway through the decision. */
export async function ownsCurrentJobLease(
  tx: Tx,
  input: Required<JobLeaseExecution>,
): Promise<boolean> {
  const [owned] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.organizationId, input.organizationId),
        eq(jobs.type, input.jobType),
        eq(jobs.status, "running"),
        eq(jobs.leaseToken, input.jobLeaseToken),
      ),
    )
    .limit(1)
    .for("share");
  return owned != null;
}

/** Assert ownership inside an already-open short org transaction. A context with
 * no queue identity is a deliberate direct-operation/test call and remains a
 * no-op; a partial identity fails closed. */
export async function assertCurrentJobLeaseInTx(
  tx: Tx,
  input: JobLeaseExecution,
): Promise<void> {
  const hasAnyIdentity =
    input.jobId != null || input.jobType != null || input.jobLeaseToken != null;
  if (!hasAnyIdentity) return;
  if (input.jobId == null || input.jobType == null || !input.jobLeaseToken) {
    throw new JobLeaseLostError();
  }
  if (
    !(await ownsCurrentJobLease(tx, {
      organizationId: input.organizationId,
      jobId: input.jobId,
      jobType: input.jobType,
      jobLeaseToken: input.jobLeaseToken,
    }))
  ) {
    throw new JobLeaseLostError();
  }
}

/** Assert ownership between provider phases, without requiring the caller to
 * hold a connection while the provider request itself is in flight. */
export async function assertCurrentJobLease(
  input: JobLeaseExecution,
): Promise<void> {
  const hasAnyIdentity =
    input.jobId != null || input.jobType != null || input.jobLeaseToken != null;
  if (!hasAnyIdentity) return;
  await withOrg(input.organizationId, (tx) =>
    assertCurrentJobLeaseInTx(tx, input),
  );
}
