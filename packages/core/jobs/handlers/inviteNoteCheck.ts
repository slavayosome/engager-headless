import { conversationPayload } from "../conversationPayload";
import { and, eq } from "drizzle-orm";
import {
  channels,
  dmThreads,
  conversationEvents,
  conversations,
  type ActionRow,
  type Channel,
  type DmThreadRow,
  type IncomingReading,
  type ConversationEventRow,
  type ConversationRow,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { onlyThem } from "../../actions/dm";
import {
  INVITE_NOTE_WINDOW_MS,
  conversationInvite,
  noteOf,
  noteSpoken,
  noteStanding,
  reserveInviteNote,
  type InviteNoteCheckPayload,
} from "../../actions/inviteNote";
import { openPauses, scopesOf } from "../../actions/pause";
import { conversationEventArrived } from "../../agentStep/wait";
import { readIncoming } from "../../ai/reading";
import { isGrant, type CapabilitySurface } from "../../connector/resolve";
import { messageOf, type ClassifiedMessage } from "../../conversations/classify";
import { INBOX_READ_LIMIT } from "../../conversations/inbox";
import {
  knownMemberProfiles,
  knownMembers,
  recordThreadRead,
  samePerson,
  soleMemberUrn,
  unrecordedInbound,
  withListedMember,
} from "../../conversations/dm";
import { recordInviteNoteCarried } from "../../conversations/record";
import { leadsEnabled } from "../../leads/gate";
import { isConnectorBackoff, isConnectorSignIn } from "../../linkedin/connectorError";
import {
  MAX_HISTORY_MESSAGES,
  type DmThreadRead,
  type InboxThread,
  type KnownMember,
} from "../../linkedin/driver";
import { claimExclusiveRun, releaseExclusiveRun } from "../../pacing";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { reserveResearchRead } from "../../ratelimit/ledger";
import { trackInviteNoteChecked } from "../../telemetry/emit";
import { grantFor } from "../context";
import { RescheduleError } from "../queue";
import { assertHostedJobSpendStillAllowed, assertHostedJobSpendStillAllowedInTx } from "../spendAccess";
import type { JobResult, SelfScopedCtx } from "../worker";
import { DEFAULT_REPLY_OBSERVATION, campaignObservation, catchupAfterMs } from "./replyWatches";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Held across the reads, which the job's own timeout ends first. */
const READ_LEASE_MS = 5 * MINUTE;

/**
 * Worker handler for `invite_note_check`: after someone accepted an
 * invitation of ours that went out with a note, one read of the account's
 * conversation with them for that note (US-ICA-05).
 *
 * The note is meant to open the conversation. LinkedIn may have carried it
 * there as the account's first message — unverified until a live account
 * accepts one, so the job records which happened and works either way:
 *
 *   carried      a one-to-one conversation with them holds a message of the
 *                account's with the note's words. The conversation binds to
 *                the conversation as any read of it does, `invite_note_carried` is
 *                recorded, and `engagerSent` counts that message as Engager's,
 *                so the read never takes the conversation over. Nothing is
 *                sent.
 *   not carried  the conversation holds no such message, or none exists. The
 *                note is reserved as the first DM under the DM step's mode
 *                (`reserveInviteNote`): Off reserves nothing, Ask me waits for
 *                the owner's yes, Automatic is paced by the gate inside the
 *                caps. The send's own preflight reads the conversation again,
 *                and a note that arrived by then is never sent twice.
 *
 * The job reads and reserves; it never presses. The conversation is the bound
 * one's history, else the account's conversation list for the one with them,
 * each page load spent from the account's thread reads. A conversation the
 * list held for the owner is not opened. Everything that leaves nothing read
 * tries again within the day: no connection, a lease another run holds, a
 * budget that refuses, a page that fails or a Stop. Past the day, the check
 * says it could not read and ends.
 *
 * The read holds the account's run lease (`worker-run:<channelId>`), as a
 * worker run and the inbox check do — one browser profile, one reader.
 *
 * SELF_SCOPED: the reads are page loads in no transaction, between short ones.
 */
export async function handleInviteNoteCheck(
  ctx: SelfScopedCtx,
  payload: InviteNoteCheckPayload,
): Promise<JobResult> {
  payload = conversationPayload(payload);
  const org = ctx.organizationId;
  const now = Date.now();
  const begun = await withOrg(org, (tx) => begin(tx, payload));
  if (begun.kind === "settled") return { settled: 1 };
  if (now >= begun.expiresAt) {
    await withOrg(org, async (tx) => trackInviteNoteChecked({ outcome: "unreadable" }, tx));
    return { expired: 1 };
  }
  const next = Math.min(now + HOUR, begun.expiresAt);
  if (begun.stopped) throw new RescheduleError("stopped", next);

  const granted = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return grantFor(ctx, tx, "dm_read");
  });
  if (!isGrant(granted)) {
    throw new RescheduleError(
      granted.detail ?? "LinkedIn account is not connected",
      Math.min(now + 5 * MINUTE, begun.expiresAt),
      granted,
    );
  }
  await assertHostedJobSpendStillAllowed(ctx);
  const leaseKey = `worker-run:${begun.conversation.channelId}`;
  const lease = await withOrg(org, (tx) => claimExclusiveRun(tx, leaseKey, READ_LEASE_MS, now));
  if (!lease.claimed) throw new RescheduleError("lease_held", Math.min(now + 5 * MINUTE, begun.expiresAt));
  const found = await findConversation(org, granted.use, begun).finally(() =>
    withOrg(org, (tx) => releaseExclusiveRun(tx, leaseKey, lease.expiresAt, Date.now())),
  );
  if (found.kind === "refused") {
    throw new RescheduleError(found.reason, Math.min(found.retryAt ?? next, begun.expiresAt));
  }
  if (found.kind === "unreadable") throw new RescheduleError(found.reason, next);

  // Their words, if they wrote any, read before the transaction that records
  // them: no connection is held across a model.
  const words = found.kind === "read" ? await readNewWords(ctx, begun, found.read) : null;
  return withOrg(org, async (tx): Promise<JobResult> => {
    const at = Date.now();
    const spoken = found.kind === "read" ? noteSpoken(found.read.messages, begun.note) : undefined;
    if (found.kind === "read") {
      // Recorded before the read is, so the account's message is known as
      // Engager's by the time the read looks for the owner's.
      if (spoken) {
        await recordInviteNoteCarried(tx, {
          conversationId: begun.conversation.id,
          inviteActionId: begun.invite.id,
          messageId: spoken.messageId,
          threadId: found.read.threadId,
          observedAt: found.read.observedAt,
          now: at,
        });
      }
      // The DM thread binds to the conversation as any read of it does, and
      // their words are recorded as the inbox's read records them: classified,
      // and a message the eligibility table judged a thing to answer wakes the
      // campaign's Ambassador. Words written the moment they accepted are the
      // likeliest to be read here first, and the inbox does not read a message
      // again once it is recorded.
      const recorded = await recordThreadRead(tx, {
        channelId: begun.conversation.channelId,
        read: found.read,
        inboxDigest: null,
        classified: words?.classified ?? new Map(),
        leadWords: words?.leadWords ?? new Map(),
        now: at,
      });
      const campaignId = recorded.conversation?.owningCampaignId ?? null;
      if (campaignId !== null) {
        for (const event of recorded.recorded) await conversationEventArrived(tx, { campaignId, event, now: at });
      }
    }
    if (spoken) {
      trackInviteNoteChecked({ outcome: "carried" }, tx);
      return { carried: 1 };
    }
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, begun.conversation.id));
    const reserved = conversation
      ? await reserveInviteNote(tx, {
          conversation,
          invite: begun.invite,
          note: begun.note,
          accepted: begun.accepted,
          now: at,
        })
      : null;
    trackInviteNoteChecked({ outcome: "not_carried" }, tx);
    return reserved?.status === "reserved" ? { not_carried: 1, reserved: 1 } : { not_carried: 1 };
  });
}

