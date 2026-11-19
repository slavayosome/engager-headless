import { z } from "zod";
import { eq } from "drizzle-orm";
import { voices } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { runVoiceRelearn } from "../../learning/relearnVoice";
import type { VoiceDescriptionDraftResult } from "../../learning/voiceDescriptionDraft";
import { setVoiceChannel } from "../../operations/voices";
import { getProfile } from "../../profile";
import { grantFor } from "../context";
import { assertHostedJobSpendStillAllowed, assertHostedJobSpendStillAllowedInTx } from "../spendAccess";
import type { SelfScopedCtx } from "../worker";

const PayloadSchema = z.object({ voiceId: z.number().int().positive() });

/**
 * A VOICE JUST CREATED DRAFTS ITS DESCRIPTION (`relearn_voice_description`),
 * on the agent process, which holds the account: the relearn engine
 * (`runVoiceRelearn`) reads the owner's own writing on LinkedIn over the
 * own-content grant — their recent posts and comments — and their Brain when
 * relearns read it, and distils a comment description without persisting
 * anything. What it drafted waits on the voice as a proposal for Keep or
 * Drop (`SurfaceVoice.proposed`), beside whatever words the voice has.
 *
 * It writes nothing else: no value How you write reads, no sample — a post is
 * not a comment the owner wrote in this voice — no habit, and nothing reaches
 * LinkedIn. Same phase discipline as every relearn: short reads, the account
 * and the model with no connection held, one short write.
 */
export async function handleRelearnVoiceDescription(
  ctx: SelfScopedCtx,
  rawPayload: unknown,
): Promise<VoiceDescriptionDraftResult> {
  const { voiceId } = PayloadSchema.parse(rawPayload);
  const orgScope = <T>(work: (tx: Tx) => Promise<T>) => withOrg(ctx.organizationId, work);
  const prepared = await orgScope(async (tx) => {
    const [voice] = await tx.select({ id: voices.id }).from(voices).where(eq(voices.id, voiceId));
    // Deleted since Create: there is nothing to describe.
    if (!voice) return null;
    return {
      ownContent: await grantFor(ctx, tx, "own_content"),
      brain: (await getProfile(tx)).voiceChannels.brain,
    };
  });
  if (!prepared) return { drafted: 0 };

  const check = () => assertHostedJobSpendStillAllowed(ctx);
  await check();
  const drafted = await runVoiceRelearn(
    { ownContent: prepared.ownContent, ...(ctx.llm ? { llm: ctx.llm } : {}) },
    {
      orgScope,
      beforeExternalPhase: check,
      beforeApplyPhase: check,
      voiceId,
      target: "comment",
      // The owner asked for their LinkedIn writing; the Brain is read where
      // every relearn reads it.
      channels: { linkedin: true, brain: prepared.brain },
      persist: false,
    },
  );
  const comment = drafted.comment;
  // Nothing of theirs to draft from: the voice stays as Create left it, and
  // the run says so (`voiceDescriptionDraftState`).
  if (!drafted.ok || !comment) return { drafted: 0 };

  return orgScope(async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const [voice] = await tx.select({ id: voices.id }).from(voices).where(eq(voices.id, voiceId));
    if (!voice) return { drafted: 0 };
    await setVoiceChannel(tx, voiceId, "comment", {
      proposed: {
        persona: comment.persona,
        houseStyle: comment.houseStyle,
        at: Date.now(),
        from: comment.sources,
        learnedFrom: comment.sampleCount,
        newComments: 0,
        drafted: true,
      },
    });
    return { drafted: 1 };
  });
}
