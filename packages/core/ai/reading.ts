import { createHash } from "node:crypto";
import { z } from "zod";
import type { IncomingHoldReason, IncomingReading } from "@engager/database/schema";
import { getLLM, type LLM } from "./client";
import { modelFor } from "./modelFor";
import { promptRef } from "./prompt/ids";
import { untrusted } from "./prompts";

/**
 * THE ONE READING OF AN INCOMING ITEM. A comment on the owner's post, a reply
 * under their comment, a direct message and an invitation's note are each read
 * once, by one model call, for everything any later decision asks of them: what
 * the person's stance is and whether they opted out, what they want of the
 * product, and whether a human must see the words before an AI answers. The
 * verdict is stored with the row (`IncomingReading`); the eligibility table,
 * lead intake, the hold and the reply writer read it from there, and the same
 * words are never classified again.
 */

export type ReadingKind = IncomingReading["kind"];

const SPAN_LABELS = [
  "relevance",
  "stance",
  "opt_out",
  "busy",
  "question",
  "interest",
  "greeting",
  "unrelated",
] as const;

/** Evidence BEFORE the verdict (same convention as SlopReport: enumerating the
 *  proof first measurably grounds the judgment under forced tool-use). */
export const IncomingVerdict = z.object({
  evidence: z.array(z.object({ quote: z.string(), supports: z.enum(SPAN_LABELS) })).max(6),
  relevance: z.enum(["relevant", "unrelated", "spam"]),
  stance: z.enum(["positive", "neutral", "negative"]),
  opt_out: z.boolean(),
  busy: z.boolean(),
  question: z.boolean(),
  interest: z.boolean(),
  greeting: z.boolean(),
  uncertain: z.boolean(),
  /** Verbatim quote from the words that justifies `lead_intent` ("" for none). */
  lead_evidence: z.string(),
  lead_intent: z.enum(["explicit_ask", "product_question", "positive_signal", "none"]),
  hold: z.boolean(),
  category: z.enum(["ok", "negative", "press", "legal", "competitor", "profanity", "other"]),
  /** Conversation arc: does this comment ask/add something (substantive), or
   *  does it close the exchange (warm/cold closer → react or dismiss, never
   *  draft another reply)? Optional under forced tool-use — absent reads as
   *  substantive so a dropped field can never dismiss a real question. */
  arc: z.enum(["substantive", "warm_closer", "cold_closer"]).optional(),
}) satisfies z.ZodType<IncomingReading["verdict"]>;
export type IncomingVerdict = z.infer<typeof IncomingVerdict>;

const WORDS: Record<ReadingKind, { what: string; noun: string; who: string; label: string; named: string }> = {
  comment: {
    what: "one comment someone left on the user's OWN LinkedIn post, before an AI may reply under the user's name",
    noun: "comment",
    who: "author",
    label: "INCOMING COMMENT",
    named: " — often named in the thread",
  },
  reply: {
    what: "one reply a person left directly under a LinkedIn comment the user wrote",
    noun: "reply",
    who: "replier",
    label: "REPLY UNDER OUR COMMENT",
    named: " — often named in the thread",
  },
  message: {
    what: "one direct message a person sent the user on LinkedIn",
    noun: "message",
    who: "sender",
    label: "DIRECT MESSAGE",
    named: " — often named in the conversation",
  },
  // A note stands alone: there is no thread or conversation to name it in.
  invite_note: {
    what: "the note someone sent with their LinkedIn connection request to the user",
    noun: "note",
    who: "sender",
    label: "INCOMING INVITE NOTE",
    named: "",
  },
};

/** The reading rubric for one kind of words. Exported so the client-drafting
 *  skill can mirror the exact criteria the server applies. */
