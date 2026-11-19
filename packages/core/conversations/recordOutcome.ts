import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  campaigns,
  conversations,
  outcomeEvents,
  type ConversationRow,
  type OutcomeAttributionMethod,
  type OutcomeEventRow,
  type OutcomeSourceType,
  type OutcomeType,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { conversationEventArrived } from "../agentStep/wait";
import {
  isFact,
  linkedInIdentityRefusal,
  projectConversationOutcomes,
  standingEvents,
  supersedeRefusal,
  type OutcomeFact,
  type OutcomeRefusal,
} from "./outcomes";
import { conversationPolicy } from "./policy";
import type { ReceiptRow } from "./receipt";
import { recordOutcomeEvidence } from "./record";

/**
 * The writers of conversion evidence (spec §18 R15). v1 has two: the owner's
 * attestation (`user_confirmed`) and a receipt the owner imports
 * (`receipt_reviewed`); the provider arm is `outcomes.ts#recordProviderOutcome`
 * and refuses. Rows are appended, never updated — a correction, a
 * cancellation or a refund supersedes — and every write re-projects the
 * conversations it touched and their people's leads. A booking, an activation or
 * a payment on a conversation is also recorded there as its verified evidence,
 * which wakes the step that checks outcomes at once ({@link evidenceArrived}).
 * Conversations exist only for campaigns that run on their strategy, and every
 * writer refuses for one that does not.
 */

const DAY = 86_400_000;

export type RecordedOutcome = {
  ok: true;
  event: OutcomeEventRow;
  /** False when this outcome was already recorded; `event` is that row. */
  recorded: boolean;
  /** The conversation as re-projected; null for an outcome on no conversation. */
  conversation: ConversationRow | null;
};

/**
 * Record the owner's word that a person reached an outcome — "they booked",
 * "they activated" — on their conversation: `user_confirmed`, attributed by the
 * owner. `reference` is the owner's own id for it (a booking or invoice
 * number) and dedups a repeat — as does a receipt row already imported under
 * it; without one, the same fact already standing on the conversation is the
 * repeat. The conversation's outcome columns and the person's lead follow.
 */
export async function recordOutcome(
  tx: Tx,
  input: {
    conversationId: number;
    type: OutcomeFact;
    occurredAt: number;
    note?: string | null;
    evidenceRef?: string | null;
    reference?: string | null;
    /** An identifier the person gave themselves; stored only as a hash. */
    customerRef?: string | null;
    recordedBy: string;
    now: number;
  },
): Promise<RecordedOutcome | OutcomeRefusal> {
  const refused =
    linkedInIdentityRefusal({
      note: input.note,
      evidenceRef: input.evidenceRef,
      reference: input.reference,
      customerRef: input.customerRef,
    }) ?? futureRefusal(input.occurredAt, input.now);
  if (refused) return refused;
  await lockOutcomes(tx);
  const conversation = await agenticConversation(tx, input.conversationId);
  if (!("id" in conversation)) return conversation;

  // The same fact already standing is the repeat: without a reference, any of
  // its type; with one, a receipt row imported under that id.
  const repeat = standingEvents(await outcomesOf(tx, conversation.id)).find(
    (event) =>
      event.type === input.type &&
      (!input.reference ||
        (event.sourceType === "imported_receipt" && event.sourceEventId === input.reference)),
  );
  if (repeat) return { ok: true, event: repeat, recorded: false, conversation };

  let sourceEventId: string;
  if (input.reference) {
    sourceEventId = `ref:${input.reference}`;
    const existing = await bySource(tx, "owner_attestation", sourceEventId);
    if (existing) {
      if (existing.conversationId !== conversation.id || existing.type !== input.type) {
        return {
          ok: false,
          reason: "source_event_conflict",
          message: `${sourceEventId} already names outcome ${existing.id}, a different fact`,
          eventId: existing.id,
        };
      }
      const head = await chainHead(tx, existing);
      if (head.id !== existing.id) return supersededRefusal(existing, head);
      return { ok: true, event: existing, recorded: false, conversation };
    }
  } else {
    // Unreferenced, the fact is named by its conversation, type and time; once
    // recorded and since reversed, the same words again are a new event after
    // that chain, named by the chain's head.
    // Persisted idempotency key: keeps its `journey:` prefix.
    sourceEventId = `journey:${conversation.id}:${input.type}:${input.occurredAt}`;
    for (;;) {
      const taken = await bySource(tx, "owner_attestation", sourceEventId);
      if (!taken) break;
      const head = await chainHead(tx, taken);
      if (head.id === taken.id) return { ok: true, event: taken, recorded: false, conversation };
      // Persisted idempotency key: keeps its `journey:` prefix.
      sourceEventId = `journey:${conversation.id}:${input.type}:${input.occurredAt}:after:${head.id}`;
    }
  }

  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const [event] = await tx
    .insert(outcomeEvents)
    .values({
      channelId: conversation.channelId,
      authorProfileId: conversation.authorProfileId,
      conversationId: conversation.id,
      type: input.type,
      occurredAt: input.occurredAt,
      observedAt: input.now,
      sourceType: "owner_attestation",
      sourceEventId,
      evidenceRef: input.evidenceRef ?? null,
      verificationStatus: "user_confirmed",
      attributionMethod: "user_confirmed",
      customerRefHash: input.customerRef
        ? customerRefHash(conversation.organizationId, input.customerRef)
        : null,
      note: input.note ?? null,
      recordedBy: input.recordedBy,
      expiresAt: input.now + policy.retention.audit_days * DAY,
      createdAt: input.now,
    })
    .returning();
  await evidenceArrived(tx, event!, input.now);
  return {
    ok: true,
    event: event!,
    recorded: true,
    conversation: await projectConversationOutcomes(tx, conversation, input.now),
  };
}

