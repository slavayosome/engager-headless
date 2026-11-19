import { eq } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { campaigns } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { boxKey, openComposerBox } from "../composer/drafts";
import { leadOpener } from "../leads/scout/opener";
import { writeLeadBoxWords } from "../leads/scout/openerDrafts";
import { COMMENT_LENGTH_LIMIT } from "../commentLength";
import {
  OPENER_MOVES,
  boxWords,
  boxWordsSchema,
  ownerAskOf,
  planAngle,
  type BoxWords,
  type ComposerAsk,
  type RequestedLeadWords,
} from "./requestedDraft";

/**
 * WORDS FOR AN OPENER THE OWNER IS WRITING — the Leads composer's Draft with
 * agent and Redraft, in the box of someone Find leads found. Their own agent,
 * in the chat dock, writes one opener from that person's own words, held to
 * the row their intent reads (`leads/scout/opener.ts`), and the words go back
 * to the box as the turn's last text: raw material, written nowhere. What goes
 * out is only what the owner queues, measured there for how much of these
 * words it kept.
 *
 * The dispatcher writes it as it writes a run's openers
 * (`leads/scout/openerDrafts.ts`), checked against the owner's documented
 * facts. A claim no source supports gets one rewrite that drops it; only an
 * opener still unsupported after that is held, before any words return. An
 * opener that breaks its row, or could go to anyone, still lands in the field,
 * and the box says so under it (`leadBoxNotes`).
 */

export const RequestedLeadText = z.object({ text: z.string().trim().min(1).max(COMMENT_LENGTH_LIMIT) }).strict();

/** The person to word an opener for, in the owner's own box; refused where
 *  the box takes no words — nobody Engager found, someone already reached,
 *  or someone the owner put out of reach. Nothing is filed. */
export async function prepareLeadWords(tx: Tx, request: RequestedLeadWords) {
  if (request.signalId === undefined) {
    throw new AppError("lead_source_required", "Reopen this source and ask for its draft again.", 409);
  }
  const box = await openComposerBox(tx, boxKey({ kind: "lead", leadId: request.leadId, signalId: request.signalId }));
  const [campaign] = box.campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, box.campaignId));
  if (!campaign || !(await leadOpener(tx, request.leadId, Date.now(), request.signalId))) throw new Error("lead_request_closed");
  return { campaign, leadId: request.leadId, signalId: request.signalId };
}

/**
 * The owner's-box workflow for an opener: read the person, have the dispatcher
 * plan, write and judge one opener on its surface through the owner's agent,
 * and hand the words back as the turn's last text. Only a claim the sources do
 * not support holds it back, after one rewrite; style and relevance remain the
 * box's notes. An angle the composer asked for (`ask`) is written through its
 * own line, or, for a new one, through none.
 */
export async function runLeadWords(deps: {
  organizationId: string;
  request: RequestedLeadWords;
  llm: LLM;
  progress: (text: string) => void;
  active?: () => Promise<void>;
  ask?: ComposerAsk;
}): Promise<BoxWords> {
  const { ask } = deps;
  deps.progress("Reading their words and your voice…");
  await deps.active?.();
  const { campaign, leadId, signalId } = await withOrg(deps.organizationId, (tx) => prepareLeadWords(tx, deps.request));
  deps.progress(ask?.kind === "idea" ? "Finding a new way in…" : "Writing your opener…");
  const asked = ownerAskOf(ask);
  const schema = boxWordsSchema(RequestedLeadText, ask, OPENER_MOVES);
  const written = await writeLeadBoxWords({
    organizationId: deps.organizationId,
    campaign,
    llm: deps.llm,
    leadId,
    signalId,
    now: Date.now(),
    ...(asked ? { ask: asked } : {}),
    ...(ask?.kind === "idea" ? { planOnly: true } : {}),
    ...(deps.active ? { continueRun: async () => (await deps.active!(), true) } : {}),
  });
  if (written === null) throw new Error("lead_request_closed");
  const named = ask?.kind === "more" || ask?.kind === "idea" ? planAngle(written.plan, OPENER_MOVES) : {};
  return boxWords(schema.parse(written.text === null ? named : { text: written.text, ...named }));
}
