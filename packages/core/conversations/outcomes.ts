import { asc, eq } from "drizzle-orm";
import {
  CONVERSION_OUTCOMES,
  conversations,
  LINKEDIN_IDENTITY_PATTERNS,
  OUTCOME_VERIFICATION_STATUSES,
  outcomeEvents,
  type ConversionOutcome,
  type ConversationRow,
  type OutcomeAttributionMethod,
  type OutcomeEventRow,
  type OutcomeType,
  type OutcomeVerificationStatus,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { projectLeadStatus } from "./leads";
import { deriveStage } from "./state";

/**
 * Conversion evidence (spec §18 R15, INV-30): a CTA offered, a booking, an
 * activation and a payment are facts with a source and a verification state,
 * never a stage reached. This module reads them — what stands, what a conversation
 * and a campaign show — and `recordOutcome.ts` appends them. Nothing here or
 * there reads a message, a click or an acceptance: only the owner or a
 * receipt states an outcome.
 */

/** What an owner or a receipt can state; `cancelled` and `refunded` only ever
 *  reverse one of these. */
export const OUTCOME_FACTS = ["cta_offered", "booked", "activated", "paid"] as const;
export type OutcomeFact = (typeof OUTCOME_FACTS)[number];

export type OutcomeRefusalReason =
  | "conversation_not_found"
  | "campaign_not_found"
  | "campaign_not_agentic"
  | "outcome_not_found"
  | "already_superseded"
  | "invalid_supersede"
  | "linkedin_identity"
  | "occurred_in_future"
  | "source_event_conflict"
  | "integration_not_configured";

export type OutcomeRefusal = {
  ok: false;
  reason: OutcomeRefusalReason;
  message: string;
  /** The event the refusal is about: the head of a chain to supersede
   *  instead, or the row a source id already names. */
  eventId?: number;
  /** The receipt row refused, 1-based. */
  row?: number;
};

export function isFact(type: OutcomeType): type is OutcomeFact {
  return (OUTCOME_FACTS as readonly OutcomeType[]).includes(type);
}

function isConversion(type: OutcomeType): type is ConversionOutcome {
  return (CONVERSION_OUTCOMES as readonly OutcomeType[]).includes(type);
}

type Chained = Pick<OutcomeEventRow, "id" | "type" | "occurredAt" | "supersedesEventId">;

/** The events nothing supersedes: the head of every chain. */
export function standingEvents<T extends Chained>(events: readonly T[]): T[] {
  const superseded = new Set(
    events.flatMap((event) =>
      event.supersedesEventId === null ? [] : [event.supersedesEventId],
    ),
  );
  return events.filter((event) => !superseded.has(event.id));
}

/**
 * Why an event of type `next` may not supersede one of type `target`, or null
 * when it may: a refund reverses a payment, a cancellation any fact, and a
 * fact restates any event — a corrected type or time, or a reversal itself
 * reversed.
 */
export function supersedeRefusal(target: OutcomeType, next: OutcomeType): string | null {
  if (next === "refunded" && target !== "paid") {
    return `a refund reverses a payment, not ${target}`;
  }
  if (next === "cancelled" && !isFact(target)) {
    return `a cancellation reverses a fact, not ${target}; restate the fact instead`;
  }
  return null;
}

export type ConversationOutcomeFacts = Pick<ConversationRow, "ctaEventId" | "outcome" | "outcomeEventId">;

/**
 * A conversation's outcome columns from its outcome events: the latest standing
 * CTA, and the furthest standing conversion — a payment stays the conversation's
 * outcome when a later booking is recorded beside it, and a cancelled booking
 * stops being one.
 */
export function conversationOutcomeFacts(events: readonly Chained[]): ConversationOutcomeFacts {
  const standing = standingEvents(events);
  const ctaEventId = latestOf(standing, "cta_offered")?.id ?? null;
  const conversion = furthestConversion(standing);
  return conversion
    ? { ctaEventId, outcome: conversion.type, outcomeEventId: conversion.id }
    : { ctaEventId, outcome: null, outcomeEventId: null };
}

/** The furthest conversion among standing events — paid, then activated,
 *  then booked — the latest of its type. */
function furthestConversion<T extends Chained>(
  standing: readonly T[],
): (T & { type: ConversionOutcome }) | undefined {
  for (const outcome of [...CONVERSION_OUTCOMES].reverse()) {
    const event = latestOf(standing, outcome);
    if (event) return event as T & { type: ConversionOutcome };
  }
  return undefined;
}

function latestOf<T extends Chained>(events: readonly T[], type: OutcomeType): T | undefined {
  return events
    .filter((event) => event.type === type)
    .sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id)[0];
}

