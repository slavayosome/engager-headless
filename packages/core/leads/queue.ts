import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { isUntouchedOffer } from "@engager/common/text-provenance";
import {
  actions,
  campaigns,
  channels,
  discoveredPosts,
  conversations,
  messages,
  roomReplyDrafts,
  type Campaign,
  type LeadSignalRow,
  type Message,
  type ScoutIntent,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { pressOwnerInvite } from "../actions/ownerInvite";
import { lockPauses } from "../actions/pause";
import { LEAD_OPENER_POST } from "../candidates/status";
import { boxKey } from "../composer/drafts";
import { CATALOG_STEPS, CEILING_INTENTS, type ActionMode, type CapabilityId, type CatalogStepId, type TargetType } from "../strategy/catalog";
import { openerModeFor } from "../strategy/resolve";
import { modeFor } from "../strategy/mode";
import { openLeadConversation } from "../conversations/record";
import { saveOwnerComment, type SaveOwnerCommentOutcome } from "../operations/clientDrafting";
import { queueRoomReplyDraft, saveRoomReplyDraft } from "../operations/roomReply";
import { personKey } from "../people/key";
import { lockEngagementSafety } from "../ratelimit/killswitch";
import { lockRoomEvidence } from "../rooms/eligibility";
import { roomReplyDraftKey, roomReplyKey } from "../rooms/replySource";
import { awaitsOpener, takesWords } from "./read";
import { leadTurnedAway, readLeadReplySource } from "./replySource";
import { leadStandings } from "./scout/eligibility";
import { leadDraftTexts, leadOpener, type LeadOpener } from "./scout/opener";

/**
 * THE OPENER, QUEUED FROM LEADS: the owner's first words to someone Find
 * leads found, pressed from their box (`lead:<id>`) and saved through the
 * Ambassador step the move belongs to — a comment on their own post through
 * Comment on posts, a reply under their comment through Meet the room, an
 * invite with a note through Connect. A reply's send reads its comment from
 * the signal Scout kept of it, as a room's reads its room (`replySource.ts`).
 *
 * Queueing is not sending. Each save is the one the Inbox makes for its kind
 * (`saveOwnerComment`, the room reply's save and queue, `pressOwnerInvite`),
 * so authorship is that kind's own: the agent's words saved untouched go out
 * as worker and capped, the owner's edit or their own words as theirs —
 * a reply's edit that keeps half or more of the agent's words stays assisted
 * and capped — and an invite from the owner's box is theirs. Every agent text
 * the lead's box offered is added here, on the server, to what the save is
 * measured against, whatever the page sent. Every send then goes through
 * `canEngage()` and the exactly-once path at its slot. Someone already reached
 * who has not answered — Contacted, No answer — may be followed up on a move
 * still open to them: a comment on their post while none of ours is on it, a
 * reply under their comment while none of ours is, an invite while none of
 * ours is pending, sent or on its way (`movesStillOpen`). Nothing is queued
 * for someone out of reach (Never engage, erased, excluded, a conversation the
 * owner closed), for someone reached on that move or who answered, for anyone
 * the page no longer offers — Research read them as other than a buyer, the
 * owner rated them a peer or not a fit, or set them aside — or on a move
 * whose step the campaign has Off. Those are asked again here because they
 * can change while a press is open: Qualify may judge the person a peer after
 * the owner opened their box.
 */

export const OPENER_MOVES = ["comment", "reply", "invite"] as const;
export type OpenerMove = (typeof OPENER_MOVES)[number];

/** The step each move goes out through, and the action of it that sends. */
export const MOVE_STEP: Record<OpenerMove, { step: CatalogStepId; capability: CapabilityId; target: TargetType }> = {
  comment: { step: "comment_on_posts", capability: "publish_comment", target: "post" },
  reply: { step: "meet_the_room", capability: "reply_to_comment", target: "room_comment" },
  invite: { step: "connect", capability: "send_invitation", target: "person" },
};

/** The step's name, as the opener's toggle says one is Off. */
export const moveStepLabel = (move: OpenerMove): string => CATALOG_STEPS[MOVE_STEP[move].step].label;

/** The public move their words allow: a comment on their own post, a reply
 *  under their comment on someone else's. */
export const publicMove = (signal: Pick<LeadSignalRow, "kind">): "comment" | "reply" =>
  signal.kind === "post" ? "comment" : "reply";

/** The action each move sends through, as the campaign resolves it now. */
/**
 * The mode each move's step sends at, as the owner set it in the campaign —
 * or, `effective`, as it resolves now, under the account's ceilings and a
 * first send still pending: what a step does on its own; null where the
 * campaign has no such step. Off means the step is not to reach anyone, and
 * the opener does not offer it.
 */
/**
 * The mode an opener goes out at to someone of each intent: the Comment
 * step's mode held to that intent's ceiling
 * (`openerModeFor`), so a cap that lowers the step lowers every intent with
 * it. What Ambassador writes on its own reads this per lead; the owner's own
 * press from Leads reads the step's mode alone.
 */
export async function openerIntentModes(
  tx: Tx,
  campaignId: number,
  read: "requested" | "effective" = "effective",
): Promise<Record<ScoutIntent, ActionMode>> {
  const comment = await modeFor(tx, { campaignId, capability: "publish_comment", target: "post", catalogStep: "comment_on_posts" });
  return Object.fromEntries(CEILING_INTENTS.map((intent) => [intent, openerModeFor(comment, intent, read)])) as Record<
    ScoutIntent,
    ActionMode
  >;
}

/** Whether a reply of ours under this comment, by its key, is queued, going
 *  out, out or unsure. One that went back to a draft, or did not post, is not
 *  used up. */
async function replyUsed(tx: Tx, key: string): Promise<boolean> {
  const [sent] = await tx.select({ status: messages.status }).from(messages).where(eq(messages.dedupeKey, key));
  return sent !== undefined && ["approved", "posting", "posted", "needs_review"].includes(sent.status);
}

/** The ways that are not used up on someone already reached: a comment on
 *  their own post while no comment of ours is on it, a reply under their
 *  comment while none of ours is queued, out or unsure on it (one reply per
 *  comment per account), an invite while no invite of ours is pending, sent or
 *  on its way and they are not connected. The ledger takes up an invite settled
 *  not sent for the owner's press; one the owner skipped or the gate blocked it
 *  refuses over as a duplicate (`reserveAction`), so those keep the invite
 *  used. */
export async function movesStillOpen(
  tx: Tx,
  opener: Pick<LeadOpener, "lead" | "signal">,
  channelId: number | null,
): Promise<Record<OpenerMove, boolean>> {
  const { lead, signal } = opener;
  const person = lead.profileId;
  const commented = async () =>
    (
      await tx
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(discoveredPosts, eq(discoveredPosts.id, messages.discoveredPostId))
        .where(and(eq(discoveredPosts.postUrn, signal.postUrn), eq(messages.kind, "comment"), sql`${messages.status} <> 'rejected'`))
        .limit(1)
    ).length > 0;
  const replied = async (account: number) => {
    if (signal.commentUrn === null) return false;
    const [channel] = await tx.select({ account: channels.externalAccountId }).from(channels).where(eq(channels.id, account));
    const accountProfileId = channel?.account?.trim();
    if (!accountProfileId) return false;
    return replyUsed(tx, roomReplyKey({ accountProfileId, postUrn: signal.postUrn, parentCommentUrn: signal.commentUrn }));
  };
  const invited = async (account: number) =>
    (
      await tx
        .select({ id: actions.id })
        .from(actions)
        .where(
          and(
            eq(actions.channelId, account),
            eq(actions.authorProfileId, person),
            eq(actions.kind, "invite"),
            ne(actions.status, "definitely_not_sent"),
          ),
        )
        .limit(1)
    ).length > 0;
  const connected = async (account: number) =>
    (
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.channelId, account),
            eq(conversations.authorProfileId, person),
            inArray(conversations.relationship, ["connected", "outgoing_pending", "incoming_pending"]),
          ),
        )
        .limit(1)
    ).length > 0;
  return {
    comment: publicMove(signal) === "comment" && !(await commented()),
    reply: publicMove(signal) === "reply" && !(channelId !== null && (await replied(channelId))),
    // An invite goes out on an account.
    invite: channelId !== null && !(await invited(channelId)) && !(await connected(channelId)),
  };
}

