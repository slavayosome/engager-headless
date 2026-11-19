import { withOrg, type Tx } from "@engager/database/tenant";
import { COUNTRY_UNKNOWN_REASON, placeCountry, placesBind, type AudienceWhere } from "../audience/geography";
import type { CapabilitySurface } from "../connector/resolve";
import { ConnectorError } from "../linkedin/connectorError";
import { knownPlaces, readPersonPlace, type PersonPlace } from "../operations/researchReads";
import { authorIdentity } from "../people/key";
import type { JudgedRoomPerson } from "./judgment";

/** The sidecar's answer for a member who is gone, as opposed to one that did
 *  not answer this time. */
const PROFILE_GONE = "PROFILE_UNAVAILABLE";

type Place = PersonPlace & { readAt: number };

/**
 * The Audience's countries applied to the people a judge called fits.
 *
 * Out of the countries is not a fit, with the owner's words for why. A person
 * with no country read — the profile named none, the budget ran out, or there
 * was no profile to read — counts as the Audience says: in (as judged), the
 * owner's call (maybe), or left out. A person no read placed keeps a null
 * read time, which is what marks them worth a later check: never a guess.
 */
export function applyCountries(
  people: readonly JudgedRoomPerson[],
  where: AudienceWhere,
  places: ReadonlyMap<string, Place>,
): JudgedRoomPerson[] {
  if (!placesBind(where)) return [...people];
  return people.map((person) => {
    if (person.fit !== "fits") return person;
    const place = person.profileId ? places.get(authorIdentity(person.profileId)) : undefined;
    const placed = { ...person, country: place?.country ?? null, countryReadAt: place?.readAt ?? null };
    const verdict = placeCountry(placed.country, where);
    if (verdict.place === "out") return { ...placed, fit: "not" as const, painId: null, reason: verdict.reason };
    if (verdict.place !== "unknown" || where.unknownCountry === "count_in") return placed;
    return where.unknownCountry === "owner_call"
      ? { ...placed, fit: "maybe" as const, reason: `${COUNTRY_UNKNOWN_REASON} · ${person.reason ?? "fits"}` }
      : { ...placed, fit: "not" as const, painId: null, reason: COUNTRY_UNKNOWN_REASON };
  });
}

/** A host's room, placed from the reads this server already made: nothing is
 *  read from LinkedIn on a host's submission. */
export async function placeFromKnown(
  tx: Tx,
  people: readonly JudgedRoomPerson[],
  where: AudienceWhere,
  now: number,
): Promise<JudgedRoomPerson[]> {
  if (!placesBind(where)) return [...people];
  return applyCountries(people, where, await knownPlaces(tx, fitIds(people), now));
}

/**
 * Research's room, placed: each fitting person's country from a profile read
 * inside its TTL, or read now — one profile visit each, spent from the
 * account's research budget and spaced like every other read by `beforeLoad`.
 *
 * A budget refusal ends the reading and leaves the rest unchecked; the
 * refusal is returned so the stage stops there too. A profile that is gone is
 * placed nowhere and not read again; any other failed read stops the reading,
 * so a sidecar that cannot answer does not spend the budget person by person.
 * A checkpoint, a sign-in wall or a rate limit, and anything `beforeLoad`
 * throws, are the caller's to handle.
 */
export async function placeRoomPeople(opts: {
  organizationId: string;
  driver: CapabilitySurface<"profile_read">;
  campaignId: number;
  where: AudienceWhere;
  people: readonly JudgedRoomPerson[];
  now: number;
  beforeLoad: () => Promise<void>;
}): Promise<{ people: JudgedRoomPerson[]; pagesRead: number; refused?: string }> {
  const { where, people, now } = opts;
  if (!placesBind(where)) return { people: [...people], pagesRead: 0 };
  const places = new Map<string, Place>(
    await withOrg(opts.organizationId, (tx) => knownPlaces(tx, fitIds(people), now)),
  );
  let pagesRead = 0;
  let refused: string | undefined;
  for (const profileId of fitIds(people)) {
    if (places.has(profileId)) continue;
    let read;
    try {
      read = await readPersonPlace({
        organizationId: opts.organizationId,
        driver: opts.driver,
        campaignId: opts.campaignId,
        profileId,
        now,
        beforeLoad: opts.beforeLoad,
      });
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.checkpoint || error.signIn || error.rateLimited) throw error;
      if ((error as { code?: unknown }).code === PROFILE_GONE && !error.retryable) {
        places.set(profileId, { country: null, readAt: now });
        continue;
      }
      break;
    }
    if (read.status === "unsupported") break;
    if (read.status === "refused") {
      refused = read.reason;
      break;
    }
    if (read.status === "read") pagesRead += 1;
    places.set(profileId, { ...read.value, readAt: read.readAt });
  }
  return { people: applyCountries(people, where, places), pagesRead, ...(refused ? { refused } : {}) };
}

/** The profiles of the people a judge called fits, each once. */
function fitIds(people: readonly JudgedRoomPerson[]): string[] {
  return [...new Set(people.flatMap((person) => person.fit === "fits" && person.profileId ? [authorIdentity(person.profileId)] : []))];
}
