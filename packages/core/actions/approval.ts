import { and, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  actionApprovals,
  actions,
  campaigns,
  conversationEvents,
  messages,
  productFacts,
  type ActionApprovalRow,
  type ActionDependencyVersions,
  type ActionRow,
  type OfferBinding,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { loadStrategy, type LoadedStrategy } from "../agentStep/select";
import { getOwnPostRepliesScoped } from "../operations/orgSettings";
import { modeFor } from "../strategy/mode";
import { currentMemoryVersion } from "../memory/records";
import { approvedOffer } from "../products/offers";
import { enqueueActionDispatch } from "./drain";
import { ActionLedgerError } from "./errors";
import { trackActionDecided } from "../telemetry/emit";
import { isMessageSend, targetHash } from "./keys";
import { pauseReasonCode, pausesTouching, pauseVerdict, scopesOf } from "./pause";

/**
 * ONE YES, BOUND TO WHAT IT WAS GIVEN FOR (spec §21 "approval binding and
 * invalidation"; INV-27).
 *
 * An approval binds the exact words (`content_hash`), the exact target
 * (`target_hash`) and what they rested on: the facts at their content
 * hashes, the observations at their revisions, the memory version, and the
 * action's authority — the effective mode of its binding. It is one-use and
 * it expires.
 *
 * At the gate every bound value is compared with the present, and the first
 * that moved names the invalidation, in this order:
 *
 *   used       the approval already sent something
 *   expired    past `expires_at`
 *   text       the words are not the words approved
 *   target     the action target is not the action target approved
 *   facts      a fact it rests on changed or is gone
 *   evidence   an observation it answers was edited or removed
 *   memory     the memory it read moved
 *   authority  its binding no longer resolves above Off — a grant revoked, a
 *              mode or a ceiling lowered, the binding removed
 *
 * The strategy's version and the voice are recorded beside them and never
 * compared: an unrelated settings edit — a pacing number, another step's
 * instructions — leaves a valid approval standing. A voice change is
 * prospective; it reaches an approval only through the words, which is the
 * `text` row.
 */

/** How long a yes stands. A day: past it the opportunity is stale and the
 *  owner looks again (spec §16, "expired approval … means no send"). */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;

export const INVALIDATION_REASONS = [
  "used",
  "expired",
  "text",
  "target",
  "facts",
  "evidence",
  "memory",
  "authority",
  // The owner's own, never the gate's: Unschedule takes the yes back
  // (`actions/ledger.ts` `unscheduleAction`).
  "owner_unscheduled",
] as const;
export type InvalidationReason = (typeof INVALIDATION_REASONS)[number];

/** What the bound values are now. */
export type CurrentDependencies = {
  contentHash: string;
  targetHash: string;
  /** Each bound fact's content hash now; absent when the fact is gone. */
  facts: ReadonlyMap<number, string>;
  /** Bound observations a later revision superseded, or that are gone. */
  staleSources: ReadonlySet<number>;
  memory: string | null;
  /** The binding's effective mode now; null when nothing resolves it. */
  authority: string | null;
  /** The approved words' content hash of the offer the action makes, now;
   *  null when it makes none, or its offer is retired or awaits a yes. */
  offer: string | null;
};

/** The first bound value that moved, or null when the approval still holds.
 *  Pure. */
export function approvalInvalidation(
  approval: Pick<
    ActionApprovalRow,
    "contentHash" | "targetHash" | "dependencyVersions" | "expiresAt" | "usedAt"
  >,
  current: CurrentDependencies,
  now: number,
): InvalidationReason | null {
  const bound = approval.dependencyVersions;
  if (approval.usedAt !== null) return "used";
  if (now >= approval.expiresAt) return "expired";
  if (approval.contentHash !== current.contentHash) return "text";
  if (approval.targetHash !== current.targetHash) return "target";
  if (bound.facts.some((fact) => current.facts.get(fact.id) !== fact.contentHash)) return "facts";
  if (bound.offer !== undefined && current.offer !== bound.offer.contentHash) return "facts";
  if (bound.sources.some((source) => current.staleSources.has(source.eventId))) return "evidence";
  if (bound.memory !== current.memory) return "memory";
  if (bound.authority !== null && (current.authority === null || current.authority === "off")) {
    return "authority";
  }
  return null;
}

/**
 * The effective mode of the action's binding on its campaign's active
 * strategy — the documents' authority, without the clock: whether the
 * account's window is open is the gate's hold, never a reason to forget a
 * yes. Null for an action no binding proposed (the owner's own act), and for
 * a binding the strategy no longer has.
 */
export async function authorityIn(tx: Tx, row: Pick<ActionRow, "campaignId" | "actionBindingId" | "target">): Promise<string | null> {
  if (row.actionBindingId === null) return null;
  if (row.campaignId === null) return "off";
  // A reply on the owner's own post follows the account's setting, which no
  // step binds (`modeFor` with `ownPost`).
  if (row.target.ownPost) return (await modeFor(tx, { ownPost: await getOwnPostRepliesScoped(tx), campaignId: row.campaignId })).effective;
  return (await modeFor(tx, { campaignId: row.campaignId, actionBindingId: row.actionBindingId })).effective ?? "off";
}

/** The active strategy an action's campaign resolves it against. */
export async function strategyFor(
  tx: Tx,
  row: Pick<ActionRow, "campaignId">,
): Promise<LoadedStrategy | null> {
  if (row.campaignId === null) return null;
  const [campaign] = await tx
    .select({ id: campaigns.id, channelId: campaigns.channelId })
    .from(campaigns)
    .where(eq(campaigns.id, row.campaignId));
  return campaign ? loadStrategy(tx, campaign) : null;
}

/** The present value of everything an approval of this row binds, with the
 *  authority its strategy gives it now. */
export async function currentDependencies(
  tx: Tx,
  row: ActionRow,
  authority: string | null,
): Promise<CurrentDependencies> {
  const factIds = row.candidate.versions.facts.map((fact) => fact.id);
  const facts =
    factIds.length === 0
      ? []
      : await tx
          .select({ id: productFacts.id, contentHash: productFacts.contentHash })
          .from(productFacts)
          .where(inArray(productFacts.id, factIds));
  const sourceIds = row.candidate.sources.map((source) => source.eventId);
  const later = alias(conversationEvents, "later");
  const present =
    sourceIds.length === 0
      ? []
      : await tx
          .select({ id: conversationEvents.id, supersededBy: later.id })
          .from(conversationEvents)
          .leftJoin(later, eq(later.supersedesEventId, conversationEvents.id))
          .where(inArray(conversationEvents.id, sourceIds));
  const live = new Set(present.filter((event) => event.supersededBy === null).map((event) => event.id));
  return {
    contentHash: row.contentHash,
    targetHash: targetHash(row.target),
    facts: new Map(facts.map((fact) => [fact.id, fact.contentHash])),
    staleSources: new Set(sourceIds.filter((id) => !live.has(id))),
    // The memory its step read that is still in force: an edit or a forget
    // since moves the digest.
    memory: await currentMemoryVersion(tx, row.stepRunId, row.candidate.versions.memory),
    authority,
    offer: await currentOffer(tx, row.candidate.versions.offer),
  };
}

/** The approved words' hash of the offer an action makes, as they stand. */
async function currentOffer(tx: Tx, bound: OfferBinding | undefined): Promise<string | null> {
  if (bound === undefined) return null;
  return (await approvedOffer(tx, bound.ref))?.contentHash ?? null;
}

/** The row's one live approval: neither used nor invalidated. */
export async function liveApproval(
  tx: Tx,
  actionExecutionId: number,
): Promise<ActionApprovalRow | null> {
  const [row] = await tx
    .select()
    .from(actionApprovals)
    .where(
      and(
        eq(actionApprovals.actionExecutionId, actionExecutionId),
        isNull(actionApprovals.usedAt),
        isNull(actionApprovals.invalidatedAt),
      ),
    );
  return row ?? null;
}

/**
 * Say yes to one action awaiting review: bind an approval to its words, its
 * target and their dependencies as they are now, and move it to `approved`.
 * Approving an action already approved is that approval. An action whose
 * binding resolves Off now cannot be approved: the owner lowered it after it
 * was proposed, and that decision stands. Nor can one under a Stop: a yes
 * given there would only wait to be cancelled at the gate.
 */
export async function approveAction(
  tx: Tx,
  input: {
    id: number;
    approver: string;
    now?: number;
    /** The caller reports the decision itself (it knows more of how the words came to be). */
    silent?: boolean;
  },
): Promise<{ action: ActionRow; approval: ActionApprovalRow }> {
  const now = input.now ?? Date.now();
  const row = await lockAction(tx, input.id);
  if (row.status === "approved") {
    const approval = await liveApproval(tx, row.id);
    if (approval) return { action: row, approval };
  }
  if (row.status !== "awaiting_review" && row.status !== "approved") {
    throw new ActionLedgerError(
      "action_not_awaiting_review",
      `Action ${row.id} is ${row.status}; only an action waiting for a yes can be approved.`,
      "Read it with list_activity. A cancelled or settled action is never sent again; a new proposal is a new action.",
    );
  }
  const stopped = pauseVerdict(
    await pausesTouching(tx, scopesOf(row), row.generationSeen),
    row.generationSeen,
  );
  if (stopped) {
    throw new ActionLedgerError(
      "action_stopped",
      `Action ${row.id} sits under a Stop, or was proposed before one (${pauseReasonCode(stopped)}), so it cannot be approved.`,
      "Skip it. After a Resume, a worker proposes afresh from what is true then; nothing a Stop outranked is revived.",
    );
  }
  const current = await currentDependencies(
    tx,
    row,
    await authorityIn(tx, row),
  );
  if (row.actionBindingId !== null && (current.authority === null || current.authority === "off")) {
    throw new ActionLedgerError(
      "action_not_permitted",
      `Action ${row.id}'s ${row.kind} resolves Off on its campaign now, so it cannot be approved.`,
      "The campaign's strategy no longer allows this action. Skip it, or change the mode first and let the next wake propose it again.",
    );
  }
  const dependencyVersions: ActionDependencyVersions = {
    facts: row.candidate.versions.facts.filter((fact) => current.facts.get(fact.id) === fact.contentHash),
    memory: current.memory,
    sources: row.candidate.sources.filter((source) => !current.staleSources.has(source.eventId)),
    authority: current.authority,
    strategy: row.candidate.versions.strategy,
    voice: row.candidate.versions.voice,
    ...(row.candidate.versions.offer ? { offer: row.candidate.versions.offer } : {}),
  };
  // A candidate that rests on something already gone is not approvable as it
  // stands: approving it would bind a yes to facts nobody can check — an
  // offer retired or reworded since among them.
  if (
    dependencyVersions.facts.length !== row.candidate.versions.facts.length ||
    dependencyVersions.sources.length !== row.candidate.sources.length ||
    (row.candidate.versions.offer !== undefined && current.offer !== row.candidate.versions.offer.contentHash)
  ) {
    throw new ActionLedgerError(
      "action_stale",
      `Action ${row.id} rests on a fact or an observation that has changed since it was proposed.`,
      "Skip it; the next wake drafts from what is true now.",
    );
  }
  const [approval] = await tx
    .insert(actionApprovals)
    .values({
      actionExecutionId: row.id,
      approver: input.approver,
      contentHash: current.contentHash,
      targetHash: current.targetHash,
      dependencyVersions,
      expiresAt: now + APPROVAL_TTL_MS,
      createdAt: now,
    })
    .returning();
  const [action] = await tx
    .update(actions)
    .set({ status: "approved", statusReason: null, updatedAt: now })
    .where(eq(actions.id, row.id))
    .returning();
  // The yes goes to the gate next, in this transaction: it commits with the
  // approval or not at all.
  await enqueueActionDispatch(tx, row.channelId, now);
  if (!input.silent) trackActionDecided(action!, "approved", { written: "kept_draft", retentionPercent: 100 }, tx);
  return { action: action!, approval: approval! };
}

/**
 * An approval the gate found stale: record why, and put its action back
 * where the owner can look again. Never a send, never a cancel — what changed
 * may still be worth a fresh yes.
 */
export async function invalidateApproval(
  tx: Tx,
  approval: Pick<ActionApprovalRow, "id" | "actionExecutionId">,
  reason: InvalidationReason,
  now: number,
): Promise<void> {
  await tx
    .update(actionApprovals)
    .set({ invalidatedAt: now, invalidatedReason: reason })
    .where(and(eq(actionApprovals.id, approval.id), isNull(actionApprovals.invalidatedAt)));
  await tx
    .update(actions)
    .set({
      status: "awaiting_review",
      statusReason: `approval_invalidated:${reason}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(actions.id, approval.actionExecutionId),
        eq(actions.status, "approved"),
      ),
    );
}

/**
 * The message of a message-send action (`actions/messageSend.ts`), locked before
 * the action: the order a message's own status change takes, since the trigger
 * that cancels its queued action runs once the message row is already locked.
 * Every place that locks such an action takes this first, so none can hold the
 * action while it waits for the message.
 */
export async function lockMessageOf(tx: Tx, id: number): Promise<void> {
  const [peek] = await tx.select({ kind: actions.kind, messageId: actions.messageId })
    .from(actions).where(eq(actions.id, id));
  if (peek && isMessageSend(peek.kind) && peek.messageId !== null) {
    await tx.select({ id: messages.id }).from(messages).where(eq(messages.id, peek.messageId)).for("update");
  }
}

/** One action, locked for the decision about to be taken on it. */
export async function lockAction(tx: Tx, id: number): Promise<ActionRow> {
  await lockMessageOf(tx, id);
  const [row] = await tx
    .select()
    .from(actions)
    .where(eq(actions.id, id))
    .for("update");
  if (!row) {
    throw new ActionLedgerError(
      "action_not_found",
      `Action ${id} not found in this organization.`,
      "Read the ids with list_activity.",
    );
  }
  return row;
}
