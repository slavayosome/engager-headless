import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  actions,
  authorProfiles,
  dmThreads,
  incomingComments,
  conversationEvents,
  conversations,
  pauseControls,
  type DmThreadBinding,
  type DmThreadRow,
  type IncomingReading,
  type ConversationEventRow,
  type ConversationRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ActionLedgerError } from "../actions/errors";
import { takeOverConversation } from "../actions/takeover";
import { leadOf } from "../ai/reading";
import { foldLeadWords } from "../leads/words";
import { followLifecycle } from "../leads/lifecycle";
import {
  dmWordsHash,
  type DmMessage,
  type DmParticipant,
  type DmThreadRead,
  type InboxThread,
  type KnownMember,
} from "../linkedin/driver";
import type { ClassifiedMessage } from "./classify";
import { projectLeadStatus } from "./leads";
import { conversationPolicy } from "./policy";
import { hastenInvitationWatch, personConversationOn, recordInboundMessage, recordOwnerMessage } from "./record";
import { deriveStage } from "./state";

const DAY = 86_400_000;

/**
 * A CONVERSATION'S DIRECT MESSAGES (spec §10 R05 "Inbound DM", §11
 * `InboundMessageObserved`, §15 R11 one canonical thread, §16 "human types or
 * sends", §17 R13 "verify exact participants … and no human draft").
 *
 * A conversation is bound to a conversation only on a read of the conversation
 * itself showing exactly two people — the account and one other, named by
 * profile id — where that id is a conversation's person on the same account. A
 * name never binds one (INV-30), a group never does, and a conversation whose
 * other person cannot be verified stays the owner's. LinkedIn's conversation
 * data names a member by member urn alone; the thread keeps the urn beside
 * the profile id a page read of the same conversation showed with it
 * ({@link withListedMember}), so a later read by urn is the same person — and
 * one by another urn is someone else. The live page links everyone by member
 * id, as that data does: someone it names by member urn alone is the profile
 * Engager knows the urn by ({@link namedByProfile}), or no one a conversation is
 * keyed by. Once bound, each message the person sends is one event on their
 * conversation; what the owner writes — sent, or still sitting in the composer —
 * hands them the conversation: a takeover (`actions/takeover.ts`) no worker
 * passes until they release it. Nothing here sends, and DM content never
 * touches `messages` or `incoming_comments`.
 *
 * A conversation the owner has with someone Engager knows — by the member
 * urn their reply under our comment carried, a read of another conversation
 * learnt, or a read of their own profile verified — is the owner's, unless
 * the campaign reached them past the public thread first
 * ({@link holdOwnersConversation}). The inbox list binds it to their conversation
 * and holds the conversation — not the person — for the owner, on the list's
 * word alone: no model reads it, nothing wakes for it, no worker's DM goes
 * into it, and the person's newest message there is kept for the owner to
 * see. The owner's own DM goes in on their press, the conversation read for
 * that send alone (`actions/dm.ts`), and the owner may hand it back
 * ({@link releaseOwnerHeldThread}). Their conversation and the public thread under
 * our comments go on as before.
 */

export type ThreadBinding =
  | { kind: "bound"; conversation: ConversationRow }
  | { kind: "group" }
  /** `identity_unknown`: no other person is named by profile id, or by a
   *  member urn the thread knows the profile of; `identity_unverified`: a
   *  message comes from someone the read does not name, or the person is
   *  named by another member urn than the thread's; `no_conversation`: the person
   *  has none on this account; `conversation_has_thread`: their conversation is bound
   *  to another conversation already. */
  | {
      kind: "unmatched";
      reason: "identity_unknown" | "identity_unverified" | "no_conversation" | "conversation_has_thread";
    };

/** Whether two people in a conversation are one: by member urn — LinkedIn's
 *  own identity for a member — where both carry one, else by profile id. A
 *  person named by neither matches no one. */
export function samePerson(
  a: Pick<DmParticipant, "profileId" | "memberUrn">,
  b: Pick<DmParticipant, "profileId" | "memberUrn">,
): boolean {
  if (a.memberUrn !== undefined && b.memberUrn !== undefined) return a.memberUrn === b.memberUrn;
  return a.profileId !== null && a.profileId === b.profileId;
}

/** Whether a profile id is only a member urn's own id again — what a read of
 *  a page that links the member by member id once kept in a profile's
 *  place. It names no public profile. */
function memberIdAgain(profileId: string, memberUrn: string): boolean {
  return profileId.toLowerCase() === memberUrn.slice(memberUrn.lastIndexOf(":") + 1).toLowerCase();
}

