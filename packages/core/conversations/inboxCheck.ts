import { and, desc, eq } from "drizzle-orm";
import { inboxReads, type Campaign, type Channel } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { openPauses } from "../actions/pause";
import { enqueue } from "../jobs/queue";
import { CONNECTOR_DECLARATIONS } from "../connector/capabilities";
import { pacedRunDueAt } from "../pacing";
import { getSystemState } from "../ratelimit/killswitch";
import { channelCeilings } from "../ratelimit/ledger";
import { withinActiveWindow } from "../time";
import { inboxCheckKind, inboxReadable, inboxReadingCampaigns } from "./inbox";

/**
 * THE ACCOUNT'S LIGHT INBOX CHECK — the question both its job
 * (`jobs/handlers/inboxCheck.ts`) and the Channel's overview ask: may the
 * account's inbox be read now, and if not, why not.
 *
 * A DM used to be seen only when an Ambassador wake happened to read the
 * inbox, and those wake on the comment day plan, so a message could wait
 * hours unseen. The check reads it on the account's own cadence ("Check
 * messages every", jittered ±30%), and only while all of this holds:
 *
 *   - an active campaign on it hires its Ambassador to Connect or to Continue
 *     in DMs, and its connector reads direct messages — otherwise nothing
 *     reads the owner's messages at all, and the check is off;
 *   - nothing stops the account — the kill switch, a connector's backoff
 *     pause, the owner's Stop on it — nor every one of those campaigns;
 *   - the account's active window is open: a check never reads outside it.
 *
 * The campaign it reads for is the oldest one that may; which one only
 * attributes the read, since a message it records wakes the campaign that
 * owns its conversation.
 */
export type InboxCheckGate =
  | { kind: "off"; reason: "no_channel" | "no_dm_step" | "unsupported" }
  | { kind: "stopped"; channel: Channel; reason: "kill_switch" | "paused" | "stopped" }
  | { kind: "closed"; channel: Channel; nextOpen: number }
  | { kind: "open"; channel: Channel; campaign: Campaign };

export async function inboxCheckGate(tx: Tx, now: number): Promise<InboxCheckGate> {
  const channel = await channelCeilings(tx);
  if (!channel) return { kind: "off", reason: "no_channel" };
  const readers = await inboxReadingCampaigns(tx, channel.id);
  if (readers.length === 0) return { kind: "off", reason: "no_dm_step" };
  if (!CONNECTOR_DECLARATIONS[channel.connector].dm_read) {
    return { kind: "off", reason: "unsupported" };
  }
  const system = await getSystemState(tx);
  if (system?.killSwitch) return { kind: "stopped", channel, reason: "kill_switch" };
  if (system?.pausedUntil != null && system.pausedUntil > now) {
    return { kind: "stopped", channel, reason: "paused" };
  }
  if ((await openPauses(tx, [{ scope: "account", scopeId: channel.id }])).length > 0) {
    return { kind: "stopped", channel, reason: "stopped" };
  }
  let campaign: Campaign | null = null;
  for (const reader of readers) {
    if (await inboxReadable(tx, reader)) {
      campaign = reader;
      break;
    }
  }
  if (!campaign) return { kind: "stopped", channel, reason: "stopped" };
  const window = withinActiveWindow(now, channel.activeHours, channel.activeDays);
  if (!window.within) return { kind: "closed", channel, nextOpen: window.nextOpen };
  return { kind: "open", channel, campaign };
}

/** Why the owner's Check LinkedIn now reads nothing: the account's stops, or
 *  no campaign on it reading messages. */
export type ConversationSyncRefusal = Extract<InboxCheckGate, { kind: "off" | "stopped" }>["reason"];

/**
 * The owner's Check LinkedIn now on one conversation: the inbox check's job,
 * for that conversation alone (`syncConversation`), now — or when the
 * account's active hours next open, since a check never reads outside them.
 * Pressed again within the minute, it is the one job. Returns when it reads,
 * or why it will not.
 */
export async function requestConversationSync(
  tx: Tx,
  conversationId: number,
  now: number,
): Promise<{ at: number } | { refused: ConversationSyncRefusal }> {
  const gate = await inboxCheckGate(tx, now);
  if (gate.kind === "off" || gate.kind === "stopped") return { refused: gate.reason };
  const at = gate.kind === "closed" ? gate.nextOpen : now;
  await enqueue(tx, {
    type: "inbox_check",
    payload: { conversationId },
    nextRunAt: at,
    idempotencyKey: `inbox_check:conversation:${conversationId}:${Math.floor(now / 60_000)}`,
  });
  return { at };
}

/** What the Channel's overview says about the check: when the inbox was last
 *  read, and roughly when the check reads it next — null when nothing will
 *  until a stop lifts. */
export type InboxCheckSchedule = {
  lastCheckedAt: number | null;
  nextAt: number | null;
};

/** The overview's line, or null while no campaign reads the inbox. */
export async function inboxCheckSchedule(
  tx: Tx,
  now: number,
): Promise<InboxCheckSchedule | null> {
  const gate = await inboxCheckGate(tx, now);
  if (gate.kind === "off") return null;
  const { channel } = gate;
  const [last] = await tx
    .select({ at: inboxReads.finishedAt })
    .from(inboxReads)
    .where(and(eq(inboxReads.channelId, channel.id), eq(inboxReads.outcome, "read")))
    .orderBy(desc(inboxReads.finishedAt))
    .limit(1);
  const lastCheckedAt = last?.at ?? null;
  if (gate.kind === "stopped") return { lastCheckedAt, nextAt: null };
  // A due time already past is the next five-minute tick's; one that falls
  // in a shut window waits for it to open.
  const due = Math.max((await pacedRunDueAt(tx, inboxCheckKind(channel.id))) ?? now, now);
  return {
    lastCheckedAt,
    nextAt: gate.kind === "closed" ? Math.max(due, gate.nextOpen) : due,
  };
}
