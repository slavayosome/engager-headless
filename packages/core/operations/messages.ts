import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { enqueueActionDispatch } from "../actions/drain";
import { sendApprovedComment } from "../actions/comment";
import { sendApprovedReply } from "../actions/reply";
import { campaignStops } from "../actions/pause";
import { ledgerChannelId } from "../ratelimit/ledger";
import {
  campaigns,
  discoveredPosts,
  exemplars,
  feedback,
  incomingComments,
  messageDraftRevisions,
  messages,
  messageStatusEvents,
  type DraftTrace,
  type IncomingComment,
  type Message,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  assistRetention as measureAssistRetention,
  isAssisted,
  isUntouchedOffer,
  retentionWindow,
} from "@engager/common/text-provenance";
import type { LLM } from "../ai/client";
import { ownerWroteMessage } from "../learning/authorship";
import { extractEditSignals, learnFromSave } from "../learning/editSignals";
import { captureVoiceSample } from "../learning/voiceSamples";
import {
  appendGuidance,
  distillRuleFromEdit,
  type DistilledEditRule,
} from "../learning/guidance";
import { campaignVoiceId } from "../voice";
import { enqueue } from "../jobs/queue";
import type { CommentRedraftPayload } from "../workers/commentRedraft";
import { nextDraftNumber, setDrafts, swapPick } from "../workers/draftSet";
import { boxKey, composerOffered, measureComposer, shownComposerAngle } from "../composer/drafts";
import { assertJudgedWords, landedJudged } from "../dispatcher/landedJudge";
import { getOwnPostRepliesScoped } from "./orgSettings";
import { modeFor } from "../strategy/mode";
import { appendVoiceRule } from "./voices";
import { assignSlots } from "./schedule";
import {
  surfaceOfActor,
  trackDraftRequested,
  trackMessageDecided,
  trackReplyDismissed,
} from "../telemetry/emit";
import { sha256 } from "../crypto";
import type { MessageDecisionOrigin } from "./messageDecisionOrigin";

export type MessageVerdict = "approve" | "edit" | "reject";

export type MessageDecisionInput = {
  messageId: number;
  verdict: MessageVerdict;
  editedText?: string | null;
  reason?: string | null;
  /** Server-derived from the authorized route. Never accept this as public
   * tool/form input. Omitted internal/test callers are conservatively agents. */
  decisionOrigin?: MessageDecisionOrigin;
  expectedStatus?: Message["status"];
  expectedRequestVersion?: number;
};

export type MessageDecisionSnapshot = {
  message: Message;
  revision: string;
  context: string | null;
  verdict: MessageVerdict;
  effectiveVerdict: MessageVerdict;
  editedText: string | null;
  reason: string | null;
  finalText: string;
  decisionOrigin: MessageDecisionOrigin;
};

export type PreparedMessageDecision = {
  snapshot: MessageDecisionSnapshot;
  exemplar: {
    label: "good" | "bad";
    contextText: string;
    responseText: string;
  } | null;
  distilledRule: DistilledEditRule | null;
};

export type MessageDecisionFailureReason =
  | "not_found"
  | "invalid_state"
  | "stale_revision"
  /** A thread reply whose campaign runs on its strategy with Reply Off. */
  | "reply_off";

export type MessageDecisionResult = {
  ok: boolean;
  kind?: Message["kind"];
  scheduledAt?: number | null;
  reason?: MessageDecisionFailureReason;
  currentStatus?: Message["status"];
};

/**
 * Messages predate a dedicated updated_at/revision column. This explicit
 * decision revision covers every field whose concurrent mutation can change the
 * meaning or safety of an approve/edit/reject. The final apply re-reads the row
 * FOR UPDATE and compares this revision before writing anything.
 */
export function messageDecisionRevision(message: Message): string {
  return JSON.stringify(message);
}

function decisionStateAllowed(status: Message["status"]): boolean {
  // An approved draft may still be edited or explicitly unqueued before the
  // posting marker wins. Mid-flight/terminal states must never be resurrected by
  // a provider result prepared from an older snapshot.
  return status === "proposed" || status === "approved";
}

/** Resolve the exact source text a message responds to. The final CAS takes a
 * SHARE lock so a concurrent context edit/delete cannot commit between the
 * comparison and the decision transaction. */
async function resolveDecisionContext(
  tx: Tx,
  message: Message,
  lock = false,
): Promise<string | null> {
  if (message.kind === "comment" && message.discoveredPostId != null) {
    const query = tx
      .select({ text: discoveredPosts.contentText })
      .from(discoveredPosts)
      .where(eq(discoveredPosts.id, message.discoveredPostId));
    const [row] = lock ? await query.for("share") : await query;
    return row?.text ?? null;
  }
  if (message.kind === "reply" && message.incomingCommentId != null) {
    const query = tx
      .select({ text: incomingComments.text })
      .from(incomingComments)
      .where(eq(incomingComments.id, message.incomingCommentId));
    const [row] = lock ? await query.for("share") : await query;
    return row?.text ?? null;
  }
  return null;
}

/**
 * Whether a yes to this reply is one its campaign's Reply refuses: a thread
 * reply on a campaign that runs on its strategy, with Reply Off. The send
 * holds the same line for every other way back to approved
 * (`enforcePublicReplyOff`).
 */
async function replyOffForDecision(
  tx: Tx,
  message: Message,
  lock = false,
): Promise<boolean> {
  if (
    message.kind !== "reply" ||
    message.campaignId == null ||
    message.incomingCommentId == null
  ) {
    return false;
  }
  const query = tx
    .select({
      source: incomingComments.source,
    })
    .from(incomingComments)
    .innerJoin(campaigns, eq(campaigns.id, message.campaignId))
    .where(eq(incomingComments.id, message.incomingCommentId));
  const [row] = lock ? await query.for("share") : await query;
  if (row?.source === "our_comment_thread") {
    const mode = (await modeFor(tx, { campaignId: message.campaignId, capability: "reply_public", target: "their_reply" })).effective;
    return mode !== "auto" && mode !== "review";
  }
  if (row?.source === "own_post") {
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, message.campaignId));
    return !campaign || (await modeFor(tx, { ownPost: await getOwnPostRepliesScoped(tx), campaignId: campaign.id })).effective === "off";
  }
  return false;
}

/** DB-only phase 1: capture the exact message/context revision provider work uses. */
export async function snapshotMessageDecision(
  tx: Tx,
  input: MessageDecisionInput,
): Promise<
  | { ok: true; snapshot: MessageDecisionSnapshot }
  | {
      ok: false;
      reason:
        | "not_found"
        | "invalid_state"
        | "reply_off"
        | "stale_revision";
      currentStatus?: Message["status"];
    }
> {
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId));
  if (!message) return { ok: false, reason: "not_found" };
  if ((input.expectedStatus !== undefined && message.status !== input.expectedStatus) ||
      (input.expectedRequestVersion !== undefined && message.redraftRequestVersion !== input.expectedRequestVersion)) {
    return { ok: false, reason: "stale_revision", currentStatus: message.status };
  }
  if (message.kind === "room_reply" && input.verdict !== "reject") {
    return { ok: false, reason: "invalid_state", currentStatus: message.status };
  }
  if (!decisionStateAllowed(message.status)) {
    return {
      ok: false,
      reason: "invalid_state",
      currentStatus: message.status,
    };
  }

  const editedText = input.editedText ?? null;
  const reason = input.reason ?? null;
  // The draft's own words with only their spacing changed are still the
  // draft: an approval, never an edit.
  const effectiveVerdict =
    input.verdict === "approve" &&
    editedText &&
    !isUntouchedOffer(editedText, [message.proposedText])
      ? "edit"
      : input.verdict;
  const finalText = editedText ?? message.finalText ?? message.proposedText;
  const decisionOrigin = input.decisionOrigin ?? "agent";
  if (input.verdict !== "reject") {
    if (await replyOffForDecision(tx, message)) {
      return { ok: false, reason: "reply_off", currentStatus: message.status };
    }
  }

  return {
    ok: true,
    snapshot: {
      message,
      revision: messageDecisionRevision(message),
      context: await resolveDecisionContext(tx, message),
      verdict: input.verdict,
      effectiveVerdict,
      editedText,
      reason,
      finalText,
      decisionOrigin,
    },
  };
}

/**
 * Provider-only phase 2. No Tx is accepted by construction. Access callbacks run
 * immediately before each provider boundary and deliberately sit outside the
 * best-effort catches so revocation/cancellation cannot masquerade as a trivial
 * edit. The exemplar embed-on-approve/edit block is gone (INV-14): exemplars are
 * stored WITHOUT vectors, exactly as a keyless install already stored them.
 */
