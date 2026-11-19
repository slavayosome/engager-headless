import { conversationPayload } from "../jobs/conversationPayload";
import { and, eq, gt, gte, inArray, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  actions,
  campaigns,
  channels,
  incomingComments,
  conversationEvents,
  conversations,
  jobs,
  stepRuns,
  type ActionCandidate,
  type ActionRow,
  type ActionTarget,
  type JobResultValue,
  type ConversationRow,
  type RelationshipReadJson,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { placeUnread } from "../audience/sendCountries";
import { inheritedStrategies, inheritedGroup } from "../strategy/inherit";
import type {
  ActionOperation,
  ActionReceipt,
  ActionSurface,
  OperationContext,
  Preflight,
} from "../execution/actionGate";
import { spendProfileRead } from "../execution/profileRead";
import { enqueue } from "../jobs/queue";
import { withinActiveWindow } from "../time";
import { recordInvitationConfirmed } from "../conversations/record";
import { refreshRelationship } from "../conversations/refresh";
import { relationshipOf } from "../conversations/relationship";
import { nextUnreadRead } from "../conversations/review";
import { InvitationReceiptSchema, RelationshipReadSchema } from "../linkedin/browser-use/protocol";
import { isConnectorBackoff } from "../linkedin/connectorError";
import {
  MAX_INCOMING_INVITATIONS,
  type IncomingInvitationsRead,
  type RelationshipRead,
  type SendInvitationInput,
  type SendInvitationResult,
} from "../linkedin/driver";
import { pauseChannelForConnectorBackoff } from "../ratelimit/killswitch";
import { candidateRefusal, reserveAction, type ReserveOutcome } from "./ledger";
import { loadStrategy } from "../agentStep/select";
import { moveWaitExpiry } from "../agentStep/wait";
import { conversationHasRoomWork, roomInviteExchange, roomInviteOwner } from "../rooms/inviteExchange";
import { roomContinuationRefusal } from "../rooms/continuation";

/**
 * INVITE — the Ambassador's Invite, its Connect step's send, on the action
 * ledger (Phase 50; spec §07 `send_invitation`, §10 R05/R06, §11 R08
 * `InvitationConfirmed`, §17 R13 "Send invitation with note"; INV-27, INV-31,
 * INV-10).
 *
 * One invitation per person per conversation, by constraint: its key is `account +
 * person + conversation + opener + 1` (`actions/keys.ts`), so a second proposal —
 * the same wake again, a later wake, another campaign reaching the person —
 * meets the unique key and reserves nothing; and only a `definitely_not_sent`
 * row is ever proposed again (INV-10). A person once invited is invited on the
 * conversation for good: the log's `invitation_confirmed` forbids another whatever
 * a later page offers, and starting them over is the owner's explicit
 * reopening (`conversations/reopen.ts`), never a second key under one conversation.
 *
 * The browser half (`inviteOperation`) rides the sidecar's `send_invitation`
 * on the write journal:
 *
 *   preflight  the person's own profile read in this browser session
 *              (`refreshRelationship`, a metered profile read, recorded on
 *              the conversation) — LinkedIn's relationship data for the member
 *              their page binds, {@link inviteAdmission}: only a read binding
 *              the member, Connect on offer, at a degree other than 1st, goes
 *              on; and then only where a whole read of the account's
 *              received invitations, made once for the drain, holds none
 *              from them. Connected, invited either way, or withdrawn inside
 *              LinkedIn's three weeks never does; a read that cannot tell
 *              holds an hour. A second invitation on the conversation, or a
 *              missing note where the campaign requires one, is refused
 *              before any read.
 *   perform    prepare re-reads the profile again inside the op and holds it
 *              to the admitting read — the same member by profile urn and
 *              number, still on Connect at that degree — reads the note limit
 *              LinkedIn's compose view states and refuses a longer note;
 *              commit makes LinkedIn's own invitation POST once, and only
 *              LinkedIn's answer naming the invitation it created confirms
 *              it (INV-31).
 *   reconcile  a read of the profile against the attempt's journal entry:
 *              pending, accepted or withdrawn since is the receipt; Connect
 *              on offer again, read long enough after the POST, is
 *              LinkedIn's data stating no invitation, so it never went out; a
 *              read that binds nothing stays with the drain and the owner.
 *
 * Settled `confirmed`, the conversation takes `invitation_confirmed`
 * (`settleInvitation`) and the wait on their answer starts: the person read
 * again (`invitation_watch`) on a backoff from the send — an hour after it,
 * then at 3, 6 and 12 hours, then once a day — until a read shows them
 * connected — the only thing that records an acceptance — or the wait
 * expires, three weeks after the send at the latest.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a pending invitation's person is read again for: three weeks
 *  from the send, or less where the step that sent it asked to wait less. */
export const INVITATION_WAIT_MS = 21 * DAY;
/** When a pending invitation's person is read again, as time after the send;
 *  past the last, once a day to the end of the wait. A first read a day out
 *  showed an acceptance a day late. */
const INVITATION_RECHECK_AGES_MS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];
/** How long after the press a read must be before it can say the invitation
 *  never went out: a page read in the seconds after Send may not show it
 *  yet. A read showing it pending settles at any time. */
