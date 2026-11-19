import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  LIVE_CHECK_CAPABILITIES,
  actionApprovals,
  actions,
  channels,
  feedback,
  liveChecks,
  messages,
  type ActionKind,
  type ActionRow,
  type LiveCheckCapability,
  type RecordedLiveCheckCapability,
  type LiveCheckRow,
  type LiveCheckSubject,
  type Message,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  FIRST_SEND,
  LIVE_READ_RECORDS,
  MODE_KEY_LABELS,
  OWNER_WRITE_LABELS,
  firstSendPending,
  liveCheckOf,
  type CapabilityId,
  type LiveCheckedId,
  type LiveChecks,
} from "../strategy/catalog";
import type { ActionReceipt } from "../execution/actionGate";
import { channelCeilings } from "../ratelimit/ledger";

/**
 * THE ACCOUNT'S VERIFIED WRITES, AS EVERY READER SEES THEM (INV-31).
 *
 * A write surface — Invite, Accept invite, DM and with it Follow-up, and the
 * owner's own Withdraw invite — asks the owner until it is verified on the
 * account: the shipped record in `LIVE_READ_RECORDS`, or a `recorded` row
 * here. The account's first confirmed send of it records one
 * ({@link recordFirstSend}) — the owner's yes on that first draft is the
 * check — and so does the owner's optional live check (`liveChecks/flow.ts`).
 * The resolver, the wakes and the dispatch gate all read the account's
 * through {@link recordedLiveChecks}: until one stands each of it resolves at
 * most Ask me, and the gate sends an Automatic reservation of it back for a
 * yes ({@link firstSendWaits}). A row is recorded only by a write's own
 * re-read, the gate's or a reconciliation's — never by the owner's word on an
 * uncertain one, and never by an agent.
 */

/** The capability each kind on the action ledger sends through, for the kinds
 *  a first send verifies. */
export const CHECKED_KINDS: Readonly<Partial<Record<ActionKind, LiveCheckedId>>> = {
  invite: "send_invitation",
  accept_invite: "accept_invitation",
  dm: "send_dm",
  followup: "followup",
  withdraw_invite: "withdraw_invitation",
  room_reply: "room_reply",
};

/** What each record lets follow its stored mode, by its catalog labels. */
export const LIVE_CHECK_UNLOCKS: Readonly<Record<LiveCheckCapability, readonly string[]>> = {
  send_invitation: [MODE_KEY_LABELS.invite],
  accept_invitation: [MODE_KEY_LABELS.accept_invite],
  send_dm: [MODE_KEY_LABELS.dm, MODE_KEY_LABELS.followup],
  withdraw_invitation: [OWNER_WRITE_LABELS.withdraw_invitation],
};

/** An attempt is in progress in these states, and holds its capability's one
 *  open slot on the account. */
export const OPEN_LIVE_CHECK_STATES = ["reading", "read", "writing"] as const;

/** Recorded proofs belonging to the account currently connected here. */
async function currentRecords(tx: Tx, channelId: number) {
  const rows = await tx
    .select({ capability: liveChecks.capability, account: channels.externalAccountId,
      executionAccount: channels.executionAccountId, target: messages.roomReplyTarget, at: liveChecks.recordedAt })
    .from(liveChecks)
    .innerJoin(channels, eq(channels.id, liveChecks.channelId))
    .leftJoin(messages, eq(messages.id, liveChecks.messageId))
    .where(and(eq(liveChecks.channelId, channelId), eq(liveChecks.state, "recorded")));
  return rows.filter((row) => row.capability !== "room_reply" ||
    (!!row.account && row.account === row.target?.accountProfileId &&
      (!row.executionAccount || row.executionAccount === row.account)));
}

/** The capabilities verified on one account: by a first send or a check. */
export async function recordedLiveChecks(tx: Tx, channelId: number): Promise<LiveChecks> {
  return new Set<LiveCheckedId>((await currentRecords(tx, channelId)).map((row) => row.capability));
}

/** A room reply is verified only by its confirmed send, never an optional
 * check. Account replacement cannot inherit the previous account's proof. */
