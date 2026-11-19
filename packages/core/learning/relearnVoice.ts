import { eq, sql } from "drizzle-orm";
import {
  profile,
  voices,
  type Profile,
  type StyleRules,
  type StyleStructuralRange,
  type Voice,
  type VoiceChannels,
  type VoiceSampleAnswer,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { listKnowledge } from "../brain/knowledge";
import { isGrant, type ConnectorResolution } from "../connector/resolve";
import { OWN_POST_LIMIT } from "../linkedin/driver";
import { mergeLearnedStyleRules, setVoiceChannel } from "../operations/voices";
import {
  getProfile,
  setChannelVoice,
  setProfileStructuralRange,
  setVoiceChannels,
} from "../profile";
import { ensureDefaultVoice } from "../voice";
import { exampleTexts } from "../voice/examples";
import {
  assembleCommentVoiceSamples,
  editedCommentTexts,
  OWN_COMMENTS_UNREADABLE,
  readOwnCommentTexts,
  unownedTextHashes,
} from "./relearn";
import { extractStructuralRange } from "./styleVariety";
import { ownerStatedAnchor } from "./calibrateVoice";
import { snapshotVoiceRevision } from "./voiceRevisions";
import {
  learnVoice,
  styleRulesFromObservation,
  type VoiceChannelSamples,
} from "./toneImport";

export type VoiceRelearnResult = {
  ok: boolean;
  reason?: string;
  persisted: boolean;
  voiceId: number | null;
  comment: {
    persona: string;
    houseStyle: string;
    sampleCount: number;
    sources: string[];
  } | null;
  post: { persona: string; houseStyle: string; sampleCount: number } | null;
  structuralRange: StyleStructuralRange | null;
  learnedStyleRules: StyleRules | null;
  /** The account's comments were read only in part: the list went on past
   *  the ones the comment voice learnt from. */
  commentsIncomplete?: boolean;
};

export type VoiceRelearnOrgScope = <T>(
  work: (tx: Tx) => Promise<T>,
) => Promise<T>;

export type VoiceRelearnSnapshot = {
  brainTexts: string[];
  editedTexts: string[];
  /** What is not the owner's to learn from — agent drafts Engager posted
   *  and disowned samples — to keep out of the account's own comments. */
  unowned: string[];
  /** The comments the owner gave the selected voice as examples of how they
   *  write: the corpus's first evidence. */
  examples: string[];
  /** What the owner says of the selected voice — how they want to sound, who
   *  they write to, what they said of sample comments — which the comment
   *  distillation anchors on. */
  stated: { ownWords: string | null; writesTo: string | null; sampleAnswers: VoiceSampleAnswer[] | null };
  targetVoiceId: number;
  isDefaultTarget: boolean;
  revision: {
    profile: Profile;
    voice: Voice;
  };
};

/** A concurrent manual voice edit must win instead of being overwritten by a
 *  model result prepared from the older voice revision. */
export class VoiceRelearnStaleSnapshotError extends Error {
  constructor() {
    super(
      "voice changed while relearn was preparing; retry from the latest voice",
    );
    this.name = "VoiceRelearnStaleSnapshotError";
  }
}

/** Exported for every writer of the default voice, not just this engine: a
 *  `seed_brain {scope:"voice"}` apply holds the SAME fence, because the row it
 *  is about to overwrite can move while the distillation is thinking whichever
 *  verb asked for it. */
export function voiceRevisionFingerprint(
  revision: VoiceRelearnSnapshot["revision"],
): string {
  return JSON.stringify(revision);
}

async function voiceRelearnSnapshot(
  tx: Tx,
  opts: {
    voiceId?: number | null;
    target: "comment" | "post" | "both";
    channels: VoiceChannels;
  },
): Promise<VoiceRelearnSnapshot> {
  // Materialize both singleton/default rows before external work. That makes the
  // final revision fence lockable even for a brand-new organization.
  const profileRow = await getProfile(tx);
  const voiceRow =
    opts.voiceId != null
      ? (await tx.select().from(voices).where(eq(voices.id, opts.voiceId)))[0]
      : await ensureDefaultVoice(tx);
  if (!voiceRow) throw new Error(`voice ${opts.voiceId} not found`);
  return {
    brainTexts: opts.channels.brain
      ? (await listKnowledge(tx)).map((row) => row.content).filter(Boolean)
      : [],
    editedTexts: opts.target !== "post" ? await editedCommentTexts(tx) : [],
    unowned: opts.target !== "post" ? await unownedTextHashes(tx) : [],
    examples: exampleTexts(voiceRow.styleRules, "comment"),
    stated: {
      ownWords: voiceRow.styleRules?.ownWords ?? null,
      writesTo: voiceRow.styleRules?.writesTo ?? null,
      sampleAnswers: voiceRow.styleRules?.sampleAnswers ?? null,
    },
    targetVoiceId: voiceRow.id,
    isDefaultTarget: voiceRow.isDefault,
    revision: { profile: profileRow, voice: voiceRow },
  };
}

export async function currentVoiceRevisionForUpdate(
  tx: Tx,
  targetVoiceId: number,
): Promise<VoiceRelearnSnapshot["revision"] | null> {
  const [profileRow] = await tx.select().from(profile).for("update");
  const [voiceRow] = await tx
    .select()
    .from(voices)
    .where(eq(voices.id, targetVoiceId))
    .for("update");
  return profileRow && voiceRow
    ? { profile: profileRow, voice: voiceRow }
    : null;
}

/**
 * The voice-relearn ENGINE, behind the voice-entity `learn_voice` tool, which
 * targets the org default voice when no `voiceId` is named. Connection
 * discipline: short DB read → CLOSE → driver fetches + distills OUTSIDE any
 * withOrg → short persist tx.
 *
 * Persist targets:
 * - the ORG DEFAULT voice (voiceId null / the default's id): via
 *   `setChannelVoice`, which keeps the profile JSONB + legacy flat columns
 *   coherent (the dual-write shim) and mirrors onto the default voice row.
 * - any OTHER voice: written to that voice row only (channels, structural
 *   range, learned styleRules) — the profile stays untouched.
 * styleRules merge is nulls-only unless `overwriteStyleRules`.
 */
export async function runVoiceRelearn(
  ctx: { ownContent: ConnectorResolution<"own_content">; llm?: LLM },
  opts: {
    orgScope: VoiceRelearnOrgScope;
    /** Re-authorize before every driver/model call. */
    beforeExternalPhase: () => Promise<void>;
    /** Re-authorize after preparation and before the fenced DB apply. */
    beforeApplyPhase: () => Promise<void>;
    voiceId?: number | null;
    target?: "comment" | "post" | "both";
    channels?: VoiceChannels;
    persist?: boolean;
    overwriteStyleRules?: boolean;
  },
): Promise<VoiceRelearnResult> {
  const target = opts.target ?? "both";
  const chans = opts.channels ?? { linkedin: true, brain: false };
  const doPersist = opts.persist ?? true;

  const snapshot = await opts.orgScope((tx) =>
    voiceRelearnSnapshot(tx, {
      voiceId: opts.voiceId,
      target,
      channels: chans,
    }),
  );
  const { brainTexts, editedTexts, targetVoiceId, isDefaultTarget } = snapshot;

  // A REFUSED own-content grant contributes nothing and stops nothing: the
  // Brain and the owner's own edits are DB material, so a relearn on an
  // unreachable account still learns from them — exactly what the unavailable
  // mock produced when it answered both fetches with an empty list. This is a
  // capability question asked as one, which is why it is not the `if (driver)`
  // null-check the same branch used to be.
  const network = isGrant(ctx.ownContent) ? ctx.ownContent.use : null;
  let liTexts: string[] = [];
  if (chans.linkedin && network) {
    await opts.beforeExternalPhase();
    try {
      const posts = await network.fetchOwnPosts(OWN_POST_LIMIT);
      liTexts = posts.map((p) => (p.contentText ?? "").trim()).filter(Boolean);
    } catch {
      /* the account answered nothing → skip this channel */
    }
  }
  let ownReplies: string[] = [];
  let commentsIncomplete = false;
  if (target !== "post" && network) {
    await opts.beforeExternalPhase();
    const read = await readOwnCommentTexts(
      network,
      undefined,
      snapshot.unowned,
      () => {
        commentsIncomplete = true;
      },
    );
    // A read that failed is no read of none: the comment voice is not learnt
    // from whatever else is left, and the relearn says why.
    if (read === null) {
      return {
        ok: false,
        reason: OWN_COMMENTS_UNREADABLE,
        persisted: false,
        voiceId: targetVoiceId,
        comment: null,
        post: null,
        structuralRange: null,
        learnedStyleRules: null,
      };
    }
    ownReplies = read;
  }

  // COMMENT channel: layered ladder (own replies + edits, posts fallback).
  let comment: VoiceRelearnResult["comment"] = null;
  let learnedRules: StyleRules | null = null;
  if (target !== "post") {
    const gathered = assembleCommentVoiceSamples({
      examples: snapshot.examples,
      ownReplies,
      editedTexts,
      postTexts: liTexts,
    });
    const samples: VoiceChannelSamples[] = [...gathered.samples];
    if (brainTexts.length)
      samples.push({ channel: "Brain", texts: brainTexts });
    const stated = ownerStatedAnchor(snapshot.stated);
    if (stated) samples.push(stated);
    await opts.beforeExternalPhase();
    const learned = await learnVoice({
      llm: ctx.llm,
      samples,
      target: "comment",
      // What a deferred distillation must write: THIS voice's comment channel,
      // and nothing at all when the caller only wanted a draft back.
      defer: { voiceId: targetVoiceId, persist: doPersist },
    });
    if (learned) {
      comment = {
        persona: learned.profile.persona_description,
        houseStyle: learned.profile.style_bullets
          .map((b) => `- ${b}`)
          .join("\n"),
        sampleCount: learned.sampleCount,
        sources: gathered.sources,
      };
      // A register observed across Brain notes is no rule of the owner's:
      // those are what they know, not how they write.
      learnedRules =
        brainTexts.length === 0 ? styleRulesFromObservation(learned.profile.observed) : null;
    }
  }

  // POST channel: own posts with post-composition framing.
  let post: VoiceRelearnResult["post"] = null;
  if (target !== "comment" && liTexts.length) {
    await opts.beforeExternalPhase();
    const learned = await learnVoice({
      llm: ctx.llm,
      samples: [{ channel: "LinkedIn posts", texts: liTexts }],
      target: "post",
      defer: { voiceId: targetVoiceId, persist: doPersist },
    });
    if (learned) {
      post = {
        persona: learned.profile.persona_description,
        houseStyle: learned.profile.style_bullets
          .map((b) => `- ${b}`)
          .join("\n"),
        sampleCount: learned.sampleCount,
      };
    }
  }

  if (!comment && !post) {
    return {
      ok: false,
      reason: "no usable content in the selected channels",
      persisted: false,
      voiceId: targetVoiceId,
      comment: null,
      post: null,
      structuralRange: null,
      learnedStyleRules: null,
      ...(commentsIncomplete ? { commentsIncomplete } : {}),
    };
  }

  // Structural range from the user's OWN posts (LinkedIn channel, comment
  // framing) — runs entirely OUTSIDE any withOrg. Best-effort.
  const structural =
    chans.linkedin && target !== "post" && network
      ? await extractStructuralRange({
          driver: network,
          llm: ctx.llm,
          beforeExternalPhase: opts.beforeExternalPhase,
        })
      : null;

  let persistedVoiceId = targetVoiceId;
  if (doPersist) {
    await opts.beforeApplyPhase();
    await opts.orgScope(async (tx) => {
      const currentRevision = await currentVoiceRevisionForUpdate(
        tx,
        targetVoiceId,
      );
      if (
        !currentRevision ||
        voiceRevisionFingerprint(currentRevision) !==
          voiceRevisionFingerprint(snapshot.revision)
      ) {
        throw new VoiceRelearnStaleSnapshotError();
      }
      await setVoiceChannels(tx, chans);
      if (isDefaultTarget) {
        // Default voice: setChannelVoice keeps profile + legacy columns + the
        // default voice row coherent; setProfileStructuralRange mirrors too.
        const def = await ensureDefaultVoice(tx);
        persistedVoiceId = def.id;
        if (comment) {
          await setChannelVoice(tx, "comment", {
            persona: comment.persona,
            houseStyle: comment.houseStyle,
            learnedFrom: comment.sampleCount,
            sources: comment.sources,
          });
        }
        if (post) {
          await setChannelVoice(tx, "post", {
            persona: post.persona,
            houseStyle: post.houseStyle,
            learnedFrom: post.sampleCount,
            sources: ["own_posts"],
          });
        }
        if (structural) await setProfileStructuralRange(tx, structural.range);
        if (learnedRules) {
          await mergeLearnedStyleRules(tx, def.id, learnedRules, {
            overwrite: opts.overwriteStyleRules ?? false,
          });
        }
      } else {
        // Named (non-default) voice: this row only — the profile is the legacy
        // store for the default voice and must not be touched.
        const id = targetVoiceId;
        if (comment) {
          await setVoiceChannel(tx, id, "comment", {
            persona: comment.persona,
            houseStyle: comment.houseStyle,
            learnedFrom: comment.sampleCount,
            sources: comment.sources,
          });
        }
        if (post) {
          await setVoiceChannel(tx, id, "post", {
            persona: post.persona,
            houseStyle: post.houseStyle,
            learnedFrom: post.sampleCount,
            sources: ["own_posts"],
          });
        }
        if (structural) {
          await tx
            .update(voices)
            .set({
              structuralRange: structural.range,
              maturity: sql`case when ${voices.maturity} = 'calibrating' then 'provisional' else ${voices.maturity} end`,
              revision: sql`${voices.revision} + 1`,
              updatedAt: Date.now(),
            })
            .where(eq(voices.id, id));
        }
        if (learnedRules) {
          await mergeLearnedStyleRules(tx, id, learnedRules, {
            overwrite: opts.overwriteStyleRules ?? false,
          });
        }
      }
      await snapshotVoiceRevision(tx, {
        voiceId: persistedVoiceId,
        source: "relearn",
      });
    });
  }

  return {
    ok: true,
    persisted: doPersist,
    voiceId: persistedVoiceId,
    comment,
    post,
    structuralRange: structural?.range ?? null,
    learnedStyleRules: learnedRules,
    ...(commentsIncomplete ? { commentsIncomplete } : {}),
  };
}
