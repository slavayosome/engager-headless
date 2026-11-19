import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  draftAttempts,
  draftPlans,
  leadSignals,
  type AuthorProfileReadJson,
  type Campaign,
  type DraftingKnobs,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { noteLimitFor } from "../../agentStep/writing";
import type { LLM } from "../../ai/client";
import type { KnowledgeRetrievalSnapshot } from "../../brain/knowledge";
import { boxKey, composerFor } from "../../composer/drafts";
import { resolveSavedWritingVoice } from "../../strategy/writingInstructions";
import { budgetFor } from "../../dispatcher/budgets";
import { compiledRulesAtHand, compiledRulesFor, compileRules, writingRulesRevision, type CompiledWritingRules } from "../../dispatcher/compile";
import { planOrCompose } from "../../dispatcher/compose";
import { dispatchedWithheldNote, draftFromPlans, saveAttempts, type DispatchItem } from "../../dispatcher/draftFromPlans";
import { judgeLanded } from "../../dispatcher/landedJudge";
import type { PlanningItem } from "../../dispatcher/planCheck";
import { ownerPlanningFacts, savePlans } from "../../dispatcher/planner";
import { rulesInputs, type DispatchPreview } from "../../dispatcher/phase";
import { renderPlan } from "../../dispatcher/writer";
import { DEFAULT_DRAFTING_KNOBS } from "../../learning/styleVariety";
import { finalizeBrainForWriter, prepareBrainForWriter } from "../../draft";
import { freshProducts } from "../../agentStep/writing";
import type { DraftConversation, DraftPlan, OwnerAsk } from "../../dispatcher/types";
import { recentAgentDrafts } from "../../draft";
import { sentTexts } from "../../operations/sentTexts";
import { profileReads } from "../../operations/researchReads";
import { getProfile } from "../../profile";
import { contextHash } from "../../tasks/hash";
import { productEvidenceFacts, type DraftEvidence } from "../../workers/evidenceReview";
import { awaitsOpener } from "../read";
import { leadStandings } from "./eligibility";
import {
  leadOpener,
  leadOpeners,
  openerContext,
  openerPlan,
  withinOpener,
  type LeadOpener,
} from "./opener";

/**
 * AN OPENER WRITTEN ON ITS OWN: the draft a step writes to someone it was
 * served (US-LMF-05), from the first way in their box holds. Each is planned —
 * a `DraftPlan` keyed on the lead's box, never a discovered post — written from
 * its plan and judged against it, the fifty-people test among the items. A
 * draft that misses is written once more from the same plan and, missing
 * again, withheld; one that could go to fifty other people is planned anew
 * around it instead, and withheld if the new plan's draft misses too.
 *
 * It writes no `discovered_posts` row, and queues, approves and sends nothing:
 * what comes back is raw material for the step that asked, whose mode decides
 * what happens to it. Their words reach every prompt fenced as untrusted data,
 * and so does the way in an opener takes, which a model drew from them.
 *
 * Where it goes follows where they said it — a comment on their post, a reply
 * under their comment — unless the step asks for an invitation's note, which
 * is written in the owner's DM voice and held to the composer's character
 * limit for them.
 */

/** One opener that passed, for the step to put in the lead's box. */
export type OpenerDraft = {
  leadId: number;
  signalId: number;
  text: string;
  /** The box position of the way in it wrote out; null where the box held
   *  none. */
  angle: number | null;
  /** The saved plan it was written from; null with the dispatcher off. */
  planId: number | null;
  /** The plan, as the writer followed it; absent on a draft held from an earlier run. */
  plan?: DraftPlan;
};

export type OpenersWritten = {
  drafted: OpenerDraft[];
  /** How many were withheld, and why, in the owner's words. */
  withheld: number;
  note: string | null;
  /** The plan an ask stopped at (`own.planOnly`). */
  plan?: DraftPlan;
  preview?: { result: DispatchPreview; knobs: Pick<DraftingKnobs, "exemplarCount" | "rationing">; compiled: CompiledWritingRules & { revision: string } };
};

