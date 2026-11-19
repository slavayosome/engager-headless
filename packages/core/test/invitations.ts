import { asc, eq } from "drizzle-orm";
import {
  channels,
  incomingInvitations,
  conversationEvents,
  conversations,
  type IncomingInvitationRow,
} from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { LIVE_READ_RECORDS, type ActionMode } from "../strategy/catalog";
import type { CampaignAgentStrategy } from "../strategy/contract";
import { conversationCampaign, withActionModes } from "../strategy/strategy.fixture";
import type { IncomingInvitation, RelationshipRead } from "../linkedin/driver";
import { alwaysOpenAccountDefault, type LedgerFixture } from "./actions";
import { baseAmbassador, observe, reply } from "./conversation";
import { activateAccountDefault } from "./strategies";

/**
 * Incoming invitations over `MockDriver`: a live flagged campaign whose
 * Ambassador has a Connect step binding Accept invite (Ask me by default), on
 * an account whose default grants it and keeps its window open, with one reply
 * observed from `REPLIER` onto a conversation the way production observes one.
 */

/** The replier whose conversation an invitation is tied to, by provider id. */
export const REPLIER = "ACoAAAda";

/** The campaign's Handle a reply step, plus a Connect step binding Accept
 *  invite at `acceptMode`. */
export function withConnectStep(
  doc: CampaignAgentStrategy,
  acceptMode: ActionMode = "review",
): CampaignAgentStrategy {
  const connect = conversationCampaign().steps!.find((step) => step.step_id === "connect")!;
  return withActionModes({
    ...doc,
    steps: [
      ...doc.steps!,
      {
        ...connect,
        allowed_tools: ["read_profile", "accept_invitation"],
        action_binding_refs: ["accept_invite"],
      },
    ],
    action_bindings: [
      ...doc.action_bindings!,
      { action_binding_id: "accept_invite", owner_step_id: "connect", capability_ref: "accept_invitation" },
    ],
  }, { accept_invite: acceptMode });
}

export async function invitationAmbassador(
  opts: { acceptMode?: ActionMode } = {},
): Promise<LedgerFixture> {
  const f = await baseAmbassador((doc) => withConnectStep(doc, opts.acceptMode));
  const channelId = await withOrg(f.orgId, async (tx) => {
    const [channel] = await tx.update(channels).set({ minActionGapSec: 0 }).returning({ id: channels.id });
    await activateAccountDefault(tx, channel!.id, alwaysOpenAccountDefault());
    return channel!.id;
  });
  const theirs = reply(f, "9001", "We measure it per team, weekly.", REPLIER);
  await observe(f, [theirs]);
  const [conversation, event] = await withOrg(f.orgId, async (tx) => [
    (await tx.select().from(conversations).orderBy(asc(conversations.id)))[0]!,
    (await tx.select().from(conversationEvents).orderBy(asc(conversationEvents.id)))[0]!,
  ] as const);
  return { ...f, channelId, conversation, event, replyUrn: theirs.replyUrn };
}

/** Ship Accept invite's record (INV-31), for a suite about what follows its
 *  first acceptance. Returns the undo. */
export function recordAcceptLiveRead(): () => void {
  const before = LIVE_READ_RECORDS.accept_invitation;
  LIVE_READ_RECORDS.accept_invitation = "test";
  return () => {
    LIVE_READ_RECORDS.accept_invitation = before;
  };
}

/** One request on the invitations page. */
export function invitationFrom(
  profileId: string,
  over: Partial<IncomingInvitation> = {},
): IncomingInvitation {
  return {
    invitationId: `invitation-from:${profileId}`,
    sender: {
      profileId,
      url: `https://www.linkedin.com/in/${profileId}/`,
      displayName: `Name of ${profileId}`,
    },
    observedAt: Date.now(),
    ...over,
  };
}

/** A relationship read of `profileId` as the fake's session shows it. */
export function readOf(
  profileId: string,
  degree: RelationshipRead["degree"],
  pending: RelationshipRead["pending"],
): RelationshipRead {
  return {
    profile: {
      id: profileId,
      url: `https://www.linkedin.com/in/${profileId}/`,
      displayName: `Name of ${profileId}`,
      verified: true,
    },
    degree,
    pending,
    note: { supported: "unknown", limitChars: null },
    observedAt: Date.now(),
    sessionId: "mock",
    pageFingerprint: "mock",
    selectorPack: "mock",
  };
}

export async function invitationRows(f: Pick<LedgerFixture, "orgId">): Promise<IncomingInvitationRow[]> {
  return withOrg(f.orgId, (tx) =>
    tx.select().from(incomingInvitations).orderBy(asc(incomingInvitations.id)),
  );
}

export async function conversationRow(f: LedgerFixture) {
  const [row] = await withOrg(f.orgId, (tx) =>
    tx.select().from(conversations).where(eq(conversations.id, f.conversation.id)),
  );
  return row!;
}
