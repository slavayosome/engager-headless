import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { composerDrafts, draftAttempts, draftPlans, leads, type Lead, type LeadAngle, type LeadSignalRow } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { freshProducts } from "../../agentStep/writing";
import { containsRawUrl } from "../../ai/slop";
import { wholeWord } from "../../ai/styleRules";
import { questionsIn } from "../../ai/voiceTraits";
import { contextHash } from "../../tasks/hash";
import { intentGate, type IntentGate } from "../../campaigns/intentGate";
import { boxKey, composerFor, replaceComposerIdeas } from "../../composer/drafts";
import { COULD_GO_TO_FIFTY, theirWordsIn } from "../../dispatcher/judgeCode";
import type { DraftPlan, OpenerPlan } from "../../dispatcher/types";
import { wayInLine } from "../../dispatcher/writer";
import type { CampaignProduct } from "../../products/queries";
import { awaitsOpener, leadStage } from "../read";
import { leadSources, leadSourcesFor, recommendedSignal } from "../source";

/**
 * THE OPENER: what a first contact with someone Find leads found may say, by
 * what their own words show. One table, `OPENER_BY_INTENT`, is the only place
 * intent shapes an opener: the head the composer shows above it, what it
 * does, and where a first contact stays below the intent gate
 * (`campaigns/intentGate.ts`) on product, pitch and link. Every lead's plan and
 * prompt is held to its row ANDed with the campaign's compiled rules and that
 * gate, so an owner's Instructions or a rule can narrow an opener and nothing
 * can widen one.
 *
 * Every opener has one shape: one thing of the owner's added to what they
 * said, and at most one question, with no recap of their words first and no
 * next step bolted on. And every one must pass the fifty-people test: it
 * carries their words, or names what they named, so it could not go unchanged
 * to fifty other people.
 *
 * The ways in a person arrives with are angles in their box (`lead:<id>`),
 * ideas with no draft: the screen's for a Signal, read from their words alone,
 * and Qualify's once they are judged, in their place. It decides what an
 * opener may SAY, never whose it is: an untouched agent draft stays worker
 * and capped. Nothing here queues or sends.
 */

/** The rows: a Lead's intent, and a Signal, whom no profile read has judged. */
export const OPENER_ROWS = ["asking", "has_problem", "topic_only", "signal"] as const;
export type OpenerRow = (typeof OPENER_ROWS)[number];

/** How far one row's opener goes on one thing: as far as the intent gate
 *  allows (`gate`), or not at all (`never`), below it. A row never allows
 *  what the gate does not, so the gate stays the one word on product, call to
 *  action and framing. */
export type OpenerReach = "gate" | "never";

export type OpenerPolicy = {
  /** What the composer shows above the opener (US-LMC-08). */
  head: string;
  /** What an opener to them does, as the writer and the judge are told. */
  does: string;
  /** A product named: Asking's as the gate allows, and then only where what
   *  they asked for is a tool, a provider or a recommendation. */
  product: OpenerReach;
  /** A pitch beyond the answer. */
  pitch: OpenerReach;
  /** A link: never in a first contact. */
  link: OpenerReach;
};

export const OPENER_BY_INTENT: Readonly<Record<OpenerRow, OpenerPolicy>> = {
  asking: {
    head: "Opener · Asking: answer only what they asked",
    does: "Answer what they asked, and nothing more. Name a product only where what they asked for is a tool, a provider or a recommendation.",
    product: "gate",
    pitch: "never",
    link: "never",
  },
  has_problem: {
    head: "Opener · Has the problem: one thing tied to their words",
    does: "Add one thing of your own to what they said, and name no product.",
    product: "never",
    pitch: "never",
    link: "never",
  },
  topic_only: {
    head: "Opener · Topic only: join the topic, no pitch",
    does: "Join the topic they joined, with no pitch and no product.",
    product: "never",
    pitch: "never",
    link: "never",
  },
  signal: {
    head: "Opener · from their words only: no profile read yet",
    does: "Speak from their words alone, and say nothing about who they are.",
    product: "never",
    pitch: "never",
    link: "never",
  },
};

