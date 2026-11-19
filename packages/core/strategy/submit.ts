import { eq } from "drizzle-orm";
import { campaigns, type SearchDepth } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  markDrawnAgain,
  pendingNote,
  recordProposal,
  retireExpiredProposal,
  takeExpiredProposal,
} from "../chat/proposals";
import type { ProposalSummary } from "../chat/proposalKinds";
import { assertSearchDepth, getCampaign } from "../operations/campaigns";
import {
  AccountPolicyError,
  applyAccountPolicy,
  prepareAccountPolicy,
  readAccountPolicyState,
  type AccountPolicyApplied,
  type AccountPolicyUpdate,
  type PreparedAccountPolicy,
} from "./accountPolicy";
import {
  applyStrategyPatch,
  preparePatch,
  readPatchState,
  type PreparedPatch,
  type StrategyPatch,
  type DepthLanding,
  type NotStartedLanding,
} from "./patch";
import { patchForSwitches } from "./redirect";
import { currentSearchDepth, depthActor, readSearchDepth, settleSearchDepth } from "./searchDepth";

/**
 * A `strategy.patch` FROM ANYWHERE BUT CHAT — the owner's own agent over MCP,
 * an old writer redirected, the worker settings form. The patch classifies
 * itself, and that decides what happens now:
 *
 *   apply   — a narrowing or a style change lands at once: a new version,
 *             activated (or scheduled for its instant), with its undo named.
 *   confirm — a widening is a pending proposal, the same row chat's card is,
 *             with no conversation: nothing changes until the owner clicks
 *             (INV-26). The caller is told so in the server's own words.
 *
 * Chat never comes through here: there every patch is a card the owner spends
 * (`chat/proposals.ts`), whichever level it is.
 */

/** Said beside a widening, so no caller reports a proposal as done — and
 *  so the owner can be told exactly where it waits for them. */
export function wideningPending(campaignName: string): string {
  return `Nothing has changed. This widens what the campaign may do, so it takes effect only when the owner confirms the displayed diff in Engager — Campaigns → ${campaignName} shows that a change is waiting for their yes, and Review opens it — and it expires in 30 minutes. Do not describe it as done.`;
}

export type SubmitOutcome =
  | {
      applied: true;
      level: "apply";
      campaignId: number;
      version: number;
      /** `scheduled` until its effective instant; `draft` on a campaign not
       *  started, until its Start. */
      status: "active" | "scheduled" | "conflict" | "draft";
      effectiveAt: number | null;
      changes: Array<{ path: string; old: unknown; new: unknown }>;
      /** The diff the patch was classified on, in the card's own words — what
       *  a surface shows beside the Undo, so it never draws the diff twice. */
      summary: Pick<ProposalSummary, "title" | "rows">;
      cancelled: number[];
      undo: { tool: "undo_strategy_version"; campaignId: number; version: number };
    }
  | {
      proposed: true;
      level: "confirm";
      pendingChangeId: string;
      kind: string;
      status: "pending";
      expiresAt: number;
      summary: ProposalSummary;
      note: string;
      /** Every way it widens is a read turned on: it lets Scout read more,
       *  and nothing send that could not before. */
      readsOnly: boolean;
    };

export async function submitStrategyPatch(
  tx: Tx,
  organizationId: string,
  patch: StrategyPatch,
  options: { approver: string; now: number } & NotStartedLanding & DepthLanding & {
    /** The patch as the caller already prepared it in this transaction, with
     *  these options and no lock. */
    prepared?: PreparedPatch;
  },
): Promise<SubmitOutcome> {
  const prepared =
    options.prepared ??
    (await preparePatch(tx, patch, {
      now: options.now,
      lock: false,
      draft: options.draft,
      searchDepth: options.searchDepth,
    }));
  if (prepared.level === "confirm") {
    return drawCard(tx, organizationId, patch, options.now, prepared.state.campaign.name, prepared.readsOnly);
  }
  const applied = await applyStrategyPatch(tx, patch, options);
  return {
    applied: true,
    level: "apply",
    campaignId: applied.campaignId,
    version: applied.version,
    status: applied.activation.status,
    effectiveAt: applied.activation.status === "scheduled" ? applied.activation.effectiveAt : null,
    changes: applied.changes,
    summary: { title: prepared.title, rows: prepared.rows },
    cancelled: applied.cancelled,
    undo: { tool: "undo_strategy_version", campaignId: applied.campaignId, version: applied.version },
  };
}

/** A patch as a card with no conversation, which only the owner's click on
 *  the campaign's Changes page spends. */
async function drawCard(
  tx: Tx,
  organizationId: string,
  patch: StrategyPatch,
  now: number,
  campaignName: string,
  readsOnly = false,
): Promise<Extract<SubmitOutcome, { proposed: true }>> {
  const card = await recordProposal(tx, organizationId, patch, { sessionId: null, turnId: null }, now);
  return {
    proposed: true,
    level: "confirm",
    pendingChangeId: card.pendingChangeId,
    kind: card.kind,
    status: "pending",
    expiresAt: card.expiresAt,
    summary: card.summary,
    note: pendingNote(wideningPending(campaignName)),
    readsOnly,
  };
}