/** Whose profile each member urn in a thread is, as its reads learnt it. */
export function knownMembers(participants: DmThreadRow["participants"] | undefined): KnownMember[] {
  return (participants ?? []).flatMap((participant) =>
    !participant.isSelf &&
    participant.memberUrn !== undefined &&
    participant.profileId !== null &&
    !memberIdAgain(participant.profileId, participant.memberUrn)
      ? [{ memberUrn: participant.memberUrn, profileId: participant.profileId }]
      : [],
  );
}

/**
 * A read whose people its page linked by member id alone — a member urn and
 * no profile, as the live page links everyone (`messaging.py`) — each named
 * by the profile Engager knows that urn by ({@link knownMemberProfiles}),
 * and their messages theirs by it too. Someone by an urn Engager knows no
 * profile for is left as read: named by nothing a conversation is keyed by, they
 * bind no conversation.
 */
async function namedByProfile(tx: Tx, channelId: number, read: DmThreadRead): Promise<DmThreadRead> {
  const urns = read.participants.flatMap((participant) =>
    participant.profileId === null && participant.memberUrn !== undefined ? [participant.memberUrn] : [],
  );
  const profiles = await knownMemberProfiles(tx, channelId, urns);
  if (profiles.size === 0) return read;
  return {
    ...read,
    participants: read.participants.map((participant) => {
      const profileId =
        participant.profileId === null && participant.memberUrn !== undefined
          ? profiles.get(participant.memberUrn)
          : undefined;
      return profileId === undefined
        ? participant
        : { ...participant, profileId, profileUrl: `https://www.linkedin.com/in/${profileId}/` };
    }),
    messages: read.messages.map((message) => {
      const profileId = message.fromSelf ? undefined : profiles.get(message.authorProfileId);
      return profileId === undefined ? message : { ...message, authorProfileId: profileId };
    }),
  };
}

/**
 * A page read of a conversation, its one other person given the member urn
 * the inbox list names them by: the page links them by profile, LinkedIn's
 * data by urn, and in one conversation that each shows exactly one other
 * person in, the two are that person. Anything else is left as it was read.
 */
export function withListedMember(read: DmThreadRead, listed: InboxThread): DmThreadRead {
  const others = read.participants.filter((participant) => !participant.isSelf);
  const [named] = listed.participants;
  if (
    read.group ||
    listed.group ||
    listed.threadId !== read.threadId ||
    others.length !== 1 ||
    listed.participants.length !== 1 ||
    named!.memberUrn === undefined ||
    others[0]!.profileId === null ||
    others[0]!.memberUrn !== undefined
  ) {
    return read;
  }
  return {
    ...read,
    participants: read.participants.map((participant) =>
      participant === others[0] ? { ...participant, memberUrn: named!.memberUrn } : participant,
    ),
  };
}

/** The one other person a thread's last read showed, if it showed one. */
function soleOther(participants: DmThreadRow["participants"] | undefined): DmParticipant | null {
  const others = (participants ?? []).filter((participant) => !participant.isSelf);
  return others.length === 1 ? others[0]! : null;
}

/** A read's participants, each keeping the member urn an earlier read of the
 *  thread learnt for the same profile: a page links people by profile alone. */
function withKnownMembers(
  participants: DmThreadRead["participants"],
  known: DmThreadRow["participants"] | undefined,
): DmThreadRead["participants"] {
  const learnt = knownMembers(known);
  return participants.map((participant) => {
    if (participant.isSelf || participant.memberUrn !== undefined || participant.profileId === null) {
      return participant;
    }
    const urn = learnt.find((member) => member.profileId === participant.profileId)?.memberUrn;
    return urn === undefined ? participant : { ...participant, memberUrn: urn };
  });
}

/**
 * Which conversation a conversation read belongs to, if any, with that conversation
 * locked for the transaction. Exactly one other participant, named by profile
 * id — or by the member urn the thread already knows the profile of — and by
 * no other member urn than the thread's, every message written by them or
 * the account, and their conversation on this account — open, else the latest
 * closed, so a person who opted out is still the person who opted out.
 */
export async function bindingOf(
  tx: Tx,
  channelId: number,
  read: DmThreadRead,
  thread: DmThreadRow | undefined,
): Promise<ThreadBinding> {
  if (read.group || read.participants.length > 2) return { kind: "group" };
  const others = read.participants.filter((participant) => !participant.isSelf);
  const other = others.length === 1 ? others[0]! : null;
  const before = soleOther(thread?.participants);
  if (other?.memberUrn !== undefined && before?.memberUrn !== undefined && other.memberUrn !== before.memberUrn) {
    return { kind: "unmatched", reason: "identity_unverified" };
  }
  // Named by the thread's own member urn alone, the person is the thread's.
  const sameMember = other?.memberUrn !== undefined && other.memberUrn === before?.memberUrn;
  const person = other?.profileId ?? (sameMember ? before!.profileId : null);
  if (person === null) return { kind: "unmatched", reason: "identity_unknown" };
  const author = other?.profileId ?? person;
  if (read.messages.some((message) => !message.fromSelf && message.authorProfileId !== author)) {
    return { kind: "unmatched", reason: "identity_unverified" };
  }
  const conversation = await personConversationOn(tx, channelId, person);
  if (!conversation) return { kind: "unmatched", reason: "no_conversation" };
  if (conversation.canonicalDmThreadId !== null && conversation.canonicalDmThreadId !== thread?.id) {
    return { kind: "unmatched", reason: "conversation_has_thread" };
  }
  return { kind: "bound", conversation };
}

