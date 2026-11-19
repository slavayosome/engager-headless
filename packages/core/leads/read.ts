import type { Lead, LeadOrigin, LeadStage } from "@engager/database/schema";

/**
 * How a lead row reads stage and origin. A row Find leads writes always
 * carries both; a null means only "written by today's intake", which is a
 * person who answered or liked a campaign's comment: inbound, and already in
 * a relationship. Pure and client-safe, so a page and a tool answer alike.
 */
export function leadOrigin(row: Pick<Lead, "origin">): LeadOrigin {
  return row.origin ?? "inbound";
}

export function leadStage(row: Pick<Lead, "stage">): LeadStage {
  return row.stage ?? "relationship";
}

/** Whether an opener is still written to them: found or served, and not yet
 *  reached. Past that, their words go in the conversation's own boxes. */
export function awaitsOpener(row: Pick<Lead, "stage">): boolean {
  const stage = leadStage(row);
  return stage === "signal" || stage === "lead";
}

/** Whether their box takes words: the opener's, until they are reached, and a
 *  follow-up's while they are reached and have not answered. Once they have
 *  answered, their words go in the conversation's own boxes. */
export function takesWords(row: Pick<Lead, "stage">): boolean {
  const stage = leadStage(row);
  return awaitsOpener(row) || stage === "contacted" || stage === "no_answer";
}
