import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { leadRatings, leads, leadSignals, type Lead, type SetAsideReason } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * SET ASIDE: the owner moving a lead out of the way without judging them, so
 * the Leads page holds only who they mean to write to. It decides only where
 * the person's row shows: it teaches Scout nothing, reads nothing from
 * LinkedIn, sends nothing, and cancels, holds or approves nothing — an opener
 * already queued stays queued, and someone set aside who answers still
 * becomes a Relationship.
 *
 * A person the owner set aside comes back on their own once Scout stores new
 * words of theirs, read after the moment they were set aside: the read derives
 * it ({@link asideNow}), and no job runs. A person set aside by their rating
 * (Not a fit, A peer, `leads/rating.ts`) never comes back on their own. Bring
 * back now undoes either, and leaves the rating as given.
 */

/** Whether a lead is set aside now: set aside, and not an owner's set-aside
 *  their newer words, passed by the screen, have undone. A condition only:
 *  as a selected field its columns would lose their table. */
export const asideNow: SQL<boolean> = sql<boolean>`(${leads.setAsideAt} is not null and not (
  ${leads.setAsideReason} = 'owner' and exists (
    select 1 from ${leadSignals}
    where ${leadSignals.organizationId} = ${leads.organizationId} and ${leadSignals.leadId} = ${leads.id}
      and ${leadSignals.verdict} = 'passed' and ${leadSignals.seenAt} > ${leads.setAsideAt})))`;

/** Where a lead stands aside, as a read shows it; null while they do not. */
export type Aside = { at: number; reason: SetAsideReason };

/** A row's set-aside as stored, which {@link asideNow} may have undone. */
export function storedAside(row: Pick<Lead, "setAsideAt" | "setAsideReason">): Aside | null {
  return row.setAsideAt === null || row.setAsideReason === null ? null : { at: row.setAsideAt, reason: row.setAsideReason };
}

/** Whether one lead is set aside now. */
export async function standsAside(tx: Tx, leadId: number): Promise<boolean> {
  return (await asideAmong(tx, [leadId])).has(leadId);
}

/** Which of these leads are set aside now, by id. Asked of the database rather
 *  than of the rows: their newer words may have undone a set-aside the row
 *  still holds. */
export async function asideAmong(tx: Tx, leadIds: readonly number[]): Promise<Set<number>> {
  if (leadIds.length === 0) return new Set();
  const rows = await tx.select({ id: leads.id }).from(leads).where(and(inArray(leads.id, [...leadIds]), asideNow));
  return new Set(rows.map((row) => row.id));
}

/**
 * Set one lead aside, in the caller's transaction. A lead already aside keeps
 * the moment and the reason they were set aside with, unless only their words
 * since brought them back. Null when there is no such lead in this
 * organization.
 */
export async function setAsideLead(
  tx: Tx,
  input: { leadId: number; reason: SetAsideReason; now: number },
): Promise<Aside | null> {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, input.leadId)).for("update");
  if (!lead) return null;
  if (await standsAside(tx, lead.id)) return storedAside(lead);
  await tx
    .update(leads)
    .set({ setAsideAt: input.now, setAsideReason: input.reason, updatedAt: Date.now() })
    .where(eq(leads.id, input.leadId));
  return { at: input.now, reason: input.reason };
}

/**
 * Bring one lead back now: the set-aside clears and their row returns to its
 * section. The rating stays as given; a peer by the owner's word is the buyer
 * Scout took them for again, or there would be no section to return to. False
 * when there is no such lead in this organization.
 */
export async function bringBackLead(tx: Tx, input: { leadId: number }): Promise<boolean> {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, input.leadId)).for("update");
  if (!lead) return false;
  const [rated] =
    lead.setAsideReason === "a_peer" && lead.role === "peer"
      ? await tx
          .select({ scoutRole: leadRatings.scoutRole })
          .from(leadRatings)
          .where(and(eq(leadRatings.leadId, lead.id), eq(leadRatings.verdict, "a_peer")))
      : [];
  await tx
    .update(leads)
    .set({ setAsideAt: null, setAsideReason: null, role: rated?.scoutRole ?? lead.role, updatedAt: Date.now() })
    .where(eq(leads.id, lead.id));
  return true;
}
