import { and, asc, eq, inArray, isNull, ne, notExists, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import {
  campaignStrategies,
  campaigns,
  channels,
  conversationEvents,
  conversationSources,
  conversations,
  messages,
  stepRuns,
  type Campaign,
  type ConversationEventType,
  type PauseScope,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  CONNECTOR_DECLARATIONS,
  type ConnectorDeclaration,
} from "../connector/capabilities";
import { currentGeneration, openPauses, scopesOf } from "../actions/pause";
import {
  NETWORK_CATALOGS,
  type CapabilityId,
  type CatalogStepId,
  type LiveChecks,
  type NetworkCatalog,
} from "../strategy/catalog";
import {
  parseStrategy,
  type CampaignAgentStrategy,
  type StrategyStep,
} from "../strategy/contract";
import { CONVERSATION_STEPS } from "../strategy/project";
import { recordedLiveChecks } from "../liveChecks/records";
import { roomEventRefusal } from "../rooms/continuation";
import { entryEventOf } from "./wait";
import { roomWork } from "./roomWork";
import { conversationHasRoomWork, roomInviteExchange, roomInviteOwner } from "../rooms/inviteExchange";

/**
 * WHICH CONVERSATIONS A WAKE SERVES — chosen by the server, under the run's
 * lease, before any model call, and frozen onto the run row (INV-3).
 *
 * Three kinds of work: an event the eligibility table judged `eligible` that
 * no step has yet decided — a reply under one of the campaign's comments, or,
 * on a conversation it owns, a message in the conversation, an accepted invitation
 * or, last in line, a verified conversion; a relevant exchange a step achieved, handed on to the step that
 * requires it (`stepAfter`); and a wait that expired asking to be woken — the
 * time a step named itself, or hours it asked for. One item per conversation, the newest event first in line for it, at
 * most `MAX_CONVERSATIONS_PER_WAKE`. A conversation the owner is answering themselves is
 * never selected (INV-9), nor one that is closed, held, paused or awaiting a
 * person. Each item names the step that answers it — for an event,
 * `stepForEvent` — and a campaign with no such step has no conversation work.
 *
 * Only a campaign that runs on its strategy has any: a send it proposes waits
 * for the owner's yes and nothing goes out without one (`dispatch.ts`).
 *
 * A Stop is read here before anything is created (INV-29): a campaign or an
 * account with an open pause has no conversation work at all, and a
 * conversation with one is not selected. The plan carries the pause
 * generation it read, which every checkpoint and reservation after it is
 * fenced by: a Stop written while the wake runs outranks it.
 */

/** At most this many conversations a wake works, oldest reply first: each is a
 *  step whose own budget bounds it, and the run's wall clock bounds them all. */
export const MAX_CONVERSATIONS_PER_WAKE = 5;


export const CONVERSATION_STOPPED_NOTE =
  "conversation_stopped: this campaign or its account is stopped, so no person-to-person step was served — only the owner's Resume starts them again";

export const STRATEGY_UNREADABLE_NOTE =
  "conversation_not_runnable: this campaign's active strategy could not be read against its channel, so no person-to-person step was served";

/** The owner's reply is pending in any of these: a step never drafts beside
 *  it (INV-9). */
const OWNER_PENDING: Array<"proposed" | "approved" | "posting" | "needs_review"> = [
  "proposed",
  "approved",
  "posting",
  "needs_review",
];

/**
 * A checkpoint that ended on something that clears by itself — its conversation
 * held for the moment (`guard:held:<ops status>`), a Stop the owner may
 * resume (`guard:paused:<scope>:<reason>`), or a barrier not met yet — has
 * not answered its reply: once the hold lifts, the next wake serves the reply
 * again and adopts the checkpoint, reading the thread as it is then. Every
 * other ending answers it.
 */
type Checkpoint = { status: AnyPgColumn; blockedReason: AnyPgColumn };

export function reopenable(checkpoint: Checkpoint): SQL {
  return sql`(${checkpoint.status} = 'blocked' and (${checkpoint.blockedReason} like 'guard:held:%' or ${checkpoint.blockedReason} like 'guard:paused:%' or ${checkpoint.blockedReason} like 'barrier:%'))`;
}

/** A checkpoint whose step answered its work: finished, and not reopenable. */
function finished(checkpoint: Checkpoint): SQL {
  return and(ne(checkpoint.status, "running"), sql`not ${reopenable(checkpoint)}`)!;
}

export type LoadedStrategy = {
  version: number;
  document: CampaignAgentStrategy;
  accountDefault: CampaignAgentStrategy | null;
  network: NetworkCatalog;
  connector: ConnectorDeclaration;
  /** The first sends and live checks recorded on the campaign's account. */
  liveChecks: LiveChecks;
};

export type ConversationItem = {
  origin: "event" | "room";
  conversationId: number;
  /** The reply the step answers. */
  eventId: number;
  stepId: string;
  /** `event:<id>`, or `timeout:<step run id>` for an expired wait. */
  workKey: string;
};

export type ConversationPlan =
  | { kind: "refused"; note: string }
  | {
      kind: "plan";
      strategy: LoadedStrategy;
      items: ConversationItem[];
      /** The pause generation the plan was made under. */
      generation: number;
    };

export async function planConversation(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
): Promise<ConversationPlan> {
  const strategy = await loadStrategy(tx, campaign);
  if (!strategy || campaign.channelId === null) {
    return { kind: "refused", note: STRATEGY_UNREADABLE_NOTE };
  }
  // The generation first: a Stop that commits between the two reads is then
  // either open below or outranks the plan.
  const generation = await currentGeneration(tx);
  const open = await openPauses(tx);
  const holds = (scope: PauseScope, scopeId: number) =>
    open.some((pause) => pause.scope === scope && pause.scopeId === scopeId);
  if (holds("account", campaign.channelId) || holds("campaign", campaign.id)) {
    return { kind: "refused", note: CONVERSATION_STOPPED_NOTE };
  }
  // A stopped conversation is held still, whether or not the owner took it
  // over.
  const stopped = new Set<number>(
    open.filter((pause) => pause.scope === "conversation").map((pause) => pause.scopeId),
  );
  const items: ConversationItem[] = [];
  const taken = new Set<number>();
  const undecided = await undecidedEvents(tx, campaign.id);
  for (const reply of undecided.replies) {
    if (taken.has(reply.conversationId) || stopped.has(reply.conversationId)) continue;
    const step = stepForEvent(strategy.document, reply.type);
    if (!step) continue;
    taken.add(reply.conversationId);
    items.push({
      origin: "event",
      conversationId: reply.conversationId,
      eventId: reply.eventId,
      stepId: step.step_id,
      workKey: `event:${reply.eventId}`,
    });
  }
  for (const handed of await handedOn(tx, campaign.id)) {
    if (taken.has(handed.conversationId) || stopped.has(handed.conversationId)) continue;
    const item = await handOnItem(tx, campaign.id, strategy, handed);
    if (!item) continue;
    taken.add(handed.conversationId);
    items.push(item);
  }
  for (const wait of await expiredWakes(tx, campaign.id)) {
    if (taken.has(wait.conversationId) || stopped.has(wait.conversationId) || wait.eventId === null) continue;
    if (!stepById(strategy.document, wait.stepId)) continue;
    taken.add(wait.conversationId);
    items.push({
      origin: "event",
      conversationId: wait.conversationId,
      eventId: wait.eventId,
      stepId: wait.stepId,
      workKey: `timeout:${wait.id}`,
    });
  }
  // A verified conversion records what came of the conversation and answers
  // no one, so a conversation serves it once nothing else waits there.
  for (const evidence of undecided.evidence) {
    if (taken.has(evidence.conversationId) || stopped.has(evidence.conversationId)) continue;
    const step = stepForEvent(strategy.document, evidence.type);
    if (!step) continue;
    taken.add(evidence.conversationId);
    items.push({
      origin: "event",
      conversationId: evidence.conversationId,
      eventId: evidence.eventId,
      stepId: step.step_id,
      workKey: `event:${evidence.eventId}`,
    });
  }
  const eligible: ConversationItem[] = [];
  for (const item of items) {
    const [event] = await tx.select().from(conversationEvents).where(eq(conversationEvents.id, item.eventId));
    if (event && !await roomEventRefusal(tx, event, campaign.id, Date.now(), generation)) eligible.push(item);
    if (eligible.length === MAX_CONVERSATIONS_PER_WAKE) break;
  }
  eligible.push(...await roomWork(tx, { campaignId: campaign.id, generationSeen: generation,
    limit: MAX_CONVERSATIONS_PER_WAKE - eligible.length, taken: new Set([...stopped, ...eligible.map((item) => item.conversationId)]) }));
  return { kind: "plan", strategy, items: eligible, generation };
}

/**
 * The hand-on a wake planned now would serve on this conversation, read as
 * {@link planConversation} reads one: a campaign on a strategy it can
 * read, no Stop on its account, on it or on the conversation, the conversation's
 * newest achieved exchange handed on to the step that follows it
 * ({@link handedOn}), and no room refusing that exchange. Null when a wake
 * would serve no hand-on there.
 */
export async function plannedHandOn(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
  conversationId: number,
): Promise<{ strategy: LoadedStrategy; item: ConversationItem } | null> {
  if (campaign.channelId === null) return null;
  const strategy = await loadStrategy(tx, campaign);
  if (!strategy) return null;
  const generation = await currentGeneration(tx);
  const scopes = scopesOf({ channelId: campaign.channelId, campaignId: campaign.id, conversationId });
  if ((await openPauses(tx, scopes)).length > 0) return null;
  const [handed] = await handedOn(tx, campaign.id, conversationId);
  const item = handed ? await handOnItem(tx, campaign.id, strategy, handed) : null;
  if (!item) return null;
  const [event] = await tx.select().from(conversationEvents).where(eq(conversationEvents.id, item.eventId));
  if (!event || (await roomEventRefusal(tx, event, campaign.id, Date.now(), generation))) return null;
  return { strategy, item };
}

/**
 * The events whose only answer is a direct message, and the send that answers
 * each: an accepted invitation — interest on the conversation, or the one
 * contextual opener their invitation earns. It enters the step that may send
 * that answer, whatever its entry event: a Connect step, entered on an
 * invitation's status too, has nothing to say to an acceptance.
 */
const ANSWERED_BY: Partial<Record<ConversationEventType, CapabilityId>> = {
  invitation_accepted: "send_dm",
};

/** The first of the Ambassador's person-to-person steps a conversation event
 *  enters — its entry predicate, or for an event only a DM answers the step
 *  that may send it; never a link on the canvas (INV-32). */
export function stepForEvent(
  document: CampaignAgentStrategy,
  type: ConversationEventType,
): StrategyStep | null {
  const conversation: readonly CatalogStepId[] = CONVERSATION_STEPS;
  const ambassador = (document.steps ?? []).filter(
    (step) => step.worker === "ambassador" && conversation.includes(step.catalog_step),
  );
  const send = ANSWERED_BY[type];
  if (send !== undefined) {
    return ambassador.find((step) => (step.allowed_tools as readonly CapabilityId[]).includes(send)) ?? null;
  }
  const entry = entryEventOf(type);
  return ambassador.find((step) => step.entry.event === entry) ?? null;
}

/**
 * The step a conversation moves on to once `finished` achieved a relevant exchange
 * on it: the next of the Ambassador's person-to-person steps, in strategy
 * order, that requires `finished` (`requires_step`) and whose every required
 * step the conversation has achieved. Invite to connect follows Reply when
 * they answer this way — its entry event is the invitations it re-enters on.
 * A typed barrier, never a link on the canvas (INV-32); the step's other
 * barriers are met or not where its checkpoint opens.
 */
export function stepAfter(
  document: CampaignAgentStrategy,
  finished: string,
  achieved: ReadonlySet<string>,
): StrategyStep | null {
  const steps = document.steps ?? [];
  const from = steps.findIndex((step) => step.step_id === finished);
  if (from < 0) return null;
  const conversation: readonly CatalogStepId[] = CONVERSATION_STEPS;
  const required = (step: StrategyStep) =>
    step.barriers.flatMap((barrier) => (barrier.type === "requires_step" ? [barrier.step_id] : []));
  return (
    steps
      .slice(from + 1)
      .find(
        (step) =>
          step.worker === "ambassador" &&
          conversation.includes(step.catalog_step) &&
          required(step).includes(finished) &&
          required(step).every((stepId) => achieved.has(stepId)),
      ) ?? null
  );
}

export function stepById(
  document: CampaignAgentStrategy,
  stepId: string,
): StrategyStep | null {
  return (document.steps ?? []).find((step) => step.step_id === stepId) ?? null;
}

/**
 * The step ids a run's stage work served, for `served_step_ids`: on a
 * campaign that runs on its strategy, its active version's steps of those
 * catalog steps; elsewhere the catalog step's own id, which is what the
 * seeder names a step.
 */
export async function stageStepIds(
  tx: Tx,
  campaign: Pick<Campaign, "id">,
  served: readonly CatalogStepId[],
): Promise<string[]> {
  if (served.length === 0) return [];
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
  if (!parsed?.success) return [...served];
  return (parsed.data.steps ?? [])
    .filter((step) => served.includes(step.catalog_step))
    .map((step) => step.step_id);
}

/** Whether the owner has a reply of their own pending anywhere on the
 *  conversation (INV-9). */
export async function ownerReplyPending(tx: Tx, conversationId: number): Promise<boolean> {
  const [pending] = await tx
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversationSources, eq(conversationSources.incomingCommentId, messages.incomingCommentId))
    .where(
      and(
        eq(conversationSources.conversationId, conversationId),
        eq(messages.publishOrigin, "owner"),
        inArray(messages.status, OWNER_PENDING),
      ),
    )
    .limit(1);
  return pending !== undefined;
}

