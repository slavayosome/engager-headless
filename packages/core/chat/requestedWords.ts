import type { z } from "zod";
import type { LLM } from "../ai/client";
import { writeConversationWords, type ConversationWordsInput } from "../dispatcher/conversationWords";
import {
  BOX_MOVES,
  boxWords,
  boxWordsSchema,
  ownerAskOf,
  planAngle,
  type BoxWords,
  type ComposerAsk,
} from "./requestedDraft";

/**
 * WORDS FOR A REPLY, A DM OR AN INVITE'S NOTE THE OWNER IS WRITING — the box's
 * Draft for me. The dispatcher plans, writes and judges them on their own
 * surface through the owner's own agent (`judgeLLM`), as it does a comment's
 * (`requestedComment.ts`), and the words go back to the box as the turn's last
 * text: raw material, written nowhere. A claim the conversation and the
 * owner's facts do not support keeps them from going out as they stand:
 * refused at the press once the model's judge reads them after they land, or
 * withheld before they land where no campaign keeps their attempt. Any other
 * miss goes on as a note, never a dead end.
 */
export async function runSpokenWords(deps: {
  organizationId: string;
  llm: LLM;
  /** What the words are for: the conversation, the rules, what a claim may rest on. */
  input: Omit<ConversationWordsInput, "organizationId" | "llm" | "ask" | "ownerRequested" | "planOnly" | "continueRun">;
  /** The box's answer format. */
  text: z.ZodObject<{ text: z.ZodString }, "strict">;
  progress: (text: string) => void;
  active?: () => Promise<void>;
  ask?: ComposerAsk;
}): Promise<BoxWords> {
  const { ask } = deps;
  const asked = ownerAskOf(ask);
  const input: ConversationWordsInput = {
    ...deps.input,
    organizationId: deps.organizationId,
    llm: deps.llm,
    ownerRequested: true,
    ...(asked ? { ask: asked } : {}),
    ...(deps.active ? { continueRun: async () => (await deps.active!(), true) } : {}),
  };
  const schema = boxWordsSchema(deps.text, ask, BOX_MOVES);
  deps.progress(ask?.kind === "idea" ? "Finding a new way in…" : "Writing your words…");
  if (ask?.kind === "idea") {
    const planned = await writeConversationWords({ ...input, planOnly: true });
    if (planned === null) throw new Error("draft_stopped");
    return boxWords(schema.parse(planAngle(planned.plan, BOX_MOVES)));
  }
  const words = await writeConversationWords(input);
  if (words === null) throw new Error("draft_stopped");
  return boxWords(schema.parse({ text: words.text, ...(ask?.kind === "more" ? planAngle(words.plan, BOX_MOVES) : {}) }));
}
