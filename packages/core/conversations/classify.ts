import { z } from "zod";
import type { ConversationEvidenceSpan, IncomingReading } from "@engager/database/schema";
import type { ReplyReading } from "./eligibility";

const SPAN_LABELS = [
  "relevance",
  "stance",
  "opt_out",
  "busy",
  "question",
  "interest",
] as const;

/** Quotes BEFORE the labels — the lead-intent judge's convention: naming the
 *  words first grounds the verdict under forced tool use. */
export const ReplyStanceVerdict = z.object({
  evidence: z
    .array(z.object({ quote: z.string(), supports: z.enum(SPAN_LABELS) }))
    .max(6),
  relevance: z.enum(["relevant", "unrelated", "spam"]),
  stance: z.enum(["positive", "neutral", "negative"]),
  opt_out: z.boolean(),
  busy: z.boolean(),
  question: z.boolean(),
  interest: z.boolean(),
  uncertain: z.boolean(),
});
export type ReplyStanceVerdict = z.infer<typeof ReplyStanceVerdict>;

/** Which classifier read an event, recorded on its decision. */
export type ClassifierStamp = { promptRef: string; model: string };

export type ClassifiedReply = {
  reading: ReplyReading;
  spans: ConversationEvidenceSpan[];
  verdict: ReplyStanceVerdict;
  classifier: ClassifierStamp;
};

/**
 * A reply as the eligibility table reads it, from the stored reading of its
 * words. The reading's quotes are checked against `content` here
 * ({@link readVerdict}), never trusted.
 */
export function replyOf(content: string, stored: IncomingReading): ClassifiedReply {
  const { verdict } = stored;
  const stance: ReplyStanceVerdict = {
    evidence: verdict.evidence.filter(spanSupportsReply),
    relevance: verdict.relevance,
    stance: verdict.stance,
    opt_out: verdict.opt_out,
    busy: verdict.busy,
    question: verdict.question,
    interest: verdict.interest,
    uncertain: verdict.uncertain,
  };
  return { ...readVerdict(content, stance), verdict: stance, classifier: stamp(stored) };
}

const REPLY_LABELS: ReadonlySet<string> = new Set(SPAN_LABELS);

function spanSupportsReply(span: { supports: string }): span is ReplyStanceVerdict["evidence"][number] {
  return REPLY_LABELS.has(span.supports);
}

