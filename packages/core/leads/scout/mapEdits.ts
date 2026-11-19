import { and, eq, isNull, sql } from "drizzle-orm";
import {
  campaigns,
  discoveryAuthorDismissals,
  searchChanges,
  searches,
  type LanguageType,
  type SearchChangeAction,
  type Search,
  type SourceRole,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { eligiblePersonSql } from "../../discovery/roomPopulation";
import { SOURCE_REFUSAL_COPY, type SourceRefusal } from "../../linkedin/searchTerms";
import { authorIdentity } from "../../people/key";
import { truncateChars } from "../../operations/postSnippets";
import { memberProfilesSql } from "../../people/directory";
import { channelCeilings } from "../../ratelimit/ledger";
import { COMPANY_PAGES_NOT_READ, canUndo, lockSearchMap, phraseSource, startingStatus } from "./map";
import { buyerGathering, type GatherAuthor } from "./mapSummary";
import { oneLine } from "./text";

/**
 * THE OWNER'S HAND ON THE SEARCH MAP: add a phrase or a place to read,
 * replace a phrase, pin, unpin, retire and restore, and undo a change the
 * Scout made. The owner is unbounded — no cap on sweeping rows, no cooldown on
 * a restore, no limit on starts — and the Scout's plan never retires or moves
 * what they pinned or added (`mapPlan.ts`). Every edit is a row of the map's
 * change log, signed by the owner.
 *
 * An edit reads nothing from LinkedIn: the next run sweeps what it changed.
 * It never writes Find posts' searches (`discovery_sources`), and a person
 * added as a source is a place Scout reads, never someone it contacts: no
 * conversation opens, and their own posts and answers never become a signal.
 */

/** Why an edit was refused: Find posts' own reasons for the checks they
 *  share, and the map's own. */
export type MapEditRefusal =
  | SourceRefusal
  | "campaign_not_found"
  | "not_a_profile_link"
  | "own_account"
  | "out_of_reach"
  | "unknown_gatherer"
  | "not_a_phrase"
  | "unknown_change"
  | "no_undo"
  | "already_undone";

const MAP_EDIT_COPY: Record<Exclude<MapEditRefusal, SourceRefusal>, string> = {
  campaign_not_found: "That campaign no longer exists.",
  not_a_profile_link: "A place to read is a LinkedIn profile or company page link (linkedin.com/in/… or linkedin.com/company/…).",
  own_account: "That is the connected account itself.",
  out_of_reach: "You have put this person out of reach, so Scout does not read them.",
  unknown_gatherer: "Their comments no longer hold buyers for this campaign.",
  not_a_phrase: "Only a phrase is edited; retire a place to read and add another.",
  unknown_change: "No change of this campaign's map has that id.",
  no_undo: "Only a change the Scout made, and that still stands, has an undo.",
  already_undone: "That change is already undone.",
};

/** An edit the map refused, and why in the owner's words. */
export type MapEditRefused = { ok: false; code: MapEditRefusal; message: string };

export type MapEdit = { ok: true; phraseId: number; message: string } | MapEditRefused;

const refused = (code: MapEditRefusal): MapEditRefused => ({
  ok: false,
  code,
  message: code in MAP_EDIT_COPY ? MAP_EDIT_COPY[code as keyof typeof MAP_EDIT_COPY] : SOURCE_REFUSAL_COPY[code as SourceRefusal],
});

/** The owner's undo lines in the change log. */
export const UNDID_ADD = "You undid Scout’s add";
export const UNDID_RETIRE = "You undid Scout’s retire";

/** A row back in the rotation, read again from the top. */
const FROM_THE_TOP = {
  status: "active" as const,
  cursor: null,
  nextReadAt: null,
  refusedAt: null,
  retiredAt: null,
  retiredBy: null,
  emptyReads: 0,
};

/** One edit, on a campaign of this organization's, under the lock every plan
 *  and edit of its map takes. */
async function onMap(tx: Tx, campaignId: number, edit: () => Promise<MapEdit>): Promise<MapEdit> {
  const [campaign] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return refused("campaign_not_found");
  await lockSearchMap(tx, campaignId);
  return edit();
}

async function record(
  tx: Tx,
  change: { campaignId: number; phraseId: number; action: SearchChangeAction; term: string; rationale?: string | null; undoes?: number; now: number },
): Promise<void> {
  await tx.insert(searchChanges).values({
    campaignId: change.campaignId,
    phraseId: change.phraseId,
    runId: null,
    actor: "owner",
    action: change.action,
    term: truncateChars(change.term, 200),
    rationale: change.rationale ?? null,
    undoes: change.undoes ?? null,
    createdAt: change.now,
  });
}

async function rowOf(tx: Tx, campaignId: number, phraseId: number): Promise<Search | undefined> {
  const [row] = await tx
    .select()
    .from(searches)
    .where(and(eq(searches.campaignId, campaignId), eq(searches.id, phraseId)));
  return row;
}

async function rowByKey(tx: Tx, campaignId: number, sourceKey: string): Promise<Search | undefined> {
  const [row] = await tx
    .select()
    .from(searches)
    .where(and(eq(searches.campaignId, campaignId), eq(searches.sourceKey, sourceKey)));
  return row;
}

/** The row a new phrase or source lands as: a retired one with its key comes
 *  back as the owner's, keeping its history; otherwise a new row. */
async function landOwnerRow(
  tx: Tx,
  campaignId: number,
  held: Search | undefined,
  values: Pick<typeof searches.$inferInsert, "sourceKey" | "lane" | "term" | "languageType"> &
    Partial<Pick<typeof searches.$inferInsert, "displayName" | "targetRef" | "sourceRole" | "painId" | "pinned">> & {
      origin?: "owner" | "like_a_post";
    },
  now: number,
): Promise<number> {
  const set = { ...values, ...FROM_THE_TOP, status: startingStatus(values.lane), origin: values.origin ?? ("owner" as const), rationale: null, updatedAt: now };
  const [row] = held
    ? await tx.update(searches).set(set).where(eq(searches.id, held.id)).returning({ id: searches.id })
    : await tx.insert(searches).values({ ...set, campaignId, createdAt: now }).returning({ id: searches.id });
  return row!.id;
}

/** Out of the rotation, by the owner's hand; a pin goes with it. */
async function retireRow(tx: Tx, row: Search, now: number, why: { rationale?: string; undoes?: number } = {}): Promise<MapEdit> {
  await tx
    .update(searches)
    .set({ status: "retired", retiredAt: now, retiredBy: "owner", pinned: false, updatedAt: now })
    .where(eq(searches.id, row.id));
  await record(tx, { campaignId: row.campaignId, phraseId: row.id, action: "retire", term: row.term, ...why, now });
  return { ok: true, phraseId: row.id, message: "Retired. Restore it any time." };
}

/** Back in the rotation at once, read from the top. */
async function restoreRow(tx: Tx, row: Search, now: number, why: { rationale?: string; undoes?: number } = {}): Promise<MapEdit> {
  await tx.update(searches).set({ ...FROM_THE_TOP, status: startingStatus(row.lane), updatedAt: now }).where(eq(searches.id, row.id));
  await record(tx, { campaignId: row.campaignId, phraseId: row.id, action: "restore", term: row.term, ...why, now });
  return { ok: true, phraseId: row.id, message: "Restored. The next run reads it from the top." };
}

/** A phrase of the owner's in the Keywords lane, under one kind of language,
 *  held to the checks a search is held to. The same phrase on the map is
 *  refused; one retired comes back. One the owner adds from a post's room
 *  (`origin: "like_a_post"`) is the owner's too, grouped under Like a post
 *  with its kind of language kept for the sweep. */
export async function addPhrase(
  tx: Tx,
  campaignId: number,
  input: { term: string; languageType: LanguageType; painId?: string; origin?: "owner" | "like_a_post" },
  now: number,
): Promise<MapEdit> {
  const phrase = phraseSource(input.term);
  if (!phrase.ok) return refused(phrase.refusal);
  return onMap(tx, campaignId, async () => {
    const held = await rowByKey(tx, campaignId, phrase.sourceKey);
    if (held && held.status !== "retired") return refused("duplicate");
    const phraseId = await landOwnerRow(
      tx,
      campaignId,
      held,
      { sourceKey: phrase.sourceKey, lane: "keywords", term: phrase.term, languageType: input.languageType, painId: input.painId, origin: input.origin },
      now,
    );
    await record(tx, { campaignId, phraseId, action: "add", term: phrase.term, now });
    return { ok: true, phraseId, message: "Added. The next run reads it." };
  });
}

/** The searches the owner confirmed in setup, as their own Pain phrases:
 *  setup asks for searches and no pains, and Find leads reads its map, never
 *  Find posts' searches. A search the map refuses or already holds is left
 *  out. Returns how many it added. */
export async function addSetupSearches(tx: Tx, campaignId: number, terms: readonly string[], now: number): Promise<number> {
  let added = 0;
  for (const term of terms) {
    if ((await addPhrase(tx, campaignId, { term, languageType: "pain" }, now)).ok) added += 1;
  }
  return added;
}

const PLACE_LINK = /^(?:https?:\/\/)?(?:[a-z]+\.)?linkedin\.com\/(in|company)\/([^/?#\s]+)/i;

/** The place a profile or company page link names: who, whether it is a
 *  company page, and the key the map holds it by. Null for any other link.
 *  The scheme is optional, as the form's own example is written; the map keeps
 *  the identity, so `http://`, `https://` and none name the same place. */
export function placeOfLink(link: string): { identity: string; company: boolean; sourceKey: string } | null {
  const match = PLACE_LINK.exec(link.trim());
  let identity = "";
  try {
    identity = match ? authorIdentity(decodeURIComponent(match[2]!)) : "";
  } catch {
    // A link whose escapes do not decode names no one.
  }
  if (!match || !identity) return null;
  const company = match[1]!.toLowerCase() === "company";
  return { identity, company, sourceKey: `${company ? "company" : "author"}:${identity}` };
}

/** Whether a person or page is within the owner's reach: not erased or
 *  excluded, not on do-not-engage, not on a conversation they closed. */
export async function inReach(tx: Tx, campaignId: number, identity: string): Promise<boolean> {
  const read = await tx.execute<{ ok: number }>(sql`
    with member_profiles as (${memberProfilesSql()})
    select 1 as ok from campaigns current
    where current.id = ${campaignId}
      and ${eligiblePersonSql(sql`${identity}::text`, sql`null::text`, sql`${`p.${identity}`}::text`, "all")}`);
  return read.rows.length > 0;
}

/**
 * A place for Scout to read for buyers, from a LinkedIn link: a person's
 * profile goes to the Creators lane, a company page to Competitors. Their own
 * posts are read for the comments under them; they are never a lead. The
 * connected account itself, someone the owner put out of reach, and a place
 * already on the map are refused; one retired comes back. "Follow as a
 * search" adds the same way (`followGatherSource`), and so does a proposal
 * the owner presses Add on.
 * A name, when the caller has one, is what the row is called; else the slug.
 * A company page is kept parked: nothing reads one yet (ruling 23).
 */
export async function addSearchSource(
  tx: Tx,
  campaignId: number,
  input: { link: string; name?: string | null; role?: SourceRole },
  now: number,
): Promise<MapEdit> {
  const place = placeOfLink(input.link);
  if (!place) return refused("not_a_profile_link");
  const { identity, company, sourceKey } = place;
  const name = oneLine(input.name, 200);
  return onMap(tx, campaignId, async () => {
    const account = (await channelCeilings(tx))?.externalAccountId ?? null;
    if (account !== null && authorIdentity(account) === identity) return refused("own_account");
    if (!(await inReach(tx, campaignId, identity))) return refused("out_of_reach");
    const held = await rowByKey(tx, campaignId, sourceKey);
    if (held && held.status !== "retired") return refused("duplicate");
    const term = name ?? held?.term ?? identity;
    const phraseId = await landOwnerRow(
      tx,
      campaignId,
      held,
      {
        sourceKey,
        lane: company ? "competitors" : "creators",
        term,
        displayName: name ?? held?.displayName ?? null,
        languageType: null,
        targetRef: identity,
        sourceRole: company ? "competitor" : (input.role ?? held?.sourceRole ?? null),
      },
      now,
    );
    await record(tx, { campaignId, phraseId, action: "add", term, now });
    return { ok: true, phraseId, message: company ? `Added. ${COMPANY_PAGES_NOT_READ}` : "Added. The next run reads the comments under their posts." };
  });
}

/** The person or page Where buyers gather holds for the campaign right now,
 *  found by the identity the owner pressed: none once the campaign is deleted,
 *  or their rooms have aged out of the windows, or the owner dismissed them.
 *  Their name and kind come from here, never from the caller. */
async function currentGatherer(tx: Tx, campaignId: number, profileId: string, now: number): Promise<GatherAuthor | null> {
  const identity = authorIdentity(profileId);
  const [campaign] = identity
    ? await tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)))
    : [];
  if (!campaign) return null;
  return (await buyerGathering(tx, campaignId, now)).authors.find((author) => author.profileId.toLowerCase() === identity) ?? null;
}

