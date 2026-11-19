import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, profileIdKey, type Message } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ActionLedgerError } from "../actions/errors";
import { requestActionRedraft } from "../actions/ledger";
import { lockPauses } from "../actions/pause";
import { scopedStop } from "../actions/stops";
import { wordsBox, type ComposerAsk, type ComposerTurn, type DraftRequest } from "../chat/requestedDraft";
import { wordsCheck } from "../dispatcher/landedJudge";
import {
  REDRAFT_STOPPED_NOTE,
  requestMessageRedraft,
  useDraftVariant,
  type AtomicMutationResult,
} from "../operations/messages";
import { resolvePersonKeys } from "../people/directory";
import { excludedRoomKeys } from "../rooms/retention";
import { getSystemState, lockEngagementSafety } from "../ratelimit/killswitch";
import { channelCeilings } from "../ratelimit/ledger";
import { requestRoomReplyDraft } from "../rooms/replyDrafting";
import { readRoomReplySource, roomReplyDraftKey, roomReplyKey } from "../rooms/replySource";
import {
  askComposerAngle,
  boxKey,
  composerFor,
  openComposerBox,
  readComposerAngle,
  shownComposerAngle,
  stillAsked,
  type AngleRef,
  type OpenBox,
} from "./drafts";

/**
 * REDRAFT ONE ANGLE, ASK FOR ONE MORE, OR ASK FOR AN IDEA'S DRAFT — the
 * presses on a composer's bar that ask for words: Redraft, which rewrites the
 * angle the owner is on and replaces its draft for good; More angles, which
 * adds a new angle with its own draft (Draft for me, on a box with none) or,
 * on a box that has angles and whose campaign finds leads, an idea: its name
 * and its line, no draft yet; and Draft, which writes the draft of one idea
 * the owner picked.
 *
 * Both ask the owner's own agent, in the chat dock, through the words-only
 * turn for the box's kind (`chat/requested*.ts`), carrying the one angle its
 * words land on (`ComposerTurn`). They approve, queue and send nothing and
 * never touch the owner's typed words: the turn's words land on that angle
 * alone (`putComposerAngle`), every other angle as it was. A worker's draft
 * waiting for a yes keeps today's Redraft, which writes it again where it
 * waits.
 *
 * Refused, before any agent is asked, wherever a yes could not send either:
 * the box closed, taken over or excluded (`openComposerBox`), its person
 * excluded from the rooms, the kill switch, or a Stop on the account, the
 * campaign or the conversation.
 */

/** The room comment an invite's note is written from: the stored room member
 *  and, where they have several comments, the exact one. */
export type InviteRoom = { roomMemberId: number; parentCommentUrn?: string };

/** One press: Redraft on an angle as the bar showed it — an agent angle by
 *  its row's position and revision, a worker's by its draft's number and the
 *  waiting draft's version — More angles on the box, or Draft on an idea, by
 *  its row's position and revision. An invite note's box opened from a room
 *  names that room (`room`), and its words are written from that comment.
 *  Fix (`fix`) is an agent angle's Redraft that takes out what its judge
 *  found unsupported in the draft. */
export type ComposerPress =
  | { box: string; kind: "redraft"; angle: AngleRef & { source: "agent" | "worker" }; fix?: true; room?: InviteRoom }
  | { box: string; kind: "more"; ideaOnly?: true; room?: InviteRoom }
  | { box: string; kind: "draft"; angle: AngleRef; room?: InviteRoom };

/** What a press asked for: the agent angle now being written, and the dock
 *  turn that writes it — neither where a worker writes its draft again on
 *  the server. */
export type ComposerAsked = { writing: AngleRef | null; turn: DraftRequest | null };

function refused(code: string, message: string): never {
  throw new AppError(code, message, 409);
}

const stale = () => refused("composer_angle_stale", "That angle changed since you read it. Read the box again.");

export async function requestComposerAngle(
  tx: Tx,
  input: ComposerPress & { by: string },
  now = Date.now(),
): Promise<ComposerAsked> {
  // Safety, pauses, then the room's evidence and the box: the order every
  // send and every delivery takes them in.
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  const box = await openComposerBox(tx, input.box);
  await refuseHeld(tx, box);
  if (input.kind === "redraft" && input.angle.source === "worker") {
    return redraftWorkerAngle(tx, box, input.angle, input.by);
  }
  // Redraft rewrites a draft and Draft writes the first: each names the angle
  // that is the one it asks for, at the revision the owner read.
  if (input.kind !== "more") {
    const asked = await shownComposerAngle(tx, box.key, input.angle.position, now);
    if (!asked || asked.revision !== input.angle.revision || (asked.state === "idea") !== (input.kind === "draft")) {
      return stale();
    }
  }
  const row = await askComposerAngle(tx, box, input.kind === "more" ? null : input.angle, now);
  const writing = { position: row.position, revision: row.revision };
  const turn = await turnFor(tx, box, {
    kind: input.kind,
    ...writing,
    ...(input.kind === "more" && input.ideaOnly ? { ideaOnly: true as const } : {}),
    ...(input.kind === "redraft" && input.fix ? { fix: true as const } : {}),
  }, input.room);
  return { writing, turn };
}

