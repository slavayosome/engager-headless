import { createHash } from "node:crypto";
import { AppError } from "@engager/common/errors";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  authorProfiles,
  campaigns,
  commentWatches,
  actions,
  discoveredPosts,
  engagedProfiles,
  jobs,
  conversationEvents,
  conversationSources,
  conversations,
  messages,
  outcomeEvents,
  rateLimitLedger,
  type IncomingComment,
  type ConversationEventRow,
  type ConversationEventType,
  type ConversationRelationship,
  type ConversationRow,
  type OutcomeEventRow,
  type OutcomeType,
  type RetentionClass,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { stopScope } from "../actions/pause";
import type { InviteNoteCheckPayload } from "../actions/inviteNote";
import { enqueue } from "../jobs/queue";
import { isRoomThreadReply, roomThreadReceipt } from "../rooms/thread";
import { trackEngagement } from "../telemetry/emit";
import {
  dmWordsHash,
  type DmMessage,
  type DmReceipt,
  type InvitationReceipt,
  type RelationshipRead,
} from "../linkedin/driver";
import { setDoNotEngage } from "../operations/engagedProfiles";
import { rememberPlace } from "../operations/researchReads";
import type {
  ClassifiedMessage,
  ClassifiedReply,
  ClassifierStamp,
  MessageIntent,
  MessageIntentVerdict,
  ReplyStanceVerdict,
} from "./classify";
import { cancelFollowup, supersedeQueuedDms } from "./followup";
import {
  evaluateEligibility,
  type DmPolicy,
  type Eligibility,
  type EligibilityEvent,
  type EligibilityPolicy,
  type ConversationState,
} from "./eligibility";
import { followLifecycle, markContacted, markRelationship } from "../leads/lifecycle";
import { projectLeadStatus } from "./leads";
import { conversationPolicy, type ConversationPolicy } from "./policy";
import { relationshipOf } from "./relationship";
import { openReviewReasons } from "./review";
import { deriveStage } from "./state";
import { listRoomMembers } from "../rooms/room";

const DAY = 86_400_000;
/** How soon after one read of a person's profile the next may be, however
 *  soon something asks for it. */
const PROFILE_REREAD_GAP_MS = 3_600_000;

/**
 * What was decided about one observed reply, stored on its event: the R05 row
 * and outcome, the classifier's labels and which classifier read it, and the
 * policy that judged it. Voice and knowledge are null: neither reaches the
 * classifier.
 */
export type ReplyDecision = Eligibility & {
  label: Omit<ReplyStanceVerdict, "evidence"> | null;
  uncertainty: boolean;
  classifier: ClassifierStamp | null;
  policy: {
    eligibility: EligibilityPolicy;
    strategy: ConversationPolicy["versions"];
    voice: null;
    knowledge: null;
  };
};

export type RecordedReply = {
  conversation: ConversationRow;
  event: ConversationEventRow;
  /** False when this revision of the reply was already recorded. */
  recorded: boolean;
};

/** A reply a conversation can record: one a thread read wrote, directly under a
 *  comment of ours, from a person the read identified by profile id. */
type ThreadReply = IncomingComment & {
  source: "our_comment_thread";
  campaignId: number;
  parentMessageId: number;
  authorProfileId: string;
  textHash: string;
  observedAt: number;
};

function isThreadReply(incoming: IncomingComment): incoming is ThreadReply {
  return (
    incoming.source === "our_comment_thread" &&
    incoming.campaignId !== null &&
    incoming.parentMessageId !== null &&
    // Identity is the provider's id for the person, as this account read it.
    // A display name, or a reply that merely arrived at the right time, is
    // never enough to join a conversation.
    incoming.authorProfileId !== null &&
    incoming.textHash !== null &&
    incoming.observedAt !== null
  );
}

/**
 * Whether `incoming` is a reply a conversation records: a thread read's row under
 * a campaign that runs on its strategy, or a room conversation the owner
 * started. The own-post sweep and the legacy monitor open no conversation.
 */
export async function recordsConversation(
  tx: Tx,
  incoming: IncomingComment,
): Promise<boolean> {
  if (!isThreadReply(incoming)) return false;
  const roomThread = await isRoomThreadReply(tx, incoming);
  if (roomThread && !await roomThreadReceipt(tx, incoming)) return false;
  return (await conversationScope(tx, incoming.campaignId)) !== null;
}

/**
 * Record one observed revision of a reply on the replier's conversation, in the
 * caller's transaction: the conversation through the person's identity (opened
 * when they have none), the reply as one of its sources, and ONE event — a
 * `reply_observed`, or a `reply_edited` superseding the last revision
 * recorded — carrying its words, their hash, both times, the attribution and
 * the decision. The conversation's columns then take the decision's effects, a
 * derived `opt_out` or `source_skipped` follows where the decision drew one,
 * and the person's lead is projected from the conversation. An opt-out in public
 * is honoured as one in a DM is (`honourOptOut`).
 *
 * A revision already recorded records nothing again. Null when the row is
 * not a reply a conversation records.
 */
export async function recordReplyEvent(
  tx: Tx,
  input: { incoming: IncomingComment; classified: ClassifiedReply | null; now: number },
): Promise<RecordedReply | null> {
  const { incoming, classified, now } = input;
  if (!isThreadReply(incoming)) return null;
  const roomThread = await isRoomThreadReply(tx, incoming);
  if (roomThread && !await roomThreadReceipt(tx, incoming)) return null;
  const scope = await conversationScope(tx, incoming.campaignId);
  if (!scope) return null;
  const conversation = await conversationOfReply(tx, incoming, scope, now);

  const digest = sha256(
    JSON.stringify(["reply", incoming.commentUrn, incoming.textRevision, incoming.textHash]),
  );
  // Every revision of this reply recorded so far, the latest first.
  const revisions = await tx
    .select()
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversation.id),
        inArray(conversationEvents.type, ["reply_observed", "reply_edited"]),
        sql`${conversationEvents.sourceRef}->>'commentUrn' = ${incoming.commentUrn}`,
      ),
    )
    .orderBy(desc(conversationEvents.id));
  const [prior] = revisions;
  if (prior?.digest === digest) return { conversation, event: prior, recorded: false };

  const type: ConversationEventType = prior ? "reply_edited" : "reply_observed";
  // An edit carries no time of its own: it happened by the read that saw it.
  const occurredAt = prior ? incoming.observedAt : incoming.receivedAt;
  // Words the person has since edited away no longer show interest: the new
  // revision's reading decides it afresh.
  const interestEvidenceEventId = revisions.some(
    (revision) => revision.id === conversation.interestEvidenceEventId,
  )
    ? null
    : conversation.interestEvidenceEventId;
  const policy = await conversationPolicy(tx, incoming.campaignId);
  let eligibility = evaluateEligibility({
    event: { type, occurredAt, reading: classified?.reading ?? null },
    conversation: {
      ...(await standing(tx, conversation)),
      hasInterest: interestEvidenceEventId !== null,
    },
    policy,
    excluded: await doNotEngage(tx, incoming.authorProfileId),
  });
  if (incoming.sensitivity === "hold" && eligibility.effects.close !== "opt_out" && eligibility.decision !== "closed") {
    eligibility = { ...eligibility, eligible: "unknown", decision: "review",
      effects: { ...eligibility.effects, opsStatus: "awaiting_review" } };
  }
  const decision: ReplyDecision = {
    ...eligibility,
    label: classified ? withoutEvidence(classified.verdict) : null,
    uncertainty:
      !classified ||
      classified.verdict.uncertain ||
      classified.reading.unquoted.length > 0,
    classifier: classified?.classifier ?? null,
    policy: {
      eligibility: policy.eligibility,
      strategy: policy.versions,
      voice: null,
      knowledge: null,
    },
  };
  const sourceRef = {
    postUrn: incoming.ownPostUrn,
    commentUrn: incoming.commentUrn,
    ...(incoming.threadParentUrn ? { parentUrn: incoming.threadParentUrn } : {}),
    messageId: incoming.parentMessageId,
    incomingCommentId: incoming.id,
  };
  const attribution = {
    method: "thread_read" as const,
    profileId: incoming.authorProfileId,
    directReply: true,
    parentMessageId: incoming.parentMessageId,
    ...(incoming.reader === "agent" ? { reader: "agent" as const } : {}),
  };
  const [event] = await tx
    .insert(conversationEvents)
    .values({
      conversationId: conversation.id,
      type,
      source: "our_comment_thread",
      sourceRef,
      // The provider's id names the reply as first posted; a later revision
      // of it is told apart by its digest.
      providerEventId: prior ? null : incoming.commentUrn,
      digest,
      content: incoming.text,
      contentHash: incoming.textHash,
      revision: incoming.textRevision,
      occurredAt,
      observedAt: incoming.observedAt,
      attribution,
      evidenceSpans: classified?.spans ?? [],
      decision,
      supersedesEventId: prior?.id ?? null,
      ...retention("content", incoming.observedAt, policy),
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!event) {
    // Another transaction recorded this revision first.
    const [existing] = await tx
      .select()
      .from(conversationEvents)
      .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
    if (!existing) {
      throw new Error(`conversation ${conversation.id}: event ${digest} neither inserted nor found`);
    }
    return { conversation, event: existing, recorded: false };
  }

  const derived = derivedDecision(eligibility);
  if (derived) {
    await tx.insert(conversationEvents).values({
      conversationId: conversation.id,
      type: derived,
      source: "our_comment_thread",
      sourceRef: { ...sourceRef, eventId: event.id },
      digest: sha256(JSON.stringify([derived, event.id])),
      occurredAt,
      observedAt: incoming.observedAt,
      attribution: { method: "derived", profileId: incoming.authorProfileId },
      ...retention(derived === "opt_out" ? "suppression" : "audit", incoming.observedAt, policy),
      createdAt: now,
    });
  }
  const updated = await applyEffects(
    tx,
    { ...conversation, interestEvidenceEventId },
    event,
    eligibility,
    policy,
    now,
  );
  if (eligibility.effects.close === "opt_out") await honourOptOut(tx, conversation, "observed:reply", now);
  // A word of theirs anywhere answers our last message: a follow-up still
  // waiting for a yes would chase someone who already wrote back (R07).
  await cancelFollowup(tx, conversation.id, now);
  await projectLeadStatus(tx, incoming.authorProfileId, now);
  // Counted once, for the reply as first seen; an edit of it is not another
  // person coming back.
  if (type === "reply_observed") {
    // Their first answer makes a Find leads person a Relationship.
    await followLifecycle(tx, "markRelationship", (sp) =>
      markRelationship(sp, { profileId: incoming.authorProfileId, at: occurredAt, kind: "reply" }));
    // Usage data: someone answered a comment of ours.
    const [parent] =
      incoming.parentMessageId == null
        ? []
        : await tx.select({ postedAt: messages.postedAt }).from(messages).where(eq(messages.id, incoming.parentMessageId));
    trackEngagement(
      { kind: "reply_to_comment", sentAt: parent?.postedAt ?? null, receivedAt: incoming.receivedAt },
      tx,
    );
  }
  return { conversation: updated, event, recorded: true };
}

