import { and, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  actions,
  conversationEvents,
  conversations,
  type ActionRow,
  type ActionTarget,
  type ConversationRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { measureBoxAssist } from "@engager/common/text-provenance";
import { boxKey, composerOffered, forgetComposerBoxes, higherRetention, measureComposer } from "../composer/drafts";
import { assertJudgedWords } from "../dispatcher/landedJudge";
import { captureVoiceSample } from "../learning/voiceSamples";
import { campaignVoiceId } from "../voice";
import { approveAction, lockAction } from "./approval";
import { dmOpenTargetFor, dmTargetFor, conversationDms, standingRefusal, type DmRefusal } from "./dm";
import { ActionLedgerError } from "./errors";
import { noteStanding } from "./inviteNote";
import { candidateRefusal, editAction, rejectAction, reserveAction } from "./ledger";
import { notPermitted, ownerRefusal } from "./ownerPress";
import { currentGeneration } from "./pause";

/**
 * A DM THE OWNER WROTE — typed on a conversation's page and sent on their own
 * press (INV-1, INV-7). The words are theirs, so the row is `origin: owner`:
 * the gate spaces it and never caps it, the person's cap counts it and never
 * stops it, and the words become a voice sample in the transaction that
 * queues them — a sample of the voice the conversation's campaign writes in,
 * the default's where it has none.
 *
 * It is the DM path's own row, not a second one: one DM into the one
 * conversation a read has bound — or the one the inbox list held for the
 * owner, which takes their words and no worker's (`standingRefusal`) —
 * reserved through the ledger's one door (`reserveAction`, which re-reads the
 * conversation, every Stop on it and the person's exclusion), and approved by the
 * press that wrote it — the yes is the owner's because the words are. The
 * dispatch gate then does for it what it does for any approved DM: re-reads
 * all of that, reads the conversation afresh and sends once, into a held one
 * only after the message the owner last saw there (`actions/dm.ts`). The
 * press is the yes, so it goes out before DMs are verified on the account, and
 * its confirmed receipt can be the one that verifies them
 * (`liveChecks/records.ts`).
 *
 * A conversation no campaign owns — someone the owner invited or accepted
 * themselves (`ownerInvite.ts`, `invitations/ownerAccept.ts`) — takes the
 * owner's DM all the same: the row names no campaign, and the gate holds it on
 * the account's own guards alone (`ownerPress.ts`, `execution/actionGate.ts`):
 * the kill switch, the account's and the conversation's Stop, the
 * do-not-engage list, exactly-once and the owner's spacing. No campaign's
 * Stop, pause or policy governs it, and a worker's DM into such a conversation
 * is still cancelled as `campaign_gone`.
 *
 * It answers the newest words of theirs on the conversation — a DM, or a reply
 * under our comment — as a `reply`. To a connection Engager keeps no
 * conversation with, it is the first message, and opens one
 * (`dmOpenTargetFor`, US-DM-02): a `reply` where they have written to the
 * account, else the conversation's `opener`. After an invitation of ours it is the
 * invitation's note that opens the conversation: where that was carried by
 * LinkedIn or sent by Engager it is the first message already and the owner's
 * words follow it; where it was neither, the owner's first message is
 * reserved in the note's place (`invite_note`, `actions/inviteNote.ts`), or,
 * with the note's own DM waiting for a yes, goes on that row. The send reads
 * in its own session that they are still a connection and that no
 * conversation with them exists, and binds the one it opens to the conversation.
 *
 * Words their agent wrote for the box (Draft for me, `chat/requestedDm.ts`)
 * stay the owner's to send, and are measured at the press as a saved reply's
 * are — how much of them the DM kept, and how much of that the owner had
 * typed before them — so a DM that is mostly the agent's teaches the voice
 * nothing (`ownerAuthoredSample`).
 */

/** Words an agent offered for the owner's box, newest first, and what the
 *  owner had typed into it before them. */
export type DmAssist = { assistTexts?: readonly string[]; ownerWords?: readonly string[] };

/** What an owner sees when the press cannot queue their DM, and what to do. */
const REFUSAL_COPY: Partial<Record<DmRefusal, [string, string]>> = {
  no_thread: [
    "No LinkedIn conversation with them is bound to this page yet.",
    "A DM goes only into the conversation a read has bound. Write the first message on LinkedIn.",
  ],
  dm_pending: [
    "Another DM to them is still waiting for a yes or a slot.",
    "Edit or skip that one first.",
  ],
  dm_unsettled: [
    "Nobody knows yet whether the last DM to them went out.",
    "Say whether it did under Issues first.",
  ],
};

/** Why the owner cannot open a conversation with them from here. */
const NOT_CONNECTED: [string, string] = [
  "You are not connected with them on LinkedIn.",
  "A first message goes only to a connection. Invite them, or write to them on LinkedIn.",
];
const OPENED_BY_INVITATION: [string, string] = [
  "Your invitation's note was the first message to them.",
  "Engager binds that conversation the next time it reads your messages; write there then, or on LinkedIn now.",
];
/** The note's own message was queued before and skipped or stopped. */
const NOTE_HANDLED: [string, string] = [
  "Your invitation's note already has a message of its own here.",
  "Read where it stands on this page, or write to them on LinkedIn.",
];

function refused(reason: string): ActionLedgerError {
  const copy = REFUSAL_COPY[reason as DmRefusal];
  return copy
    ? notPermitted(copy[0], copy[1])
    : ownerRefusal(reason, ["This conversation cannot take a DM now.", "Read where it stands on this page."]);
}

/** The newest words of theirs on the conversation that nothing has superseded. */
async function newestOfTheirs(tx: Tx, conversationId: number) {
  const later = alias(conversationEvents, "later");
  const [event] = await tx
    .select({ id: conversationEvents.id, contentHash: conversationEvents.contentHash })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ["inbound_message_observed", "reply_observed", "reply_edited"]),
        notExists(tx.select({ id: later.id }).from(later).where(eq(later.supersedesEventId, conversationEvents.id))),
      ),
    )
    .orderBy(desc(conversationEvents.occurredAt), desc(conversationEvents.id))
    .limit(1);
  return event ?? null;
}

