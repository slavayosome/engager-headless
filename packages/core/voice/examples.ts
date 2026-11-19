import type { StyleRules, VoiceExample } from "@engager/database/schema";

/**
 * THE EXAMPLES A VOICE KEEPS OF HOW THE OWNER WRITES: how many it keeps, when
 * two of them are the same words, and which a channel's drafts are shown.
 *
 * Each example belongs to one channel — Comment, Reply or DM — and a channel
 * with none of its own is shown Comment's. Pinned ones list first and never
 * drop off to make room.
 *
 * TWO FIELDS, KEPT IN STEP. `styleRules.examples` is the Comment channel's
 * words, newest first, a plain list of strings — the shape every release
 * reads, so a voice written here stays readable by one before it.
 * `styleRules.exampleItems` is every channel's examples with their pin,
 * origin and date. Every write sets both from one list (`examplesFields`),
 * and every read goes through `voiceExamples`, where the plain list decides
 * which comment examples there are: one written by a writer that knows only
 * the plain list — an older release, or `save_voice` — is read as it left
 * them.
 *
 * Pure, and free of the database, so a page can hold what the owner pastes to
 * the rules the operations keep it to before anything is sent.
 */

export type ExampleChannel = VoiceExample["channel"];

/** At most this many examples are kept for each channel, newest first. */
export const VOICE_EXAMPLE_CAP = 12;

/** The words of an example as two of them are compared: the same words twice
 *  are one example, whatever their spacing, case or Unicode form. */
export function exampleKey(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** A comment example the plain list holds and no item describes: one kept
 *  before examples carried more, read as pasted, unpinned and undated. */
export function plainExample(text: string): VoiceExample {
  return { text, pinned: false, addedAt: null, from: "pasted", channel: "comment" };
}

type ExampleRules = Pick<StyleRules, "examples" | "exampleItems"> | null | undefined;

/**
 * Every example a voice keeps, newest first. Where the items hold exactly the
 * plain list's comments, they are read as written. Where a writer that knows
 * only the plain list has moved it since, its comments are the plain list's,
 * each with what its item said of it, ahead of every other channel's items.
 */
export function voiceExamples(rules: ExampleRules): VoiceExample[] {
  const items = rules?.exampleItems ?? [];
  const plain = rules?.examples ?? [];
  const itemComments = items.filter((item) => item.channel === "comment");
  const inStep =
    itemComments.length === plain.length &&
    itemComments.every((item, i) => exampleKey(item.text) === exampleKey(plain[i]!));
  if (inStep) return [...items];
  return [
    ...plain.map((text) => {
      const known = itemComments.find((item) => exampleKey(item.text) === exampleKey(text));
      return known ? { ...known, text } : plainExample(text);
    }),
    ...items.filter((item) => item.channel !== "comment"),
  ];
}

/** The two fields a voice keeps its examples in, from one list of them. */
export function examplesFields(examples: readonly VoiceExample[]): Pick<StyleRules, "examples" | "exampleItems"> {
  const comments = examples.filter((example) => example.channel === "comment").map((example) => example.text);
  return {
    examples: comments.length > 0 ? comments : null,
    exampleItems: examples.length > 0 ? [...examples] : null,
  };
}

/** One channel's own examples: the pinned first, then the rest, each newest
 *  first. */
export function channelExamples(rules: ExampleRules, channel: ExampleChannel): VoiceExample[] {
  const own = voiceExamples(rules).filter((example) => example.channel === channel);
  return [...own.filter((example) => example.pinned), ...own.filter((example) => !example.pinned)];
}

/** The words of one channel's own examples, in the order a draft sees them. */
export function exampleTexts(rules: ExampleRules, channel: ExampleChannel): string[] {
  return channelExamples(rules, channel).map((example) => example.text);
}

/** What a draft on one channel is shown first: its own examples, else
 *  Comment's. */
export function draftExamples(rules: ExampleRules, channel: ExampleChannel): string[] {
  const own = exampleTexts(rules, channel);
  return own.length > 0 || channel === "comment" ? own : exampleTexts(rules, "comment");
}
