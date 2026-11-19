import type { Campaign, ResolvedStyleRules } from "@engager/database/schema";
import type { CampaignAgentStrategy } from "./contract";

/**
 * THE CAMPAIGN'S OWN VOICE, as its strategy states it (spec §09 R04), laid
 * over the voice row its drafts are written in: which row (`voice:<id>`, the
 * campaign-scoped override), and the style the owner corrected — sentence
 * casing and a capital I, a sentence target — as the register rules every
 * writer, the slop judge and the lint already read (`ai/styleRules.ts`). The
 * model writes the words under them; the server never rewrites a word itself.
 *
 * Every agent step's draft is written in it (`agentStep/writing.ts`), and a
 * version that moves any of it redrafts the drafts still waiting, as it takes
 * effect (`agentStep/redraft.ts`). Pure.
 */

type StrategyVoice = CampaignAgentStrategy["voice"];

const VOICE_ROW = /^voice:(\d+)$/;

/** The voice row a campaign's drafts are written in: its strategy's own
 *  (`voice:<id>`, the campaign-scoped override), else the campaign's. */
export function draftingVoiceId(
  voice: StrategyVoice,
  campaign: Pick<Campaign, "voiceId">,
): number | null {
  const own = voice.voice_profile_id === null ? null : VOICE_ROW.exec(voice.voice_profile_id);
  return own ? Number(own[1]) : campaign.voiceId;
}

/**
 * The register a draft is written under: the voice row's own rules, with the
 * strategy's corrections over them. `sentence` is ordinary sentence capitals
 * — never formal copy — whatever casing the row writes in; `preserve_user`
 * leaves the row's casing as the owner writes.
 */
export function strategyRegister<V extends { styleRules: ResolvedStyleRules }>(
  resolved: V,
  voice: StrategyVoice,
): V {
  const target = voice.sentence_target;
  const extras = [
    resolved.styleRules.extras.trim() || null,
    voice.casing === "sentence" && voice.capital_i ? "Write I as a capital I, always." : null,
    target === null
      ? null
      : `Aim at about ${target} sentence${target === 1 ? "" : "s"}: a goal, never a reason to leave part of a question unanswered.`,
  ].filter((line): line is string => line !== null);
  return {
    ...resolved,
    styleRules: {
      ...resolved.styleRules,
      casing: voice.casing === "sentence" ? "sentence" : resolved.styleRules.casing,
      extras: extras.join("\n"),
    },
  };
}

const VOICE_FIELDS = [
  "voice_profile_id",
  "casing",
  "capital_i",
  "sentence_target",
  "random_typos",
] as const satisfies readonly (keyof StrategyVoice)[];

/** Whether a version changes anything a draft is written from. */
export function voiceMoved(before: StrategyVoice, after: StrategyVoice): boolean {
  return VOICE_FIELDS.some((field) => before[field] !== after[field]);
}
