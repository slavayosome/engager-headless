import { backgroundEntitlement, runtimeEntitlement } from "../entitlements/entitlement";
import type { Tx } from "@engager/database/tenant";
import { campaigns, channels, type ActionKind } from "@engager/database/schema";
import { eq } from "drizzle-orm";
import { canEngage } from "../ratelimit/ledger";
import type { PostResult, SessionStatus } from "../linkedin/driver";
import { recordSendSession } from "../linkedin/liveness";
import { assertDispatch, beginDispatch, ExecutionAuthorityError, settleDispatch, type AuthorityToken } from "./authority";

export class DispatchPolicyError extends Error {
  /** From the gate's refusal: when it clears, or that it never will. */
  constructor(readonly reason: string, readonly gate?: { retryAt?: number; permanent?: boolean }) {
    super(reason); this.name = "DispatchPolicyError";
  }
}

/** The authoritative `canEngage`, once per action, after acquiring the
 * operation holder: earlier points ask only `standingRefusal`, and another
 * operation's receipt may have committed since. The action ledger's kinds
 * pass here too, from its dispatch gate. */
export async function assertAccountWritePolicy(tx: Tx, input: {
  channelId: number; campaignId: number | null; action: "comment" | "reply" | "room_reply" | "like" | ActionKind;
  origin: "owner" | "worker"; profileId?: string | null; memberUrn?: string | null; responsive?: boolean;
  /** The owner's own press, which a paused campaign lets through (`canEngage`). */
  pressed?: boolean;
}): Promise<void> {
  const [channel] = await tx.select().from(channels).where(eq(channels.id, input.channelId));
  const [campaign] =
    input.campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId));
  if (!channel || (input.campaignId !== null && !campaign)) throw new DispatchPolicyError("account_unverified");
  const decision = await canEngage({
    action: input.action, channel, campaign: campaign ?? null, origin: input.origin,
    profileId: input.profileId, memberUrn: input.memberUrn, responsive: input.responsive ?? input.action === "reply", pressed: input.pressed, db: tx,
  });
  if (!decision.ok) throw new DispatchPolicyError(decision.reason, { retryAt: decision.retryAt, permanent: decision.permanent });
}

export class DispatchNotStartedError extends Error {
  readonly reason?: string;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "dispatch refused before provider", { cause });
    this.name = "DispatchNotStartedError";
    this.reason = cause instanceof ExecutionAuthorityError || cause instanceof DispatchPolicyError ? cause.reason : undefined;
  }
}

/** Companion actions and standalone likes use the same account/epoch/holder
 * boundary as comments. Their existing durable receipts remain the source of
 * truth for uncertain results; this holder cannot be freed by a timeout. */
export async function dispatchAccountWrite(input: {
  orgScope: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  token: AuthorityToken;
  operationId: string;
  /** Unattended writes also stop on a lapsed licence; an owner's press does not. */
  origin?: "owner" | "worker";
  session: () => Promise<SessionStatus>;
  prepare?: (tx: Tx) => Promise<void>;
  authorize?: (tx: Tx) => Promise<void>;
  write: () => Promise<PostResult>;
}): Promise<PostResult> {
  let started = false;
  let held = false;
  try {
    await input.orgScope(async (tx) => {
      await input.prepare?.(tx);
      await beginDispatch(tx, input.token, input.operationId);
    });
    held = true;
    const session = await input.session();
    await recordSendSession(input.token.organizationId, input.token.accountId, session);
    await input.orgScope(async (tx) => {
      await assertDispatch(tx, input.token, input.operationId, session);
      const admission = await (input.origin === "worker" ? backgroundEntitlement : runtimeEntitlement)(tx, input.token.organizationId, { lock: true });
      if (!admission.allowed) {
        if (admission.reason === "license_lapsed") throw new DispatchPolicyError(admission.reason);
        throw new ExecutionAuthorityError("authority_elsewhere");
      }
      await input.authorize?.(tx);
    });
    started = true;
    const result = await input.write();
    return result;
  } catch (error) {
    if (!started) throw new DispatchNotStartedError(error);
    throw error;
  } finally {
    // Once I/O starts, only the durable receipt's settlement transaction may
    // release this holder. Even a definite answer can be lost before commit.
    if (!started && held) {
      await input.orgScope((tx) => settleDispatch(tx, input.token.channelId, input.operationId));
    }
  }
}
