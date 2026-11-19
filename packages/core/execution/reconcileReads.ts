import { sql, type SQL } from "drizzle-orm";
import type { ActionKind, ActionRow } from "@engager/database/schema";

/**
 * WHEN A SEND NOBODY CAN VOUCH FOR IS READ, AND WHEN THE OWNER IS ASKED
 * (INV-10; US-DM-06, US-LIO-08). A send whose outcome is open keeps the
 * account's holder (`actionGate.ts`), and only a read settles it — never a
 * second press. The drain looks at it on its own at each of its looks after
 * the click; every drain reads it besides, before anything new on the account.
 *
 * A like, DM, follow-up, invite, acceptance or withdrawal waits on no one while
 * those looks go on: what a read shows settles it, and the owner is asked only
 * once the looks give up — three that could not tell, or two hours since the
 * click, whichever comes first, or the looks spent. Only a look counts: a read
 * some other drain made between two looks — an owner's yes elsewhere on the
 * account enqueues one — settles what it can and counts for nothing, so a send
 * a later look would have settled is never handed to the owner early. Every
 * other kind's open outcome is the owner's at once, and read on every drain
 * all the same.
 *
 * Pure, and the SQL the person's waits read it with, so the Inbox and the
 * drain cannot disagree about who is still being read.
 */

const MINUTE = 60_000;

/** When, after an attempt whose outcome nobody saw, the drain reads it again
 *  on its own: soon, then past the quarter hour — the earliest a read showing
 *  nothing sent may settle an invitation or a DM so (`actions/invite.ts`,
 *  `actions/dm.ts`) — then once more. */
export const RECONCILE_LOOKS_MS = [2 * MINUTE, 15 * MINUTE, 60 * MINUTE] as const;

/** When the looks give up on an open DM and the owner is asked instead. */
export const RECONCILE_ASK_OWNER_AFTER = { reads: 3, sinceClickMs: 120 * MINUTE } as const;

/** The kinds whose open outcome is read before the owner is asked: a like's,
 *  a DM's, an invite's, an acceptance's and a withdrawal's, whose person says
 *  it is being checked meanwhile. Each reads LinkedIn's own data against the
 *  attempt (a like, the post's; the rest, the attempt's journal entry), and
 *  none presses anything. */
export const READ_BEFORE_ASKING: readonly ActionKind[] = [
  "like_target",
  "dm",
  "followup",
  "invite",
  "accept_invite",
  "withdraw_invite",
];

/** The `status_reason` an open send takes when its looks give up. */
export const RECONCILE_EXHAUSTED = "reconcile_exhausted";

type OpenSend = Pick<
  ActionRow,
  | "kind"
  | "statusReason"
  | "reconcileAttempts"
  | "lastReconcileAt"
  | "attempts"
  | "fenceToken"
  | "submittedAt"
  | "updatedAt"
>;

/** When the attempt whose outcome is open was pressed: the one the row is
 *  fenced to, as the drain's looks and the DM's own settle time count it. */
export function clickedAt(row: Pick<OpenSend, "attempts" | "fenceToken" | "submittedAt" | "updatedAt">): number {
  return (
    row.attempts.find((attempt) => attempt.operationId === row.fenceToken)?.startedAt ??
    row.submittedAt ??
    row.updatedAt
  );
}

/** When the drain looks at it next on its own: the first of its looks after
 *  the last one counted, or after the click before any. Null once the looks
 *  are spent. */
export function nextReconcileAt(
  row: Pick<OpenSend, "lastReconcileAt" | "attempts" | "fenceToken" | "submittedAt" | "updatedAt">,
): number | null {
  const clicked = clickedAt(row);
  const after = row.lastReconcileAt ?? clicked;
  return RECONCILE_LOOKS_MS.map((offset) => clicked + offset).find((at) => at > after) ?? null;
}

/** Whether a read now is one of the drain's looks — the next one is due —
 *  rather than one another drain made between two of them. */
export function lookDue(row: Parameters<typeof nextReconcileAt>[0], now: number): boolean {
  const next = nextReconcileAt(row);
  return next !== null && now >= next;
}

/** Whether the owner is asked about this open send: always, for a kind not
 *  read first; for the others, once its looks give up. */
export function askOwner(row: OpenSend, now: number): boolean {
  if (!READ_BEFORE_ASKING.includes(row.kind)) return true;
  return (
    row.statusReason === RECONCILE_EXHAUSTED ||
    row.reconcileAttempts >= RECONCILE_ASK_OWNER_AFTER.reads ||
    now - clickedAt(row) >= RECONCILE_ASK_OWNER_AFTER.sinceClickMs ||
    nextReconcileAt(row) === null
  );
}

/** {@link askOwner}'s "not yet", over an `actions` row aliased
 *  `action` in raw SQL: an open send whose looks go on. */
export function stillReadingSql(): SQL {
  const clicked = sql`coalesce(
    (select (attempt->>'startedAt')::bigint
     from jsonb_array_elements(action.attempts) attempt
     where attempt->>'operationId' = action.fence_token
     limit 1),
    action.submitted_at,
    action.updated_at)`;
  return sql`(
    action.status = 'uncertain'
    and action.kind in (${sql.join(
      READ_BEFORE_ASKING.map((kind) => sql`${kind}`),
      sql`, `,
    )})
    and action.status_reason is distinct from ${RECONCILE_EXHAUSTED}
    and action.reconcile_attempts < ${RECONCILE_ASK_OWNER_AFTER.reads}
    and ${clicked} > (extract(epoch from now()) * 1000)::bigint - ${RECONCILE_ASK_OWNER_AFTER.sinceClickMs}
    and coalesce(action.last_reconcile_at, ${clicked}) < ${clicked} + ${RECONCILE_LOOKS_MS.at(-1)!})`;
}
