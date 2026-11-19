import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  campaignStrategies,
  campaigns,
  channels,
} from "@engager/database/schema";
import { afterCommit, type Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import { enqueueCompileForCampaign } from "../brain/compile";
import { trackModeChanges } from "../telemetry/emit";
import { enqueue, retireFinishedIdempotencyKey } from "../jobs/queue";
import { recordedLiveChecks } from "../liveChecks/records";
import { getSystemState } from "../ratelimit/killswitch";
import { CAPABILITIES, NETWORK_CATALOGS } from "./catalog";
import {
  strategyIssueCode,
  modesByKey,
  parseStrategy,
  type CampaignAgentStrategy,
} from "./contract";
import { voiceMoved } from "./draftingVoice";
import { projectStrategy, projectDocument } from "./project";

/**
 * ACTIVATION — the one thing that writes a campaign's switches once it runs
 * on its strategy (INV-25), in ONE transaction: the version turns `active`,
 * the one before it `archived`, and the projection writes every worker row,
 * `verifyStage` and the wake. A version active without
 * its projections, or projections without a version, is a defect; the caller's
 * transaction is what makes the pair one.
 *
 * Validated in full first, against the campaign's own network: the contract,
 * the account default it inherits from, and a resolution of every binding.
 * Nothing is written for a document that fails.
 *
 * A version that moves the campaign's voice queues, in the same transaction,
 * the redraft of its drafts still waiting (`agentStep/redraft.ts`): the model
 * writes them again in the new voice once this commits — prospective, never
 * reaching what was sent.
 *
 * A version whose `effective_at` is still ahead stays a `draft`, and a job
 * activates it at that instant through this same function — same validation,
 * same projection. Only a campaign that runs on its strategy activates: an
 * unflagged campaign's versions are records, and its workers keep the switches
 * their own writers set.
 *
 * COMPARE-AND-SWAP AT THE INSTANT. A version was written against a base, and a
 * scheduled one may find, when its instant comes, that another version
 * replaced that base meanwhile. It does not activate over a document its author
 * never saw: it turns `pending_review`, writes nothing else, and the answer
 * says so. Scheduled versions therefore activate in effective-time order, each
 * against the version the one before it left.
 */

export type ActivationRefusal =
  | "campaign_not_found"
  | "strategy_not_found"
  | "strategy_superseded"
  | "strategy_cancelled"
  | "strategy_conflict"
  | "strategy_not_activatable"
  | "strategy_invalid";

export class StrategyActivationError extends AppError {
  constructor(
    code: ActivationRefusal,
    message: string,
    readonly recovery: string,
    readonly issues: Array<{ path: string; code: string | null; message: string }> = [],
  ) {
    super(code, message, code === "campaign_not_found" || code === "strategy_not_found" ? 404 : 409);
  }
}

export type ActivationOutcome =
  | {
      status: "active";
      version: number;
      archived: number | null;
      /** Whether the version moved the campaign's voice, so the drafts still
       *  waiting are queued to be written again in it. */
      redraftQueued: boolean;
    }
  | { status: "scheduled"; version: number; effectiveAt: number }
  | { status: "conflict"; version: number; activeVersion: number };

/** The account default a campaign inherits from, parsed, or null when its
 *  channel has none. A stored default that fails the contract refuses the
 *  activation — and a patch drawn against it — rather than resolving as if it
 *  were absent. */
export async function readAccountDefault(
  tx: Tx,
  channelId: number,
  context: Parameters<typeof parseStrategy>[1],
): Promise<{ version: number; document: CampaignAgentStrategy } | null> {
  const [row] = await tx
    .select({ version: campaignStrategies.version, document: campaignStrategies.document })
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.channelId, channelId),
        eq(campaignStrategies.status, "active"),
      ),
    );
  if (!row) return null;
  const parsed = parseStrategy(row.document, context);
  if (parsed.success) return { version: row.version, document: parsed.data };
  throw invalid("the account default", parsed.error.issues);
}

function invalid(
  what: string,
  issues: Parameters<typeof strategyIssueCode>[0][],
): StrategyActivationError {
  return new StrategyActivationError(
    "strategy_invalid",
    `${what} does not satisfy the strategy contract, so nothing was activated.`,
    "Read the issues with get_campaign; a version that fails the contract never activates.",
    issues.map((issue) => ({
      path: issue.path.join("."),
      code: strategyIssueCode(issue),
      message: issue.message,
    })),
  );
}