/** The words a save carries, and what the page says the owner's box showed. */
export type OpenerWords = { text: string; assistTexts?: readonly string[]; ownerWords?: readonly string[]; by: string };

const refused = (code: string, message: string) => new AppError(code, message, 409);
const reached = () => refused("lead_reached", "Something already went out to them that way. Wait for their answer.");

/**
 * What a save is measured against: every text the box offered, as the server
 * holds them and as the page says it showed them, and what the owner typed —
 * less any of those texts, which no one typed. A page that sent the agent's
 * draft among the owner's words would otherwise rescue it as theirs
 * (`isAssisted`), and an untouched draft would go out uncapped.
 */
function measuredWords(input: OpenerWords, boxOffered: readonly string[]) {
  const assistTexts = [...boxOffered, ...(input.assistTexts ?? [])];
  return { assistTexts, ownerWords: (input.ownerWords ?? []).filter((typed) => !isUntouchedOffer(typed, assistTexts)) };
}

/** The opener as it may be queued now, for a move: the person in reach, not
 *  yet reached, still a buyer the owner has not turned away, and their
 *  campaign's step for it not Off. */
async function queueable(
  tx: Tx,
  leadId: number,
  move: OpenerMove,
  now: number,
  signalId?: number,
): Promise<{ opener: LeadOpener; campaign: Campaign; assistTexts: string[] }> {
  // Safety, pauses, then the room's evidence: the order every reply save,
  // queue and send takes them in (`operations/roomReply.ts`), so a press here
  // and a room reply's cannot each hold the lock the other waits for. The
  // evidence lock is the one Never engage takes: an exclusion lands before
  // this or after it.
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  await lockRoomEvidence(tx);
  const opener = await leadOpener(tx, leadId, now, signalId);
  if (!opener) throw refused("lead_not_found", "This lead is gone, or has no words to answer.");
  const { lead } = opener;
  // Someone reached who has not answered may be followed up; anyone further on is the Inbox's.
  const followUp = !awaitsOpener(lead);
  if (!takesWords(lead)) throw reached();
  const turnedAway = await leadTurnedAway(tx, lead);
  if (turnedAway) throw turnedAway;
  const [standing] = await leadStandings(tx, lead.campaignId!, [lead.id]);
  if (!standing?.eligible) throw refused("lead_out_of_reach", "Engager does not contact this person.");
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, lead.campaignId!));
  if (!campaign || campaign.status === "archived") throw refused("campaign_unavailable", "This lead's campaign cannot send.");
  if (followUp && !(await movesStillOpen(tx, opener, campaign.channelId))[move]) throw reached();
  const target = MOVE_STEP[move];
  const mode = (await modeFor(tx, { campaignId: campaign.id, capability: target.capability, target: target.target, catalogStep: target.step })).effective ?? "off";
  if (mode === null || mode === "off") {
    throw refused("move_off", `${moveStepLabel(move)} is ${mode === "off" ? "Off in" : "not in"} this campaign.`);
  }
  return { opener, campaign, assistTexts: await leadDraftTexts(tx, leadId) };
}

