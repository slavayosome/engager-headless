/**
 * The four groups every message and every ledger row is sorted into by its
 * state — waiting for a yes, scheduled, posted, and an issue. The data's cut,
 * not the owner's tabs, which are the dashboard's.
 */
export const PIPELINE_TABS = ["waitingForYes", "scheduled", "posted", "issues"] as const;
export type PipelineTab = (typeof PIPELINE_TABS)[number];