export async function activateStrategy(
  tx: Tx,
  target: { campaignId: number; version: number },
  now: number = Date.now(),
  /** Of the version already in force: write only what lowers the rows. A
   *  start that re-projects the campaigns it finds is not the owner's
   *  re-arm of one a kill switch disarmed (INV-11). */
  options: { narrowOnly?: boolean } = {},
): Promise<ActivationOutcome> {
  // The campaign row is the activation's lock: two activations of one
  // campaign serialize here, so "the one active version" is never raced.
  const [campaign] = await tx
    .select({
      id: campaigns.id,
      organizationId: campaigns.organizationId,
      channelId: campaigns.channelId,
    })
    .from(campaigns)
    .where(eq(campaigns.id, target.campaignId))
    .for("update");
  if (!campaign) {
    throw new StrategyActivationError(
      "campaign_not_found",
      `campaign ${target.campaignId} not found`,
      "Call list_campaigns and retry with an id from this organization.",
    );
  }
  const versions = await tx
    .select()
    .from(campaignStrategies)
    .where(eq(campaignStrategies.campaignId, target.campaignId));
  const row = versions.find((v) => v.version === target.version);
  if (!row) {
    throw new StrategyActivationError(
      "strategy_not_found",
      `campaign ${target.campaignId} has no strategy version ${target.version}`,
      "Read the versions with get_campaign.",
    );
  }
  const active = versions.find((v) => v.status === "active");
  if (options.narrowOnly && active?.id !== row.id) {
    throw new StrategyActivationError(
      "strategy_not_activatable",
      `version ${target.version} is not the one in force, so it can only be activated in full.`,
      "A narrowing re-projection is of the active version alone.",
    );
  }
  if (row.status === "archived") {
    throw new StrategyActivationError(
      "strategy_superseded",
      `version ${target.version} was replaced by a newer one, so it does not activate again.`,
      "A change back is a new version; read the active one with get_campaign.",
    );
  }
  if (row.status === "cancelled") {
    throw new StrategyActivationError(
      "strategy_cancelled",
      `version ${target.version} was cancelled by an undo before it activated, so it never will.`,
      "Read the active version with get_campaign; a change it still needs is a new patch.",
    );
  }
  if (row.status === "pending_review") {
    throw new StrategyActivationError(
      "strategy_conflict",
      `version ${target.version} was written against a version that was replaced before its instant, so it waits for review instead of activating.`,
      "Read the active version with get_campaign and propose the change again against it.",
    );
  }
  if (row.effectiveAt > now) {
    await enqueue(tx, {
      type: "activate_strategy",
      payload: { campaignId: target.campaignId, version: target.version },
      nextRunAt: row.effectiveAt,
      idempotencyKey: `activate_strategy:${target.campaignId}:${target.version}`,
    });
    return { status: "scheduled", version: row.version, effectiveAt: row.effectiveAt };
  }
  // The compare-and-swap: a version activates only over the base it was
  // written against — so a draft older than the active one waits for review
  // rather than overwriting it. Re-activating the active version is a
  // re-projection of what is already in force.
  if (active && active.id !== row.id && row.baseVersion !== active.version) {
    await tx
      .update(campaignStrategies)
      .set({ status: "pending_review" })
      .where(eq(campaignStrategies.id, row.id));
    return { status: "conflict", version: row.version, activeVersion: active.version };
  }

  const [channel] =
    campaign.channelId === null
      ? []
      : await tx
          .select({ network: channels.network })
          .from(channels)
          .where(eq(channels.id, campaign.channelId));
  if (!channel || campaign.channelId === null) {
    throw new StrategyActivationError(
      "strategy_not_activatable",
      "This campaign has no channel, so its strategy's actions have no network to resolve against.",
      "A campaign is bound to its channel when one exists; connect the account first.",
    );
  }
  const network = NETWORK_CATALOGS[channel.network];
  const parsed = parseStrategy(row.document, { network });
  if (!parsed.success) throw invalid(`version ${row.version}`, parsed.error.issues);
  const document = parsed.data;
  if ((document.steps ?? []).some((step) => step.worker === "writer")) {
    throw new StrategyActivationError(
      "strategy_not_activatable",
      "A Writer step cannot activate yet: no worker can take it.",
      "Remove the Writer's step; the Writer lands later.",
    );
  }
  // Resolved before anything is written: a binding the network cannot place
  // throws here, with nothing flipped.
  const projection = projectDocument(document, {
    accountDefault:
      (await readAccountDefault(tx, campaign.channelId, { network }))?.document ?? null,
    network,
    liveChecks: await recordedLiveChecks(tx, campaign.channelId),
  });

  // Archive before activating: the partial unique index admits one active
  // version per campaign at every statement, not only at commit.
  if (active && active.id !== row.id) {
    await tx
      .update(campaignStrategies)
      .set({ status: "archived" })
      .where(eq(campaignStrategies.id, active.id));
  }
  if (row.status !== "active") {
    await tx
      .update(campaignStrategies)
      .set({ status: "active" })
      .where(eq(campaignStrategies.id, row.id));
  }
  await projectStrategy(tx, target.campaignId, projection, now, options);
  // A new version may write differently: its writing rules compile now, so
  // the next draft does not wait on them.
  if (active?.id !== row.id) await enqueueCompileForCampaign(tx, target.campaignId);
  // A version that is Automatic and takes effect while the kill switch is on
  // cannot be the owner's re-arm: it is narrowed to Ask me at once, durably, so
  // clearing the switch publishes nothing unattended. Re-arming is the owner's
  // (INV-11), and it stamps the ramp.
  if (!options.narrowOnly && projection.ambassador?.publishes && (await getSystemState(tx))?.killSwitch === true) {
    const { narrowCommentToAskMe } = await import("../operations/learningSignals");
    await narrowCommentToAskMe(tx, campaign.organizationId, target.campaignId, "kill_switch", now);
  }
  const before =
    active && active.id !== row.id ? parseStrategy(active.document, { network }) : null;
  const redraftQueued = before?.success === true && voiceMoved(before.data.voice, document.voice);
  if (redraftQueued) await enqueueVoiceRedraft(tx, campaign.organizationId, target.campaignId, now);
  // Usage data: every action whose mode this version moved.
  if (before?.success === true) {
    trackModeChanges(modesByKey(before.data), modesByKey(document), tx);
  }
  // The first version ever in force is the campaign's Start. What it can do is
  // counted, not named: steps, and whether it likes, invites or messages.
  if (!active) {
    const kinds = new Set(
      (document.action_bindings ?? []).map((binding) => CAPABILITIES[binding.capability_ref].kind),
    );
    afterCommit(tx, () =>
      track("campaign_started", {
        steps_count: (document.steps ?? []).length,
        has_like: kinds.has("react"),
        has_invite: kinds.has("connect"),
        has_dm: kinds.has("message") || kinds.has("follow_up"),
      }),
    );
  }
  return {
    status: "active",
    version: row.version,
    archived: active && active.id !== row.id ? active.version : null,
    redraftQueued,
  };
}

