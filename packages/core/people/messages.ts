import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  actionApprovals,
  actions,
  dmThreads,
  conversationEvents,
  conversations,
  type ActionRow,
  type ActionStatus,
  type ConversationEventRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { dmTargetFor } from "../actions/dm";
import { noteOf } from "../actions/inviteNote";
import { askOwner, clickedAt, nextReconcileAt } from "../execution/reconcileReads";
import type { MessageIntent } from "../conversations/classify";
import { intentOf } from "../conversations/conversation";
import { INVITATION_ANSWERS } from "../conversations/record";

/**
 * A PERSON'S DIRECT MESSAGES WITH THE ACCOUNT — the Messages beside their
 * Public thread: the conversation a read bound to their conversation, every
 * message in it oldest first, and how the two of them came to be connected.
 *
 * Their messages are the conversation's own record of them; ours are the DM and
 * follow-up rows of the action ledger that went out, or went with an outcome
 * nobody knows yet — a confirmed DM of ours the log holds with no row of
 * the conversation's behind it, and what the owner wrote on LinkedIn itself
 * that a read saw (`owner_message_observed`). A conversation the inbox list held for the owner is read
 * by nothing, so its newest message — kept as the list showed it — stands in
 * for theirs, to be seen and nothing else.
 *
 * The invitation's note is the first message of ours when it opened the
 * conversation: carried there by LinkedIn (`invite_note_carried`) or sent by
 * Engager as a DM (`invite_note`) once that DM is confirmed. It sits at the
 * time the invitation went, and the acceptance that follows it says it opened
 * the conversation (`noteOpened`). With no note, Messages starts at the first
 * words either way.
 *
 * Reads only, inside the caller's `withOrg`; every table read is under RLS.
 * Their words are verbatim and untrusted: a surface renders them as text.
 */

export type DmEntry =
  | {
      kind: "theirs";
      key: string;
      at: number;
      text: string | null;
      intent: MessageIntent | null;
      /** The newest message of a conversation held for the owner, as the
       *  inbox list showed it: shown, never read. */
      held: boolean;
    }
  | {
      kind: "ours";
      key: string;
      at: number;
      /** Its ledger row; null for a confirmed DM the log holds with none of
       *  the conversation's behind it, whose words and yes are not known. */
      actionId: number | null;
      text: string | null;
      /** The owner's own words, as against a draft. */
      owner: boolean;
      /** The owner's yes sent it; else it went on its own. */
      approved: boolean;
      status: ActionStatus;
      /** The invitation's note, which opened the conversation. Absent for
       *  every other message. */
      note?: true;
      /** Written by the owner on LinkedIn itself, which a read saw. Absent
       *  for every message Engager sent. */
      linkedIn?: true;
    };

export type PersonMessaging = {
  /** The conversation a read bound to them, where one has. */
  thread: { url: string; ownerHeldAt: number | null } | null;
  /** Oldest first. */
  entries: DmEntry[];
  /** How they came to be connected, as the log recorded it: they accepted
   *  our invite — sent from the thread of the reply it answered — or the
   *  account accepted theirs. */
  connectedBy:
    | {
        kind: "accepted_ours";
        at: number;
        incomingCommentId: number | null;
        /** The invitation's note is the conversation's first message,
         *  carried or sent. Absent with no note, or one that never reached the
         *  conversation. */
        noteOpened?: true;
      }
    | { kind: "accepted_theirs"; at: number }
    | null;
  /** Our invite, sent and not answered yet: when it went. */
  inviteSentAt: number | null;
  /** The words that invite carries, which become the first message once
   *  they accept. Absent for an invite with no note, or none pending. */
  inviteNote?: string;
};

/** What of ours shows as a message: it went, or it may have. */
const SENT: readonly ActionStatus[] = ["dispatching", "uncertain", "confirmed"];

