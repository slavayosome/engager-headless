import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import {
  actionApprovals,
  actions,
  campaigns,
  dmThreads,
  engagedProfiles,
  conversations,
  profileIdKey,
  type ActionCandidate,
  type ActionKind,
  type ActionRow,
  type ActionStatus,
  type ActionPurpose,
  type ActionTarget,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  assistRetention as measureAssistRetention,
  retentionWindow,
} from "@engager/common/text-provenance";
import { enqueue } from "../jobs/queue";
import { extractEditSignals, learnFromSave } from "../learning/editSignals";
import { captureVoiceSample } from "../learning/voiceSamples";
import { endLiveCheckWrites } from "../liveChecks/records";
import { setDoNotEngage } from "../operations/engagedProfiles";
import { excludedRoomKeys, excludeRoomIdentity } from "../rooms/retention";
import { findPerson } from "../people/directory";
import { campaignVoiceId } from "../voice";
import { boxKey, composerOffered, measureComposer } from "../composer/drafts";
import { modeFor } from "../strategy/mode";
import { approveAction, invalidateApproval, liveApproval, lockAction } from "./approval";
import { enqueueActionDispatch } from "./drain";
import { ActionLedgerError } from "./errors";
import { surfaceOfActor, trackActionDecided, trackDraftRequested } from "../telemetry/emit";
import { contentHash, personKey, purposeAdmitted, reactionKey } from "./keys";
import {
  lockPauses,
  ownerIsTheReview,
  pauseReasonCode,
  pausesTouching,
  pauseVerdict,
  QUEUED_STATUSES,
  scopesOf,
  stopScope,
} from "./pause";

/**
 * THE ACTION LEDGER — a row before any click (INV-27, INV-18; spec §12 R09,
 * §15 R11).
 *
 * `reserveAction` is candidate creation's one door for the kinds the
 * `messages` path never carried. It re-reads, in the transaction that
 * inserts, what may have moved since the proposer looked: the conversation (closed,
 * owned by the owner, held), the pauses on every scope the action touches and
 * their generation, and the person's exclusion. Then it inserts under the
 * semantic idempotency key; the unique constraint, not the account lease, is
 * what makes a second proposal of the same action reserve nothing — the lease
 * would not survive a crash between two wakes.
 *
 * A row lands `awaiting_review` (Ask me) or `reserved` (Automatic, which a
 * kind reaches only on an owner-set rolling-24h ceiling — INV-28). Nothing
 * here dispatches: the gate (`execution/actionGate.ts`) is the only path to a
 * click. A `reserved` row is queued for it in the transaction that writes the
 * row, as an owner's yes queues an approved one (`actions/drain.ts`); the gate
 * re-reads every guard, and binds the row to the account's window and ceiling.
 *
 * The rest are the owner's decisions on a queued row — skip, edit, exclude the
 * person — each in its own transaction, each leaving a row nothing can send
 * without a fresh yes.
 */

export type ReserveInput = {
  channelId: number;
  campaignId: number | null;
  conversationId: number | null;
  authorProfileId: string | null;
  stepRunId?: number | null;
  actionBindingId?: string | null;
  kind: ActionKind;
  purpose: ActionPurpose;
  sequence?: number;
  target: ActionTarget;
  /** The inbound event a `reply` answers. */
  inboundEventId?: number | null;
  /** The send of ours this action rides with: the gate holds it until that
   *  message is posted. */
  messageId?: number | null;
  candidate: ActionCandidate;
  origin?: "owner" | "worker";
  /** What the action's mode resolved to when it was proposed. */
  mode: "review" | "auto";
  /** The pause generation the proposer read before it began — a Stop written
   *  since outranks the proposal. */
  generationSeen: number;
  /** The owner's own press takes up a row of the same action that was
   *  skipped, stopped or blocked, as one settled not sent always is. Only for
   *  a kind whose row is never cancelled or blocked after its click — a like
   *  (`likeTarget.ts`) — and only with `origin: owner`: what the owner skipped
   *  stays skipped for the workers. */
  retakeUnclicked?: boolean;
  now?: number;
};

