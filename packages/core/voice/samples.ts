import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { campaigns, discoveredPosts, leads, leadSignals, voices, type Voice, type VoiceSampleAnswer } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { SAMPLE_ANSWER_CAP, VoiceSampleAnswerSchema } from "../ai/styleRules";
import { eligibleLeadSql } from "../leads/scout/eligibility";
import { leadOpeners } from "../leads/scout/opener";
import { getVoice, mergeStyleRules } from "../operations/voices";
import { resolveJudgmentPolicy } from "../tasks/policy";
import { isPreviewRefusal, previewCommentDrafts, type PreviewRefusal } from "../workers/draftPreview";

/**
 * DOES THIS SOUND LIKE YOU: comments written in one voice for the owner to
 * judge, and what they said of each.
 *
 * A sample is the dispatcher's own preview (`previewCommentDrafts`, the path
 * `preview_drafts` takes) on a post a campaign writing in the voice found —
 * a discovered post, or the post a lead's opener answers — the newest first,
 * one comment to a post and to a lead, so it is what a run would write there,
 * and nothing of it is kept: no draft, no plan, no sample. A post the
 * dispatcher writes nothing on that the judge admits is passed over for the
 * next.
 *
 * An answer is kept on the voice (`StyleRules.sampleAnswers`), where a
 * relearn of the description anchors on it beside how the owner says they
 * want to sound. The words are Engager's, so an answer is never a voice
 * sample and never evidence of how the owner writes.
 */

export const VOICE_SAMPLE_COUNT = 3;
/** The posts tried for one set of samples. */
const POSTS_TRIED = 6;

/** A sample and the post it was written on: `post:<id>` for a discovered
 *  post, `signal:<id>` for the lead's post its opener answers. */
export type VoiceSample = { key: string; text: string };

/** The ids of one kind `keys` names; a key that names neither is no key. */
const idsOf = (keys: readonly string[], kind: "post" | "signal"): number[] =>
  keys.flatMap((key) => {
    const id = Number(key.slice(kind.length + 1));
    return key.startsWith(`${kind}:`) && Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });

/** Up to three comments in the voice (null: the default), on posts none of
 *  `exclude` names. Fewer where the campaigns writing in it found fewer posts. */
