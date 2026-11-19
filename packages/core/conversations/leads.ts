import { and, desc, eq, ne } from "drizzle-orm";
import {
  conversations,
  leads,
  type ConversationRow,
  type LeadStatus,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { projectLead } from "./state";

/** The conversation a person's lead follows: the one touched last — on an install
 *  with one account, their only one. Null for anyone no flagged campaign has
 *  heard from, whose lead keeps the lifecycle `leads/intake.ts` gives it. */
export async function personConversation(
  tx: Tx,
  profileId: string,
): Promise<ConversationRow | null> {
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.authorProfileId, profileId))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(1);
  return conversation ?? null;
}

export async function projectedLeadStatus(
  tx: Tx,
  profileId: string,
): Promise<LeadStatus | null> {
  const conversation = await personConversation(tx, profileId);
  return conversation ? projectLead(conversation) : null;
}

/** Bring the person's lead, if they have one, to what their conversation says. */
export async function projectLeadStatus(
  tx: Tx,
  profileId: string,
  now: number,
): Promise<void> {
  const status = await projectedLeadStatus(tx, profileId);
  if (!status) return;
  await tx
    .update(leads)
    .set({ status, statusChangedAt: now, updatedAt: now })
    .where(and(eq(leads.profileId, profileId), ne(leads.status, status)));
}
