import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  conversationEvents,
  conversationSources,
  conversations,
  leads,
  type ConversationEventRow,
  type ConversationRow,
  type ConversationSourceRow,
  type LeadStatus,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { fencedWake, scheduledWakes, type WakeView } from "../agentStep/wakes";
import { delimited } from "./delimit";
import { listConversationOutcomes, type OutcomeEventView } from "./outcomes";

/** One conversation as an agent reads it: its separate facts side by side, the
 *  public threads it runs through, its conversion evidence, the lead status
 *  projected from it, and when the Ambassador has decided to wake on it and
 *  why — the person's words in the reason fenced as untrusted data. */
export type ConversationView = ConversationRow & {
  sources: ConversationSourceRow[];
  outcomes: OutcomeEventView[];
  lead: { id: number; status: LeadStatus } | null;
  wakes: WakeView[];
};

/** One event as an agent reads it. `content` is the person's words fenced
 *  as untrusted data; `evidenceSpans` index the words between the fences. */
export type ConversationEventView = Omit<ConversationEventRow, "content"> & {
  content: string | null;
};

/**
 * The people among `profileIds` whose conversation stands closed — an opt-out,
 * an exclusion, a reopening nothing replaced. A person's conversation is their
 * open conversation, else their latest closed one, as the directory reads it
 * (`people/directory.ts`); closed, nothing is offered to the owner to do to
 * them, whether or not they are on the do-not-engage list.
 */
export async function closedPeople(tx: Tx, profileIds: readonly string[]): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();
  const standing = await tx
    .selectDistinctOn([conversations.authorProfileId], {
      profileId: conversations.authorProfileId,
      closedReason: conversations.closedReason,
    })
    .from(conversations)
    .where(inArray(conversations.authorProfileId, [...profileIds]))
    .orderBy(conversations.authorProfileId, sql`${conversations.closedReason} is null desc`, desc(conversations.id));
  return new Set(standing.flatMap((row) => (row.closedReason === null ? [] : [row.profileId])));
}

export async function getConversation(tx: Tx, id: number): Promise<ConversationView | null> {
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, id));
  if (!conversation) return null;
  const sources = await tx
    .select()
    .from(conversationSources)
    .where(eq(conversationSources.conversationId, id))
    .orderBy(asc(conversationSources.createdAt), asc(conversationSources.id));
  const [lead] = await tx
    .select({ id: leads.id, status: leads.status })
    .from(leads)
    .where(eq(leads.profileId, conversation.authorProfileId));
  return {
    ...conversation,
    sources,
    outcomes: await listConversationOutcomes(tx, id),
    lead: lead ?? null,
    wakes: (await scheduledWakes(tx, { conversationIds: [id] })).map(fencedWake),
  };
}

export const CONVERSATION_EVENTS_PAGE = 50;

/** A conversation's log, newest first, a page at a time; `before` is the
 *  previous page's `nextBefore`. Null when the conversation is not this org's. */
export async function listConversationEvents(
  tx: Tx,
  opts: { conversationId: number; before?: number; limit?: number },
): Promise<{ events: ConversationEventView[]; nextBefore: number | null } | null> {
  const [conversation] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, opts.conversationId));
  if (!conversation) return null;
  const limit = opts.limit ?? CONVERSATION_EVENTS_PAGE;
  const rows = await tx
    .select()
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, opts.conversationId),
        ...(opts.before !== undefined ? [lt(conversationEvents.id, opts.before)] : []),
      ),
    )
    .orderBy(desc(conversationEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    events: page.map((event) => ({
      ...event,
      sourceRef: conversationSourceRef(event.sourceRef),
      content: event.content === null ? null : delimited(event),
    })),
    nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Read the other conversation on reopen events written before the rename. */
function conversationSourceRef(source: ConversationEventRow["sourceRef"]): ConversationEventRow["sourceRef"] {
  const { journeyId, ...rest } = source as ConversationEventRow["sourceRef"] & { journeyId?: number };
  return journeyId === undefined ? rest : { ...rest, conversationId: rest.conversationId ?? journeyId };
}
