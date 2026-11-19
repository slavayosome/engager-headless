import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  authorProfiles,
  campaignStrategies,
  campaigns,
  channels,
  dmThreads,
  inboxReads,
  incomingComments,
  conversationEvents,
  conversationSources,
  conversations,
  leads,
  type Campaign,
  type Channel,
  type DmThreadRow,
  type IncomingReading,
  type InboxReadOutcome,
  type Reader,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { openPauses, scopesOf } from "../actions/pause";
import { conversationEventArrived } from "../agentStep/wait";
import type { LLM } from "../ai/client";
import { readIncoming, wordsHash } from "../ai/reading";
import { CONNECTOR_DECLARATIONS } from "../connector/capabilities";
import { isGrant } from "../connector/resolve";
import { parseStrategy } from "../strategy/contract";
import {
  campaignObservation,
  catchupAfterMs,
  observedSince,
} from "../jobs/handlers/replyWatches";
import type { CapabilityGrant } from "../jobs/context";
import {
  isConnectorBackoff,
  isConnectorDrift,
  isConnectorSignIn,
} from "../linkedin/connectorError";
import type {
  AgentPage,
  AgentPageRequest,
  DmMessage,
  DmThreadRead,
  InboxRead,
  InboxThread,
  KnownMember,
} from "../linkedin/driver";
import { MAX_HISTORY_MESSAGES } from "../linkedin/driver";
import { leadsEnabled } from "../leads/gate";
import { stampPacedRun } from "../pacing";
import { pauseChannelForConnectorBackoff } from "../ratelimit/killswitch";
import { reserveReplyCheck } from "../ratelimit/ledger";
import { inboxReadNote } from "../reader/notes";
import { readDmThreadByAgent, readInboxByAgent } from "../reader/read";
import { droppedCount } from "../reader/verify";
import { messageOf, type ClassifiedMessage } from "./classify";
import {
  engagerSent,
  holdOwnersConversation,
  knownMemberProfiles,
  knownMembers,
  listedState,
  recordGroupCard,
  recordHeldCard,
  recordThreadRead,
  samePerson,
  soleMemberUrn,
  unrecordedInbound,
  withListedMember,
  type RecordedThread,
} from "./dm";

/**
 * THE AMBASSADOR'S EYES ON THE INBOX (spec §07 `read_thread`, §10 R05, §16
 * "Mac asleep — show last successful observation and missed coverage").
 *
 * A wake of the Ambassador of a campaign that runs on its strategy and
 * hires it for one-to-one contact past the public thread — a Connect step or
 * a Message after they accept step ({@link readsInbox}) — reads the account's inbox
 * — newest conversations first, back to when the campaign began observing
 * and as far before it as its observation lookback reaches — from LinkedIn's
 * own conversation data: who each is with, its last message, how many wait
 * unread. That read opens nothing and touches no conversation's read state.
 * From it, a conversation whose list shows a new message from the other side
 * is observed:
 *
 *   - a conversation already bound to a conversation;
 *   - a conversation the list names beside a conversation's person — by the
 *     profile id LinkedIn links, or by a name a read of theirs carried — to
 *     see who is actually in it. The name is a hint about WHICH page to load,
 *     never an identity: only the conversation's own read binds it
 *     (`conversations/dm.ts`), by profile id.
 *
 * The list's last message stands for a read of a conversation already bound
 * where it is the whole of what is new ({@link listSuffices}): one message
 * unread, from the person the conversation holds, in a conversation the owner has
 * not read or written in since Engager last opened it, with no draft waiting.
 * It is recorded as the conversation's page would record it, beside what
 * Engager already keeps — no page load, no reply check. Every other
 * conversation to observe is read, at most {@link MAX_THREAD_OPENS_PER_WAKE}
 * a wake, each spending a reply check: from LinkedIn's own history for it,
 * without opening it, where LinkedIn keeps no draft on it — a draft only its
 * page shows — its person named by the profile any read of Engager's tied
 * their member urn to ({@link membersOf}); else, or where the history cannot
 * be read (a renamed query, an answer the connector does not know, a member
 * urn no read has tied to a profile), by opening it. Opening one marks it
 * seen on LinkedIn, so one the list showed unread has its unread mark put
 * back. A moved one left unread is read on the next wake.
 *
 * A one-to-one conversation the list shows with someone Engager knows by
 * member urn — whose reply under our comment carried it, whom a read of
 * another conversation learnt it for, or whose own profile a read verified it
 * for — that the campaign did not start is
 * the owner's, held for them on the list's word (`holdOwnersConversation`):
 * bound to the person's conversation and the conversation itself held, the
 * person's newest message there kept for the owner to see. Nothing opens it,
 * no model reads it, no reply check is spent on it, nothing wakes for it and
 * no DM goes into it — each move of it on the list is kept the same way. The
 * person's conversation, and the public thread under our comments, go on as
 * before.
 *
 * A group the list shows beside one of those people is kept as a group and
 * never read. Every other conversation in the inbox is the owner's: it is
 * not opened, its words are dropped unread, and nothing of it is kept.
 *
 * Only a conversation bound to a conversation has its words read by a model —
 * one message at a time, fenced as untrusted data, with no transaction open.
 *
 * Every attempt is an `inbox_reads` row, which is what coverage is told from:
 * the last successful read, and the stretches the inbox went unread. Every
 * attempt that reached the account also pushes the account's light inbox
 * check (`inbox_check`) one interval out, so a wake and the check never read
 * the same inbox twice in a row. Every page load — the list, a history, a
 * conversation opened — spends a reply check from the account's budget for
 * what people write back (`dailyReplyCheckCap`), shared with the looks under
 * its comments and never Research's.
 *
 * FAIL CLOSED. A page the connector does not recognise changes nothing and
 * ends the reading; a signed-out session or a backoff ends it too, and a
 * backoff parks the account as every other read's does.
 *
 * THE AGENT READER. Where the connector hands over pages for it, a list read
 * or a conversation read that drifts is followed by the agent reader's read
 * of the same page (`reader/`): a page load of its own, spending its own
 * reply check, whose answer stands only as far as the page shows it. A list
 * the parser reads as empty is believed. After a conversation drifts, every later one
 * this wake is the agent reader's alone. Its list names only the
 * conversations the page links or has open — it presses no card — and carries
 * no message itself, so every conversation it names is opened; its
 * conversation read never reads the composer, so a thread keeps the
 * composer state its last parser read saw.
 */