/**
 * The messages of a read that the last read of the thread's page had not
 * shown: the ones after `anchor` — the newest message that read showed — in
 * thread order. With no earlier page read, or one whose newest message this
 * read no longer shows, every message is new — the direction that hands a
 * conversation to a person rather than missing one they are already in. Pure.
 */
export function messagesSince(messages: readonly DmMessage[], anchor: string | null): DmMessage[] {
  const at = anchor === null ? -1 : messages.findIndex((message) => message.messageId === anchor);
  return messages.slice(at + 1);
}

/**
 * Since when a message the account sends in the conversation is one Engager
 * has not answered for: the later of Engager's own last DM in it and the
 * owner's last hand-back of it (`update_person`). Null where there is
 * neither — then only where the last history read stopped says what is new.
 */
export async function ownerWritesSince(tx: Tx, conversationId: number): Promise<number | null> {
  const [sent] = await tx
    .select({ at: sql<string | number | null>`max(${conversationEvents.occurredAt})` })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, "dm_confirmed")));
  const [released] = await tx
    .select({ at: sql<string | number | null>`max(${pauseControls.resumedAt})` })
    .from(pauseControls)
    .where(
      and(
        eq(pauseControls.scope, "conversation"),
        eq(pauseControls.scopeId, conversationId),
        eq(pauseControls.reason, "takeover"),
      ),
    );
  // `max` of a bigint comes back as text, and as null over no rows.
  const times = [sent?.at, released?.at].flatMap((at) => (at == null ? [] : [Number(at)]));
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Which of these messages are Engager's own DMs on the conversation: a send whose
 * confirmation named the message, or one in flight or confirmed carrying
 * exactly its words (an uncertain send that landed, read before it settled),
 * or the note of an invitation of ours that went out, which LinkedIn may have
 * carried into the conversation when they accepted (`actions/inviteNote.ts`).
 * Every other message the account sent is the owner's.
 */
export async function engagerSent(
  tx: Tx,
  conversationId: number,
  messages: readonly Pick<DmMessage, "messageId" | "fromSelf" | "textHash">[],
): Promise<Set<string>> {
  const sent = messages.filter((message) => message.fromSelf);
  if (sent.length === 0) return new Set();
  const rows = await tx
    .select({ candidate: actions.candidate, receipt: actions.externalReceipt })
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversationId),
        inArray(actions.kind, ["dm", "followup"]),
        inArray(actions.status, ["dispatching", "uncertain", "confirmed"]),
      ),
    );
  const invites = await tx
    .select({ candidate: actions.candidate })
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversationId),
        eq(actions.kind, "invite"),
        eq(actions.status, "confirmed"),
      ),
    );
  const ids = new Set<string>();
  const words = new Set<string>();
  for (const row of rows) {
    const confirmed = (row.receipt?.message as { messageId?: unknown } | undefined)?.messageId;
    if (typeof confirmed === "string") ids.add(confirmed);
    if (row.candidate.text) words.add(dmWordsHash(row.candidate.text));
  }
  for (const invite of invites) {
    if (invite.candidate.text) words.add(dmWordsHash(invite.candidate.text));
  }
  return new Set(
    sent
      .filter((message) => ids.has(message.messageId) || words.has(message.textHash))
      .map((message) => message.messageId),
  );
}

/**
 * Whether words in a conversation's composer are a prepare of ours that no
 * Send took: a DM or follow-up on the conversation that reached the browser
 * carrying exactly them. A commit refused before the press, or a send that
 * never went, leaves them there — Engager's words, never the owner's draft.
 */
export async function engagerTyped(tx: Tx, conversationId: number, draftHash: string): Promise<boolean> {
  const rows = await tx
    .select({ candidate: actions.candidate })
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversationId),
        inArray(actions.kind, ["dm", "followup"]),
        sql`jsonb_array_length(${actions.attempts}) > 0`,
      ),
    );
  return rows.some((row) => row.candidate.text != null && dmWordsHash(row.candidate.text) === draftHash);
}

