import { and, eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { audienceThemes } from "@engager/database/schema";
import { afterCommit, type Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import { enqueueRecompileForCampaigns } from "../brain/compile";
import { listKnowledge, storeKnowledge } from "../brain/knowledge";
import { syncVaultMirror, vaultReplicaEnabled } from "../brain/mirror";
import { lockBrainMutation } from "../brain/mutationLock";
import { lockRoomEvidence } from "../rooms/eligibility";
import { currentThemes } from "./themes";

export class ThemeKeepError extends AppError {
  constructor(message: string) { super("audience_theme_not_kept", message, 409); }
}

/** The explicit owner press saves the current retained words, never a body
 * supplied by the browser. Room erasure and Brain writes share their existing
 * fences; a second press returns the first keep without recreating a note. */
export async function keepAudienceTheme(tx: Tx, input: {
  campaignId: number; themeId: string; rolledUpAt: number;
}, now = Date.now()) {
  await lockRoomEvidence(tx);
  const [stored] = await tx.select().from(audienceThemes).where(and(
    eq(audienceThemes.id, input.themeId), eq(audienceThemes.campaignId, input.campaignId),
  )).for("update");
  if (!stored) throw new ThemeKeepError("That theme is no longer available.");
  if (stored.keptAt !== null) return { keptAt: stored.keptAt, knowledgeId: stored.keptKnowledgeId };
  const theme = (await currentThemes(tx, input.campaignId, now)).find((row) => row.id === input.themeId);
  if (!theme || theme.rolledUpAt !== input.rolledUpAt) {
    throw new ThemeKeepError("The theme or its sources changed. Reopen it before keeping it.");
  }
  await lockBrainMutation(tx);
  const content = [theme.text, ...theme.phrases].join("\n\n").trim();
  const result = await storeKnowledge(tx, { slot: "audience", title: theme.text, content,
    source: "learned", sourcePath: `campaign/${input.campaignId}/theme/${theme.id}` });
  // A content duplicate keeps its original source and identity. It is not
  // retagged or overwritten merely because another room says the same thing.
  const knowledgeId = result.changedIds[0] ?? (await listKnowledge(tx)).find((note) => note.content.trim() === content)?.id;
  if (knowledgeId === undefined) throw new ThemeKeepError("The Brain note could not be found. Try keeping the theme again.");
  if (result.changed) await enqueueRecompileForCampaigns(tx);
  if (result.changed && vaultReplicaEnabled()) await syncVaultMirror(tx);
  await tx.update(audienceThemes).set({ keptAt: now, keptKnowledgeId: knowledgeId })
    .where(eq(audienceThemes.id, theme.id));
  afterCommit(tx, () => track("audience_theme_kept", { kind: theme.kind }));
  return { keptAt: now, knowledgeId };
}