/** The campaign's active strategy and what it resolves against, or null
 *  when there is none the contract still accepts. The dispatch gate reads an
 *  action's authority through it too (`actions/approval.ts`). */
export async function loadStrategy(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
): Promise<LoadedStrategy | null> {
  if (campaign.channelId === null) return null;
  const [channel] = await tx
    .select({ network: channels.network, connector: channels.connector })
    .from(channels)
    .where(eq(channels.id, campaign.channelId));
  if (!channel?.connector) return null;
  const network = NETWORK_CATALOGS[channel.network];
  const [active] = await tx
    .select()
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.campaignId, campaign.id),
        eq(campaignStrategies.status, "active"),
      ),
    );
  if (!active) return null;
  const parsed = parseStrategy(active.document, { network });
  if (!parsed.success) return null;
  const [account] = await tx
    .select({ document: campaignStrategies.document })
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.channelId, campaign.channelId),
        eq(campaignStrategies.status, "active"),
      ),
    );
  const accountDefault = account ? parseStrategy(account.document, { network }) : null;
  if (accountDefault && !accountDefault.success) return null;
  return {
    version: active.version,
    document: parsed.data,
    accountDefault: accountDefault?.data ?? null,
    network,
    connector: CONNECTOR_DECLARATIONS[channel.connector],
    liveChecks: await recordedLiveChecks(tx, campaign.channelId),
  };
}

