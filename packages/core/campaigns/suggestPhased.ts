import { eq } from "drizzle-orm";
import {
  products,
  type ProductCampaignSuggestion,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import {
  currentKnowledgeVersion,
  listKnowledge,
} from "../brain/knowledge";
import { getProduct } from "../products/queries";
import { suggestCampaignSetup } from "./suggest";

export type CampaignSuggestionOrgScope = <T>(
  work: (tx: Tx) => Promise<T>,
) => Promise<T>;

/**
 * Snapshot product + Brain in a short scope, run the model detached, then cache
 * only if both revisions are still current. A user edit always wins over stale
 * targeting prepared from an older product or Brain.
 */
export async function suggestCampaignForProductPhased(
  orgScope: CampaignSuggestionOrgScope,
  input: {
    organizationId: string;
    productId: number;
    llm?: LLM;
    beforeExternalPhase: () => Promise<void>;
    beforeApplyPhase: () => Promise<void>;
  },
): Promise<ProductCampaignSuggestion | null> {
  const snap = await orgScope(async (tx) => {
    const product = await getProduct(tx, input.productId);
    return {
      product,
      knowledge: await listKnowledge(tx),
      knowledgeVersion: await currentKnowledgeVersion(tx),
    };
  });
  if (snap.product?.product.campaignSuggestion) {
    return snap.product.product.campaignSuggestion;
  }
  if (!snap.product) return null;
  const product = snap.product;

  await input.beforeExternalPhase();
  const suggestion = await suggestCampaignSetup({
    organizationId: input.organizationId,
    product,
    knowledge: snap.knowledge,
    llm: input.llm,
  });
  if (!suggestion) return null;

  await input.beforeApplyPhase();
  return orgScope(async (tx) => {
    const [current] = await tx
      .select({
        updatedAt: products.updatedAt,
        campaignSuggestion: products.campaignSuggestion,
      })
      .from(products)
      .where(eq(products.id, input.productId))
      .for("update");
    if (!current) return null;
    if (current.campaignSuggestion) return current.campaignSuggestion;
    if (
      current.updatedAt !== product.product.updatedAt ||
      (await currentKnowledgeVersion(tx)) !== snap.knowledgeVersion
    ) {
      return null;
    }
    await tx
      .update(products)
      .set({ campaignSuggestion: suggestion })
      .where(eq(products.id, input.productId));
    return suggestion;
  });
}
