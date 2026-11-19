import { and, desc, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  actions,
  campaigns,
  channels,
  dmThreads,
  engagedProfiles,
  incomingInvitations,
  jobs,
  conversations,
  liveChecks,
  type ActionRow,
  type DmThreadRow,
  type ConversationRow,
  type LiveCheckCapability,
  type LiveCheckReadProof,
  type RecordedLiveCheckCapability,
  type LiveCheckRow,
  type LiveCheckSubject,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { approveAction } from "../actions/approval";
import { invitationRefusal, inviteTargetFor } from "../actions/invite";
import { reserveAction, type ReserveOutcome } from "../actions/ledger";
import { queueOwnerDm } from "../actions/ownerDm";
import { currentGeneration } from "../actions/pause";
import { openWithdrawal, queueWithdrawal } from "../actions/withdrawInvite";
import type { CapabilityKind } from "../connector/capabilities";
import type { CapabilitySurface } from "../connector/resolve";
import type { ActionReceipt } from "../execution/actionGate";
import { acceptanceTarget } from "../invitations/accept";
import { observeIncomingInvitations } from "../invitations/observe";
import { enqueue } from "../jobs/queue";
import { knownMembers } from "../conversations/dm";
import { outstandingInvitation } from "../conversations/record";
import { refreshRelationship } from "../conversations/refresh";
import { isConnectorBackoff, isConnectorSignIn } from "../linkedin/connectorError";
import { MAX_HISTORY_MESSAGES, type ConversationHistory, type DmThreadRead } from "../linkedin/driver";
import { pauseChannelForConnectorBackoff } from "../ratelimit/killswitch";
import { channelCeilings, reserveResearchRead } from "../ratelimit/ledger";
import { CHECKED_KINDS, isLiveCheckCapability, isOptionalLiveCheck, openAttempt, recordFirstSend, recordedLiveChecks, type OptionalLiveCheckRow } from "./records";

/**
 * AN OWNER'S LIVE CHECK, PRESSED IN ENGAGER (INV-31) — optional: the
 * account's first confirmed send of a write verifies it too
 * (`liveChecks/records.ts`). The check is for the owner who wants it
 * verified before any draft of it comes.
 *
 * Two steps, each the owner's press, on one account:
 *
 *   read   The owner picks the person or the conversation from Engager's own
 *          data — a conversation's person to invite or whose invitation from us to
 *          withdraw, a pending incoming invitation, an inbox conversation
 *          bound to a conversation — and Engager runs that surface's
 *          existing read op once, on the serial lane like every browser job
 *          (`live_check_read`). What it saw is kept on the attempt; the owner
 *          says whether it matches LinkedIn. Wrong ends the attempt and
 *          records nothing.
 *   write  On a matching read, the owner writes the exact words — the note,
 *          the DM — or confirms the invitation to accept or to withdraw, and
 *          presses once.
 *          It is reserved through the ledger's one door and approved by that
 *          press: the normal gate, journal and re-read path. The words are
 *          the owner's, so it goes out as theirs (`origin: owner`, INV-1) —
 *          spaced, never capped, outside any sending window — and a Stop, an
 *          opt-out and the person's exclusion still hold it. The attempt
 *          names that one action.
 *
 * The check is recorded only when the write's own re-read confirms it
 * ({@link settleLiveCheck}). An uncertain write is read again by the
 * gate's reconciliation, never pressed again. Nothing here runs from a wake,
 * and nothing records a check but the owner's presses: no agent tool calls
 * these.
 */

/** Who pressed: the owner, through one of Engager's own surfaces. */
export type OwnerActor = `owner:${string}`;

export type LiveCheckRefusal =
  | "live_check_not_found"
  | "live_check_no_account"
  | "live_check_recorded"
  | "live_check_in_progress"
  | "live_check_not_ready"
  | "live_check_subject_invalid"
  | "live_check_text_required"
  | "live_check_write_refused";

/** Why an owner's press on a live check was refused. Nothing was written. */
export class LiveCheckError extends AppError {
  constructor(
    code: LiveCheckRefusal,
    message: string,
    readonly recovery: string,
  ) {
    super(code, message, code === "live_check_not_found" ? 404 : code === "live_check_text_required" ? 400 : 409);
  }
}

/** The read each check's surface leans on — the capability its job is
 *  granted — and what the owner picks for it. */
export const LIVE_CHECK_READS: Readonly<
  Record<LiveCheckCapability, { kind: CapabilityKind; subject: LiveCheckSubject["kind"] }>
> = {
  send_invitation: { kind: "relationship", subject: "conversation" },
  accept_invitation: { kind: "invitations_read", subject: "invitation" },
  send_dm: { kind: "dm_read", subject: "dm_thread" },
  withdraw_invitation: { kind: "relationship", subject: "conversation" },
};

/** The longest invitation note the write takes; the composer's own printed
 *  limit, read at the press, is the one that binds. */
export const LIVE_CHECK_NOTE_MAX = 300;

/** An action that has settled, one way or the other. */
const SETTLED_ACTION = ["confirmed", "definitely_not_sent", "blocked", "cancelled"] as const;

// ---------------------------------------------------------------------------
// What the owner can pick
// ---------------------------------------------------------------------------

/** One thing a check can be run on, as the picker lists it. */
export type LiveCheckOption = {
  subject: LiveCheckSubject;
  /** Whom it reaches, by name where Engager has one. */
  label: string;
  /** The campaign it belongs to. */
  campaign: string;
};

const OPTIONS_LIMIT = 50;

/**
 * What a check can be run on, from Engager's own data on the account: for
 * Invite, an open conversation's person a campaign owns who is not connected or
 * invited either way; for Accept invite, a pending request tied to such a
 * conversation; for DM, a two-person conversation a read bound to one; for
 * Withdraw invite, such a person whose invitation from us is still pending
 * with no withdrawal of it open. Newest first.
 */
export async function liveCheckOptions(tx: Tx, capability: LiveCheckCapability): Promise<LiveCheckOption[]> {
  const channel = await channelCeilings(tx);
  if (!channel) return [];
  switch (capability) {
    case "send_invitation": {
      const rows = await tx
        .select({ conversation: conversations, campaign: campaigns.name, name: engagedProfiles.name })
        .from(conversations)
        .innerJoin(campaigns, eq(campaigns.id, conversations.owningCampaignId))
        .leftJoin(engagedProfiles, eq(engagedProfiles.profileId, conversations.authorProfileId))
        .where(
          and(
            eq(conversations.channelId, channel.id),
            isNull(conversations.closedReason),
            notInArray(conversations.relationship, ["connected", "outgoing_pending", "incoming_pending"]),
          ),
        )
        .orderBy(desc(conversations.id))
        .limit(OPTIONS_LIMIT);
      const open: LiveCheckOption[] = [];
      for (const row of rows) {
        if ((await invitationRefusal(tx, row.conversation)) !== null) continue;
        open.push({
          subject: { kind: "conversation", conversationId: row.conversation.id },
          label: row.name ?? row.conversation.authorProfileId,
          campaign: row.campaign,
        });
      }
      return open;
    }
    case "accept_invitation": {
      const rows = await tx
        .select({ invitation: incomingInvitations, campaign: campaigns.name })
        .from(incomingInvitations)
        .innerJoin(conversations, eq(conversations.id, incomingInvitations.conversationId))
        .innerJoin(campaigns, eq(campaigns.id, conversations.owningCampaignId))
        .where(
          and(
            eq(incomingInvitations.channelId, channel.id),
            eq(incomingInvitations.status, "pending"),
            isNull(conversations.closedReason),
          ),
        )
        .orderBy(desc(incomingInvitations.observedAt))
        .limit(OPTIONS_LIMIT);
      return rows.map((row) => ({
        subject: { kind: "invitation", invitationId: row.invitation.id },
        label: row.invitation.senderDisplayName ?? row.invitation.senderProfileId,
        campaign: row.campaign,
      }));
    }
    case "send_dm": {
      const rows = await tx
        .select({ thread: dmThreads, campaign: campaigns.name, person: conversations.authorProfileId })
        .from(dmThreads)
        .innerJoin(conversations, eq(conversations.id, dmThreads.conversationId))
        .innerJoin(campaigns, eq(campaigns.id, conversations.owningCampaignId))
        .where(
          and(
            eq(dmThreads.channelId, channel.id),
            eq(dmThreads.binding, "bound"),
            isNotNull(dmThreads.lastMessageId),
            isNull(conversations.closedReason),
          ),
        )
        .orderBy(desc(dmThreads.lastObservedAt))
        .limit(OPTIONS_LIMIT);
      return rows.map((row) => ({
        subject: { kind: "dm_thread", threadId: row.thread.id },
        label:
          row.thread.participants.find((participant) => participant.profileId === row.person)?.displayName ??
          row.person,
        campaign: row.campaign,
      }));
    }
    case "withdraw_invitation": {
      const rows = await tx
        .select({ conversation: conversations, campaign: campaigns.name, name: engagedProfiles.name })
        .from(conversations)
        .innerJoin(campaigns, eq(campaigns.id, conversations.owningCampaignId))
        .leftJoin(engagedProfiles, eq(engagedProfiles.profileId, conversations.authorProfileId))
        .where(
          and(
            eq(conversations.channelId, channel.id),
            isNull(conversations.closedReason),
            eq(conversations.relationship, "outgoing_pending"),
          ),
        )
        .orderBy(desc(conversations.id))
        .limit(OPTIONS_LIMIT);
      const open: LiveCheckOption[] = [];
      for (const row of rows) {
        if ((await withdrawalRefusal(tx, row.conversation)) !== null) continue;
        open.push({
          subject: { kind: "conversation", conversationId: row.conversation.id },
          label: row.name ?? row.conversation.authorProfileId,
          campaign: row.campaign,
        });
      }
      return open;
    }
  }
}

/** Why the conversation's invitation from us is not one to withdraw now: none is
 *  pending as its last read and its log stand, or a withdrawal of it is
 *  already open. Null when one is. */
async function withdrawalRefusal(tx: Tx, conversation: ConversationRow): Promise<string | null> {
  if (conversation.relationship !== "outgoing_pending" || (await outstandingInvitation(tx, conversation.id)) === null) {
    return "no invite of ours to them is pending";
  }
  return (await openWithdrawal(tx, conversation.id)) === null ? null : "a withdrawal of it is already open";
}

/** The conversation a subject reaches, checked as it stands: on the account, open,
 *  owned by a campaign — and, per check, someone to invite, a request still
 *  pending, a conversation still bound. */
async function subjectConversation(
  tx: Tx,
  channelId: number,
  capability: LiveCheckCapability,
  subject: LiveCheckSubject,
): Promise<{ conversation: ConversationRow; campaignId: number }> {
  const invalid = (message: string, recovery = "Pick another from the list.") =>
    new LiveCheckError("live_check_subject_invalid", message, recovery);
  if (subject.kind !== LIVE_CHECK_READS[capability].subject) {
    throw invalid("That is not something this check reads.");
  }
  let conversationId: number;
  switch (subject.kind) {
    case "conversation":
      conversationId = subject.conversationId;
      break;
    case "invitation": {
      const [invitation] = await tx
        .select()
        .from(incomingInvitations)
        .where(and(eq(incomingInvitations.id, subject.invitationId), eq(incomingInvitations.channelId, channelId)));
      if (!invitation) throw invalid("That request is not on this account.");
      if (invitation.status !== "pending") throw invalid("That request is no longer pending.");
      if (invitation.conversationId === null) {
        throw invalid(
          "That request is not tied to a conversation yet.",
          "Link it to the person who replied on Channels → LinkedIn → Overview, or pick a request that is.",
        );
      }
      conversationId = invitation.conversationId;
      break;
    }
    case "dm_thread": {
      const [thread] = await tx
        .select()
        .from(dmThreads)
        .where(and(eq(dmThreads.id, subject.threadId), eq(dmThreads.channelId, channelId)));
      if (!thread) throw invalid("That conversation is not on this account.");
      if (thread.binding !== "bound" || thread.conversationId === null || thread.lastMessageId === null) {
        throw invalid("That conversation is not bound to one person's conversation.");
      }
      conversationId = thread.conversationId;
      break;
    }
  }
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.channelId, channelId)));
  if (!conversation) throw invalid("That person is not on this account.");
  if (conversation.closedReason !== null) throw invalid("That conversation is closed.");
  if (conversation.owningCampaignId === null) throw invalid("That conversation belongs to no campaign.");
  if (capability === "send_invitation") {
    const refused = await invitationRefusal(tx, conversation);
    if (refused !== null) throw invalid(`They cannot be invited: ${refused.replaceAll("_", " ")}.`);
  }
  if (capability === "withdraw_invitation") {
    const refused = await withdrawalRefusal(tx, conversation);
    if (refused !== null) throw invalid(`Nothing to withdraw: ${refused}.`);
  }
  return { conversation, campaignId: conversation.owningCampaignId };
}

