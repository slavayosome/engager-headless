import { and, eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaignProducts, productFacts, products } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { sha256 } from "../ai/prompts";
import { storeProductFact } from "../products/facts";
import { campaignProductId } from "../products/queries";
import { lockRoomEvidence } from "../rooms/eligibility";
import { currentThemes, type CurrentAudienceTheme } from "./themes";

export type ThemeProductChoice = { id: number; name: string; addedThemeIds: string[] };

export class ThemeProductError extends AppError {
  constructor(message: string) { super("audience_theme_not_added", message, 409); }
}

/** The product the campaign's drafts use (`campaignProductId`), the one a
 * pushback is added to. Only an exact objection in it is an already-added
 * theme: product facts dedupe across the whole org, so another product is not
 * success. */
export async function themeProductChoices(tx: Tx, campaignId: number,
  themes: ReadonlyArray<Pick<CurrentAudienceTheme, "id" | "kind" | "text">>): Promise<ThemeProductChoice[]> {
  const objections = themes.filter((theme) => theme.kind === "objection");
  if (!objections.length) return [];
  const productId = await campaignProductId(tx, campaignId);
  if (productId === null) return [];
  const [product] = await tx.select({ id: products.id, name: products.name }).from(products).where(eq(products.id, productId));
  if (!product) return [];
  const facts = await tx.select({ hash: productFacts.contentHash }).from(productFacts)
    .where(and(eq(productFacts.productId, productId), eq(productFacts.facet, "objections")));
  return [{ ...product, addedThemeIds: objections
    .filter((theme) => facts.some((fact) => fact.hash === sha256(theme.text.trim())))
    .map((theme) => theme.id) }];
}

export async function addAudienceThemeToProduct(tx: Tx, input: {
  campaignId: number; themeId: string; rolledUpAt: number; productId: number;
}, now = Date.now()) {
  await lockRoomEvidence(tx);
  // Product -> link -> fact, matching deletion and the canonical fact editor.
  const [product] = await tx.select({ id: products.id, name: products.name }).from(products)
    .where(eq(products.id, input.productId)).for("update");
  const [attached] = await tx.select({ productId: campaignProducts.productId }).from(campaignProducts)
    .where(and(eq(campaignProducts.campaignId, input.campaignId), eq(campaignProducts.productId, input.productId))).for("share");
  const inUse = await campaignProductId(tx, input.campaignId);
  if (!product || !attached || inUse !== product.id) throw new ThemeProductError("That product is no longer the one this campaign offers.");
  const theme = (await currentThemes(tx, input.campaignId, now)).find((row) => row.id === input.themeId);
  if (!theme || theme.kind !== "objection" || theme.rolledUpAt !== input.rolledUpAt) {
    throw new ThemeProductError("The pushback or its sources changed. Reopen it before adding it.");
  }
  const changed = await storeProductFact(tx, { productId: product.id, facet: "objections", content: theme.text,
    source: "manual", sourcePath: `campaign/${input.campaignId}/theme/${theme.id}` });
  const [fact] = await tx.select({ id: productFacts.id }).from(productFacts).where(and(
    eq(productFacts.productId, product.id), eq(productFacts.facet, "objections"), eq(productFacts.contentHash, sha256(theme.text.trim())),
  ));
  if (!fact) throw new ThemeProductError("That text is already saved elsewhere in Products. Open Brain to review it.");
  return { productId: product.id, productName: product.name, factId: fact.id, changed };
}