/**
 * Append the owner's correction of an outcome: `cancelled` (a booking called
 * off, a fact recorded in error), `refunded` (a payment returned) or a fact
 * restating it (another type or time, or a reversal reversed). The new event
 * supersedes the old, which then counts nowhere; an event is superseded once,
 * so a correction of a correction names the newer one. It keeps the old
 * event's person — except an outcome no conversation claimed, which `conversationId`
 * attributes on the owner's word.
 */
export async function supersedeOutcome(
  tx: Tx,
  input: {
    eventId: number;
    type: OutcomeType;
    occurredAt: number;
    conversationId?: number | null;
    note?: string | null;
    evidenceRef?: string | null;
    reference?: string | null;
    recordedBy: string;
    now: number;
  },
): Promise<RecordedOutcome | OutcomeRefusal> {
  const refused =
    linkedInIdentityRefusal({
      note: input.note,
      evidenceRef: input.evidenceRef,
      reference: input.reference,
    }) ?? futureRefusal(input.occurredAt, input.now);
  if (refused) return refused;
  await lockOutcomes(tx);
  const [target] = await tx
    .select()
    .from(outcomeEvents)
    .where(eq(outcomeEvents.id, input.eventId));
  if (!target) {
    return {
      ok: false,
      reason: "outcome_not_found",
      message: `outcome ${input.eventId} not found in this organization`,
    };
  }
  // A correction is named by what it supersedes, so a reference the
  // corrected outcome was recorded under (a refund of invoice INV-7) is free.
  const sourceEventId = input.reference
    ? `ref:${input.reference}:supersedes:${target.id}`
    : `supersedes:${target.id}`;
  const existing = await bySource(tx, "owner_attestation", sourceEventId);
  if (existing) {
    if (existing.supersedesEventId !== target.id || existing.type !== input.type) {
      return {
        ok: false,
        reason: "source_event_conflict",
        message: `${sourceEventId} already names outcome ${existing.id}, a different correction`,
        eventId: existing.id,
      };
    }
    const conversation = existing.conversationId === null ? null : await conversationRow(tx, existing.conversationId);
    return { ok: true, event: existing, recorded: false, conversation };
  }
  const head = await chainHead(tx, target);
  if (head.id !== target.id) return supersededRefusal(target, head);
  const invalid = supersedeRefusal(target.type, input.type);
  if (invalid) return { ok: false, reason: "invalid_supersede", message: invalid };

  const attributing = input.conversationId ?? null;
  if (attributing !== null && target.conversationId !== null && attributing !== target.conversationId) {
    return {
      ok: false,
      reason: "invalid_supersede",
      message: `outcome ${target.id} is attributed to conversation ${target.conversationId}; cancel it and record the outcome on the right conversation`,
    };
  }
  const conversationId = target.conversationId ?? attributing;
  let conversation: ConversationRow | null = null;
  if (conversationId !== null) {
    const found = await agenticConversation(tx, conversationId);
    if (!("id" in found)) return found;
    if (found.channelId !== target.channelId) {
      return {
        ok: false,
        reason: "conversation_not_found",
        message: `conversation ${conversationId} is not on the account outcome ${target.id} was recorded on`,
      };
    }
    conversation = found;
  }
  const attributionMethod: OutcomeAttributionMethod =
    target.conversationId !== null ? target.attributionMethod : conversation ? "user_confirmed" : "unknown";
  const policy = await conversationPolicy(tx, conversation?.owningCampaignId ?? null);
  const [event] = await tx
    .insert(outcomeEvents)
    .values({
      channelId: target.channelId,
      authorProfileId: conversation?.authorProfileId ?? null,
      conversationId: conversation?.id ?? null,
      type: input.type,
      occurredAt: input.occurredAt,
      observedAt: input.now,
      sourceType: "owner_attestation",
      sourceEventId,
      evidenceRef: input.evidenceRef ?? null,
      verificationStatus: "user_confirmed",
      attributionMethod,
      customerRefHash: target.customerRefHash,
      note: input.note ?? null,
      supersedesEventId: target.id,
      recordedBy: input.recordedBy,
      expiresAt: input.now + policy.retention.audit_days * DAY,
      createdAt: input.now,
    })
    .returning();
  await evidenceArrived(tx, event!, input.now);
  return {
    ok: true,
    event: event!,
    recorded: true,
    conversation: conversation ? await projectConversationOutcomes(tx, conversation, input.now) : null,
  };
}

