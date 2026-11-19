import { eq } from "drizzle-orm";
import { products } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { AgentCliError } from "../../ai/agentCli/types";
import { enqueueRecompileForProduct } from "../../brain/compile";
import { listKnowledge } from "../../brain/knowledge";
import { suggestCampaignSetup } from "../../campaigns/suggest";
import {
  applyPreparedProductUrlIngest,
  prepareProductUrlIngest,
  type ProductIngestErrorCode,
} from "../../products/ingest";
import { getProduct, type ProductDetail } from "../../products/queries";
import type { SelfScopedCtx } from "../worker";
import { RescheduleError } from "../queue";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
  HostedJobSpendRevokedError,
} from "../spendAccess";

class ProductIngestRevisionChangedError extends RescheduleError {
  constructor() {
    super("product_ingest_revision_changed", Date.now());
  }
}

class ProductIngestFailureError extends Error {
  constructor(readonly code: ProductIngestErrorCode) {
    super(code);
    this.name = "ProductIngestFailureError";
  }
}

function suggestionInputFingerprint(
  product: ProductDetail,
  knowledge: { content: string }[],
): string {
  return JSON.stringify({
    ingestRevision: product.product.ingestRevision,
    name: product.product.name,
    oneLiner: product.product.oneLiner,
    link: product.product.link,
    facts: product.factsByFacet.flatMap((group) =>
      group.items.map((fact) => [group.facet, fact.content]),
    ),
    knowledge: knowledge.map((item) => item.content).sort(),
  });
}

/**
 * Ingest a product's `link` (site / GitHub README) into product facts, off the
 * request path. `ingestProductUrl` fetches an arbitrary (remotely-scriptable) URL —
 * SSRF-guarded + timed out inside. Transient fetch/extraction failures throw into
 * the queue's bounded retry path with a stable product error code.
 *
 * SELF-SCOPED in TWO phases so the wizard's product step isn't slow:
 *   (1) ingest → COMMIT the facts in their own tx. The moment this commits, the
 *       wizard's product-card poll sees the facts and moves on — it no longer waits
 *       for phase 2.
 *   (2) pre-generate the first-campaign suggestion in a SEPARATE tx (the second LLM
 *       call). Caching it lets onboarding's campaign step prefill instantly. Keeping
 *       it out of phase 1's transaction shaves that whole LLM call off the product
 *       step's critical path, and never pins the connection across it.
 */