/**
 * "Follow as a search", from Where buyers gather: the person or company page
 * whose comments held buyers becomes a place Scout reads — a person in
 * Creators, a page in Competitors — added exactly as the owner's link would
 * add them, under the name and kind the campaign's own evidence gives them. An
 * identity that evidence no longer names is refused. Scout reads their comment
 * sections and never contacts them.
 */
export async function followGatherSource(tx: Tx, campaignId: number, input: { profileId: string }, now: number): Promise<MapEdit> {
  const author = await currentGatherer(tx, campaignId, input.profileId, now);
  if (!author) return refused("unknown_gatherer");
  const path = author.lane === "competitors" ? "company" : "in";
  return addSearchSource(tx, campaignId, { link: `https://www.linkedin.com/${path}/${encodeURIComponent(author.profileId)}`, name: author.name }, now);
}

/** Dismiss a person or page from Where buyers gather: Scout no longer
 *  suggests them for this campaign, as a place it starts or one a room
 *  proposes. Only one the campaign's evidence names and the map does not
 *  already read can be dismissed. It writes no row of the map. */
export async function dismissGatherAuthor(
  tx: Tx,
  campaignId: number,
  profileId: string,
  now: number,
): Promise<{ ok: true; message: string } | MapEditRefused> {
  const author = await currentGatherer(tx, campaignId, profileId, now);
  if (!author || author.following) return refused("unknown_gatherer");
  await tx
    .insert(discoveryAuthorDismissals)
    .values({ campaignId, authorIdentity: authorIdentity(author.profileId), dismissedAt: now })
    .onConflictDoNothing();
  return { ok: true, message: "Dismissed. Scout will not suggest them again for this campaign." };
}