export type ImportedRow = {
  /** 1-based. */
  row: number;
  eventId: number;
  /** False for a row already imported. */
  recorded: boolean;
  type: OutcomeType;
  attributionMethod: OutcomeAttributionMethod;
  conversationId: number | null;
};

export type ImportedReceipt = {
  ok: true;
  rows: ImportedRow[];
  recorded: number;
  duplicates: number;
};

/**
 * Import a receipt the owner provides onto the account `campaignId` lives on:
 * each row one `receipt_reviewed` event, deduplicated by its source id and the
 * redacted hash of its contents. A row is attributed when the owner named the
 * conversation (`user_confirmed`) or its `customerRef` matches exactly one conversation
 * on the account already holding that identifier (`consented_identifier`); a
 * named conversation its identifier contradicts, an identifier on several conversations
 * or on none, and a row naming neither are `unknown` and attach to no
 * conversation. A row that reverses another inherits its person.
 *
 * All rows or none: every row is checked before the first is written, and a
 * refused row refuses the import.
 */
export async function importReceipt(
  tx: Tx,
  input: { campaignId: number; rows: ReceiptRow[]; recordedBy: string; now: number },
): Promise<ImportedReceipt | OutcomeRefusal> {
  await lockOutcomes(tx);
  const [campaign] = await tx
    .select({
      id: campaigns.id,
      organizationId: campaigns.organizationId,
      channelId: campaigns.channelId,
    })
    .from(campaigns)
    .where(eq(campaigns.id, input.campaignId));
  if (!campaign) {
    return {
      ok: false,
      reason: "campaign_not_found",
      message: `campaign ${input.campaignId} not found in this organization`,
    };
  }
  if (campaign.channelId === null) {
    return notAgentic(campaign.id);
  }
  const channelId = campaign.channelId;
  const refuse = (
    index: number,
    refusal: Omit<OutcomeRefusal, "ok" | "row">,
  ): OutcomeRefusal => ({
    ok: false,
    ...refusal,
    message: `row ${index + 1}: ${refusal.message}`,
    row: index + 1,
  });

  // Plan every row against what is recorded and what the rows before it will
  // write; only a receipt with no refused row is written.
  const plans: ReceiptPlan[] = [];
  for (const [index, row] of input.rows.entries()) {
    const refused =
      linkedInIdentityRefusal({
        sourceEventId: row.sourceEventId,
        customerRef: row.customerRef,
        supersedesSourceEventId: row.supersedesSourceEventId,
      }) ?? futureRefusal(row.occurredAt, input.now);
    if (refused) return refuse(index, refused);
    const evidenceRef = receiptHash(campaign.organizationId, row);

    // The same source id again is the same event: a repeat when its contents
    // match, a conflict when they do not — a changed row supersedes instead.
    const prior = await receiptTarget(tx, plans, channelId, row.sourceEventId);
    if (prior) {
      if (prior.evidenceRef !== evidenceRef) {
        return refuse(index, {
          reason: "source_event_conflict",
          message: `${row.sourceEventId} was already imported with different contents; restate or reverse it with a row naming it in supersedesSourceEventId`,
          ...("eventId" in prior.ref ? { eventId: prior.ref.eventId } : {}),
        });
      }
      plans.push({ kind: "repeat", index, row, of: prior });
      continue;
    }

    const hashed = row.customerRef
      ? customerRefHash(campaign.organizationId, row.customerRef)
      : null;
    if (row.supersedesSourceEventId !== null) {
      const target = await receiptTarget(tx, plans, channelId, row.supersedesSourceEventId);
      if (!target || target.channelId !== channelId) {
        return refuse(index, {
          reason: "outcome_not_found",
          message: `${row.supersedesSourceEventId} names no receipt row imported on this account`,
        });
      }
      if (
        target.superseded ||
        plans.some((plan) => plan.kind === "write" && sameRef(plan.supersedes, target.ref))
      ) {
        return refuse(index, {
          reason: "already_superseded",
          message: `${row.supersedesSourceEventId} is already superseded`,
          ...("eventId" in target.ref ? { eventId: target.ref.eventId } : {}),
        });
      }
      const invalid = supersedeRefusal(target.type, row.type);
      if (invalid) return refuse(index, { reason: "invalid_supersede", message: invalid });
      plans.push({
        kind: "write",
        index,
        row,
        evidenceRef,
        customerRefHash: hashed ?? target.customerRefHash,
        conversation: target.conversation,
        attributionMethod: target.attributionMethod,
        supersedes: target.ref,
      });
      continue;
    }

    if (!isFact(row.type)) {
      return refuse(index, {
        reason: "invalid_supersede",
        message: `a ${row.type} row names the row it reverses in supersedesSourceEventId`,
      });
    }
    let named: Person | null = null;
    if (row.conversationId !== null) {
      const [conversation] = await tx
        .select({
          id: conversations.id,
          authorProfileId: conversations.authorProfileId,
          campaignId: campaigns.id,
        })
        .from(conversations)
        .leftJoin(campaigns, eq(conversations.owningCampaignId, campaigns.id))
        .where(and(eq(conversations.id, row.conversationId), eq(conversations.channelId, channelId)));
      if (!conversation) {
        return refuse(index, {
          reason: "conversation_not_found",
          message: `conversation ${row.conversationId} is not on this campaign's account`,
        });
      }
      if (conversation.campaignId === null) {
        return refuse(index, {
          reason: "campaign_not_agentic",
          message: `conversation ${row.conversationId}'s campaign is gone`,
        });
      }
      named = { id: conversation.id, authorProfileId: conversation.authorProfileId };
    }
    const attribution = await attribute(tx, { channelId, named, customerRefHash: hashed, plans });
    const attested = attribution.conversation
      ? await attestedFact(tx, plans, attribution.conversation.id, row)
      : null;
    plans.push({
      kind: "write",
      index,
      row,
      evidenceRef,
      customerRefHash: hashed ?? attested?.customerRefHash ?? null,
      conversation: attribution.conversation,
      attributionMethod: attribution.method,
      supersedes: attested ? { eventId: attested.id } : null,
    });
  }

  const policy = await conversationPolicy(tx, campaign.id);
  const written = new Map<number, OutcomeEventRow>();
  const eventIdOf = (ref: ReceiptRef) =>
    "eventId" in ref ? ref.eventId : written.get(ref.planned)!.id;
  const rows: ImportedRow[] = [];
  for (const plan of plans) {
    if (plan.kind === "repeat") {
      rows.push({
        row: plan.index + 1,
        eventId: eventIdOf(plan.of.ref),
        recorded: false,
        type: plan.row.type,
        attributionMethod: plan.of.attributionMethod,
        conversationId: plan.of.conversation?.id ?? null,
      });
      continue;
    }
    const [event] = await tx
      .insert(outcomeEvents)
      .values({
        channelId,
        authorProfileId: plan.conversation?.authorProfileId ?? null,
        conversationId: plan.conversation?.id ?? null,
        type: plan.row.type,
        occurredAt: plan.row.occurredAt,
        observedAt: input.now,
        sourceType: "imported_receipt",
        sourceEventId: plan.row.sourceEventId,
        evidenceRef: plan.evidenceRef,
        verificationStatus: "receipt_reviewed",
        attributionMethod: plan.attributionMethod,
        customerRefHash: plan.customerRefHash,
        supersedesEventId: plan.supersedes === null ? null : eventIdOf(plan.supersedes),
        recordedBy: input.recordedBy,
        expiresAt: input.now + policy.retention.audit_days * DAY,
        createdAt: input.now,
      })
      .returning();
    written.set(plan.index, event!);
    rows.push({
      row: plan.index + 1,
      eventId: event!.id,
      recorded: true,
      type: event!.type,
      attributionMethod: event!.attributionMethod,
      conversationId: event!.conversationId,
    });
  }

  const touched = [
    ...new Set(
      plans.flatMap((plan) => (plan.kind === "write" && plan.conversation ? [plan.conversation.id] : [])),
    ),
  ];
  if (touched.length > 0) {
    const locked = await tx
      .select()
      .from(conversations)
      .where(inArray(conversations.id, touched))
      .orderBy(asc(conversations.id))
      .for("update");
    for (const conversation of locked) await projectConversationOutcomes(tx, conversation, input.now);
  }
  // After the projection, which locks every conversation the receipt touched in id
  // order: the evidence then locks no conversation the import does not hold.
  for (const event of written.values()) await evidenceArrived(tx, event, input.now);
  const recorded = rows.filter((row) => row.recorded).length;
  return { ok: true, rows, recorded, duplicates: rows.length - recorded };
}