export async function readPersonMessaging(tx: Tx, conversationId: number): Promise<PersonMessaging | null> {
  const [conversation] = await tx
    .select({
      id: conversations.id,
      authorProfileId: conversations.authorProfileId,
      threadId: conversations.canonicalDmThreadId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conversation) return null;

  const [thread] =
    conversation.threadId === null
      ? []
      : await tx
          .select()
          .from(dmThreads)
          .where(and(eq(dmThreads.id, conversation.threadId), eq(dmThreads.binding, "bound")));
  const events = await tx
    .select()
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversation.id),
        inArray(conversationEvents.type, [
          "inbound_message_observed",
          "owner_message_observed",
          "dm_confirmed",
          "invitation_confirmed",
          "invite_note_carried",
          ...INVITATION_ANSWERS,
        ]),
      ),
    )
    .orderBy(asc(conversationEvents.occurredAt), asc(conversationEvents.id));
  const ledger = await tx
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversation.id),
        inArray(actions.kind, ["dm", "followup", "invite"]),
      ),
    )
    .orderBy(asc(actions.createdAt), asc(actions.id));
  const sent = ledger.filter((action) => action.kind !== "invite" && SENT.includes(action.status));
  // The invitation our acceptance answered, and whether its note is the
  // conversation's first message: its DM went, or a read found it carried.
  const answered = acceptedInvite(events, ledger);
  const invite = answered?.accepted.sourceRef.invitationId === undefined ? answered?.invite : undefined;
  const note = invite ? noteOf(invite) : null;
  const noteDm = sent.find((action) => action.purpose === "invite_note" && action.status === "confirmed");
  const carried =
    invite !== undefined &&
    events.some((event) => event.type === "invite_note_carried" && event.sourceRef.actionExecutionId === invite.id);
  const noteSentAt =
    invite === undefined
      ? null
      : (events.find(
          (event) => event.type === "invitation_confirmed" && event.sourceRef.actionExecutionId === invite.id,
        )?.occurredAt ??
        invite.settledAt ??
        invite.createdAt);
  const noteOpened = note !== null && (carried || noteDm !== undefined);
  // The note carried by LinkedIn has no DM of its own: the invitation's row
  // stands for it.
  const carriedNote = noteOpened && noteDm === undefined && invite !== undefined ? invite : null;
  const withApproval = carriedNote ? [...sent, carriedNote] : sent;
  const approved = new Set(
    withApproval.length === 0
      ? []
      : (
          await tx
            .select({ id: actionApprovals.actionExecutionId })
            .from(actionApprovals)
            .where(
              and(
                inArray(
                  actionApprovals.actionExecutionId,
                  withApproval.map((action) => action.id),
                ),
                isNotNull(actionApprovals.usedAt),
              ),
            )
        ).map((approval) => approval.id),
  );

  const superseded = new Set(
    events.flatMap((event) => (event.supersedesEventId === null ? [] : [event.supersedesEventId])),
  );
  const theirs = events.filter((event) => event.type === "inbound_message_observed" && !superseded.has(event.id));
  // A send's receipt is its ledger row's, as the conversation's timeline
  // reads it; the log's own record stands only where no row of the
  // conversation's is behind it.
  const ledgered = new Set(ledger.map((action) => action.id));
  const unledgered = events.filter(
    (event) =>
      event.type === "dm_confirmed" &&
      (event.sourceRef.actionExecutionId === undefined || !ledgered.has(event.sourceRef.actionExecutionId)),
  );
  const entries: DmEntry[] = [
    ...theirs.map(
      (event): DmEntry => ({
        kind: "theirs",
        key: `event:${event.id}`,
        at: event.occurredAt,
        text: event.content,
        intent: intentOf(event),
        held: false,
      }),
    ),
    ...sent.map(
      (action): DmEntry => ({
        kind: "ours",
        key: `action:${action.id}`,
        at:
          action === noteDm && noteSentAt !== null
            ? noteSentAt
            : action.status === "confirmed"
              ? (action.settledAt ?? action.createdAt)
              : (action.submittedAt ?? action.createdAt),
        actionId: action.id,
        text: action.candidate.text,
        owner: action.origin === "owner",
        approved: approved.has(action.id),
        status: action.status,
        ...(action.purpose === "invite_note" ? { note: true as const } : {}),
      }),
    ),
    ...(carriedNote && noteSentAt !== null
      ? [
          {
            kind: "ours",
            key: `note:${carriedNote.id}`,
            at: noteSentAt,
            actionId: carriedNote.id,
            text: note,
            owner: carriedNote.origin === "owner",
            approved: approved.has(carriedNote.id),
            status: "confirmed",
            note: true,
          } satisfies DmEntry,
        ]
      : []),
    ...unledgered.map(
      (event): DmEntry => ({
        kind: "ours",
        key: `event:${event.id}`,
        at: event.occurredAt,
        actionId: null,
        text: event.content,
        owner: false,
        approved: false,
        status: "confirmed",
      }),
    ),
    ...events
      .filter((event) => event.type === "owner_message_observed")
      .map(
        (event): DmEntry => ({
          kind: "ours",
          key: `event:${event.id}`,
          at: event.occurredAt,
          actionId: null,
          text: event.content,
          owner: true,
          approved: false,
          status: "confirmed",
          linkedIn: true,
        }),
      ),
  ];
  // Nothing reads a held conversation, so its newest message is no event:
  // the list's copy of it stands in, unless a read before the hold kept it.
  if (thread?.heldMessageText && thread.heldMessageAt !== null) {
    const text = thread.heldMessageText;
    if (!theirs.some((event) => event.content === text)) {
      entries.push({
        kind: "theirs",
        key: `held:${thread.id}`,
        at: thread.heldMessageAt,
        text,
        intent: null,
        held: true,
      });
    }
  }
  entries.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const pending = pendingInvite(events, ledger);

  return {
    thread: thread
      ? { url: dmTargetFor(thread, conversation.authorProfileId).urn!, ownerHeldAt: thread.ownerHeldAt }
      : null,
    entries,
    connectedBy: await connectedBy(tx, answered, noteOpened),
    inviteSentAt: pending?.at ?? null,
    ...(pending?.note ? { inviteNote: pending.note } : {}),
  };
}