export async function prepareMessageDecision(
  snapshot: MessageDecisionSnapshot,
  opts: {
    llm?: LLM | null;
    beforeExternalPhase?: () => Promise<void>;
  } = {},
): Promise<PreparedMessageDecision> {
  // A "good" exemplar is shown to the writer as the voice to match, so only
  // words the owner wrote may be one: approving an agent draft, or touching
  // it up, is not authorship. A rejection with a reason stays a "bad" one.
  const wantsExemplar =
    snapshot.verdict === "reject"
      ? Boolean(snapshot.reason)
      : ownerWroteMessage({ ...snapshot.message, finalText: snapshot.finalText });
  const responseText = snapshot.finalText;
  const exemplar: PreparedMessageDecision["exemplar"] =
    wantsExemplar && snapshot.context && responseText
      ? {
          label: snapshot.verdict === "reject" ? "bad" : "good",
          contextText: snapshot.context,
          responseText,
        }
      : null;

  let distilledRule: DistilledEditRule | null = null;
  if (
    snapshot.effectiveVerdict === "edit" &&
    snapshot.message.campaignId != null &&
    snapshot.message.proposedText.trim() !== snapshot.finalText.trim() &&
    opts.llm !== null
  ) {
    await opts.beforeExternalPhase?.();
    distilledRule = await distillRuleFromEdit({
      original: snapshot.message.proposedText,
      edited: snapshot.finalText,
      llm: opts.llm,
    });
  }

  return { snapshot, exemplar, distilledRule };
}

/** Strip provider-derived enrichment while retaining the thin local exemplar. */
export function withoutHostedMessageDecisionLearning(
  prepared: PreparedMessageDecision,
): PreparedMessageDecision {
  return {
    ...prepared,
    exemplar: prepared.exemplar
      ? {
          label: prepared.exemplar.label,
          contextText: prepared.exemplar.contextText,
          responseText: prepared.exemplar.responseText,
        }
      : null,
    distilledRule: null,
  };
}

async function applyPreparedExemplar(
  tx: Tx,
  message: Message,
  exemplar: NonNullable<PreparedMessageDecision["exemplar"]>,
): Promise<void> {
  const voiceId = await campaignVoiceId(tx, message.campaignId);
  await tx.insert(exemplars).values({
    campaignId: message.campaignId,
    voiceId,
    kind: message.kind === "room_reply" ? "reply" : message.kind,
    contextText: exemplar.contextText,
    responseText: exemplar.responseText,
    label: exemplar.label,
    source: "feedback",
  });
}

/**
 * DB-only phase 3. The caller supplies a fresh authorized/RLS transaction. The
 * row lock plus revision/context comparison is the stale-result CAS: provider
 * output can never approve, reject, reschedule, or teach from a message that
 * changed while the connection was released.
 */
export async function applyPreparedMessageDecision(
  db: Tx,
  prepared: PreparedMessageDecision,
): Promise<MessageDecisionResult> {
  const snapshot = prepared.snapshot;
  const [message] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, snapshot.message.id))
    .for("update");
  if (!message) return { ok: false, reason: "not_found" };
  if (
    !decisionStateAllowed(message.status) ||
    messageDecisionRevision(message) !== snapshot.revision ||
    (await resolveDecisionContext(db, message, true)) !== snapshot.context
  ) {
    return {
      ok: false,
      reason: "stale_revision",
      currentStatus: message.status,
    };
  }
  if (snapshot.verdict !== "reject") {
    if (await replyOffForDecision(db, message, true)) {
      return { ok: false, reason: "reply_off", currentStatus: message.status };
    }
  }

  if (snapshot.verdict === "reject") {
    const [updated] = await db
      .update(messages)
      .set({ status: "rejected", error: snapshot.reason ?? undefined })
      .where(
        and(
          eq(messages.id, message.id),
          eq(messages.status, snapshot.message.status),
        ),
      )
      .returning({ id: messages.id });
    if (!updated) {
      return {
        ok: false,
        reason: "stale_revision",
        currentStatus: message.status,
      };
    }
    await db.insert(feedback).values({
      messageId: message.id,
      verdict: snapshot.effectiveVerdict,
      editedText: null,
      reasonTags: snapshot.reason ? [snapshot.reason] : null,
      decisionOrigin: snapshot.decisionOrigin,
      finalTextHash: null,
    });
    trackMessageDecided(
      {
        decision: "rejected",
        for: message.kind,
        origin: message.publishOrigin === "owner" ? "owner" : "worker",
        written: "none",
        characters: (message.finalText ?? message.proposedText ?? "").length,
      },
      db,
    );
    return { ok: true, kind: message.kind };
  }

  // Words as the agent left them wait for the model's judge, whatever the
  // verdict says: an "edit" that changed nothing is still the agent's, and
  // words the owner changed match no attempt, so they pass.
  await assertJudgedWords(db, snapshot.finalText);
  // An edit is measured against everything its box offered too, read while
  // the draft still waits on it: every earlier draft of its own, the rest of
  // its set, and the angles the owner's agent delivered there.
  const editedBox =
    snapshot.effectiveVerdict !== "edit"
      ? null
      : message.kind === "comment" && message.discoveredPostId != null
        ? boxKey({ kind: "comment", discoveredPostId: message.discoveredPostId })
        : message.kind === "reply" && message.incomingCommentId != null
          ? boxKey({ kind: "reply", incomingCommentId: message.incomingCommentId })
          : null;
  const boxOffered = editedBox === null ? [] : await composerOffered(db, editedBox);
  const [updated] = await db
    .update(messages)
    .set({
      status: "approved",
      finalText: snapshot.finalText,
      scheduledAt: null,
    })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, snapshot.message.status),
      ),
    )
    .returning({ id: messages.id });
  if (!updated) {
    return {
      ok: false,
      reason: "stale_revision",
      currentStatus: message.status,
    };
  }
  await db.insert(feedback).values({
    messageId: message.id,
    verdict: snapshot.effectiveVerdict,
    editedText:
      snapshot.effectiveVerdict === "edit" ? snapshot.editedText : null,
    reasonTags: snapshot.reason ? [snapshot.reason] : null,
    decisionOrigin: snapshot.decisionOrigin,
    finalTextHash: sha256(snapshot.finalText),
    ...(message.kind === "reply" ? { messageRequestVersion: message.redraftRequestVersion } : {}),
  });

  // `message` is the row as it was SELECTed for update. The rewrite branch
  // below rewrites `publishOrigin` in the database without refreshing it, so
  // the slot must be planned from this variable and never from the stale
  // snapshot — otherwise an owner's own words get slotted under the worker
  // policy while projectSchedule, which re-reads the column, mirrors a plan
  // that was never made.
  let sendOrigin = message.publishOrigin;
  // Usage data: how much of an agent draft survived into what is approved. A
  // bare approval keeps it whole; an edit is measured below, where it is.
  let keptPercent: number | null = snapshot.effectiveVerdict === "edit" ? null : 100;
  const [campaign] =
    message.campaignId == null
      ? []
      : await db.select().from(campaigns).where(eq(campaigns.id, message.campaignId));
  // Under a Pause an owner's rewrite is what lets a draft go out at all, so
  // only the authenticated dashboard may make it. A card's id is claimed, not
  // attested (`decisionOriginFor`): an agent that forged one would otherwise
  // hand its own text through the Pause as the owner's.
  const ownerAttested =
    snapshot.decisionOrigin === "dashboard" || campaign?.status !== "paused";

  // A rewrite the owner made in a direct UI is their words at the moment of
  // the act — keep it as a voice sample now, not if-and-when it posts: a
  // comment as one, a reply as a reply sample, which teaches how they reply.
  // The measured retention against the proposed draft decides whether it
  // teaches the voice, through the same shared policy as every other sample;
  // agent-relayed edits are deliberately excluded (nothing proves the agent's
  // editedText is the owner's wording).
  if (
    snapshot.effectiveVerdict === "edit" &&
    (message.kind === "comment" || message.kind === "reply") &&
    (snapshot.decisionOrigin === "mcp_app" ||
      snapshot.decisionOrigin === "dashboard")
  ) {
    const retention = Math.max(
      measureAssistRetention(snapshot.finalText, retentionWindow([message.proposedText])).retention,
      measureComposer(snapshot.finalText, boxOffered)?.assistRetention ?? 0,
    );
    keptPercent = retention * 100;
    const voiceId = await campaignVoiceId(db, message.campaignId);
    // How the owner edited a draft (spec 7), learned for the voice it was
    // written in — whenever the draft was not already their own words. A
    // rewrite from scratch still shows which of the draft's moves they cut;
    // the sentence-level dimensions skip what no draft sentence became.
    const editSignals =
      message.publishOrigin !== "owner"
        ? extractEditSignals(message.proposedText, snapshot.finalText)
        : null;
    if (message.kind === "comment") {
      // Same act, same consequence: an owner rewrite in a direct UI is
      // authorship, so it also flips the row's pacing provenance to
      // owner-authored. A bare approval of an agent draft is NOT this branch
      // and stays unattended volume, and neither is an "edit" into another of
      // the box's agent texts word for word: that approves the agent's words.
      const agentWords =
        isUntouchedOffer(snapshot.finalText, [...boxOffered, message.proposedText]) &&
        isAssisted(retention, null);
      if (ownerAttested && !agentWords) {
        await db
          .update(messages)
          .set({ publishOrigin: "owner" })
          .where(eq(messages.id, message.id));
        sendOrigin = "owner";
      }
      const sample = await captureVoiceSample(db, {
        text: snapshot.finalText,
        source: "edited_draft",
        assistRetention: retention,
        ownerOrigin: null,
        voiceId,
        messageId: message.id,
        campaignId: message.campaignId,
        discoveredPostId: message.discoveredPostId,
        editSignals,
      });
      if (sample.id != null && editSignals) await learnFromSave(db, voiceId);
    } else {
      // A reply keeps the pacing provenance it was drafted with, and the
      // post it answers under is its thread's. What the rewrite changed is
      // kept with the sample, and the reply channel's own habits roll up
      // from it — never a comment's.
      const [incoming] =
        message.incomingCommentId == null
          ? []
          : await db
              .select({ discoveredPostId: incomingComments.discoveredPostId })
              .from(incomingComments)
              .where(eq(incomingComments.id, message.incomingCommentId));
      const sample = await captureVoiceSample(db, {
        text: snapshot.finalText,
        source: "owner_reply",
        assistRetention: retention,
        ownerOrigin: null,
        voiceId,
        messageId: message.id,
        campaignId: message.campaignId,
        discoveredPostId: incoming?.discoveredPostId ?? null,
        editSignals,
      });
      if (sample.id != null && editSignals) await learnFromSave(db, voiceId);
    }
  }

  let scheduledAt: number | null = null;
  if (message.campaignId != null) {
    // Approved on a Paused campaign: no slot until the Resume plans one
    // (`heldForResume`), so it neither holds an anchor of the account's plan
    // nor meets the send gate while the campaign reads Paused. The owner's own
    // words are not held by it: they take their slot.
    if (campaign && (campaign.status !== "paused" || sendOrigin === "owner")) {
      let targetPostedAt: number | null = null;
      if (message.kind === "comment" && message.discoveredPostId != null) {
        const [post] = await db
          .select({ postedAt: discoveredPosts.postedAt })
          .from(discoveredPosts)
          .where(eq(discoveredPosts.id, message.discoveredPostId));
        targetPostedAt = post?.postedAt ?? null;
      }
      const [slot] = await assignSlots(db, {
        campaign,
        // Who AUTHORED what is about to send — an owner rewrite flipped it
        // above; a bare approval of an agent draft did not.
        origin: sendOrigin,
        items: [
          {
            messageId: message.id,
            kind: message.kind,
            targetPostedAt,
          },
        ],
      });
      scheduledAt = slot?.scheduledAt ?? null;
    }
  }
  // A comment or a reply goes out as an action: this decision's yes is its approval.
  const yes = { by: `owner:${snapshot.decisionOrigin}` };
  if (message.kind === "comment") await sendApprovedComment(db, message.id, { yes });
  else if (message.kind === "reply") await sendApprovedReply(db, message.id, { yes });

  trackMessageDecided(
    {
      decision: "approved",
      for: message.kind,
      origin: sendOrigin === "owner" ? "owner" : "worker",
      written: snapshot.effectiveVerdict === "edit" ? "edited_draft" : "kept_draft",
      retentionPercent: keptPercent,
      characters: snapshot.finalText.length,
    },
    db,
  );
  return { ok: true, kind: message.kind, scheduledAt };
}