type Person = { id: number; authorProfileId: string };

/** A receipt row's event: one already recorded, or the one an earlier row of
 *  the same receipt will write. */
type ReceiptRef = { eventId: number } | { planned: number };

type ReceiptPlan =
  | { kind: "repeat"; index: number; row: ReceiptRow; of: ReceiptTarget }
  | {
      kind: "write";
      index: number;
      row: ReceiptRow;
      evidenceRef: string;
      customerRefHash: string | null;
      conversation: Person | null;
      attributionMethod: OutcomeAttributionMethod;
      supersedes: ReceiptRef | null;
    };

type ReceiptTarget = {
  ref: ReceiptRef;
  channelId: number;
  type: OutcomeType;
  evidenceRef: string | null;
  customerRefHash: string | null;
  conversation: Person | null;
  attributionMethod: OutcomeAttributionMethod;
  /** Already superseded by a recorded event. */
  superseded: boolean;
};

function sameRef(a: ReceiptRef | null, b: ReceiptRef): boolean {
  if (a === null) return false;
  return "eventId" in a
    ? "eventId" in b && a.eventId === b.eventId
    : "planned" in b && a.planned === b.planned;
}

/** The imported event `sourceEventId` names: the one an earlier row of this
 *  receipt writes, else one an earlier import recorded. */
