import { z } from "zod";

/** Raw edited fields, including half-entered numbers. Only differences are
 * persisted; untouched defaults are always read from the account. */
const number = z.string().max(20);
export const firstCampaignLimitsSchema = z.object({
  together: number, comments: number, replies: number, likes: number, invites: number, dms: number,
  gap: number, weeks: number, startRate: number,
  start: z.string().max(5), end: z.string().max(5), tz: z.string().max(80),
  days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).max(7),
}).partial().strict();
export type FirstCampaignLimits = z.infer<typeof firstCampaignLimitsSchema>;