/** Every opener's shape, whatever its row. */
export const OPENER_SHAPE =
  "Add one thing tied to their words and stop: a point, an observation, a dry reaction, an answer or one question. Tie it to them by naming what they named or keeping a few of their own words, never by restating what they said, and add no next step. Ask at most one question.";

/** The row a person's opener reads: a Signal's until Qualify judges them,
 *  then their intent's. A Lead with no intent recorded reads Topic only, as
 *  the gate does. */
export function openerRowOf(lead: Pick<Lead, "stage" | "intent">): OpenerRow {
  return leadStage(lead) === "signal" ? "signal" : (lead.intent ?? "topic_only");
}

/** What an opener may carry: the row ANDed with the gate. */
export type OpenerContent = { product: boolean; pitch: boolean; link: boolean };

export function openerContent(row: OpenerRow, gate: IntentGate): OpenerContent {
  const policy = OPENER_BY_INTENT[row];
  const reach = (value: OpenerReach, allowed: boolean) => value === "gate" && allowed;
  return {
    product: reach(policy.product, gate.canMentionProduct),
    pitch: reach(policy.pitch, gate.canMentionProduct),
    link: reach(policy.link, gate.allowCta),
  };
}

/** A plan held to what the opener may carry: the compile already decided its
 *  content, and the row and the gate can only take from it. */
export function withinOpener(plan: DraftPlan, content: OpenerContent): DraftPlan {
  return {
    ...plan,
    content: {
      product: plan.content.product && content.product,
      pitch: plan.content.pitch && content.pitch,
      link: plan.content.link && content.link,
    },
  };
}

/** The opener a plan carries: its row, what it does, its shape, and the way
 *  in it writes out. */
export function openerPlan(row: OpenerRow, angle: { name: string; why: string } | null): OpenerPlan {
  return { row, does: OPENER_BY_INTENT[row].does, shape: OPENER_SHAPE, angle };
}

/** The opener's lines for a prompt that is not a plan's: what it does, its
 *  shape, its way in, and what it may carry. */
export function openerLines(row: OpenerRow, content: OpenerContent, angle: { name: string; why: string } | null): string[] {
  return [
    `This is a first contact with someone found by their own words. ${OPENER_BY_INTENT[row].does}`,
    OPENER_SHAPE,
    ...(angle ? [wayInLine(angle)] : []),
    content.product ? "You may name your product, as the line above allows." : "Name no product.",
    content.pitch ? "You may make a pitch." : "Make no pitch.",
    content.link ? "You may share a link." : "Share no link.",
  ];
}

/** What code holds an opener to when no plan does: their words, and what the
 *  row may carry. `productNames` are every product attached, named or not. */
export type OpenerCheck = { theirWords: readonly string[]; content: OpenerContent; productNames: readonly string[] };

export type OpenerFault = { item: "specific" | "content.product" | "content.link" | "question"; detail: string };

/**
 * The checks the judge's code layer runs on a planned opener, for one written
 * with no plan: the fifty-people test, a product or a link its row leaves out,
 * and one question at most. Empty where it holds.
 */
export function openerFaults(text: string, check: OpenerCheck): OpenerFault[] {
  const faults: OpenerFault[] = [];
  if (theirWordsIn(text, check.theirWords) === null) {
    faults.push({ item: "specific", detail: `${COULD_GO_TO_FIFTY}: it carries none of their words and names nothing they named` });
  }
  const product = check.productNames.map((name) => (name.trim() ? wholeWord(name).exec(text)?.[0] : undefined)).find(Boolean);
  if (product && !check.content.product) {
    faults.push({ item: "content.product", detail: `Names "${product}", and this opener names no product` });
  }
  if (!check.content.link && text.split(/\s+/u).some(containsRawUrl)) {
    faults.push({ item: "content.link", detail: "Shares a link, and a first contact shares none" });
  }
  const questions = questionsIn(text);
  if (questions.length > 1) faults.push({ item: "question", detail: `Asks ${questions.length} questions, and an opener asks one at most` });
  return faults;
}

/** Concrete feedback for an unsolicited product mention in the composer. */
export const OPENER_PRODUCT_NOTE = "Names your product, and they did not ask for one. Edit it before you queue it.";

