import { eq } from "drizzle-orm";
import { leads, type ScoutIntent } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { authorIdentity } from "../people/key";

/**
 * THE INTENT GATE — how much a lead-mode draft may say about the product,
 * decided by what the person's own words show (`leads.intent`) rather than by
 * a campaign's Goal. The one place intent decides product, call to action and
 * framing.
 *
 * It decides what a draft may SAY, never whose it is: an untouched agent
 * draft stays worker and capped however its gate reads.
 */
export type IntentGate = {
  /** The intent it was read for. No intent recorded reads Topic only. */
  intent: ScoutIntent;
  /** A product may come up. */
  canMentionProduct: boolean;
  /** One small next step may come up. */
  allowCta: boolean;
  /** What the draft does, where a Find posts campaign's Goal described what
   *  its drafts are for. */
  framing: string;
};

/** Each intent's ceiling, before the attached products decide whether there
 *  is anything to mention. */
export const INTENT_POLICY: Readonly<
  Record<ScoutIntent, { product: boolean; cta: boolean; framing: string }>
> = {
  topic_only: { product: false, cta: false, framing: "Join the topic with no pitch." },
  has_problem: { product: true, cta: false, framing: "Offer an observation on what they said." },
  asking: { product: true, cta: true, framing: "Answer only what they asked." },
};

/** What a lead-mode draft to someone of this intent may carry. A product, and
 *  an Asking lead's one small next step, come up only when one is attached.
 *  Pure. */
export function intentGate(intent: ScoutIntent | null | undefined, hasProducts: boolean): IntentGate {
  const read = intent ?? "topic_only";
  const policy = INTENT_POLICY[read];
  return {
    intent: read,
    canMentionProduct: policy.product && hasProducts,
    allowCta: policy.cta && hasProducts,
    framing: policy.framing,
  };
}

/** The products a writer is shown: every one attached, except under a gate
 *  that lets none come up — so a Topic only draft has no product to name. A
 *  null gate is a Find posts campaign's, which shows them all. */
export function productsWithin<T>(gate: IntentGate | null, products: readonly T[]): T[] {
  return gate && !gate.canMentionProduct ? [] : [...products];
}

/** The person's intent at draft time, so a lead whose intent ratchets up
 *  drafts under the new gate next time. Null for someone with no lead row,
 *  who reads Topic only. A lead keeps the id as LinkedIn spells it; finding
 *  one reads the id as an identity, as Find leads' merge does, so a profile
 *  URL and its slug are one person and the case is ignored. */
export async function leadIntent(tx: Tx, profileId: string | null | undefined): Promise<ScoutIntent | null> {
  if (!profileId) return null;
  const [row] = await tx
    .select({ intent: leads.intent })
    .from(leads)
    .where(eq(leads.profileId, authorIdentity(profileId)))
    .limit(1);
  return row?.intent ?? null;
}

/** The gate a campaign's draft to this person is held to. */
export async function draftIntentGate(
  tx: Tx,
  profileId: string | null | undefined,
  hasProducts: boolean,
): Promise<IntentGate> {
  return intentGate(await leadIntent(tx, profileId), hasProducts);
}