export const INVITATION_RESOLVE_SETTLE_MS = 15 * MINUTE;
/** A preflight read that cannot tell is tried again this much later. */
const PREFLIGHT_RETRY_MS = HOUR;
/** How long LinkedIn takes no new invitation to a person after one to them
 *  is withdrawn: three weeks. */
export const WITHDRAWAL_COOL_OFF_MS = 21 * DAY;

/**
 * The next time, after `now`, the person of an invitation sent at `sentAt` is
 * read: the next point of the schedule counted from the send, not a wait from
 * this read. A look that ran late, or that the read budget put off, does not
 * push the rest back, and one past several points reads once, not once for
 * each. Whether a wake then reads at all is still the budget's to say
 * (`reserveResearchRead`).
 */
export function nextInvitationRecheck(sentAt: number, now: number): number {
  const age = Math.max(0, now - sentAt);
  const early = INVITATION_RECHECK_AGES_MS.find((at) => at > age);
  return sentAt + (early ?? (Math.floor(age / DAY) + 1) * DAY);
}

/** The person an invitation is for, as an approval binds it: their id and
 *  their own profile page. */
export function inviteTargetFor(profileId: string): ActionTarget {
  return { kind: "person", id: profileId, urn: `https://www.linkedin.com/in/${profileId}/` };
}

/**
 * Why this conversation's person is not one to invite now, as the conversation stands:
 * already connected, an invitation pending either way, one of ours to them
 * withdrawn inside LinkedIn's three weeks — on this conversation or an
 * earlier one on the account — or one of ours already on the log. Null when
 * nothing the server holds forbids it — the preflight read still decides.
 */
export async function invitationRefusal(
  tx: Tx,
  conversation: Pick<ConversationRow, "id" | "relationship" | "channelId" | "authorProfileId">,
  now: number = Date.now(),
): Promise<string | null> {
  if (conversation.relationship === "connected") return "already_connected";
  if (conversation.relationship === "outgoing_pending" || conversation.relationship === "incoming_pending") {
    return "invitation_pending";
  }
  const [withdrawn] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(
      and(
        eq(conversations.channelId, conversation.channelId),
        eq(conversations.authorProfileId, conversation.authorProfileId),
        eq(conversationEvents.type, "invitation_withdrawn"),
        gte(conversationEvents.occurredAt, now - WITHDRAWAL_COOL_OFF_MS),
      ),
    )
    .limit(1);
  if (withdrawn) return "recently_withdrawn";
  const [sent] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversation.id), eq(conversationEvents.type, "invitation_confirmed")))
    .limit(1);
  return sent ? "invitation_sent" : null;
}

/**
 * Reserve one invitation for the conversation's person — the candidate, never the
 * send — at the mode its binding resolved to: Ask me for the owner's yes, or
 * Automatic, which only an owner-set ceiling and the account's confirmed first
 * invitation ever let it reach (INV-28, INV-31). Refused where the conversation already forbids
 * it; otherwise the ledger's one door (`reserveAction`) re-reads the conversation,
 * the pauses and the person's exclusion and inserts under the opener key.
 */
