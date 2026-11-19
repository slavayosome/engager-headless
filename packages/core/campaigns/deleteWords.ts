/**
 * WHAT DELETING A CAMPAIGN DOES, in the owner's words — said by the card an
 * agent's `delete_campaign` draws and by the dialog behind the campaign's own
 * Delete, so the two never promise different things. Each sentence is what
 * `deleteCampaign` (`operations/deleteCampaign.ts`) does, and nothing more.
 *
 * Dependency-free, so a client component can take it.
 */
export const DELETE_CAMPAIGN_WORDS = [
  "It stops, and everything waiting in it is cancelled: actions and comments waiting for your yes or scheduled, changes waiting for your yes, wakes and follow-ups.",
  "What it already sent stays in the account's history, and still counts toward the account's caps.",
  "Deleting is final: it can't be undone.",
] as const;
