/**
 * A QUICK CAMPAIGN FROM CHAT, IN THE OWNER'S WORDS. Client-safe — it imports
 * nothing — so the card that offers Create and start and the server that
 * draws it say one thing.
 *
 * The card's campaign is created finding leads, as every campaign is
 * (US-LMF-07), and its first look runs on Find leads (US-LMF-06): three
 * phrases a run, newest posts first, the people who pass the screen shown on
 * Leads as Signals. These words say what it does, in people. They all follow
 * `QUICK_FIRST_LOOK_LIVE`: off, a Quick campaign is saved Quick and runs like
 * Standard, and they say only that.
 */
export const QUICK_FIRST_LOOK_LIVE = true;

/** The card a Quick design is drawn as: a campaign its yes creates as well as
 *  starts (`chat/quickCampaign.ts`). */
export const CAMPAIGN_CREATE_AND_START = "campaign.create_and_start";

/** What Quick reads, beside "Search depth" on that card. */
export const QUICK_DEPTH_VALUE = QUICK_FIRST_LOOK_LIVE
  ? "Quick · 3 phrases a run, newest posts first, people shown as Signals"
  : "Quick · saved, and runs like Standard until its first look ships";

/** What the card says once Create and start has landed, beside Open Leads. */
export const QUICK_STARTED = QUICK_FIRST_LOOK_LIVE
  ? "Started. Scout's first look is reading LinkedIn, and people will land in Leads as it finds them."
  : "Started. Scout's first run is reading LinkedIn, and people will land in Leads as it finds them.";
