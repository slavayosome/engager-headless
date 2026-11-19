import { AMBASSADOR_STEP_ROWS } from "../strategy/firstCampaignActions";

/**
 * What Fill in the rest may fill (`fill.ts`), in its own module so New
 * campaign's client can name the fields without reaching the database.
 */

/** The steps whose instructions it may write: Find leads, then the
 *  Ambassador's rows. */
export const FILL_STEPS = ["find_leads", ...AMBASSADOR_STEP_ROWS] as const;
export type FillStep = (typeof FILL_STEPS)[number];

/** The fields it may fill besides each step's instructions. */
export const FILL_FIELDS = ["depth", "pains", "notThem", "countries", "goal", "offer", "voice", "name"] as const;
export type FillField = (typeof FILL_FIELDS)[number];
