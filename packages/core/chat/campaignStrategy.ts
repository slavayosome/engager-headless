import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { products } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { audiencePainSchema, audienceProfileInputSchema } from "../audience/model";
import { MODE_KEYS } from "../strategy/catalog";
import {
  INSTRUCTION_INTENTS,
  SCOPE_LEVELS,
  compileInstruction,
  instructionPatch,
  parseRecognition,
  type InstructionScope,
} from "../strategy/compiler";
import { readPatchState, undoPatchFor } from "../strategy/patch";
import { CAMPAIGN_TEMPLATE_IDS, designPatch, templateContext } from "../strategy/templates";
import type { McpCtx } from "../mcp/context";
import { errorResult, jsonResult } from "../mcp/tools/util";
import {
  proposalResult,
  recordProposal,
  refusalResult,
  type ProposalContext,
} from "./proposals";
import { newCampaignAudience, type CreateAndStart } from "./quickCampaign";
import { CAMPAIGN_CREATE_AND_START } from "./quickCampaignWords";

export const discoveryPatch = z
  .object({
    keywords: z.array(z.string().trim().min(1).max(100)),
    hashtags: z.array(z.string().trim().min(1).max(80)),
    target_author_urns: z
      .array(z.string().trim().min(1).max(2000))
      .max(8),
  })
  .partial()
  .strict();

/**
 * A CAMPAIGN'S STRATEGY, CHANGED FROM CHAT — the broker's own
 * `patch_campaign_strategy` and `undo_strategy_version`.
 *
 * The registry's tools of those names take raw ops and land a narrowing at
 * once (`mcp/tools/strategy.ts`), which is right for an external agent the
 * owner runs and wrong here: chat reads third-party text, so every change it
 * makes is a card the owner spends (`proposals.ts`), whichever way it moves
 * authority. And chat does not author ops. It says which known change the
 * owner asked for — a template and its answers, or one recognized instruction
 * — and the server writes the ops (`templates.ts`, `compiler.ts`), so a
 * sentence pasted into the conversation can reach no path the change did not
 * name. Each vocabulary is closed: a template, an intent or a key outside it
 * is refused by name before anything is read.
 *
 * The tool definitions are as small as they can be read: they ride every step of
 * every turn. Each intent's arguments are in engager-campaigns, which chat
 * reads before it designs or changes a campaign, and a recognition the closed
 * schema refuses comes back naming the argument it got wrong.
 *
 * Mounted in place of the registry's two writers when the broker opens the
 * registry for a conversation (`mcp/tools/index.ts`); the read,
 * `get_campaign`, is the registry's own.
 */

/** The two writers chat mounts in place of the registry's. */
export const CHAT_STRATEGY_WRITERS = [
  "patch_campaign_strategy",
  "undo_strategy_version",
] as const;

/** A strategy from a template and the owner's answers (`templates.ts`) —
 *  and a Quick search depth, whose design names no campaign: its card creates
 *  one as it starts it (`quickCampaign.ts`). */
const design = z
  .object({
    template: z.enum(CAMPAIGN_TEMPLATE_IDS),
    ask_first: z.array(z.enum(MODE_KEYS)),
    lead_in: z.boolean(),
    offer_product_id: z.number().int().positive().nullable(),
    search_depth: z.literal("quick").optional(),
  })
  .strict();

/** One recognized instruction as the model sends it. Its arguments are
 *  parsed by the compiler's closed schema in the handler (`parseRecognition`):
 *  nine member schemas here would be paid on every step of every turn. */
const recognized = z
  .object({
    intent: z.enum(INSTRUCTION_INTENTS),
    args: z.record(z.unknown()),
    ambiguous_scope: z.boolean(),
  })
  .strict();

const scope = z.object({ level: z.enum(SCOPE_LEVELS), step_id: z.string().optional() }).strict();

const audience = audienceProfileInputSchema.innerType().shape;

/** The campaign a Quick design names, as chat says it: who it is for in one
 *  line, their pains and who to leave out in the owner's words, and the
 *  searches it designed — each in the bounds of the field it fills. */
const newCampaign = z
  .object({
    name: z.string().trim().min(1).max(200),
    who: audience.who.shape.summary.min(1),
    pains: z.array(audiencePainSchema.innerType().shape.text).max(12).optional(),
    notThem: audience.notThem.optional(),
    discovery: discoveryPatch.optional(),
    channelId: z.number().int().positive().optional(),
  })
  .strict();

/** What a scope argument means — a step without its id is a scope nobody
 *  stated. */
function scopeOf(stated: z.infer<typeof scope> | null | undefined): InstructionScope | null {
  if (!stated) return null;
  if (stated.level !== "step") return { level: stated.level };
  return stated.step_id ? { level: "step", stepId: stated.step_id } : null;
}

/** A call that says neither — or both — of the two changes. */
export class OneChangeError extends AppError {
  readonly recovery = "Nothing was proposed. Send exactly one of `design` or `recognized`.";

  constructor() {
    super("invalid_proposal", "a strategy change is a design or one recognized instruction", 400);
  }
}

/** A call naming a campaign its change is not about: a Quick design creates
 *  its own, from `campaign`; every other change names the one it changes. */
export class WhichCampaignError extends AppError {
  readonly recovery: string;

  constructor(change: "quick" | "other") {
    super(
      "invalid_proposal",
      change === "quick"
        ? "a Quick design creates its campaign, so it names none"
        : "a change names the campaign it changes",
      400,
    );
    this.recovery =
      change === "quick"
        ? "Nothing was proposed. Send the new campaign as `campaign`, without campaignId; its card's Create and start creates and starts it."
        : "Nothing was proposed. Send the campaignId it changes; only a design with search_depth quick sends `campaign` instead.";
  }
}