export async function roomReplyFirstSendAt(tx: Tx, channelId: number): Promise<number | null> {
  const recorded = (await currentRecords(tx, channelId)).filter((row) => row.capability === "room_reply" && row.at !== null);
  return recorded.length ? Math.min(...recorded.map((row) => row.at!)) : null;
}

/** Approval is of these words in this attempt, and says nothing about who
 * authored them. Only server-attested owner surfaces qualify. */
export async function roomReplyApproval(tx: Tx, message: Message) {
  if (message.kind !== "room_reply") return null;
  const [yes] = await tx.select().from(feedback).where(eq(feedback.messageId, message.id))
    .orderBy(desc(feedback.id)).limit(1);
  if (!yes || (yes.verdict !== "approve" && yes.verdict !== "edit") ||
    (yes.decisionOrigin !== "dashboard" && yes.decisionOrigin !== "mcp_app") ||
    yes.messageRequestVersion !== message.redraftRequestVersion ||
    yes.finalTextHash !== createHash("sha256").update(message.finalText ?? message.proposedText).digest("hex")) return null;
  return yes;
}

/** Called only beside the provider-confirmed message/ledger/watch settlement.
 * No text, name, model decision or owner assertion becomes capability proof. */
export async function recordRoomReplyFirstSend(
  tx: Tx,
  message: Message,
  input: { channelId: number; externalUrn: string; by: "gate" | "reconcile"; now: number },
): Promise<boolean> {
  if (message.kind !== "room_reply" || !message.roomReplyTarget || !input.externalUrn.trim()) return false;
  const yes = await roomReplyApproval(tx, message);
  if (!yes) return false;
  const [stored] = await tx.select().from(messages).where(eq(messages.id, message.id));
  if (stored?.status !== "posted" || stored.externalUrn !== input.externalUrn ||
    stored.redraftRequestVersion !== message.redraftRequestVersion) return false;
  const [channel] = await tx.select().from(channels).where(eq(channels.id, input.channelId)).for("update");
  const account = message.roomReplyTarget.accountProfileId;
  if (!channel || channel.externalAccountId !== account ||
    (channel.executionAccountId && channel.executionAccountId !== account)) return false;
  if (!firstSendPending("room_reply", await recordedLiveChecks(tx, input.channelId))) return false;
  // A previous account's record remains history, never an unlock for the new
  // connection. Serialize replacement with all first sends on this channel.
  await tx.update(liveChecks).set({ state: "closed", closedReason: "account_changed", updatedAt: input.now })
    .where(and(eq(liveChecks.channelId, input.channelId), eq(liveChecks.capability, "room_reply"), eq(liveChecks.state, "recorded")));
  const recorded = await tx.insert(liveChecks).values({
    channelId: input.channelId, capability: "room_reply", state: "recorded",
    subject: { kind: "room_reply", messageId: message.id }, messageId: message.id,
    readConfirmedAt: yes.createdAt, startedBy: `owner:${yes.decisionOrigin}`, recordedBy: FIRST_SEND,
    recordedAt: input.now, createdAt: input.now, updatedAt: input.now,
    writeProof: { messageId: message.id, operationId: `${message.dedupeKey}:${message.redraftRequestVersion}`,
      settledBy: input.by, settledAt: input.now,
      evidence: { externalUrn: input.externalUrn, accountProfileId: account } },
  }).onConflictDoNothing().returning({ id: liveChecks.id });
  return recorded.length > 0;
}

/**
 * Whether an action's kind still waits on the account's first confirmed send
 * of it — what holds an Automatic reservation of it for the owner's yes at
 * the gate. A row the owner said yes to goes on: that yes is the check.
 */
export async function firstSendWaits(
  tx: Tx,
  row: Pick<ActionRow, "kind" | "channelId">,
): Promise<boolean> {
  const capability = CHECKED_KINDS[row.kind];
  return capability !== undefined && firstSendPending(capability, await recordedLiveChecks(tx, row.channelId));
}

