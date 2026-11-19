import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { audienceThemes, candidateResearch, engagedProfiles, roomExclusions, roomMembers, roomReplyDrafts, roomReplyAssists } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { PostThread } from "../linkedin/driver";
import { memberProfilesSql, resolvePersonKeys } from "../people/directory";
import { memberId, personKey } from "../people/key";
import { authorIdentity } from "../people/key";
import { cancelPersonMessages } from "../operations/cancelPersonMessages";
import { purgeUnkeptThemePain } from "../audience/write";
import { boxKey, forgetComposerBoxes } from "../composer/drafts";
import { eraseLeadSignals } from "../leads/scout/signals";
import { lockRoomEvidence, roomContactSql, ROOM_RETENTION_MS } from "./eligibility";

function commentKeys(comment: PostThread["comments"][number]) {
  const profile = comment.authorProfileId ? authorIdentity(comment.authorProfileId) : null;
  const member = memberId(comment.memberUrn);
  return [...(profile ? [`p.${profile}`] : []), ...(member ? [`m.${member}`] : [])];
}

/** Minimal exclusion ids, resolved by the same directory as a person link.
 * This also covers a member-only block whose public profile was learned later. */
export async function excludedRoomKeys(tx: Tx): Promise<Set<string>> {
  const rows = await tx.select().from(roomExclusions);
  const blocked = await tx.select({ profile: engagedProfiles.profileId }).from(engagedProfiles)
    .where(eq(engagedProfiles.doNotEngage, true));
  const keys = [...rows.flatMap((row) => [row.identityKey, row.personKey]),
    ...blocked.map((row) => `p.${authorIdentity(row.profile)}`)];
  const resolved = await resolvePersonKeys(tx, keys);
  return new Set([...keys, ...resolved.values()]);
}

/** Provider/cache reads are data, not a route around an earlier exclusion. */
export async function withoutExcludedRoomComments(tx: Tx, thread: PostThread): Promise<PostThread> {
  const excluded = await excludedRoomKeys(tx);
  if (!excluded.size) return thread;
  const aliases = await resolvePersonKeys(tx, thread.comments.flatMap(commentKeys));
  return { ...thread, comments: thread.comments.filter((comment) =>
    !commentKeys(comment).some((key) => excluded.has(key) || excluded.has(aliases.get(key) ?? key))) };
}

/** A later provider read may be the first source tying a blocked member id
 * to a public profile. Keep only that minimal pair before discarding their
 * comment, so a subsequent profile-only read cannot restore discovery. This
 * is a write-boundary operation, never a side effect of a cached UI read. */
export async function rememberExcludedRoomAliases(tx: Tx, thread: PostThread, now = Date.now()) {
  await lockRoomEvidence(tx);
  const excluded = await excludedRoomKeys(tx);
  if (!excluded.size) return;
  const pairs = new Map<string, Set<string>>();
  for (const comment of thread.comments) {
    const keys = commentKeys(comment);
    const profile = keys.find((key) => key.startsWith("p."));
    const member = keys.find((key) => key.startsWith("m."));
    if (profile && member) pairs.set(member, new Set([...(pairs.get(member) ?? []), profile]));
  }
  for (const [member, profiles] of pairs) {
    if (profiles.size !== 1) continue;
    const profile = [...profiles][0]!;
    if (!excluded.has(member) && !excluded.has(profile)) continue;
    await tx.insert(roomExclusions).values([member, profile].map((identityKey) => ({
      identityKey, personKey: profile, createdAt: now,
    }))).onConflictDoNothing();
    await tx.update(roomExclusions).set({ personKey: profile })
      .where(and(eq(roomExclusions.identityKey, member), eq(roomExclusions.personKey, member)));
    excluded.add(member);
    excluded.add(profile);
  }
}

