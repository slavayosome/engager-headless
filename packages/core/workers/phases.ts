import { and, desc, eq, inArray, isNull, TransactionRollbackError } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  draftAttempts,
  campaigns,
  draftPlans,
  leadSignals,
  leads,
  messages,
  systemState,
  type Campaign,
  type DiscoveredPost,
  type Lead,
  type LeadFit,
  type ScoutIntent,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { campaignStops, lockPauses } from "../actions/pause";
import type { LLM } from "../ai/client";
import { followUpHistory } from "../ai/writer";
import { modelFor } from "../ai/modelFor";
import { productEvidenceFacts, type DraftEvidence } from "./evidenceReview";
import type { PausedPress } from "../strategy/read";
import { assertNotRecoveryOnly } from "../jobs/recoveryScope";
import { contextHash } from "../tasks/hash";
import { lockRoomEvidence } from "../rooms/eligibility";
import { draftHolds, type DraftHold } from "../people/draftHolds";
import { submitCommentDraftBatch } from "../operations/clientDrafting";
import { getCommentDraftingContext } from "../operations/clientDrafting";
import { draftingPostText } from "./postText";
import { lockEngagementSafety } from "../ratelimit/killswitch";
import type { ActionMode } from "../strategy/catalog";
import { prepareKnowledgeRetrieval } from "../brain/knowledge";
import { boxKey, composerFor, draftComposerIdea, openComposerBox, putComposerAngle } from "../composer/drafts";
import { leadStandings } from "../leads/scout/eligibility";
import { leadOpeners, leadsWithDraft, openerContext, openerSignal, type LeadOpener } from "../leads/scout/opener";
import { leadSourcesFor } from "../leads/source";
import { openersWithheld, writeLeadOpeners, type OpenerDraft } from "../leads/scout/openerDrafts";
import { leadPost, openerIntentModes } from "../leads/queue";
import { turnedAway } from "../leads/replySource";
import { asideAmong } from "../leads/setAside";
import { compareLeads } from "../leads/scout/serve";
import { daySlots } from "../operations/demand";
import { channelCeilings } from "../ratelimit/ledger";
import { currentRulesRevision } from "../dispatcher/phase";
import { DraftPlanSchema } from "../dispatcher/types";

/**
 * What the Ambassador's run writes, as ordinary functions.
 *
 * Discipline borrowed from the runner protocol, minus its ceremony (there is
 * no remote party here, so no lease, no credential scope, no claim):
 *
 *  - the SERVER picks and freezes the ids; the model is handed exactly those
 *  - a receipt is a row we wrote, never a count the model reported
 *  - anything the model returns for an id we did not freeze is discarded
 *
 * Every phase returns what it actually changed, so a run record can be built
 * from facts rather than from a summary.
 *
 * CONNECTION DISCIPLINE. Each phase takes an `organizationId`, not a `Tx`, and
 * owns its own short transactions: snapshot -> release -> model call -> short
 * write. It cannot be given a transaction to hold, which is the point.
 *
 * It used to take a `Tx` and call `llm.json` inside it. Every caller is
 * SELF_SCOPED precisely so that cannot happen, and three of their comments said
 * it did not — while one pooled connection sat pinned across an agent-CLI
 * subprocess for the whole model call. At ENGAGER_PG_POOL_MAX=1 that is a
 * deadlock, and pg's pool has no acquire timeout, so it presents as a hang.
 *
 * The freeze survives the split: the ids handed to the model come from the
 * snapshot phase and the apply phase keys on that same list (INV-3). It is
 * never re-read after the model returns, because a re-read would silently
 * widen the set the model was actually judged against.
 */

/**
 * How much of each phase one run may do. Every number here is the caller's own
 * arithmetic at the run's clock — a demand read off rows, or an owner's exact
 * ask on a manual trigger — never a stored per-worker ceiling.
 *
 * There is no `maxPublishes`, and its absence is arithmetic rather than an
 * omission: the publish step arms exactly what the draft step wrote, and an
 * armed run's `maxDrafts` IS the plan's slots the account writes ahead — its
 * next few, or the rest of its day — net of every committed worker row,
 * so a run that drafted only what the plan wants
 * cannot schedule more than the plan wants. A second ceiling under that one
 * never refused anything anyway — slot assignment has no refusal branch — it
 * only decided how far into the future the surplus got pushed.
 */
