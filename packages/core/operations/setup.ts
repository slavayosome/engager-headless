import { and, count, desc, eq } from "drizzle-orm";
import {
  brainQuestions,
  brainState,
  campaignProducts,
  campaigns,
  jobs,
  memberships,
  organizations,
  productFacts,
  products,
} from "@engager/database/schema";
import { afterCommit, type Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import { checkoutConfigured, getOrgPlan } from "@engager/billing/plans";
import { AppError } from "@engager/common/errors";
import {
  agentCliStatusAsync,
  type AgentCliStatus,
} from "../ai/agentCli";
import { resolvedRoleModels } from "../ai/modelRoles";
import { getProfile } from "../profile";
import { getSystemState } from "../ratelimit/killswitch";
import { channelCeilings as loadChannelCeilings } from "../ratelimit/ledger";
import { isSupportedPublicCampaignRuntime } from "./campaigns";
import { localSetupContract } from "./setupContract";
import { config } from "../config";
import { listNotes } from "../brain/vault";
import { computeLearningSignals, type LearningSignals } from "./learningSignals";
import { skillHold, SETUP_WORKFLOW_SKILL, type LoadedSkill } from "../skills/freshness";
import { listSkills } from "../skills/registry";
import { skillInstallCommand, skillInstallOrigin } from "../skills/install";

/**
 * Everything an agent needs to know about how far this org's setup has come and
 * what still blocks going live — the MCP twin of the dashboard onboarding wizard's
 * consolidated poll (`getOnboardingState`), widened to the full go-live checklist.
 * One short transaction, no network: connection state comes from secret metadata,
 * voice/ingest progress from the durable jobs table.
 */
export type SetupState = {
  /** Org-level learning signals, derived on read: calibration cycles, warm-up
   *  state, and the measurement families under telemetry. Informational only —
   *  nothing here withholds a capability. */
  learningSignals: LearningSignals;
  /** WHO THINKS in the background: the agent CLI on this machine that serves
   *  every `json()` call behind discovery enrichment, Brain seeding, product
   *  ingest and drafting — which one, whether its binary is there, and the
   *  refusal itself when selection has one.
   *
   *  Here because the refusals it carries used to reach the owner ONLY as a
   *  stack trace on the first background job, hours after `engager init`
   *  reported success: a pinned agent that cannot serve schema-constrained
   *  output, and a role model the resolved agent does not declare. */
  agent: AgentCliStatus;
  onboardingStep: string | null;
  linkedin: { connected: boolean };
  voice: {
    /** idle = not started; learning = import job in flight; done = voice saved;
     *  failed = the latest import job dead-lettered with no voice saved. */
    stage: "idle" | "learning" | "done" | "failed";
    persisted: boolean;
  };
  products: {
    count: number;
    /** Mirrors products.ingestStage of the most recent product (null = no
     *  crawlable link or the ingest job hasn't stamped yet). */
    ingestStage: "crawling" | "suggesting" | "done" | "failed" | null;
    factCount: number;
  };
  brain: {
    fillScore: number;
    knowledgeCount: number;
    pendingQuestions: number;
    /** The LinkedIn-connect background seed finished without landing any docs
     *  (transient provider failure or a too-thin post history). Inline hosted
     *  seeding can be denied before activation, so the agent should seed via
     *  thin writes instead: get_channel → save_knowledge. */
    seedStalled: boolean;
  };
  campaigns: {
    total: number;
    active: number;
    /** Active campaigns that conform to the public agent-first ladder. */
    supportedActive: number;
    /** Supported Product campaigns with at least one attached product. */
    readyActive: number;
  };
  subscription: { plan: string; checkoutConfigured: boolean };
  safety: {
    killSwitch: boolean;
    dailyEngageCap: number;
    minActionGapSec: number;
  };
  /** Derived setup checklist, in the order the setup skill walks it. `blocking`
   *  marks items that must be done before live posting can work at all. */
  checklist: { item: string; done: boolean; blocking: boolean }[];
};

export { localSetupContract };

export async function getSetupState(
  tx: Tx,
  organizationId: string,
  opts: {
    /** Does the caller hold the setup workflow? A caller fact, not org state,
     *  so it is supplied rather than read. Leave it `undefined` when the
     *  question does not apply to this caller — the checklist then omits the
     *  item entirely rather than showing one nobody can act on. The web wizard
     *  does exactly that: it IS the workflow. */
    workflowLoaded?: boolean;
    /** Caller-supplied connection truth for the local connector contract: the
     *  MCP tool layer passes `linkedInConnectionState`'s own answer, from the
     *  channel row it resolved, under localSetupContract. A caller that
     *  leaves it undefined reads as not connected. */
    linkedInConnected?: boolean;
  } = {},
): Promise<SetupState> {
  // organizations/jobs are identity/global tables (not RLS-scoped) → filter by org
  // explicitly; everything else is scoped by the withOrg GUC.
  const [org] = await tx
    .select({
      onboardingStep: organizations.onboardingStep,
      onboardingExecutionMode: organizations.onboardingExecutionMode,
      onboardingFirstRunChoice: organizations.onboardingFirstRunChoice,
      onboardingHostApprovalState: organizations.onboardingHostApprovalState,
      modelOverrides: organizations.modelOverrides,
      agentCliBin: organizations.agentCliBin,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  // The ceilings moved to the connected account (INV-4). Read through the
  // phase's single channel-row loader, not a second select of the same row.
  const channel = await loadChannelCeilings(tx);

  const connected = opts.linkedInConnected ?? false;
  const prof = await getProfile(tx);

  // Voice comes from the saved profile; the Brain seed job reports its own progress.
  const persisted = Boolean(prof.voicePersona?.trim());
  const [seedJob] = connected
    ? await tx
        .select({ status: jobs.status })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organizationId),
            eq(jobs.type, "seed_brain"),
          ),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(1)
    : [];
  const voiceStage: SetupState["voice"]["stage"] = persisted ? "done" : "idle";
  const importSettled =
    seedJob?.status === "done" ||
    seedJob?.status === "failed" ||
    seedJob?.status === "dead";

  const productRows = await tx
    .select({ ingestStage: products.ingestStage })
    .from(products)
    .orderBy(desc(products.updatedAt), desc(products.id));
  const [factAgg] = await tx.select({ n: count() }).from(productFacts);

  const [bs] = await tx
    .select({ fillScore: brainState.fillScore })
    .from(brainState);
  // The Brain's knowledge count resolves from the vault (INV-14): active
  // notes, whatever their slot — the table aggregate this replaced.
  const knowledgeCount = (await listNotes()).length;
  const [pendingAgg] = await tx
    .select({ n: count() })
    .from(brainQuestions)
    .where(eq(brainQuestions.status, "pending"));

  const campaignRows = await tx.select().from(campaigns);
  const productLinks = await tx
    .select({ campaignId: campaignProducts.campaignId })
    .from(campaignProducts);
  const productBackedCampaignIds = new Set(
    productLinks.map((link) => link.campaignId),
  );

  const plan = await getOrgPlan(tx, organizationId);
  const system = await getSystemState(tx);
  // The stored overrides ride along so the probe reports the map and binary
  // inference will actually use, not the env's answer to a question the owner
  // has since re-answered in-app — resolved with the precedence the boundary
  // uses, so a local pin the override does not reach stays the answer here too,
  // and a role running in place of a model its installation does not offer is
  // reported as such.
  const roles = resolvedRoleModels(org?.modelOverrides ?? {});
  // The agent probe rides beside a read it would otherwise wait behind: it is
  // async and memoized (30s), but a memo MISS verifies the selection and its
  // isolation profile — a hash of the selected CLI plus two or three bounded
  // inspections of it — and this transaction is open. Running it concurrently
  // means only its EXCESS over that query is added, not its whole duration —
  // and that excess is real, not nil: `Promise.all` settles on the slower arm,
  // and a cold inspection outruns the query. Each inspection carries its own
  // 5s bound, and the whole thing is paid at most once per memo window, which
  // is what keeps a ~15s `get_status` poll off it.
  const [learningSignals, agent] = await Promise.all([
    computeLearningSignals(tx, organizationId),
    agentCliStatusAsync({
      models: roles.models,
      unoffered: roles.unoffered,
      claudeBin: org?.agentCliBin ?? null,
    }),
  ]);
  const state: Omit<SetupState, "checklist"> = {
    // Derived truth leads the wire (JSON key order is wire order).
    learningSignals,
    agent,
    onboardingStep: org?.onboardingStep ?? null,
    linkedin: { connected },
    voice: { stage: voiceStage, persisted },
    products: {
      count: productRows.length,
      ingestStage: productRows[0]?.ingestStage ?? null,
      factCount: factAgg?.n ?? 0,
    },
    brain: {
      fillScore: bs?.fillScore ?? 0,
      knowledgeCount,
      pendingQuestions: pendingAgg?.n ?? 0,
      seedStalled: connected && importSettled && knowledgeCount === 0,
    },
    campaigns: {
      total: campaignRows.length,
      active: campaignRows.filter((campaign) => campaign.status === "active")
        .length,
      supportedActive: campaignRows.filter(isSupportedPublicCampaignRuntime)
        .length,
      readyActive: campaignRows.filter(
        (campaign) =>
          isSupportedPublicCampaignRuntime(campaign) &&
          productBackedCampaignIds.has(campaign.id),
      ).length,
    },
    subscription: { plan: plan.key, checkoutConfigured: checkoutConfigured() },
    safety: {
      killSwitch: system?.killSwitch ?? false,
      dailyEngageCap: channel?.dailyEngageCap ?? 40,
      minActionGapSec: channel?.minActionGapSec ?? 120,
    },
  };

  const checklist: SetupState["checklist"] = [
    // First because the skill checks it before anything else, and blocking for
    // the same reason connect_linkedin is: walked first, enforced at finish.
    ...(opts.workflowLoaded === undefined
      ? []
      : [
          {
            item: "load_workflow",
            done: opts.workflowLoaded,
            blocking: true,
          },
        ]),
    { item: "connect_linkedin", done: connected, blocking: true },
    {
      item: "seed_brain",
      done: state.brain.knowledgeCount > 0,
      blocking: false,
    },
    // Non-blocking: the local sequence needs no product to finish setup — see
    // the campaign fence below, which no longer reads it either.
    { item: "add_product", done: state.products.count > 0, blocking: false },
    { item: "learn_voice", done: persisted, blocking: false },
    // An archived or paused row is not a launch-ready campaign. AT LEAST one,
    // not exactly one: the one-active-campaign policy lifted with T-8.11, and an
    // owner who set up a second audience must not be told setup is unfinished.
    // Supported-active status is the whole predicate: the product-backed
    // conjunct went with the rest of the product requirement.
    {
      item: "save_campaign",
      done: state.campaigns.supportedActive >= 1,
      blocking: true,
    },
  ];
  return { ...state, checklist };
}

export class SetupLinkedInRequiredError extends AppError {
  readonly recovery =
    "Reconnect LinkedIn, then retry setup completion. Existing billing authority is preserved and is not created again.";

  constructor() {
    super(
      "setup_linkedin_required",
      "Setup cannot finish until this organization has an active LinkedIn connection.",
      409,
    );
  }
}

export class SetupCampaignRequiredError extends AppError {
  readonly recovery =
    "Save a campaign with save_campaign and have the owner start it in Engager, then retry setup completion.";

  constructor() {
    super(
      "setup_campaign_required",
      "Setup cannot finish without at least one active campaign.",
      409,
    );
  }
}

/**
 * The one fence in this family that is NOT about durable org state.
 *
 * Its siblings all assert a fact about the organization — a product exists, the
 * LinkedIn connection is live, charge authority is real — so they belong inside
 * `completeSetup`, where the transaction can see them. This one asserts a fact
 * about the CALLER: does the agent driving setup hold the workflow it is
 * certifying complete? That is true or false per session, so it is raised at
 * the MCP tool boundary from the caller's own `loadedSkills` report and is
 * deliberately absent from `completeSetup`.
 *
 * Do not "fix" that by moving it in. Persisting the report would let "held the
 * skill on Tuesday" stand in for "holds it now", which is precisely the silent
 * half-working state this exists to end. The web wizard is correctly unaffected:
 * a human clicking Finish in a browser IS the workflow.
 */
export class SetupWorkflowRequiredError extends AppError {
  readonly recovery =
    "Load the engager-setup skill, then retry with `loadedSkills`. Run `list_skills` and its `install.command` if your host has a shell; if the host denies it or you have none, call `get_skill_file` for engager-setup/SKILL.md — that path always works. Read the skill, then finish setup. Do not report setup complete until this call succeeds.";

  readonly data: Record<string, unknown>;

  constructor(data: Record<string, unknown> = {}) {
    super(
      "setup_workflow_required",
      "Setup cannot finish until the agent driving it holds the engager-setup workflow.",
      409,
    );
    this.data = data;
  }
}

/** Complete setup for an MCP caller, checking its reported workflow and the
 * organization's durable owner before applying the shared readiness gates. */
export async function completeMcpSetup(
  tx: Tx, organizationId: string,
  opts: { linkedInConnected: boolean; loadedSkills?: LoadedSkill[] },
): Promise<void> {
  const hold = skillHold({ manifests: listSkills(), loaded: opts.loadedSkills, name: SETUP_WORKFLOW_SKILL });
  if (hold.held === false) {
    const origin = skillInstallOrigin();
    throw new SetupWorkflowRequiredError({
      requiredSkill: SETUP_WORKFLOW_SKILL, servedVersion: hold.servedVersion, reported: opts.loadedSkills ?? null,
      install: origin ? { method: "shell", command: skillInstallCommand(origin, "claude"), clients: { claude: skillInstallCommand(origin, "claude"), codex: skillInstallCommand(origin, "codex") } } : null,
      streamFallback: { tool: "get_skill_file", args: { skill: SETUP_WORKFLOW_SKILL, path: "SKILL.md" } },
    });
  }
  const owners = await tx.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.isOwner, true))).limit(2);
  if (owners.length !== 1) throw new AppError("setup_owner_credential_required", "This protected setup step needs the project owner.", 403);
  await completeSetup(tx, organizationId, localSetupContract() ? { linkedInConnected: opts.linkedInConnected } : {});
}

