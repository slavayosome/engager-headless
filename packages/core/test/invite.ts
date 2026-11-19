import type { RelationshipReadJson } from "@engager/database/schema";
import { catalogStepTemplate } from "../strategy/addStep";
import { LIVE_READ_RECORDS } from "../strategy/catalog";
import type { CampaignAgentStrategy } from "../strategy/contract";
import { withActionModes } from "../strategy/strategy.fixture";
import { mockMember } from "../linkedin/mock";
import { alwaysOpenAccountDefault, liveAmbassador, type LedgerFixture } from "./actions";

/**
 * The invitation's fixtures: the live Ambassador of `test/actions.ts` with
 * Connect added the way Add step adds it — its entry and its barrier as they
 * ship, so a wake reaches it only as the server routes one there — with Invite
 * at Ask me, and Invite's record, shipped for a suite about what follows its
 * first send.
 */

/** Connect as it ships, after Handle a reply, with the owner's instructions. */
export function withConnect(doc: CampaignAgentStrategy): CampaignAgentStrategy {
  const connect = catalogStepTemplate("connect");
  return withActionModes(
    {
      ...doc,
      steps: [
        ...(doc.steps ?? []),
        { ...connect.step, instructions: "Mention what they said about measuring." },
      ],
      action_bindings: [...(doc.action_bindings ?? []), ...connect.bindings],
      grants: [...new Set([...doc.grants, ...connect.grants])],
    },
    { invite: "review" },
  );
}

/** A relationship read of a member it verified, 2nd degree. */
export function liveRead(over: Partial<RelationshipReadJson> = {}): RelationshipReadJson {
  return {
    profile: {
      id: "jonas-weber",
      url: "https://www.linkedin.com/in/jonas-weber/",
      displayName: "Jonas Weber",
      verified: true,
    },
    degree: "2nd",
    pending: "none",
    note: { supported: "unknown", limitChars: null },
    observedAt: 1_791_676_800_000,
    sessionId: "5f0c9a1e2b7d4c38a6e1f2d3b4c5a697",
    pageFingerprint: "0123456789abcdef",
    selectorPack: "linkedin-2026-10-11.6",
    ...over,
  };
}

/** A read of `profileId`'s own page as its data shows a stranger to invite:
 *  the member bound, as the fake binds them, their invitation switch on
 *  Connect, and a Connect that leads to their composer. */
export function connectRead(profileId: string, over: Partial<RelationshipReadJson> = {}): RelationshipReadJson {
  return liveRead({
    profile: { ...liveRead().profile, id: profileId, url: `https://www.linkedin.com/in/${profileId}/` },
    ...mockMember(profileId),
    invitation: "connect",
    connect: { composerUrl: `https://www.linkedin.com/preload/custom-invite/?vanityName=${profileId}` },
    observedAt: Date.now(),
    ...over,
  });
}

/** Ship Invite's record (INV-31), for a suite about what follows its first
 *  send. Returns the undo. */
export function recordInviteLiveChecks(): () => void {
  const before = LIVE_READ_RECORDS.send_invitation;
  LIVE_READ_RECORDS.send_invitation = "test";
  return () => {
    LIVE_READ_RECORDS.send_invitation = before;
  };
}

/** Ship Withdraw invite's record (INV-31), for a suite about what follows
 *  its first withdrawal. Returns the undo. */
export function recordWithdrawLiveCheck(): () => void {
  const before = LIVE_READ_RECORDS.withdraw_invitation;
  LIVE_READ_RECORDS.withdraw_invitation = "test";
  return () => {
    LIVE_READ_RECORDS.withdraw_invitation = before;
  };
}

/** A live Ambassador whose Connect step binds Invite at Ask me, with one
 *  observed reply on one conversation. */
export function inviteAmbassador(): Promise<LedgerFixture> {
  return liveAmbassador(alwaysOpenAccountDefault(), withConnect);
}

/** The proposal a Connect step makes for the conversation's person. */
export function inviteCall(personId: string) {
  return {
    call_id: "invite",
    tool: "send_invitation",
    version: 1,
    target: { kind: "person", ref: personId },
    inputs: [],
    cta_asset_id: null,
  };
}
