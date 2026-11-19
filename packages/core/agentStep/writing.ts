import { and, desc, eq, inArray } from "drizzle-orm";
import {
  authorProfiles,
  conversationEvents,
  incomingComments,
  type Campaign,
  type IncomingReading,
  type IncomingComment,
  type ConversationEventRow,
  type ConversationRow,
  type ProductFact,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { conversationDms, latestOurs } from "../actions/dm";
import type { LLM } from "../ai/client";
import { readIncoming, readingOf, sensitivityOf, sensitivityRow } from "../ai/reading";
import {
  INVITATION_NOTE_TARGET_CHARS,
  type DirectMessagePurpose,
  type ProductContext,
  type WriteResult,
} from "../ai/writer";
import { modelFor } from "../ai/modelFor";
import { writeConversationWords, type ConversationWords, type ConversationWordsInput } from "../dispatcher/conversationWords";
import { draftIntentGate, productsWithin } from "../campaigns/intentGate";
import { objectiveMeta } from "../campaigns/objectives";
import type { CampaignAgentStrategy, StrategyStep } from "../strategy/contract";
import { strategyRegister, draftingVoiceId } from "../strategy/draftingVoice";
import { prepareReplyDraft, replyPreparationRevision, type PreparedReplyDraft } from "../draft";
import { getProfile } from "../profile";
import type { OfferWords } from "../products/offers";
import { loadCampaignProducts, type CampaignProduct } from "../products/queries";
import { assembleReplyContext, threadConversation, type ReplyThreadContext } from "../replyContext";
import { resolveCampaignVoice, type ResolvedVoiceV2 } from "../voice";
import { factFreshness } from "./freshness";
import { campaignFacts } from "./input";
import { readWritingPreferences } from "../strategy/writingInstructions";
import { campaignWritingGuidance } from "../ai/writingInstructions";
import { createHash } from "node:crypto";

/**
 * HOW AN AGENT STEP'S WORDS ARE WRITTEN — a public reply, a DM, an
 * invitation's note — shared by the step's own drafts (`dispatch.ts`) and the
 * redraft a voice update takes the waiting ones through (`redraft.ts`), so a
 * redraft is written exactly as a fresh draft is: by the existing drafting
 * modules, in the voice row the strategy names and under the register it
 * corrected (`strategy/draftingVoice.ts`), with the step's instructions as
 * its angle. The reads take a transaction; the writes are model calls made
 * with none held. Nothing here checks a guard or writes a row.
 */

type StrategyVoice = CampaignAgentStrategy["voice"];

/** The campaign's voice as a draft is written in it: a DM with the voice's
 *  DM description, anything else with its comment one. */
async function draftingVoice(
  tx: Tx,
  campaign: Pick<Campaign, "voiceId">,
  voice: StrategyVoice,
  surface: "comment" | "reply" | "dm" = "comment",
): Promise<ResolvedVoiceV2> {
  const resolved = await resolveCampaignVoice(
    tx,
    { voiceId: draftingVoiceId(voice, campaign) },
    await getProfile(tx),
    surface,
  );
  return strategyRegister(resolved, voice);
}

/** What the draft's claims may rest on beyond the Brain and the campaign's
 *  products: the facts the step binds, and the approved words of the offer it
 *  makes. */
function boundFactLines(facts: ProductFact[], offer: OfferWords | null = null): string[] {
  return [
    ...facts.map((fact) => fact.content),
    ...(offer === null ? [] : [offer.what, `Offer link: ${offer.url}`, ...offer.facts]),
  ];
}

/** The offer a message makes, as an instruction at the step's authority: only
 *  its approved words, and only its link. */
function offerRules(offer: OfferWords | null): string[] {
  return offer === null
    ? []
    : [
        `This message makes this offer, approved by the owner, and says nothing about it beyond its words: ${offer.what}`,
        `The only link the message may carry is ${offer.url}.`,
        "Never imply a free trial, a discount or instant access unless the offer's words say so.",
      ];
}

/** What came of the dispatcher's words, as the row that carries them reads it. */
export type SpokenDraft = WriteResult & {
  /** The saved plan the words were written from. */
  planId: number | null;
  briefSourceHash: string | null;
  briefAnchorIds: number[] | null;
};

function spokenDraft(words: ConversationWords | null): SpokenDraft {
  if (words === null) throw new Error("the draft was stopped before it was judged");
  return {
    text: words.text,
    model: modelFor("writer"),
    promptTemplate: words.promptTemplate,
    planId: words.planId,
    briefSourceHash: words.brief.sourceHash,
    briefAnchorIds: words.brief.anchorIds,
  };
}

/** The thread a public reply or a DM answers, as the dispatcher reads it. */
const replyConversation = ({ incoming, threadContext }: Pick<PreparedReplyDraft, "incoming" | "threadContext">) =>
  threadConversation({ text: incoming.text, authorName: incoming.authorName, postedAt: incoming.receivedAt }, threadContext);

const FINAL_REPLY = "This is the last reply the owner has in this thread: close the exchange with a statement and ask no question.";

/** What a public reply to `incoming` is written from. The brief cannot be
 *  split back into the facts it was compiled from, so one stale fact among
 *  them takes the whole brief out of the draft. */
export async function prepareStepReply(
  tx: Tx,
  input: { incoming: IncomingComment; campaign: Campaign; voice: StrategyVoice; now: number; step?: Pick<StrategyStep, "step_id" | "instructions" | "objective"> },
): Promise<PreparedReplyDraft> {
  const { incoming, campaign, voice, now } = input;
  const prepared = await prepareReplyDraft(
    tx,
    incoming,
    { ...campaign, voiceId: draftingVoiceId(voice, campaign) },
    undefined,
    { factFilter: freshFact(now) },
    { step: input.step ? { id: input.step.step_id, instructions: input.step.instructions, objective: input.step.objective } : null,
      voice: await draftingVoice(tx, campaign, voice, "reply") },
  );
  const staleFact = (await campaignFacts(tx, campaign.id)).some(
    (fact) => factFreshness(fact, now).stale,
  );
  return {
    ...prepared,
    brain: staleFact ? { ...prepared.brain, compiledBrief: null } : prepared.brain,
  };
}

/** Intake changes reply bookkeeping, not the words or instructions it used. */
export function stepReplyWritingRevision(prepared: PreparedReplyDraft, facts: ProductFact[]): string {
  const preparation: Record<string, unknown> = JSON.parse(replyPreparationRevision(prepared));
  preparation.incoming = { text: prepared.incoming.text, source: prepared.incoming.source,
    authorName: prepared.incoming.authorName, textHash: prepared.incoming.textHash };
  preparation.campaign = { guidance: campaignWritingGuidance(prepared.campaign, "reply"),
    strictness: prepared.campaign.tone?.slop_strictness, premiumWriter: prepared.campaign.premiumWriter };
  return createHash("sha256").update(JSON.stringify({
    preparation,
    facts: [...facts].sort((a, b) => a.id - b.id),
  })).digest("hex");
}

/** What the dispatcher writes a public reply to an incoming comment from: the
 *  thread it answers, and what a claim in it may rest on. */
export function replyWordsInput(
  prepared: PreparedReplyDraft,
  facts?: readonly string[],
): Omit<ConversationWordsInput, "organizationId" | "llm"> {
  const { incoming, threadContext } = prepared;
  return {
    campaign: prepared.campaign,
    draftKey: incoming.id,
    surface: "reply",
    conversation: replyConversation(prepared),
    brain: prepared.brain,
    query: incoming.text,
    products: prepared.products,
    ...(facts ? { facts } : {}),
    step: prepared.stepInstructions ?? null,
    ...(threadContext.finalReply ? { rules: [FINAL_REPLY] } : {}),
    firstTouch: threadContext.repliesUsed === 0,
  };
}

/** A public reply to an incoming comment, planned, written and judged by the
 *  dispatcher for the thread it answers. */
export async function writeReplyWords(
  prepared: PreparedReplyDraft,
  opts: { organizationId: string; llm: LLM; facts?: readonly string[] },
): Promise<SpokenDraft> {
  return spokenDraft(
    await writeConversationWords({ ...replyWordsInput(prepared, opts.facts), organizationId: opts.organizationId, llm: opts.llm }),
  );
}

/** What came of words that may be held: held for the owner, with the reading
 *  to keep when one was made here, or written. */
export type Held = { kind: "held"; reading: IncomingReading | undefined };

/** The reading of the words an item answers, stored or made now, and whether
 *  it holds them from every draft: the reading found words a person must see
 *  first (press, legal, hostile, profane), or the row arrived held. */
async function readingHolds(incoming: IncomingComment, llm: LLM): Promise<{ held: boolean; reading: IncomingReading; made: boolean }> {
  const stored = readingOf(incoming);
  const reading = stored ?? (await readIncoming(incoming.text, "reply", llm));
  return { held: sensitivityOf(reading).hold || incoming.sensitivity === "hold", reading, made: stored === null };
}

/** Keeps a reading on its row, with the hold it found unless the row arrived
 *  held for another reason. */
export async function keepReading(tx: Tx, incoming: Pick<IncomingComment, "id" | "sensitivity">, reading: IncomingReading): Promise<void> {
  await tx
    .update(incomingComments)
    .set({ reading, ...(incoming.sensitivity === "hold" ? {} : sensitivityRow(sensitivityOf(reading))) })
    .where(eq(incomingComments.id, incoming.id));
}

/** A public reply, written from what `prepareStepReply` read: the reply's
 *  stored reading for the hold — read now only for a reply that has none — then,
 *  unless it holds the words, the dispatcher under the step's instructions.
 *  Where the step binds facts they are the one list the reply may claim, and
 *  the campaign's products stand beside them by name alone. A held reply is
 *  never written; `reading` is the reading made here, for the caller to keep. */
export async function writeStepReply(
  prepared: PreparedReplyDraft,
  opts: { organizationId: string; step: Pick<StrategyStep, "instructions">; facts: ProductFact[]; llm: LLM },
): Promise<Held | { kind: "written"; draft: SpokenDraft; sensitivity: ReturnType<typeof sensitivityOf>; reading: IncomingReading | undefined }> {
  const { held, reading, made } = await readingHolds(prepared.incoming, opts.llm);
  if (held) return { kind: "held", reading };
  const draft = await writeReplyWords(
    {
      ...prepared,
      stepInstructions: { id: prepared.stepInstructions?.id ?? "reply", instructions: opts.step.instructions },
      products:
        opts.facts.length > 0
          ? prepared.products.map((product) => ({ ...product, facts: [] }))
          : prepared.products,
    },
    { organizationId: opts.organizationId, llm: opts.llm, facts: boundFactLines(opts.facts) },
  );
  return { kind: "written", draft, sensitivity: sensitivityOf(reading), reading: made ? reading : undefined };
}

/** What a DM is drafted from: the exchange under our comment it answers, or
 *  the person's conversation with the account. */
export type DmSource =
  | {
      kind: "exchange";
      incoming: IncomingComment;
      thread: ReplyThreadContext;
      products: ProductContext[];
      objective: string;
      voice: ResolvedVoiceV2;
      preferences: Awaited<ReturnType<typeof readWritingPreferences>>;
    }
  | {
      kind: "conversation";
      conversationId: number;
      /** Their newest words in the conversation are held for the owner. */
      held: boolean;
      purpose: DirectMessagePurpose;
      conversation: string;
      interest: boolean;
      name: string | null;
      products: ProductContext[];
      voice: ResolvedVoiceV2;
      preferences: Awaited<ReturnType<typeof readWritingPreferences>>;
    };

/** Only inputs that can change these words participate in the admission check. */
export function dmWritingRevision(source: DmSource, instructions: string, facts: ProductFact[], offer: OfferWords | null): string {
  const { preferences, ...evidence } = source;
  return createHash("sha256").update(JSON.stringify({ evidence, instructions, facts: [...facts].sort((a, b) => a.id - b.id), offer,
    preferences: preferences ? { learnedGuidance: preferences.learnedGuidance, constraints: preferences.constraints,
      campaign: campaignWritingGuidance(preferences.campaign, "dm") } : null,
  })).digest("hex");
}

/** Only inputs that can change a note's words participate in the admission check. */
export function noteWritingRevision(
  source: NoteSource,
  input: { thread: string; name: string | null; instructions: string; interestShown: boolean },
): string {
  const { preferences, ...evidence } = source;
  return createHash("sha256").update(JSON.stringify({ evidence, ...input,
    preferences: { learnedGuidance: preferences.learnedGuidance, constraints: preferences.constraints,
      campaign: campaignWritingGuidance(preferences.campaign, "invitation") } })).digest("hex");
}

/** Keeps the facts a drafter may be handed: a stale one of the campaign's own
 *  never is. */
function freshFact(now: number): (fact: ProductFact) => boolean {
  return (fact) => !factFreshness(fact, now).stale;
}

/** Every product attached to the campaign, each with its fresh facts only —
 *  a bounded slice of them, as the comment lane reads it. */
export async function freshProducts(tx: Tx, campaignId: number, now: number): Promise<CampaignProduct[]> {
  return loadCampaignProducts(tx, campaignId, { factFilter: freshFact(now) });
}

/** A DM answering a reply under our comment, drafted from that exchange. In
 *  lead mode what it may say follows the person's intent (`intentGate`): its
 *  framing stands where the Goal's description would, and a product is
 *  handed over only where one may come up. */
export async function exchangeSource(
  tx: Tx,
  input: { incoming: IncomingComment; campaign: Campaign; voice: StrategyVoice; now: number },
): Promise<DmSource> {
  const products = await freshProducts(tx, input.campaign.id, input.now);
  const intent = await draftIntentGate(tx, input.incoming.authorProfileId, products.length > 0);
  return {
    kind: "exchange",
    preferences: await readWritingPreferences(tx, input.campaign),
    incoming: input.incoming,
    thread: await assembleReplyContext(tx, input.incoming),
    products: productsWithin(intent, products),
    objective: intent ? intent.framing : objectiveMeta(input.campaign.objective).description,
    voice: await draftingVoice(tx, input.campaign, input.voice, "dm"),
  };
}

/** Whether the newest words they said in a conversation are held for the owner:
 *  their reading found a hold, or none was made, since words no model read are
 *  a person's to read first. */
async function wordsHeld(tx: Tx, conversationId: number): Promise<boolean> {
  const [newest] = await tx
    .select({ reading: conversationEvents.reading })
    .from(conversationEvents)
    .where(and(
      eq(conversationEvents.conversationId, conversationId),
      inArray(conversationEvents.type, ["inbound_message_observed", "reply_observed", "reply_edited"]),
    ))
    .orderBy(desc(conversationEvents.occurredAt), desc(conversationEvents.id))
    .limit(1);
  return newest !== undefined && (newest.reading === null || sensitivityOf(newest.reading).hold);
}

/** A DM in their conversation with the account, drafted from it: the one
 *  opener, an answer, or — after our own unanswered message, whatever woke
 *  the step — a follow-up. In lead mode a product is handed over only where
 *  the person's intent lets one come up. */
export async function conversationSource(
  tx: Tx,
  input: {
    conversation: Pick<ConversationRow, "id" | "authorProfileId" | "interestEvidenceEventId">;
    campaign: Campaign;
    dmHistory: string;
    eventType: ConversationEventRow["type"];
    voice: StrategyVoice;
    now: number;
  },
): Promise<Extract<DmSource, { kind: "conversation" }>> {
  const interest = input.conversation.interestEvidenceEventId !== null;
  const [named] = await tx
    .select({ name: incomingComments.authorName })
    .from(incomingComments)
    .where(eq(incomingComments.authorProfileId, input.conversation.authorProfileId))
    .orderBy(desc(incomingComments.id))
    .limit(1);
  const ours = await latestOurs(tx, input.conversation.id, (await conversationDms(tx, input.conversation.id)).confirmed);
  const products = await freshProducts(tx, input.campaign.id, input.now);
  const intent = await draftIntentGate(tx, input.conversation.authorProfileId, products.length > 0);
  return {
    kind: "conversation",
    conversationId: input.conversation.id,
    held: await wordsHeld(tx, input.conversation.id),
    preferences: await readWritingPreferences(tx, input.campaign),
    purpose:
      ours !== null && !ours.answered
        ? "followup"
        : input.eventType === "invitation_accepted" && !interest
          ? "opener"
          : "reply",
    conversation: input.dmHistory,
    interest,
    name: named?.name ?? null,
    products: productsWithin(intent, products),
    voice: await draftingVoice(tx, input.campaign, input.voice, "dm"),
  };
}

export async function writeStepDm(
  source: DmSource,
  opts: {
    organizationId: string;
    step: Pick<StrategyStep, "instructions">;
    facts: ProductFact[];
    /** The approved offer the DM makes, or null for none. */
    offer: OfferWords | null;
    llm: LLM;
  },
): Promise<Held | { kind: "written"; draft: SpokenDraft; reading: IncomingReading | undefined }> {
  const { preferences } = source;
  const exchange = source.kind === "exchange";
  const purpose = exchange ? "reply" : source.purpose;
  // Words a person must see first are never answered, by a draft or a redraft.
  const checked = exchange ? await readingHolds(source.incoming, opts.llm) : null;
  if (checked ? checked.held : source.kind === "conversation" && source.held) {
    return { kind: "held", reading: checked?.made ? checked.reading : undefined };
  }
  const draft = spokenDraft(
    await writeConversationWords({
      organizationId: opts.organizationId,
      campaign: preferences.campaign,
      llm: opts.llm,
      draftKey: exchange ? source.incoming.id : source.conversationId,
      surface: purpose === "followup" ? "followup" : "dm",
      conversation: exchange
        ? replyConversation({ incoming: source.incoming, threadContext: source.thread })
        : { post: { discoveredPostId: null, authorName: source.name, postedAt: null, text: source.conversation, mediaText: null }, turns: [] },
      query: exchange ? source.incoming.text : source.conversation,
      products: source.products,
      facts: boundFactLines(opts.facts, opts.offer),
      step: { id: "dm", instructions: opts.step.instructions },
      rules: [
        ...(purpose === "opener" ? ["This is the one opener after their invitation was accepted: only the conversation shows any earlier contact."] : []),
        ...(purpose === "followup" ? ["This is the one follow-up after their silence: only the conversation shows what was said."] : []),
        exchange
          ? `Their reply was read as ${source.incoming.intent ?? "none"}: context only, never permission or a claim of interest.`
          : source.interest
            ? "Interest is evidenced by their quoted words; claim no further commitment."
            : "Do not claim they expressed interest in an offer.",
        ...offerRules(opts.offer),
      ],
      ...(opts.offer === null ? {} : { offer: true }),
      firstTouch: purpose === "opener",
    }),
  );
  return { kind: "written", draft, reading: checked?.made ? checked.reading : undefined };
}

/** Use the observed composer limit, never past the 300 characters an invitation
 * may carry. When unknown, prepare within that envelope; the canonical sender
 * refuses an unread or unsupported composer. Preferred brevity belongs in
 * editable instructions. */
export async function noteLimitFor(tx: Tx, authorProfileId: string): Promise<number> {
  const [person] = await tx
    .select({ evidence: authorProfiles.identityEvidence })
    .from(authorProfiles)
    .where(eq(authorProfiles.profileId, authorProfileId));
  return Math.min(person?.evidence?.read.note.limitChars ?? INVITATION_NOTE_TARGET_CHARS, INVITATION_NOTE_TARGET_CHARS);
}

/** What an invitation's note is written from besides the exchange. */
export type NoteSource = { voice: ResolvedVoiceV2; maxChars: number; products: CampaignProduct[];
  preferences: Awaited<ReturnType<typeof readWritingPreferences>> };

/** What an invitation's note is written in: the campaign's voice, aimed under
 *  the limit a composer last printed for the person, where one did, with the
 *  campaign's attached products as context — whatever the step's context refs
 *  name, since the note is written by the server and not by the step. In lead
 *  mode a product is handed over only where the person's intent lets one come
 *  up (`intentGate`). */
export async function noteSource(
  tx: Tx,
  input: { campaign: Campaign; authorProfileId: string; voice: StrategyVoice; now: number },
): Promise<NoteSource> {
  const products = await freshProducts(tx, input.campaign.id, input.now);
  const intent = await draftIntentGate(tx, input.authorProfileId, products.length > 0);
  return {
    voice: await draftingVoice(tx, input.campaign, input.voice, "dm"),
    preferences: await readWritingPreferences(tx, input.campaign),
    maxChars: await noteLimitFor(tx, input.authorProfileId),
    products: productsWithin(intent, products),
  };
}

/** Bind every supplied fact: prose is never parsed into a product-permission
 * flag, and an inherited preference can still ask for a factual mention. */
export function factsBoundToNote(
  source: Pick<NoteSource, "products">,
  step: Pick<StrategyStep, "instructions">,
): CampaignProduct["factRows"] {
  return source.products.flatMap((product) => product.factRows);
}

/** An invitation's note, from the verified exchange and the step's own
 *  instructions — never from the proposal — planned, written and judged by
 *  the dispatcher under the limit the composer printed for the person. */
export async function writeStepNote(
  source: NoteSource,
  opts: {
    organizationId: string;
    thread: string;
    name: string | null;
    step: Pick<StrategyStep, "instructions">;
    interestShown: boolean;
    /** The conversation the note goes into, which names its saved plan. */
    conversationId?: number;
    llm: LLM;
    beforeCall?: () => Promise<void>;
  },
): Promise<SpokenDraft> {
  return spokenDraft(
    await writeConversationWords({
      organizationId: opts.organizationId,
      campaign: source.preferences.campaign,
      llm: opts.llm,
      surface: "invitation",
      ...(opts.conversationId === undefined ? {} : { draftKey: opts.conversationId }),
      conversation: { post: { discoveredPostId: null, authorName: opts.name, postedAt: null, text: opts.thread, mediaText: null }, turns: [] },
      query: opts.thread,
      products: source.products,
      step: { id: "invitation", instructions: opts.step.instructions },
      rules: [
        "Cite the exchange you actually had; it is the only shared conversation you may refer to.",
        opts.interestShown
          ? "Interest is evidenced by their quoted words; do not expand it into a commitment."
          : "Product interest is not evidenced: an invitation to try the product must not claim they requested or wanted it.",
      ],
      // The note follows an exchange the step requires: they answered us.
      firstTouch: false,
      maxChars: source.maxChars,
      ...(opts.beforeCall ? { continueRun: async () => (await opts.beforeCall!(), true) } : {}),
    }),
  );
}