async function receiptTarget(
  tx: Tx,
  plans: readonly ReceiptPlan[],
  channelId: number,
  sourceEventId: string,
): Promise<ReceiptTarget | null> {
  const earlier = plans.find((plan) => plan.row.sourceEventId === sourceEventId);
  if (earlier?.kind === "repeat") return earlier.of;
  if (earlier) {
    return {
      ref: { planned: earlier.index },
      channelId,
      type: earlier.row.type,
      evidenceRef: earlier.evidenceRef,
      customerRefHash: earlier.customerRefHash,
      conversation: earlier.conversation,
      attributionMethod: earlier.attributionMethod,
      superseded: false,
    };
  }
  const recorded = await bySource(tx, "imported_receipt", sourceEventId);
  if (!recorded) return null;
  return {
    ref: { eventId: recorded.id },
    channelId: recorded.channelId,
    type: recorded.type,
    evidenceRef: recorded.evidenceRef,
    customerRefHash: recorded.customerRefHash,
    conversation:
      recorded.conversationId === null
        ? null
        : { id: recorded.conversationId, authorProfileId: recorded.authorProfileId! },
    attributionMethod: recorded.attributionMethod,
    superseded: (await chainHead(tx, recorded)).id !== recorded.id,
  };
}

/**
 * The owner's word a receipt row confirms: a `user_confirmed` fact of the
 * row's type standing on the conversation the row is attributed to, which the row
 * then supersedes — one fact, now on a receipt, never the same fact twice.
 * The attestation recorded under the row's own id comes first, then the
 * earliest; one an earlier row of the receipt already confirms is spent.
 */