export type ReserveOutcome =
  | { status: "reserved"; action: ActionRow }
  | { status: "duplicate"; action: ActionRow }
  | { status: "refused"; reason: string };

/** The semantic key of the action an input describes. */
export function idempotencyKeyFor(input: ReserveInput): string {
  if (input.kind === "like_target") {
    return reactionKey({ channelId: input.channelId, target: input.target, reaction: "like" });
  }
  if (input.authorProfileId === null || input.conversationId === null) {
    throw new Error(`a ${input.kind} is to a person on a conversation`);
  }
  return personKey({
    channelId: input.channelId,
    personId: input.authorProfileId,
    conversationId: input.conversationId,
    purpose: input.purpose,
    sequence: input.sequence ?? 1,
    inboundEventId: input.inboundEventId ?? null,
  });
}

export async function reserveAction(tx: Tx, input: ReserveInput): Promise<ReserveOutcome> {
  const now = input.now ?? Date.now();
  // A purpose the kind cannot serve is refused, not keyed: a follow-up only
  // follows up, an invitation only opens.
  if (!purposeAdmitted(input.kind, input.purpose)) {
    return { status: "refused", reason: `purpose_not_admitted:${input.kind}:${input.purpose}` };
  }
  const key = idempotencyKeyFor(input);
  const refused = await candidateRefusal(tx, input);
  if (refused) return { status: "refused", reason: refused };
  // No worker's DM goes into a conversation the inbox list held for the owner
  // (`conversations/dm.ts`); the owner's own words do, on their press. The
  // person's public thread is not held.
  if (
    input.target.kind === "dm_thread" &&
    input.origin !== "owner" &&
    (await ownerHeld(tx, input.channelId, input.target.id))
  ) {
    return { status: "refused", reason: "owner_held" };
  }

  let mode = input.mode;
  if (input.origin !== "owner") {
    const current = input.campaignId !== null && input.actionBindingId
      ? await modeFor(tx, { campaignId: input.campaignId, actionBindingId: input.actionBindingId })
      : null;
    // No campaign or binding to resolve is the same answer as a binding that is Off.
    if (current?.effective !== "review" && current?.effective !== "auto") {
      return { status: "refused", reason: "mode_off" };
    }
    if (current.effective === "review") mode = "review";
  }
  const status: ActionStatus = mode === "review" ? "awaiting_review" : "reserved";
  const fields = {
    campaignId: input.campaignId,
    stepRunId: input.stepRunId ?? null,
    messageId: input.messageId ?? null,
    actionBindingId: input.actionBindingId ?? null,
    target: input.target,
    contentHash: contentHash(input.kind, input.candidate.text),
    candidate: input.candidate,
    origin: input.origin ?? "worker",
    status,
    generationSeen: input.generationSeen,
    updatedAt: now,
  } as const;
  const [inserted] = await tx
    .insert(actions)
    .values({
      ...fields,
      channelId: input.channelId,
      conversationId: input.conversationId,
      authorProfileId: input.authorProfileId,
      kind: input.kind,
      purpose: input.purpose,
      sequence: input.sequence ?? 1,
      idempotencyKey: key,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [actions.organizationId, actions.idempotencyKey],
    })
    .returning();
  if (inserted) return queued(tx, inserted, now);

  const [existing] = await tx
    .select()
    .from(actions)
    .where(eq(actions.idempotencyKey, key))
    .for("update");
  if (!existing) throw new Error(`action ${key}: neither inserted nor found`);
  // The one retry the ledger admits (INV-10): a send with evidence that it
  // did not go out is the same action again — its attempts kept, its words
  // and their dependencies the new proposal's, waiting for a fresh yes. An
  // uncertain one never is; anything else already answered the proposal, and
  // so does a row of another kind that holds the same key (an invitation's
  // opener is the opener). The owner's own press, where it may, also takes up
  // one that never reached its click (`retakeUnclicked`).
  const retaken =
    existing.status === "definitely_not_sent" ||
    (input.retakeUnclicked === true &&
      input.origin === "owner" &&
      (existing.status === "cancelled" || existing.status === "blocked"));
  if (!retaken || existing.kind !== input.kind) {
    return { status: "duplicate", action: existing };
  }
  const [rearmed] = await tx
    .update(actions)
    .set({
      ...fields,
      // The conversation too: a reaction's key names none, so the owner's own like
      // never rides on the conversation a worker's proposal of it did.
      conversationId: input.conversationId,
      statusReason: "retry_after_not_sent",
      fenceToken: null,
      submittedAt: null,
      externalReceipt: null,
      settledAt: null,
    })
    .where(and(eq(actions.id, existing.id), eq(actions.status, existing.status)))
    .returning();
  return queued(tx, rearmed!, now);
}

