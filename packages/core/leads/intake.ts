import { and, count, eq, isNotNull, isNull, max } from "drizzle-orm";
import {
  authorProfiles,
  engagementEvents,
  incomingComments,
  leads,
  type Lead,
  type LeadIntent,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LeadWordsKind } from "../ai/reading";
import { enqueue } from "../jobs/queue";
import { projectedLeadStatus } from "../conversations/leads";
import { leadsEnabled } from "./gate";
import {
  computeLeadTier,
  INTENT_RANK,
  maxIntent,
  maxTier,
  REPEAT_ENGAGER_TOUCHES,
} from "./scoring";

/**
 * Lead intake — a signal from every CAMPAIGN-thread reply, folded in from the
 * reply's stored reading BEFORE any reply gating (`processIncoming`), so a
 * skipped reply can never swallow a lead. Scope is deliberate: only
 * `source='our_comment_thread'` rows (someone answered a comment a campaign
 * posted) are lead signals — comments on the org's OWN posts engage the
 * person's content history, not a campaign, and counting them polluted leads
 * with other-product questions. A reply that could not be read leaves `intent`
 * NULL (= unclassified, distinct from a judged 'none') and the backfill sweeps
 * it later; the reply flow is never blocked.
 */

export type LeadSignalResult = {
  lead: Lead;
  created: boolean;
  /** Crossed into hot on THIS signal (create-at-hot or promoted) — the
   *  notify trigger (PR2 enqueues on it). */
  becameHot: boolean;
};

/**
 * A non-LLM touch (a reaction on one of our campaign comments — the watch
 * carries the campaign). Counts toward the repeat-engager promotion but never
 * creates intent on its own.
 */
export async function recordLeadTouch(
  tx: Tx,
  actor: { profileId: string; name: string | null; campaignId?: number | null },
): Promise<LeadSignalResult | undefined> {
  if (!(await leadsEnabled(tx))) return undefined;
  return upsertLeadFromSignal(tx, {
    profileId: actor.profileId,
    name: actor.name,
    intent: "none",
    evidence: null,
    triggerIncomingCommentId: null,
    campaignId: actor.campaignId ?? null,
  });
}

/** Campaign-thread replies + likes on campaign comments from one person. */
export async function countTouches(tx: Tx, profileId: string): Promise<number> {
  const [comments] = await tx
    .select({ n: count() })
    .from(incomingComments)
    .where(
      and(
        eq(incomingComments.authorProfileId, profileId),
        eq(incomingComments.source, "our_comment_thread"),
      ),
    );
  const [likes] = await tx
    .select({ n: count() })
    .from(engagementEvents)
    .where(
      and(
        eq(engagementEvents.actorProfileId, profileId),
        eq(engagementEvents.type, "like_received"),
      ),
    );
  return (comments?.n ?? 0) + (likes?.n ?? 0);
}

export type LeadSignal = {
  profileId: string;
  name: string | null;
  intent: LeadIntent;
  evidence: string | null;
  triggerIncomingCommentId: number | null;
  /** The campaign whose engagement produced this signal. */
  campaignId: number | null;
  /** Set when the signal is their own words to the owner — a reply, a DM, an
   *  invitation's note — and when they arrived. Only words move a lead's
   *  temperature: a like carries none. */
  words?: { at: number; kind: LeadWordsKind };
};

/**
 * Fold one signal into the (org, profile) lead row. Insert-then-merge: the
 * unique index serializes concurrent signals for the same person (the second
 * tx blocks on the first's insert, then reads its committed row), so the
 * read-modify-write merge is race-safe. Intent and tier only ratchet UP;
 * `dead` reopens on a fresh ≥ product_question signal; `converted` is final —
 * except for a person on a conversation, whose status is the conversation's projection
 * (`conversations/state.ts#projectLead`) and moves with the conversation alone.
 */
