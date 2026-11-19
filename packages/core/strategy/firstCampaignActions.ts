import { z } from "zod";
import { ACTION_MODES, type ActionMode, type CatalogStepId } from "./catalog";
import { WRITING_DEFAULTS, writingSurfaceForStep } from "../ai/writingInstructionContract";

/**
 * WHAT THE FIRST CAMPAIGN'S REVIEW LISTS, as data a setup screen can import:
 * the five steps the campaign is created with, the eight actions the
 * Ambassador's steps bind (by their binding ids, the only way to tell Like
 * post from Like reply — the two share one stored key), and the modes each
 * starts at — and the starting points New campaign offers, further down.
 * Client-safe: no database, no template, so the screens that show these and
 * the builders that write them (`firstCampaign.ts`, `templates.ts`) cannot
 * disagree about what there is.
 */

/** The steps of the campaign setup creates, in the order the Review lists
 *  them: Scout's Find leads — every campaign created finds leads — then the
 *  Ambassador's four. */
export const FIRST_CAMPAIGN_STEPS = [
  "find_leads",
  "comment_on_posts",
  "handle_reply",
  "connect",
  "continue_in_dms",
] as const satisfies readonly CatalogStepId[];
export type FirstCampaignStepId = (typeof FIRST_CAMPAIGN_STEPS)[number];

export const FIND_POSTS_OBJECTIVE = "Find the posts this campaign's audience is in, and say in one line why each one fits.";
export const FIND_LEADS_OBJECTIVE = "Find people in their own words about the problem, researched into leads.";

export function firstCampaignInstructionDefault(step: FirstCampaignStepId): string {
  const surface = writingSurfaceForStep(step);
  return surface ? WRITING_DEFAULTS[surface] : "";
}

/** The binding ids of every action the Ambassador's steps hold. */
export const FIRST_CAMPAIGN_ACTION_IDS = [
  "comment",
  "like_post",
  "reply",
  "like_reply",
  "invite",
  "accept_invite",
  "dm",
  "followup",
] as const;
export type FirstCampaignActionId = (typeof FIRST_CAMPAIGN_ACTION_IDS)[number];

/** Each Ambassador step's actions, in catalog order. */
export const FIRST_CAMPAIGN_STEP_ACTIONS = {
  comment_on_posts: ["comment", "like_post"],
  handle_reply: ["reply", "like_reply"],
  connect: ["invite", "accept_invite"],
  continue_in_dms: ["dm", "followup"],
} as const satisfies Partial<Record<FirstCampaignStepId, readonly FirstCampaignActionId[]>>;

/** The actions the Review gives a three-way control. Accept invite and
 *  Follow-up live in the same steps and have no row: they start Off. */
export const FIRST_CAMPAIGN_CONTROLS = [
  "comment",
  "like_post",
  "reply",
  "like_reply",
  "invite",
  "dm",
] as const satisfies readonly FirstCampaignActionId[];
export type FirstCampaignControlId = (typeof FIRST_CAMPAIGN_CONTROLS)[number];

/**
 * The modes the first campaign starts at: Comment and Like post ask first,
 * everything that reaches a person after a reply is Off. Nothing is ever
 * pre-set to Automatic — the product never does (`templates.ts`) — and the
 * owner moves any of these on the Review.
 */
export const FIRST_CAMPAIGN_DEFAULT_MODES: Readonly<Record<FirstCampaignActionId, ActionMode>> = {
  comment: "review",
  like_post: "review",
  reply: "off",
  like_reply: "off",
  invite: "off",
  accept_invite: "off",
  dm: "off",
  followup: "off",
};

const mode = z.enum(ACTION_MODES);

/** Per-action modes as the wizard stores them: only the ones the owner set,
 *  and only for the actions with a control. */
export const firstCampaignModesSchema = z
  .object({
    comment: mode,
    like_post: mode,
    reply: mode,
    like_reply: mode,
    invite: mode,
    dm: mode,
  })
  .partial()
  .strict();
export type FirstCampaignModes = Partial<Record<FirstCampaignActionId, ActionMode>>;

/** The longest a step's instructions may be: a strategy step's own bound
 *  (`StrategyStep.instructions`). */
export const STEP_INSTRUCTIONS_MAX = 4000;

const instructions = z.string().max(STEP_INSTRUCTIONS_MAX);

/** Step instructions as the wizard stores them: only the ones the owner
 *  changed from the starting text. */
