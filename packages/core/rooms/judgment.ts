import { z } from "zod";
import { AppError } from "@engager/common/errors";
import type { PostThread } from "../linkedin/driver";
import { memberId, personKey } from "../people/key";
import { authorIdentity } from "../people/key";

export type RoomComment = PostThread["comments"][number] & { ref: string };
export type RoomPerson = {
  ref: string;
  personKey: string;
  profileId: string | null;
  memberUrn: string | null;
  name: string | null;
  headline: string | null;
  comments: RoomComment[];
};

export class InvalidRoomJudgment extends AppError {
  constructor(message: string) { super("invalid_room_judgment", message, 400); }
}

/** Freeze identities and their source comments before asking for judgments.
 * Aliases come from the canonical directory; a name never joins two people. */
export function roomPeople(
  comments: PostThread["comments"],
  context: { aliases: ReadonlyMap<string, string>; excluded: ReadonlySet<string>; authorKey: string | null },
): RoomPerson[] {
  const pairs = new Map<string, Set<string>>();
  for (const comment of comments) {
    const member = memberId(comment.memberUrn);
    const profile = comment.authorProfileId ? authorIdentity(comment.authorProfileId) : null;
    if (!member || !profile || comment.authorIsCompany) continue;
    const keys = pairs.get(`m.${member}`) ?? new Set<string>();
    keys.add(`p.${profile}`);
    pairs.set(`m.${member}`, keys);
  }
  for (const [member, keys] of pairs) {
    const known = context.aliases.get(member);
    if (known && known !== member) keys.add(known);
  }
  const resolve = (key: string) => {
    const local = pairs.get(key);
    if (local && local.size === 1) return [...local][0]!;
    return context.aliases.get(key) ?? key;
  };
  const excluded = new Set([...context.excluded].map(resolve));
  if (context.authorKey) excluded.add(resolve(context.authorKey));
  // An owner's second comment can lack isOwner; its identity still belongs
  // to the owner, so remove all evidence for it before freezing references.
  for (const comment of comments.filter((entry) => entry.isOwner)) {
    const key = personKey({ profileId: comment.authorProfileId ? authorIdentity(comment.authorProfileId) : null, memberUrn: comment.memberUrn });
    if (key) excluded.add(resolve(key));
    if (comment.memberUrn && memberId(comment.memberUrn)) excluded.add(resolve(`m.${memberId(comment.memberUrn)}`));
  }
  const people = new Map<string, RoomPerson>();
  const seenComments = new Set<string>();
  comments.forEach((comment, index) => {
    if (comment.authorIsCompany || comment.isOwner || seenComments.has(comment.commentUrn)) return;
    seenComments.add(comment.commentUrn);
    const profileId = comment.authorProfileId ? authorIdentity(comment.authorProfileId) : null;
    const member = memberId(comment.memberUrn);
    const memberKey = member ? `m.${member}` : null;
    // Conflicting aliases are unresolved, not two matching people.
    if (memberKey && (pairs.get(memberKey)?.size ?? 0) > 1) return;
    const key = personKey({ profileId, memberUrn: comment.memberUrn });
    if (!key) return;
    const canonical = resolve(key);
    if (excluded.has(canonical) || (memberKey && excluded.has(resolve(memberKey)))) return;
    let person = people.get(canonical);
    if (!person) {
      person = {
        ref: `person-${people.size}`, personKey: canonical,
        profileId: canonical.startsWith("p.") ? canonical.slice(2) : null,
        memberUrn: member ? comment.memberUrn! : null,
        name: comment.authorName ?? null, headline: comment.authorHeadline ?? null, comments: [],
      };
      people.set(canonical, person);
    }
    person.memberUrn ??= member ? comment.memberUrn! : null;
    person.comments.push({ ...comment, ref: `comment-${index}` });
  });
  return [...people.values()];
}