/** An outcome counts against a product this organization has. */
export class UnknownOfferError extends AppError {
  readonly recovery =
    "Nothing was proposed. Read the products with list_products and use one of their ids, or null when the campaign counts no outcome.";

  constructor(productId: number) {
    super("offer_not_found", `product ${productId} is not one this organization has`, 404);
  }
}

async function offerReference(tx: Tx, productId: number | null): Promise<string | null> {
  if (productId === null) return null;
  const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId));
  if (!product) throw new UnknownOfferError(productId);
  return `product:${product.id}`;
}

/** A Quick design as the card its yes creates and starts: the campaign it
 *  names, the strategy it starts on — answered as any design is — and the
 *  owner's words. */
async function createAndStartChange(
  tx: Tx,
  campaign: z.infer<typeof newCampaign>,
  answers: z.infer<typeof design>,
  instruction: string,
): Promise<CreateAndStart> {
  return {
    kind: CAMPAIGN_CREATE_AND_START,
    campaign: {
      name: campaign.name,
      audienceProfile: newCampaignAudience(campaign),
      ...(campaign.discovery ? { discovery: campaign.discovery } : {}),
      ...(campaign.channelId !== undefined ? { channelId: campaign.channelId } : {}),
    },
    design: {
      template: answers.template,
      askFirst: answers.ask_first,
      leadIn: answers.lead_in,
      offer: await offerReference(tx, answers.offer_product_id),
    },
    instruction,
  };
}

/** Said beside a clarify, so the model asks rather than guesses. */
const ASK_FIRST =
  "Nothing was proposed. Ask the owner which of these they mean — one question, these options — then call again with scope set to their answer.";

const PATCH_DESCRIPTION =
  "Propose ONE strategy change as a card the owner answers; never call it done. `design`: a template and answers; its yes starts a campaign not started. With search_depth quick send `campaign`, not campaignId: its yes creates and starts it. `recognized`: their instruction as one known intent. `scope`: what they said, or this step.";

export function registerChatStrategyTools(
  server: McpServer,
  ctx: McpCtx,
  chat: ProposalContext,
): void {
  server.registerTool(
    "patch_campaign_strategy",
    {
      title: "Propose a change to a campaign's strategy",
      description: PATCH_DESCRIPTION,
      inputSchema: {
        campaignId: z.number().int().positive().optional(),
        campaign: newCampaign.optional(),
        instruction: z.string().max(4000),
        design: design.optional(),
        recognized: recognized.optional(),
        scope: scope.nullable().optional(),
      },
    },
    async (input) => {
      try {
        return await withOrg(ctx.organizationId, async (tx) => {
          const { campaignId, campaign, instruction } = input;
          if ((input.design === undefined) === (input.recognized === undefined)) {
            throw new OneChangeError();
          }
          if (input.design?.search_depth === "quick") {
            if (campaign === undefined || campaignId !== undefined) throw new WhichCampaignError("quick");
            const change = await createAndStartChange(tx, campaign, input.design, instruction);
            return proposalResult(await recordProposal(tx, ctx.organizationId, change, chat));
          }
          if (campaignId === undefined || campaign !== undefined) throw new WhichCampaignError("other");
          const state = await readPatchState(tx, campaignId, { lock: false });
          if (input.design) {
            const patch = designPatch({
              campaignId,
              expectedBaseVersion: state.active.version,
              base: state.base,
              template: input.design.template,
              answers: {
                askFirst: input.design.ask_first,
                leadIn: input.design.lead_in,
                offer: await offerReference(tx, input.design.offer_product_id),
              },
              context: templateContext(state),
              instruction,
            });
            return proposalResult(await recordProposal(tx, ctx.organizationId, patch, chat));
          }
          const recognition = parseRecognition(input.recognized);
          const compiled = compileInstruction(
            recognition,
            scopeOf(input.scope),
            state.base,
            state.network,
          );
          switch (compiled.kind) {
            case "clarify":
              return jsonResult({
                clarify: true,
                question: compiled.question,
                options: compiled.options,
                note: ASK_FIRST,
              });
            case "nothing":
              return errorResult(compiled.reason, {
                code: "nothing_to_propose",
                recovery: "Nothing was proposed. Tell the owner why in a sentence; do not reach for another tool to make it anyway.",
              });
            case "exclusion": {
              // The account's own do-not-engage list, which the strategy
              // does not hold: its existing card, with its own wording.
              const exclusion = { kind: "do_not_engage.add" as const, profileId: compiled.profileId };
              return proposalResult(await recordProposal(tx, ctx.organizationId, exclusion, chat));
            }
            case "ops":
              return proposalResult(
                await recordProposal(
                  tx,
                  ctx.organizationId,
                  instructionPatch({
                    campaignId,
                    expectedBaseVersion: state.active.version,
                    compiled,
                    instruction,
                  }),
                  chat,
                ),
              );
          }
        });
      } catch (error) {
        return refusalResult(error);
      }
    },
  );

  server.registerTool(
    "undo_strategy_version",
    {
      title: "Propose undoing a strategy version",
      description:
        "Propose undoing one strategy version as a card the owner answers; what it replaced returns as a new version.",
      inputSchema: {
        campaignId: z.number().int().positive(),
        version: z.number().int().positive(),
        instruction: z.string().max(4000).optional(),
      },
    },
    async ({ campaignId, version, instruction }) => {
      try {
        return await withOrg(ctx.organizationId, async (tx) =>
          proposalResult(
            await recordProposal(
              tx,
              ctx.organizationId,
              await undoPatchFor(tx, campaignId, version, instruction ?? `undo version ${version}`),
              chat,
            ),
          ),
        );
      } catch (error) {
        return refusalResult(error);
      }
    },
  );
}