/** Stamp onboarding complete (the wizard's `finishOnboarding`, sans redirect).
 * Three fences, in order, before the stamp: tenancy scope, the LinkedIn
 * connection, and at least one active campaign. No product, no subscription,
 * no interactive-operation stamp — this is the local sequence (T-14.1); a
 * local finish needs no separate authorization call. Workflow
 * possession is enforced one layer out — see `SetupWorkflowRequiredError`. */
export async function completeSetup(
  tx: Tx,
  organizationId: string,
  opts: {
    /** Same contract as getSetupState's linkedInConnected: the channel row's
     *  truth, supplied by the MCP tool layer under localSetupContract only. */
    linkedInConnected?: boolean;
    /** Guided local setup lets the owner add their first Scout later. */
    skipScout?: boolean;
  } = {},
): Promise<void> {
  const linkedInConnected = opts.linkedInConnected ?? false;
  if (!linkedInConnected) throw new SetupLinkedInRequiredError();
  const campaignRows = await tx.select().from(campaigns);
  // AT LEAST one ready campaign, not exactly one. The one-active-campaign policy
  // lifted with T-8.11, and what setup needs is a campaign that works — a second
  // audience is an ordinary account, not an unfinished setup. Supported-active
  // status is the whole predicate: no product, no approval/drafting-mode
  // shape, no onboarding-preview match — those went with the rest of the
  // hosted completion machinery.
  const ready = campaignRows.filter(isSupportedPublicCampaignRuntime);
  if (ready.length === 0 && !(opts.skipScout && localSetupContract())) {
    throw new SetupCampaignRequiredError();
  }
  const [before] = await tx
    .select({ step: organizations.onboardingStep })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  await tx
    .update(organizations)
    .set({
      onboardingStep: "done",
      onboardingCompletedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(organizations.id, organizationId));
  // A repeat of a finished setup is not another finish.
  if (before?.step !== "done") {
    afterCommit(tx, () => {
      if (before?.step === "campaign") track("onboarding_step_completed", { step: "campaign" });
      track("onboarding_step_completed", { step: "done" });
    });
  }
}