export async function writeVoiceSamples(
  organizationId: string,
  input: { voiceId: number | null; exclude: string[] },
  llm: LLM,
): Promise<{ samples: VoiceSample[] } | PreviewRefusal> {
  const excludedPosts = idsOf(input.exclude, "post");
  const excludedSignals = idsOf(input.exclude, "signal");
  const posts = await withOrg(organizationId, async (tx) => {
    if ((await resolveJudgmentPolicy(tx)) !== "configured_background") return null;
    const voice =
      input.voiceId != null
        ? await getVoice(tx, input.voiceId)
        : ((await tx.select().from(voices).where(eq(voices.isDefault, true)))[0] ?? null);
    if (input.voiceId != null && !voice) return [];
    // The campaigns writing in it, as the bar counts them: attached to it
    // and, for the default, the ones that picked no voice.
    const writes = !voice
      ? isNull(campaigns.voiceId)
      : voice.isDefault
        ? or(eq(campaigns.voiceId, voice.id), isNull(campaigns.voiceId))
        : eq(campaigns.voiceId, voice.id);
    const discovered = await tx
      .select({ id: discoveredPosts.id, foundAt: discoveredPosts.discoveredAt })
      .from(discoveredPosts)
      .innerJoin(campaigns, eq(campaigns.id, discoveredPosts.campaignId))
      .where(
        and(
          writes,
          ne(campaigns.status, "archived"),
          isNotNull(discoveredPosts.contentText),
          excludedPosts.length > 0 ? notInArray(discoveredPosts.id, excludedPosts) : undefined,
        ),
      )
      .orderBy(desc(discoveredPosts.discoveredAt), desc(discoveredPosts.id))
      .limit(POSTS_TRIED);
    // A lead's post is the one its opener answers, as a run selects it: an
    // opener still owed, to someone in reach, on the words their box
    // recommends, where those words are a post. A lead a sample was written
    // to is passed over whole: one comment to a lead. More leads are read
    // than posts are tried, since whose words are a post shows only after.
    const newestWords = sql`(select max(${leadSignals.seenAt}) from ${leadSignals} where ${leadSignals.leadId} = ${leads.id} and ${leadSignals.verdict} = 'passed')`;
    const served = await tx
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
      .where(
        and(
          writes,
          ne(campaigns.status, "archived"),
          inArray(leads.stage, ["signal", "lead"]),
          sql`${leads.rating} is distinct from 'not_a_fit'`,
          eligibleLeadSql(sql`${leads.profileId}`, sql`${leads.campaignId}`),
          excludedSignals.length > 0
            ? notInArray(leads.id, tx.select({ id: leadSignals.leadId }).from(leadSignals).where(and(inArray(leadSignals.id, excludedSignals), isNotNull(leadSignals.leadId))))
            : undefined,
        ),
      )
      .orderBy(sql`${newestWords} desc nulls last`, desc(leads.id))
      .limit(POSTS_TRIED * 4);
    const openers = await leadOpeners(tx, served.map((lead) => lead.id), Date.now());
    const answered = [...openers.values()].flatMap(({ lead, signal }) =>
      signal.kind === "post" ? [{ key: `signal:${signal.id}`, foundAt: signal.seenAt, target: { leadId: lead.id, signalId: signal.id } }] : [],
    );
    return [
      ...discovered.map((post) => ({ key: `post:${post.id}`, foundAt: post.foundAt, target: { discoveredPostId: post.id } })),
      ...answered,
    ]
      .sort((a, b) => b.foundAt - a.foundAt)
      .slice(0, POSTS_TRIED);
  });
  if (!posts) {
    return { refused: { code: "no_background_agent", message: "No background agent is set up to write samples.", status: 409 } };
  }
  const samples: VoiceSample[] = [];
  for (const post of posts) {
    if (samples.length === VOICE_SAMPLE_COUNT) break;
    const preview = await previewCommentDrafts(organizationId, post.target, llm);
    if (isPreviewRefusal(preview)) {
      // A stop holds every post alike; anything else is this post's alone.
      if (preview.refused.code === "account_stopped" || preview.refused.code === "handed_off") return preview;
      continue;
    }
    const admitted = preview.variants[0]?.candidates[0]?.attempts.find((attempt) => attempt.outcome === "admitted");
    if (admitted) samples.push({ key: post.key, text: admitted.text });
  }
  return { samples };
}

/**
 * Keep what the owner said of one sample on the voice, newest first: the same
 * words answered again are one answer, the latest, and past the cap the
 * oldest drops. Nothing else on the voice moves and no model is asked; the
 * revision moves, so a relearn already reading the voice steps aside for the
 * one that reads this answer. Hands back that revision.
 */
export async function answerVoiceSample(
  tx: Tx,
  input: { voiceId: number; text: string; soundsLikeMe: boolean; now?: number },
): Promise<{ revision: number } | "voice_not_found" | "invalid_text"> {
  const parsed = VoiceSampleAnswerSchema.safeParse({
    text: input.text,
    soundsLikeMe: input.soundsLikeMe,
    at: input.now ?? Date.now(),
  });
  if (!parsed.success) return "invalid_text";
  const voice = await getVoice(tx, input.voiceId);
  if (!voice) return "voice_not_found";
  const earlier = (voice.styleRules?.sampleAnswers ?? []).filter((answer) => answer.text !== parsed.data.text);
  return setVoiceSampleAnswers(tx, voice, [parsed.data, ...earlier].slice(0, SAMPLE_ANSWER_CAP));
}

/** Not `updateVoice`: an answer is no writing rule, so the voice keeps its
 *  maturity and no campaign's rules compile again. */
async function setVoiceSampleAnswers(
  tx: Tx,
  voice: Voice,
  sampleAnswers: VoiceSampleAnswer[],
): Promise<{ revision: number }> {
  const [row] = await tx
    .update(voices)
    .set({
      styleRules: mergeStyleRules(voice.styleRules, { sampleAnswers }),
      revision: sql`${voices.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(voices.id, voice.id))
    .returning({ revision: voices.revision });
  if (!row) throw new Error(`voice ${voice.id} not found`);
  return row;
}
