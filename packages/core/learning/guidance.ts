import { eq } from "drizzle-orm";
import { z } from "zod";
import { campaignGuidance } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { getLLM, type LLM } from "../ai/client";
import { enqueueCompileForCampaign } from "../brain/compile";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";

export const MAX_BULLETS = 10;

export function parseBullets(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

export function formatBullets(bullets: string[]): string {
  return bullets
    .slice(0, MAX_BULLETS)
    .map((b) => `- ${b}`)
    .join("\n");
}

export async function getGuidance(tx: Tx, campaignId: number): Promise<string> {
  const [row] = await tx
    .select({ g: campaignGuidance.guidance })
    .from(campaignGuidance)
    .where(eq(campaignGuidance.campaignId, campaignId));
  return row?.g ?? "";
}

export async function setGuidance(
  tx: Tx,
  campaignId: number,
  guidance: string,
  derivedFrom = 0,
): Promise<void> {
  await tx
    .insert(campaignGuidance)
    .values({ campaignId, guidance, derivedFrom, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: campaignGuidance.campaignId,
      set: { guidance, derivedFrom, updatedAt: Date.now() },
    });
  // Guidance is a writing rule: compiled now, so the next draft does not wait.
  await enqueueCompileForCampaign(tx, campaignId);
}

/** Append one rule (deduped, capped at MAX_BULLETS). Used by instant-tune. */
export async function appendGuidance(
  tx: Tx,
  campaignId: number,
  rule: string,
): Promise<boolean> {
  const norm = rule.trim().replace(/^[-*]\s*/, "").trim();
  if (!norm) return false;
  const cur = parseBullets(await getGuidance(tx, campaignId));
  if (cur.some((b) => b.toLowerCase() === norm.toLowerCase())) return false;
  const next = [...cur, norm].slice(-MAX_BULLETS);
  await setGuidance(tx, campaignId, formatBullets(next), next.length);
  return true;
}

const EditRule = z.object({
  /** The distilled rule, or empty when the edit is trivial/cosmetic. */
  rule: z.string(),
  /** register = HOW it's said (wording, casing, punctuation, emoji, length
   *  habits, sign-offs) → accrues to the VOICE. strategy = WHAT is said (topic,
   *  angle, product handling, audience choices) → accrues to the CAMPAIGN. */
  kind: z.enum(["register", "strategy"]),
});

export type DistilledEditRule = { rule: string; kind: "register" | "strategy" };

/**
 * Extract ONE short imperative rule from a human edit, classified by what it
 * governs: `register` (how the text sounds — routes to the campaign's VOICE)
 * vs `strategy` (what the comment says — routes to the campaign's guidance).
 * Returns null when the edit is trivial.
 */
export async function distillRuleFromEdit(opts: {
  original: string;
  edited: string;
  /** null is an explicit no-hosted-cognition boundary (for example, a thin
   * post-cancellation edit). Undefined retains the managed fallback. */
  llm?: LLM | null;
}): Promise<DistilledEditRule | null> {
  if (opts.original.trim() === opts.edited.trim()) return null;
  if (opts.llm === null) return null;
  const llm = opts.llm ?? getLLM();
  let out: z.infer<typeof EditRule>;
  try {
    out = await llm.json({
      model: modelFor("filter"),
      stage: "guidance",
      promptRef: promptRef("learn.guidance"),
      system: `You extract ONE short imperative rule (max 120 chars) describing how a user edited an AI-written LinkedIn comment, so future comments follow it — and CLASSIFY it:
- kind "register": the edit changed HOW it's said — wording, tone, casing, punctuation, emoji, shorthand, length habits, sign-offs.
- kind "strategy": the edit changed WHAT is said — the topic, the angle, product handling, claims, audience-specific content.
If the edit is trivial/cosmetic (typo fixes, whitespace), output rule as an empty string.`,
      user: `ORIGINAL:\n${opts.original}\n\nEDITED (the human's preferred version):\n${opts.edited}`,
      schema: EditRule,
      maxTokens: 100,
    });
  } catch {
    return null; // best-effort — a failed distill never blocks an approve
  }
  const r = out.rule.trim().replace(/^[-*]\s*/, "");
  if (!r || /^none$/i.test(r)) return null;
  return { rule: r.slice(0, 120), kind: out.kind };
}
