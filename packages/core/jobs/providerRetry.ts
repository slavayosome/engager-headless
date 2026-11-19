import { and, eq, sql } from "drizzle-orm";
import { cloudProviderCircuits } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { RescheduleError } from "./queue";

/**
 * Bounded provider retries and the per-org circuit that stops an outage
 * becoming a storm (ADR-06).
 *
 * The rules are policy constants with a fake clock, not ambient behaviour:
 *
 * - At most three attempts per logical operation, exponential backoff with
 *   jitter, and one overall two-minute deadline across all of them.
 * - A provider that names its own wait returns the JOB to a delayed queue.
 *   A worker never sleeps out a provider's retry-after: the worker is the
 *   scarce resource, and the queue already knows how to wait.
 * - Five consecutive failures against one provider open that org's circuit
 *   for fifteen minutes. Success closes it.
 *
 * Terminal by definition: invalid credentials and unusable payment state.
 * Retrying either spends attempts on an answer that cannot change without an
 * explicit repair.
 *
 * A refusal raised BEFORE the provider is reached — an output the schema
 * rejected — is neither transient nor terminal here: it says nothing about the
 * provider, so it is rethrown without touching the circuit that protects
 * against the provider.
 */

export const PROVIDER_MAX_ATTEMPTS = 3;
export const PROVIDER_RETRY_DEADLINE_MS = 120_000;
export const PROVIDER_BACKOFF_BASE_MS = 500;
export const PROVIDER_BACKOFF_CEILING_MS = 30_000;
export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_OPEN_MS = 15 * 60_000;

export type ProviderAttemptOutcome =
  | { kind: "transient"; failureKind: string; retryAfterMs?: number }
  | { kind: "terminal"; failureKind: string }
  /** The operation refused before the provider was reached, or the provider
   *  answered and the answer was unusable. Rethrown untouched: it is not
   *  evidence about the provider's health, so it must never push the org's
   *  circuit toward opening. */
  | { kind: "not_provider" };

/** The org's circuit for this provider is open; no attempt is made. */
export class ProviderCircuitOpenError extends RescheduleError {
  constructor(
    readonly provider: string,
    openUntil: number,
  ) {
    super(`provider_circuit_open:${provider}`, openUntil);
    this.name = "ProviderCircuitOpenError";
  }
}

/** Every bounded attempt failed, or the deadline elapsed. */
export class ProviderAttemptsExhaustedError extends Error {
  constructor(
    readonly provider: string,
    readonly attempts: number,
    readonly failureKind: string,
    options?: ErrorOptions,
  ) {
    super(
      `provider ${provider} failed ${attempts} bounded attempts (${failureKind})`,
      options,
    );
    this.name = "ProviderAttemptsExhaustedError";
  }
}

export type ProviderRetryClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Deterministic in fixtures; `Math.random` in production. */
  random: () => number;
};

const REAL_CLOCK: ProviderRetryClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  random: Math.random,
};

/** Full jitter on an exponential base, capped. Full jitter rather than
 *  equal jitter because the tenants being spread are few and identical. */
export function providerBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    PROVIDER_BACKOFF_CEILING_MS,
    PROVIDER_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(random() * ceiling);
}

export type ProviderCircuitState = {
  open: boolean;
  openUntil: number | null;
  consecutiveFailures: number;
};

/** Read the org's circuit for one provider. */
export async function providerCircuitState(
  organizationId: string,
  provider: string,
  now?: number,
): Promise<ProviderCircuitState> {
  return withOrg(organizationId, async (tx) => {
    const at = now ?? Date.now();
    const [row] = await tx
      .select()
      .from(cloudProviderCircuits)
      .where(
        and(
          eq(cloudProviderCircuits.organizationId, organizationId),
          eq(cloudProviderCircuits.provider, provider),
        ),
      );
    if (!row) return { open: false, openUntil: null, consecutiveFailures: 0 };
    const open = row.openUntil != null && row.openUntil > at;
    return {
      open,
      openUntil: row.openUntil,
      consecutiveFailures: row.consecutiveFailures,
    };
  });
}