/** How many conversations one inbox read lists. */
export const INBOX_READ_LIMIT = 20;

/** How many conversations one wake reads beyond the list — from their
 *  history or by opening them, each a reply check — and a moved one left
 *  unread is read on the next wake. One the list alone stands for is not
 *  counted. */
export const MAX_THREAD_OPENS_PER_WAKE = 3;

/** How many messages LinkedIn's history holds a page. */
const HISTORY_PAGE = 20;

/** How many of a conversation's newest messages a history read asks for:
 *  one of LinkedIn's pages, two where a page's worth waits unread. */
function historyLimit(thread: InboxThread): number {
  return thread.unreadCount !== undefined && thread.unreadCount >= HISTORY_PAGE ? MAX_HISTORY_MESSAGES : HISTORY_PAGE;
}

/** How long the inbox may go unread inside the account's active hours before
 *  the time counts as missed — at the default cadence; a slower "Check
 *  messages every" stretches it ({@link inboxGapMs}). */
export const INBOX_GAP_MS = 2 * 3_600_000;

/** {@link INBOX_GAP_MS} for an account checking every `cadenceMin`: never
 *  shorter than two of its intervals, so an ordinary wait between two checks
 *  is never reported as missed coverage. */
export function inboxGapMs(cadenceMin: number): number {
  return Math.max(INBOX_GAP_MS, 2 * cadenceMin * 60_000);
}

/** The `pacing_state` kind the account's light inbox check is paced on. */
export function inboxCheckKind(channelId: number): string {
  return `inbox_check:${channelId}`;
}

const READ_JITTER_MIN_MS = 3_000;
const READ_JITTER_SPAN_MS = 4_000;

export type InboxObservation =
  | {
      status: "read";
      listed: number;
      threadsRead: number;
      recorded: number;
      takeovers: number;
      /** What cut the reading short, if anything. */
      stoppedBy: string | null;
      /** The inbox listed more conversations than the read took. */
      truncated: boolean;
      /** Cards the reader could not read and skipped. */
      skipped: number;
      /** Conversations the wake opened while the list showed them unread
       *  whose unread mark it could not see restored. */
      unreadRestoresUnconfirmed: number;
      /** Whose list the read worked from. */
      reader: Reader;
      /** What the agent reader did, where it read anything — run notes. */
      agentNotes: string[];
    }
  | { status: "stopped" | "unsupported" }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string; agentNotes?: string[] };

/** The inbox card's digest: what moves when a message arrives. The unread
 *  mark is left out — the owner reading a message on their phone is not a
 *  new one. */
export function inboxDigest(thread: InboxThread): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        thread.lastMessage.textHash,
        thread.lastMessage.fromSelf,
        thread.lastMessage.at,
      ]),
      "utf8",
    )
    .digest("hex");
}

/** A display name as a hint compares: case, spacing and Unicode form
 *  folded. */
export function nameKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

/** The Ambassador's steps that put it in touch with a person beyond the
 *  public thread — an invitation's note or a DM — so the person may answer in
 *  the inbox: an opt-out or a "busy" there must be seen. */
const INBOX_STEPS: ReadonlySet<string> = new Set(["connect", "continue_in_dms"]);

/**
 * Whether a campaign's wakes read its account's inbox at all: it runs on its
 * strategy, and that strategy hires its Ambassador to Connect or to
 * Message after they accept — the steps the inbox is the eyes of (INV-33). A campaign
 * with neither never opens the owner's messages, whatever else it does.
 */
export async function readsInbox(
  tx: Tx,
  campaign: Pick<Campaign, "id">,
): Promise<boolean> {
  const [active] = await tx
    .select({ document: campaignStrategies.document })
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.campaignId, campaign.id),
        eq(campaignStrategies.status, "active"),
      ),
    );
  const parsed = active ? parseStrategy(active.document, { network: null }) : null;
  return (
    parsed?.success === true &&
    (parsed.data.steps ?? []).some(
      (step) => step.worker === "ambassador" && INBOX_STEPS.has(step.catalog_step),
    )
  );
}

/**
 * Whether the account's inbox may be read for this campaign at all: the
 * campaign reads one ({@link readsInbox}), its account's connector reads
 * direct messages, and nothing stops it or its account. The one question a
 * wake ({@link inboxReadDue}) and the light check (`conversations/inboxCheck.ts`)
 * both ask before a read. Returns the channel's cadence when it may.
 */
export async function inboxReadable(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
): Promise<{ cadenceMin: number } | null> {
  if (campaign.channelId === null || !(await readsInbox(tx, campaign))) return null;
  const [channel] = await tx
    .select({ connector: channels.connector, cadenceMin: channels.inboxCheckBaseMin })
    .from(channels)
    .where(eq(channels.id, campaign.channelId));
  if (!channel || !CONNECTOR_DECLARATIONS[channel.connector].dm_read) return null;
  const stops = await openPauses(
    tx,
    scopesOf({ channelId: campaign.channelId, campaignId: campaign.id, conversationId: null }),
  );
  return stops.length > 0 ? null : { cadenceMin: channel.cadenceMin };
}

/**
 * Whether this wake should read the account's inbox: it may at all
 * ({@link inboxReadable}), and — unless forced — no read has succeeded
 * within the account's "Check messages every". Only a press forces it: an
 * event wake works from what the read that woke it just recorded.
 */