/** What became of an expired design the owner said yes to after all. */
export type RevivedDesign =
  | SubmitOutcome
  /** Another version replaced the one it was drawn against; nothing drawn.
   *  `notStarted`: what replaced it is a draft, which can take its steps. */
  | {
      moved: true;
      expectedBaseVersion: number;
      activeVersion: number;
      carriesSteps: boolean;
      notStarted: boolean;
    }
  /** Not an expired, unanswered card about this campaign — open, or spent. */
  | { gone: true };

/**
 * AN EXPIRED DESIGN, USED AFTER ALL — the owner's own press on a card that
 * expired before they answered it, which is never itself the yes the card
 * asked for:
 *
 *   as drawn  — checked against the version in force (the card's own
 *               compare-and-swap) and drawn again as a fresh card, which the
 *               owner confirms as they would any other. A version that moved
 *               since is said, and nothing is drawn.
 *   onto the draft — its ops, rebased onto the version in force. On a
 *               campaign not started they land on its draft, where nothing
 *               wakes, and its Start is still the one card that asks; on one
 *               started they are a fresh card like any other.
 *
 * Steps that landed on the draft retire the expired card at once: that press
 * was the owner's decision. A card drawn again retires it only when the
 * owner's yes to that card lands (`decidePendingChange`), so cancelling the
 * dialog leaves the design where it was, to be used again.
 */
export async function reviveExpiredDesign(
  tx: Tx,
  organizationId: string,
  input: { campaignId: number; pendingChangeId: string; onto: "as_drawn" | "the_draft" },
  options: { approver: string; now: number },
): Promise<RevivedDesign> {
  const taken = await takeExpiredProposal(tx, input.campaignId, input.pendingChangeId, options.now);
  if (!taken) return { gone: true };
  const state = await readPatchState(tx, input.campaignId, { lock: false });
  if (input.onto === "as_drawn" && state.active.version !== taken.patch.expectedBaseVersion) {
    return {
      moved: true,
      expectedBaseVersion: taken.patch.expectedBaseVersion,
      activeVersion: state.active.version,
      carriesSteps: taken.patch.ops.length > 0,
      notStarted: state.notStarted,
    };
  }
  const patch = { ...taken.patch, expectedBaseVersion: state.active.version };
  const outcome =
    input.onto === "the_draft" && state.notStarted
      ? await submitStrategyPatch(tx, organizationId, patch, { ...options, draft: true })
      : await drawCard(tx, organizationId, patch, options.now, state.campaign.name);
  if ("proposed" in outcome) await markDrawnAgain(tx, taken.id, outcome.pendingChangeId);
  else await retireExpiredProposal(tx, taken.id, options.now, { landedAs: outcome.version });
  return outcome;
}

/**
 * SETTING A CAMPAIGN'S SEARCH DEPTH — after its create, the one way any
 * surface sets it (`save_campaign`, the app). Deep IS a read of the Scout's
 * step (strategy/searchDepth.ts): Find posts' Research, or on a campaign that
 * finds leads, Find leads' Company page read. A depth that moves that read says
 * it through the patch any other switch takes (`patchForSwitches`), and the
 * patch classifies itself: on a campaign that has started, Deep is a widening
 * that waits for the owner's yes and changes nothing until then, and leaving
 * Deep a narrowing that lands at once with its undo; before the Start either
 * lands on the draft, where nothing is in force. The Quick or Standard it
 * stores lands with that patch, so the change is told once. Between Quick and
 * Standard the Deep read does not move: the column is written and nothing
 * else is, on a campaign that finds leads too, where Research is the owner's
 * own switch, On at every depth, and no depth moves it. Off its strategy a
 * campaign's Research is `verifyStage` itself, written with it.
 *
 * `alongside` is a step's own patch saved with the depth — the Find leads
 * inspector's Save (US-LME-05). Where the depth moves a read it travels in the
 * same patch: one version, one card. Where it moves none — Quick to Standard —
 * the depth is the campaign's own setting, stored at once whether or not the
 * step's patch is a card, and the version never lists it (ruling 32).
 *
 * `strategy` is the patch's outcome, null when none was drawn; `searchDepth`
 * the depth the campaign reads now. Null for a campaign that no longer stands.
 * `reportedDepth` is a create's own depth, already told (`DepthLanding`).
 */