export async function sendOwnerDm(
  tx: Tx,
  input: { conversationId: number; text: string; by: string; now?: number } & DmAssist,
): Promise<{ action: ActionRow; sampleId: number | null }> {
  const now = input.now ?? Date.now();
  const text = input.text.trim();
  if (text.length === 0) {
    throw new ActionLedgerError("action_text_required", "A DM needs words.", "Write what to send.");
  }
  await assertJudgedWords(tx, text);
  // Unlocked: `reserveAction` re-reads it and takes the locks, in the order
  // the gate takes them.
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId));
  if (!conversation) {
    throw new ActionLedgerError(
      "conversation_not_found",
      `Conversation ${input.conversationId} not found in this organization.`,
      "Open the person from Inbox.",
    );
  }
  return queueOwnerDm(tx, {
    conversation,
    text,
    by: input.by,
    now,
    assistTexts: input.assistTexts,
    ownerWords: input.ownerWords,
  });
}

/**
 * The owner's own words in place of a worker's DM or follow-up waiting for
 * their yes — Clear · write my own, then Approve: the draft is skipped and
 * their words queued ({@link sendOwnerDm}) in one transaction, so both land or
 * neither does, and the two never wait side by side. They are measured
 * against the draft first, then every agent text their box showed: once
 * skipped, the draft is no longer the box's, so a draft typed back as theirs
 * would otherwise be learned as their voice.
 */
export async function replaceDraftWithOwnerDm(
  tx: Tx,
  input: { actionId: number; text: string; by: string; now?: number } & DmAssist,
): Promise<{ action: ActionRow; sampleId: number | null }> {
  const now = input.now ?? Date.now();
  const draft = await lockAction(tx, input.actionId);
  if ((draft.kind !== "dm" && draft.kind !== "followup") || draft.conversationId === null) {
    throw new ActionLedgerError(
      "action_not_permitted",
      `Action ${draft.id} is not a message in a conversation.`,
      "Write to them from their Messages.",
    );
  }
  // The note's DM is the conversation's first message, and the key admits one:
  // the owner's words go on that row, not on a second one.
  if (draft.purpose !== "invite_note") {
    await rejectAction(tx, { id: draft.id, by: input.by, reason: "owner_wrote_instead", now });
  }
  const drafted = draft.candidate.text;
  const shown = input.assistTexts ?? [];
  return sendOwnerDm(tx, {
    conversationId: draft.conversationId,
    text: input.text,
    by: input.by,
    now,
    assistTexts: drafted === null ? shown : [drafted, ...shown.filter((text) => text.trim() !== drafted.trim())],
    ownerWords: input.ownerWords,
  });
}

