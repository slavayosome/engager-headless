import { asc, eq } from "drizzle-orm";
import {
  actions,
  workerRuns,
  campaignStrategies,
  campaigns,
  channels,
  conversationEvents,
  conversations,
  type ActionRow,
  type Campaign,
  type ConversationEventRow,
  type ConversationRow,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { reserveAction, type ReserveInput } from "../actions/ledger";
import { likeTargetFor, type LikeConversation } from "../actions/likeTarget";
import { currentGeneration, scopeRef, stopScope } from "../actions/pause";
import { loadStrategy, planConversation, type ConversationItem } from "../agentStep/select";
import { emptyTally, runConversationWake } from "../agentStep/wake";
import type { CampaignAgentStrategy } from "../strategy/contract";
import { conversationCampaign, section14AccountDefault, withActionModes } from "../strategy/strategy.fixture";
import type { ActionOperation } from "../execution/actionGate";
import type { MockDriver } from "../linkedin/mock";
import { setKillSwitch } from "../ratelimit/killswitch";
import { withEntryBoundary } from "./boundary";
import { baseAmbassador, observe, reply, type Fixture } from "./conversation";
import { activateAccountDefault } from "./strategies";
import type { FakeLLM } from "./fakes";

/**
 * The action ledger's fixtures: a campaign whose Like reply resolves Ask me, on an account whose
 * default strategy grants the like and keeps its window open all week; one
 * reply observed onto a conversation the way production observes one; and a Like
 * operation over `MockDriver` for the gate to click, whose confirmation is a
 * re-read of the fake's like state and never the click (INV-31).
 */

/** The §14 account default with a window open every hour of every day, so
 *  the gate's window hold never decides a case it is not about. */
export function alwaysOpenAccountDefault(): CampaignAgentStrategy {
  const base = section14AccountDefault();
  return {
    ...base,
    version: 1,
    previous_version: null,
    schedule: {
      ...base.schedule!,
      timezone: "UTC",
      allowed_windows: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start_local: "00:00", end_local: "24:00" }],
    },
  };
}

export type LedgerFixture = Fixture & {
  channelId: number;
  conversation: ConversationRow;
  event: ConversationEventRow;
  replyUrn: string;
};

/** A live Ambassador with one observed reply on one conversation. `edit` changes
 *  its strategy before it is activated. */
export async function liveAmbassador(
  accountDefault: CampaignAgentStrategy | null = alwaysOpenAccountDefault(),
  edit: (doc: CampaignAgentStrategy) => CampaignAgentStrategy = (doc) => doc,
  replyText = "We measure it per team, weekly.",
): Promise<LedgerFixture> {
  const f = await baseAmbassador(edit);
  const channelId = await withOrg(f.orgId, async (tx) => {
    // No min-action gap: a case about spacing sets one itself, and every
    // other case clicks twice within the second.
    const [channel] = await tx
      .update(channels)
      .set({ minActionGapSec: 0 })
      .returning({ id: channels.id });
    if (accountDefault) await activateAccountDefault(tx, channel!.id, accountDefault);
    return channel!.id;
  });
  const theirs = reply(f, "9001", replyText);
  await observe(f, [theirs]);
  const [conversation, event] = await withOrg(f.orgId, async (tx) => [
    (await tx.select().from(conversations).orderBy(asc(conversations.id)))[0]!,
    (await tx.select().from(conversationEvents).orderBy(asc(conversationEvents.id)))[0]!,
  ] as const);
  return { ...f, channelId, conversation, event, replyUrn: theirs.replyUrn };
}

/** The conversation a Like reply in the fixture is aimed in. */
export function fixtureConversation(f: LedgerFixture): LikeConversation {
  return {
    postUrn: f.post,
    reply: { urn: f.replyUrn, authorProfileId: f.conversation.authorProfileId, textHash: f.event.contentHash },
    repliedTo: f.ours,
  };
}

