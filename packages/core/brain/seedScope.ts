import type { LLM } from "../ai/client";
import {
  deferTask,
  externalJudgmentActive,
} from "../tasks/judgment";
import {
  currentVoiceRevisionForUpdate,
  voiceRevisionFingerprint,
  VoiceRelearnStaleSnapshotError,
} from "../learning/relearnVoice";
import {
  assembleCommentVoiceSamples,
  ownerExampleSamples,
  unownedTextHashes,
} from "../learning/relearn";
import { learnVoice } from "../learning/toneImport";
import { voiceSampleHash } from "../learning/voiceSamples";
import { enqueueRecompileForProduct } from "./compile";
import { recomputeFillScore, storeProductFact } from "../products/facts";
import { applyProductCandidatePhased } from "../products/candidatePhased";
import {
  extractProductFactsFromText,
  markExistingProductCandidates,
  prepareProductCandidatesFromText,
} from "../products/ingest";
import { getProfile, setChannelVoice } from "../profile";
import { ensureDefaultVoice } from "../voice";
import { exampleTexts } from "../voice/examples";
import { corpusText, voiceSampleChannel } from "./corpus";
import type { KnowledgeSource } from "./knowledge";
import { seedBackgroundPhased, type BrainOrgScope } from "./seed";

/**
 * WHERE one loaded corpus lands.
 *
 * `seed_brain`'s second parameter, resolved: the Brain's own notes, the
 * account-wide voice, or one product's facts. Source and scope are independent
 * on purpose — the owner's own posts can teach the voice, a product's site can
 * fill the Brain, and neither pairing needs a verb of its own.
 */
export type SeedScope =
  | { kind: "brain" }
  | { kind: "voice" }
  | { kind: "product"; productId: number };

/** `StartTask`'s `sourceText` bound, minus headroom for the envelope. */
const MAX_DEFERRED_CORPUS_CHARS = 60_000;

export type SeedCorpusInput = {
  texts: string[];
  /** `linkedin:<account>` / `url:<host>` / `file:<path>` / `text:<attribution>`. */
  provenance: string;
  scope: SeedScope;
  /** What the pieces of this corpus are called in the extraction prompt. The
   *  LinkedIn sweep says `POST`; everything else is a `DOCUMENT`. */
  label?: string;
  /** How the notes are TAGGED (`knowledge.source`'s four-value enum), as
   *  opposed to where they came from. A LinkedIn seed tags `linkedin`;
   *  everything else is `interview` material the agent brought. */
  source?: KnowledgeSource;
  /**
   * Archive this source's notes at the moment the replacement lands.
   *
   * PER KIND, and the asymmetry is deliberate: a LinkedIn re-seed replaces the
   * previous LinkedIn notes because it re-read the same account and its answer
   * supersedes the old one, while a text, file or URL seed adds to the vault
   * and archives nothing — a second blurb is a second source, not a correction
   * of the first, and only the owner knows which of two facts is now wrong.
   */
  replaceSource?: KnowledgeSource;
  /**
   * `brain` scope only: also look for a product this corpus describes, and
   * enrich it when it ALREADY EXISTS (never create one — `save_product` is
   * the only thing that does that).
   *
   * Off by default and on for the agent-brought sources, which is where it has
   * always been: a blurb or a page about someone's work usually names their
   * product, and 25 LinkedIn posts usually name a dozen things that are not
   * one. A bonus in the strictest sense — it cannot fail the seed.
   */
  detectProducts?: boolean;
  /**
   * `brain` scope only: also learn the account's voice when none is saved yet.
   *
   * OFF BY DEFAULT, and the gate is WHOSE WORDS these are rather than which
   * scope asked. The account voice is how the OWNER sounds, and it goes on to
   * shape every comment Engager writes for them — so a marketing page's copy
   * (`url`) or a paragraph attributed to someone else (`text`) must never
   * become it as a side effect of filling the Brain. Only the sources that are
   * the owner's own writing by construction turn it on: their LinkedIn posts,
   * and files on their own disk.
   *
   * An owner who DOES want a voice learned from supplied writing asks for it
   * with `scope:"voice"`, which is explicit and is not this flag.
   */
  voiceBonus?: boolean;
  /**
   * The owner's own comments, for a corpus that is the connected account's: how
   * they write COMMENTS, which is the channel a seed's voice pass fills. Asked
   * only once a voice pass is going to run, so a Brain seed that leaves the
   * voice alone makes no second visit to LinkedIn. `null` is a read that
   * failed; the voice is then learnt from the corpus alone.
   */
  ownComments?: () => Promise<string[] | null>;
};

