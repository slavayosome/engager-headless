import { and, eq, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { leads, leadSignals, personReads } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { authorIdentity } from "../people/key";
import { resolvePersonKeys } from "../people/directory";
import { parsePersonKey } from "../people/key";
import { writeRead } from "../people/reads";

/**
 * WHICH LEADS ARE NEW. Leads works like the Inbox: a lead is new from the
 * moment Scout made one of them until the owner opens them, and again
 * whenever Scout reads new words of theirs after that. It is the same read
 * state (`person_reads`, `people/reads.ts`), kept under the lead's own key,
 * so a person who becomes the Inbox's is read or unread there by the same
 * row. Only a lead — a Signal, someone written to, someone set aside — is ever
 * new. Nothing here sends, reads LinkedIn or calls a model.
 */

/**
 * When Engager last saw something of a lead's that the owner is shown: the
 * moment they became one, or the newest words of theirs Scout read that the
 * screen passed, whichever is later. Compared, as the Inbox compares an
 * answer, on when Engager saw it and never on when they said it.
 */
export const leadSeenAt = sql<number>`greatest(coalesce(${leads.researchedAt}, 0),
  coalesce((select max(${leadSignals.seenAt}) from ${leadSignals}
    where ${leadSignals.organizationId} = ${leads.organizationId} and ${leadSignals.leadId} = ${leads.id}
      and ${leadSignals.verdict} = 'passed'), 0))`;

/** A lead the owner has not opened since `leadSeenAt`. */
export const newLead = sql`(${leads.stage} = 'lead' and not exists (
  select 1 from ${personReads} opened
  where opened.organization_id = ${leads.organizationId} and opened.person_key = 'p.' || ${leads.profileId}
    and opened.read_at >= ${leadSeenAt}))`;

/** `leadSeenAt` for one lead: what opening them marks them read as of. The
 *  expression is wrapped because a lone table's own columns lose their
 *  qualifier in the select list, which its subquery needs. */
export async function seenAtOf(tx: Tx, leadId: number): Promise<number> {
  const [row] = await tx.select({ at: sql<number>`${leadSeenAt}`.mapWith(Number) }).from(leads).where(eq(leads.id, leadId));
  return row?.at ?? 0;
}

/** The key a lead's read state is kept under: their profile id as their row
 *  spells it. A key that is no lead's is refused. */
async function leadKey(tx: Tx, key: string): Promise<string> {
  const canonical = (await resolvePersonKeys(tx, [key])).get(key);
  const person = canonical === undefined ? null : parsePersonKey(canonical);
  if (person?.kind !== "profile") throw new AppError("invalid_person_key", "That is not a person's key.", 400);
  const [lead] = await tx
    .select({ profileId: leads.profileId })
    .from(leads)
    .where(and(eq(leads.origin, "find_leads"), eq(leads.profileId, authorIdentity(person.profileId))));
  if (!lead) throw new AppError("lead_not_found", "That person is not one of your leads.", 404);
  return `p.${lead.profileId}`;
}

/** Opening a lead: they are read until Scout reads new words of theirs.
 *  `seenAt` is `leadSeenAt` as the page showed it, so words read since stay
 *  new. */
export async function markLeadRead(tx: Tx, key: string, now: number, seenAt = now): Promise<void> {
  await writeRead(tx, await leadKey(tx, key), { readAt: Math.min(seenAt, now) }, now);
}

export async function markLeadNew(tx: Tx, key: string, now = Date.now()): Promise<void> {
  await writeRead(tx, await leadKey(tx, key), { readAt: null }, now);
}
