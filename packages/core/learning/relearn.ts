import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { messages, voiceSamples } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { OWNER_AUTHORED_MODEL, ownerWroteMessage } from "./authorship";
import type { CapabilitySurface } from "../connector/resolve";
import { OWN_COMMENT_LIMIT } from "../linkedin/driver";
import type { VoiceChannelSamples } from "./toneImport";
import { voiceSampleHash } from "./voiceSamples";

/**
 * Shared comment-voice sample gathering — used by the dashboard re-learn action
 * and the MCP relearn tool so the paths can't
 * drift. Connection discipline: `fromDb` runs inside the caller's SHORT tx;
 * `fromDriver` is network-only (never call it while holding a tx — pool max 1).
 */

/** Comment voice counts as genuinely "learned" at this many real comment samples
 *  (own replies + human edits); below it we fall back to posts. */
export const MIN_COMMENT_SAMPLES = 5;

export type GatheredSamples = {
  samples: VoiceChannelSamples[];
  /** Provenance for SurfaceVoice.sources / the UI chip. */
  sources: string[];
  sampleTexts: number;
};

const postedColumns = {
  id: messages.id,
  finalText: messages.finalText,
  proposedText: messages.proposedText,
  model: messages.model,
  assistRetention: messages.assistRetention,
  ownerOrigin: messages.ownerOrigin,
};

/**
 * DB half of the comment-voice ladder: comments the user actually wrote.
 *
 * Two shapes qualify, and both are the same signal — text that reached
 * LinkedIn in the user's own words:
 *
 *  - an EDIT of a draft, where the owner rewrote most of what was proposed;
 *  - a comment they COMPOSED themselves in the Radar card, where proposedText
 *    already IS their text so there is no divergence to detect. Those were
 *    invisible here until the card let them write one, which is why the
 *    authoring tool stamps a marker rather than leaving it to inference.
 *
 * Either one that mostly kept an agent draft is excluded (`ownerWroteMessage`):
 * a voice relearned from approved drafts learns the model's style back. So is
 * either one the owner disowned (`disownedTexts`).
 */