/**
 * The owner's rewrite of a phrase: the old row is retired with its history
 * and its replacement starts as the owner's, keeping the old one's pain and
 * pin. Only the kind of language changing edits the row in place. Checked in
 * full before anything moves, so a refusal leaves both as they were.
 */
export async function editPhrase(
  tx: Tx,
  campaignId: number,
  input: { phraseId: number; term: string; languageType?: LanguageType },
  now: number,
): Promise<MapEdit> {
  const phrase = phraseSource(input.term);
  if (!phrase.ok) return refused(phrase.refusal);
  return onMap(tx, campaignId, async () => {
    const old = await rowOf(tx, campaignId, input.phraseId);
    if (!old || old.status === "retired") return refused("unknown_source");
    if (old.lane !== "keywords") return refused("not_a_phrase");
    const languageType = input.languageType ?? old.languageType;
    if (phrase.sourceKey === old.sourceKey) {
      await tx.update(searches).set({ term: phrase.term, languageType, updatedAt: now }).where(eq(searches.id, old.id));
      await record(tx, { campaignId, phraseId: old.id, action: "edit", term: phrase.term, now });
      return { ok: true, phraseId: old.id, message: "Saved." };
    }
    const held = await rowByKey(tx, campaignId, phrase.sourceKey);
    if (held && held.status !== "retired") return refused("duplicate");
    await retireRow(tx, old, now, { rationale: `Replaced by “${phrase.term}”.` });
    const phraseId = await landOwnerRow(
      tx,
      campaignId,
      held,
      { sourceKey: phrase.sourceKey, lane: "keywords", term: phrase.term, languageType, painId: old.painId, pinned: old.pinned },
      now,
    );
    await record(tx, { campaignId, phraseId, action: "edit", term: phrase.term, rationale: `Replaces “${old.term}”.`, now });
    return { ok: true, phraseId, message: "Replaced. The old search keeps its history in Retired; the next run reads the new one." };
  });
}

