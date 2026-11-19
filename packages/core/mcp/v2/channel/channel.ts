import { z } from "zod";
import { WindowPlaceSchema } from "../../../linkedin/browser-use/protocol";
import { AppError } from "@engager/common/errors";
import { withOrg } from "@engager/database/tenant";
import { applyKillSwitch, getOrgSafety, getOwnPostReplies, updateOrgSafety, updateOwnPostReplies } from "../../../operations/orgSettings";
import { READ_CAP_ADVISORY, SEARCH_CAP_ADVISORY } from "../../../operations/readBudgets";
import { OWN_POST_LIMIT } from "../../../linkedin/driver";
import { linkedInConnectionState, probeLinkedInSession } from "../../../linkedin/liveness";
import { isGrant } from "../../../connector/resolve";
import { discoverBudget } from "../../../ratelimit/ledger";
import { rateLimitState } from "../../../operations/observability";
import { accountConversationPolicy } from "../../../actions/policy";
import { waitingAccountChanges } from "../../../chat/proposals";
import { clearChannelPause } from "../../../ratelimit/killswitch";
import { scopeRef, stopScope, resumeScope } from "../../../actions/pause";
import { findPerson } from "../../../people/directory";
import { readAccountPolicyState, prepareAccountPolicy, ACCOUNT_POLICY_UPDATE, accountPolicyUpdateSchema } from "../../../strategy/accountPolicy";
import { submitAccountPolicy } from "../../../strategy/submit";
import { modeFor } from "../../../strategy/mode";
import { accountLiveChecks } from "../../../liveChecks/records";
import { untrusted } from "../../../ai/prompts";
import { mcpOperationActor } from "../../context";
import { assertHostedMcpExternalPhase } from "../../tools/hostedSpend";
import { errorResult, jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { parseRef } from "../refs";
import { readOwnerTimeZone } from "../../../ownerClock";

const positive = z.number().int().positive();
const searchCap = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const number = z.number().finite().optional();
const limits = z.object({
  dailyCap: number, minGap: number,
  window: z.object({ start: z.string(), end: z.string(), tz: z.string() }).nullable().optional(),
  warmup: number,
  dailyEngageCap: number, minActionGapSec: number, dailyCommentCap: number, dailyReplyCap: number,
  perProfileDayCap: number, perProfileWeekCap: number, perProfileMonthCap: number,
  minDelaySec: number, warmupWeeks: number, warmupStartRate: number.nullable(),
  activeHours: z.object({ start: z.string(), end: z.string(), tz: z.string() }).nullable().optional(),
  activeDays: z.array(z.string()).nullable().optional(), dailyThreadReadCap: number,
  dailyProfileReadCap: number, dailySearchPageCap: searchCap, hourlySearchCap: searchCap,
  dailyReplyCheckCap: number, replyCheckBaseMin: number, inboxCheckBaseMin: number,
  writeAhead: z.enum(["next_few", "rest_of_day"]).optional(),
}).strict();
const ownPostReplies = z.object({ mode: z.enum(["off", "review", "auto"]).optional(), sensitivity_gate: z.boolean().optional(), prompt: z.string().min(1).max(2000).optional() }).strict();

export const channelTools: readonly V2Tool[] = [
  defineTool({
    name: "get_channel", kind: "read",
    description: "Read the LinkedIn account, its limits and policy. See engager-status for the playbook.",
    input: z.object({ include: z.array(z.enum(["connection", "limits", "policy", "own_posts", "own_post_replies", "live_checks"])).optional(), probe: z.boolean().optional(), waitForSignInMs: z.number().int().min(0).max(90000).optional(), recheck: z.boolean().optional(), openSignIn: z.boolean().optional(), place: WindowPlaceSchema.optional() }).strict(),
    handler: async ({ ctx, signal }, { include, probe, waitForSignInMs, recheck, openSignIn, place }) => {
      const external: Record<string, unknown> = {};
      if (probe) {
        await assertHostedMcpExternalPhase(ctx, signal, "feed:read");
        const grant = await ctx.grant("session");
        external.probe = isGrant(grant)
          ? await probeLinkedInSession(grant.use, ctx.organizationId, { connector: grant.connector, waitForSignInMs, recheck, openSignIn, place })
          : { connected: false, reason: grant };
      }
      if (include?.includes("own_posts")) {
        const connection = await withOrg(ctx.organizationId, (tx) => linkedInConnectionState(tx));
        if (connection.status === "no_session" || connection.status === "not_configured" || connection.status === "needs_signin") {
          external.ownPosts = { connected: false, status: connection.status };
        } else {
          await assertHostedMcpExternalPhase(ctx, signal, "feed:read");
          const grant = await ctx.grant("own_content");
          external.ownPosts = isGrant(grant)
            ? untrusted("OWN POSTS", JSON.stringify(await grant.use.fetchOwnPosts(OWN_POST_LIMIT)))
            : { connected: false, reason: grant };
        }
      }
      return withOrg(ctx.organizationId, async tx => {
        const parts = include ?? ["connection", "limits", "policy", "own_post_replies", "live_checks"];
        const result: Record<string, unknown> = { ...external, timezone: await readOwnerTimeZone(tx) };
        if (parts.includes("connection")) result.connection = await linkedInConnectionState(tx);
        if (parts.includes("limits")) {
          const now = Date.now();
          const searches = await discoverBudget(tx, null, now);
          result.limits = { ...(await getOrgSafety(tx, ctx.organizationId)), rate: await rateLimitState(tx), searches: {
            day: { ...searches.day, freesAt: searches.day.oldest === null ? null : searches.day.oldest + 86_400_000 },
            hour: { ...searches.hour, freesAt: searches.hour.oldest === null ? null : searches.hour.oldest + 3_600_000 },
          } };
        }
        if (parts.includes("policy")) {
          const now = Date.now();
          const state = await readAccountPolicyState(tx, { lock: false, now });
          // Numbers and hours only: the account keeps no mode per action, so the `grants` and `max_mode` an older default still stores are not shown.
          const { budgets, schedule } = state.base;
          result.policy = { channelId: state.channel.id, version: state.active?.version ?? null, budgets, schedule, conversation: await accountConversationPolicy(tx), waiting: await waitingAccountChanges(tx, now) };
        }
        if (parts.includes("own_post_replies")) {
          const policy = await getOwnPostReplies(tx, ctx.organizationId);
          result.ownPostReplies = policy && { ...policy, resolution: await modeFor(tx, { ownPost: policy }) };
        }
        if (parts.includes("live_checks")) result.liveChecks = await accountLiveChecks(tx);
        return jsonResult(result);
      });
    },
  }),
  defineTool({
    name: "update_channel", kind: "write",
    description: "Change account limits, policy or own-post replies. Send a widening alone; mixed changes are refused. Widenings wait for the owner in Engager. See engager-status.",
    input: z.object({ limits: limits.optional(), policy: accountPolicyUpdateSchema.omit({ kind: true }).optional(), expectedVersion: positive.nullable().optional(), ownPostReplies: ownPostReplies.optional() }).strict(),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      const result: Record<string, unknown> = {};
      if (input.ownPostReplies?.mode) {
        const current = await getOwnPostReplies(tx, ctx.organizationId);
        const rank = { off: 0, review: 1, auto: 2 } as const;
        if (rank[input.ownPostReplies.mode] > rank[current?.mode ?? "off"]) {
          const others = [...(input.limits ? ["limits"] : []), ...(input.policy ? ["policy"] : []), ...Object.keys(input.ownPostReplies).filter(key => key !== "mode").map(key => `ownPostReplies.${key}`)];
          if (others.length) throw new AppError("mixed_change", `Nothing changed. Widening: ownPostReplies.mode; other fields: ${others.join(", ")}. Send the other fields first, then the widening alone.`, 409);
          return errorResult("Confirm this widening in Engager.", { code: "needs_owner_confirmation", status: 409 });
        }
      }
      // Submit policy before other fields so a mixed widening rolls back whole.
      if (input.policy) {
        const now = Date.now();
        const change = input.policy;
        const policyFields = Object.keys(input.policy).filter(key => key !== "action");
        if (policyFields.length > 1) {
          const state = await readAccountPolicyState(tx, { lock: true, now });
          const widening = policyFields.find(field => {
            try {
              const part = { kind: ACCOUNT_POLICY_UPDATE, ...(change.action ? { action: change.action } : {}), [field]: change[field as keyof typeof change] };
              return prepareAccountPolicy(state, accountPolicyUpdateSchema.parse(part), now).level === "confirm";
            } catch { return false; }
          });
          if (widening) {
            const others = [...policyFields.filter(field => field !== widening).map(field => `policy.${field}`), ...(input.limits ? ["limits"] : []), ...(input.ownPostReplies ? ["ownPostReplies"] : [])];
            throw new AppError("mixed_change", `Nothing changed. Widening: policy.${widening}; other fields: ${others.join(", ")}. Send the other fields first, then the widening alone.`, 409);
          }
        }
        const outcome = await submitAccountPolicy(tx, ctx.organizationId, { kind: ACCOUNT_POLICY_UPDATE, ...change }, { approver: mcpOperationActor(ctx), now, expectedVersion: input.expectedVersion !== undefined ? input.expectedVersion : (await readAccountPolicyState(tx, { lock: false, now })).active?.version ?? null });
        result.policy = { ...outcome, status: "proposed" in outcome ? "proposed" : "applied" };
        const notApplied = (["limits", "ownPostReplies"] as const).filter(field => input[field]);
        if ("proposed" in outcome && notApplied.length) throw new AppError("mixed_change", `Nothing changed. Widening: policy; other fields: ${notApplied.join(", ")}. Send the other fields first, then the widening alone.`, 409);
      }
      if (input.limits) {
        const { dailyCap, minGap, window, warmup, ...pacing } = input.limits;
        result.limits = await updateOrgSafety(tx, ctx.organizationId, { ...pacing,
          ...(dailyCap !== undefined ? { dailyEngageCap: dailyCap } : {}),
          ...(minGap !== undefined ? { minActionGapSec: minGap } : {}),
          ...(window !== undefined ? { activeHours: window } : {}),
          ...(warmup !== undefined ? { warmupWeeks: warmup } : {}),
        });
        const warnings: string[] = [];
        if ((input.limits.dailySearchPageCap ?? 0) > SEARCH_CAP_ADVISORY.daily) warnings.push(`More than ${SEARCH_CAP_ADVISORY.daily} searches a day is not recommended.`);
        if ((input.limits.hourlySearchCap ?? 0) > SEARCH_CAP_ADVISORY.hourly) warnings.push(`More than ${SEARCH_CAP_ADVISORY.hourly} searches an hour is not recommended.`);
        if ((input.limits.dailyThreadReadCap ?? 0) > READ_CAP_ADVISORY) warnings.push(`More than ${READ_CAP_ADVISORY} post reads a day is not recommended.`);
        if ((input.limits.dailyProfileReadCap ?? 0) > READ_CAP_ADVISORY) warnings.push(`More than ${READ_CAP_ADVISORY} profile reads a day is not recommended.`);
        result.warnings = warnings;
      }
      if (input.ownPostReplies) {
        const policy = await updateOwnPostReplies(tx, ctx.organizationId, input.ownPostReplies);
        result.ownPostReplies = policy && { ...policy, resolution: await modeFor(tx, { ownPost: policy }) };
      }
      return jsonResult(result);
    }),
  }),
  defineTool({
    name: "stop", kind: "write",
    description: "Stop or resume an account, campaign or person's conversation. Resuming does not replay cancelled work. See engager-status.",
    input: z.object({ scope: z.enum(["account", "campaign", "person"]), campaignId: positive.optional(), campaignIds: z.array(positive).min(1).max(50).optional(), ref: z.string().optional(), kind: z.enum(["stop", "kill_switch"]), on: z.boolean(), clearAutoPause: z.boolean().optional() }).strict(),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      if (input.kind === "kill_switch") {
        if (input.scope !== "account") return errorResult("The kill switch applies to the account.", { code: "invalid_input" });
        await applyKillSwitch(tx, ctx.organizationId, input.on);
        if (input.clearAutoPause) await clearChannelPause(tx);
        return jsonResult({ killSwitch: input.on });
      }
      if (input.campaignIds) {
        // Several campaigns at once: each its own stop, as if asked one by one.
        if (input.scope !== "campaign" || input.campaignId !== undefined) return errorResult("campaignIds go with scope campaign, alone.", { code: "invalid_input" });
        const by = mcpOperationActor(ctx);
        const campaigns = [];
        for (const campaignId of new Set(input.campaignIds)) {
          const target = await scopeRef(tx, "campaign", campaignId);
          campaigns.push({ campaignId, ...(input.on ? await stopScope(tx, { ...target, by }) : await resumeScope(tx, { ...target, by })) });
        }
        return jsonResult({ campaigns });
      }
      let scopeId = input.campaignId;
      if (input.scope === "person") {
        if (!input.ref) return errorResult("A person ref is required.", { code: "invalid_input" });
        const ref = parseRef(input.ref, ["person"]);
        if (ref.kind !== "person") throw new Error("unreachable");
        const person = await findPerson(tx, ref.key);
        if (!person?.conversationId) return errorResult("No open conversation for this person.", { code: "scope_not_found" });
        scopeId = person.conversationId;
      }
      const scope = input.scope === "person" ? "conversation" : input.scope;
      if (scope === "campaign" && !scopeId) return errorResult("A campaign id is required.", { code: "invalid_input" });
      const target = await scopeRef(tx, scope, scope === "account" ? undefined : scopeId);
      const by = mcpOperationActor(ctx);
      const outcome = input.on ? await stopScope(tx, { ...target, by }) : await resumeScope(tx, { ...target, by });
      if (input.clearAutoPause) await clearChannelPause(tx);
      return jsonResult(outcome);
    }),
  }),
];