/**
 * The owner's words as one DM answering their newest words on the conversation —
 * queued through the ledger's one door, approved by the press that wrote
 * them, and kept as a voice sample in the same transaction. What
 * {@link sendOwnerDm} queues, and what DM's optional live check sends
 * (`liveChecks/flow.ts`) as that check's one write.
 */
export async function queueOwnerDm(
  tx: Tx,
  input: { conversation: ConversationRow; text: string; by: string; now: number } & DmAssist,
): Promise<{ action: ActionRow; sampleId: number | null }> {
  const { conversation, text, now } = input;
  const dms = await conversationDms(tx, conversation.id);
  const note = await noteStanding(tx, conversation.id);
  // The invitation's note waiting for a yes or a slot is the one DM to them,
  // and the conversation's first: the owner's words go on that row.
  if (note.kind === "waiting" && !dms.unsettled) return putWordsOnNote(tx, input, note.action);
  const standing = await standingRefusal(tx, conversation, dms, now, { owner: true });
  if ("reason" in standing) {
    // No conversation at all — not one a read found and could not bind — is a
    // first message's to open.
    if (standing.reason !== "no_thread" || conversation.canonicalDmThreadId !== null) throw refused(standing.reason);
    return queueFirstOwnerDm(tx, { ...input, dms, note });
  }
  const answers = await newestOfTheirs(tx, conversation.id);
  if (!answers) {
    // A conversation held for the owner shows their newest message without
    // recording it, so it may be all there is of theirs, and it is no event
    // a DM can answer.
    if (standing.thread.ownerHeldAt !== null) {
      throw new ActionLedgerError(
        "action_not_permitted",
        "Engager keeps nothing of theirs a DM from here could answer: it only shows their newest message in this conversation.",
        "Answer them on LinkedIn.",
      );
    }
    // The invitation's note, neither carried nor sent, left the conversation
    // without a first message: the owner's words open it in the note's place.
    if (note.kind === "open") {
      return reserveOwnerDm(tx, input, {
        purpose: "invite_note",
        sequence: 1,
        answers: null,
        target: dmTargetFor(standing.thread, conversation.authorProfileId),
        duplicate: NOTE_HANDLED,
      });
    }
    throw new ActionLedgerError(
      "action_not_permitted",
      "They have not written anything a DM here could answer yet.",
      "Write the first message on LinkedIn.",
    );
  }
  return reserveOwnerDm(tx, input, {
    purpose: "reply",
    sequence: await nextSequence(tx, conversation.id, dms),
    answers,
    target: dmTargetFor(standing.thread, conversation.authorProfileId),
  });
}

/**
 * The owner's first message to a connection Engager keeps no conversation
 * with — one DM at a time, as into any conversation, and only to someone the
 * last read showed connected; the send reads it again in its own session.
 */
async function queueFirstOwnerDm(
  tx: Tx,
  input: {
    conversation: ConversationRow;
    text: string;
    by: string;
    now: number;
    dms: Awaited<ReturnType<typeof conversationDms>>;
    note: Awaited<ReturnType<typeof noteStanding>>;
  } & DmAssist,
): Promise<{ action: ActionRow; sampleId: number | null }> {
  const { conversation, dms, note } = input;
  if (dms.unsettled) throw refused("dm_unsettled");
  if (dms.pending) throw refused("dm_pending");
  if (conversation.relationship !== "connected") throw notPermitted(...NOT_CONNECTED);
  const answers = await newestOfTheirs(tx, conversation.id);
  if (answers) {
    return reserveOwnerDm(tx, input, {
      purpose: "reply",
      sequence: await nextSequence(tx, conversation.id, dms),
      answers,
      target: null,
    });
  }
  // After an invitation of ours the note opens the conversation: said when it
  // did, and in its place when it did not.
  switch (note.kind) {
    case "carried":
    case "sent":
      throw notPermitted(...OPENED_BY_INVITATION);
    case "open":
      return reserveOwnerDm(tx, input, {
        purpose: "invite_note",
        sequence: 1,
        answers: null,
        target: null,
        duplicate: NOTE_HANDLED,
      });
    case "waiting":
      throw refused("dm_pending");
    case "none":
      return reserveOwnerDm(tx, input, {
        purpose: "opener",
        sequence: 1,
        answers: null,
        target: null,
        duplicate: OPENED_BY_INVITATION,
      });
  }
}

/**
 * The owner's words on the invitation's note DM that waits for a yes or a
 * slot, in place of the note: the row keeps its key, takes their words
 * (`editAction`, which makes it theirs) and their press is the yes.
 */