/**
 * The post their words are on, as a `discovered_posts` row of the lead's
 * campaign — the row a comment is saved on. The first move that needs it
 * writes it, born `drafted` and marked as a lead's (`LEAD_OPENER_POST`): no
 * Find posts stage reads such a row, a campaign that finds leads runs none,
 * and the pool's counts and lists skip it. A post another campaign already
 * holds is that campaign's, and the comment is queued from there.
 */
export async function leadPost(tx: Tx, opener: LeadOpener, campaignId: number): Promise<number> {
  const { lead, signal } = opener;
  await tx
    .insert(discoveredPosts)
    .values({
      campaignId,
      postUrn: signal.postUrn,
      authorProfileId: lead.profileId,
      authorName: lead.name,
      authorHeadline: lead.headline,
      url: signal.url,
      contentText: signal.words,
      postedAt: signal.saidAt,
      status: "drafted",
      filterReason: LEAD_OPENER_POST,
    })
    .onConflictDoNothing();
  const [post] = await tx
    .select({ id: discoveredPosts.id, campaignId: discoveredPosts.campaignId })
    .from(discoveredPosts)
    .where(eq(discoveredPosts.postUrn, signal.postUrn));
  if (!post || post.campaignId !== campaignId) {
    throw refused("post_in_other_campaign", "Another campaign holds this post. Comment on it from that campaign.");
  }
  return post.id;
}

