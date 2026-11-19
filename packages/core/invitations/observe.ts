import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  channels,
  incomingComments,
  incomingInvitations,
  conversationEvents,
  conversations,
  type IncomingInvitationRow,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { leadOf } from "../ai/reading";
import type { CapabilitySurface } from "../connector/resolve";
import { authorIdentity } from "../people/key";
import { recordIncomingInvitation } from "../conversations/record";
import { leadsEnabled } from "../leads/gate";
import { followLifecycle, markRelationship } from "../leads/lifecycle";
import { foldLeadWords, peopleWithLeads, readWords } from "../leads/words";
import type { IncomingInvitation, IncomingInvitationsRead } from "../linkedin/driver";
import { stampPacedRun } from "../pacing";
import { reserveResearchRead, type EngageDecision } from "../ratelimit/ledger";
import { reserveAcceptance, skipQueuedAcceptances, type AcceptanceReservation } from "./accept";
import { attributeInvitation, sameName, type Exchange } from "./attribute";
import { invitationsCheckKind } from "./wake";

/**
 * THE AMBASSADOR'S EYE ON INCOMING INVITATIONS — one read of the account's own
 * invitations page per wake, recorded (spec §10 R05, §11 R08
 * `IncomingInvitationObserved`, §15; INV-30, INV-31).
 *
 * The read is a page load on the account's session, so it spends a
 * `profile_read` from the account's research budget first, in a transaction
 * of its own; it is performed holding no connection, bounded where the waking
 * campaign's observation begins — when it began observing, and as far before
 * it as `observation.replay_lookback_hours` reaches; and recorded in one
 * transaction:
 *
 *   - every invitation on it is kept as one row per account (its sender, their
 *     note verbatim, when the page dates it, when it was last seen);
 *   - one not yet tied to a conversation is attributed by identity alone
 *     (`attribute.ts`) — verified when its sender wrote a reply a conversation on
 *     this account recorded; the conversation then records it
 *     (`incoming_invitation_observed`) and takes `incoming_pending`;
 *   - one that is tied — verified now, or linked earlier by the owner — gets
 *     its Accept invite reserved for the owner's yes where the conversation's
 *     campaign binds it above Off (`accept.ts`);
 *   - unmatched, it is listed for the owner and acted on by nothing;
 *   - on a read that showed the whole list, a pending row the read no longer
 *     shows — since where the read began — is `gone`.
 *
 * The read is made by an Ambassador's wake, by the account's light check
 * between wakes (`jobs/handlers/inboxCheck.ts`) or by the owner's live check;
 * whoever made it, the light check's next look is measured from it, so the
 * two never read the page twice in a row.
 *
 * A read that fails changes nothing: a page the connector does not recognise
 * throws to the caller with no row written.
 */

const HOUR = 3_600_000;

/** How far back an invitation may date and still be read, where no waking
 *  campaign says where its read begins — the replies' own default. */
export const DEFAULT_INVITATION_LOOKBACK_MS = 168 * HOUR;

/** The most invitations one read takes in. */
export const INVITATIONS_PER_READ = 50;

export type ObservedInvitation = {
  invitation: IncomingInvitationRow;
  /** Whether this read stored it for the first time (it was already kept
   *  otherwise). */
  stored: boolean;
  /** Whether this read recorded it on a conversation (it was already, or is not
   *  tied to one, otherwise). */
  recorded: boolean;
  reservation: AcceptanceReservation | null;
};

export type InvitationObservation =
  | {
      status: "read";
      read: IncomingInvitationsRead;
      observed: ObservedInvitation[];
      /** Pending rows the read showed gone. */
      gone: number;
    }
  /** The account's read budget, window or stops said no; nothing was read. */
  | { status: "refused"; reason: string; retryAt?: number }
  /** The connector reads no invitations list. */
  | { status: "unsupported" };

export async function observeIncomingInvitations(opts: {
  organizationId: string;
  channelId: number;
  driver: CapabilitySurface<"invitations_read">;
  /** Where the read begins: the waking campaign's observation
   *  (`campaignObservation`); else the default lookback from now. */
  since?: number;
  now?: number;
  /** Reads the notes of the invitations this read stored, for the leads of
   *  their senders; the owner's model where none is given. */
  llm?: LLM;
}): Promise<InvitationObservation> {
  const { organizationId, driver, channelId } = opts;
  const now = opts.now ?? Date.now();
  if (!driver.readIncomingInvitations) return { status: "unsupported" };

  const reserved = await withOrg(organizationId, async (tx): Promise<EngageDecision> => {
    const [channel] = await tx.select().from(channels).where(eq(channels.id, channelId));
    return channel
      ? reserveResearchRead({ db: tx, channel, read: "profile_read", now })
      : { ok: false, reason: "account_gone", permanent: true };
  });
  if (!reserved.ok) {
    return {
      status: "refused",
      reason: reserved.reason,
      ...(reserved.retryAt != null ? { retryAt: reserved.retryAt } : {}),
    };
  }

  const since = opts.since ?? now - DEFAULT_INVITATION_LOOKBACK_MS;
  const read = await driver.readIncomingInvitations({ since, limit: INVITATIONS_PER_READ });
  const result = await withOrg(organizationId, async (tx) => {
    const [channel] = await tx
      .select({ cadenceMin: channels.inboxCheckBaseMin })
      .from(channels)
      .where(eq(channels.id, channelId));
    if (channel) await stampPacedRun(tx, invitationsCheckKind(channelId), channel.cadenceMin * 60_000, now);
    return {
      status: "read" as const,
      read,
      ...(await recordInvitationsRead(tx, { channelId, read, since, now })),
    };
  });
  await foldInvitationNotes(organizationId, result.observed, opts.llm);
  return result;
}