/** One of our DMs whose outcome Engager is still reading: when it was
 *  pressed, and when the drain reads it next on its own. */
export type DmCheck = { actionId: number; at: number; nextReadAt: number };

/**
 * Our DMs and follow-ups on the conversation whose outcome Engager is still
 * reading, oldest first (`execution/reconcileReads.ts`): pressed, not read
 * back, and the reads not given up. None of them waits on the owner yet, and
 * nothing is pressed again for them before a read settles them.
 */
export async function dmsBeingChecked(tx: Tx, conversationId: number, now: number = Date.now()): Promise<DmCheck[]> {
  const open = await tx
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversationId),
        inArray(actions.kind, ["dm", "followup"]),
        eq(actions.status, "uncertain"),
      ),
    )
    .orderBy(asc(actions.submittedAt), asc(actions.id));
  return open.flatMap((action) => {
    const next = nextReconcileAt(action);
    return next !== null && !askOwner(action, now)
      ? [{ actionId: action.id, at: clickedAt(action), nextReadAt: next }]
      : [];
  });
}

/** The newest acceptance on the log and, for ours, the confirmed invite it
 *  answered: the newest one settled by then, else the newest. */
function acceptedInvite(
  events: readonly ConversationEventRow[],
  actions: readonly ActionRow[],
): { accepted: ConversationEventRow; invite: ActionRow | undefined } | null {
  const accepted = events.filter((event) => event.type === "invitation_accepted").at(-1);
  if (!accepted) return null;
  const invites = actions.filter((action) => action.kind === "invite" && action.status === "confirmed");
  const invite =
    invites.filter((action) => (action.settledAt ?? action.createdAt) <= accepted.occurredAt).at(-1) ??
    invites.at(-1);
  return { accepted, invite };
}

/** How the two came to be connected: the newest acceptance on the log, and,
 *  for theirs of our invite, the reply that invite answered — the confirmed
 *  invite it accepted, by the event its candidate cites. */
async function connectedBy(
  tx: Tx,
  answered: ReturnType<typeof acceptedInvite>,
  noteOpened: boolean,
): Promise<PersonMessaging["connectedBy"]> {
  if (!answered) return null;
  const { accepted, invite } = answered;
  if (accepted.sourceRef.invitationId !== undefined) return { kind: "accepted_theirs", at: accepted.occurredAt };
  const cited = invite?.candidate.sources[0]?.eventId;
  const [source] =
    cited === undefined
      ? []
      : await tx
          .select({ sourceRef: conversationEvents.sourceRef })
          .from(conversationEvents)
          .where(eq(conversationEvents.id, cited));
  return {
    kind: "accepted_ours",
    at: accepted.occurredAt,
    incomingCommentId: source?.sourceRef.incomingCommentId ?? null,
    ...(noteOpened ? { noteOpened: true as const } : {}),
  };
}

/** Our newest invite, while nothing has answered it — their acceptance, our
 *  withdrawal, or LinkedIn no longer listing it: when it went, and the note
 *  it carries. */
function pendingInvite(
  events: readonly ConversationEventRow[],
  actions: readonly ActionRow[],
): { at: number; note: string | null } | null {
  const sent = events.filter((event) => event.type === "invitation_confirmed").at(-1);
  if (!sent) return null;
  const answered = events.some(
    (event) => (INVITATION_ANSWERS as readonly string[]).includes(event.type) && event.id > sent.id,
  );
  if (answered) return null;
  const invite = actions.find((action) => action.kind === "invite" && action.id === sent.sourceRef.actionExecutionId);
  return { at: sent.occurredAt, note: invite ? noteOf(invite) : null };
}