/**
 * The account's first confirmed send of a capability, recorded as its
 * verification in the transaction that settles it (INV-31): the owner said
 * yes to it, and the operation's own re-read — the gate's answer for its
 * click, or a reconciliation read's — confirmed it went out. From then on the
 * capability follows its stored mode on every campaign on the account,
 * Automatic included. Nothing else records one: an action target that already stood
 * that way (nothing was pressed), the owner's word on an uncertain send, an
 * answer that it did not go out, or a send no yes stood behind. The row's
 * subject is the conversation it went out on, and the owner's yes stands
 * where a check's confirmed read does. True when it recorded one.
 */
export async function recordFirstSend(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  settled: { by: "gate" | "reconcile" | "owner"; clicked: boolean; now: number },
): Promise<boolean> {
  const capability = CHECKED_KINDS[row.kind];
  if (capability === undefined || row.conversationId === null) return false;
  if (receipt.status !== "confirmed" || receipt.noop === true || !settled.clicked || settled.by === "owner") {
    return false;
  }
  if (!firstSendPending(capability, await recordedLiveChecks(tx, row.channelId))) return false;
  const [yes] = await tx
    .select({ approver: actionApprovals.approver, createdAt: actionApprovals.createdAt })
    .from(actionApprovals)
    .where(and(eq(actionApprovals.actionExecutionId, row.id), isNotNull(actionApprovals.usedAt)))
    .orderBy(desc(actionApprovals.id))
    .limit(1);
  if (!yes) return false;
  const { now } = settled;
  // One record per capability on an account: a check recorded in the same
  // instant stands, and this one is not needed.
  const recorded = await tx
    .insert(liveChecks)
    .values({
      channelId: row.channelId,
      capability: liveCheckOf(capability) as LiveCheckCapability,
      state: "recorded",
      subject: { kind: "conversation", conversationId: row.conversationId },
      readConfirmedAt: yes.createdAt,
      actionExecutionId: row.id,
      writeProof: {
        actionExecutionId: row.id,
        operationId: row.fenceToken,
        settledBy: settled.by,
        settledAt: now,
        evidence: receipt.evidence,
      },
      startedBy: yes.approver,
      recordedBy: FIRST_SEND,
      recordedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: liveChecks.id });
  return recorded.length > 0;
}

/**
 * End the attempts whose one write was taken out of the queue before it ever
 * reached the gate's click — cancelled by a Stop, a skip, an exclusion or
 * their own message, or blocked there — in the transaction that
 * took it out. Nothing went out, so nothing is recorded, and the owner can
 * start the check again. Every writer that settles a queued action without
 * the gate's settlement calls this beside it.
 */
export async function endLiveCheckWrites(
  tx: Tx,
  actionIds: readonly number[],
  status: "cancelled" | "blocked",
  now: number,
): Promise<void> {
  if (actionIds.length === 0) return;
  await tx
    .update(liveChecks)
    .set({ state: "closed", closedReason: `not_sent:${status}`, updatedAt: now })
    .where(and(inArray(liveChecks.actionExecutionId, [...actionIds]), eq(liveChecks.state, "writing")));
}

/** One attempt as a surface shows it. */
export type LiveCheckAttempt = Pick<
  LiveCheckRow,
  | "id"
  | "state"
  | "readProof"
  | "readConfirmedAt"
  | "actionExecutionId"
  | "closedReason"
  | "createdAt"
  | "updatedAt"
> & {
  subject: LiveCheckSubject;
  /** Where its one write stands on the action ledger, once there is one. */
  write: Pick<ActionRow, "status" | "statusReason"> | null;
};

/** One write's verification on the account: whether its first send is still
 *  pending, the record that stands, and the newest attempt at its optional
 *  check since. */
export type LiveCheckView = {
  capability: LiveCheckCapability;
  unlocks: readonly string[];
  /** Ask me at most on every campaign here until a record stands. */
  pending: boolean;
  /** The date of the record shipped for every install, if there is one. */
  shipped: string | null;
  /** `by` is {@link FIRST_SEND} where the account's first confirmed send
   *  made it, else the owner who ran the check. */
  recorded: { id: number; at: number; by: string } | null;
  /** The attempt in progress, else the newest one that ended after the
   *  record — what the owner did last, and how it ended. */
  attempt: LiveCheckAttempt | null;
};