export type PhaseLimits = {
  /**
   * How many comments intake may RECEIVE, not how many candidates the phase
   * reads: it selects `DRAFT_SELECTION_HEADROOM` past this number and cuts back
   * to it once the review has withheld what it can see is unsupported.
   */
  maxDrafts: number;
};

export type DraftPhaseResult = {
  drafted: number;
  published: number;
  rejected: number;
  capRefused: number;
  /**
   * The batch was refused as a whole — no row was written and no counter above
   * describes what happened. The caller must surface this rather than record a
   * run of zeros beside `succeeded`: a refusal nobody can read is the same lie
   * as a fabricated count, only quieter.
   */
  refusal?: {
    code: string;
    message: string;
    /**
     * What to DO about it. The intake carries a recovery hint on every refusal
     * it can act on (`ClientIntakeErrorDetails.recovery`), the owner's own save
     * path already surfaces it, and the worker path dropped it on the
     * floor — leaving the run log with a diagnosis and no treatment.
     */
    recovery?: string;
  };
  /**
   * Why a phase that was asked for drafts wrote none, in words the owner reads
   * on the run. Present on every exit that writes no row, except a batch
   * refusal, which `refusal` already says. The
   * phase has a dozen ways to end at zero, and a bare `drafted 0` beside a
   * confirmed match gave the owner no way to tell an empty pool from a
   * withheld draft from a candidate left for them to write.
   */
  nothingDrafted?: string;
};

/** The most openers one run writes on its own. */
export const LEAD_OPENERS_PER_RUN = 10;

/** How many openers past the day's open slots an Automatic run writes ahead,
 *  to keep for the next run. */
const OPENER_HEADROOM = 2;

/** How many more comments the account's day takes, up to a run's most
 *  openers: the day's open slots (`daySlots`), none where the account's own
 *  row cannot be read — a plan that cannot be read is how a worker fills a day
 *  nobody paced. */
async function openDaySlots(tx: Tx, campaign: Campaign, now: number): Promise<number> {
  const channel = await channelCeilings(tx);
  return channel ? Math.min(LEAD_OPENERS_PER_RUN, (await daySlots(tx, channel, now, campaign.id)).open) : 0;
}

/** A lead a run writes an opener to, and the mode it goes out at: the step's,
 *  held to the ceiling of their intent. `hold` marks one written past the
 *  day's open slots: it is kept for the next run, not queued. */
export type OwedOpener = { leadId: number; mode: "review" | "auto"; hold?: boolean };

/** The fits a Topic only lead's opener is written to: with no ask and no
 *  problem in their words, how well they fit is all that makes them worth one. */
const TOPIC_ONLY_OPENER_FITS: readonly LeadFit[] = ["strong", "fits"];

/** The mode an opener to this lead goes out at, by the intent modes as they
 *  stand: null where none is written. */
function leadOpenerMode(modes: Record<ScoutIntent, ActionMode>, lead: Lead): OwedOpener["mode"] | null {
  const intent = lead.intent ?? "topic_only";
  if (intent === "topic_only" && !(lead.fit && TOPIC_ONLY_OPENER_FITS.includes(lead.fit))) return null;
  return modes[intent] === "off" ? null : modes[intent];
}

type HeldOpener = OpenerDraft & { attemptId: number; context: string | undefined };

/** The openers kept from an earlier run (`held` attempts), as they may be used
 *  now. One whose rules changed, whose post left its window or changed, or
 *  that a newer one replaces is discarded, with the reason. */
