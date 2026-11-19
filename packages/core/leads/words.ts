import { inArray, sql } from "drizzle-orm";
import { leads, type IncomingReading } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { readIncoming, type LeadIntentVerdict, type LeadWordsKind } from "../ai/reading";
import { authorIdentity } from "../people/key";
import { leadsEnabled } from "./gate";
import { upsertLeadFromSignal, type LeadSignalResult } from "./intake";

/**
 * A person's words to the owner outside a thread under a campaign comment: a
 * direct message, or the note on an invitation. A reply is read by intake
 * (`detectLeadIntent`); these are read the same way and folded into the same
 * lead, so their temperature reflects all three. Text is LinkedIn's: it reaches
 * the classifier only inside `untrusted()` and nothing here keeps or logs it.
 */

export type DirectWordsKind = Exclude<LeadWordsKind, "comment">;

/**
 * Read a DM or a note, with no transaction open. A model that fails reads
 * nothing: the words are skipped, as intake skips a reply it could not read,
 * and the pipeline they came through goes on.
 */
export async function readWords(
  text: string,
  kind: DirectWordsKind,
  llm?: LLM,
): Promise<IncomingReading | null> {
  try {
    return await readIncoming(text, kind, llm);
  } catch (error) {
    console.error(`[leads] reading failed for a ${kind}:`, error);
    return null;
  }
}

/** Which of these people have a lead, as `authorIdentity` names them. */
export async function peopleWithLeads(tx: Tx, profileIds: readonly string[]): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();
  const rows = await tx
    .select({ profileId: leads.profileId })
    .from(leads)
    .where(inArray(leads.profileId, profileIds.map(authorIdentity)));
  return new Set(rows.map((row) => authorIdentity(row.profileId)));
}

/**
 * Fold one read DM or note into its sender's lead, in the caller's
 * transaction. Intent only ratchets up, the words' time and count are the
 * lead's temperature, and a sender with no lead gets one only past intake's
 * threshold, as a reply's does.
 */
export async function foldLeadWords(
  tx: Tx,
  input: {
    profileId: string;
    /** As the conversation or the invitation shows them: a lead made by these
     *  words is named by it. */
    name: string | null;
    campaignId: number | null;
    kind: DirectWordsKind;
    verdict: LeadIntentVerdict;
    /** When they wrote it. */
    at: number;
  },
): Promise<LeadSignalResult | undefined> {
  if (!(await leadsEnabled(tx))) return undefined;
  return upsertLeadFromSignal(tx, {
    profileId: input.profileId,
    name: input.name,
    intent: input.verdict.intent,
    evidence: input.verdict.evidence || null,
    triggerIncomingCommentId: null,
    campaignId: input.campaignId,
    words: { at: input.at, kind: input.kind },
  });
}