export type SeedCorpusOpts = {
  llm?: LLM;
  beforeExternalPhase?: () => Promise<void>;
  beforeApplyPhase?: () => Promise<void>;
};

export type SeedCorpusResult = {
  scope: SeedScope["kind"];
  provenance: string;
  documents: number;
  /** `brain` and `voice` scopes: whether a voice was actually saved. */
  voiceLearned?: boolean;
  /** `product` scope: how many facts landed. */
  factsAdded?: number;
  /** `brain` scope with `detectProducts`: the existing products this corpus
   *  enriched, by name. */
  enriched?: string[];
};

/**
 * Distil the account-wide voice from a corpus into the default voice's COMMENT
 * channel.
 *
 * One channel per call, which is the same narrowing the in-session relearn
 * states and for the same reason: a prepared stage freezes the voice row, so
 * two stages over one row cannot both be submitted. `learn_voice` remains the
 * tool for naming a voice, a channel, or asking for a draft without saving —
 * `seed_brain {scope:"voice"}` is the one-line "learn how I sound from THIS"
 * and deliberately takes no knobs.
 *
 * `onlyWhenEmpty` is the BONUS pass a Brain seed throws in: it writes only when
 * the account has never saved a voice, and re-reads that predicate inside the
 * apply so a voice that arrived while the seed ran wins.
 *
 * THE REVISION FENCE IS THE SAME ONE `runVoiceRelearn` HOLDS, and it is not the
 * emptiness check. A distillation takes minutes; the profile or the voice row
 * can be hand-edited, calibrated, or relearned in that window, and writing the
 * older answer over the newer one loses evidence nobody can get back. So the
 * revision is snapshotted before the model phase and re-read `FOR UPDATE`
 * inside the apply, and a move raises the same `voice_relearn_stale` an agent
 * already knows how to retry.
 */
async function learnVoiceFromCorpus(
  orgScope: BrainOrgScope,
  input: SeedCorpusInput,
  opts: SeedCorpusOpts,
  { onlyWhenEmpty = false }: { onlyWhenEmpty?: boolean } = {},
): Promise<boolean> {
  // Both singleton rows are MATERIALIZED here, exactly as `voiceRelearnSnapshot`
  // does and for the same reason: the fence below compares this revision to one
  // read `FOR UPDATE`, and on a brand-new organization neither row exists yet —
  // so a snapshot that only read them would compare `null` to a row the apply
  // itself created and refuse every first seed.
  const before = await orgScope(async (tx) => {
    const profileRow = await getProfile(tx);
    const voiceRow = await ensureDefaultVoice(tx);
    return {
      voiceId: voiceRow.id,
      revision: { profile: profileRow, voice: voiceRow },
      examples: exampleTexts(voiceRow.styleRules, "comment"),
      unowned: new Set(await unownedTextHashes(tx)),
    };
  });
  await opts.beforeExternalPhase?.();
  const owned = (texts: readonly string[]) =>
    texts.filter((text) => !before.unowned.has(voiceSampleHash(text)));
  const ownReplies = input.ownComments
    ? owned((await input.ownComments()) ?? [])
    : [];
  if (input.ownComments) await opts.beforeExternalPhase?.();
  // The comment voice learns from the comments the owner wrote, the way a
  // relearn does; their posts stand in only where there are too few of those.
  const gathered =
    ownReplies.length > 0
      ? assembleCommentVoiceSamples({
          examples: before.examples,
          ownReplies,
          editedTexts: [],
          postTexts: owned(input.texts),
        })
      : null;
  // Under the external-judgment policy this returns null having deferred a
  // `voice_analysis` stage carrying exactly these texts — the caller's own
  // agent distils them and `finish_task` writes the channel,
  // behind that path's own `voice_calibration_hold` fence.
  const learned = await learnVoice({
    ...(opts.llm ? { llm: opts.llm } : {}),
    // The examples the owner gave lead; an agent's posted draft or a sample
    // they disowned is no writing of theirs, whoever supplied the corpus.
    samples: gathered
      ? gathered.samples
      : [
          ...ownerExampleSamples(before.examples),
          {
            channel: voiceSampleChannel(input.provenance),
            texts: owned(input.texts),
          },
        ],
    target: "comment",
    defer: { voiceId: before.voiceId, persist: true },
  });
  if (!learned) return false;
  await opts.beforeApplyPhase?.();
  return orgScope(async (tx) => {
    const current = await currentVoiceRevisionForUpdate(tx, before.voiceId);
    if (
      !before.revision ||
      !current ||
      voiceRevisionFingerprint(current) !==
        voiceRevisionFingerprint(before.revision)
    ) {
      // A BONUS never fails the seed it rode in on: the Brain notes this pass
      // already wrote stay, and the voice simply was not this pass's to write.
      // An explicit `scope:"voice"` call raises, because that call was ABOUT
      // the voice and reporting success would be a lie.
      if (onlyWhenEmpty) return false;
      throw new VoiceRelearnStaleSnapshotError();
    }
    // Belt to the fence's braces: the emptiness predicate the bonus pass
    // promised, re-read here rather than before the model call.
    if (onlyWhenEmpty && (await getProfile(tx)).voicePersona?.trim())
      return false;
    // The default voice's canonical dual-writer: profile, legacy columns and
    // the default voice row cannot report different personas afterwards.
    await setChannelVoice(tx, "comment", {
      persona: learned.profile.persona_description,
      houseStyle: learned.profile.style_bullets
        .map((bullet) => `- ${bullet}`)
        .join("\n"),
      learnedFrom: learned.sampleCount,
      sources: gathered?.sources ?? ["supplied_writing"],
    });
    return true;
  });
}