// ---------------------------------------------------------------------------
// Step one: the live read
// ---------------------------------------------------------------------------

/** The account the checks are recorded on, or why there is none. */
async function account(tx: Tx) {
  const channel = await channelCeilings(tx);
  if (!channel) {
    throw new LiveCheckError(
      "live_check_no_account",
      "No LinkedIn account is connected.",
      "Connect the account on Channels first.",
    );
  }
  return channel;
}

/** Make room for a new attempt: one waiting on the owner's word, one whose
 *  read job ended without a word, or one whose write has settled is ended;
 *  one still reading or still sending is not. */
async function retireOpenAttempt(tx: Tx, channelId: number, capability: LiveCheckCapability, now: number) {
  const open = await openAttempt(tx, channelId, capability);
  if (!open) return;
  let closedReason: string | null = null;
  if (open.state === "read") closedReason = "abandoned";
  if (open.state === "reading" && !(await readQueued(tx, open))) closedReason = "read_failed:interrupted";
  if (open.state === "writing" && open.actionExecutionId !== null) {
    const [action] = await tx
      .select({ status: actions.status })
      .from(actions)
      .where(eq(actions.id, open.actionExecutionId));
    if (action && (SETTLED_ACTION as readonly string[]).includes(action.status)) {
      closedReason = `not_sent:${action.status}`;
    }
  }
  if (closedReason === null) {
    throw new LiveCheckError(
      "live_check_in_progress",
      open.state === "reading"
        ? "This check's read is still running."
        : "This check's write has not settled yet.",
      "Wait for it here; the page shows it when it lands.",
    );
  }
  await tx
    .update(liveChecks)
    .set({ state: "closed", closedReason, updatedAt: now })
    .where(eq(liveChecks.id, open.id));
}