export async function reserveInvitation(
  tx: Tx,
  input: {
    conversation: Pick<ConversationRow, "id" | "channelId" | "authorProfileId" | "relationship">;
    campaignId: number;
    stepRunId: number | null;
    actionBindingId: string;
    candidate: ActionCandidate;
    mode: "review" | "auto";
    generationSeen: number;
    now: number;
  },
): Promise<ReserveOutcome> {
  const room = await roomInvitationAdmission(tx, { campaignId: input.campaignId, stepRunId: input.stepRunId,
    conversationId: input.conversation.id, generationSeen: input.generationSeen });
  if (room.kind === "refused") return { status: "refused", reason: room.reason };
  const refused = await invitationRefusal(tx, input.conversation, input.now);
  if (refused) return { status: "refused", reason: refused };
  return reserveAction(tx, {
    channelId: input.conversation.channelId,
    campaignId: input.campaignId,
    conversationId: input.conversation.id,
    authorProfileId: input.conversation.authorProfileId,
    stepRunId: input.stepRunId,
    actionBindingId: input.actionBindingId,
    kind: "invite",
    purpose: "opener",
    target: inviteTargetFor(input.conversation.authorProfileId),
    candidate: input.candidate,
    mode: input.mode,
    generationSeen: input.generationSeen,
    now: input.now,
  });
}

/** The Meet step's invitation authority is a verified exchange, never its
 * original spotted event or an invitation-shaped model proposal. This check
 * also lives at reservation so callers cannot bypass the pre-writer guard. */
export async function roomInvitationAdmission(tx: Tx, input: {
  campaignId: number; conversationId: number; stepRunId: number | null; generationSeen: number;
}): Promise<{ kind: "ordinary" } | { kind: "ready"; text: string } | { kind: "refused"; reason: string }> {
  if (input.stepRunId === null) return { kind: "ordinary" };
  const [checkpoint] = await tx.select().from(stepRuns).where(eq(stepRuns.id, input.stepRunId));
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId));
  const strategy = campaign ? await loadStrategy(tx, campaign) : null;
  const step = strategy?.document.steps?.find((entry) => entry.step_id === checkpoint?.stepId);
  if (step?.catalog_step !== "meet_the_room" && !(step?.catalog_step === "connect" &&
    await conversationHasRoomWork(tx, input.conversationId, input.campaignId))) return { kind: "ordinary" };
  if (!checkpoint || !strategy || checkpoint.campaignId !== input.campaignId || checkpoint.conversationId !== input.conversationId ||
    checkpoint.eventId === null) return { kind: "refused", reason: "room_invite_too_early" };
  const exchange = await roomInviteExchange(tx, { campaignId: input.campaignId, conversationId: input.conversationId,
    eventId: checkpoint.eventId, strategy });
  if (!exchange) return { kind: "refused", reason: "room_invite_too_early" };
  if ((await roomInviteOwner(tx, input.campaignId, strategy))?.step_id !== step.step_id) return { kind: "refused", reason: "room_invite_not_owned" };
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId));
  const [incoming] = await tx.select().from(incomingComments).where(eq(incomingComments.id, exchange.event.sourceRef.incomingCommentId!));
  if (!conversation || !incoming) return { kind: "refused", reason: "room_invite_too_early" };
  const refused = await candidateRefusal(tx, { campaignId: input.campaignId, channelId: conversation.channelId,
    conversationId: conversation.id, authorProfileId: conversation.authorProfileId, generationSeen: input.generationSeen }) ??
    await roomContinuationRefusal(tx, incoming, input.campaignId, Date.now());
  return refused ? { kind: "refused", reason: refused } : { kind: "ready", text: exchange.text };
}

/** Whether the campaign asks every invitation to carry a note — the
 *  strategy's `invite.note_required`, inherited the way a mode is; true
 *  where no scope states it. */
async function noteRequired(tx: Tx, campaignId: number | null): Promise<boolean> {
  if (campaignId === null) return true;
  const strategies = (await inheritedStrategies(tx, [campaignId])).get(campaignId);
  return inheritedGroup(strategies, "invite")?.note_required ?? true;
}