async function heldOpeners(tx: Tx, campaign: Campaign, now: number, revision: string): Promise<Map<number, HeldOpener>> {
  const rows = await tx.select({ attemptId: draftAttempts.id, text: draftAttempts.text, planId: draftPlans.id,
    box: draftPlans.boxKey, revision: draftPlans.rulesRevision, plan: draftPlans.plan })
    .from(draftAttempts).innerJoin(draftPlans, and(eq(draftPlans.organizationId, draftAttempts.organizationId), eq(draftPlans.id, draftAttempts.planId)))
    .where(and(eq(draftPlans.campaignId, campaign.id), eq(draftAttempts.outcome, "held")))
    .orderBy(desc(draftPlans.id));
  const parsed = rows.map((row) => ({ ...row, parsed: DraftPlanSchema.safeParse(row.plan) }));
  const signalIds = parsed.flatMap((row) => row.parsed.success && row.parsed.data.leadSignalId ? [row.parsed.data.leadSignalId] : []);
  const signals = signalIds.length ? await tx.select().from(leadSignals).where(inArray(leadSignals.id, signalIds)) : [];
  const bySignal = new Map(signals.map((signal) => [signal.id, signal]));
  const held = new Map<number, HeldOpener>();
  for (const row of parsed) {
    const id = /^lead:(\d+)$/.exec(row.box ?? "")?.[1];
    const plan = row.parsed.success ? row.parsed.data : null;
    const signal = plan?.leadSignalId ? bySignal.get(plan.leadSignalId) : undefined;
    const aged = !signal || signal.leadId !== Number(id) || signal.kind !== "post" || signal.verdict !== "passed" ||
      (signal.saidAt !== null && signal.saidAt < now - campaign.maxPostAgeDays * 86_400_000);
    const reason = row.revision !== revision ? "The strategy changed while this draft was held." : aged ? "The post is no longer in its window." : plan?.leadSignalHash !== contextHash(signal!.words) ? "The post changed while this draft was held." : null;
    if (reason || !id || !plan || !signal || held.has(Number(id))) {
      await tx.update(draftAttempts).set({ outcome: "discarded", reason: reason ?? "A newer draft is available." }).where(eq(draftAttempts.id, row.attemptId));
      continue;
    }
    held.set(Number(id), { leadId: Number(id), signalId: signal.id, text: row.text, angle: plan.leadAnglePosition ?? null, planId: row.planId, attemptId: row.attemptId, context: plan.leadContextHash });
  }
  return held;
}

/**
 * THE LEADS A RUN WRITES AN OPENER TO ON ITS OWN (US-LMF-05), frozen under the
 * run's lease before any model call: the campaign's served Leads — never a
 * Signal — on a post of their own, whose box no agent text has reached yet,
 * one unattended draft a lead, at the mode Comment on posts sends to someone
 * of their intent at as it resolves now: the step's, held to that intent's
 * ceiling (`openerIntentModes`). Off for their intent writes none. By default
 * Topic only waits in the box for a yes while Asking and Has the problem are
 * queued, and a Topic only lead is written to only at
 * {@link TOPIC_ONLY_OPENER_FITS}; one with no intent recorded reads Topic
 * only, as the intent gate does. Someone whose words are a comment under
 * someone else's post is left to the owner, who queues a reply to it from
 * Leads (ruling 25): no step writes one on its own. So is someone the
 * owner's Queue would refuse (`turnedAway`: not a buyer, rated a peer or not
 * a fit, set aside), someone out of reach, someone whom a decision waiting on
 * them or their allowance holds (`draftHolds`), and someone whose last opener
 * was withheld and whose words and rules have not moved since
 * (`openersWithheld`). The strongest first, at most
 * {@link LEAD_OPENERS_PER_RUN} — and at Automatic, each being a comment
 * queued into the day, no more than the day has open (`daySlots`) — and up to
 * two more past them, written ahead and kept for the next run, which takes a
 * kept opener first. An opener at Ask me queues nothing, so it spends none.
 */
