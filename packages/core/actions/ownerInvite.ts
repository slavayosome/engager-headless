import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { measureBoxAssist, retentionWindow } from "@engager/common/text-provenance";
import { jobs, conversations, type ActionRow } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { boxKey, composerOffered, higherRetention, measureComposer } from "../composer/drafts";
import { openOwnerConversation } from "../conversations/record";
import { assertJudgedWords } from "../dispatcher/landedJudge";
import { enqueue } from "../jobs/queue";
import { findPerson, type Person } from "../people/directory";
import { memberId } from "../people/key";
import { channelCeilings } from "../ratelimit/ledger";
import { roomInviteSource, type RoomInviteOrigin } from "../rooms/inviteSource";
import { roomInviteAssistTexts } from "../rooms/assistProvenance";
import { approveAction } from "./approval";
import { ActionLedgerError } from "./errors";
import { inviteTargetFor, invitationRefusal, WITHDRAWAL_COOL_OFF_MS } from "./invite";
import { reserveAction } from "./ledger";
import { currentGeneration } from "./pause";
import { notPermitted, ownerCampaignFor, ownerRefusal } from "./ownerPress";

/**
 * AN INVITE THE OWNER WROTE — typed on a person's header and sent on their own
 * press (INV-1, INV-7). The note is theirs, so the row is `origin: owner`: the
 * gate spaces it and never caps it, and the press is the yes — approved in the
 * transaction that reserves it.
 *
 * It is the invite path's own row, not a second one: reserved through the
 * ledger's one door (`reserveAction`, which re-reads the conversation, every Stop on
 * it and the person's exclusion) under the key a worker's invite takes, so a
 * person is invited once whoever proposes it. The dispatch gate then does for
 * it what it does for any approved invite (`inviteOperation`): reads their
 * profile in this browser session and sends only when LinkedIn's data says
 * they are not connected and nothing is pending either way. The press is the
 * yes, so it goes out before invites are verified on the account, and its
 * confirmed receipt can be the one that verifies them.
 *
 * Someone Engager never met in a conversation gets one opened for the press
 * (`openOwnerConversation`) under a running campaign that touched them, and under
 * none where no campaign did: the invite is then the owner's own, on the
 * account alone, which no campaign's Stop, pause or policy governs and no
 * campaign is credited with (`ownerCampaignFor`). Someone known only by a
 * member urn has no profile address to invite by until a read of their own
 * profile binds the urn to one: the press queues that read with the owner's
 * note (`owner_invite_member`), and the invite goes this same way once it
 * does — never by a guess. Without a member urn there is nothing to read.
 *
 * Words their agent wrote for the box (Draft for me, `chat/requestedInvite.ts`)
 * stay the owner's to send, and are measured at the press as a DM's are — how
 * much of them the note kept, and how much of what the owner had typed before
 * them — and kept on the candidate (`assist`), so a note that is mostly the
 * agent's is never taken for the owner's own voice.
 */

/** Words an agent offered for the owner's box, newest first, and what the
 *  owner had typed into it before them. */
export type InviteAssist = { assistTexts?: readonly string[]; ownerWords?: readonly string[] };

/** What the owner sees when an invite is refused for where they stand with
 *  the person, and what to do. */
const STANDING_COPY: Record<string, [string, string]> = {
  already_connected: ["You're already connected.", "Message them instead."],
  invitation_pending: ["An invite is already pending.", "Wait for their answer, or withdraw it first."],
  invitation_incoming: ["They already invited you.", "Accept their invite instead."],
  recently_withdrawn: [
    "LinkedIn allows a new invite 3 weeks after a withdrawal.",
    "Try again when the three weeks have passed.",
  ],
  invitation_sent: ["You already invited them.", "Engager never sends a second invite."],
  self: ["That is your own profile.", "Nothing to send."],
};

function refusedFor(reason: string): ActionLedgerError {
  const copy = STANDING_COPY[reason];
  return copy
    ? notPermitted(copy[0], copy[1])
    : ownerRefusal(reason, ["Engager will not invite them now.", "Invite them on LinkedIn."]);
}

/** Why the last read of the person rules an invite out, before any conversation is
 *  opened for them; null when it does not. */
export function inviteStandingRefusal(
  person: Pick<Person, "relationship" | "latestRead">,
  now: number,
): string | null {
  if (person.latestRead.self) return "self";
  if (person.relationship === "connected") return "already_connected";
  if (person.relationship === "outgoing_pending") return "invitation_pending";
  if (person.relationship === "incoming_pending") return "invitation_incoming";
  const { invitation, at } = person.latestRead;
  if (invitation === "withdrawn" && at !== null && at + WITHDRAWAL_COOL_OFF_MS > now) return "recently_withdrawn";
  return null;
}