export function inviteOperation(driver: ActionSurface, context: OperationContext): ActionOperation {
  // The read each row was admitted on, from its preflight to its click, and
  // the member it bound: what the sidecar holds the page to again before
  // anything is pressed.
  const admitted = new Map<number, { read: RelationshipReadJson; expected: SendInvitationInput["expected"] }>();
  return {
    async preflight(row) {
      const profileId = row.authorProfileId;
      if (row.conversationId === null || profileId === null || row.target.kind !== "person" || row.target.id !== profileId) {
        return blockedBefore("target_unresolved");
      }
      const checked = await withOrg(context.organizationId, async (tx) => {
        if (row.campaignId !== null) {
          const room = await roomInvitationAdmission(tx, { campaignId: row.campaignId, conversationId: row.conversationId!,
            stepRunId: row.stepRunId, generationSeen: row.generationSeen });
          if (room.kind === "refused") return { refused: room.reason };
        }
        if ((await noteRequired(tx, row.campaignId)) && !row.candidate.text?.trim()) return { refused: "note_required" };
        const [other] = await tx
          .select({ id: actions.id })
          .from(actions)
          .where(
            and(
              eq(actions.conversationId, row.conversationId!),
              eq(actions.kind, "invite"),
              ne(actions.id, row.id),
              notInArray(actions.status, ["definitely_not_sent", "cancelled"]),
            ),
          )
          .limit(1);
        if (other) return { refused: "invite_exists" };
        // The read below is their own profile: it says where they are too,
        // for the gate's countries, wherever no recent read already has.
        const [campaign] =
          row.campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, row.campaignId));
        return { place: await placeUnread(tx, { campaign: campaign ?? null, profileId, now: context.now() }) };
      });
      if (checked.refused) return blockedBefore(checked.refused);
      if (!driver.readRelationship || !driver.sendInvitation) return blockedBefore("invitations_unavailable");

      let refreshed: Awaited<ReturnType<typeof refreshRelationship>>;
      try {
        refreshed = await refreshRelationship({
          organizationId: context.organizationId,
          driver,
          conversationId: row.conversationId,
          now: context.now(),
          place: checked.place,
        });
      } catch (error) {
        if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(context.organizationId, error);
        return { proceed: false, hold: "preflight:unreadable", retryAt: context.now() + PREFLIGHT_RETRY_MS };
      }
      switch (refreshed.status) {
        case "refused":
          return {
            proceed: false,
            hold: `preflight:${refreshed.reason}`,
            ...(refreshed.retryAt === undefined ? {} : { retryAt: refreshed.retryAt }),
          };
        case "unsupported":
          return blockedBefore("relationship_unreadable");
        case "not_found":
          return blockedBefore("conversation_gone");
        case "read":
          break;
      }
      const admission = inviteAdmission(refreshed.read, profileId);
      if (admission.status === "held") {
        // Recorded on the conversation, which a person now looks at: nothing to
        // send on a read that could not tell. It reads again at the pace the
        // reads that could not tell allow, and a read that can tell lifts
        // the review (`nextUnreadRead`).
        const readsAt = await withOrg(context.organizationId, (tx) =>
          nextUnreadRead(tx, row.conversationId!, context.now()),
        );
        return { proceed: false, hold: admission.reason, retryAt: Math.max(readsAt, context.now() + PREFLIGHT_RETRY_MS) };
      }
      if (admission.status === "refused") return blockedBefore(admission.reason, refreshed.read);
      const incoming = await theirInvitationListed(driver, context, row);
      if (incoming === "listed") return blockedBefore("invitation_incoming", refreshed.read);
      if (incoming !== "absent") {
        const retryAt = incoming.retryAt ?? context.now() + PREFLIGHT_RETRY_MS;
        return { proceed: false, hold: `preflight:${incoming.hold}`, retryAt };
      }
      admitted.set(row.id, { read: refreshed.read, expected: admission.expected });
      return { proceed: true };
    },
    async perform(row) {
      const admission = admitted.get(row.id);
      if (!admission || !driver.sendInvitation) {
        return { status: "definitely_not_sent", evidence: { reason: "not_admitted_in_session" } };
      }
      if (row.campaignId !== null && row.conversationId !== null) {
        const room = await withOrg(context.organizationId, (tx) => roomInvitationAdmission(tx, {
          campaignId: row.campaignId!, conversationId: row.conversationId!, stepRunId: row.stepRunId, generationSeen: row.generationSeen,
        }));
        if (room.kind === "refused") return { status: "definitely_not_sent", evidence: { reason: room.reason } };
      }
      const result = await driver.sendInvitation({
        operationId: row.fenceToken!,
        profileId: row.authorProfileId!,
        note: row.candidate.text!,
        expected: admission.expected,
      });
      return invitationReceipt(result, admission.read);
    },
    async reconcile(row) {
      if (!driver.resolveInvitation || row.fenceToken === null || row.authorProfileId === null || !row.candidate.text) {
        return null;
      }
      const resolution = await driver.resolveInvitation({
        operationId: row.fenceToken,
        profileId: row.authorProfileId,
        note: row.candidate.text,
      });
      if (resolution.status === "confirmed") {
        return { status: "confirmed", evidence: { relationship: resolution.relationship, reconciled: true } };
      }
      // The read just made is this look's; the sidecar holds its own answer to
      // the same quarter hour after the press, so Connect on offer at an
      // earlier look never reaches here as `not_sent`.
      const attempt = row.attempts.find((candidate) => candidate.operationId === row.fenceToken);
      const settledLongEnough =
        attempt !== undefined && context.now() - attempt.startedAt >= INVITATION_RESOLVE_SETTLE_MS;
      if (resolution.status === "not_sent" && settledLongEnough) {
        return {
          status: "definitely_not_sent",
          evidence: { relationship: resolution.relationship, reconciled: true },
        };
      }
      return null;
    },
  };
}

