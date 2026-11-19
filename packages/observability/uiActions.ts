// Pure, with no Node imports: the dashboard's pages name an action from this
// list in the browser, and the catalog's `ui_action` is the same list.
export const UI_ACTIONS = [
  "run_now",
  "strategy_saved",
  "strategy_table_edit",
  "voice_trait_set",
  "chat_sent",
  "browser_visibility_set",
  "report_opened",
  "stop_everything",
  "show_more_post",
  "angle_explored",
  "inbox_filter",
  "leads_filter",
  "why_picked_opened",
  "plan_checkout_opened",
] as const;

export type UiAction = (typeof UI_ACTIONS)[number];