export type OpenerDraftsInput = {
  organizationId: string;
  campaign: Campaign;
  llm: LLM;
  /** The leads the step writes to, frozen by it. */
  leadIds: readonly number[];
  runId: number | null;
  now: number;
  /** Where the openers go when it is not where they said it: the note of a
   *  connection invitation. Unset, each is written where they said it. */
  surface?: "invitation";
  continueRun?: () => Promise<boolean>;
  /** The vault as the run read it, so the writer meets what its apply checks. */
  knowledge?: KnowledgeRetrievalSnapshot;
};

/** What the owner asked of one opener in a box of theirs: only a claim the
 *  evidence does not support holds it back, and an ask for an idea stops at
 *  the plan. */
type OwnerRequest = { ownerRequested: true; ask?: OwnerAsk; planOnly?: boolean };

/** One person an opener is written to, with the way in it takes. */
type Subject = LeadOpener & {
  angle: { position: number; name: string; why: string } | null;
  /** What Research read of them, if it has. */
  profile: AuthorProfileReadJson | undefined;
};

type Surface = "comment" | "room_reply" | "invitation";

/** Their post is commented on; their comment under someone else's, replied
 *  under. */
const surfaceOf = (subject: Subject): Surface => (subject.signal.kind === "post" ? "comment" : "room_reply");

/** The voice an opener on this surface is written in: an invitation's note
 *  is a DM's. */
const voiceChannelOf = (surface: Surface) => (surface === "comment" ? "comment" : surface === "room_reply" ? "reply" : "dm");

/** The people an opener may still be written to, as they stand now: in reach,
 *  on this campaign, not yet reached, each with the first way in their box
 *  holds. */
async function subjectsOf(tx: Tx, campaign: Campaign, leadIds: readonly number[], now: number): Promise<Subject[]> {
  const standing = new Map((await leadStandings(tx, campaign.id, leadIds)).map((row) => [row.id, row.eligible]));
  const openers = await leadOpeners(tx, leadIds.filter((leadId) => standing.get(leadId)), now, await freshProducts(tx, campaign.id, now));
  const subjects: Subject[] = [];
  for (const leadId of leadIds) {
    const opener = openers.get(leadId);
    if (!opener || opener.lead.campaignId !== campaign.id || !awaitsOpener(opener.lead)) continue;
    subjects.push({ ...opener, angle: null, profile: undefined });
  }
  const boxes = await composerFor(tx, subjects.map(({ lead, signal }) => boxKey({ kind: "lead", leadId: lead.id, signalId: signal.id })), now);
  const profiles = await profileReads(tx, subjects.map((subject) => subject.lead.profileId));
  for (const subject of subjects) {
    subject.profile = profiles.get(subject.lead.profileId)?.read;
    const first = boxes.get(boxKey({ kind: "lead", leadId: subject.lead.id, signalId: subject.signal.id }))?.angles.find((angle) => angle.source === "agent" && angle.why);
    subject.angle = first ? { position: first.position, name: first.angle, why: first.why! } : null;
  }
  return subjects;
}

function conversationOf(subject: Subject, surface: Surface): DraftConversation {
  const { lead, signal } = subject;
  return {
    surface,
    leadId: lead.id,
    post: { discoveredPostId: null, authorName: lead.name, postedAt: signal.saidAt, text: signal.words, mediaText: null },
    turns: [],
  };
}

/** Their headline as the planner is shown it: a Signal is known by their
 *  words alone. */
const headlineOf = (subject: Subject): string | null =>
  subject.row === "signal" ? null : (subject.profile?.headline ?? subject.lead.headline);

/** What a claim may stand on: their words, their headline and their public
 *  role where Research read it, and the fresh facts of a product the opener
 *  may name. A Signal is known by their words alone. */
function evidenceOf(subject: Subject): DraftEvidence {
  const role = subject.row === "signal" ? undefined : subject.profile?.currentRole;
  const profile = role?.title || role?.company ? `Their public profile: ${[role.title, role.company].filter(Boolean).join(" at ")}` : null;
  return {
    post: [subject.signal.words, profile].filter(Boolean).join("\n\n"),
    postedAt: subject.signal.saidAt,
    authorName: subject.lead.name,
    authorHeadline: headlineOf(subject),
    knowledge: null,
    constraints: null,
    productFacts: productEvidenceFacts(subject.products),
  };
}