/** What one relationship read of the person says of inviting them now. */
export type InviteAdmission =
  /** The member it bound, as the sidecar must find them again before Send. */
  | { status: "admitted"; expected: SendInvitationInput["expected"] }
  /** Not one to invite as LinkedIn's data shows them: blocked, nothing sent. */
  | { status: "refused"; reason: string }
  /** The read could not tell: held an hour, nothing sent. */
  | { status: "held"; reason: "relationship_unknown" };

/**
 * Whether one read of the person's own profile admits an invitation —
 * LinkedIn's own data (US-LIO-01), never a guess. Only a read that binds the
 * member (verified, with their profile urn and member number) and shows
 * Connect on offer, at a degree other than 1st, admits one. Connected, an
 * invitation pending either way, or one withdrawn inside LinkedIn's three
 * weeks refuse it; a read that shows none of that holds. Where their page's
 * own Connect leads plays no part: the invitation is LinkedIn's client's
 * request, not a press of it.
 */
export function inviteAdmission(read: RelationshipRead, profileId: string): InviteAdmission {
  switch (relationshipOf(read, profileId)) {
    case "connected":
      return { status: "refused", reason: "already_connected" };
    case "outgoing_pending":
      return { status: "refused", reason: "invitation_pending" };
    case "incoming_pending":
      return { status: "refused", reason: "invitation_incoming" };
    case "unknown":
      return { status: "held", reason: "relationship_unknown" };
    case "not_connected":
      break;
  }
  if (read.invitation === "withdrawn") return { status: "refused", reason: "recently_withdrawn" };
  if (
    read.invitation !== "connect" ||
    read.profileUrn === undefined ||
    read.memberId === undefined ||
    (read.degree !== "2nd" && read.degree !== "3rd+")
  ) {
    return { status: "held", reason: "relationship_unknown" };
  }
  return {
    status: "admitted",
    expected: { degree: read.degree, pending: "none", profileUrn: read.profileUrn, memberId: read.memberId },
  };
}

/** One whole read of the account's received invitations, or why it was not
 *  made or did not finish. */
type ReceivedInvitations =
  | { list: IncomingInvitationsRead }
  | { hold: string; retryAt?: number };