/**
 * The note on an invitation is the sender's own words to the owner, so it
 * counts toward their lead's temperature as a reply does. Read once, for an
 * invitation this read stored for the first time whose sender has a lead,
 * after the read is recorded: no model call holds a connection, and a note
 * that cannot be read is skipped without touching the invitation.
 */
async function foldInvitationNotes(
  organizationId: string,
  observed: readonly ObservedInvitation[],
  llm: LLM | undefined,
): Promise<void> {
  const noted = observed.filter(({ invitation, stored }) => stored && invitation.note?.trim());
  if (noted.length === 0) return;
  try {
    const senders = await withOrg(organizationId, async (tx) =>
      (await leadsEnabled(tx))
        ? peopleWithLeads(tx, noted.map(({ invitation }) => invitation.senderProfileId))
        : new Set<string>(),
    );
    for (const { invitation } of noted) {
      if (!senders.has(authorIdentity(invitation.senderProfileId))) continue;
      const reading = await readWords(invitation.note!, "invite_note", llm);
      if (!reading) continue;
      await withOrg(organizationId, async (tx) => {
        const [conversation] =
          invitation.conversationId === null
            ? []
            : await tx.select({ campaignId: conversations.owningCampaignId }).from(conversations).where(eq(conversations.id, invitation.conversationId));
        await foldLeadWords(tx, {
          profileId: invitation.senderProfileId,
          name: invitation.senderDisplayName,
          campaignId: conversation?.campaignId ?? null,
          kind: "invite_note",
          verdict: leadOf(reading),
          at: invitation.receivedAt ?? invitation.firstObservedAt,
        });
      });
    }
  } catch (error) {
    // The invitation is recorded; its note counting is never worth the read.
    console.error("[invitations] folding a note into a lead failed:", error);
  }
}

/** Record one read of the invitations page, in the caller's transaction. */
export async function recordInvitationsRead(
  tx: Tx,
  input: { channelId: number; read: IncomingInvitationsRead; since: number; now: number },
): Promise<{ observed: ObservedInvitation[]; gone: number }> {
  const { channelId, read, now } = input;
  const exchanges = await exchangesFor(tx, channelId, read.invitations);
  const observed: ObservedInvitation[] = [];
  for (const invitation of read.invitations) {
    const kept = await keep(tx, channelId, invitation, now);
    let row = kept.row;
    let recorded = false;
    // A new invitation is its sender writing to the owner, tied to a
    // conversation or not: a person Find leads handed over is a Relationship.
    if (kept.stored) {
      await followLifecycle(tx, "markRelationship", (sp) =>
        markRelationship(sp, {
          profileId: invitation.sender.profileId,
          at: invitation.receivedAt ?? invitation.observedAt,
          kind: "invite_received",
        }));
    }
    if (row.attribution === "unmatched") {
      const attribution = attributeInvitation(invitation, exchanges);
      if (attribution.status === "verified") {
        const event = await recordIncomingInvitation(tx, {
          conversationId: attribution.conversationId,
          invitation: {
            invitationId: invitation.invitationId,
            senderProfileId: invitation.sender.profileId,
            senderUrl: invitation.sender.url,
            observedAt: invitation.observedAt,
            link: { method: "verified_exchange", replyEventId: attribution.replyEventId },
          },
          now,
        });
        if (event) {
          recorded = event.recorded;
          row = await updateInvitation(tx, row.id, {
            attribution: "verified_exchange",
            attributionEvidence: {
              method: "verified_exchange",
              profileId: invitation.sender.profileId,
              conversationId: attribution.conversationId,
              replyEventId: attribution.replyEventId,
            },
            conversationId: attribution.conversationId,
            conversationEventId: event.event.id,
            updatedAt: now,
          });
        }
      } else {
        row = await updateInvitation(tx, row.id, {
          attributionEvidence: { method: "unmatched", nameMatches: attribution.nameMatches },
          updatedAt: now,
        });
      }
    }
    observed.push({
      invitation: row,
      stored: kept.stored,
      recorded,
      reservation: row.attribution === "unmatched" ? null : await reserveAcceptance(tx, row, now),
    });
  }
  return { observed, gone: await goneSince(tx, input) };
}

/** The row for one invitation, current with this read, and whether this read
 *  stored it. A dismissed one stays dismissed and an accepted one accepted;
 *  one a read showed gone is pending again when a read shows it. */