export type OutcomeCounts = Record<OutcomeFact, number>;

export type OutcomeCorrection = {
  eventId: number;
  type: OutcomeType;
  verificationStatus: OutcomeVerificationStatus;
  attributionMethod: OutcomeAttributionMethod;
  occurredAt: number;
  supersedes: { eventId: number; type: OutcomeType; verificationStatus: OutcomeVerificationStatus };
};

/**
 * A campaign's conversion evidence (spec §20: confirmed counts, attribution
 * coverage shown, no causal lift). `outcomes` counts the standing facts on the
 * campaign's conversations, one block per verification state — never summed, so an
 * owner's word never enters a receipt's count, nor either a provider's — and
 * lists every correction, cancellation and refund. `attributionCoverage`
 * counts converted people by how they were joined — one per conversation with a
 * standing conversion, by the method of the conversion its stage reads, so a
 * booking and a payment of one person are one — and its `unknown` counts the
 * account's conversions no conversation claims, which belong to no campaign and
 * enter no `outcomes` count.
 */
export type OutcomeReport = {
  outcomes: Record<OutcomeVerificationStatus, OutcomeCounts> & {
    corrections: OutcomeCorrection[];
  };
  attributionCoverage: Record<OutcomeAttributionMethod, number> & {
    /** The attributed share of everything counted here; null with none. */
    coverage: number | null;
  };
};

type Tallied = Chained &
  Pick<OutcomeEventRow, "conversationId" | "verificationStatus" | "attributionMethod">;

/** Tally an account's outcome events for the campaign owning `conversationIds`.
 *  What stands is read across every event given, so a correction retires what
 *  it corrects wherever either lives. */
export function tallyOutcomes(
  events: readonly Tallied[],
  conversationIds: ReadonlySet<number>,
): OutcomeReport {
  const ours = (event: Tallied) => event.conversationId !== null && conversationIds.has(event.conversationId);
  const inScope = (event: Tallied) => event.conversationId === null || ours(event);
  const counts = Object.fromEntries(
    OUTCOME_VERIFICATION_STATUSES.map((status) => [
      status,
      { cta_offered: 0, booked: 0, activated: 0, paid: 0 },
    ]),
  ) as Record<OutcomeVerificationStatus, OutcomeCounts>;
  const joined: Record<OutcomeAttributionMethod, number> = {
    user_confirmed: 0,
    consented_identifier: 0,
    unknown: 0,
  };
  const conversions = new Map<number, Tallied[]>();
  for (const event of standingEvents(events)) {
    if (!isFact(event.type) || !inScope(event)) continue;
    if (ours(event)) counts[event.verificationStatus][event.type] += 1;
    if (!isConversion(event.type)) continue;
    if (event.conversationId === null) joined.unknown += 1;
    else conversions.set(event.conversationId, [...(conversions.get(event.conversationId) ?? []), event]);
  }
  for (const standing of conversions.values()) {
    joined[furthestConversion(standing)!.attributionMethod] += 1;
  }
  const byId = new Map(events.map((event) => [event.id, event]));
  const corrections = events
    .filter((event) => event.supersedesEventId !== null && inScope(event))
    .sort((a, b) => a.id - b.id)
    .flatMap((event): OutcomeCorrection[] => {
      const target = byId.get(event.supersedesEventId!);
      if (!target) return [];
      return [
        {
          eventId: event.id,
          type: event.type,
          verificationStatus: event.verificationStatus,
          attributionMethod: event.attributionMethod,
          occurredAt: event.occurredAt,
          supersedes: {
            eventId: target.id,
            type: target.type,
            verificationStatus: target.verificationStatus,
          },
        },
      ];
    });
  const attributed = joined.user_confirmed + joined.consented_identifier;
  const total = attributed + joined.unknown;
  return {
    outcomes: { ...counts, corrections },
    attributionCoverage: { ...joined, coverage: total === 0 ? null : attributed / total },
  };
}