export async function leadOpenersOwed(tx: Tx, campaign: Campaign, now: number): Promise<OwedOpener[]> {
  const modes = await openerIntentModes(tx, campaign.id, "effective");
  const modeFor = (lead: Lead) => leadOpenerMode(modes, lead);
  if (Object.values(modes).every((mode) => mode === "off")) return [];
  const served = (
    await tx
      .select()
      .from(leads)
      .where(and(eq(leads.campaignId, campaign.id), eq(leads.origin, "find_leads"), eq(leads.stage, "lead")))
  ).filter((lead) => modeFor(lead) !== null);
  if (served.length === 0) return [];
  let slots = served.some((lead) => modeFor(lead) === "auto") ? await openDaySlots(tx, campaign, now) : 0;
  if (slots === 0 && !served.some((lead) => modeFor(lead) === "review")) return [];
  const revision = await currentRulesRevision(tx, campaign);
  const saved = await heldOpeners(tx, campaign, now, revision);
  const reachable = new Set(
    (await leadStandings(tx, campaign.id, served.map((lead) => lead.id))).filter((one) => one.eligible).map((one) => one.id),
  );
  const held = await draftHolds(tx, campaign.channelId, now);
  const boxes = await composerFor(tx, served.map((lead) => boxKey({ kind: "lead", leadId: lead.id })), now);
  const aside = await asideAmong(tx, served.map((lead) => lead.id));
  const tried = await openersWithheld(tx, campaign, served.map((lead) => lead.id), revision);
  const drafted = await leadsWithDraft(tx, served.map((lead) => lead.id));
  const sources = await leadSourcesFor(tx, served.map((lead) => lead.id));
  const owed: OwedOpener[] = [];
  let headroom = slots > 0 ? OPENER_HEADROOM : 0;
  for (const lead of served.sort((a, b) => Number(saved.has(b.id)) - Number(saved.has(a.id)) || compareLeads(a, b))) {
    if (owed.length >= LEAD_OPENERS_PER_RUN) break;
    const mode = modeFor(lead)!;
    if (mode === "auto" && slots === 0 && headroom === 0) continue;
    if (turnedAway(lead, aside.has(lead.id)) !== null || tried.has(lead.id)) continue;
    if (!reachable.has(lead.id) || held.has(lead.profileId) || held.has(lead.profileId.toLowerCase())) continue;
    const box = boxes.get(boxKey({ kind: "lead", leadId: lead.id }));
    if ((box && (box.offered.length > 0 || box.angles.some((angle) => angle.state === "writing"))) || drafted.has(lead.id)) continue;
    if (openerSignal(lead, sources.get(lead.id) ?? [])?.kind !== "post") continue;
    const hold = mode === "auto" && slots === 0;
    owed.push({ leadId: lead.id, mode, ...(hold ? { hold: true } : {}) });
    if (mode === "auto") {
      if (hold) headroom -= 1;
      else slots -= 1;
    }
  }
  return owed;
}

/** What the openers a run wrote came to. */
export type LeadOpenerPhaseResult = {
  /** Openers that landed in a lead's box. */
  drafted: number;
  /** Of those, the ones queued as worker, at Automatic. */
  queued: number;
  /** Openers the writer or the judge withheld. */
  withheld: number;
  /** Openers whose person their allowance held at the queue: they wait in
   *  the box. */
  held: number;
  /** What else the run says of them, in the owner's words. */
  note: string | null;
};

/**
 * THE OPENERS COMMENT ON POSTS WRITES TO THE LEADS IT WAS SERVED (US-LMF-05):
 * angle 1 of each lead frozen by {@link leadOpenersOwed}, written by
 * `writeLeadOpeners` — planned by the dispatcher where the org's switch is on,
 * held to the lead's intent row either way — and put in their box as that
 * angle's draft, where the composer opens on it. It waits on Leads, in the
 * lead's box, never in the Inbox: a box holds no message. What happens to it
 * then is the mode it was owed at (`OwedOpener`), the step's held to the
 * ceiling of their intent:
 *
 *   Ask me    — it waits in the box for the owner's Queue.
 *   Automatic — the step queues it as worker through today's intake
 *               (`submitCommentDraftBatch`), on the post row the first move
 *               that needs one writes (`leadPost`): capped and paced as any
 *               worker comment, and sent through `canEngage()` and the
 *               exactly-once path. Only a comment intake schedules is kept; one
 *               it would hold for a yes stays in the box instead, so nothing of
 *               a lead's waits in the Inbox. Run once, a Pause, the stop or a
 *               Stop on the campaign or the account arms nothing.
 *
 * Nothing here sends. Each lead lands in its own short transaction under the
 * locks every intake takes, and asks again whether their box still takes a
 * first draft: the owner's words, or a delivery that came first, keep it.
 */
