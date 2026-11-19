import type { CapabilitySurface } from "../connector/resolve";

/**
 * Best-effort display-name lookup for comment authors whose payload omitted a
 * name (provider thread-reply items often carry only the profile id). One
 * profile call per distinct id; ANY failure just skips that id — the profile
 * endpoint 422s for company authors and is rate-limited, and a missing name
 * must never block comment intake (it only costs the UI label + the @-tag).
 */
export async function lookupProfileNames(
  driver: CapabilitySurface<"profile">,
  profileIds: Iterable<string>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!driver.fetchProfile) return names;
  for (const id of new Set(profileIds)) {
    try {
      const name = (await driver.fetchProfile(id)).name;
      if (name) names.set(id, name);
    } catch {
      // best-effort — leave this author unnamed
    }
  }
  return names;
}
