import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations, SEARCH_DEPTHS } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { FIRST_CAMPAIGN } from "../campaigns/firstCampaignFields";
import { firstCampaignLimitsSchema } from "./firstCampaignLimits";
import {
  firstCampaignInstructionsSchema,
  firstCampaignModesSchema,
} from "../strategy/firstCampaignActions";

/** The setup screens the first campaign has, in the order the owner meets them. */
export const FIRST_CAMPAIGN_SCREENS = ["line", "draft", "depth", "review"] as const;
export type FirstCampaignScreen = (typeof FIRST_CAMPAIGN_SCREENS)[number];

/**
 * THE FIRST-CAMPAIGN WIZARD'S WORKING COPY — everything the owner has answered
 * so far, held in `organizations.first_campaign_draft` so a quit and relaunch
 * returns to the screen last reached with its inputs. A copy of the owner's
 * answers and the agent's suggestion, not a campaign: it exists until setup
 * completes, and it is the owner's own line, kept as typed.
 *
 * The fields bound only what the column can hold. Whether they are enough to
 * go on (a name, an audience, one to five searches) is the screen's check, so
 * a half-edited draft is stored as it stands.
 */
export const firstCampaignDraftSchema = z
  .object({
    /** The screen last reached. */
    screen: z.enum(FIRST_CAMPAIGN_SCREENS),
    /** The owner's line, as typed. */
    line: z.string().max(FIRST_CAMPAIGN.lineMax),
    /** The four fields as the owner has them: the agent's draft, or the line
     *  itself where the agent could not answer. Null before the first draft. */
    draft: z
      .object({
        name: z.string().max(FIRST_CAMPAIGN.nameMax),
        audience: z.string().max(FIRST_CAMPAIGN.audienceMax),
        topics: z.array(z.string().max(FIRST_CAMPAIGN.topicMax)).max(FIRST_CAMPAIGN.topicsMax),
        /** One search per line, as the textarea holds them. */
        searches: z.string().max(1000),
        /** Who wrote it, for the line above the fields: the agent's name. Null
         *  where the agent could not answer. */
        agent: z.string().max(80).nullable(),
        /** The plain reason line, where the agent could not answer. */
        notice: z.string().max(400).nullable(),
      })
      .strict()
      .nullable(),
    /** The search depth chosen; null until the owner has seen the choice. */
    depth: z.enum(SEARCH_DEPTHS).nullable(),
    /** The Review's choices, by action: only the ones the owner set. An action
     *  not named is at its decided default. */
    modes: firstCampaignModesSchema.optional(),
    /** The step instructions the owner changed from the starting text, by
     *  step. A step not named inherits the starting text. */
    instructions: firstCampaignInstructionsSchema.optional(),
    limits: firstCampaignLimitsSchema.optional(),
    /** Product explicitly confirmed (null means skipped). New Brain imports
     * must not silently change which product setup restores or attaches. */
    productId: z.number().int().positive().nullable().optional(),
  })
  .strict();
export type FirstCampaignDraft = z.infer<typeof firstCampaignDraftSchema>;

/** What a save may carry: any of the top-level answers, replacing that answer
 *  whole and leaving the others as they are. */
export const firstCampaignDraftPatchSchema = firstCampaignDraftSchema.partial();
export type FirstCampaignDraftPatch = z.infer<typeof firstCampaignDraftPatchSchema>;

const BLANK: FirstCampaignDraft = { screen: "line", line: "", draft: null, depth: null };

/** The stored copy, or null for none. A copy that no longer parses (an older
 *  build's shape) is the same as none: it is disposable, never worth a crash. */
export function parseFirstCampaignDraft(stored: unknown): FirstCampaignDraft | null {
  const parsed = firstCampaignDraftSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

async function stored(tx: Tx, orgId: string, lock: boolean): Promise<FirstCampaignDraft | null> {
  const query = tx
    .select({ draft: organizations.firstCampaignDraft })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const [row] = await (lock ? query.for("update") : query);
  return parseFirstCampaignDraft(row?.draft);
}

export function readFirstCampaignDraft(tx: Tx, orgId: string): Promise<FirstCampaignDraft | null> {
  return stored(tx, orgId, false);
}

/** Merge a save into the stored copy under the org's row lock: the answers the
 *  patch names are replaced, every other answer is kept. Returns the result. */
export async function mergeFirstCampaignDraft(
  tx: Tx,
  orgId: string,
  patch: FirstCampaignDraftPatch,
): Promise<FirstCampaignDraft> {
  const named = Object.entries(firstCampaignDraftPatchSchema.parse(patch)).filter(([, answer]) => answer !== undefined);
  const next = firstCampaignDraftSchema.parse({
    ...((await stored(tx, orgId, true)) ?? BLANK),
    ...Object.fromEntries(named),
  });
  await tx
    .update(organizations)
    .set({ firstCampaignDraft: next, updatedAt: Date.now() })
    .where(eq(organizations.id, orgId));
  return next;
}

/** Drop the working copy once setup completes. */
export async function clearFirstCampaignDraft(tx: Tx, orgId: string): Promise<void> {
  await tx
    .update(organizations)
    .set({ firstCampaignDraft: null, updatedAt: Date.now() })
    .where(eq(organizations.id, orgId));
}
