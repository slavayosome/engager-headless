/**
 * Browser session policy constants.
 *
 * Their own module because the bridge and the dashboard's Browser page both
 * need them, and `bridgeServer.ts` itself is webpack-ignored in the dashboard
 * bundle (it owns the one standing holder), so a constant a page has to state
 * has to live somewhere the page can import.
 */

/** Local hour of the daily idle recycle — a clean Chrome restart per day so a
 *  weeks-old Chromium never accumulates. */
export const RECYCLE_HOUR = 4;