export async function inboxReadDue(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
  opts: { now: number; force: boolean },
): Promise<boolean> {
  const readable = await inboxReadable(tx, campaign);
  if (!readable || campaign.channelId === null) return false;
  if (opts.force) return true;
  const [last] = await tx
    .select({ at: inboxReads.finishedAt })
    .from(inboxReads)
    .where(and(eq(inboxReads.channelId, campaign.channelId), eq(inboxReads.outcome, "read")))
    .orderBy(desc(inboxReads.finishedAt))
    .limit(1);
  return !last || last.at <= opts.now - readable.cadenceMin * 60_000;
}

/**
 * The account's active campaigns whose wakes read its inbox
 * ({@link readsInbox}), oldest first, whether or not a Stop holds them. None
 * means nothing reads the owner's messages at all.
 */
export async function inboxReadingCampaigns(tx: Tx, channelId: number): Promise<Campaign[]> {
  const active = await tx
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.channelId, channelId),
        eq(campaigns.status, "active"),
      ),
    )
    .orderBy(asc(campaigns.id));
  const reading: Campaign[] = [];
  for (const campaign of active) if (await readsInbox(tx, campaign)) reading.push(campaign);
  return reading;
}

/** Read the inbox for one wake. See the module comment. */
export async function observeInbox(opts: {
  organizationId: string;
  campaign: Pick<Campaign, "id" | "channelId">;
  grant: CapabilityGrant;
  llm: LLM;
  runId: number | null;
  now: number;
  /** Renews the run's lease; false stops the reading between page loads. */
  continueRun?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): Promise<InboxObservation> {
  const { organizationId: org, campaign, now } = opts;
  const channelId = campaign.channelId;
  if (channelId === null) return { status: "unsupported" };
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const startedAt = Date.now();

  const begun = await withOrg(org, async (tx) => {
    if (!(await readsInbox(tx, campaign))) return { kind: "unsupported" } as const;
    const stops = await openPauses(
      tx,
      scopesOf({ channelId, campaignId: campaign.id, conversationId: null }),
    );
    if (stops.length > 0) return { kind: "stopped" } as const;
    const granted = await opts.grant(tx, "dm_read");
    if (!isGrant(granted)) return { kind: "unsupported" } as const;
    const { readInbox, readDmThread, readConversationMessages } = granted.use;
    if (!readInbox || !readDmThread) return { kind: "unsupported" } as const;
    // The agent reader is its own question: a connector that hands over no
    // page reads the inbox with its parser alone, as before.
    const pages = await opts.grant(tx, "agent_read");
    const readPage = isGrant(pages) ? pages.use.readPageForAgent?.bind(pages.use) : undefined;
    const [channel] = await tx.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) return { kind: "unsupported" } as const;
    // Everything since the campaign began observing, and as far before it as
    // it catches up (`observation`) — the rule the threads under its comments
    // are read by.
    const observation = await campaignObservation(tx, campaign.id, now);
    const since = observedSince(observation.policy, observation.anchorMs, now);
    const refused = await reserveRead(tx, channel, campaign.id, now);
    return {
      kind: "ready",
      surface: {
        readInbox: readInbox.bind(granted.use),
        readDmThread: readDmThread.bind(granted.use),
        readHistory: readConversationMessages?.bind(granted.use) ?? null,
        readPage: readPage ?? null,
      },
      channel,
      observation,
      since,
      refused,
    } as const;
  });
  if (begun.kind !== "ready") return { status: begun.kind };
  const { surface, channel, observation, since } = begun;
  const log = (outcome: InboxReadOutcome, values: Partial<typeof inboxReads.$inferInsert>) =>
    withOrg(org, async (tx) => {
      const finishedAt = Date.now();
      await tx.insert(inboxReads).values({
        channelId,
        campaignId: campaign.id,
        runId: opts.runId,
        outcome,
        lookbackFrom: since,
        startedAt,
        finishedAt,
        ...values,
      });
      // A read that reached the account — whoever made it — is the one the
      // light check would have made: its next is measured from this one.
      if (outcome !== "refused") {
        await stampPacedRun(
          tx,
          inboxCheckKind(channelId),
          channel.inboxCheckBaseMin * 60_000,
          finishedAt,
          random,
        );
      }
    });
  if (begun.refused) {
    await log("refused", { reason: begun.refused });
    return { status: "refused", reason: begun.refused };
  }

  // The agent reader stands behind each of the parser's reads: its own page
  // load, its own reply check, the owner's model, and the server's check
  // of every id and word against the page (`reader/`).
  const agent: AgentInboxReader | null = surface.readPage
    ? {
        readPage: surface.readPage,
        llm: opts.llm,
        reserve: () => withOrg(org, (tx) => reserveRead(tx, channel, campaign.id, Date.now())),
      }
    : null;
  const agentNotes: string[] = [];
  // Page loads on the real account are spaced, as the verify's are: every
  // conversation after the first waits, whether the one before it answered
  // or threw — and an agent read is a page load of its own, after the
  // parser's.
  let opened = false;
  const spaced = async () => {
    if (opened) await sleep(READ_JITTER_MIN_MS + random() * READ_JITTER_SPAN_MS);
    opened = true;
  };

  let inbox: InboxRead;
  let reader: Reader = "parser";
  try {
    inbox = await surface.readInbox({ since, limit: INBOX_READ_LIMIT });
  } catch (error) {
    const reason = await readFailure(org, "inbox", error);
    opened = true;
    const byAgent = agent && isConnectorDrift(error) ? await inboxByAgent(org, agent, spaced) : null;
    if (byAgent?.kind !== "read") {
      await log("failed", { reason });
      return { status: "failed", reason, ...(byAgent ? { agentNotes: [byAgent.note] } : {}) };
    }
    inbox = byAgent.inbox;
    reader = "agent";
    agentNotes.push(byAgent.note);
  }

  const plan = await withOrg(org, (tx) => planThreadReads(tx, channel, inbox, observation, now));
  const backlogAfterMs = catchupAfterMs(channel.inboxCheckBaseMin);
  let threadsRead = 0;
  let recorded = plan.recorded;
  let takeovers = 0;
  let unreadRestoresUnconfirmed = 0;
  let stoppedBy: string | null = null;
  let parserDrifted = false;
  for (const { thread, digest, listed, composer, members, since: threadSince } of plan.reads) {
    if (opts.continueRun && !(await opts.continueRun())) {
      stoppedBy = "run_stopped";
      break;
    }
    let observed: DmThreadRead | null = listed;
    if (observed === null && composer !== null && surface.readHistory) {
      const refused = await withOrg(org, (tx) => reserveRead(tx, channel, campaign.id, Date.now()));
      if (refused) {
        stoppedBy = refused;
        break;
      }
      await spaced();
      try {
        const history = await surface.readHistory(thread.threadId, { limit: historyLimit(thread), members });
        observed = { ...history, composer };
      } catch (error) {
        if (isConnectorSignIn(error) || isConnectorBackoff(error)) {
          stoppedBy = await readFailure(org, "thread", error);
          break;
        }
        // Fail closed for this read alone: the conversation is opened, as it
        // was before its history could be read.
        console.warn(`[inbox] history query id stale: ${(error as Error).message}; opening the conversation`);
      }
    }
    if (observed === null && !parserDrifted) {
      const refused = await withOrg(org, (tx) => reserveRead(tx, channel, campaign.id, Date.now()));
      if (refused) {
        stoppedBy = refused;
        break;
      }
      await spaced();
      try {
        // The page links the person by profile, the list by member urn: the
        // thread keeps the two together, for its next read by urn.
        observed = withListedMember(
          await surface.readDmThread(thread.threadId, {
            since: threadSince,
            ...(thread.unread ? { restoreUnread: true } : {}),
          }),
          thread,
        );
        if (observed.unreadRestore === "unread_restore_unconfirmed") unreadRestoresUnconfirmed += 1;
      } catch (error) {
        const reason = await readFailure(org, "thread", error);
        // The same layout, the same session, the same account: every further
        // conversation would meet the same answer — the agent reader's to
        // read where it may. Anything else is this one's.
        if (isConnectorDrift(error) && agent) {
          parserDrifted = true;
        } else if (isConnectorDrift(error) || isConnectorSignIn(error) || isConnectorBackoff(error)) {
          stoppedBy = reason;
          break;
        } else {
          continue;
        }
      }
    }
    if (observed === null && agent) {
      const byAgent = await dmThreadByAgent(org, channelId, agent, thread.threadId, spaced);
      if (byAgent.kind === "stop") {
        stoppedBy = byAgent.reason;
        break;
      }
      if (byAgent.kind === "missed") {
        agentNotes.push(byAgent.note);
        continue;
      }
      observed = byAgent.read;
    }
    if (observed === null) continue;
    const read = observed;
    if (listed === null) threadsRead += 1;
    const result = await recordRead({
      organizationId: org,
      channelId,
      llm: opts.llm,
      read,
      inboxDigest: digest,
      listed: listed !== null,
      backlogAfterMs: observation.policy.catchupRequiresReview ? backlogAfterMs : null,
    });
    recorded += result.recorded.length;
    if (result.takeover) takeovers += 1;
  }

  // Opening a conversation the list showed unread took its mark; the read's one
  // Mark as unread is journaled where it could not be seen to land, and never
  // pressed again on a guess.
  await log("read", {
    reason: stoppedBy,
    threadsListed: inbox.threads.length,
    threadsRead,
    messagesRecorded: recorded,
    unreadRestoresUnconfirmed,
    reader,
  });
  return {
    status: "read",
    listed: inbox.threads.length,
    threadsRead,
    recorded,
    takeovers,
    stoppedBy,
    truncated: inbox.truncated,
    skipped: inbox.skipped ?? 0,
    unreadRestoresUnconfirmed,
    reader,
    agentNotes,
  };
}