/**
 * Record an edit the thread read just wrote over a reply, when that reply is
 * already on a conversation. One not yet recorded is left to `processIncoming`,
 * which records whatever revision it finds. An edit is recorded unclassified
 * — review — until something reads its words again.
 */
export async function recordReplyEdit(
  tx: Tx,
  incoming: IncomingComment,
  now: number,
): Promise<RecordedReply | null> {
  const [source] = await tx
    .select({ id: conversationSources.id })
    .from(conversationSources)
    .where(eq(conversationSources.incomingCommentId, incoming.id));
  if (!source) return null;
  return recordReplyEvent(tx, { incoming, classified: null, now });
}

export type RecordedInvitation = {
  conversation: ConversationRow;
  event: ConversationEventRow;
  /** False when this action's invitation was already on the log. */
  recorded: boolean;
};

/**
 * Record that an invitation of ours to the conversation's person went out — R08's
 * `InvitationConfirmed` — from the settled receipt of its ledger row, in the
 * caller's transaction (the one that settles the row). Its evidence is what
 * confirmed it: a read of the person, in the session that sent it, showing it
 * pending moves the conversation to `outgoing_pending` and the person's copy with
 * it. LinkedIn's answer naming the invitation it created (`receipt`), with no
 * such read, records it as of that answer, and an owner's word, with neither,
 * as of now; neither moves a relationship (INV-30) — the next read of the
 * person does. Once on the log it forbids a second invitation on the conversation,
 * whatever a later page offers. Recorded once per action. Null when the
 * conversation is not this org's.
 */
export async function recordInvitationConfirmed(
  tx: Tx,
  input: {
    conversationId: number;
    actionExecutionId: number;
    read: RelationshipRead | null;
    receipt?: InvitationReceipt | null;
    now: number;
  },
): Promise<RecordedInvitation | null> {
  const { read, now } = input;
  const receipt = input.receipt ?? null;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update");
  if (!conversation) return null;
  const digest = sha256(JSON.stringify(["invitation_confirmed", input.actionExecutionId]));
  const [prior] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
  if (prior) return { conversation, event: prior, recorded: false };

  const pending = read !== null && relationshipOf(read, conversation.authorProfileId) === "outgoing_pending";
  const occurredAt = read?.observedAt ?? receipt?.sentAt ?? now;
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const eligibility = evaluateEligibility({
    event: { type: "invitation_confirmed", occurredAt, relationshipRead: pending },
    conversation: await standing(tx, conversation),
    policy,
    excluded: await doNotEngage(tx, conversation.authorProfileId),
  });
  const event = await appendEvent(tx, {
    conversationId: conversation.id,
    type: "invitation_confirmed",
    source: "invitation",
    sourceRef: {
      ...(read ? { profileUrl: read.profile.url } : {}),
      actionExecutionId: input.actionExecutionId,
    },
    digest,
    occurredAt,
    observedAt: occurredAt,
    attribution: read
      ? {
          method: "relationship_read",
          profileId: conversation.authorProfileId,
          channelId: conversation.channelId,
          read,
        }
      : receipt
        ? { method: "derived", profileId: conversation.authorProfileId, channelId: conversation.channelId }
        : { method: "owner", profileId: conversation.authorProfileId },
    decision: {
      ...eligibility,
      policy: { dm: policy.dm, strategy: policy.versions },
    } satisfies InvitationDecision,
    ...retention("audit", occurredAt, policy),
    createdAt: now,
  });
  const updated = await applyEffects(tx, conversation, event, eligibility, policy, now);
  if (pending) await followRead(tx, conversation, "outgoing_pending", read);
  // The first send that reaches a Find leads person makes them Contacted.
  await followLifecycle(tx, "markContacted", (sp) =>
    markContacted(sp, {
      profileId: conversation.authorProfileId,
      send: { kind: "action", id: input.actionExecutionId },
      at: occurredAt,
    }));
  return { conversation: updated, event, recorded: true };
}

/** What answers an invitation of ours on the conversation's log: their
 *  acceptance, our withdrawal, or a read finding it no longer pending. */
export const INVITATION_ANSWERS = ["invitation_accepted", "invitation_withdrawn", "invitation_gone"] as const;

/** The invitation of ours the conversation's log holds sent — its newest
 *  `invitation_confirmed` — and the first event that answered it since, or
 *  nulls. */
async function newestInvitation(
  tx: Tx,
  conversationId: number,
): Promise<{ sent: ConversationEventRow | null; answer: ConversationEventRow | null }> {
  const [sent] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, "invitation_confirmed")))
    .orderBy(desc(conversationEvents.id))
    .limit(1);
  if (!sent) return { sent: null, answer: null };
  const [answer] = await tx
    .select()
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, [...INVITATION_ANSWERS]),
        sql`${conversationEvents.id} > ${sent.id}`,
      ),
    )
    .orderBy(asc(conversationEvents.id))
    .limit(1);
  return { sent, answer: answer ?? null };
}

/** The invitation of ours the conversation's log holds sent — its newest
 *  `invitation_confirmed` — that nothing has answered since, or null. */
export async function outstandingInvitation(tx: Tx, conversationId: number): Promise<ConversationEventRow | null> {
  const { sent, answer } = await newestInvitation(tx, conversationId);
  return answer ? null : sent;
}

