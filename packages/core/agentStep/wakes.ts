import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  campaigns,
  incomingComments,
  conversations,
  stepRuns,
  type StepRunRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ActionLedgerError } from "../actions/errors";
import { invitationLooks } from "../actions/invite";
import { untrusted } from "../ai/prompts";
import { personKey } from "../people/key";
import { MAX_WAIT_HOURS } from "./result";
import { consumeWait, moveWaitExpiry } from "./wait";

/**
 * THE WAKES THE OWNER SEES — every time a step has asked to be woken on a
 * conversation, with why: the step's own summary, and the person's words
 * where the time rests on them ("Waking Mon 20 Oct — they said 'next week
 * works better'"). The person's Messages tab in the Inbox lists them, and
 * the owner can move one or cancel it: a moved wake is the same wait at the
 * owner's time; a cancelled one ends with no wake, and
 * the conversation waits for the person. Either way their next message still
 * wakes the step, which decides afresh.
 */

const HOUR = 3_600_000;

export type WakeView = {
  stepRunId: number;
  conversationId: number;
  campaign: { id: number; name: string } | null;
  stepId: string;
  /** Who it is with, by the name their latest reply carried. */
  person: string | null;
  /** …and by their key (`people/key.ts`), which every name links by. */
  personKey: string | null;
  /** The event whose arrival ends the wait early (`StepWait.event`): their
   *  reply, their message, an invitation answered. */
  event: string;
  /** When the step wakes, unless a word of theirs comes first. */
  at: number;
  /** On a wait for an invitation's answer, when Engager next reads their
   *  profile for it (`invitationLooks`): the wait ends there if they
   *  accepted, and `at` is only the longest it waits. Null on any other. */
  lookAt: number | null;
  /** The step named the instant itself rather than hours from now. */
  named: boolean;
  /** The step's own summary of its decision, display text. */
  rationale: string | null;
  /** The person's words the time rests on, verbatim — untrusted data — or
   *  null where they named none. */
  quote: string | null;
  /** Who moved it, when the owner did. */
  movedBy: string | null;
};

/** The latest name a reply of the person's carried — selected beside a row
 *  joined to its conversation. */
export const conversationPersonName = sql<string | null>`(
  select ${incomingComments.authorName}
  from ${incomingComments}
  where ${incomingComments.authorProfileId} = ${conversations.authorProfileId}
  order by ${incomingComments.id} desc
  limit 1
)`;

/** A checkpoint waiting to be woken: unconsumed, and asking to wake rather
 *  than to hand the conversation to a person. */
const pendingWake = and(
  eq(stepRuns.status, "waiting"),
  sql`${stepRuns.wait}->>'consumedAt' is null`,
  sql`${stepRuns.wait}->>'onTimeout' = 'wake'`,
);

/** Every wake still to come on an open conversation, soonest first — or on these
 *  conversations only, or these campaigns' only: the campaign whose step set it. */
export async function scheduledWakes(
  tx: Tx,
  filter: { conversationIds?: readonly number[]; campaignIds?: readonly number[] } = {},
): Promise<WakeView[]> {
  if (filter.conversationIds?.length === 0 || filter.campaignIds?.length === 0) return [];
  const rows = await tx
    .select({
      checkpoint: stepRuns,
      campaign: { id: campaigns.id, name: campaigns.name },
      person: conversationPersonName,
      profileId: conversations.authorProfileId,
    })
    .from(stepRuns)
    .innerJoin(conversations, eq(conversations.id, stepRuns.conversationId))
    .leftJoin(campaigns, eq(campaigns.id, stepRuns.campaignId))
    .where(
      and(
        pendingWake,
        isNull(conversations.closedReason),
        ...(filter.conversationIds ? [inArray(stepRuns.conversationId, [...filter.conversationIds])] : []),
        ...(filter.campaignIds ? [inArray(stepRuns.campaignId, [...filter.campaignIds])] : []),
      ),
    )
    .orderBy(asc(sql`(${stepRuns.wait}->>'expiresAt')::bigint`), asc(stepRuns.id));
  const looks = await invitationLooks(
    tx,
    rows.flatMap(({ checkpoint }) => (checkpoint.wait?.event === "invitation_status" ? [checkpoint.conversationId] : [])),
  );
  return rows.map(({ checkpoint, campaign, person, profileId }) =>
    wakeView(checkpoint, campaign, person, personKey({ profileId }), looks),
  );
}