/** What the owner's Check LinkedIn now on one conversation came to. */
export type ConversationSync =
  | { status: "read"; recorded: number }
  /** The account's read budget, window or stops said no; nothing was read. */
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string }
  /** No LinkedIn conversation is bound to it, or the one bound is the
   *  owner's own, which Engager reads nothing of. */
  | { status: "unbound" | "held" | "unsupported" | "not_found" };

/**
 * THE OWNER'S "CHECK LINKEDIN NOW" on one conversation: its bound LinkedIn
 * conversation opened at once, whatever the inbox card last said and whoever
 * wrote last, and recorded as the inbox's own reads are (`recordRead`) —
 * their new messages read and answered under the campaign's modes, the
 * owner's own words on LinkedIn kept for their Messages. One page load,
 * reserved first against the account's reply-check budget, so its window
 * and stops say yes before anything loads. The caller holds the account's
 * run lease, as the inbox check does.
 */
export async function syncConversation(opts: {
  organizationId: string;
  conversationId: number;
  grant: CapabilityGrant;
  llm: LLM;
  now: number;
}): Promise<ConversationSync> {
  const { organizationId: org, now } = opts;
  const begun = await withOrg(org, async (tx) => {
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, opts.conversationId));
    if (!conversation || conversation.owningCampaignId === null) return { kind: "not_found" } as const;
    if (conversation.canonicalDmThreadId === null) return { kind: "unbound" } as const;
    const [thread] = await tx.select().from(dmThreads).where(eq(dmThreads.id, conversation.canonicalDmThreadId));
    if (!thread || thread.binding !== "bound") return { kind: "unbound" } as const;
    if (thread.ownerHeldAt !== null) return { kind: "held" } as const;
    const [channel] = await tx.select().from(channels).where(eq(channels.id, conversation.channelId));
    if (!channel) return { kind: "not_found" } as const;
    const campaignId = conversation.owningCampaignId;
    // A takeover holds what Engager sends to them, never what it reads.
    const stops = await openPauses(tx, scopesOf({ channelId: channel.id, campaignId, conversationId: null }));
    if (stops.length > 0) return { kind: "refused", reason: "stopped" } as const;
    const granted = await opts.grant(tx, "dm_read");
    if (!isGrant(granted) || !granted.use.readDmThread) return { kind: "unsupported" } as const;
    const observation = await campaignObservation(tx, campaignId, now);
    const refused = await reserveRead(tx, channel, campaignId, now);
    if (refused) return { kind: "refused", reason: refused } as const;
    return {
      kind: "ready",
      readDmThread: granted.use.readDmThread.bind(granted.use),
      channel,
      thread,
      since: observedSince(observation.policy, Math.min(observation.anchorMs, thread.createdAt), now),
      backlogAfterMs: observation.policy.catchupRequiresReview ? catchupAfterMs(channel.inboxCheckBaseMin) : null,
    } as const;
  });
  if (begun.kind === "refused") return { status: "refused", reason: begun.reason };
  if (begun.kind !== "ready") return { status: begun.kind };
  let read: DmThreadRead;
  try {
    read = await begun.readDmThread(begun.thread.providerThreadId, {
      since: begun.since,
      ...((begun.thread.unreadCount ?? 0) > 0 ? { restoreUnread: true } : {}),
    });
  } catch (error) {
    return { status: "failed", reason: await readFailure(org, "thread", error) };
  }
  const recorded = await recordRead({
    organizationId: org,
    channelId: begun.channel.id,
    llm: opts.llm,
    read,
    inboxDigest: begun.thread.lastInboxDigest,
    listed: false,
    backlogAfterMs: begun.backlogAfterMs,
  });
  return { status: "read", recorded: recorded.recorded.length };
}