async function setPinned(tx: Tx, campaignId: number, phraseId: number, pinned: boolean, now: number): Promise<MapEdit> {
  return onMap(tx, campaignId, async () => {
    const row = await rowOf(tx, campaignId, phraseId);
    if (!row || row.status === "retired") return refused("unknown_source");
    if (row.pinned !== pinned) {
      await tx.update(searches).set({ pinned, updatedAt: now }).where(eq(searches.id, row.id));
      await record(tx, { campaignId, phraseId: row.id, action: pinned ? "pin" : "unpin", term: row.term, now });
    }
    return { ok: true, phraseId: row.id, message: pinned ? "Pinned. The Scout keeps it." : "Unpinned. The Scout may retire it." };
  });
}

/** Pin a live row: the Scout keeps it whatever it finds. */
export const pinPhrase = (tx: Tx, campaignId: number, phraseId: number, now: number) => setPinned(tx, campaignId, phraseId, true, now);

/** Unpin a row: the Scout may retire it again. */
export const unpinPhrase = (tx: Tx, campaignId: number, phraseId: number, now: number) => setPinned(tx, campaignId, phraseId, false, now);

/** Retire a live row: it is read no more, and the Scout never brings it back. */
export async function retirePhrase(tx: Tx, campaignId: number, phraseId: number, now: number): Promise<MapEdit> {
  return onMap(tx, campaignId, async () => {
    const row = await rowOf(tx, campaignId, phraseId);
    return !row || row.status === "retired" ? refused("unknown_source") : retireRow(tx, row, now);
  });
}

