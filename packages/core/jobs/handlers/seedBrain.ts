import { eq } from "drizzle-orm";
import { z } from "zod";
import { products } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { linkedInProvenance } from "../../brain/corpus";
import { seedFromLinkedInPhased } from "../../brain/linkedinSeed";
import { seedCorpusPhased, type SeedScope } from "../../brain/seedScope";
import { isGrant } from "../../connector/resolve";
import { VoiceRelearnStaleSnapshotError } from "../../learning/relearnVoice";
import { grantFor } from "../context";
import type { JobResult, SelfScopedCtx } from "../worker";
import { assertHostedJobSpendStillAllowed } from "../spendAccess";
import { linkedInConnectionState } from "../../linkedin/liveness";

/**
 * Seed the Brain, the account voice, or a product's facts from the source
 * `seed_brain` froze — the work that used to happen INSIDE the tool call.
 *
 * It moved here because of what it costs, not what it does. A seed is a corpus
 * followed by one agent-CLI spawn per chunk, and every one of those is a
 * process start plus an inference round trip (~19s measured on Haiku 4.5).
 * Minutes, in other words — against a chat turn the driver kills at five and an
 * MCP tool ceiling below that, so the owner met a timeout on their first setup
 * step while the seed was still working. As a job it simply runs to completion
 * on the worker the owner already has running, and the tool answers in a second
 * with somewhere to look.
 *
 * ALL FOUR SOURCE KINDS land here, and only one of them is read here. A URL and
 * a file are read by the tool, because a crawl that fails is something a chat
 * turn can still tell the owner about and a job can only dead-letter over; the
 * LinkedIn sweep is the browser, so it travels with the job. An empty payload
 * is the shape every row queued before this phase carries, and it means what it
 * always meant: sweep the account into the Brain.
 *
 * SELF_SCOPED: no transaction is held across the sweep or the extraction. The
 * seed writes each chunk through in its own short org scope, so a job that dies
 * mid-corpus leaves every landed fact behind — the same write-through the tool
 * relied on, now with nothing watching the clock.
 */
const ScopeSchema = z.union([
  z.object({ kind: z.literal("brain") }),
  z.object({ kind: z.literal("voice") }),
  z.object({
    kind: z.literal("product"),
    productId: z.number().int().positive(),
  }),
]);

const PayloadSchema = z.object({
  source: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("linkedin") }),
      z.object({ kind: z.literal("url"), url: z.string() }),
      z.object({ kind: z.literal("file"), path: z.string() }),
      z.object({
        kind: z.literal("text"),
        text: z.string(),
        attribution: z.string(),
      }),
    ])
    .optional(),
  scope: ScopeSchema.optional(),
  provenance: z.string().optional(),
  /** The account selected when queued; never import another account if
   * the owner switches while this job is queued or a model is thinking. */
  expectedAccountId: z.string().min(1).max(500).optional(),
  /** The bytes the tool already read. Absent for the LinkedIn kind, which is
   *  swept here. */
  texts: z.array(z.string()).optional(),
});

/**
 * The voice moved while this seed was thinking.
 *
 * A JOB cannot answer 409 the way the old interactive shim did, and retrying is
 * worse than not: the distillation would be re-run against a voice that has
 * already been superseded, and the next attempt would lose the same race. So
 * the run FINISHES, carrying the refusal as its result — no attempt burned, no
 * backoff, and `get_status` shows the owner a coded outcome instead of a job
 * that quietly did nothing.
 */
const VOICE_STALE_RESULT: JobResult = {
  refusal: {
    layer: "org",
    code: "voice_relearn_stale",
    detail:
      "the voice changed while this seed was distilling it; seed the voice again from the latest one",
  },
};