/**
 * One read of a conversation, recorded: each message of theirs it has not
 * recorded read by the owner's model — except backlog, older than
 * `backlogAfterMs`, which waits for the owner unread, recorded unclassified,
 * which is review, so nothing wakes or drafts against it — then the read
 * written in one transaction (`recordThreadRead`), and the Ambassador of the
 * campaign that owns the conversation woken for what it answers.
 */
async function recordRead(input: {
  organizationId: string;
  channelId: number;
  llm: LLM;
  read: DmThreadRead;
  inboxDigest: string | null;
  listed: boolean;
  /** Null where the campaign reads catch-up like any message. */
  backlogAfterMs: number | null;
}): Promise<RecordedThread> {
  const { organizationId: org, channelId, read, backlogAfterMs } = input;
  const { pending, leadsOn } = await withOrg(org, async (tx) => ({
    pending: await unrecordedInbound(tx, channelId, read),
    leadsOn: await leadsEnabled(tx),
  }));
  const classified = new Map<string, ClassifiedMessage | null>();
  const current: DmMessage[] = [];
  for (const message of pending) {
    if (backlogAfterMs !== null && Date.now() - (message.sentAt ?? message.observedAt) > backlogAfterMs) {
      classified.set(message.messageId, null);
    } else {
      current.push(message);
    }
  }
  // One reading of each message's words serves its classification and, for
  // the person's temperature, the buying intent they show.
  const leadWords = new Map<string, IncomingReading>();
  const saved = await withOrg(org, async (tx) => pending.length === 0 ? [] : tx
    .select({ id: conversationEvents.providerEventId, reading: conversationEvents.reading })
    .from(conversationEvents).innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(and(eq(conversations.channelId, channelId), inArray(conversationEvents.providerEventId, pending.map(message => message.messageId)))));
  for (const message of current) {
    try {
      const prior = saved.find(row => row.id === message.messageId)?.reading;
      const reading = prior?.textHash === wordsHash(message.text) ? prior : await readIncoming(message.text, "message", input.llm);
      classified.set(message.messageId, messageOf(message.text, reading));
      if (leadsOn && !prior) leadWords.set(message.messageId, reading);
    } catch (error) {
      // An unclassified message is recorded as one, which is review.
      console.error(`[inbox] message reading failed in ${read.threadId}:`, error);
      classified.set(message.messageId, null);
    }
  }
  return withOrg(org, async (tx) => {
    const at = Date.now();
    const recorded = await recordThreadRead(tx, {
      channelId,
      read,
      inboxDigest: input.inboxDigest,
      classified,
      leadWords,
      now: at,
      ...(input.listed ? { listed: true } : {}),
    });
    // A message the eligibility table judged a thing to answer wakes the
    // Ambassador of the campaign that owns the conversation, as a reply
    // under our comment does — its Message after they accept step answers it.
    const campaignId = recorded.conversation?.owningCampaignId ?? null;
    if (campaignId !== null) {
      for (const event of recorded.recorded) await conversationEventArrived(tx, { campaignId, event, now: at });
    }
    return recorded;
  });
}

/** The agent reader as the inbox uses it: the connector's page load, the
 *  owner's model, and a reply check reserved for each page. */
type AgentInboxReader = {
  readPage: (request: AgentPageRequest) => Promise<AgentPage>;
  llm: LLM;
  reserve: () => Promise<string | null>;
};

/** Why an agent read stopped the reading, or what it read. */
type AgentInboxRead =
  | { kind: "read"; inbox: InboxRead; note: string }
  | { kind: "missed"; note: string };

/**
 * The inbox read by the agent reader: the conversations the page names —
 * those a card links, and the one open — as the parser would list them. It
 * presses nothing, so a card that links no conversation stays unnamed and is
 * never opened.
 */
async function inboxByAgent(
  organizationId: string,
  agent: AgentInboxReader,
  beforeLoad: () => Promise<void>,
): Promise<AgentInboxRead> {
  const refused = await agent.reserve();
  if (refused) return { kind: "missed", note: `inbox not read by the agent reader: ${refused}` };
  let page: AgentPage;
  try {
    await beforeLoad();
    page = await agent.readPage({ intent: "inbox" });
  } catch (error) {
    const reason = await readFailure(organizationId, "inbox", error);
    return { kind: "missed", note: `inbox not read by the agent reader: ${reason}` };
  }
  const result = await readInboxByAgent(agent.llm, page);
  if (result.status !== "verified") return { kind: "missed", note: inboxReadNote(result) };
  return {
    kind: "read",
    inbox: {
      threads: result.threads,
      truncated: page.truncated,
      skipped: droppedCount(result.dropped),
      observedAt: page.observedAt,
      pageFingerprint: page.pageFingerprint,
      selectorPack: page.selectorPack,
    },
    note: inboxReadNote({ listed: result.threads.length, dropped: result.dropped }),
  };
}

