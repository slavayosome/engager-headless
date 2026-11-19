import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { audienceThemes, campaigns, candidateResearch, discoveredPosts, roomSnapshots,
  type AudienceThemeSourceJson } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { resolvePersonKeys } from "../people/directory";
import { lockRoomEvidence } from "../rooms/eligibility";
import { readRoomInsightEvidence } from "../rooms/insights";
import { audienceProfile } from "./model";
import { AudienceNotFound, InvalidAudience, setProposedPains } from "./write";
import { bindAudienceThemes, evidenceHash, themeResultSchema, THEME_WINDOW_MS, type ThemeEvidenceBatch, type ThemeEvidenceItem } from "./themeEvidence";

export class StaleAudienceThemes extends AppError {
  constructor() { super("audience_themes_stale", "The audience or its room evidence changed. Gather the current evidence before rolling up themes.", 409); }
}

/** One local evidence reader, shared by rollup validation and current views.
 * It does not call a model, schedule work, or read LinkedIn. */
export async function readAudienceThemeEvidence(tx: Tx, campaignId: number, now = Date.now()): Promise<ThemeEvidenceBatch | null> {
  const [campaign] = await tx.select().from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  if (!campaign) return null;
  const rows = await tx.select({ post: discoveredPosts, research: candidateResearch, snapshot: roomSnapshots })
    .from(candidateResearch).innerJoin(discoveredPosts, eq(discoveredPosts.id, candidateResearch.discoveredPostId))
    .innerJoin(roomSnapshots, eq(roomSnapshots.id, candidateResearch.roomSnapshotId))
    .where(and(eq(candidateResearch.campaignId, campaignId), eq(candidateResearch.verdict, "confirmed"),
      eq(roomSnapshots.audienceRevision, campaign.audienceRevision), gt(roomSnapshots.readAt, now - THEME_WINDOW_MS), lte(roomSnapshots.readAt, now)))
    .orderBy(asc(discoveredPosts.id));
  const visible = await readRoomInsightEvidence(tx, rows.map((row) => row.post.id), now);
  const items: ThemeEvidenceItem[] = [];
  for (const { post, snapshot } of rows) {
    const room = visible.get(post.id);
    if (!room || room.snapshotId !== snapshot.id || room.audienceRevision !== campaign.audienceRevision) continue;
    for (const insight of room.insights) {
      const id = evidenceHash({ post: post.id, snapshot: snapshot.id, revision: snapshot.audienceRevision,
        kind: insight.kind, text: insight.text, sources: insight.sources.map(({ personKey, commentUrn }) => ({ personKey, commentUrn })) });
      items.push({ ...insight, id, discoveredPostId: post.id, snapshotId: snapshot.id, audienceRevision: snapshot.audienceRevision,
        readAt: snapshot.readAt, postUrn: post.postUrn, postText: post.contentText ?? "", authorName: post.authorName });
    }
  }
  const pains = audienceProfile(campaign).pains.filter((pain) => pain.status === "active").map(({ id, text }) => ({ id, text }));
  const previous = await tx.select({ id: audienceThemes.id, kind: audienceThemes.kind, text: audienceThemes.text,
    status: audienceThemes.status, rolledUpAt: audienceThemes.rolledUpAt }).from(audienceThemes)
    .where(eq(audienceThemes.campaignId, campaignId)).orderBy(asc(audienceThemes.id));
  const fingerprint = evidenceHash({ campaignId, revision: campaign.audienceRevision, items: items.map((item) => item.id), pains, previous,
    lastRollupAt: campaign.audienceThemesRolledUpAt });
  return { campaignId, audienceRevision: campaign.audienceRevision, windowStart: now - THEME_WINDOW_MS,
    observedAt: now, lastRollupAt: campaign.audienceThemesRolledUpAt, items, pains, previous, fingerprint };
}

/** All results settle against fresh evidence under the same fence as room
 * replacement and exclusion. A stale/failed result writes nothing. */