/** The note words in a lead's box carry, or null where none is needed. The
 *  words land in the field either way: only a fact holds them back. */
export function openerNote(text: string, check: OpenerCheck): string | null {
  const faults = openerFaults(text, check);
  if (faults.some((fault) => fault.item === "content.product")) return OPENER_PRODUCT_NOTE;
  // Word overlap is a drafting heuristic, not a reliable assessment of an
  // owner's visible text. A valid paraphrase must not receive a genericity nag.
  return null;
}

/** The signal of theirs an opener answers: the one their intent quote stands
 *  in, else their newest. `signals` are newest first. */
export function openerSignal(
  lead: Pick<Lead, "intentQuote">,
  signals: readonly LeadSignalRow[],
): LeadSignalRow | undefined {
  return recommendedSignal(lead, signals);
}

/** An unattended run must not add a second draft because a different source
 *  became recommended. The owner's explicit asks remain per source. */
export async function hasLeadDraft(tx: Tx, leadId: number): Promise<boolean> {
  return (await leadsWithDraft(tx, [leadId])).has(leadId);
}

/** {@link hasLeadDraft} for many leads in one read: those whose box, or a
 *  source's, already holds words, an offer or a draft being written. */
export async function leadsWithDraft(tx: Tx, leadIds: readonly number[]): Promise<Set<number>> {
  if (leadIds.length === 0) return new Set();
  const keys = new Map(leadIds.map((leadId) => [boxKey({ kind: "lead", leadId }), leadId]));
  const rows = await tx.select({ boxKey: composerDrafts.boxKey }).from(composerDrafts).where(and(
    or(...[...keys.keys()].map((key) => sql`(${composerDrafts.boxKey} = ${key} or ${composerDrafts.boxKey} like ${`${key}:signal:%`})`)),
    sql`(${composerDrafts.text} is not null or jsonb_array_length(${composerDrafts.offered}) > 0 or ${composerDrafts.state} = 'writing')`,
  ));
  return new Set(rows.flatMap((row) => {
    const leadId = keys.get(row.boxKey.replace(/:signal:.*$/, ""));
    return leadId === undefined ? [] : [leadId];
  }));
}

/** Source boxes are separate editors, but copying an agent's words to a
 *  different source must not turn them into owner-authored words. */
export async function leadDraftTexts(tx: Tx, leadId: number): Promise<string[]> {
  const key = boxKey({ kind: "lead", leadId });
  const rows = await tx.select({ text: composerDrafts.text, offered: composerDrafts.offered }).from(composerDrafts)
    .where(sql`${composerDrafts.boxKey} = ${key} or ${composerDrafts.boxKey} like ${`${key}:signal:%`}`);
  return [...new Set(rows.flatMap((row) => [...(row.text === null ? [] : [row.text]), ...row.offered]))];
}

/** Everything an opener to one person is written and checked from. */
export type LeadOpener = {
  lead: Lead;
  row: OpenerRow;
  /** The words it answers. */
  signal: LeadSignalRow;
  /** Everything of theirs the screen passed, newest first. */
  signals: LeadSignalRow[];
  content: OpenerContent;
  /** The products it may be handed: none where it may name none. */
  products: CampaignProduct[];
  /** Every product attached, for the checks to find one named. */
  productNames: string[];
};

/** One person's opener, read as it stands; null for someone with no campaign
 *  or no words the screen passed. Their standing is the caller's to ask. */
export async function leadOpener(tx: Tx, leadId: number, now: number, signalId?: number, products?: CampaignProduct[]): Promise<LeadOpener | null> {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
  if (!lead || lead.campaignId === null) return null;
  return openerOf(lead, await leadSources(tx, lead.id), signalId, products ?? await freshProducts(tx, lead.campaignId, now));
}

/** {@link leadOpener} for many people in one read each of their rows and
 *  sources, on their newest recommended words; someone it would return null
 *  for is absent. `products` are the campaign's, read once where not given. */