/** Whether the conversation is one the inbox list held for the owner. */
async function ownerHeld(tx: Tx, channelId: number, providerThreadId: string): Promise<boolean> {
  const [thread] = await tx
    .select({ heldAt: dmThreads.ownerHeldAt })
    .from(dmThreads)
    .where(and(eq(dmThreads.channelId, channelId), eq(dmThreads.providerThreadId, providerThreadId)));
  return thread?.heldAt != null;
}

/** A reservation, with an Automatic one handed to the send gate: no yes is
 *  coming for it, so nothing else would. */
async function queued(tx: Tx, action: ActionRow, now: number): Promise<ReserveOutcome> {
  if (action.status === "reserved") await enqueueActionDispatch(tx, action.channelId, now);
  return { status: "reserved", action };
}

/**
 * Why no candidate may be made for this person now, or null — what candidate
 * creation re-reads in the transaction that writes one, whichever table it
 * lands on (INV-29): the conversation closed, taken over or held; a pause on the
 * account, the campaign or the conversation open, or written since the
 * proposer's generation; the person excluded. A conversation only waiting on
 * the owner is held to unattended work alone: their own press is the review
 * (`ownerIsTheReview`). Under the pause lock, so a Stop, a takeover or an
 * exclusion either committed before this reads, or waits for the candidate and
 * cancels it.
 */
export async function candidateRefusal(
  tx: Tx,
  input: Pick<
    ReserveInput,
    "channelId" | "campaignId" | "conversationId" | "authorProfileId" | "generationSeen" | "origin"
  >,
): Promise<string | null> {
  if (input.conversationId !== null) {
    const [conversation] = await tx
      .select({ closedReason: conversations.closedReason, opsStatus: conversations.opsStatus })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .for("share");
    if (!conversation) return "conversation_not_found";
    if (conversation.closedReason !== null) return "conversation_closed";
    if (conversation.opsStatus === "human_owned") return "human_owned";
    if (conversation.opsStatus !== "runnable" && !ownerIsTheReview(input.origin, conversation.opsStatus)) {
      return `held:${conversation.opsStatus}`;
    }
  }
  await lockPauses(tx);
  const verdict = pauseVerdict(
    await pausesTouching(tx, scopesOf(input), input.generationSeen),
    input.generationSeen,
  );
  if (verdict) return pauseReasonCode(verdict);
  if (input.authorProfileId !== null) {
    const [person] = await tx
      .select({ block: engagedProfiles.doNotEngage })
      .from(engagedProfiles)
      .where(eq(engagedProfiles.profileId, input.authorProfileId));
    if (person?.block || (await excludedRoomKeys(tx)).has(`p.${profileIdKey(input.authorProfileId)}`)) return "excluded";
  }
  return null;
}

/** The owner's no: the action is cancelled and its approval with it. Only a
 *  row short of the click can be skipped. */