/**
 * Bring the next read of an outstanding invitation's person forward
 * (`invitation_watch`, `actions/invite.ts`): a message from them in the
 * account's inbox is the strongest sign they accepted it, and the watch's
 * read of their profile — the one thing that records an acceptance — need
 * not wait out its backoff. It is brought to now when no read of their
 * profile has been made since they first wrote after the invitation: that
 * message is what the read is for, however soon the last one was. After that
 * read, or where all they wrote came before the invitation, a message brings
 * the next one no nearer than an hour after the account's last read of their
 * profile — the watch's own, or any other — so several messages do not read
 * them again and again. Nothing where no invitation of ours is outstanding,
 * its watch is not waiting, or the day's profile reads put it off: the watch
 * reads as it always does, under its own budget and lease.
 */
export async function hastenInvitationWatch(
  tx: Tx,
  conversation: Pick<ConversationRow, "id" | "organizationId" | "channelId" | "authorProfileId">,
  now: number,
): Promise<void> {
  const sent = await outstandingInvitation(tx, conversation.id);
  const actionId = sent?.sourceRef.actionExecutionId;
  if (!sent || actionId === undefined) return;
  const [last] = await tx
    .select({ at: sql<number | null>`max(${rateLimitLedger.ts})::float8` })
    .from(rateLimitLedger)
    .where(
      and(
        eq(rateLimitLedger.action, "profile_read"),
        eq(rateLimitLedger.channelId, conversation.channelId),
        eq(rateLimitLedger.targetProfileId, conversation.authorProfileId),
      ),
    );
  const [wrote] = await tx
    .select({ at: sql<number | null>`min(${conversationEvents.occurredAt})::float8` })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversation.id),
        eq(conversationEvents.type, "inbound_message_observed"),
        sql`${conversationEvents.occurredAt} > ${sent.occurredAt}`,
      ),
    );
  const read = last?.at ?? null;
  const readSince = read !== null && (wrote?.at == null || read >= wrote.at);
  const at = readSince ? Math.max(now, read + PROFILE_REREAD_GAP_MS) : now;
  await tx
    .update(jobs)
    .set({ nextRunAt: sql`least(${jobs.nextRunAt}, ${at}::bigint)`, updatedAt: now })
    .where(
      and(
        // `jobs` is excluded from RLS, so the org predicate is explicit.
        eq(jobs.organizationId, conversation.organizationId),
        eq(jobs.idempotencyKey, `invitation_watch:${actionId}`),
        eq(jobs.status, "queued"),
        // One the budget put off waits for when it said, as the scheduler
        // leaves it (`scheduleInvitationWatches`): pulled up, it would only
        // wake to be refused again.
        sql`coalesce((${jobs.result} #>> '{refusal,retryAt}')::bigint, 0) <= ${now}`,
      ),
    );
}

/** The invitation of ours the conversation's log holds sent, with the
 *  `invitation_gone` that answered it — a read found LinkedIn no longer lists
 *  it — or null for one pending, accepted or withdrawn by us. */
export async function goneInvitation(
  tx: Tx,
  conversationId: number,
): Promise<{ sent: ConversationEventRow; gone: ConversationEventRow } | null> {
  const { sent, answer } = await newestInvitation(tx, conversationId);
  return sent && answer?.type === "invitation_gone" ? { sent, gone: answer } : null;
}

/**
 * Record that the owner withdrew our invitation to the conversation's person, from
 * the settled receipt of its ledger row, in the caller's transaction (the one
 * that settles the row). Its evidence is the read that confirmed it: a read of
 * the person, in the session that withdrew it, showing nothing pending moves
 * the conversation to `not_connected` and the person's copy with it. An owner's
 * word, with no read, records the withdrawal and moves no relationship
 * (INV-30). Either way the invitation is answered: nothing waits on it, and
 * the log's `invitation_confirmed` still forbids a second one on the conversation.
 * Recorded once per action. Null when the conversation is not this org's.
 */
export async function recordInvitationWithdrawn(
  tx: Tx,
  input: {
    conversationId: number;
    actionExecutionId: number;
    read: RelationshipRead | null;
    now: number;
  },
): Promise<RecordedInvitation | null> {
  const { read, now } = input;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update");
  if (!conversation) return null;
  const digest = sha256(JSON.stringify(["invitation_withdrawn", input.actionExecutionId]));
  const [prior] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
  if (prior) return { conversation, event: prior, recorded: false };

  const withdrawn = read !== null && relationshipOf(read, conversation.authorProfileId) === "not_connected";
  const occurredAt = read?.observedAt ?? now;
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const eligibility = evaluateEligibility({
    event: { type: "invitation_withdrawn", occurredAt, relationshipRead: withdrawn },
    conversation: await standing(tx, conversation),
    policy,
    excluded: await doNotEngage(tx, conversation.authorProfileId),
  });
  const event = await appendEvent(tx, {
    conversationId: conversation.id,
    type: "invitation_withdrawn",
    source: "invitation",
    sourceRef: {
      ...(read ? { profileUrl: read.profile.url } : {}),
      actionExecutionId: input.actionExecutionId,
    },
    digest,
    occurredAt,
    observedAt: occurredAt,
    attribution: read
      ? {
          method: "relationship_read",
          profileId: conversation.authorProfileId,
          channelId: conversation.channelId,
          read,
        }
      : { method: "owner", profileId: conversation.authorProfileId },
    decision: {
      ...eligibility,
      policy: { dm: policy.dm, strategy: policy.versions },
    } satisfies InvitationDecision,
    ...retention("audit", occurredAt, policy),
    createdAt: now,
  });
  const updated = await applyEffects(tx, conversation, event, eligibility, policy, now);
  if (withdrawn) await followRead(tx, conversation, "not_connected", read);
  return { conversation: updated, event, recorded: true };
}

/**
 * What was decided about one relationship read, stored on its event: the R05
 * row and outcome, the relationship the read showed — `unknown` when it could
 * not tell — and the policy that judged it.
 */
export type RelationshipDecision = Eligibility & {
  relationship: ConversationRelationship;
  policy: { dm: DmPolicy; strategy: ConversationPolicy["versions"] };
};

export type RecordedRelationship = {
  conversation: ConversationRow;
  /** The read, as the conversation's `relationship_observed` event. */
  observed: ConversationEventRow;
  /** The acceptance the read proves, when the conversation was waiting on one. */
  accepted: ConversationEventRow | null;
  /** Our invitation the read found no longer pending, when the conversation was
   *  waiting on one. */
  gone: ConversationEventRow | null;
};

/**
 * Record one relationship read on the conversation it was made for, in the
 * caller's transaction: a `relationship_observed` event with the read itself
 * as its attribution, judged by the eligibility table; an
 * `invitation_accepted` when the conversation was waiting on our invitation —
 * `outgoing_pending`, or one its log holds sent and unanswered — and the read
 * shows the person connected — the one thing that ever records an acceptance;
 * an `invitation_gone` when the log holds ours sent and unanswered and the
 * person's own data shows their invitation switch back on Connect, or on
 * Withdrawn — LinkedIn no longer lists it; the conversation's columns from those
 * decisions; when the read could tell, the relationship and the read on the
 * person's `author_profiles` row; and, when it looked, where they are.
 *
 * A read that could not tell moves no relationship, on the conversation or the
 * person, and sends the conversation to review. The read must be one the conversation's
 * own account just made (INV-30), which is why `refreshRelationship`, which
 * makes it, is the caller. Null when the conversation is not this org's.
 */
