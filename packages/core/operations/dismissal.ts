import { and, eq } from "drizzle-orm";
import {
  campaigns,
  incomingComments,
  messages,
  type ActionTarget,
  type Campaign,
  type IncomingComment,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ActionLedgerError } from "../actions/errors";
import { reserveAction } from "../actions/ledger";
import { likeTargetFor, sendLikeBinding } from "../actions/likeTarget";
import { ownerLike } from "../actions/ownerLike";
import { currentGeneration } from "../actions/pause";
import type { DismissedBy } from "./messages";

export type DismissResult = {
  dismissed: boolean;
  /** The `like_target` action the acknowledgement was queued as. The gate
   *  sends it, or waits for a yes where Like reply is Ask me. */
  likeActionId?: number;
  note?: string;
};

/** What a dismissal here records for its Undo (`undoDontReply`). It only ever
 *  dismisses a `new` reply with no reply of ours to withdraw: one already
 *  drafted for is refused, and is Don't reply's to let go. */
function dismissedFromNew(by: DismissedBy) {
  return {
    dismissedAt: Date.now(),
    dismissedFrom: "new",
    dismissedReplyId: null,
    dismissedReplyVersion: null,
    dismissedBy: by,
  } as const;
}

/**
 * What an acknowledgement like of this reply aims at: the reply itself under
 * a comment of ours (read back before the click), else the other person's
 * comment on our post.
 */
function dismissalLikeTarget(incoming: IncomingComment, oursUrn: string | null): ActionTarget | null {
  const repliedTo = incoming.threadParentUrn ?? oursUrn;
  if (incoming.source === "our_comment_thread" && incoming.authorProfileId && repliedTo) {
    return likeTargetFor("their_reply", {
      postUrn: incoming.ownPostUrn,
      reply: { urn: incoming.commentUrn, authorProfileId: incoming.authorProfileId, textHash: incoming.textHash },
      repliedTo,
    });
  }
  return likeTargetFor("room_comment", {
    postUrn: incoming.ownPostUrn,
    reply: null,
    repliedTo: null,
    roomComment: {
      urn: incoming.commentUrn,
      authorProfileId: incoming.authorProfileId || null,
      ...(incoming.threadParentUrn ? { parentUrn: incoming.threadParentUrn } : {}),
    },
  });
}

/**
 * Queue the acknowledgement like of a dismissed reply as a `like_target`
 * action. The owner's own press is the owner's — approved by it, only spaced;
 * what the agent decides is Like reply's to allow and the account's like
 * ceiling's to count, at the gate (`execution/actionGate.ts`).
 */
async function queueDismissalLike(
  tx: Tx,
  incoming: IncomingComment,
  campaign: Campaign | null,
  by: DismissedBy,
): Promise<Pick<DismissResult, "likeActionId" | "note">> {
  if (!campaign) return { note: "like skipped: no campaign to attribute it to" };
  if (campaign.channelId === null) return { note: "like blocked: channel_row_missing" };
  const [ours] =
    incoming.parentMessageId === null
      ? []
      : await tx.select({ urn: messages.externalUrn }).from(messages).where(eq(messages.id, incoming.parentMessageId));
  const target = dismissalLikeTarget(incoming, ours?.urn ?? null);
  if (!target) return { note: "like skipped: there is nothing to aim it at" };
  const authorProfileId = incoming.authorProfileId || null;
  if (by === "owner") {
    try {
      const pressed = await ownerLike(tx, {
        channelId: campaign.channelId,
        campaignId: campaign.id,
        authorProfileId,
        target,
        by: "owner:dismissal",
      });
      return { likeActionId: pressed.action.id };
    } catch (error) {
      if (error instanceof ActionLedgerError) return { note: `like blocked: ${error.message}` };
      throw error;
    }
  }
  const bound = await sendLikeBinding(tx, campaign, "reply");
  if (!bound) return { note: "like blocked: like_off" };
  const reserved = await reserveAction(tx, {
    channelId: campaign.channelId,
    campaignId: campaign.id,
    conversationId: null,
    authorProfileId,
    actionBindingId: bound.binding.action_binding_id,
    kind: "like_target",
    purpose: "reaction",
    target,
    candidate: { text: null, sources: [], versions: { strategy: bound.version, facts: [], memory: null, voice: null } },
    mode: bound.binding.effective === "auto" ? "auto" : "review",
    generationSeen: await currentGeneration(tx),
  });
  if (reserved.status === "refused") return { note: `like blocked: ${reserved.reason}` };
  return {
    likeActionId: reserved.action.id,
    ...(reserved.status === "duplicate" ? { note: "like already queued" } : {}),
  };
}

/**
 * Dismiss an incoming comment (status='dismissed' — a JUDGED "no reply
 * needed", vs 'ignored' which is policy-declined) with an optional
 * acknowledgment like on the comment. Shared by the owner's Like & dismiss
 * and processIncoming's server-side closer triage so both loops behave
 * identically. Database only: the like is queued, never pressed here.
 *
 * The like is best-effort: every miss (no campaign, shadow mode, Like reply
 * Off, a Stop) is reported in `note` but NEVER un-dismisses.
 */
export async function dismissIncoming(
  tx: Tx,
  opts: {
    incomingCommentId: number;
    like: boolean;
    /** Preferred attribution; falls back to the reply's campaign, then the
     *  lowest-id active campaign. */
    campaign?: Campaign | null;
    /** Who let the reply go, recorded for its Undo. */
    by: DismissedBy;
  },
): Promise<DismissResult> {
  // Always authorize from a locked current row. Callers may have loaded the
  // reply for display earlier; it is not a transition token.
  const [incoming] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, opts.incomingCommentId))
    .for("update");
  if (!incoming) return { dismissed: false, note: "incoming comment not found" };
  if (incoming.status === "dismissed") return { dismissed: true, note: "already dismissed" };
  if (incoming.status === "replied" || incoming.status === "reply_proposed") {
    return { dismissed: false, note: `already ${incoming.status} — a reply exists; nothing to dismiss` };
  }
  if (incoming.status !== "new") {
    return { dismissed: false, note: `incoming comment is ${incoming.status}; nothing to dismiss` };
  }
  await tx
    .update(incomingComments)
    .set({ status: "dismissed", ...dismissedFromNew(opts.by) })
    .where(and(eq(incomingComments.id, incoming.id), eq(incomingComments.status, "new")));
  if (!opts.like) return { dismissed: true };
  let campaign = opts.campaign;
  if (campaign === undefined) {
    [campaign] = incoming.campaignId
      ? await tx.select().from(campaigns).where(eq(campaigns.id, incoming.campaignId))
      : [];
    if (!campaign) {
      [campaign] = await tx.select().from(campaigns).where(eq(campaigns.status, "active")).orderBy(campaigns.id).limit(1);
    }
  }
  return { dismissed: true, ...(await queueDismissalLike(tx, incoming, campaign ?? null, opts.by)) };
}
