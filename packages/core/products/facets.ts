import type { ProductFacet } from "@engager/database/schema";

/**
 * The six product facets, in canonical display/assessment order.
 *
 * Its own module, importing nothing but a type, because this list is READ ON
 * THE CLIENT: the folder page heads its six sections with these labels and the
 * add-product dialog groups what it found under them. `facts.ts` beside it
 * reaches for `node:crypto` to hash content, which a browser bundle cannot
 * follow — so the label set lives where both sides can have it, and `facts.ts`
 * re-exports it for the callers that already had it from there.
 *
 * ONE LABEL SET. These strings are the section headings, so they are written
 * the way the product writes every other heading: no ampersands, and the whole
 * phrase spelled out.
 */
export const PRODUCT_FACETS: { id: ProductFacet; label: string }[] = [
  { id: "what", label: "What it is" },
  { id: "audience", label: "Who it is for" },
  { id: "value", label: "Why it matters" },
  { id: "proof", label: "Proof" },
  { id: "objections", label: "Objections and answers" },
  { id: "links", label: "Links" },
];