export const firstCampaignInstructionsSchema = z
  .object({
    find_leads: instructions,
    comment_on_posts: instructions,
    handle_reply: instructions,
    connect: instructions,
    continue_in_dms: instructions,
  })
  .partial()
  .strict();
export type FirstCampaignInstructions = Partial<Record<FirstCampaignStepId, string>>;

/** The mode an action starts at unless the owner chose one. */
export function modeOf(modes: FirstCampaignModes | undefined, id: FirstCampaignActionId): ActionMode {
  return modes?.[id] ?? FIRST_CAMPAIGN_DEFAULT_MODES[id];
}

/**
 * A NEW CAMPAIGN'S STARTING POINTS — the three outcomes New campaign offers and
 * `save_campaign` takes, said once so a campaign made on the page and one made
 * by the owner's agent from the same starting point hold the same steps at the
 * same modes (`designDocument`, templates.ts, writes both).
 *
 * A starting point only fills values the owner then changes. Connect,
 * Message after they accept and Meet the room are off under every one of them: private
 * contact is opt-in, and a step switched on by hand starts at Ask me.
 */

/** The Ambassador's steps a new campaign can switch on, in the order its
 *  block lists them. Check outcome is not among them: it counts against an
 *  offer that is set up in chat, and takes no mode. */
export const AMBASSADOR_STEP_ROWS = [
  "comment_on_posts",
  "handle_reply",
  "connect",
  "continue_in_dms",
  "meet_the_room",
] as const satisfies readonly CatalogStepId[];
export type AmbassadorStepId = (typeof AMBASSADOR_STEP_ROWS)[number];

/** A switched-on step's mode. Off is the switch. */
export const STEP_SEND_MODES = ["review", "auto"] as const;
export type StepSendMode = (typeof STEP_SEND_MODES)[number];

/** What a step switched on by hand starts at, under every starting point. */
export const SWITCHED_ON_MODE: StepSendMode = "review";

/** The steps switched on, each at its mode. A step not named is not hired. */
export type DesignSteps = Partial<Record<AmbassadorStepId, StepSendMode>>;

export const STARTING_POINTS = {
  find_leads_only: {
    label: "Find leads only",
    line: "You get people worth talking to, researched. Nothing is written or sent; you reach out yourself.",
    steps: {},
  },
  find_and_draft: {
    label: "Find and draft",
    line: "Also drafts comments and replies. Every one waits in Inbox for your yes.",
    steps: { comment_on_posts: "review", handle_reply: "review" },
  },
  find_and_engage: {
    label: "Find and engage",
    line: "Comments and replies go out on their own, inside the channel pace. Stop it any moment.",
    steps: { comment_on_posts: "auto", handle_reply: "auto" },
  },
} as const satisfies Record<string, { label: string; line: string; steps: DesignSteps }>;
export type StartingPointId = keyof typeof STARTING_POINTS;
export const STARTING_POINT_IDS = Object.keys(STARTING_POINTS) as [StartingPointId, ...StartingPointId[]];

/** The starting point New campaign opens on. */
export const DEFAULT_STARTING_POINT: StartingPointId = "find_and_draft";

const sendMode = z.enum(STEP_SEND_MODES);
const designInstructions = z.string().max(STEP_INSTRUCTIONS_MAX);

/** A new campaign's steps as New campaign sends them: the Ambassador steps
 *  switched on with their modes, and the instructions written for Find leads
 *  and for those steps. */
export const campaignDesignSchema = z
  .object({
    steps: z
      .object({ comment_on_posts: sendMode, handle_reply: sendMode, connect: sendMode, continue_in_dms: sendMode, meet_the_room: sendMode })
      .partial()
      .strict(),
    instructions: z
      .object({
        find_leads: designInstructions,
        comment_on_posts: designInstructions,
        handle_reply: designInstructions,
        connect: designInstructions,
        continue_in_dms: designInstructions,
        meet_the_room: designInstructions,
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export type CampaignDesign = z.infer<typeof campaignDesignSchema>;

/** A starting point's steps, as a design with no instructions written. */
export function startingDesign(id: StartingPointId): CampaignDesign {
  return { steps: { ...STARTING_POINTS[id].steps } };
}

/** The starting point whose steps these are exactly, or null for steps the
 *  owner changed from every one of them. */
export function startingPointOf(steps: DesignSteps): StartingPointId | null {
  const matches = (id: StartingPointId) => {
    const preset: DesignSteps = STARTING_POINTS[id].steps;
    return AMBASSADOR_STEP_ROWS.every((step) => preset[step] === steps[step]);
  };
  return STARTING_POINT_IDS.find(matches) ?? null;
}