export async function rejectAction(
  tx: Tx,
  input: { id: number; by: string; reason?: string; now?: number },
): Promise<ActionRow> {
  const now = input.now ?? Date.now();
  const row = await lockAction(tx, input.id);
  if (!(QUEUED_STATUSES as readonly string[]).includes(row.status)) {
    throw new ActionLedgerError(
      "action_not_awaiting_review",
      `Action ${row.id} is ${row.status}; only a queued action can be skipped.`,
      row.status === "uncertain"
        ? "An uncertain send is resolved, never skipped: check the person's profile on LinkedIn, then use resolve_outcome."
        : "Nothing to skip — it is settled or cancelled already.",
    );
  }
  const reason = input.reason ?? "skipped";
  const approval = await liveApproval(tx, row.id);
  if (approval) {
    await tx
      .update(actionApprovals)
      .set({ invalidatedAt: now, invalidatedReason: reason })
      .where(eq(actionApprovals.id, approval.id));
  }
  const [cancelled] = await tx
    .update(actions)
    .set({ status: "cancelled", statusReason: `${reason}:${input.by}`, settledAt: now, updatedAt: now })
    .where(eq(actions.id, row.id))
    .returning();
  await endLiveCheckWrites(tx, [row.id], "cancelled", now);
  trackActionDecided(cancelled!, "rejected", {}, tx);
  return cancelled!;
}

/**
 * The owner's Unschedule: a scheduled action leaves the schedule and waits for
 * their yes again. An approved one's yes is invalidated (`owner_unscheduled`),
 * so the gate, which re-reads the row before any click, finds nothing queued;
 * an Automatic reservation, which no yes stood behind, now needs one. Not a
 * skip — nothing is cancelled and the row stays the worker's proposal. One
 * the gate already wrote `dispatching` is past taking back.
 */
export async function unscheduleAction(
  tx: Tx,
  input: { id: number; now?: number },
): Promise<ActionRow> {
  const now = input.now ?? Date.now();
  const row = await lockAction(tx, input.id);
  if (row.status === "dispatching") {
    throw new ActionLedgerError(
      "action_going_out",
      "It is already going out, so it can no longer be unscheduled.",
      "Its outcome shows on the person in Inbox once LinkedIn answers.",
    );
  }
  if (row.status !== "approved" && row.status !== "reserved") {
    throw new ActionLedgerError(
      "action_not_scheduled",
      `Action ${row.id} is ${row.status}; only a scheduled action can be unscheduled.`,
      "Read it with list_activity.",
    );
  }
  const approval = row.status === "approved" ? await liveApproval(tx, row.id) : null;
  if (approval) {
    await invalidateApproval(tx, approval, "owner_unscheduled", now);
  } else {
    await tx
      .update(actions)
      .set({ status: "awaiting_review", statusReason: "owner_unscheduled", updatedAt: now })
      .where(eq(actions.id, row.id));
  }
  const [unscheduled] = await tx.select().from(actions).where(eq(actions.id, row.id));
  trackActionDecided(unscheduled!, "unscheduled", {}, tx);
  return unscheduled!;
}

/**
 * New words for a queued action that carries words. Its content hash moves
 * with them, so a yes given to the old words no longer holds: an approved row
 * goes back to waiting for one. Written by the owner in a direct surface, the
 * words are theirs — INV-1's authorship — and the action is only spaced; an
 * agent relaying an edit leaves it unattended work.
 */