export async function editedCommentTexts(tx: Tx, cap = 30): Promise<string[]> {
  const rows = await tx
    .select(postedColumns)
    .from(messages)
    .where(
      and(
        eq(messages.kind, "comment"),
        eq(messages.status, "posted"),
        or(
          and(
            isNotNull(messages.finalText),
            ne(messages.finalText, messages.proposedText),
          ),
          eq(messages.model, OWNER_AUTHORED_MODEL),
        ),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(cap * 3);
  const disowned = await disownedTexts(tx);
  return rows
    .filter((row) => ownerWroteMessage(row) && !disowned.messageIds.has(row.id))
    .map((row) => (row.finalText ?? row.proposedText).trim())
    .filter((text) => text.length > 20 && !disowned.hashes.has(voiceSampleHash(text)))
    .slice(0, cap);
}

/**
 * What the owner disowned, by digest and by the message each sample was saved
 * from. A disown excludes a sample from everything, forever (`voiceSamples.ts`):
 * its words reach no corpus, whether read from the sample, from the message
 * it came from, or back from LinkedIn once that message went out.
 */
async function disownedTexts(
  tx: Tx,
): Promise<{ hashes: Set<string>; messageIds: Set<number> }> {
  const rows = await tx
    .select({
      hash: voiceSamples.textHash,
      messageId: voiceSamples.messageId,
      finalText: messages.finalText,
      proposedText: messages.proposedText,
    })
    .from(voiceSamples)
    .leftJoin(messages, eq(messages.id, voiceSamples.messageId))
    .where(isNotNull(voiceSamples.disownedAt));
  const hashes = new Set<string>();
  const messageIds = new Set<number>();
  for (const row of rows) {
    hashes.add(row.hash);
    if (row.messageId != null) messageIds.add(row.messageId);
    const words = row.finalText ?? row.proposedText;
    if (words != null) hashes.add(voiceSampleHash(words));
  }
  return { hashes, messageIds };
}

/**
 * The texts that are not the owner's to learn a voice from, as voice-sample
 * hashes: what Engager posted from an agent's draft — the agent's words
 * whatever account they went out under — and what the owner disowned. The
 * account's own comments read back from LinkedIn include both.
 */
export async function unownedTextHashes(tx: Tx, cap = 500): Promise<string[]> {
  const rows = await tx
    .select(postedColumns)
    .from(messages)
    .where(
      and(
        inArray(messages.kind, ["comment", "reply"]),
        eq(messages.status, "posted"),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(cap);
  const drafted = rows
    .filter((row) => !ownerWroteMessage(row))
    .map((row) => voiceSampleHash(row.finalText ?? row.proposedText));
  return [...drafted, ...(await disownedTexts(tx)).hashes];
}

/** What a relearn says, and does instead, when the account's comments could
 *  not be read from LinkedIn's data: nothing — never a voice learnt from none. */
export const OWN_COMMENTS_UNREADABLE = "Engager couldn't read your comments on LinkedIn.";

/** Network half: the user's own comments as LinkedIn's data lists them
 *  (driver-optional), less any that are not theirs to learn from
 *  (`unownedTextHashes`) — or null where the read failed, which is never
 *  "none". `onIncomplete` is called where the list went on past what was
 *  read. */
export async function readOwnCommentTexts(
  driver: CapabilitySurface<"own_content">,
  cap = OWN_COMMENT_LIMIT,
  unowned: readonly string[] = [],
  onIncomplete?: () => void,
): Promise<string[] | null> {
  if (!driver.fetchOwnComments) return [];
  const excluded = new Set(unowned);
  try {
    const items = await driver.fetchOwnComments(cap, onIncomplete);
    return items
      .map((c) => c.text.trim())
      .filter((t) => t.length > 20 && !excluded.has(voiceSampleHash(t)));
  } catch (e) {
    console.warn("[voice] fetchOwnComments failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** {@link readOwnCommentTexts} for a learner that falls back to other
 *  material when the read fails. */
export async function ownReplyTexts(
  driver: CapabilitySurface<"own_content">,
  cap = OWN_COMMENT_LIMIT,
  unowned: readonly string[] = [],
): Promise<string[]> {
  return (await readOwnCommentTexts(driver, cap, unowned)) ?? [];
}

/** The comments the owner gave as examples of how they write
 *  (`addVoiceExample`), as a corpus channel that leads whatever it is read
 *  with. */
export function ownerExampleSamples(examples: readonly string[]): VoiceChannelSamples[] {
  return examples.length > 0
    ? [{ channel: "examples you gave of how you write", texts: [...examples] }]
    : [];
}

/**
 * Assemble the layered comment-voice corpus. `ownReplies` and `editedTexts` come
 * from the two halves above (gathered by the caller with proper tx discipline);
 * `examples` are the voice's own comment examples (`exampleTexts`), first and
 * counted as real comment signal; `postTexts` is the fallback material. Falls back to
 * posts when the real comment signal is below MIN_COMMENT_SAMPLES — recorded
 * honestly in `sources`.
 */
export function assembleCommentVoiceSamples(opts: {
  examples: readonly string[];
  ownReplies: string[];
  editedTexts: string[];
  postTexts: string[];
}): GatheredSamples {
  const examples = ownerExampleSamples(opts.examples);
  const exampleSources = examples.length > 0 ? ["owner_examples"] : [];
  const real = opts.examples.length + opts.ownReplies.length + opts.editedTexts.length;
  if (real >= MIN_COMMENT_SAMPLES) {
    const samples: VoiceChannelSamples[] = [...examples];
    const sources: string[] = [...exampleSources];
    if (opts.ownReplies.length > 0) {
      samples.push({ channel: "your own comments", texts: opts.ownReplies });
      sources.push("own_comments");
    }
    if (opts.editedTexts.length > 0) {
      samples.push({ channel: "comments you edited", texts: opts.editedTexts });
      sources.push("edited_messages");
    }
    return { samples, sources, sampleTexts: real };
  }
  return {
    samples: [...examples, { channel: "LinkedIn posts", texts: opts.postTexts }],
    sources: [...exampleSources, "posts_fallback"],
    sampleTexts: opts.examples.length + opts.postTexts.length,
  };
}
