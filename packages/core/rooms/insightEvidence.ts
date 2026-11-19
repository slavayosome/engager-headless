import { z } from "zod";
import type { RoomInsightJson } from "@engager/database/schema";
import type { JudgedRoomPerson } from "./judgment";

const claim = z.object({
  text: z.string().trim().min(1).max(120),
  comments: z.array(z.string().max(80)).max(8),
}).strict();

/** Prompt references are accepted only against the exact judged room.
 * Unknown references are discarded; no name, index or model count is evidence. */
export const roomInsightsSchema = z.object({
  pains: z.array(claim).max(3).default([]),
  objections: z.array(claim).max(3).default([]),
  openQuestions: z.array(claim).max(3).default([]),
}).strict();
export type RoomInsightsInput = z.infer<typeof roomInsightsSchema>;

export function bindRoomInsights(input: unknown, people: readonly JudgedRoomPerson[], snapshot: {
  id: string; audienceRevision: number;
}): RoomInsightJson[] {
  if (input === undefined) return [];
  const parsed = roomInsightsSchema.parse(input);
  const sources = new Map<string, RoomInsightJson["sourceRefs"][number]>();
  const ambiguous = new Set<string>();
  for (const person of people) {
    if (person.fit !== "fits") continue;
    for (const comment of person.comments) {
      if (!comment.commentUrn || !comment.text.trim()) continue;
      if (sources.has(comment.ref)) ambiguous.add(comment.ref);
      sources.set(comment.ref, { personKey: person.personKey, commentUrn: comment.commentUrn });
    }
  }
  for (const ref of ambiguous) sources.delete(ref);
  const kinds = { pains: "pain", objections: "objection", openQuestions: "open_question" } as const;
  return (Object.keys(kinds) as Array<keyof typeof kinds>).flatMap((list) => parsed[list].flatMap((item) => {
    const seen = new Set<string>();
    const sourceRefs = item.comments.flatMap((ref) => {
      const source = sources.get(ref);
      if (!source || seen.has(source.commentUrn)) return [];
      seen.add(source.commentUrn);
      return [source];
    });
    return sourceRefs.length ? [{ kind: kinds[list], text: item.text, sourceRefs,
      snapshotId: snapshot.id, audienceRevision: snapshot.audienceRevision }] : [];
  }));
}