/**
 * Start a check: the owner picked what to read. Queues the one read, on the
 * account's serial browser lane, and nothing else — no check is recorded.
 */
export async function startLiveRead(
  tx: Tx,
  input: { capability: LiveCheckCapability; subject: LiveCheckSubject; by: OwnerActor; now?: number },
): Promise<LiveCheckRow> {
  if (!isLiveCheckCapability(input.capability)) {
    throw new LiveCheckError("live_check_subject_invalid", "This write is verified by its first approved send.", "Queue the reply from its public reply box.");
  }
  const now = input.now ?? Date.now();
  const channel = await account(tx);
  const [recorded] = await tx
    .select({ id: liveChecks.id })
    .from(liveChecks)
    .where(
      and(
        eq(liveChecks.channelId, channel.id),
        eq(liveChecks.capability, input.capability),
        eq(liveChecks.state, "recorded"),
      ),
    );
  if (recorded) {
    throw new LiveCheckError(
      "live_check_recorded",
      "This write is already verified on this account, by its first send or a check.",
      "Clear it first to run it again.",
    );
  }
  await retireOpenAttempt(tx, channel.id, input.capability, now);
  await subjectConversation(tx, channel.id, input.capability, input.subject);
  const [attempt] = await tx
    .insert(liveChecks)
    .values({
      channelId: channel.id,
      capability: input.capability,
      state: "reading",
      subject: input.subject,
      startedBy: input.by,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await enqueue(tx, {
    type: "live_check_read",
    payload: { liveCheckId: attempt!.id } satisfies LiveCheckReadPayload,
    idempotencyKey: readJobKey(attempt!),
    // One read, once: a failure is the owner's to see, not the queue's to
    // repeat on the account.
    maxAttempts: 1,
    nextRunAt: now,
  });
  return attempt!;
}

export type LiveCheckReadPayload = { liveCheckId: number };

const readJobKey = (attempt: Pick<LiveCheckRow, "id">) => `live_check_read:${attempt.id}`;

/** Whether an attempt's read job is still queued or running. `jobs` is
 *  outside RLS, so the org is named. */
async function readQueued(tx: Tx, attempt: Pick<LiveCheckRow, "id" | "organizationId">): Promise<boolean> {
  const [job] = await tx
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.organizationId, attempt.organizationId), eq(jobs.idempotencyKey, readJobKey(attempt))));
  return job?.status === "queued" || job?.status === "running";
}

