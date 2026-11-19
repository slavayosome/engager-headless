import { and, desc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import {
  campaigns,
  dmThreads,
  inboxReads,
  conversationEvents,
  conversations,
  type Channel,
  type DmThreadBinding,
  type ConversationClosedReason,
  type ConversationOpsStatus,
  type ConversationStage,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { scheduledWakes, type WakeView } from "../agentStep/wakes";
import { channelCeilings } from "../ratelimit/ledger";
import { withinActiveWindow } from "../time";
import type { MessageIntent } from "./classify";
import { INBOX_GAP_MS, inboxGapMs, readsInbox } from "./inbox";

/**
 * WHAT THE INBOX VIEW SHOWS (the account's Overview, and the DM rows of
 * `list_people`): how well the inbox has been covered, and the conversations
 * a conversation's person is in, each with where its conversation stands. Reads only.
 */

const DAY = 86_400_000;
/** The resolution coverage is told at. */
const STEP_MS = 5 * 60_000;

export type InboxCoverage = {
  /** The latest read of the inbox that succeeded. */
  lastRead: {
    at: number;
    threadsListed: number;
    threadsRead: number;
    messagesRecorded: number;
    /** What cut it short, if anything. */
    stoppedBy: string | null;
  } | null;
  /** The latest attempt, when it came after `lastRead` and did not read. */
  lastAttempt: { at: number; outcome: "refused" | "failed"; reason: string } | null;
  /** The stretches of the last day, inside the account's active hours, the
   *  inbox went unread longer than {@link inboxGapMs} — each from when it
   *  became overdue to the read that ended it, or to now. */
  gaps: Array<{ from: number; to: number }>;
};

/**
 * The stretches of `[from, to)`, inside the active window, more than `gapMs`
 * ({@link INBOX_GAP_MS} unless the account checks slower) after the latest of
 * `reads` — the successful reads, any order. Nothing before the first read is
 * a gap: the inbox was not being read yet, not missed. Pure.
 */
export function coverageGaps(
  reads: readonly number[],
  window: Pick<Channel, "activeHours" | "activeDays">,
  from: number,
  to: number,
  gapMs: number = INBOX_GAP_MS,
): Array<{ from: number; to: number }> {
  const sorted = [...reads].sort((a, b) => a - b);
  const gaps: Array<{ from: number; to: number }> = [];
  let open: number | null = null;
  let last = -1;
  for (let at = from; at < to; at += STEP_MS) {
    while (last + 1 < sorted.length && sorted[last + 1]! <= at) last += 1;
    const lastRead = last >= 0 ? sorted[last]! : null;
    const missed =
      lastRead !== null &&
      at - lastRead > gapMs &&
      withinActiveWindow(at, window.activeHours, window.activeDays).within;
    if (missed && open === null) open = at;
    if (!missed && open !== null) {
      gaps.push({ from: open, to: at });
      open = null;
    }
  }
  if (open !== null) gaps.push({ from: open, to });
  return gaps;
}

export async function inboxCoverage(
  tx: Tx,
  channel: Pick<Channel, "id" | "activeHours" | "activeDays" | "inboxCheckBaseMin">,
  now: number,
): Promise<InboxCoverage> {
  const since = now - DAY;
  const reads = await tx
    .select()
    .from(inboxReads)
    .where(
      and(
        eq(inboxReads.channelId, channel.id),
        eq(inboxReads.outcome, "read"),
        gte(inboxReads.finishedAt, since),
      ),
    )
    .orderBy(desc(inboxReads.finishedAt));
  // The read that a day-old stretch was last covered by.
  const [before] = await tx
    .select()
    .from(inboxReads)
    .where(
      and(
        eq(inboxReads.channelId, channel.id),
        eq(inboxReads.outcome, "read"),
        lt(inboxReads.finishedAt, since),
      ),
    )
    .orderBy(desc(inboxReads.finishedAt))
    .limit(1);
  const latest = reads[0] ?? before ?? null;
  const [attempt] = await tx
    .select()
    .from(inboxReads)
    .where(and(eq(inboxReads.channelId, channel.id), ne(inboxReads.outcome, "read")))
    .orderBy(desc(inboxReads.finishedAt))
    .limit(1);
  return {
    lastRead: latest && {
      at: latest.finishedAt,
      threadsListed: latest.threadsListed,
      threadsRead: latest.threadsRead,
      messagesRecorded: latest.messagesRecorded,
      stoppedBy: latest.reason,
    },
    lastAttempt:
      attempt && attempt.outcome !== "read" && (!latest || attempt.finishedAt > latest.finishedAt)
        ? { at: attempt.finishedAt, outcome: attempt.outcome, reason: attempt.reason ?? "" }
        : null,
    gaps: coverageGaps(
      [...reads, ...(before ? [before] : [])].map((read) => read.finishedAt),
      channel,
      since,
      now,
      inboxGapMs(channel.inboxCheckBaseMin),
    ),
  };
}

export type InboxView =
  /** No campaign on the account reads its inbox: the view is dark. */
  | { enabled: false }
  | { enabled: true; coverage: InboxCoverage; threads: DmThreadItem[] };

/** The org's LinkedIn account's Inbox: dark until a campaign on it reads the
 *  inbox (`readsInbox`), then its coverage and its conversations. */
export async function inboxView(tx: Tx, now: number): Promise<InboxView> {
  const channel = await channelCeilings(tx);
  if (!channel) return { enabled: false };
  const onAccount = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.channelId, channel.id));
  let enabled = false;
  for (const campaign of onAccount) enabled ||= await readsInbox(tx, campaign);
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    coverage: await inboxCoverage(tx, channel, now),
    threads: await dmThreadItems(tx, { channelId: channel.id }),
  };
}

