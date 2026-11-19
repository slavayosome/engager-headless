/**
 * The lead funnel's usage data (US-LMF-12): found, lead, contacted, came back,
 * one small function per event, called from the write that made it true. Each
 * turns what the product holds into the catalog's enums and drops the rest —
 * no name, no word, no URL, no profile id ever leaves — and every one sent
 * from inside a transaction waits for its commit (`afterCommitOrNow`).
 */
import { eq, sql } from "drizzle-orm";
import { leads, personReads, type Lead, type LeadFit, type LeadRating, type ScoutIntent, type SearchDepth } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import { hoursBucket } from "@engager/observability/classify";
import type { TelemetryProps } from "@engager/observability/events";
import { leadTemperatureOf } from "../leads/temperature";
import { resolvePersonKeys } from "../people/directory";
import { isUnread, readAnswers } from "../people/reads";
import { afterCommitOrNow } from "./emit";

type FunnelIntent = TelemetryProps<"lead_served">["intent"];
type FunnelFit = TelemetryProps<"lead_served">["fit"];

const INTENT: Record<ScoutIntent, FunnelIntent> = { asking: "asking", has_problem: "problem", topic_only: "topic" };

/** What their words show, as the funnel counts it: `none` where nothing has
 *  judged them. */
export function funnelIntent(intent: ScoutIntent | null): FunnelIntent {
  return intent === null ? "none" : INTENT[intent];
}

/** How well they fit: `unchecked` where no fit check has judged them. */
export function funnelFit(fit: LeadFit | null): FunnelFit {
  return fit ?? "unchecked";
}

/** Find leads put a person on Leads: a Signal whose words passed the screen,
 *  or a Lead Research judged. */
export function trackLeadServed(
  input: { stage: "signal" | "lead"; lead: Pick<Lead, "intent" | "fit">; depth: SearchDepth },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () =>
    track("lead_served", {
      stage: input.stage,
      intent: funnelIntent(input.lead.intent),
      fit: funnelFit(input.lead.fit),
      depth: input.depth,
    }),
  );
}

/** The owner's answer to "Is this right?", beside what Scout judged. */
export function trackLeadRated(input: { rating: LeadRating; lead: Pick<Lead, "intent" | "fit"> }, tx?: Tx): void {
  afterCommitOrNow(tx, () =>
    track("lead_rated", {
      rating: input.rating === "a_peer" ? "peer" : input.rating,
      intent: funnelIntent(input.lead.intent),
      fit: funnelFit(input.lead.fit),
    }),
  );
}

/** Research judged a Signal, or could not read them: on the owner's press, in a
 *  run, or by Judge, which takes one person at a time as a step. */
export function trackSignalResearched(input: TelemetryProps<"signal_researched">, tx?: Tx): void {
  afterCommitOrNow(tx, () => track("signal_researched", { trigger: input.trigger, outcome: input.outcome }));
}

/** The first send that reached a person Find leads found, from the stage they
 *  were at. */
export function trackLeadContacted(
  input: {
    via: TelemetryProps<"lead_contacted">["via"];
    origin: "owner" | "worker";
    lead: Pick<Lead, "intent" | "fit">;
    from: "signal" | "lead";
  },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () =>
    track("lead_contacted", {
      via: input.via,
      origin: input.origin,
      intent: funnelIntent(input.lead.intent),
      fit: funnelFit(input.lead.fit),
      from: input.from,
    }),
  );
}

/** Their first answer made them a Relationship, so long after the first send
 *  that reached them. */
export function trackRelationshipStarted(
  input: {
    kind: TelemetryProps<"relationship_started">["kind"];
    lead: Pick<Lead, "origin" | "contactedAt">;
    at: number;
  },
  tx?: Tx,
): void {
  const { contactedAt } = input.lead;
  afterCommitOrNow(tx, () =>
    track("relationship_started", {
      kind: input.kind,
      // A row today's intake wrote names no origin: they came in on their own.
      origin: input.lead.origin ?? "inbound",
      hours_since_contact_bucket: contactedAt === null ? "not_contacted" : hoursBucket(input.at - contactedAt),
    }),
  );
}

/**
 * What opening `key` in the Inbox tells, read before it marks them read: their
 * temperature by their words to the owner, and whether they were unread. Null
 * for someone the Inbox does not hold, and for a read that failed: the reads
 * run in a savepoint of their own, as the lifecycle hooks do
 * (`followLifecycle`), so one that fails never aborts the opening it sits
 * beside.
 */
export async function inboxPersonState(
  tx: Tx,
  key: string,
  now: number,
): Promise<TelemetryProps<"inbox_person_read"> | null> {
  try {
    return await tx.transaction((savepoint) => readPersonState(savepoint, key, now));
  } catch (error) {
    console.error("[leads] inbox person state failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function readPersonState(tx: Tx, key: string, now: number): Promise<TelemetryProps<"inbox_person_read"> | null> {
  const person = (await resolvePersonKeys(tx, [key])).get(key) ?? key;
  const answer = (await readAnswers(tx, { personKeys: [person] })).get(person);
  if (!answer) return null;
  const [read] = await tx.select({ readAt: personReads.readAt }).from(personReads).where(eq(personReads.personKey, person));
  const [lead] = person.startsWith("p.")
    ? await tx.select().from(leads).where(eq(leads.profileId, person.slice("p.".length)))
    : [];
  return {
    // The lead row alone: a decline is read from their messages, and is not sent.
    temperature: ((heat) => (heat && heat !== "declined" ? heat : "none"))(lead ? leadTemperatureOf(lead, now)?.temperature : null),
    was_unread: isUnread({ newestObservedAt: answer.observedAt, readAt: read?.readAt ?? null }),
  };
}

/** The owner opened a person in the Inbox. */
export function trackInboxPersonRead(input: TelemetryProps<"inbox_person_read">, tx?: Tx): void {
  afterCommitOrNow(tx, () => track("inbox_person_read", { temperature: input.temperature, was_unread: input.was_unread }));
}

/** A campaign's Scout step moved from Find posts to Find leads. */
export function trackScoutStepSwitched(
  input: { source: TelemetryProps<"scout_step_switched">["source"]; depth: SearchDepth },
  tx?: Tx,
): void {
  afterCommitOrNow(tx, () =>
    track("scout_step_switched", { from: "find_posts", to: "find_leads", source: input.source, depth: input.depth }),
  );
}
