import { z } from "zod";
import type { LLM } from "../ai/client";
import { writeConversationWords } from "../dispatcher/conversationWords";
import type { getRoomReplyContext } from "../rooms/replyDrafting";
import { BOX_MOVES, boxWords, boxWordsSchema, ownerAskOf, planAngle, type BoxWords, type ComposerAsk, type WrittenWords } from "./requestedDraft";

type Context = Awaited<ReturnType<typeof getRoomReplyContext>>;

/** What a reply under their comment, or a note to them, is told besides the
 *  owner's rules. */
const RULES = {
  reply: [
    "You and your mean the person whose comment you answer, never the post author or anyone else in the thread.",
    "Make no claim about them that their own comment does not make: the post opening and the room's insights are context, not facts about them.",
    "Name whose statement you refer to if you use another comment.",
  ],
  invite_note: [
    "Refer to what they said in their comment without inventing familiarity, a prior exchange or facts about them.",
    "This is an invitation note, not a public reply.",
  ],
};

/**
 * The owner's-box workflow for a room box: read their comment, have the
 * dispatcher plan, write and judge one reply, or one invitation note, through
 * the owner's own agent, and hand the words back to be delivered into the box.
 * A Stop or a new request while the writer runs prevents another model call,
 * not merely the delivery. Only a claim their comment and the owner's facts do
 * not establish holds the words back, after one rewrite; any other miss goes
 * on as a note.
 */
export async function runRoomReplyWords(deps: {
  organizationId: string;
  llm: LLM;
  prepare: () => Promise<Context>;
  /** Delivers the words against the request they answer; `note` is a miss the
   *  judge let go on. */
  submit: (context: Context, words: WrittenWords, note: string | null) => Promise<{ text: string; note?: string }>;
  progress: (text: string) => void;
  active?: () => Promise<void>;
  ask?: ComposerAsk;
}): Promise<BoxWords> {
  deps.progress("Reading their comment and your voice…");
  const prepared = await deps.prepare();
  const { ask } = deps;
  const { context, request } = prepared;
  const plain = z.object({ text: z.string().trim().min(1).max(context.maxCharacters) }).strict();
  const schema = boxWordsSchema(plain, ask, BOX_MOVES);
  if (prepared.text !== null && ask?.kind !== "idea") return boxWords({ text: prepared.text });
  // The request moving on stops the work before the next model call.
  const unchanged = async (): Promise<boolean> => {
    await deps.active?.();
    const current = await deps.prepare();
    if (current.contextRevision !== prepared.contextRevision) throw new Error("room_draft_request_changed");
    return current.text === null;
  };
  deps.progress(ask?.kind === "idea" ? "Looking for another way into their comment…" : request.deliverable === "reply" ? "Drafting your reply to them…" : "Drafting your invitation note…");
  const asked = ownerAskOf(ask);
  const input = {
    organizationId: deps.organizationId,
    campaign: prepared.campaign,
    llm: deps.llm,
    surface: request.deliverable === "reply" ? ("room_reply" as const) : ("invitation" as const),
    conversation: {
      post: { discoveredPostId: null, authorName: context.recipient.name, postedAt: null, text: context.recipient.comment, mediaText: null },
      turns: context.post.opening ? [{ speaker: "other" as const, name: context.post.authorName ?? null, text: context.post.opening }] : [],
    },
    query: context.recipient.comment,
    headline: context.recipient.headline,
    products: context.ownerFacts.products,
    room: prepared.evidence.room,
    step: context.stepInstructions,
    rules: RULES[request.deliverable],
    firstTouch: true,
    maxChars: context.maxCharacters,
    ownerRequested: true,
    ...(asked ? { ask: asked } : {}),
    continueRun: unchanged,
  };
  if (ask?.kind === "idea") {
    const planned = await writeConversationWords({ ...input, planOnly: true });
    if (planned === null) throw new Error("room_draft_request_changed");
    return boxWords(schema.parse(planAngle(planned.plan, BOX_MOVES)));
  }
  const words = await writeConversationWords(input);
  if (words === null) throw new Error("room_draft_request_changed");
  if (!(await unchanged())) return boxWords({ text: (await deps.prepare()).text! });
  const written = boxWords(schema.parse({ text: words.text, ...(ask?.kind === "more" ? planAngle(words.plan, BOX_MOVES) : {}) }));
  return { ...written, text: (await deps.submit(prepared, written as WrittenWords, words.note)).text };
}