export async function recordAudienceThemes(tx: Tx, campaignId: number, expectedFingerprint: string, input: unknown, now = Date.now()) {
  await lockRoomEvidence(tx);
  const parsed = themeResultSchema.parse(input);
  const resultHash = evidenceHash(parsed);
  const [campaign] = await tx.select().from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt))).for("update");
  if (!campaign) throw new StaleAudienceThemes();
  if (campaign.audienceThemesInputHash === expectedFingerprint) {
    if (campaign.audienceThemesResultHash !== resultHash || campaign.audienceThemesRolledUpAt === null) throw new StaleAudienceThemes();
    return tx.select().from(audienceThemes).where(and(eq(audienceThemes.campaignId, campaignId),
      eq(audienceThemes.rolledUpAt, campaign.audienceThemesRolledUpAt)));
  }
  const current = await readAudienceThemeEvidence(tx, campaignId, now);
  if (!current || current.fingerprint !== expectedFingerprint) throw new StaleAudienceThemes();
  const bound = bindAudienceThemes(current, parsed);
  const existing = await tx.select().from(audienceThemes).where(eq(audienceThemes.campaignId, campaignId)).for("update");
  const prior = new Map(existing.map((theme) => [theme.id, theme]));
  await tx.update(audienceThemes).set({ status: "past" }).where(and(eq(audienceThemes.campaignId, campaignId), eq(audienceThemes.status, "current")));
  const saved: Array<typeof audienceThemes.$inferSelect> = [];
  for (const theme of bound) {
    const before = theme.id ? prior.get(theme.id) : undefined;
    const values = { campaignId, audienceRevision: current.audienceRevision, kind: theme.kind, text: theme.text,
      phrases: theme.phrases, painId: theme.painId, rooms: theme.rooms, comments: theme.comments,
      sourceRefs: theme.sourceRefs, status: "current" as const, rolledUpAt: now, lastSeenAt: theme.lastSeenAt };
    const [row] = before
      ? await tx.update(audienceThemes).set(values).where(and(eq(audienceThemes.id, before.id), eq(audienceThemes.campaignId, campaignId))).returning()
      : await tx.insert(audienceThemes).values({ ...values, firstSeenAt: theme.lastSeenAt }).returning();
    if (row) saved.push(row);
  }
  await tx.update(campaigns).set({ audienceThemesRolledUpAt: now,
    audienceThemesInputHash: expectedFingerprint, audienceThemesResultHash: resultHash }).where(eq(campaigns.id, campaignId));
  await proposeLearnedPains(tx, campaignId, now);
  return saved;
}

export type CurrentAudienceTheme = Omit<typeof audienceThemes.$inferSelect, "sourceRefs"> & {
  sourceRefs: AudienceThemeSourceJson[];
  sources: Array<{ discoveredPostId: number; postUrn: string; postText: string; authorName: string | null;
    comments: ThemeEvidenceItem["sources"] }>;
};

/** Counts describe the comments a reader can open now, not yesterday's
 * stored rollup totals. Old revisions, replaced rooms and erased people
 * cannot reappear through a theme. */