export async function recordRelationshipRead(
  tx: Tx,
  input: { conversationId: number; read: RelationshipRead; now: number },
): Promise<RecordedRelationship | null> {
  const { read, now } = input;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update");
  if (!conversation) return null;
  const relationship = relationshipOf(read, conversation.authorProfileId);
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const excluded = await doNotEngage(tx, conversation.authorProfileId);
  const judge = async (
    event: EligibilityEvent,
    at: ConversationRow,
  ): Promise<RelationshipDecision> => ({
    ...evaluateEligibility({ event, conversation: await standing(tx, at), policy, excluded }),
    relationship,
    policy: { dm: policy.dm, strategy: policy.versions },
  });
  // What both events carry: the read is their evidence and their time.
  const shared = {
    conversationId: conversation.id,
    occurredAt: read.observedAt,
    observedAt: read.observedAt,
    attribution: {
      method: "relationship_read" as const,
      profileId: conversation.authorProfileId,
      channelId: conversation.channelId,
      read,
    },
    ...retention("audit", read.observedAt, policy),
    createdAt: now,
  };

  const seen = await judge(
    { type: "relationship_observed", occurredAt: read.observedAt, relationship },
    conversation,
  );
  const observed = await appendEvent(tx, {
    ...shared,
    type: "relationship_observed",
    source: "profile",
    sourceRef: { profileUrl: read.profile.url },
    digest: sha256(JSON.stringify(["relationship_observed", read])),
    decision: seen,
  });
  let updated = await applyEffects(tx, conversation, observed, seen, policy, now);

  // An acceptance is the read moving our pending invitation to connected — a
  // read older than the conversation's last, which moves nothing, proves none. Ours
  // is pending where a read showed it so, or where the log holds it sent and
  // unanswered — the owner's word settled the send, and no read since showed
  // it either way.
  let accepted: ConversationEventRow | null = null;
  const waiting =
    conversation.relationship === "outgoing_pending" ||
    (conversation.relationship !== "connected" && (await outstandingInvitation(tx, conversation.id)) !== null);
  if (waiting && seen.effects.relationship === "connected") {
    const sentInvitation = await outstandingInvitation(tx, conversation.id);
    const acceptance = await judge(
      { type: "invitation_accepted", occurredAt: read.observedAt, relationshipRead: true },
      updated,
    );
    accepted = await appendEvent(tx, {
      ...shared,
      type: "invitation_accepted",
      source: "invitation",
      sourceRef: { profileUrl: read.profile.url, eventId: observed.id },
      digest: sha256(JSON.stringify(["invitation_accepted", observed.id])),
      decision: acceptance,
    });
    updated = await applyEffects(tx, updated, accepted, acceptance, policy, now);
    await followLifecycle(tx, "markRelationship", (sp) =>
      markRelationship(sp, { profileId: conversation.authorProfileId, at: read.observedAt, kind: "invite_accepted" }));
    // Usage data: our invitation was accepted.
    trackEngagement(
      { kind: "invite_accepted", sentAt: sentInvitation?.occurredAt ?? null, receivedAt: read.observedAt },
      tx,
    );
    await queueInviteNoteCheck(tx, conversation.id, sentInvitation, accepted, now);
  }

  // Gone is the switch itself saying no invitation of ours stands — never a
  // read that merely did not find one.
  let gone: ConversationEventRow | null = null;
  if (
    relationship === "not_connected" &&
    (read.invitation === "connect" || read.invitation === "withdrawn") &&
    (await outstandingInvitation(tx, conversation.id)) !== null
  ) {
    const answered = await judge({ type: "invitation_gone", occurredAt: read.observedAt }, updated);
    gone = await appendEvent(tx, {
      ...shared,
      type: "invitation_gone",
      source: "invitation",
      sourceRef: { profileUrl: read.profile.url, eventId: observed.id },
      digest: sha256(JSON.stringify(["invitation_gone", observed.id])),
      decision: answered,
    });
    updated = await applyEffects(tx, updated, gone, answered, policy, now);
  }

  if (relationship !== "unknown") await followRead(tx, conversation, relationship, read);
  if (read.place) await rememberPlace(tx, conversation.authorProfileId, read.place, read.observedAt);
  return { conversation: updated, observed, accepted, gone };
}

/**
 * The acceptance of an invitation sent with a note queues one read of the
 * conversation for that note (`jobs/handlers/inviteNoteCheck.ts`): LinkedIn
 * may have carried it as the first message, and if it did not, it is
 * reserved as one under the DM step. An invitation sent with no note queues
 * nothing, and neither does their invitation accepted by us. Keyed on the
 * invitation's own action, so a second look at the same acceptance queues
 * nothing again.
 */
async function queueInviteNoteCheck(
  tx: Tx,
  conversationId: number,
  sent: ConversationEventRow | null,
  accepted: ConversationEventRow,
  now: number,
): Promise<void> {
  const inviteActionId = sent?.sourceRef.actionExecutionId;
  if (inviteActionId === undefined) return;
  const [invite] = await tx
    .select({ candidate: actions.candidate, kind: actions.kind })
    .from(actions)
    .where(eq(actions.id, inviteActionId));
  if (invite?.kind !== "invite" || !invite.candidate.text?.trim()) return;
  const payload: InviteNoteCheckPayload = { conversationId, inviteActionId, acceptedEventId: accepted.id };
  await enqueue(tx, {
    type: "invite_note_check",
    payload,
    nextRunAt: now,
    idempotencyKey: `invite_note_check:${inviteActionId}`,
  });
}

export type RecordedInviteNote = {
  event: ConversationEventRow;
  /** False when this invitation's note was already recorded as carried. */
  recorded: boolean;
};

/**
 * Record that a read of the conversation showed our invitation's note already
 * there as the account's own message: LinkedIn carried it, and Engager sends
 * nothing in its place. Once per invitation, in the caller's transaction.
 * Null when the conversation is not this org's.
 */
export async function recordInviteNoteCarried(
  tx: Tx,
  input: {
    conversationId: number;
    inviteActionId: number;
    messageId: string;
    threadId: string;
    observedAt: number;
    now: number;
  },
): Promise<RecordedInviteNote | null> {
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).for("update");
  if (!conversation) return null;
  const digest = sha256(JSON.stringify(["invite_note_carried", input.inviteActionId]));
  const [prior] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
  if (prior) return { event: prior, recorded: false };
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const event = await appendEvent(tx, {
    conversationId: conversation.id,
    type: "invite_note_carried",
    source: "dm",
    sourceRef: { actionExecutionId: input.inviteActionId, threadId: input.threadId },
    providerEventId: input.messageId,
    digest,
    occurredAt: input.observedAt,
    observedAt: input.observedAt,
    attribution: { method: "dm_read", profileId: conversation.authorProfileId, channelId: conversation.channelId },
    decision: { messageId: input.messageId, inviteActionId: input.inviteActionId },
    ...retention("audit", input.observedAt, policy),
    createdAt: input.now,
  });
  return { event, recorded: true };
}

/** An invitation from a person to this account, tied to a conversation, and how. */
export type AttributedInvitation = {
  invitationId: string;
  /** The sender as the invitations page linked them. */
  senderProfileId: string;
  senderUrl: string;
  /** The read that showed it pending. */
  observedAt: number;
  link:
    | { method: "verified_exchange"; replyEventId: number }
    | {
        method: "user_confirmed_link";
        /** The reply the owner says its sender wrote; null where they
         *  accepted a request from someone with no reply to name. */
        replyEventId: number | null;
        confirmedBy: string;
        confirmedAt: number;
      };
};

/** What was decided about an invitation or its acceptance: the R05 row and
 *  outcome, and the policy that judged it. */
export type InvitationDecision = Eligibility & {
  policy: { dm: DmPolicy; strategy: ConversationPolicy["versions"] };
};

export type RecordedInvitationEvent = {
  conversation: ConversationRow;
  event: ConversationEventRow;
  /** False when this invitation was already recorded this way. */
  recorded: boolean;
};

/**
 * Record on a conversation that its person has an invitation to this account
 * waiting — R08's `IncomingInvitationObserved` — tied to one of the replies
 * the conversation recorded: by the sender's provider id, or by the owner's word
 * that this sender wrote that reply. Never by a name or a time. The read that
 * showed it pending is its time and its relationship evidence; the eligibility
 * table judges it with the link verified, and the conversation takes
 * `incoming_pending` from it. An invitation already recorded on the conversation
 * the same way records nothing again. Null when the conversation is not this
 * org's.
 */
