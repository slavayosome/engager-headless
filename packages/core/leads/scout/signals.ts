import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  authorProfiles,
  draftPlans,
  leads,
  leadSignals,
  searchChanges,
  searches,
  searchLookalikes,
  type HeadlineSource,
  type LanguageType,
  type LeadRole,
  type LeadSignalKind,
  type LeadSignalRow,
  type SignalDropReason,
  type SignalVerdict,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { boxKey, forgetComposerBoxes } from "../../composer/drafts";
import { eligiblePersonSql } from "../../discovery/roomPopulation";
import { authorIdentity } from "../../people/key";
import { memberProfilesSql, resolvePersonKeys } from "../../people/directory";
import { personKey } from "../../people/key";
import { lockRoomEvidence } from "../../rooms/eligibility";

/**
 * A person's own words, as Find leads keeps them (`lead_signals`). The words
 * are LinkedIn text: held as data, rendered only as plain text, never read as
 * an instruction.
 */

/** The owner-facing line for each reason the screen drops someone's words. The
 *  run counts them from rows, never from a model's tally. */
export const DROP_REASON_WORDS: Record<SignalDropReason, string> = {
  no_own_words: "No words of their own",
  not_audience: "Not your audience",
  selling_similar: "Selling something like yours",
  already_solved: "A problem already solved",
  recruiter: "A recruiter or a job post",
  student: "A student or looking for work",
};

export type SignalInput = {
  campaignId: number;
  /** Their public profile id, when LinkedIn gave one. */
  profileId?: string | null;
  /** `urn:li:fsd_profile:<id>`, for a person LinkedIn names only so. */
  memberUrn?: string | null;
  name?: string | null;
  headline?: string | null;
  /** Where the headline was read, when there is one. */
  headlineFrom?: HeadlineSource | null;
  kind: LeadSignalKind;
  postUrn: string;
  /** Required exactly when `kind` is comment. */
  commentUrn?: string | null;
  url?: string | null;
  words: string;
  /** When LinkedIn says they wrote it; null when it gives no time. */
  saidAt?: number | null;
  /** How many comments the post had when it was read. */
  commentCount?: number | null;
  languageType?: LanguageType | null;
  phraseId?: number | null;
  runId?: number | null;
  verdict?: SignalVerdict;
  /** When a pending word became expired (fixtures and durable scheduler state). */
  expiredAt?: number | null;
  role?: LeadRole | null;
  /** Required exactly when `verdict` is dropped. */
  dropReason?: SignalDropReason | null;
  reason?: string | null;
  seenAt?: number;
};

export type SignalWrite =
  | { written: true; created: boolean; signal: LeadSignalRow }
  /** `no_person`: neither a profile id nor a member urn names them.
   *  `ineligible`: on the do-not-engage list, an excluded identity, or a
   *  conversation the owner closed. The caller counts the drop on its run. */
  | { written: false; reason: "no_person" | "ineligible" };

/** Land a page under the same exclusion lock and eligibility rules as a single signal. */
export async function writeSignals(tx: Tx, inputs: readonly SignalInput[], lockHeld = false): Promise<number> {
  const entries = inputs.flatMap((input, index) => {
    const profileId = input.profileId ? authorIdentity(input.profileId) : null;
    const key = personKey({ profileId, memberUrn: input.memberUrn });
    return key ? [{ input, index, profileId, key }] : [];
  });
  if (!entries.length) return 0;
  if (!lockHeld) await lockRoomEvidence(tx);
  const resolved = await resolvePersonKeys(tx, entries.map((entry) => entry.key));
  const rows = entries.map(({ input, index, profileId, key }) => {
    const canonical = resolved.get(key) ?? key;
    const profile = canonical.startsWith("p.") ? canonical.slice(2) : profileId;
    return sql`(${index}::int, ${input.campaignId}::int, ${profile}::text, ${input.memberUrn ?? null}::text, ${canonical}::text)`;
  });
  const eligible = await tx.execute<{ idx: number }>(sql`
    with member_profiles as (${memberProfilesSql()}),
    people(idx, campaign_id, profile, member_urn, person_key) as (values ${sql.join(rows, sql`, `)})
    select people.idx from people join campaigns current on current.id = people.campaign_id
    where ${eligiblePersonSql(sql`people.profile`, sql`people.member_urn`, sql`people.person_key`, "all")}`);
  const allowed = new Set(eligible.rows.map((row) => row.idx));
  const now = Date.now();
  const values = entries.filter(({ index }) => allowed.has(index)).map(({ input, profileId, key }) => ({
    campaignId: input.campaignId, personKey: key, profileId,
    memberUrn: input.memberUrn ?? null, name: input.name ?? null, headline: input.headline ?? null,
    headlineFrom: input.headlineFrom ?? null, kind: input.kind, postUrn: input.postUrn,
    commentUrn: input.commentUrn ?? null, url: input.url ?? null, words: input.words,
    saidAt: input.saidAt ?? null, commentCount: input.commentCount ?? null, languageType: input.languageType ?? null,
    phraseId: input.phraseId ?? null, runId: input.runId ?? null, verdict: input.verdict ?? "pending" as const,
    expiredAt: input.expiredAt ?? null, role: input.role ?? null, dropReason: input.dropReason ?? null,
    reason: input.reason ?? null, seenAt: input.seenAt ?? now, createdAt: now,
  }));
  if (!values.length) return 0;
  return (await tx.insert(leadSignals).values(values).onConflictDoNothing().returning({ id: leadSignals.id })).length;
}

