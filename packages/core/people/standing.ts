import { inArray, isNotNull, sql } from "drizzle-orm";
import {
  dmThreads,
  incomingComments,
  type ActionKind,
  type ConversionOutcome,
  type ConversationClosedReason,
  type ConversationRelationship,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { scheduledWakes } from "../agentStep/wakes";
import { stillReadingSql } from "../execution/reconcileReads";
import { INVITATION_ANSWERS } from "../conversations/record";
import type { Person, TouchKind } from "./directory";
import { listSpotted } from "../rooms/people";

/**
 * WHERE THINGS STAND WITH SOMEONE NOTHING WAITS ON — the one fact the Inbox's
 * Everyone list shows a person by when they are owed nothing (`people/waits.ts`
 * answers for the rest), read from their conversation where Engager keeps one.
 *
 * The first that holds is their standing: their conversation closed, an
 * outcome confirmed, the conversation the owner's own, a DM of ours Engager
 * is still reading back, an invite the owner approved that waits on a read,
 * an invite of ours still unanswered, a step waiting for their answer — and,
 * with none of those, what happened last.
 *
 * Reads only, inside the caller's `withOrg`; every table read is under RLS.
 */
export type Standing =
  | { kind: "spotted"; rooms: number; spottedAt: number }
  /** They asked not to be contacted, or the owner excluded them. */
  | { kind: "closed"; reason: Exclude<ConversationClosedReason, "reopened"> }
  /** The furthest outcome confirmed on their conversation. */
  | { kind: "outcome"; outcome: ConversionOutcome }
  /** The owner took their conversation over, or wrote in it themselves. */
  | { kind: "yours" }
  /** A send of ours went out unsure and Engager is still reading LinkedIn to
   *  settle it — for a DM what `people/messages.ts`'s `dmsBeingChecked`
   *  lists — read by the same `askOwner` rule (`execution/reconcileReads.ts`),
   *  for every person at once. `of` is which send. */
  | { kind: "checking"; of: CheckedSend }
  /** The owner approved an invite to them and it is held on a read that
   *  could not be made yet; `reason` is the hold the drain gave it, after
   *  `held:` (`execution/actionGate.ts`), and it is tried again. */
  | { kind: "held"; reason: string }
  /** An invite of ours reached them, `at`, and nothing has answered it —
   *  their acceptance, our withdrawal, or LinkedIn no longer listing it. */
  | { kind: "invite_sent"; at: number }
  /** A step waits for their answer and reads again at `at`. */
  | { kind: "waiting"; at: number }
  /** Nothing pending: their last touch, and — for a reply of theirs —
   *  whether it was a comment on the owner's own post. */
  | { kind: "quiet"; touch: TouchKind | null; onOwnPost: boolean };

/** The sends whose outcome is read before the owner is asked, as a person
 *  names them. */
export type CheckedSend = "message" | "invite" | "acceptance" | "withdrawal" | "like";

const CHECKED: Partial<Record<ActionKind, CheckedSend>> = {
  dm: "message",
  followup: "message",
  invite: "invite",
  accept_invite: "acceptance",
  withdraw_invite: "withdrawal",
  like_target: "like",
};

/** What a person's conversation says of where things stand. */
type Conversation = {
  id: number;
  closedReason: ConversationClosedReason | null;
  outcome: ConversionOutcome | null;
  relationship: ConversationRelationship;
  takenOver: boolean;
  /** The kind of the newest send still being read, where one is. */
  checking: ActionKind | null;
  /** The hold on the owner's approved invite to them, where one is held. */
  heldReason: string | null;
  invitedAt: number | null;
  /** The newest answer to an invite of ours: accepted, withdrawn or gone. */
  answeredAt: number | null;
};

/** The standing of each of `people`, by canonical key. */
export async function personStandings(tx: Tx, people: readonly Person[]): Promise<Map<string, Standing>> {
  const conversationIds = [...new Set(people.flatMap((person) => (person.conversationId === null ? [] : [person.conversationId])))];
  const conversations =
    conversationIds.length === 0
      ? []
      : ((
          await tx.execute(sql`
            select
              conversation.id::float8 as id,
              conversation.closed_reason as "closedReason",
              conversation.outcome,
              conversation.relationship,
              conversation.ops_status = 'human_owned' and exists (
                select 1 from pause_controls pause
                where pause.organization_id = conversation.organization_id
                  and pause.scope = 'conversation'
                  and pause.scope_id = conversation.id
                  and pause.reason = 'takeover'
                  and pause.resumed_at is null) as "takenOver",
              (select action.kind from actions action
                where action.organization_id = conversation.organization_id
                  and action.conversation_id = conversation.id
                  and ${stillReadingSql()}
                order by action.id desc
                limit 1) as checking,
              (select substr(action.status_reason, 6) from actions action
                where action.organization_id = conversation.organization_id
                  and action.conversation_id = conversation.id
                  and action.kind = 'invite'
                  and action.status = 'approved'
                  and action.status_reason like 'held:%'
                order by action.id desc
                limit 1) as "heldReason",
              (select max(event.occurred_at) from conversation_events event
                where event.organization_id = conversation.organization_id
                  and event.conversation_id = conversation.id
                  and event.type = 'invitation_confirmed')::float8 as "invitedAt",
              (select max(event.occurred_at) from conversation_events event
                where event.organization_id = conversation.organization_id
                  and event.conversation_id = conversation.id
                  and event.type in (${sql.join(
                    INVITATION_ANSWERS.map((type) => sql`${type}`),
                    sql`, `,
                  )}))::float8 as "answeredAt"
            from conversations conversation
            where conversation.id in (${sql.join(
              conversationIds.map((id) => sql`${id}`),
              sql`, `,
            )})`)
        ).rows as Conversation[]);
  const byConversation = new Map(conversations.map((row) => [row.id, row] as const));
  const wakes = new Map<number, number>();
  for (const wake of await scheduledWakes(tx, { conversationIds })) {
    wakes.set(wake.conversationId, Math.min(wake.at, wakes.get(wake.conversationId) ?? Infinity));
  }
  // A conversation the owner wrote in themselves is theirs, bound to a
  // conversation or not.
  const held = await tx
    .select({ conversationId: dmThreads.conversationId, participants: dmThreads.participants })
    .from(dmThreads)
    .where(isNotNull(dmThreads.ownerHeldAt));
  const heldConversations = new Set(held.flatMap((thread) => (thread.conversationId === null ? [] : [thread.conversationId])));
  const heldProfiles = new Set(
    held.flatMap((thread) =>
      thread.participants.flatMap((participant) =>
        !participant.isSelf && participant.profileId ? [participant.profileId] : [],
      ),
    ),
  );
  const onOwnPost = await repliesOnOwnPosts(tx, people);
  const spotted = new Map<string, { rooms: number; spottedAt: number }>();
  for (let offset = 0; offset < people.length; offset += 100) {
    const page = await listSpotted(tx, { keys: people.slice(offset, offset + 100).map((person) => person.canonicalKey), limit: 100 });
    for (const person of page.people) spotted.set(person.personKey, person);
  }

  return new Map(
    people.map((person) => {
      const conversation = person.conversationId === null ? undefined : byConversation.get(person.conversationId);
      const closed = conversation?.closedReason ?? (person.doNotEngage ? "manual_exclude" : null);
      const standing = (): Standing => {
        if (closed === "opt_out" || closed === "manual_exclude") return { kind: "closed", reason: closed };
        const seen = spotted.get(person.canonicalKey);
        if (seen && !closed) return { kind: "spotted", rooms: seen.rooms, spottedAt: seen.spottedAt };
        if (conversation?.outcome && conversation.closedReason === null) {
          return { kind: "outcome", outcome: conversation.outcome };
        }
        if (
          conversation?.takenOver ||
          (person.conversationId !== null && heldConversations.has(person.conversationId)) ||
          (person.profileId !== null && heldProfiles.has(person.profileId))
        ) {
          return { kind: "yours" };
        }
        const checking = conversation?.checking ? CHECKED[conversation.checking] : undefined;
        if (checking) return { kind: "checking", of: checking };
        if (conversation?.heldReason) return { kind: "held", reason: conversation.heldReason };
        if (
          conversation?.invitedAt != null &&
          (conversation.answeredAt ?? -Infinity) < conversation.invitedAt &&
          conversation.relationship !== "connected"
        ) {
          return { kind: "invite_sent", at: conversation.invitedAt };
        }
        const wake = person.conversationId === null ? undefined : wakes.get(person.conversationId);
        if (wake !== undefined) return { kind: "waiting", at: wake };
        return { kind: "quiet", touch: person.lastTouch?.kind ?? null, onOwnPost: onOwnPost.has(person.canonicalKey) };
      };
      return [person.canonicalKey, standing()] as const;
    }),
  );
}

/** The people whose last touch is a reply of theirs that was a comment on
 *  the owner's own post rather than an answer under a comment of ours: the
 *  reply at that moment, by any id it carries for them. */
async function repliesOnOwnPosts(tx: Tx, people: readonly Person[]): Promise<Set<string>> {
  const replied = people.filter((person) => person.lastTouch?.kind === "their_reply");
  if (replied.length === 0) return new Set();
  const replies = await tx
    .select({
      id: incomingComments.id,
      profileId: incomingComments.authorProfileId,
      memberUrn: incomingComments.authorMemberUrn,
      at: incomingComments.receivedAt,
      source: incomingComments.source,
    })
    .from(incomingComments)
    .where(inArray(incomingComments.receivedAt, [...new Set(replied.map((person) => person.lastTouch!.at))]));
  return new Set(
    replied.flatMap((person) => {
      const reply = replies.find(
        (row) =>
          row.at === person.lastTouch!.at &&
          ((person.profileId !== null && row.profileId === person.profileId) ||
            (person.memberUrn !== null && row.memberUrn === person.memberUrn) ||
            row.id === person.incomingCommentId),
      );
      return reply?.source === "own_post" ? [person.canonicalKey] : [];
    }),
  );
}