async function keep(
  tx: Tx,
  channelId: number,
  invitation: IncomingInvitation,
  now: number,
): Promise<{ row: IncomingInvitationRow; stored: boolean }> {
  const facts = {
    senderUrl: invitation.sender.url,
    senderDisplayName: invitation.sender.displayName,
    note: invitation.note ?? null,
    observedAt: invitation.observedAt,
    updatedAt: now,
  };
  const [inserted] = await tx
    .insert(incomingInvitations)
    .values({
      ...facts,
      channelId,
      invitationId: invitation.invitationId,
      senderProfileId: invitation.sender.profileId,
      receivedAt: invitation.receivedAt ?? null,
      firstObservedAt: invitation.observedAt,
      statusAt: now,
      attributionEvidence: { method: "unmatched", nameMatches: [] },
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [
        incomingInvitations.organizationId,
        incomingInvitations.channelId,
        incomingInvitations.invitationId,
      ],
    })
    .returning();
  if (inserted) return { row: inserted, stored: true };
  const [existing] = await tx
    .select()
    .from(incomingInvitations)
    .where(
      and(
        eq(incomingInvitations.channelId, channelId),
        eq(incomingInvitations.invitationId, invitation.invitationId),
      ),
    )
    .for("update");
  if (!existing) throw new Error(`invitation ${invitation.invitationId}: neither inserted nor found`);
  const row = await updateInvitation(tx, existing.id, {
    ...facts,
    receivedAt: invitation.receivedAt ?? existing.receivedAt,
    ...(existing.status === "gone" ? { status: "pending" as const, statusAt: now } : {}),
  });
  return { row, stored: false };
}

export async function updateInvitation(
  tx: Tx,
  id: number,
  set: Partial<typeof incomingInvitations.$inferInsert>,
): Promise<IncomingInvitationRow> {
  const [row] = await tx
    .update(incomingInvitations)
    .set(set)
    .where(eq(incomingInvitations.id, id))
    .returning();
  if (!row) throw new Error(`invitation row ${id} not found`);
  return row;
}

/** On a read that showed the whole list, the pending rows within its lookback
 *  it no longer shows: accepted, ignored or withdrawn on LinkedIn — and any
 *  acceptance still waiting on one of them is skipped with it. */
async function goneSince(
  tx: Tx,
  input: { channelId: number; read: IncomingInvitationsRead; since: number; now: number },
): Promise<number> {
  const { read, now } = input;
  if (!read.complete || read.truncated) return 0;
  const seen = read.invitations.map((invitation) => invitation.invitationId);
  const gone = await tx
    .update(incomingInvitations)
    .set({ status: "gone", statusAt: now, updatedAt: now })
    .where(
      and(
        eq(incomingInvitations.channelId, input.channelId),
        eq(incomingInvitations.status, "pending"),
        or(isNull(incomingInvitations.receivedAt), gte(incomingInvitations.receivedAt, input.since)),
        ...(seen.length > 0 ? [notInArray(incomingInvitations.invitationId, seen)] : []),
      ),
    )
    .returning({
      channelId: incomingInvitations.channelId,
      invitationId: incomingInvitations.invitationId,
    });
  for (const invitation of gone) {
    await skipQueuedAcceptances(tx, invitation, { by: "invitations_read", reason: "invitation_gone", now });
  }
  return gone.length;
}

/**
 * The replies conversations on this account recorded from these invitations'
 * senders — by provider id, which is what verifies — and from anyone sharing a
 * sender's name, which only hints. One per conversation: its latest
 * `reply_observed`.
 */
export async function exchangesFor(
  tx: Tx,
  channelId: number,
  invitations: readonly Pick<IncomingInvitation, "sender">[],
): Promise<Exchange[]> {
  if (invitations.length === 0) return [];
  const ids = [...new Set(invitations.map((invitation) => invitation.sender.profileId))];
  const names = [
    ...new Set(invitations.map((invitation) => invitation.sender.displayName.toLocaleLowerCase())),
  ];
  const rows = await tx
    .select({
      conversationId: conversations.id,
      profileId: conversations.authorProfileId,
      closedReason: conversations.closedReason,
      replyEventId: conversationEvents.id,
      displayName: incomingComments.authorName,
    })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .leftJoin(
      incomingComments,
      eq(incomingComments.id, sql`(${conversationEvents.sourceRef} ->> 'incomingCommentId')::bigint`),
    )
    .where(
      and(
        eq(conversations.channelId, channelId),
        eq(conversationEvents.type, "reply_observed"),
        or(
          inArray(conversations.authorProfileId, ids),
          inArray(sql`lower(${incomingComments.authorName})`, names),
        ),
      ),
    )
    .orderBy(desc(conversationEvents.id));
  const latest = new Map<number, Exchange>();
  for (const row of rows) {
    if (latest.has(row.conversationId)) continue;
    latest.set(row.conversationId, {
      conversationId: row.conversationId,
      profileId: row.profileId,
      displayName: row.displayName,
      replyEventId: row.replyEventId,
      closed: row.closedReason !== null,
    });
  }
  return [...latest.values()].filter(
    (exchange) =>
      ids.includes(exchange.profileId) ||
      invitations.some((invitation) => sameName(exchange.displayName, invitation.sender.displayName)),
  );
}
