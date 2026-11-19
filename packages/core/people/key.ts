import { sql, type SQL } from "drizzle-orm";

/** Normalize a LinkedIn profile URL, slug, or member URN to one identity. */
export function authorIdentity(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^author:/, "")
    .replace(/^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

/**
 * ONE KEY PER PERSON, from their LinkedIn identity and nothing else.
 *
 * A person is named by the strongest id any of their rows carries:
 *
 *  - `p.<profileId>` — the public identifier of their profile, the id every
 *    pacing, do-not-engage and conversation read already keys on;
 *  - `m.<id>` — the id in their member urn (`urn:li:fsd_profile:<id>`), the
 *    form LinkedIn's own data names a member by, where no profile id is known;
 *  - `r.<incoming_comments.id>` — a reply that carried neither, which is a
 *    person of its own and never anyone else.
 *
 * A name is never an identity: two people who share one are two keys. An `m.`
 * key some other row ties to a profile id resolves to that `p.` key
 * (`people/directory.ts`); this module reads one row at a time.
 */

/** The Inbox row that holds the owner's own setup, which no person may own. */
export const SETUP_KEY = "setup";

const MEMBER_URN_PREFIX = "urn:li:fsd_profile:";
/** The member id a urn may carry, as the connector's protocol admits it. */
const MEMBER_ID = /^[A-Za-z0-9_-]{1,200}$/;
/** As the connector bounds a profile id. */
const MAX_PROFILE_ID = 1_000;

/** What a row knows of who it is about. */
export type PersonIdentity = {
  profileId?: string | null;
  memberUrn?: string | null;
  /** The reply the row is, or answers — the identity of last resort. */
  incomingCommentId?: number | null;
};

export type ParsedPersonKey =
  | { kind: "profile"; profileId: string }
  | { kind: "member"; memberUrn: string }
  | { kind: "reply"; incomingCommentId: number };

/** The id a member urn carries; null for anything that is not one. */
export function memberId(urn: string | null | undefined): string | null {
  if (!urn?.startsWith(MEMBER_URN_PREFIX)) return null;
  const id = urn.slice(MEMBER_URN_PREFIX.length);
  return MEMBER_ID.test(id) ? id : null;
}

/** The key one row names its person by; null when it names no one. An empty
 *  profile id is no profile id. */
export function personKey(row: PersonIdentity): string | null {
  if (row.profileId) return `p.${row.profileId}`;
  const member = memberId(row.memberUrn);
  if (member !== null) return `m.${member}`;
  if (row.incomingCommentId != null) return `r.${row.incomingCommentId}`;
  return null;
}

/** What a key names; null for anything that is not a person's key, `setup`
 *  included. */
export function parsePersonKey(key: string): ParsedPersonKey | null {
  const rest = key.slice(2);
  if (key.startsWith("p.")) {
    return rest.length > 0 && rest.length <= MAX_PROFILE_ID ? { kind: "profile", profileId: rest } : null;
  }
  if (key.startsWith("m.")) {
    return MEMBER_ID.test(rest) ? { kind: "member", memberUrn: `${MEMBER_URN_PREFIX}${rest}` } : null;
  }
  if (key.startsWith("r.")) {
    return /^[1-9]\d{0,14}$/.test(rest) ? { kind: "reply", incomingCommentId: Number(rest) } : null;
  }
  return null;
}

/**
 * `personKey` in SQL, for a query that groups or counts by person: the same
 * three forms in the same order, over the row's own columns. A caller that
 * resolves member urns passes the profile id a urn is known by as the row's
 * own where it has none.
 */
export function personKeySql(row: { profileId: SQL; memberUrn: SQL; incomingCommentId: SQL }): SQL {
  return sql`(case
    when nullif(${row.profileId}, '') is not null then 'p.' || ${row.profileId}
    when ${row.memberUrn} ~ ${`^${MEMBER_URN_PREFIX}[A-Za-z0-9_-]{1,200}$`}
      then 'm.' || substring(${row.memberUrn} from ${sql.raw(String(MEMBER_URN_PREFIX.length + 1))})
    when ${row.incomingCommentId} is not null then 'r.' || ${row.incomingCommentId}::text
  end)`;
}