/** The most characters a note to each of these people may take. */
async function noteLimitsOf(tx: Tx, subjects: readonly Subject[]): Promise<Map<number, number>> {
  const limits = new Map<number, number>();
  for (const subject of subjects) limits.set(subject.lead.id, await noteLimitFor(tx, subject.lead.profileId));
  return limits;
}

/** The miss that names an opener's plan rather than its wording: a draft that
 *  could go to fifty other people is planned again, never rewritten. */
const PLAN_AGAIN: ReadonlySet<string> = new Set(["specific"]);

/** The dispatcher's way, for the openers on one surface: compile, plan, hold
 *  each plan to its row, save the plans keyed on the boxes, write and judge,
 *  and save every attempt; a lead whose draft could go to fifty other people
 *  is planned and drafted once more. Null where the run stopped. */
async function dispatched(input: OpenerDraftsInput, surface: Surface, subjects: readonly Subject[], previewKnobs?: DraftingKnobs, precompiled?: CompiledWritingRules & { revision: string }, own?: OwnerRequest): Promise<OpenersWritten | null> {
  const { organizationId, campaign, llm, now } = input;
  const go = async () => !input.continueRun || (await input.continueRun());
  const read = await withOrg(organizationId, async (tx) => {
    const voice = await resolveSavedWritingVoice(tx, campaign, await getProfile(tx), voiceChannelOf(surface), { knobs: previewKnobs });
    const knobs = { ...DEFAULT_DRAFTING_KNOBS, ...voice.styleRules.knobs, ...previewKnobs };
    const brain = await prepareBrainForWriter(tx, campaign, input.knowledge);
    const owner = await ownerPlanningFacts(tx, campaign, now, brain.knowledge);
    if (previewKnobs) owner.examplesMax = knobs.exemplarCount;
    return {
      ...(await rulesInputs(tx, campaign, surface, brain.knowledge)),
      recentDrafts: await recentAgentDrafts(tx, campaign.id),
      owner,
      brain,
      sent: (await sentTexts(tx, now)).map((row) => row.text),
      voice: { persona: voice.persona, houseStyle: voice.houseStyle },
      rationing: knobs.rationing,
      knobs: { exemplarCount: knobs.exemplarCount, rationing: knobs.rationing },
      // A note takes the most the composer prints for them.
      noteLimits: surface === "invitation" ? await noteLimitsOf(tx, subjects) : null,
    };
  });
  const compileInput = {
    campaignId: campaign.id,
    channel: surface === "invitation" ? "dm" as const : "comment" as const,
    voiceRules: read.voiceRules,
    campaignRules: read.campaignRules,
  };
  // The owner's ask, waiting on its words, is planned and written in one
  // call under the compile at hand; a preview, a run and an idea take the
  // full chain.
  const composing = own?.ownerRequested === true && !own.planOnly;
  const compiled = precompiled && precompiled.revision === writingRulesRevision(compileInput)
    ? precompiled
    : previewKnobs
      ? { ...(await compileRules(llm, compileInput)), revision: writingRulesRevision(compileInput) }
      : await (composing ? compiledRulesAtHand : compiledRulesFor)(organizationId, llm, compileInput);
  if (!(await go())) return null;
  const byLead = new Map(subjects.map((subject) => [subject.lead.id, subject]));
  const evidence = new Map<number, DraftEvidence>();
  for (const subject of subjects) {
    const brain = await finalizeBrainForWriter(read.brain, { queryText: subject.signal.words, llm: null });
    evidence.set(subject.lead.id, { ...evidenceOf(subject), knowledge: brain.knowledge, constraints: brain.constraints ?? null });
  }
  // Plan, hold each plan to its row and save it: one round over these leads,
  // planned around the draft an earlier round withheld where there was one.
  const planRound = async (group: readonly Subject[], withheld?: ReadonlyMap<number, { text: string; reason: string }>) => {
    const items: PlanningItem[] = group.map((subject) => ({
      conversation: conversationOf(subject, surface),
      ownerFacts: [evidence.get(subject.lead.id)?.knowledge, ...(evidence.get(subject.lead.id)?.productFacts ?? [])].filter((fact): fact is string => !!fact),
      ...(own?.ask ? { ask: own.ask } : {}),
      ...(withheld?.has(subject.lead.id) ? { withheld: withheld.get(subject.lead.id)! } : {}),
      research: null,
      authorHeadline: headlineOf(subject),
      firstTouch: true,
      opener: openerPlan(subject.row, subject.angle && { name: subject.angle.name, why: subject.angle.why }),
      ...(read.noteLimits ? { maxChars: read.noteLimits.get(subject.lead.id)! } : {}),
    }));
    const planning = {
      ...read.owner,
      items,
      rules: compiled.rules,
      rulesRevision: compiled.revision,
      budget: budgetFor(compiled.rules, read.recentDrafts, items.length, read.rationing),
    };
    const planned = await planOrCompose(llm, planning, composing ? { now, voice: read.voice } : null);
    const plans = new Map([...planned.plans].map(([id, plan]) => [id, { ...withinOpener(plan, byLead.get(id)!.content), leadSignalId: byLead.get(id)!.signal.id, leadSignalHash: contextHash(byLead.get(id)!.signal.words), leadContextHash: openerContext(byLead.get(id)!), leadAnglePosition: byLead.get(id)!.angle?.position ?? null }] as const));
    const planIds = previewKnobs ? new Map<number, number>() : await withOrg(organizationId, (tx) => savePlans(tx, { campaignId: campaign.id, runId: input.runId }, plans));
    return { plans, planIds, unplanned: planned.unplanned, texts: planned.texts };
  };
  // Write and judge each planned lead, and keep every attempt under its plan;
  // words the owner waits on go to the model's judge once they land.
  const draftRound = async ({ plans, planIds, texts }: Awaited<ReturnType<typeof planRound>>) => {
    const work: DispatchItem[] = [];
    for (const subject of subjects) {
      const planned = plans.get(subject.lead.id);
      if (!planned) continue;
      work.push({ plan: planned, conversation: conversationOf(subject, surface), evidence: evidence.get(subject.lead.id)!, ...(own?.ask ? { ask: own.ask } : {}) });
    }
    const outcome = await draftFromPlans(
      llm,
      work,
      { sent: read.sent, stories: read.owner.stories, productNames: subjects[0]?.productNames ?? [] },
      { now, voice: read.voice, ownerRequested: own?.ownerRequested === true, planAgainOn: PLAN_AGAIN, ...(texts ? { composed: texts } : {}), ...(input.continueRun ? { continueRun: input.continueRun } : {}) },
    );
    if (outcome && !previewKnobs) await withOrg(organizationId, (tx) => saveAttempts(tx, planIds, [...outcome.admitted, ...outcome.withheld]));
    if (outcome && texts) void judgeLanded(organizationId, llm, outcome.admitted.map((draft) => ({ planId: planIds.get(draft.id)!, draft, evidence: evidence.get(draft.id)! })));
    return outcome;
  };
  const first = await planRound(subjects);
  if (own?.planOnly) return { drafted: [], withheld: 0, note: null, plan: [...first.plans.values()][0] };
  let outcome = await draftRound(first);
  if (outcome === null) return null;
  const plans = new Map(first.plans);
  const planIds = new Map(first.planIds);
  // A draft that could go to fifty other people was planned wrong, not worded
  // wrong: its lead is planned once more, around what the judge withheld.
  const again = new Map(outcome.withheld.filter((withheld) => PLAN_AGAIN.has(withheld.miss.item))
    .map((withheld) => [withheld.id, { text: withheld.attempts.at(-1)!.text, reason: withheld.miss.detail }]));
  if (again.size > 0) {
    if (!(await go())) return null;
    const second = await planRound(subjects.filter((subject) => again.has(subject.lead.id)), again);
    if (!(await go())) return null;
    const redrafted = await draftRound(second);
    if (redrafted === null) return null;
    for (const [id, planned] of second.plans) plans.set(id, planned);
    for (const [id, planId] of second.planIds) planIds.set(id, planId);
    outcome = {
      admitted: [...outcome.admitted, ...redrafted.admitted],
      withheld: [...outcome.withheld.filter((withheld) => !second.plans.has(withheld.id)), ...redrafted.withheld],
      unwritten: [...outcome.unwritten, ...redrafted.unwritten],
    };
  }
  if (previewKnobs) {
    const id = subjects[0]!.lead.id;
    const plan = plans.get(id) ?? null;
    const drafted = [...outcome.admitted, ...outcome.withheld][0];
    return { drafted: [], withheld: 0, note: null, preview: { knobs: read.knobs, compiled, result: {
      plan, planLines: plan ? renderPlan(plan) : null,
      unplanned: plan ? null : first.unplanned.get(id) ?? "the planner returned no plan for this lead",
      attempts: drafted?.attempts ?? [],
      outcome: !plan ? "unplanned" : outcome.admitted.length ? "admitted" : outcome.withheld.length ? "withheld" : "unwritten",
    } } };
  }
  const withheld = outcome.withheld.length + outcome.unwritten.length + first.unplanned.size;
  return {
    drafted: outcome.admitted.map((draft) => ({
      leadId: draft.id,
      signalId: byLead.get(draft.id)!.signal.id,
      text: draft.attempts.at(-1)!.text,
      angle: byLead.get(draft.id)?.angle?.position ?? null,
      planId: planIds.get(draft.id) ?? null,
      plan: draft.plan,
    })),
    withheld,
    note: withheld > 0 ? dispatchedWithheldNote(outcome, first.unplanned, ["lead", "leads"]) : null,
  };
}