/**
 * The product pass a Brain seed throws in for agent-brought corpora.
 *
 * Only products that ALREADY exist are touched: a seed is the owner talking
 * about their work, and minting a product row out of a passing mention is how
 * a vault ends up with three near-duplicates nobody asked for. Wrapped whole,
 * because the facts this seed already stored must survive any failure here.
 */
async function enrichExistingProducts(
  orgScope: BrainOrgScope,
  input: SeedCorpusInput,
  opts: SeedCorpusOpts,
): Promise<string[]> {
  // Nothing to do under the external-judgment policy: the extraction above
  // already handed the same corpus back as a `brain_notes` stage, and a second
  // owed stage for a product the owner has not mentioned wanting would be
  // work asked of them for a bonus.
  if (externalJudgmentActive()) return [];
  const enriched: string[] = [];
  try {
    const detected = await prepareProductCandidatesFromText(
      corpusText(input.texts, input.label),
      {
        ...(opts.llm ? { llm: opts.llm } : {}),
        ...(opts.beforeExternalPhase
          ? { beforeExternalPhase: opts.beforeExternalPhase }
          : {}),
      },
    );
    const candidates = await orgScope((tx) =>
      markExistingProductCandidates(tx, detected),
    );
    for (const candidate of candidates.filter((item) => item.exists)) {
      const applied = await applyProductCandidatePhased(orgScope, candidate, {
        allowCreate: false,
        ...(opts.llm ? { llm: opts.llm } : {}),
        ...(opts.beforeExternalPhase
          ? { beforeExternalPhase: opts.beforeExternalPhase }
          : {}),
        ...(opts.beforeApplyPhase
          ? { beforeApplyPhase: opts.beforeApplyPhase }
          : {}),
      });
      if (applied.id == null) continue;
      enriched.push(candidate.name);
      if (applied.changed)
        await orgScope((tx) =>
          enqueueRecompileForProduct(tx, applied.id as number),
        );
    }
  } catch {
    /* product enrichment is a bonus — never fail the seed because of it */
  }
  return enriched;
}

/** The voice pass a Brain seed throws in when the account has never saved one.
 *  A BONUS, exactly as the LinkedIn seed has always treated it: a provider
 *  failure here leaves the successfully seeded Brain alone. */
