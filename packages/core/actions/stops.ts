import { and, desc, eq, isNull, or } from "drizzle-orm";
import { conversations, pauseControls } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * THE STOP ON EVERY SEND, NOT ONLY THE LEDGER'S (INV-29; spec §01 R02: "while
 * paused, no actionable candidates or sends can be created").
 *
 * The `messages` path — a comment, a reply, a companion like — reads this from
 * `canEngage`, and the reply lane before it drafts, against three scopes: the
 * account, the campaign, and the conversation with the person the send is to
 * (their open conversation on the account). A Stop holds every send in its scope,
 * the owner's included, the way the kill switch does. A takeover holds only
 * the workers': it is the owner taking the conversation, and their own words
 * in it are exactly what it is for.
 *
 * Pure reads; the ledger's own gate reads the same rows and its generation
 * besides (`execution/actionGate.ts`).
 */
export async function scopedStop(
  tx: Tx,
  input: {
    channelId: number;
    /** Null for an owner's act that rides no campaign: only the account's and
     *  the conversation's Stop hold it. */
    campaignId: number | null;
    profileId?: string | null;
    origin: "owner" | "worker";
  },
): Promise<string | null> {
  const [conversation] = input.profileId
    ? await tx
        .select({ id: conversations.id, opsStatus: conversations.opsStatus })
        .from(conversations)
        .where(
          and(
            eq(conversations.channelId, input.channelId),
            eq(conversations.authorProfileId, input.profileId),
            isNull(conversations.closedReason),
          ),
        )
    : [];
  if (conversation?.opsStatus === "human_owned" && input.origin === "worker") return "human_owned";
  const open = await tx
    .select({ scope: pauseControls.scope, reason: pauseControls.reason })
    .from(pauseControls)
    .where(
      and(
        isNull(pauseControls.resumedAt),
        or(
          and(eq(pauseControls.scope, "account"), eq(pauseControls.scopeId, input.channelId)),
          ...(input.campaignId === null
            ? []
            : [and(eq(pauseControls.scope, "campaign"), eq(pauseControls.scopeId, input.campaignId))]),
          ...(conversation
            ? [and(eq(pauseControls.scope, "conversation"), eq(pauseControls.scopeId, conversation.id))]
            : []),
        ),
      ),
    )
    .orderBy(desc(pauseControls.generation));
  const holding = open.find((pause) => pause.reason !== "takeover" || input.origin === "worker");
  return holding ? `stopped:${holding.scope}:${holding.reason}` : null;
}
