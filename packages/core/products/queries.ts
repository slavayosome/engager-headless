import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  brainQuestions,
  campaignProducts,
  campaigns,
  productFacts,
  products,
  type Product,
  type ProductFacet,
  type ProductFact,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { ProductContext } from "../ai/writer";
import { readOffer, type OfferView } from "./offers";
import { productInUse } from "../campaigns/oneEach";

/** Facets the writer leans on first when weaving a product in. */
const FACET_PRIORITY: ProductFacet[] = [
  "value",
  "proof",
  "objections",
  "what",
  "audience",
  "links",
];

export type ProductContextOptions = {
  maxFactsPerProduct?: number;
  /** Keeps only the facts a caller may claim — an agent step's drafter
   *  drops the stale ones before the slice is taken. */
  factFilter?: (fact: ProductFact) => boolean;
};

/** One attached product as a writer is handed it, with the rows its facts
 *  were read from — what an action written from it is bound to. */
export type CampaignProduct = ProductContext & {
  factRows: Pick<ProductFact, "id" | "contentHash">[];
};

/**
 * Load the product a campaign's drafts use (`campaignProductId`) with a
 * bounded, prioritized slice of its facts — what the writer weaves in
 * (Spec 02). Returns `[]` when nothing is attached.
 */
export async function loadCampaignProductContext(
  tx: Tx,
  campaignId: number,
  opts: ProductContextOptions = {},
): Promise<ProductContext[]> {
  return (await loadCampaignProducts(tx, campaignId, opts)).map(
    ({ name, oneLiner, link, facts }) => ({ name, oneLiner, link, facts }),
  );
}

/** `loadCampaignProductContext`, each product carrying the fact rows its slice
 *  came from. */
export async function loadCampaignProducts(
  tx: Tx,
  campaignId: number,
  opts: ProductContextOptions = {},
): Promise<CampaignProduct[]> {
  const productId = await campaignProductId(tx, campaignId);
  if (productId === null) return [];

  const ids = [productId];
  const prods = await tx
    .select()
    .from(products)
    .where(inArray(products.id, ids))
    .orderBy(asc(products.id));
  // Deterministic order (facet, then id): the facet sort + slice below — and the
  // compiled-brief sourceHash that hashes this exact facts slice — must be stable
  // across calls, or an unchanged product spuriously recompiles its brief.
  const facts = await tx
    .select()
    .from(productFacts)
    .where(inArray(productFacts.productId, ids))
    .orderBy(asc(productFacts.facet), asc(productFacts.id));

  // Default 2 (was 5): both call sites — the writer path (draft.ts) and the brief
  // compiler (compile.ts) — use this default, so they stay fact-coherent (the brief's
  // factsDigest hashes the SAME slice the writer sees). A smaller slice shrinks the
  // promo-mode catalogue dump; the writer only ever weaves in one fact anyway.
  const maxFacts = opts.maxFactsPerProduct ?? 2;
  return prods.map((p) => {
    const own = facts
      .filter((f) => f.productId === p.id && (opts.factFilter?.(f) ?? true))
      .sort((a, b) => FACET_PRIORITY.indexOf(a.facet) - FACET_PRIORITY.indexOf(b.facet))
      .slice(0, maxFacts);
    return {
      name: p.name,
      oneLiner: p.oneLiner,
      link: p.link,
      facts: own.map((f) => f.content),
      factRows: own.map(({ id, contentHash }) => ({ id, contentHash })),
    };
  });
}

export type ProductListItem = Product & { factCount: number; attachedCount: number };

