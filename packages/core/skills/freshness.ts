import type { SkillManifest } from "./registry";

/**
 * Is the agent working from the skills this release actually serves?
 *
 * Why this exists in a tool RESULT rather than a description: the hosted MCP is
 * stateless — a fresh server per HTTP request — so a client's cached tool
 * descriptions and the server `instructions` freeze the moment its connector
 * opens, and no server code can refresh them (`sendToolListChanged()` has no
 * live connection to notify). Results are the only channel that is always the
 * live release speaking.
 *
 * It found this: skills installed on a founder's machine were engager-batch
 * 3.2.0 / engager-setup 1.1.1 against a server serving 5.0.0 / 12.0.0. The
 * installed batch skill still described the job as "draft comments and schedule
 * them for paced publishing" — the pre-pivot draft-factory model, several
 * product pivots stale. Every SKILL.md carries a "compare your version with
 * list_skills and refresh" rule, but it needs the skill to be LOADED to be
 * read, then two tool calls, then a filesystem write; the host's permission
 * classifier denied two of those and the rule never fired for months.
 *
 * So the server says it, unprompted, in the one place that cannot go stale.
 *
 * The freshness VERDICT never blocks: an agent with no skill still produced
 * useful triage, and refusing work would break every text host and every
 * session where install is denied — the exact case this is for. Exactly one
 * operation is an exception, and it is about possession rather than staleness:
 * `complete_setup` refuses when the agent does not hold `engager-setup` at all
 * (`skillHold` below), because certifying setup complete is the one moment the
 * product asserts the agent can do the job. An outdated copy still finishes.
 */

export type SkillFreshnessVerdict =
  | "current"
  | "outdated"
  | "absent"
  | "unknown";

export type LoadedSkill = { name?: string; version?: string };

export type SkillFreshness = {
  /** What this release serves, for the visible skills. */
  served: Record<string, string>;
  verdict: SkillFreshnessVerdict;
  /** Reported skills that are behind what is served, newest-first order not
   *  meaningful — sorted by name. */
  stale: string[];
};

/** Numeric-segment compare on a `major.minor.patch` string. Returns null when
 *  either side is not parseable: skill versions are raw frontmatter strings
 *  defaulting to "0.0.0", and nothing in the repo has ever semver-compared
 *  them, so an odd value must read as "unknown" and never as "outdated". */
export function compareSkillVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const parts = v.trim().split(".");
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map((p) => (/^\d+$/u.test(p) ? Number(p) : Number.NaN));
    return nums.some((n) => Number.isNaN(n)) ? null : nums;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function skillFreshness(input: {
  manifests: readonly SkillManifest[];
  /** Omitted entirely when the agent did not report — which is itself a
   *  signal, because every skill from this release onward reports. */
  loaded?: readonly LoadedSkill[];
}): SkillFreshness {
  const served: Record<string, string> = {};
  for (const manifest of [...input.manifests].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    served[manifest.name] = manifest.version;
  }

  // No served set at all (a partial deploy leaves skillsRoot() null): we have
  // nothing to compare against, so nobody is told they are behind.
  if (Object.keys(served).length === 0) {
    return { served, verdict: "unknown", stale: [] };
  }
  if (input.loaded === undefined) return { served, verdict: "unknown", stale: [] };
  const reported = input.loaded.filter(
    (s): s is { name: string; version: string } =>
      typeof s?.name === "string" &&
      s.name.length > 0 &&
      typeof s?.version === "string" &&
      s.version.length > 0,
  );
  if (reported.length === 0) return { served, verdict: "absent", stale: [] };

  const stale: string[] = [];
  let comparable = 0;
  for (const skill of reported) {
    const servedVersion = served[skill.name];
    if (servedVersion === undefined) continue; // not ours, or not visible here
    const cmp = compareSkillVersions(skill.version, servedVersion);
    if (cmp === null) continue; // unparseable → unknown, never "outdated"
    comparable += 1;
    if (cmp < 0) stale.push(skill.name);
  }
  stale.sort();
  if (stale.length > 0) return { served, verdict: "outdated", stale };
  return {
    served,
    verdict: comparable > 0 ? "current" : "unknown",
    stale: [],
  };
}

