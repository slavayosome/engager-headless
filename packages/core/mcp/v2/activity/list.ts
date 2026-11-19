import { z } from "zod";
import { withOrg } from "@engager/database/tenant";
import { ACTIVITY_KINDS, ACTIVITY_VIEWS, listActivity } from "../../../activity/rows";
import { jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { parseRef } from "../refs";
import { untrusted } from "../../../ai/prompts";

/**
 * What waits on a yes, is going out, went out, came back or has a problem, one
 * list, each row saying why it is where it is. The Activity tabs call the same
 * functions (`core/activity/rows.ts`), so a row here is the row there.
 */
export const activityListTools: readonly V2Tool[] = [
  defineTool({
    name: "list_activity",
    kind: "read",
    description:
      "What waits on a yes, is upcoming, went out, came back or has a problem. Each row says why it is where it is; refs reads exact rows.",
    input: z.object({
      view: z.enum(ACTIVITY_VIEWS),
      kind: z.enum(ACTIVITY_KINDS).optional(),
      campaignId: z.number().int().positive().optional(),
      refs: z.array(z.string().max(40)).min(1).max(50).optional().describe("msg: or act: and an id."),
      cursor: z.string().max(100).optional().describe("nextCursor of the last page."),
    }),
    handler: async ({ ctx }, { view, kind, campaignId, refs, cursor }) => {
      // Refs are checked before a transaction opens.
      const parsed = refs?.map((ref) => parseRef(ref, ["msg", "act"]));
      const named = parsed && {
        messages: parsed.flatMap((ref) => (ref.kind === "msg" ? [ref.id] : [])),
        actions: parsed.flatMap((ref) => (ref.kind === "act" ? [ref.id] : [])),
      };
      const page = await withOrg(ctx.organizationId, (tx) =>
        listActivity(tx, ctx.organizationId, { view, kind, campaignId, refs: named, cursor }),
      );
      return jsonResult({ ...page, rows: page.rows.map((row) => ({
        ...row, text: view === "came_back" && row.text !== null ? untrusted("THEIR WORDS", row.text) : row.text,
      })) });
    },
  }),
];