async function attestedFact(
  tx: Tx,
  plans: readonly ReceiptPlan[],
  conversationId: number,
  row: ReceiptRow,
): Promise<OutcomeEventRow | null> {
  const confirmed = new Set(
    plans.flatMap((plan) =>
      plan.kind === "write" && plan.supersedes !== null && "eventId" in plan.supersedes
        ? [plan.supersedes.eventId]
        : [],
    ),
  );
  const attested = standingEvents(await outcomesOf(tx, conversationId))
    .filter(
      (event) =>
        event.type === row.type &&
        event.verificationStatus === "user_confirmed" &&
        !confirmed.has(event.id),
    )
    .sort((a, b) => a.occurredAt - b.occurredAt || a.id - b.id);
  return (
    attested.find((event) => event.sourceEventId === `ref:${row.sourceEventId}`) ??
    attested[0] ??
    null
  );
}

/**
 * The person a fact row is attributed to. The owner naming a conversation is
 * `user_confirmed` unless the row's identifier is held only by others; an
 * identifier held by exactly one conversation on the account — through an event
 * already recorded or a row earlier in the same receipt — is
 * `consented_identifier`, when that conversation's campaign runs on its
 * strategy. Every other case is `unknown`, on no conversation.
 */
async function attribute(
  tx: Tx,
  input: {
    channelId: number;
    named: Person | null;
    customerRefHash: string | null;
    plans: readonly ReceiptPlan[];
  },
): Promise<{ method: OutcomeAttributionMethod; conversation: Person | null }> {
  const holders = new Map<number, { person: Person; owned: boolean }>();
  if (input.customerRefHash !== null) {
    const recorded = await tx
      .selectDistinct({
        id: conversations.id,
        authorProfileId: conversations.authorProfileId,
        campaignId: campaigns.id,
      })
      .from(outcomeEvents)
      .innerJoin(conversations, eq(outcomeEvents.conversationId, conversations.id))
      .leftJoin(campaigns, eq(conversations.owningCampaignId, campaigns.id))
      .where(
        and(
          eq(outcomeEvents.customerRefHash, input.customerRefHash),
          eq(conversations.channelId, input.channelId),
        ),
      );
    for (const { campaignId, ...person } of recorded) {
      holders.set(person.id, { person, owned: campaignId !== null });
    }
    for (const plan of input.plans) {
      if (plan.kind === "write" && plan.customerRefHash === input.customerRefHash && plan.conversation) {
        holders.set(plan.conversation.id, { person: plan.conversation, owned: true });
      }
    }
  }
  if (input.named) {
    // The identifier contradicts the owner only when others hold it and the
    // conversation named does not; an address the named person shares takes
    // nothing from the owner's word.
    const contradicted = holders.size > 0 && !holders.has(input.named.id);
    return contradicted
      ? { method: "unknown", conversation: null }
      : { method: "user_confirmed", conversation: input.named };
  }
  const [only, ...others] = holders.values();
  return only?.owned && others.length === 0
    ? { method: "consented_identifier", conversation: only.person }
    : { method: "unknown", conversation: null };
}

/**
 * A verified booking, activation or payment on a conversation is the input a
 * Check outcome step enters on: recorded on the conversation as that evidence, it
 * wakes the campaign's Ambassador and ends the waits on `outcome_evidence`
 * there at once (`conversationEventArrived`), rather than leaving them to their
 * timeout — where the campaign's strategy has a step it enters.
 */