/** A reply under one of the campaign's comments, or an edit of one. */
const REPLY_EVENTS: ConversationEventType[] = ["reply_observed", "reply_edited"];

/** The events a conversation produces beside the public thread,
 *  which belong to the campaign that owns the conversation: a message in their
 *  conversation, an accepted invitation. */
const CONVERSATION_EVENTS: ConversationEventType[] = ["inbound_message_observed", "invitation_accepted"];

/** A verified conversion on a conversation the campaign owns: the evidence a
 *  Check outcome step enters on. A line of its own — the conversation's
 *  steps read the thread, which says nothing of a booking, and Check outcome
 *  reads no thread — so neither line's answer answers the other's events. */
const OUTCOME_EVIDENCE: ConversationEventType[] = ["booking_verified", "activation_verified", "payment_verified"];

/** Every event a wake plans: the lines {@link undecidedEvents} reads. */
const PLANNED_EVENTS: ReadonlySet<ConversationEventType> = new Set([
  ...REPLY_EVENTS,
  ...CONVERSATION_EVENTS,
  ...OUTCOME_EVIDENCE,
]);

/**
 * Whether a wake of the campaign's Ambassador plans a conversation event of this
 * type: an event of a line the planner reads, on a campaign that runs on a
 * strategy it can read, entering one of its steps ({@link stepForEvent}).
 * An event it does not plan is no work for a wake, so it must neither wake
 * one nor end a wait the woken run would never answer
 * (`conversationEventArrived`).
 */
