import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  actions,
  incomingInvitations,
  conversationEvents,
  conversations,
  leads,
  messages,
  type LeadFirstSend,
  type Message,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { authorIdentity } from "../people/key";
import { resolvePersonKeys } from "../people/directory";
import { memberId } from "../people/key";
import { ENGAGED_BACK_EVENTS } from "../people/reads";
import { trackLeadContacted, trackRelationshipStarted } from "../telemetry/leadFunnel";

/**
 * How a Find leads person moves on after Scout hands them over: the first
 * send that reaches them makes them Contacted, any of the four ways of
 * answering makes them a Relationship, and a Contacted person nobody heard
 * from in two weeks folds into No answer. The hooks run in the transaction of
 * the send or event they follow, so a rolled-back one moves nobody, each in a
 * savepoint of its own (`followLifecycle`) so one that fails never takes the
 * send or event with it. They only read what already happened: nothing here
 * sends, queues, opens a step, reads LinkedIn or calls a model.
 *
 * Only a row Find leads wrote can move. A row today's intake wrote has no
 * stage and reads as a Relationship (`leadStage`), and a peer, competitor,
 * partner or noise row is never a lead to move. A like moves nobody: it is
 * none of the sends below, nor one of the four answers (`ENGAGED_BACK_EVENTS`).
 */

/** Decision 2(a): a first send nobody answered in this long folds into No
 *  answer. A follow-up inside the caps keeps them there; their count never
 *  restarts. */
export const NO_ANSWER_AFTER_DAYS = 14;
const DAY = 86_400_000;

/** The rows a move may touch: a person is a buyer, or not yet judged one. */
const buyerRole = or(isNull(leads.role), eq(leads.role, "buyer"));
const ofPerson = (profileId: string): SQL => eq(leads.profileId, authorIdentity(profileId));

/**
 * Run one hook beside the send or event it follows. A comment is on LinkedIn
 * before its settle transaction runs, so a hook that throws must not roll the
 * settle back and leave the caps uncounted: the hook gets a savepoint, undoes
 * only itself on failure, and the failure is logged by the hook's name and the
 * error's message. A hook carries ids and times, never what a person wrote.
 */
export async function followLifecycle(
  tx: Tx,
  hook: string,
  run: (savepoint: Tx) => Promise<unknown>,
): Promise<void> {
  try {
    await tx.transaction((savepoint) => run(savepoint));
  } catch (error) {
    console.error(`[leads] lifecycle hook ${hook} failed:`, error instanceof Error ? error.message : String(error));
  }
}

/**
 * The first send that reaches a person: Signal or Lead becomes Contacted, at
 * the send's time, naming the send. Anyone further along stays where they
 * are, so a second send changes nothing. True when someone moved.
 */
export async function markContacted(
  tx: Tx,
  input: { profileId: string; send: LeadFirstSend; at: number },
): Promise<boolean> {
  const before = await tx
    .select({ id: leads.id, stage: leads.stage, intent: leads.intent, fit: leads.fit })
    .from(leads)
    .where(and(ofPerson(input.profileId), inArray(leads.stage, ["signal", "lead"]), buyerRole))
    .for("no key update");
  if (before.length === 0) return false;
  await tx
    .update(leads)
    .set({ stage: "contacted", contactedAt: input.at, firstSend: input.send, updatedAt: Date.now() })
    .where(inArray(leads.id, before.map((lead) => lead.id)));
  const sent = await firstSendFacts(tx, input.send);
  for (const lead of before) {
    trackLeadContacted({ ...sent, lead, from: lead.stage === "signal" ? "signal" : "lead" }, tx);
  }
  return true;
}

/** What a first send was and who wrote it, as the funnel counts it: a send
 *  whose row cannot be read counts as a comment, or an invitation, that went
 *  out unattended — what an unstamped send fails closed to. */
async function firstSendFacts(
  tx: Tx,
  send: LeadFirstSend,
): Promise<{ via: "comment" | "reply" | "room_reply" | "invite"; origin: "owner" | "worker" }> {
  if (send.kind === "action") {
    const [action] = await tx.select({ origin: actions.origin }).from(actions).where(eq(actions.id, send.id));
    return { via: "invite", origin: action?.origin ?? "worker" };
  }
  const [message] = await tx
    .select({ kind: messages.kind, origin: messages.publishOrigin })
    .from(messages)
    .where(eq(messages.id, send.id));
  return { via: message?.kind ?? "comment", origin: message?.origin ?? "worker" };
}

/** How a person answered, as the funnel names the first answer. */
export type FirstAnswer = "reply" | "message" | "invite_received" | "invite_accepted";

/**
 * They answered: Signal, Lead, Contacted or No answer becomes a Relationship,
 * at the answer's own time. Someone who is one already keeps the date they
 * became it. True when someone moved.
 */
export async function markRelationship(
  tx: Tx,
  input: { profileId: string; at: number; kind: FirstAnswer },
): Promise<boolean> {
  const moved = await tx
    .update(leads)
    .set({ stage: "relationship", relationshipAt: input.at, updatedAt: Date.now() })
    .where(and(
      ofPerson(input.profileId),
      inArray(leads.stage, ["signal", "lead", "contacted", "no_answer"]),
      buyerRole,
    ))
    .returning({ origin: leads.origin, contactedAt: leads.contactedAt });
  for (const lead of moved) trackRelationshipStarted({ kind: input.kind, lead, at: input.at }, tx);
  return moved.length > 0;
}

/**
 * Fold every Contacted person whose first send is two weeks old and who has
 * not answered since into No answer; returns how many. The answer is read
 * from the conversation log as well as the stage, so a person whose answer the
 * hooks somehow missed is left where they are and never reported as silent;
 * so is anyone who sent the account an invitation, which waits for the owner
 * rather than on the person.
 */
export async function foldNoAnswer(tx: Tx, now: number): Promise<number> {
  const answers = sql.join(ENGAGED_BACK_EVENTS.map((type) => sql`${type}`), sql`, `);
  const folded = await tx
    .update(leads)
    .set({ stage: "no_answer", updatedAt: now })
    .where(and(
      eq(leads.stage, "contacted"),
      sql`${leads.contactedAt} <= ${now - NO_ANSWER_AFTER_DAYS * DAY}`,
      buyerRole,
      sql`not exists (
        select 1 from ${conversationEvents} join ${conversations}
          on ${conversations.organizationId} = ${conversationEvents.organizationId} and ${conversations.id} = ${conversationEvents.conversationId}
        where ${conversations.authorProfileId} = ${leads.profileId}
          and ${conversationEvents.type} in (${answers})
          and ${conversationEvents.observedAt} >= ${leads.contactedAt})`,
      sql`not exists (
        select 1 from ${incomingInvitations}
        where ${incomingInvitations.organizationId} = ${leads.organizationId}
          and ${incomingInvitations.senderProfileId} = ${leads.profileId})`,
    ))
    .returning({ id: leads.id });
  return folded.length;
}

/**
 * The profile a settled send reached: the author of the post a comment is on,
 * the comment author a reply answers, or a room reply's person — by the profile id
 * the message froze, else by the profile their member urn is known as.
 */
export async function reachedProfile(
  tx: Tx,
  message: Pick<Message, "targetProfileId" | "roomReplyTarget">,
): Promise<string | null> {
  if (message.targetProfileId) return message.targetProfileId;
  const member = memberId(message.roomReplyTarget?.memberUrn);
  if (member === null) return null;
  const key = `m.${member}`;
  const known = (await resolvePersonKeys(tx, [key])).get(key);
  return known?.startsWith("p.") ? known.slice(2) : null;
}
