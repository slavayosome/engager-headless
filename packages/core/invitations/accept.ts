import { and, eq, inArray, sql } from "drizzle-orm";
import {
  actions,
  campaigns,
  incomingInvitations,
  conversations,
  type ActionRow,
  type ActionTarget,
  type IncomingInvitationRow,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { rejectAction, reserveAction, type ReserveOutcome } from "../actions/ledger";
import { currentGeneration, QUEUED_STATUSES } from "../actions/pause";
import { loadStrategy, type LoadedStrategy } from "../agentStep/select";
import { conversationEventArrived } from "../agentStep/wait";
import type { ResolvedAction } from "../strategy/resolve";
import { modeFor } from "../strategy/mode";
import type {
  ActionOperation,
  ActionReceipt,
  ActionSurface,
  Preflight,
} from "../execution/actionGate";
import { spendProfileRead } from "../execution/profileRead";
import { recordIncomingAcceptance } from "../conversations/record";
import { relationshipOf } from "../conversations/relationship";
import { isConnectorBackoff } from "../linkedin/connectorError";
import {
  MAX_INCOMING_INVITATIONS,
  type AcceptanceResolution,
  type AcceptInvitationResult,
  type RelationshipRead,
} from "../linkedin/driver";
import { pauseChannelForConnectorBackoff } from "../ratelimit/killswitch";

/**
 * THE AMBASSADOR'S ACCEPT INVITE — one ledger row per person's invitation, and
 * the browser half the gate runs it through (spec §10 R05, §17 R13 "accept
 * incoming invitation"; INV-27, INV-31).
 *
 * A row is reserved only for an invitation tied to the person's conversation —
 * verified by identity or linked by the owner — on a conversation whose owning
 * campaign runs on its strategy and binds Accept invite above Off, at the
 * mode the binding resolves to: Ask me waits for the owner's yes, and
 * Automatic — reachable only on an owner-set ceiling for acceptances once the
 * account's first acceptance is confirmed (INV-28, INV-31) — goes to the gate
 * on its own.
 * Its key is the person's acceptance on the conversation, so a second wake
 * reserves nothing.
 *
 * At the gate it is a read before the click (does the page's data still list
 * the request?), the click itself (`acceptInvitation`: prepared on the data,
 * bound by the row key it names, journaled under the attempt's operation id),
 * and a read after it: the sender's own profile, `1st`, in the session that
 * pressed. The press is never the receipt, and the request leaving the list
 * is evidence, never the receipt either. Every page load the gate makes
 * outside the press — the list before it, a reconciliation's reads — spends a
 * `profile_read` from the account's read budget first, as the wake's own read
 * does. Confirmed, the
 * conversation takes `connected` with an incoming `invitation_accepted`, which
 * wakes the Ambassador where it was judged a thing to answer: nothing here
 * reserves a DM — the Message after they accept step decides on the one contextual
 * opener, and the server on whether it may go (`actions/dm.ts`).
 */

/** What a reservation for an invitation is made from. */
type Reservable = Pick<
  IncomingInvitationRow,
  "channelId" | "invitationId" | "senderProfileId" | "conversationId" | "conversationEventId" | "attribution" | "status"
>;

export type AcceptanceReservation =
  | ReserveOutcome
  /** Nothing reserved, and why: the invitation is not tied to a
   *  conversation, the campaign does not run on its strategy, or its Accept
   *  invite is Off. */
  | { status: "skipped"; reason: string };

/** The ledger target of an acceptance: the invitation, and its sender beside
 *  it — the approval's target hash binds both. */
export function acceptanceTarget(
  invitation: Pick<IncomingInvitationRow, "invitationId" | "senderProfileId">,
): ActionTarget {
  return { kind: "invitation", id: invitation.invitationId, urn: invitation.senderProfileId };
}

/** Where Accept invite stands for one invitation's conversation: the
 *  binding its owning campaign resolves, or why there is none to reserve on —
 *  the invitation is tied to no conversation, the conversation to no campaign
 *  that runs on its strategy, or that strategy has no Accept invite. */
type AcceptanceBinding =
  | {
      status: "bound";
      conversation: { authorProfileId: string };
      campaign: { id: number };
      strategy: LoadedStrategy;
      binding: ResolvedAction;
    }
  | { status: "skipped"; reason: string };

async function acceptanceBinding(
  tx: Tx,
  invitation: Pick<Reservable, "attribution" | "conversationId">,
): Promise<AcceptanceBinding> {
  if (invitation.attribution === "unmatched" || invitation.conversationId === null) {
    return { status: "skipped", reason: "unattributed" };
  }
  const [conversation] = await tx
    .select({
      authorProfileId: conversations.authorProfileId,
      owningCampaignId: conversations.owningCampaignId,
    })
    .from(conversations)
    .where(eq(conversations.id, invitation.conversationId));
  if (!conversation || conversation.owningCampaignId === null) return { status: "skipped", reason: "no_campaign" };
  const [campaign] = await tx
    .select({ id: campaigns.id, channelId: campaigns.channelId })
    .from(campaigns)
    .where(eq(campaigns.id, conversation.owningCampaignId));
  if (!campaign) return { status: "skipped", reason: "no_campaign" };
  const strategy = await loadStrategy(tx, campaign);
  if (!strategy) return { status: "skipped", reason: "strategy_unreadable" };
  const binding = await modeFor(tx, { campaignId: campaign.id, capability: "accept_invitation" });
  if (binding.action_binding_id === null) return { status: "skipped", reason: "no_accept_step" };
  return { status: "bound", conversation, campaign, strategy, binding };
}

/**
 * The mode Accept invite resolves to for an invitation's conversation — Off
 * included — or null where nothing binds it: the invitation is tied to no
 * conversation, or its campaign has no Accept invite. What the owner is told
 * when no acceptance waits on a request.
 */
/**
 * Reserve one attributed invitation's acceptance, in the caller's
 * transaction. The mode is the conversation's owning campaign's Accept invite
 * binding, resolved now: Ask me waits for the owner's yes, Automatic goes to
 * the send gate on its own (`reserveAction`).
 */
export async function reserveAcceptance(
  tx: Tx,
  invitation: Reservable,
  now: number,
): Promise<AcceptanceReservation> {
  if (invitation.attribution === "unmatched" || invitation.conversationId === null) {
    return { status: "skipped", reason: "unattributed" };
  }
  if (invitation.status !== "pending") return { status: "skipped", reason: `invitation_${invitation.status}` };
  const bound = await acceptanceBinding(tx, invitation);
  if (bound.status === "skipped") return bound;
  const { conversation, campaign, strategy, binding } = bound;
  if (binding.effective === null || binding.effective === "off") {
    return { status: "skipped", reason: `accept_invite_off:${binding.reason ?? binding.resolved_from}` };
  }
  return reserveAction(tx, {
    channelId: invitation.channelId,
    campaignId: campaign.id,
    conversationId: invitation.conversationId,
    authorProfileId: conversation.authorProfileId,
    actionBindingId: binding.action_binding_id,
    kind: "accept_invite",
    purpose: "acceptance",
    target: acceptanceTarget(invitation),
    candidate: {
      text: null,
      sources:
        invitation.conversationEventId === null ? [] : [{ eventId: invitation.conversationEventId, contentHash: null }],
      versions: { strategy: strategy.version, facts: [], memory: null, voice: null },
    },
    // What the binding resolves to: Automatic only where the account set a
    // ceiling for acceptances and its first acceptance is confirmed (INV-28,
    // INV-31).
    mode: binding.effective === "auto" ? "auto" : "review",
    generationSeen: await currentGeneration(tx),
    now,
  });
}

/** The sender an acceptance row names. */
function senderOf(row: ActionRow): string {
  if (row.target.kind !== "invitation" || row.target.urn === null) {
    throw new Error(`action ${row.id} is not an acceptance of a person's invitation`);
  }
  return row.target.urn;
}

/** How long after the press a read must be before the request still listed
 *  can say nothing was accepted: the data read in the seconds after Accept
 *  may not have caught up. A read showing the sender connected settles at
 *  any time. */
export const ACCEPTANCE_RESOLVE_SETTLE_MS = 15 * 60_000;

/** A read before the click that could not be made now is tried again this
 *  much later — a page load each time, so not every drain. */
const PREFLIGHT_RETRY_MS = 60 * 60_000;

type OperationContext = { organizationId: string; now: () => number };

/** One page load on the account, against its daily read budget: null when the
 *  budget says yes, else why not. */
async function spendRead(
  context: OperationContext,
  row: ActionRow,
): Promise<{ reason: string; retryAt?: number } | null> {
  return spendProfileRead(context, row, senderOf(row));
}

/** The gate's browser half for `accept_invite`. */
export function acceptInviteOperation(
  driver: ActionSurface,
  context: OperationContext,
): ActionOperation {
  /** A read before the click that cannot be made, or cannot finish: the row
   *  waits, approved. */
  const hold = (reason: string, retryAt?: number): Preflight => ({
    proceed: false,
    hold: `preflight:${reason}`,
    retryAt: retryAt ?? context.now() + PREFLIGHT_RETRY_MS,
  });
  const unreadable = async (error: unknown): Promise<Preflight> => {
    if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(context.organizationId, error);
    return hold("unreadable");
  };
  return {
    async preflight(row) {
      const sender = senderOf(row);
      if (!driver.readIncomingInvitations) return hold("invitations_unreadable");
      const refused = await spendRead(context, row);
      if (refused) return hold(refused.reason, refused.retryAt);
      let list;
      try {
        list = await driver.readIncomingInvitations({ limit: MAX_INCOMING_INVITATIONS });
      } catch (error) {
        return unreadable(error);
      }
      // The list holds only a person's request still Pending, each bound to
      // its sender's slug — a follow or a page's invitation is never on it —
      // so exactly one request on it under this id, from this sender, is the
      // one thing Accept may press.
      const listed = list.invitations.filter(
        (invitation) => invitation.invitationId === row.target.id && invitation.sender.profileId === sender,
      );
      if (listed.length === 1) return { proceed: true };
      // A list that offers more than it showed proves no absence, and nothing
      // else proves a request is one to accept: the row waits for a whole read.
      if (!list.complete || list.truncated) return hold("invitations_incomplete");
      // Absent from a whole read, it is not there to accept — a stale row, a
      // follow an earlier reader took for a person's request, a request taken
      // back — and nothing is pressed. Only the sender's own page says whether
      // the owner already accepted it themselves, or they withdrew it.
      const notListed: ActionReceipt = { status: "blocked", evidence: { reason: "invitation_not_listed" } };
      if (!driver.readRelationship) return { proceed: false, receipt: notListed };
      const refusedAgain = await spendRead(context, row);
      if (refusedAgain) return hold(refusedAgain.reason, refusedAgain.retryAt);
      let read;
      try {
        read = await driver.readRelationship({ profileId: sender });
      } catch (error) {
        return unreadable(error);
      }
      switch (relationshipOf(read, sender)) {
        case "connected":
          return {
            proceed: false,
            receipt: { status: "confirmed", noop: true, evidence: { reason: "already_connected", relationship: read } },
          };
        case "not_connected":
          return {
            proceed: false,
            receipt: { status: "blocked", evidence: { reason: "invitation_withdrawn", relationship: read } },
          };
        default:
          return { proceed: false, receipt: { ...notListed, evidence: { ...notListed.evidence, relationship: read } } };
      }
    },

    async perform(row) {
      if (!driver.acceptInvitation) {
        return { status: "definitely_not_sent", evidence: { reason: "accept_unavailable", notAttempted: true } };
      }
      const sender = senderOf(row);
      const result = await driver.acceptInvitation({
        invitationId: row.target.id,
        senderProfileId: sender,
        operationId: row.fenceToken!,
      });
      return acceptanceReceipt(result, sender);
    },

    async reconcile(row) {
      if (!driver.resolveAcceptance || row.fenceToken === null) return null;
      const sender = senderOf(row);
      let resolution: AcceptanceResolution;
      try {
        // The driver asks for a read only where it will load a page: the
        // sender's profile, then the invitations page. An attempt that never
        // pressed loads neither, and spends nothing.
        resolution = await driver.resolveAcceptance(
          { invitationId: row.target.id, senderProfileId: sender, operationId: row.fenceToken },
          async () => (await spendRead(context, row)) === null,
        );
      } catch (error) {
        if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(context.organizationId, error);
        return null;
      }
      return acceptanceResolved(row, resolution, sender);
    },
  };
}

/**
 * What a read of an open acceptance settles. The sender reading `1st` is
 * accepted; the request gone from a whole list with Connect on offer was
 * withdrawn; an attempt that never reached its press accepted nothing. The
 * request still listed says nothing was accepted only when the data was read
 * at least `ACCEPTANCE_RESOLVE_SETTLE_MS` after the press; anything else
 * stays open.
 */
export function acceptanceResolved(
  row: Pick<ActionRow, "attempts" | "fenceToken">,
  resolution: AcceptanceResolution,
  sender: string,
): ActionReceipt | null {
  const evidence = { relationship: resolution.relationship, reconciled: true };
  switch (resolution.status) {
    case "accepted":
      return resolution.relationship !== null && relationshipOf(resolution.relationship, sender) === "connected"
        ? { status: "confirmed", evidence }
        : null;
    case "withdrawn":
      return { status: "blocked", evidence: { ...evidence, reason: "invitation_withdrawn" } };
    case "not_sent":
      return { status: "definitely_not_sent", evidence: { ...evidence, notAttempted: true } };
    case "pending": {
      const attempt = row.attempts.find((candidate) => candidate.operationId === row.fenceToken);
      return attempt !== undefined && resolution.observedAt - attempt.startedAt >= ACCEPTANCE_RESOLVE_SETTLE_MS
        ? { status: "definitely_not_sent", evidence: { ...evidence, reason: "invitation_still_pending" } }
        : null;
    }
    case "uncertain":
      return null;
  }
}

/**
 * The acceptance op's answer as the ledger settles it. Whatever the sidecar
 * calls it, connected is what the sender's own profile, read after the press,
 * shows — a verified page of the sender reading `1st` — or it is not
 * confirmed.
 */
export function acceptanceReceipt(result: AcceptInvitationResult, sender: string): ActionReceipt {
  switch (result.status) {
    case "confirmed":
      return relationshipOf(result.relationship, sender) === "connected"
        ? { status: "confirmed", evidence: { relationship: result.relationship } }
        : { status: "uncertain", evidence: { reason: "confirmed_without_connected_read", relationship: result.relationship } };
    case "blocked":
      return {
        status: "blocked",
        evidence: {
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.relationship ? { relationship: result.relationship } : {}),
        },
      };
    case "not_sent":
      return { status: "definitely_not_sent", evidence: { reason: result.reason, notAttempted: true } };
    case "uncertain":
      return {
        status: "uncertain",
        evidence: { reason: result.reason, ...(result.relationship ? { relationship: result.relationship } : {}) },
      };
  }
}

