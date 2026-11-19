import { withOrg, type Tx } from "@engager/database/tenant";
import { decidePendingChange } from "../chat/proposals";
import { STRATEGY_PATCH, readPatchState, startPatchFor } from "../strategy/patch";
import { submitStrategyPatch } from "../strategy/submit";
import { UNASKED_ANSWERS, designPatch, templateContext } from "../strategy/templates";

const OWNER = "test:owner";

/**
 * The owner's Start from template on a campaign just created: the Discover
 * and draft steps on its draft, through the path the workspace takes. It is
 * still waiting for its Start afterwards. A draft that already holds its steps
 * — a Quick campaign made over MCP — has none to add.
 */
export async function designAsOwner(organizationId: string, campaignId: number): Promise<void> {
  await withOrg(organizationId, (tx) => designDraft(tx, organizationId, campaignId, Date.now()));
}

async function designDraft(tx: Tx, organizationId: string, campaignId: number, now: number): Promise<void> {
  const draft = await readPatchState(tx, campaignId, { lock: false });
  if ((draft.base.steps ?? []).length > 0) return;
  await submitStrategyPatch(
    tx,
    organizationId,
    designPatch({
      campaignId,
      expectedBaseVersion: draft.active.version,
      base: draft.base,
      template: "discover_and_draft",
      answers: UNASKED_ANSWERS,
      context: templateContext(draft),
      instruction: "Start from the discover and draft template",
    }),
    { approver: OWNER, now, draft: true },
  );
}

/**
 * What the owner does in Engager to a campaign just created: Start from
 * template, then Start campaign — the Discover and draft steps on its draft,
 * its Start drawn as a card, and the owner's yes to it, each through the path
 * the workspace takes. Afterwards it is Active, on its strategy.
 */
export async function startAsOwner(organizationId: string, campaignId: number): Promise<void> {
  const now = Date.now();
  const card = await withOrg(organizationId, async (tx) => {
    await designDraft(tx, organizationId, campaignId, now);
    const designed = await readPatchState(tx, campaignId, { lock: false });
    return submitStrategyPatch(
      tx,
      organizationId,
      startPatchFor(campaignId, designed.active.version, "Start campaign"),
      { approver: OWNER, now, draft: false },
    );
  });
  if (!("proposed" in card)) throw new Error("a Start draws a card");
  await confirmAsOwner(organizationId, campaignId, card.pendingChangeId);
}

/** The owner's yes, on the campaign's own page, to a card waiting about it. */
export async function confirmAsOwner(
  organizationId: string,
  campaignId: number,
  pendingChangeId: string,
): Promise<void> {
  const decided = await decidePendingChange(organizationId, {
    sessionId: "any",
    pendingChangeId,
    decision: "apply",
    approver: OWNER,
    expects: { kind: STRATEGY_PATCH, campaignId },
  });
  if (!decided.ok) throw new Error(`the change did not land: ${decided.message}`);
}