export const readingSystem = (kind: ReadingKind): string => {
  const { what, noun, who, named } = WORDS[kind];
  return `You read ${what}, to say what it permits, what it wants and whether a human must see it first. You do not answer it.
evidence: up to six quotes copied EXACTLY from the ${noun}, character for character, each naming the label it supports. Each quote is a run of at least two whole words — never a fragment of a word — unless the whole ${noun} is one word. Quote first, then label. Never paraphrase a quote.

STANCE
relevance=relevant: it engages with the user's words or the topic. relevance=unrelated: it ignores the exchange (a pasted pleasantry, another topic, about something other than the user's product). relevance=spam: a pitch for their own product or service, a link drop, bait.
stance=positive: agreement, thanks, enthusiasm. stance=negative: disagreement, criticism, hostility, or saying they are not interested. stance=neutral: neither — a plain question, a fact, a measured remark. A neutral ${noun} is NOT negative for being unenthusiastic.
opt_out=true ONLY when they explicitly refuse further contact or tell the user to stop ("please don't message me", "not interested, stop"). Criticism alone is not an opt-out. Quote the refusal.
busy=true when they say it is not a good time ("swamped this week", "maybe later") — it does not refuse. Never guess when they will be free.
question=true when they ask something.
interest=true ONLY when they explicitly ask to try, see, buy or discuss the user's product or to work together. Praise of the post or the idea, a thank-you, a greeting or a question about something else is NOT interest. Quote the ask.
greeting=true when it is a greeting or a courtesy and nothing more ("Thanks for connecting!", "Hi there").
uncertain=true when you cannot tell what it means: sarcasm you cannot resolve, a language you cannot read, a fragment.

BUYING INTENT toward the user's product (the product the user builds/sells${named}), not general enthusiasm for the topic.
lead_intent=explicit_ask: they directly ask to learn more, see it, try it, talk, or buy — e.g. "I'd love to learn more about it", "can you show me?", "how do I get access?". A concrete ask, aimed at the product.
lead_intent=product_question: they ask a specific question ABOUT the product (what it does, how it works, pricing, fit for their case) without asking for a conversation.
lead_intent=positive_signal: they show real interest in the product ("intrigued by X", "this sounds exactly like what we need") but ask nothing.
lead_intent=none: everything else — topic discussion, praise of the post, disagreement, their own pitch.
Read the WHOLE ${noun} and classify by the STRONGEST signal present: a long ${noun} about their own company that ends with "I'd love to learn more about it sometime" is explicit_ask — the ask outranks everything before it, and a soft deferral ("sometime", "at some point", "when you have time") does NOT weaken it. Praise first, ask later is still an ask.
Beware LinkedIn boilerplate: "let's connect sometime", "great post, following!", generic networking pleasantries are lead_intent=none — a real ask names or clearly points at the product. A ${who} pitching THEIR OWN product is none, even when flattering.
lead_evidence: quote the exact words of the STRONGEST signal (the ask, if there is one), verbatim from the ${noun}; empty string for none.

SENSITIVITY
Set hold=true when a human MUST review before an AI replies: hostile/negative, profane, from press/journalists, anything legal-sounding (threats, disputes, compliance), or a competitor jab/bait. Name the category (negative, press, legal, competitor, profanity, other). Set hold=false, category=ok only for clearly benign words (genuine questions, praise, neutral discussion). When unsure, hold=true.
Also judge the conversation ARC. arc=substantive: it asks something, pushes back, or adds material worth answering. arc=warm_closer: a friendly wrap-up — thanks, praise, agreement, an emoji-level pleasantry — with NOTHING left to answer (replying again would loop the thread; the human response is a reaction, not words). arc=cold_closer: an ending with no warmth to acknowledge (flat "ok", dismissiveness, spam). When unsure, arc=substantive.`;
};

/** SHA-256 hex of the words a reading was made of. */
export function wordsHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Read one item's words: the one model call every decision about them stands
 * on. The words reach the model only inside {@link untrusted}. Throws what the
 * model call throws; the caller records the item unread, which is review.
 */
export async function readIncoming(
  text: string,
  kind: ReadingKind,
  llm?: LLM,
): Promise<IncomingReading> {
  const client = llm ?? getLLM();
  const model = modelFor("filter");
  const ref = promptRef("judge.incoming_reading");
  const verdict = await client.json({
    model,
    stage: "incoming_reading",
    promptRef: ref,
    system: readingSystem(kind),
    user: untrusted(WORDS[kind].label, text),
    schema: IncomingVerdict,
    maxTokens: 600,
  });
  return { kind, textHash: wordsHash(text), model, promptRef: ref, readAt: Date.now(), verdict };
}

/** The reading stored with a row, if it was made of the words the row has now.
 *  An edited row's reading is stale and reads as none. */
export function readingOf(row: { text: string; reading: IncomingReading | null }): IncomingReading | null {
  return row.reading && row.reading.textHash === wordsHash(row.text) ? row.reading : null;
}

/** Whether the sensitivity check found words a human must see first. */
export type SensitivityVerdict = Pick<IncomingVerdict, "hold" | "category" | "arc">;

export function sensitivityOf(reading: IncomingReading): SensitivityVerdict {
  const { hold, category, arc } = reading.verdict;
  return { hold, category, ...(arc ? { arc } : {}) };
}

/** What an incoming comment's row keeps of a verdict: held or not, and why.
 *  A hold the verdict files under no category of the rubric's is
 *  `sensitive_other`. */
export function sensitivityRow(verdict: Pick<SensitivityVerdict, "hold" | "category">): {
  sensitivity: "hold" | "ok";
  holdReason: IncomingHoldReason | null;
} {
  if (!verdict.hold) return { sensitivity: "ok", holdReason: null };
  return {
    sensitivity: "hold",
    holdReason: verdict.category === "ok" ? "sensitive_other" : `sensitive_${verdict.category}`,
  };
}

/** What kind of words a person wrote to the owner, for the lead they build. */
export type LeadWordsKind = Exclude<ReadingKind, "reply">;

export type LeadIntentVerdict = {
  evidence: string;
  intent: IncomingVerdict["lead_intent"];
};

export function leadOf(reading: IncomingReading): LeadIntentVerdict {
  return { evidence: reading.verdict.lead_evidence, intent: reading.verdict.lead_intent };
}