/** Refuse owner-given text that carries a LinkedIn address, urn or member id:
 *  outcome evidence never names a person by their LinkedIn identity. */
export function linkedInIdentityRefusal(
  fields: Record<string, string | null | undefined>,
): OutcomeRefusal | null {
  const address = new RegExp(LINKEDIN_IDENTITY_PATTERNS.address, "i");
  const memberId = new RegExp(LINKEDIN_IDENTITY_PATTERNS.memberId);
  for (const [name, value] of Object.entries(fields)) {
    if (value && (address.test(value) || memberId.test(value))) {
      return {
        ok: false,
        reason: "linkedin_identity",
        message: `${name} carries a LinkedIn address or member id; outcome evidence never names a person by their LinkedIn identity`,
      };
    }
  }
  return null;
}

/** The provider arm's input, for the integration spec §20 leaves open. */
export type ProviderOutcomeInput = {
  provider: string;
  sourceEventId: string;
  type: OutcomeType;
  occurredAt: number;
};

/**
 * A booking, activation or payment a calendar or billing provider verified.
 * Spec §20 leaves "activation strategy and outcome integrations" open, and a
 * local install calls no provider with an Engager key (INV-19), so no
 * integration is configured: the arm refuses, and nothing writes
 * `provider_verified` until a real one passes its own event tests.
 */
export function recordProviderOutcome(_input: ProviderOutcomeInput): OutcomeRefusal {
  return {
    ok: false,
    reason: "integration_not_configured",
    message:
      "No outcome provider is configured. Record the owner's word with update_person, or import a receipt with import_data.",
  };
}

/** One outcome event as a reader sees it: the identifier hash stays home, and
 *  `supersededBy` names the event that retired it. */
export type OutcomeEventView = Omit<OutcomeEventRow, "customerRefHash"> & {
  supersededBy: number | null;
};

/** A conversation's outcome events, oldest first. A correction keeps its corrected outcome's
 *  conversation, so every successor of these is among them. */
export async function listConversationOutcomes(
  tx: Tx,
  conversationId: number,
): Promise<OutcomeEventView[]> {
  const rows = await tx
    .select()
    .from(outcomeEvents)
    .where(eq(outcomeEvents.conversationId, conversationId))
    .orderBy(asc(outcomeEvents.id));
  const supersededBy = new Map(
    rows.flatMap((row) =>
      row.supersedesEventId === null ? [] : [[row.supersedesEventId, row.id] as const],
    ),
  );
  return rows.map(({ customerRefHash: _hash, ...row }) => ({
    ...row,
    supersededBy: supersededBy.get(row.id) ?? null,
  }));
}

/** One campaign's conversion evidence, read off its account's outcome events
 *  (`OutcomeReport`). */
export async function campaignOutcomeReport(
  tx: Tx,
  campaign: { id: number; channelId: number },
): Promise<OutcomeReport> {
  const events = await tx
    .select({
      id: outcomeEvents.id,
      type: outcomeEvents.type,
      occurredAt: outcomeEvents.occurredAt,
      supersedesEventId: outcomeEvents.supersedesEventId,
      conversationId: outcomeEvents.conversationId,
      verificationStatus: outcomeEvents.verificationStatus,
      attributionMethod: outcomeEvents.attributionMethod,
    })
    .from(outcomeEvents)
    .where(eq(outcomeEvents.channelId, campaign.channelId));
  const owned = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.owningCampaignId, campaign.id));
  return tallyOutcomes(events, new Set(owned.map((conversation) => conversation.id)));
}

/**
 * Re-project a conversation's outcome facts from its outcome events — the CTA, the
 * standing conversion and the stage they summarize — then the person's lead
 * from the conversation. The caller holds the conversation's row lock.
 */
export async function projectConversationOutcomes(
  tx: Tx,
  conversation: ConversationRow,
  now: number,
): Promise<ConversationRow> {
  const facts = conversationOutcomeFacts(
    await tx.select().from(outcomeEvents).where(eq(outcomeEvents.conversationId, conversation.id)),
  );
  const [updated] = await tx
    .update(conversations)
    .set({ ...facts, derivedStage: deriveStage({ ...conversation, ...facts }), updatedAt: now })
    .where(eq(conversations.id, conversation.id))
    .returning();
  await projectLeadStatus(tx, conversation.authorProfileId, now);
  return updated!;
}