/** Bring a retired row back, the owner's or the Scout's: the owner keeps no
 *  cooldown. */
export async function restorePhrase(tx: Tx, campaignId: number, phraseId: number, now: number): Promise<MapEdit> {
  return onMap(tx, campaignId, async () => {
    const row = await rowOf(tx, campaignId, phraseId);
    if (!row) return refused("unknown_source");
    return row.status === "retired" ? restoreRow(tx, row, now) : { ok: true, phraseId: row.id, message: "It is already on the map." };
  });
}

/**
 * Undo one of the Scout's changes, from the run page or the Searches log: an
 * add, or a source it started reading, becomes a retirement, and a
 * retirement a restore, each logged as the owner's with the change it took
 * back. A change the owner made, one already undone, or one whose row no
 * longer stands as the change left it has no undo.
 */
export async function undoMapChange(tx: Tx, input: { campaignId: number; changeId: number }, now: number): Promise<MapEdit> {
  const { campaignId } = input;
  return onMap(tx, campaignId, async () => {
    const [change] = await tx
      .select()
      .from(searchChanges)
      .where(and(eq(searchChanges.campaignId, campaignId), eq(searchChanges.id, input.changeId)));
    if (!change) return refused("unknown_change");
    const [undone] = await tx
      .select({ id: searchChanges.id })
      .from(searchChanges)
      .where(eq(searchChanges.undoes, change.id));
    if (undone) return refused("already_undone");
    const row = change.phraseId === null ? undefined : await rowOf(tx, campaignId, change.phraseId);
    if (!row || !canUndo(change, row, false)) return refused("no_undo");
    return change.action === "add"
      ? retireRow(tx, row, now, { rationale: UNDID_ADD, undoes: change.id })
      : restoreRow(tx, row, now, { rationale: UNDID_RETIRE, undoes: change.id });
  });
}
