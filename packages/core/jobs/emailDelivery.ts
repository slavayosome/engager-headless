import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@engager/common/crypto";
import {
  EmailProviderError,
  type PreparedEmailPayload,
  type SendResult,
} from "../leads/notifications/delivery";
import { resolveDeploymentEnvironment } from "@engager/database/environment";
import {
  emailDeliveryReceipts,
  memberships,
  users,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { SelfScopedCtx } from "./worker";
import { assertHostedJobSpendStillAllowedInTx } from "./spendAccess";

export const EMAIL_PROVIDER_IDEMPOTENCY_RETRY_MS = 23 * 60 * 60_000;
/** Absolute DB + provider budget, below the pool's default 10s acquire ceiling. */
export const EMAIL_DELIVERY_TOTAL_TIMEOUT_MS = 8_000;
/** Maximum provider share of the total budget. Actual attempts use less. */
export const EMAIL_PROVIDER_TIMEOUT_MS = 8_000;
const EMAIL_DELIVERY_LOCK_TIMEOUT_MS = 1_500;
const EMAIL_DELIVERY_SETTLE_RESERVE_MS = 250;
const RECIPIENT_AUTHORITY_REVOKED = "recipient_owner_membership_revoked";
const RECIPIENT_ADDRESS_CHANGED = "recipient_email_address_changed";
const RECIPIENT_BINDING_MISSING = "recipient_authorization_binding_missing";

export type JobEmailKind =
  | "lead_hot"
  | "lead_nudge"
  | "checkpoint"
  | "runtime_alert"
  | "trial_started"
  | "trial_ending"
  | "payment_failed";

export class EmailDeliveryOutcomeUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailDeliveryOutcomeUncertainError";
  }
}

export class EmailProviderDeliveryError extends Error {
  constructor(readonly auditReference: string) {
    super(`email provider delivery failed (${auditReference})`);
    this.name = "EmailProviderDeliveryError";
  }
}

/** Explicit test seam. Production rejects it even if a caller constructs one. */
export type EmailDeliveryTestAuthorizer = {
  assertInTx: (tx: Tx) => Promise<void>;
};

export type ClaimedJobEmailCtx = SelfScopedCtx & {
  jobId: number;
  jobType: NonNullable<SelfScopedCtx["jobType"]>;
  jobLeaseToken: string;
  emailDeliveryTestAuthorizer?: EmailDeliveryTestAuthorizer;
};

/** The control service delivers a tenant event inside the request that
 * authenticates it. It has no tenant job lease in its own database. */
type ControlPlaneEmailCtx = {
  organizationId: string;
  signal?: AbortSignal;
  jobId?: never;
  controlPlaneAuthorization: (tx: Tx) => Promise<void>;
};
type EmailDeliveryCtx = ClaimedJobEmailCtx | ControlPlaneEmailCtx;

/** Make the job-owned boundary visible in both the type system and at runtime. */
export function claimedJobEmailContext(ctx: SelfScopedCtx): ClaimedJobEmailCtx {
  const candidate = ctx as ClaimedJobEmailCtx;
  if (
    "controlPlaneAuthorization" in candidate ||
    !Number.isSafeInteger(candidate.jobId) ||
    candidate.jobId <= 0 ||
    !candidate.jobType ||
    !candidate.jobLeaseToken?.trim()
  ) {
    throw new Error(
      "durable email delivery requires the exact running job id, type, and lease token",
    );
  }
  return candidate;
}

function testAuthorizer(
  ctx: ClaimedJobEmailCtx,
): EmailDeliveryTestAuthorizer | null {
  const authorizer = ctx.emailDeliveryTestAuthorizer;
  if (!authorizer) return null;
  if (resolveDeploymentEnvironment() !== "test") {
    throw new Error("emailDeliveryTestAuthorizer is permitted only in tests");
  }
  return authorizer;
}

