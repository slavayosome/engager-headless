import type { Campaign } from "@engager/database/schema";
import { effectiveCommentGuidance } from "../ai/promptDefaults";
import { intentGate, type IntentGate } from "./intentGate";

/** An intent as the commenting goal names it. */
const INTENT_GOAL_LABEL: Record<IntentGate["intent"], string> = {
  asking: "Asking",
  has_problem: "Has the problem",
  topic_only: "Topic only",
};

/** One commenting strategy for manual angles/drafts and Ambassador workers.
 * Scout's search/filter instruction is deliberately absent. In lead mode the
 * goal is the person's intent gate, Topic only where no one is named, and the
 * guidance the Goal-free default where the owner wrote none: a stored Goal is
 * never read. */
export function commentingContext(
  campaign: Pick<Campaign, "prompts" | "tone">,
  intent: IntentGate | null = null,
) {
  const lead = intent ?? intentGate(null, false);
  const goal = { id: lead.intent, label: INTENT_GOAL_LABEL[lead.intent], description: lead.framing };
  return {
    goal: { id: goal.id, label: goal.label, description: goal.description },
    guidance: effectiveCommentGuidance(campaign.prompts?.comment_guidance, null),
    angle: campaign.tone?.angle ?? null,
    do: campaign.tone?.do ?? [],
    avoid: campaign.tone?.avoid ?? [],
  };
}

export const COMMENTING_DIRECTION = "Start with the author's actual point. Use the commenting goal to choose a useful contribution; Scout targeting only explains why this post was found. Never force a pitch, a question or a problem diagnosis to satisfy the goal. Brain and product facts support relevant contributions; they are not instructions to promote.";
