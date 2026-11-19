/**
 * Upcoming's table, row by row — client-safe and import-free beyond types, so
 * a test pins the rows without rendering.
 */

import type { QueueMessage } from "./messageTypes";
import { heldForReview, heldOnConnectionCheck, type ActionRowView } from "./presentation";
import type { PipelineData } from "./rows";
import { companionLikeLabel, ledgerSendLabel, messageSendLabel, type SendLabel } from "./sendLabels";

/**
 * One row of the plan: a scheduled comment or reply, the like that rides one
 * out, or a like, invite, acceptance, DM or follow-up on the action ledger
 * that holds its yes — each with whose yes it goes out on.
 */
export type UpcomingRow =
  | { kind: "send"; key: string; message: QueueMessage; label: SendLabel }
  | { kind: "like"; key: string; message: QueueMessage; label: SendLabel }
  | { kind: "action"; key: string; action: ActionRowView; label: SendLabel };

/** The row of the person's thread this one is about (`inbox/item-ref.ts`):
 *  a comment or reply, and the like that rides it, are the message; a ledger
 *  action is itself. */
export function upcomingItem(row: UpcomingRow): string {
  return row.kind === "action" ? `action:${row.action.id}` : `message:${row.message.id}`;
}

/** The Time column of a ledger action, which holds no slot of its own: queued
 *  for the gate's next look, held until a read of the person can tell
 *  whether the two are connected, or held for the owner's review of its
 *  conversation, which no look will lift — the words the strip and the
 *  person's header give the same hold. */
export function actionWhen(action: Pick<ActionRowView, "status" | "statusReason">): string {
  if (heldOnConnectionCheck(action)) return "Held · checking whether you're connected";
  return heldForReview(action) ? "Held · waits for your review" : "Queued";
}

/** Soonest first: each send at its slot with the like that rides it right
 *  under it, then the ledger's actions, which go when the gate next admits
 *  them and hold no slot of their own. */
export function upcomingRows(
  pipeline: Pick<PipelineData, "rows" | "actions" | "approvedDrafts" | "ridingLikes">,
): UpcomingRow[] {
  const approved = new Set(pipeline.approvedDrafts);
  const riding = new Set(pipeline.ridingLikes);
  return [
    ...pipeline.rows.scheduled.flatMap((message): UpcomingRow[] => [
      {
        kind: "send",
        key: `send:${message.id}`,
        message,
        label: messageSendLabel({ publishOrigin: message.publishOrigin, approved: approved.has(message.id) }),
      },
      ...(riding.has(message.id)
        ? [{ kind: "like" as const, key: `like:${message.id}`, message, label: companionLikeLabel(message.kind) }]
        : []),
    ]),
    ...pipeline.actions.scheduled.map(
      (action): UpcomingRow => ({
        kind: "action",
        key: `action:${action.id}`,
        action,
        label: ledgerSendLabel({
          kind: action.kind,
          origin: action.origin,
          approved: action.approved,
          hasText: action.text !== null,
        }),
      }),
    ),
  ];
}