/**
 * The opener the owner asked for in their own box, to one source of one lead:
 * planned and written on its surface in one call through the owner's own agent
 * (`input.llm`), and judged by code before the words come back; the model's
 * judge reads them after, and only a claim the evidence does not support holds
 * them back from a send. Null where the person, their words or the campaign
 * are no longer there, or the run stopped. An ask for an idea (`planOnly`)
 * comes back as its plan alone.
 */
export async function writeLeadBoxWords(
  input: Omit<OpenerDraftsInput, "leadIds" | "runId"> & { leadId: number; signalId: number; ask?: OwnerAsk; planOnly?: boolean },
): Promise<{ text: string | null; plan: DraftPlan } | null> {
  const opener = await withOrg(input.organizationId, async (tx) => {
    const found = await leadOpener(tx, input.leadId, input.now, input.signalId, await freshProducts(tx, input.campaign.id, input.now));
    if (!found || found.lead.campaignId !== input.campaign.id) return null;
    const profile = (await profileReads(tx, [found.lead.profileId])).get(found.lead.profileId)?.read;
    return { ...found, angle: null, profile } satisfies Subject;
  });
  if (!opener) return null;
  const written = await dispatched({ ...input, leadIds: [input.leadId], runId: null }, surfaceOf(opener), [opener], undefined, undefined, {
    ownerRequested: true,
    ...(input.ask ? { ask: input.ask } : {}),
    ...(input.planOnly ? { planOnly: true } : {}),
  });
  if (written === null) return null;
  if (written.plan) return { text: null, plan: written.plan };
  const [draft] = written.drafted;
  if (!draft) throw new Error("lead_words_unsupported");
  return { text: draft.text, plan: draft.plan! };
}