/** What one read came to, as the job counts it. */
export type LiveReadOutcome = "read" | "refused" | "failed" | "gone";

/**
 * The read itself, for the `live_check_read` job: the surface's existing read
 * op, once, through the grant the job resolved for the account — the
 * person's own profile, the invitations page, or the conversation. What it
 * saw lands on the attempt for the owner to compare. A read the account's
 * budget, window or stops refuse, or one that fails, ends the attempt and
 * says why; nothing is retried behind the owner's back.
 */
export async function performLiveRead(input: {
  organizationId: string;
  liveCheckId: number;
  surface: CapabilitySurface<"relationship" | "invitations_read" | "dm_read">;
  now?: number;
}): Promise<LiveReadOutcome> {
  const { organizationId, surface } = input;
  const now = input.now ?? Date.now();
  const attempt = await withOrg(organizationId, async (tx) => {
    const [row] = await tx.select().from(liveChecks).where(eq(liveChecks.id, input.liveCheckId));
    return row?.state === "reading" && isOptionalLiveCheck(row) ? row : null;
  });
  if (!attempt) return "gone";
  const end = async (outcome: Exclude<LiveReadOutcome, "read" | "gone">, reason: string) => {
    await withOrg(organizationId, (tx) =>
      tx
        .update(liveChecks)
        .set({ state: "closed", closedReason: `read_${outcome}:${reason}`.slice(0, 200), updatedAt: now })
        .where(and(eq(liveChecks.id, attempt.id), eq(liveChecks.state, "reading"))),
    );
    return outcome;
  };
  let proof: LiveCheckReadProof | { refused: string } | { failed: string };
  try {
    proof = await readSubject(organizationId, attempt, surface, now);
  } catch (error) {
    if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(organizationId, error);
    return end("failed", error instanceof Error ? error.message : String(error));
  }
  if ("refused" in proof) return end("refused", proof.refused);
  if ("failed" in proof) return end("failed", proof.failed);
  const read = proof;
  await withOrg(organizationId, (tx) =>
    tx
      .update(liveChecks)
      .set({ state: "read", readProof: read, updatedAt: now })
      .where(and(eq(liveChecks.id, attempt.id), eq(liveChecks.state, "reading"))),
  );
  return "read";
}