/**
 * One whole read of the account's received invitations (US-LIO-04), a metered
 * profile read — made once for the drain, whichever invitations in it ask:
 * ten invitations are one page load and one spend of the budget, and a read
 * that failed or was refused holds all ten alike (`OperationContext.once`).
 */
function receivedInvitations(
  driver: ActionSurface,
  context: OperationContext,
  row: ActionRow,
): Promise<ReceivedInvitations> {
  const read = async (): Promise<ReceivedInvitations> => {
    if (!driver.readIncomingInvitations) return { hold: "invitations_unreadable" };
    const refused = await spendProfileRead(context, row);
    if (refused) return { hold: refused.reason, ...(refused.retryAt !== undefined ? { retryAt: refused.retryAt } : {}) };
    try {
      return { list: await driver.readIncomingInvitations({ limit: MAX_INCOMING_INVITATIONS }) };
    } catch (error) {
      if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(context.organizationId, error);
      return { hold: "unreadable" };
    }
  };
  return context.once ? context.once(`received_invitations:${row.channelId}`, read) : read();
}

/**
 * Whether the account's received invitations list a request from the row's
 * person. `listed` blocks the invitation; only a read that lists every
 * invitation the page counts proves `absent`; anything else holds it.
 */
async function theirInvitationListed(
  driver: ActionSurface,
  context: OperationContext,
  row: ActionRow,
): Promise<"listed" | "absent" | { hold: string; retryAt?: number }> {
  const received = await receivedInvitations(driver, context, row);
  if ("hold" in received) return received;
  const { list } = received;
  if (list.invitations.some((invitation) => invitation.sender.profileId === row.authorProfileId)) return "listed";
  return list.complete && !list.truncated ? "absent" : { hold: "invitations_incomplete" };
}

function blockedBefore(reason: string, relationship?: RelationshipReadJson): Preflight {
  return {
    proceed: false,
    receipt: { status: "blocked", evidence: { reason, ...(relationship ? { relationship } : {}) } },
  };
}

/** The sidecar's answer as the ledger settles it. A confirmation carries
 *  LinkedIn's answer naming the invitation it created where that confirmed
 *  it, the read that shows it pending where one did, and the read it was
 *  admitted on. */
export function invitationReceipt(result: SendInvitationResult, admittedOn: RelationshipReadJson): ActionReceipt {
  const admittedBy = { sessionId: admittedOn.sessionId, observedAt: admittedOn.observedAt };
  switch (result.status) {
    case "confirmed": {
      const read = result.relationship;
      return {
        status: "confirmed",
        evidence: {
          relationship: read,
          ...(result.receipt ? { receipt: result.receipt } : {}),
          noteLimit: result.noteLimit,
          admittedBy,
          // What LinkedIn showed for the member the admitting read bound: the
          // invitation it created, pending, or them connected already.
          invitation: {
            profileUrn: read?.profileUrn ?? admittedOn.profileUrn ?? null,
            memberId: read?.memberId ?? admittedOn.memberId ?? null,
            state: read?.degree === "1st" ? "Distance1" : "Pending",
            observedAt: read?.observedAt ?? result.receipt?.sentAt ?? null,
            ...(result.receipt ? { invitationUrn: result.receipt.invitationUrn } : {}),
          },
        },
      };
    }
    case "blocked":
      return {
        status: "blocked",
        evidence: {
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.noteLimit !== undefined ? { noteLimit: result.noteLimit } : {}),
          admittedBy,
        },
      };
    case "not_sent":
      return { status: "definitely_not_sent", evidence: { reason: result.reason, notAttempted: true } };
    case "uncertain":
      return {
        status: "uncertain",
        evidence: { error: result.reason, ...(result.relationship ? { relationship: result.relationship } : {}) },
      };
  }
}

/**
 * What a settled invitation proves on its conversation, in the transaction that
 * settles it — whoever settled it: the gate's click, a reconciliation read,
 * the owner. A confirmed one is `invitation_confirmed` on the log, carrying
 * the read that showed it pending where there is one, and the start of the
 * wait on their answer. Nothing else moves the conversation here: an uncertain one
 * is already held by the gate, and one that never went out leaves the person
 * as the last read showed them.
 */
