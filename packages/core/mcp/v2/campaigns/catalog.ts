import { z } from "zod";
import { withOrg } from "@engager/database/tenant";
import { catalogView } from "../../../strategy/catalogView";
import { defineTool, type V2Tool } from "../define";

export const catalogTools: readonly V2Tool[] = [defineTool({
  name: "get_catalog", kind: "read",
  description: "Read the campaign catalog, strategy parameters and account limits. See engager-campaigns for the setup workflow.",
  input: z.object({
    include: z.array(z.enum(["workers", "steps", "actions", "modes", "parameters", "templates", "ceilings"])).optional(),
    campaignId: z.number().int().positive().optional(),
  }),
  handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async (tx) => ({ content: [{ type: "text", text: JSON.stringify(await catalogView(tx, ctx.organizationId, input)) }] })),
})];