type NewWords = {
  classified: Map<string, ClassifiedMessage | null>;
  leadWords: Map<string, IncomingReading>;
};

/**
 * The person's messages this read would newly record, read as the inbox's
 * read reads them (`conversations/inbox.ts`), with no transaction open while
 * a model reads them: each one's classification, and while leads are on the
 * buying intent its words show. Backlog where the campaign has catch-up
 * reviewed, and words the model could not read, are recorded unclassified,
 * which is review.
 */
async function readNewWords(ctx: SelfScopedCtx, begun: Ready, read: DmThreadRead): Promise<NewWords> {
  const { channelId, owningCampaignId } = begun.conversation;
  const { pending, leadsOn, observation } = await withOrg(ctx.organizationId, async (tx) => ({
    pending: await unrecordedInbound(tx, channelId, read),
    leadsOn: await leadsEnabled(tx),
    observation: owningCampaignId === null ? null : await campaignObservation(tx, owningCampaignId, Date.now()),
  }));
  const reviewBacklog = observation?.policy.catchupRequiresReview ?? DEFAULT_REPLY_OBSERVATION.catchup_requires_review;
  const backlogAfterMs = catchupAfterMs(begun.channel.inboxCheckBaseMin);
  const words: NewWords = { classified: new Map(), leadWords: new Map() };
  for (const message of pending) {
    if (reviewBacklog && Date.now() - (message.sentAt ?? message.observedAt) > backlogAfterMs) {
      words.classified.set(message.messageId, null);
      continue;
    }
    try {
      const reading = await readIncoming(message.text, "message", ctx.llm);
      words.classified.set(message.messageId, messageOf(message.text, reading));
      if (leadsOn) words.leadWords.set(message.messageId, reading);
    } catch (error) {
      console.error(`[invite-note] message reading failed in ${read.threadId}:`, error);
      words.classified.set(message.messageId, null);
    }
  }
  return words;
}