/** One read of the attempt's subject, and the values the owner compares. */
async function readSubject(
  organizationId: string,
  attempt: OptionalLiveCheckRow,
  surface: CapabilitySurface<"relationship" | "invitations_read" | "dm_read">,
  now: number,
): Promise<LiveCheckReadProof | { refused: string } | { failed: string }> {
  const subject = attempt.subject;
  switch (subject.kind) {
    case "conversation": {
      const refreshed = await refreshRelationship({
        organizationId,
        driver: surface,
        conversationId: subject.conversationId,
        now,
      });
      if (refreshed.status === "refused") return { refused: refreshed.reason };
      if (refreshed.status !== "read") return { failed: refreshed.status };
      const { read } = refreshed;
      return {
        op: "read_relationship",
        readAt: read.observedAt,
        sessionId: read.sessionId,
        pageFingerprint: read.pageFingerprint,
        observed: {
          profileId: read.profile.id,
          displayName: read.profile.displayName,
          verified: read.profile.verified,
          degree: read.degree,
          pending: read.pending,
          noteLimit: read.note.limitChars,
        },
      };
    }
    case "invitation": {
      const invitation = await withOrg(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(incomingInvitations)
          .where(eq(incomingInvitations.id, subject.invitationId));
        return row ?? null;
      });
      if (!invitation) return { failed: "invitation_gone" };
      const observed = await observeIncomingInvitations({
        organizationId,
        channelId: attempt.channelId,
        driver: surface,
        now,
      });
      if (observed.status === "refused") return { refused: observed.reason };
      if (observed.status !== "read") return { failed: observed.status };
      const { read } = observed;
      const shown = read.invitations.find(
        (candidate) =>
          candidate.invitationId === invitation.invitationId ||
          candidate.sender.profileId === invitation.senderProfileId,
      );
      return {
        op: "read_incoming_invitations",
        readAt: read.observedAt,
        sessionId: read.sessionId,
        pageFingerprint: read.pageFingerprint,
        observed: {
          listed: read.invitations.length,
          others: read.others,
          complete: read.complete,
          truncated: read.truncated,
          shown: shown !== undefined,
          senderProfileId: shown?.sender.profileId ?? invitation.senderProfileId,
          displayName: shown?.sender.displayName ?? invitation.senderDisplayName,
        },
      };
    }
    case "dm_thread": {
      const reserved = await withOrg(
        organizationId,
        async (tx): Promise<{ thread: DmThreadRow } | { refused: string } | { failed: string }> => {
          const [thread] = await tx.select().from(dmThreads).where(eq(dmThreads.id, subject.threadId));
          const [channel] = await tx.select().from(channels).where(eq(channels.id, attempt.channelId));
          if (!thread || !channel) return { failed: "conversation_gone" };
          const decision = await reserveResearchRead({ db: tx, channel, read: "thread_read", now });
          return decision.ok ? { thread } : { refused: decision.reason };
        },
      );
      if (!("thread" in reserved)) return reserved;
      const { thread } = reserved;
      const read = await conversationRead(surface, thread);
      if (read === null) return { failed: "unsupported" };
      const others = read.participants.filter((participant) => !participant.isSelf);
      const newest = read.messages.at(-1)?.messageId ?? null;
      return {
        // The read that ran: a history is not a page, and shows no composer.
        op: "composer" in read ? "read_dm_thread" : "read_conversation_messages",
        readAt: read.observedAt,
        sessionId: read.sessionId,
        pageFingerprint: read.pageFingerprint,
        observed: {
          participants: read.participants.length,
          group: read.group,
          profileId: others.length === 1 ? (others[0]!.profileId ?? null) : null,
          displayName: others.length === 1 ? others[0]!.displayName : null,
          messages: read.messages.length,
          complete: read.complete,
          // A history shows no composer: whose words wait there is unknown.
          hasDraft: "composer" in read ? read.composer.hasDraft : null,
          newestMessageId: newest,
          // A message Engager has not taken in yet holds the DM at the gate
          // (`thread_moved`) until the inbox read records it.
          newestRecorded: newest !== null && newest === thread.lastMessageId,
        },
      };
    }
  }
}

