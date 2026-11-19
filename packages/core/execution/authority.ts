import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { assertNotRecoveryOnly } from "../jobs/recoveryScope";
import { channels, systemState, type Channel } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { SessionStatus } from "../linkedin/driver";
import { adoptRestoredSnapshot, openTransferIntent } from "./transfer";

export type AuthorityReason = "account_unverified" | "account_mismatch" |
  "authority_elsewhere" | "transfer_paused" | "lease_lost" | "delivery_uncertain";
export type AuthorityToken = {
  organizationId: string;
  channelId: number;
  runtimeId: string;
  accountId: string;
  epoch: number;
  placement: "local" | "cloud";
};
export type AuthorityDecision =
  | { allowed: true; token: AuthorityToken }
  | { allowed: false; reason: AuthorityReason; recovery: "verify_account" | "resume_transfer" | "reconcile" };

export class ExecutionAuthorityError extends Error {
  constructor(readonly reason: AuthorityReason) {
    super(reason);
    this.name = "ExecutionAuthorityError";
  }
}

/** How long an operation holder keeps the account: a write that outlasts it
 *  loses its lease, so none may be given longer to answer. */
export const EXECUTION_LEASE_MS = 120_000;

/** Deliberately unrelated to the anonymous installation/telemetry identity. */
export function accountCoordinationKey(network: string, accountId: string): string {
  return createHash("sha256").update(`engager-execution-v1\0${network}\0${accountId}`).digest("hex");
}

/** What a filesystem without hard links answers `link(2)` with. */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EXDEV"]);

function readRuntimeId(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = raw.trim();
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new ExecutionAuthorityError("authority_elsewhere");
  return value;
}

/** Leaves `file` holding one id, this process's or the one that got there
 *  first. */
