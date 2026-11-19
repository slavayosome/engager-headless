import { and, desc, eq, sql } from "drizzle-orm";
import { incomingComments } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { assembleReplyContext } from "../replyContext";

/** The stored incoming work and its reply context. No provider read. */
export async function listIncomingComments(tx: Tx, input: { campaignId?: number; limit: number; offset: number }) {
  const where = and(eq(incomingComments.status, "new"), input.campaignId === undefined ? undefined : eq(incomingComments.campaignId, input.campaignId));
  const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(incomingComments).where(where);
  const rows = await tx.select().from(incomingComments).where(where).orderBy(desc(incomingComments.receivedAt), desc(incomingComments.id)).limit(input.limit).offset(input.offset);
  return { total: count?.total ?? 0, rows: await Promise.all(rows.map(async (row) => ({ ...row, thread: await assembleReplyContext(tx, row) }))) };
}