type Begun =
  | { kind: "settled" }
  | {
      kind: "ready";
      conversation: ConversationRow;
      invite: ActionRow;
      note: string;
      accepted: ConversationEventRow;
      /** The DM thread a read bound to the conversation, when one has. */
      thread: DmThreadRow | null;
      channel: Channel;
      stopped: boolean;
      expiresAt: number;
    };

/** What the check stands on, or that there is nothing left for it: the
 *  conversation gone or closed, no note to look for, a note that is the first
 *  message already or waits to be, or a conversation held for the owner. */
async function begin(tx: Tx, payload: InviteNoteCheckPayload): Promise<Begun> {
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, payload.conversationId));
  if (!conversation || conversation.closedReason !== null) return { kind: "settled" };
  const invite = await conversationInvite(tx, conversation.id);
  const note = invite && noteOf(invite);
  if (!invite || invite.id !== payload.inviteActionId || !note) return { kind: "settled" };
  if ((await noteStanding(tx, conversation.id)).kind !== "open") return { kind: "settled" };
  const [accepted] = await tx.select().from(conversationEvents).where(eq(conversationEvents.id, payload.acceptedEventId));
  const [channel] = await tx.select().from(channels).where(eq(channels.id, conversation.channelId));
  if (!accepted || !channel) return { kind: "settled" };
  const [thread] =
    conversation.canonicalDmThreadId === null
      ? []
      : await tx
          .select()
          .from(dmThreads)
          .where(and(eq(dmThreads.id, conversation.canonicalDmThreadId), eq(dmThreads.binding, "bound")));
  // A conversation the inbox list held for the owner is read by nothing.
  if (thread?.ownerHeldAt != null) return { kind: "settled" };
  const stops = await openPauses(
    tx,
    scopesOf({ channelId: conversation.channelId, campaignId: conversation.owningCampaignId, conversationId: conversation.id }),
  );
  return {
    kind: "ready",
    conversation,
    invite,
    note,
    accepted,
    thread: thread ?? null,
    channel,
    stopped: stops.length > 0,
    expiresAt: accepted.createdAt + INVITE_NOTE_WINDOW_MS,
  };
}

type Ready = Extract<Begun, { kind: "ready" }>;

type Found =
  | { kind: "read"; read: DmThreadRead }
  /** The list was read and holds no conversation with them. */
  | { kind: "none" }
  | { kind: "refused"; reason: string; retryAt?: number }
  | { kind: "unreadable"; reason: string };

