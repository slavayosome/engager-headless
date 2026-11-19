import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { discoveredPosts, roomMembers } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { ownerLike, ownerLikeTarget, type LikeSubject } from "../../../actions/ownerLike";
import { scopedStop } from "../../../actions/stops";
import { lockPauses } from "../../../actions/pause";
import { getSystemState, lockEngagementSafety } from "../../../ratelimit/killswitch";
import { sendOwnerDm } from "../../../actions/ownerDm";
import { pressOwnerInvite } from "../../../actions/ownerInvite";
import { withdrawInvite } from "../../../actions/withdrawInvite";
import { COMMENT_LENGTH_LIMIT } from "../../../commentLength";
import { landedJudged } from "../../../dispatcher/landedJudge";
import { ownerAccept } from "../../../invitations/ownerAccept";
import { saveOwnerComment, saveOwnerReply } from "../../../operations/clientDrafting";
import { getCampaign } from "../../../operations/campaigns";
import { queueRoomReplyDraft, saveRoomReplyDraft } from "../../../operations/roomReply";
import { findPerson } from "../../../people/directory";
import { readRoomReplyComposer } from "../../../rooms/replyComposer";
import { mcpOperationActor, type McpCtx } from "../../context";
import { errorResult, jsonResult } from "../../tools/util";
import { domainRefusal } from "../activity/decisions";
import { defineTool, type V2Tool } from "../define";
import { parseRef, RefKindNotAcceptedError, type Ref, type RefKind } from "../refs";

/**
 * The owner's own words, or the owner's own press, for every action that
 * reaches a person — each through the operation its button in the app calls.
 *
 * Nothing here touches the driver: a press lands a message or a ledger row and
 * the agent's drain sends it after `canEngage` and exactly-once
 * reconciliation. Who wrote the words, and so whether caps bind them, is the
 * operation's own measure against what the box offered; the input has no
 * origin, approval or authorship field to set.
 */

const KINDS = ["comment", "reply", "like", "dm", "invite", "accept", "withdraw"] as const;
type PressKind = (typeof KINDS)[number];

/** The refs each kind is pressed on. */
const ACCEPTS: Record<PressKind, readonly RefKind[]> = {
  comment: ["post"],
  reply: ["turn", "member"],
  like: ["post", "turn", "member"],
  dm: ["person"],
  invite: ["person"],
  accept: ["inv"],
  withdraw: ["person"],
};

/** The kinds whose press is the owner's words. */
const NEEDS_WORDS: ReadonlySet<PressKind> = new Set(["comment", "reply", "dm", "invite"]);

const pressInput = z.object({
  ref: z.string().describe("post: · turn: · member: · person: · inv: and its id."),
  kind: z.enum(KINDS),
  text: z.string().trim().min(1).max(3000).optional().describe("The owner's words."),
});

type Call = { ctx: McpCtx; signal: AbortSignal };

const refuse = (code: string, message: string, status = 409, recovery?: string): CallToolResult =>
  errorResult(message, { code, status, ...(recovery ? { recovery } : {}) });

/** The row id a post:, turn: or inv: ref names; parseRef admitted only those. */
function rowId(ref: Ref): number {
  if (!("id" in ref)) throw new Error(`unreachable: ${ref.kind}: carries no row id`);
  return ref.id;
}

/** A member ref names a room member by its row id. */
function memberRowId(ref: Extract<Ref, { kind: "member" }>): number | null {
  return /^[1-9]\d{0,14}$/.test(ref.memberId) ? Number(ref.memberId) : null;
}

const queued = (ref: string, kind: PressKind, more: Record<string, unknown>) =>
  jsonResult({ ok: true, ref, kind, ...more, note: "Queued; it goes out only after the send gates pass on the next drain." });

async function pressComment(tx: Tx, ref: string, id: number, text: string): Promise<CallToolResult> {
  if (text.length > COMMENT_LENGTH_LIMIT) {
    return refuse("text_too_long", `A comment is at most ${COMMENT_LENGTH_LIMIT} characters (${text.length}).`, 400);
  }
  const [post] = await tx
    .select({ campaignId: discoveredPosts.campaignId, profileId: discoveredPosts.authorProfileId })
    .from(discoveredPosts)
    .where(eq(discoveredPosts.id, id));
  const campaign = post?.campaignId == null ? null : await getCampaign(tx, post.campaignId);
  if (!campaign || campaign.channelId === null) return refuse("no_campaign", "That post belongs to no campaign, so nothing is sent from it.");
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  if ((await getSystemState(tx))?.killSwitch || await scopedStop(tx, {
    channelId: campaign.channelId, campaignId: campaign.id, profileId: post?.profileId, origin: "owner",
  })) return refuse("action_stopped", "Sending is stopped, so nothing was queued.");
  const outcome = await saveOwnerComment(tx, campaign, { discoveredPostId: id, text });
  if (outcome.kind === "duplicate") {
    return refuse("already_commented", "There is already a comment of ours on this post.", 409, "Edit that one with decide.");
  }
  const intake = outcome.result;
  if (!intake.ok) return refuse("comment_refused", intake.error, 409, intake.details?.recovery);
  const data = intake.data as { status?: string; items?: Array<{ error?: string; scheduledAt?: string }> };
  const item = data.items?.[0];
  if (item?.error) return refuse("comment_refused", item.error);
  return queued(ref, "comment", { messageId: outcome.messageId, status: data.status, scheduledAt: item?.scheduledAt ?? null });
}