export async function editAction(
  tx: Tx,
  input: { id: number; text: string; byOwner: boolean; now?: number },
): Promise<ActionRow> {
  const now = input.now ?? Date.now();
  const text = input.text.trim();
  const row = await lockAction(tx, input.id);
  if (row.candidate.text === null) {
    throw new ActionLedgerError(
      "action_text_required",
      `A ${row.kind} carries no words to edit.`,
      "Approve or skip it as it stands.",
    );
  }
  if (text.length === 0) {
    throw new ActionLedgerError(
      "action_text_required",
      "An edit needs the new words.",
      "Send the full text the action should carry.",
    );
  }
  if (row.status !== "awaiting_review" && row.status !== "approved" && row.status !== "reserved") {
    throw new ActionLedgerError(
      "action_not_awaiting_review",
      `Action ${row.id} is ${row.status}; only a queued action can be edited.`,
      "Read it with list_activity.",
    );
  }
  const approval = await liveApproval(tx, row.id);
  if (approval) await invalidateApproval(tx, approval, "text", now);
  const [edited] = await tx
    .update(actions)
    .set({
      candidate: { ...row.candidate, text },
      contentHash: contentHash(row.kind, text),
      origin: input.byOwner ? "owner" : row.origin,
      status: "awaiting_review",
      statusReason: approval ? "approval_invalidated:text" : null,
      updatedAt: now,
    })
    .where(eq(actions.id, row.id))
    .returning();
  return edited!;
}

/** Where a DM the owner asked to have written again stands, on its
 *  `status_reason`: asked, written again and waiting for a yes, or not
 *  written — the draft as it was, waiting for a yes all the same. */
export const ACTION_REDRAFT = {
  asked: "redraft_requested",
  written: "redrafted",
  notWritten: "redraft_not_written",
} as const;

export type ActionRedraftPayload = { actionId: number };

/** How long an ask stands before it may be asked again: past the job lease
 *  (`jobs/queue.ts` `LEASE_MS`) and the rewrite's one model call, an ask still
 *  open is one whose job died — a crash or a restart — and is not coming. */
export const REDRAFT_ASK_STALE_MS = 10 * 60_000;

/**
 * The owner's Redraft on a DM or follow-up a worker drafted: the draft stays
 * where it is, waiting for a yes, and its step's writer writes it again now
 * from their conversation as it stands (`agentStep/redraft.ts`
 * `redraftAskedAction`, queued here). Until the new words land nothing
 * approves the old ones on the ask's behalf, and a yes, an edit or a skip
 * given meanwhile wins: the rewrite keeps only an ask still standing.
 *
 * Only a worker's draft waiting for a yes is written again, and only where a
 * yes could still send it: a Stop, a takeover or an exclusion since it was
 * drafted refuses the ask, as it refuses the yes. An ask still open is asked
 * once; past {@link REDRAFT_ASK_STALE_MS} it is asked again.
 */
export async function requestActionRedraft(
  tx: Tx,
  input: { id: number; by: string; now?: number },
): Promise<ActionRow> {
  const now = input.now ?? Date.now();
  const row = await lockAction(tx, input.id);
  if ((row.kind !== "dm" && row.kind !== "followup") || row.origin !== "worker" || row.stepRunId === null) {
    throw new ActionLedgerError(
      "action_not_permitted",
      `Action ${row.id} is not a message a worker drafted, so there is nothing to write again.`,
      "Change its words yourself, or skip it.",
    );
  }
  if (row.status !== "awaiting_review") {
    throw new ActionLedgerError(
      "action_not_awaiting_review",
      `Action ${row.id} is ${row.status}; only a draft waiting for a yes is written again.`,
      "Read it with list_activity.",
    );
  }
  if (row.statusReason === ACTION_REDRAFT.asked && now - row.updatedAt < REDRAFT_ASK_STALE_MS) return row;
  const refused = await candidateRefusal(tx, row);
  if (refused) {
    throw new ActionLedgerError(
      "action_stopped",
      `Action ${row.id}'s conversation cannot take a new draft now (${refused}).`,
      "Skip it. After a Resume, a worker drafts afresh from what is true then.",
    );
  }
  const [asked] = await tx
    .update(actions)
    .set({ statusReason: ACTION_REDRAFT.asked, updatedAt: now })
    .where(eq(actions.id, row.id))
    .returning();
  const payload: ActionRedraftPayload = { actionId: row.id };
  // Keyed on the ask, so a replay queues nothing; one attempt, since a
  // rewrite that comes to nothing says so on the row and waits for the owner.
  await enqueue(tx, {
    type: "redraft_action",
    payload,
    idempotencyKey: `redraft_action:${row.id}:${now}`,
    maxAttempts: 1,
  });
  trackDraftRequested(
    { kind: "redraft", for: "dm", surface: surfaceOfActor(input.by) },
    tx,
  );
  return asked!;
}