/**
 * The person's messages in a read that their conversation has not recorded — what
 * the caller classifies, with no transaction open, before it records the
 * read. Empty for a DM thread no conversation binds: an unbound thread's words
 * never reach a model.
 */
export async function unrecordedInbound(
  tx: Tx,
  channelId: number,
  observed: DmThreadRead,
): Promise<DmMessage[]> {
  const read = await namedByProfile(tx, channelId, observed);
  const [row] = await tx
    .select()
    .from(dmThreads)
    .where(
      and(eq(dmThreads.channelId, channelId), eq(dmThreads.providerThreadId, read.threadId)),
    );
  const binding = await bindingOf(tx, channelId, read, row);
  if (binding.kind !== "bound") return [];
  const inbound = read.messages.filter((message) => !message.fromSelf);
  if (inbound.length === 0) return [];
  const recorded = await tx
    .select({ id: conversationEvents.providerEventId, reading: conversationEvents.reading, decision: conversationEvents.decision })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, binding.conversation.id),
        inArray(
          conversationEvents.providerEventId,
          inbound.map((message) => message.messageId),
        ),
      ),
    );
  const seen = new Set(recorded.filter((event) => !event.reading || (event.decision as { label?: unknown } | null)?.label != null).map((event) => event.id));
  return inbound.filter((message) => !seen.has(message.messageId));
}

export type RecordedThread = {
  thread: DmThreadRow;
  binding: ThreadBinding;
  /** The conversation after the read, when the thread is bound to one. */
  conversation: ConversationRow | null;
  /** The person's messages this read recorded, oldest first. */
  recorded: ConversationEventRow[];
  /** Why the owner was handed the conversation by this read, if they were. */
  takeover: "draft" | "sent" | null;
};

/**
 * Write what one read of a conversation found, in one transaction: the
 * thread's row and binding, each message the person sent that their conversation
 * has not recorded (classified where `classified` has it, else recorded
 * unclassified, which is review), each the owner wrote there on LinkedIn
 * (`recordOwnerMessage`), and the takeover when the owner has written
 * in it — a message the account sent that is not one of Engager's own DMs
 * ({@link engagerSent}) and that no read of the conversation's history had
 * shown, or that is dated after Engager's own last DM in it or the owner's
 * last hand-back ({@link ownerWritesSince}); or words in the composer that
 * are neither the draft the last takeover saw nor a prepare of ours
 * ({@link engagerTyped}). A read the inbox list's last message stands for
 * moves the tail a DM is written after (`lastMessageId`), never where the
 * last history read stopped (`lastHistoryMessageId`): what the owner sent
 * before that message only the history shows.
 *
 * A thread that stops verifying as the conversation's — it became a group, or
 * names someone else — is unbound, and the conversation loses it as its canonical
 * thread; nothing in that read is recorded. A read that names its person by
 * nothing a conversation is keyed by (`identity_unknown`) contradicts no one: a
 * bound thread stays bound, and nothing in that read is recorded either.
 *
 * A message the person sent that the read recorded, where an invitation of
 * ours to them is still outstanding, brings its watch's read forward
 * ({@link hastenInvitationWatch}): it is how their acceptance shows first.
 */
