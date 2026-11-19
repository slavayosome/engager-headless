import type {
  ConversationRow,
  ConversationStage,
  LeadStatus,
} from "@engager/database/schema";

type StageFacts = Pick<
  ConversationRow,
  | "closedReason"
  | "outcome"
  | "ctaEventId"
  | "interestEvidenceEventId"
  | "canonicalDmThreadId"
  | "relationship"
>;

/**
 * The one-word summary of a conversation's separate facts (spec §11 R08). It is
 * read OFF them and never written back into them: a later message cannot
 * erase interest, a CTA, an outcome or a closure, because none of those
 * columns is derived from the stage. A conversion outcome is the furthest the
 * person has gone — booked, activated, paid — so it outranks every fact but a
 * closure.
 */
export function deriveStage(conversation: StageFacts): ConversationStage {
  if (conversation.closedReason !== null) return "closed";
  if (conversation.outcome !== null) return conversation.outcome;
  if (conversation.ctaEventId !== null) return "cta_offered";
  if (conversation.interestEvidenceEventId !== null) return "interested";
  if (conversation.canonicalDmThreadId !== null) return "conversing";
  if (conversation.relationship === "connected") return "connected";
  return "engaged";
}

/**
 * `leads.status` as a projection of the person's conversation (spec §15): what the
 * Leads surfaces keep reading, drawn from the conversation's facts rather than
 * written beside them. A closed conversation is a dead lead that no signal
 * reopens; a standing booking, activation or payment is a conversion, which
 * no later message undoes; a DM thread is a conversation; a CTA is contact
 * made.
 */
export function projectLead(
  conversation: Pick<
    ConversationRow,
    "closedReason" | "outcome" | "canonicalDmThreadId" | "ctaEventId"
  >,
): LeadStatus {
  if (conversation.closedReason !== null) return "dead";
  if (conversation.outcome !== null) return "converted";
  if (conversation.canonicalDmThreadId !== null) return "in_conversation";
  if (conversation.ctaEventId !== null) return "contacted";
  return "new";
}