/** The conversation as its check reads it: from LinkedIn's own history of it,
 *  without opening it — no seen receipt, no delivery acknowledgement — where
 *  the connector reads one and it answers, the people in it by the profiles
 *  Engager's reads tied their member urns to; else its page. Null where the
 *  connector reads no conversation's page. */
async function conversationRead(
  surface: CapabilitySurface<"dm_read">,
  thread: DmThreadRow,
): Promise<ConversationHistory | DmThreadRead | null> {
  if (!surface.readDmThread) return null;
  if (surface.readConversationMessages) {
    try {
      return await surface.readConversationMessages(thread.providerThreadId, {
        limit: MAX_HISTORY_MESSAGES,
        members: knownMembers(thread.participants),
      });
    } catch (error) {
      if (isConnectorBackoff(error) || isConnectorSignIn(error)) throw error;
      console.warn(`[live-check] the conversation's history was not read: ${(error as Error).message}; opening it`);
    }
  }
  return surface.readDmThread(thread.providerThreadId, {});
}

/** A read attempt, locked, that the owner may act on now. */
async function attemptFor(tx: Tx, id: number): Promise<OptionalLiveCheckRow> {
  const [row] = await tx.select().from(liveChecks).where(eq(liveChecks.id, id)).for("update");
  if (!row || !isOptionalLiveCheck(row)) {
    throw new LiveCheckError("live_check_not_found", `Live check ${id} not found.`, "Open it from Channels → LinkedIn.");
  }
  return row;
}

/**
 * The owner's word on what the read showed. Matches LinkedIn: the write step
 * opens. Wrong: the attempt ends and nothing is recorded — what it saw stays
 * on it, for the report.
 */
export async function judgeLiveRead(
  tx: Tx,
  input: { id: number; matches: boolean; by: OwnerActor; now?: number },
): Promise<LiveCheckRow> {
  const now = input.now ?? Date.now();
  const attempt = await attemptFor(tx, input.id);
  if (attempt.state !== "read" || attempt.readConfirmedAt !== null) {
    throw new LiveCheckError(
      "live_check_not_ready",
      "This check has no read waiting for your word.",
      "Run the read first, or start the check again.",
    );
  }
  const [updated] = await tx
    .update(liveChecks)
    .set(
      input.matches
        ? { readConfirmedAt: now, updatedAt: now }
        : { state: "closed", closedReason: "read_wrong", updatedAt: now },
    )
    .where(eq(liveChecks.id, attempt.id))
    .returning();
  return updated!;
}

// ---------------------------------------------------------------------------
// Step two: the one live write
// ---------------------------------------------------------------------------