export async function runLeadOpenerPhase(
  organizationId: string,
  campaign: Campaign,
  llm: LLM,
  owed: readonly OwedOpener[],
  opts: { runId: number; continueRun?: () => Promise<boolean>; press?: PausedPress },
  now: number = Date.now(),
): Promise<LeadOpenerPhaseResult> {
  assertNotRecoveryOnly("draft");
  const result: LeadOpenerPhaseResult = { drafted: 0, queued: 0, withheld: 0, held: 0, note: null };
  const stopped = await withOrg(organizationId, async (tx) => {
    const [safety] = await tx.select().from(systemState);
    if (safety?.killSwitch) return KILL_SWITCH_NOTE;
    if (safety?.transferPaused || safety?.cloudPaused) return HANDED_OFF_NOTE;
    if (await stoppedFor(tx, campaign)) return CAMPAIGN_STOPPED_NOTE;
    return null;
  });
  if (stopped !== null || owed.length === 0) return { ...result, note: stopped };

  // The vault and the rules it shapes are read once for the whole run: the
  // held drafts, the writer and every apply below are judged against them.
  const { knowledge, saved } = await withOrg(organizationId, async (tx) => {
    const knowledge = await prepareKnowledgeRetrieval(tx);
    const revision = await currentRulesRevision(tx, campaign, knowledge);
    const rows = await heldOpeners(tx, campaign, now, revision);
    const openers = await leadOpeners(tx, owed.filter((one) => rows.has(one.leadId)).map((one) => one.leadId), now);
    for (const one of owed) {
      const held = rows.get(one.leadId);
      const opener = openers.get(one.leadId);
      const reason = !held ? null : opener?.signal.id !== held.signalId ? "The lead's source changed while this draft was held."
        : openerContext(opener) !== held.context ? "Their intent or what the opener may carry changed while this draft was held." : null;
      if (held && reason) {
        await tx.update(draftAttempts).set({ outcome: "discarded", reason }).where(eq(draftAttempts.id, held.attemptId));
        rows.delete(one.leadId);
      }
    }
    return { knowledge, saved: rows };
  });
  const written = await writeLeadOpeners({
    organizationId,
    campaign,
    llm,
    leadIds: owed.filter((one) => !saved.has(one.leadId)).map((one) => one.leadId),
    runId: opts.runId,
    now,
    knowledge,
    ...(opts.continueRun ? { continueRun: opts.continueRun } : {}),
  });
  if (written === null) return { ...result, note: STOPPED_NOTE };
  result.withheld = written.withheld;
  result.note = written.note;
  const owedIds = new Set(owed.map((one) => one.leadId));
  const drafts = new Map(written.drafted.map((draft) => [draft.leadId, draft]));
  for (const [id, draft] of saved) if (owedIds.has(id)) drafts.set(id, draft);
  let slots = owed.filter((one) => one.mode === "auto" && !one.hold).length;
  const planIds = [...drafts.values()].flatMap((draft) => (draft.planId === null ? [] : [draft.planId]));
  const plans = new Map(
    planIds.length === 0
      ? []
      : (await withOrg(organizationId, (tx) => tx.select({ id: draftPlans.id, revision: draftPlans.rulesRevision, plan: draftPlans.plan })
          .from(draftPlans).where(inArray(draftPlans.id, planIds)))).map((row) => [row.id, row] as const),
  );
  // Every draft lands in one transaction, under the locks every intake takes
  // (the advisory ones first, then the campaign's row, so a Pause cannot commit
  // between its status being read and a draft being admitted): the stop, the
  // pause and the kill switch are asked once, and the modes, the rules and what
  // was read about each person are asked as they stand now, for all of them at
  // once.
  const landed = await withOrg(organizationId, async (tx) => {
    const tally = { drafted: 0, queued: 0, held: 0, kept: 0 };
    await lockEngagementSafety(tx);
    await lockPauses(tx);
    await lockRoomEvidence(tx);
    const [safety] = await tx.select().from(systemState);
    const [current] = await tx.select().from(campaigns).where(and(eq(campaigns.id, campaign.id), isNull(campaigns.deletedAt))).for("update");
    if (!current || (campaign.status === "active" && current.status !== "active") || safety?.killSwitch || safety?.cloudPaused || safety?.transferPaused || (await stoppedFor(tx, campaign))) return tally;
    const intentModes = await openerIntentModes(tx, campaign.id, "effective");
    const applyRevision = await currentRulesRevision(tx, current, knowledge);
    const ready = owed.filter((one) => drafts.has(one.leadId));
    const ids = ready.map((one) => one.leadId);
    const at = Date.now();
    const openers = await leadOpeners(tx, ids, at);
    const aside = await asideAmong(tx, ids);
    const written = await leadsWithDraft(tx, ids);
    const boxes = await composerFor(tx, [...openers.values()].map(({ lead, signal }) => boxKey({ kind: "lead", leadId: lead.id, signalId: signal.id })), at);
    for (const one of ready) {
      const draft = drafts.get(one.leadId)!;
      const held = saved.get(draft.leadId);
      const savedPlan = draft.planId === null ? undefined : plans.get(draft.planId);
      if (draft.planId !== null && savedPlan?.revision !== applyRevision) break;
      const plan = savedPlan && DraftPlanSchema.safeParse(savedPlan.plan).data;
      const opener = openers.get(draft.leadId);
      // Their mode as it stands now: a step turned to Ask me keeps the draft
      // in the box for the owner's yes, and one turned Off writes nothing.
      const mode = opener && leadOpenerMode(intentModes, opener.lead);
      if (opener && plan && openerContext(opener) !== plan.leadContextHash) {
        if (held) await tx.update(draftAttempts).set({ outcome: "discarded", reason: "Their intent or what the opener may carry changed while this draft was held." }).where(eq(draftAttempts.id, held.attemptId));
        continue;
      }
      const box = opener && boxes.get(boxKey({ kind: "lead", leadId: draft.leadId, signalId: draft.signalId }));
      // Asked again here, as the owner's Queue asks it: the owner may have
      // rated or set them aside while the writer was out.
      if (
        opener?.signal.kind !== "post" || opener.signal.id !== draft.signalId ||
        (plan && plan.leadSignalHash !== contextHash(opener.signal.words)) ||
        !mode ||
        (opener.signal.saidAt !== null && opener.signal.saidAt < at - current.maxPostAgeDays * 86_400_000) ||
        turnedAway(opener.lead, aside.has(draft.leadId)) !== null ||
        written.has(draft.leadId) ||
        (box && (box.offered.length > 0 || box.angles.some((angle) => angle.state === "writing")))
      ) {
        continue;
      }
      if (mode === "auto" && slots === 0) {
        if (!held && draft.planId !== null) await tx.update(draftAttempts).set({ outcome: "held" }).where(and(eq(draftAttempts.planId, draft.planId), eq(draftAttempts.outcome, "admitted")));
        tally.kept += 1;
        continue;
      }
      if (!(await putLeadOpener(tx, draft, now))) continue;
      if (held) await tx.update(draftAttempts).set({ outcome: "admitted" }).where(and(eq(draftAttempts.id, held.attemptId), eq(draftAttempts.outcome, "held")));
      const armed = mode === "auto" && !opts.press && !safety?.killSwitch && !safety?.cloudPaused;
      const outcome = armed ? await queueLeadOpener(tx, current, opener, draft, opts.runId) : "drafted";
      if (mode === "auto") slots -= 1;
      tally.drafted += 1;
      if (outcome === "queued") tally.queued += 1;
      if (outcome === "held") tally.held += 1;
    }
    return tally;
  });
  result.drafted += landed.drafted;
  result.queued += landed.queued;
  result.held += landed.held;
  const kept = landed.kept;
  if (kept > 0) {
    result.note = [result.note, `${plural(kept, "opener", "openers")} written ahead and kept for the next run`].filter(Boolean).join("; ");
  }
  return result;
}