function messageLearningStateMatches(
  message: Message,
  snapshot: MessageDecisionSnapshot,
): boolean {
  const sameSource =
    message.kind === snapshot.message.kind &&
    message.campaignId === snapshot.message.campaignId &&
    message.discoveredPostId === snapshot.message.discoveredPostId &&
    message.incomingCommentId === snapshot.message.incomingCommentId &&
    message.proposedText === snapshot.message.proposedText;
  if (!sameSource) return false;
  if (snapshot.verdict === "reject") {
    return (
      message.status === "rejected" &&
      message.finalText === snapshot.message.finalText
    );
  }
  return (
    (message.status === "approved" ||
      message.status === "posting" ||
      message.status === "posted") &&
    message.finalText === snapshot.finalText
  );
}

/**
 * DB-only, best-effort phase 4. It deliberately runs in a transaction separate
 * from the essential status/feedback/scheduling apply: a malformed legacy voice
 * row or any other learning failure can roll this transaction back without
 * undoing the user's decision. The state check prevents late learning from a
 * superseded decision.
 */
export async function applyPreparedMessageDecisionLearning(
  db: Tx,
  prepared: PreparedMessageDecision,
): Promise<boolean> {
  if (!prepared.exemplar && !prepared.distilledRule) return false;
  const [message] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, prepared.snapshot.message.id))
    .for("share");
  if (!message || !messageLearningStateMatches(message, prepared.snapshot)) {
    return false;
  }

  if (prepared.exemplar) {
    await applyPreparedExemplar(db, message, prepared.exemplar);
  }
  if (prepared.distilledRule && message.campaignId != null) {
    if (prepared.distilledRule.kind === "register") {
      const [campaign] = await db
        .select({ voiceId: campaigns.voiceId })
        .from(campaigns)
        .where(eq(campaigns.id, message.campaignId));
      await appendVoiceRule(
        db,
        campaign?.voiceId ?? null,
        prepared.distilledRule.rule,
      );
    } else {
      await appendGuidance(db, message.campaignId, prepared.distilledRule.rule);
    }
  }
  return true;
}

/**
 * Apply a human/agent decision to a drafted message: record feedback, update
 * status, enqueue the gated post job on approve, and close the learning loop
 * (promote exemplar + distil a rule from an edit). Next-free core of the
 * `decideMessage` server action; the action only adds `revalidatePath`.
 *
 * Runs inside the caller's org-scoped `withOrg` transaction (RLS + the GUC
 * default supply organization_id), so no query carries an organizationId.
 *
 * @deprecated Production callers must use snapshotMessageDecision,
 * prepareMessageDecision, applyPreparedMessageDecision, and the isolated
 * learning phase so no provider is invoked while a transaction is owned.
 */
export async function applyMessageDecision(opts: {
  db: Tx;
  messageId: number;
  verdict: MessageVerdict;
  editedText?: string | null;
  reason?: string | null;
}): Promise<MessageDecisionResult> {
  // Deprecated compatibility seam for transaction-owned tests. Production MCP
  // and dashboard callers use the exported phases, and callers that omit explicit
  // test doubles stay strictly DB-only (no environment provider fallback).
  const snapshot = await snapshotMessageDecision(opts.db, {
    messageId: opts.messageId,
    verdict: opts.verdict,
    editedText: opts.editedText,
    reason: opts.reason,
  });
  if (!snapshot.ok) return snapshot;
  const prepared = await prepareMessageDecision(snapshot.snapshot, {
    llm: null,
  });
  const applied = await applyPreparedMessageDecision(opts.db, prepared);
  if (applied.ok) {
    try {
      await applyPreparedMessageDecisionLearning(opts.db, prepared);
    } catch {
      // Compatibility path only. Canonical phased callers isolate this in its
      // own transaction so a DB failure cannot poison the essential apply.
    }
  }
  return applied;
}

/** Opens the transaction a decision phase runs in: the dashboard's org, an
 *  MCP call's org. The phases below never share one, so provider work between
 *  them holds no connection. */
export type MessageDecisionScope = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

/** What a whole decision came to: the row's new place, or why nothing moved. */
export type DecideMessageResult =
  | { ok: true; kind: Message["kind"]; scheduledAt: number | null }
  | { ok: false; reason: MessageDecisionFailureReason; currentStatus?: Message["status"] };

/**
 * The owner's yes, edit or no on one comment or reply, start to end: snapshot,
 * prepare, apply, then the learning a decision leaves. The dashboard's buttons
 * and the MCP `decide` tool both run it, so a decision lands the same row —
 * status, slot, `publishOrigin`, feedback — whichever of them pressed.
 *
 * `decisionOrigin` is the caller's own to state, never a tool argument. The
 * learning step is isolated: the decision is already committed by then.
 */