export async function recordIncomingInvitation(
  tx: Tx,
  input: { conversationId: number; invitation: AttributedInvitation; now: number },
): Promise<RecordedInvitationEvent | null> {
  const { invitation, now } = input;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update");
  if (!conversation) return null;
  const digest = sha256(
    JSON.stringify(["incoming_invitation_observed", invitation.invitationId, invitation.link.method]),
  );
  const [prior] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
  if (prior) return { conversation, event: prior, recorded: false };

  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const eligibility = evaluateEligibility({
    event: {
      type: "incoming_invitation_observed",
      occurredAt: invitation.observedAt,
      linkVerified: true,
    },
    conversation: await standing(tx, conversation),
    policy,
    excluded: await doNotEngage(tx, conversation.authorProfileId),
  });
  const { link } = invitation;
  const event = await appendEvent(tx, {
    conversationId: conversation.id,
    type: "incoming_invitation_observed",
    source: "invitation",
    sourceRef: {
      profileUrl: invitation.senderUrl,
      invitationId: invitation.invitationId,
      ...(link.replyEventId === null ? {} : { eventId: link.replyEventId }),
    },
    digest,
    occurredAt: invitation.observedAt,
    observedAt: invitation.observedAt,
    attribution: {
      method: link.method,
      profileId: conversation.authorProfileId,
      senderProfileId: invitation.senderProfileId,
      ...(link.replyEventId === null ? {} : { replyEventId: link.replyEventId }),
      channelId: conversation.channelId,
      ...(link.method === "user_confirmed_link"
        ? { confirmedBy: link.confirmedBy, confirmedAt: link.confirmedAt }
        : {}),
    },
    decision: {
      ...eligibility,
      policy: { dm: policy.dm, strategy: policy.versions },
    } satisfies InvitationDecision,
    ...retention("audit", invitation.observedAt, policy),
    createdAt: now,
  });
  const updated = await applyEffects(tx, conversation, event, eligibility, policy, now);
  await followLifecycle(tx, "markRelationship", (sp) =>
    markRelationship(sp, { profileId: conversation.authorProfileId, at: invitation.observedAt, kind: "invite_received" }));
  return { conversation: updated, event, recorded: true };
}

/**
 * Record that this account accepted the conversation's person's invitation — R08's
 * `InvitationAccepted`, incoming — from the one thing that shows it: a read of
 * the sender's own profile in the account's session after the press, showing
 * them `1st`. A read that does not show that is recorded as an acceptance the
 * table sends to review, and moves no relationship. The decision carries the
 * campaign's call on the one contextual opener, which nothing here acts on.
 * Recorded once per invitation. Null when the conversation is not this org's.
 */
export async function recordIncomingAcceptance(
  tx: Tx,
  input: {
    conversationId: number;
    invitationId: string;
    senderProfileId: string;
    read: RelationshipRead;
    /** The `incoming_invitation_observed` event it answers. */
    invitationEventId: number | null;
    now: number;
  },
): Promise<RecordedInvitationEvent | null> {
  const { read, now } = input;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update");
  if (!conversation) return null;
  const digest = sha256(JSON.stringify(["invitation_accepted", "incoming", input.invitationId]));
  const [prior] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
  if (prior) return { conversation, event: prior, recorded: false };

  const connected =
    read.profile.verified && read.profile.id === input.senderProfileId && read.degree === "1st";
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const eligibility = evaluateEligibility({
    event: {
      type: "invitation_accepted",
      occurredAt: read.observedAt,
      relationshipRead: connected,
      direction: "incoming",
    },
    conversation: await standing(tx, conversation),
    policy,
    excluded: await doNotEngage(tx, conversation.authorProfileId),
  });
  const event = await appendEvent(tx, {
    conversationId: conversation.id,
    type: "invitation_accepted",
    source: "invitation",
    sourceRef: {
      profileUrl: read.profile.url,
      invitationId: input.invitationId,
      ...(input.invitationEventId === null ? {} : { eventId: input.invitationEventId }),
    },
    digest,
    occurredAt: read.observedAt,
    observedAt: read.observedAt,
    attribution: {
      method: "relationship_read",
      profileId: conversation.authorProfileId,
      senderProfileId: input.senderProfileId,
      channelId: conversation.channelId,
      read,
    },
    decision: {
      ...eligibility,
      policy: { dm: policy.dm, strategy: policy.versions },
    } satisfies InvitationDecision,
    ...retention("audit", read.observedAt, policy),
    createdAt: now,
  });
  const updated = await applyEffects(tx, conversation, event, eligibility, policy, now);
  await followLifecycle(tx, "markRelationship", (sp) =>
    markRelationship(sp, { profileId: conversation.authorProfileId, at: read.observedAt, kind: "invite_accepted" }));
  if (connected) {
    // The sender's own copy follows the newest read that could tell, as a
    // relationship read's does.
    await tx
      .update(authorProfiles)
      .set({
        relationship: "connected",
        relationshipCheckedAt: read.observedAt,
        identityEvidence: { method: "relationship_read", channelId: conversation.channelId, read },
      })
      .where(
        and(
          eq(authorProfiles.profileId, input.senderProfileId),
          or(
            isNull(authorProfiles.relationshipCheckedAt),
            lte(authorProfiles.relationshipCheckedAt, read.observedAt),
          ),
        ),
      );
  }
  return { conversation: updated, event, recorded: true };
}

/** The conversation event each conversion outcome is the verified evidence of
 *  (R08). An offer, a cancellation and a refund are none. */
const OUTCOME_EVIDENCE: Partial<
  Record<OutcomeType, "booking_verified" | "activation_verified" | "payment_verified">
> = {
  booked: "booking_verified",
  activated: "activation_verified",
  paid: "payment_verified",
};

/** What was decided about a verified outcome on a conversation, and the policy
 *  that judged it. */
export type OutcomeEvidenceDecision = Eligibility & {
  policy: { strategy: ConversationPolicy["versions"] };
};

export type RecordedOutcomeEvidence = {
  conversation: ConversationRow;
  event: ConversationEventRow;
  /** False when this outcome was already recorded on the conversation. */
  recorded: boolean;
};

/**
 * Record on a conversation that a conversion of its person's is verified — R08's
 * `BookingVerified`, `ActivationVerified` or `PaymentVerified` — from the
 * outcome row that holds the evidence: the owner's attestation or a receipt
 * they reviewed (`recordOutcome.ts`). The event is that row's echo on the
 * conversation, which is what a step waiting on `outcome_evidence` matches; the
 * conversation's outcome columns stay the outcome rows' own projection. Recorded
 * once per fact: a row restating the one it supersedes — a receipt confirming
 * the owner's word, a corrected time — is the same evidence again, while a
 * fact reinstated after its cancellation is new. Null for an outcome that is
 * no such evidence, or one on no conversation of this org's.
 */
export async function recordOutcomeEvidence(
  tx: Tx,
  input: { outcome: OutcomeEventRow; now: number },
): Promise<RecordedOutcomeEvidence | null> {
  const { outcome, now } = input;
  const type = OUTCOME_EVIDENCE[outcome.type];
  if (type === undefined || outcome.conversationId === null) return null;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, outcome.conversationId))
    .for("update");
  if (!conversation) return null;
  let fact: Pick<OutcomeEventRow, "id" | "type" | "supersedesEventId"> = outcome;
  while (fact.supersedesEventId !== null) {
    const [restated] = await tx
      .select({ id: outcomeEvents.id, type: outcomeEvents.type, supersedesEventId: outcomeEvents.supersedesEventId })
      .from(outcomeEvents)
      .where(eq(outcomeEvents.id, fact.supersedesEventId));
    if (!restated || restated.type !== outcome.type) break;
    fact = restated;
  }
  const digest = sha256(JSON.stringify([type, fact.id]));
  const [prior] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
  if (prior) return { conversation, event: prior, recorded: false };

  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const eligibility = evaluateEligibility({
    event: { type, occurredAt: outcome.occurredAt },
    conversation: await standing(tx, conversation),
    policy,
    excluded: await doNotEngage(tx, conversation.authorProfileId),
  });
  const event = await appendEvent(tx, {
    conversationId: conversation.id,
    type,
    source: "outcome",
    sourceRef: { outcomeEventId: outcome.id },
    digest,
    occurredAt: outcome.occurredAt,
    observedAt: outcome.observedAt,
    attribution: { method: "derived", profileId: conversation.authorProfileId, channelId: conversation.channelId },
    decision: {
      ...eligibility,
      policy: { strategy: policy.versions },
    } satisfies OutcomeEvidenceDecision,
    ...retention("audit", outcome.observedAt, policy),
    createdAt: now,
  });
  const updated = await applyEffects(tx, conversation, event, eligibility, policy, now);
  return { conversation: updated, event, recorded: true };
}

/**
 * What was decided about one inbound direct message, stored on its event: the
 * R05 row and outcome, the intent and labels the classifier read and which
 * classifier read it, and the policy that judged it. Voice and knowledge are
 * null: neither reaches the classifier.
 */
export type MessageDecision = Eligibility & {
  intent: MessageIntent | null;
  label: Omit<MessageIntentVerdict, "evidence"> | null;
  uncertainty: boolean;
  classifier: ClassifierStamp | null;
  policy: {
    eligibility: EligibilityPolicy;
    strategy: ConversationPolicy["versions"];
    voice: null;
    knowledge: null;
  };
};

