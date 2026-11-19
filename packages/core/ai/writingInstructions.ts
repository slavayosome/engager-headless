import type { Campaign } from "@engager/database/schema";
import { effectiveCommentGuidance, effectiveReplyPlaybook } from "./promptDefaults";

import { createHash } from "node:crypto";
import { WRITING_DEFAULTS, WRITING_GENERAL_RULES, type WritingSurface, type WritingSource, type WritingStep, type WritingInstructions } from "./writingInstructionContract";
export * from "./writingInstructionContract";

const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type CampaignGuidance = Pick<Campaign, "objective" | "prompts" | "tone">;
export function campaignWritingGuidance(campaign: CampaignGuidance, surface: WritingSurface): string {
  const t = campaign.tone;
  const guidance = surface === "comment" || surface === "angle"
    ? effectiveCommentGuidance(campaign.prompts?.comment_guidance, null)
    : surface === "reply" || surface === "room_reply"
      ? Object.values(effectiveReplyPlaybook(campaign)).filter(Boolean).join("\n\n")
      : "";
  return [
    guidance,
    t?.length ? "Preferred length (overridable): " + t.length : "",
    t?.angle ? "Campaign direction: " + t.angle : "",
    t?.do?.length ? "Campaign preferences:\n" + t.do.join("\n") : "",
    t?.avoid?.length ? "Campaign avoid preferences:\n" + t.avoid.join("\n") : "",
  ].filter(Boolean).join("\n\n");
}

export function resolveWritingInstructions(input: {
  surface: WritingSurface;
  step?: WritingStep | null;
  campaign?: CampaignGuidance;
  voice?: string;
  learned?: string;
  brainPreferences?: string;
  campaignGuidance?: string;
  defaults?: string;
  /** How a comment to someone with history follows up: below everything the
   *  owner set, so their instructions win. */
  followUp?: string;
}): WritingInstructions {
  const sources: WritingSource[] = [];
  const add = (id: string, label: string, priority: number, text?: string) => {
    if (text?.trim()) sources.push({ id, label, priority, text, revision: revision({ id, priority, text }) });
  };
  add("defaults", "Editable starting preferences", 0, input.defaults ?? WRITING_DEFAULTS[input.surface]);
  add("learned", "Learned style (inherited)", 1, input.learned);
  add("followup", "Follow-up with this person", 1, input.followUp);
  add("voice", "Selected voice (inherited)", 2, input.voice);
  add("brain", "Brain preferences (inherited)", 2, input.brainPreferences);
  add("campaign", "Campaign guidance", 3, input.campaign ? campaignWritingGuidance(input.campaign, input.surface) : undefined);
  add("guidance", "Additional owner guidance", 3, input.campaignGuidance);
  add("step", "This step — Instructions", 4, input.step?.instructions);
  return { version: 1, revision: revision({ surface: input.surface, stepId: input.step?.id, objective: input.step?.objective, sources, generalRules: WRITING_GENERAL_RULES }),
    surface: input.surface, step: input.step ?? null, sources, generalRules: WRITING_GENERAL_RULES };
}

export function renderWritingInstructions(resolved: WritingInstructions): string {
  return [
    "Writing instruction revision: " + resolved.revision,
    "INSTRUCTION AUTHORITY: General rules remain binding. For behavioral choices, higher priority overrides conflicting lower priority; compatible guidance still applies. Step instructions override campaign guidance, which overrides inherited voice/Brain and learned style, which override starting preferences. A lower-priority 'never' or 'always' is still only a preference. Do not infer product interest or facts from an instruction to promote. If instructions at the same priority cannot both be satisfied, report the conflict instead of silently ignoring one.",
    "GENERAL RULES:\n" + resolved.generalRules.map(rule => "- " + rule).join("\n"),
    resolved.step?.objective ? "STEP PURPOSE (context; Instructions governs behavior): " + resolved.step.objective : "",
    ...resolved.sources.map(source => `PRIORITY ${source.priority} — ${source.label}:\n${source.text}`),
    "Only actual channel limits and the required output schema are structural limits. Links, asks, product mentions, questions, signatures, preferred length and cosmetic patterns are governed by the instructions above, never an independent editorial prohibition.",
  ].filter(Boolean).join("\n\n");
}

/** No language interpretation here: compliance with prose is a semantic
 * judgment using this exact instruction set, not a keyword permission flag. */
export function writingCompliancePrompt(instructions: string): string {
  return `Evaluate the proposed text against the effective instructions below and the supplied factual evidence.
List concrete violations, naming the applicable source and explaining the conflict. Do not penalize a link, CTA, pitch, question, signature, format or phrase merely because it is unusual. Higher-priority instructions override conflicting defaults and learned style. Do not invent an editorial rule.
Score 0..1: 0 for compliant, 0.3 for a minor preference mismatch, 0.7 for a clear instruction violation, 1 for fabricated facts or a general-rule violation.
${instructions}`;
}