export async function ownerInvite(
  tx: Tx,
  input: {
    personKey: string;
    /** The campaign the page acted from; the server falls back to the one
     *  the conversation belongs to, or a running one that touched them. */
    campaignId?: number | null;
    openedFrom?: RoomInviteOrigin;
    note: string;
    by: string;
    now?: number;
  } & InviteAssist,
): Promise<{ action: ActionRow }> {
  const now = input.now ?? Date.now();
  const note = input.note.trim();
  if (note.length === 0) {
    throw new ActionLedgerError("action_text_required", "An invite needs a note.", "Say why you'd like to connect.");
  }
  const person = await findPerson(tx, input.personKey);
  if (!person) {
    throw new ActionLedgerError("conversation_not_found", "Engager does not know that person.", "Reload the Inbox.");
  }
  if (person.profileId === null) {
    throw notPermitted(
      "Engager has no profile address for them yet, so it cannot invite them from here.",
      "Invite them on LinkedIn.",
    );
  }
  const standing = inviteStandingRefusal(person, now);
  if (standing) throw refusedFor(standing);

  const [existing] =
    person.conversationId === null ? [] : await tx.select().from(conversations).where(eq(conversations.id, person.conversationId));
  const room = input.openedFrom ? await roomInviteSource(tx, {
    campaignId: input.campaignId ?? null, personKey: person.canonicalKey, openedFrom: input.openedFrom, now,
  }) : null;
  if (room && existing && (existing.owningCampaignId !== room.campaign.id || existing.channelId !== room.channelId)) {
    throw notPermitted("This person already has a conversation under another campaign.", "Open that conversation to invite them.");
  }
  const campaign = room ? { id: room.campaign.id, channelId: room.channelId } : await ownerCampaignFor(tx, {
    person,
    conversation: existing ?? null,
    asked: input.campaignId ?? null,
  });
  const channelId = existing?.channelId ?? campaign?.channelId ?? (await channelCeilings(tx))?.id;
  if (channelId === undefined) {
    throw notPermitted("No LinkedIn account is connected, so Engager sends nothing from here.", "Connect it on the Channel.");
  }
  const conversation = await openOwnerConversation(tx, {
    channelId,
    campaignId: campaign?.id ?? null,
    profileId: person.profileId,
    now,
    openedFrom: input.openedFrom,
  });
  if (room && (conversation.owningCampaignId !== room.campaign.id || conversation.channelId !== room.channelId)) {
    throw notPermitted("This person already has a conversation under another campaign.", "Open that conversation to invite them.");
  }
  const refused = await invitationRefusal(tx, conversation, now);
  if (refused) throw refusedFor(refused);

  // With no agent words offered, the owner's words by construction; every
  // angle their invite box kept counts beside the ones the page sent.
  const offered = retentionWindow([...(room ? await roomInviteAssistTexts(tx, room) : []), ...(input.assistTexts ?? [])]);
  const assisted = higherRetention(
    measureBoxAssist(note, offered, input.ownerWords),
    measureComposer(note, await composerOffered(tx, boxKey({ kind: "invite", personKey: person.canonicalKey })), input.ownerWords),
  );
  const reserved = await reserveAction(tx, {
    channelId: conversation.channelId,
    campaignId: conversation.owningCampaignId,
    conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId,
    kind: "invite",
    purpose: "opener",
    target: inviteTargetFor(conversation.authorProfileId),
    candidate: {
      text: note,
      ...(assisted ? { assist: assisted } : {}),
      sources: [],
      versions: { strategy: null, facts: [], memory: null, voice: null },
    },
    origin: "owner",
    mode: "review",
    generationSeen: await currentGeneration(tx),
    now,
  });
  if (reserved.status === "refused") throw refusedFor(reserved.reason);
  if (reserved.status === "duplicate") {
    throw notPermitted(
      reserved.action.status === "awaiting_review"
        ? "An invite to them is already waiting for your yes."
        : "An invite to them is already on its way.",
      reserved.action.status === "awaiting_review"
        ? "Approve or reword that one under Public."
        : "Engager settles it by reading their profile, never by sending it again.",
    );
  }
  return approveAction(tx, { id: reserved.action.id, approver: input.by, now });
}

/** How long the owner's invite to someone known only by a member urn waits
 *  on the read that finds their profile address. */
const MEMBER_INVITE_WINDOW_MS = 24 * 60 * 60_000;

/** The codes a member invite's refusal takes on its job's result, which the
 *  person's page reads back by ({@link readMemberInviteRefusal}). */
export const MEMBER_INVITE_REFUSALS = {
  unbound: "profile_unbound",
  refused: "invite_refused",
} as const;

/** The owner's invite to someone known only by a member urn, as its job
 *  carries it: the read that finds their profile address, and the press it
 *  then makes (`jobs/handlers/ownerInviteMember.ts`). */
export type OwnerInviteMemberPayload = {
  memberUrn: string;
  channelId: number;
  campaignId: number | null;
  note: string;
  by: string;
  assistTexts?: readonly string[];
  ownerWords?: readonly string[];
  expiresAt: number;
  openedFrom?: RoomInviteOrigin;
  roomAccountProfileId?: string;
  generationSeen?: number;
};

/**
 * The owner's Invite press on a person's header: {@link ownerInvite} for
 * someone Engager has a profile address for; for someone known only by a
 * member urn, the read of their own profile that finds one, queued with the
 * owner's note (`owner_invite_member`), which presses this same invite once
 * it does. `queued` says the invite waits on that read.
 */