export const roomJudgmentSchema = z.object({
  personRef: z.string(),
  evidenceRefs: z.array(z.string()).min(1).max(100),
  fit: z.enum(["fits", "maybe", "not"]),
  painId: z.string().optional(),
  reason: z.string().trim().min(1).max(500),
}).strict();
export type RoomJudgment = z.infer<typeof roomJudgmentSchema>;
export type JudgedRoomPerson = RoomPerson & {
  fit: RoomJudgment["fit"] | "unknown";
  painId: string | null;
  reason: string | null;
  evidenceRefs: string[];
  /** Where a profile read placed a person the judge called fits, and when
   *  (`rooms/countries.ts`); null for anyone not placed. */
  country: string | null;
  countryReadAt: number | null;
};

/** Missing answers remain unknown in the same denominator. Unknown identities
 * and evidence from a different person refuse the result as a whole. */
export function judgeRoomPeople(people: readonly RoomPerson[], input: unknown, activePainIds: ReadonlySet<string>): JudgedRoomPerson[] {
  const judgments = z.array(roomJudgmentSchema).max(100).parse(input);
  const frozen = new Map(people.map((person) => [person.ref, person]));
  const byPerson = new Map<string, RoomJudgment>();
  for (const judgment of judgments) {
    const person = frozen.get(judgment.personRef);
    if (!person || byPerson.has(judgment.personRef)) throw new InvalidRoomJudgment("Unknown or duplicate person reference.");
    const evidence = new Set(person.comments.map((comment) => comment.ref));
    if (new Set(judgment.evidenceRefs).size !== judgment.evidenceRefs.length || judgment.evidenceRefs.some((ref) => !evidence.has(ref))) {
      throw new InvalidRoomJudgment("Comment evidence must belong to the selected person.");
    }
    if (judgment.painId && !activePainIds.has(judgment.painId)) throw new InvalidRoomJudgment("The pain is not active in this Audience revision.");
    byPerson.set(judgment.personRef, judgment);
  }
  return people.map((person) => {
    const judgment = byPerson.get(person.ref);
    return { ...person, fit: judgment?.fit ?? "unknown", painId: judgment?.painId ?? null,
      reason: judgment?.reason ?? null, evidenceRefs: judgment?.evidenceRefs ?? [], country: null, countryReadAt: null };
  });
}

export function roomSummary(people: readonly JudgedRoomPerson[], pages: 1 | 2) {
  const fits = people.filter((person) => person.fit === "fits").length;
  return {
    judged: people.length, fits,
    maybe: people.filter((person) => person.fit === "maybe").length,
    unknown: people.filter((person) => person.fit === "unknown").length,
    density: people.length ? fits / people.length : 0, pages,
  };
}

/** The shared author/room decision. Contact caps affect the author path only;
 * hard content faults reject even a room full of otherwise matching people.
 * An eligible author the judge called maybe, with no room to carry the post,
 * is the owner's call (`author_maybe`): it reaches the deck, never a worker. */
export function decideJoin(input: {
  authorFit: "fits" | "maybe" | "not";
  authorContactEligible: boolean;
  contentFault?: "off_topic" | "engagement_bait" | "no_contribution_possible";
  room: ReturnType<typeof roomSummary>;
  /** Server page two enriches a room that already qualified on page one. */
  firstPageRoom?: { judged: number; fits: number };
}) {
  if (input.contentFault) return { lens: "none" as const, reasonCode: input.contentFault, reason: null };
  const author = input.authorFit === "fits" && input.authorContactEligible;
  const qualifies = (room: { judged: number; fits: number }) => room.fits >= 2 || (room.fits >= 1 && room.judged <= 5);
  const room = qualifies(input.room) || (input.firstPageRoom !== undefined && qualifies(input.firstPageRoom));
  if (author || room) return { lens: author && room ? "both" as const : author ? "author" as const : "room" as const, reasonCode: null, reason: null };
  if (input.authorFit === "maybe" && input.authorContactEligible) return { lens: "author_maybe" as const, reasonCode: null, reason: null };
  return { lens: "none" as const, reasonCode: "empty_room" as const,
    reason: input.room.fits > 0 || input.room.maybe > 0 || input.room.judged === 0 || input.room.unknown > 0
      ? "Not enough audience evidence" : "Nobody fits this audience" };
}
