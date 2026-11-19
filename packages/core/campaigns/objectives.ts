import type { CampaignObjective } from "@engager/database/schema";
import { CAMPAIGN_CREATE_DEFAULTS } from "./defaults";

/**
 * One source of truth for campaign objectives — imported by both the writer
 * (behavior) and the UI (picker + list). The campaign owns commenting preferences; it
 * drives how often the writer may mention a product and whether a CTA is allowed.
 */
export type ObjectiveMeta = {
  id: CampaignObjective;
  label: string;
  /** Lucide icon name (resolved by the UI). */
  icon: string;
  /** Short qualifier shown on the picker card. */
  tag: string;
  description: string;
  /** Promo share the objective targets when products are in play (0..1). */
  defaultPromoRatio: number;
  /** Whether this objective may EVER reference a product. */
  allowsProductMention: boolean;
  /** Whether a (soft, relevant) call-to-action is permitted. */
  allowsCta: boolean;
  /**
   * Whether this objective is currently selectable in the UI. Disabled objectives
   * stay fully defined (the writer + scoring still resolve them, so existing
   * campaigns keep working) but can't be picked for new campaigns yet.
   */
  available: boolean;
};

// Copy is final — taken verbatim from the prototype's OBJECTIVES.
export const OBJECTIVES: ObjectiveMeta[] = [
  {
    id: "engage",
    label: "Start useful conversations",
    icon: "MessageCircle",
    tag: "default",
    description: "Make a useful contribution to the author's actual point and leave room for a natural conversation.",
    defaultPromoRatio: 0,
    allowsProductMention: false,
    allowsCta: false,
    available: true,
  },
  {
    id: "visibility",
    label: "Visibility",
    icon: "Eye",
    tag: "no selling",
    description:
      "Show up consistently in your niche. Engagement is the goal itself — pure value, no ask.",
    defaultPromoRatio: 0,
    allowsProductMention: false,
    allowsCta: false,
    available: true,
  },
  {
    id: "audience",
    label: "Audience growth",
    icon: "UserPlus",
    tag: "rare mention",
    description:
      "Earn relevant followers and connections by being genuinely useful to the right people.",
    defaultPromoRatio: 0.05,
    allowsProductMention: true,
    allowsCta: false,
    available: true,
  },
  {
    id: "nurture",
    label: "Relationship nurture",
    icon: "Handshake",
    tag: "ABM",
    description:
      "Warm specific people and accounts over time. Familiar, not salesy — plays the long game.",
    defaultPromoRatio: 0.05,
    allowsProductMention: true,
    allowsCta: false,
    available: true,
  },
  {
    id: "thought",
    label: "Thought leadership",
    icon: "Lightbulb",
    tag: "POV",
    description: "Advance a point of view and build authority on the topics you own.",
    defaultPromoRatio: 0,
    allowsProductMention: false,
    allowsCta: false,
    available: true,
  },
  {
    id: "product",
    label: "Product promotion",
    icon: "Megaphone",
    tag: "woven in",
    description:
      "Drive interest in a product — woven in only where it genuinely fits the conversation.",
    defaultPromoRatio: 0.3,
    allowsProductMention: true,
    allowsCta: true,
    available: true,
  },
];

export const OBJECTIVE_BY_ID: Record<CampaignObjective, ObjectiveMeta> = Object.fromEntries(
  OBJECTIVES.map((o) => [o.id, o]),
) as Record<CampaignObjective, ObjectiveMeta>;

/** A campaign with no stored goal reads as the one a new campaign is created with,
 *  by NAME. It used to be `OBJECTIVES[0]`, which is the picker's first row — a
 *  list whose order is copy, not policy, and prepending a goal to it silently
 *  moved every unset target onto the new one. */
export function objectiveMeta(objective: CampaignObjective | null | undefined): ObjectiveMeta {
  return (
    (objective && OBJECTIVE_BY_ID[objective]) ||
    OBJECTIVE_BY_ID[CAMPAIGN_CREATE_DEFAULTS.objective]
  );
}

/** Public creation/transition availability shared by non-UI policy surfaces. */
export function isPublicObjectiveAvailable(
  objective: CampaignObjective | null | undefined,
): boolean {
  return objective != null && OBJECTIVE_BY_ID[objective]?.available === true;
}

/**
 * Whether the writer may reference a product at all for this campaign:
 * - `product` objective: always.
 * - `audience` / `nurture`: only when a product is actually attached (rare, low).
 * - `engage` / `visibility` / `thought`: never, regardless of attachments.
 */
export function mayMentionProduct(
  objective: CampaignObjective | null | undefined,
  hasAttachedProducts: boolean,
): boolean {
  const meta = objectiveMeta(objective);
  if (!meta.allowsProductMention) return false;
  if (meta.id === "product") return true;
  return hasAttachedProducts;
}

/** Whether a soft CTA is allowed (product objective only). */
export function mayUseCta(objective: CampaignObjective | null | undefined): boolean {
  return objectiveMeta(objective).allowsCta;
}

/**
 * Effective promo share for the next comment. The objective sets the ceiling.
 * Override semantics: `null`/unset = "use the objective's default"; an EXPLICIT
 * number — including 0 — is honored (clamped to [0,1], and never above a
 * non-product objective's small default). The old `override > 0` guard made a
 * stored 0 silently mean 30%, so a user could not run a no-promotion product
 * campaign; the migration strips those legacy zeros to null.
 */
export function effectivePromoRatio(
  objective: CampaignObjective | null | undefined,
  tonePromoRatio: number | null | undefined,
): number {
  const meta = objectiveMeta(objective);
  if (!meta.allowsProductMention) return 0;
  const override = typeof tonePromoRatio === "number" ? tonePromoRatio : null;
  if (override === null) return meta.defaultPromoRatio;
  const clamped = Math.min(1, Math.max(0, override));
  if (meta.id === "product") return clamped;
  // audience / nurture: keep it low — never above the objective's small default.
  return Math.min(clamped, meta.defaultPromoRatio);
}
