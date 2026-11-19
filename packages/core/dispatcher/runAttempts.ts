import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  discoveredPosts,
  draftAttempts,
  draftPlans,
  leads,
  leadSignals,
  messages,
  type LeadSignalKind,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { postExcerpt } from "../operations/postSnippets";
import type { DraftAttempt } from "./draftFromPlans";
import { DraftPlanSchema, PlanVerdictSchema, type DraftPlan } from "./types";

/**
 * One run's planned drafts, as its run page shows them (spec "Draft
 * Dispatcher" v0.3): every plan the run saved, the post it was planned for —
 * or, for an opener, the lead and the words of theirs it answers — each text
 * written from it with what the judge said, and the message an admitted one
 * became. So a draft held back reads beside the plan item it
 * missed, rather than as a count in the run's note.
 *
 * Pure reads in the caller's org transaction. A plan this engine cannot read,
 * or whose attempts it cannot, is left out and counted rather than shown in
 * part.
 */

export type RunPlan = {
  planId: number;
  discoveredPostId: number | null;
  /** The post it was planned for; null when the plan names none or the post
   *  is gone. */
  post: {
    authorName: string | null;
    authorProfileId: string | null;
    excerpt: string | null;
    url: string | null;
  } | null;
  /** The lead an opener was planned for, from its box, the words of theirs
   *  it answers and where those are theirs — a post of their own or a
   *  comment; null for a plan on a discovered post. */
  lead: {
    profileId: string;
    name: string | null;
    excerpt: string | null;
    url: string | null;
    wordsIn: LeadSignalKind;
  } | null;
  plan: DraftPlan;
  /** Oldest first: the first text, then the one rewrite a miss earns. Empty
   *  when the writer returned nothing for it. */
  attempts: DraftAttempt[];
  /** The message an admitted draft became. */
  messageId: number | null;
};

export type RunPlans = { plans: RunPlan[]; unreadable: number };

const AttemptsSchema = z.array(
  z.object({
    attempt: z.union([z.literal(1), z.literal(2)]),
    text: z.string(),
    verdicts: z.array(PlanVerdictSchema),
    outcome: z.enum(["admitted", "rewrite", "withheld", "held", "discarded"]),
    reason: z.string().nullable(),
  }),
);

export async function listRunPlans(tx: Tx, runId: number, limit = 100): Promise<RunPlans> {
  const rows = await tx
    .select({
      id: draftPlans.id,
      discoveredPostId: draftPlans.discoveredPostId,
      boxKey: draftPlans.boxKey,
      plan: draftPlans.plan,
      postId: discoveredPosts.id,
      authorName: discoveredPosts.authorName,
      authorProfileId: discoveredPosts.authorProfileId,
      contentText: discoveredPosts.contentText,
      url: discoveredPosts.url,
    })
    .from(draftPlans)
    .leftJoin(
      discoveredPosts,
      and(
        eq(discoveredPosts.organizationId, draftPlans.organizationId),
        eq(discoveredPosts.id, draftPlans.discoveredPostId),
      ),
    )
    .where(eq(draftPlans.runId, runId))
    .orderBy(asc(draftPlans.id))
    .limit(limit);
  if (rows.length === 0) return { plans: [], unreadable: 0 };

  const ids = rows.map((row) => row.id);
  const attempts = new Map<number, unknown[]>();
  for (const { planId, ...attempt } of await tx
    .select({
      planId: draftAttempts.planId,
      attempt: draftAttempts.attempt,
      text: draftAttempts.text,
      verdicts: draftAttempts.verdicts,
      outcome: draftAttempts.outcome,
      reason: draftAttempts.reason,
    })
    .from(draftAttempts)
    .where(inArray(draftAttempts.planId, ids))
    .orderBy(asc(draftAttempts.planId), asc(draftAttempts.attempt))) {
    attempts.set(planId, [...(attempts.get(planId) ?? []), attempt]);
  }
  const written = new Map<number, number>();
  for (const message of await tx
    .select({ id: messages.id, planId: messages.draftPlanId })
    .from(messages)
    .where(inArray(messages.draftPlanId, ids))
    .orderBy(asc(messages.id))) {
    if (message.planId != null && !written.has(message.planId)) written.set(message.planId, message.id);
  }

  // An opener's box names its lead, and the signal it answers where it has one.
  const boxes = new Map(rows.map((row) => [row.id, /^lead:(\d+)(?::signal:(\d+))?$/.exec(row.boxKey ?? "")] as const));
  const leadIds = [...new Set([...boxes.values()].flatMap((box) => (box ? [Number(box[1])] : [])))];
  const signalIds = [...new Set([...boxes.values()].flatMap((box) => (box?.[2] ? [Number(box[2])] : [])))];
  const people = new Map(
    (leadIds.length > 0
      ? await tx.select({ id: leads.id, profileId: leads.profileId, name: leads.name }).from(leads).where(inArray(leads.id, leadIds))
      : []
    ).map((lead) => [lead.id, lead] as const),
  );
  const said = new Map(
    (signalIds.length > 0
      ? await tx
          .select({ id: leadSignals.id, words: leadSignals.words, url: leadSignals.url, kind: leadSignals.kind })
          .from(leadSignals)
          .where(inArray(leadSignals.id, signalIds))
      : []
    ).map((signal) => [signal.id, signal] as const),
  );
  // A box that names no signal answers their newest words the screen passed.
  const newest = new Map<number, { words: string; url: string | null; kind: LeadSignalKind }>();
  if (leadIds.length > 0) {
    for (const signal of await tx
      .select({ leadId: leadSignals.leadId, words: leadSignals.words, url: leadSignals.url, kind: leadSignals.kind })
      .from(leadSignals)
      .where(and(inArray(leadSignals.leadId, leadIds), eq(leadSignals.verdict, "passed")))
      .orderBy(desc(leadSignals.seenAt), desc(leadSignals.id))) {
      if (signal.leadId != null && !newest.has(signal.leadId)) newest.set(signal.leadId, signal);
    }
  }
  const leadOf = (planId: number): RunPlan["lead"] => {
    const box = boxes.get(planId);
    const lead = box ? people.get(Number(box[1])) : undefined;
    if (!lead) return null;
    const signal = (box?.[2] ? said.get(Number(box[2])) : undefined) ?? newest.get(lead.id);
    return {
      profileId: lead.profileId,
      name: lead.name,
      excerpt: postExcerpt(signal?.words ?? null),
      url: signal?.url ?? null,
      wordsIn: signal?.kind ?? "post",
    };
  };

  let unreadable = 0;
  const plans = rows.flatMap((row): RunPlan[] => {
    const plan = DraftPlanSchema.safeParse(row.plan);
    const tried = AttemptsSchema.safeParse(attempts.get(row.id) ?? []);
    if (!plan.success || !tried.success) {
      unreadable += 1;
      return [];
    }
    return [
      {
        planId: row.id,
        discoveredPostId: row.discoveredPostId,
        post:
          row.postId == null
            ? null
            : {
                authorName: row.authorName,
                authorProfileId: row.authorProfileId,
                excerpt: postExcerpt(row.contentText),
                url: row.url,
              },
        lead: leadOf(row.id),
        plan: plan.data,
        attempts: tried.data,
        messageId: written.get(row.id) ?? null,
      },
    ];
  });
  return { plans, unreadable };
}