/**
 * Someone asked not to be contacted, in a reply or a DM: the person goes on
 * the account's do-not-engage list — the flag every send gate reads, so
 * nothing reaches them again from any campaign — and the conversation is
 * stopped (INV-29), so nothing queued for them goes out and no later word,
 * however warm, reopens it. The list is keyed on their profile id: a row
 * that knows them only by a member urn is not covered by it.
 */
async function honourOptOut(
  tx: Tx,
  conversation: Pick<ConversationRow, "id" | "authorProfileId">,
  by: "observed:dm" | "observed:reply",
  now: number,
): Promise<void> {
  await setDoNotEngage(tx, { profileId: conversation.authorProfileId, doNotEngage: true });
  await stopScope(tx, { scope: "conversation", scopeId: conversation.id, reason: "opt_out", by, now });
}

export type RecordedMessage = {
  conversation: ConversationRow;
  event: ConversationEventRow;
  /** False when this message was already recorded. */
  recorded: boolean;
};

/**
 * Record one message the account sent in the conversation's canonical DM
 * thread that is none of Engager's own DMs (`engagerSent`): the owner wrote it
 * on LinkedIn. ONE event, keyed on the provider's id for the message and
 * carrying its words, so their Messages show it beside Engager's. It decides
 * nothing: whether it hands the owner the conversation is the read's takeover
 * (`conversations/dm.ts`). A message already recorded records nothing again.
 */
export async function recordOwnerMessage(
  tx: Tx,
  input: {
    conversation: ConversationRow;
    thread: { id: number; channelId: number; providerThreadId: string };
    message: DmMessage;
    now: number;
  },
): Promise<boolean> {
  const { conversation, thread, message, now } = input;
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const [event] = await tx
    .insert(conversationEvents)
    .values({
      conversationId: conversation.id,
      type: "owner_message_observed",
      source: "dm",
      sourceRef: { dmThreadId: thread.id, threadId: thread.providerThreadId },
      providerEventId: message.messageId,
      digest: sha256(JSON.stringify(["dm_owner", message.messageId, message.textHash])),
      content: message.text,
      contentHash: message.textHash,
      occurredAt: message.sentAt ?? message.observedAt,
      observedAt: message.observedAt,
      attribution: { method: "dm_read", profileId: conversation.authorProfileId, channelId: thread.channelId },
      ...retention("content", message.observedAt, policy),
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: conversationEvents.id });
  return event !== undefined;
}

/**
 * Record one message the person sent in the conversation's canonical DM thread,
 * in the caller's transaction (spec §11, `InboundMessageObserved`): ONE event,
 * keyed on the provider's id for the message, carrying its words, their hash,
 * both times, the read as its attribution and the decision the eligibility
 * table drew from the classifier's reading. The conversation's columns then take
 * the decision's effects, a derived `opt_out` or `source_skipped` follows
 * where it drew one, any follow-up waiting on the conversation is cancelled, and
 * the person's lead is projected from the conversation.
 *
 * An opt-out also puts the person on the account's do-not-engage list and
 * stops the conversation (`honourOptOut`).
 *
 * A message already recorded records nothing again. The caller holds the
 * conversation's lock and has verified the thread as exactly the account and this
 * person, by profile id (`conversations/dm.ts`).
 */
export async function recordInboundMessage(
  tx: Tx,
  input: {
    conversation: ConversationRow;
    thread: { id: number; channelId: number; providerThreadId: string };
    message: DmMessage;
    classified: ClassifiedMessage | null;
    /** The conversation read's reader, where it was the agent's. */
    reader?: "agent";
    now: number;
  },
): Promise<RecordedMessage> {
  const { conversation, thread, message, classified, now } = input;
  const recordedAs = async () => {
    const [existing] = await tx
      .select()
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, conversation.id),
          eq(conversationEvents.providerEventId, message.messageId),
        ),
      );
    return existing ?? null;
  };
  const prior = await recordedAs();
  if (prior && (!classified || (prior.decision as MessageDecision | null)?.label !== null)) {
    return { conversation, event: prior, recorded: false };
  }

  // A message carries no time of its own where the page printed none: it
  // happened by the read that saw it.
  const occurredAt = message.sentAt ?? message.observedAt;
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  let eligibility = evaluateEligibility({
    event: {
      type: "inbound_message_observed",
      occurredAt,
      reading: classified?.reading ?? null,
    },
    conversation: await standing(tx, conversation),
    policy,
    excluded: await doNotEngage(tx, conversation.authorProfileId),
  });
  if (classified?.read.verdict.hold && eligibility.effects.close !== "opt_out" && eligibility.decision !== "closed") {
    eligibility = { ...eligibility, eligible: "unknown", decision: "review",
      effects: { ...eligibility.effects, opsStatus: "awaiting_review" } };
  }
  const decision: MessageDecision = {
    ...eligibility,
    intent: classified?.intent ?? null,
    label: classified ? withoutEvidence(classified.verdict) : null,
    uncertainty:
      !classified ||
      classified.intent === "unknown" ||
      classified.reading.unquoted.length > 0,
    classifier: classified?.classifier ?? null,
    policy: {
      eligibility: policy.eligibility,
      strategy: policy.versions,
      voice: null,
      knowledge: null,
    },
  };
  const sourceRef = { dmThreadId: thread.id, threadId: thread.providerThreadId };
  const attribution = {
    method: "dm_read" as const,
    profileId: message.authorProfileId,
    channelId: thread.channelId,
    ...(input.reader === "agent" ? { reader: "agent" as const } : {}),
  };
  const [event] = prior ? await tx.update(conversationEvents).set({
    evidenceSpans: classified?.spans ?? [], decision, reading: classified?.read ?? prior.reading,
  }).where(eq(conversationEvents.id, prior.id)).returning() : await tx
    .insert(conversationEvents)
    .values({
      conversationId: conversation.id,
      type: "inbound_message_observed",
      source: "dm",
      sourceRef,
      providerEventId: message.messageId,
      digest: sha256(JSON.stringify(["dm", message.messageId, message.textHash])),
      content: message.text,
      contentHash: message.textHash,
      occurredAt,
      observedAt: message.observedAt,
      attribution,
      evidenceSpans: classified?.spans ?? [],
      decision,
      reading: classified?.read ?? null,
      ...retention("content", message.observedAt, policy),
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!event) {
    // Another transaction recorded this message first.
    const existing = await recordedAs();
    if (!existing) {
      throw new Error(`conversation ${conversation.id}: message ${message.messageId} neither inserted nor found`);
    }
    return { conversation, event: existing, recorded: false };
  }

  const derived = derivedDecision(eligibility);
  if (derived) {
    await tx.insert(conversationEvents).values({
      conversationId: conversation.id,
      type: derived,
      source: "dm",
      sourceRef: { ...sourceRef, eventId: event.id },
      digest: sha256(JSON.stringify([derived, event.id])),
      occurredAt,
      observedAt: message.observedAt,
      attribution: { method: "derived", profileId: conversation.authorProfileId },
      ...retention(derived === "opt_out" ? "suppression" : "audit", message.observedAt, policy),
      createdAt: now,
    });
  }
  const updated = await applyEffects(tx, conversation, event, eligibility, policy, now);
  if (eligibility.effects.close === "opt_out") await honourOptOut(tx, conversation, "observed:dm", now);
  await cancelFollowup(tx, conversation.id, now);
  await supersedeQueuedDms(tx, conversation.id, now);
  await projectLeadStatus(tx, conversation.authorProfileId, now);
  await followLifecycle(tx, "markRelationship", (sp) =>
    markRelationship(sp, { profileId: conversation.authorProfileId, at: occurredAt, kind: "message" }));
  // Usage data: a person wrote back. Measured from our last DM to them, when
  // there was one; the first word in a conversation they began is not a reply.
  const [lastSent] = await tx
    .select({ occurredAt: conversationEvents.occurredAt })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.type, "dm_confirmed")))
    .orderBy(desc(conversationEvents.occurredAt))
    .limit(1);
  if (lastSent) {
    trackEngagement(
      { kind: "dm_reply", sentAt: lastSent.occurredAt, receivedAt: message.observedAt },
      tx,
    );
  }
  return { conversation: updated, event, recorded: true };
}

/** What a confirmed DM's event carries of the send: the ledger row, its kind
 *  and purpose, and — for an offer — the CTA asset it made. */