async function authorizeInTx(tx: Tx, ctx: EmailDeliveryCtx): Promise<void> {
  if ("controlPlaneAuthorization" in ctx) {
    ctx.signal?.throwIfAborted();
    await ctx.controlPlaneAuthorization(tx);
    ctx.signal?.throwIfAborted();
    return;
  }
  const injected = testAuthorizer(ctx);
  if (injected) return injected.assertInTx(tx);
  await assertHostedJobSpendStillAllowedInTx(tx, ctx);
}

function providerKey(input: {
  organizationId: string;
  kind: JobEmailKind;
  deliveryKey: string;
}): string {
  const environment = resolveDeploymentEnvironment();
  const digest = createHash("sha256")
    .update(
      `${environment}\0${input.organizationId}\0${input.kind}\0${input.deliveryKey}`,
      "utf8",
    )
    .digest("base64url");
  return `engager_${environment}_email_${digest}`;
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  opts: { optional?: boolean } = {},
): string | undefined {
  if (value == null && opts.optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`prepared email ${field} is invalid`);
  }
  return value;
}

function normalizePreparedPayload(value: unknown): PreparedEmailPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("prepared email payload is invalid");
  }
  const input = value as Record<string, unknown>;
  return {
    from: boundedString(input.from, "from", 500)!,
    to: boundedString(input.to, "to", 500)!,
    subject: boundedString(input.subject, "subject", 500)!,
    html: boundedString(input.html, "html", 1_000_000)!,
    ...(input.text == null
      ? {}
      : { text: boundedString(input.text, "text", 1_000_000)! }),
    ...(input.replyTo == null
      ? {}
      : { replyTo: boundedString(input.replyTo, "replyTo", 500)! }),
  };
}

function serializePreparedPayload(payload: PreparedEmailPayload): string {
  // Normalize property order and reject surprising runtime values before the
  // request becomes an immutable provider contract.
  return JSON.stringify(normalizePreparedPayload(payload));
}