export async function recordThreadRead(
  tx: Tx,
  input: {
    channelId: number;
    read: DmThreadRead;
    /** The inbox card the read was made for, as last seen. */
    inboxDigest: string | null;
    classified: ReadonlyMap<string, ClassifiedMessage | null>;
    /** The reading of each message's words, for the buying intent that builds
     *  the lead of the person who sent them; a message with none is not
     *  folded. */
    leadWords?: ReadonlyMap<string, IncomingReading>;
    now: number;
    /** The read is the inbox list's last message standing for the
     *  conversation's (`conversations/inbox.ts`): nothing opened its page, so the
     *  last read of the page stays the one it was. */
    listed?: boolean;
  },
): Promise<RecordedThread> {
  const { channelId, now } = input;
  const read = await namedByProfile(tx, channelId, input.read);
  const [existing] = await tx
    .select()
    .from(dmThreads)
    .where(
      and(eq(dmThreads.channelId, channelId), eq(dmThreads.providerThreadId, read.threadId)),
    )
    .for("update");
  const binding = await bindingOf(tx, channelId, read, existing);
  if (binding.kind === "unmatched" && binding.reason === "identity_unknown" && existing?.binding === "bound") {
    return { thread: existing, binding, conversation: null, recorded: [], takeover: null };
  }
  const boundTo = binding.kind === "bound" ? binding.conversation.id : null;
  if (existing?.conversationId != null && existing.conversationId !== boundTo) {
    await releaseCanonical(tx, existing.conversationId, existing.id, now);
  }

  const newest = read.messages.at(-1)?.messageId;
  const values = {
    binding: binding.kind satisfies DmThreadBinding,
    conversationId: boundTo,
    participants: withKnownMembers(read.participants, existing?.participants),
    ...(input.inboxDigest !== null ? { lastInboxDigest: input.inboxDigest } : {}),
    lastMessageId: newest ?? existing?.lastMessageId ?? null,
    lastObservedAt: read.observedAt,
    ...(input.listed
      ? {}
      : {
          lastHistoryMessageId: newest ?? existing?.lastHistoryMessageId ?? null,
          lastThreadReadAt: read.observedAt,
        }),
    updatedAt: now,
  };
  if (binding.kind !== "bound") {
    const thread = await upsertThread(tx, channelId, read.threadId, existing, {
      ...values,
      humanDraftSeenAt: null,
      humanDraftHash: null,
    });
    return { thread, binding, conversation: null, recorded: [], takeover: null };
  }

  const typed = read.composer.hasDraft ? read.composer.draftHash : null;
  const draft = typed !== null && !(await engagerTyped(tx, binding.conversation.id, typed)) ? typed : null;
  const freshDraft = draft !== null && draft !== existing?.humanDraftHash;
  const thread = await upsertThread(tx, channelId, read.threadId, existing, {
    ...values,
    humanDraftSeenAt: draft === null ? null : freshDraft ? now : (existing?.humanDraftSeenAt ?? now),
    humanDraftHash: draft,
  });
  let conversation = binding.conversation;
  if (conversation.canonicalDmThreadId !== thread.id) {
    conversation = await setCanonical(tx, conversation, thread.id, now);
  }

  const recorded: ConversationEventRow[] = [];
  const sender = soleOther(read.participants)?.displayName ?? null;
  for (const message of read.messages) {
    if (message.fromSelf) continue;
    const result = await recordInboundMessage(tx, {
      conversation,
      thread: { id: thread.id, channelId, providerThreadId: read.threadId },
      message,
      classified: input.classified.get(message.messageId) ?? null,
      reader: read.reader,
      now,
    });
    const storedWords = input.leadWords?.get(message.messageId);
    if (storedWords && !input.classified.get(message.messageId)) {
      await tx.update(conversationEvents).set({ reading: storedWords })
        .where(and(eq(conversationEvents.id, result.event.id), sql`${conversationEvents.reading} is null`));
    }
    conversation = result.conversation;
    if (!result.recorded) continue;
    recorded.push(result.event);
    const words = input.leadWords?.get(message.messageId);
    if (words) {
      const { authorProfileId: profileId, owningCampaignId: campaignId } = conversation;
      await followLifecycle(tx, "foldLeadWords", (savepoint) =>
        foldLeadWords(savepoint, {
          profileId,
          name: sender,
          campaignId,
          kind: "message",
          verdict: leadOf(words),
          at: message.sentAt ?? message.observedAt,
        }),
      );
    }
  }
  if (recorded.length > 0) await hastenInvitationWatch(tx, conversation, now);
  // What the owner wrote on LinkedIn themselves, for their Messages.
  const engagers = await engagerSent(tx, conversation.id, read.messages);
  for (const message of read.messages) {
    if (!message.fromSelf || engagers.has(message.messageId)) continue;
    await recordOwnerMessage(tx, {
      conversation,
      thread: { id: thread.id, channelId, providerThreadId: read.threadId },
      message,
      now,
    });
  }

  // What the owner may have written unseen: every message after where the
  // last history read stopped — and, where Engager has sent in it or the
  // owner handed it back, every one dated after that, wherever it sits.
  const after = await ownerWritesSince(tx, conversation.id);
  const unseen = new Set(messagesSince(read.messages, existing?.lastHistoryMessageId ?? null));
  const since = read.messages.filter(
    (message) => unseen.has(message) || (after !== null && message.sentAt !== null && message.sentAt > after),
  );
  const ours = await engagerSent(tx, conversation.id, since);
  const sent = since.some((message) => message.fromSelf && !ours.has(message.messageId));
  // A closed conversation stays closed, and one the owner already holds is
  // theirs: neither is taken over again.
  const takeover =
    conversation.closedReason !== null || conversation.opsStatus === "human_owned"
      ? null
      : freshDraft
        ? "draft"
        : sent
          ? "sent"
          : null;
  if (takeover) {
    await takeOverConversation(tx, {
      conversationId: conversation.id,
      by: `observed:dm_${takeover}`,
      now,
    });
    const [held] = await tx.select().from(conversations).where(eq(conversations.id, conversation.id));
    conversation = held!;
  }
  await projectLeadStatus(tx, conversation.authorProfileId, now);
  return { thread, binding, conversation, recorded, takeover };
}

/**
 * Keep a conversation the inbox showed beside a conversation's person without
 * reading it: a group, which is never handled. Its card is all that is kept.
 */
