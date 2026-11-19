import type { ActionStatus } from "@engager/database/schema";

/**
 * WHERE ONE SEND OF OURS STANDS ON ITS WAY OUT — a comment, reply, invite,
 * acceptance or message the owner said yes to (or an Automatic one the gate
 * has reserved) that LinkedIn has not confirmed yet. The strip across a
 * person's pane (`people/strip.ts`) and the lines under their header read
 * the same state, so the two never say a send two ways.
 *
 * Pure, and free of the database, so the client bundle can take its types
 * and a test can pin the words without a row: `people/sends.ts` reads the
 * rows these functions classify. A send that went out, was refused, failed
 * or was cancelled is none of this — it has a state of its own — and a draft
 * still waiting for a yes was never sent.
 */

/** `queued`: approved, waiting its turn. `held`: the gate or the queue looked
 *  and said not yet. `sending`: the click is in flight. `checking`: it went
 *  out unsure, and Engager is reading to find out. */
export type SendPhase = "queued" | "held" | "sending" | "checking";

export type SendState = {
  phase: SendPhase;
  /** The moment it goes out or is tried again, as its row or the queue names
   *  it: a comment's slot, the instant a hold is looked at again, or — for
   *  a hold on the active hours — the instant they open. Null where none is
   *  named — never guessed. */
  at: number | null;
  /** What a held send waits on, where the Inbox words it: the account's
   *  active hours, its campaign's pause, the owner's review of the
   *  conversation, or a read of the person that can tell whether the two are
   *  connected. Any other hold is null. */
  because: "active_hours" | "campaign_paused" | "writes_off" | "conversation_review" | "relationship_check" | null;
  /** The zone the active hours are kept in, so their opening reads on the
   *  account's clock. On an active-hours hold alone. */
  tz?: string;
  /** The hold is on the read before the send, which must still pass once the
   *  hours open: the hours opening does not send it. On an active-hours hold
   *  alone. */
  afterCheck?: true;
  /** The campaign whose pause holds the send, by name and by id (its Resume
   *  is the owner's). On a pause hold alone. */
  campaign?: string;
  campaignId?: number;
};

/** What is going out. A message and a follow-up are both `dm`. */
export type SendKind = "comment" | "reply" | "room_reply" | "invite" | "accept_invite" | "dm";

/** One send, by its row: a `messages` row for a comment or a reply, an
 *  `actions` row for the rest. */
export type Send = { kind: SendKind; id: number; state: SendState };

/** A hold only the owner lifts: their Resume of the campaign, their turning
 *  sending on, their review of the conversation. The active hours and the
 *  queue's next look pass on their own, and nothing waits on the owner for
 *  them. */
const OWNER_HOLDS = new Set<SendState["because"]>(["campaign_paused", "writes_off", "conversation_review"]);

export const waitsOnOwner = (state: SendState): boolean => state.phase === "held" && OWNER_HOLDS.has(state.because);

/** The state of one send among a person's, by its kind and row. */
export const sendStateOf = (sends: readonly Send[], kind: SendKind, id: number): SendState | undefined =>
  sends.find((send) => send.kind === kind && send.id === id)?.state;

/** When the account's active hours next open, and the zone they are kept in. */
export type Opening = { at: number; tz: string };

/** The holds that mean the account's active hours are closed: the ledger's
 *  refusal on a comment, and the read before an invite is sent. The gate's
 *  `outside_window` is not one: it is the account policy's sending window, a
 *  setting of its own with its own opening. */
const ACTIVE_HOURS = new Set(["outside_active_hours", "preflight:outside_active_hours"]);

/** The gate's hold on unattended work in a conversation that waits on the
 *  owner (`conversations.ops_status = awaiting_review`): nothing a worker queued
 *  goes in it until they have looked. */
const CONVERSATION_REVIEW = "conversation_awaiting_review";
/** The same hold where only a read of the person that could not tell sent the
 *  conversation there: Engager reads them again on its own, and a read that
 *  can tell lets it go (`execution/actionGate.ts` `RELATIONSHIP_UNREAD_HOLD`). */
const RELATIONSHIP_CHECK = "conversation_relationship_unread";

/** A hold. For the active hours it names their next opening, not the instant
 *  the queue next looks: the queue's job is shared by every held action of the
 *  account and a new yes pulls it forward, so its instant can fall before the
 *  hours open. Any other hold names the instant the queue looks again, and so
 *  does an hours hold once they are open (`opens` null): it is a stale one. */
const hold = (reason: string, retryAt: number | null, opens: Opening | null): SendState => {
  // Looking again changes nothing: only the owner's review lets it go.
  if (reason === CONVERSATION_REVIEW || reason === "journey_awaiting_review") return { phase: "held", at: null, because: "conversation_review" };
  if (reason === RELATIONSHIP_CHECK || reason === "journey_relationship_unread") return { phase: "held", at: null, because: "relationship_check" };
  return ACTIVE_HOURS.has(reason) && opens !== null
    ? {
        phase: "held",
        at: opens.at,
        because: "active_hours",
        tz: opens.tz,
        ...(reason.startsWith("preflight:") ? { afterCheck: true as const } : {}),
      }
    : { phase: "held", at: retryAt, because: null };
};

/** A ledger row on its way out, or null where it is not on its way: a draft
 *  waiting for a yes, a send settled one way or the other. `retryAt` is the
 *  instant the queue looks at the account's held actions again, `opens` when
 *  its active hours next open. */
export function actionSendState(
  row: { status: ActionStatus; statusReason: string | null },
  retryAt: number | null,
  opens: Opening | null,
): SendState | null {
  switch (row.status) {
    case "reserved":
    case "approved":
      return row.statusReason?.startsWith("held:")
        ? hold(row.statusReason.slice("held:".length), retryAt, opens)
        : { phase: "queued", at: null, because: null };
    case "dispatching":
      return { phase: "sending", at: null, because: null };
    case "uncertain":
      return { phase: "checking", at: null, because: null };
    default:
      return null;
  }
}

/** An approved comment or reply: held by its campaign's pause (`pausedCampaign`
 *  names the campaign, for an unattended send, which takes no slot until the
 *  Resume), waiting for its planned slot, held by a rung that refused it
 *  (`refusal`, from the post job's receipt), or posting. */
export function messageSendState(
  row: {
    status: string;
    scheduledAt: number | null;
    pausedCampaign: { id: number; name: string } | null;
    sendAuthorized?: boolean;
  },
  refusal: { code: string; retryAt: number | null } | null,
  opens: Opening | null,
): SendState | null {
  switch (row.status) {
    case "approved":
      if (row.sendAuthorized === false) return { phase: "held", at: null, because: "writes_off" };
      if (row.pausedCampaign !== null) {
        return {
          phase: "held",
          at: null,
          because: "campaign_paused",
          campaign: row.pausedCampaign.name,
          campaignId: row.pausedCampaign.id,
        };
      }
      return refusal
        ? hold(refusal.code, refusal.retryAt, opens)
        : { phase: "queued", at: row.scheduledAt, because: null };
    case "posting":
      return { phase: "sending", at: null, because: null };
    default:
      return null;
  }
}