function stamp(stored: IncomingReading): ClassifierStamp {
  return { promptRef: stored.promptRef, model: stored.model };
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function wordCount(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/**
 * Where `quote` stands in `content` as a run of the person's whole words —
 * starting and ending on word boundaries, never inside one — and is long
 * enough to say something: two words or more, or every word of a one-word
 * reply. A fragment ("Not", lifted from "Not sure yet") is no evidence.
 */
export function locateQuote(
  content: string,
  quote: string,
): { start: number; end: number } | null {
  const words = wordCount(quote);
  if (words === 0 || (words < 2 && words !== wordCount(content))) return null;
  for (
    let start = content.indexOf(quote);
    start !== -1;
    start = content.indexOf(quote, start + 1)
  ) {
    const end = start + quote.length;
    const before = start > 0 ? content[start - 1]! : "";
    const after = end < content.length ? content[end]! : "";
    const opensWord = !WORD_CHAR.test(before) || !WORD_CHAR.test(quote[0]!);
    const closesWord = !WORD_CHAR.test(after) || !WORD_CHAR.test(quote.at(-1)!);
    if (opensWord && closesWord) return { start, end };
  }
  return null;
}

/**
 * Check a verdict against the words it claims to read. A quote is evidence
 * only where it stands verbatim in `content` as whole words (see
 * {@link locateQuote}), and becomes a span there; the two claims that move a
 * fact — an opt-out and interest — stand only on a quote of their own, and
 * one without is named `unquoted` instead.
 */
export function readVerdict(
  content: string,
  verdict: ReplyStanceVerdict,
): { reading: ReplyReading; spans: ConversationEvidenceSpan[] } {
  const { spans, quoted, unquoted } = quotedClaims(content, verdict);
  return {
    reading: {
      relevance: verdict.relevance,
      stance: verdict.stance,
      optOut: verdict.opt_out && quoted("opt_out"),
      busy: verdict.busy,
      question: verdict.question,
      interest: verdict.interest && quoted("interest"),
      uncertain: verdict.uncertain,
      unquoted,
    },
    spans,
  };
}

/** The verdict's quotes that stand in `content` as spans, and which of the
 *  two fact-moving claims — an opt-out, interest — it made without one. */
function quotedClaims(
  content: string,
  verdict: {
    evidence: ReadonlyArray<{ quote: string; supports: string }>;
    opt_out: boolean;
    interest: boolean;
  },
): {
  spans: ConversationEvidenceSpan[];
  quoted: (label: string) => boolean;
  unquoted: ReplyReading["unquoted"][number][];
} {
  const spans: ConversationEvidenceSpan[] = [];
  for (const { quote, supports } of verdict.evidence) {
    const at = locateQuote(content, quote.trim());
    if (at) spans.push({ ...at, label: supports });
  }
  const quoted = (label: string) => spans.some((span) => span.label === label);
  const unquoted: ReplyReading["unquoted"][number][] = [];
  if (verdict.opt_out && !quoted("opt_out")) unquoted.push("opt_out");
  if (verdict.interest && !quoted("interest")) unquoted.push("interest");
  return { spans, quoted, unquoted };
}

/**
 * What an inbound direct message intends (spec §10 R05, "Inbound DM —
 * classify its actual intent"), one word for the owner to read. A greeting,
 * a courtesy or a question about something else is not interest; in a mixed
 * message an opt-out outranks everything and "busy" outranks a question or
 * interest (§11). `unknown` is review.
 */
export const MESSAGE_INTENTS = [
  "opt_out",
  "busy",
  "interest",
  "question",
  "declined",
  "greeting",
  "unrelated",
  "unknown",
] as const;
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

const MESSAGE_SPAN_LABELS = [
  "opt_out",
  "busy",
  "interest",
  "question",
  "greeting",
  "unrelated",
] as const;

export const MessageIntentVerdict = z.object({
  evidence: z
    .array(z.object({ quote: z.string(), supports: z.enum(MESSAGE_SPAN_LABELS) }))
    .max(6),
  opt_out: z.boolean(),
  busy: z.boolean(),
  interest: z.boolean(),
  question: z.boolean(),
  greeting: z.boolean(),
  /** They said no to what was offered, refusing nothing further: the stored
   *  reading's negative stance on a message that is no opt-out. Absent on a
   *  verdict that never read a stance. */
  declined: z.boolean().optional(),
  unrelated: z.boolean(),
  spam: z.boolean(),
  uncertain: z.boolean(),
});
export type MessageIntentVerdict = z.infer<typeof MessageIntentVerdict>;

export type ClassifiedMessage = {
  intent: MessageIntent;
  reading: ReplyReading;
  spans: ConversationEvidenceSpan[];
  verdict: MessageIntentVerdict;
  classifier: ClassifierStamp;
  /** The stored reading the message was recorded from. */
  read: IncomingReading;
};

/**
 * A message as the eligibility table reads it, from the stored reading of its
 * words. Only the message was read, never the thread around it, the person's
 * profile or anything else the read saw.
 */
export function messageOf(content: string, stored: IncomingReading): ClassifiedMessage {
  const { verdict } = stored;
  const message: MessageIntentVerdict = {
    evidence: verdict.evidence.filter(spanSupportsMessage),
    opt_out: verdict.opt_out,
    busy: verdict.busy,
    interest: verdict.interest,
    question: verdict.question,
    greeting: verdict.greeting,
    declined: verdict.stance === "negative" && !verdict.opt_out,
    unrelated: verdict.relevance === "unrelated",
    spam: verdict.relevance === "spam",
    uncertain: verdict.uncertain,
  };
  return { ...readMessageVerdict(content, message), verdict: message, classifier: stamp(stored), read: stored };
}

const MESSAGE_LABELS: ReadonlySet<string> = new Set(MESSAGE_SPAN_LABELS);

function spanSupportsMessage(span: { supports: string }): span is MessageIntentVerdict["evidence"][number] {
  return MESSAGE_LABELS.has(span.supports);
}

/**
 * Check a message verdict against the words it claims to read, as
 * {@link readVerdict} does a reply's, and name its intent. An opt-out or
 * interest stands only on a quote of its own. A message the model could make
 * nothing of — no label at all — reads as uncertain, so the table sends it to
 * a person rather than letting silence count as a greeting.
 */
export function readMessageVerdict(
  content: string,
  verdict: MessageIntentVerdict,
): { intent: MessageIntent; reading: ReplyReading; spans: ConversationEvidenceSpan[] } {
  const { spans, quoted, unquoted } = quotedClaims(content, verdict);
  const optOut = verdict.opt_out && quoted("opt_out");
  const interest = verdict.interest && quoted("interest");
  const intent: MessageIntent =
    verdict.uncertain || unquoted.includes("opt_out")
      ? "unknown"
      : optOut
        ? "opt_out"
        : verdict.busy
          ? "busy"
          : interest
            ? "interest"
            : verdict.question
              ? "question"
              : verdict.declined
                ? "declined"
              : verdict.greeting
                ? "greeting"
                : verdict.unrelated || verdict.spam
                  ? "unrelated"
                  : "unknown";
  return {
    intent,
    reading: {
      relevance: verdict.spam ? "spam" : verdict.unrelated ? "unrelated" : "relevant",
      // A message is not judged for stance: nothing in R05's DM row reads it.
      stance: "neutral",
      optOut,
      busy: verdict.busy,
      question: verdict.question,
      interest,
      uncertain: verdict.uncertain || intent === "unknown",
      unquoted,
    },
    spans,
  };
}
