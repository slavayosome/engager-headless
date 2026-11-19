import { eq } from "drizzle-orm";
import { authorProfiles } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { authorIdentity } from "../people/key";
import { PROFILE_READ_TTL_MS } from "../operations/researchReads";
import { resolvePersonKeys } from "../people/directory";
import { personKey } from "../people/key";
import { COUNTRY_UNKNOWN_REASON, placeCountry, placesBind } from "./geography";
import { audienceProfile, type AudienceCampaign } from "./model";

/**
 * THE AUDIENCE'S COUNTRIES AT THE SEND — the same `where` Research applies
 * before a post or a person is matched, applied again immediately before
 * anything reaches the person: a comment on their post, a reply to them, a
 * like of their post or their reply, an invitation, an acceptance of theirs,
 * a DM. A person matched before the Audience named countries, or reached
 * through a reply or an invitation rather than a match, meets it here.
 *
 * A like counts as contact: it puts the account's name in the person's
 * notifications, which is all a first touch is.
 *
 * Where the person is comes from their profile's location, as a read of it
 * left it on their `author_profiles` row. A read inside
 * {@link PROFILE_READ_TTL_MS} decides at once. Past it, a send whose own
 * check before the click reads their profile anyway (an invitation's) waits
 * for that read; any other uses the latest country a read found, however old
 * — a location barely moves — and no send adds a read of its own. A person no
 * read placed counts as the Audience's `unknownCountry` says.
 */
export type CountryRefusal =
  /** Never sent: outside the countries, or placed nowhere where the Audience
   *  leaves those out. */
  | { kind: "refuse"; code: "outside_countries"; country: string; reason: string }
  | { kind: "refuse"; code: "country_unknown"; reason: string }
  /** Placed nowhere, and the Audience makes that the owner's call: sent only
   *  on their yes. */
  | { kind: "ask"; code: "country_unknown"; reason: string };

/**
 * Why this send may not reach its person as the campaign's Audience places
 * them, or null when it may — or when the place is left to a read the send
 * makes before its click (`readComing`). A send with no campaign, or whose
 * Audience names no country, is never refused here.
 */
export async function countryRefusal(
  tx: Tx,
  input: {
    campaign: AudienceCampaign | null;
    profileId: string | null;
    /** Where only the person's member urn is known. */
    memberUrn?: string | null;
    /** The owner said yes to this send, or wrote it: their call is made. */
    ownerSaidYes: boolean;
    /** The send's own check before the click reads the person's profile. */
    readComing?: boolean;
    now: number;
  },
): Promise<CountryRefusal | null> {
  if (!input.campaign) return null;
  const { where } = audienceProfile(input.campaign);
  if (!placesBind(where)) return null;

  const profileId = input.profileId ?? (await profileOfMember(tx, input.memberUrn));
  const stored = profileId ? await storedPlace(tx, profileId, input.now) : null;
  if (input.readComing && !stored?.fresh) return null;

  const country = stored?.country ?? null;
  const place = placeCountry(country, where);
  if (place.place === "out") {
    return { kind: "refuse", code: "outside_countries", country: country!.toUpperCase(), reason: place.reason };
  }
  if (place.place !== "unknown" || where.unknownCountry === "count_in") return null;
  if (where.unknownCountry === "leave_out") {
    return { kind: "refuse", code: "country_unknown", reason: COUNTRY_UNKNOWN_REASON };
  }
  return input.ownerSaidYes ? null : { kind: "ask", code: "country_unknown", reason: COUNTRY_UNKNOWN_REASON };
}

/**
 * Whether a profile read the send makes anyway should also look up where its
 * person is: the Audience names countries, and no read inside
 * {@link PROFILE_READ_TTL_MS} placed them.
 */
export async function placeUnread(
  tx: Tx,
  input: { campaign: AudienceCampaign | null; profileId: string; now: number },
): Promise<boolean> {
  if (!input.campaign || !placesBind(audienceProfile(input.campaign).where)) return false;
  return !(await storedPlace(tx, input.profileId, input.now))?.fresh;
}

/** Where the person's last profile read that looked at their location placed
 *  them, and whether it is inside the TTL; null where no read looked. A
 *  country on the row no such read stands behind — an older metrics fetch's,
 *  which could be the profile's locale — places nobody. */
async function storedPlace(
  tx: Tx,
  profileId: string,
  now: number,
): Promise<{ country: string | null; fresh: boolean } | null> {
  const [row] = await tx
    .select({ country: authorProfiles.country, readAt: authorProfiles.countryReadAt })
    .from(authorProfiles)
    .where(eq(authorProfiles.profileId, authorIdentity(profileId)));
  if (!row || row.readAt === null) return null;
  return { country: row.country, fresh: row.readAt >= now - PROFILE_READ_TTL_MS };
}

/** The profile id some row ties this member urn to, as `canEngage` resolves
 *  it; null for none. */
async function profileOfMember(tx: Tx, memberUrn: string | null | undefined): Promise<string | null> {
  const key = personKey({ memberUrn });
  if (!key) return null;
  const canonical = (await resolvePersonKeys(tx, [key])).get(key);
  return canonical?.startsWith("p.") ? canonical.slice(2) : null;
}