export async function decideMessage(
  scope: MessageDecisionScope,
  input: MessageDecisionInput,
  opts: { llm?: LLM | null } = {},
): Promise<DecideMessageResult> {
  const snapshot = await scope((tx) => snapshotMessageDecision(tx, input));
  if (!snapshot.ok) return snapshot;
  await landedJudged(snapshot.snapshot.message.organizationId, snapshot.snapshot.finalText);
  const prepared = await prepareMessageDecision(snapshot.snapshot, { llm: opts.llm ?? null });
  const applied = await scope((tx) => applyPreparedMessageDecision(tx, prepared));
  if (!applied.ok) return { ok: false, reason: applied.reason ?? "stale_revision", currentStatus: applied.currentStatus };
  try {
    await scope((tx) => applyPreparedMessageDecisionLearning(tx, prepared));
  } catch {
    // Learning is isolated and best-effort; the decision is already committed.
  }
  return { ok: true, kind: applied.kind!, scheduledAt: applied.scheduledAt ?? null };
}

/** Apply the selected variant, like choice and decision as one transaction. */
export async function decideMessageWithOptions(
  scope: MessageDecisionScope,
  input: MessageDecisionInput & { expectedStatus: Message["status"]; expectedRequestVersion: number; variant?: number; likeWithSend?: boolean },
  opts: { llm?: LLM | null } = {},
): Promise<DecideMessageResult> {
  class Refused extends Error {
    constructor(readonly result: Extract<DecideMessageResult, { ok: false }>) { super(result.reason); }
  }
  let applied: { result: Extract<DecideMessageResult, { ok: true }>; snapshot: MessageDecisionSnapshot };
  try {
    applied = await scope(async (tx) => {
      const [row] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for("update");
      if (!row) throw new Refused({ ok: false, reason: "not_found" });
      if (row.status !== input.expectedStatus || row.redraftRequestVersion !== input.expectedRequestVersion)
        throw new Refused({ ok: false, reason: "stale_revision", currentStatus: row.status });
      if (input.likeWithSend !== undefined) {
        const like = await setMessageLikeWithSend(tx, { messageId: input.messageId, on: input.likeWithSend });
        if (!like.ok) throw new Refused({ ok: false, reason: "invalid_state", currentStatus: row.status });
      }
      if (input.variant !== undefined) {
        const variant = await useDraftVariant(tx, { messageId: input.messageId, expectedStatus: row.status, expectedRequestVersion: row.redraftRequestVersion, variant: input.variant });
        if (!variant.ok) throw new Refused({ ok: false, reason: variant.reason === "stale_state" ? "stale_revision" : "invalid_state", currentStatus: row.status });
      }
      const snapshot = await snapshotMessageDecision(tx, { ...input, expectedRequestVersion: row.redraftRequestVersion + (input.variant === undefined ? 0 : 1) });
      if (!snapshot.ok) throw new Refused(snapshot);
      const prepared = await prepareMessageDecision(snapshot.snapshot, { llm: null });
      const result = await applyPreparedMessageDecision(tx, prepared);
      if (!result.ok) throw new Refused({ ok: false, reason: result.reason ?? "stale_revision", currentStatus: result.currentStatus });
      return { result: { ok: true as const, kind: result.kind!, scheduledAt: result.scheduledAt ?? null }, snapshot: snapshot.snapshot };
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
  try {
    const prepared = await prepareMessageDecision(applied.snapshot, { llm: opts.llm ?? null });
    await scope((tx) => applyPreparedMessageDecisionLearning(tx, prepared));
  } catch { /* The decision has committed; learning is best-effort. */ }
  return applied.result;
}

/**
 * Restore a rejected draft back to `proposed` so it returns to the review queue.
 * A pure status flip — it does not re-run the learning loop; the original reject
 * already recorded its feedback. Guarded to `rejected` rows so it can't resurrect
 * a posted/failed message.
 */
export async function restoreMessageOp(
  tx: Tx,
  messageId: number,
): Promise<{ ok: boolean; error?: string }> {
  const [msg] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!msg) return { ok: false, error: "not_found" };
  if (msg.status !== "rejected") return { ok: false, error: "not_rejected" };
  await tx
    .update(messages)
    .set({ status: "proposed", error: null, scheduledAt: null })
    .where(eq(messages.id, messageId));
  return { ok: true };
}

/**
 * The owner's Unschedule: an approved send leaves the schedule and waits for
 * their yes again, exactly as it waited before — the same words, the same
 * `publishOrigin`, the same "+ Like". It is not a decision on the draft, so
 * it writes no `feedback` and teaches nothing; a yes given later is a fresh
 * decision with a fresh slot.
 *
 * The trigger cancels the queued action with the status and records the
 * move in `message_status_events`, with the reason `owner_unscheduled`. A send already marked `posting` is past
 * taking back: the gate holding it decides what became of it, and a drain that
 * wakes on a row no longer approved sends nothing. `approved` is the whole guard: the posting marker
 * exists only on a `posting` row — the database clears it off any other
 * status (`normalize_message_posting_marker`).
 */
export async function unscheduleMessageOp(
  tx: Tx,
  messageId: number,
): Promise<
  { ok: true } | { ok: false; reason: "not_found" | "going_out" | "not_scheduled" }
> {
  // Transaction-local, and cleared again before anything else here writes a
  // message: the reason names this move and no other.
  await tx.execute(sql`select set_config('app.message_status_reason', 'owner_unscheduled', true)`);
  const [updated] = await tx
    .update(messages)
    .set({ status: "proposed", scheduledAt: null })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.status, "approved"),
      ),
    )
    .returning({
      id: messages.id,
      kind: messages.kind,
      origin: messages.publishOrigin,
      text: messages.finalText,
    });
  await tx.execute(sql`select set_config('app.message_status_reason', '', true)`);
  if (updated) {
    trackMessageDecided(
      {
        decision: "unscheduled",
        for: updated.kind,
        origin: updated.origin === "owner" ? "owner" : "worker",
        written: "none",
        characters: (updated.text ?? "").length,
      },
      tx,
    );
    return { ok: true };
  }
  const [message] = await tx
    .select({ status: messages.status })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!message) return { ok: false, reason: "not_found" };
  return { ok: false, reason: message.status === "posting" ? "going_out" : "not_scheduled" };
}

/**
 * The owner's Unschedule on the like a scheduled send carries: the like leaves
 * the schedule, and the send keeps its slot and goes out without it. It only
 * narrows what was approved — the send's words, slot and authorship stay as
 * they are, no status moves and nothing is learned. `likeWithSend = false` is
 * the owner's "no like" on that send whatever its step binds (`sendLike`).
 * Once the send is `posting`, the worker holding it has already decided what
 * rides with it.
 */
export async function dropScheduledLikeOp(
  tx: Tx,
  messageId: number,
): Promise<
  { ok: true } | { ok: false; reason: "not_found" | "going_out" | "not_scheduled" }
> {
  const [updated] = await tx
    .update(messages)
    .set({ likeWithSend: false })
    .where(and(eq(messages.id, messageId), eq(messages.status, "approved")))
    .returning({ id: messages.id });
  if (updated) return { ok: true };
  const [message] = await tx
    .select({ status: messages.status })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!message) return { ok: false, reason: "not_found" };
  return { ok: false, reason: message.status === "posting" ? "going_out" : "not_scheduled" };
}

/** The reason recorded with a message's latest move, '' where none was. */
function latestMoveReason(): SQL {
  return sql`coalesce((
    select ${messageStatusEvents.reason}
      from ${messageStatusEvents}
     where ${messageStatusEvents.messageId} = ${messages.id}
     order by ${messageStatusEvents.occurredAt} desc, ${messageStatusEvents.id} desc
     limit 1
  ), '')`;
}

/**
 * Whether a message's latest move was anything but the owner's Unschedule, as
 * a predicate over `messages` for an unattended writer's own update. What the
 * owner took out of the schedule goes back only on their yes: a worker that
 * finds the same draft again — an Automatic Reply re-run on the conversation —
 * leaves it waiting for one.
 */
export function notUnscheduledByOwner(): SQL {
  return sql`${latestMoveReason()} <> 'owner_unscheduled'`;
}

/** Whether a message's latest move was the owner's Unschedule — why a draft
 *  that was approved waits for their yes again. */
export function unscheduledByOwner(): SQL<boolean> {
  return sql<boolean>`${latestMoveReason()} = 'owner_unscheduled'`;
}

/**
 * The owner's "+ Like" on a draft waiting for their yes: whether the like its
 * step binds goes out with it (`actions/likeTarget.ts` `sendLike`). Only
 * before the yes — a yes already given said what it covered.
 */
export async function setMessageLikeWithSend(
  tx: Tx,
  input: { messageId: number; on: boolean },
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_waiting" }> {
  const [updated] = await tx
    .update(messages)
    .set({ likeWithSend: input.on })
    .where(and(eq(messages.id, input.messageId), eq(messages.status, "proposed"), ne(messages.kind, "room_reply")))
    .returning({ id: messages.id });
  if (updated) return { ok: true };
  const [message] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, input.messageId));
  return { ok: false, reason: message ? "not_waiting" : "not_found" };
}

