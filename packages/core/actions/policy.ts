import type { RecordedLiveCheckCapability } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { readAccountDefault } from "../strategy/activate";
import {
  BUDGETED_MODE_KEYS,
  MODE_KEY_LABELS,
  NETWORK_CATALOGS,
  NO_LIVE_CHECKS,
  type BudgetedModeKey,
  type CapabilityId,
  type ModeKey,
} from "../strategy/catalog";
import { hasCeiling } from "../strategy/resolve";
import { pendingFirstSend, recordedLiveChecks } from "../liveChecks/records";
import { channelCeilings } from "../ratelimit/ledger";
import { openPauses } from "./pause";

/**
 * THE ACCOUNT'S CONVERSATION POLICY, in one read — what Channels → LinkedIn →
 * Replies summarizes for the person-to-person actions (spec §01, "extend
 * current Replies/Pacing with conversation policy").
 *
 * For each action: its ceiling — the channel's day plan for a public reply,
 * the rolling-24h budget for a new kind, whose null is what keeps a step's
 * Automatic at Ask me — and its first send. Beside them, the Stops open on
 * the account. The account keeps no mode of its own: each step's binding is
 * its action's one mode (INV-28). Read-only.
 */

/** The person-to-person actions, in the order a conversation reaches them. */
const CONVERSATION_KEYS = [
  "public_reply",
  "room_reply",
  "like_target",
  "invite",
  "accept_invite",
  "dm",
  "followup",
] as const satisfies readonly ModeKey[];

/** The capability each of them sends through. */
const CAPABILITY_OF: Record<(typeof CONVERSATION_KEYS)[number], CapabilityId> = {
  public_reply: "reply_public",
  room_reply: "reply_to_comment",
  like_target: "like_target",
  invite: "send_invitation",
  accept_invite: "accept_invitation",
  dm: "send_dm",
  followup: "followup",
};

export type ConversationPolicyRow = {
  key: (typeof CONVERSATION_KEYS)[number];
  label: string;
  /** Whether a step's Automatic stays Ask me until a number is set: a new
   *  kind's ceiling — and a DM's or a follow-up's per-person cap — unset. */
  needsNumber: boolean;
  /** The day plan's for a public reply; the rolling-24h budget, or null when
   *  none is set, for a new kind. */
  ceiling: "day_plan" | number | null;
  /** The record its first send waits on — Ask me at most on every campaign
   *  until the account confirms one — or null once one stands. */
  firstSend: RecordedLiveCheckCapability | null;
};

export type ConversationPolicy = {
  /** Whether the account has a default strategy at all. Without one no
   *  new kind can be Automatic. */
  defined: boolean;
  /** The account default's version in force — what a change from the page is
   *  drawn against — or null for none yet. */
  version: number | null;
  rows: ConversationPolicyRow[];
  /** Stops open on the account itself. */
  accountStopped: boolean;
};

function isBudgeted(key: ModeKey): key is BudgetedModeKey {
  return (BUDGETED_MODE_KEYS as readonly ModeKey[]).includes(key);
}

export async function accountConversationPolicy(tx: Tx): Promise<ConversationPolicy> {
  const channel = await channelCeilings(tx);
  const account = channel
    ? await readAccountDefault(tx, channel.id, { network: NETWORK_CATALOGS[channel.network] })
    : null;
  const document = account?.document ?? null;
  const recorded = channel ? await recordedLiveChecks(tx, channel.id) : NO_LIVE_CHECKS;
  return {
    defined: document !== null,
    version: account?.version ?? null,
    rows: CONVERSATION_KEYS.map((key) => {
      const ceiling = isBudgeted(key)
        ? (document?.budgets?.action_budgets_per_rolling_24h[key] ?? null)
        : "day_plan";
      return {
        key,
        label: MODE_KEY_LABELS[key],
        // The resolver's own rule, not a second reading of it: Automatic needs
        // the kind's ceiling — and a DM's or a follow-up's, the per-person cap.
        needsNumber: isBudgeted(key) && !hasCeiling(document, key),
        ceiling,
        firstSend: pendingFirstSend(CAPABILITY_OF[key], recorded),
      };
    }),
    accountStopped:
      channel !== null &&
      (await openPauses(tx, [{ scope: "account", scopeId: channel.id }])).length > 0,
  };
}