export async function recordGroupCard(
  tx: Tx,
  input: {
    channelId: number;
    threadId: string;
    participants: DmThreadRow["participants"];
    inboxDigest: string;
    observedAt: number;
    now: number;
  },
): Promise<DmThreadRow> {
  const [existing] = await tx
    .select()
    .from(dmThreads)
    .where(
      and(
        eq(dmThreads.channelId, input.channelId),
        eq(dmThreads.providerThreadId, input.threadId),
      ),
    )
    .for("update");
  if (existing?.conversationId != null) {
    await releaseCanonical(tx, existing.conversationId, existing.id, input.now);
  }
  return upsertThread(tx, input.channelId, input.threadId, existing, {
    binding: "group",
    conversationId: null,
    participants: input.participants,
    lastInboxDigest: input.inboxDigest,
    lastObservedAt: input.observedAt,
    humanDraftSeenAt: null,
    humanDraftHash: null,
    updatedAt: input.now,
  });
}

/** What the list says of a conversation beyond its card, which every list
 *  read keeps on the conversation's row. */
export function listedState(listed: InboxThread): Pick<DmThreadRow, "unreadCount" | "lastMessageAt"> {
  return { unreadCount: listed.unreadCount ?? null, lastMessageAt: listed.lastMessage.at };
}

/** The member urn of the one other person in a conversation the list shows,
 *  where it is one member's with the account: a group has several, and a
 *  company page is named by no member urn. */
export function soleMemberUrn(listed: InboxThread): string | null {
  const [other] = listed.participants;
  return !listed.group && listed.participants.length === 1 ? (other!.memberUrn ?? null) : null;
}

/**
 * Whose profile each of these member urns is, as Engager knows: a reply
 * under one of our comments that carried the urn beside its author's profile,
 * a read of one of the account's conversations that showed the two together,
 * or a read of the person's own profile that verified both — as the people
 * directory reads them (`memberProfilesSql`). A conversation's member id kept
 * as if it were a profile ({@link memberIdAgain}) is no profile, and an urn
 * known as two profiles is no one's.
 */
export async function knownMemberProfiles(
  tx: Tx,
  channelId: number,
  urns: readonly string[],
): Promise<Map<string, string>> {
  if (urns.length === 0) return new Map();
  const listed = sql.join(urns.map((urn) => sql`${urn}`), sql`, `);
  const replied = await tx
    .selectDistinct({ urn: incomingComments.authorMemberUrn, profileId: incomingComments.authorProfileId })
    .from(incomingComments)
    .where(
      and(inArray(incomingComments.authorMemberUrn, [...urns]), isNotNull(incomingComments.authorProfileId)),
    );
  const read = await tx.execute(sql`
    select distinct person->>'memberUrn' as urn, person->>'profileId' as "profileId"
    from ${dmThreads}, jsonb_array_elements(${dmThreads.participants}) as person
    where ${dmThreads.channelId} = ${channelId}
      and person->>'memberUrn' in (${listed})
      and person->>'profileId' is not null
      and person->>'profileId' <> lower(split_part(person->>'memberUrn', ':', 4))
      and person->>'isSelf' = 'false'`);
  const evidence = authorProfiles.identityEvidence;
  const profiled = await tx
    .select({ urn: sql<string>`${evidence}->'read'->>'profileUrn'`, profileId: authorProfiles.profileId })
    .from(authorProfiles)
    .where(
      and(
        sql`${evidence}->'read'->'profile'->>'verified' = 'true'`,
        sql`${evidence}->'read'->'profile'->>'id' = ${authorProfiles.profileId}`,
        sql`${evidence}->'read'->>'profileUrn' in (${listed})`,
      ),
    );
  const profiles = new Map<string, Set<string>>();
  const rows = [...replied, ...(read.rows as Array<{ urn: string; profileId: string }>), ...profiled];
  for (const { urn, profileId } of rows) {
    if (urn === null || profileId === null) continue;
    profiles.set(urn, (profiles.get(urn) ?? new Set()).add(profileId));
  }
  return new Map([...profiles].flatMap(([urn, ids]) => (ids.size === 1 ? [[urn, [...ids][0]!] as const] : [])));
}

/**
 * Whether the campaign reached the person past the public thread before:
 * an invitation of ours, one between them and the account it saw accepted, or
 * a DM of ours. A conversation with them may then be one it started, which a
 * read verifies as it would any.
 */
async function campaignReached(tx: Tx, conversationId: number): Promise<boolean> {
  const [reached] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ["invitation_confirmed", "invitation_accepted", "dm_confirmed"]),
      ),
    )
    .limit(1);
  return reached !== undefined;
}