async function pressReply(tx: Tx, ref: Ref, text: string): Promise<CallToolResult> {
  if (ref.kind === "turn") {
    const outcome = await saveOwnerReply(tx, { incomingCommentId: ref.id, text });
    if (outcome.kind === "answered") return refuse("already_answered", `That reply is ${outcome.status} already.`);
    if (outcome.kind === "refused") return refuse("reply_refused", outcome.error, 409, outcome.recovery);
    return queued(`turn:${ref.id}`, "reply", {
      messageId: outcome.messageId,
      status: outcome.status,
      scheduledAt: outcome.scheduledAt,
    });
  }
  if (ref.kind !== "member") throw new Error("unreachable: reply takes turn: and member:");
  const roomMemberId = memberRowId(ref);
  if (roomMemberId === null) return refuse("invalid_ref", `member:${ref.memberId} is not a room member.`, 400);
  const [member] = await tx
    .select({ comments: roomMembers.comments, evidenceRefs: roomMembers.evidenceRefs })
    .from(roomMembers)
    .where(eq(roomMembers.id, roomMemberId));
  // The comment the room shows them by (`rooms/read.ts`).
  const comment = member?.comments.find((entry) => member.evidenceRefs.includes(entry.ref)) ?? member?.comments[0];
  if (!comment) return refuse("not_found", "That room member has no comment to answer.", 404);
  const target = { roomMemberId, parentCommentUrn: comment.commentUrn };
  const held = (await readRoomReplyComposer(tx, target)).draft;
  const draft = await saveRoomReplyDraft(
    tx,
    { ...target, text, expectedRevision: held?.revision ?? null },
    { selection: "owner", authoredByOwner: true },
  );
  const message = await queueRoomReplyDraft(tx, { draftId: draft.id, expectedRevision: draft.revision }, { authorization: "owner", surface: "mcp_app" });
  return queued(`member:${ref.memberId}`, "reply", {
    messageId: message.id,
    status: message.status,
    scheduledAt: message.scheduledAt,
  });
}

async function pressLike(tx: Tx, by: string, raw: string, ref: Ref): Promise<CallToolResult> {
  let subject: LikeSubject;
  if (ref.kind === "post") subject = { kind: "post", discoveredPostId: ref.id };
  else if (ref.kind === "turn") subject = { kind: "reply", incomingCommentId: ref.id };
  else if (ref.kind === "member") {
    const roomMemberId = memberRowId(ref);
    if (roomMemberId === null) return refuse("invalid_ref", `member:${ref.memberId} is not a room member.`, 400);
    subject = { kind: "room_comment", roomMemberId };
  } else throw new Error("unreachable: like takes post:, turn: and member:");
  const { state, action } = await ownerLike(tx, {
    ...(await ownerLikeTarget(tx, subject)),
    by,
  });
  // A like already standing answers where it stands and queues nothing new.
  return jsonResult({ ok: true, ref: raw, kind: "like", state, actionId: action.id });
}

/** The conversation a person's header press acts in. */
async function conversationOf(tx: Tx, key: string): Promise<number | CallToolResult> {
  const person = await findPerson(tx, key);
  if (!person) return refuse("not_found", "No such person.", 404);
  if (person.conversationId === null) {
    return refuse("conversation_not_found", "That person has no conversation yet.", 404, "Invite them first.");
  }
  return person.conversationId;
}

async function press(call: Call, input: z.infer<typeof pressInput>): Promise<CallToolResult> {
  const { ctx } = call;
  const { kind, text } = input;
  const ref = parseRef(input.ref, ACCEPTS[kind]);
  if (!ACCEPTS[kind].includes(ref.kind)) throw new RefKindNotAcceptedError(ref.kind, ACCEPTS[kind]);
  if (NEEDS_WORDS.has(kind) && !text) return refuse("text_required", `${kind} carries the owner's words: pass them in text.`, 400);
  if (!NEEDS_WORDS.has(kind) && text !== undefined) return refuse("text_not_accepted", `${kind} takes no words.`, 400);
  const by = `owner:${mcpOperationActor(ctx)}`;
  try {
    if (text) await landedJudged(ctx.organizationId, text);
    return await withOrg(ctx.organizationId, async (tx): Promise<CallToolResult> => {
      switch (kind) {
        case "comment":
          return pressComment(tx, input.ref, rowId(ref), text!);
        case "reply":
          return pressReply(tx, ref, text!);
        case "like":
          return pressLike(tx, by, input.ref, ref);
        case "accept": {
          const { action } = await ownerAccept(tx, {
            incomingInvitationId: rowId(ref),
            campaignId: null,
            by,
          });
          return queued(input.ref, kind, { actionId: action.id, status: action.status });
        }
        case "invite": {
          const pressed = await pressOwnerInvite(tx, {
            personKey: (ref as Extract<Ref, { kind: "person" }>).key,
            campaignId: null,
            note: text!,
            by,
          });
          return "queued" in pressed
            ? queued(input.ref, kind, { waitingOn: pressed.queued })
            : queued(input.ref, kind, { actionId: pressed.action.id, status: pressed.action.status });
        }
        case "dm":
        case "withdraw": {
          const conversationId = await conversationOf(tx, (ref as Extract<Ref, { kind: "person" }>).key);
          if (typeof conversationId !== "number") return conversationId;
          const { action } =
            kind === "dm"
              ? await sendOwnerDm(tx, { conversationId, text: text!, by })
              : { action: await withdrawInvite(tx, { conversationId, by }) };
          return queued(input.ref, kind, { actionId: action.id, status: action.status });
        }
      }
    });
  } catch (error) {
    return domainRefusal(error);
  }
}

export const pressTools: readonly V2Tool[] = [
  defineTool({
    name: "act",
    kind: "linkedin",
    description:
      "Carry the owner's OWN words or press: comment, reply, like, dm, invite, accept or withdraw. Queues it; sends nothing itself. Not for your drafts (submit_draft). See engager-people.",
    input: pressInput,
    handler: async (call, input) => press(call, input),
  }),
];
