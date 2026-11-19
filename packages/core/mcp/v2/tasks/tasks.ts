import { z } from "zod";
import { withOrg } from "@engager/database/tenant";
import { startTask, getTask, finishTask, cancelTask, listOpenTasks, TaskSubmission, UnfrozenItemError } from "../../../tasks/task";
import { listOwedTasks } from "../../../tasks/owed";
import { modeFor, resolveJudgmentPolicy } from "../../../tasks/policy";
import { errorResult, jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { parseRef } from "../refs";

const kinds = ["draft", "brain_notes", "voice_analysis", "product_facts", "campaign_brief", "voice_calibration", "angle_classification"] as const;

export const taskTools: readonly V2Tool[] = [
  defineTool({
    name: "start_task", kind: "write",
    description: "Prepare a bounded judgment with frozen context and item IDs; grants no approval. See engager-status.",
    input: z.object({ kind: z.enum(kinds), campaignId: z.number().int().positive().optional(), refs: z.array(z.string()).optional(), productId: z.number().int().positive().optional(), sourceText: z.string().optional(), name: z.string().optional() }).strict(),
    handler: async ({ ctx, signal }, input) => {
      const refs = input.refs?.map((ref) => parseRef(ref, ["post"]));
      if (refs && (input.kind !== "draft" || refs.length !== 1)) return errorResult("This task accepts one post ref for a requested draft.", { code: "invalid_refs", status: 400 });
      const post = refs?.[0];
      return jsonResult(await startTask(ctx, { taskKind: input.kind, campaignId: input.campaignId, productId: input.productId, sourceText: input.sourceText, ...(input.name && input.kind === "product_facts" ? { productName: input.name } : {}), ...(input.name && input.kind === "campaign_brief" ? { campaignName: input.name } : {}), ...(post?.kind === "post" ? { requestedPostId: post.id } : {}) }, signal));
    },
  }),
  defineTool({
    name: "get_task", kind: "read",
    description: "Read one task, or list open and owed tasks and the host's judgment policy. See engager-status.",
    input: z.object({ id: z.string().uuid().optional() }).strict(),
    handler: async ({ ctx, signal }, { id }) => {
      if (id) return jsonResult(await getTask(ctx, id, false, signal));
      return withOrg(ctx.organizationId, async (tx) => {
        const open = await listOpenTasks(tx);
        const policy = await resolveJudgmentPolicy(tx);
        return jsonResult({ open, owed: await listOwedTasks(tx, open), kinds, policy, mode: modeFor(policy) });
      });
    },
  }),
  defineTool({
    name: "finish_task", kind: "write",
    description: "Submit frozen item judgments or cancel unfinished work; identical receipts replay. See engager-status.",
    input: z.object({ id: z.string().uuid(), contextRevision: TaskSubmission.shape.contextRevision, idempotencyKey: TaskSubmission.shape.idempotencyKey, items: TaskSubmission.shape.items.optional(), incompleteIds: z.array(z.string()).max(20).optional(), cancel: z.boolean().optional() }).strict(),
    handler: async ({ ctx, signal }, input) => {
      if (input.cancel) {
        if (input.items?.length || input.incompleteIds?.length) return errorResult("Cancel cannot include items.", { code: "invalid_request", status: 400 });
        return jsonResult(await cancelTask(ctx, { taskId: input.id, contextRevision: input.contextRevision, idempotencyKey: input.idempotencyKey }, signal));
      }
      try {
        return jsonResult(await finishTask(ctx, { taskId: input.id, contextRevision: input.contextRevision, idempotencyKey: input.idempotencyKey, items: input.items ?? [], incompleteIds: input.incompleteIds ?? [] }, signal));
      } catch (error) {
        if (error instanceof UnfrozenItemError) return errorResult("unfrozen_item", { code: error.code, status: error.status, data: error.data });
        throw error;
      }
    },
  }),
];
