import { and, desc, eq, inArray } from "drizzle-orm";
import { isAssisted } from "@engager/common/text-provenance";
import {
  actions,
  campaigns,
  conversationEvents,
  type ActionRow,
  type ActionStatus,
  type ActionTarget,
  type ConversationEventRow,
  type ConversationRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { loadStrategy, stepForEvent } from "../agentStep/select";
import { modeFor } from "../strategy/mode";
import { dmWordsHash, type DmMessage } from "../linkedin/driver";
import { dmOpenTargetFor, dmTargetFor, conversationDms, standingRefusal } from "./dm";
import { reserveAction, type ReserveOutcome } from "./ledger";
import { currentGeneration } from "./pause";

/**
 * THE INVITE NOTE AS THE FIRST MESSAGE (US-ICA-05; spec §3.17).
 *
 * An invitation sent with a note says those words to the person once. When
 * they accept, the note is meant to open the conversation: LinkedIn may carry
 * it there as the account's first message, and where it did not, Engager sends
 * it as one — a DM of purpose `invite_note`, under the DM step's own mode.
 * Either way the words reach them once: the key admits one note per
 * conversation (`actions/keys.ts`), and the send's own preflight finds a note
 * the conversation already holds.
 *
 * Nothing here is a model's output. The note is sent as written, so it is
 * never drafted, redrafted or redone on its own; whether the words are the
 * owner's (`origin`) is the invitation's own. A note the owner wrote counts
 * as theirs and is only spaced, one a worker wrote is unattended work and
 * binds to the caps (INV-1). Words the owner's agent offered and they sent
 * as they were are the agent's, whoever pressed: they wait for a yes and
 * never go Automatic (`assist` on the invitation).
 *
 * Spec §3.17 — the owner's note becomes the first DM when they accept — is
 * why this path does not ask the DM step's `outgoing_acceptance` policy
 * (R05): that policy keeps an acceptance quiet until interest shows, and an
 * invitation the owner wrote a note for is already an opener they chose.
 */

/** What the acceptance queues (`conversations/record.ts`): one read of the
 *  conversation for the note, keyed on the invitation's own action. */
export type InviteNoteCheckPayload = {
  conversationId: number;
  inviteActionId: number;
  /** The `invitation_accepted` event the DM step would answer, which the
   *  note's DM cites as its evidence. */
  acceptedEventId: number;
};

/** How long a check that cannot read the conversation tries again — hourly,
 *  once, for the day — before it gives up and says so. */
export const INVITE_NOTE_WINDOW_MS = 24 * 60 * 60_000;

/** The note DM's rows that wait for a yes or a slot, and the ones that went
 *  or may have. Every other row of the purpose ended without a message. */
const WAITING: readonly ActionStatus[] = ["reserved", "awaiting_review", "approved"];
const SENT: readonly ActionStatus[] = ["dispatching", "uncertain", "confirmed"];

/** The conversation's newest invitation of ours that went out. */
export async function conversationInvite(tx: Tx, conversationId: number): Promise<ActionRow | null> {
  const [invite] = await tx
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversationId),
        eq(actions.kind, "invite"),
        eq(actions.status, "confirmed"),
      ),
    )
    .orderBy(desc(actions.id))
    .limit(1);
  return invite ?? null;
}

/** The words an invitation was sent with; null for none. */
export function noteOf(invite: Pick<ActionRow, "candidate">): string | null {
  return invite.candidate.text?.trim() || null;
}

/** The account's own message in a read of the conversation that says the
 *  note's words, if it holds one. */
export function noteSpoken(messages: readonly DmMessage[], note: string): DmMessage | undefined {
  const hash = dmWordsHash(note);
  return messages.find((message) => message.fromSelf && message.textHash === hash);
}

/** The same for an invitation that may have gone with no note: none is there
 *  to find. */
export function noteSpokenIn(
  messages: readonly DmMessage[],
  invite: Pick<ActionRow, "candidate">,
): DmMessage | undefined {
  const note = noteOf(invite);
  return note === null ? undefined : noteSpoken(messages, note);
}

/** Where the note of the conversation's invitation stands. */
export type NoteStanding =
  | { kind: "none" }
  | { kind: "carried"; invite: ActionRow; event: ConversationEventRow }
  | { kind: "sent"; invite: ActionRow; action: ActionRow }
  | { kind: "waiting"; invite: ActionRow; action: ActionRow }
  | { kind: "open"; invite: ActionRow };

/**
 * Whether the conversation's invitation has a note that is the conversation's
 * first message already — carried by LinkedIn, or its DM sent or going out —
 * one waiting to be sent, or neither. `none` where we sent no invitation: an
 * acceptance of theirs, or no invitation at all.
 */
