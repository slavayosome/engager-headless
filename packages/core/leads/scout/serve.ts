import { and, desc, eq, sql } from "drizzle-orm";
import { campaigns, leads, leadSignals, type Lead, type ScoutIntent, type SearchDepth } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { openLeadConversation, recordLeadServed } from "../../conversations/record";
import { lockRoomEvidence } from "../../rooms/eligibility";
import { trackLeadServed } from "../../telemetry/leadFunnel";
import { leadStage } from "../read";
import { leadStandings } from "./eligibility";
import { openerSignal } from "./opener";

/**
 * SERVE: a qualified buyer becomes a Lead, with the conversation the Ambassador's
 * steps act on. Serving sends nothing and drafts nothing: it moves the person
 * to stage Lead, opens their conversation on the campaign's account and records one
 * `lead_served` event there. What a step then does with the event is that
 * step's own mode, caps, pacing and Stop.
 *
 * A lead's post is not keyed here. The event names the signal of theirs the
 * opener answers (`sourceRef.lead`, with the post urn and the comment urn), and
 * a run writes no `discovered_posts` row. The move that first needs one (the
 * owner's press, a step's draft) writes it then, born `drafted` under the
 * lead's campaign, which runs no Find posts stage: Find posts' sweep, triage
 * and Research never meet it, and the send path reads the row it always has.
 */

const FIT_RANK = { strong: 0, fits: 1, weak: 2 } as const;
const INTENT_RANK = { asking: 0, has_problem: 1, topic_only: 2 } as const;

/** The columns the order reads. */
export type LeadOrderKey = Pick<Lead, "id" | "role" | "fit" | "intent" | "intentAt" | "lastSignalAt">;

/**
 * THE ORDER THE STEPS WORK THROUGH THE LEADS IN: the best fit first, then
 * whoever Research judged not a buyer, the people asking first within a fit,
 * then whoever said something most recently, then the id so the order never
 * wavers. A role not yet judged ranks by fit. What the owner reads is not in
 * this order but a newer one (`compareLeadsNewestFirst`).
 */
export function compareLeads(a: LeadOrderKey, b: LeadOrderKey): number {
  const fit = (lead: LeadOrderKey) =>
    lead.role !== null && lead.role !== "buyer" ? 4 : lead.fit === null ? 3 : FIT_RANK[lead.fit];
  const intent = (lead: LeadOrderKey) => (lead.intent === null ? 3 : INTENT_RANK[lead.intent]);
  const newest = (lead: LeadOrderKey) => lead.intentAt ?? lead.lastSignalAt;
  return fit(a) - fit(b) || intent(a) - intent(b) || newest(b) - newest(a) || a.id - b.id;
}

/** The columns the owner's order reads. */
export type LeadAgeKey = Pick<Lead, "id" | "researchedAt" | "intentAt" | "lastSignalAt">;

/**
 * THE ORDER EVERY READ OF THE LEADS USES: whoever Scout made a lead of most
 * recently first, then whoever said something most recently, then the id so the
 * order never wavers. Someone Scout has not researched ranks after everyone it
 * has. `listLeads` and the Leads page sort by the same rule in SQL
 * (`leads/list.ts`), which a test holds to this.
 */
export function compareLeadsNewestFirst(a: LeadAgeKey, b: LeadAgeKey): number {
  const newest = (lead: LeadAgeKey) => lead.intentAt ?? lead.lastSignalAt;
  return (b.researchedAt ?? 0) - (a.researchedAt ?? 0) || newest(b) - newest(a) || a.id - b.id;
}

export type ServedLead = { leadId: number; intent: ScoutIntent; conversationId: number; eventId: number };

/**
 * Serve one lead, in the caller's transaction: stage Lead, their conversation, the
 * `lead_served` event. Null for anyone it does not serve: not a buyer judged
 * with a fit and an intent, not at stage Signal, rated Not a fit or A peer by
 * the owner (which Bring back now leaves as given), with no account to act on, or
 * out of reach now (Never engage, an erased or excluded person, a conversation the
 * owner closed, however the id is spelled); the owner's rules can have moved
 * since the screen, so they are asked again here, under the lock Never engage
 * takes, and again by the conversation's own table when the event is recorded. The
 * Research press serves through this same function.
 */
export async function serveLead(
  tx: Tx,
  input: { campaignId: number; leadId: number; depth: SearchDepth; now: number; runId?: number | null },
): Promise<ServedLead | null> {
  await lockRoomEvidence(tx);
  const [lead] = await tx.select().from(leads).where(eq(leads.id, input.leadId)).for("update");
  if (
    !lead ||
    lead.role !== "buyer" ||
    lead.fit === null ||
    lead.intent === null ||
    leadStage(lead) !== "signal" ||
    lead.rating === "not_a_fit" ||
    lead.rating === "a_peer"
  ) {
    return null;
  }
  const [campaign] = await tx.select({ channelId: campaigns.channelId }).from(campaigns).where(eq(campaigns.id, input.campaignId));
  if (campaign?.channelId == null) return null;
  const [standing] = await leadStandings(tx, input.campaignId, [lead.id]);
  if (!standing?.eligible) return null;

  // The signal the opener answers: the one their intent quote stands in, else
  // their newest.
  const signals = await tx
    .select()
    .from(leadSignals)
    .where(and(eq(leadSignals.leadId, lead.id), eq(leadSignals.verdict, "passed")))
    .orderBy(desc(sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`), desc(leadSignals.id));
  const signal = openerSignal(lead, signals);
  if (!signal) return null;

  const conversation = await openLeadConversation(tx, {
    channelId: campaign.channelId,
    campaignId: input.campaignId,
    profileId: lead.profileId,
    leadId: lead.id,
    now: input.now,
  });
  const first = [...signals].sort((a, b) => a.seenAt - b.seenAt || a.id - b.id)[0];
  const served = await recordLeadServed(tx, { conversationId: conversation.id, leadId: lead.id, signal, runId: input.runId ?? first?.runId, now: input.now });
  if (!served) return null;
  await tx.update(leads).set({ stage: "lead", updatedAt: Date.now() }).where(eq(leads.id, lead.id));
  trackLeadServed({ stage: "lead", lead, depth: input.depth }, tx);
  return { leadId: lead.id, intent: lead.intent, conversationId: conversation.id, eventId: served.event.id };
}
