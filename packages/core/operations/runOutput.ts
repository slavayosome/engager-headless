import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { discoveredPosts, incomingComments, messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

export type WorkerOutputRow = {
  id: number;
  kind: typeof messages.$inferSelect.kind;
  status: typeof messages.$inferSelect.status;
  text: string;
  edited: boolean;
  authorName: string | null;
};

/** Worker-written receipts, never the owner's later edits. */
export async function listRunOutput(tx: Tx, runId: number, limit = 100, afterId?: number): Promise<WorkerOutputRow[]> {
  const rows = await tx.select({ id: messages.id, kind: messages.kind, status: messages.status,
    proposedText: messages.proposedText, finalText: messages.finalText, discoveredPostId: messages.discoveredPostId,
    incomingCommentId: messages.incomingCommentId }).from(messages)
    .where(and(eq(messages.workerRunId, runId), afterId === undefined ? undefined : gt(messages.id, afterId)))
    .orderBy(afterId === undefined ? desc(messages.createdAt) : asc(messages.id)).limit(limit);
  const postIds = [...new Set(rows.flatMap(row => row.discoveredPostId === null ? [] : [row.discoveredPostId]))];
  const replyIds = [...new Set(rows.flatMap(row => row.incomingCommentId === null ? [] : [row.incomingCommentId]))];
  const authors = new Map(postIds.length ? (await tx.select({ id: discoveredPosts.id, name: discoveredPosts.authorName }).from(discoveredPosts).where(inArray(discoveredPosts.id, postIds))).map(row => [row.id, row.name]) : []);
  const repliers = new Map(replyIds.length ? (await tx.select({ id: incomingComments.id, name: incomingComments.authorName }).from(incomingComments).where(inArray(incomingComments.id, replyIds))).map(row => [row.id, row.name]) : []);
  return rows.map(row => ({ id: row.id, kind: row.kind, status: row.status, text: row.proposedText,
    edited: row.finalText !== null && row.finalText !== row.proposedText,
    authorName: row.kind === "room_reply" ? null : row.discoveredPostId !== null ? authors.get(row.discoveredPostId) ?? null : row.incomingCommentId !== null ? repliers.get(row.incomingCommentId) ?? null : null }));
}
