import { and, desc, eq } from "drizzle-orm";
import {
  actions,
  channels,
  messages,
  type ActionKind,
  type ActionRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueueActionDispatch } from "../actions/drain";
import { isMessageSend } from "../actions/keys";
import { EXECUTION_LEASE_MS } from "../execution/authority";
import { settleAction } from "../execution/actionGate";
import { DEFAULT_NETWORK, networkFor } from "../network/registry";

/**
 * The one place an uncertain send is settled, whatever it was: a comment, a
 * reply or a room reply (a message), or a like, DM, invitation, acceptance or
 * withdrawal (an action) — all of them sent by the action ledger.
 *
 * It rests on what the owner saw and nothing else. It presses nothing, reads
 * nothing from LinkedIn and is never run on a timeout or a guess: the surface
 * that calls it is the owner's own word, or an agent relaying it.
 *
 * - `went_out` settles the item as posted and confirmed, once: the rate-limit
 *   ledger counts it toward the caps and the sidecar's journal entry is closed.
 * - `not_sent` re-arms both ledgers and releases the account. The item goes
 *   back to waiting for a deliberate yes; it never queues itself again.
 *
 * The item's status (and, for a message, its request version) is the
 * compare-and-set, so of two resolutions at once one wins and the other is
 * refused with what the item is now.
 */

export type OutcomeObserved = "went_out" | "not_sent";

/** `by` of a resolution that is not the owner's word: the write itself was
 *  SEEN on LinkedIn (its urn or receipt found). Only `went_out` can rest on it;
 *  an absence, however long, never says `not_sent`. */
export const EVIDENCE = "evidence";

export type OutcomeInput = {
  ref: { kind: "msg" | "act"; id: number };
  observed: OutcomeObserved;
  /** What the owner looked at: the urn a comment went out as, or, for an
   *  action relayed by an agent, the exact target it was shown. */
  urn?: string;
  /** Who said so: `owner:…`, or {@link EVIDENCE}. */
  by: string;
  /** An agent relaying the owner, not the owner's own surface. */
  viaAgent?: boolean;
  /** The request version the caller saw on a message. Absent, the current one. */
  version?: number;
  /** What the read that saw the write found, for an action settled on evidence. */
  proof?: { evidence: Record<string, unknown>; noop?: true };
};

export type OutcomeRefusal =
  | "not_found"
  | "not_uncertain"
  | "stale_state"
  | "urn_required"
  | "target_mismatch"
  | "owner_required"
  /** The update left the old operation's press possibly still running. */
  | "in_flight";

export type OutcomeResult =
  | { ok: true; status: string }
  | { ok: false; reason: OutcomeRefusal; detail: string; currentStatus?: string; currentVersion?: number };

const refusal = (
  reason: OutcomeRefusal,
  detail: string,
  current?: { status: string; version?: number },
): OutcomeResult => ({
  ok: false,
  reason,
  detail,
  ...(current ? { currentStatus: current.status, currentVersion: current.version } : {}),
});

export async function resolveOutcome(tx: Tx, input: OutcomeInput): Promise<OutcomeResult> {
  return input.ref.kind === "act" ? resolveAction(tx, input) : resolveMessage(tx, input);
}

/** The kinds that keep an entry in the sidecar's write journal. */
const JOURNALED: readonly ActionKind[] = ["dm", "followup", "invite", "accept_invite", "withdraw_invite", "room_reply", "reply", "comment"];

/** What a comment or reply that went out is named by: the comment urn LinkedIn shows. */
const COMMENT_URN = networkFor(DEFAULT_NETWORK).externalUrnPattern;

/** The `status_reason` of an uncertain action whose owner has answered and
 *  whose journal has not yet taken the answer. Its fence stays until it has. */
const ANSWERED = "owner_answered:";

/** `folded` is an answer an update took from the old resolver's queue: the
 *  message already shows it, so only the journal is left to close, on the
 *  request `version` the old resolution was frozen at. */
export type OwnerAnswer = { observed: OutcomeObserved; by: string; target?: string; folded?: true; version?: number };

/** The operation id a send fenced under before comments, replies and room
 *  replies were actions (`post:<message>:<version>`). */
const LEGACY_FENCE = "post:";

/** The owner's answer an uncertain action is waiting to hand its journal. */
export function ownerAnswerOf(row: Pick<ActionRow, "statusReason" | "externalReceipt">): OwnerAnswer | null {
  if (!row.statusReason?.startsWith(ANSWERED)) return null;
  const answer = row.externalReceipt?.ownerAnswer;
  return answer ? (answer as OwnerAnswer) : null;
}

/** An uncertain action settled on an answer: the owner's word, or a read that
 *  saw the write. The account is free again, so whatever was approved behind
 *  it goes through the gate next. */
export async function settleAnswered(
  tx: Tx,
  row: ActionRow,
  answer: OwnerAnswer | { observed: "went_out"; by: typeof EVIDENCE; proof: NonNullable<OutcomeInput["proof"]> },
  now: number,
): Promise<ActionRow> {
  const target = "target" in answer ? answer.target : undefined;
  const proof = "proof" in answer ? answer.proof : undefined;
  const settled = await settleAction(tx, {
    id: row.id,
    operationId: row.fenceToken!,
    receipt: {
      status: answer.observed === "went_out" ? "confirmed" : "definitely_not_sent",
      ...(proof?.noop ? { noop: true as const } : {}),
      evidence: {
        resolvedBy: answer.by,
        ...(proof ? proof.evidence : target ? { observedTarget: target } : { ownerAttested: answer.by }),
        ...("folded" in answer && answer.folded ? { folded: true } : {}),
      },
    },
    settledBy: proof ? "reconcile" : "owner",
    now,
  });
  await enqueueActionDispatch(tx, row.channelId, now);
  return settled ?? row;
}

