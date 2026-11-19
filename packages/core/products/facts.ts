import { and, eq, ne, sql } from "drizzle-orm";
import {
  productFacts,
  products,
  type ProductFacet,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { sha256 } from "../ai/prompts";
import { PRODUCT_FACETS } from "./facets";

/** The six facets, re-exported so the callers that already read them from
 *  here keep working; the list itself lives in a module a browser bundle can
 *  follow (see `facets.ts`). */
export { PRODUCT_FACETS } from "./facets";

export type ProductFactSource =
  | "obsidian"
  | "interview"
  | "manual"
  | "linkedin"
  | "web";

export type StoreProductFactInput = {
  productId: number;
  facet: ProductFacet;
  content: string;
  source: ProductFactSource;
  sourcePath?: string;
};

/**
 * Store one product fact for the current org. Mirrors storeKnowledge: dedupes on
 * (org, contentHash) so re-ingestion is idempotent, and recomputes the product's
 * fill score. Returns true if a new row was inserted.
 */
export async function storeProductFact(
  tx: Tx,
  input: StoreProductFactInput,
): Promise<boolean> {
  const content = input.content.trim();
  if (!content) return false;
  const contentHash = sha256(content);

  const inserted = await tx
    .insert(productFacts)
    .values({
      productId: input.productId,
      facet: input.facet,
      content,
      source: input.source,
      sourcePath: input.sourcePath ?? null,
      contentHash,
    })
    .onConflictDoNothing()
    .returning({ id: productFacts.id });

  if (inserted.length > 0) await recomputeFillScore(tx, input.productId);
  return inserted.length > 0;
}

export type UpdateProductFactInput = {
  facet?: ProductFacet;
  content?: string;
};

/**
 * Recompute a product's fill score = fraction of the 6 facets with ≥1 fact.
 * Called after every fact mutation so the meter stays in sync. RLS scopes both
 * queries to the current org.
 */
export async function recomputeFillScore(
  tx: Tx,
  productId: number,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${productFacts.facet})::int` })
    .from(productFacts)
    .where(eq(productFacts.productId, productId));
  const score = (row?.n ?? 0) / PRODUCT_FACETS.length;
  await tx
    .update(products)
    .set({
      fillScore: score,
      // Every fact mutation changes the inputs to campaign suggestion. Keep
      // invalidation in the shared layer so dashboard and MCP edits agree.
      campaignSuggestion: null,
      updatedAt: Date.now(),
    })
    .where(eq(products.id, productId));
  return score;
}

export type UpdateProductFactResult =
  | { status: "updated"; factId: number; productId: number }
  | { status: "missing" }
  | { status: "conflict"; productId: number };

/** Edit one product fact. Re-hashes on content change and collapses onto an existing (org, hash) row by
 *  dropping this one. */
export async function updateProductFact(
  tx: Tx,
  id: number,
  input: UpdateProductFactInput,
): Promise<UpdateProductFactResult> {
  const [existing] = await tx
    .select({ productId: productFacts.productId })
    .from(productFacts)
    .where(eq(productFacts.id, id));
  if (!existing) return { status: "missing" };
  // Product ingest replaces web facts under a product-row lock. Take locks in
  // the same product -> fact order so a user edit cannot deadlock a recrawl.
  await tx
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, existing.productId))
    .for("update");
  // The row may have been replaced by a recrawl while we waited for the
  // product lock. Never claim success against a vanished/stale fact.
  const [currentFact] = await tx
    .select({ productId: productFacts.productId })
    .from(productFacts)
    .where(eq(productFacts.id, id));
  if (!currentFact || currentFact.productId !== existing.productId) {
    return { status: "missing" };
  }

  const set: Partial<typeof productFacts.$inferInsert> = {};
  if (input.facet !== undefined) set.facet = input.facet;
  if (input.facet !== undefined || input.content !== undefined) {
    // Once a person corrects a crawled fact, it is durable manual knowledge and
    // must survive later website refreshes.
    set.source = "manual";
  }

  if (input.content !== undefined) {
    const content = input.content.trim();
    if (!content) return { status: "conflict", productId: existing.productId };
    const contentHash = sha256(content);
    const dupe = await tx
      .select({ id: productFacts.id, productId: productFacts.productId })
      .from(productFacts)
      .where(
        and(eq(productFacts.contentHash, contentHash), ne(productFacts.id, id)),
      );
    if (dupe.length > 0) {
      const replacement = dupe[0]!;
      // Content is globally deduped. Collapse only within this product, where
      // the human correction can safely promote the surviving row to manual.
      // A duplicate owned by another product leaves this fact unchanged.
      if (replacement.productId !== existing.productId) {
        return { status: "conflict", productId: existing.productId };
      }
      await tx
        .update(productFacts)
        .set({
          source: "manual",
          ...(input.facet !== undefined ? { facet: input.facet } : {}),
          updatedAt: Date.now(),
        })
        .where(eq(productFacts.id, replacement.id));
      await tx.delete(productFacts).where(eq(productFacts.id, id));
      await recomputeFillScore(tx, existing.productId);
      return {
        status: "updated",
        factId: replacement.id,
        productId: existing.productId,
      };
    }
    set.content = content;
    set.contentHash = contentHash;
  }

  if (Object.keys(set).length === 0) {
    return { status: "updated", factId: id, productId: existing.productId };
  }
  set.updatedAt = Date.now();
  await tx.update(productFacts).set(set).where(eq(productFacts.id, id));
  await recomputeFillScore(tx, existing.productId);
  return { status: "updated", factId: id, productId: existing.productId };
}

/** Delete one product fact and recompute its product's fill score. */
export async function deleteProductFact(tx: Tx, id: number): Promise<void> {
  const [existing] = await tx
    .select({ productId: productFacts.productId })
    .from(productFacts)
    .where(eq(productFacts.id, id));
  if (!existing) return;
  await tx
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, existing.productId))
    .for("update");
  await tx.delete(productFacts).where(eq(productFacts.id, id));
  await recomputeFillScore(tx, existing.productId);
}
