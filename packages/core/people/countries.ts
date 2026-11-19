import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { authorProfiles } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { authorIdentity } from "./key";

/**
 * WHERE A PERSON IS BASED, for display: the country the latest profile read
 * placed them in (`author_profiles.country`), however long ago — a location
 * barely moves, and a read that names none never clears one. A person no
 * read placed has no country: never one guessed from a name, a headline or a
 * language.
 */

/** Each known country, keyed by the id as given and matched by
 *  `authorIdentity`, so a profile URL, its slug and its spelling in another
 *  case are one person. Where two rows are that one person, the one placed
 *  last wins. */
export async function knownCountries(tx: Tx, profileIds: readonly string[]): Promise<Map<string, string>> {
  if (profileIds.length === 0) return new Map();
  const rows = await tx
    .select({ profileId: authorProfiles.profileId, country: authorProfiles.country })
    .from(authorProfiles)
    .where(
      and(
        inArray(authorProfiles.profileId, [...new Set([...profileIds, ...profileIds.map(authorIdentity)])]),
        isNotNull(authorProfiles.country),
      ),
    )
    .orderBy(sql`greatest(coalesce(${authorProfiles.countryReadAt}, 0), ${authorProfiles.fetchedAt})`);
  const byIdentity = new Map(rows.map((row) => [authorIdentity(row.profileId), row.country!]));
  return new Map(
    profileIds.flatMap((id) => {
      const country = byIdentity.get(authorIdentity(id));
      return country === undefined ? [] : [[id, country] as const];
    }),
  );
}