/** Queue a comment on their own post, the owner's save on it. The post is
 *  the one the box showed (`signalId`): words written for one post of theirs
 *  are never queued on another that landed since. */
export async function queueLeadComment(
  tx: Tx,
  input: OpenerWords & { leadId: number; signalId: number; now?: number },
): Promise<SaveOwnerCommentOutcome> {
  const now = input.now ?? Date.now();
  const { opener, campaign, assistTexts } = await queueable(tx, input.leadId, "comment", now, input.signalId);
  if (opener.signal.id !== input.signalId) {
    throw refused("comment_target_changed", "Review the recipient and exact post again before sending.");
  }
  if (publicMove(opener.signal) !== "comment") throw refused("move_not_offered", "Their words are a comment, not a post of theirs.");
  const discoveredPostId = await leadPost(tx, opener, campaign.id);
  return saveOwnerComment(tx, campaign, {
    discoveredPostId,
    text: input.text,
    ...measuredWords(input, assistTexts),
    box: boxKey({ kind: "lead", leadId: input.leadId, signalId: input.signalId }),
  });
}

/**
 * Queue a reply under their comment: the room reply's save, on the signal that
 * holds their comment, and its queue, at once. The comment is the one the box
 * showed (`signalId`), read again at each (`readLeadReplySource`), and again
 * at send. One reply per comment per account: a reply already on its way or
 * out is refused, never replaced.
 */
export async function queueLeadReply(
  tx: Tx,
  input: OpenerWords & { leadId: number; signalId: number; now?: number },
): Promise<Message> {
  const now = input.now ?? Date.now();
  const { opener, assistTexts } = await queueable(tx, input.leadId, "reply", now, input.signalId);
  // The press names the comment the box was drawn for. Words written for one
  // comment are never queued under another that landed since.
  if (opener.signal.id !== input.signalId) {
    throw refused("room_reply_target_changed", "Review the recipient and exact comment again before sending.");
  }
  if (publicMove(opener.signal) !== "reply") throw refused("move_not_offered", "Their words are a post of theirs, not a comment.");
  const source = await readLeadReplySource(tx, opener.signal.id, { now });
  if (await replyUsed(tx, roomReplyKey(source))) throw refused("reply_queued", "You already have a reply to this comment.");
  // The press is the owner's yes to the words in the box: it saves over what
  // an earlier press left, and queues exactly that.
  const [held] = await tx
    .select({ revision: roomReplyDrafts.revision })
    .from(roomReplyDrafts)
    .where(eq(roomReplyDrafts.targetKey, roomReplyDraftKey(source.campaignId, roomReplyKey(source))));
  const words = measuredWords(input, assistTexts);
  const draft = await saveRoomReplyDraft(
    tx,
    { source: "lead", signalId: opener.signal.id, text: input.text, expectedRevision: held?.revision ?? null },
    { selection: "owner", authoredByOwner: true, assist: { texts: words.assistTexts, ownerWords: words.ownerWords }, now },
  );
  return queueRoomReplyDraft(
    tx,
    { draftId: draft.id, expectedRevision: draft.revision },
    { authorization: "owner", surface: "dashboard", now },
  );
}

/**
 * Queue an invite with the owner's note, under the lead's campaign, on the
 * conversation the lead's steps act on: theirs on the account, else one opened
 * from the lead, as serving opens it — a Signal has none yet. Refused, it
 * rolls back with the caller's transaction.
 */
export async function queueLeadInvite(
  tx: Tx,
  input: OpenerWords & { leadId: number; now?: number },
): ReturnType<typeof pressOwnerInvite> {
  const now = input.now ?? Date.now();
  const { opener, campaign, assistTexts } = await queueable(tx, input.leadId, "invite", now);
  if (campaign.channelId === null) throw refused("campaign_unavailable", "This lead's campaign has no LinkedIn account.");
  await openLeadConversation(tx, {
    channelId: campaign.channelId,
    campaignId: campaign.id,
    profileId: opener.lead.profileId,
    leadId: opener.lead.id,
    now,
  });
  return pressOwnerInvite(tx, {
    personKey: personKey({ profileId: opener.lead.profileId })!,
    campaignId: campaign.id,
    note: input.text,
    by: input.by,
    ...measuredWords(input, assistTexts),
    now,
  });
}