/** Someone excluded, the kill switch, or a Stop on the account, the box's
 *  campaign or the conversation with its person: what would hold the
 *  owner's yes (`candidateRefusal`) holds the ask for the words. */
async function refuseHeld(tx: Tx, box: OpenBox): Promise<void> {
  if (box.profileId !== null && (await excludedRoomKeys(tx)).has(`p.${profileIdKey(box.profileId)}`)) {
    refused("composer_box_excluded", "You chose never to engage this person.");
  }
  if ((await getSystemState(tx))?.killSwitch) {
    refused("kill_switch", "Sending is stopped everywhere. Resume sending to ask your agent here.");
  }
  const [campaign] =
    box.campaignId === null
      ? []
      : await tx.select({ channelId: campaigns.channelId }).from(campaigns).where(eq(campaigns.id, box.campaignId));
  const channelId = campaign?.channelId ?? (await channelCeilings(tx))?.id;
  if (channelId == null) return;
  const stop = await scopedStop(tx, { channelId, campaignId: box.campaignId, profileId: box.profileId, origin: "owner" });
  // `stopped:<scope>:<reason>`, the scope an account, a campaign or a conversation.
  const scope = stop?.split(":")[1];
  if (scope) refused(`${scope}_stopped`, `Sending is stopped on this ${scope}. Resume sending to ask your agent here.`);
}

/** The owner's-box turn that writes the angle, for the box's kind. A room
 *  box's words are asked by its own stored request (`requestRoomReplyDraft`),
 *  filed here — and so are an invite note's, where the box was opened from the
 *  room the person was seen in: it is written from their exact comment, and
 *  for someone Engager has no profile address for yet. */
async function turnFor(tx: Tx, box: OpenBox, composer: ComposerTurn, room?: InviteRoom): Promise<DraftRequest> {
  if (room && box.box.kind !== "invite") refused("composer_box_invalid", "Only an invite's note is written from a room.");
  switch (box.box.kind) {
    case "comment":
      return { kind: "comment", postId: box.box.discoveredPostId, deliver: "box", composer };
    case "reply":
      return { kind: "reply", incomingCommentId: box.box.incomingCommentId, deliver: "box", composer };
    case "dm":
      return { kind: "dm", conversationId: box.box.conversationId, deliver: "box", composer };
    case "invite": {
      if (!room) return { kind: "invite", personKey: box.box.personKey, deliver: "box", composer };
      const request = await requestRoomReplyDraft(tx, { ...room, deliverable: "invite_note" });
      // The room's person is the box's, whichever key names them.
      const { personKey } = await readRoomReplySource(tx, request, { selectedBy: "owner" });
      if ((await resolvePersonKeys(tx, [personKey])).get(personKey) !== box.box.personKey) {
        refused("composer_box_invalid", "That room is not this person's. Reopen the invite from their page.");
      }
      return { kind: "room_reply", ...request, deliver: "box", composer };
    }
    case "room": {
      const request = await requestRoomReplyDraft(tx, { ...box.room!, deliverable: "reply" });
      return { kind: "room_reply", ...request, deliver: "box", composer };
    }
    case "lead":
      return { kind: "lead", leadId: box.box.leadId, signalId: box.box.signalId, deliver: "box", composer };
  }
}

/** A worker's draft a Redraft could not be filed on, refused for why. */
function settled<S extends string>(result: AtomicMutationResult<S>): number {
  if (result.ok) return result.requestVersion;
  if (result.reason === "stale_state") return stale();
  if (result.reason === "campaign_stopped") return refused("campaign_stopped", REDRAFT_STOPPED_NOTE);
  return refused(result.reason, "That draft cannot be written again now. Read the box again.");
}

/**
 * Redraft on the worker's draft waiting for a yes keeps today's path, and
 * adds none: a comment or a reply is asked for again where it waits
 * (`requestMessageRedraft`) — the Ambassador writes a comment's, the owner's
 * agent a reply's (`chat/requestedReply.ts`) — and a DM or follow-up is its
 * step's writer's again (`requestActionRedraft`). The words it replaces stay
 * in the draft's own history, for authorship. A draft of the set other than
 * the one in the box goes in it first (`useDraftVariant`), so the angle
 * rewritten is the one the owner is on. A worker's invite has no writer to
 * ask again, so its Redraft is refused before anything is filed.
 */