/** The Like reply the Handle a reply step binds, as a wake would reserve it. */
export function likeInput(f: LedgerFixture, over: Partial<ReserveInput> = {}): Omit<ReserveInput, "generationSeen"> {
  return {
    channelId: f.channelId,
    campaignId: f.campaignId,
    conversationId: f.conversation.id,
    authorProfileId: f.conversation.authorProfileId,
    actionBindingId: "like_reply",
    kind: "like_target",
    purpose: "reaction",
    target: likeTargetFor("their_reply", fixtureConversation(f))!,
    candidate: {
      text: null,
      sources: [{ eventId: f.event.id, contentHash: f.event.contentHash }],
      versions: { strategy: 2, facts: [], memory: null, voice: null },
    },
    mode: "review",
    ...over,
  };
}

/** Reserve through the one door, under the org's generation now. */
export async function reserve(
  f: LedgerFixture,
  input: Omit<ReserveInput, "generationSeen"> & { generationSeen?: number } = likeInput(f),
): Promise<ActionRow> {
  return withOrg(f.orgId, async (tx) => {
    const outcome = await reserveAction(tx, {
      ...input,
      generationSeen: input.generationSeen ?? (await currentGeneration(tx)),
    });
    if (outcome.status === "refused") throw new Error(`reservation refused: ${outcome.reason}`);
    return outcome.action;
  });
}

/**
 * One conversation wake over the fixture's reply, with the plan the server
 * would freeze, driven through `runConversationWake` itself rather than the
 * worker run — so a case can name the work key, and replay one the worker run
 * would never freeze twice. The run row it opens is closed after, as the
 * worker run would — one running run per account.
 */
export async function wakeOnce(f: LedgerFixture, llm: FakeLLM, workKey: string, stepId = "handle_reply") {
  const item: ConversationItem = {
    origin: "event",
    conversationId: f.conversation.id,
    eventId: f.event.id,
    stepId,
    workKey,
  };
  return wakeOver(f, llm, () => [item]);
}

/** One conversation wake over the plan the server itself freezes for the
 *  fixture's campaign (`planConversation`): which step each conversation enters
 *  is the server's choice, never the case's. */
export async function wakePlanned(f: LedgerFixture, llm: FakeLLM) {
  let items: ConversationItem[] = [];
  const tally = await wakeOver(f, llm, async (tx, campaign) => {
    const plan = await planConversation(tx, campaign);
    if (plan.kind !== "plan") throw new Error(`no conversation plan: ${plan.note}`);
    items = plan.items;
    return items;
  });
  return { items, tally };
}

async function wakeOver(
  f: LedgerFixture,
  llm: FakeLLM,
  itemsFor: (tx: Tx, campaign: Campaign) => ConversationItem[] | Promise<ConversationItem[]>,
) {
  const { campaign, strategy, runId, items } = await withOrg(f.orgId, async (tx) => {
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, f.campaignId));
    const [run] = await tx
      .insert(workerRuns)
      .values({
        workerId: f.ambassadorId,
        campaignId: f.campaignId,
        channelId: f.channelId,
        trigger: "event",
        status: "running",
        phase: "converse",
        startedAt: Date.now(),
      })
      .returning();
    return {
      campaign: campaign!,
      strategy: (await loadStrategy(tx, campaign!))!,
      runId: run!.id,
      items: await itemsFor(tx, campaign!),
    };
  });
  const tally = emptyTally();
  await withEntryBoundary(
    () =>
      runConversationWake(
        { kind: "plan", strategy, items, generation: 0 },
        {
          organizationId: f.orgId,
          runId,
          campaign,
          llm,
          now: Date.now(),
          continueRun: async () => true,
          generationSeen: 0,
        },
        tally,
      ),
    { organizationId: f.orgId },
  );
  await withOrg(f.orgId, (tx) =>
    tx
      .update(workerRuns)
      .set({ status: "succeeded", finishedAt: Date.now() })
      .where(eq(workerRuns.id, runId)),
  );
  return tally;
}

export async function actionRow(f: Pick<Fixture, "orgId">, id: number): Promise<ActionRow> {
  const [row] = await withOrg(f.orgId, (tx) =>
    tx.select().from(actions).where(eq(actions.id, id)),
  );
  return row!;
}

export const actionRows = (orgId: string) => withOrg(orgId, (tx) => tx.select().from(actions).orderBy(actions.id));

/** The channel's window open every hour of every day, with any other column a case sets. */
export const openHours = (orgId: string, over: Partial<typeof channels.$inferInsert> = {}) =>
  withOrg(orgId, (tx) => tx.update(channels).set({ activeHours: { start: "00:00", end: "23:59", tz: "UTC" }, activeDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], ...over }));

