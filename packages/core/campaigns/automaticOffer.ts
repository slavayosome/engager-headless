import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { normalizedEditDistance } from "@engager/common/text-provenance";
import { campaigns, feedback, messageDraftRevisions, messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { describeAction } from "../strategy/cardWords";
import type { StrategyPatch } from "../strategy/patch";
import { previewModes } from "../strategy/preview";
import { readCampaignStrategy } from "../operations/campaignWorkspace";
import { OWNER_AUTHORED_MODEL } from "../learning/authorship";

export const OFFER_AFTER_APPROVED = 10;
/** At most one fifth of the latest approved drafts may differ by more than
 * one fifth of their words. The existing normalized edit metric owns words. */
export const FEW_EDITS = { maxDistance: 0.2, maxEditedShare: 0.2 } as const;
const ACTION = "publish_comment";

export type AutomaticOffer = {
  campaignId: number; version: number; stepId: string; bindingId: string;
  label: string; approved: number; edited: number; held: string | null;
};

/** Advice only. Reads confirmed sends and trusted owner approval evidence;
 * no message text is copied into a new row, response or telemetry. */
export async function automaticOfferFor(tx: Tx, campaignId: number, now = Date.now()): Promise<AutomaticOffer | null> {
  const [campaign] = await tx.select().from(campaigns).where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  if (!campaign || campaign.status === "archived" || campaign.automaticOfferDismissed?.[ACTION]) return null;
  const strategy = await readCampaignStrategy(tx, campaign);
  if (strategy.notStarted || !strategy.document || !strategy.version || !strategy.network) return null;
  const action = strategy.actions.find((item) => item.capability === ACTION && item.requested === "review");
  if (!action) return null;

  // EXISTS counts each message once, even after multiple approvals/revisions.
  // A confirmed send of the exact owner-approved text is required. The direct
  // composer path has a frozen draft-fit measurement instead of feedback.
  const approved = await tx.select({ proposed: messages.proposedText, final: messages.finalText,
    fit: messages.draftFitDistance }).from(messages).where(and(
    eq(messages.campaignId, campaignId), eq(messages.kind, "comment"), eq(messages.status, "posted"),
    isNotNull(messages.postedAt), isNotNull(messages.externalUrn),
    sql`(${messages.ownerOrigin} is null or ${messages.ownerOrigin} < 0.5)`,
    // A retaken rejected message keeps historical revisions/run lineage. A
    // composer replacement qualifies only through its current offered draft.
    sql`(${messages.model} is distinct from ${OWNER_AUTHORED_MODEL} or ${messages.draftFitDistance} is not null)`,
    sql`((${messages.model} is not null and ${messages.model} <> ${OWNER_AUTHORED_MODEL}) or ${messages.workerRunId} is not null or ${messages.draftFitDistance} is not null or exists (
      select 1 from ${messageDraftRevisions} r where r.message_id = ${messages.id}
      and r.organization_id = ${messages.organizationId} and r.source in ('initial', 'redraft', 'variant_swap') and r.model is not null and r.model <> ${OWNER_AUTHORED_MODEL}
    ))`,
    sql`((${messages.model} = ${OWNER_AUTHORED_MODEL} and ${messages.draftFitDistance} is not null
      and coalesce(${messages.finalText}, ${messages.proposedText}) = ${messages.proposedText}) or exists (
      select 1 from ${feedback} f where f.message_id = ${messages.id} and f.organization_id = ${messages.organizationId}
      and f.verdict in ('approve', 'edit') and f.decision_origin in ('dashboard', 'mcp_app')
      and f.final_text_hash = encode(sha256(convert_to(coalesce(${messages.finalText}, ${messages.proposedText}), 'UTF8')), 'hex')
    ))`,
  )).orderBy(desc(messages.postedAt), desc(messages.id)).limit(OFFER_AFTER_APPROVED);
  if (approved.length < OFFER_AFTER_APPROVED) return null;
  const edited = approved.filter((row) => Math.max(row.fit ?? 0, normalizedEditDistance(row.final ?? row.proposed, row.proposed)) > FEW_EDITS.maxDistance).length;
  if (edited / approved.length > FEW_EDITS.maxEditedShare) return null;

  const automatic = { ...strategy.document, action_bindings: (strategy.document.action_bindings ?? []).map((binding) =>
    binding.action_binding_id === action.action_binding_id ? { ...binding, mode: "auto" as const } : binding) };
  const resolved = previewModes({ campaign: automatic, accountDefault: strategy.accountDefault?.document ?? null,
    network: strategy.network, connector: strategy.connector, liveChecks: strategy.liveChecks, now })
    .find((item) => item.action_binding_id === action.action_binding_id);
  return { campaignId, version: strategy.version.version, stepId: action.step_id, bindingId: action.action_binding_id,
    label: action.label, approved: approved.length, edited, held: resolved?.effective === "auto" ? null : describeAction(resolved) };
}

/** Settled O-2 says once: answering this advice remembers the action forever.
 * This never limits the owner's ordinary Strategy controls. */
export async function dismissAutomaticOffer(tx: Tx, campaignId: number, approved: number, now = Date.now()): Promise<void> {
  await tx.update(campaigns).set({ automaticOfferDismissed: sql`coalesce(${campaigns.automaticOfferDismissed}, '{}'::jsonb) || ${JSON.stringify({ [ACTION]: { at: now, approved } })}::jsonb` })
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
}

export function automaticOfferPatch(offer: AutomaticOffer): StrategyPatch {
  const instruction = `Switch ${offer.label} to Automatic after reviewing the advice`;
  const path = `/action_bindings/${offer.bindingId}/mode`;
  return { kind: "strategy.patch", campaignId: offer.campaignId, expectedBaseVersion: offer.version,
    ops: [{ op: "add", path, value: "auto" }], dependencyVersions: { voice: null, knowledge: null, memory: null },
    provenance: { instruction, recognizedIntent: { summary: instruction, paths: [path] }, scope: { stepId: offer.stepId }, compilerVersion: "automatic-offer/1" } };
}