/** Delete discovery evidence, including raw cached copies on posts whose
 * room was never judged. Receipt rows and owner-kept notes are not discovery
 * stores; an uncertain dispatch keeps its own minimum target/receipt binding.
 *
 * `signals` also erases what Find leads kept of these people: their words, the
 * quote their lead holds and the source Scout started from them, with their name
 * in the search map's change log. Only Never engage asks for it. A room that
 * ages out forgets the room, not a lead that was researched from it. */
export async function purgeRoomDiscovery(tx: Tx, personKeys: readonly string[], options: { signals?: boolean } = {}) {
  if (!personKeys.length) return { people: 0, members: 0 };
  await lockRoomEvidence(tx);
  const aliases = await resolvePersonKeys(tx, personKeys);
  const keys = new Set([...personKeys, ...aliases.values()]);
  await cancelPersonMessages(tx, [...keys]);
  const values = sql.join([...keys].map((key) => sql`${key}`), sql`, `);
  const rows = await tx.execute<{ id: number; personKey: string; profileId: string | null; memberUrn: string | null;
    comments: PostThread["comments"] }>(sql`
    with member_profiles as (${memberProfilesSql()})
    select member.id::int as id, member.person_key as "personKey", member.profile_id as "profileId",
      member.member_urn as "memberUrn", member.comments
    from room_members member left join member_profiles alias on alias.urn = member.member_urn
    where member.person_key in (${values}) or 'p.' || coalesce(member.profile_id, alias.profile_id) in (${values})
      or 'm.' || substring(member.member_urn from 20) in (${values})`);
  const commentUrns = new Set(rows.rows.flatMap((row) => row.comments.map((comment) => comment.commentUrn)));
  for (const row of rows.rows) {
    keys.add(row.personKey);
    const key = personKey(row);
    if (key) keys.add(key);
    const member = memberId(row.memberUrn);
    if (member) keys.add(`m.${member}`);
  }
  // Resolve raw-cache aliases while the room rows that establish them still
  // exist. Bounded pages avoid loading every stored thread into memory.
  let after = 0;
  while (true) {
    const batch = await tx.select({ id: candidateResearch.id, thread: candidateResearch.thread }).from(candidateResearch)
      .where(and(gt(candidateResearch.id, after), isNotNull(candidateResearch.thread)))
      .orderBy(candidateResearch.id).limit(200);
    if (!batch.length) break;
    const resolved = await resolvePersonKeys(tx, batch.flatMap((row) => row.thread!.comments.flatMap(commentKeys)));
    for (const row of batch) {
      const thread = row.thread!;
      const comments = thread.comments.filter((comment) => !commentUrns.has(comment.commentUrn) &&
        !commentKeys(comment).some((key) => keys.has(key) || keys.has(resolved.get(key) ?? key)));
      if (comments.length !== thread.comments.length) await tx.update(candidateResearch).set({
        thread: { ...thread, comments }, threadReadAt: null, alreadySaid: [], reason: null,
        authorReplyRate: null, updatedAt: Date.now(),
      }).where(eq(candidateResearch.id, row.id));
    }
    after = batch.at(-1)!.id;
  }
  const draftKeys = sql.join([...keys].map((key) => sql`${key}`), sql`, `);
  // Claim text can identify a person too. Remove claims that lose their last
  // retained source, rather than merely hiding a dead comment link in the UI.
  let afterClaim = 0;
  while (true) {
    const claims = await tx.select({ id: candidateResearch.id, insights: candidateResearch.insights }).from(candidateResearch)
      .where(and(gt(candidateResearch.id, afterClaim), isNotNull(candidateResearch.insights)))
      .orderBy(candidateResearch.id).limit(200);
    if (!claims.length) break;
    for (const row of claims) {
      const insights = row.insights!.flatMap((item) => {
        const sourceRefs = item.sourceRefs.filter((source) => !keys.has(source.personKey) && !commentUrns.has(source.commentUrn));
        return sourceRefs.length ? [{ ...item, sourceRefs }] : [];
      });
      if (JSON.stringify(insights) !== JSON.stringify(row.insights)) await tx.update(candidateResearch).set({ insights })
        .where(eq(candidateResearch.id, row.id));
    }
    afterClaim = claims.at(-1)!.id;
  }
  const erased = await tx.update(roomReplyDrafts).set({ target: null, erasedAt: Date.now(), assistTexts: [], ownerWords: [],
    assistRetention: null, ownerOrigin: null, revision: sql`${roomReplyDrafts.revision} + 1`, updatedAt: Date.now() })
    .where(sql`${roomReplyDrafts.target} ->> 'personKey' in (${draftKeys})
      or 'p.' || (${roomReplyDrafts.target} ->> 'profileId') in (${draftKeys})
      or 'm.' || substring(${roomReplyDrafts.target} ->> 'memberUrn' from 20) in (${draftKeys})`)
    .returning({ targetKey: roomReplyDrafts.targetKey });
  const offers = await tx.delete(roomReplyAssists).where(sql`${roomReplyAssists.target} ->> 'personKey' in (${draftKeys})
    or 'p.' || (${roomReplyAssists.target} ->> 'profileId') in (${draftKeys})
    or 'm.' || substring(${roomReplyAssists.target} ->> 'memberUrn' from 20) in (${draftKeys})`)
    .returning({ targetKey: roomReplyAssists.targetKey });
  // The angles their boxes kept go with the offers: each room reply's, and
  // the invite note's.
  await forgetComposerBoxes(tx, [
    ...[...erased, ...offers].map((row) => boxKey({ kind: "room", targetKey: row.targetKey })),
    ...[...keys].map((key) => boxKey({ kind: "invite", personKey: key })),
  ]);
  let afterTheme: string | undefined;
  while (true) {
    const themes = await tx.select().from(audienceThemes)
      .where(afterTheme ? gt(audienceThemes.id, afterTheme) : undefined).orderBy(audienceThemes.id).limit(200);
    if (!themes.length) break;
    for (const theme of themes) {
      const sourceRefs = theme.sourceRefs.flatMap((source) => {
        const comments = source.comments.filter((comment) => !keys.has(comment.personKey) && !commentUrns.has(comment.commentUrn));
        return comments.length ? [{ ...source, comments }] : [];
      });
      if (JSON.stringify(sourceRefs) === JSON.stringify(theme.sourceRefs)) continue;
      const rooms = new Set(sourceRefs.map((source) => source.discoveredPostId)).size;
      const comments = new Set(sourceRefs.flatMap((source) => source.comments.map((comment) => comment.commentUrn))).size;
      await purgeUnkeptThemePain(tx, theme.campaignId, theme.id, rooms, Date.now());
      await tx.update(audienceThemes).set({ sourceRefs, rooms, comments, phrases: [],
        status: rooms < 2 ? "past" : theme.status,
        ...(rooms === 0 ? { text: "Evidence no longer retained" } : {}),
      }).where(eq(audienceThemes.id, theme.id));
    }
    afterTheme = themes.at(-1)!.id;
  }
  // Find leads' words are discovery evidence too. Aliases resolve through the
  // room rows still standing, so they go before the members do.
  if (options.signals) await eraseLeadSignals(tx, keys);
  if (rows.rows.length) await tx.delete(roomMembers).where(inArray(roomMembers.id, rows.rows.map((row) => row.id)));
  return { people: new Set(aliases.values()).size, members: rows.rows.length };
}