/**
 * One conversation read by the agent reader, after the parser could not
 * read the layout. Everything a conversation read carries but its composer:
 * the agent reader never reads one, so the conversation keeps the composer
 * state its last parser read saw — a human draft seen stays seen, and none
 * is invented. "stop" where no further read can succeed.
 */
async function dmThreadByAgent(
  organizationId: string,
  channelId: number,
  agent: AgentInboxReader,
  threadId: string,
  beforeLoad: () => Promise<void>,
): Promise<{ kind: "read"; read: DmThreadRead } | { kind: "missed"; note: string } | { kind: "stop"; reason: string }> {
  const refused = await agent.reserve();
  if (refused) return { kind: "stop", reason: refused };
  let page: AgentPage;
  try {
    await beforeLoad();
    page = await agent.readPage({ intent: "dm_thread", threadId });
  } catch (error) {
    const reason = await readFailure(organizationId, "thread", error);
    if (isConnectorSignIn(error) || isConnectorBackoff(error)) return { kind: "stop", reason };
    return { kind: "missed", note: `a conversation was not read by the agent reader: ${reason}` };
  }
  const result = await readDmThreadByAgent(agent.llm, page, threadId);
  if (result.status !== "verified") {
    const why = result.status === "unverified" ? result.reason : result.status;
    return { kind: "missed", note: `a conversation's agent read recorded nothing: ${why}` };
  }
  const [known] = await withOrg(organizationId, (tx) =>
    tx
      .select({ draftHash: dmThreads.humanDraftHash })
      .from(dmThreads)
      .where(and(eq(dmThreads.channelId, channelId), eq(dmThreads.providerThreadId, threadId))),
  );
  return {
    kind: "read",
    read: {
      ...result.read,
      composer: known?.draftHash ? { hasDraft: true, draftHash: known.draftHash } : { hasDraft: false },
    },
  };
}

/** The read's reservation, committed before the page load as every read's
 *  is; null when it may proceed. A message is what someone wrote back, as a
 *  reply is: it spends the account's reply-check budget, never Research's
 *  `thread_read`, so a day on which verifying matches spends every post read
 *  still sees the inbox. */
async function reserveRead(
  tx: Tx,
  channel: Channel,
  campaignId: number,
  now: number,
): Promise<string | null> {
  const decision = await reserveReplyCheck({ db: tx, channel, campaignId, now });
  return decision.ok ? null : decision.reason;
}

/** What a failed read is recorded as — and a backoff parks the account, as
 *  every other read's does. */
async function readFailure(
  organizationId: string,
  what: "inbox" | "thread",
  error: unknown,
): Promise<string> {
  if (isConnectorBackoff(error)) {
    return `backoff:${await pauseChannelForConnectorBackoff(organizationId, error)}`;
  }
  if (isConnectorDrift(error)) {
    console.warn(
      `[inbox] ${what}: ${(error as Error).message}`,
      JSON.stringify((error as { diagnostic?: unknown }).diagnostic ?? null),
    );
    return "ui_drift";
  }
  if (isConnectorSignIn(error)) return "sign_in";
  console.error(`[inbox] ${what} read failed:`, error);
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.toLowerCase() : "read_failed";
}

/** A conversation this wake observes: by the list's last message alone where
 *  `listed` stands for its read; else from its history, where `composer` —
 *  what Engager last saw in it — stands for the one its page would show, and
 *  `members` names whose profile each member urn in it is; else by opening
 *  it. */
type PlannedRead = {
  thread: InboxThread;
  digest: string;
  listed: DmThreadRead | null;
  composer: DmThreadRead["composer"] | null;
  members: KnownMember[];
  /** Where a read of the conversation's page begins. */
  since: number;
};

/** The composer a read of the conversation's history stands on — what
 *  Engager last saw in it — where LinkedIn keeps no draft on it; null where
 *  only its page can say whose words wait there. */
function historyComposer(thread: InboxThread, row: DmThreadRow | undefined): DmThreadRead["composer"] | null {
  if (thread.hasDraft !== false || thread.group) return null;
  return row?.humanDraftHash ? { hasDraft: true, draftHash: row.humanDraftHash } : { hasDraft: false };
}

/** Whose profile each member urn in a conversation is, as Engager's reads
 *  tied them — what its own last read kept, and what Engager knows of its one
 *  other person ({@link knownMemberProfiles}) — so its history can say who
 *  is in it without its page. */
function membersOf(
  thread: InboxThread,
  row: DmThreadRow | undefined,
  known: ReadonlyMap<string, string>,
): KnownMember[] {
  const kept = knownMembers(row?.participants);
  const urn = soleMemberUrn(thread);
  const profileId = urn === null ? undefined : known.get(urn);
  return urn === null || profileId === undefined || kept.some((member) => member.memberUrn === urn)
    ? kept
    : [...kept, { memberUrn: urn, profileId }];
}

/**
 * Which conversations the inbox showed this wake observes, and what it keeps
 * of the rest: every conversation already kept moves its `last_observed_at`
 * and takes the list's unread count and last time; one beside a conversation's
 * person that is a group is kept as one, unread; one the owner has with
 * someone Engager knows is held for them ({@link holdOwnersConversation}),
 * and one held for them keeps only what the list says of it
 * ({@link recordHeldCard}) — `recorded` counts the person's messages both
 * kept.
 *
 * One is observed only when the list shows something new FROM the other
 * side: a moved conversation a conversation holds, or one beside a conversation's
 * person that this account has not answered last. One whose last message is
 * the account's own waits for the person's answer, which shows that message
 * too. Where the list alone cannot stand for the read, the conversation is
 * opened — which marks it seen on LinkedIn — threads already bound first,
 * then the newest, at most {@link MAX_THREAD_OPENS_PER_WAKE}. Everything else
 * is the owner's and is left alone.
 *
 * A read begins where the campaign's does ({@link observedSince}); one of a
 * conversation already bound, from when Engager began keeping it where that
 * came first.
 */
