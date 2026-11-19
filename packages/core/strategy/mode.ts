import { eq } from "drizzle-orm";
import { campaigns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { loadStrategy } from "../agentStep/select";
import type { CapabilityId, CatalogStepId, TargetType } from "./catalog";
import { resolveStrategy, type ResolvedAction } from "./resolve";
import type { OwnPostReplies } from "../operations/orgSettings";
import { handleReplyStep } from "./seed";
import type { ActionMode } from "./catalog";
import type { ResolveReason, ResolvedFrom } from "./resolve";

type ModeInput = { campaignId: number; capability?: CapabilityId; target?: TargetType; actionBindingId?: string; stepId?: string; catalogStep?: CatalogStepId; now?: number };
type OwnPostMode = { effective: ActionMode; reason: ResolveReason | null; resolvedFrom: ResolvedFrom; scope: "account" | "campaign" };

/** What a lookup that names no single binding answers: Off, from the campaign,
 *  so a missing, ambiguous or unreadable binding can never grant authority. */
export type NoBinding = {
  action_binding_id: null;
  step_id: null;
  requested: "off";
  ceiling: "off";
  effective: "off";
  intent_ceilings: null;
  resolved_from: "campaign";
  reason: "no_binding";
};
export type ModeAnswer = ResolvedAction | NoBinding;

const NO_BINDING: NoBinding = {
  action_binding_id: null, step_id: null, requested: "off", ceiling: "off", effective: "off",
  intent_ceilings: null, resolved_from: "campaign", reason: "no_binding",
};

/** Every action the campaign's active strategy binds, resolved now. */
export async function liveModes(tx: Tx, campaignId: number, now?: number): Promise<ResolvedAction[]> {
  return (await liveStrategy(tx, campaignId, now))?.actions ?? [];
}

async function liveStrategy(tx: Tx, campaignId: number, now?: number) {
  const [campaign] = await tx.select({ id: campaigns.id, channelId: campaigns.channelId })
    .from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  const strategy = await loadStrategy(tx, campaign);
  if (!strategy) return null;
  const actions = resolveStrategy({
    accountDefault: strategy.accountDefault, campaign: strategy.document,
    network: strategy.network, connector: strategy.connector, liveChecks: strategy.liveChecks, now,
  });
  return { strategy, actions };
}

/** Read the active strategy and account policy at the point of use: the
 *  step's mode, lowered only where the account's numbers, hours or first
 *  sends say it cannot happen. */
export function modeFor(tx: Tx, input: ModeInput): Promise<ModeAnswer>;
export function modeFor(tx: Tx, input: { ownPost: OwnPostReplies; campaignId?: number }): Promise<OwnPostMode>;
export async function modeFor(tx: Tx, input: ModeInput | { ownPost: OwnPostReplies; campaignId?: number }): Promise<ModeAnswer | OwnPostMode> {
  if ("ownPost" in input) {
    const scope = input.campaignId === undefined ? "account" : "campaign";
    const [campaign] = input.campaignId === undefined
      ? await tx.select().from(campaigns).where(eq(campaigns.status, "active")).orderBy(campaigns.id).limit(1)
      : await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId));
    const strategy = campaign ? await loadStrategy(tx, campaign) : null;
    if (!strategy) return { effective: "off", reason: null, resolvedFrom: "campaign", scope };
    const seed = handleReplyStep(input.ownPost.mode);
    const [action] = resolveStrategy({ campaign: { ...strategy.document, steps: [seed.step], action_bindings: seed.bindings },
      accountDefault: strategy.accountDefault, network: strategy.network, connector: strategy.connector,
      liveChecks: strategy.liveChecks, now: Date.now() });
    const effective = action?.effective === "auto" || action?.effective === "review" ? action.effective : "off";
    return { effective, reason: action?.reason ?? null, resolvedFrom: action?.resolved_from ?? "campaign", scope };
  }
  const live = await liveStrategy(tx, input.campaignId, input.now);
  if (!live) return NO_BINDING;
  const { strategy, actions } = live;
  const matches = actions.filter((action) =>
    (input.actionBindingId === undefined || action.action_binding_id === input.actionBindingId) &&
    (input.stepId === undefined || action.step_id === input.stepId) &&
    (input.catalogStep === undefined || (strategy.document.steps ?? []).some((step) => step.step_id === action.step_id && step.catalog_step === input.catalogStep)) &&
    (input.capability === undefined || action.capability === input.capability) &&
    (input.target === undefined || action.target === input.target));
  // An ambiguous or missing binding cannot grant authority.
  return matches.length === 1 ? matches[0]! : NO_BINDING;
}
