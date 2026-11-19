import { eq } from "drizzle-orm";
import {
  campaigns,
  discoveredPosts,
  exemplars,
  incomingComments,
  type Message,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { getVoiceForCampaign } from "../voice";

/** The text the message responded to (post for a comment, comment for a reply). */
export async function resolveContext(
  tx: Tx,
  message: Message,
): Promise<string | null> {
  if (message.kind === "comment" && message.discoveredPostId) {
    const [row] = await tx
      .select({ t: discoveredPosts.contentText })
      .from(discoveredPosts)
      .where(eq(discoveredPosts.id, message.discoveredPostId));
    return row?.t ?? null;
  }
  if (message.kind === "reply" && message.incomingCommentId) {
    const [row] = await tx
      .select({ t: incomingComments.text })
      .from(incomingComments)
      .where(eq(incomingComments.id, message.incomingCommentId));
    return row?.t ?? null;
  }
  return null;
}

/**
 * Turn a human verdict into a retrievable exemplar. Exemplars are stored
 * WITHOUT a vector (the embedder is gone — INV-14): retrieval keys off the
 * recency fallback, exactly as every keyless install already behaved.
 */
export async function promoteToExemplar(opts: {
  db: Tx;
  message: Message;
  label: "good" | "bad";
  context?: string | null;
}): Promise<void> {
  const tx = opts.db;
  const context = opts.context ?? (await resolveContext(tx, opts.message));
  if (!context) return;
  const response = opts.message.finalText ?? opts.message.proposedText;
  if (!response) return;

  // Stamp the voice the response was written in (the campaign's resolved voice
  // at promotion time) so retrieval can stop leaking exemplars across
  // register-incompatible voices. Best-effort: no campaign / no voices → null
  // (legacy semantics: retrievable everywhere).
  let voiceId: number | null = null;
  if (opts.message.campaignId != null) {
    try {
      const [c] = await tx
        .select({ voiceId: campaigns.voiceId })
        .from(campaigns)
        .where(eq(campaigns.id, opts.message.campaignId));
      if (c) {
        const hit = await getVoiceForCampaign(tx, c);
        voiceId = hit?.voice.id ?? null;
      }
    } catch {
      voiceId = null;
    }
  }

  await tx.insert(exemplars).values({
    campaignId: opts.message.campaignId,
    voiceId,
    kind: opts.message.kind === "room_reply" ? "reply" : opts.message.kind,
    contextText: context,
    responseText: response,
    label: opts.label,
    source: "feedback",
  });
}