/**
 * The one write, on the owner's press: reserved through the ledger's one door
 * for the person the read checked, approved by this press, and named on the
 * attempt. The owner wrote the note or the DM, or pressed Accept or Withdraw,
 * so it is theirs (`origin: owner`): the gate spaces it and never caps it,
 * and a DM's words become a voice sample as any DM they write does. The
 * approval queues the drain.
 */
export async function sendLiveWrite(
  tx: Tx,
  input: { id: number; text: string | null; by: OwnerActor; now?: number },
): Promise<{ attempt: LiveCheckRow; action: ActionRow }> {
  const now = input.now ?? Date.now();
  const attempt = await attemptFor(tx, input.id);
  if (attempt.state !== "read" || attempt.readConfirmedAt === null) {
    throw new LiveCheckError(
      "live_check_not_ready",
      "This check's read has not been confirmed.",
      "Say whether the read matches LinkedIn first.",
    );
  }
  const capability = attempt.capability;
  const text = input.text?.trim() ?? "";
  if (capability !== "accept_invitation" && capability !== "withdraw_invitation" && text.length === 0) {
    throw new LiveCheckError(
      "live_check_text_required",
      capability === "send_dm" ? "A DM needs words." : "An invitation needs a note.",
      "Write exactly what to send.",
    );
  }
  if (capability === "send_invitation" && text.length > LIVE_CHECK_NOTE_MAX) {
    throw new LiveCheckError(
      "live_check_text_required",
      `A note is at most ${LIVE_CHECK_NOTE_MAX} characters.`,
      "Shorten it.",
    );
  }
  const { conversation, campaignId } = await subjectConversation(tx, attempt.channelId, capability, attempt.subject);
  const action =
    capability === "send_dm"
      ? (await queueOwnerDm(tx, { conversation, text, by: input.by, now })).action
      : capability === "withdraw_invitation"
        ? await queueWithdrawal(tx, { conversation, by: input.by, now })
        : await approved(tx, await reserveLiveWrite(tx, attempt, conversation, campaignId, text, now), input.by, now);
  const [updated] = await tx
    .update(liveChecks)
    .set({ state: "writing", actionExecutionId: action.id, updatedAt: now })
    .where(eq(liveChecks.id, attempt.id))
    .returning();
  return { attempt: updated!, action };
}

/** Invite's and Accept invite's reservation: the ledger's one door, with no
 *  binding behind it — the owner's press is the proposal. */
async function reserveLiveWrite(
  tx: Tx,
  attempt: LiveCheckRow,
  conversation: ConversationRow,
  campaignId: number,
  text: string,
  now: number,
): Promise<ReserveOutcome> {
  const generationSeen = await currentGeneration(tx);
  const versions = { strategy: null, facts: [], memory: null, voice: null };
  if (attempt.subject.kind === "invitation") {
    const [invitation] = await tx
      .select()
      .from(incomingInvitations)
      .where(eq(incomingInvitations.id, attempt.subject.invitationId));
    return reserveAction(tx, {
      channelId: attempt.channelId,
      campaignId,
      conversationId: conversation.id,
      authorProfileId: conversation.authorProfileId,
      kind: "accept_invite",
      purpose: "acceptance",
      target: acceptanceTarget(invitation!),
      candidate: {
        text: null,
        sources:
          invitation!.conversationEventId === null ? [] : [{ eventId: invitation!.conversationEventId, contentHash: null }],
        versions,
      },
      origin: "owner",
      mode: "review",
      generationSeen,
      now,
    });
  }
  return reserveAction(tx, {
    channelId: attempt.channelId,
    campaignId,
    conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId,
    kind: "invite",
    purpose: "opener",
    target: inviteTargetFor(conversation.authorProfileId),
    candidate: { text, sources: [], versions },
    origin: "owner",
    mode: "review",
    generationSeen,
    now,
  });
}

async function approved(tx: Tx, reserved: ReserveOutcome, by: OwnerActor, now: number): Promise<ActionRow> {
  if (reserved.status !== "reserved") {
    throw new LiveCheckError(
      "live_check_write_refused",
      reserved.status === "duplicate"
        ? `This person already has one on the ledger (${reserved.action.status}).`
        : `The ledger refused it: ${reserved.reason.replaceAll("_", " ")}.`,
      "Settle that one on the person in Inbox, or on the LinkedIn channel's Overview when it holds sending. Or start the check on someone else.",
    );
  }
  return (await approveAction(tx, { id: reserved.action.id, approver: by, now })).action;
}

