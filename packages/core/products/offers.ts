import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { offers, products, type Offer, type OfferBinding } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { contextHash } from "../tasks/hash";

/**
 * THE OFFER AN OFFER DM MAY MAKE — a product's link, what it is and the facts
 * a message may state about it, in words the owner approved (spec §14 R14).
 *
 * A campaign names its offer in `cta.cta_asset_id` as `product:<id>`, and a
 * step's `send_dm` names it again; neither name is an approval. What resolves
 * is the product's offer row, and only while its approved words are its words
 * and it is not retired ({@link approvedOffer}): an unknown reference, words
 * saved since the yes, and a retired offer all resolve as none, and an offer
 * DM is refused `cta_unapproved` before a word is drafted.
 *
 * Who approves: the owner, by their own hand — the Offer form on the product,
 * the yes on a chat card, or `decide` on their word, bound to the hash
 * of the words they were shown. Words an agent saves (`save_product`) wait for
 * that yes. The approval binds words, never sending: a DM still waits at Ask
 * me and under every DM rule (`actions/dm.ts`).
 */

export const OFFER_REF_PREFIX = "product:";

export const offerWords = z
  .object({
    url: z.string().trim().url().max(2000),
    what: z.string().trim().min(1).max(500),
    facts: z.array(z.string().trim().min(1).max(500)).max(20),
  })
  .strict();
export type OfferWords = z.infer<typeof offerWords>;

/** What a reader is shown of an offer: its words, whether they are the words
 *  the owner approved, and whether it is retired. */
export type OfferView = OfferWords & {
  ref: string;
  productId: number;
  contentHash: string;
  approved: boolean;
  approvedAt: number | null;
  approvedBy: string | null;
  retired: boolean;
};

/** An offer a DM may make now: approved, as it stands, and not retired. */
export type ApprovedOffer = OfferWords & OfferBinding & { productId: number };

export function offerRef(productId: number): string {
  return `${OFFER_REF_PREFIX}${productId}`;
}