/** Enqueue an immediate (still gated) post for a message, skipping the queue wait. */
export async function postNowOp(
  tx: Tx,
  messageId: number,
): Promise<{ ok: boolean; kind?: Message["kind"] }> {
  const [msg] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!msg) return { ok: false };
  // A send goes on the yes it was approved with: a withdrawn one needs a new.
  if (msg.status !== "approved") return { ok: false };
  // An explicit "now" moves the slot to THIS instant, and the action ledger's
  // drain is woken for it. Hard caps (daily/org, active hours, min-gap floor)
  // still gate the send — "now" means "next legal instant", never a bypass.
  const now = Date.now();
  await tx.update(messages).set({ scheduledAt: now }).where(eq(messages.id, messageId));
  const channelId = await ledgerChannelId(tx, msg.campaignId);
  if (channelId != null) await enqueueActionDispatch(tx, channelId, now);
  return { ok: true, kind: msg.kind };
}

/**
 * Post now for a caller that holds a view of the row that may be stale: only a
 * row still approved moves to now, and one that is not says what it is. The
 * lock and the move share one transaction, so an agent relaying a yes never
 * moves a row the owner has since withdrawn.
 */
export async function postNowApprovedOp(
  tx: Tx,
  messageId: number,
): Promise<
  { ok: true; kind: Message["kind"] } | { ok: false; reason: "not_found" | "not_approved"; currentStatus?: Message["status"] }
> {
  const [row] = await tx
    .select({ status: messages.status })
    .from(messages)
    .where(eq(messages.id, messageId))
    .for("update");
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "approved") return { ok: false, reason: "not_approved", currentStatus: row.status };
  const moved = await postNowOp(tx, messageId);
  return moved.ok ? { ok: true, kind: moved.kind! } : { ok: false, reason: "not_found" };
}

export type AtomicMutationFailureReason =
  | "not_found"
  | "wrong_kind"
  | "invalid_state"
  | "stale_state"
  | "request_conflict"
  | "campaign_stopped";

export type AtomicMutationFailure<
  Status extends string,
  Reason extends string = AtomicMutationFailureReason,
> = {
  ok: false;
  reason: Reason;
  currentStatus?: Status;
  currentRequestVersion?: number;
  currentMessageStatus?: Message["status"];
  currentMessageRequestVersion?: number;
};

export type AtomicMutationSuccess<Status extends string> = {
  ok: true;
  status: Status;
  requestVersion: number;
  idempotent?: boolean;
};

export type AtomicMutationResult<
  Status extends string,
  Reason extends string = AtomicMutationFailureReason,
> = AtomicMutationSuccess<Status> | AtomicMutationFailure<Status, Reason>;

export type MessageCas = {
  messageId: number;
  expectedStatus: Message["status"];
  expectedRequestVersion: number;
};

export type IncomingCas = {
  incomingCommentId: number;
  expectedStatus: IncomingComment["status"];
  expectedRequestVersion: number;
};

function messageFailure(
  reason: AtomicMutationFailureReason,
  message?: Message,
): AtomicMutationFailure<Message["status"]> {
  return {
    ok: false,
    reason,
    currentStatus: message?.status,
    currentRequestVersion: message?.redraftRequestVersion,
  };
}

function incomingFailure<Reason extends string>(
  reason: Reason,
  incoming?: IncomingComment,
  message?: Message,
): AtomicMutationFailure<IncomingComment["status"], Reason> {
  return {
    ok: false,
    reason,
    currentStatus: incoming?.status,
    currentRequestVersion: incoming?.draftRequestVersion,
    currentMessageStatus: message?.status,
    currentMessageRequestVersion: message?.redraftRequestVersion,
  };
}

function messageCasMatches(message: Message, input: MessageCas): boolean {
  return (
    message.status === input.expectedStatus &&
    message.redraftRequestVersion === input.expectedRequestVersion
  );
}

function incomingCasMatches(
  incoming: IncomingComment,
  input: IncomingCas,
): boolean {
  return (
    incoming.status === input.expectedStatus &&
    incoming.draftRequestVersion === input.expectedRequestVersion
  );
}

type RequestUse = {
  target: "message" | "incoming";
  targetId: number;
  requestedBy: string;
  requestNote: string | null;
};

async function lockRequestId(tx: Tx, requestId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
}

async function findRequestUse(
  tx: Tx,
  requestId: string,
): Promise<RequestUse | null> {
  const [message] = await tx
    .select({
      targetId: messages.id,
      requestedBy: messages.redraftRequestedBy,
      requestNote: messages.redraftRequestNote,
    })
    .from(messages)
    .where(eq(messages.redraftRequestId, requestId))
    .limit(1);
  if (message?.requestedBy) {
    return {
      target: "message",
      targetId: message.targetId,
      requestedBy: message.requestedBy,
      requestNote: message.requestNote,
    };
  }

  const [incoming] = await tx
    .select({
      targetId: incomingComments.id,
      requestedBy: incomingComments.draftRequestedBy,
      requestNote: incomingComments.draftRequestNote,
    })
    .from(incomingComments)
    .where(eq(incomingComments.draftRequestId, requestId))
    .limit(1);
  if (incoming?.requestedBy) {
    return {
      target: "incoming",
      targetId: incoming.targetId,
      requestedBy: incoming.requestedBy,
      requestNote: incoming.requestNote,
    };
  }

  const [revision] = await tx
    .select({
      targetId: messageDraftRevisions.messageId,
      requestedBy: messageDraftRevisions.requestedBy,
      requestNote: messageDraftRevisions.requestNote,
    })
    .from(messageDraftRevisions)
    .where(eq(messageDraftRevisions.requestId, requestId))
    .limit(1);
  if (revision?.requestedBy) {
    return {
      target: "message",
      targetId: revision.targetId,
      requestedBy: revision.requestedBy,
      requestNote: revision.requestNote,
    };
  }
  return null;
}

function sameRequest(
  use: RequestUse,
  target: RequestUse["target"],
  targetId: number,
  actor: string,
  note: string | null,
): boolean {
  return (
    use.target === target &&
    use.targetId === targetId &&
    use.requestedBy === actor &&
    use.requestNote === note
  );
}

/** Why a redraft is refused while a Stop holds the message's campaign, as the
 *  owner reads it. */
export const REDRAFT_STOPPED_NOTE = "Sending is stopped on this campaign. Resume sending to redraft.";

/** Request a replacement in the same message pipeline. Human requests always
 * return to Review, regardless of the campaign's automatic approval policy.
 * Refused while a Stop holds its campaign or its account: nothing in a stopped
 * campaign is drafted, and a replacement is a draft. */
export async function requestMessageRedraft(
  tx: Tx,
  input: MessageCas & {
    requestId: string;
    actor: string;
    note?: string | null;
  },
): Promise<AtomicMutationResult<Message["status"]>> {
  const note = input.note ?? null;
  await lockRequestId(tx, input.requestId);
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .for("update");
  if (!message) return messageFailure("not_found");

  const use = await findRequestUse(tx, input.requestId);
  if (message.kind === "room_reply") return messageFailure("wrong_kind", message);
  if (use) {
    if (sameRequest(use, "message", message.id, input.actor, note)) {
      return {
        ok: true,
        status: message.status,
        requestVersion: message.redraftRequestVersion,
        idempotent: true,
      };
    }
    return messageFailure("request_conflict", message);
  }
  if (
    message.status !== "proposed" &&
    message.status !== "approved" &&
    message.status !== "failed"
  ) {
    return messageFailure("invalid_state", message);
  }
  if (!messageCasMatches(message, input)) {
    return messageFailure("stale_state", message);
  }
  if (message.campaignId !== null) {
    const campaign = { id: message.campaignId, channelId: await ledgerChannelId(tx, message.campaignId) };
    if ((await campaignStops(tx, campaign)).length > 0) return messageFailure("campaign_stopped", message);
  }

  const requestedAt = Date.now();
  const nextVersion = message.redraftRequestVersion + 1;
  const [updated] = await tx
    .update(messages)
    .set({
      status: "proposed",
      proposedText: message.finalText ?? message.proposedText,
      finalText: null,
      scheduledAt: null,
      error: null,
      postingStartedAt: null,
      redraftRequestId: input.requestId,
      redraftRequestVersion: nextVersion,
      redraftRequestedAt: requestedAt,
      redraftRequestedBy: input.actor,
      redraftRequestNote: note,
    })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, input.expectedStatus),
        eq(messages.redraftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: messages.status });
  if (!updated) return messageFailure("stale_state", message);
  await queueCommentRedraft(tx, message, input.requestId);
  trackDraftRequested({ kind: "redraft", for: message.kind, surface: surfaceOfActor(input.actor) }, tx);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}