/** Persist aliases before erasure, so removing evidence cannot erase the
 * identity that makes Never engage effective. No names or text are retained. */
export async function excludeRoomIdentity(tx: Tx, key: string, now = Date.now()) {
  await lockRoomEvidence(tx);
  const canonical = (await resolvePersonKeys(tx, [key])).get(key);
  if (!canonical || !/^[pm]\./.test(canonical)) throw new Error("No LinkedIn identity is known for this person.");
  const rows = await tx.select({ personKey: roomMembers.personKey, memberUrn: roomMembers.memberUrn }).from(roomMembers);
  const aliases = await resolvePersonKeys(tx, rows.map((row) => row.personKey));
  const identities = new Set([key, canonical]);
  for (const row of rows) {
    if ((aliases.get(row.personKey) ?? row.personKey) !== canonical) continue;
    identities.add(row.personKey);
    const member = memberId(row.memberUrn);
    if (member) identities.add(`m.${member}`);
  }
  await tx.insert(roomExclusions).values([...identities].filter((identity) => /^[pm]\./.test(identity)).map((identityKey) => ({
    identityKey, personKey: canonical, createdAt: now,
  }))).onConflictDoNothing();
  return purgeRoomDiscovery(tx, [...identities], { signals: true });
}

export async function clearRoomExclusion(tx: Tx, key: string) {
  await lockRoomEvidence(tx);
  const rows = await tx.select().from(roomExclusions);
  const aliases = await resolvePersonKeys(tx, [key, ...rows.flatMap((row) => [row.identityKey, row.personKey])]);
  const canonical = aliases.get(key) ?? key;
  const identities = rows.filter((row) => (aliases.get(row.identityKey) ?? row.identityKey) === canonical ||
    (aliases.get(row.personKey) ?? row.personKey) === canonical).map((row) => row.identityKey);
  if (identities.length) await tx.delete(roomExclusions).where(inArray(roomExclusions.identityKey, identities));
}