function payloadHash(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function thawPreparedPayload(
  encrypted: string | null,
  expectedHash: string,
): PreparedEmailPayload {
  if (!encrypted) throw new Error("frozen email provider payload is missing");
  const serialized = decryptSecret(encrypted);
  if (payloadHash(serialized) !== expectedHash) {
    throw new Error("frozen email provider payload failed its integrity hash");
  }
  return normalizePreparedPayload(JSON.parse(serialized) as unknown);
}

function providerErrorAudit(error: unknown): string {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  let raw: string;
  if (error instanceof Error) raw = `${error.name}\0${error.message}`;
  else if (typeof error === "string") raw = error;
  else {
    try {
      raw = JSON.stringify(error) ?? "unknown";
    } catch {
      raw = Object.prototype.toString.call(error);
    }
  }
  const safeToken = (value: unknown): string | undefined =>
    typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
      ? value
      : undefined;
  const status = Number(record?.status ?? record?.statusCode);
  const canonicalError = error instanceof EmailProviderError ? error : undefined;
  const audit = {
    category:
      safeToken(canonicalError?.category) ??
      safeToken(error instanceof Error ? error.name : undefined) ??
      "provider_error",
    ...(safeToken(record?.code) ? { code: safeToken(record?.code) } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    // The provider wrapper has already discarded the body. Keep its original
    // correlation digest rather than hashing the wrapper's safe message again.
    digest:
      canonicalError &&
      typeof canonicalError.digest === "string" &&
      /^[0-9a-f]{64}$/.test(canonicalError.digest)
        ? canonicalError.digest
        : createHash("sha256").update(raw, "utf8").digest("hex"),
  };
  return JSON.stringify(audit);
}

function providerErrorReference(audit: string): string {
  const parsed = JSON.parse(audit) as {
    category: string;
    code?: string;
    status?: number;
    digest: string;
  };
  return [
    parsed.category,
    parsed.code,
    parsed.status == null ? undefined : String(parsed.status),
    parsed.digest.slice(0, 16),
  ]
    .filter(Boolean)
    .join(":");
}

type Reservation =
  | {
      status: "send";
      receiptId: number;
      idempotencyKey: string;
      payloadHash: string;
      recipientUserId: string;
      providerPayload: PreparedEmailPayload;
    }
  | {
      status: "sent";
      receiptId: number;
      providerMessageId: string | null;
    }
  | { status: "uncertain"; receiptId: number }
  | {
      status: "suppressed";
      reason:
        | typeof RECIPIENT_AUTHORITY_REVOKED
        | typeof RECIPIENT_ADDRESS_CHANGED;
    };

type ProviderTransactionResult =
  | {
      status: "sent";
      alreadySent: boolean;
      providerMessageId: string | null;
    }
  | { status: "uncertain"; receiptId: number }
  | { status: "provider_error"; audit: string };

export type JobEmailDeliveryResult =
  | {
      sent: true;
      alreadySent: boolean;
      providerMessageId?: string;
    }
  | {
      sent: false;
      suppressed: true;
      reason:
        | "recipient_owner_membership_revoked"
        | "recipient_email_address_changed";
    };

export type JobEmailSender = (
  payload: PreparedEmailPayload,
  idempotencyKey: string,
  signal: AbortSignal,
) => Promise<SendResult>;

type JobEmailDeliveryInput = {
  kind: JobEmailKind;
  /** Stable identity of the logical notification, not its recipient/body. */
  deliveryKey: string;
  /** Called only for a brand-new receipt. Retries use the encrypted request. */
  prepare: () => PreparedEmailPayload;
  send: JobEmailSender;
  /** Domain-state closure committed atomically with the provider receipt. */
  settleInTx?: (tx: Tx) => Promise<void>;
  now?: number;
  /** Test-only crash seam after provider ACK but before the DB receipt closes. */
  afterProviderAck?: () => void;
  /** Test-only deadline seam. Production always uses 8 seconds. */
  providerTimeoutMsForTest?: number;
  /** Test-only absolute DB + provider deadline seam. */
  totalTimeoutMsForTest?: number;
};

function boundedTestTimeoutMs(
  field: "providerTimeoutMsForTest" | "totalTimeoutMsForTest",
  testOverride: number | undefined,
  productionValue: number,
): number {
  if (testOverride == null) return productionValue;
  if (resolveDeploymentEnvironment() !== "test") {
    throw new Error(`${field} is permitted only in tests`);
  }
  if (
    !Number.isSafeInteger(testOverride) ||
    testOverride < 1 ||
    testOverride > productionValue
  ) {
    throw new Error(`${field} must be between 1 and ${productionValue}`);
  }
  return testOverride;
}

function remainingDeliveryMs(deadlineAt: number): number {
  return Math.floor(deadlineAt - Date.now());
}

function requireRemainingDeliveryMs(deadlineAt: number): number {
  const remainingMs = remainingDeliveryMs(deadlineAt);
  if (remainingMs < 1) {
    throw new Error("email delivery exceeded its absolute deadline");
  }
  return remainingMs;
}

/** Apply transaction-local limits before any authorization or receipt lock. */
async function configureDeliveryTxDeadline(
  tx: Tx,
  deadlineAt: number,
): Promise<number> {
  const remainingMs = requireRemainingDeliveryMs(deadlineAt);
  const lockTimeoutMs = Math.max(
    1,
    Math.min(EMAIL_DELIVERY_LOCK_TIMEOUT_MS, remainingMs - 1),
  );
  await tx.execute(sql`select
    set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
    set_config('statement_timeout', ${`${remainingMs}ms`}, true)`);
  return remainingMs;
}

function providerBudgetMs(
  deadlineAt: number,
  providerMaximumMs: number,
): number {
  const availableMs =
    requireRemainingDeliveryMs(deadlineAt) - EMAIL_DELIVERY_SETTLE_RESERVE_MS;
  if (availableMs < 1) {
    throw new Error(
      "email delivery deadline has no provider settlement reserve remaining",
    );
  }
  return Math.min(providerMaximumMs, availableMs);
}

function providerAbortScope(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `email provider exceeded ${timeoutMs}ms deadline`,
        "TimeoutError",
      ),
    );
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function normalizedRecipientAddress(value: string): string {
  return value.trim().toLowerCase();
}

/** Lock both authorization records until the caller's transaction commits. */
async function lockedRecipientAuthorityFailure(
  tx: Tx,
  organizationId: string,
  recipientUserId: string,
  frozenRecipient: string,
): Promise<
  typeof RECIPIENT_AUTHORITY_REVOKED | typeof RECIPIENT_ADDRESS_CHANGED | null
> {
  const [recipient] = await tx
    .select({
      membershipId: memberships.id,
      userId: users.id,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, recipientUserId),
        eq(memberships.isOwner, true),
      ),
    )
    .limit(1)
    .for("share");
  if (!recipient) return RECIPIENT_AUTHORITY_REVOKED;
  return normalizedRecipientAddress(recipient.email) ===
    normalizedRecipientAddress(frozenRecipient)
    ? null
    : RECIPIENT_ADDRESS_CHANGED;
}