export async function settleInvitation(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  now: number,
): Promise<void> {
  if (receipt.status !== "confirmed" || row.conversationId === null) return;
  const read = RelationshipReadSchema.safeParse(receipt.evidence.relationship);
  const created = InvitationReceiptSchema.safeParse(receipt.evidence.receipt);
  const recorded = await recordInvitationConfirmed(tx, {
    conversationId: row.conversationId,
    actionExecutionId: row.id,
    read: read.success ? read.data : null,
    receipt: created.success ? created.data : null,
    now,
  });
  if (!recorded?.recorded) return;
  // The strategy's expiry — the wait the step that sent it asked for on the
  // invitation's status, where it asked for one — and never past the watch's.
  // It counts from the send: the step asked for it when it queued the
  // invitation, and one held for the owner's review, the account's hours or
  // its caps would otherwise be waiting out time it was never sent in. The
  // owner's own move of the wake stands as they set it.
  const [checkpoint] =
    row.stepRunId === null
      ? []
      : await tx
          .select({ id: stepRuns.id, wait: stepRuns.wait, askedAt: stepRuns.finishedAt })
          .from(stepRuns)
          .where(eq(stepRuns.id, row.stepRunId));
  const asked = checkpoint?.wait;
  const longest = now + INVITATION_WAIT_MS;
  const open = checkpoint && asked && asked.event === "invitation_status" && asked.consumedAt === null;
  const expiresAt = !open
    ? longest
    : Math.min(
        asked.movedBy ? asked.expiresAt : now + Math.max(asked.expiresAt - (checkpoint.askedAt ?? now), 0),
        longest,
      );
  if (open && expiresAt !== asked.expiresAt) await moveWaitExpiry(tx, checkpoint, expiresAt, now);
  const payload: InvitationWatchPayload = { conversationId: row.conversationId, actionExecutionId: row.id, expiresAt };
  await enqueue(tx, {
    type: "invitation_watch",
    payload,
    nextRunAt: Math.min(nextInvitationRecheck(recorded.event.occurredAt, now), expiresAt),
    idempotencyKey: `invitation_watch:${row.id}`,
  });
}

const InvitationWatchPayloadSchema = z.object({
  conversationId: z.number().int(),
  actionExecutionId: z.number().int(),
  /** When the wait on their acceptance ends. */
  expiresAt: z.number(),
});

export type InvitationWatchPayload = z.infer<typeof InvitationWatchPayloadSchema>;

/**
 * Bring the queued watches onto the schedule: one whose next read is later
 * than the schedule from its invitation's send allows is moved up to the
 * schedule's next point — a watch queued when a read was a day apart would
 * otherwise wait out that day. Only ever earlier, and only a queued row: one
 * at or before its point, or running, is left alone, and a moved watch keeps
 * its pace from there (`handleInvitationWatch`). One whose last look was
 * refused — the day's profile reads spent, the window shut — waits for when
 * the refusal said: moved up, it would only wake to be refused again. A
 * watch whose payload is not a watch's is skipped and logged: a throw here
 * would undo the scheduler's whole pass. Returns how many it moved.
 */
export async function scheduleInvitationWatches(tx: Tx, organizationId: string, now: number): Promise<number> {
  const watches = await queuedWatches(tx, organizationId);
  if (watches.length === 0) return 0;
  const confirmed = await tx
    .select({ conversationId: conversationEvents.conversationId, occurredAt: conversationEvents.occurredAt, sourceRef: conversationEvents.sourceRef })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.type, "invitation_confirmed"),
        inArray(conversationEvents.conversationId, [...new Set(watches.map((watch) => watch.payload.conversationId))]),
      ),
    );
  let moved = 0;
  for (const { id, nextRunAt, payload, result } of watches) {
    const sent = confirmed.find(
      (event) => event.conversationId === payload.conversationId && event.sourceRef.actionExecutionId === payload.actionExecutionId,
    );
    if (!sent) continue;
    const due = Math.min(nextInvitationRecheck(sent.occurredAt, now), payload.expiresAt);
    if (nextRunAt <= due) continue;
    const { refusal } = (result ?? {}) as Partial<Extract<JobResultValue, { refusal: unknown }>>;
    if (refusal?.retryAt !== undefined && refusal.retryAt > due) continue;
    const updated = await tx
      .update(jobs)
      .set({ nextRunAt: due, updatedAt: now })
      .where(and(eq(jobs.id, id), eq(jobs.status, "queued"), gt(jobs.nextRunAt, due)))
      .returning({ id: jobs.id });
    moved += updated.length;
  }
  return moved;
}