export async function pressOwnerInvite(
  tx: Tx,
  input: Parameters<typeof ownerInvite>[1],
): Promise<{ action: ActionRow } | { queued: "profile_read" }> {
  await assertJudgedWords(tx, input.note);
  const person = await findPerson(tx, input.personKey);
  // Anyone with an address to invite by, anyone unknown, and anyone with
  // neither an address nor a member id to read one by is `ownerInvite`'s own
  // to answer.
  if (person === null || person.profileId !== null || memberId(person.memberUrn) === null) {
    return ownerInvite(tx, input);
  }
  const note = input.note.trim();
  if (note.length === 0) {
    throw new ActionLedgerError("action_text_required", "An invite needs a note.", "Say why you'd like to connect.");
  }
  await queueMemberInvite(tx, {
    person,
    memberUrn: person.memberUrn!,
    input,
    note,
    now: input.now ?? Date.now(),
  });
  return { queued: "profile_read" };
}

/** Queue the read of a member-urn person's own profile, with the owner's
 *  note, on the account a campaign of theirs is on — one per person at a
 *  time. Where they stand as last read rules it out first, as for
 *  anyone. */
async function queueMemberInvite(
  tx: Tx,
  opts: {
    person: Person;
    memberUrn: string;
    input: { campaignId?: number | null; by: string; openedFrom?: RoomInviteOrigin } & InviteAssist;
    note: string;
    now: number;
  },
): Promise<void> {
  const { person, now } = opts;
  const standing = inviteStandingRefusal(person, now);
  if (standing) throw refusedFor(standing);
  const room = opts.input.openedFrom ? await roomInviteSource(tx, {
    campaignId: opts.input.campaignId ?? null, personKey: person.canonicalKey, openedFrom: opts.input.openedFrom, now,
  }) : null;
  const campaign = room ? { id: room.campaign.id, channelId: room.channelId } :
    await ownerCampaignFor(tx, { person, conversation: null, asked: opts.input.campaignId ?? null });
  const channelId = campaign?.channelId ?? (await channelCeilings(tx))?.id;
  if (channelId === undefined) {
    throw notPermitted("No LinkedIn account is connected, so Engager sends nothing from here.", "Connect it on the Channel.");
  }
  const payload: OwnerInviteMemberPayload = {
    memberUrn: opts.memberUrn,
    channelId,
    campaignId: campaign?.id ?? null,
    note: opts.note,
    by: opts.input.by,
    assistTexts: retentionWindow([...(room ? await roomInviteAssistTexts(tx, room) : []), ...(opts.input.assistTexts ?? [])]),
    ...(opts.input.ownerWords ? { ownerWords: opts.input.ownerWords } : {}),
    expiresAt: now + MEMBER_INVITE_WINDOW_MS,
    ...(room ? { openedFrom: room.openedFrom, roomAccountProfileId: room.accountProfileId,
      generationSeen: await currentGeneration(tx) } : {}),
  };
  // One read at a time per person; once it has run, a press may queue
  // another. The queue is excluded from RLS, so it is read by the org.
  const [waiting] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
        eq(jobs.type, "owner_invite_member"),
        inArray(jobs.status, ["queued", "running"]),
        sql`${jobs.payload} ->> 'memberUrn' = ${opts.memberUrn}`,
      ),
    )
    .limit(1);
  if (waiting) {
    throw notPermitted(
      "An invite to them is already waiting on a read of their profile.",
      "Engager sends it once the read finds their profile address.",
    );
  }
  await enqueue(tx, {
    type: "owner_invite_member",
    payload,
    nextRunAt: now,
    idempotencyKey: `owner_invite_member:${opts.memberUrn}:${now}`,
  });
}

/**
 * What the owner's newest invite to someone known only by a member urn came
 * to when nothing was sent, in plain words, and when: the newest finished
 * read-and-invite job for them, if it completed with a refusal — their
 * profile gave no address to invite by, or where they stand ruled the invite
 * out. The press returned when it queued the job, so this is how the person's
 * page learns the rest.
 */
export async function readMemberInviteRefusal(
  tx: Tx,
  memberUrn: string,
): Promise<{ text: string; at: number } | null> {
  const [job] = await tx
    .select({ result: jobs.result, at: jobs.updatedAt })
    .from(jobs)
    .where(
      and(
        sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
        eq(jobs.type, "owner_invite_member"),
        eq(jobs.status, "done"),
        sql`${jobs.payload} ->> 'memberUrn' = ${memberUrn}`,
      ),
    )
    .orderBy(desc(jobs.updatedAt))
    .limit(1);
  // A job that counted something wrote numbers where a refusal writes its rung.
  const refusal = typeof job?.result?.refusal === "object" ? job.result.refusal : null;
  const named = Object.values<string>(MEMBER_INVITE_REFUSALS).includes(refusal?.code ?? "");
  return job && refusal?.detail && named ? { text: refusal.detail, at: job.at } : null;
}