/**
 * An opener at Automatic, queued as worker through today's intake on the
 * lead's post row (`leadPost`, the row the owner's Queue writes too), in a
 * savepoint kept only where intake scheduled it: a comment intake would hold
 * for a yes, or held for their allowance, or a post another campaign holds,
 * leaves no row — no post row, no message — and the opener waits in the box.
 */
async function queueLeadOpener(
  tx: Tx,
  campaign: Campaign,
  opener: LeadOpener,
  draft: OpenerDraft,
  runId: number,
): Promise<"queued" | "held" | "drafted"> {
  let outcome: "queued" | "held" | "drafted" = "drafted";
  try {
    await tx.transaction(async (savepoint) => {
      const discoveredPostId = await leadPost(savepoint, opener, campaign.id);
      const batch = await submitCommentDraftBatch(
        savepoint,
        campaign,
        { drafts: [{ discoveredPostId, text: draft.text }], model: modelFor("writer") },
        { forceProposal: false, worker: { workerAuthored: true, publish: true, runId } },
      );
      const items = "data" in batch && batch.data && "items" in batch.data ? (batch.data.items as IntakeItem[]) : [];
      const item = items[0];
      if (item?.held === "allowance") outcome = "held";
      if (item?.messageId == null || item.alreadyExisted || item.status !== "approved") return savepoint.rollback();
      if (draft.planId !== null) {
        await savepoint.update(messages).set({ draftPlanId: draft.planId }).where(eq(messages.id, item.messageId));
      }
      outcome = "queued";
    });
  } catch (error) {
    const elsewhere = error instanceof AppError && error.code === "post_in_other_campaign";
    if (!(error instanceof TransactionRollbackError) && !elsewhere) throw error;
  }
  return outcome;
}

