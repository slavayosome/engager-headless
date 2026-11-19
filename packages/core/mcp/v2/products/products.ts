import { z } from "zod";
import { withOrg, type Tx } from "@engager/database/tenant";
import { llmWithSignal } from "../../../ai/client";
import { listProducts, getProduct, campaignsForProduct, findProductIdByName } from "../../../products/queries";
import { createProduct, updateProduct, setProductCampaigns, applyProductFactOps, answerQuestionOnProduct } from "../../../operations/products";
import { saveOffer, retireOffer, offerWords } from "../../../products/offers";
import { checkUrlReachable, requestProductIngestRun } from "../../../products/ingest";
import { applyProductCandidatePhased, detectProductsFromBrainPhased } from "../../../products/candidatePhased";
import { ingestProductInSession } from "../../../tasks/executor";
import { resolveJudgmentPolicy } from "../../../tasks/policy";
import { hostedJobSpendAccess } from "../../../entitlements/hosted";
import { enqueueIngestProduct } from "../../../products/ingest";
import { compileFields, routeCompile } from "../../../operations/compileRouting";
import { assertHostedMcpExternalPhase, hostedMcpAccessErrorResult, withHostedMcpScope } from "../../tools/hostedSpend";
import { jsonResult, errorResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { untrusted } from "../../../ai/prompts";
import { fenceByShape } from "../fence";

const id = z.number().int().positive();
const facet = z.enum(["what", "audience", "value", "proof", "objections", "links"]);
const candidate = z.object({ name: z.string().min(1).max(80), oneLiner: z.string().max(200).nullable(), facts: z.array(z.object({ facet, content: z.string().min(1).max(10000) })).max(12), exists: z.boolean() });
const invalid = (message: string) => errorResult(message, { code: "invalid_input", status: 400 });

export const productTools: readonly V2Tool[] = [
  defineTool({
    name: "list_products", kind: "read", description: "List products or read one with its facts, offer and campaigns. See engager-voice-and-brain.",
    input: z.object({ id: id.optional() }),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async (tx) => {
      if (!input.id) return jsonResult(await listProducts(tx));
      const product = await getProduct(tx, input.id);
      return product ? jsonResult(fenceByShape({ ...product, campaigns: await campaignsForProduct(tx, input.id) })) : errorResult(`product ${input.id} not found`, { code: "product_not_found", status: 404 });
    }),
  }),
  defineTool({
    name: "save_product", kind: "write", description: "Create or edit a product, its facts, offer and campaigns. Offers wait for owner approval. See engager-voice-and-brain.",
    input: z.object({ id: id.optional(), name: z.string().min(1).max(80).optional(), oneLiner: z.string().max(200).nullable().optional(), link: z.string().max(2048).nullable().optional(), status: z.enum(["idea", "beta", "released"]).optional(), facts: z.array(z.object({ op: z.enum(["add", "update", "delete"]), id: id.optional(), facet: facet.optional(), content: z.string().min(1).max(10000).optional() })).optional(), answer: z.object({ questionId: id, text: z.string().max(10000) }).optional(), offer: offerWords.optional(), retireOffer: z.boolean().optional(), campaignIds: z.array(id).optional(), detectedKey: z.string().max(250000).optional() }),
    handler: async ({ ctx, signal }, input) => {
      try {
      if (input.offer && input.retireOffer) return invalid("Supply offer or retireOffer, not both.");
      if (input.detectedKey && input.id) return invalid("A detected product cannot also name an id.");
      let productId = input.id;
      if (input.detectedKey) {
        let decoded: unknown;
        try { decoded = JSON.parse(Buffer.from(input.detectedKey, "base64url").toString("utf8")); } catch { return invalid("Invalid detectedKey."); }
        const parsed = candidate.safeParse(decoded);
        if (!parsed.success) return invalid("Invalid detectedKey.");
        const scope = <T>(work: (tx: Tx) => Promise<T>) => withHostedMcpScope(ctx, signal, "brain:write", work);
        const beforeExternalPhase = () => assertHostedMcpExternalPhase(ctx, signal, "brain:write");
        const applied = await applyProductCandidatePhased(scope, parsed.data, { llm: llmWithSignal(ctx.llm, signal), beforeExternalPhase, beforeApplyPhase: beforeExternalPhase });
        if (applied.id === null) return errorResult("Product candidate could not be applied.", { code: "product_candidate_stale", status: 409 });
        productId = applied.id;
      }
      const save = async (tx: Tx) => {
        const fields = { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.oneLiner !== undefined ? { oneLiner: input.oneLiner } : {}), ...(input.link !== undefined ? { link: input.link } : {}), ...(input.status !== undefined ? { status: input.status } : {}) };
        let created = false;
        let existedByName = false;
        if (productId === undefined) {
          if (!input.name) return { error: "name is required for a new product" } as const;
          productId = (await findProductIdByName(tx, input.name)) ?? undefined;
          if (productId === undefined) { productId = await createProduct(tx, fields); created = true; } else existedByName = true;
        } else if (!(await getProduct(tx, productId))) return { error: `product ${productId} not found` } as const;
        if (!created) await updateProduct(tx, productId, fields);
        if (input.campaignIds) await setProductCampaigns(tx, productId, input.campaignIds);
        const factResults = await applyProductFactOps(tx, productId, input.facts ?? []);
        const answer = input.answer ? await answerQuestionOnProduct(tx, productId, input.answer.questionId, input.answer.text) : undefined;
        const offer = input.offer ? { ...(await saveOffer(tx, { productId, ...input.offer }, { approver: null, now: Date.now() })), note: "Not approved. Show the owner the url, what and facts; no DM makes the offer until they approve exactly these words in Engager." } : input.retireOffer ? await retireOffer(tx, { productId }, { now: Date.now() }) : undefined;
        let inSession = false;
        if (created && input.link?.trim()) {
          const access = await hostedJobSpendAccess(tx, ctx.organizationId, "ingest_product");
          if (access.allowed) {
            const policy = await resolveJudgmentPolicy(tx);
            if (policy === "configured_background") await enqueueIngestProduct(tx, productId, { reason: "create" });
            else inSession = policy === "interactive_external";
          }
        }
        const compile = await routeCompile(tx, ctx.organizationId, { kind: "product", productId });
        return { productId, created, ...(existedByName ? { note: "A product with this name already exists; it was edited, not created." } : {}), factResults, answer, offer, inSession, ...compileFields(compile) } as const;
      };
      const result = input.facts?.length || input.answer
        ? await withHostedMcpScope(ctx, signal, "brain:write", save)
        : await withOrg(ctx.organizationId, save);
      if ("error" in result) return invalid(result.error ?? "Invalid product.");
      const ingest = result.inSession && input.link ? await ingestProductInSession(ctx, { productId: result.productId, link: input.link.trim(), signal }) : null;
      return jsonResult({ ...result, ...(ingest ? { ingest } : {}) });
      } catch (error) {
        const refusal = hostedMcpAccessErrorResult(error);
        if (refusal) return refusal;
        throw error;
      }
    },
  }),
  defineTool({
    name: "delete_product", kind: "destructive", description: "Ask the owner to delete a product; it never deletes and answers needs_owner_confirmation. See engager-voice-and-brain.",
    input: z.object({ id }),
    handler: async () => errorResult("Confirm product deletion in the app.", { code: "needs_owner_confirmation", status: 403 }),
  }),
  defineTool({
    name: "scan_product", kind: "linkedin", description: "Check a URL, queue a product rescan or detect products in the Brain. Detection saves nothing. See engager-voice-and-brain.",
    input: z.object({ url: z.string().max(2048).optional(), id: id.optional(), fromBrain: z.boolean().optional() }),
    handler: async ({ ctx, signal }, input) => {
      try {
      if (Number(input.url !== undefined) + Number(input.id !== undefined) + Number(input.fromBrain === true) !== 1 || input.fromBrain === false) return invalid("Supply exactly one of url, id or fromBrain:true.");
      if (input.url !== undefined) {
        const beforeExternalPhase = () => assertHostedMcpExternalPhase(ctx, signal, "brain:write");
        await beforeExternalPhase();
        return jsonResult({ reachable: await checkUrlReachable(input.url, { signal, beforeExternalPhase }) });
      }
      if (input.id !== undefined) return withOrg(ctx.organizationId, async (tx) => jsonResult(await requestProductIngestRun(tx, ctx.organizationId, input.id!)));
      const scope = <T>(work: (tx: Tx) => Promise<T>) => withHostedMcpScope(ctx, signal, "brain:write", work);
      const beforeExternalPhase = () => assertHostedMcpExternalPhase(ctx, signal, "brain:write");
      const candidates = await detectProductsFromBrainPhased(scope, { llm: llmWithSignal(ctx.llm, signal), beforeExternalPhase, beforeApplyPhase: beforeExternalPhase });
      return jsonResult({ candidates: candidates.map((item) => ({ ...item, name: untrusted("DETECTED PRODUCT", item.name), oneLiner: item.oneLiner === null ? null : untrusted("DETECTED PRODUCT", item.oneLiner), facts: item.facts.map((fact) => ({ ...fact, content: untrusted("DETECTED PRODUCT FACT", fact.content) })), detectedKey: Buffer.from(JSON.stringify(item)).toString("base64url") })) });
      } catch (error) {
        const refusal = hostedMcpAccessErrorResult(error);
        if (refusal) return refusal;
        throw error;
      }
    },
  }),
];
