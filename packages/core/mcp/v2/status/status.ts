import { z } from "zod";
import { commercialProjection } from "@engager/billing/projection";
import { withOrg } from "@engager/database/tenant";
import { getSetupState, completeMcpSetup, SetupWorkflowRequiredError } from "../../../operations/setup";
import { setupHandoff } from "../../../operations/setupHandoff";
import { deriveSetupCardProgress, setupStateNext } from "../../../operations/setupProgress";
import { advanceGuidedSetup, lockGuidedSetup, readGuidedSetup } from "../../../operations/guidedSetup";
import { mergeFirstCampaignDraft } from "../../../operations/firstCampaignDraft";
import { stampLinkedinRiskAcknowledged, readLinkedinRiskAcknowledgedAt } from "../../../operations/workers";
import { listWorkers } from "../../../operations/workers";
import { getSystemState } from "../../../ratelimit/killswitch";
import { linkedInConnectionState } from "../../../linkedin/liveness";
import { aiUsageStats, briefStats, learningStats, listOrgJobs, opsMetrics } from "../../../operations/observability";
import { getModelSettings, updateModelSettings } from "../../../operations/modelSettings";
import { renameOrganization } from "../../../operations/orgSettings";
import { listSkills } from "../../../skills/registry";
import { skillFreshness, skillFreshnessDirective, skillHold, SETUP_WORKFLOW_SKILL } from "../../../skills/freshness";
import { listOpenTasks } from "../../../tasks/task";
import { listOwedTasks } from "../../../tasks/owed";
import { parseReceipt, receiptRowShape, RECEIPT_MAX_ROWS } from "../../../conversations/receipt";
import { importReceipt } from "../../../conversations/recordOutcome";
import { mcpOperationActor } from "../../context";
import { jsonResult, errorResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { untrusted } from "../../../ai/prompts";
import { readOwnerTimeZone } from "../../../ownerClock";

const id = z.number().int().positive();
const blocks = z.enum(["setup", "health", "queue", "jobs", "usage", "billing", "learning", "models"]);
const loadedSkillsInput = z.array(z.object({ name: z.string().max(64).optional(), version: z.string().max(32).optional() })).max(20).optional();
const invalid = (message: string) => errorResult(message, { code: "invalid_input", status: 400 });

export const statusTools: readonly V2Tool[] = [
  defineTool({
    name: "get_status", kind: "read",
    description: "Read install status and selected details. See engager-status for the workflow.",
    input: z.object({ include: z.array(blocks).optional(), jobsBefore: z.string().max(200).optional(), jobsLimit: z.number().int().min(1).max(200).optional(), loadedSkills: loadedSkillsInput }),
    handler: async ({ ctx }, { include, jobsBefore, jobsLimit, loadedSkills }) => {
      let before: { updatedAt: number; id: number } | undefined;
      if (jobsBefore !== undefined) {
        try {
          const parsed = z.object({ updatedAt: z.number().int().nonnegative(), id: z.number().int().positive() }).strict().safeParse(JSON.parse(Buffer.from(jobsBefore, "base64url").toString("utf8")));
          if (!parsed.success) return invalid("Invalid jobsBefore cursor.");
          before = parsed.data;
        } catch { return invalid("Invalid jobsBefore cursor."); }
      }
      const manifests = listSkills();
      return withOrg(ctx.organizationId, async (tx) => {
      const wanted = new Set(include ?? ["setup", "health"]);
      // Every block's times are said in it (`ownerClock.ts`); null means say them relative to now.
      const out: Record<string, unknown> = { timezone: await readOwnerTimeZone(tx) };
      if (wanted.has("setup")) {
        const connection = await linkedInConnectionState(tx);
        const hold = skillHold({ manifests, loaded: loadedSkills, name: SETUP_WORKFLOW_SKILL });
        const state = await getSetupState(tx, ctx.organizationId, { linkedInConnected: connection.connected, ...(hold.held === null ? {} : { workflowLoaded: hold.held }) });
        const pendingTasks = await listOpenTasks(tx);
        const owedTasks = await listOwedTasks(tx, pendingTasks);
        const progress = deriveSetupCardProgress(state, owedTasks);
        const skills = skillFreshness({ manifests, loaded: loadedSkills });
        const directive = skillFreshnessDirective(skills);
        const next = setupStateNext(state, progress.currentStep, pendingTasks.length > 0, false, owedTasks);
        out.setup = { ...state, ...progress, next: directive ? `${next} ${directive}` : next, pendingTasks, owedTasks, skills };
      }
      if (wanted.has("health")) {
        const state = await getSystemState(tx);
        out.health = { killSwitch: state?.killSwitch ?? false, pausedReason: state?.pausedReason ?? null, pausedUntil: state?.pausedUntil ?? null, paused: !!(state?.killSwitch || (state?.pausedUntil && state.pausedUntil > Date.now())), linkedinRiskAcknowledgedAt: await readLinkedinRiskAcknowledgedAt(tx, ctx.organizationId), connection: await linkedInConnectionState(tx), operations: await opsMetrics(tx) };
      }
      if (wanted.has("queue")) out.queue = await opsMetrics(tx);
      if (wanted.has("jobs")) {
        const limit = jobsLimit ?? 200;
        const result = await listOrgJobs(tx, ctx.organizationId, { limit: limit + 1, before });
        const workers = new Map((await listWorkers(tx)).map((worker) => [worker.id, worker.campaignId]));
        const page = result.rows.slice(0, limit);
        const last = page.at(-1);
        out.jobs = { total: result.total, nextBefore: result.rows.length > limit && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString("base64url") : null, rows: page.map(({ payload, ...row }) => {
          const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
          const workerId = typeof data.workerId === "number" ? data.workerId : null;
          return { ...row, lastError: row.lastError === null ? null : untrusted("JOB ERROR", row.lastError), campaignId: data.campaignId ?? (workerId === null ? null : workers.get(workerId) ?? null), workerId };
        }) };
      }
      if (wanted.has("usage")) out.usage = await aiUsageStats(tx, ctx.organizationId);
      if (wanted.has("billing")) out.billing = await commercialProjection(tx, ctx.organizationId);
      if (wanted.has("learning")) out.learning = { ...(await learningStats(tx, ctx.organizationId)), briefs: await briefStats(tx) };
      if (wanted.has("models")) out.models = await getModelSettings(tx, ctx.organizationId);
      return jsonResult(out);
      });
    },
  }),
  defineTool({
    name: "complete_setup", kind: "write", description: "Record a setup step; unfinished setup is refused. See engager-setup.",
    input: z.object({ step: z.enum(["acknowledge_risk", "skip_product", "done"]), loadedSkills: loadedSkillsInput }),
    handler: async ({ ctx }, { step, loadedSkills }) => withOrg(ctx.organizationId, async (tx) => {
      if (step === "acknowledge_risk") {
        await stampLinkedinRiskAcknowledged(tx, ctx.organizationId, Date.now());
        return jsonResult({ ok: true, linkedinRiskAcknowledgedAt: await readLinkedinRiskAcknowledgedAt(tx, ctx.organizationId) });
      }
      if (step === "skip_product") {
        const state = await readGuidedSetup(tx, ctx.organizationId);
        if (!state.accountId) return invalid("No connected account for guided setup.");
        const locked = await lockGuidedSetup(tx, ctx.organizationId, state.accountId);
        if (locked.step === "product") await mergeFirstCampaignDraft(tx, ctx.organizationId, { productId: null });
        await advanceGuidedSetup(tx, ctx.organizationId, state.accountId);
      } else {
        try {
          await completeMcpSetup(tx, ctx.organizationId, { linkedInConnected: (await linkedInConnectionState(tx)).connected, loadedSkills });
        } catch (error) {
          if (error instanceof SetupWorkflowRequiredError) return errorResult(error.message, { code: error.code, status: error.status, recovery: error.recovery, data: error.data });
          throw error;
        }
        return jsonResult({ ok: true, onboardingStep: "done", handoff: await setupHandoff(tx) });
      }
      return jsonResult({ ok: true });
    }),
  }),
  defineTool({
    name: "import_data", kind: "write", description: "Import owner-provided receipts; supply rows or CSV. See engager-status.",
    input: z.object({ kind: z.literal("receipts"), campaignId: id, rows: z.array(z.object(receiptRowShape).strict()).max(RECEIPT_MAX_ROWS).optional(), csv: z.string().max(200000).optional() }),
    handler: async ({ ctx }, { campaignId, rows, csv }) => {
      if ((rows === undefined) === (csv === undefined)) return invalid("Supply exactly one of rows or csv.");
      const parsed = parseReceipt({ rows, csv });
      if (!parsed.ok) return errorResult(parsed.message, { code: "receipt_invalid", status: 422 });
      const result = await withOrg(ctx.organizationId, (tx) => importReceipt(tx, { campaignId, rows: parsed.rows, recordedBy: mcpOperationActor(ctx), now: Date.now() }));
      return result.ok ? jsonResult(result) : errorResult(result.message, { code: result.reason, status: 422 });
    },
  }),
  defineTool({
    name: "update_settings", kind: "write", description: "Change model roles or the account name. Agent selection stays in the app. See engager-status.",
    input: z.object({ models: z.object({ filter: z.string().nullable().optional(), writer: z.string().nullable().optional(), writerPremium: z.string().nullable().optional(), chat: z.string().nullable().optional() }).optional(), orgName: z.string().min(1).max(120).optional() }),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async (tx) => jsonResult({
      ...(input.models ? { models: await updateModelSettings(tx, ctx.organizationId, { models: input.models }) } : {}),
      ...(input.orgName !== undefined ? { organization: await renameOrganization(tx, ctx.organizationId, input.orgName) } : {}),
    })),
  }),
];