export type OwnersConversation =
  /** Bound to the person's conversation and held for the owner; `recorded` says
   *  whether the person's newest message there was new to it. */
  | { kind: "held"; thread: DmThreadRow; recorded: boolean }
  /** Left alone: their conversation is closed, or keeps another conversation. */
  | { kind: "left" }
  /** Not held: they have no conversation here, or the campaign may have started
   *  the conversation — a read decides it, as for anyone. */
  | { kind: "read" };

/**
 * Hold a one-to-one conversation the inbox list shows for the owner, where
 * its other person is someone Engager knows (`profileId`, from their member
 * urn: {@link knownMemberProfiles}) and nothing of the campaign's reached
 * them past the public thread ({@link campaignReached}): a conversation the
 * owner has with a person who answered them. It is bound to the person's
 * conversation on the list's word alone — no read of it — and the conversation
 * itself held for the owner (`owner_held_at`): no model reads it, and every
 * DM door refuses it a worker's words (`owner_held`). The person's conversation
 * is not touched: the public thread under our comments — its replies, its
 * likes, the drafts waiting on them — goes on as before.
 *
 * The person's newest message there, as the list shows it, is kept on the
 * conversation for the owner to see ({@link heldMessage}) — never as an event
 * on their conversation, so nothing wakes for it and no step is handed it.
 *
 * A conversation already bound keeps its binding: the caller holds only one
 * with no row or an unmatched one.
 */
export async function holdOwnersConversation(
  tx: Tx,
  input: {
    channelId: number;
    listed: InboxThread;
    profileId: string;
    inboxDigest: string;
    observedAt: number;
    now: number;
  },
): Promise<OwnersConversation> {
  const { channelId, listed, now } = input;
  const [existing] = await tx
    .select()
    .from(dmThreads)
    .where(and(eq(dmThreads.channelId, channelId), eq(dmThreads.providerThreadId, listed.threadId)))
    .for("update");
  const [person] = listed.participants;
  if ((existing && existing.binding !== "unmatched") || soleMemberUrn(listed) === null) return { kind: "read" };
  const conversation = await personConversationOn(tx, channelId, input.profileId);
  if (!conversation) return { kind: "read" };
  if (conversation.closedReason !== null || conversation.canonicalDmThreadId !== null) return { kind: "left" };
  if (await campaignReached(tx, conversation.id)) return { kind: "read" };

  const message = heldMessage(listed, conversation.authorProfileId);
  const thread = await upsertThread(tx, channelId, listed.threadId, existing, {
    binding: "bound",
    conversationId: conversation.id,
    participants: [{ ...person!, profileId: conversation.authorProfileId, isSelf: false }],
    lastInboxDigest: input.inboxDigest,
    lastMessageId: listed.lastMessage.messageId ?? existing?.lastMessageId ?? null,
    lastObservedAt: input.observedAt,
    ...listedState(listed),
    humanDraftSeenAt: null,
    humanDraftHash: null,
    ownerHeldAt: now,
    ...message,
    updatedAt: now,
  });
  await setCanonical(tx, conversation, thread.id, now);
  await projectLeadStatus(tx, conversation.authorProfileId, now);
  return { kind: "held", thread, recorded: message !== null };
}

/**
 * The owner hands back a conversation held for them (Hand back to Engager):
 * from the next read it is bound to the person's conversation as any read binds
 * one, under the campaign's DM mode. What is in it now is the owner's past:
 * the next read starts after the message the list last showed there
 * (`last_history_message_id`), so only what the account sends after the
 * hand-back is unseen, and hands it to them again as in any bound
 * conversation. Its card is forgotten, so the next inbox read reads it —
 * their newest message among what it records — rather than waiting for the
 * conversation to move. The hand-back goes on the conversation's log. Refused for
 * a conversation not held for the owner, and on a closed conversation.
 */