/** A wake as an agent reads it: the person's words fenced as untrusted data,
 *  never instructions. */
export function fencedWake(view: WakeView): WakeView {
  return { ...view, quote: view.quote === null ? null : untrusted("THEIR WORDS", view.quote) };
}

function wakeView(
  checkpoint: StepRunRow,
  campaign: { id: number; name: string } | null,
  person: string | null,
  key: string | null,
  looks: ReadonlyMap<number, number>,
): WakeView {
  const wait = checkpoint.wait!;
  return {
    stepRunId: checkpoint.id,
    conversationId: checkpoint.conversationId,
    campaign,
    stepId: checkpoint.stepId,
    person,
    personKey: key,
    event: wait.event,
    at: wait.expiresAt,
    lookAt: wait.event === "invitation_status" ? (looks.get(checkpoint.conversationId) ?? null) : null,
    named: wait.named ?? false,
    rationale: checkpoint.rationaleSummary,
    quote: wait.quote ?? null,
    movedBy: wait.movedBy ?? null,
  };
}

/** The conversation, locked, open — and its pending wakes, locked. */
async function wakesToChange(tx: Tx, conversationId: number): Promise<StepRunRow[]> {
  const [conversation] = await tx
    .select({ id: conversations.id, closedReason: conversations.closedReason })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for("update");
  if (!conversation) {
    throw new ActionLedgerError(
      "conversation_not_found",
      `Conversation ${conversationId} not found in this organization.`,
      "A conversation is a conversation: its id is on an action (`conversationId`), a wake, or the activity list returns.",
    );
  }
  if (conversation.closedReason !== null) {
    throw new ActionLedgerError(
      "conversation_closed",
      `Conversation ${conversation.id} is closed (${conversation.closedReason}); nothing wakes on it.`,
      "A closed conversation stays closed; the owner can reopen it in Engager.",
    );
  }
  const waiting = await tx
    .select()
    .from(stepRuns)
    .where(and(eq(stepRuns.conversationId, conversation.id), pendingWake))
    .orderBy(desc(stepRuns.id))
    .for("update");
  if (waiting.length === 0) {
    throw new ActionLedgerError(
      "wake_not_found",
      `Nothing is set to wake on conversation ${conversation.id}.`,
      "A wake is the Ambassador's own: it sets one when it decides to wait for a time. The person's next message wakes it either way.",
    );
  }
  return waiting;
}

/**
 * Move the conversation's wake to `at` — the owner's time, within the next
 * {@link MAX_WAIT_HOURS} hours. Its timeout job moves with it; one already
 * firing is refused, since the step is being woken now. Their next message
 * still wakes the step first.
 */
export async function moveWake(
  tx: Tx,
  input: { conversationId: number; at: number; by: string; now: number },
): Promise<WakeView[]> {
  const waiting = await wakesToChange(tx, input.conversationId);
  if (!Number.isFinite(input.at) || input.at <= input.now || input.at > input.now + MAX_WAIT_HOURS * HOUR) {
    throw new ActionLedgerError(
      "wake_time_invalid",
      "A wake is at a time in the next 30 days.",
      "Name a time after now and within the next 30 days, as an ISO 8601 time with its offset.",
    );
  }
  for (const row of waiting) {
    if (!(await moveWaitExpiry(tx, row, input.at, input.now, input.by))) {
      throw new ActionLedgerError(
        "wake_firing",
        `The wake on conversation ${input.conversationId} is firing right now.`,
        "The Ambassador is reading the conversation again; look at it in a minute.",
      );
    }
  }
  return scheduledWakes(tx, { conversationIds: [input.conversationId] });
}

/**
 * Cancel the conversation's wake: it ends with no wake, and its timeout job
 * with it. The conversation then waits for the person — their next message
 * wakes the step as any message does. Returns how many were cancelled.
 */
export async function cancelWake(
  tx: Tx,
  input: { conversationId: number; now: number },
): Promise<number> {
  const waiting = await wakesToChange(tx, input.conversationId);
  for (const row of waiting) await consumeWait(tx, row, "owner", input.now);
  return waiting.length;
}
