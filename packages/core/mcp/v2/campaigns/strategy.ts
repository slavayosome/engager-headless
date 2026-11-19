import { z } from "zod";
import { withOrg } from "@engager/database/tenant";
import { AppError } from "@engager/common/errors";
import { LANGUAGE_TYPES } from "@engager/database/schema";
import { STRATEGY_PATCH, strategyPatchSchema, preparePatch, undoPatchFor, type StrategyPatch } from "../../../strategy/patch";
import { submitStrategyPatch } from "../../../strategy/submit";
import { meetTheRoomRefusal } from "../../../strategy/addStep";
import { runWorkerNow, runCampaignTestOp, runFirstLookOp, retryFirstLook } from "../../../operations/campaignWorkspace";
import { campaignFirstLook } from "../../../workers/firstLook";
import { addPhrase, addSearchSource, followGatherSource, dismissGatherAuthor, editPhrase, pinPhrase, unpinPhrase, retirePhrase, restorePhrase, undoMapChange } from "../../../leads/scout/mapEdits";
import { addLookalikeSearch, readLookalike, requestAndWaitSearchLookalike } from "../../../discovery/lookalike";
import { withHostedMcpScope } from "../../tools/hostedSpend";
import { drainCampaignWork } from "../../../operations/drainCampaignWork";
import { getCampaign } from "../../../operations/campaigns";
import { previewModes } from "../../../strategy/preview";
import { rankOf } from "../../../strategy/catalog";
import { mcpOperationActor, type McpCtx } from "../../context";
import { errorResult, jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";

const id = z.number().int().positive();
type SearchEdit = { campaignId: number; ops?: Array<{ op: string; id?: number; text?: string; profileId?: string; lookalikeId?: number; index?: number; languageType?: (typeof LANGUAGE_TYPES)[number] }>; fromPostUrl?: string };

/** One campaign's search edits, in order; the first that fails ends them. */
async function editSearches({ ctx, signal }: { ctx: McpCtx; signal: AbortSignal }, input: SearchEdit): Promise<Record<string, unknown>> {
      if (input.fromPostUrl) {
        if (input.ops?.length) throw new AppError("invalid_edit", "Request a post proposal separately from edits.", 400);
        return (await requestAndWaitSearchLookalike(work => withHostedMcpScope(ctx, signal, "messages:write", work), input.campaignId, input.fromPostUrl, signal)) as Record<string, unknown>;
      }
      const results = [];
      for (const [index, op] of (input.ops ?? []).entries()) {
        let result;
        try { result = await withOrg(ctx.organizationId, async tx => {
          const now = Date.now();
          if (op.op === "add" && op.text && op.languageType) return addPhrase(tx, input.campaignId, { term: op.text, languageType: op.languageType }, now);
          if (op.op === "add_place" && op.text) return addSearchSource(tx, input.campaignId, { link: op.text }, now);
          if (op.op === "follow" && op.profileId) return followGatherSource(tx, input.campaignId, { profileId: op.profileId }, now);
          if (op.op === "dismiss" && op.profileId) return dismissGatherAuthor(tx, input.campaignId, op.profileId, now);
          if (op.op === "add_from_lookalike" && op.lookalikeId && op.index !== undefined) {
            if ((await readLookalike(tx, input.campaignId, op.lookalikeId)).target !== "lead_searches") throw new AppError("invalid_proposal", "That suggestion is not for searches.", 409);
            return addLookalikeSearch(tx, input.campaignId, op.lookalikeId, op.index, now);
          }
          if (op.id && op.op === "replace" && op.text) return editPhrase(tx, input.campaignId, { phraseId: op.id, term: op.text, languageType: op.languageType }, now);
          if (op.id && op.op === "pin") return pinPhrase(tx, input.campaignId, op.id, now);
          if (op.id && op.op === "unpin") return unpinPhrase(tx, input.campaignId, op.id, now);
          if (op.id && op.op === "retire") return retirePhrase(tx, input.campaignId, op.id, now);
          if (op.id && op.op === "restore") return restorePhrase(tx, input.campaignId, op.id, now);
          if (op.id && op.op === "undo") return undoMapChange(tx, { campaignId: input.campaignId, changeId: op.id }, now);
          return { ok: false as const, code: "invalid_edit", message: "Missing fields for this search operation." };
        }); } catch (error) {
          if (!(error instanceof AppError)) throw error;
          return { results, failedOp: index + 1, error: { code: error.code, message: error.message } };
        }
        results.push(result);
        if (!result.ok) return { results, failedOp: index + 1 };
      }
      return { results };
}

export const strategyTools: readonly V2Tool[] = [
  defineTool({ name: "patch_strategy", kind: "write", description: "Preview or submit one strategy patch; widenings await the owner in Engager. See engager-campaigns.",
    input: z.object({ campaignId: id, version: id, patch: strategyPatchSchema.omit({ kind: true, campaignId: true, expectedBaseVersion: true }).optional(), undoVersion: id.optional(), dryRun: z.boolean().optional() }),
    handler: async ({ ctx }, input) => {
      try { return await withOrg(ctx.organizationId, async tx => {
      if ((input.patch === undefined) === (input.undoVersion === undefined)) throw new AppError("invalid_patch", "Give exactly one of patch and undoVersion.", 400);
      const patch: StrategyPatch = input.patch ? { kind: STRATEGY_PATCH, campaignId: input.campaignId, expectedBaseVersion: input.version, ...input.patch }
        : { ...await undoPatchFor(tx, input.campaignId, input.undoVersion!, `undo version ${input.undoVersion}`), expectedBaseVersion: input.version };
      const now = Date.now();
      const prepared = await preparePatch(tx, patch, { now, lock: false, draft: true });
      const refused = meetTheRoomRefusal(prepared.state.base, prepared.document);
      if (refused) throw new AppError("meet_the_room_needs_deep", refused, 409);
      if (input.dryRun) {
        const resolve = (campaign: typeof prepared.document) => previewModes({ campaign, accountDefault: prepared.state.accountDefault?.document ?? null, network: prepared.state.network, connector: null, liveChecks: prepared.state.liveChecks });
        const before = new Map(resolve(prepared.state.base).map(action => [action.action_binding_id, action]));
        // A step's mode is what happens; an Automatic newly asked for still waits at Ask me until Limits holds the action's number.
        const needsNumber = resolve(prepared.document).filter(action => action.reason === "ceiling_null" && rankOf(action.requested) > rankOf(before.get(action.action_binding_id)?.requested));
        return jsonResult({ level: prepared.level, proposed: prepared.level === "confirm", rows: prepared.rows, widenings: prepared.widenings, needsNumber, changes: prepared.changes, document: prepared.document });
      }
      const outcome = await submitStrategyPatch(tx, ctx.organizationId, patch, { approver: mcpOperationActor(ctx), now, draft: true, prepared });
      // The outcome names v1's undo tool; v2 undoes through this one, against the version just written.
      return jsonResult("applied" in outcome ? { ...outcome, undo: { tool: "patch_strategy", campaignId: outcome.campaignId, version: outcome.version, undoVersion: outcome.version } } : outcome);
      }); } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return errorResult(error.message, { code: error.code, status: error.status,
          ...("recovery" in error && typeof error.recovery === "string" ? { recovery: error.recovery } : {}),
          ...("details" in error && typeof error.details === "object" && error.details !== null ? { data: error.details as Record<string, unknown> } : {}) });
      }
    },
  }),
  defineTool({ name: "edit_searches", kind: "linkedin", description: "Edit searches in order, or propose searches from a post. See engager-campaigns.",
    input: z.object({ campaignId: id.optional(), campaignIds: z.array(id).min(1).max(50).optional(), ops: z.array(z.object({ op: z.enum(["add", "add_place", "add_from_lookalike", "replace", "pin", "unpin", "retire", "restore", "undo", "follow", "dismiss"]), id: id.optional(), text: z.string().min(1).max(500).optional(), profileId: z.string().min(1).optional(), lookalikeId: id.optional(), index: z.number().int().min(0).max(3).optional(), languageType: z.enum(LANGUAGE_TYPES).optional() })).optional(), fromPostUrl: z.string().url().optional() }),
    handler: async (call, { campaignIds, campaignId, ...edit }) => {
      if ((campaignId === undefined) === (campaignIds === undefined)) throw new AppError("invalid_edit", "Give campaignId or campaignIds.", 400);
      if (campaignId !== undefined) return jsonResult(await editSearches(call, { ...edit, campaignId }));
      // The same additions to several campaigns. An edit of a search already
      // there names that campaign's own row, so it is asked of one campaign.
      if (edit.fromPostUrl || !edit.ops?.length || edit.ops.some((op) => op.op !== "add" && op.op !== "add_place")) throw new AppError("invalid_edit", "Many campaigns take add and add_place alone.", 400);
      const campaigns = [];
      for (const each of new Set(campaignIds)) campaigns.push({ campaignId: each, ...(await editSearches(call, { ...edit, campaignId: each })) });
      return jsonResult({ campaigns });
    },
  }),
  defineTool({ name: "run_campaign", kind: "linkedin", description: "Run a campaign or its pre-start test within its strategy and stops. due_work is account-wide, no pacing relief. See engager-campaigns.",
    input: z.object({ campaignId: id, run: z.enum(["now", "first_look", "due_work", "test"]), worker: z.enum(["scout", "ambassador"]).optional() }),
    handler: async ({ ctx, signal }, input) => {
      if (input.run === "now") return jsonResult(await runWorkerNow(ctx, input.campaignId, input.worker, signal));
      if (input.worker) throw new AppError("invalid_run", "A worker can only be selected for Run now.", 400);
      if (input.run === "test") return withOrg(ctx.organizationId, async tx => jsonResult(await runCampaignTestOp(tx, input.campaignId)));
      if (input.run === "first_look") return withOrg(ctx.organizationId, async tx => {
        const previous = await campaignFirstLook(tx, ctx.organizationId, input.campaignId);
        return jsonResult(previous?.stopped
          ? await retryFirstLook(tx, ctx.organizationId, input.campaignId, { trigger: "agent" })
          : await runFirstLookOp(tx, input.campaignId, { trigger: "agent" }));
      });
      if (!(await withOrg(ctx.organizationId, tx => getCampaign(tx, input.campaignId)))) throw new AppError("campaign_not_found", "Campaign not found.", 404);
      return jsonResult(await drainCampaignWork(ctx.organizationId, signal));
    },
  }),
];