/** Which half of the work queue a conversation sorts into, as
 *  `list_people`'s post-rooted rows do: the owner's to answer, or Engager's
 *  in hand. A closed conversation, or a conversation no conversation holds, is
 *  neither. */
export type DmSection = "needs_you" | "in_progress";

export type DmThreadItem = {
  id: number;
  providerThreadId: string;
  binding: DmThreadBinding;
  /** The other people in it, by the names the latest read showed. */
  with: string[];
  conversation: {
    id: number;
    profileId: string;
    opsStatus: ConversationOpsStatus;
    closedReason: ConversationClosedReason | null;
    derivedStage: ConversationStage;
  } | null;
  campaign: { id: number; name: string } | null;
  /** The person's latest message, verbatim: untrusted data. Its conversation
   *  event; none on a conversation held for the owner, which keeps the
   *  message the list showed on itself and never as an event. */
  lastMessage: {
    eventId: number | null;
    text: string | null;
    intent: MessageIntent | null;
    reasons: string[];
    at: number;
  } | null;
  humanDraftSeenAt: number | null;
  lastObservedAt: number;
  /** How many messages LinkedIn counts unread in it, and when its newest —
   *  either side's — was sent, as the latest inbox list showed them: what a
   *  conversation the owner holds is shown by beside `lastMessage`, since
   *  nothing opens it. Null where no list has said. */
  unreadCount?: number | null;
  lastMessageAt?: number | null;
  /** When the inbox list held it for the owner — their own conversation
   *  with someone Engager knows, which Engager only shows (`conversations/dm.ts`);
   *  null on every other. */
  ownerHeldAt?: number | null;
  section: DmSection | null;
  /** The soonest time the Ambassador decided to wake on the conversation,
   *  and why; null when none is set. */
  wake: WakeView | null;
};

/** Ops statuses the owner has to answer: a decision only a person makes, a
 *  conversation they hold, or a send nobody can vouch for. */
const NEEDS_YOU: ReadonlySet<ConversationOpsStatus> = new Set([
  "awaiting_review",
  "human_owned",
  "blocked",
  "uncertain",
]);