export async function currentThemes(tx: Tx, campaignId: number, now = Date.now()): Promise<CurrentAudienceTheme[]> {
  const evidence = await readAudienceThemeEvidence(tx, campaignId, now);
  if (!evidence) return [];
  const themes = await tx.select().from(audienceThemes).where(and(eq(audienceThemes.campaignId, campaignId),
    eq(audienceThemes.status, "current"), eq(audienceThemes.audienceRevision, evidence.audienceRevision)));
  const aliases = await resolvePersonKeys(tx, themes.flatMap((theme) => theme.sourceRefs.flatMap((source) => source.comments.map((comment) => comment.personKey))));
  const rooms = new Map<number, { item: ThemeEvidenceItem; comments: Map<string, ThemeEvidenceItem["sources"][number]> }>();
  for (const item of evidence.items) {
    let room = rooms.get(item.discoveredPostId);
    if (!room) { room = { item, comments: new Map() }; rooms.set(item.discoveredPostId, room); }
    for (const comment of item.sources) room.comments.set(comment.commentUrn, comment);
  }
  const out: CurrentAudienceTheme[] = [];
  for (const theme of themes) {
    const seen = new Set<string>();
    const sources: CurrentAudienceTheme["sources"] = [];
    const sourceRefs: AudienceThemeSourceJson[] = [];
    for (const source of theme.sourceRefs) {
      const room = rooms.get(source.discoveredPostId);
      if (!room || source.snapshotId !== room.item.snapshotId || source.audienceRevision !== evidence.audienceRevision) continue;
      const comments = source.comments.flatMap((ref) => {
        const comment = room.comments.get(ref.commentUrn);
        if (!comment || comment.personKey !== (aliases.get(ref.personKey) ?? ref.personKey) || seen.has(ref.commentUrn)) return [];
        seen.add(ref.commentUrn);
        return [comment];
      });
      if (!comments.length) continue;
      sources.push({ discoveredPostId: source.discoveredPostId, postUrn: room.item.postUrn,
        postText: room.item.postText, authorName: room.item.authorName, comments });
      sourceRefs.push({ ...source, comments: comments.map(({ personKey, commentUrn }) => ({ personKey, commentUrn })) });
    }
    if (sources.length < 2) continue;
    const phrases = theme.phrases.filter((phrase) => sources.some((source) => source.comments.some((comment) => comment.text.includes(phrase))));
    out.push({ ...theme, sourceRefs, sources, phrases, rooms: sources.length, comments: seen.size });
  }
  return out.sort((a, b) => b.rooms - a.rooms || b.comments - a.comments || a.id.localeCompare(b.id)).slice(0, 8);
}

async function lockThemeAudience(tx: Tx, campaignId: number) {
  await lockRoomEvidence(tx);
  const [campaign] = await tx.select().from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt))).for("update");
  if (!campaign) throw new AudienceNotFound();
  return campaign;
}

function themePain(theme: CurrentAudienceTheme) {
  return { id: `theme-${theme.id}`, text: theme.text, phrases: theme.phrases, source: "learned" as const,
    status: "proposed" as const, themeId: theme.id, seenInRooms: theme.rooms };
}

/** Rollups can propose, never activate. A kept or dismissed theme keeps its
 * lineage, so a later phrasing cannot make it a fresh unsolicited proposal. */
export async function proposeLearnedPains(tx: Tx, campaignId: number, now = Date.now()) {
  const campaign = await lockThemeAudience(tx, campaignId);
  if (!campaign.audienceProfile) return [];
  const known = new Set(campaign.audienceProfile.pains.flatMap((pain) => pain.themeId ? [pain.themeId] : []));
  const themes = (await currentThemes(tx, campaignId, now)).filter((theme) =>
    theme.kind === "pain" && theme.rooms >= 3 && theme.painId === null && !known.has(theme.id));
  return setProposedPains(tx, campaignId, themes.map(themePain), now);
}

/** The owner's explicit Add to Audience stages even a two-room pain. The
 * Settings Save remains the sole activation. */
export async function proposeThemePain(tx: Tx, campaignId: number, themeId: string, now = Date.now()) {
  const campaign = await lockThemeAudience(tx, campaignId);
  const known = audienceProfile(campaign).pains.find((pain) => pain.themeId === themeId);
  if (known) return known;
  const theme = (await currentThemes(tx, campaignId, now)).find((item) => item.id === themeId);
  if (!theme || theme.kind !== "pain" || theme.painId !== null) throw new InvalidAudience("That pain no longer has current room evidence to add.");
  const [pain] = await setProposedPains(tx, campaignId, [themePain(theme)], now);
  if (!pain) throw new InvalidAudience("There are already 12 current pains. Retire one in Settings before adding another.");
  return pain;
}
