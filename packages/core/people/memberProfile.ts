import { and, eq, isNull, lte, or } from "drizzle-orm";
import { authorProfiles } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { relationshipOf } from "../conversations/relationship";
import type { RelationshipRead } from "../linkedin/driver";

/**
 * WHOSE PROFILE A MEMBER URN IS, from their own profile page. LinkedIn's
 * conversation data and notification cards name a member by
 * `urn:li:fsd_profile:<id>` alone; an invitation goes by the public
 * identifier their profile address carries (`/preload/custom-invite/
 * ?vanityName=<slug>`). A read of their profile asked for by the urn's id
 * binds the two in the page's own data — its top card keyed by the id, the
 * identifier bound to it, the member's number viewed — and only a read that
 * verified all three, and names exactly that urn, ties them.
 *
 * The pair is kept the way a relationship read is kept: on the person's
 * identity row (`author_profiles.identity_evidence`), which the people
 * directory reads as one more source of member urn ↔ profile id
 * (`memberProfilesSql`) — so the person the urn named is the person the
 * identifier names from then on, and the invite path admits them as anyone.
 */

/** The public identifier `read` binds `memberUrn` to, or null where it does
 *  not: a read not verified as the member asked for, one naming another
 *  urn, or an identifier that is only the id again. */
export function memberProfileOf(read: RelationshipRead, memberUrn: string): string | null {
  const id = read.profile.id;
  if (!read.profile.verified || read.profileUrn !== memberUrn) return null;
  if (id.length === 0 || id === memberUrn.slice(memberUrn.lastIndexOf(":") + 1)) return null;
  return /^[a-z0-9][a-z0-9_%.-]{0,199}$/.test(id) ? id : null;
}

/** Keep the read on the person's identity row, as a relationship read's own
 *  copy is kept: the row opened where none is, and moved only by a read no
 *  older than the one it holds. A read that could not tell the relationship
 *  still ties the urn to the identifier, but only on a row no read has. */
export async function recordMemberProfile(
  tx: Tx,
  input: { channelId: number; profileId: string; read: RelationshipRead },
): Promise<void> {
  const { profileId, read } = input;
  const evidence = { method: "relationship_read" as const, channelId: input.channelId, read };
  const relationship = relationshipOf(read, profileId);
  await tx.insert(authorProfiles).values({ profileId, fetchedAt: 0 }).onConflictDoNothing();
  await tx
    .update(authorProfiles)
    .set(
      relationship === "unknown"
        ? { identityEvidence: evidence }
        : { relationship, relationshipCheckedAt: read.observedAt, identityEvidence: evidence },
    )
    .where(
      and(
        eq(authorProfiles.profileId, profileId),
        relationship === "unknown"
          ? isNull(authorProfiles.identityEvidence)
          : or(isNull(authorProfiles.relationshipCheckedAt), lte(authorProfiles.relationshipCheckedAt, read.observedAt)),
      ),
    );
}
