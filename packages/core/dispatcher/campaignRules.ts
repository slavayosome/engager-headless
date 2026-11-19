import type { Campaign } from "@engager/database/schema";
import { effectiveCommentGuidance, effectiveReplyPlaybook } from "../ai/promptDefaults";
import { lengthSpecForTier } from "../ai/writer";
import type { WritingStep } from "../ai/writingInstructionContract";
import type { CampaignRule, CampaignRuleSource, DraftSurface } from "./types";

/**
 * Every instruction a campaign gives its drafts, one rule per line or
 * field, each under its own authority: the Comment step's "Instructions", the
 * campaign guidance drafting reads (the objective's default where the owner
 * wrote none, the Goal-free one in lead mode), and the tone's length,
 * direction and do and avoid lists. Ids number each source's rules in order,
 * so an unchanged campaign reads the same ids every time.
 */
export function campaignRulesFor(
  campaign: Pick<Campaign, "objective" | "prompts" | "tone">,
  step?: WritingStep | null,
  learned = "",
  surface: DraftSurface = "comment",
): CampaignRule[] {
  const tone = campaign.tone;
  // A reply is guided by the campaign's reply playbook, a DM, a follow-up or
  // a connection note by its step alone; every other surface reads the
  // comment guidance.
  const guidance =
    surface === "reply"
      ? Object.values(effectiveReplyPlaybook(campaign)).filter(Boolean).join("\n\n")
      : surface === "dm" || surface === "followup" || surface === "invitation"
        ? ""
        : effectiveCommentGuidance(campaign.prompts?.comment_guidance, null);
  return [
    ...numbered("step", instructionLines(step?.instructions ?? "")),
    ...numbered("campaign_guidance", instructionLines(guidance)),
    ...numbered("tone", [
      // "auto" is a tier picked per post, not a preference.
      tone?.length && tone.length !== "auto" ? `Preferred length: ${lengthSpecForTier(tone.length).cap}` : "",
      tone?.angle?.trim() ? `Campaign direction: ${tone.angle.trim()}` : "",
      ...(tone?.do ?? []),
      ...(tone?.avoid ?? []).map((item) => (item.trim() ? `Avoid: ${item.trim()}` : "")),
    ]),
    // Learned guidance shares tone's rank and ties settle first-said, so it is
    // listed last: the owner's written preference wins over what was distilled.
    ...numbered("learned_guidance", instructionLines(learned)),
  ];
}

function numbered(source: CampaignRuleSource, lines: readonly string[]): CampaignRule[] {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text, n) => ({ id: `campaign.${source}.${n}`, source, text }));
}

/**
 * One instruction a line, without its bullet. A line that heads the bullets
 * under it ("NEVER:", "HOW TO CONTRIBUTE:") is no instruction of its own: it
 * prefixes each of them, since "Mention a product" means the opposite without
 * its "Never:". A blank line ends a heading's reach.
 */
function instructionLines(text: string): string[] {
  const lines: string[] = [];
  let heading = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*•]\s*/u.test(line);
    const item = line.replace(/^[-*•]\s*/u, "");
    if (!item) {
      heading = "";
    } else if (!bullet && item.endsWith(":")) {
      heading = item === item.toUpperCase() ? item.charAt(0) + item.slice(1).toLowerCase() : item;
    } else {
      lines.push(heading ? `${heading} ${item}` : item);
    }
  }
  return lines;
}