export type DmConfirmedDecision = {
  actionExecutionId: number;
  kind: "dm" | "followup";
  purpose: string;
  sequence: number;
  ctaAssetId: string | null;
};

/**
 * Record that a DM of ours reached the person — R08's `DMConfirmed` — from the
 * settled receipt of its ledger row, in the caller's transaction (the one that
 * settles it). Its evidence is the conversation read back showing the message,
 * where there is one; an owner's word that it went out records it with no
 * read. Our words are kept beside theirs, so the conversation a step is handed
 * reads both sides. It moves no column of the conversation: a sent message erases
 * no fact, and an offer is a fact of its own only where a receipt states it
 * (spec §11). Recorded once per action. Null when the conversation is not this
 * org's.
 */
export async function recordDmConfirmed(
  tx: Tx,
  input: {
    conversationId: number;
    /** The conversation, or none yet: an owner's word that a first message went
     *  names no thread, and a later read of the inbox binds it. */
    thread: { id: number | null; providerThreadId: string | null };
    text: string;
    message: DmReceipt | null;
    /** When it went: the time the read printed, else the press. */
    sentAt: number;
    decision: DmConfirmedDecision;
    now: number;
  },
): Promise<{ event: ConversationEventRow; recorded: boolean } | null> {
  const { message, now } = input;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update");
  if (!conversation) return null;
  const digest = sha256(JSON.stringify(["dm_confirmed", input.decision.actionExecutionId]));
  const [prior] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
  if (prior) return { event: prior, recorded: false };
  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const observedAt = message?.observedAt ?? now;
  const event = await appendEvent(tx, {
    conversationId: conversation.id,
    type: "dm_confirmed",
    source: "dm",
    sourceRef: {
      ...(input.thread.id === null ? {} : { dmThreadId: input.thread.id }),
      ...(input.thread.providerThreadId === null ? {} : { threadId: input.thread.providerThreadId }),
      actionExecutionId: input.decision.actionExecutionId,
    },
    providerEventId: message?.messageId ?? null,
    digest,
    content: input.text,
    contentHash: dmWordsHash(input.text),
    occurredAt: input.sentAt,
    observedAt,
    attribution: message
      ? { method: "dm_read", profileId: conversation.authorProfileId, channelId: conversation.channelId }
      : { method: "owner", profileId: conversation.authorProfileId },
    decision: input.decision,
    ...retention("content", observedAt, policy),
    createdAt: now,
  });
  return { event, recorded: true };
}

/** Mark the sources these replies are as gone — their author deleted them, or
 *  our comment above them went. The conversation and its events stay. */
export async function tombstoneSources(
  tx: Tx,
  incomingCommentIds: number[],
  now: number,
): Promise<void> {
  if (incomingCommentIds.length === 0) return;
  await tx
    .update(conversationSources)
    .set({ deletedAt: now })
    .where(
      and(
        inArray(conversationSources.incomingCommentId, incomingCommentIds),
        isNull(conversationSources.deletedAt),
      ),
    );
}

/** A campaign with no account opens no conversation. */
async function conversationScope(
  tx: Tx,
  campaignId: number,
): Promise<{ campaignId: number; channelId: number } | null> {
  const [campaign] = await tx
    .select({
      channelId: campaigns.channelId,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign || campaign.channelId === null) return null;
  return { campaignId, channelId: campaign.channelId };
}

/**
 * The conversation a reply belongs to, locked for this transaction. A reply already
 * recorded keeps the conversation it was recorded on. A new one joins the person's
 * conversation on this account — the open one, else the latest closed one, so an
 * opt-out stays where it was put — and attaches as one of its sources; a
 * second campaign reaching the same person attaches a source to the same
 * conversation. A conversation is opened only when the person has none.
 */
async function conversationOfReply(
  tx: Tx,
  incoming: ThreadReply,
  scope: { campaignId: number; channelId: number },
  now: number,
): Promise<ConversationRow> {
  const [source] = await tx
    .select({ conversationId: conversationSources.conversationId })
    .from(conversationSources)
    .where(eq(conversationSources.incomingCommentId, incoming.id));
  if (source) {
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, source.conversationId))
      .for("update");
    if (conversation) return conversation;
  }

  // The identity row the conversation hangs on. Epoch `fetched_at`: the profile's
  // metrics were never fetched, so every TTL check reads it as stale and the
  // next enrichment fetches it.
  await tx
    .insert(authorProfiles)
    .values({ profileId: incoming.authorProfileId, fetchedAt: 0 })
    .onConflictDoNothing();
  const conversation =
    (await personConversationOn(tx, scope.channelId, incoming.authorProfileId)) ??
    (await openConversation(tx, scope, incoming.authorProfileId, now));
  const [watch] = await tx
    .select({ id: commentWatches.id })
    .from(commentWatches)
    .where(eq(commentWatches.messageId, incoming.parentMessageId));
  await tx
    .insert(conversationSources)
    .values({
      conversationId: conversation.id,
      campaignId: scope.campaignId,
      incomingCommentId: incoming.id,
      commentWatchId: watch?.id ?? null,
      sourceRef: incoming.commentUrn,
      // Gone before it was first recorded: the tombstone travels with it.
      deletedAt: incoming.removedAt,
      createdAt: now,
    })
    .onConflictDoNothing();
  return conversation;
}

/** The person's conversation on this account, locked for this transaction: the
 *  open one, else the latest closed one, so an opt-out stays where it was put. */
export async function personConversationOn(
  tx: Tx,
  channelId: number,
  profileId: string,
): Promise<ConversationRow | null> {
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.channelId, channelId), eq(conversations.authorProfileId, profileId)))
    .orderBy(sql`${conversations.closedReason} is null desc`, desc(conversations.id))
    .limit(1)
    .for("update");
  return conversation ?? null;
}

/** What a conversation that opens from something Engager found says it opened from. */
type ConversationOrigin = { kind: "room"; discoveredPostId: number } | { kind: "lead"; leadId: number };

/**
 * The conversation a lead Scout serves rides on: the person's own on this account
 * — the open one, else the latest closed one, which `recordLeadServed` then
 * refuses — or a new one owned by the campaign, opened from the lead. The
 * identity row is made as an owner's press makes it.
 */
export async function openLeadConversation(
  tx: Tx,
  input: { channelId: number; campaignId: number; profileId: string; leadId: number; now: number },
): Promise<ConversationRow> {
  return openOwnerConversation(tx, { ...input, openedFrom: { kind: "lead", leadId: input.leadId } });
}

export type RecordedLeadServed = {
  conversation: ConversationRow;
  /** The `lead_served` event the conversation holds for this lead. */
  event: ConversationEventRow;
  /** False when the lead had been served before: nothing was written. */
  recorded: boolean;
};

/**
 * Record on a conversation that Scout served a lead: one `lead_served` event naming
 * the lead and the signal of theirs the opener answers, with the eligibility
 * table's decision for it. The digest is the lead's own, so serving the same
 * lead again records nothing. It sends and drafts nothing: the event only
 * gives the Ambassador's steps something to start on. Null when the conversation is
 * not this org's, and when the table does not find the person eligible (a
 * closed conversation, a block, a conversation the owner holds): nothing is recorded
 * for them.
 */
export async function recordLeadServed(
  tx: Tx,
  input: {
    conversationId: number;
    leadId: number;
    signal: { id: number; postUrn: string; commentUrn: string | null };
    /** The Find leads run that served them; none for the owner's press. */
    runId?: number | null;
    now: number;
  },
): Promise<RecordedLeadServed | null> {
  const { now } = input;
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).for("update");
  if (!conversation) return null;
  const digest = sha256(JSON.stringify(["lead_served", input.leadId]));
  const [prior] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.digest, digest)));
  if (prior) return { conversation, event: prior, recorded: false };

  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const eligibility = evaluateEligibility({
    event: { type: "lead_served", occurredAt: now },
    conversation: await standing(tx, conversation),
    policy,
    excluded: await doNotEngage(tx, conversation.authorProfileId),
  });
  if (eligibility.decision !== "eligible") return null;
  const event = await appendEvent(tx, {
    conversationId: conversation.id,
    type: "lead_served",
    source: "find_leads",
    sourceRef: {
      lead: { leadId: input.leadId, signalId: input.signal.id, ...(input.runId != null ? { runId: input.runId } : {}) },
      postUrn: input.signal.postUrn,
      ...(input.signal.commentUrn ? { commentUrn: input.signal.commentUrn } : {}),
    },
    digest,
    occurredAt: now,
    observedAt: now,
    attribution: { method: "derived", profileId: conversation.authorProfileId },
    decision: { ...eligibility, policy: { dm: policy.dm, strategy: policy.versions } },
    ...retention("audit", now, policy),
    createdAt: now,
  });
  return { conversation, event, recorded: true };
}