/** Preview the same served lead and current signal the worker would select. */
export async function previewLeadOpener(input: OpenerDraftsInput, signalId: number, knobs: DraftingKnobs, precompiled?: CompiledWritingRules & { revision: string }): Promise<OpenersWritten["preview"] | null> {
  const subjects = await withOrg(input.organizationId, (tx) => subjectsOf(tx, input.campaign, input.leadIds, input.now));
  const subject = subjects[0];
  if (!subject || subject.signal.id !== signalId || subject.signal.kind !== "post") return null;
  return (await dispatched(input, "comment", [subject], knobs, precompiled))?.preview ?? null;
}

/**
 * The leads whose last opener was withheld and who have given the writer
 * nothing new since: the box's newest attempt, under its newest plan, was
 * withheld; no words of theirs have been kept after it; and the rules it was
 * planned from (`rulesRevision`) are still the ones the campaign compiles to.
 * Asked again, the writer would meet the same miss and spend the same model
 * calls on every wake. The dispatcher keeps every attempt (`saveAttempts`).
 * A draft that could go to fifty other people parks its lead only once its
 * opener was planned again since their words: before that, the next wake
 * plans it anew.
 */
export async function openersWithheld(
  tx: Tx,
  campaign: Pick<Campaign, "id">,
  leadIds: readonly number[],
  rulesRevision: string,
): Promise<Set<number>> {
  if (leadIds.length === 0) return new Set();
  const leadOf = new Map(leadIds.map((leadId) => [boxKey({ kind: "lead", leadId }), leadId]));
  const newest = await tx
    .selectDistinctOn([draftPlans.boxKey], {
      boxKey: draftPlans.boxKey,
      plannedAt: draftPlans.createdAt,
      revision: draftPlans.rulesRevision,
      outcome: draftAttempts.outcome,
      couldGoToFifty: sql<boolean>`coalesce(${draftAttempts.verdicts} @> '[{"item":"specific","pass":false}]'::jsonb, false)`,
    })
    .from(draftPlans)
    .leftJoin(draftAttempts, and(eq(draftAttempts.organizationId, draftPlans.organizationId), eq(draftAttempts.planId, draftPlans.id)))
    .where(and(eq(draftPlans.campaignId, campaign.id), eq(draftPlans.surface, "comment"), inArray(draftPlans.boxKey, [...leadOf.keys()])))
    .orderBy(draftPlans.boxKey, desc(draftPlans.id), sql`${draftAttempts.attempt} desc nulls last`);
  const withheld = newest.filter((row) => row.outcome === "withheld" && row.revision === rulesRevision);
  if (withheld.length === 0) return new Set();
  const words = await tx
    .select({ leadId: leadSignals.leadId, keptAt: max(leadSignals.createdAt) })
    .from(leadSignals)
    .where(and(inArray(leadSignals.leadId, withheld.map((row) => leadOf.get(row.boxKey!)!)), eq(leadSignals.verdict, "passed")))
    .groupBy(leadSignals.leadId);
  const keptAt = new Map(words.map((row) => [row.leadId, row.keptAt ?? 0]));
  const planned = await tx
    .select({ boxKey: draftPlans.boxKey, plannedAt: draftPlans.createdAt })
    .from(draftPlans)
    .where(and(eq(draftPlans.campaignId, campaign.id), eq(draftPlans.surface, "comment"), inArray(draftPlans.boxKey, withheld.map((row) => row.boxKey!))));
  return new Set(
    withheld.flatMap((row) => {
      const leadId = leadOf.get(row.boxKey!)!;
      const kept = keptAt.get(leadId) ?? 0;
      if (kept > row.plannedAt) return [];
      const plannedAgain = planned.filter((plan) => plan.boxKey === row.boxKey && plan.plannedAt > kept).length > 1;
      return !row.couldGoToFifty || plannedAgain ? [leadId] : [];
    }),
  );
}

/**
 * Write an opener to each of these leads, in their order, by the
 * dispatcher's way. Someone out of reach, on another campaign, or already reached is left out.
 * Null where the run stopped before its drafts were judged: nothing it wrote
 * goes on. A provider or schema failure throws, so nothing unjudged moves on.
 */
export async function writeLeadOpeners(input: OpenerDraftsInput): Promise<OpenersWritten | null> {
  const subjects = await withOrg(input.organizationId, (tx) => subjectsOf(tx, input.campaign, input.leadIds, input.now));
  const result: OpenersWritten = { drafted: [], withheld: 0, note: null };
  for (const surface of ["comment", "room_reply", "invitation"] as const) {
    const group = subjects.filter((subject) => (input.surface ?? surfaceOf(subject)) === surface);
    if (group.length === 0) continue;
    const one = await dispatched(input, surface, group);
    if (one === null) return null;
    result.drafted.push(...one.drafted);
    result.withheld += one.withheld;
    result.note = [result.note, one.note].filter(Boolean).join("; ") || null;
  }
  const order = new Map(input.leadIds.map((id, at) => [id, at]));
  result.drafted.sort((a, b) => (order.get(a.leadId) ?? 0) - (order.get(b.leadId) ?? 0));
  return result;
}