async function redraftWorkerAngle(tx: Tx, box: OpenBox, angle: AngleRef, by: string): Promise<ComposerAsked> {
  if (box.box.kind === "invite") {
    throw new ActionLedgerError(
      "action_not_permitted",
      "Redraft cannot write an invite's note again yet.",
      "Change the note yourself, or skip the invite.",
    );
  }
  const { waiting, angles } = (await composerFor(tx, [box.key])).get(box.key)!;
  const drafts = angles.filter((entry) => entry.source === "worker");
  if (!waiting || waiting.version !== angle.revision || !drafts.some((entry) => entry.position === angle.position)) {
    return stale();
  }
  if (waiting.kind === "action") {
    await requestActionRedraft(tx, { id: waiting.id, by });
    return { writing: null, turn: null };
  }
  const cas = { messageId: waiting.id, expectedStatus: waiting.status as Message["status"] };
  let version = waiting.version;
  // The set's first draft is the one in the box.
  if (drafts[0]!.position !== angle.position) {
    version = settled(await useDraftVariant(tx, { ...cas, expectedRequestVersion: version, variant: angle.position }));
  }
  settled(await requestMessageRedraft(tx, { ...cas, expectedRequestVersion: version, requestId: randomUUID(), actor: by }));
  return {
    writing: null,
    turn:
      box.box.kind === "reply"
        ? { kind: "reply", incomingCommentId: box.box.incomingCommentId, deliver: "proposal" }
        : null,
  };
}

/** The box a dock turn's words land in: the owner's own box it names, or —
 *  for a room's request — the reply under that comment, or the person's
 *  invite note. */
export async function askedBox(tx: Tx, request: DraftRequest): Promise<string | null> {
  if (!("kind" in request) || request.kind !== "room_reply") return wordsBox(request);
  const source = await readRoomReplySource(tx, request, { selectedBy: "owner" });
  return request.deliverable === "reply"
    ? boxKey({ kind: "room", targetKey: roomReplyDraftKey(source.campaignId, roomReplyKey(source)) })
    : boxKey({ kind: "invite", personKey: source.personKey });
}

/** The angle a dock turn writes: its box, the angle as the ask left it, and
 *  what the writer is told of it. */
export type AskedAngle = { box: string; at: AngleRef; ask: ComposerAsk };

/** What Fix tells the writer, as the owner's instruction on the draft. */
const fixInstruction = (detail: string) => `Take out what its sources do not support: ${detail}. Keep the rest of the angle.`;

/**
 * The angle a dock turn writes, read from its row before any agent call: the
 * box, the angle as the ask left it, and what the writer is told of it —
 * Redraft's name, line and the draft it replaces, and for Fix the claim to
 * take out of it; for an idea's Draft, its name and line; or, for More
 * angles, the angles the box already holds: a new angle with its draft, or a
 * new idea beside them — in a lead's box always, and where the campaign finds
 * leads and the box has angles.
 * Refused where the box no longer takes words, or the angle was asked for
 * again, or the ask lapsed.
 */
export async function readComposerAsk(
  tx: Tx,
  request: DraftRequest,
  turn: ComposerTurn,
  now = Date.now(),
): Promise<AskedAngle> {
  const named = await askedBox(tx, request);
  if (named === null) throw new AppError("composer_box_invalid", "That ask names no box of yours.", 400);
  const { key, box } = await openComposerBox(tx, named);
  const at = { position: turn.position, revision: turn.revision };
  const row = await readComposerAngle(tx, key, at.position);
  if (!stillAsked(row, at, now)) return stale();
  if (turn.kind === "draft") {
    // An idea's line is the angle: without one there is nothing to draft from.
    if (row.angleWhy === null || row.offered.length > 0) return stale();
    return { box: key, at, ask: { kind: "draft", angle: row.angle, why: row.angleWhy } };
  }
  const replacing = row.offered.at(-1);
  if (replacing !== undefined) {
    // Fix names the claim to take out as the send gate finds it, never as the
    // page said it; without one, it is a plain Redraft.
    const check = turn.fix ? await wordsCheck(tx, replacing, now) : null;
    const fix = check?.state === "unsupported" ? { instruction: fixInstruction(check.detail) } : {};
    return { box: key, at, ask: { kind: "redraft", angle: row.angle, why: row.angleWhy, replacing, ...fix } };
  }
  const { angles } = (await composerFor(tx, [key], now)).get(key)!;
  // The row being written is no angle of the box yet; every other is taken,
  // an idea as much as a draft. A lead's box adds a way in and never words:
  // the owner picks the approach first, whatever the box holds.
  const taken = angles.flatMap((entry) => (entry.state === "writing" ? [] : [{ angle: entry.angle, why: entry.why, move: entry.move }]));
  const idea = turn.ideaOnly === true || box.kind === "lead" || taken.length > 0;
  return { box: key, at, ask: { kind: idea ? "idea" : "more", taken } };
}

