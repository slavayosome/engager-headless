import { z } from "zod";
import { withOrg } from "@engager/database/tenant";
import { effectiveAudience } from "../../../audience/model";
import { audienceHistory } from "../../../audience/write";
import { audienceProfileInputSchema } from "../../../audience/model";
import { CAMPAIGN_TEMPLATE_IDS } from "../../../strategy/templates";
import { STARTING_POINT_IDS, startingDesign } from "../../../strategy/firstCampaignActions";
import { saveCampaign } from "../../../operations/saveCampaign";
import { mcpOperationActor } from "../../context";
import { getCampaign, listCampaignsWithMeta } from "../../../operations/campaigns";
import { CAMPAIGN_DELETE, CampaignNotFoundError, deletePending, type CampaignDelete } from "../../../operations/deleteCampaign";
import { pendingNote, recordProposal } from "../../../chat/proposals";
import { campaignOneEach } from "../../../operations/campaignOneEach";
import { listStrategyVersions, readCampaignStrategy, type CampaignStrategyView } from "../../../strategy/read";
import { CATALOG_STEPS } from "../../../strategy/catalog";
import { searchMapSummary, pipelineSummary } from "../../../leads/scout/mapSummary";
import { campaignWorkers } from "../../../operations/campaignWorkspace";
import { listWorkerRuns } from "../../../operations/workers";
import { runForAgent } from "./run";
import { campaignWatchStats } from "../../../operations/observability";
import { campaignOutcomeReport } from "../../../conversations/outcomes";
import { leadWeek } from "../../../leads/week";
import { errorResult, jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { fenceByShape } from "../fence";
import { campaignBriefView } from "../../../operations/campaignBriefView";
import { AppError } from "@engager/common/errors";
import { readPatchState } from "../../../strategy/patch";
import { previewModes } from "../../../strategy/preview";

const id = z.number().int().positive();

/** The strategy as `get_campaign` reads it: each step under its catalog name
 *  (`stepName`), whatever label the version it was stored in carries. */
function catalogNamed(view: CampaignStrategyView | null): CampaignStrategyView | null {
  const steps = view?.strategy.document.steps;
  if (!view || !Array.isArray(steps)) return view;
  const named = steps.map((step: unknown) => {
    const id = (step as { catalog_step?: unknown } | null)?.catalog_step;
    return typeof id === "string" && Object.hasOwn(CATALOG_STEPS, id)
      ? { ...(step as object), label: CATALOG_STEPS[id as keyof typeof CATALOG_STEPS].label }
      : step;
  });
  return { ...view, strategy: { ...view.strategy, document: { ...view.strategy.document, steps: named } } };
}
export const campaignCrudTools: readonly V2Tool[] = [
  defineTool({ name: "list_campaigns", kind: "read", description: "List campaigns, optionally by status. See engager-campaigns.",
    input: z.object({ status: z.enum(["active", "paused", "archived"]).optional() }),
    handler: async ({ ctx }, { status }) => withOrg(ctx.organizationId, async tx => jsonResult((await listCampaignsWithMeta(tx)).filter(c => !status || c.status === status))),
  }),
  defineTool({ name: "get_campaign", kind: "read", description: "Read a campaign and selected workspace details. See engager-campaigns.",
    input: z.object({ id, include: z.array(z.enum(["strategy", "strategy_versions", "brief", "audience", "searches", "runs", "stats"])).optional() }),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      const campaign = await getCampaign(tx, input.id);
      if (!campaign) return errorResult(`campaign ${input.id} not found`, { code: "campaign_not_found", status: 404 });
      const wants = (part: string) => input.include?.includes(part as never) ?? false;
      const workers = wants("runs") ? await campaignWorkers(tx, input.id) : [];
      return jsonResult({ campaign, ...await campaignOneEach(tx, campaign),
        ...(wants("strategy") && { strategy: catalogNamed(await readCampaignStrategy(tx, input.id)) }),
        ...(wants("strategy_versions") && { strategy_versions: await listStrategyVersions(tx, input.id) }),
        ...(wants("brief") && { brief: fenceByShape(await campaignBriefView(tx, input.id)) }),
        ...(wants("audience") && { audience: { ...effectiveAudience(campaign), history: await audienceHistory(tx, input.id, undefined, 10) } }),
        ...(wants("searches") && { searches: fenceByShape({ map: await searchMapSummary(tx, input.id, Date.now()), pipeline: await pipelineSummary(tx, input.id, Date.now()) }) }),
        ...(wants("runs") && { runs: await Promise.all(workers.map(async worker => ({ worker, runs: (await listWorkerRuns(tx, worker.id)).map(runForAgent) }))) }),
        ...(wants("stats") && { stats: { watches: await campaignWatchStats(tx, input.id), outcomes: campaign.channelId === null ? null : await campaignOutcomeReport(tx, { id: input.id, channelId: campaign.channelId }), week: (await leadWeek(tx, [input.id], Date.now())).get(input.id) } }),
      });
    }),
  }),
  defineTool({ name: "save_campaign", kind: "write", description: "Create or update a campaign, or preview without saving. Send a widening alone; mixed changes are refused. Start remains the owner's. See engager-campaigns.",
    input: z.object({ id: id.optional(), ids: z.array(id).min(1).max(50).optional(), name: z.string().min(1).max(200).optional(), goal: z.enum(["engage", "visibility", "audience", "nurture", "thought", "product"]).optional(), audience: audienceProfileInputSchema.optional(), depth: z.enum(["quick", "standard", "deep"]).optional(), voiceId: id.nullable().optional(), productId: id.nullable().optional(), status: z.enum(["paused", "archived"]).optional(), recompileBrief: z.boolean().optional(), duplicateFrom: id.optional(), template: z.enum(CAMPAIGN_TEMPLATE_IDS).optional(), startingPoint: z.enum(STARTING_POINT_IDS).optional(), dryRun: z.boolean().optional() }),
    handler: async ({ ctx }, { dryRun, startingPoint, productId, ids, ...fields }) => withOrg(ctx.organizationId, async tx => {
      if (ids) {
        // Several campaigns take the one change that is the same for each:
        // paused, or archived. Each is saved as it would be alone.
        const { status, ...own } = fields;
        if (!status || dryRun || startingPoint || productId !== undefined || Object.values(own).some((field) => field !== undefined)) return errorResult("Many campaigns take status alone.", { code: "invalid_request", status: 400 });
        const campaigns = [];
        for (const one of new Set(ids)) {
          const saved = await saveCampaign(tx, ctx.organizationId, { id: one, status }, mcpOperationActor(ctx));
          campaigns.push({ id: one, valid: saved.valid, ...(saved.valid ? {} : { errors: saved.errors }) });
        }
        return jsonResult({ status, campaigns });
      }
      // A starting point is the same design New campaign sends for its card.
      const input = { ...fields, ...(startingPoint && { design: startingDesign(startingPoint) }), ...(productId !== undefined && { products: productId === null ? [] : [productId] }) };
      if (!dryRun) return jsonResult(await saveCampaign(tx, ctx.organizationId, input, mcpOperationActor(ctx)));
      class Preview { constructor(readonly value: unknown) {} }
      try {
        await tx.transaction(async nested => {
          const result = await saveCampaign(nested, ctx.organizationId, input, mcpOperationActor(ctx));
          if (!result.valid) throw new Preview(result);
          const campaignId = result.campaign!.id;
          const state = await readPatchState(nested, campaignId, { lock: false });
          const needsNumber = previewModes({ campaign: state.base, accountDefault: state.accountDefault?.document ?? null, network: state.network, connector: null, liveChecks: state.liveChecks })
            .filter(action => action.reason === "ceiling_null");
          throw new Preview({ ...result, ...(needsNumber.length && { needsNumber }) });
        });
      } catch (error) {
        if (error instanceof Preview) {
          const value = error.value as { valid: boolean };
          return jsonResult(value.valid ? { dryRun: true, errors: [], confirmationRequired: ["Start remains the owner's in Engager"], ...value } : { dryRun: true, ...value });
        }
        if (error instanceof AppError) return jsonResult({ dryRun: true, valid: false, errors: [{ field: "field" in error && typeof error.field === "string" ? error.field : null, code: error.code, message: error.message }] });
        if (error instanceof z.ZodError) return jsonResult({ dryRun: true, valid: false, errors: error.issues.map(issue => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) });
        throw error;
      }
      throw new Error("Preview did not roll back.");
    }),
  }),
  defineTool({ name: "delete_campaign", kind: "destructive", description: "Propose deleting a campaign for the owner to confirm in Engager. See engager-campaigns.",
    input: z.object({ id }), handler: async ({ ctx }, { id: campaignId }) => withOrg(ctx.organizationId, async tx => {
      const campaign = await getCampaign(tx, campaignId);
      if (!campaign) throw new CampaignNotFoundError(campaignId);
      const change: CampaignDelete = { kind: CAMPAIGN_DELETE, campaignId };
      const card = await recordProposal(tx, ctx.organizationId, change, { sessionId: null, turnId: null });
      return jsonResult({ proposed: true, ...card, status: "pending", note: pendingNote(deletePending(campaign.name)) });
    }),
  }),
];