/**
 * An agent's comment on a campaign that runs on its strategy is its
 * Ambassador's to write again (`workers/commentRedraft.ts`), queued at once and
 * keyed on the ask, so a replay of it queues nothing. One the owner wrote, and
 * any other campaign's, stays with the owner's own agent. One attempt: a
 * rewrite that fails says why on the comment and waits for the owner to ask
 * again.
 */
async function queueCommentRedraft(tx: Tx, message: Message, requestId: string): Promise<void> {
  if (message.kind !== "comment" || message.campaignId === null) return;
  if (message.publishOrigin !== "worker") return;
  const [campaign] = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, message.campaignId));
  if (!campaign) return;
  const payload: CommentRedraftPayload = { campaignId: message.campaignId };
  await enqueue(tx, {
    type: "redraft_comments",
    payload,
    idempotencyKey: `redraft_comments:${requestId}`,
    maxAttempts: 1,
  });
}

/** Cancel a pending redraft without replacing the words already shown. */
export async function cancelMessageRedraft(tx: Tx, input: MessageCas & { requestId: string }): Promise<AtomicMutationResult<Message["status"]>> {
  await lockRequestId(tx, input.requestId);
  const [message] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for("update");
  if (!message) return messageFailure("not_found");
  if (!messageCasMatches(message, input)) return messageFailure("stale_state", message);
  if (message.redraftRequestId !== input.requestId || message.status !== "proposed") return messageFailure("request_conflict", message);
  const version = message.redraftRequestVersion + 1;
  await tx.update(messages).set({ redraftRequestId: null, redraftRequestVersion: version, redraftRequestedAt: null, redraftRequestedBy: null, redraftRequestNote: null }).where(eq(messages.id, message.id));
  return { ok: true, status: message.status, requestVersion: version };
}

/** Withdraw a comment without creating relevance or learning feedback. */
export async function dontComment(
  tx: Tx,
  input: MessageCas,
): Promise<AtomicMutationResult<Message["status"]>> {
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .for("update");
  if (!message) return messageFailure("not_found");
  if (message.kind !== "comment") return messageFailure("wrong_kind", message);
  if (
    message.status !== "proposed" &&
    message.status !== "approved" &&
    message.status !== "failed"
  ) {
    return messageFailure("invalid_state", message);
  }
  if (!messageCasMatches(message, input)) {
    return messageFailure("stale_state", message);
  }
  const nextVersion = message.redraftRequestVersion + 1;
  const [updated] = await tx
    .update(messages)
    .set({
      status: "rejected",
      scheduledAt: null,
      error: null,
      redraftRequestId: null,
      redraftRequestVersion: nextVersion,
      redraftRequestedAt: null,
      redraftRequestedBy: null,
      redraftRequestNote: null,
    })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, input.expectedStatus),
        eq(messages.redraftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: messages.status });
  if (!updated) return messageFailure("stale_state", message);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}

/**
 * The owner's Use this one: another draft of a comment's judged set
 * (`trace.pick`) goes in its box, in place of the one there. It approves,
 * sends and teaches nothing — the comment still waits for a yes, still the
 * agent's words — and the history records the swap as a draft Engager wrote
 * that the owner chose (`variant_swap`), never as their edit. The owner story
 * and rationale go with the words; an edit the owner made in the box gives way
 * to the draft they chose.
 *
 * An agent's draft waiting for a yes, with no redraft asked for, only: the
 * owner's own words are no set's to replace, and an asked-for redraft is
 * about to replace these. The status and request version are the CAS, and the
 * version moves, so a second press from a block that has not caught up is
 * refused rather than swapping again.
 */
export async function useDraftVariant(
  tx: Tx,
  input: MessageCas & { variant: number },
): Promise<AtomicMutationResult<Message["status"]>> {
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .for("update");
  if (!message) return messageFailure("not_found");
  if (message.kind !== "comment") return messageFailure("wrong_kind", message);
  if (
    message.status !== "proposed" ||
    message.publishOrigin !== "worker" ||
    message.redraftRequestId != null
  ) {
    return messageFailure("invalid_state", message);
  }
  if (!messageCasMatches(message, input)) {
    return messageFailure("stale_state", message);
  }
  const trace = message.trace;
  const swapped = trace?.pick
    ? swapPick(
        trace.pick,
        {
          text: message.proposedText,
          ownerStoryId: message.ownerStoryId,
          rationale: trace.client?.declared?.rationale,
        },
        input.variant,
      )
    : null;
  if (!trace || !swapped) return messageFailure("invalid_state", message);
  // The rationale the trace declares is the box's: the chosen draft's now.
  const declared = { ...trace.client?.declared, rationale: swapped.chosen.rationale };
  const nextVersion = message.redraftRequestVersion + 1;
  await tx.execute(sql`select set_config('app.message_draft_source', 'variant_swap', true)`);
  const [updated] = await tx
    .update(messages)
    .set({
      proposedText: swapped.chosen.text,
      finalText: null,
      ownerStoryId: swapped.chosen.ownerStoryId ?? null,
      trace: {
        ...trace,
        pick: swapped.pick,
        ...(trace.client ? { client: { ...trace.client, declared } } : {}),
      },
      redraftRequestVersion: nextVersion,
    })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, input.expectedStatus),
        eq(messages.redraftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: messages.status });
  await tx.execute(sql`select set_config('app.message_draft_source', '', true)`);
  if (!updated) return messageFailure("stale_state", message);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}

/**
 * A draft the owner asked their own agent for, from one of the post's
 * angles, joins a waiting comment's set as its next draft: `asked`, with the
 * angle (where it had one) and the move it makes (`""` where it named none).
 * A comment written alone gains a set this way, its draft 1 the one in its
 * box and no pick line, because Engager picked nothing.
 *
 * It changes no words in the box. The owner's block puts it there with the
 * swap Use this one makes (`useDraftVariant`), in front of them — so a yes is
 * never given to words that landed while the owner read others. It approves,
 * sends and teaches nothing: the comment still waits for a yes, still the
 * agent's words.
 *
 * The same waiting draft only, as at the ask: still `proposed`, an agent's,
 * with no Redraft open, at the request version the ask was made against. A
 * comment approved, skipped, redrafted or swapped since is refused, and the
 * draft joins nothing. A draft already in the set is not added twice.
 */
export async function addAskedDraft(
  tx: Tx,
  input: MessageCas & { move: string; angle: string | null; text: string },
): Promise<AtomicMutationResult<Message["status"]> & { draft?: number }> {
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .for("update");
  if (!message) return messageFailure("not_found");
  if (message.kind !== "comment") return messageFailure("wrong_kind", message);
  if (
    message.status !== "proposed" ||
    message.publishOrigin !== "worker" ||
    message.redraftRequestId != null
  ) {
    return messageFailure("invalid_state", message);
  }
  if (!messageCasMatches(message, input)) {
    return messageFailure("stale_state", message);
  }
  const text = input.text.trim();
  // A row written before traces were kept gains one, with the set in it.
  const trace: DraftTrace = message.trace ?? { v: 1, source: "client" };
  const pick = trace.pick ?? { move: "", why: "", scores: [], others: [], draft: 1 };
  const already = setDrafts(pick, message.proposedText).find((entry) => entry.text.trim() === text);
  if (already) {
    return {
      ok: true,
      status: message.status,
      requestVersion: message.redraftRequestVersion,
      idempotent: true,
      draft: already.draft,
    };
  }
  const draft = nextDraftNumber(pick);
  const asked = {
    move: input.move,
    text,
    draft,
    asked: true as const,
    ...(input.angle !== null ? { angle: input.angle } : {}),
  };
  const [updated] = await tx
    .update(messages)
    .set({ trace: { ...trace, pick: { ...pick, others: [...pick.others, asked] } } })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, input.expectedStatus),
        eq(messages.redraftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: messages.status });
  if (!updated) return messageFailure("stale_state", message);
  return { ok: true, status: updated.status, requestVersion: message.redraftRequestVersion, draft };
}

/**
 * The owner's choice of one of their agent's angles in a waiting comment's
 * box: the angle's draft joins the comment's set as one the owner asked for
 * (`addAskedDraft`) and goes in its box (`useDraftVariant`). The words are a
 * draft Engager wrote, chosen — `variant_swap` in its history, never the
 * owner's edit — so the comment still waits for a yes, still the agent's
 * words, and approving it untouched stays unattended volume. Nothing is
 * approved, sent or taught.
 *
 * The angle is the agent's row as the bar showed it, by its own position and
 * revision — never a worker angle's draft number, which `useDraftVariant`
 * takes. The same waiting draft only, at the version the box was read at; an
 * angle rewritten since is stale, and one still being written, or no longer
 * there, is refused. One whose Redraft failed, or lapsed, keeps the draft it
 * had, and that draft is still its to choose: the angle as the bar reads it.
 */