/**
 * Keep one signal. Nothing is written for a person the owner has put out of
 * reach: the guard reads the rules room discovery reads (`eligiblePersonSql`),
 * under the lock Never engage takes, so an exclusion that lands first leaves
 * nothing behind and one that lands after erases what was written. The same
 * words found twice in one campaign are one signal; the first sighting stays.
 */
export async function writeSignal(tx: Tx, input: SignalInput): Promise<SignalWrite> {
  const profileId = input.profileId ? authorIdentity(input.profileId) : null;
  const key = personKey({ profileId, memberUrn: input.memberUrn });
  if (!key) return { written: false, reason: "no_person" };

  await lockRoomEvidence(tx);
  // Judge a member urn by the profile it is known to be, as erasure does.
  const canonical = (await resolvePersonKeys(tx, [key])).get(key) ?? key;
  const profile = canonical.startsWith("p.") ? canonical.slice(2) : profileId;
  const eligible = await tx.execute<{ ok: number }>(sql`
    with member_profiles as (${memberProfilesSql()})
    select 1 as ok from campaigns current
    where current.id = ${input.campaignId}
      and ${eligiblePersonSql(sql`${profile}::text`, sql`${input.memberUrn ?? null}::text`, sql`${canonical}::text`, "all")}`);
  if (!eligible.rows.length) return { written: false, reason: "ineligible" };

  const now = Date.now();
  const [inserted] = await tx.insert(leadSignals).values({
    campaignId: input.campaignId,
    personKey: key,
    profileId,
    memberUrn: input.memberUrn ?? null,
    name: input.name ?? null,
    headline: input.headline ?? null,
    headlineFrom: input.headlineFrom ?? null,
    kind: input.kind,
    postUrn: input.postUrn,
    commentUrn: input.commentUrn ?? null,
    url: input.url ?? null,
    words: input.words,
    saidAt: input.saidAt ?? null,
    commentCount: input.commentCount ?? null,
    languageType: input.languageType ?? null,
    phraseId: input.phraseId ?? null,
    runId: input.runId ?? null,
    verdict: input.verdict ?? "pending",
    expiredAt: input.expiredAt ?? null,
    role: input.role ?? null,
    dropReason: input.dropReason ?? null,
    reason: input.reason ?? null,
    seenAt: input.seenAt ?? now,
    createdAt: now,
  }).onConflictDoNothing().returning();
  if (inserted) return { written: true, created: true, signal: inserted };

  const [existing] = await tx.select().from(leadSignals).where(and(
    eq(leadSignals.campaignId, input.campaignId),
    sql`coalesce(${leadSignals.commentUrn}, ${leadSignals.postUrn}) = ${input.commentUrn ?? input.postUrn}`,
  ));
  return { written: true, created: false, signal: existing! };
}

/** What the search map's change log says where a name was erased. */
const ERASED_SOURCE_TERM = "Erased";

/**
 * Erase what these people said: every signal they own, found by any key the
 * caller resolved for them (their own, `p.<profileId>` or `m.<member id>`,
 * the last also through a member urn a profile is known by), the quotes
 * their lead kept (the signal's and the one a reply, DM or note left), what
 * Scout read of them and what it made of it — the ways in their box held, and
 * the openers planned and written to them, among it — and the source Scout started from
 * them, which is read no more, with their name gone from the map's change log.
 * Returns how many signals went.
 */
