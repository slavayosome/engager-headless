import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { productFacts, products, type ProductFacet } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { createProduct, updateProduct } from "../operations/products";
import { recomputeFillScore, storeProductFact } from "./facts";
import { findProductIdByName } from "./queries";
import { AppError } from "@engager/common/errors";

/**
 * THE PRODUCT SETUP SAVES, as the product step's form holds it: the six
 * fields the owner reviews, and the source line they were read from. Setup
 * records its selected id separately from products discovered in the Brain.
 */
export type SetupProduct = {
  name: string;
  description: string;
  audience: string;
  value: string;
  facts: string;
  link: string;
  source: string;
};

/** What the source line says for a product the owner entered by hand. */
const OWNER_DETAILS = "Owner-provided details";

/** The facets the form's fields are stored under: the description and the
 *  other facts as `what`, the audience, the value. Facts the owner added to
 *  the product anywhere else are not this step's to replace. */
const FORM_FACETS: ProductFacet[] = ["what", "audience", "value"];

/**
 * The saved product as the form reads it back, or null before one is saved —
 * what Back shows again, after a relaunch too. The form's fields are what
 * `writeSetupProduct` stored: the description is the product's one-liner, the
 * audience and value are their facets' facts, and the other facts are what is
 * left of `what` once the description (stored there too) is set aside. Facts
 * under any other facet are not on this form and are left alone.
 */
export async function readSetupProduct(tx: Tx, id?: number | null): Promise<(SetupProduct & { id: number }) | null> {
  if (id === null) return null;
  const [product] = await tx.select().from(products).where(id === undefined ? undefined : eq(products.id, id)).orderBy(desc(products.id)).limit(1);
  if (!product) return null;
  const facts = await tx
    .select()
    .from(productFacts)
    .where(eq(productFacts.productId, product.id))
    .orderBy(asc(productFacts.id));
  const description = product.oneLiner ?? "";
  const of = (facet: ProductFacet) =>
    facts
      .filter((fact) => fact.facet === facet && !(facet === "what" && fact.content === description))
      .map((fact) => fact.content)
      .join("\n");
  return {
    id: product.id,
    name: product.name,
    description,
    audience: of("audience"),
    value: of("value"),
    facts: of("what"),
    link: product.link ?? "",
    source: facts.find((fact) => fact.sourcePath)?.sourcePath ?? OWNER_DETAILS,
  };
}

/**
 * Save the reviewed product and return its id. `id` names the product the
 * form was restored from; without one it is the product already called that
 * (setup keeps one, so a second press means the same one), and failing both
 * it is created. An existing product is updated in place — a new name renames
 * it, and the form's facts replace the ones this step stored rather than add
 * to them — so going Back and forward never makes a second product or repeats
 * a fact.
 */
export async function writeSetupProduct(
  tx: Tx,
  input: SetupProduct,
  id: number | null = null,
): Promise<number> {
  const known = id === null ? null : (await tx.select({ id: products.id }).from(products).where(eq(products.id, id)))[0];
  if (id !== null && !known) throw new AppError("setup_product_missing", "That product is no longer available. Reload and choose another product.", 409);
  const existing = known?.id ?? (await findProductIdByName(tx, input.name));
  const productId =
    existing ??
    (await createProduct(tx, {
      name: input.name,
      oneLiner: input.description,
      link: input.link,
      source: "manual",
    }));
  if (existing !== null) {
    await updateProduct(tx, productId, { name: input.name, oneLiner: input.description, link: input.link });
    await tx
      .delete(productFacts)
      .where(
        and(
          eq(productFacts.productId, productId),
          inArray(productFacts.facet, FORM_FACETS),
          eq(productFacts.source, "manual"),
        ),
      );
  }
  for (const [facet, content] of [
    ["what", input.description],
    ["audience", input.audience],
    ["value", input.value],
    ["what", input.facts],
  ] as const) {
    await storeProductFact(tx, { productId, facet, content, source: "manual", sourcePath: input.source });
  }
  await recomputeFillScore(tx, productId);
  return productId;
}
