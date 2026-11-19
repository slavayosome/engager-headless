import { createHash } from "node:crypto";
import { z } from "zod";
import type { AudienceThemeSourceJson, RoomInsightJson } from "@engager/database/schema";

export const THEME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export type ThemeEvidenceItem = {
  id: string;
  kind: RoomInsightJson["kind"];
  text: string;
  discoveredPostId: number;
  snapshotId: string;
  audienceRevision: number;
  readAt: number;
  postUrn: string;
  postText: string;
  authorName: string | null;
  sources: Array<{ personKey: string; commentUrn: string; authorName: string | null; text: string }>;
};
export type ThemeLineage = {
  id: string; kind: RoomInsightJson["kind"]; text: string; status: "current" | "past"; rolledUpAt: number;
};
export type ThemeEvidenceBatch = {
  campaignId: number;
  audienceRevision: number;
  windowStart: number;
  observedAt: number;
  lastRollupAt: number | null;
  items: ThemeEvidenceItem[];
  pains: Array<{ id: string; text: string }>;
  previous: ThemeLineage[];
  fingerprint: string;
};

export const themeResultSchema = z.object({ themes: z.array(z.object({
  kind: z.enum(["pain", "objection", "open_question"]),
  text: z.string().trim().min(1).max(120),
  phrases: z.array(z.string().trim().min(1).max(40)).max(3).default([]),
  insightIds: z.array(z.string().min(1).max(100)).min(1).max(1800),
  sameAs: z.string().uuid().optional(),
  painId: z.string().min(1).max(100).optional(),
}).strict()).max(8) }).strict();

export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type BoundTheme = {
  id?: string;
  kind: RoomInsightJson["kind"];
  text: string;
  phrases: string[];
  painId: string | null;
  sourceRefs: AudienceThemeSourceJson[];
  rooms: number;
  comments: number;
  lastSeenAt: number;
};

/** This is evidence validation, not a model call. Counts and phrases are
 * recovered from the frozen comments; no supplied prose establishes a fact. */
export function bindAudienceThemes(batch: ThemeEvidenceBatch, input: unknown): BoundTheme[] {
  const parsed = themeResultSchema.parse(input);
  const evidence = new Map(batch.items.map((item) => [item.id, item]));
  const previous = new Map(batch.previous.map((item) => [item.id, item]));
  const pains = new Set(batch.pains.map((pain) => pain.id));
  const seenIds = new Set<string>();
  const seenWords = new Set<string>();
  return parsed.themes.flatMap((theme) => {
    if (theme.insightIds.some((id) => !evidence.has(id)) || (theme.painId && !pains.has(theme.painId))) return [];
    if (theme.sameAs && previous.get(theme.sameAs)?.kind !== theme.kind) return [];
    const items = [...new Set(theme.insightIds)].map((id) => evidence.get(id)!);
    const sources = new Map<number, AudienceThemeSourceJson>();
    const comments = new Set<string>();
    for (const item of items) {
      let source = sources.get(item.discoveredPostId);
      if (!source) {
        source = { discoveredPostId: item.discoveredPostId, snapshotId: item.snapshotId,
          audienceRevision: item.audienceRevision, comments: [] };
        sources.set(item.discoveredPostId, source);
      }
      for (const comment of item.sources) {
        if (source.comments.some((ref) => ref.commentUrn === comment.commentUrn)) continue;
        source.comments.push({ personKey: comment.personKey, commentUrn: comment.commentUrn });
        comments.add(comment.commentUrn);
      }
    }
    if (sources.size < 2) return [];
    const words = `${theme.kind}:${theme.text.toLocaleLowerCase("en")}`;
    const matchingLineage = batch.previous.filter((item) => `${item.kind}:${item.text.toLocaleLowerCase("en")}` === words);
    const id = theme.sameAs ?? (matchingLineage.length === 1 ? matchingLineage[0]!.id : undefined);
    if (seenWords.has(words) || (id && seenIds.has(id))) return [];
    seenWords.add(words);
    if (id) seenIds.add(id);
    return [{ ...(id ? { id } : {}), kind: theme.kind, text: theme.text,
      phrases: [...new Set(theme.phrases)].filter((phrase) => items.some((item) => item.sources.some((comment) => comment.text.includes(phrase)))),
      painId: theme.painId ?? null, sourceRefs: [...sources.values()], rooms: sources.size,
      comments: comments.size, lastSeenAt: Math.max(...items.map((item) => item.readAt)) }];
  });
}