export async function leadOpeners(tx: Tx, leadIds: readonly number[], now: number, products?: CampaignProduct[]): Promise<Map<number, LeadOpener>> {
  const openers = new Map<number, LeadOpener>();
  if (leadIds.length === 0) return openers;
  const rows = await tx.select().from(leads).where(inArray(leads.id, [...leadIds]));
  const sources = await leadSourcesFor(tx, rows.map((lead) => lead.id));
  const attached = new Map<number, CampaignProduct[]>();
  for (const lead of rows) {
    if (lead.campaignId === null) continue;
    if (!attached.has(lead.campaignId)) attached.set(lead.campaignId, products ?? await freshProducts(tx, lead.campaignId, now));
    const opener = openerOf(lead, sources.get(lead.id) ?? [], undefined, attached.get(lead.campaignId)!);
    if (opener) openers.set(lead.id, opener);
  }
  return openers;
}

function openerOf(lead: Lead, signals: LeadSignalRow[], signalId: number | undefined, attached: CampaignProduct[]): LeadOpener | null {
  const signal = signalId === undefined ? openerSignal(lead, signals) : signals.find((source) => source.id === signalId);
  if (!signal) return null;
  const row = openerRowOf(lead);
  // The intent gate as lead mode reads it, at draft time: their intent now.
  const content = openerContent(row, intentGate(lead.intent, attached.length > 0));
  return {
    lead,
    row,
    signal,
    signals,
    content,
    products: content.product ? attached : [],
    productNames: attached.map((product) => product.name),
  };
}

/** What an opener was written under, as one hash: their intent and row, what
 *  the row and the gate let it carry, and the products it may name. A kept
 *  draft is used again only while it is the same. */
export function openerContext(opener: LeadOpener): string {
  return contextHash([opener.lead.intent ?? null, opener.row, opener.content, [...opener.productNames].sort()]);
}

/** What code checks an opener to this person against. */
export function openerCheck(opener: LeadOpener): OpenerCheck {
  return {
    theirWords: opener.signals.map((signal) => signal.words),
    content: opener.content,
    productNames: opener.productNames,
  };
}

/** The notes on the words a lead's box holds now, by the angle's position:
 *  only an angle whose words break its row or could go to anyone has one. */
export async function leadBoxNotes(tx: Tx, leadId: number, now = Date.now(), signalId?: number): Promise<Map<number, string>> {
  const key = boxKey({ kind: "lead", leadId, ...(signalId === undefined ? {} : { signalId }) });
  const opener = await leadOpener(tx, leadId, now, signalId);
  const composer = (await composerFor(tx, [key], now)).get(key);
  if (!opener || !composer) return new Map();
  const check = openerCheck(opener);
  const attempts = await tx.select({ text: draftAttempts.text, reason: draftAttempts.reason })
    .from(draftPlans).innerJoin(draftAttempts, and(eq(draftAttempts.organizationId, draftPlans.organizationId), eq(draftAttempts.planId, draftPlans.id)))
    .where(and(eq(draftPlans.boxKey, boxKey({ kind: "lead", leadId })), eq(draftAttempts.outcome, "admitted")))
    .orderBy(desc(draftPlans.id), desc(draftAttempts.attempt));
  return new Map(
    composer.angles.flatMap((angle) => {
      const note = angle.text === null ? null : openerNote(angle.text, check) ?? attempts.find((attempt) => attempt.text === angle.text)?.reason ?? null;
      return note === null ? [] : [[angle.position, note] as const];
    }),
  );
}

/**
 * The ways in a person arrives with, into their box as ideas — a name and a
 * line each, no draft — in place of the ideas it held: what Qualify found
 * replaces what the screen guessed, and an angle the box holds a draft on
 * stays (`replaceComposerIdeas`); none clears the ideas it held. Someone
 * already reached has no opener to find a way into, and gets none. The caller
 * holds the lock Never engage takes and has asked the person's standing.
 */
export async function putLeadAngles(
  tx: Tx,
  lead: Pick<Lead, "id" | "stage">,
  angles: readonly LeadAngle[],
  now = Date.now(),
): Promise<void> {
  if (!awaitsOpener(lead)) return;
  await replaceComposerIdeas(tx, { box: boxKey({ kind: "lead", leadId: lead.id }), ideas: angles }, now);
}