/** Whether the press an update found in flight may still be running: the old
 *  process holds the account's lease, or its posting marker is still inside the
 *  lease it was taken under. */
async function pressMayBeLive(tx: Tx, row: ActionRow, now: number): Promise<boolean> {
  if (!row.fenceToken?.startsWith(LEGACY_FENCE)) return false;
  const [held] = await tx.select({ holder: channels.executionHolder, until: channels.executionLeaseUntil })
    .from(channels).where(eq(channels.id, row.channelId));
  const startedAt = row.attempts.at(-1)?.startedAt ?? row.submittedAt ?? 0;
  return (held?.holder === row.fenceToken && (held.until ?? 0) > now) || startedAt + EXECUTION_LEASE_MS > now;
}

async function resolveAction(tx: Tx, input: OutcomeInput, viaMessage = false): Promise<OutcomeResult> {
  const { id } = input.ref;
  // An agent cannot say an action did NOT go out: that answer lets the same
  // action be proposed again (INV-10), so only the owner's own surface mints
  // it. A message's is the owner's word relayed, observed and version-checked.
  if (input.viaAgent && !viaMessage && input.observed !== "went_out") {
    return refusal("owner_required", `Only the owner, in Engager, can mark action ${id} as not sent.`);
  }
  if (input.by === EVIDENCE && input.observed !== "went_out") {
    throw new Error("A read settles an uncertain send only as sent; an absence is the owner's to say.");
  }
  const now = Date.now();
  const [row] = await tx.select().from(actions).where(eq(actions.id, id)).for("update");
  if (!row) return refusal("not_found", `Action ${id} not found in this organization.`);
  if (row.status !== "uncertain" || row.fenceToken === null || ownerAnswerOf(row) !== null) {
    return refusal(
      "not_uncertain",
      `Action ${id} is ${row.status}${row.status === "uncertain" ? " and already answered" : ""}; only an uncertain send takes the owner's resolution.`,
      { status: row.status, version: row.updatedAt },
    );
  }
  if (await pressMayBeLive(tx, row, now)) {
    return refusal("in_flight", `Action ${id} was sent before an update and may still be going out; answer once it has had its ${EXECUTION_LEASE_MS / 1000} seconds.`);
  }
  const target = input.urn?.trim();
  if (input.viaAgent && !(viaMessage && input.observed === "not_sent")) {
    // What an agent says went out must be this action's own target — for a
    // reply, the comment it became, which only the urn's shape can vouch for.
    const own = isMessageSend(row.kind) ? target : (row.target.urn ?? row.target.id);
    if (!target) return refusal("urn_required", "Name the exact target the owner looked at in target.");
    if (target !== own) return refusal("target_mismatch", `The observed target is not action ${id}'s (${own}).`);
  }
  const answer = { observed: input.observed, by: input.by, ...(target ? { target } : {}) };
  if (input.proof) {
    const settled = await settleAnswered(tx, row, { observed: "went_out", by: EVIDENCE, proof: input.proof }, now);
    return { ok: true, status: settled.status };
  }
  if (!JOURNALED.includes(row.kind)) {
    const settled = await settleAnswered(tx, row, answer, now);
    return { ok: true, status: settled.status };
  }
  // The sidecar's journal entry for the attempt is closed on the same answer
  // before the account's fence is let go (`reconcileActions`): a fence that
  // went first would free the account while the journal still holds the
  // attempt open.
  await tx
    .update(actions)
    .set({
      statusReason: `${ANSWERED}${input.observed}`,
      externalReceipt: { ...row.externalReceipt, ownerAnswer: answer },
      updatedAt: now,
    })
    .where(eq(actions.id, id));
  await enqueueActionDispatch(tx, row.channelId, now);
  return { ok: true, status: row.status };
}

async function resolveMessage(tx: Tx, input: OutcomeInput): Promise<OutcomeResult> {
  const { id } = input.ref;
  const [message] = await tx.select().from(messages).where(eq(messages.id, id)).for("update");
  if (!message) return refusal("not_found", "Message not found.");

  const urn = input.urn?.trim();
  // A message sends as an action: its uncertain send is answered there.
  const [action] = await tx.select({ id: actions.id, status: actions.status }).from(actions)
    .where(and(eq(actions.messageId, id), eq(actions.kind, message.kind)))
    .orderBy(desc(actions.id)).limit(1);
  if (!action) return refusal("not_found", "That message has no send to resolve.");
  // An answer to an earlier attempt is not one to this.
  if (action.status === "uncertain" && input.version !== undefined && input.version !== message.redraftRequestVersion) {
    return refusal("stale_state", "It changed since you read it, so nothing was changed.", { status: message.status, version: message.redraftRequestVersion });
  }
  if (input.observed === "went_out" && (!urn || !COMMENT_URN.test(urn))) {
    return refusal("urn_required", "A comment that went out needs the observed urn (urn:li:comment:… or urn:li:activity:…).");
  }
  return resolveAction(tx, { ...input, ref: { kind: "act", id: action.id } }, true);
}