/** The product a reference names, or null for one that names none. */
export function productIdOfRef(ref: string): number | null {
  if (!ref.startsWith(OFFER_REF_PREFIX)) return null;
  const id = Number(ref.slice(OFFER_REF_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function offerContentHash(words: OfferWords): string {
  return contextHash({ url: words.url, what: words.what, facts: words.facts });
}

function viewOf(row: Offer): OfferView {
  return {
    ref: offerRef(row.productId),
    productId: row.productId,
    url: row.url,
    what: row.what,
    facts: row.facts,
    contentHash: row.contentHash,
    approved: row.approvedHash === row.contentHash,
    approvedAt: row.approvedAt,
    approvedBy: row.approvedBy,
    retired: row.retiredAt !== null,
  };
}

export class OfferError extends AppError {
  readonly recovery: string;

  constructor(code: string, message: string, recovery: string, status = 409) {
    super(code, message, status);
    this.recovery = recovery;
  }
}

function productMissing(productId: number): OfferError {
  return new OfferError(
    "product_not_found",
    `product ${productId} is not one this organization has`,
    "Nothing was written. Read the products with list_products and use one of their ids.",
    404,
  );
}

function offerMissing(productId: number): OfferError {
  return new OfferError(
    "offer_not_found",
    `product ${productId} has no offer`,
    "Nothing was written. Save its words first (save_product), then show the owner what they would approve.",
    404,
  );
}

export async function readOffer(tx: Tx, productId: number): Promise<OfferView | null> {
  const [row] = await tx.select().from(offers).where(eq(offers.productId, productId));
  return row ? viewOf(row) : null;
}

/**
 * Write a product's offer: new words, or the first. A retired offer saved
 * again is offered again. `approver` is the owner's own hand — the form, a
 * chat card's yes — and approves the words it saves; null leaves them waiting
 * for one and takes back any yes there was, so words an agent saves are never
 * approved by an earlier yes to the same words.
 */
export async function saveOffer(
  tx: Tx,
  input: OfferWords & { productId: number },
  context: { approver: string | null; now: number },
): Promise<OfferView> {
  const words = offerWords.parse({ url: input.url, what: input.what, facts: input.facts });
  const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, input.productId));
  if (!product) throw productMissing(input.productId);
  const contentHash = offerContentHash(words);
  const approval =
    context.approver === null
      ? { approvedHash: null, approvedBy: null, approvedAt: null }
      : { approvedHash: contentHash, approvedBy: context.approver, approvedAt: context.now };
  const [row] = await tx
    .insert(offers)
    .values({
      productId: product.id,
      ...words,
      contentHash,
      ...approval,
      createdAt: context.now,
      updatedAt: context.now,
    })
    .onConflictDoUpdate({
      target: [offers.organizationId, offers.productId],
      set: {
        ...words,
        contentHash,
        ...approval,
        retiredAt: null,
        updatedAt: context.now,
      },
    })
    .returning();
  return viewOf(row!);
}

/** The owner's yes to exactly the words they were shown: refused when the
 *  offer has other words now, or is retired. */
export async function approveOffer(
  tx: Tx,
  input: { productId: number; contentHash: string },
  context: { approver: string; now: number },
): Promise<OfferView> {
  const [row] = await tx.select().from(offers).where(eq(offers.productId, input.productId)).for("update");
  if (!row) throw offerMissing(input.productId);
  if (row.retiredAt !== null) {
    throw new OfferError(
      "offer_retired",
      `product ${input.productId}'s offer is retired`,
      "Nothing was approved. Save its words again (save_product) to offer it again, then ask the owner.",
    );
  }
  if (row.contentHash !== input.contentHash) {
    throw new OfferError(
      "offer_changed",
      `product ${input.productId}'s offer has other words than the ones approved`,
      "Nothing was approved. Read the offer again (list_products), show the owner its words as they are, and approve that contentHash on their word.",
    );
  }
  const [approved] = await tx
    .update(offers)
    .set({
      approvedHash: row.contentHash,
      approvedBy: context.approver,
      approvedAt: context.now,
      updatedAt: context.now,
    })
    .where(eq(offers.id, row.id))
    .returning();
  return viewOf(approved!);
}

/** Retire a product's offer: no DM makes it from now on, a yes already given
 *  to one that would is refused at the gate (`actions/approval.ts`), and
 *  offering it again asks the owner again. */
export async function retireOffer(
  tx: Tx,
  input: { productId: number },
  context: { now: number },
): Promise<OfferView> {
  const [row] = await tx
    .update(offers)
    .set({
      retiredAt: sql`coalesce(${offers.retiredAt}, ${context.now})`,
      approvedHash: null,
      updatedAt: context.now,
    })
    .where(eq(offers.productId, input.productId))
    .returning();
  if (!row) throw offerMissing(input.productId);
  return viewOf(row);
}

/** The offer a reference names, when a DM may make it now; null for an
 *  unknown reference, unapproved words and a retired offer alike. */
export async function approvedOffer(tx: Tx, ref: string): Promise<ApprovedOffer | null> {
  const productId = productIdOfRef(ref);
  if (productId === null) return null;
  const offer = await readOffer(tx, productId);
  if (!offer || !offer.approved || offer.retired) return null;
  return { ref, productId, url: offer.url, what: offer.what, facts: offer.facts, contentHash: offer.contentHash };
}

/**
 * What an offer may never be said to be unless its own facts say so: a free
 * trial, a discount, instant access. A draft that says one its facts do not
 * is refused, and so is a link that is not the offer's. Read on the words
 * alone, both ways, so "free" in a fact is what lets "free" into a DM.
 * Deliberately broad: a false alarm costs a redraft; a missed one is a claim
 * the owner never made, sent in their name.
 */
const UNSUPPORTED_UNLESS_STATED = {
  free_trial: /\btrial\b|\bno (?:credit )?card\b|(?<!feel\s)\bfree\b(?!\s+time\b)/i,
  discount:
    /\bdiscount(?:ed|s)?\b|\d+\s?%\s?off\b|\bcoupons?\b|\bpromo(?:tion(?:al)?)?\s+codes?\b|\bhalf[-\s]price\b|\bon sale\b|\breduced price\b|\bspecial price\b|\bearly[-\s]bird\b/i,
  instant_access:
    /\binstant(?:ly)?\b|\bimmediate(?:ly)?\b|\bright away\b|\bstraight away\b|\bno wait(?:ing)?(?:\s?list)?\b|\bskip the (?:wait(?:\s?list)?|queue|line)\b/i,
} as const;
export type OfferClaim = keyof typeof UNSUPPORTED_UNLESS_STATED | "link";

/** A link however it is spelled: with a scheme, from `www.`, or a bare
 *  domain with or without a path. */
const LINK =
  /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/[^\s<>()]*)?/gi;

function sameLink(found: string, url: string): boolean {
  const bare = (value: string) =>
    value
      .replace(/[.,;:!?'")\]]+$/, "")
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return bare(found) === bare(url);
}

/** The first thing `text` says about the offer that its approved words do
 *  not, or null. Pure. */
export function unsupportedOfferClaim(
  text: string,
  offer: Pick<OfferWords, "url" | "facts" | "what">,
): OfferClaim | null {
  const stated = [offer.what, ...offer.facts].join("\n");
  for (const [claim, says] of Object.entries(UNSUPPORTED_UNLESS_STATED) as Array<[OfferClaim, RegExp]>) {
    if (says.test(text) && !says.test(stated)) return claim;
  }
  for (const found of text.match(LINK) ?? []) {
    if (!sameLink(found, offer.url)) return "link";
  }
  return null;
}