export async function useComposerAngle(
  tx: Tx,
  input: MessageCas & { agentAngle: { position: number; revision: number } },
  now = Date.now(),
): Promise<AtomicMutationResult<Message["status"]>> {
  const [message] = await tx.select().from(messages).where(eq(messages.id, input.messageId));
  if (!message) return messageFailure("not_found");
  if (message.kind !== "comment" || message.discoveredPostId === null) return messageFailure("wrong_kind", message);
  const angle = await shownComposerAngle(
    tx,
    boxKey({ kind: "comment", discoveredPostId: message.discoveredPostId }),
    input.agentAngle.position,
    now,
  );
  if (!angle || angle.state === "writing" || angle.text === null) return messageFailure("invalid_state", message);
  if (angle.revision !== input.agentAngle.revision) return messageFailure("stale_state", message);
  const added = await addAskedDraft(tx, {
    messageId: input.messageId,
    expectedStatus: input.expectedStatus,
    expectedRequestVersion: input.expectedRequestVersion,
    move: angle.move ?? "",
    angle: angle.why,
    text: angle.text,
  });
  if (!added.ok || added.draft === undefined) return added;
  // Its words already in the box: nothing to swap.
  if (added.draft === (message.trace?.pick?.draft ?? 1)) return { ...added, idempotent: true };
  return useDraftVariant(tx, {
    messageId: input.messageId,
    expectedStatus: input.expectedStatus,
    expectedRequestVersion: added.requestVersion,
    variant: added.draft,
  });
}

export type ReplyMessageCas = MessageCas;

/** Who let a reply go: the owner, pressing Don't reply in the Inbox, or
 *  their agent over MCP. */
export type DismissedBy = NonNullable<IncomingComment["dismissedBy"]>;

/**
 * Their reply and the one reply of ours to it, locked for Don't reply or its
 * Undo: ours first, then theirs — the order a send's settle takes them
 * (`settleReply`), so a press racing a settle waits for it instead of
 * deadlocking it, which would fail the settle of a reply already on LinkedIn.
 * A reply of ours written while this waited for their row (a step's draft,
 * written under that row's lock) was not there to lock, so it is read again.
 */
export async function lockReplyTurn(
  tx: Tx,
  incomingCommentId: number,
): Promise<{ incoming: IncomingComment | undefined; reply: Message | undefined }> {
  const ours = () =>
    tx.select().from(messages).where(eq(messages.incomingCommentId, incomingCommentId)).for("update");
  const [early] = await ours();
  const [incoming] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, incomingCommentId))
    .for("update");
  const [reply] = early ? [early] : await ours();
  return { incoming, reply };
}

/**
 * Don't reply — one exact reply of theirs let go, with nothing sent. It takes
 * every reply still waiting on the owner, whatever it is under: held, read as
 * sensitive, undrafted or in a conversation they took over (`new`), one whose
 * draft waits or was turned down (`reply_proposed`), one Reply Off left
 * (`ignored`). A reply of ours to it that waits, is scheduled or failed is
 * withdrawn in the same transaction, and named exactly: one already going
 * out, out, or out unsure is settled in its own block, and refused here.
 *
 * The press is recorded on the row — when, the status it left, the draft it
 * withdrew at the version it left it, who chose it — for its Undo
 * (`undoDontReply`). Nothing reaches LinkedIn, and nothing else about the
 * person moves: the conversation stays open, and a later reply of theirs
 * lands as one more.
 */