async function settleUncertainReceipt(
  tx: Tx,
  receipt: {
    id: number;
    state: "reserved" | "sending" | "sent" | "uncertain";
    payloadHash: string;
    updatedAt: number;
  },
  reason: string,
  requestedAt: number,
  deadlineAt: number,
  settleInTx?: (tx: Tx) => Promise<void>,
): Promise<void> {
  if (receipt.state !== "reserved" && receipt.state !== "sending") {
    throw new Error(`email delivery receipt ${receipt.id} is already final`);
  }
  await configureDeliveryTxDeadline(tx, deadlineAt);
  const updated = await tx
    .update(emailDeliveryReceipts)
    .set({
      state: "uncertain",
      encryptedProviderPayload: null,
      providerMessageId: null,
      sentAt: null,
      lastError: reason,
      updatedAt: Math.max(requestedAt, receipt.updatedAt, Date.now()),
    })
    .where(
      and(
        eq(emailDeliveryReceipts.id, receipt.id),
        eq(emailDeliveryReceipts.state, receipt.state),
        eq(emailDeliveryReceipts.payloadHash, receipt.payloadHash),
      ),
    )
    .returning({ id: emailDeliveryReceipts.id });
  if (updated.length === 0) {
    throw new Error(
      `email delivery receipt ${receipt.id} could not be settled as uncertain`,
    );
  }
  if (settleInTx) {
    await configureDeliveryTxDeadline(tx, deadlineAt);
    await settleInTx(tx);
  }
}

/** Resume a frozen request before a handler re-evaluates mutable business
 * state. Returns false only when this logical email has never been reserved. */
export async function resumeJobEmailIfPresent(
  ctx: ClaimedJobEmailCtx,
  input: {
    kind: JobEmailKind;
    deliveryKey: string;
    send: JobEmailSender;
    settleInTx?: (tx: Tx) => Promise<void>;
  },
): Promise<boolean> {
  const [existing] = await withOrg(ctx.organizationId, (tx) =>
    tx
      .select({ id: emailDeliveryReceipts.id })
      .from(emailDeliveryReceipts)
      .where(
        and(
          eq(emailDeliveryReceipts.kind, input.kind),
          eq(emailDeliveryReceipts.deliveryKey, input.deliveryKey),
        ),
      )
      .limit(1),
  );
  if (!existing) return false;
  try {
    await deliverJobEmailInternal(ctx, {
      ...input,
      prepare: () => {
        throw new Error(
          "existing email receipt lost its frozen provider payload",
        );
      },
    });
  } catch (error) {
    // `settleInTx` treats a final uncertain outcome as at-most-once delivery:
    // the provider may have accepted the request, so the domain notification is
    // suppressed and closed instead of retrying under a new logical key. The
    // receipt remains visibly `uncertain` for operators.
    if (
      error instanceof EmailDeliveryOutcomeUncertainError &&
      input.settleInTx
    ) {
      return true;
    }
    throw error;
  }
  return true;
}

