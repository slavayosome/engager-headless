import { and, eq } from "drizzle-orm";
import { searchLookalikes, type PostThreadJson } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { isGrant } from "../../connector/resolve";
import { discoveryLeaseKind } from "../../linkedin/searchLimits";
import { failLookalike, lookalikeContext, prepareLookalike } from "../../discovery/lookalike";
import { readRoomOntoMap } from "../../leads/scout/room";
import type { LLM } from "../../ai/client";
import { PostThreadSchema } from "../../linkedin/browser-use/protocol";
import { claimExclusiveRun, releaseExclusiveRun, renewExclusiveRun } from "../../pacing";
import { reserveResearchRead } from "../../ratelimit/ledger";
import { grantFor } from "../context";
import { jobGuardedLlm } from "../providerGuard";
import { RescheduleError } from "../queue";
import { assertHostedJobSpendStillAllowed, assertHostedJobSpendStillAllowedInTx } from "../spendAccess";
import type { SelfScopedCtx } from "../worker";

const LEASE_MS = 10 * 60_000;
type Scope = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;
const isLeadSearchTarget = (target: string): boolean => target === "lead_searches";

/** One explicit room request, one budgeted browser read, one judgment. No
 * transaction spans external work, and a crash after reservation is not a
 * license to read the account again on the queue's next attempt. */
export async function handleSearchLookalike(ctx: SelfScopedCtx,
  payload: { campaignId: number; lookalikeId: number },
  scope: Scope = (work) => withOrg(ctx.organizationId, work)): Promise<Record<string, number>> {
  const { campaignId, lookalikeId } = payload;
  const start = await scope(async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const [row] = await tx.select().from(searchLookalikes).where(and(eq(searchLookalikes.id, lookalikeId),
      eq(searchLookalikes.campaignId, campaignId)));
    if (!row || row.status !== "reading" || row.reader !== "server" || !isLeadSearchTarget(row.target)) return null;
    const current = await lookalikeContext(tx, campaignId);
    if (current.contextRevision !== row.contextRevision) {
      await failLookalike(tx, campaignId, lookalikeId, "read_refused", "context_changed");
      return null;
    }
    const kind = discoveryLeaseKind(current.channel.id);
    const lease = await claimExclusiveRun(tx, kind, LEASE_MS, Date.now());
    if (!lease.claimed) throw new RescheduleError("account_reader_busy");
    // A room read onto a search map also takes the account's run lease, as a
    // Find leads run does, so the two never read at once. Held, it gives the
    // discovery lease back with the transaction and tries again.
    const runKind = isLeadSearchTarget(row.target) ? `worker-run:${current.channel.id}` : null;
    const run = runKind ? await claimExclusiveRun(tx, runKind, LEASE_MS, Date.now()) : null;
    if (run && !run.claimed) throw new RescheduleError("account_run_busy");
    return { ...current, row, kind, expiry: lease.expiresAt, runKind, runExpiry: run?.expiresAt ?? 0 };
  }).catch(async (error) => {
    if (error instanceof RescheduleError) throw error;
    await scope((tx) => failLookalike(tx, campaignId, lookalikeId, "read_refused", "read_unavailable"));
    return null;
  });
  if (!start) return { skipped: 1 };
  let expiry = start.expiry;
  let runExpiry = start.runExpiry;
  let read = false;
  const renew = async () => {
    await assertHostedJobSpendStillAllowed(ctx);
    if (ctx.signal?.aborted) throw new Error("lookalike_aborted");
    const next = await scope((tx) => renewExclusiveRun(tx, start.kind, LEASE_MS, Date.now(), expiry));
    if (next === null) throw new Error("lookalike_lease_lost");
    expiry = next;
    if (start.runKind === null) return;
    const nextRun = await scope((tx) => renewExclusiveRun(tx, start.runKind!, LEASE_MS, Date.now(), runExpiry));
    if (nextRun === null) throw new Error("lookalike_lease_lost");
    runExpiry = nextRun;
  };
  try {
    const granted = await scope((tx) => grantFor(ctx, tx, "thread_read"));
    if (!isGrant(granted)) {
      await scope((tx) => failLookalike(tx, campaignId, lookalikeId, "read_refused", "connector_unavailable"));
      return { refused: 1 };
    }
    const reserved = await scope(async (tx) => {
      await assertHostedJobSpendStillAllowedInTx(tx, ctx);
      const current = await lookalikeContext(tx, campaignId);
      const [row] = await tx.select().from(searchLookalikes).where(eq(searchLookalikes.id, lookalikeId)).for("update");
      if (!row || row.status !== "reading") return false;
      if (row.contextRevision !== current.contextRevision || row.readStartedAt !== null) {
        await failLookalike(tx, campaignId, lookalikeId, "read_refused", row.readStartedAt !== null ? "read_interrupted" : "context_changed");
        return false;
      }
      const now = Date.now();
      const decision = await reserveResearchRead({ db: tx, read: "thread_read", channel: current.channel, campaignId, now });
      if (!decision.ok) {
        await failLookalike(tx, campaignId, lookalikeId, "read_refused", decision.reason);
        return false;
      }
      await tx.update(searchLookalikes).set({ readStartedAt: now, readSpentAt: now }).where(eq(searchLookalikes.id, row.id));
      return true;
    });
    if (!reserved) return { refused: 1 };
    await renew();
    // Recheck a Stop/account change after reservation and immediately before
    // the driver; a refused race still owns its one conservative budget row.
    await scope(async (tx) => {
      if ((await lookalikeContext(tx, campaignId)).contextRevision !== start.contextRevision) throw new Error("lookalike_stale");
    });
    const thread = PostThreadSchema.parse(await granted.use.readPostThread!(start.row.postUrn, { maxComments: 50 }));
    read = true;
    await renew();
    await readRoomOntoMap({ scope, campaignId, lookalikeId, thread, llm: jobGuardedLlm(ctx), now: Date.now(), beforeExternal: renew });
    return { read: 1 };
  } catch {
    await scope((tx) => failLookalike(tx, campaignId, lookalikeId, "read_failed", read ? "judgment_failed" : "read_failed"));
    return { failed: 1 };
  } finally {
    await scope((tx) => releaseExclusiveRun(tx, start.kind, expiry, Date.now()));
    if (start.runKind !== null) await scope((tx) => releaseExclusiveRun(tx, start.runKind!, runExpiry, Date.now()));
  }
}

/** A native client's already-read thread uses the same source binding and
 * one selected-provider judgment, with no Engager browser or read budget. */
export async function judgeHostLookalike(options: {
  campaignId: number; lookalikeId: number; thread: PostThreadJson;
  llm: LLM; scope: Scope; beforeExternal: () => Promise<void>;
}) {
  const { campaignId, lookalikeId, scope } = options;
  const thread = PostThreadSchema.parse(options.thread);
  const prepared = await scope(async (tx) => {
    const current = await prepareLookalike(tx, campaignId, lookalikeId, thread);
    if (current.row.reader !== "agent" || !isLeadSearchTarget(current.row.target) || current.row.readStartedAt !== null) return null;
    await tx.update(searchLookalikes).set({ readStartedAt: Date.now() }).where(eq(searchLookalikes.id, lookalikeId));
    return current;
  });
  if (!prepared) return;
  try {
    await readRoomOntoMap({ scope, campaignId, lookalikeId, thread, llm: options.llm, now: Date.now(), beforeExternal: options.beforeExternal });
  } catch (error) {
    await scope((tx) => failLookalike(tx, campaignId, lookalikeId, "read_failed", "judgment_failed"));
    throw error;
  }
}
