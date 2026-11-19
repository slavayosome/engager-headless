import { and, eq, ne, sql } from "drizzle-orm";
import { campaigns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  campaignsAwaitingProductRecompile,
  campaignsAwaitingRecompile,
  enqueueCompileForCampaign,
  enqueueRecompileForCampaigns,
  enqueueRecompileForProduct,
} from "../brain/compile";
import { hostedJobSpendAccess } from "../entitlements/hosted";
import {
  modeFor,
  resolveJudgmentPolicy,
  type ExecutionMode,
  type JudgmentPolicy,
} from "../tasks/policy";

/** What a change put out of date, and therefore what the compile covers. */
export type CompileScope =
  /** One campaign, named by the tool that touched it. */
  | { kind: "campaign"; campaignId: number }
  /** The Brain changed: every non-archived target. */
  | { kind: "brain" }
  /** A product's facts changed: the non-archived targets it feeds. */
  | { kind: "product"; productId: number };

/** The fields a routed compile adds to its tool's receipt. */
export type CompileReceipt = {
  /** WHICH WAY this compile went, the same word every other routed tool uses.
   *  Absent when nothing was routed at all — a write that changed no row has
   *  no compile to describe, and answering `queued` about it would be a claim
   *  rather than a fact. */
  mode?: ExecutionMode;
  /** A queue row was written that a process will run. Never true for work the
   *  caller's own agent now owes — that is what `pendingTasks` is for. */
  recompileEnqueued: boolean;
  /** Task kinds owed to the CALLER. Absent when nothing is owed, which is both
   *  the background case and an org with no campaign for a brief to belong to. */
  pendingTasks?: string[];
};

/** The receipt of a write that routed no compile, because nothing changed. */
export const NO_COMPILE: CompileReceipt = { recompileEnqueued: false };

/** The receipt half of a routed compile. `policy` is the caller's routing fact
 *  — it decides what else the reply says and never goes on the wire itself. */
export function compileFields({
  policy: _policy,
  ...receipt
}: CompileReceipt & { policy: JudgmentPolicy }): CompileReceipt {
  return receipt;
}

async function targetsAwaiting(tx: Tx, scope: CompileScope): Promise<number> {
  switch (scope.kind) {
    // Status-checked like the other two arms, whose selections exclude an
    // archived target: `save_campaign` and `save_campaign` reach an archived
    // one, and owing a brief for a campaign `listOwedTasks` will never list
    // leaves the agent with a task kind and nowhere to settle it.
    case "campaign": {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, scope.campaignId),
            ne(campaigns.status, "archived"),
          ),
        );
      return row?.n ?? 0;
    }
    case "brain":
      return (await campaignsAwaitingRecompile(tx)).length;
    case "product":
      return (await campaignsAwaitingProductRecompile(tx, scope.productId))
        .length;
  }
}

async function enqueueFor(tx: Tx, scope: CompileScope): Promise<number> {
  switch (scope.kind) {
    case "campaign":
      await enqueueCompileForCampaign(tx, scope.campaignId);
      return 1;
    case "brain":
      return enqueueRecompileForCampaigns(tx);
    case "product":
      return enqueueRecompileForProduct(tx, scope.productId);
  }
}

/**
 * Route a focus-brief compile, and say on the receipt which way it went.
 *
 * ONE decision, taken by every tool that moves a brief out of date. Under
 * `configured_background` it is the enqueue those tools have always done. Under
 * `interactive_external` it writes NOTHING: a free install has no process to
 * claim a `compile_campaign` row, so one written there is an orphan that sits
 * `queued` forever while `recompileEnqueued: true` tells the agent the brief is
 * being taken care of. The brief is owed to the caller's own agent instead —
 * `campaign_brief`, the same task kind `finish_task` already names
 * when an accepted source stage stales a brief, so the skills' `pendingTasks`
 * prose covers this without a second vocabulary.
 *
 * `recompileEnqueued` is the truthful half: false whenever no row was written,
 * whether the policy deferred it, the entitlement refused it, or there was no
 * target for it to be about.
 */
export async function routeCompile(
  tx: Tx,
  organizationId: string,
  scope: CompileScope,
  opts: {
    /** A policy the caller already resolved, so one resolution governs both the
     *  rows written in this transaction and the receipt built from them. */
    policy?: JudgmentPolicy;
    /** Whether the hosted compile-spend gate applies. Default true, which is
     *  what every tool that carried its own `…WhenEntitled` helper did. Pass
     *  false where the call site has always enqueued ungated. */
    spendGate?: boolean;
  } = {},
): Promise<CompileReceipt & { policy: JudgmentPolicy }> {
  const policy = await resolveJudgmentPolicy(tx, opts.policy);
  const mode = modeFor(policy);
  if (policy === "interactive_external") {
    const owed = await targetsAwaiting(tx, scope);
    return {
      policy,
      mode,
      recompileEnqueued: false,
      ...(owed > 0 ? { pendingTasks: ["campaign_brief"] } : {}),
    };
  }
  if (opts.spendGate !== false) {
    const access = await hostedJobSpendAccess(
      tx,
      organizationId,
      "compile_campaign",
    );
    if (!access.allowed) return { policy, mode, recompileEnqueued: false };
  }
  return {
    policy,
    mode,
    recompileEnqueued: (await enqueueFor(tx, scope)) > 0,
  };
}