async function planThreadReads(
  tx: Tx,
  channel: Channel,
  inbox: InboxRead,
  observation: Awaited<ReturnType<typeof campaignObservation>>,
  now: number,
): Promise<{ reads: PlannedRead[]; recorded: number }> {
  const since = observedSince(observation.policy, observation.anchorMs, now);
  const threadIds = inbox.threads.map((thread) => thread.threadId);
  const kept = new Map<string, DmThreadRow>(
    threadIds.length === 0
      ? []
      : (
          await tx
            .select()
            .from(dmThreads)
            .where(
              and(
                eq(dmThreads.channelId, channel.id),
                inArray(dmThreads.providerThreadId, threadIds),
              ),
            )
        ).map((row) => [row.providerThreadId, row]),
  );
  const people = await conversationPeople(tx, channel.id);
  const members = await knownMemberProfiles(
    tx,
    channel.id,
    inbox.threads.flatMap((thread) => soleMemberUrn(thread) ?? []),
  );
  const bound: PlannedRead[] = [];
  const candidates: PlannedRead[] = [];
  // Bound conversations where the account wrote last: read after the ones
  // waiting on an answer, so what the owner wrote on LinkedIn is recorded
  // without holding back what a person wrote.
  const ownerLast: PlannedRead[] = [];
  let recorded = 0;
  /** Hold the conversation for the owner where it is theirs with someone
   *  Engager knows; "read" where it is not, for the rules below. */
  const hold = async (thread: InboxThread, profileId: string | undefined, digest: string) => {
    if (profileId === undefined) return "read";
    const owners = await holdOwnersConversation(tx, {
      channelId: channel.id,
      listed: thread,
      profileId,
      inboxDigest: digest,
      observedAt: inbox.observedAt,
      now,
    });
    if (owners.kind === "held" && owners.recorded) recorded += 1;
    return owners.kind;
  };
  for (const thread of inbox.threads) {
    const digest = inboxDigest(thread);
    const row = kept.get(thread.threadId);
    const theirs = !thread.lastMessage.fromSelf;
    // Who the one other person is, by the profile Engager knows the member
    // urn the list names them by.
    const urn = soleMemberUrn(thread);
    const person = urn === null ? undefined : members.get(urn);
    if (row) {
      await tx
        .update(dmThreads)
        .set({ lastObservedAt: inbox.observedAt, ...listedState(thread), updatedAt: now })
        .where(eq(dmThreads.id, row.id));
      if (row.lastInboxDigest === digest && !namedSince(row, person, people.ids)) continue;
      if (thread.group || row.binding === "group") {
        await recordGroupCard(tx, groupCard(channel.id, thread, digest, inbox.observedAt, now));
      } else if (row.binding === "bound" && row.ownerHeldAt !== null) {
        const held = { thread: row, listed: thread, inboxDigest: digest, observedAt: inbox.observedAt, now };
        if (await recordHeldCard(tx, held)) recorded += 1;
      } else if (row.binding === "bound") {
        const planned: PlannedRead = {
          thread,
          digest,
          listed: listSuffices(inbox, thread, row),
          composer: historyComposer(thread, row),
          members: membersOf(thread, row, members),
          since: observedSince(observation.policy, Math.min(observation.anchorMs, row.createdAt), now),
        };
        if (theirs) bound.push(planned);
        else if (!(await engagerWroteLast(tx, row, thread))) ownerLast.push(planned);
      } else if (
        (await hold(thread, person, digest)) === "read" &&
        theirs &&
        unmatchedMayBind(row, person, people.ids)
      ) {
        candidates.push({
          thread,
          digest,
          listed: null,
          composer: historyComposer(thread, row),
          members: membersOf(thread, row, members),
          since,
        });
      }
      continue;
    }
    if ((await hold(thread, person, digest)) !== "read") continue;
    const beside =
      (person !== undefined && people.ids.has(person)) ||
      thread.participants.some(
        (participant) =>
          (participant.profileId !== null && people.ids.has(participant.profileId)) ||
          people.names.has(nameKey(participant.displayName)),
      );
    if (!beside) continue;
    if (thread.group) {
      await recordGroupCard(tx, groupCard(channel.id, thread, digest, inbox.observedAt, now));
    } else if (theirs) {
      candidates.push({
        thread,
        digest,
        listed: null,
        composer: historyComposer(thread, undefined),
        members: membersOf(thread, undefined, members),
        since,
      });
    }
  }
  const reads = [...bound, ...candidates, ...ownerLast];
  const opened = new Set(reads.filter((read) => read.listed === null).slice(0, MAX_THREAD_OPENS_PER_WAKE));
  return { reads: reads.filter((read) => read.listed !== null || opened.has(read)), recorded };
}

/** Whether the account's message the list shows last on a bound conversation
 *  is one of Engager's own DMs there (`engagerSent`): a send of ours moves
 *  the card as the owner's own words on LinkedIn do, and only theirs need
 *  the conversation opened. */
async function engagerWroteLast(tx: Tx, row: DmThreadRow, thread: InboxThread): Promise<boolean> {
  const [conversation] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.canonicalDmThreadId, row.id));
  if (!conversation) return true;
  const last = { messageId: thread.lastMessage.messageId ?? "", fromSelf: true, textHash: thread.lastMessage.textHash };
  return (await engagerSent(tx, conversation.id, [last])).size > 0;
}

