import { z } from "zod";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { untrusted } from "../ai/prompts";
import type { RetrievedKnowledge } from "./knowledge";

/**
 * FACT SELECTION — the "intelligent" half of retrieval. Cosine top-k over the org-wide
 * Brain surfaces rows that are merely NEARBY the post (and with no embedder it falls back
 * to recency), so the writer gets 1-2 facts that often don't actually fit → it drops them
 * and asks a generic question instead. This reranks a WIDER candidate set with one cheap
 * Haiku call, picking only the facts that genuinely add substance to a comment on THIS
 * post. It is honest about "none fit" (empty picks), so it never forces an off-topic fact.
 *
 * `avoid`-slot rows are hard constraints, never "facts to draw on" — they are passed
 * through untouched and never sent to the model for selection.
 */

const PickSchema = z.object({
  // Indices (into the numbered candidate list) of the facts worth drawing on for THIS
  // comment, best first. Fewer is fine; an EMPTY list is valid when none genuinely fit —
  // a comment grounded in nothing beats one grounded in an irrelevant fact.
  picks: z.array(z.number().int()),
});

const SYSTEM = `You do FACT SELECTION for one LinkedIn comment. Given a post and a numbered list of things the comment author knows or believes, pick ONLY the facts that would genuinely strengthen a reply to THIS specific post — a concrete detail, a lived experience, a number, or a pointed stance that speaks to what the post is actually about.

Rules:
- Relevance over similarity: a fact that merely shares a keyword is NOT useful. Pick a fact only if a real person would naturally reach for it replying here.
- Prefer specific, concrete facts over generic ones.
- Pick at most the number asked for, best first.
- If nothing genuinely fits, return an EMPTY list. A comment grounded in nothing is better than one grounded in an off-topic fact.
Return only the indices.`;

/**
 * Rerank retrieved Brain knowledge for a post/comment. Returns the `avoid` rows first
 * (unchanged), then the reranked pick of non-avoid facts, capped at `finalK`.
 *
 * Cost-bounded: when there are `finalK` or fewer non-avoid candidates there is nothing to
 * choose, so it returns them WITHOUT an LLM call. Best-effort: any LLM/parse failure (or
 * an all-invalid pick set) falls back to the incoming top-k order, so a broken reranker
 * degrades to today's behavior rather than dropping facts.
 */
export async function rerankKnowledgeForComment(opts: {
  postText: string;
  rows: RetrievedKnowledge[];
  finalK: number;
  llm?: LLM | null;
}): Promise<RetrievedKnowledge[]> {
  const avoid = opts.rows.filter((r) => r.slot === "avoid");
  const rest = opts.rows.filter((r) => r.slot !== "avoid");
  // Nothing to choose from → no LLM call.
  if (rest.length <= opts.finalK) return opts.rows;

  if (opts.llm === null) return [...avoid, ...rest.slice(0, opts.finalK)];
  const llm = opts.llm ?? getLLM();
  const numbered = rest.map((r, i) => `${i}. ${r.content}`).join("\n");
  let picks: number[] = [];
  try {
    const out = await llm.json({
      model: modelFor("filter"),
      stage: "fact_select",
      promptRef: promptRef("brain.rerank"),
      system: SYSTEM,
      user:
        untrusted("POST", opts.postText) +
        `\n\nCANDIDATE FACTS (pick the best ${opts.finalK} by index, or none):\n${numbered}`,
      schema: PickSchema,
      maxTokens: 100,
    });
    picks = out.picks;
  } catch {
    picks = []; // fall through to the top-k fallback below
  }

  const seen = new Set<number>();
  const picked: RetrievedKnowledge[] = [];
  for (const idx of picks) {
    if (idx >= 0 && idx < rest.length && !seen.has(idx)) {
      seen.add(idx);
      picked.push(rest[idx]!);
      if (picked.length >= opts.finalK) break;
    }
  }
  // The model can legitimately pick NONE. But we can't distinguish "deliberately none"
  // from "call failed" here, so on an empty pick we keep the pre-rerank top-k (never
  // MORE off-topic than today). A confident empty-select is a future refinement.
  const chosen = picked.length > 0 ? picked : rest.slice(0, opts.finalK);
  return [...avoid, ...chosen];
}
