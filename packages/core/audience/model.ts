import { z } from "zod";
import type { AudienceProfileJson, Campaign } from "@engager/database/schema";
import { ANYWHERE, audienceWhereSchema } from "./geography";

const chips = (max: number, width = 60) => z.array(z.string().trim().min(1).max(width))
  .transform((values) => [...new Map(values.map((value) => [value.toLocaleLowerCase("en"), value])).values()])
  .pipe(z.array(z.string()).max(max));

export const audiencePainSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(160),
  phrases: chips(6, 80).default([]),
  source: z.enum(["owner", "brain", "learned"]).default("owner"),
  status: z.enum(["proposed", "active", "retired"]).default("active"),
  themeId: z.string().uuid().optional(),
  seenInRooms: z.number().int().nonnegative().optional(),
  evidencePurgedAt: z.number().int().positive().optional(),
}).strict().superRefine((pain, ctx) => {
  if (pain.status === "proposed" && pain.source !== "learned") {
    ctx.addIssue({ code: "custom", path: ["source"], message: "Only a learned pain can be proposed." });
  }
  if ((pain.themeId !== undefined || pain.seenInRooms !== undefined) &&
      (pain.source !== "learned" || pain.themeId === undefined || pain.seenInRooms === undefined)) {
    ctx.addIssue({ code: "custom", message: "A learned theme needs its identity and source-room count." });
  }
  if (pain.evidencePurgedAt !== undefined && (!pain.themeId || pain.source !== "learned")) {
    ctx.addIssue({ code: "custom", message: "Only a learned theme has retained evidence." });
  }
  if (pain.seenInRooms === 0 && (pain.evidencePurgedAt === undefined || pain.status !== "retired")) {
    ctx.addIssue({ code: "custom", message: "A pain without retained evidence stays retired." });
  }
});

export const audienceProfileInputSchema = z.object({
  who: z.object({
    summary: z.string().trim().max(500),
    signals: chips(12).default([]),
    companyKinds: chips(8).default([]),
  }).strict(),
  pains: z.array(audiencePainSchema).default([]),
  notThem: chips(12).default([]),
  where: audienceWhereSchema.default({}),
  testSource: z.enum(["derived", "owner"]).default("derived"),
  ownerRule: z.string().nullable().default(null),
}).strict().superRefine((profile, ctx) => {
  if (new Set(profile.pains.map((pain) => pain.id)).size !== profile.pains.length) {
    ctx.addIssue({ code: "custom", path: ["pains"], message: "Each pain needs its own identity." });
  }
  const themeIds = profile.pains.flatMap((pain) => pain.themeId ? [pain.themeId] : []);
  if (new Set(themeIds).size !== themeIds.length) ctx.addIssue({ code: "custom", path: ["pains"], message: "A theme can belong to only one pain." });
  if (profile.pains.filter((pain) => pain.status !== "retired").length > 12) {
    ctx.addIssue({ code: "custom", path: ["pains"], message: "Keep at most 12 current pains." });
  }
  if (profile.testSource === "derived" && !profile.who.summary) {
    ctx.addIssue({ code: "custom", path: ["who", "summary"], message: "Describe who you want to meet." });
  }
});
export type AudienceProfileInput = z.infer<typeof audienceProfileInputSchema>;
export type AudienceProfile = AudienceProfileJson;
export type AudienceCampaign = Pick<Campaign, "aiFilter" | "audienceProfile" | "audienceRevision" | "verifyStage">;

export function editableAudience(profile: AudienceProfile): AudienceProfileInput {
  const { revision: _revision, updatedAt: _updatedAt, ...input } = profile;
  return input;
}

/** A read adapter, never a backfill. Legacy text stays byte-for-byte intact,
 *  including a long rule; no Who or pain is inferred from it. */
export function audienceProfile(campaign: AudienceCampaign): AudienceProfile {
  return campaign.audienceProfile ?? {
    who: { summary: "", signals: [], companyKinds: [] },
    pains: [], notThem: [], where: ANYWHERE, testSource: "owner",
    ownerRule: campaign.aiFilter?.instruction ?? "",
    revision: campaign.audienceRevision, updatedAt: 0,
  };
}

/** The sole compatibility projection. Exclusions bind either positive rule;
 *  pains prioritize an opening and never add an identity requirement. */
export function audienceInstruction(profile: AudienceProfileInput): string {
  const positive = profile.testSource === "owner" ? profile.ownerRule ?? "" : [
    `Who: ${profile.who.summary}`,
    profile.who.signals.length && `Signals: ${profile.who.signals.join("; ")}`,
    profile.who.companyKinds.length && `Company kinds: ${profile.who.companyKinds.join("; ")}`,
    ...profile.pains.filter((pain) => pain.status === "active").map((pain) =>
      `Opportunity: ${pain.text}${pain.phrases.length ? ` — in their words: ${pain.phrases.join("; ")}` : ""}`),
    "Pains prioritize opportunities. Their absence does not disqualify a person who fits Who.",
  ].filter(Boolean).join("\n");
  return [positive, profile.notThem.length && `Always exclude: ${profile.notThem.join("; ")}`].filter(Boolean).join("\n");
}

export function effectiveAudience(campaign: AudienceCampaign) {
  const profile = audienceProfile(campaign);
  return {
    revision: campaign.audienceRevision, profile,
    instruction: audienceInstruction(profile),
  };
}

export function sameAudience(a: AudienceProfileInput, b: AudienceProfileInput): boolean {
  return JSON.stringify(audienceProfileInputSchema.parse(a)) === JSON.stringify(audienceProfileInputSchema.parse(b));
}

/** Keep newly arrived learning proposals when an owner saves an older form.
 *  Owner revisions are still protected by CAS; only learned proposals merge. */
export function mergeAudienceProposals(input: AudienceProfileInput, current: AudienceProfileInput): AudienceProfileInput {
  const ids = new Set(input.pains.map((pain) => pain.id));
  const themes = new Set(input.pains.flatMap((pain) => pain.themeId ? [pain.themeId] : []));
  return { ...input, pains: [...input.pains, ...current.pains.filter((pain) =>
    (pain.status === "proposed" || (pain.evidencePurgedAt !== undefined && pain.seenInRooms === 0)) &&
    !ids.has(pain.id) && (!pain.themeId || !themes.has(pain.themeId)))] };
}

/** A status-only owner decision gets a precise history reason. Any other
 * audience edit, or a mixture of Keep and Dismiss, remains an owner edit. */
export function painDecisionReason(before: AudienceProfileInput, next: AudienceProfileInput): "owner_edit" | "pain_kept" | "pain_dismissed" {
  const previous = new Map(before.pains.map((pain) => [pain.id, pain]));
  const decisions = new Set<"active" | "retired">();
  const comparable = { ...next, pains: next.pains.map((pain) => {
    if (previous.get(pain.id)?.status !== "proposed" || pain.status === "proposed") return pain;
    decisions.add(pain.status);
    return { ...pain, status: "proposed" as const };
  }) };
  if (decisions.size !== 1 || !sameAudience(before, comparable)) return "owner_edit";
  return decisions.has("active") ? "pain_kept" : "pain_dismissed";
}