/** The skill that owns the setup workflow. `complete_setup` refuses without it:
 *  an agent that never read it cannot have walked the LinkedIn risk disclosure,
 *  the trial-before-LinkedIn order, or the angle contract, and "you're all set"
 *  from such an agent is a lie the product tells on its own behalf. */
export const SETUP_WORKFLOW_SKILL = "engager-setup";

export type SkillHold = {
  /** What this release serves for that skill, or null when it serves none. */
  servedVersion: string | null;
  /** Whatever the agent reported alongside the name — informational only. */
  reportedVersion: string | null;
  /** Does the agent hold this skill at all? `null` means unanswerable, and an
   *  unanswerable hold must never block. */
  held: boolean | null;
};

/**
 * Does the agent hold ONE named skill — regardless of how fresh it is?
 *
 * Deliberately not `skillFreshness`, which answers a different question. An
 * agent reporting only `engager-campaigns` at the served version scores `current`
 * there while holding no setup workflow at all, so a gate built on that verdict
 * would wave through the exact case it exists to catch.
 *
 * Two narrowings versus `skillFreshness`, both on purpose:
 *
 *   - Matches on NAME ONLY. A reported skill with a missing or unparseable
 *     version still counts as held. Possession is the question here; staleness
 *     is already answered, and refusing an honest agent over a garbled version
 *     string would be a wall with no useful lesson behind it.
 *   - Fails OPEN (`held: null`) when this release serves no such skill — a
 *     partial deploy leaves `skillsRoot()` null. There is nothing to compare
 *     against and no install source to point at, so failing closed would brick
 *     setup completion for every org on an operator's mistake.
 */
export function skillHold(input: {
  manifests: readonly SkillManifest[];
  /** Omitted entirely when the agent did not report — which is itself the
   *  answer: every skill from this release onward reports. */
  loaded?: readonly LoadedSkill[];
  name: string;
}): SkillHold {
  const manifest = input.manifests.find(
    (candidate) =>
      candidate.name === input.name,
  );
  if (!manifest) {
    return { servedVersion: null, reportedVersion: null, held: null };
  }
  const reported = input.loaded?.find(
    (skill) => typeof skill?.name === "string" && skill.name === input.name,
  );
  return {
    servedVersion: manifest.version,
    reportedVersion:
      typeof reported?.version === "string" && reported.version.length > 0
        ? reported.version
        : null,
    held: reported !== undefined,
  };
}

/** The rules an agent must not get wrong, for the case where it has no skill
 *  at all. Deliberately short: this rides a ~15s poll. */
const CONTRACT_WITHOUT_SKILL =
  "Until you have it: drafting assist happens IN CHAT and nothing you offer is " +
  "recorded — only the comment the OWNER saves exists; never fill their comment " +
  "box and never save one for them; on an active campaign saving their comment " +
  "SENDS it; and `deckFocus` above names the post their deck is showing.";

/**
 * One sentence to APPEND to `next` — never to replace it. setupStateNext
 * (setupProgress.ts) is now pure per-step guidance (channel/brain/scout/
 * handoff/complete) with no guard ahead of it: T-14.2 (78d2dc6b) deleted the
 * three unconditional guards it used to run first — legacy-campaign
 * conflict, pending cancellation, invalid Stripe state. Nothing outranks the
 * step guidance anymore, which is exactly why staleness still only appends:
 * the owner needs both what to do now AND that the copy driving it is stale.
 */
export function skillFreshnessDirective(
  freshness: SkillFreshness,
): string | null {
  const refresh =
    "Refresh with `list_skills` → run its `install.command` (or hand the owner " +
    "that exact command to run), then re-read the skill and follow THAT copy.";
  if (freshness.verdict === "outdated") {
    const named = freshness.stale
      .map((name) => `${name} (served ${freshness.served[name]})`)
      .join(", ");
    return `Your loaded skill is OUT OF DATE: ${named}. You are working from a superseded contract — ${refresh}`;
  }
  if (freshness.verdict === "absent") {
    return `You reported no Engager skill loaded. ${refresh} ${CONTRACT_WITHOUT_SKILL}`;
  }
  if (freshness.verdict === "unknown") {
    return `You did not report a loaded skill version in \`loadedSkills\`. If you have an Engager skill it predates version reporting and is out of date; if you have none, you are missing the workflow entirely. Either way: ${refresh} ${CONTRACT_WITHOUT_SKILL}`;
  }
  return null;
}