/** One page load spent from the account's thread reads, committed before it. */
async function meterRead(org: string, channel: Channel, campaignId: number | null) {
  return withOrg(org, (tx) =>
    reserveResearchRead({ db: tx, channel, read: "thread_read", campaignId, now: Date.now() }),
  );
}

/** The one-to-one conversation the list shows with the person: by the profile
 *  it links, else by a member urn a read of Engager's tied to them. A name is
 *  never an identity. */
function conversationWith(
  threads: readonly InboxThread[],
  personId: string,
  known: ReadonlyMap<string, string>,
): InboxThread | undefined {
  return threads.find(
    (thread) =>
      !thread.group &&
      thread.participants.length === 1 &&
      (thread.participants[0]!.profileId === personId ||
        (thread.participants[0]!.profileId === null &&
          thread.participants[0]!.memberUrn !== undefined &&
          known.get(thread.participants[0]!.memberUrn) === personId)),
  );
}

/**
 * The conversation with them as it stands: the bound one's history, else the
 * list's conversation with them, each read without a transaction open. The
 * history is read without opening the conversation, and where it cannot be
 * the page is. Read only — nothing is pressed, opened for writing or marked.
 */
async function findConversation(org: string, driver: CapabilitySurface<"dm_read">, begun: Ready): Promise<Found> {
  const { conversation, channel } = begun;
  const personId = conversation.authorProfileId;
  if (!driver.readDmThread) return { kind: "unreadable", reason: "dm_read_unavailable" };
  const unreadable = async (error: unknown): Promise<Found> => {
    if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(org, error);
    const code = isConnectorSignIn(error) ? "sign_in" : "read_failed";
    return { kind: "unreadable", reason: `unreadable: ${code}` };
  };
  const refusal = async (): Promise<Found | null> => {
    const metered = await meterRead(org, channel, conversation.owningCampaignId);
    return metered.ok
      ? null
      : {
          kind: "refused",
          reason: `budget:${metered.reason}`,
          ...(metered.retryAt === undefined ? {} : { retryAt: metered.retryAt }),
        };
  };

  let threadId = begun.thread?.providerThreadId ?? null;
  let members: KnownMember[] = knownMembers(begun.thread?.participants);
  let listed: InboxThread | null = null;
  if (threadId === null) {
    if (!driver.readInbox) return { kind: "unreadable", reason: "inbox_unavailable" };
    const refused = await refusal();
    if (refused) return refused;
    let threads: readonly InboxThread[];
    try {
      threads = (await driver.readInbox({ limit: INBOX_READ_LIMIT })).threads;
    } catch (error) {
      return unreadable(error);
    }
    const urns = threads.flatMap((thread) => soleMemberUrn(thread) ?? []);
    const known = await withOrg(org, (tx) => knownMemberProfiles(tx, conversation.channelId, urns));
    listed = conversationWith(threads, personId, known) ?? null;
    if (!listed) return { kind: "none" };
    threadId = listed.threadId;
    const urn = soleMemberUrn(listed);
    if (urn !== null) members = [...members, { memberUrn: urn, profileId: personId }];
  }

  let read: DmThreadRead | null = null;
  if (driver.readConversationMessages) {
    const refused = await refusal();
    if (refused) return refused;
    try {
      const history = await driver.readConversationMessages(threadId, { limit: MAX_HISTORY_MESSAGES, members });
      // Its composer is the one Engager last saw: a history read shows none.
      const draftHash = begun.thread?.humanDraftHash;
      read = { ...history, composer: draftHash ? { hasDraft: true, draftHash } : { hasDraft: false } };
    } catch (error) {
      if (isConnectorBackoff(error) || isConnectorSignIn(error)) return unreadable(error);
      // A history the connector cannot read this way is read off its page.
    }
  }
  if (read === null) {
    const refused = await refusal();
    if (refused) return refused;
    try {
      const page = await driver.readDmThread(threadId, {});
      read = listed ? withListedMember(page, listed) : page;
    } catch (error) {
      return unreadable(error);
    }
  }
  // The account and the person alone: anything else is not the conversation
  // the invitation's note would open.
  if (!onlyThem(read, personId, members)) return { kind: "unreadable", reason: "participants_mismatch" };
  return { kind: "read", read };
}