/**
 * Deliver one claimed-job email through a committed local receipt and Resend's
 * provider idempotency key. The exact rendered provider request (including the
 * sender) is encrypted before the first attempt and replayed unchanged; it is
 * cleared atomically once the outcome is final. Reservation and provider phases
 * share one absolute eight-second deadline; DB lock waits are capped at 1.5s and
 * the provider receives only the remaining budget after a settlement reserve.
 * The provider call holds the receipt, owner membership, and user address locks.
 * A crash after provider ACK rolls that transaction back to the last committed
 * unresolved state, and a retry reuses the same key and frozen request. After 23
 * hours we fail safe instead of crossing Resend's documented 24-hour window.
 *
 * `settleInTx` must be idempotent. It commits in the same transaction as a
 * final `sent` or `uncertain` outcome, closing receipt/domain-state crash gaps;
 * it also heals an already-final receipt. An uncertain provider outcome is
 * deliberately treated as at-most-once delivery, never retried under a new key.
 */
export async function deliverJobEmail(
  ctx: ClaimedJobEmailCtx,
  input: JobEmailDeliveryInput & {
    /** User whose current owner membership authorizes the frozen recipient. */
    recipientUserId: string;
  },
): Promise<JobEmailDeliveryResult> {
  claimedJobEmailContext(ctx);
  return deliverJobEmailInternal(ctx, input);
}

/** Reuses the same frozen request, owner locks and provider retry window as
 * claimed-job mail. The caller supplies server-side authorization; request
 * data never supplies this callback or an arbitrary email template. */
export async function deliverControlPlaneEmail(
  ctx: ControlPlaneEmailCtx,
  input: JobEmailDeliveryInput & {
    kind:
      | "checkpoint"
      | "runtime_alert"
      | "trial_started"
      | "trial_ending"
      | "payment_failed";
    recipientUserId: string;
  },
): Promise<JobEmailDeliveryResult> {
  const environment = resolveDeploymentEnvironment();
  if (environment !== "prod" && environment !== "dev" && environment !== "test") {
    throw new Error("Control-plane email delivery is unavailable in tenant runtimes");
  }
  if (typeof ctx.controlPlaneAuthorization !== "function") {
    throw new Error("Control-plane email requires request authorization");
  }
  return deliverJobEmailInternal(ctx, input);
}

/** Internal resume path may omit recipientUserId only because it must recover
 * that immutable subject from an already-committed receipt. */