/**
 * Skip every acceptance still waiting on one invitation — the owner dismissed
 * it here, or a read showed it gone from LinkedIn — so nothing presses Accept
 * on a request that is not there to accept.
 */
export async function skipQueuedAcceptances(
  tx: Tx,
  invitation: Pick<IncomingInvitationRow, "channelId" | "invitationId">,
  input: { by: string; reason: string; now: number },
): Promise<number> {
  const queued = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.channelId, invitation.channelId),
        eq(actions.kind, "accept_invite"),
        sql`${actions.target} ->> 'id' = ${invitation.invitationId}`,
        inArray(actions.status, QUEUED_STATUSES),
      ),
    );
  for (const action of queued) {
    await rejectAction(tx, { id: action.id, by: input.by, reason: input.reason, now: input.now });
  }
  return queued.length;
}

/**
 * What a settled acceptance does beyond the ledger, in the settling
 * transaction: confirmed, the conversation takes `connected` from the read the
 * receipt carries and the invitation is `accepted`; blocked because it was
 * withdrawn, the invitation is `gone`. Nothing else, and never a DM.
 */
export async function settleAcceptance(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  now: number,
): Promise<void> {
  if (row.kind !== "accept_invite") return;
  const sender = senderOf(row);
  const invitationWhere = and(
    eq(incomingInvitations.channelId, row.channelId),
    eq(incomingInvitations.invitationId, row.target.id),
  );
  if (receipt.status === "confirmed") {
    const read = receipt.evidence.relationship as RelationshipRead | null | undefined;
    const [invitation] = await tx
      .update(incomingInvitations)
      .set({ status: "accepted", statusAt: now, updatedAt: now })
      .where(invitationWhere)
      .returning({ conversationEventId: incomingInvitations.conversationEventId });
    if (read && row.conversationId !== null) {
      const recorded = await recordIncomingAcceptance(tx, {
        conversationId: row.conversationId,
        invitationId: row.target.id,
        senderProfileId: sender,
        read,
        invitationEventId: invitation?.conversationEventId ?? null,
        now,
      });
      // An acceptance the eligibility table judged a thing to answer — their
      // interest on the conversation, or the one contextual opener the campaign
      // allows — wakes the Ambassador; its Message after they accept step decides.
      const campaignId = recorded?.conversation.owningCampaignId ?? null;
      if (recorded?.recorded && campaignId !== null) {
        await conversationEventArrived(tx, { campaignId, event: recorded.event, now });
      }
    }
    return;
  }
  if (
    receipt.status === "blocked" &&
    (receipt.evidence.reason === "invitation_withdrawn" || receipt.evidence.reason === "invitation_not_listed")
  ) {
    await tx
      .update(incomingInvitations)
      .set({ status: "gone", statusAt: now, updatedAt: now })
      .where(invitationWhere);
  }
}