export async function dontReply(
  tx: Tx,
  input: IncomingCas & { reply: ReplyMessageCas | null; by: DismissedBy },
): Promise<AtomicMutationResult<IncomingComment["status"]>> {
  const { incoming, reply } = await lockReplyTurn(tx, input.incomingCommentId);
  if (!incoming) return incomingFailure("not_found");

  if ((reply == null) !== (input.reply == null)) {
    return incomingFailure("stale_state", incoming, reply);
  }
  if (incoming.status === "dismissed" || incoming.status === "replied") {
    return incomingFailure("invalid_state", incoming, reply);
  }
  if (!incomingCasMatches(incoming, input)) {
    return incomingFailure("stale_state", incoming, reply);
  }

  let withdrawn: { id: number; version: number } | null = null;
  if (reply && input.reply) {
    if (reply.id !== input.reply.messageId) {
      return incomingFailure("stale_state", incoming, reply);
    }
    if (reply.kind !== "reply") {
      return incomingFailure("wrong_kind", incoming, reply);
    }
    if (
      reply.status !== "proposed" &&
      reply.status !== "approved" &&
      reply.status !== "failed" &&
      reply.status !== "rejected"
    ) {
      return incomingFailure("invalid_state", incoming, reply);
    }
    if (!messageCasMatches(reply, input.reply)) {
      return incomingFailure("stale_state", incoming, reply);
    }
    // A draft the owner already turned down has nothing left to withdraw.
    if (reply.status !== "rejected") {
      withdrawn = { id: reply.id, version: reply.redraftRequestVersion + 1 };
      await tx
        .update(messages)
        .set({
          status: "rejected",
          scheduledAt: null,
          error: null,
          redraftRequestId: null,
          redraftRequestVersion: withdrawn.version,
          redraftRequestedAt: null,
          redraftRequestedBy: null,
          redraftRequestNote: null,
        })
        .where(
          and(
            eq(messages.id, reply.id),
            eq(messages.status, input.reply.expectedStatus),
            eq(
              messages.redraftRequestVersion,
              input.reply.expectedRequestVersion,
            ),
          ),
        );
    }
  }

  const nextVersion = incoming.draftRequestVersion + 1;
  const [updated] = await tx
    .update(incomingComments)
    .set({
      status: "dismissed",
      draftRequestId: null,
      draftRequestVersion: nextVersion,
      draftRequestedAt: null,
      draftRequestedBy: null,
      draftRequestNote: null,
      dismissedAt: Date.now(),
      dismissedFrom: incoming.status,
      dismissedReplyId: withdrawn?.id ?? null,
      dismissedReplyVersion: withdrawn?.version ?? null,
      dismissedBy: input.by,
    })
    .where(
      and(
        eq(incomingComments.id, incoming.id),
        eq(incomingComments.status, input.expectedStatus),
        eq(incomingComments.draftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: incomingComments.status });
  if (!updated) return incomingFailure("stale_state", incoming, reply);
  trackReplyDismissed({ action: "dont_reply", source: incoming.source, by: input.by }, tx);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}

/** Why an Undo changes nothing, beyond any compare-and-set's reasons: the
 *  reply was dismissed before Engager recorded what Undo needs, or LinkedIn
 *  shows it deleted. */
export type UndoDontReplyFailureReason =
  | AtomicMutationFailureReason
  | "not_undoable"
  | "removed";

/**
 * Undo a Don't reply: the reply waits again exactly as it did before the
 * press. Its status goes back to the one the dismissal left, the record is
 * cleared and the version moves; the draft of ours it withdrew comes back to
 * wait for a yes — only while it is still the rejected row the dismissal left,
 * so a draft decided again since stays as it was decided.
 *
 * Refused on a dismissal from before the press was recorded, which says
 * nothing of what to give back, and on a reply LinkedIn shows deleted. Undo
 * drafts nothing, sends nothing and reads nothing: whatever the reply waits
 * on next is the press it waited on before.
 */
export async function undoDontReply(
  tx: Tx,
  input: { incomingCommentId: number; expectedRequestVersion: number; by: DismissedBy },
): Promise<AtomicMutationResult<IncomingComment["status"], UndoDontReplyFailureReason>> {
  const { incoming } = await lockReplyTurn(tx, input.incomingCommentId);
  if (!incoming) return incomingFailure("not_found");
  if (incoming.status !== "dismissed") return incomingFailure("invalid_state", incoming);
  if (incoming.draftRequestVersion !== input.expectedRequestVersion) {
    return incomingFailure("stale_state", incoming);
  }
  if (incoming.dismissedFrom === null) return incomingFailure("not_undoable", incoming);
  if (incoming.removedAt !== null) return incomingFailure("removed", incoming);

  const nextVersion = incoming.draftRequestVersion + 1;
  const [updated] = await tx
    .update(incomingComments)
    .set({
      status: incoming.dismissedFrom,
      draftRequestVersion: nextVersion,
      dismissedAt: null,
      dismissedFrom: null,
      dismissedReplyId: null,
      dismissedReplyVersion: null,
      dismissedBy: null,
    })
    .where(
      and(
        eq(incomingComments.id, incoming.id),
        eq(incomingComments.status, "dismissed"),
        eq(incomingComments.draftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: incomingComments.status });
  if (!updated) return incomingFailure("stale_state", incoming);
  if (incoming.dismissedReplyId !== null && incoming.dismissedReplyVersion !== null) {
    await tx
      .update(messages)
      .set({ status: "proposed", redraftRequestVersion: incoming.dismissedReplyVersion + 1 })
      .where(
        and(
          eq(messages.id, incoming.dismissedReplyId),
          eq(messages.incomingCommentId, incoming.id),
          eq(messages.status, "rejected"),
          eq(messages.redraftRequestVersion, incoming.dismissedReplyVersion),
        ),
      );
  }
  trackReplyDismissed({ action: "undo", source: incoming.source, by: input.by }, tx);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}

/** Request exact agent work for an inbound turn. A policy ignore may be reopened;
 * a prior human dismissal or a delivered reply may not. */
export async function requestIncomingReplyDraft(
  tx: Tx,
  input: IncomingCas & {
    requestId: string;
    actor: string;
    note?: string | null;
    existingReply: ReplyMessageCas | null;
  },
): Promise<AtomicMutationResult<IncomingComment["status"]>> {
  const note = input.note ?? null;
  await lockRequestId(tx, input.requestId);
  const [incoming] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, input.incomingCommentId))
    .for("update");
  if (!incoming) return incomingFailure("not_found");
  const [reply] = await tx
    .select()
    .from(messages)
    .where(eq(messages.incomingCommentId, incoming.id))
    .for("update");

  const use = await findRequestUse(tx, input.requestId);
  if (use) {
    if (sameRequest(use, "incoming", incoming.id, input.actor, note)) {
      return {
        ok: true,
        status: incoming.status,
        requestVersion: incoming.draftRequestVersion,
        idempotent: true,
      };
    }
    return incomingFailure("request_conflict", incoming, reply);
  }
  if (incoming.status === "dismissed" || incoming.status === "replied") {
    return incomingFailure("invalid_state", incoming, reply);
  }
  if (!incomingCasMatches(incoming, input)) {
    return incomingFailure("stale_state", incoming, reply);
  }
  if ((reply == null) !== (input.existingReply == null)) {
    return incomingFailure("stale_state", incoming, reply);
  }
  if (reply && input.existingReply) {
    if (reply.id !== input.existingReply.messageId) {
      return incomingFailure("stale_state", incoming, reply);
    }
    if (reply.kind !== "reply") {
      return incomingFailure("wrong_kind", incoming, reply);
    }
    // A draft the owner turned down may be asked for again: the new one
    // takes its row, which is the one reply this reply may have.
    if (
      reply.status !== "proposed" &&
      reply.status !== "approved" &&
      reply.status !== "failed" &&
      reply.status !== "rejected"
    ) {
      return incomingFailure("invalid_state", incoming, reply);
    }
    if (!messageCasMatches(reply, input.existingReply)) {
      return incomingFailure("stale_state", incoming, reply);
    }
    await tx
      .update(messages)
      .set({
        status: "rejected",
        scheduledAt: null,
        error: null,
        redraftRequestId: null,
        redraftRequestVersion: reply.redraftRequestVersion + 1,
        redraftRequestedAt: null,
        redraftRequestedBy: null,
        redraftRequestNote: null,
      })
      .where(
        and(
          eq(messages.id, reply.id),
          eq(messages.status, input.existingReply.expectedStatus),
          eq(
            messages.redraftRequestVersion,
            input.existingReply.expectedRequestVersion,
          ),
        ),
      );
  }

  const nextVersion = incoming.draftRequestVersion + 1;
  const [updated] = await tx
    .update(incomingComments)
    .set({
      status: "new",
      draftRequestId: input.requestId,
      draftRequestVersion: nextVersion,
      draftRequestedAt: Date.now(),
      draftRequestedBy: input.actor,
      draftRequestNote: note,
    })
    .where(
      and(
        eq(incomingComments.id, incoming.id),
        eq(incomingComments.status, input.expectedStatus),
        eq(incomingComments.draftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: incomingComments.status });
  if (!updated) return incomingFailure("stale_state", incoming, reply);
  trackDraftRequested({ kind: "draft", for: "reply", surface: surfaceOfActor(input.actor) }, tx);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}

export async function cancelIncomingReplyDraft(
  tx: Tx,
  input: IncomingCas & { requestId: string },
): Promise<AtomicMutationResult<IncomingComment["status"]>> {
  const [incoming] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, input.incomingCommentId))
    .for("update");
  if (!incoming) return incomingFailure("not_found");
  if (incoming.status !== "new" || incoming.draftRequestId == null) {
    return incomingFailure("invalid_state", incoming);
  }
  if (incoming.draftRequestId !== input.requestId) {
    return incomingFailure("request_conflict", incoming);
  }
  if (!incomingCasMatches(incoming, input)) {
    return incomingFailure("stale_state", incoming);
  }
  const nextVersion = incoming.draftRequestVersion + 1;
  const [updated] = await tx
    .update(incomingComments)
    .set({
      draftRequestId: null,
      draftRequestVersion: nextVersion,
      draftRequestedAt: null,
      draftRequestedBy: null,
      draftRequestNote: null,
    })
    .where(
      and(
        eq(incomingComments.id, incoming.id),
        eq(incomingComments.status, input.expectedStatus),
        eq(incomingComments.draftRequestVersion, input.expectedRequestVersion),
        eq(incomingComments.draftRequestId, input.requestId),
      ),
    )
    .returning({ status: incomingComments.status });
  if (!updated) return incomingFailure("stale_state", incoming);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}

/** A failed send nothing can have posted: no posting marker, no provider
 *  urn, no redraft asked for. Only such a failure is sent again, or reopened
 *  for an edit; any other is checked on LinkedIn, never retried. */
function definitelyNotPosted(message: Message): boolean {
  return (
    message.status === "failed" &&
    message.postingStartedAt == null &&
    message.externalUrn == null &&
    message.redraftRequestId == null
  );
}

/** Re-arm only a clean, definitive failure. The send goes back on the action
 *  ledger, through every gate and the exactly-once path any send does. */
export async function retryDefinitiveMessageFailure(
  tx: Tx,
  input: MessageCas,
): Promise<AtomicMutationResult<Message["status"]>> {
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .for("update");
  if (!message) return messageFailure("not_found");
  if (!definitelyNotPosted(message)) return messageFailure("invalid_state", message);
  if (!messageCasMatches(message, input)) {
    return messageFailure("stale_state", message);
  }
  const nextVersion = message.redraftRequestVersion + 1;
  const [updated] = await tx
    .update(messages)
    .set({
      status: "approved",
      error: null,
      errorCode: null,
      scheduledAt: Date.now(),
      redraftRequestVersion: nextVersion,
    })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, "failed"),
        eq(messages.redraftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: messages.status });
  if (!updated) return messageFailure("stale_state", message);
  // A comment or a reply goes out as an action, on the yes it was given and has not outlived.
  const how = { yes: message.publishOrigin === "owner" ? { by: "owner:written" } : null, carry: true };
  if (message.kind === "comment") await sendApprovedComment(tx, message.id, how);
  else if (message.kind === "reply") await sendApprovedReply(tx, message.id, how);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}

/**
 * The owner's Edit on a send that definitely did not post: back to a draft
 * waiting for a yes, with their words. It approves nothing — Approve once
 * does, under the authorship rule every decision has — and only a failure
 * nothing can have posted is reopened, as only it is retried. Words changed
 * are the owner's edit (`final_text`); words left as they were reopen the row
 * as it stood.
 */
export async function reopenFailedMessage(
  tx: Tx,
  input: MessageCas & { text: string },
): Promise<AtomicMutationResult<Message["status"]>> {
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .for("update");
  if (!message) return messageFailure("not_found");
  if (!definitelyNotPosted(message)) return messageFailure("invalid_state", message);
  if (!messageCasMatches(message, input)) {
    return messageFailure("stale_state", message);
  }
  const text = input.text.trim();
  if (text.length === 0) return messageFailure("invalid_state", message);
  const nextVersion = message.redraftRequestVersion + 1;
  const [updated] = await tx
    .update(messages)
    .set({
      status: "proposed",
      ...(text === (message.finalText ?? message.proposedText) ? {} : { finalText: text }),
      error: null,
      errorCode: null,
      scheduledAt: null,
      redraftRequestVersion: nextVersion,
    })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.status, "failed"),
        eq(messages.redraftRequestVersion, input.expectedRequestVersion),
      ),
    )
    .returning({ status: messages.status });
  if (!updated) return messageFailure("stale_state", message);
  return { ok: true, status: updated.status, requestVersion: nextVersion };
}