async function deliverJobEmailInternal(
  ctx: EmailDeliveryCtx,
  input: JobEmailDeliveryInput & { recipientUserId?: string },
): Promise<JobEmailDeliveryResult> {
  // Runtime defense in case a JavaScript caller bypasses the TS signature.
  if (!("controlPlaneAuthorization" in ctx)) claimedJobEmailContext(ctx);
  const deliveryKey = input.deliveryKey.trim();
  if (!deliveryKey || deliveryKey.length > 240) {
    throw new Error("email deliveryKey must contain 1-240 characters");
  }
  const totalTimeoutMs = boundedTestTimeoutMs(
    "totalTimeoutMsForTest",
    input.totalTimeoutMsForTest,
    EMAIL_DELIVERY_TOTAL_TIMEOUT_MS,
  );
  const deliveryDeadlineAt = Date.now() + totalTimeoutMs;
  const now = input.now ?? Date.now();
  const providerMaximumMs = boundedTestTimeoutMs(
    "providerTimeoutMsForTest",
    input.providerTimeoutMsForTest,
    EMAIL_PROVIDER_TIMEOUT_MS,
  );
  const idempotencyKey = providerKey({
    organizationId: ctx.organizationId,
    kind: input.kind,
    deliveryKey,
  });

  const reservation = await withOrg(
    ctx.organizationId,
    async (tx): Promise<Reservation> => {
      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      await authorizeInTx(tx, ctx);
      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext(current_setting('app.current_org', true)),
          hashtext(${`${input.kind}:${deliveryKey}`})
        )`,
      );

      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      const [existing] = await tx
        .select()
        .from(emailDeliveryReceipts)
        .where(
          and(
            eq(emailDeliveryReceipts.kind, input.kind),
            eq(emailDeliveryReceipts.deliveryKey, deliveryKey),
          ),
        )
        .for("update");

      if (existing?.state === "sent") {
        if (input.settleInTx) {
          await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
          await input.settleInTx(tx);
        }
        return {
          status: "sent",
          receiptId: existing.id,
          providerMessageId: existing.providerMessageId,
        };
      }
      if (existing?.state === "uncertain") {
        if (input.settleInTx) {
          await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
          await input.settleInTx(tx);
        }
        return { status: "uncertain", receiptId: existing.id };
      }

      // A provider ACK followed by transaction rollback leaves the last durable
      // state `reserved`. `createdAt` is therefore the earliest safe boundary
      // for every unresolved receipt, even when no attempt clock committed.
      const idempotencyStartedAt =
        existing?.firstAttemptAt ?? existing?.createdAt;
      if (
        (existing?.state === "reserved" || existing?.state === "sending") &&
        idempotencyStartedAt != null &&
        now - idempotencyStartedAt >= EMAIL_PROVIDER_IDEMPOTENCY_RETRY_MS
      ) {
        await settleUncertainReceipt(
          tx,
          existing,
          "provider_idempotency_window_expired",
          now,
          deliveryDeadlineAt,
          input.settleInTx,
        );
        return { status: "uncertain", receiptId: existing.id };
      }

      if (existing) {
        if (existing.state !== "reserved" && existing.state !== "sending") {
          throw new Error(
            `email delivery receipt ${existing.id} has an invalid unresolved state`,
          );
        }
        if (!existing.recipientUserId) {
          await settleUncertainReceipt(
            tx,
            existing,
            RECIPIENT_BINDING_MISSING,
            now,
            deliveryDeadlineAt,
            input.settleInTx,
          );
          return { status: "uncertain", receiptId: existing.id };
        }
        let providerPayload: PreparedEmailPayload;
        try {
          providerPayload = thawPreparedPayload(
            existing.encryptedProviderPayload,
            existing.payloadHash,
          );
        } catch {
          await settleUncertainReceipt(
            tx,
            existing,
            "frozen_provider_payload_unavailable",
            now,
            deliveryDeadlineAt,
            input.settleInTx,
          );
          return { status: "uncertain", receiptId: existing.id };
        }
        return {
          status: "send",
          receiptId: existing.id,
          idempotencyKey: existing.providerIdempotencyKey,
          payloadHash: existing.payloadHash,
          recipientUserId: existing.recipientUserId,
          providerPayload,
        };
      }

      const recipientUserId = input.recipientUserId?.trim();
      if (!recipientUserId) {
        throw new Error(
          "new email delivery receipt requires an intended recipient user id",
        );
      }
      const providerPayload = normalizePreparedPayload(input.prepare());
      const serialized = serializePreparedPayload(providerPayload);
      const frozenHash = payloadHash(serialized);
      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      const recipientFailure = await lockedRecipientAuthorityFailure(
        tx,
        ctx.organizationId,
        recipientUserId,
        providerPayload.to,
      );
      if (recipientFailure) {
        if (input.settleInTx) {
          await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
          await input.settleInTx(tx);
        }
        return { status: "suppressed", reason: recipientFailure };
      }
      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      const [created] = await tx
        .insert(emailDeliveryReceipts)
        .values({
          jobId: ctx.jobId,
          recipientUserId,
          kind: input.kind,
          deliveryKey,
          providerIdempotencyKey: idempotencyKey,
          payloadHash: frozenHash,
          encryptedProviderPayload: encryptSecret(serialized),
          state: "reserved",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: emailDeliveryReceipts.id });
      if (!created) throw new Error("email delivery receipt was not created");
      return {
        status: "send",
        receiptId: created.id,
        idempotencyKey,
        payloadHash: frozenHash,
        recipientUserId,
        providerPayload,
      };
    },
  );

  if (reservation.status === "sent") {
    return {
      sent: true,
      alreadySent: true,
      ...(reservation.providerMessageId
        ? { providerMessageId: reservation.providerMessageId }
        : {}),
    };
  }
  if (reservation.status === "uncertain") {
    throw new EmailDeliveryOutcomeUncertainError(
      `email delivery receipt ${reservation.receiptId} has an uncertain provider outcome`,
    );
  }
  if (reservation.status === "suppressed") {
    return {
      sent: false,
      suppressed: true,
      reason: reservation.reason,
    };
  }

  // These email job types never consume an initial-hosted allowance. Recheck
  // authority only inside the deadline-configured provider transaction so its
  // job/subscription locks remain held through provider and domain settlement.
  requireRemainingDeliveryMs(deliveryDeadlineAt);
  const outcome = await withOrg(
    ctx.organizationId,
    async (tx): Promise<ProviderTransactionResult> => {
      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      await authorizeInTx(tx, ctx);
      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      const [receipt] = await tx
        .select()
        .from(emailDeliveryReceipts)
        .where(eq(emailDeliveryReceipts.id, reservation.receiptId))
        .limit(1)
        .for("update");
      if (!receipt) {
        throw new Error(
          `email delivery receipt ${reservation.receiptId} disappeared before provider delivery`,
        );
      }
      if (receipt.state === "sent") {
        if (input.settleInTx) {
          await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
          await input.settleInTx(tx);
        }
        return {
          status: "sent",
          alreadySent: true,
          providerMessageId: receipt.providerMessageId,
        };
      }
      if (receipt.state === "uncertain") {
        if (input.settleInTx) {
          await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
          await input.settleInTx(tx);
        }
        return { status: "uncertain", receiptId: receipt.id };
      }
      if (receipt.state !== "reserved" && receipt.state !== "sending") {
        throw new Error(
          `email delivery receipt ${receipt.id} has an invalid provider state`,
        );
      }
      if (
        receipt.payloadHash !== reservation.payloadHash ||
        receipt.providerIdempotencyKey !== reservation.idempotencyKey ||
        receipt.recipientUserId !== reservation.recipientUserId
      ) {
        throw new Error(
          `email delivery receipt ${receipt.id} changed before provider delivery`,
        );
      }
      if (!receipt.recipientUserId) {
        await settleUncertainReceipt(
          tx,
          receipt,
          RECIPIENT_BINDING_MISSING,
          now,
          deliveryDeadlineAt,
          input.settleInTx,
        );
        return { status: "uncertain", receiptId: receipt.id };
      }

      // PostgreSQL retains these share locks, plus the receipt's update lock,
      // through the awaited provider call. Owner transfer and address changes
      // therefore wait until the exact frozen request is durably settled.
      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      const recipientFailure = await lockedRecipientAuthorityFailure(
        tx,
        ctx.organizationId,
        receipt.recipientUserId,
        reservation.providerPayload.to,
      );
      if (recipientFailure) {
        await settleUncertainReceipt(
          tx,
          receipt,
          recipientFailure,
          now,
          deliveryDeadlineAt,
          input.settleInTx,
        );
        return { status: "uncertain", receiptId: receipt.id };
      }

      const attemptAt = Math.max(now, receipt.updatedAt, Date.now());
      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      const started = await tx
        .update(emailDeliveryReceipts)
        .set({
          state: "sending",
          attempts: receipt.attempts + 1,
          firstAttemptAt: receipt.firstAttemptAt ?? attemptAt,
          lastAttemptAt: attemptAt,
          lastError: null,
          updatedAt: attemptAt,
        })
        .where(
          and(
            eq(emailDeliveryReceipts.id, receipt.id),
            eq(emailDeliveryReceipts.state, receipt.state),
            eq(emailDeliveryReceipts.payloadHash, receipt.payloadHash),
          ),
        )
        .returning({ id: emailDeliveryReceipts.id });
      if (started.length === 0) {
        throw new Error(
          `email delivery receipt ${receipt.id} could not start a provider attempt`,
        );
      }

      const abortScope = providerAbortScope(
        ctx.signal,
        providerBudgetMs(deliveryDeadlineAt, providerMaximumMs),
      );
      let attempt!:
        | { ok: true; result: SendResult }
        | { ok: false; error: unknown };
      try {
        try {
          attempt = {
            ok: true,
            result: await input.send(
              reservation.providerPayload,
              reservation.idempotencyKey,
              abortScope.signal,
            ),
          };
        } catch (error) {
          attempt = { ok: false, error };
        }
      } finally {
        abortScope.dispose();
      }

      if (!attempt.ok) {
        await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
        const audit = providerErrorAudit(attempt.error);
        const failedAt = Math.max(attemptAt, Date.now());
        const recorded = await tx
          .update(emailDeliveryReceipts)
          .set({ lastError: audit, updatedAt: failedAt })
          .where(
            and(
              eq(emailDeliveryReceipts.id, receipt.id),
              eq(emailDeliveryReceipts.state, "sending"),
              eq(emailDeliveryReceipts.payloadHash, receipt.payloadHash),
            ),
          )
          .returning({ id: emailDeliveryReceipts.id });
        if (recorded.length === 0) {
          throw new Error(
            `email delivery receipt ${receipt.id} could not record provider failure`,
          );
        }
        return { status: "provider_error", audit };
      }
      const result = attempt.result;

      // Test-only ACK crash seam intentionally remains under every lock. A throw
      // rolls this transaction back to the committed reserved/sending receipt.
      input.afterProviderAck?.();

      await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
      const closedAt = Math.max(attemptAt, Date.now());
      const closed = await tx
        .update(emailDeliveryReceipts)
        .set({
          state: "sent",
          encryptedProviderPayload: null,
          providerMessageId: result.id ?? null,
          sentAt: closedAt,
          lastError: null,
          updatedAt: closedAt,
        })
        .where(
          and(
            eq(emailDeliveryReceipts.id, receipt.id),
            eq(emailDeliveryReceipts.state, "sending"),
            eq(emailDeliveryReceipts.payloadHash, receipt.payloadHash),
          ),
        )
        .returning({ id: emailDeliveryReceipts.id });
      if (closed.length === 0) {
        throw new Error(
          `email delivery receipt ${receipt.id} could not be settled`,
        );
      }
      if (input.settleInTx) {
        await configureDeliveryTxDeadline(tx, deliveryDeadlineAt);
        await input.settleInTx(tx);
      }
      return {
        status: "sent",
        alreadySent: false,
        providerMessageId: result.id ?? null,
      };
    },
  );

  if (outcome.status === "provider_error") {
    // Provider messages can echo recipients, action URLs, or tokens. Commit only
    // the safe audit digest, then surface a sanitized error after transaction end.
    throw new EmailProviderDeliveryError(providerErrorReference(outcome.audit));
  }
  if (outcome.status === "uncertain") {
    throw new EmailDeliveryOutcomeUncertainError(
      `email delivery receipt ${outcome.receiptId} has an uncertain provider outcome`,
    );
  }
  return {
    sent: true,
    alreadySent: outcome.alreadySent,
    ...(outcome.providerMessageId
      ? { providerMessageId: outcome.providerMessageId }
      : {}),
  };
}