/**
 * The owner's own words for a queued action and their yes to them, in one
 * press from a direct surface — the ledger's Save & approve. Words left as
 * they were are a plain yes, and the action stays the worker's.
 *
 * A rewrite of a DM a worker drafted teaches the voice its campaign writes in
 * how its owner writes DMs (`keepDmRewrite`). An invitation's note teaches
 * nothing.
 */
export async function editAndApproveAction(
  tx: Tx,
  input: { id: number; text: string; approver: string; now?: number },
): Promise<ActionRow> {
  const now = input.now ?? Date.now();
  const row = await lockAction(tx, input.id);
  const text = input.text.trim();
  const draft = row.candidate.text;
  const edited = row.candidate.text !== text;
  if (edited) {
    await editAction(tx, { id: row.id, text, byOwner: true, now });
    if ((row.kind === "dm" || row.kind === "followup") && row.origin === "worker" && draft !== null) {
      await keepDmRewrite(tx, { campaignId: row.campaignId, conversationId: row.conversationId, draft, text });
    }
  }
  const approved = (await approveAction(tx, { id: row.id, approver: input.approver, now, silent: true })).action;
  // How the words came to be: the owner's rewrite of a draft, measured against
  // it, or the draft as it stood. Only the measure travels.
  trackActionDecided(
    approved,
    "approved",
    edited
      ? {
          written: "edited_draft",
          retentionPercent:
            draft === null ? null : measureAssistRetention(text, retentionWindow([draft])).retention * 100,
        }
      : { written: "kept_draft", retentionPercent: 100 },
    tx,
  );
  return approved;
}

/**
 * The owner's rewrite of a worker's DM, kept as a DM sample of the voice its
 * campaign writes in, measured against the draft it rewrote and every angle
 * its box kept: words that are mostly the agent's stay an approval and teach
 * how they write nothing (`ownerAuthoredSample`). What the rewrite changed is
 * kept with it, and the DM channel's habits roll up from it
 * (`refreshLearnedDirectives`) — never a comment's or a reply's.
 */
async function keepDmRewrite(
  tx: Tx,
  input: { campaignId: number | null; conversationId: number | null; draft: string; text: string },
): Promise<void> {
  const voiceId = await campaignVoiceId(tx, input.campaignId);
  const editSignals = extractEditSignals(input.draft, input.text);
  const boxOffered =
    input.conversationId === null ? [] : await composerOffered(tx, boxKey({ kind: "dm", conversationId: input.conversationId }));
  const sample = await captureVoiceSample(tx, {
    text: input.text,
    source: "owner_dm",
    assistRetention: Math.max(
      measureAssistRetention(input.text, retentionWindow([input.draft])).retention,
      measureComposer(input.text, boxOffered)?.assistRetention ?? 0,
    ),
    ownerOrigin: null,
    campaignId: input.campaignId,
    voiceId,
    editSignals,
  });
  if (sample.id != null) await learnFromSave(tx, voiceId);
}

/**
 * Never this person again: the account's do-not-engage list (the same flag
 * `update_person` writes, which every send gate reads), and every queued
 * action to them cancelled — their conversation's under a new pause
 * generation (`exclusion`), so whatever a wake reserved for them before this
 * commits meets it at the gate too.
 */