export function dmSection(item: Pick<DmThreadItem, "binding" | "conversation" | "ownerHeldAt">): DmSection | null {
  if (item.binding !== "bound" || !item.conversation || item.conversation.closedReason !== null) {
    return null;
  }
  // A conversation held for the owner is theirs to answer, however the
  // person's conversation stands.
  if (item.ownerHeldAt != null) return "needs_you";
  return NEEDS_YOU.has(item.conversation.opsStatus) ? "needs_you" : "in_progress";
}

/** The conversations kept on the org's accounts, newest observed first. */
export async function dmThreadItems(
  tx: Tx,
  filter: { channelId?: number; campaignId?: number; limit?: number } = {},
): Promise<DmThreadItem[]> {
  const rows = await tx
    .select({ thread: dmThreads, conversation: conversations, campaign: { id: campaigns.id, name: campaigns.name } })
    .from(dmThreads)
    .leftJoin(conversations, eq(conversations.id, dmThreads.conversationId))
    .leftJoin(campaigns, eq(campaigns.id, conversations.owningCampaignId))
    .where(
      and(
        ...(filter.channelId !== undefined ? [eq(dmThreads.channelId, filter.channelId)] : []),
        ...(filter.campaignId !== undefined
          ? [eq(conversations.owningCampaignId, filter.campaignId)]
          : []),
      ),
    )
    .orderBy(desc(dmThreads.lastObservedAt), desc(dmThreads.id))
    .limit(filter.limit ?? 100);
  const conversationIds = rows.flatMap((row) => (row.conversation ? [row.conversation.id] : []));
  const latest = new Map<number, typeof conversationEvents.$inferSelect>();
  if (conversationIds.length > 0) {
    const messages = await tx
      .selectDistinctOn([conversationEvents.conversationId])
      .from(conversationEvents)
      .where(
        and(
          inArray(conversationEvents.conversationId, conversationIds),
          eq(conversationEvents.type, "inbound_message_observed"),
        ),
      )
      .orderBy(conversationEvents.conversationId, desc(conversationEvents.occurredAt), desc(conversationEvents.id));
    for (const message of messages) latest.set(message.conversationId, message);
  }
  const wakes = new Map<number, WakeView>();
  // Soonest first: the first a conversation has is its next.
  for (const wake of await scheduledWakes(tx, { conversationIds })) {
    if (!wakes.has(wake.conversationId)) wakes.set(wake.conversationId, wake);
  }
  return rows.map(({ thread, conversation, campaign }) => {
    const message = conversation ? latest.get(conversation.id) : undefined;
    const decision = message?.decision as
      | { intent?: MessageIntent | null; reasons?: string[] }
      | null
      | undefined;
    const item = {
      id: thread.id,
      providerThreadId: thread.providerThreadId,
      binding: thread.binding,
      with: thread.participants
        .filter((participant) => !participant.isSelf)
        .map((participant) => participant.displayName),
      conversation: conversation && {
        id: conversation.id,
        profileId: conversation.authorProfileId,
        opsStatus: conversation.opsStatus,
        closedReason: conversation.closedReason,
        derivedStage: conversation.derivedStage,
      },
      campaign: campaign && campaign.id !== null ? { id: campaign.id, name: campaign.name } : null,
      lastMessage:
        thread.ownerHeldAt !== null
          ? thread.heldMessageText === null
            ? null
            : {
                eventId: null,
                text: thread.heldMessageText,
                intent: null,
                reasons: [],
                at: thread.heldMessageAt ?? thread.lastObservedAt,
              }
          : message
            ? {
                eventId: message.id,
                text: message.content,
                intent: decision?.intent ?? null,
                reasons: decision?.reasons ?? [],
                at: message.occurredAt,
              }
            : null,
      humanDraftSeenAt: thread.humanDraftSeenAt,
      lastObservedAt: thread.lastObservedAt,
      unreadCount: thread.unreadCount,
      lastMessageAt: thread.lastMessageAt,
      ownerHeldAt: thread.ownerHeldAt,
      wake: (conversation && wakes.get(conversation.id)) ?? null,
    };
    return { ...item, section: dmSection(item) };
  });
}