export async function releaseOwnerHeldThread(
  tx: Tx,
  input: { conversationId: number; by: string; now?: number },
): Promise<DmThreadRow> {
  const now = input.now ?? Date.now();
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).for("update");
  if (!conversation) {
    throw new ActionLedgerError(
      "conversation_not_found",
      `Conversation ${input.conversationId} not found in this organization.`,
      "Open the person from the Inbox.",
    );
  }
  if (conversation.closedReason !== null) {
    throw new ActionLedgerError(
      "conversation_closed",
      `Conversation ${conversation.id} is closed (${conversation.closedReason}); nothing is handed back on it.`,
      "A closed conversation stays closed.",
    );
  }
  const [thread] =
    conversation.canonicalDmThreadId === null
      ? []
      : await tx
          .select()
          .from(dmThreads)
          .where(and(eq(dmThreads.id, conversation.canonicalDmThreadId), eq(dmThreads.conversationId, conversation.id)))
          .for("update");
  if (!thread || thread.ownerHeldAt === null) {
    throw new ActionLedgerError(
      "conversation_not_taken_over",
      `No conversation with this person is held for you on conversation ${conversation.id}.`,
      "Nothing to hand back.",
    );
  }
  const [released] = await tx
    .update(dmThreads)
    .set({
      ownerHeldAt: null,
      lastHistoryMessageId: thread.lastMessageId,
      lastInboxDigest: null,
      updatedAt: now,
    })
    .where(eq(dmThreads.id, thread.id))
    .returning();
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  await tx.insert(conversationEvents).values({
    conversationId: conversation.id,
    type: "dm_handed_back",
    source: "owner",
    sourceRef: { dmThreadId: thread.id, threadId: thread.providerThreadId },
    digest: createHash("sha256")
      .update(JSON.stringify(["dm_handed_back", thread.id, now]), "utf8")
      .digest("hex"),
    occurredAt: now,
    observedAt: now,
    attribution: { method: "owner", profileId: conversation.authorProfileId },
    decision: { by: input.by },
    retentionClass: "audit",
    expiresAt: now + policy.retention.audit_days * DAY,
    createdAt: now,
  });
  return released!;
}

/**
 * The list moved a conversation held for the owner
 * ({@link holdOwnersConversation}): its card and the person's newest message
 * are kept, and nothing reads it. A list naming another member in it than the
 * one it was held with moves its card alone. Whether the person's message was
 * new to it.
 */
export async function recordHeldCard(
  tx: Tx,
  input: { thread: DmThreadRow; listed: InboxThread; inboxDigest: string; observedAt: number; now: number },
): Promise<boolean> {
  const { thread, listed } = input;
  const person = soleOther(thread.participants);
  const [other] = listed.participants;
  const same = other?.memberUrn === undefined || other.memberUrn === person?.memberUrn;
  const message =
    same && person?.profileId != null && listed.lastMessage.messageId !== thread.lastMessageId
      ? heldMessage(listed, person.profileId)
      : null;
  await tx
    .update(dmThreads)
    .set({
      lastInboxDigest: input.inboxDigest,
      lastMessageId: listed.lastMessage.messageId ?? thread.lastMessageId,
      lastObservedAt: input.observedAt,
      ...listedState(listed),
      ...message,
      updatedAt: input.now,
    })
    .where(eq(dmThreads.id, thread.id));
  return message !== null;
}

/**
 * The person's newest message in a held conversation, where the list's last
 * message is it and the list carries its words: kept for the owner to see,
 * read by nothing else. Null where the account wrote last, or the list names
 * another sender.
 */
function heldMessage(
  listed: InboxThread,
  personId: string,
): Pick<DmThreadRow, "heldMessageText" | "heldMessageAt"> | null {
  const { fromSelf, text, at, authorProfileId } = listed.lastMessage;
  if (fromSelf || text === undefined || (authorProfileId != null && authorProfileId !== personId)) return null;
  return { heldMessageText: text, heldMessageAt: at };
}

async function upsertThread(
  tx: Tx,
  channelId: number,
  providerThreadId: string,
  existing: DmThreadRow | undefined,
  values: Partial<typeof dmThreads.$inferInsert> &
    Pick<typeof dmThreads.$inferInsert, "binding" | "participants" | "lastObservedAt">,
): Promise<DmThreadRow> {
  if (existing) {
    const [updated] = await tx
      .update(dmThreads)
      .set(values)
      .where(eq(dmThreads.id, existing.id))
      .returning();
    return updated!;
  }
  const [inserted] = await tx
    .insert(dmThreads)
    .values({ channelId, providerThreadId, createdAt: values.updatedAt, ...values })
    .returning();
  return inserted!;
}

/** Name the thread as the conversation's canonical one, and summarize again. */
async function setCanonical(
  tx: Tx,
  conversation: ConversationRow,
  threadId: number,
  now: number,
): Promise<ConversationRow> {
  const [updated] = await tx
    .update(conversations)
    .set({
      canonicalDmThreadId: threadId,
      derivedStage: deriveStage({ ...conversation, canonicalDmThreadId: threadId }),
      updatedAt: now,
    })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return updated!;
}

/** The conversation loses the thread as its canonical one, where it still has it. */
async function releaseCanonical(
  tx: Tx,
  conversationId: number,
  threadId: number,
  now: number,
): Promise<void> {
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.canonicalDmThreadId, threadId)))
    .for("update");
  if (!conversation) return;
  await tx
    .update(conversations)
    .set({
      canonicalDmThreadId: null,
      derivedStage: deriveStage({ ...conversation, canonicalDmThreadId: null }),
      updatedAt: now,
    })
    .where(eq(conversations.id, conversation.id));
}