export async function excludeActionPerson(
  tx: Tx,
  input: { id: number; by: string; now?: number },
): Promise<{ profileId: string; cancelled: number }> {
  // The pause lock before the row's, in the order the gate takes them.
  await lockPauses(tx);
  const row = await lockAction(tx, input.id);
  if (row.authorProfileId === null) {
    throw new ActionLedgerError(
      "action_not_permitted",
      `Action ${row.id} names no person to exclude.`,
      "Skip it instead.",
    );
  }
  return excludePerson(tx, {
    profileId: row.authorProfileId,
    conversationId: row.conversationId,
    by: input.by,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

/**
 * The same exclusion from the person rather than from one of their actions —
 * a conversation's page, which may have nothing queued to press it on. Takes
 * the pause lock itself; under a caller's it is the same lock again.
 */
export async function excludePerson(
  tx: Tx,
  input: { profileId: string; conversationId: number | null; by: string; now?: number },
): Promise<{ profileId: string; cancelled: number }> {
  const now = input.now ?? Date.now();
  const person = input.profileId;
  await lockPauses(tx);
  await setDoNotEngage(tx, { profileId: person, doNotEngage: true });
  const conversation =
    input.conversationId === null
      ? 0
      : (
          await stopScope(tx, {
            scope: "conversation",
            scopeId: input.conversationId,
            reason: "exclusion",
            by: input.by,
            now,
          })
        ).cancelled;
  // What no conversation holds: a reaction on their post, say.
  const elsewhere = await tx
    .update(actions)
    .set({ status: "cancelled", statusReason: `excluded:${input.by}`, settledAt: now, updatedAt: now })
    .where(
      and(
        eq(actions.authorProfileId, person),
        inArray(actions.status, QUEUED_STATUSES),
      ),
    )
    .returning({ id: actions.id });
  await endLiveCheckWrites(
    tx,
    elsewhere.map((action) => action.id),
    "cancelled",
    now,
  );
  if (elsewhere.length > 0) {
    await tx
      .update(actionApprovals)
      .set({ invalidatedAt: now, invalidatedReason: "excluded" })
      .where(
        and(
          inArray(
            actionApprovals.actionExecutionId,
            elsewhere.map((action) => action.id),
          ),
          isNull(actionApprovals.usedAt),
          isNull(actionApprovals.invalidatedAt),
        ),
      );
  }
  return { profileId: person, cancelled: conversation + elsewhere.length };
}

export const LIST_ACTIONS_LIMIT = 100;

/** The same owner exclusion accepts a member-only room identity. */
export async function excludePersonKey(tx: Tx, input: { personKey: string; by: string; now?: number }) {
  const person = await findPerson(tx, input.personKey);
  if (!person) throw new Error("This person is gone.");
  if (person.profileId) return excludePerson(tx, { profileId: person.profileId, conversationId: person.conversationId, ...input });
  await lockPauses(tx);
  return excludeRoomIdentity(tx, person.canonicalKey, input.now);
}

export type ActionListItem = ActionRow & { campaignName: string | null };

/** The ledger's rows, newest first, optionally narrowed. */
export async function listActions(
  tx: Tx,
  filter: {
    statuses?: readonly ActionStatus[];
    campaignId?: number;
    conversationId?: number;
    limit?: number;
  } = {},
): Promise<ActionListItem[]> {
  const where: SQL[] = [];
  if (filter.statuses && filter.statuses.length > 0) {
    where.push(inArray(actions.status, [...filter.statuses]));
  }
  if (filter.campaignId !== undefined) where.push(eq(actions.campaignId, filter.campaignId));
  if (filter.conversationId !== undefined) where.push(eq(actions.conversationId, filter.conversationId));
  const rows = await tx
    .select({ action: actions, campaignName: campaigns.name })
    .from(actions)
    .leftJoin(campaigns, eq(campaigns.id, actions.campaignId))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(actions.updatedAt), desc(actions.id))
    .limit(Math.min(filter.limit ?? LIST_ACTIONS_LIMIT, LIST_ACTIONS_LIMIT));
  return rows.map((row) => ({ ...row.action, campaignName: row.campaignName }));
}