export async function openRoomConversation(
  tx: Tx,
  input: { channelId: number; campaignId: number; profileId: string; discoveredPostId: number; now: number },
): Promise<ConversationRow> {
  return openOwnerConversation(tx, { ...input, openedFrom: { kind: "room", discoveredPostId: input.discoveredPostId } });
}

/**
 * The conversation an owner's own press on a person acts through: the one they
 * have — the open one, else the latest closed one, which the caller's ledger
 * door then refuses for its closing — or, for someone never met in a
 * conversation, a new one owned by `campaignId` — or by none, for someone no
 * campaign touched. The owner's press needs a conversation to ride on, and it
 * opens one whether or not the campaign runs on its strategy: conversations
 * otherwise open only on a reply to a campaign that does (`conversationScope`),
 * and opening this one gives no worker a reason to wake on it.
 */
export async function openOwnerConversation(
  tx: Tx,
  input: { channelId: number; campaignId: number | null; profileId: string; now: number; openedFrom?: ConversationOrigin },
): Promise<ConversationRow> {
  if (input.openedFrom?.kind === "room") {
    const [source] = await tx.select({ campaign: campaigns }).from(discoveredPosts)
      .innerJoin(campaigns, eq(campaigns.id, discoveredPosts.campaignId))
      .where(eq(discoveredPosts.id, input.openedFrom.discoveredPostId));
    const campaign = source?.campaign;
    if (!campaign || campaign.id !== input.campaignId || campaign.channelId !== input.channelId) {
      throw new AppError("room_source_mismatch", "That room does not belong to this campaign and account.", 409);
    }
    const room = await listRoomMembers(tx, campaign, input.openedFrom.discoveredPostId, undefined, input.now);
    if (!room || room.stale || !room.members.some((member) => member.fit === "fits" && member.personKey === `p.${input.profileId}`)) {
      throw new AppError("room_person_unavailable", "Research needs to check this person in the room again.", 409);
    }
  }
  const existing = await personConversationOn(tx, input.channelId, input.profileId);
  if (existing) return existing;
  // The identity row the conversation hangs on, as a reply's conversation takes it.
  await tx.insert(authorProfiles).values({ profileId: input.profileId, fetchedAt: 0 }).onConflictDoNothing();
  return openConversation(tx, { campaignId: input.campaignId, channelId: input.channelId, openedFrom: input.openedFrom }, input.profileId, input.now);
}

async function openConversation(
  tx: Tx,
  scope: { campaignId: number | null; channelId: number; openedFrom?: ConversationOrigin },
  profileId: string,
  now: number,
): Promise<ConversationRow> {
  const [opened] = await tx
    .insert(conversations)
    .values({
      channelId: scope.channelId,
      authorProfileId: profileId,
      owningCampaignId: scope.campaignId,
      openedFrom: scope.openedFrom?.kind ?? null,
      openedFromPostId: scope.openedFrom?.kind === "room" ? scope.openedFrom.discoveredPostId : null,
      openedFromLeadId: scope.openedFrom?.kind === "lead" ? scope.openedFrom.leadId : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (opened) return opened;
  // Another transaction opened it first; the open-person index made it wait.
  const raced = await personConversationOn(tx, scope.channelId, profileId);
  if (!raced) throw new Error(`no conversation for ${profileId} on channel ${scope.channelId}`);
  return raced;
}

/** The conversation's standing as the eligibility table reads it, an invitation
 *  confirmed on its log and the reasons of a review it waits in included. */
async function standing(tx: Tx, conversation: ConversationRow): Promise<ConversationState> {
  const [invitation] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversation.id),
        eq(conversationEvents.type, "invitation_confirmed"),
      ),
    )
    .limit(1);
  return {
    relationship: conversation.relationship,
    relationshipCheckedAt: conversation.relationshipCheckedAt,
    opsStatus: conversation.opsStatus,
    opsStatusAt: conversation.opsStatusAt,
    closedReason: conversation.closedReason,
    hasInterest: conversation.interestEvidenceEventId !== null,
    invited: invitation !== undefined,
    reviewReasons: await openReviewReasons(tx, conversation),
  };
}

/** The person's copy of a relationship a read could tell: it follows the
 *  newest such read on any of the org's accounts, where the conversation's is its
 *  own account's. */
async function followRead(
  tx: Tx,
  conversation: Pick<ConversationRow, "authorProfileId" | "channelId">,
  relationship: Exclude<ConversationRelationship, "unknown">,
  read: RelationshipRead,
): Promise<void> {
  await tx
    .update(authorProfiles)
    .set({
      relationship,
      relationshipCheckedAt: read.observedAt,
      identityEvidence: { method: "relationship_read", channelId: conversation.channelId, read },
    })
    .where(
      and(
        eq(authorProfiles.profileId, conversation.authorProfileId),
        or(
          isNull(authorProfiles.relationshipCheckedAt),
          lte(authorProfiles.relationshipCheckedAt, read.observedAt),
        ),
      ),
    );
}

async function doNotEngage(tx: Tx, profileId: string): Promise<boolean> {
  const [profile] = await tx
    .select({ doNotEngage: engagedProfiles.doNotEngage })
    .from(engagedProfiles)
    .where(eq(engagedProfiles.profileId, profileId));
  return profile?.doNotEngage ?? false;
}

/** The decisions a person or a source earns as a record of their own: an
 *  opt-out outlives the words that said it, and a skip is the audit trail of
 *  why a source earned nothing. */
function derivedDecision(eligibility: Eligibility): "opt_out" | "source_skipped" | null {
  if (eligibility.effects.close === "opt_out") return "opt_out";
  if (eligibility.decision === "source_skipped") return "source_skipped";
  return null;
}

function retention(
  retentionClass: RetentionClass,
  observedAt: number,
  policy: ConversationPolicy,
): { retentionClass: RetentionClass; expiresAt: number | null } {
  const days =
    retentionClass === "content"
      ? policy.retention.content_days
      : retentionClass === "audit"
        ? policy.retention.audit_days
        : null;
  return { retentionClass, expiresAt: days === null ? null : observedAt + days * DAY };
}

/** Write what the decision moves onto the conversation, each column from its own
 *  evidence, and the stage summarized from the result. */
async function applyEffects(
  tx: Tx,
  conversation: ConversationRow,
  event: ConversationEventRow,
  eligibility: Eligibility,
  policy: ConversationPolicy,
  now: number,
): Promise<ConversationRow> {
  const { effects } = eligibility;
  const next = {
    relationship: effects.relationship ?? conversation.relationship,
    relationshipCheckedAt: effects.relationship
      ? event.observedAt
      : conversation.relationshipCheckedAt,
    opsStatus: effects.opsStatus ?? conversation.opsStatus,
    opsStatusAt: effects.opsStatus ? event.occurredAt : conversation.opsStatusAt,
    interestEvidenceEventId:
      conversation.interestEvidenceEventId ?? (effects.interest ? event.id : null),
    closedReason: conversation.closedReason ?? effects.close ?? null,
    closedAt: conversation.closedAt ?? (effects.close ? now : null),
    ctaEventId: conversation.ctaEventId,
    outcome: conversation.outcome,
    canonicalDmThreadId: conversation.canonicalDmThreadId,
  };
  const suppressed = next.closedReason !== null;
  const [updated] = await tx
    .update(conversations)
    .set({
      ...next,
      derivedStage: deriveStage(next),
      retentionClass: suppressed ? "suppression" : "audit",
      expiresAt: suppressed ? null : event.observedAt + policy.retention.audit_days * DAY,
      updatedAt: now,
    })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return updated!;
}

async function appendEvent(
  tx: Tx,
  values: typeof conversationEvents.$inferInsert,
): Promise<ConversationEventRow> {
  const [event] = await tx.insert(conversationEvents).values(values).returning();
  return event!;
}

function withoutEvidence<Verdict extends { evidence: unknown }>(
  verdict: Verdict,
): Omit<Verdict, "evidence"> {
  const { evidence: _evidence, ...label } = verdict;
  return label;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
