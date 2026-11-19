import { AppError } from "@engager/common/errors";

/** Why an owner's decision on the action ledger was refused. Nothing was
 *  written when one is thrown. */
export type ActionLedgerRefusal =
  | "action_not_found"
  | "scope_not_found"
  | "action_not_awaiting_review"
  | "action_not_scheduled"
  | "action_going_out"
  | "action_not_permitted"
  | "action_stale"
  | "action_stopped"
  | "evidence_mismatch"
  | "action_not_uncertain"
  | "action_text_required"
  | "conversation_not_found"
  | "conversation_closed"
  | "conversation_reopened"
  | "conversation_unsettled"
  | "conversation_not_taken_over"
  | "conversation_not_awaiting_review"
  | "wake_not_found"
  | "wake_time_invalid"
  | "wake_firing";

export class ActionLedgerError extends AppError {
  constructor(
    code: ActionLedgerRefusal,
    message: string,
    readonly recovery: string,
  ) {
    super(
      code,
      message,
      code === "action_not_found" ||
        code === "scope_not_found" ||
        code === "conversation_not_found" ||
        code === "wake_not_found"
        ? 404
        : code === "action_text_required" || code === "wake_time_invalid"
          ? 400
          : 409,
    );
  }
}