async function voiceBonus(
  orgScope: BrainOrgScope,
  input: SeedCorpusInput,
  opts: SeedCorpusOpts,
): Promise<boolean> {
  const voiceWasEmpty = await orgScope(async (tx) => {
    const current = await getProfile(tx);
    return !current.voicePersona?.trim();
  });
  if (!voiceWasEmpty) return false;
  try {
    return await learnVoiceFromCorpus(orgScope, input, opts, {
      onlyWhenEmpty: true,
    });
  } catch (error) {
    // A stale revision is the BONUS PASS'S OWN CONTRACT: `onlyWhenEmpty`
    // declines at the fence and returns false, so one arriving here means that
    // branch stopped working. Swallowing it would hide that forever — and did:
    // with the catch bare, replacing the decline with a throw changed nothing
    // observable and every test still passed. Everything else is what the catch
    // was written for: a provider failure during a bonus must leave the
    // successfully seeded Brain alone.
    if (error instanceof VoiceRelearnStaleSnapshotError) throw error;
    return false;
  }
}

/**
 * Seed ONE loaded corpus into ONE scope.
 *
 * The shared engine behind every `seed_brain` call, in both modes. Nothing here
 * decides WHO thinks: each phase asks the external-judgment policy on its own
 * way past, so the same code runs the corpus into the vault on a worker and
 * hands it back as a prepared stage in the owner's own session.
 */
export async function seedCorpusPhased(
  orgScope: BrainOrgScope,
  input: SeedCorpusInput,
  opts: SeedCorpusOpts = {},
): Promise<SeedCorpusResult> {
  const base = {
    scope: input.scope.kind,
    provenance: input.provenance,
    documents: input.texts.length,
  };

  switch (input.scope.kind) {
    case "voice":
      return {
        ...base,
        voiceLearned: await learnVoiceFromCorpus(orgScope, input, opts),
      };

    case "product": {
      const productId = input.scope.productId;
      const text = corpusText(input.texts, input.label);
      // The extraction is the model phase, so it defers like every other one —
      // and it carries the productId the frozen stage is bound to, plus the
      // provenance the applied facts will be stamped with.
      if (
        deferTask({
          kind: "product_facts",
          productId,
          sourceText: text.slice(0, MAX_DEFERRED_CORPUS_CHARS),
          intent: { sourcePath: input.provenance },
        })
      )
        return { ...base, factsAdded: 0 };
      await opts.beforeExternalPhase?.();
      const prepared = await extractProductFactsFromText(text, {
        ...(opts.llm ? { llm: opts.llm } : {}),
      });
      if (!prepared.ok) return { ...base, factsAdded: 0 };
      await opts.beforeApplyPhase?.();
      // ADDITIVE, and deliberately not `applyPreparedProductUrlIngest`: that
      // one deletes the product's whole `web` fact set before writing, which is
      // right for a recrawl of the same link and wrong for everything here — a
      // paragraph the agent supplied is not a newer reading of the site, and
      // wiping the crawl for it loses facts nothing will fetch again. Same
      // write the prepared `product_facts` stage makes, so the two modes leave
      // the same rows behind.
      const factsAdded = await orgScope(async (tx) => {
        let inserted = 0;
        for (const fact of prepared.facts)
          if (
            await storeProductFact(tx, {
              productId,
              facet: fact.facet,
              content: fact.content,
              source: "manual",
              sourcePath: input.provenance,
            })
          )
            inserted++;
        if (inserted) {
          await recomputeFillScore(tx, productId);
          await enqueueRecompileForProduct(tx, productId);
        }
        return inserted;
      });
      return { ...base, factsAdded };
    }

    case "brain": {
      await seedBackgroundPhased(orgScope, corpusText(input.texts, input.label), {
        ...(opts.llm ? { llm: opts.llm } : {}),
        source: input.source ?? "interview",
        ...(input.replaceSource ? { replaceSource: input.replaceSource } : {}),
        sourcePath: input.provenance,
        ...(opts.beforeExternalPhase
          ? { beforeExternalPhase: opts.beforeExternalPhase }
          : {}),
        ...(opts.beforeApplyPhase
          ? { beforeApplyPhase: opts.beforeApplyPhase }
          : {}),
      });
      const voiceLearned = input.voiceBonus
        ? await voiceBonus(orgScope, input, opts)
        : false;
      const enriched = input.detectProducts
        ? await enrichExistingProducts(orgScope, input, opts)
        : [];
      return {
        ...base,
        voiceLearned,
        ...(input.detectProducts ? { enriched } : {}),
      };
    }
  }
}