export async function handleSeedBrain(
  ctx: SelfScopedCtx,
  payload: unknown = {},
): Promise<JobResult | void> {
  const orgId = ctx.organizationId;
  const parsed = PayloadSchema.safeParse(payload ?? {});
  const options = parsed.success ? parsed.data : {};
  const source = options.source ?? { kind: "linkedin" as const };
  const expectedAccountId = options.expectedAccountId ??
    (source.kind === "linkedin" && options.provenance?.startsWith("linkedin:")
      ? options.provenance.slice("linkedin:".length)
      : undefined);
  const scope: SeedScope = options.scope ?? { kind: "brain" };
  const orgScope = <T>(work: Parameters<typeof withOrg<T>>[1]) =>
    withOrg(orgId, work);
  const check = async () => {
    await assertHostedJobSpendStillAllowed(ctx);
    if (expectedAccountId) {
      const connection = await orgScope(linkedInConnectionState);
      if (!connection.connected || connection.externalAccountId !== expectedAccountId) {
        throw new Error("The LinkedIn account changed. Restart the import for the current account.");
      }
    }
  };
  const fences = {
    ...(ctx.llm ? { llm: ctx.llm } : {}),
    beforeExternalPhase: check,
    beforeApplyPhase: check,
  };

  // The product may have been deleted between the queue and the claim. A seed
  // bound to a row that is gone would fail on the fact insert's foreign key —
  // an error the owner cannot act on, about a product they themselves removed.
  // Ending quietly is what every other "the world moved on" arm here does.
  if (scope.kind === "product") {
    const [row] = await orgScope((tx) =>
      tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, scope.productId)),
    );
    if (!row) return;
  }

  await check();

  if (source.kind === "linkedin") {
    const own = await withOrg(orgId, (tx) => grantFor(ctx, tx, "own_content"));
    // No own-content capability (no account connected, or a mock driver) is the
    // same nothing-to-read the tool answered `ok: false` for. Not an error: the
    // Brain step simply has no corpus yet.
    if (!isGrant(own)) return;
    return withVoiceStaleAsResult(async () => {
      const seeded = await seedFromLinkedInPhased(orgScope, {
        driver: own.use,
        scope,
        provenance: options.provenance ?? linkedInProvenance(null),
        ...fences,
      });
      // What the server read, so a voice learnt from posts alone because the
      // comments would not load is on the record rather than passed as the
      // whole picture.
      if (seeded)
        return {
          posts: seeded.postCount,
          postsIncomplete: seeded.postsIncomplete ? 1 : 0,
          comments: seeded.commentCount,
          commentsUnreadable: seeded.commentsUnreadable ? 1 : 0,
          commentsIncomplete: seeded.commentsIncomplete ? 1 : 0,
        };
    });
  }

  // Read by the tool that queued this, at the boundary that could still tell
  // the owner the crawl failed. A payload with no texts is a job whose source
  // yielded nothing, which the tool already refused to the caller's face.
  const texts = options.texts ?? [];
  if (texts.length === 0) return;
  return withVoiceStaleAsResult(async () => {
    await seedCorpusPhased(
      orgScope,
      {
        texts,
        provenance: options.provenance ?? `${source.kind}:unattributed`,
        scope,
        // Never `linkedin`: these notes did not come from the account, and
        // tagging them so would make the next LinkedIn re-seed archive them. No
        // `replaceSource` either — a second blurb is a second source, not a
        // correction of the first.
        source: "interview",
        // The bonus `seed_brain` has always run: a blurb about
        // someone's work usually names their product.
        detectProducts: scope.kind === "brain",
        // A url or a text source is NOT evidence of how the owner writes — see
        // `SeedCorpusInput.voiceBonus`.
        voiceBonus: source.kind === "file",
      },
      fences,
    );
  });
}

/** Turn the one refusal a seed can raise into the job's own receipt. Every
 *  other failure stays a failure: a provider error or a revoked entitlement is
 *  something a retry can still fix, and this one is not. */
async function withVoiceStaleAsResult(
  work: () => Promise<JobResult | void>,
): Promise<JobResult | void> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof VoiceRelearnStaleSnapshotError)
      return VOICE_STALE_RESULT;
    throw error;
  }
}