/** One intake item, as `submitCommentDraftBatch` reports it. */
type IntakeItem = { messageId: number | null; alreadyExisted?: boolean; status?: string; held?: DraftHold["kind"] };

/** An opener into its lead's box, on the way in it took: that idea's draft,
 *  or a new angle where the box held none. False where the box takes no words
 *  now — the person put out of reach, or reached. The caller has asked whether
 *  the box already holds a draft: one unattended draft a lead. */
async function putLeadOpener(tx: Tx, draft: OpenerDraft, now: number): Promise<boolean> {
  const key = boxKey({ kind: "lead", leadId: draft.leadId, signalId: draft.signalId });
  try {
    await openComposerBox(tx, key);
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith("composer_box_")) return false;
    throw error;
  }
  if (draft.angle === null) {
    await putComposerAngle(tx, { box: key, text: draft.text }, now);
    return true;
  }
  return (await draftComposerIdea(tx, { box: key, position: draft.angle, text: draft.text }, now)) !== null;
}

/** The drafting context `getCommentDraftingContext` serves for one post. */
export type CommentDraftingContext = Extract<
  Awaited<ReturnType<typeof getCommentDraftingContext>>,
  { ok: true }
>["data"];

/**
 * The reviewer's evidence for a post's draft: a STRICT SUBSET of the writer's
 * context — the source post plus the owner's documented facts, and nothing
 * about how the owner sounds. Built from the context rather than parsed back
 * out of its serialized form, so what the reviewer may treat as fact is a
 * decision this file makes rather than a filter it hopes held.
 */
export function draftEvidence(post: DiscoveredPost, context: CommentDraftingContext): DraftEvidence {
  return {
    post: draftingPostText(post, context.research?.fullText),
    postedAt: post.postedAt,
    authorName: post.authorName,
    authorHeadline: context.research?.author?.headline ?? post.authorHeadline,
    knowledge: context.brain.knowledge,
    constraints: context.brain.constraints,
    productFacts: productEvidenceFacts(context.products),
    writingInstructions: context.systemPrompt,
    styleDirective: context.styleDirective,
    ...(context.research?.room ? { room: context.research.room } : {}),
    ...(context.followUp ? { history: followUpHistory(context.followUp) } : {}),
  };
}

export const KILL_SWITCH_NOTE = "the account's stop is on";
export const HANDED_OFF_NOTE = "this install has handed the account off, so it writes nothing";
/** A Stop on the campaign, as its run page says it: the skip note when
 *  preflight meets one, and after "drafted 0 — " when the phase does. */
export const CAMPAIGN_STOPPED_NOTE = "Sending is stopped on this campaign";
/** A Stop on the campaign's account — Pause LinkedIn — as its run page says
 *  it when preflight meets one. */
export const ACCOUNT_STOPPED_NOTE = "LinkedIn is paused";
const STOPPED_NOTE = "the run stopped before its drafts were saved";

/** Whether a Stop holds this campaign: its own or its account's. */
async function stoppedFor(tx: Tx, campaign: Pick<Campaign, "id" | "channelId">): Promise<boolean> {
  return (await campaignStops(tx, campaign)).length > 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
