import { inArray } from "drizzle-orm";
import { audienceThemes } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { KnowledgeRow } from "../brain/knowledge";
import { currentThemes, type CurrentAudienceTheme } from "./themes";

export type LearnedThemeOrigin = {
  keptAt: number | null;
  /** Present only when the current tenant still owns the exact linked theme
   * and its retained comments support the count. */
  campaignId?: number;
  rooms?: number;
};

const SOURCE_PATH = /^campaign\/([1-9]\d*)\/theme\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function learnedThemePath(value: string | null) {
  const match = value?.match(SOURCE_PATH);
  if (!match) return null;
  const campaignId = Number(match[1]);
  return Number.isSafeInteger(campaignId) ? { campaignId, themeId: match[2]!.toLowerCase() } : null;
}

/** Read-only provenance for owner-kept notes. A hand-edited source path is
 * never authority to link another note, campaign or tenant. Missing/erased
 * themes keep the note's creation date but expose no source population. */
export async function learnedThemeOrigins(tx: Tx,
  notes: ReadonlyArray<Pick<KnowledgeRow, "id" | "source" | "sourcePath" | "createdAt">>, now = Date.now()) {
  const learned = notes.filter((note) => note.source === "learned");
  const out = new Map<number, LearnedThemeOrigin>(learned.map((note) => [note.id,
    { keptAt: Number.isFinite(note.createdAt) && note.createdAt > 0 ? note.createdAt : null }]));
  const paths = learned.flatMap((note) => {
    const path = learnedThemePath(note.sourcePath);
    return path ? [{ note, ...path }] : [];
  });
  if (!paths.length) return out;
  const themes = new Map((await tx.select().from(audienceThemes)
    .where(inArray(audienceThemes.id, [...new Set(paths.map((path) => path.themeId))])))
    .map((theme) => [theme.id, theme]));
  const populations = new Map<number, CurrentAudienceTheme[]>();
  for (const path of paths) {
    const theme = themes.get(path.themeId);
    if (!theme || theme.campaignId !== path.campaignId || theme.keptKnowledgeId !== path.note.id || theme.keptAt === null) continue;
    const origin: LearnedThemeOrigin = { keptAt: theme.keptAt };
    let current = populations.get(path.campaignId);
    if (!current) { current = await currentThemes(tx, path.campaignId, now); populations.set(path.campaignId, current); }
    const retained = current.find((item) => item.id === theme.id);
    if (retained) { origin.campaignId = path.campaignId; origin.rooms = retained.rooms; }
    out.set(path.note.id, origin);
  }
  return out;
}
