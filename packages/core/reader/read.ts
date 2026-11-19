import type { z } from "zod";
import { LLMOutputError, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import type { AgentPage, AgentReadIntent } from "../linkedin/driver";
import { CommentRepliesAnswer, DmThreadAnswer, InboxAnswer } from "./answers";
import { readerSystem, readerUser } from "./prompt";
import { threadIdOf } from "./representation";
import {
  verifyCommentReplies,
  verifyDmThread,
  verifyInbox,
  type VerifiedDmThread,
  type VerifiedInbox,
  type VerifiedReplies,
} from "./verify";

/**
 * THE AGENT READER: an agent reads, code writes.
 *
 * The connector's structured reads parse LinkedIn's markup, and a redesign
 * that moves it reads as nothing (2026-10-12: every reply under our comments
 * read as none). Where one finds nothing or drifts, its caller loads the same
 * page as words and anchors (`readPageForAgent`), and this module hands it to
 * the owner's own model through `LLM.json()` — the agent CLI, or the API
 * backend where configured — with one strict schema per intent, then checks
 * the answer against the page (`verify.ts`). What survives is a read like the
 * connector's own, recorded the way the connector's is.
 *
 * Only reads. Posting, liking, inviting and sending stay deterministic,
 * journalled and exactly-once, and a model answer is never completion
 * evidence for any of them (INV-2/INV-3).
 *
 * The model call holds no transaction. Its usage is recorded under the stage
 * `agent_reader`, so `get_status` counts the reader's calls on their own.
 */

/** Why an agent read yielded nothing to record. */
export type ReaderMiss =
  /** The answer did not fit its schema: nothing is recorded. */
  | { status: "malformed" }
  /** The model call itself failed. */
  | { status: "failed"; reason: string };

type Asked<T> = { status: "answered"; answer: T } | ReaderMiss;

async function ask<T>(
  llm: LLM,
  intent: AgentReadIntent,
  schema: z.ZodType<T>,
  page: AgentPage,
  context: { commentUrn?: string; threadId?: string },
): Promise<Asked<T>> {
  let raw: unknown;
  try {
    raw = await llm.json({
      model: modelFor("filter"),
      stage: "agent_reader",
      promptRef: promptRef("reader.page"),
      system: readerSystem(intent),
      user: readerUser(page, context),
      schema,
      strict: true,
      maxTokens: 4_096,
    });
  } catch (error) {
    if (error instanceof LLMOutputError) return { status: "malformed" };
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  // The client validates too; a reader that records nothing on a bad shape
  // does not take that on trust.
  const parsed = schema.safeParse(raw);
  return parsed.success ? { status: "answered", answer: parsed.data } : { status: "malformed" };
}

/** The replies under our comment on its post's page, and the counts it shows. */
export async function readCommentRepliesByAgent(
  llm: LLM,
  page: AgentPage,
  watched: { commentUrn: string },
): Promise<VerifiedReplies | ReaderMiss> {
  const asked = await ask(llm, "comment_replies", CommentRepliesAnswer, page, {
    commentUrn: watched.commentUrn,
  });
  return asked.status === "answered" ? verifyCommentReplies(page, asked.answer, watched) : asked;
}

/** The conversations the inbox lists that the page can name. */
export async function readInboxByAgent(
  llm: LLM,
  page: AgentPage,
): Promise<({ status: "verified" } & VerifiedInbox) | ReaderMiss> {
  const open = threadIdOf(page.url);
  const asked = await ask(llm, "inbox", InboxAnswer, page, open ? { threadId: open } : {});
  return asked.status === "answered" ? { status: "verified", ...verifyInbox(page, asked.answer) } : asked;
}

/** One conversation: who is in it, and its messages. */
export async function readDmThreadByAgent(
  llm: LLM,
  page: AgentPage,
  threadId: string,
): Promise<VerifiedDmThread | ReaderMiss> {
  const asked = await ask(llm, "dm_thread", DmThreadAnswer, page, { threadId });
  return asked.status === "answered" ? verifyDmThread(page, asked.answer, threadId) : asked;
}
