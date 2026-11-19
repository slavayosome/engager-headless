import { randomUUID } from "node:crypto";
import { TransactionRollbackError } from "drizzle-orm";
import { z } from "zod";
import type { Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { audienceProfile, audienceProfileInputSchema, type AudienceProfileInput } from "../audience/model";
import { MODE_KEYS } from "../strategy/catalog";
import {
  readPatchState,
  startPatchFor,
  type StrategyPatch,
} from "../strategy/patch";
import { CAMPAIGN_TEMPLATE_IDS } from "../strategy/templates";
import { startCampaign } from "../operations/startCampaign";
import { requireSavedCampaign, saveCampaign } from "../operations/saveCampaign";
import { CAMPAIGN_CREATE_AND_START, QUICK_DEPTH_VALUE } from "./quickCampaignWords";

/**
 * A QUICK CAMPAIGN FROM CHAT, created and started by the owner's one press
 * (SPEC §4.4) — the chat's twin of New campaign's Create and start
 * (`createAndStartCampaign`, apps/dashboard/app/campaigns/new/actions.ts).
 *
 * Every other campaign chat designs exists before its card: `save_campaign`
 * makes it, Paused and Not started, and the card proposes its strategy. A
 * Quick one does not. Its card is the whole campaign — what it is for, its
 * strategy and its Start — and nothing is created until the owner presses
 * Create and start, so Change something leaves nothing behind.
 *
 * THE PRESS IS ONE TRANSACTION, the card's own (`decidePendingChange`): the
 * campaign is created as `save_campaign` creates one, at Quick; its strategy
 * lands on its draft as a template's does; and its Start activates that draft.
 * A refusal anywhere takes all of it back, and the card stays answerable.
 *
 * THE CARD IS THAT PRESS, read before it is made. The same three operations
 * run in a savepoint that is rolled back (`dryRun`), and the card is read off
 * what they wrote: the Start's own rows and design, and the campaign's own
 * values. So the card cannot say more, or other, than the press would do, and
 * a campaign the press could not create draws no card at all.
 */

/** A Quick campaign as its card carries it: the campaign it creates, the
 *  strategy that campaign starts on, and the owner's words. */
export const createAndStartSchema = z
  .object({
    kind: z.literal(CAMPAIGN_CREATE_AND_START),
    campaign: z
      .object({
        name: z.string().trim().min(1).max(200),
        /** Pain identities are given once, when the card is drawn, so the
         *  card and its press describe the same pains. */
        audienceProfile: audienceProfileInputSchema,
        /** Its sources, bounded where chat said them (`discoveryPatch`). */
        discovery: z
          .object({
            keywords: z.array(z.string()),
            hashtags: z.array(z.string()),
            target_author_urns: z.array(z.string()),
          })
          .partial()
          .strict()
          .optional(),
        /** The account it lives on for life, when the org has several. */
        channelId: z.number().int().positive().optional(),
      })
      .strict(),
    /** A template and the owner's answers (`TemplateAnswers`). */
    design: z
      .object({
        template: z.enum(CAMPAIGN_TEMPLATE_IDS),
        askFirst: z.array(z.enum(MODE_KEYS)),
        leadIn: z.boolean(),
        offer: z.string().nullable(),
      })
      .strict(),
    instruction: z.string().max(4000),
  })
  .strict();
export type CreateAndStart = z.infer<typeof createAndStartSchema>;

/** The new campaign's Audience, from chat's words for it — who they are in
 *  one line, their pains and who to leave out: its pains the owner's, active,
 *  each given its identity here. */
export function newCampaignAudience(words: {
  who: string;
  pains?: readonly string[];
  notThem?: readonly string[];
}): AudienceProfileInput {
  return audienceProfileInputSchema.parse({
    who: { summary: words.who },
    pains: (words.pains ?? []).map((text) => ({ id: randomUUID(), text, source: "owner", status: "active" })),
    notThem: words.notThem ?? [],
    testSource: "derived",
  });
}

/**
 * `work` against a savepoint of `tx` that is rolled back whatever it wrote:
 * what an operation WOULD do, read off the operation itself and kept nowhere.
 * Anything it set to run after the commit is dropped with it (`afterCommit`).
 */
export async function dryRun<T>(tx: Tx, work: (savepoint: Tx) => Promise<T>): Promise<T> {
  let ran: { value: T } | undefined;
  try {
    await tx.transaction(async (savepoint) => {
      ran = { value: await work(savepoint) };
      savepoint.rollback();
    });
  } catch (error) {
    if (!(ran && error instanceof TransactionRollbackError)) throw error;
  }
  return ran!.value;
}

/**
 * The campaign, created at Quick with its strategy on its draft, and the
 * Start that activates it — what the card is read off, in a dry run, and what
 * its yes commits. Created as `save_campaign` creates one, on its account,
 * Paused and Not started; the template lands on the draft as Create and
 * start's does, where nothing is in force until the Start.
 */
export async function createWithStrategy(
  tx: Tx,
  organizationId: string,
  value: CreateAndStart,
  context: { approver: string | null; now: number },
): Promise<{ campaignId: number; start: StrategyPatch }> {
  const { name, audienceProfile, discovery, channelId } = value.campaign;
  const { template, askFirst, leadIn, offer } = value.design;
  const saved = await saveCampaign(tx, organizationId, {
    name, audience: audienceProfile, createFields: discovery ? { discovery } : {}, channelId,
    depth: "quick", template, templateAnswers: { askFirst, leadIn, offer }, source: "chat", actor: "owner",
  }, context.approver ?? "chat-preview");
  const campaignId = requireSavedCampaign(saved).campaign!.id;
  const state = await readPatchState(tx, campaignId, { lock: false });
  return { campaignId, start: startPatchFor(campaignId, state.active.version, value.instruction) };
}

/** One of the campaign's own values, as its card lists it. */
export type CampaignFact = { label: string; value: string };

/** What the campaign is for: its name, its Audience and the oldest post it
 *  searches, read off the row its create wrote, and its search depth —
 *  Quick, which is what this card creates. It finds leads, as every campaign
 *  created does, so what it searches is its pains' words, said above: Find
 *  posts' keyword searches are not read. */
export function factsOf(campaign: Campaign): CampaignFact[] {
  const audience = audienceProfile(campaign);
  const pains = audience.pains.filter((pain) => pain.status === "active").map((pain) => pain.text);
  const days = campaign.maxPostAgeDays;
  return [
    { label: "Name", value: campaign.name },
    { label: "Who", value: audience.who.summary },
    ...(pains.length > 0 ? [{ label: "Their pains", value: pains.join(" · ") }] : []),
    ...(audience.notThem.length > 0 ? [{ label: "Not them", value: audience.notThem.join(", ") }] : []),
    { label: "Search depth", value: QUICK_DEPTH_VALUE },
    { label: "Oldest post to search", value: `${days} ${days === 1 ? "day" : "days"}` },
  ];
}

/**
 * CREATE AND START — the card's yes: the campaign and its strategy, its brief
 * routed for compile as every create routes it, and its Start, all in the
 * card's one transaction. The receipt names the campaign the card's Open
 * Leads goes to.
 */
export async function createAndStart(
  tx: Tx,
  organizationId: string,
  value: CreateAndStart,
  context: { approver: string | null; now: number },
): Promise<{ campaignId: number; version: number; started: boolean }> {
  const { campaignId, start } = await createWithStrategy(tx, organizationId, value, context);
  if (!context.approver) throw new Error("An owner must confirm Start.");
  const started = await startCampaign(tx, campaignId, start.expectedBaseVersion, { approver: context.approver, now: context.now, instruction: value.instruction, confirmed: true });
  return { campaignId, version: started.result.version, started: started.result.started };
}