/** The version in force of every campaign the owner still has on an account — what a
 *  change above the campaigns activates again, in place. */
export async function inForceOnChannel(
  tx: Tx,
  channelId: number,
): Promise<Array<{ campaignId: number; version: number }>> {
  const rows = await tx
    .select({ campaignId: campaignStrategies.campaignId, version: campaignStrategies.version })
    .from(campaignStrategies)
    .innerJoin(campaigns, eq(campaigns.id, campaignStrategies.campaignId))
    .where(
      and(
        eq(campaigns.channelId, channelId),
        isNull(campaigns.deletedAt),
        eq(campaignStrategies.status, "active"),
        isNotNull(campaignStrategies.campaignId),
      ),
    );
  return rows.map((row) => ({ campaignId: row.campaignId!, version: row.version }));
}

export const voiceRedraftKey = (campaignId: number) => `redraft_for_voice:${campaignId}`;

/**
 * Queue a campaign's voice redraft. One at a time per campaign: the key is
 * held while one is queued or running, and a finished one's is retired first.
 * A version activated while one waits is redrafted by it; one activated while
 * it runs, by its own re-check before it finishes.
 */
async function enqueueVoiceRedraft(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  now: number,
): Promise<void> {
  const key = voiceRedraftKey(campaignId);
  await retireFinishedIdempotencyKey(tx, organizationId, key);
  await enqueue(tx, {
    type: "redraft_for_voice",
    payload: { campaignId },
    idempotencyKey: key,
    nextRunAt: now,
  });
}