/** The ways every send is stopped at once: the account's kill switch, the owner's Stop on one campaign, or on the account (Pause LinkedIn). */
export type SendGuard = "kill switch" | "campaign Stop" | "account Stop";
export async function tripGuard(tx: Tx, guard: SendGuard, campaignId: number): Promise<void> {
  if (guard === "kill switch") await setKillSwitch(tx, true);
  else if (guard === "account Stop") await stopScope(tx, { ...(await scopeRef(tx, "account", undefined)), by: "owner:test" });
  else await stopScope(tx, { scope: "campaign", scopeId: campaignId, by: "owner:test", reason: "stop" });
}

/** One action of each kind the gate dispatches besides a comment, in `status` on the fixture's reply: their ids. */
export async function insertGatedKinds(tx: Tx, f: LedgerFixture, status: ActionRow["status"]): Promise<number[]> {
  const kinds = ["like_target", "invite", "accept_invite", "dm", "followup", "withdraw_invite"] as const;
  const rows = await tx.insert(actions).values(kinds.map((kind) => ({ ...likeInput(f), kind, idempotencyKey: `${status}:${kind}`, contentHash: "fixture", generationSeen: 0, status }))).returning();
  return rows.map((row) => row.id);
}

/**
 * Like reply over the fake driver: preflight proceeds, the click is
 * `likeComment`, and both the click's answer and a reconciliation are the
 * fake's like state re-read. `calls` counts every method, so a case can
 * assert that a reconciliation never clicked.
 */
export function likeOperation(driver: MockDriver, postUrn: string) {
  const calls = { preflight: 0, perform: 0, reconcile: 0 };
  const liked = (row: ActionRow) =>
    driver.likedComments.some((like) => like.commentUrn === row.target.urn);
  const operation = (): ActionOperation => ({
    async preflight() {
      calls.preflight += 1;
      return { proceed: true };
    },
    async perform(row) {
      calls.perform += 1;
      const clicked = await driver.likeComment(postUrn, row.target.urn!);
      return liked(row)
        ? { status: "confirmed", evidence: { reread: "liked", externalUrn: clicked.externalUrn ?? null } }
        : { status: "definitely_not_sent", evidence: { reread: "not_liked", error: clicked.error ?? null } };
    },
    async reconcile(row) {
      calls.reconcile += 1;
      return liked(row)
        ? { status: "confirmed", evidence: { reread: "liked" } }
        : { status: "definitely_not_sent", evidence: { reread: "not_liked" } };
    },
  });
  return { calls, operations: { like_target: operation } };
}

/**
 * Let a bare fixture campaign (one with no strategy, which reads as Off) like
 * on its own: Like post and Like reply at `mode`, on an account whose default
 * sets a like ceiling, which Automatic needs. What the suites about a like the
 * agent decides call before they reach for one.
 */
export async function setLikeModes(
  tx: Tx,
  campaignId: number,
  mode: "off" | "review" | "auto" = "auto",
  ceiling = 100,
  /** Modes for the comment too, which the account then grants. */
  also: Parameters<typeof withActionModes>[1] = {},
): Promise<void> {
  const [channel] = await tx.select({ id: channels.id }).from(channels);
  const account = alwaysOpenAccountDefault();
  account.budgets!.action_budgets_per_rolling_24h.like_target = ceiling;
  if (also.publish_comment) account.grants = [...account.grants, "grant_publish_comment"];
  await tx.delete(campaignStrategies).where(eq(campaignStrategies.campaignId, campaignId));
  await tx.delete(campaignStrategies).where(eq(campaignStrategies.channelId, channel!.id));
  await activateAccountDefault(tx, channel!.id, account);
  await tx.insert(campaignStrategies).values({
    campaignId,
    channelId: null,
    version: 1,
    status: "active",
    baseVersion: null,
    document: { ...withActionModes(conversationCampaign(), { like_target: mode, ...also }), campaign_id: campaignId },
    patchProvenance: { source: "seed", instruction: null, intent: null, scope: null, changes: [], compilerVersion: "test", approver: null },
    effectiveAt: Date.now() - 60_000,
    createdAt: Date.now(),
  });
}
