import { desc, eq } from "drizzle-orm";
import { campaignStrategies, channels } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { addStepPatch } from "../strategy/addStep";
import type { CampaignAgentStrategy } from "../strategy/contract";
import { readPatchState } from "../strategy/patch";
import { submitStrategyPatch } from "../strategy/submit";

/**
 * Write the next version of a campaign's strategy as a `draft`, edited from
 * its newest one — what Phase 39's patch will do, without its proposal: these
 * suites are about what ACTIVATION does with a version, not how one is made.
 *
 * The edit receives the stored document and returns the new one; version,
 * previous version and effective instant are stamped here so a case states
 * only the change it is about. The instant is required: a suite on a pinned
 * clock that defaulted it to the wall clock would stage a version effective
 * months after its own "now", which activation rightly only schedules.
 */
export async function stageStrategyVersion(
  tx: Tx,
  campaignId: number,
  edit: (document: CampaignAgentStrategy) => CampaignAgentStrategy,
  effectiveAt: number,
): Promise<number> {
  const [newest] = await tx
    .select()
    .from(campaignStrategies)
    .where(eq(campaignStrategies.campaignId, campaignId))
    .orderBy(desc(campaignStrategies.version))
    .limit(1);
  if (!newest) throw new Error(`campaign ${campaignId} has no strategy to edit`);
  const version = newest.version + 1;
  const document = edit(structuredClone(newest.document) as CampaignAgentStrategy);
  await tx.insert(campaignStrategies).values({
    campaignId,
    channelId: null,
    version,
    status: "draft",
    baseVersion: newest.version,
    document: {
      ...document,
      version,
      previous_version: newest.version,
      effective_at: new Date(effectiveAt).toISOString(),
    },
    patchProvenance: {
      source: "patch",
      instruction: null,
      intent: null,
      scope: { campaignId, stepId: null },
      changes: [],
      compilerVersion: null,
      approver: null,
    },
    effectiveAt,
    createdAt: Date.now(),
  });
  return version;
}

/**
 * Make `document` the account default of `channelId` — active at once, the
 * row a campaign on that channel inherits from and is capped by. What setup
 * and the chat's patch will write for an account, without either: these
 * suites are about what a default DOES, not how one is made.
 */
export async function activateAccountDefault(
  tx: Tx,
  channelId: number,
  document: CampaignAgentStrategy,
): Promise<void> {
  await tx.insert(campaignStrategies).values({
    campaignId: null,
    channelId,
    version: document.version,
    status: "active",
    document,
    patchProvenance: {
      source: "seed",
      instruction: null,
      intent: null,
      scope: null,
      changes: [],
      compilerVersion: "test",
      approver: null,
    },
    effectiveAt: Date.now() - 60_000,
  });
}

/** `activateAccountDefault` on the org's one channel, for the suites that have just the one. */
export async function activateChannelAccount(tx: Tx, document: CampaignAgentStrategy): Promise<void> {
  const [channel] = await tx.select().from(channels);
  await activateAccountDefault(tx, channel!.id, document);
}

/** Hires a catalog step into a campaign as a draft, at the modes given. */
export async function hireStep(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  catalogStep: Parameters<typeof addStepPatch>[0]["catalogStep"],
  modes: NonNullable<NonNullable<Parameters<typeof addStepPatch>[0]["staged"]>["modes"]>,
): Promise<void> {
  const state = await readPatchState(tx, campaignId, { lock: false });
  await submitStrategyPatch(tx, organizationId, addStepPatch({ campaignId, expectedBaseVersion: state.active.version,
    document: state.base, catalogStep, staged: { modes } }), { approver: "test", now: Date.now(), draft: true });
}