async function evidenceArrived(tx: Tx, outcome: OutcomeEventRow, now: number): Promise<void> {
  const recorded = await recordOutcomeEvidence(tx, { outcome, now });
  const campaignId = recorded?.conversation.owningCampaignId ?? null;
  if (!recorded?.recorded || campaignId === null) return;
  await conversationEventArrived(tx, { campaignId, event: recorded.event, now });
}

function futureRefusal(occurredAt: number, now: number): OutcomeRefusal | null {
  return occurredAt > now
    ? {
        ok: false,
        reason: "occurred_in_future",
        message: "occurredAt is in the future; an outcome is recorded once it has happened",
      }
    : null;
}

function notAgentic(campaignId: number | null): OutcomeRefusal {
  return {
    ok: false,
    reason: "campaign_not_agentic",
    message:
      campaignId === null
        ? "the conversation's campaign is gone; outcomes are recorded only on conversations of a campaign"
        : `campaign ${campaignId} has no account to record outcomes on`,
  };
}

function supersededRefusal(event: OutcomeEventRow, head: OutcomeEventRow): OutcomeRefusal {
  return {
    ok: false,
    reason: "already_superseded",
    message: `outcome ${event.id} is already superseded; supersede ${head.id}, the latest in its chain`,
    eventId: head.id,
  };
}

/** Every outcome write of the org runs one at a time: what stands, what is
 *  superseded and what repeats are read and written under one lock. */
async function lockOutcomes(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('outcome_events:' || coalesce(current_setting('app.current_org', true), ''), 0))`,
  );
}

/** The conversation, when its owning campaign still exists. */
async function agenticConversation(tx: Tx, conversationId: number): Promise<ConversationRow | OutcomeRefusal> {
  const conversation = await conversationRow(tx, conversationId);
  if (!conversation) {
    return {
      ok: false,
      reason: "conversation_not_found",
      message: `conversation ${conversationId} not found in this organization`,
    };
  }
  const [campaign] =
    conversation.owningCampaignId === null
      ? []
      : await tx
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(eq(campaigns.id, conversation.owningCampaignId));
  if (!campaign) return notAgentic(conversation.owningCampaignId);
  return conversation;
}

async function conversationRow(tx: Tx, conversationId: number): Promise<ConversationRow | null> {
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for("update");
  return conversation ?? null;
}

async function outcomesOf(tx: Tx, conversationId: number): Promise<OutcomeEventRow[]> {
  return tx.select().from(outcomeEvents).where(eq(outcomeEvents.conversationId, conversationId));
}

async function bySource(
  tx: Tx,
  sourceType: OutcomeSourceType,
  sourceEventId: string,
): Promise<OutcomeEventRow | null> {
  const [event] = await tx
    .select()
    .from(outcomeEvents)
    .where(
      and(
        eq(outcomeEvents.sourceType, sourceType),
        eq(outcomeEvents.sourceEventId, sourceEventId),
      ),
    );
  return event ?? null;
}

/** The newest event of `event`'s chain: `event` itself when nothing
 *  supersedes it. */
async function chainHead(tx: Tx, event: OutcomeEventRow): Promise<OutcomeEventRow> {
  let head = event;
  for (;;) {
    const [next] = await tx
      .select()
      .from(outcomeEvents)
      .where(eq(outcomeEvents.supersedesEventId, head.id));
    if (!next) return head;
    head = next;
  }
}

/** A consented identifier, hashed with the org so the stored value matches
 *  only inside it and never reads back as the identifier. */
function customerRefHash(organizationId: string, customerRef: string): string {
  return sha256(`customer:${organizationId}:${customerRef.trim().toLowerCase()}`);
}

/** The redacted receipt reference: a hash of the row as imported, which also
 *  tells a repeat import of the same row from a changed one. */
function receiptHash(organizationId: string, row: ReceiptRow): string {
  return `receipt:sha256:${sha256(
    JSON.stringify([
      organizationId,
      row.sourceEventId,
      row.type,
      row.occurredAt,
      row.conversationId,
      row.customerRef,
      row.supersedesSourceEventId,
    ]),
  )}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
