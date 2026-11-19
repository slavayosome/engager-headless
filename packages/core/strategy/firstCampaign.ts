import type { SearchDepth } from "@engager/database/schema";
import { MODE_KEYS } from "./catalog";
import type { ActionBinding, CampaignAgentStrategy } from "./contract";
import {
  FIRST_CAMPAIGN_ACTION_IDS,
  firstCampaignInstructionDefault,
  modeOf,
  type FirstCampaignActionId,
  type FirstCampaignInstructions,
  type FirstCampaignModes,
  type FirstCampaignStepId,
} from "./firstCampaignActions";
import { STRATEGY_PATCH, type StrategyPatch } from "./patch";
import {
  designOps,
  rootsOf,
  templateDocument,
  type TemplateAnswers,
  type TemplateContext,
} from "./templates";

export { FIRST_CAMPAIGN_DEFAULT_MODES } from "./firstCampaignActions";
/** Durable provenance identifying this setup's campaign, including after its
 * draft is cleared. A retry must never adopt an unrelated newest campaign. */
export const FIRST_CAMPAIGN_COMPILER_VERSION = "first-campaign/1";

/**
 * THE FIRST CAMPAIGN'S STRATEGY — what setup's Review decides, said as the
 * document the campaign is created with. Pure: no I/O, no clock.
 *
 * It is the Conversation to conversion template led in by Scout's finds,
 * with no Check outcome (there is no offer yet): Find leads — every campaign
 * is created finding leads — then the Ambassador's Comment on posts, Reply
 * when they answer, Invite to connect and Message after they accept. The
 * template sets a send's mode from its stored key, and Like post and Like
 * reply share one (`like_target`), so the template alone cannot give them
 * different modes. Each binding's mode is
 * therefore set by its own id, from the Review's choices; Find leads' reads
 * are the template's, and its depth is the campaign's.
 *
 * Nothing here sets Automatic by itself: a choice is whatever the owner picked
 * on the Review, and the resolver holds it where the account requires
 * (`resolve.ts`).
 */

/** The template's answers: every send may ask first but Follow-up, which
 *  starts Off with the rest. The Review's choices then replace each mode. */
const ANSWERS: TemplateAnswers = {
  askFirst: MODE_KEYS.filter((key) => key !== "followup"),
  leadIn: true,
  offer: null,
};

export type FirstCampaignChoices = {
  depth: SearchDepth;
  /** The modes the owner set; every action not named starts at its default. */
  modes: FirstCampaignModes;
  /** The step instructions the owner changed, by step id; a step not named
   *  stores none and inherits the starting text. */
  instructions: FirstCampaignInstructions;
};

const isActionId = (id: string): id is FirstCampaignActionId =>
  (FIRST_CAMPAIGN_ACTION_IDS as readonly string[]).includes(id);

/** The document `base` becomes with the Review's choices on it. */
export function firstCampaignDocument(
  base: CampaignAgentStrategy,
  choices: FirstCampaignChoices,
  context: TemplateContext,
): CampaignAgentStrategy {
  const designed = templateDocument(base, "conversation_to_conversion", ANSWERS, context);
  const action_bindings = (designed.action_bindings ?? []).map((binding): ActionBinding => {
    if (binding.action_binding_id === "lead_company") {
      return { ...binding, mode: choices.depth === "deep" ? "on" : "off" };
    }
    if (!isActionId(binding.action_binding_id)) return binding;
    return { ...binding, mode: modeOf(choices.modes, binding.action_binding_id) };
  });
  const steps = (designed.steps ?? []).map((step) => {
    const instructions = choices.instructions[step.step_id as keyof FirstCampaignInstructions] ?? "";
    return { ...step, instructions: instructions === firstCampaignInstructionDefault(step.catalog_step as FirstCampaignStepId) ? "" : instructions };
  });
  return { ...designed, action_bindings, steps };
}

/**
 * The `strategy.patch` that makes the blank draft `base` the first
 * campaign's design: the ops from `base` to {@link firstCampaignDocument},
 * every grant the sends need asked for by name. Pure. It lands on the draft of
 * a campaign not started, where nothing is in force until the Start.
 */
export function firstCampaignPatch(input: {
  campaignId: number;
  expectedBaseVersion: number;
  base: CampaignAgentStrategy;
  choices: FirstCampaignChoices;
  context: TemplateContext;
  instruction: string;
}): StrategyPatch {
  const target = firstCampaignDocument(input.base, input.choices, input.context);
  const ops = designOps(input.base, target);
  const add = target.grants.filter((grant) => !input.base.grants.includes(grant));
  const remove = input.base.grants.filter((grant) => !target.grants.includes(grant));
  const grants = add.length > 0 || remove.length > 0;
  return {
    kind: STRATEGY_PATCH,
    campaignId: input.campaignId,
    expectedBaseVersion: input.expectedBaseVersion,
    ops,
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    ...(grants ? { requestedGrants: { add, remove } } : {}),
    provenance: {
      instruction: input.instruction,
      recognizedIntent: {
        summary: "First campaign: Scout's finds, then the Ambassador's steps at the modes chosen in setup",
        paths: [...rootsOf(ops), ...(grants ? ["/grants"] : [])],
      },
      scope: { stepId: null },
      compilerVersion: FIRST_CAMPAIGN_COMPILER_VERSION,
    },
  };
}