export async function eraseLeadSignals(tx: Tx, keys: ReadonlySet<string>): Promise<number> {
  if (!keys.size) return 0;
  const values = sql.join([...keys].map((key) => sql`${key}`), sql`, `);
  const gone = await tx.execute<{ id: number }>(sql`
    with member_profiles as (${memberProfilesSql()})
    delete from lead_signals where id in (
      select signal.id from lead_signals signal left join member_profiles alias on alias.urn = signal.member_urn
      where signal.person_key in (${values})
        or 'p.' || coalesce(signal.profile_id, alias.profile_id) in (${values})
        or 'm.' || substring(signal.member_urn from 20) in (${values}))
    returning id`);
  const theirs = sql`'p.' || ${leads.profileId} in (${values})`;
  await eraseSources(tx, values, theirs);
  // The ways in their box held were read from those words, and so were the
  // openers planned and written to them: a plan keyed on the box quotes their
  // words, and its attempts (which go with it) hold the openers.
  const boxes = (await tx.select({ id: leads.id }).from(leads).where(theirs)).map((lead) => boxKey({ kind: "lead", leadId: lead.id }));
  await forgetComposerBoxes(tx, boxes);
  if (boxes.length > 0) await tx.delete(draftPlans).where(sql`(${inArray(draftPlans.boxKey, boxes)}${sql.join(
    boxes.map((key) => sql` or ${draftPlans.boxKey} like ${`${key}:signal:%`}`), sql``,
  )})`);
  await tx
    .update(leads)
    .set({
      intent: null,
      intentQuote: null,
      intentAt: null,
      evidenceQuote: null,
      // And what Scout made of what it read of them.
      qualification: null,
      angles: null,
      updatedAt: Date.now(),
    })
    .where(theirs);
  // And what it read of them, which is the person's, not the lead's.
  await tx
    .update(authorProfiles)
    .set({ profileRead: null, profileReadAt: null })
    .where(sql`'p.' || ${authorProfiles.profileId} in (${values})`);
  // A person Scout found and no one has heard from is nothing but what it read
  // of them, so the row goes too. Anyone who answered keeps theirs.
  await tx.delete(leads).where(and(
    eq(leads.origin, "find_leads"),
    eq(leads.stage, "signal"),
    eq(leads.intentLevel, "none"),
    isNull(leads.triggerIncomingCommentId),
    theirs,
  ));
  return gone.rows.length;
}

/**
 * The sources a peer or competitor became (`searches`, a creator's
 * feed named by their name and profile id) are deleted, so they are never read
 * again, and the change log forgets their name: the changes of those rows and
 * the refusals logged for them before they were one. The posts they wrote that
 * the owner pointed Scout at go the same way: the room request forgets its
 * author, its opening words and the author's proposal, and the One thread row
 * named by those words is deleted. Runs before the lead rows go, which hold the
 * names the log was written with.
 */
async function eraseSources(tx: Tx, values: SQL, theirs: SQL): Promise<void> {
  const rooms = await tx
    .select({ id: searchLookalikes.id, postUrn: searchLookalikes.postUrn, proposals: searchLookalikes.proposals })
    .from(searchLookalikes)
    .where(sql`'p.' || ${searchLookalikes.authorProfileId} in (${values})`);
  for (const room of rooms) {
    await tx
      .update(searchLookalikes)
      .set({
        authorProfileId: null,
        authorName: null,
        authorHeadline: null,
        opening: "",
        proposals: room.proposals.map((proposal) =>
          proposal.intent === "magnet_author"
            ? { intent: proposal.intent, type: proposal.type, term: ERASED_SOURCE_TERM, line: ERASED_SOURCE_TERM, state: "skipped" as const }
            : proposal,
        ),
      })
      .where(eq(searchLookalikes.id, room.id));
  }
  const posts = rooms.map((room) => room.postUrn);
  const sources = [
    ...(await tx
      .select({ id: searches.id, term: searches.term, name: searches.displayName })
      .from(searches)
      .where(and(eq(searches.lane, "creators"), sql`'p.' || lower(${searches.targetRef}) in (${values})`))),
    ...(posts.length > 0
      ? await tx
          .select({ id: searches.id, term: searches.term, name: searches.displayName })
          .from(searches)
          .where(and(eq(searches.lane, "one_thread"), inArray(searches.targetRef, posts)))
      : []),
  ];
  const people = await tx.select({ profileId: leads.profileId, name: leads.name }).from(leads).where(theirs);
  const ids = sources.map((source) => source.id);
  const names = [
    ...new Set([...sources.flatMap((source) => [source.term, source.name]), ...people.flatMap((lead) => [lead.name, lead.profileId])].filter((name): name is string => !!name)),
  ];
  if (ids.length === 0 && names.length === 0) return;
  await tx
    .update(searchChanges)
    .set({ term: ERASED_SOURCE_TERM })
    .where(
      or(
        ids.length > 0 ? inArray(searchChanges.phraseId, ids) : undefined,
        names.length > 0 ? and(isNull(searchChanges.phraseId), inArray(searchChanges.term, names)) : undefined,
      ),
    );
  if (ids.length > 0) await tx.delete(searches).where(inArray(searches.id, ids));
}