export async function noteStanding(tx: Tx, conversationId: number): Promise<NoteStanding> {
  const invite = await conversationInvite(tx, conversationId);
  if (!invite) return { kind: "none" };
  const [carried] = await tx
    .select()
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, "invite_note_carried")))
    .orderBy(desc(conversationEvents.id))
    .limit(1);
  if (carried) return { kind: "carried", invite, event: carried };
  const dms = await tx
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversationId),
        eq(actions.kind, "dm"),
        eq(actions.purpose, "invite_note"),
        inArray(actions.status, [...WAITING, ...SENT]),
      ),
    )
    .orderBy(desc(actions.id));
  const sent = dms.find((action) => SENT.includes(action.status));
  if (sent) return { kind: "sent", invite, action: sent };
  const waiting = dms.find((action) => WAITING.includes(action.status));
  return waiting ? { kind: "waiting", invite, action: waiting } : { kind: "open", invite };
}

/**
 * Reserve the invitation's note as the first DM to the person who accepted —
 * the candidate, never the send. The DM step's own mode decides it, resolved
 * as every DM's is: Off reserves nothing, Ask me waits for the owner's yes,
 * Automatic is reserved and paced by the gate inside the caps, and is only
 * Ask me until a DM has been verified on the account (`firstSendPending`, in
 * the resolution). It goes into the conversation a read has bound; with none,
 * only a note the owner wrote may open one (`dmOpenTargetFor`) — a worker's
 * words never do. The ledger's one door (`reserveAction`) then re-reads the
 * conversation, every Stop and the person's exclusion, and the person's cap counts
 * the DM and refuses an unattended one at it (`standingRefusal`).
 *
 * The mode is read from the documents alone, without the clock: whether the
 * account's window is open is the gate's hold, not a reason to forget a note.
 * An agent's offer the owner sent untouched waits for the owner's yes under
 * any mode, so only words the owner wrote open a conversation unattended.
 */
export async function reserveInviteNote(
  tx: Tx,
  input: { conversation: ConversationRow; invite: ActionRow; note: string; accepted: ConversationEventRow; now: number },
): Promise<ReserveOutcome> {
  const { conversation, invite, note, accepted, now } = input;
  if (conversation.owningCampaignId === null) return { status: "refused", reason: "no_dm_step" };
  const [campaign] = await tx
    .select({ id: campaigns.id, channelId: campaigns.channelId, status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, conversation.owningCampaignId));
  if (!campaign) return { status: "refused", reason: "no_dm_step" };
  if (campaign.status === "archived") return { status: "refused", reason: "campaign_archived" };
  const strategy = await loadStrategy(tx, campaign);
  const step = strategy && stepForEvent(strategy.document, "invitation_accepted");
  if (!strategy || !step) return { status: "refused", reason: "no_dm_step" };
  const dm = await modeFor(tx, { campaignId: campaign.id, capability: "send_dm", stepId: step.step_id });
  if (!dm || dm.effective === null || dm.effective === "off") return { status: "refused", reason: "dm_step_off" };

  const dms = await conversationDms(tx, conversation.id);
  const owner = invite.origin === "owner";
  const agentWords = isAssisted(invite.candidate.assist?.assistRetention, invite.candidate.assist?.ownerOrigin);
  const standing = await standingRefusal(tx, conversation, dms, now, { owner });
  let target: ActionTarget;
  if ("thread" in standing) {
    target = dmTargetFor(standing.thread, conversation.authorProfileId);
  } else if (standing.reason === "no_thread" && conversation.canonicalDmThreadId === null && conversation.relationship === "connected") {
    // A worker's words never open a conversation: only the owner's press does.
    if (!owner) return { status: "refused", reason: "opener_owner_only" };
    target = dmOpenTargetFor(conversation.authorProfileId);
  } else {
    return { status: "refused", reason: standing.reason };
  }
  return reserveAction(tx, {
    channelId: conversation.channelId,
    campaignId: campaign.id,
    conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId,
    stepRunId: null,
    actionBindingId: dm.action_binding_id,
    kind: "dm",
    purpose: "invite_note",
    sequence: 1,
    target,
    candidate: {
      text: note,
      ...(invite.candidate.assist ? { assist: invite.candidate.assist } : {}),
      sources: [{ eventId: accepted.id, contentHash: accepted.contentHash }],
      versions: { strategy: strategy.version, facts: [], memory: null, voice: null },
    },
    origin: invite.origin,
    // Automatic only on a campaign that runs, and only for words the owner
    // wrote: on a paused one, or for an agent's offer sent as it was, the note
    // waits for the owner's yes like any other.
    mode: dm.effective === "auto" && campaign.status === "active" && !agentWords ? "auto" : "review",
    generationSeen: await currentGeneration(tx),
    now,
  });
}