export async function setSearchDepth(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  depth: SearchDepth,
  {
    alongside = null,
    ...options
  }: { approver: string; instruction: string; now: number; alongside?: StrategyPatch | null } & Pick<
    DepthLanding,
    "reportedDepth"
  >,
): Promise<{ searchDepth: SearchDepth; strategy: SubmitOutcome | null } | null> {
  assertSearchDepth(depth);
  const campaign = await getCampaign(tx, campaignId);
  if (!campaign) return null;
  const current = await readSearchDepth(tx, campaign);
  const stored = depth === "quick" ? "quick" : "standard";
  const store = async () => {
    await tx
      .update(campaigns)
      .set({
        searchDepth: stored,
        updatedAt: options.now,
      })
      .where(eq(campaigns.id, campaignId));
    return settleSearchDepth(tx, campaignId, options.reportedDepth ?? current, depthActor(options.approver));
  };
  const switched = await patchForSwitches(tx, campaignId, { leadDepth: depth }, options.instruction);
  if (alongside && !switched) {
    const searchDepth = await store();
    const { approver, now } = options;
    return { searchDepth, strategy: await submitStrategyPatch(tx, organizationId, alongside, { approver, now, draft: true }) };
  }
  const patch = alongside && switched ? joinedPatch(alongside, switched) : switched;
  if (patch) {
    const strategy = await submitStrategyPatch(tx, organizationId, patch, {
      ...options,
      draft: true,
      searchDepth: stored,
    });
    return { searchDepth: await currentSearchDepth(tx, campaignId), strategy };
  }
  return { searchDepth: await store(), strategy: null };
}

/**
 * A step's own patch and the reads a depth moves, as the one patch that says
 * both, against the version the step's was written on. The step's own scope
 * stays, so its ops keep the check that they sit inside the step; the depth's
 * ops sit on the Scout's own step, and its grants are the depth's: a step's
 * own edits ask for none.
 */
function joinedPatch(own: StrategyPatch, switched: StrategyPatch): StrategyPatch {
  return {
    ...own,
    ops: [...own.ops, ...switched.ops],
    ...(switched.requestedGrants ? { requestedGrants: switched.requestedGrants } : {}),
    provenance: {
      ...own.provenance,
      instruction: `${own.provenance.instruction}; ${switched.provenance.instruction}`,
      recognizedIntent: {
        summary: `${own.provenance.recognizedIntent.summary}; ${switched.provenance.recognizedIntent.summary}`.slice(0, 500),
        paths: [...new Set([...own.provenance.recognizedIntent.paths, ...switched.provenance.recognizedIntent.paths])],
      },
    },
  };
}

/** Said beside an account change that waits, for the same reason as
 *  `wideningPending`: so no caller reports it as done, and the owner is told
 *  where it waits for them. */
export const ACCOUNT_CHANGE_PENDING =
  "Nothing has changed. This lets the account do more without the owner's yes, so it takes effect only when the owner confirms it in Engager — Channels → LinkedIn shows that a change is waiting for their yes and Review opens it, and the Inbox's Changes tab lists it — and it expires in 30 minutes. Do not describe it as done.";

export type AccountPolicySubmitted =
  | ({ applied: true } & AccountPolicyApplied & Pick<PreparedAccountPolicy, "title" | "rows" | "preview">)
  | {
      proposed: true;
      level: "confirm";
      pendingChangeId: string;
      kind: string;
      expiresAt: number;
      summary: ProposalSummary;
    };

/**
 * An ACCOUNT CHANGE FROM ANYWHERE BUT CHAT — the account's own pages. Like a
 * campaign's patch outside chat (above), the change classifies itself:
 * one that only holds the account closer lands at once, and one that lets it
 * do more unattended waits as the same card chat draws, with no conversation,
 * until the owner's click (INV-26).
 *
 * `expectedVersion` is the account default the page was drawn from — null for
 * none yet — and a change drawn against one another change has replaced is
 * refused rather than landed over it.
 */
export async function submitAccountPolicy(
  tx: Tx,
  organizationId: string,
  change: AccountPolicyUpdate,
  options: { approver: string; now: number; expectedVersion: number | null },
): Promise<AccountPolicySubmitted> {
  // Under the channel's lock, so the version compared is the one written over.
  const state = await readAccountPolicyState(tx, { lock: true, now: options.now });
  if ((state.active?.version ?? null) !== options.expectedVersion) {
    throw new AccountPolicyError(
      "account_policy_conflict",
      "Another change to this account's policy landed first, so nothing was changed.",
      "Reload to see it, then try again.",
    );
  }
  const prepared = prepareAccountPolicy(state, change, options.now);
  if (prepared.level === "confirm") {
    const card = await recordProposal(
      tx,
      organizationId,
      change,
      { sessionId: null, turnId: null },
      options.now,
    );
    return {
      proposed: true,
      level: "confirm",
      pendingChangeId: card.pendingChangeId,
      kind: card.kind,
      expiresAt: card.expiresAt,
      summary: card.summary,
    };
  }
  const applied = await applyAccountPolicy(tx, change, { approver: options.approver, now: options.now });
  return {
    applied: true,
    ...applied,
    title: prepared.title,
    rows: prepared.rows,
    preview: prepared.preview,
  };
}