/** Daily, idempotent retention. The clock is the latest qualifying room
 * evidence, never a draft or a newly opened conversation. Confirmed contact keeps
 * its existing history policy. No provider or model is involved. */
export async function forgetSpotted(tx: Tx, now = Date.now()) {
  await lockRoomEvidence(tx);
  const expired = await tx.delete(roomReplyAssists).where(sql`${roomReplyAssists.evidenceExpiresAt} <= ${now}`)
    .returning({ targetKey: roomReplyAssists.targetKey, deliverable: roomReplyAssists.deliverable });
  await forgetComposerBoxes(tx, expired.flatMap((row) =>
    row.deliverable === "reply" ? [boxKey({ kind: "room", targetKey: row.targetKey })] : []));
  await tx.update(roomMembers).set({ draftRequestId: null, draftRequestedAt: null, draftRequest: null })
    .where(sql`${roomMembers.draftRequestedAt} <= ${now - ROOM_RETENTION_MS}`);
  const profile = sql`coalesce(member.profile_id, alias.profile_id)`;
  const rows = await tx.execute<{ key: string }>(sql`
    with member_profiles as (${memberProfilesSql()}), seen as (
      select coalesce('p.' || ${profile}, member.person_key) as key,
        snapshot.read_at, member.fit, ${roomContactSql(profile, sql`member.member_urn`, sql`campaign.channel_id`)} as contacted
      from room_members member join room_snapshots snapshot on snapshot.id = member.snapshot_id
      join campaigns campaign on campaign.id = snapshot.campaign_id
      left join member_profiles alias on alias.urn = member.member_urn
    ) select key from seen group by key
      having coalesce(max(read_at) filter (where fit = 'fits'), max(read_at)) <= ${now - ROOM_RETENTION_MS}
        and not bool_or(contacted)`);
  const result = await purgeRoomDiscovery(tx, rows.rows.map((row) => row.key));
  // Unjudged raw reads contain comment authors too. They have no qualifying
  // person evidence to renew their retention clock.
  await tx.update(candidateResearch).set({ thread: null, threadReadAt: null, alreadySaid: [], reason: null, authorReplyRate: null })
    .where(and(isNotNull(candidateResearch.thread), sql`coalesce(${candidateResearch.threadReadAt}, ${candidateResearch.updatedAt}) <= ${now - ROOM_RETENTION_MS}`,
      sql`${candidateResearch.roomSnapshotId} is null`));
  return result;
}
