import type { LLM } from "../ai/client";
import type { CapabilitySurface } from "../connector/resolve";
import { readOwnCommentTexts } from "../learning/relearn";
import { linkedInProvenance, loadCorpus } from "./corpus";
import type { BrainOrgScope } from "./seed";
import { seedCorpusPhased, type SeedScope } from "./seedScope";

export type LinkedInSeedResult = {
  /** How many of the account's own posts were usable as source material. */
  postCount: number;
  /** Whether the account-wide voice was (re)learned + saved on this run. */
  voiceLearned: boolean;
  /** The post read ran out of pages before its limit, so `postCount` is not
   *  the whole of what the account wrote. */
  postsIncomplete: boolean;
  /** How many of the account's own comments the comment voice could read; 0
   *  where no voice pass ran, the account has none, or the read failed. */
  commentCount: number;
  /** The comments could not be read from LinkedIn, so the voice pass (if it
   *  ran) learnt from the posts alone. Never the same thing as "none". */
  commentsUnreadable: boolean;
  /** The comments were read only in part: the list went on past `commentCount`. */
  commentsIncomplete: boolean;
};

export type LinkedInSeedPhasedOptions = {
  driver: CapabilitySurface<"own_content">;
  llm?: LLM;
  postLimit?: number;
  /** Where the account's posts land. Defaults to the Brain, which is what this
   *  import has always meant; `seed_brain {source:{kind:"linkedin"},
   *  scope:"voice"}` sends the same sweep to the voice instead. */
  scope?: SeedScope;
  /** `linkedin:<account>` — stamped on every note this seed writes. Resolved by
   *  the caller, which knows who the connected account is without a sweep. */
  provenance?: string;
  /** Re-authorize immediately before every driver/LLM call. */
  beforeExternalPhase?: () => Promise<void>;
  /** Re-authorize after provider work and before each DB apply. */
  beforeApplyPhase?: () => Promise<void>;
};

/**
 * Interactive-safe LinkedIn import: the SWEEP, and then the shared seed engine.
 *
 * The driver fetch, the incremental extraction (each chunk written through as
 * it extracts; a re-seed archives the previous LinkedIn notes), assessment,
 * questions, and the bonus voice pass all happen without an org transaction.
 * Each persistence phase re-opens a short scope and re-checks the predicate it
 * is allowed to update.
 *
 * Everything past the sweep is `seedCorpusPhased`, shared with the URL, file
 * and text sources — the account's posts are one corpus among four, and the
 * only thing special about them is how they are READ.
 */
export async function seedFromLinkedInPhased(
  orgScope: BrainOrgScope,
  opts: LinkedInSeedPhasedOptions,
): Promise<LinkedInSeedResult | null> {
  // The SAME loader the url, file and text kinds use — the account's posts are
  // one corpus among four, and the only thing special about them is that
  // reading them means driving a browser. One loader means one set of caps and
  // one provenance format, rather than a LinkedIn-shaped copy that drifts.
  const corpus = await loadCorpus(
    {
      driver: opts.driver,
      ...(opts.postLimit !== undefined ? { postLimit: opts.postLimit } : {}),
      ...(opts.beforeExternalPhase
        ? { beforeFetch: opts.beforeExternalPhase }
        : {}),
    },
    { kind: "linkedin" },
  );
  // A voice seed may learn from the comments alone: an owner who writes
  // comments and no posts still has a voice. The Brain needs the posts.
  const commentsOnly =
    !corpus.ok &&
    corpus.code === "corpus_empty" &&
    opts.scope?.kind === "voice";
  if (!corpus.ok && !commentsOnly) return null;
  const texts = corpus.ok ? corpus.texts : [];

  // The comment voice learns from the comments the owner wrote; the posts above
  // are the Brain's and the voice's fallback. Read only when the voice pass
  // asks, and a failed read costs the seed nothing but those comments.
  let commentCount = 0;
  let commentsUnreadable = false;
  let commentsIncomplete = false;
  const ownComments = async () => {
    const read = await readOwnCommentTexts(opts.driver, undefined, [], () => {
      commentsIncomplete = true;
    });
    commentsUnreadable = read === null;
    commentCount = read?.length ?? 0;
    return read;
  };

  const seeded = await seedCorpusPhased(
    orgScope,
    {
      texts,
      label: "POST",
      // The caller resolved this WITHOUT a sweep (see `connectedAccountId`), so
      // it names the account even where the driver reports no identity of its
      // own; the loader's answer is the fallback.
      provenance:
        opts.provenance ??
        (corpus.ok ? corpus.provenance : linkedInProvenance(null)),
      scope: opts.scope ?? { kind: "brain" },
      source: "linkedin",
      // A re-read of the SAME account supersedes what the last read said, so
      // the previous LinkedIn notes are archived as the new ones land.
      replaceSource: "linkedin",
      // The owner's own posts ARE the owner's writing, which is what makes the
      // bonus voice pass honest here and dishonest for a crawled page.
      voiceBonus: true,
      ...(opts.scope?.kind === "product" ? {} : { ownComments }),
    },
    {
      ...(opts.llm ? { llm: opts.llm } : {}),
      ...(opts.beforeExternalPhase
        ? { beforeExternalPhase: opts.beforeExternalPhase }
        : {}),
      ...(opts.beforeApplyPhase
        ? { beforeApplyPhase: opts.beforeApplyPhase }
        : {}),
    },
  );

  return {
    postCount: texts.length,
    postsIncomplete: corpus.ok && corpus.incomplete === true,
    voiceLearned: seeded.voiceLearned ?? false,
    commentCount,
    commentsUnreadable,
    commentsIncomplete,
  };
}
