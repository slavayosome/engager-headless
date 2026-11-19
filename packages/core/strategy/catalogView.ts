import type { Tx } from "@engager/database/tenant";
import { zodToJsonSchema } from "zod-to-json-schema";
import { WORKER_CATALOG, ACTION_KIND_OWNERS, ACTION_MODES, READ_MODES, MODE_KEYS, MODE_GRANTS, BUDGETED_MODE_KEYS, CAPABILITIES, RETIRED_CAPABILITIES, CATALOG_STEPS, STEP_ENTRIES, type BudgetedModeKey, type CapabilityId, type ModeKey } from "./catalog";
import { hasCeiling } from "./resolve";
import { CAMPAIGN_TEMPLATES } from "./templates";
import { strategyShape } from "./contract";
import { strategyPatchSchema } from "./patch";
import { SEARCH_DEPTH_LABELS } from "./searchDepth";
import { readAccountPolicyState } from "./accountPolicy";
import { getOrgSafety } from "../operations/orgSettings";
import { discoverBudget } from "../ratelimit/ledger";
import { SEARCH_CAP_ADVISORY } from "../operations/readBudgets";
import { getCampaign } from "../operations/campaigns";
import { AppError } from "@engager/common/errors";
import { channels } from "@engager/database/schema";
import { eq } from "drizzle-orm";
import { readAccountDefault } from "./activate";
import { accountDefaultSeed } from "./seed";
import { NETWORK_CATALOGS } from "./catalog";
import { catalogStepTemplate, type HireableStepId } from "./addStep";
import { audienceProfileInputSchema } from "../audience/model";
import { leadRunShapeFor } from "../leads/scout/shape";

type Part = "workers" | "steps" | "actions" | "modes" | "parameters" | "templates" | "ceilings";

function compactSchema(value: unknown, inProperties = false): unknown {
  if (Array.isArray(value)) return value.map(item => compactSchema(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => inProperties || key !== "description").map(([key, item]) => [key, compactSchema(item, key === "properties")]));
}

export async function catalogView(tx: Tx, organizationId: string, options: { include?: Part[]; campaignId?: number }) {
  const wants = (part: Part) => !options.include || options.include.includes(part);
  const campaign = options.campaignId === undefined ? undefined : await getCampaign(tx, options.campaignId);
  if (options.campaignId !== undefined && !campaign) {
    throw new AppError("campaign_not_found", `campaign ${options.campaignId} not found`, 404);
  }
  const channel = campaign?.channelId == null ? undefined : (await tx.select().from(channels).where(eq(channels.id, campaign.channelId)))[0];
  const policy = wants("ceilings") || wants("actions") ? channel
    ? (await readAccountDefault(tx, channel.id, { network: NETWORK_CATALOGS[channel.network] }))?.document ?? accountDefaultSeed(channel.activeHours?.tz ?? "UTC", Date.now())
    : (await readAccountPolicyState(tx, { lock: false, now: Date.now() })).base : undefined;
  const budget = wants("ceilings") ? await discoverBudget(tx, options.campaignId ?? null) : undefined;
  const ceilings = budget ? {
    policy: policy && { budgets: policy.budgets },
    safety: channel ? { dailyThreadReadCap: channel.dailyThreadReadCap, dailyProfileReadCap: channel.dailyProfileReadCap, dailySearchPageCap: channel.dailySearchPageCap, hourlySearchCap: channel.hourlySearchCap } : await getOrgSafety(tx, organizationId),
    searches: budget,
    // The binding limits a strategy's depth and pages are spent against, with where each comes from.
    searchLimits: {
      dailySearchPageCap: { value: budget.day.limit, source: budget.day.source },
      hourlySearchCap: { value: budget.hour.limit, source: budget.hour.source },
    },
    advisory: SEARCH_CAP_ADVISORY,
  } : undefined;
  return {
    ...(wants("workers") && { workers: WORKER_CATALOG }),
    ...(wants("steps") && { steps: Object.fromEntries(Object.entries(CATALOG_STEPS).map(([id, step]) => {
      const template = id === "write_post" ? null : catalogStepTemplate(id as HireableStepId);
      return [id, { ...step, entries: STEP_ENTRIES[id as keyof typeof STEP_ENTRIES], ...(template ? { objective: template.step.objective, bindings: template.bindings } : { objective: "Write a post", bindings: [] }) }];
    })) }),
    ...(wants("actions") && { actions: Object.fromEntries(Object.entries(CAPABILITIES).filter(([id]) => !RETIRED_CAPABILITIES.includes(id as CapabilityId))), owners: ACTION_KIND_OWNERS, networkActions: NETWORK_CATALOGS.linkedin.actions.map(action => {
      const key: ModeKey | null = action.stored && action.stored !== "step_switch" ? action.stored : null;
      // A step's Automatic stays Ask me until the account's number for it is set (`hasCeiling`).
      const needsNumber = key !== null && (BUDGETED_MODE_KEYS as readonly ModeKey[]).includes(key) && !hasCeiling(policy ?? null, key as BudgetedModeKey);
      return { step: action.step, kind: action.kind, label: action.label, capability: action.capability, modes: action.modes, defaultMode: action.modes ? "off" : null, needsNumber, connector: CAPABILITIES[action.capability].connector };
    }) }),
    ...(wants("modes") && { modes: { actions: ACTION_MODES, reads: READ_MODES, keys: MODE_KEYS, grants: MODE_GRANTS } }),
    ...(wants("parameters") && { parameters: { strategy: compactSchema(zodToJsonSchema(strategyShape)), patch: compactSchema(zodToJsonSchema(strategyPatchSchema)), audience: compactSchema(zodToJsonSchema(audienceProfileInputSchema)), searchDepth: SEARCH_DEPTH_LABELS, depthShapes: Object.fromEntries((["quick", "standard", "deep"] as const).map(depth => [depth, leadRunShapeFor(depth)])) } }),
    ...(wants("templates") && { templates: CAMPAIGN_TEMPLATES }),
    ...(ceilings && { ceilings }),
  };
}
