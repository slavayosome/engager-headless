import type { AudienceProfileInput } from "./model";

export type AudienceSuggestion = Pick<AudienceProfileInput, "who" | "pains" | "notThem">;

export function audienceHasEmptyPart(profile: AudienceProfileInput): boolean {
  return !profile.who.summary.trim() || !profile.who.signals.length || !profile.who.companyKinds.length ||
    !profile.pains.some((pain) => pain.status === "active") || !profile.notThem.length;
}

/** Evaluate emptiness at arrival, not at request time. The owner can keep
 * typing while a model works; suggestions never replace those words. */
export function fillEmptyAudience(profile: AudienceProfileInput, suggestion: AudienceSuggestion): AudienceProfileInput {
  const painCapacity = Math.max(0, 12 - profile.pains.filter((pain) => pain.status !== "retired").length);
  return { ...profile, who: {
    summary: profile.who.summary.trim() ? profile.who.summary : suggestion.who.summary,
    signals: profile.who.signals.length ? profile.who.signals : suggestion.who.signals,
    companyKinds: profile.who.companyKinds.length ? profile.who.companyKinds : suggestion.who.companyKinds,
  }, pains: profile.pains.some((pain) => pain.status === "active") ? profile.pains : [
    ...profile.pains, ...suggestion.pains.filter((pain) => !profile.pains.some((existing) => existing.id === pain.id))
      .slice(0, Math.min(3, painCapacity)),
  ], notThem: profile.notThem.length ? profile.notThem : suggestion.notThem };
}
