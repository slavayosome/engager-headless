import { eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  discoveredPosts,
  incomingComments,
  messages,
  roomMembers,
  type ActionRow,
  type ActionTarget,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { closedPeople } from "../conversations/read";
import { readRoomReplySource } from "../rooms/replySource";
import { approveAction } from "./approval";
import { ActionLedgerError } from "./errors";
import { reserveAction } from "./ledger";
import { likeTargetFor } from "./likeTarget";
import { notPermitted, pressCampaign, type CampaignWords } from "./ownerPress";
import { currentGeneration } from "./pause";

/**
 * A LIKE THE OWNER PRESSED — Like post on their post, Like reply on their
 * reply under our comment, Like on their comment in a room they were spotted
 * in, from the person's thread (INV-1, INV-27). The press
 * is the owner's yes: one `like_target` row through the ledger's one door
 * (`reserveAction`, which re-reads every Stop on the account and the campaign
 * and the person's exclusion), `origin: owner`, approved by the press. The
 * dispatch gate then does for it what it does for any approved like: re-reads
 * every guard, spaces it and never caps it, reads a reply back before the
 * click, and reads the control's pressed state, never toggling a like off
 * (`likeTarget.ts`).
 *
 * The action target is the server's, never the page's: it is built from the rows the
 * thread was read from, through `likeTargetFor`, so it is the action target a
 * worker's Like would aim at and the reaction key is the same one. One like
 * per campaign: one already waiting for a yes is approved by the press, one on
 * its way, done or unsure is left as it stands, and one that never reached its
 * click — skipped, stopped, blocked or settled not sent — is the same action
 * taken up again.
 */

/** What a thread's like is on: their post, their reply under our comment, or
 *  their comment in the room, by the room member the thread read it from. */
export type LikeSubject =
  | { kind: "post"; discoveredPostId: number }
  | { kind: "reply"; incomingCommentId: number }
  | { kind: "room_comment"; roomMemberId: number };

/** The like a press asks for, as the gate holds it: the account, the campaign
 *  it goes out under, the person whose exclusion it meets, and the action target. */
export type OwnerLikeInput = {
  channelId: number;
  campaignId: number;
  authorProfileId: string | null;
  target: ActionTarget;
};

/** What the press came to: queued for the gate by this press, or the like
 *  that already stood on the action target, as it stands. */
export type OwnerLikeOutcome = {
  state: "liking" | "liked" | "checking";
  action: ActionRow;
};

/** What a like says when its campaign cannot send. */
const LIKE_WORDS: CampaignWords = {
  none: ["This belongs to no campaign, so Engager likes nothing here.", "Like it on LinkedIn."],
  archived: "Like it on LinkedIn.",
};

/** Refused where the person's conversation is closed: the like would reach
 *  someone the conversation was closed on. The ledger reads the conversation only
 *  when it is handed one, and the owner's like rides none. */
async function assertOpenTo(tx: Tx, author: string | null): Promise<void> {
  if (author && (await closedPeople(tx, [author])).has(author)) {
    throw notPermitted(
      "Your conversation with them is closed, so nothing goes out to them from here.",
      "Reopen them first, or like it on LinkedIn.",
    );
  }
}

/** What a refused room comment says in a like's words, where the room's own
 *  refusal is written for a reply. The rest read the same for either. */
const ROOM_LIKE_WORDS: Readonly<Record<string, string>> = {
  room_author_not_eligible: "That comment is not from another person, so there is nothing to like.",
  room_account_unavailable: "Reconnect the LinkedIn account first.",
};

/**
 * Their comment in a room, as a like of it is aimed: the exact comment the room
 * shows them by, resolved as a reply to it would be (`readRoomReplySource` —
 * the author, the evidence still current and not skipped, the person not
 * excluded), and only for someone who fits. Their profile id travels with it,
 * which is what makes the confirmed like contact with them
 * (`roomContactSql`).
 */
async function roomCommentTarget(tx: Tx, roomMemberId: number): Promise<OwnerLikeInput> {
  const [member] = await tx
    .select({ fit: roomMembers.fit, comments: roomMembers.comments, evidenceRefs: roomMembers.evidenceRefs })
    .from(roomMembers)
    .where(eq(roomMembers.id, roomMemberId));
  if (!member) throw new ActionLedgerError("action_not_found", "Person not found in the room.", "Reload the person.");
  // The comment the room shows them by (`rooms/read.ts`).
  const comment = member.comments.find((entry) => member.evidenceRefs.includes(entry.ref)) ?? member.comments[0];
  if (member.fit !== "fits" || !comment) {
    throw notPermitted("Engager likes a room comment only from someone who fits.", "Like it on LinkedIn.");
  }
  const source = await readRoomReplySource(
    tx,
    { roomMemberId, parentCommentUrn: comment.commentUrn },
    { selectedBy: "owner" },
  ).catch((error: unknown) => {
    throw error instanceof AppError && error.code.startsWith("room_")
      ? notPermitted(ROOM_LIKE_WORDS[error.code] ?? error.message, "Like it on LinkedIn.")
      : error;
  });
  await assertOpenTo(tx, source.profileId);
  const campaign = await pressCampaign(tx, source.campaignId, LIKE_WORDS);
  return {
    channelId: campaign.channelId,
    campaignId: campaign.id,
    authorProfileId: source.profileId,
    target: likeTargetFor("room_comment", {
      postUrn: source.postUrn,
      reply: null,
      repliedTo: null,
      roomComment: { urn: source.parentCommentUrn, authorProfileId: source.profileId },
    })!,
  };
}

/**
 * What a press on a thread likes, read from the rows the thread was built on:
 * their post by its urn; their reply by its own urn, under our comment, by the
 * person and in the words the last read of it showed; their comment in a room
 * by the room member that read it. Refused, with why, where no like can be
 * aimed: a reply LinkedIn shows deleted, one not under our comment, one whose
 * author no read named, a room comment of someone who does not fit or was
 * skipped — and any whose author's conversation is closed, on the
 * do-not-engage list or not.
 */
export async function ownerLikeTarget(tx: Tx, subject: LikeSubject): Promise<OwnerLikeInput> {
  if (subject.kind === "room_comment") return roomCommentTarget(tx, subject.roomMemberId);
  if (subject.kind === "post") {
    const [post] = await tx
      .select({
        postUrn: discoveredPosts.postUrn,
        author: discoveredPosts.authorProfileId,
        campaignId: discoveredPosts.campaignId,
      })
      .from(discoveredPosts)
      .where(eq(discoveredPosts.id, subject.discoveredPostId));
    if (!post) throw new ActionLedgerError("action_not_found", "Post not found.", "Reload the person.");
    await assertOpenTo(tx, post.author || null);
    const campaign = await pressCampaign(tx, post.campaignId, LIKE_WORDS);
    return {
      channelId: campaign.channelId,
      campaignId: campaign.id,
      authorProfileId: post.author || null,
      target: likeTargetFor("post", { postUrn: post.postUrn, reply: null, repliedTo: null })!,
    };
  }
  const [reply] = await tx
    .select({ reply: incomingComments, ours: messages.externalUrn, oursCampaignId: messages.campaignId })
    .from(incomingComments)
    .leftJoin(messages, eq(messages.id, incomingComments.parentMessageId))
    .where(eq(incomingComments.id, subject.incomingCommentId));
  if (!reply) throw new ActionLedgerError("action_not_found", "Reply not found.", "Reload the person.");
  const incoming = reply.reply;
  if (incoming.removedAt !== null) {
    throw notPermitted("This reply was deleted on LinkedIn, so there is nothing to like.", "Nothing to do.");
  }
  const target =
    incoming.source === "our_comment_thread" && incoming.authorProfileId
      ? likeTargetFor("their_reply", {
          postUrn: incoming.ownPostUrn,
          reply: { urn: incoming.commentUrn, authorProfileId: incoming.authorProfileId, textHash: incoming.textHash },
          repliedTo: incoming.threadParentUrn ?? reply.ours,
        })
      : null;
  if (!target) {
    throw notPermitted(
      "Engager likes only a reply under your comment, from someone a read named.",
      "Like it on LinkedIn.",
    );
  }
  await assertOpenTo(tx, incoming.authorProfileId);
  const campaign = await pressCampaign(tx, incoming.campaignId ?? reply.oursCampaignId, LIKE_WORDS);
  return {
    channelId: campaign.channelId,
    campaignId: campaign.id,
    authorProfileId: incoming.authorProfileId,
    target,
  };
}

/** What a refused reservation means to the owner. */
function refused(reason: string): ActionLedgerError {
  if (reason === "excluded") {
    return notPermitted(
      "They are on your do-not-engage list.",
      "Nothing reaches them from this account until you lift it on the Channel's blocklist.",
    );
  }
  if (reason.startsWith("paused:") || reason.startsWith("superseded:")) {
    return new ActionLedgerError("action_stopped", "A Stop holds this.", "Resume it first.");
  }
  return notPermitted(`Engager will not like it now: ${reason.replaceAll("_", " ")}.`, "Like it on LinkedIn.");
}

/** Where a like already on the action target stands, as the press reports it. */
const STANDING: Partial<Record<ActionRow["status"], OwnerLikeOutcome["state"]>> = {
  approved: "liking",
  reserved: "liking",
  dispatching: "liking",
  confirmed: "liked",
  uncertain: "checking",
};

export async function ownerLike(
  tx: Tx,
  input: OwnerLikeInput & { by: string; now?: number },
): Promise<OwnerLikeOutcome> {
  const now = input.now ?? Date.now();
  const reserved = await reserveAction(tx, {
    channelId: input.channelId,
    campaignId: input.campaignId,
    conversationId: null,
    authorProfileId: input.authorProfileId,
    kind: "like_target",
    purpose: "reaction",
    target: input.target,
    candidate: { text: null, sources: [], versions: { strategy: null, facts: [], memory: null, voice: null } },
    origin: "owner",
    mode: "review",
    generationSeen: await currentGeneration(tx),
    retakeUnclicked: true,
    now,
  });
  if (reserved.status === "refused") throw refused(reserved.reason);
  const standing = reserved.status === "duplicate" ? STANDING[reserved.action.status] : undefined;
  if (standing) return { state: standing, action: reserved.action };
  // Reserved by this press, or a like waiting for a yes: the press is it.
  const { action } = await approveAction(tx, { id: reserved.action.id, approver: input.by, now });
  return { state: "liking", action };
}
