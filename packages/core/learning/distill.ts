import { and, desc, eq } from "drizzle-orm";
import { campaignGuidance, feedback, messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { formatBullets, parseBullets } from "./guidance";

const MIN_EVENTS = 3;

const SYSTEM = `You maintain the STRATEGY guidance for one LinkedIn campaign as at most 10 short imperative bullets — WHAT its comments should say (topics, angles, product handling, audience choices, hooks that worked).
You are given the CURRENT guidance and RECENT FEEDBACK (approvals, edits showing the change, rejections with reasons).
Rewrite the guidance bullet list. Rules:
- Only keep or add a rule that is supported by a clear human edit or by >= 3 feedback events.
- Preserve existing rules that still hold; drop ones contradicted by recent feedback.
- STRATEGY only: skip register/wording rules (casing, punctuation, emoji, phrasing habits) — those belong to the account's VOICE, not this list.
- Keep each bullet short and concrete. Max 10 bullets.
Output ONLY the bullets, one per line, each starting with "- ". No preamble.`;

function trunc(s: string | null, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

type DistillationEvent = {
  id: number;
  verdict: "approve" | "edit" | "reject";
  editedText: string | null;
  reasonTags: string[] | null;
  proposed: string;
  final: string | null;
  createdAt: number;
};

export type PreparedCampaignDistillation = {
  campaignId: number;
  events: DistillationEvent[];
  currentGuidance: string;
  guidanceRevision: {
    exists: boolean;
    guidance: string;
    derivedFrom: number;
    updatedAt: number;
  };
  revision: string;
};

async function distillationEvents(
  tx: Tx,
  campaignId: number,
): Promise<DistillationEvent[]> {
  return tx
    .select({
      id: feedback.id,
      verdict: feedback.verdict,
      editedText: feedback.editedText,
      reasonTags: feedback.reasonTags,
      proposed: messages.proposedText,
      final: messages.finalText,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .innerJoin(messages, eq(feedback.messageId, messages.id))
    .where(eq(messages.campaignId, campaignId))
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(50);
}

/** DB-only feedback/guidance snapshot. */
export async function prepareCampaignDistillation(
  tx: Tx,
  campaignId: number,
): Promise<PreparedCampaignDistillation | null> {
  const events = await distillationEvents(tx, campaignId);
  if (events.length < MIN_EVENTS) return null;
  const [guidance] = await tx
    .select()
    .from(campaignGuidance)
    .where(eq(campaignGuidance.campaignId, campaignId));
  if (guidance && !events.some((event) => event.createdAt > guidance.updatedAt)) return null;
  const guidanceRevision = guidance
    ? {
        exists: true,
        guidance: guidance.guidance,
        derivedFrom: guidance.derivedFrom,
        updatedAt: guidance.updatedAt,
      }
    : { exists: false, guidance: "", derivedFrom: 0, updatedAt: 0 };
  return {
    campaignId,
    events,
    currentGuidance: guidance?.guidance ?? "",
    guidanceRevision,
    revision: JSON.stringify({ events, guidance: guidanceRevision }),
  };
}

/** Provider-only rewrite over detached feedback. */
export async function writePreparedCampaignDistillation(
  prepared: PreparedCampaignDistillation,
  llm?: LLM,
): Promise<string | null> {
  const summary = prepared.events
    .map((event) => {
      if (event.verdict === "approve") {
        return `APPROVED: ${trunc(event.final ?? event.proposed, 200)}`;
      }
      if (event.verdict === "edit") {
        return `EDITED from "${trunc(event.proposed, 160)}" to "${trunc(event.editedText, 160)}"`;
      }
      const reason = event.reasonTags?.join(", ") || "no reason";
      return `REJECTED (${reason}): ${trunc(event.proposed, 160)}`;
    })
    .join("\n");
  const out = await (llm ?? getLLM()).text({
    model: modelFor("filter"),
    stage: "distill",
    promptRef: promptRef("learn.distill"),
    system: SYSTEM,
    user: `CURRENT GUIDANCE:\n${prepared.currentGuidance || "(none yet)"}\n\nRECENT FEEDBACK EVENTS:\n${summary}`,
    maxTokens: 400,
  });
  const bullets = parseBullets(out).slice(0, 10);
  return bullets.length > 0 ? formatBullets(bullets) : null;
}

/** CAS apply. Returns false when feedback or guidance changed during cognition. */
export async function applyPreparedCampaignDistillation(
  tx: Tx,
  prepared: PreparedCampaignDistillation,
  guidance: string,
): Promise<boolean> {
  const fresh = await prepareCampaignDistillation(tx, prepared.campaignId);
  if (!fresh || fresh.revision !== prepared.revision) return false;
  const now = Date.now();
  if (!prepared.guidanceRevision.exists) {
    const [inserted] = await tx
      .insert(campaignGuidance)
      .values({
        campaignId: prepared.campaignId,
        guidance,
        derivedFrom: prepared.events.length,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ campaignId: campaignGuidance.campaignId });
    return inserted != null;
  }
  const [updated] = await tx
    .update(campaignGuidance)
    .set({
      guidance,
      derivedFrom: prepared.events.length,
      updatedAt: now,
    })
    .where(
      and(
        eq(campaignGuidance.campaignId, prepared.campaignId),
        eq(campaignGuidance.guidance, prepared.guidanceRevision.guidance),
        eq(campaignGuidance.derivedFrom, prepared.guidanceRevision.derivedFrom),
        eq(campaignGuidance.updatedAt, prepared.guidanceRevision.updatedAt),
      ),
    )
    .returning({ campaignId: campaignGuidance.campaignId });
  return updated != null;
}