/**
 * The queued watches of one organization — the transaction's own unless
 * named — each with its payload read as a watch's. `jobs` is outside RLS, so
 * the organization is explicit; a payload that is not a watch's is skipped
 * and logged, never thrown, since the scheduler's whole pass reads these.
 */
async function queuedWatches(tx: Tx, organizationId?: string) {
  const queued = await tx
    .select({ id: jobs.id, nextRunAt: jobs.nextRunAt, payload: jobs.payload, result: jobs.result })
    .from(jobs)
    .where(
      and(
        organizationId === undefined
          ? sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`
          : eq(jobs.organizationId, organizationId),
        eq(jobs.type, "invitation_watch"),
        eq(jobs.status, "queued"),
      ),
    );
  return queued.flatMap((job) => {
    const payload = InvitationWatchPayloadSchema.safeParse(conversationPayload(job.payload as InvitationWatchPayload));
    if (payload.success) return [{ ...job, payload: payload.data }];
    // eslint-disable-next-line no-console
    console.warn(`[invitation_watch] ${job.id} skipped: its payload is not a watch's`);
    return [];
  });
}

/**
 * When Engager next reads the person of each of these conversations for an
 * invitation's answer: the queued watch's next read, by conversation. A wait
 * on an invitation ends there, within hours, and only at its expiry when no
 * read finds an answer; one with no watch queued has no entry.
 */
export async function invitationLooks(tx: Tx, conversationIds: readonly number[]): Promise<Map<number, number>> {
  if (conversationIds.length === 0) return new Map();
  const wanted = new Set(conversationIds);
  return new Map(
    (await queuedWatches(tx))
      .filter((watch) => wanted.has(watch.payload.conversationId))
      .map((watch) => [watch.payload.conversationId, watch.nextRunAt] as const),
  );
}

/** Why the owner's Check LinkedIn now on an invitation reads nothing: no
 *  answer to one is waited on. */
export type InvitationLookRefusal = "not_waiting";

/**
 * The owner's Check LinkedIn now on an invitation that still reads pending —
 * they saw it accepted before Engager did: the watch's next read of the
 * person, moved up to now, or to when the account's active hours open or a
 * spent day of profile reads frees, since the read is refused before either.
 * Only ever earlier, and only a queued watch. The read is the watch's own
 * (`handleInvitationWatch`), so an acceptance it finds ends the wait and opens
 * their Messages as any read's does. Returns when it reads, or why it will not.
 */
export async function requestInvitationLook(
  tx: Tx,
  conversationId: number,
  now: number,
): Promise<{ at: number } | { refused: InvitationLookRefusal }> {
  const watch = (await queuedWatches(tx)).find((one) => one.payload.conversationId === conversationId);
  if (!watch) return { refused: "not_waiting" };
  const [channel] = await tx
    .select({ activeHours: channels.activeHours, activeDays: channels.activeDays })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId));
  const window = withinActiveWindow(now, channel?.activeHours, channel?.activeDays);
  const { refusal } = (watch.result ?? {}) as Partial<Extract<JobResultValue, { refusal: unknown }>>;
  const at = Math.max(window.within ? now : window.nextOpen, refusal?.retryAt ?? now);
  if (watch.nextRunAt <= at) return { at: Math.max(watch.nextRunAt, now) };
  await tx
    .update(jobs)
    .set({ nextRunAt: at, updatedAt: now })
    .where(and(eq(jobs.id, watch.id), eq(jobs.status, "queued"), gt(jobs.nextRunAt, at)));
  return { at };
}