export async function plansEvent(
  tx: Tx,
  campaignId: number,
  type: ConversationEventType,
): Promise<boolean> {
  if (!PLANNED_EVENTS.has(type)) return false;
  const [campaign] = await tx
    .select({ id: campaigns.id, channelId: campaigns.channelId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) return false;
  const strategy = await loadStrategy(tx, campaign);
  return strategy !== null && stepForEvent(strategy.document, type) !== null;
}

type Undecided = { eventId: number; conversationId: number; type: ConversationEventType; occurredAt: number };

/**
 * Eligible events no finished step has answered, the newest of each conversation
 * first in its line, oldest conversation first: replies under this campaign's
 * comments and the events of the conversations on conversations it owns; and,
 * apart from them, the verified conversions on those conversations.
 */
async function undecidedEvents(
  tx: Tx,
  campaignId: number,
): Promise<{ replies: Undecided[]; evidence: Undecided[] }> {
  const later = alias(conversationEvents, "later");
  const sibling = alias(conversationSources, "sibling");
  const answeredEvent = alias(conversationEvents, "answered_event");
  // Answered: a finished step on the conversation answered this event or a newer
  // one of its line. A checkpoint still `running` is a crashed wake's, and one
  // a passing hold ended is reopenable; the next wake adopts either.
  const unanswered = (line: "conversation" | "evidence") =>
    notExists(
      tx
        .select({ id: stepRuns.id })
        .from(stepRuns)
        .innerJoin(answeredEvent, eq(answeredEvent.id, stepRuns.eventId))
        .where(
          and(
            eq(stepRuns.conversationId, conversationEvents.conversationId),
            sql`${stepRuns.eventId} >= ${conversationEvents.id}`,
            finished(stepRuns),
            line === "evidence"
              ? inArray(answeredEvent.type, OUTCOME_EVIDENCE)
              : notInArray(answeredEvent.type, OUTCOME_EVIDENCE),
          ),
        ),
    );
  const ownerQuiet = notExists(
    tx
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(sibling, eq(sibling.incomingCommentId, messages.incomingCommentId))
      .where(
        and(
          eq(sibling.conversationId, conversationEvents.conversationId),
          eq(messages.publishOrigin, "owner"),
          inArray(messages.status, OWNER_PENDING),
        ),
      ),
  );
  const current = notExists(
    tx.select({ id: later.id }).from(later).where(eq(later.supersedesEventId, conversationEvents.id)),
  );
  const owned = (types: ConversationEventType[], line: "conversation" | "evidence") =>
    tx
      .select({
        eventId: conversationEvents.id,
        conversationId: conversationEvents.conversationId,
        type: conversationEvents.type,
        occurredAt: conversationEvents.occurredAt,
      })
      .from(conversationEvents)
      .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
      .where(
        and(
          eq(conversations.owningCampaignId, campaignId),
          inArray(conversationEvents.type, types),
          sql`${conversationEvents.decision}->>'decision' = 'eligible'`,
          isNull(conversations.closedReason),
          eq(conversations.opsStatus, "runnable"),
          current,
          unanswered(line),
          ownerQuiet,
        ),
      );
  const conversation = await owned(CONVERSATION_EVENTS, "conversation");
  const rows = await tx
    .select({
      eventId: conversationEvents.id,
      conversationId: conversationEvents.conversationId,
      type: conversationEvents.type,
      occurredAt: conversationEvents.occurredAt,
    })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .innerJoin(
      conversationSources,
      sql`${conversationSources.incomingCommentId} = (${conversationEvents.sourceRef}->>'incomingCommentId')::bigint`,
    )
    .where(
      and(
        eq(conversationSources.campaignId, campaignId),
        isNull(conversationSources.deletedAt),
        inArray(conversationEvents.type, REPLY_EVENTS),
        sql`${conversationEvents.decision}->>'decision' = 'eligible'`,
        isNull(conversations.closedReason),
        eq(conversations.opsStatus, "runnable"),
        current,
        unanswered("conversation"),
        ownerQuiet,
      ),
    );
  return {
    replies: newestOfEach([...rows, ...conversation]),
    evidence: newestOfEach(await owned(OUTCOME_EVIDENCE, "evidence")),
  };
}

/** The newest event of each conversation, which answers for the older ones of its
 *  line — the step reads them all — oldest conversation first. */
function newestOfEach(events: Undecided[]): Undecided[] {
  const newest = new Map<number, Undecided>();
  for (const event of events) {
    const held = newest.get(event.conversationId);
    if (!held || event.eventId > held.eventId) newest.set(event.conversationId, event);
  }
  return [...newest.values()].sort(
    (a, b) => a.occurredAt - b.occurredAt || a.eventId - b.eventId,
  );
}

type HandedOn = { conversationId: number; eventId: number; stepId: string; achieved: Set<string> };

/** The newest relevant exchange a step achieved on each open conversation of this
 *  campaign — or on the one conversation asked about — a reply judged `eligible`
 *  that no later checkpoint on the same exchange has finished, with the steps
 *  its conversation has achieved: work for the step that requires it
 *  (`stepAfter`). A conversation the owner is answering themselves waits, as its
 *  replies do (INV-9). */
async function handedOn(tx: Tx, campaignId: number, conversationId?: number): Promise<HandedOn[]> {
  const newer = alias(stepRuns, "newer");
  const newerEvent = alias(conversationEvents, "newer_event");
  const successor = alias(stepRuns, "successor");
  const sibling = alias(conversationSources, "sibling");
  const rows = await tx
    .select({ conversationId: stepRuns.conversationId, eventId: conversationEvents.id, stepId: stepRuns.stepId })
    .from(stepRuns)
    .innerJoin(conversations, eq(conversations.id, stepRuns.conversationId))
    .innerJoin(conversationEvents, eq(conversationEvents.id, stepRuns.eventId))
    .where(
      and(
        eq(stepRuns.campaignId, campaignId),
        conversationId === undefined ? undefined : eq(stepRuns.conversationId, conversationId),
        eq(stepRuns.status, "achieved"),
        sql`${stepRuns.workKey} = 'event:' || ${conversationEvents.id}`,
        sql`${conversationEvents.decision}->>'decision' = 'eligible'`,
        // A verified conversion is no exchange to hand on, and the step that
        // recorded it moves no conversation on.
        notInArray(conversationEvents.type, OUTCOME_EVIDENCE),
        isNull(conversations.closedReason),
        eq(conversations.opsStatus, "runnable"),
        notExists(
          tx
            .select({ id: newer.id })
            .from(newer)
            .leftJoin(newerEvent, eq(newerEvent.id, newer.eventId))
            .where(
              and(
                eq(newer.conversationId, stepRuns.conversationId),
                eq(newer.status, "achieved"),
                sql`${newer.id} > ${stepRuns.id}`,
                or(isNull(newerEvent.type), notInArray(newerEvent.type, OUTCOME_EVIDENCE)),
              ),
            ),
        ),
        notExists(
          tx
            .select({ id: successor.id })
            .from(successor)
            .where(
              and(
                eq(successor.conversationId, stepRuns.conversationId),
                eq(successor.workKey, stepRuns.workKey),
                sql`${successor.id} > ${stepRuns.id}`,
                finished(successor),
              ),
            ),
        ),
        notExists(
          tx
            .select({ id: messages.id })
            .from(messages)
            .innerJoin(sibling, eq(sibling.incomingCommentId, messages.incomingCommentId))
            .where(
              and(
                eq(sibling.conversationId, stepRuns.conversationId),
                eq(messages.publishOrigin, "owner"),
                inArray(messages.status, OWNER_PENDING),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(stepRuns.updatedAt), asc(stepRuns.id));
  if (rows.length === 0) return [];
  const achieved = await tx
    .selectDistinct({ conversationId: stepRuns.conversationId, stepId: stepRuns.stepId })
    .from(stepRuns)
    .where(
      and(
        inArray(
          stepRuns.conversationId,
          rows.map((row) => row.conversationId),
        ),
        eq(stepRuns.status, "achieved"),
      ),
    );
  return rows.map((row) => ({
    ...row,
    achieved: new Set(achieved.filter((done) => done.conversationId === row.conversationId).map((done) => done.stepId)),
  }));
}

/** The work an achieved exchange hands its conversation on to: the step that
 *  requires the one that achieved it (`stepAfter`) — or, from Reply when they answer
 *  on a conversation met in a room, the step that invites them, where the exchange
 *  earned an invitation. Null when no step follows. */
async function handOnItem(
  tx: Tx,
  campaignId: number,
  strategy: LoadedStrategy,
  handed: HandedOn,
): Promise<ConversationItem | null> {
  const fromRoom = strategy.document.steps?.some((step) => step.step_id === handed.stepId && step.catalog_step === "handle_reply") === true &&
    await conversationHasRoomWork(tx, handed.conversationId, campaignId);
  const step = fromRoom
    ? await roomInviteExchange(tx, { campaignId, conversationId: handed.conversationId, eventId: handed.eventId, strategy })
      ? await roomInviteOwner(tx, campaignId, strategy) : null
    : stepAfter(strategy.document, handed.stepId, handed.achieved);
  if (!step) return null;
  return {
    origin: fromRoom ? "room" : "event",
    conversationId: handed.conversationId,
    eventId: handed.eventId,
    stepId: step.step_id,
    workKey: `event:${handed.eventId}`,
  };
}

/** Waits the timeout consumed asking to be woken, on conversations still open, that
 *  no later checkpoint of the step has picked up — the timeout's own, or one
 *  a newer reply opened, which read the whole thread. */
async function expiredWakes(
  tx: Tx,
  campaignId: number,
): Promise<Array<{ id: number; conversationId: number; stepId: string; eventId: number | null }>> {
  const successor = alias(stepRuns, "successor");
  return tx
    .select({
      id: stepRuns.id,
      conversationId: stepRuns.conversationId,
      stepId: stepRuns.stepId,
      eventId: stepRuns.eventId,
    })
    .from(stepRuns)
    .innerJoin(conversations, eq(conversations.id, stepRuns.conversationId))
    .where(
      and(
        eq(stepRuns.campaignId, campaignId),
        eq(stepRuns.status, "waiting"),
        sql`${stepRuns.wait}->>'consumedBy' = 'timeout'`,
        sql`${stepRuns.wait}->>'onTimeout' = 'wake'`,
        isNull(conversations.closedReason),
        eq(conversations.opsStatus, "runnable"),
        notExists(
          tx
            .select({ id: successor.id })
            .from(successor)
            .where(
              and(
                eq(successor.conversationId, stepRuns.conversationId),
                eq(successor.stepId, stepRuns.stepId),
                sql`${successor.id} > ${stepRuns.id}`,
                finished(successor),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(stepRuns.updatedAt), asc(stepRuns.id));
}