export type AccountLiveChecks = {
  /** The account they are recorded on; null with no LinkedIn account. */
  channelId: number | null;
  checks: LiveCheckView[];
};

/** Every check on the org's LinkedIn account. Read-only. */
export async function accountLiveChecks(tx: Tx): Promise<AccountLiveChecks> {
  const channel = await channelCeilings(tx);
  const rows = channel
    ? (
        await tx
          .select({
            check: liveChecks,
            status: actions.status,
            statusReason: actions.statusReason,
          })
          .from(liveChecks)
          .leftJoin(actions, eq(actions.id, liveChecks.actionExecutionId))
          .where(eq(liveChecks.channelId, channel.id))
          .orderBy(desc(liveChecks.id))
      ).map(({ check, status, statusReason }) => ({
        ...check,
        write: status === null ? null : { status, statusReason },
      }))
    : [];
  return {
    channelId: channel?.id ?? null,
    checks: LIVE_CHECK_CAPABILITIES.map((capability) => {
      const own = rows.filter((row) => row.capability === capability);
      const record = own.find((row) => row.state === "recorded") ?? null;
      const latest = own.find((row) => row.state !== "recorded" && (record === null || row.id > record.id));
      return {
        capability,
        unlocks: LIVE_CHECK_UNLOCKS[capability],
        pending: firstSendPending(capability, new Set(record ? [capability] : [])),
        shipped: LIVE_READ_RECORDS[capability] ?? null,
        recorded: record ? { id: record.id, at: record.recordedAt!, by: record.recordedBy! } : null,
        attempt: latest ? attemptOf(latest) : null,
      };
    }),
  };
}

/** One check's view, by its capability. */
export async function accountLiveCheck(tx: Tx, capability: LiveCheckCapability): Promise<LiveCheckView> {
  const { checks } = await accountLiveChecks(tx);
  return checks.find((check) => check.capability === capability)!;
}

function attemptOf(row: LiveCheckRow & Pick<LiveCheckAttempt, "write">): LiveCheckAttempt {
  if (row.subject.kind === "room_reply") throw new Error("A room reply has no optional live-check attempt.");
  return {
    write: row.write,
    id: row.id,
    state: row.state,
    subject: row.subject,
    readProof: row.readProof,
    readConfirmedAt: row.readConfirmedAt,
    actionExecutionId: row.actionExecutionId,
    closedReason: row.closedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Whether a string names a check. */
export function isLiveCheckCapability(value: unknown): value is LiveCheckCapability {
  return typeof value === "string" && (LIVE_CHECK_CAPABILITIES as readonly string[]).includes(value);
}

export type OptionalLiveCheckRow = LiveCheckRow & { capability: LiveCheckCapability; subject: LiveCheckSubject };

export function isOptionalLiveCheck(row: LiveCheckRow): row is OptionalLiveCheckRow {
  return isLiveCheckCapability(row.capability) && row.subject.kind !== "room_reply";
}

/** The record a capability's first send still waits on — Follow-up's is
 *  DM's — or null once one stands. */
export function pendingFirstSend(capability: CapabilityId, recorded: LiveChecks): RecordedLiveCheckCapability | null {
  if (!firstSendPending(capability, recorded)) return null;
  const check = liveCheckOf(capability);
  return check === "room_reply" || isLiveCheckCapability(check) ? check : null;
}

/** The open attempt on an account for a capability, locked. */
export async function openAttempt(
  tx: Tx,
  channelId: number,
  capability: LiveCheckCapability,
): Promise<LiveCheckRow | null> {
  const [row] = await tx
    .select()
    .from(liveChecks)
    .where(
      and(
        eq(liveChecks.channelId, channelId),
        eq(liveChecks.capability, capability),
        inArray(liveChecks.state, [...OPEN_LIVE_CHECK_STATES]),
      ),
    )
    .for("update");
  return row ?? null;
}