export async function upsertLeadFromSignal(
  tx: Tx,
  signal: LeadSignal,
): Promise<LeadSignalResult | undefined> {
  const touchCount = await countTouches(tx, signal.profileId);
  const authority = await authorityFor(tx, signal.profileId);
  // A person on a conversation has the status their conversation projects — whichever
  // of the two writes lands first — and no signal reopens it.
  const projected = await projectedLeadStatus(tx, signal.profileId);
  const now = Date.now();

  const scored = computeLeadTier({ intentLevel: signal.intent, authority, touchCount });

  // Creation threshold: real interest or visible pursuit — a single drive-by
  // 'none' comment never creates a lead row.
  const worthCreating =
    INTENT_RANK[signal.intent] >= INTENT_RANK.positive_signal ||
    touchCount >= REPEAT_ENGAGER_TOUCHES;

  const authorityKnown =
    authority.headline != null || authority.followers != null || authority.isInfluencer != null;
  const opening = worthCreating ? await openingWords(tx, signal) : undefined;

  const [inserted] = worthCreating
    ? await tx
        .insert(leads)
        .values({
          profileId: signal.profileId,
          campaignId: signal.campaignId,
          name: signal.name,
          headline: authority.headline ?? null,
          followers: authority.followers ?? null,
          tier: scored.tier,
          intentLevel: signal.intent,
          evidenceQuote: signal.evidence,
          triggerIncomingCommentId: signal.triggerIncomingCommentId,
          touchCount,
          tierReasons: scored.reasons,
          lastSignalAt: now,
          ...opening,
          ...(projected ? { status: projected } : {}),
        })
        .onConflictDoNothing({ target: [leads.organizationId, leads.profileId] })
        .returning()
    : [undefined];
  if (inserted) {
    const result = { lead: inserted, created: true, becameHot: inserted.tier === "hot" };
    await enqueueNotify(tx, result, signal.intent, authorityKnown);
    return result;
  }

  const [existing] = await tx
    .select()
    .from(leads)
    .where(eq(leads.profileId, signal.profileId));
  if (!existing) return undefined; // below threshold, no prior lead

  const mergedIntent = maxIntent(existing.intentLevel, signal.intent);
  const rescored = computeLeadTier({ intentLevel: mergedIntent, authority, touchCount });
  const mergedTier = maxTier(existing.tier, rescored.tier);
  const intentUpgraded = INTENT_RANK[signal.intent] > INTENT_RANK[existing.intentLevel];
  const status =
    projected ??
    (existing.status === "dead" && INTENT_RANK[signal.intent] >= INTENT_RANK.product_question
      ? "new"
      : existing.status);

  const [updated] = await tx
    .update(leads)
    .set({
      name: signal.name ?? existing.name,
      headline: authority.headline ?? existing.headline,
      followers: authority.followers ?? existing.followers,
      intentLevel: mergedIntent,
      tier: mergedTier,
      tierReasons: rescored.reasons,
      touchCount,
      lastSignalAt: now,
      updatedAt: now,
      ...(signal.words
        ? {
            lastWordsAt: Math.max(existing.lastWordsAt ?? 0, signal.words.at),
            wordTouchCount: existing.wordTouchCount + 1,
          }
        : {}),
      ...(intentUpgraded
        ? {
            evidenceQuote: signal.evidence,
            // A DM or a note has no comment: the one that made them a lead stays.
            ...(signal.triggerIncomingCommentId != null
              ? { triggerIncomingCommentId: signal.triggerIncomingCommentId }
              : {}),
            ...(signal.campaignId != null ? { campaignId: signal.campaignId } : {}),
          }
        : {}),
      ...(status !== existing.status ? { status, statusChangedAt: now } : {}),
    })
    .where(eq(leads.id, existing.id))
    .returning();
  if (!updated) return undefined;

  const result = {
    lead: updated,
    created: false,
    becameHot: mergedTier === "hot" && existing.tier !== "hot",
  };
  await enqueueNotify(tx, result, signal.intent, authorityKnown);
  return result;
}

/**
 * What a new row starts with in the way of words: the person's replies under
 * campaign comments that are still there and already read for intent — the
 * same rows the migration's backfill counted, so a person is not Cold for
 * having written before the row was made — plus this signal when it is a DM or
 * a note, which no row of its own yet records. A reply not yet read is left
 * out: the classification that reads it counts it, once.
 */
async function openingWords(
  tx: Tx,
  signal: LeadSignal,
): Promise<{ lastWordsAt: number | null; wordTouchCount: number }> {
  const [replies] = await tx
    .select({ n: count(), last: max(incomingComments.receivedAt) })
    .from(incomingComments)
    .where(
      and(
        eq(incomingComments.authorProfileId, signal.profileId),
        eq(incomingComments.source, "our_comment_thread"),
        isNull(incomingComments.removedAt),
        isNotNull(incomingComments.intent),
      ),
    );
  const written = signal.words && signal.words.kind !== "comment" ? 1 : 0;
  const times = [replies?.last ?? null, signal.words?.at ?? null].filter((at): at is number => at !== null);
  return {
    lastWordsAt: times.length > 0 ? Math.max(...times) : null,
    wordTouchCount: (replies?.n ?? 0) + written,
  };
}

/**
 * Enqueue the hot-lead notification TRANSACTIONALLY with the lead write.
 * Completed job rows keep their idempotency key forever, so a key must name a
 * distinct trigger, not just the lead: `:hot` fires once, on the crossing;
 * `:pq` covers a warm product_question whose hot-vs-warm answer needs the
 * profile enrichment the notify job performs (it emails only if enrichment
 * lands hot). The job's `notifiedAt` guard makes the pair at-most-one-email.
 */
async function enqueueNotify(
  tx: Tx,
  result: LeadSignalResult,
  signalIntent: LeadIntent,
  authorityKnown: boolean,
): Promise<void> {
  const { lead } = result;
  if (lead.notifiedAt || lead.status !== "new") return;
  const trigger =
    result.becameHot || lead.tier === "hot"
      ? result.becameHot
        ? "hot"
        : undefined // already hot and already had its :hot job
      : signalIntent === "product_question" && !authorityKnown
        ? "pq"
        : undefined;
  if (!trigger) return;
  await enqueue(tx, {
    type: "notify_lead",
    payload: { leadId: lead.id },
    idempotencyKey: `notify_lead:${lead.id}:${trigger}`,
  });
}

async function authorityFor(
  tx: Tx,
  profileId: string,
): Promise<{ headline?: string | null; followers?: number | null; isInfluencer?: boolean | null }> {
  const [cached] = await tx
    .select({
      headline: authorProfiles.headline,
      followers: authorProfiles.followers,
      isInfluencer: authorProfiles.isInfluencer,
    })
    .from(authorProfiles)
    .where(and(eq(authorProfiles.profileId, profileId), isNull(authorProfiles.fetchError)));
  return cached ?? {};
}
