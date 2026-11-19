import { and, eq, notInArray } from "drizzle-orm";
import { channels, transferIntents } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { SessionStatus } from "../linkedin/driver";
import { runtimeInstanceId } from "./authority";

/**
 * The record a portable restore leaves behind, and the adoption that takes it
 * into service (ADR-02). One organization, one open intent per side, and
 * exactly one activation.
 *
 * Nothing here ever replays work. Recreating eligible future work from workers
 * is ordinary scheduling; unresolved obligations travel as evidence and are
 * reconciled, never dispatched again.
 */
export type TransferSide = "source" | "destination";
export type TransferIntent = typeof transferIntents.$inferSelect;

const TERMINAL_STATES: TransferIntent["state"][] = ["activated", "abandoned"];

export async function openTransferIntent(
  tx: Tx,
  organizationId: string,
  side: TransferSide,
): Promise<TransferIntent | undefined> {
  const [row] = await tx
    .select()
    .from(transferIntents)
    .where(
      and(
        eq(transferIntents.organizationId, organizationId),
        eq(transferIntents.side, side),
        notInArray(transferIntents.state, TERMINAL_STATES),
      ),
    );
  return row;
}

/** `transfer_intents` sits outside tenant RLS, so every mutation binds the
 * organization explicitly — the convention the other global tables follow. */
async function advance(
  tx: Tx,
  input: { intentId: string; organizationId: string },
  patch: Partial<typeof transferIntents.$inferInsert>,
  now: number,
): Promise<TransferIntent | undefined> {
  const [row] = await tx
    .update(transferIntents)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(transferIntents.id, input.intentId),
        eq(transferIntents.organizationId, input.organizationId),
      ),
    )
    .returning();
  return row;
}

export type RestoreAdoptionResult =
  | { status: "adopted" | "already_adopted"; epoch: number }
  | {
      status:
        | "identity_mismatch"
        | "not_restored"
        | "unknown_intent";
    };

/**
 * Take a RESTORED snapshot into service on this machine.
 *
 * A portable archive is not a handoff. It proves nothing about another install
 * — no quiesce, no stop receipt, no verified copy — so this path proves what
 * can actually be proved instead: the owner ran `restore` against this database, and THIS
 * machine's managed driver verifies the account. Then one epoch above
 * everything the snapshot carried, so no runtime named in the archive can still
 * compare equal to this one.
 *
 * The fence against a second executor stays where it belongs. `restore` refuses
 * over an organization whose authority has demonstrably moved
 * (`packages/database/portable-restore.ts`), and `observeAccount` /
 * `readExecutionAuthority` refuse while `transfer_paused` is up. Unrelated offline clones remain
 * outside the supported guarantee (TIER-05); this is the recovery route for the
 * supported case, an owner whose machine died.
 */
export async function adoptRestoredSnapshot(
  tx: Tx,
  input: {
    intentId: string;
    organizationId: string;
    channelId: number;
    /** This install's OWN managed-driver session, not a copied receipt. */
    session: SessionStatus;
    now: number;
  },
): Promise<RestoreAdoptionResult> {
  const [intent] = await tx
    .select()
    .from(transferIntents)
    .where(eq(transferIntents.id, input.intentId))
    .for("update");
  if (!intent || intent.organizationId !== input.organizationId) {
    return { status: "unknown_intent" };
  }
  if (intent.state === "activated") {
    return { status: "already_adopted", epoch: intent.activatedEpoch! };
  }
  if (intent.state !== "restored") return { status: "not_restored" };

  const [channel] = await tx
    .select()
    .from(channels)
    .where(eq(channels.id, input.channelId))
    .for("update");
  const accountId = input.session.ok
    ? input.session.account?.externalAccountId?.trim()
    : undefined;
  if (
    !channel ||
    channel.organizationId !== input.organizationId ||
    !accountId ||
    (channel.executionAccountId && channel.executionAccountId !== accountId)
  ) {
    await advance(
      tx,
      input,
      { lastError: "destination_identity_mismatch" },
      input.now,
    );
    return { status: "identity_mismatch" };
  }

  const epoch =
    Math.max(channel.executionEpoch, intent.expectedEpoch ?? 0) + 1;
  await tx
    .update(channels)
    .set({
      executionAccountId: accountId,
      externalAccountId: accountId,
      executionRuntimeId: runtimeInstanceId(),
      executionPlacement: "local",
      executionEpoch: epoch,
      executionState: "active",
      executionTransferId: intent.id,
      // The archive carried no credentials and no live operation; a copied
      // holder would be a lease nothing can settle.
      executionHolder: null,
      executionLeaseUntil: null,
      verifiedAt: input.now,
    })
    .where(eq(channels.id, input.channelId));
  await advance(
    tx,
    input,
    {
      state: "activated",
      activatedEpoch: epoch,
      activatedAt: input.now,
      lastError: null,
    },
    input.now,
  );
  return { status: "adopted", epoch };
}
