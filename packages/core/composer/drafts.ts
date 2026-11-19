import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { COMPOSER_ANGLE_LIMIT } from "@engager/common/composer";
import { AppError } from "@engager/common/errors";
import { assistRetention, ownerOrigin, retentionWindow } from "@engager/common/text-provenance";
import {
  actions,
  composerDrafts,
  discoveredPosts,
  engagedProfiles,
  incomingComments,
  conversations,
  leads,
  leadSignals,
  messageDraftRevisions,
  messages,
  roomReplyAssists,
  roomReplyDrafts,
  stepRuns,
  type ComposerDraft,
  type Message,
  type RoomReplyTargetJson,
  type RoomSourcedReplyTarget,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { takesWords } from "../leads/read";
import { leadStandings } from "../leads/scout/eligibility";
import { recommendedSource, recommendedSources } from "../leads/source";
import type { AssistMove } from "../operations/candidateDraft";
import { findPerson, resolvePersonKeys } from "../people/directory";
import { parsePersonKey } from "../people/key";
import { readRoomReplySource, roomReplyKey } from "../rooms/replySource";
import { setDrafts } from "../workers/draftSet";

/**
 * ONE DRAFT PER ANGLE, IN EVERY BOX THE OWNER WRITES IN.
 *
 * A box is where the owner's words will land: a comment under a post, a reply
 * under a reply, a room reply under someone's comment, an invite's note, a DM
 * into a conversation, the opener to someone Find leads found. Each has one
 * key, the same whatever draft row exists for it, and each agent delivery to
 * it is an angle row of its own: a name, what it does, and its one draft. A
 * delivery never overwrites another; only the owner's Redraft replaces an
 * angle's draft, and then for good — the old words stay only where authorship
 * reads them (`offered`).
 *
 * A row is raw material. Nothing sends from here; only the owner's press saves
 * words, through the box's own op and its gates. Every save is measured
 * against everything the box ever offered (`composerFor(...).offered`), so a
 * draft kept, or typed back, is never learned as the owner's voice.
 *
 * An angle may stand as an IDEA: its name and the line saying what it does,
 * with no draft. The owner picks the approach before any words shape it, and
 * asks for the draft of the one they pick (`askComposerAngle`); an idea is
 * offered no words, so it adds nothing a save is measured against. A lead
 * arrives with ideas, and the ones Qualify finds replace the screen's
 * (`replaceComposerIdeas`): only an idea that never held a draft is replaced.
 */

export type ComposerBox =
  | { kind: "comment"; discoveredPostId: number }
  | { kind: "reply"; incomingCommentId: number }
  | { kind: "room"; targetKey: string }
  | { kind: "invite"; personKey: string }
  | { kind: "dm"; conversationId: number }
  /** One source's opener. An older person-only key resolves once to the
   *  recommended source, keeping its existing angles and drafts. */
  | { kind: "lead"; leadId: number; signalId?: number };

export type ComposerAngleState = ComposerDraft["state"];

/** One angle in a box's bar. An agent angle's `position` is its row's, the
 *  one `useComposerAngle` takes with its revision; a worker angle's is its
 *  draft's number in the waiting row's set, the number a swap takes
 *  (`useDraftVariant`). The two are numbered apart, so `source` says which. */
export type ComposerAngle = {
  position: number;
  angle: string;
  why: string | null;
  move: string | null;
  text: string | null;
  state: ComposerAngleState;
  source: "agent" | "worker";
  revision: number;
  /** Every draft an agent angle has held, oldest first and the one it shows
   *  last: the versions a Redraft, or a draft's conversation, wrote on it.
   *  Absent where the angle has only ever held the one it shows. */
  versions?: string[];
};

/** The worker's draft waiting for a yes on the box, by the row that holds
 *  it and the version its decisions are checked against. */
export type ComposerWaiting = {
  kind: "message" | "action";
  id: number;
  status: string;
  version: number;
};

export type Composer = {
  angles: ComposerAngle[];
  waiting: ComposerWaiting | null;
  /** Every agent text the box has ever shown, current first, each once. */
  offered: string[];
};

/** One agent angle as the owner last saw it: its row's position, and the
 *  revision its words were at. */
export type AngleRef = { position: number; revision: number };

/** The most an angle's name and its line may run. */
export const ANGLE_NAME_LIMIT = 24;
export const ANGLE_WHY_LIMIT = 160;

/** How long an angle stands being written before it is taken as not coming:
 *  past the chat turn's own budget (`chat/broker.ts`), an ask still open is
 *  one whose turn died — a crash or a restart — and it reads as failed. */
export const COMPOSER_ASK_STALE_MS = 10 * 60_000;

/** What an angle is called where its move names it — the board's words — and
 *  where none does. */
const MOVE_NAMES: Record<AssistMove, string> = {
  question: "Ask",
  agree_plus: "Add",
  push_back: "Push back",
  your_story: "Story",
  answer_room: "Answer",
};
export const UNNAMED_ANGLE = "Draft";

export function angleName(move: string | null | undefined): string {
  return (move ? MOVE_NAMES[move as AssistMove] : undefined) ?? UNNAMED_ANGLE;
}

/** What an agent angle is called: the name of what it speaks to, else the
 *  move it makes. */
function agentAngleName(input: { name?: string | null; move?: AssistMove | null }): string {
  return clip(input.name, ANGLE_NAME_LIMIT) ?? angleName(input.move);
}

export function boxKey(box: ComposerBox): string {
  switch (box.kind) {
    case "comment":
      return `comment:${box.discoveredPostId}`;
    case "reply":
      return `reply:${box.incomingCommentId}`;
    case "room":
      return `room:${box.targetKey}`;
    case "invite":
      return `invite:${box.personKey}`;
    case "dm":
      return `dm:${box.conversationId}`;
    case "lead":
      return `lead:${box.leadId}${box.signalId === undefined ? "" : `:signal:${box.signalId}`}`;
  }
}

/** A row id, at most 15 digits, so it is always a safe integer. */
const ROW_ID = /^[1-9]\d{0,14}$/;
const ROOM_TARGET = /^[0-9a-f]{64}$/;

/** The box a key names; null for anything that is not one. */
export function parseBoxKey(key: string): ComposerBox | null {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const rest = key.slice(at + 1);
  if (at < 0 || rest.length === 0) return null;
  if (kind === "comment" && ROW_ID.test(rest)) return { kind, discoveredPostId: Number(rest) };
  if (kind === "reply" && ROW_ID.test(rest)) return { kind, incomingCommentId: Number(rest) };
  if (kind === "dm" && ROW_ID.test(rest)) return { kind, conversationId: Number(rest) };
  if (kind === "lead" && ROW_ID.test(rest)) return { kind, leadId: Number(rest) };
  if (kind === "lead") {
    const [lead, source, signal, extra] = rest.split(":");
    if (lead && signal && source === "signal" && extra === undefined && ROW_ID.test(lead) && ROW_ID.test(signal)) {
      return { kind, leadId: Number(lead), signalId: Number(signal) };
    }
  }
  if (kind === "room" && ROOM_TARGET.test(rest)) return { kind, targetKey: rest };
  if (kind === "invite" && parsePersonKey(rest) !== null) return { kind, personKey: rest };
  return null;
}

function refused(code: string, message: string): never {
  throw new AppError(code, message, 409);
}

/** A delivered line's identity: its text, whitespace runs folded. */
function textKey(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

/** A line kept to `limit` characters, cut at a word where it runs over. */
export function clip(value: string | null | undefined, limit: number): string | null {
  const chars = Array.from(value?.trim().replace(/\s+/gu, " ") ?? "");
  if (chars.length === 0) return null;
  if (chars.length <= limit) return chars.join("");
  const cut = chars.slice(0, limit - 1).join("");
  const word = cut.lastIndexOf(" ");
  return `${(word > 0 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** Every text once, in the order first met. */
function distinct(texts: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    if (!text?.trim()) continue;
    const key = textKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

async function excluded(tx: Tx, profileId: string | null): Promise<boolean> {
  if (!profileId) return false;
  const [row] = await tx
    .select({ doNotEngage: engagedProfiles.doNotEngage })
    .from(engagedProfiles)
    .where(eq(engagedProfiles.profileId, profileId));
  return row?.doNotEngage === true;
}

/** A send of ours on the box that is past waiting for a yes: scheduled, on
 *  its way, out, or waiting on a check. A draft turned down closes nothing. */
const closedBy = (status: Message["status"]) => status !== "proposed" && status !== "rejected";

/** The room box's target, from the offer or the owner draft that names it. */
async function roomTarget(tx: Tx, targetKey: string): Promise<RoomReplyTargetJson | null> {
  const [assist] = await tx
    .select({ target: roomReplyAssists.target })
    .from(roomReplyAssists)
    .where(eq(roomReplyAssists.targetKey, targetKey))
    .limit(1);
  if (assist) return assist.target;
  const [draft] = await tx
    .select({ target: roomReplyDrafts.target })
    .from(roomReplyDrafts)
    .where(eq(roomReplyDrafts.targetKey, targetKey));
  return draft?.target ?? null;
}

/** A box a write may land in, as resolved: its canonical key and what it
 *  names, the campaign its words ride, the person they reach and — for a room
 *  box — the comment they answer. */
export type OpenBox = {
  key: string;
  box: ComposerBox;
  campaignId: number | null;
  profileId: string | null;
  room: Pick<RoomSourcedReplyTarget, "roomMemberId" | "parentCommentUrn"> | null;
};

/**
 * The box a write names, resolved to what it writes on: refused where the key
 * names nothing that exists, a box that takes no more words (a send of ours
 * on it past waiting, a conversation closed or taken over), or someone the
 * owner chose never to engage. An invite's box is keyed by the person's
 * canonical key, so one person has one.
 */
export async function openComposerBox(tx: Tx, key: string): Promise<OpenBox> {
  key = await leadSourceBox(tx, key);
  const box = parseBoxKey(key);
  if (!box) throw new AppError("composer_box_invalid", `${key} names no composer box.`, 400);
  const missing = () => refused("composer_box_missing", "That box is no longer here.");
  const closed = () => refused("composer_box_closed", "That box takes no more words.");
  const excludedPerson = () => refused("composer_box_excluded", "You chose never to engage this person.");
  switch (box.kind) {
    case "comment": {
      const [post] = await tx.select().from(discoveredPosts).where(eq(discoveredPosts.id, box.discoveredPostId));
      if (!post) return missing();
      const sent = await tx
        .select({ status: messages.status })
        .from(messages)
        .where(and(eq(messages.kind, "comment"), eq(messages.discoveredPostId, post.id)));
      if (sent.some((row) => closedBy(row.status))) return closed();
      if (await excluded(tx, post.authorProfileId)) return excludedPerson();
      return { key, box, campaignId: post.campaignId, profileId: post.authorProfileId, room: null };
    }
    case "reply": {
      const [incoming] = await tx.select().from(incomingComments).where(eq(incomingComments.id, box.incomingCommentId));
      if (!incoming || incoming.removedAt !== null) return missing();
      const [sent] = await tx
        .select({ status: messages.status })
        .from(messages)
        .where(eq(messages.incomingCommentId, incoming.id));
      if (incoming.status === "replied" || (sent && closedBy(sent.status))) return closed();
      if (await excluded(tx, incoming.authorProfileId)) return excludedPerson();
      return { key, box, campaignId: incoming.campaignId, profileId: incoming.authorProfileId, room: null };
    }
    case "room": {
      const target = await roomTarget(tx, box.targetKey);
      // A reply under a lead's comment is written in the lead's own box
      // (`lead:<id>`), never in a room's.
      if (!target || target.source === "lead") return missing();
      // The room's own reader refuses evidence that expired, a person excluded
      // or skipped, and a comment no longer there.
      const source = await readRoomReplySource(
        tx,
        { roomMemberId: target.roomMemberId, parentCommentUrn: target.parentCommentUrn },
        { selectedBy: "owner" },
      );
      const [sent] = await tx
        .select({ status: messages.status })
        .from(messages)
        .where(eq(messages.dedupeKey, roomReplyKey(source)));
      if (sent && closedBy(sent.status)) return closed();
      return {
        key,
        box,
        campaignId: source.campaignId,
        profileId: source.profileId,
        room: { roomMemberId: source.roomMemberId, parentCommentUrn: source.parentCommentUrn },
      };
    }
    case "invite": {
      const person = await findPerson(tx, box.personKey);
      if (!person) return missing();
      if (person.doNotEngage) return excludedPerson();
      const [conversation] =
        person.conversationId === null
          ? []
          : await tx
              .select({ campaignId: conversations.owningCampaignId })
              .from(conversations)
              .where(eq(conversations.id, person.conversationId));
      const [lead] = person.profileId !== null && !conversation?.campaignId && person.campaigns.length === 0
        ? await tx.select({ campaignId: leads.campaignId }).from(leads).where(eq(leads.profileId, person.profileId))
        : [];
      const campaignId = conversation?.campaignId ?? (person.campaigns.length === 1 ? person.campaigns[0]!.id : lead?.campaignId ?? null);
      const named: ComposerBox = { kind: "invite", personKey: person.canonicalKey };
      return { key: boxKey(named), box: named, campaignId, profileId: person.profileId, room: null };
    }
    case "dm": {
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, box.conversationId));
      if (!conversation) return missing();
      if (conversation.closedReason !== null || conversation.opsStatus === "human_owned") return closed();
      if (await excluded(tx, conversation.authorProfileId)) return excludedPerson();
      return { key, box, campaignId: conversation.owningCampaignId, profileId: conversation.authorProfileId, room: null };
    }
    case "lead": {
      const [lead] = await tx.select().from(leads).where(eq(leads.id, box.leadId));
      if (!lead || lead.campaignId === null) return missing();
      if (await excluded(tx, lead.profileId)) return excludedPerson();
      // The opener is for someone Scout found and nobody has reached yet, and
      // a follow-up for someone reached who has not answered: past that, their
      // words go in the boxes of the conversation itself. Someone the owner
      // put out of reach otherwise — erased, excluded, a conversation they closed —
      // has a box that takes no words either.
      if (!takesWords(lead)) return closed();
      const [standing] = await leadStandings(tx, lead.campaignId, [lead.id]);
      if (!standing?.eligible) return closed();
      if (box.signalId !== undefined) {
        const [source] = await tx.select({ id: leadSignals.id }).from(leadSignals).where(and(
          eq(leadSignals.id, box.signalId), eq(leadSignals.leadId, lead.id), eq(leadSignals.verdict, "passed"),
        ));
        if (!source) return missing();
      }
      return { key, box, campaignId: lead.campaignId, profileId: lead.profileId, room: null };
    }
  }
}

/** Writes to one box take their turn one at a time. */
async function lockBox(tx: Tx, key: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('composer:' || current_setting('app.current_org')), hashtext(${key}))`,
  );
}

/** Bind old person-only angles once, without replacing their rows, revisions
 *  or offered text. New sources always have separate keys. The old key is
 *  locked before either source key so concurrent reads cannot adopt it twice. */
export async function leadSourceBox(tx: Tx, key: string): Promise<string> {
  const box = parseBoxKey(key);
  if (box?.kind !== "lead") return key;
  const old = boxKey({ kind: "lead", leadId: box.leadId });
  if (box.signalId !== undefined) {
    const [legacy] = await tx.select({ id: composerDrafts.id }).from(composerDrafts).where(eq(composerDrafts.boxKey, old)).limit(1);
    if (!legacy) return key;
  }
  const recommended = await recommendedSource(tx, box.leadId);
  const signalId = box.signalId ?? recommended;
  if (signalId === null) return key;
  const named = boxKey({ kind: "lead", leadId: box.leadId, signalId });
  if (signalId !== recommended) return named;
  await lockBox(tx, old);
  const legacy = await tx.select().from(composerDrafts).where(eq(composerDrafts.boxKey, old)).orderBy(composerDrafts.position);
  if (legacy.length === 0) return named;
  await lockBox(tx, named);
  const [last] = await tx.select({ position: sql<number>`coalesce(max(${composerDrafts.position}), 0)::int` })
    .from(composerDrafts).where(eq(composerDrafts.boxKey, named));
  const offset = last?.position ?? 0;
  for (const row of legacy) {
    await tx.update(composerDrafts).set({ boxKey: named, position: row.position + offset }).where(eq(composerDrafts.id, row.id));
  }
  return named;
}

/** {@link leadSourceBox} of each lead's person-only key, for many leads at
 *  once: two reads decide every lead that holds no person-only angles to bind,
 *  and only one that does takes the single path. */
async function leadSourceBoxes(tx: Tx, leadIds: readonly number[]): Promise<Map<number, string>> {
  if (leadIds.length === 0) return new Map();
  const old = (leadId: number) => boxKey({ kind: "lead", leadId });
  const bound = new Set(
    (await tx.select({ boxKey: composerDrafts.boxKey }).from(composerDrafts).where(inArray(composerDrafts.boxKey, leadIds.map(old)))).map((row) => row.boxKey),
  );
  const recommended = await recommendedSources(tx, leadIds.filter((leadId) => !bound.has(old(leadId))));
  const named = new Map<number, string>();
  for (const leadId of leadIds) {
    const signalId = recommended.get(leadId);
    named.set(leadId, bound.has(old(leadId)) ? await leadSourceBox(tx, old(leadId)) : signalId === undefined ? old(leadId) : boxKey({ kind: "lead", leadId, signalId }));
  }
  return named;
}

/** An angle asked for whose turn never came back with words or a failure. */
function lapsed(row: ComposerDraft, now: number): boolean {
  return row.state === "writing" && now - (row.requestedAt ?? row.updatedAt) >= COMPOSER_ASK_STALE_MS;
}

/** A row being written that was an idea: it has its line and has never held a
 *  draft. A new angle still waiting for its name has no line, and a Redraft's
 *  angle has the draft it is replacing. */
function wasIdea(row: ComposerDraft): boolean {
  return row.angleWhy !== null && row.offered.length === 0;
}

/** Whether the row is the angle an ask left being written, at the revision
 *  it left, and the ask still stands. */
export function stillAsked(row: ComposerDraft | null, at: AngleRef, now: number): row is ComposerDraft {
  return row !== null && row.revision === at.revision && row.state === "writing" && !lapsed(row, now);
}

/** A row's earlier drafts with `text` moved last: the one it replaces, newest. */
function retire(offered: readonly string[], text: string): string[] {
  return [...offered.filter((held) => textKey(held) !== textKey(text)), text];
}

/**
 * One agent delivery to a box: an angle row of its own at the box's next
 * position, named by what it speaks to or else by the move it makes ("Draft"
 * where it names neither), with the line saying what it does. Words the box already holds, as an angle or an
 * angle's earlier draft, are not added twice. It approves, queues and sends
 * nothing, and never touches words the owner typed: those live in the box.
 *
 * Words asked for one angle (`at`: a Redraft, or More angles) land on that
 * row only, and only while it is still being written at the revision the ask
 * left it at: an answer to an ask made again since, or one that lapsed, lands
 * nowhere, so a slow answer never overwrites a newer one. The move, name and
 * line it gives, if any, are the angle's from then on.
 */
export async function putComposerAngle(
  tx: Tx,
  input: {
    box: string;
    text: string;
    move?: AssistMove | null;
    name?: string | null;
    why?: string | null;
    requestedAt?: number | null;
    /** The campaign the words were written under, where the box itself
     *  names none: a room's invite note, to someone no campaign touched. */
    campaignId?: number | null;
    /** The angle the words were asked for. */
    at?: AngleRef;
  },
  now = Date.now(),
): Promise<ComposerDraft> {
  const text = input.text.trim();
  if (text.length === 0) throw new AppError("composer_text_required", "An angle needs its draft.", 400);
  const box = await openComposerBox(tx, input.box);
  await lockBox(tx, box.key);
  if (input.at) {
    const row = await readComposerAngle(tx, box.key, input.at.position);
    if (!stillAsked(row, input.at, now)) {
      refused("composer_angle_stale", "That angle was asked for again or moved on, so these words land nowhere.");
    }
    const [landed] = await tx
      .update(composerDrafts)
      .set({
        text,
        state: "ready",
        revision: row.revision + 1,
        ...(input.move ? { move: input.move, angle: agentAngleName(input) } : {}),
        angleWhy: clip(input.why, ANGLE_WHY_LIMIT) ?? row.angleWhy,
        updatedAt: now,
      })
      .where(eq(composerDrafts.id, row.id))
      .returning();
    return landed!;
  }
  const rows = await tx
    .select()
    .from(composerDrafts)
    .where(eq(composerDrafts.boxKey, box.key))
    .orderBy(composerDrafts.position);
  const kept = rows.find((row) => [row.text, ...row.offered].some((held) => held !== null && textKey(held) === textKey(text)));
  if (kept) return kept;
  const [created] = await tx
    .insert(composerDrafts)
    .values({
      boxKey: box.key,
      campaignId: box.campaignId ?? input.campaignId ?? null,
      position: Math.max(0, ...rows.map((row) => row.position)) + 1,
      angle: agentAngleName(input),
      angleWhy: clip(input.why, ANGLE_WHY_LIMIT),
      move: input.move ?? null,
      text,
      state: "ready",
      requestedAt: input.requestedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created!;
}

/**
 * One angle with its name and its line and no draft. With `at`, the answer to
 * More angles: the angle asked for is an idea from then on, named by what it
 * speaks to or else by the move it makes, and only while it is still being written at the revision the ask
 * left it at — as words are (`putComposerAngle`). Without, a new idea at the
 * box's next position (what serves a lead hands the Ambassador's box), refused
 * where the box shows {@link COMPOSER_ANGLE_LIMIT} angles; a line the box
 * already holds is not added twice. It approves, queues and sends nothing, and
 * never touches words the owner typed.
 */
export async function putComposerIdea(
  tx: Tx,
  input: {
    box: string;
    why: string;
    move?: AssistMove | null;
    name?: string | null;
    /** The campaign the angle was written under, where the box names none. */
    campaignId?: number | null;
    /** The angle asked for. */
    at?: AngleRef;
  },
  now = Date.now(),
): Promise<ComposerDraft> {
  const why = clip(input.why, ANGLE_WHY_LIMIT);
  if (why === null) throw new AppError("composer_angle_line_required", "An angle needs its line.", 400);
  const box = await openComposerBox(tx, input.box);
  await lockBox(tx, box.key);
  const name = agentAngleName(input);
  if (input.at) {
    const row = await readComposerAngle(tx, box.key, input.at.position);
    if (!stillAsked(row, input.at, now)) {
      refused("composer_angle_stale", "That angle was asked for again or moved on, so this angle lands nowhere.");
    }
    const [landed] = await tx
      .update(composerDrafts)
      .set({
        text: null,
        state: "idea",
        revision: row.revision + 1,
        move: input.move ?? null,
        angle: name,
        angleWhy: why,
        updatedAt: now,
      })
      .where(eq(composerDrafts.id, row.id))
      .returning();
    return landed!;
  }
  const rows = await tx.select().from(composerDrafts).where(eq(composerDrafts.boxKey, box.key));
  const held = rows.find((row) => row.angleWhy !== null && textKey(row.angleWhy) === textKey(why));
  if (held) return held;
  const shown = (await composerFor(tx, [box.key], now)).get(box.key)?.angles ?? [];
  if (shown.length >= COMPOSER_ANGLE_LIMIT) {
    refused("composer_full", `This box holds ${COMPOSER_ANGLE_LIMIT} angles.`);
  }
  const [last] = await tx
    .select({ position: composerDrafts.position })
    .from(composerDrafts)
    .where(eq(composerDrafts.boxKey, box.key))
    .orderBy(desc(composerDrafts.position))
    .limit(1);
  const [created] = await tx
    .insert(composerDrafts)
    .values({
      boxKey: box.key,
      campaignId: box.campaignId ?? input.campaignId ?? null,
      position: (last?.position ?? 0) + 1,
      angle: name,
      angleWhy: why,
      move: input.move ?? null,
      text: null,
      state: "idea",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created!;
}

/**
 * A box's ideas, set from one delivery of them: every idea the box holds that
 * never held a draft goes, and these take the box's first free positions — a
 * name and a line each, no draft. An angle that holds a draft, or is being
 * written, stays where it is, and a line it already has is not added beside
 * it; the box never shows more than {@link COMPOSER_ANGLE_LIMIT}. What serves
 * a lead hands their box this way: the screen's guesses, then Qualify's
 * sharper set in their place. It approves, queues and sends nothing.
 */
export async function replaceComposerIdeas(
  tx: Tx,
  input: { box: string; ideas: readonly { name: string; why: string }[] },
  now = Date.now(),
): Promise<ComposerDraft[]> {
  const box = await openComposerBox(tx, input.box);
  await lockBox(tx, box.key);
  const rows = await tx.select().from(composerDrafts).where(eq(composerDrafts.boxKey, box.key));
  const stale = rows.filter((row) => row.state === "idea" && row.offered.length === 0);
  if (stale.length > 0) await tx.delete(composerDrafts).where(inArray(composerDrafts.id, stale.map((row) => row.id)));
  const kept = rows.filter((row) => !stale.includes(row));
  const taken = new Set(kept.map((row) => row.position));
  const lines = new Set(kept.flatMap((row) => (row.angleWhy === null ? [] : [textKey(row.angleWhy)])));
  const room = COMPOSER_ANGLE_LIMIT - kept.flatMap((row) => agentAngle(row, now)).length;
  const fresh = input.ideas
    .flatMap((idea) => {
      const name = clip(idea.name, ANGLE_NAME_LIMIT);
      const why = clip(idea.why, ANGLE_WHY_LIMIT);
      return name === null || why === null || lines.has(textKey(why)) ? [] : [{ name, why }];
    })
    .filter((idea, at, all) => all.findIndex((other) => textKey(other.why) === textKey(idea.why)) === at)
    .slice(0, Math.max(0, room));
  const placed: ComposerDraft[] = [];
  let position = 0;
  for (const idea of fresh) {
    do position += 1;
    while (taken.has(position));
    const [created] = await tx
      .insert(composerDrafts)
      .values({
        boxKey: box.key,
        campaignId: box.campaignId,
        position,
        angle: idea.name,
        angleWhy: idea.why,
        text: null,
        state: "idea",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    placed.push(created!);
  }
  return placed;
}

/**
 * The draft of one idea, written by a step on its own rather than asked for
 * by the owner — an opener to a lead the step was served (`writeLeadOpeners`):
 * the idea holds these words from then on, as an idea's Draft leaves it. Null
 * where the angle at `position` is no longer an idea that never held a draft
 * — the owner asked for it meanwhile, or it is gone. The caller has opened the
 * box. It approves, queues and sends nothing.
 */
export async function draftComposerIdea(
  tx: Tx,
  input: { box: string; position: number; text: string },
  now = Date.now(),
): Promise<ComposerDraft | null> {
  const text = input.text.trim();
  if (text.length === 0) throw new AppError("composer_text_required", "An angle needs its draft.", 400);
  input = { ...input, box: await leadSourceBox(tx, input.box) };
  await lockBox(tx, input.box);
  const row = await readComposerAngle(tx, input.box, input.position);
  if (row?.state !== "idea" || !wasIdea(row)) return null;
  const [landed] = await tx
    .update(composerDrafts)
    .set({ text, state: "ready", revision: row.revision + 1, updatedAt: now })
    .where(eq(composerDrafts.id, row.id))
    .returning();
  return landed ?? null;
}

/** One agent angle of a box, as its row holds it; null where none is at that
 *  position. */
export async function readComposerAngle(tx: Tx, box: string, position: number): Promise<ComposerDraft | null> {
  box = await leadSourceBox(tx, box);
  const [row] = await tx
    .select()
    .from(composerDrafts)
    .where(and(eq(composerDrafts.boxKey, box), eq(composerDrafts.position, position)));
  return row ?? null;
}

/**
 * An angle the owner asked their agent to write, left being written until
 * the words land (`putComposerAngle` with `at`) or the ask fails
 * (`failComposerAngle`). With `at`, Redraft: that agent angle again — its
 * draft moves to its `offered`, where only authorship reads it, its revision
 * moves, and every other angle stays as it was — or, for an idea, the draft
 * of that angle, which has no earlier words to retire. Without, More angles:
 * a new row at the box's next position, refused (`composer_full`) where the
 * box already shows {@link COMPOSER_ANGLE_LIMIT}, ideas included. Only an
 * angle's own words are ever replaced. The caller has opened the box and
 * checked what stops it.
 */
export async function askComposerAngle(
  tx: Tx,
  box: OpenBox,
  at: AngleRef | null,
  now = Date.now(),
): Promise<ComposerDraft> {
  await lockBox(tx, box.key);
  if (at) {
    const row = await readComposerAngle(tx, box.key, at.position);
    if (!row || row.revision !== at.revision || agentAngle(row, now).length === 0) {
      refused("composer_angle_stale", "That angle changed since you read it. Read the box again.");
    }
    const [asked] = await tx
      .update(composerDrafts)
      .set({
        text: null,
        state: "writing",
        revision: row.revision + 1,
        // An angle asked again while it is written has no words to retire.
        offered: row.text === null ? row.offered : retire(row.offered, row.text),
        requestedAt: now,
        updatedAt: now,
      })
      .where(eq(composerDrafts.id, row.id))
      .returning();
    return asked!;
  }
  const shown = (await composerFor(tx, [box.key], now)).get(box.key)?.angles ?? [];
  if (shown.length >= COMPOSER_ANGLE_LIMIT) {
    refused("composer_full", `This box holds ${COMPOSER_ANGLE_LIMIT} angles. Redraft one of them instead.`);
  }
  const [last] = await tx
    .select({ position: composerDrafts.position })
    .from(composerDrafts)
    .where(eq(composerDrafts.boxKey, box.key))
    .orderBy(desc(composerDrafts.position))
    .limit(1);
  const [asked] = await tx
    .insert(composerDrafts)
    .values({
      boxKey: box.key,
      campaignId: box.campaignId,
      position: (last?.position ?? 0) + 1,
      angle: UNNAMED_ANGLE,
      text: null,
      state: "writing",
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return asked!;
}

/**
 * An ask that came to no words: Redraft's angle keeps the draft it was
 * replacing, shown again, `failed`, so a draft is replaced only when a new
 * one lands; an idea whose draft was asked for goes back to being an idea,
 * never deleted; More angles' row stays as no angle at all, so its position
 * is never asked for again and a slow answer to it lands nowhere. Only the
 * ask as it was made — an angle asked for again since is the newer ask's —
 * and nothing is retried.
 */
export async function failComposerAngle(tx: Tx, key: string, at: AngleRef, now = Date.now()): Promise<void> {
  key = await leadSourceBox(tx, key);
  await lockBox(tx, key);
  const row = await readComposerAngle(tx, key, at.position);
  if (!row || row.revision !== at.revision || row.state !== "writing") return;
  await tx
    .update(composerDrafts)
    .set({
      text: row.offered.at(-1) ?? null,
      state: wasIdea(row) ? "idea" : "failed",
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(eq(composerDrafts.id, row.id));
}

type WaitingMessage = Pick<Message, "id" | "status" | "proposedText" | "trace" | "redraftRequestVersion">;

/** A waiting message's drafts as worker angles: the one in its box first,
 *  then the rest of its set by number. */
function messageAngles(message: WaitingMessage): ComposerAngle[] {
  const pick = message.trace?.pick;
  const drafts = pick
    ? setDrafts(pick, message.proposedText)
    : [{ draft: 1, move: "", text: message.proposedText, inBox: true, asked: false, angle: null }];
  const others = new Map((pick?.others ?? []).map((other) => [textKey(other.text), other.rationale ?? null] as const));
  return [...drafts.filter((draft) => draft.inBox), ...drafts.filter((draft) => !draft.inBox)].map((draft) => ({
    position: draft.draft,
    angle: angleName(draft.move),
    why: draft.angle ?? (draft.inBox ? pick?.why || null : others.get(textKey(draft.text)) ?? null),
    move: draft.move || null,
    text: draft.text,
    state: "ready" as const,
    source: "worker" as const,
    revision: message.redraftRequestVersion,
  }));
}

/** A row as its angle reads now: an ask that lapsed reads as failed, with the
 *  draft it was replacing shown again — an idea whose draft lapsed, as the
 *  idea it was — and a new angle that never came — its ask failed or lapsed —
 *  reads as no angle at all. */
function agentAngle(row: ComposerDraft, now: number): ComposerAngle[] {
  const { text, state } = lapsed(row, now)
    ? { text: row.offered.at(-1) ?? null, state: wasIdea(row) ? ("idea" as const) : ("failed" as const) }
    : row;
  if (text === null && state === "failed") return [];
  return [
    {
      position: row.position,
      angle: row.angle,
      why: row.angleWhy,
      move: row.move,
      text,
      state,
      source: "agent",
      revision: row.revision,
      versions: text === null ? [...row.offered] : retire(row.offered, text),
    },
  ];
}

/** One agent angle of a box as its bar shows it now; null where none shows
 *  at that position. */
export async function shownComposerAngle(
  tx: Tx,
  box: string,
  position: number,
  now = Date.now(),
): Promise<ComposerAngle | null> {
  const row = await readComposerAngle(tx, box, position);
  return row === null ? null : (agentAngle(row, now)[0] ?? null);
}

/** What a box holds beside its own rows: the worker's draft waiting on it
 *  and the agent texts other records keep for it. */
type BoxExtras = { waiting: ComposerWaiting | null; workerAngles: ComposerAngle[]; offered: string[] };

const NO_EXTRAS: BoxExtras = { waiting: null, workerAngles: [], offered: [] };

const waitingMessageColumns = {
  id: messages.id,
  status: messages.status,
  proposedText: messages.proposedText,
  trace: messages.trace,
  redraftRequestVersion: messages.redraftRequestVersion,
  discoveredPostId: messages.discoveredPostId,
  incomingCommentId: messages.incomingCommentId,
  dedupeKey: messages.dedupeKey,
};

/** Every earlier draft Engager wrote for these messages, newest first. */
async function draftHistory(tx: Tx, ids: readonly number[]): Promise<Map<number, string[]>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ messageId: messageDraftRevisions.messageId, text: messageDraftRevisions.draftText })
    .from(messageDraftRevisions)
    .where(
      and(
        inArray(messageDraftRevisions.messageId, [...ids]),
        inArray(messageDraftRevisions.source, ["initial", "redraft", "variant_swap"]),
      ),
    )
    .orderBy(desc(messageDraftRevisions.revision));
  const out = new Map<number, string[]>();
  for (const row of rows) out.set(row.messageId, [...(out.get(row.messageId) ?? []), row.text]);
  return out;
}

function fromMessage(message: WaitingMessage, history: readonly string[]): BoxExtras {
  const workerAngles = messageAngles(message);
  return {
    waiting: { kind: "message", id: message.id, status: message.status, version: message.redraftRequestVersion },
    workerAngles,
    offered: [...workerAngles.map((angle) => angle.text!), ...history],
  };
}

function fromAction(action: { id: number; status: string; updatedAt: number; text: string | null; why: string | null }): BoxExtras {
  if (action.text === null) return NO_EXTRAS;
  return {
    waiting: { kind: "action", id: action.id, status: action.status, version: action.updatedAt },
    workerAngles: [
      {
        position: 1,
        angle: UNNAMED_ANGLE,
        why: action.why,
        move: null,
        text: action.text,
        state: "ready",
        source: "worker",
        revision: action.updatedAt,
      },
    ],
    offered: [action.text],
  };
}

/** The worker drafts and other agent records of each box, by key. */
async function boxExtras(tx: Tx, boxes: ReadonlyMap<string, ComposerBox>): Promise<Map<string, BoxExtras>> {
  const out = new Map<string, BoxExtras>();
  const of = <K extends ComposerBox["kind"]>(kind: K) =>
    [...boxes].flatMap(([key, box]) => (box.kind === kind ? [[key, box as Extract<ComposerBox, { kind: K }>] as const] : []));
  const add = (key: string, extras: Partial<BoxExtras>) => {
    const current = out.get(key) ?? NO_EXTRAS;
    out.set(key, {
      waiting: extras.waiting ?? current.waiting,
      workerAngles: [...current.workerAngles, ...(extras.workerAngles ?? [])],
      offered: [...current.offered, ...(extras.offered ?? [])],
    });
  };

  const comments = of("comment");
  const replies = of("reply");
  const rooms = of("room");
  const roomTargets = new Map<string, RoomReplyTargetJson>();
  if (rooms.length > 0) {
    const targetKeys = rooms.map(([, box]) => box.targetKey);
    const drafts = await tx
      .select({ targetKey: roomReplyDrafts.targetKey, target: roomReplyDrafts.target })
      .from(roomReplyDrafts)
      .where(and(inArray(roomReplyDrafts.targetKey, targetKeys), isNotNull(roomReplyDrafts.target)));
    const assists = await tx
      .select({ targetKey: roomReplyAssists.targetKey, target: roomReplyAssists.target, texts: roomReplyAssists.texts })
      .from(roomReplyAssists)
      .where(and(inArray(roomReplyAssists.targetKey, targetKeys), eq(roomReplyAssists.deliverable, "reply")));
    for (const row of [...drafts, ...assists]) if (row.target) roomTargets.set(row.targetKey, row.target);
    for (const [key, box] of rooms) {
      add(key, { offered: assists.find((row) => row.targetKey === box.targetKey)?.texts ?? [] });
    }
  }

  const waitingFilters = [
    ...(comments.length > 0
      ? [and(eq(messages.kind, "comment"), inArray(messages.discoveredPostId, comments.map(([, box]) => box.discoveredPostId)))]
      : []),
    ...(replies.length > 0
      ? [and(eq(messages.kind, "reply"), inArray(messages.incomingCommentId, replies.map(([, box]) => box.incomingCommentId)))]
      : []),
    ...(roomTargets.size > 0
      ? [
          and(
            eq(messages.kind, "room_reply"),
            sql`${messages.workerRunId} is not null`,
            inArray(messages.dedupeKey, [...roomTargets.values()].map((target) => roomReplyKey(target))),
          ),
        ]
      : []),
  ];
  if (waitingFilters.length > 0) {
    const waiting = await tx
      .select(waitingMessageColumns)
      .from(messages)
      .where(
        and(
          eq(messages.status, "proposed"),
          eq(messages.publishOrigin, "worker"),
          sql`(${sql.join(waitingFilters, sql` or `)})`,
        ),
      );
    const history = await draftHistory(tx, waiting.map((row) => row.id));
    for (const [key, box] of [...comments, ...replies, ...rooms]) {
      const target = box.kind === "room" ? roomTargets.get(box.targetKey) : undefined;
      const message = waiting.find((row) =>
        box.kind === "comment"
          ? row.discoveredPostId === box.discoveredPostId
          : box.kind === "reply"
            ? row.incomingCommentId === box.incomingCommentId
            : target !== undefined && row.dedupeKey === roomReplyKey(target),
      );
      if (message) add(key, fromMessage(message, history.get(message.id) ?? []));
    }
  }

  const invites = of("invite");
  if (invites.length > 0) {
    const personKeys = invites.map(([, box]) => box.personKey);
    const profileIds = personKeys.flatMap((personKey) => {
      const person = parsePersonKey(personKey);
      return person?.kind === "profile" ? [person.profileId] : [];
    });
    const held =
      profileIds.length === 0
        ? []
        : await tx
            .select({ action: actions, why: stepRuns.rationaleSummary })
            .from(actions)
            .leftJoin(stepRuns, eq(stepRuns.id, actions.stepRunId))
            .where(
              and(
                eq(actions.kind, "invite"),
                eq(actions.status, "awaiting_review"),
                eq(actions.origin, "worker"),
                inArray(actions.authorProfileId, profileIds),
              ),
            );
    const assists = await tx
      .select({ personKey: sql<string>`${roomReplyAssists.target} ->> 'personKey'`, texts: roomReplyAssists.texts })
      .from(roomReplyAssists)
      .where(
        and(
          eq(roomReplyAssists.deliverable, "invite_note"),
          inArray(sql<string>`${roomReplyAssists.target} ->> 'personKey'`, personKeys),
        ),
      )
      .orderBy(desc(roomReplyAssists.updatedAt));
    for (const [key, box] of invites) {
      const person = parsePersonKey(box.personKey);
      const found = held.find(
        ({ action }) => person?.kind === "profile" && action.authorProfileId === person.profileId,
      );
      if (found) add(key, fromAction({ ...found.action, text: found.action.candidate.text, why: found.why }));
      add(key, { offered: assists.filter((row) => row.personKey === box.personKey).flatMap((row) => row.texts) });
    }
  }

  const dms = of("dm");
  if (dms.length > 0) {
    const held = await tx
      .select({ action: actions, why: stepRuns.rationaleSummary })
      .from(actions)
      .leftJoin(stepRuns, eq(stepRuns.id, actions.stepRunId))
      .where(
        and(
          inArray(actions.kind, ["dm", "followup"]),
          eq(actions.status, "awaiting_review"),
          eq(actions.origin, "worker"),
          inArray(actions.conversationId, dms.map(([, box]) => box.conversationId)),
        ),
      );
    for (const [key, box] of dms) {
      const found = held.find(({ action }) => action.conversationId === box.conversationId);
      if (found) add(key, fromAction({ ...found.action, text: found.action.candidate.text, why: found.why }));
    }
  }
  return out;
}

/**
 * What each box holds, by the key it was asked by: its angles in the order
 * the bar shows them — the worker's draft waiting on it and the rest of that
 * draft's set first, then the agent's rows by position, less any whose words
 * that set already holds — the worker's draft waiting for a yes, and every
 * agent text the box has ever shown. A key that names no box is left out; a
 * box with nothing in it reads empty.
 */
export async function composerFor(tx: Tx, keys: readonly string[], now = Date.now()): Promise<Map<string, Composer>> {
  const leadKeys = await leadSourceBoxes(tx, [...new Set(keys.flatMap((key) => {
    const box = parseBoxKey(key);
    return box?.kind === "lead" ? [box.leadId] : [];
  }))]);
  const sourceKeys = new Map<string, string>();
  for (const key of keys) {
    const box = parseBoxKey(key);
    sourceKeys.set(key, box?.kind === "lead" && box.signalId === undefined ? leadKeys.get(box.leadId)! : key);
  }
  const parsed = keys.flatMap((key) => {
    const box = parseBoxKey(sourceKeys.get(key)!);
    return box ? [[key, box] as const] : [];
  });
  // One person has one invite box, whichever of their keys names it.
  const invites = await resolvePersonKeys(
    tx,
    parsed.flatMap(([, box]) => (box.kind === "invite" ? [box.personKey] : [])),
  );
  const boxes = new Map<string, ComposerBox>(
    parsed.map(([, box]) => {
      const named: ComposerBox =
        box.kind === "invite" ? { kind: "invite", personKey: invites.get(box.personKey) ?? box.personKey } : box;
      return [boxKey(named), named] as const;
    }),
  );
  if (boxes.size === 0) return new Map();
  const rows = await tx
    .select()
    .from(composerDrafts)
    .where(inArray(composerDrafts.boxKey, [...boxes.keys()]))
    .orderBy(composerDrafts.position);
  const extras = await boxExtras(tx, boxes);
  const composers = new Map<string, Composer>();
  for (const key of boxes.keys()) {
    const own = rows.filter((row) => row.boxKey === key);
    const extra = extras.get(key) ?? NO_EXTRAS;
    // An agent angle the owner put in the waiting draft's set
    // (`useComposerAngle`) is shown once, as the set's.
    const inSet = new Set(extra.workerAngles.map((angle) => textKey(angle.text!)));
    composers.set(key, {
      angles: [
        ...extra.workerAngles,
        ...own.filter((row) => row.text === null || !inSet.has(textKey(row.text))).flatMap((row) => agentAngle(row, now)),
      ],
      waiting: extra.waiting,
      offered: distinct([
        ...extra.workerAngles.map((angle) => angle.text),
        ...own.map((row) => row.text),
        ...(parseBoxKey(key)?.kind === "comment" ? own.map((row) => row.angleWhy) : []),
        ...own.flatMap((row) => [...row.offered].reverse()),
        ...extra.offered,
      ]),
    });
  }
  return new Map(
    parsed.map(([asked, box]) => {
      const key = box.kind === "invite" ? boxKey({ kind: "invite", personKey: invites.get(box.personKey) ?? box.personKey }) : boxKey(box);
      return [asked, composers.get(key)!] as const;
    }),
  );
}

/** Everything one box has ever offered; empty for a key that names none. */
export async function composerOffered(tx: Tx, key: string): Promise<string[]> {
  return (await composerFor(tx, [key])).get(key)?.offered ?? [];
}

/**
 * Both halves of authorship for words saved from a box, against every agent
 * text the box ever showed — no window: a draft Redraft replaced, or one
 * browsed past three angles ago, typed back is still the agent's — and the
 * owner's own typed words over the window a saved comment is measured in.
 * Null when the box offered nothing, where the words are theirs by
 * construction.
 */
export function measureComposer(
  saved: string,
  offered: readonly string[],
  ownerWords?: readonly string[],
): { assistRetention: number; ownerOrigin: number | null } | null {
  if (offered.length === 0) return null;
  const typed = retentionWindow(ownerWords ?? []);
  return {
    assistRetention: assistRetention(saved, offered).retention,
    ownerOrigin: typed.length > 0 ? ownerOrigin(saved, typed).origin : null,
  };
}

/** Of two measures of one save, the one that kept more of the agent's words:
 *  every measure a save is put through can only raise what it kept. */
export function higherRetention<T extends { assistRetention: number | null } | null>(a: T, b: T): T {
  if (b === null || (a?.assistRetention ?? -1) >= (b.assistRetention ?? -1)) return a;
  return b;
}

/** The composer rows of boxes whose words are spent — a DM the owner sent
 *  from its box — or that are forgotten with what they were for — a room's
 *  evidence aged out, someone the owner chose never to engage. */
export async function forgetComposerBoxes(tx: Tx, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const leadKeys = keys.filter((key) => { const box = parseBoxKey(key); return box?.kind === "lead" && box.signalId === undefined; });
  await tx.delete(composerDrafts).where(sql`(${inArray(composerDrafts.boxKey, [...keys])}${sql.join(
    leadKeys.map((key) => sql` or ${composerDrafts.boxKey} like ${`${key}:signal:%`}`), sql``,
  )})`);
}