export async function handleIngestProduct(
  ctx: SelfScopedCtx,
  payload: { productId: number },
): Promise<void> {
  const orgId = ctx.organizationId;
  let revision: number | undefined;

  const lockProduct = (tx: Tx) =>
    tx
      .select({
        id: products.id,
        ingestRevision: products.ingestRevision,
        updatedAt: products.updatedAt,
        campaignSuggestion: products.campaignSuggestion,
      })
      .from(products)
      .where(eq(products.id, payload.productId))
      .for("update")
      .then((rows) => rows[0] ?? null);

  // Live-progress stamp, ALWAYS in its own short tx (a stamp inside a phase's tx
  // wouldn't be visible until that phase commits — useless as live status).
  const stamp = (
    stage: "crawling" | "suggesting" | "done" | "failed",
    errorCode: ProductIngestErrorCode | null = null,
  ) =>
    withOrg(orgId, async (tx) => {
      const product = await lockProduct(tx);
      if (
        !product ||
        (revision !== undefined && product.ingestRevision !== revision)
      ) {
        return false;
      }
      await assertHostedJobSpendStillAllowedInTx(tx, ctx);
      const rows = await tx
        .update(products)
        .set({
          ingestStage: stage,
          ingestErrorCode: errorCode,
          updatedAt: Date.now(),
        })
        .where(eq(products.id, payload.productId))
        .returning({ id: products.id });
      return rows.length > 0;
    });

  const requireCurrent = (current: boolean) => {
    if (!current) throw new ProductIngestRevisionChangedError();
  };

  try {
    // Phase 1 — snapshot the link, release the connection for every provider call,
    // then re-open one short transaction to persist the prepared facts.
    const snapshot = await withOrg(orgId, async (tx) => {
      const row = await lockProduct(tx);
      if (!row) return null;
      await assertHostedJobSpendStillAllowedInTx(tx, ctx);
      const [link] = await tx
        .select({ link: products.link })
        .from(products)
        .where(eq(products.id, payload.productId));
      return link ? { ...row, link: link.link } : null;
    });
    if (!snapshot) return;
    revision = snapshot.ingestRevision;
    requireCurrent(await stamp("crawling"));
    const link = snapshot.link;
    // A removed product or a manually cleared URL is a recoverable pre-provider
    // no-op, not consumption of the owner's one initial ingest lane.
    if (!link) {
      requireCurrent(await stamp("done"));
      return;
    }
    // An agent that refused reaches the INTERACTIVE callers as itself, so the
    // owner reads what to fix. Here there is nobody reading: the queue records
    // a code and retries, so the refusal becomes the typed denial this handler
    // has always stamped rather than an error the outer catch cannot name.
    const prepared = await prepareProductUrlIngest(link, {
      llm: ctx.llm,
      beforeFetch: () => assertHostedJobSpendStillAllowed(ctx),
      beforeExtract: () => assertHostedJobSpendStillAllowed(ctx),
    }).catch((error: unknown) => {
      if (error instanceof AgentCliError)
        throw new ProductIngestFailureError("product_ingest_extraction_failed");
      throw error;
    });
    if (!prepared.ok) {
      // Loud + honest: a swallowed read/extract failure looked exactly like a
      // successful ingest of an empty site, and phase 2 then cached a junk
      // suggestion grounded on nothing. Stamp failed so the wizard shows its
      // manual-entry escape instead of a silently empty product.
      console.error(
        `[ingest_product] product ${payload.productId} ingest failed: ${prepared.reason}`,
      );
      if (prepared.code === "product_ingest_url_invalid") {
        requireCurrent(await stamp("failed", prepared.code));
        return;
      }
      throw new ProductIngestFailureError(prepared.code);
    }
    const applied = await withOrg(orgId, async (tx) => {
      const current = await lockProduct(tx);
      if (!current || current.ingestRevision !== revision) {
        return { ok: false as const, added: 0 as const, stale: true as const };
      }
      await assertHostedJobSpendStillAllowedInTx(tx, ctx);
      return applyPreparedProductUrlIngest(tx, payload.productId, prepared, {
        expectedRevision: revision,
      });
    });
    if (!applied.ok) throw new ProductIngestRevisionChangedError();
    // Recompile when web facts changed, including removals. Product facts are not
    // in knowledgeVersion, so the coarse Brain wave will not cover them.
    if (applied.changed) {
      await withOrg(orgId, async (tx) => {
        await assertHostedJobSpendStillAllowedInTx(tx, ctx);
        return enqueueRecompileForProduct(tx, payload.productId);
      });
    }

    requireCurrent(await stamp("suggesting"));

    // Phase 2 — pre-generate the campaign suggestion (name/audience/keywords), OFF the
    // product-step critical path. Best-effort: on any failure the wizard suggests live.
    try {
      const { product, knowledge } = await withOrg(orgId, async (tx) => ({
        product: await getProduct(tx, payload.productId),
        knowledge: await listKnowledge(tx),
      }));
      if (product?.product.ingestRevision !== revision) {
        throw new ProductIngestRevisionChangedError();
      }
      const suggestionInput = product
        ? suggestionInputFingerprint(product, knowledge)
        : null;
      await assertHostedJobSpendStillAllowed(ctx);
      const s = await suggestCampaignSetup({
        organizationId: product?.product.organizationId ?? orgId,
        product,
        knowledge,
        llm: ctx.llm,
      });
      if (s) {
        await withOrg(orgId, async (tx) => {
          const current = await lockProduct(tx);
          if (!current || current.ingestRevision !== revision) {
            throw new ProductIngestRevisionChangedError();
          }
          await assertHostedJobSpendStillAllowedInTx(tx, ctx);
          // Product facts, identity, and Brain knowledge are in this snapshot.
          // If any relevant input changed while the model ran, leave the cache
          // empty/current rather than writing stale targeting.
          const currentDetail = await getProduct(tx, payload.productId);
          const currentKnowledge = await listKnowledge(tx);
          if (
            !currentDetail ||
            suggestionInput === null ||
            suggestionInputFingerprint(currentDetail, currentKnowledge) !==
              suggestionInput ||
            current.campaignSuggestion
          ) {
            return Boolean(current.campaignSuggestion);
          }
          await tx
            .update(products)
            .set({ campaignSuggestion: s, updatedAt: Date.now() })
            .where(eq(products.id, payload.productId));
          return true;
        });
      }
    } catch (error) {
      if (
        error instanceof HostedJobSpendRevokedError ||
        error instanceof ProductIngestRevisionChangedError
      ) {
        throw error;
      }
      /* best-effort pre-generation; the wizard computes it live if this is absent */
    }

    requireCurrent(await stamp("done"));
  } catch (e) {
    if (e instanceof ProductIngestRevisionChangedError) throw e;
    // Stamp the failure so the onboarding panel flips to its manual-entry escape
    // hatch instead of spinning; then rethrow so the queue records the attempt.
    const errorCode =
      e instanceof ProductIngestFailureError
        ? e.code
        : e instanceof HostedJobSpendRevokedError
          ? e.reason === "subscription_inactive"
            ? "product_ingest_subscription_inactive"
            : e.reason === "job_lease_lost"
              ? "product_ingest_job_lease_lost"
              : null
          : null;
    const stamped = await stamp("failed", errorCode).catch(() => null);
    if (stamped === false) throw new ProductIngestRevisionChangedError();
    throw e;
  }
}