/**
 * The read the list's last message stands for, on a conversation a conversation
 * holds — or null where only opening it can say what is new:
 *
 *   - the list carries the message itself, by LinkedIn's own id, and is not
 *     a group's;
 *   - it is from the person the conversation holds — by member urn where the list
 *     and the thread both name one, else by profile id — and the only other
 *     person in it;
 *   - it is the one message LinkedIn counts unread — several, and only the
 *     page shows them all;
 *   - LinkedIn keeps no draft on it — whose words a draft holds, only the
 *     page's composer says;
 *   - the owner has not read it since Engager last opened it — a message the
 *     owner wrote there is shown only by the page, and reading it is what
 *     writing in it starts with.
 *
 * The read keeps what Engager already knows of the conversation — who the
 * account and the person are in it, the composer its last read saw — and is
 * recorded as the list's, never as a read of the page.
 */
function listSuffices(inbox: InboxRead, thread: InboxThread, row: DmThreadRow): DmThreadRead | null {
  const { messageId, text, authorProfileId, fromSelf, textHash, at } = thread.lastMessage;
  const self = row.participants.filter((participant) => participant.isSelf);
  const person = row.participants.filter((participant) => !participant.isSelf);
  const [other] = thread.participants;
  if (
    messageId === undefined ||
    text === undefined ||
    inbox.sessionId === undefined ||
    fromSelf ||
    thread.group ||
    row.binding !== "bound" ||
    self.length !== 1 ||
    person.length !== 1 ||
    person[0]!.profileId === null ||
    thread.participants.length !== 1 ||
    !samePerson(other!, person[0]!) ||
    // The sender is the one other person; a profile the list names for it
    // must be theirs.
    (authorProfileId != null && authorProfileId !== person[0]!.profileId) ||
    thread.unreadCount === undefined ||
    thread.unreadCount > 1 ||
    thread.hasDraft !== false ||
    thread.lastReadAt === undefined ||
    (thread.lastReadAt !== null &&
      (row.lastThreadReadAt === null || thread.lastReadAt > row.lastThreadReadAt))
  ) {
    return null;
  }
  return {
    threadId: thread.threadId,
    participants: [
      self[0]!,
      // The list's member urn for the person, where the thread had none yet.
      person[0]!.memberUrn === undefined && other!.memberUrn !== undefined
        ? { ...person[0]!, memberUrn: other!.memberUrn }
        : person[0]!,
    ],
    group: false,
    messages: [
      {
        messageId,
        fromSelf: false,
        authorProfileId: person[0]!.profileId,
        text,
        textHash,
        sentAt: at,
        observedAt: inbox.observedAt,
      },
    ],
    complete: false,
    composer: row.humanDraftHash ? { hasDraft: true, draftHash: row.humanDraftHash } : { hasDraft: false },
    observedAt: inbox.observedAt,
    sessionId: inbox.sessionId,
    pageFingerprint: inbox.pageFingerprint,
    selectorPack: inbox.selectorPack,
  };
}

/** Whether a conversation a read left unmatched is worth opening again: only
 *  where the person it is with has a conversation now — named by id on its read,
 *  or `person`, the profile Engager knows the member urn the list names them
 *  by. One named by someone else's id, or by none, matched the hint on a name
 *  alone, and a name is all that would bring it back. */
function unmatchedMayBind(
  row: DmThreadRow,
  person: string | undefined,
  conversationIds: ReadonlySet<string>,
): boolean {
  return (
    (person !== undefined && conversationIds.has(person)) ||
    row.participants.some(
      (participant) =>
        !participant.isSelf && participant.profileId !== null && conversationIds.has(participant.profileId),
    )
  );
}

/** Whether an unmatched conversation's person is someone a conversation has whom
 *  its last read could not name: the member urn the list names them by known
 *  since as that conversation's person's profile (`person`) — a read of their
 *  profile, a reply that carried both. Such a conversation gets another look
 *  though nothing in it moved; once a read names them, only a move does. */
function namedSince(row: DmThreadRow, person: string | undefined, conversationIds: ReadonlySet<string>): boolean {
  return (
    row.binding === "unmatched" &&
    person !== undefined &&
    conversationIds.has(person) &&
    !row.participants.some((participant) => !participant.isSelf && participant.profileId === person)
  );
}

function groupCard(
  channelId: number,
  thread: InboxThread,
  digest: string,
  observedAt: number,
  now: number,
) {
  return {
    channelId,
    threadId: thread.threadId,
    participants: thread.participants.map((participant) => ({ ...participant, isSelf: false })),
    inboxDigest: digest,
    observedAt,
    now,
  };
}

/**
 * The people with a conversation on this account, as the inbox can hint at them:
 * their profile ids, and the names a read of theirs carried — the reply under
 * our comment, a read of their profile, their lead.
 */
async function conversationPeople(
  tx: Tx,
  channelId: number,
): Promise<{ ids: Set<string>; names: Set<string> }> {
  const people = await tx
    .select({ profileId: conversations.authorProfileId })
    .from(conversations)
    .where(eq(conversations.channelId, channelId));
  const ids = new Set(people.map((person) => person.profileId));
  if (ids.size === 0) return { ids, names: new Set() };
  const profileIds = [...ids];
  const replied = await tx
    .selectDistinct({ name: incomingComments.authorName })
    .from(incomingComments)
    .innerJoin(conversationSources, eq(conversationSources.incomingCommentId, incomingComments.id))
    .innerJoin(conversations, eq(conversations.id, conversationSources.conversationId))
    .where(and(eq(conversations.channelId, channelId), isNotNull(incomingComments.authorName)));
  const profiled = await tx
    .select({
      name: sql<string | null>`${authorProfiles.identityEvidence}->'read'->'profile'->>'displayName'`,
    })
    .from(authorProfiles)
    .where(inArray(authorProfiles.profileId, profileIds));
  const led = await tx
    .select({ name: leads.name })
    .from(leads)
    .where(and(inArray(leads.profileId, profileIds), isNotNull(leads.name)));
  const names = new Set<string>();
  for (const row of [...replied, ...profiled, ...led]) if (row.name) names.add(nameKey(row.name));
  return { ids, names };
}
