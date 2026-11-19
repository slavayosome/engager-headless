import { assistRetention, isAssisted } from "@engager/common/text-provenance";

/**
 * Marks a row as text the OWNER typed rather than any model's output.
 *
 * The corpus reads this: a comment they composed themselves has no edit to
 * detect (proposedText already IS their text), so without a marker it would
 * stay invisible to voice relearn forever.
 */
export const OWNER_AUTHORED_MODEL = "human:radar-card";

/** A message as authorship reads it: what was proposed, what went out, and
 *  the measurements frozen when the owner saved it. */
export type AuthoredText = {
  model: string | null;
  proposedText: string;
  finalText: string | null;
  assistRetention: number | null;
  ownerOrigin: number | null;
};

/**
 * Whether a message's words are the owner's. A comment they composed carries
 * the authorship frozen when they saved it; an agent draft is theirs only when
 * they rewrote most of it, measured against the draft it started from. A
 * draft that went out as proposed, or lightly touched, is the agent's — and
 * whatever learns how the owner writes must never read it as theirs.
 */
export function ownerWroteMessage(message: AuthoredText): boolean {
  if (message.model === OWNER_AUTHORED_MODEL) {
    return !isAssisted(message.assistRetention, message.ownerOrigin);
  }
  const final = message.finalText;
  if (final == null || final.trim() === message.proposedText.trim()) return false;
  const retention =
    message.assistRetention ?? assistRetention(final, [message.proposedText]).retention;
  return !isAssisted(retention, message.ownerOrigin);
}