function publishRuntimeId(file: string): void {
  const id = randomUUID();
  const candidate = `${file}.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(candidate, id, { flag: "wx", mode: 0o600 });
    try {
      linkSync(candidate, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") return;
      if (!LINK_UNSUPPORTED.has(code)) throw error;
      // No hard links here: create the id file exclusively and write it in
      // place, which a reader can catch half made, but never overwrites one.
      try {
        writeFileSync(file, id, { flag: "wx", mode: 0o600 });
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      }
    }
  } finally {
    rmSync(candidate, { force: true });
  }
}

/** Shared by processes at one installation root. The id is minted once and
 * cached for this process. Simultaneous startup is
 * handled by publishing the id whole: it is written to a file of this
 * process's own and linked into place, which fails if the id already exists and
 * never shows a reader a file that is created but not yet written. (Creating
 * the id file exclusively and writing it afterwards did: a second process read
 * it empty and refused as `authority_elsewhere`. That is still how it is made
 * on a filesystem that cannot link.) A copied id is never sufficient: the DB
 * source fence, placement, account and epoch are rechecked for each
 * operation. */
let processRuntimeId: string | undefined;

export function runtimeInstanceId(): string {
  if (processRuntimeId) return processRuntimeId;
  const file = process.env.ENGAGER_EXECUTION_ID_FILE ?? join(homedir(), ".engager", "execution-id");
  const existing = readRuntimeId(file);
  if (existing) return (processRuntimeId = existing);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  publishRuntimeId(file);
  const published = readRuntimeId(file);
  if (!published) throw new ExecutionAuthorityError("authority_elsewhere");
  return (processRuntimeId = published);
}

const denied = (reason: AuthorityReason): AuthorityDecision => ({
  allowed: false, reason,
  recovery: reason === "transfer_paused" || reason === "authority_elsewhere" ? "resume_transfer"
    : reason === "lease_lost" || reason === "delivery_uncertain" ? "reconcile" : "verify_account",
});

async function sourceFenced(tx: Tx, organizationId: string): Promise<boolean> {
  const [state] = await tx.select().from(systemState)
    .where(eq(systemState.organizationId, organizationId));
  return state?.transferPaused === true || state?.cloudPaused === true;
}

/** Never accepts a caller-authored identity. The input is the managed driver's
 * session result. A different account pauses the existing binding rather than
 * silently moving its budget, saved drafts or unresolved delivery obligations. */
export async function observeAccount(tx: Tx, channelId: number, session: SessionStatus): Promise<AuthorityDecision> {
  const [channel] = await tx.select().from(channels).where(eq(channels.id, channelId)).for("update");
  if (!channel) return denied("account_unverified");
  if (await sourceFenced(tx, channel.organizationId)) return denied("transfer_paused");
  const accountId = session.ok ? session.account?.externalAccountId?.trim() : undefined;
  if (!accountId || (channel.executionAccountId && channel.executionAccountId !== accountId)) {
    await tx.update(channels).set({ executionState: "paused_recovery" }).where(eq(channels.id, channelId));
    return denied(accountId ? "account_mismatch" : "account_unverified");
  }
  const placement = "local";
  const runtimeId = runtimeInstanceId();
  const handoff = await openTransferIntent(tx, channel.organizationId, "destination");
  // A portable restore leaves its own record and no runtime of its own, so
  // neither branch below could ever bind it — an epoch it cannot raise, and a
  // reconnect that requires the runtime id the archive had. Adoption takes one
  // higher epoch on this session, having proved no more than it can — and only
  // at a LOCAL placement, for the same reason the initial binding below is
  // local-only.
  if (handoff?.state === "restored") {
    const adoption = await adoptRestoredSnapshot(tx, {
      intentId: handoff.id, organizationId: channel.organizationId,
      channelId, session, now: Date.now(),
    });
    if (adoption.status !== "adopted" && adoption.status !== "already_adopted") {
      return denied(
        adoption.status === "identity_mismatch" ? "account_mismatch" : "transfer_paused",
      );
    }
    return readExecutionAuthority(tx, channelId);
  }
  if (channel.executionEpoch === 0) {
    // Initial local binding only; a session alone cannot claim cloud.
    await tx.update(channels).set({
      executionAccountId: accountId, externalAccountId: accountId,
      executionRuntimeId: runtimeId, executionPlacement: placement,
      executionEpoch: 1, executionState: "active", verifiedAt: Date.now(),
    }).where(eq(channels.id, channelId));
  } else if (channel.executionState === "paused_recovery"
    && channel.executionRuntimeId === runtimeId && channel.executionPlacement === placement
    && channel.executionAccountId === accountId && !channel.executionHolder) {
    // The same verified account returned to this installation. Copied/retired
    // runtimes and unresolved sends cannot take this reconnect path.
    await tx.update(channels).set({
      executionState: "active", executionEpoch: channel.executionEpoch + 1,
      verifiedAt: Date.now(),
    }).where(eq(channels.id, channelId));
  }
  return readExecutionAuthority(tx, channelId);
}

export async function readExecutionAuthority(tx: Tx, channelId: number, expected?: AuthorityToken): Promise<AuthorityDecision> {
  const [channel] = await tx.select().from(channels).where(eq(channels.id, channelId));
  if (!channel) return denied("account_unverified");
  if (await sourceFenced(tx, channel.organizationId)) return denied("transfer_paused");
  if (!channel.executionAccountId || !Number.isSafeInteger(channel.executionEpoch) || channel.executionEpoch <= 0) return denied("account_unverified");
  if (channel.executionAccountId !== channel.externalAccountId) return denied("account_mismatch");
  const runtimeId = runtimeInstanceId();
  const placement = "local";
  if (channel.executionState !== "active" || channel.executionRuntimeId !== runtimeId || channel.executionPlacement !== placement) {
    return denied("authority_elsewhere");
  }
  const token: AuthorityToken = {
    organizationId: channel.organizationId, channelId, runtimeId,
    accountId: channel.executionAccountId, epoch: channel.executionEpoch, placement,
  };
  if (expected && Object.keys(token).some((key) => token[key as keyof AuthorityToken] !== expected[key as keyof AuthorityToken])) {
    return denied("authority_elsewhere");
  }
  return { allowed: true, token };
}

export function requireAuthority(decision: AuthorityDecision): AuthorityToken {
  if (!decision.allowed) throw new ExecutionAuthorityError(decision.reason);
  return decision.token;
}

/** The database clock bounds an operation holder. Expiry never frees a possibly
 * dispatched write. Only settlement/reconciliation of the same operation does. */
export async function beginDispatch(tx: Tx, token: AuthorityToken, operationId: string): Promise<void> {
  // Every canonical send passes here, which makes it the one place a recovery
  // task can be stopped from dispatching new content whatever route it took.
  assertNotRecoveryOnly("publish");
  const [channel] = await tx.select().from(channels).where(eq(channels.id, token.channelId)).for("update");
  requireAuthority(await readExecutionAuthority(tx, token.channelId, token));
  if (channel!.executionHolder) throw new ExecutionAuthorityError("delivery_uncertain");
  await tx.update(channels).set({
    executionHolder: operationId,
    executionLeaseUntil: sql`(extract(epoch from clock_timestamp()) * 1000)::bigint + ${EXECUTION_LEASE_MS}`,
  }).where(eq(channels.id, token.channelId));
}

export async function assertDispatchHolder(tx: Tx, token: AuthorityToken, operationId: string): Promise<void> {
  requireAuthority(await readExecutionAuthority(tx, token.channelId, token));
  const found = await tx.select({ id: channels.id }).from(channels).where(and(
    eq(channels.id, token.channelId), eq(channels.executionHolder, operationId),
    sql`${channels.executionLeaseUntil} > (extract(epoch from clock_timestamp()) * 1000)::bigint`,
  ));
  if (!found.length) throw new ExecutionAuthorityError("lease_lost");
}

export async function assertDispatch(tx: Tx, token: AuthorityToken, operationId: string, session: SessionStatus): Promise<void> {
  await assertDispatchHolder(tx, token, operationId);
  if (!session.ok || session.account?.externalAccountId !== token.accountId) {
    throw new ExecutionAuthorityError("account_mismatch");
  }
}

/** Does not authorize another send. Safe after lapse/epoch loss, and an old
 * receipt cannot clear a successor's operation holder. */
export async function settleDispatch(tx: Tx, channelId: number, operationId: string): Promise<void> {
  await tx.update(channels).set({ executionHolder: null, executionLeaseUntil: null })
    .where(and(eq(channels.id, channelId), eq(channels.executionHolder, operationId)));
}