export async function recordProviderFailure(
  organizationId: string,
  provider: string,
  failureKind: string,
  now?: number,
): Promise<ProviderCircuitState> {
  return withOrg(organizationId, async (tx) => {
    const at = now ?? Date.now();
    await tx
      .insert(cloudProviderCircuits)
      .values({
        organizationId,
        provider,
        periodStart: 0,
        consecutiveFailures: 0,
        updatedAt: at,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(cloudProviderCircuits)
      .where(
        and(
          eq(cloudProviderCircuits.organizationId, organizationId),
          eq(cloudProviderCircuits.provider, provider),
        ),
      )
      .for("update");
    const failures = (row?.consecutiveFailures ?? 0) + 1;
    const opens = failures >= CIRCUIT_FAILURE_THRESHOLD;
    await tx
      .update(cloudProviderCircuits)
      .set({
        consecutiveFailures: failures,
        openedAt: opens ? at : (row?.openedAt ?? null),
        openUntil: opens ? at + CIRCUIT_OPEN_MS : (row?.openUntil ?? null),
        lastFailureKind: failureKind.slice(0, 160),
        lastFailureAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(cloudProviderCircuits.organizationId, organizationId),
          eq(cloudProviderCircuits.provider, provider),
        ),
      );
    return {
      open: opens,
      openUntil: opens ? at + CIRCUIT_OPEN_MS : (row?.openUntil ?? null),
      consecutiveFailures: failures,
    };
  });
}

export async function recordProviderSuccess(
  organizationId: string,
  provider: string,
  now?: number,
): Promise<void> {
  await withOrg(organizationId, async (tx) => {
    const at = now ?? Date.now();
    await tx
      .update(cloudProviderCircuits)
      .set({
        consecutiveFailures: 0,
        openedAt: null,
        openUntil: null,
        updatedAt: at,
      })
      .where(
        and(
          eq(cloudProviderCircuits.organizationId, organizationId),
          eq(cloudProviderCircuits.provider, provider),
          sql`${cloudProviderCircuits.consecutiveFailures} > 0 or ${cloudProviderCircuits.openUntil} is not null`,
        ),
      );
  });
}

export type ProviderAttempt<T> = (attempt: {
  index: number;
  /** Distinct per attempt so usage stays attributable. */
  attemptId: string;
}) => Promise<T>;

/**
 * Run one logical provider operation under the bounded retry policy.
 *
 * `classify` decides what an error means. Anything it calls terminal stops
 * immediately; a transient answer carrying `retryAfterMs` that would exceed
 * the deadline returns the job to a delayed queue rather than sleeping.
 */
export async function withBoundedProviderRetry<T>(
  input: {
    organizationId: string;
    provider: string;
    /** Stable across attempts; the attempt index makes each attempt distinct. */
    operationId: string;
    classify: (error: unknown) => ProviderAttemptOutcome;
    clock?: Partial<ProviderRetryClock>;
  },
  operation: ProviderAttempt<T>,
): Promise<T> {
  const clock: ProviderRetryClock = { ...REAL_CLOCK, ...input.clock };
  const circuit = await providerCircuitState(
    input.organizationId,
    input.provider,
    clock.now(),
  );
  if (circuit.open && circuit.openUntil != null) {
    throw new ProviderCircuitOpenError(input.provider, circuit.openUntil);
  }

  const deadline = clock.now() + PROVIDER_RETRY_DEADLINE_MS;
  let lastError: unknown;
  let lastFailureKind = "unknown";
  for (let index = 1; index <= PROVIDER_MAX_ATTEMPTS; index++) {
    try {
      const value = await operation({
        index,
        attemptId: `${input.operationId}:${index}`,
      });
      await recordProviderSuccess(
        input.organizationId,
        input.provider,
        clock.now(),
      );
      return value;
    } catch (error) {
      lastError = error;
      const outcome = input.classify(error);
      if (outcome.kind === "not_provider" || outcome.kind === "terminal") throw error;
      lastFailureKind = outcome.failureKind;
      const state = await recordProviderFailure(
        input.organizationId,
        input.provider,
        outcome.failureKind,
        clock.now(),
      );
      if (state.open && state.openUntil != null) {
        throw new ProviderCircuitOpenError(input.provider, state.openUntil);
      }
      const waitMs =
        outcome.retryAfterMs ?? providerBackoffMs(index, clock.random);
      const resumeAt = clock.now() + waitMs;
      if (index === PROVIDER_MAX_ATTEMPTS) break;
      if (resumeAt > deadline) {
        // The provider asked for longer than this operation may hold a
        // worker. Give the slot back and let the queue wake it.
        throw new RescheduleError(
          `provider_retry_after:${input.provider}`,
          resumeAt,
        );
      }
      await clock.sleep(waitMs);
    }
  }
  throw new ProviderAttemptsExhaustedError(
    input.provider,
    PROVIDER_MAX_ATTEMPTS,
    lastFailureKind,
    { cause: lastError },
  );
}
