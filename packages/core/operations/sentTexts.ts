import { and, eq, gte, inArray, or } from "drizzle-orm";
import { messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { REPEATED_WINDOW_MS } from "../ai/intakeGate";

/**
 * The words the account has said lately in public: every comment and room
 * reply it posted in the last {@link REPEATED_WINDOW_MS}, and every one
 * approved or being sent (it is going out). Whoever wrote them, owner or agent:
 * an audience reads one voice. A proposal still waiting on a yes has not been
 * said, so it is not here. Pass the texts to `intakeGateViolations` as `sent`.
 *
 * Each text comes with its message id, so a caller checking a row that is
 * already there (a resubmitted draft) can leave that row out of the comparison.
 */
export async function sentTexts(
  tx: Tx,
  now: number,
): Promise<{ messageId: number; text: string }[]> {
  const rows = await tx
    .select({ id: messages.id, final: messages.finalText, proposed: messages.proposedText })
    .from(messages)
    .where(
      and(
        inArray(messages.kind, ["comment", "room_reply"]),
        or(
          inArray(messages.status, ["approved", "posting"]),
          and(eq(messages.status, "posted"), gte(messages.postedAt, now - REPEATED_WINDOW_MS)),
        ),
      ),
    );
  return rows.map((row) => ({ messageId: row.id, text: row.final ?? row.proposed }));
}