async function putWordsOnNote(
  tx: Tx,
  input: { conversation: ConversationRow; text: string; by: string; now: number } & DmAssist,
  note: ActionRow,
): Promise<{ action: ActionRow; sampleId: number | null }> {
  // The ledger's one door re-reads the conversation, every Stop and the person's
  // exclusion for a new row; the row already there is read the same way.
  const stopped = await candidateRefusal(tx, {
    channelId: note.channelId,
    campaignId: note.campaignId,
    conversationId: note.conversationId,
    authorProfileId: note.authorProfileId,
    generationSeen: await currentGeneration(tx),
    origin: "owner",
  });
  if (stopped) throw refused(stopped);
  await editAction(tx, { id: note.id, text: input.text, byOwner: true, now: input.now });
  const { action } = await approveAction(tx, { id: note.id, approver: input.by, now: input.now });
  return keepOwnerWords(tx, input, action);
}

/** A key no row on the conversation holds: past every DM numbered so far, so a
 *  worker's draft the owner skipped never makes their own words a
 *  duplicate. */
async function nextSequence(
  tx: Tx,
  conversationId: number,
  dms: Awaited<ReturnType<typeof conversationDms>>,
): Promise<number> {
  const [numbered] = await tx
    .select({ n: sql<number>`coalesce(max(${actions.sequence}), 0)::int` })
    .from(actions)
    .where(and(eq(actions.conversationId, conversationId), inArray(actions.kind, ["dm", "followup"])));
  return Math.max(numbered?.n ?? 0, dms.confirmed.length) + 1;
}

/** The owner's words reserved through the ledger's one door, approved by the
 *  press that wrote them, and kept as a voice sample in the same
 *  transaction. A null target opens the conversation. */
async function reserveOwnerDm(
  tx: Tx,
  input: { conversation: ConversationRow; text: string; by: string; now: number } & DmAssist,
  as: {
    purpose: "reply" | "opener" | "invite_note";
    sequence: number;
    answers: { id: number; contentHash: string | null } | null;
    target: ActionTarget | null;
    /** What the owner is told where the key is another row's. */
    duplicate?: [string, string];
  },
): Promise<{ action: ActionRow; sampleId: number | null }> {
  const { conversation, text, now } = input;
  const reserved = await reserveAction(tx, {
    channelId: conversation.channelId,
    campaignId: conversation.owningCampaignId,
    conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId,
    kind: "dm",
    purpose: as.purpose,
    sequence: as.sequence,
    inboundEventId: as.answers?.id ?? null,
    target: as.target ?? dmOpenTargetFor(conversation.authorProfileId),
    candidate: {
      text,
      sources: as.answers ? [{ eventId: as.answers.id, contentHash: as.answers.contentHash }] : [],
      versions: { strategy: null, facts: [], memory: null, voice: null },
    },
    origin: "owner",
    mode: "review",
    generationSeen: await currentGeneration(tx),
    now,
  });
  if (reserved.status === "duplicate" && as.duplicate) throw notPermitted(...as.duplicate);
  if (reserved.status !== "reserved") {
    throw refused(reserved.status === "refused" ? reserved.reason : "duplicate");
  }
  const { action } = await approveAction(tx, { id: reserved.action.id, approver: input.by, now });
  return keepOwnerWords(tx, input, action);
}

/** The owner's words as a voice sample, kept in the transaction that queued
 *  them. */
async function keepOwnerWords(
  tx: Tx,
  input: { conversation: ConversationRow; text: string; by: string; now: number } & DmAssist,
  action: ActionRow,
): Promise<{ action: ActionRow; sampleId: number | null }> {
  const { conversation, text } = input;
  const box = boxKey({ kind: "dm", conversationId: conversation.id });
  // With no agent words offered, the owner's words by construction; every
  // angle the box kept counts beside the ones the page sent.
  const assisted = higherRetention(
    measureBoxAssist(text, input.assistTexts, input.ownerWords),
    measureComposer(text, await composerOffered(tx, box), input.ownerWords),
  );
  // Measured, the box's angles are spent: the conversation's next message
  // starts from an empty box.
  await forgetComposerBoxes(tx, [box]);
  const sample = await captureVoiceSample(tx, {
    text,
    source: "owner_dm",
    assistRetention: assisted?.assistRetention ?? null,
    ownerOrigin: assisted?.ownerOrigin ?? null,
    campaignId: conversation.owningCampaignId,
    voiceId: await campaignVoiceId(tx, conversation.owningCampaignId),
  });
  return { action, sampleId: sample.id };
}
