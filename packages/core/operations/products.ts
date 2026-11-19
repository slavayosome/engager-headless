import { and, eq, inArray, sql } from "drizzle-orm";
import {
  brainQuestions,
  campaignProducts,
  campaigns,
  productFacts,
  products,
  type Product,
  type ProductFacet,
  type ProductStatus,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { deleteProductFact, storeProductFact, updateProductFact } from "../products/facts";
import { campaignsForProduct } from "../products/queries";
import { CampaignProductRequiredError } from "./campaigns";
import { OneProductError } from "../campaigns/oneEach";
import { AppError } from "@engager/common/errors";

export type ProductInput = {
  name?: string;
  oneLiner?: string | null;
  link?: string | null;
  status?: ProductStatus;
  source?: Product["source"];
};

/** Create a product in the current org scope. Returns its id. */
export async function createProduct(
  tx: Tx,
  input: ProductInput,
): Promise<number> {
  const [row] = await tx
    .insert(products)
    .values({
      name: input.name?.trim() || "Untitled product",
      oneLiner: input.oneLiner?.trim() || null,
      link: input.link?.trim() || null,
      status: input.status ?? "idea",
      source: input.source ?? "manual",
    })
    .returning({ id: products.id });
  return row!.id;
}

/** Patch a product's scalar fields (RLS scopes to the current org). */
export async function updateProduct(
  tx: Tx,
  id: number,
  input: ProductInput,
): Promise<void> {
  const changesSuggestionInputs =
    input.name !== undefined ||
    input.oneLiner !== undefined ||
    input.link !== undefined;
  const [current] = changesSuggestionInputs
    ? await tx
        .select({
          name: products.name,
          oneLiner: products.oneLiner,
          link: products.link,
          ingestRevision: products.ingestRevision,
        })
        .from(products)
        .where(eq(products.id, id))
        .for("update")
    : [];
  const patch: Partial<typeof products.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (input.name !== undefined) {
    const name = input.name.trim() || "Untitled product";
    patch.name = name;
    if (current && current.name !== name) patch.campaignSuggestion = null;
  }
  if (input.oneLiner !== undefined) {
    const oneLiner = input.oneLiner?.trim() || null;
    patch.oneLiner = oneLiner;
    if (current && current.oneLiner !== oneLiner)
      patch.campaignSuggestion = null;
  }
  if (input.link !== undefined) {
    const link = input.link?.trim() || null;
    patch.link = link;
    if (current && current.link !== link) {
      patch.ingestRevision = current.ingestRevision + 1;
      patch.ingestStage = null;
      patch.ingestErrorCode = null;
      patch.campaignSuggestion = null;
    }
  }
  if (input.status !== undefined) patch.status = input.status;
  await tx.update(products).set(patch).where(eq(products.id, id));
}

/** Serialize product-link invariants with the same per-org transaction lock as
 * campaign mutations. Agent clients commonly issue tool calls in parallel; a
 * read-then-remove check without this lock lets two removals each observe two
 * links and jointly leave a Product campaign with none. */
async function lockProductLinkPolicy(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(coalesce(current_setting('app.current_org', true), '')))`,
  );
}

export async function deleteProduct(tx: Tx, id: number): Promise<void> {
  await lockProductLinkPolicy(tx);
  await tx.delete(products).where(eq(products.id, id));
}

export async function attachProductToCampaign(
  tx: Tx,
  campaignId: number,
  productId: number,
): Promise<void> {
  const [campaign] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId));
  const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId));
  if (!campaign || !product) throw new AppError("not_found", "Campaign or product not found.", 404);
  await lockProductLinkPolicy(tx);
  const attached = await tx
    .select({ productId: campaignProducts.productId })
    .from(campaignProducts)
    .where(eq(campaignProducts.campaignId, campaignId));
  if (attached.some((row) => row.productId === productId)) return;
  if (attached.length > 0) throw new OneProductError();
  await tx.insert(campaignProducts).values({ campaignId, productId });
}

export async function detachProductFromCampaign(
  tx: Tx,
  campaignId: number,
  productId: number,
): Promise<void> {
  await lockProductLinkPolicy(tx);
  const existing = await tx
    .select({ productId: campaignProducts.productId })
    .from(campaignProducts)
    .where(eq(campaignProducts.campaignId, campaignId));
  await setCampaignProductsUnlocked(
    tx,
    campaignId,
    existing.map((row) => row.productId).filter((id) => id !== productId),
  );
}

/**
 * Reconcile which campaigns see one product. Attaching and detaching one at a
 * time rather than through `setCampaignProducts`, because that call reconciles
 * a CAMPAIGN's products: this is the other axis, and using it would silently
 * detach the other products of every campaign touched. A campaign that needs
 * its last product refuses, named.
 */
export async function setProductCampaigns(tx: Tx, productId: number, campaignIds: readonly number[]): Promise<void> {
  const current = await campaignsForProduct(tx, productId);
  const want = new Set(campaignIds);
  const have = new Set(current.map((row) => row.id));
  for (const campaignId of want) if (!have.has(campaignId)) await attachProductToCampaign(tx, campaignId, productId);
  for (const row of current) {
    if (want.has(row.id)) continue;
    try {
      await detachProductFromCampaign(tx, row.id, productId);
    } catch (error) {
      if (error instanceof CampaignProductRequiredError)
        throw new CampaignProductRequiredError(
          `${row.name} has to keep at least one product. Tick another one under Products on its Settings before taking this folder off it.`,
          error.recovery,
        );
      throw error;
    }
  }
}

/**
 * Reconcile a campaign's attached products to exactly `productIds` — used when the
 * campaign editor saves (attach toggles posted as form state). Inserts the new,
 * removes the dropped, leaves the rest.
 */
export async function setCampaignProducts(
  tx: Tx,
  campaignId: number,
  productIds: number[],
): Promise<boolean> {
  await lockProductLinkPolicy(tx);
  return setCampaignProductsUnlocked(tx, campaignId, productIds);
}

/** Caller holds lockProductLinkPolicy. Kept separate so detach can compute and
 * apply its desired set under one lock without recursively acquiring it. Says
 * whether it moved. */
async function setCampaignProductsUnlocked(
  tx: Tx,
  campaignId: number,
  productIds: readonly number[],
): Promise<boolean> {
  const existing = await tx
    .select({ productId: campaignProducts.productId })
    .from(campaignProducts)
    .where(eq(campaignProducts.campaignId, campaignId));
  const have = new Set(existing.map((r) => r.productId));
  const want = new Set(productIds);

  const toAdd = [...want].filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !want.has(id));
  // An older campaign keeps the several it has until the owner picks one; it
  // gains none beside them.
  if (want.size > 1 && toAdd.length > 0) throw new OneProductError();

  if (toAdd.length > 0) {
    await tx
      .insert(campaignProducts)
      .values(toAdd.map((productId) => ({ campaignId, productId })))
      .onConflictDoNothing();
  }
  if (toRemove.length > 0) {
    await tx
      .delete(campaignProducts)
      .where(
        and(
          eq(campaignProducts.campaignId, campaignId),
          inArray(campaignProducts.productId, toRemove),
        ),
      );
  }
  return toAdd.length > 0 || toRemove.length > 0;
}

export type ProductFactOp = { op: "add" | "update" | "delete"; id?: number; facet?: ProductFacet; content?: string };

/** Apply fact ops to one product, one result per op: an op naming a fact that
 *  is not this product's fails alone and the others land. */
export async function applyProductFactOps(tx: Tx, productId: number, ops: readonly ProductFactOp[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const fact of ops) {
    if (fact.op === "add") {
      if (!fact.facet || !fact.content) { results.push({ op: fact.op, error: "facet and content required" }); continue; }
      results.push({ op: fact.op, added: await storeProductFact(tx, { productId, facet: fact.facet, content: fact.content, source: "manual" }) });
      continue;
    }
    const [found] = fact.id ? await tx.select({ id: productFacts.id }).from(productFacts).where(and(eq(productFacts.id, fact.id), eq(productFacts.productId, productId))) : [];
    if (!found) { results.push({ op: fact.op, id: fact.id, error: "fact not found" }); continue; }
    if (fact.op === "delete") { await deleteProductFact(tx, found.id); results.push({ op: fact.op, id: found.id, deleted: true }); }
    else results.push({ op: fact.op, id: found.id, result: await updateProductFact(tx, found.id, { facet: fact.facet, content: fact.content }) });
  }
  return results;
}

/** Answer a question only if it belongs to this product. */
export async function answerQuestionOnProduct(tx: Tx, productId: number, questionId: number, answer: string): Promise<{ ok: boolean }> {
  const [question] = await tx.select({ id: brainQuestions.id }).from(brainQuestions).where(and(eq(brainQuestions.id, questionId), eq(brainQuestions.productId, productId)));
  return question ? answerProductQuestion(tx, questionId, answer) : { ok: false };
}

/**
 * Answer a product-scoped "sharpen" question: persist the answer as a product_fact
 * in the question's facet, then mark the question answered. No-op if the question
 * isn't product-scoped or is already answered.
 */
export async function answerProductQuestion(
  tx: Tx,
  questionId: number,
  answer: string,
): Promise<{ ok: boolean }> {
  const text = answer.trim();
  const [q] = await tx
    .select({
      productId: brainQuestions.productId,
      facet: brainQuestions.productFacet,
      status: brainQuestions.status,
    })
    .from(brainQuestions)
    .where(eq(brainQuestions.id, questionId));
  if (
    !q ||
    q.status !== "pending" ||
    q.productId === null ||
    q.facet === null
  ) {
    return { ok: false };
  }
  if (text) {
    await storeProductFact(tx, {
      productId: q.productId,
      facet: q.facet,
      content: text,
      source: "interview",
    });
  }
  await tx
    .update(brainQuestions)
    .set({ status: "answered", answer: text || null, answeredAt: Date.now() })
    .where(eq(brainQuestions.id, questionId));
  return { ok: true };
}