/** All products for the current org with fact + attach counts (for the list). */
export async function listProducts(tx: Tx): Promise<ProductListItem[]> {
  // Stable tiebreaker: with only updatedAt, two products touched in the same tick (or a
  // background ingest bumping updatedAt between reads) can reorder, so `products[0]` — the
  // onboarding prefill vs. the hashtag suggestion — could resolve to DIFFERENT products.
  const rows = await tx
    .select()
    .from(products)
    .orderBy(desc(products.updatedAt), desc(products.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const factCounts = await tx
    .select({ productId: productFacts.productId, n: sql<number>`count(*)::int` })
    .from(productFacts)
    .where(inArray(productFacts.productId, ids))
    .groupBy(productFacts.productId);
  const attachCounts = await tx
    .select({ productId: campaignProducts.productId, n: sql<number>`count(*)::int` })
    .from(campaignProducts)
    .where(inArray(campaignProducts.productId, ids))
    .groupBy(campaignProducts.productId);

  const facts = new Map(factCounts.map((r) => [r.productId, r.n]));
  const attached = new Map(attachCounts.map((r) => [r.productId, r.n]));
  return rows.map((p) => ({
    ...p,
    factCount: facts.get(p.id) ?? 0,
    attachedCount: attached.get(p.id) ?? 0,
  }));
}

export type ProductQuestion = { id: number; facet: ProductFacet; question: string };

export type ProductDetail = {
  product: Product;
  attachedCount: number;
  /** Facts grouped by facet, in canonical order (empty facets omitted by the UI). */
  factsByFacet: { facet: ProductFacet; items: ProductFact[] }[];
  pending: ProductQuestion[];
  /** What it offers, as an offer DM may make it, and whether the owner has
   *  approved those words (`products/offers.ts`); null for none. */
  offer: OfferView | null;
};

const FACET_ORDER: ProductFacet[] = ["what", "audience", "value", "proof", "objections", "links"];

/** One product with its facts grouped by facet and its pending "sharpen" questions. */
export async function getProduct(tx: Tx, id: number): Promise<ProductDetail | null> {
  const [product] = await tx.select().from(products).where(eq(products.id, id));
  if (!product) return null;

  const facts = await tx
    .select()
    .from(productFacts)
    .where(eq(productFacts.productId, id))
    .orderBy(asc(productFacts.facet), desc(productFacts.createdAt));

  const [{ n: attachedCount } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignProducts)
    .where(eq(campaignProducts.productId, id));

  const pendingRows = await tx
    .select({ id: brainQuestions.id, facet: brainQuestions.productFacet, question: brainQuestions.question })
    .from(brainQuestions)
    .where(and(eq(brainQuestions.productId, id), eq(brainQuestions.status, "pending")))
    .orderBy(desc(brainQuestions.createdAt));

  const factsByFacet = FACET_ORDER.map((facet) => ({
    facet,
    items: facts.filter((f) => f.facet === facet),
  })).filter((g) => g.items.length > 0);

  const pending: ProductQuestion[] = pendingRows
    .filter((q): q is { id: number; facet: ProductFacet; question: string } => q.facet !== null)
    .map((q) => ({ id: q.id, facet: q.facet, question: q.question }));

  return { product, attachedCount, factsByFacet, pending, offer: await readOffer(tx, id) };
}

/** The campaigns a product is attached to, named — what the folder page's "Used
 *  by" row lists and what its Change picker starts from. `attachedCount` says
 *  how many; this says which. */
export async function campaignsForProduct(
  tx: Tx,
  productId: number,
): Promise<{ id: number; name: string }[]> {
  return tx
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaignProducts)
    .innerJoin(campaigns, eq(campaigns.id, campaignProducts.campaignId))
    .where(eq(campaignProducts.productId, productId))
    .orderBy(asc(campaigns.name));
}

/** Find an existing product by case-insensitive name (for create-dedupe). */
export async function findProductIdByName(tx: Tx, name: string): Promise<number | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const rows = await tx.select({ id: products.id, name: products.name }).from(products);
  return rows.find((p) => p.name.trim().toLowerCase() === key)?.id ?? null;
}

/** The org's products by name — what a campaign's Products choice offers —
 *  each with how many facts its Brain folder holds. */
export async function productChoices(tx: Tx): Promise<{ id: number; name: string; facts: number }[]> {
  return tx
    .select({ id: products.id, name: products.name, facts: sql<number>`count(${productFacts.id})::int` })
    .from(products)
    .leftJoin(productFacts, eq(productFacts.productId, products.id))
    .groupBy(products.id)
    .orderBy(asc(products.name), asc(products.id));
}

/** Product ids attached to a campaign (for the editor's attach toggles). */
export async function attachedProductIds(tx: Tx, campaignId: number): Promise<number[]> {
  const rows = await tx
    .select({ productId: campaignProducts.productId })
    .from(campaignProducts)
    .where(eq(campaignProducts.campaignId, campaignId));
  return rows.map((r) => r.productId);
}

/** The one product a campaign's drafts use, or null for nothing to offer
 *  (`productInUse`). */
export async function campaignProductId(tx: Tx, campaignId: number): Promise<number | null> {
  return productInUse(await attachedProductIds(tx, campaignId));
}