/**
 * What a settled action means for the account's records, in the settling
 * transaction — the dispatch gate calls it wherever an action settles. The
 * attempt that pressed it, if one did: confirmed by the operation's own
 * re-read — the gate's answer for a click, or a reconciliation read's for an
 * uncertain one — the check is recorded. Anything else that settles it ends
 * the attempt with nothing recorded: an action target that already stood that way
 * (nothing was pressed), the owner's own word on an uncertain one (a look is
 * not the op's re-read), an answer that it did not go out, or a first send
 * recorded while the attempt was open. An action no attempt pressed may be
 * the account's first confirmed send of its kind ({@link recordFirstSend}).
 * `uncertain` waits on the reconciliation read; nothing presses twice.
 *
 * Every resolver reads the record live. The campaigns' projected switches
 * follow from a queued re-projection ({@link enqueueReprojection}), never from
 * here, where a failed re-projection would roll back a settled send.
 */
export async function settleLiveCheck(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  settled: { by: "gate" | "reconcile" | "owner"; clicked: boolean; now: number },
): Promise<void> {
  if (CHECKED_KINDS[row.kind] === undefined || receipt.status === "uncertain") return;
  const [attempt] = await tx
    .select()
    .from(liveChecks)
    .where(and(eq(liveChecks.actionExecutionId, row.id), eq(liveChecks.state, "writing")))
    .for("update");
  const { now } = settled;
  if (!attempt) {
    if (await recordFirstSend(tx, row, receipt, settled)) await enqueueReprojection(tx, row.channelId, now);
    return;
  }
  const closedReason =
    receipt.status !== "confirmed"
      ? `not_sent:${receipt.status}`
      : !settled.clicked || receipt.noop === true
        ? "nothing_pressed"
        : settled.by === "owner"
          ? "owner_resolved"
          : (await recordedLiveChecks(tx, row.channelId)).has(attempt.capability)
            ? "first_send_recorded"
            : null;
  if (closedReason !== null) {
    await tx
      .update(liveChecks)
      .set({ state: "closed", closedReason, updatedAt: now })
      .where(eq(liveChecks.id, attempt.id));
    return;
  }
  await tx
    .update(liveChecks)
    .set({
      state: "recorded",
      writeProof: {
        actionExecutionId: row.id,
        operationId: row.fenceToken,
        settledBy: settled.by === "reconcile" ? "reconcile" : "gate",
        settledAt: now,
        evidence: receipt.evidence,
      },
      recordedBy: attempt.startedBy,
      recordedAt: now,
      updatedAt: now,
    })
    .where(eq(liveChecks.id, attempt.id));
  await enqueueReprojection(tx, row.channelId, now);
}

export type ReprojectCampaignsPayload = { channelId: number };

/**
 * Queue the account's flagged campaigns to be activated again in place, so
 * what they project is drawn against the account's records as they stand,
 * without a new version. The job runs on its own, later, so a failed
 * re-projection leaves the record, and the send that made it, as they are.
 */
export async function enqueueReprojection(tx: Tx, channelId: number, now: number): Promise<void> {
  await enqueue(tx, {
    type: "reproject_campaigns",
    payload: { channelId } satisfies ReprojectCampaignsPayload,
    nextRunAt: now,
  });
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/**
 * The owner withdraws a record — a first send's or a check's: the capability
 * asks the owner again on every campaign on the account, from this
 * transaction, until its next confirmed send — every resolver reads the
 * record live, the gate sends an Automatic reservation of it back for a yes,
 * and the campaigns are queued to be re-projected without it. Never Off.
 */
export async function clearLiveCheck(
  tx: Tx,
  input: { capability: RecordedLiveCheckCapability; by: OwnerActor; now?: number },
): Promise<LiveCheckRow> {
  const now = input.now ?? Date.now();
  const channel = await account(tx);
  const [row] = await tx
    .update(liveChecks)
    .set({ state: "closed", closedReason: "cleared", clearedBy: input.by, clearedAt: now, updatedAt: now })
    .where(
      and(
        eq(liveChecks.channelId, channel.id),
        eq(liveChecks.capability, input.capability),
        eq(liveChecks.state, "recorded"),
      ),
    )
    .returning();
  if (!row) {
    throw new LiveCheckError(
      "live_check_not_found",
      "This check is not recorded on this account.",
      "Nothing to clear.",
    );
  }
  await enqueueReprojection(tx, channel.id, now);
  return row;
}
