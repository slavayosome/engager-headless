import { and, count, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { audienceRevisions, campaigns, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { routeCompile } from "../operations/compileRouting";
import { audienceInstruction, audiencePainSchema, audienceProfile, audienceProfileInputSchema, editableAudience, mergeAudienceProposals, painDecisionReason, sameAudience, type AudienceProfileInput } from "./model";

type Revision = typeof audienceRevisions.$inferInsert;
export type AudienceWriteMeta = {
  reason?: Revision["reason"];
  changedBy?: string;
  restoredFrom?: number;
  otherEdits?: boolean;
};
export class AudienceConflict extends Error {
  readonly code = "stale";
  constructor() { super("This audience changed since you opened it. Reload to see the new version; your edits are still here."); }
}
export class AudienceNotFound extends Error {
  readonly code = "not_found";
  constructor() { super("That campaign no longer exists."); }
}
export class InvalidAudience extends AppError {
  constructor(message: string) { super("invalid_audience", message, 400); }
}

/** The campaign row is already locked. Only new learning proposals may merge
 *  over the owner's base; any intervening owner edit requires a fresh read. */
export async function audienceRevisionPatch(tx: Tx, campaign: Campaign, input: AudienceProfileInput, baseRevision: number | undefined, meta: AudienceWriteMeta, now: number) {
  if (baseRevision === undefined || !Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new AudienceConflict();
  if (campaign.audienceRevision !== baseRevision) {
    if (meta.reason === "chat_proposal") throw new AudienceConflict();
    const intervening = await tx.select({ reason: audienceRevisions.reason }).from(audienceRevisions)
      .where(and(eq(audienceRevisions.campaignId, campaign.id), gt(audienceRevisions.revision, baseRevision)));
    if (baseRevision > campaign.audienceRevision || !intervening.length || intervening.some((row) => row.reason !== "learned")) throw new AudienceConflict();
  }
  return audiencePatch(tx, campaign, meta.reason === "chat_proposal" ? input : mergeAudienceProposals(input, editableAudience(audienceProfile(campaign))), meta, now);
}

/** Caller holds the campaign row lock. Every writer commits facts, projection
 *  and provenance together; the next compiled brief starts from those facts. */
export async function audiencePatch(
  tx: Tx,
  campaign: Campaign,
  nextInput: AudienceProfileInput,
  source: "settings" | "compatibility" | AudienceWriteMeta,
  now: number,
) {
  const meta: AudienceWriteMeta = typeof source === "object" ? source
    : { reason: source === "settings" ? "owner_edit" : "agent", changedBy: source === "settings" ? "owner" : "agent" };
  const before = audienceProfile(campaign);
  const erased = before.pains.filter((pain) => pain.evidencePurgedAt !== undefined && pain.seenInRooms === 0 &&
    !nextInput.pains.some((next) => next.id === pain.id || next.themeId === pain.themeId));
  const next = audienceProfileInputSchema.parse({ ...nextInput, pains: [...nextInput.pains, ...erased] });
  if (meta.restoredFrom === undefined && sameAudience(editableAudience(before), next)) return {};
  let restoredProfile: typeof before | undefined;
  if (meta.restoredFrom !== undefined) {
    if (!Number.isSafeInteger(meta.restoredFrom) || meta.restoredFrom < 0) throw new InvalidAudience("That audience revision no longer exists.");
    const [restored] = await tx.select({ profile: audienceRevisions.profile }).from(audienceRevisions)
      .where(and(eq(audienceRevisions.campaignId, campaign.id), eq(audienceRevisions.revision, meta.restoredFrom)));
    if (!restored) throw new InvalidAudience("That audience revision no longer exists.");
    restoredProfile = restored.profile;
  }
  const instruction = audienceInstruction(next);
  if ((instruction.length > 16000 && instruction !== audienceInstruction(before)) ||
      ((next.ownerRule?.length ?? 0) > 16000 && next.ownerRule !== before.ownerRule)) {
    throw new InvalidAudience("The audience rule is too long. Shorten it to 16,000 characters; no constraints have been removed.");
  }
  if (meta.reason !== "learned") {
    for (const pain of next.pains) {
      const samePain = (previous: typeof pain) => previous.id === pain.id || (pain.themeId !== undefined && previous.themeId === pain.themeId);
      const previous = before.pains.find(samePain) ?? restoredProfile?.pains.find(samePain);
      if (pain.themeId !== undefined && previous?.themeId === pain.themeId && pain.id !== previous.id) {
        throw new InvalidAudience("Keep the existing identity of a pain learned from this theme.");
      }
      if (pain.evidencePurgedAt !== previous?.evidencePurgedAt) throw new AudienceConflict();
      if (previous?.evidencePurgedAt !== undefined &&
          (pain.themeId !== previous.themeId || pain.seenInRooms !== previous.seenInRooms)) throw new AudienceConflict();
    }
    for (const pain of next.pains.filter((p) => p.status === "proposed")) {
      const previous = restoredProfile?.pains.find((p) => p.id === pain.id) ?? before.pains.find((p) => p.id === pain.id);
      if (!previous || JSON.stringify(audiencePainSchema.parse(previous)) !== JSON.stringify(pain)) {
        throw new InvalidAudience("Only Research can propose a learned pain. Keep it before editing it.");
      }
    }
  }
  if (meta.reason === "agent" && next.pains.some((pain) => pain.status === "active" &&
      before.pains.some((previous) => previous.id === pain.id && previous.status === "proposed"))) {
    throw new InvalidAudience("Keep a proposed pain in the campaign's Strategy before it can affect matching.");
  }
  if (!campaign.audienceProfile) {
    await tx.insert(audienceRevisions).values({
      campaignId: campaign.id, revision: campaign.audienceRevision,
      profile: before, reason: "migrated", summary: "Preserved the original relevance rule",
      changedBy: "migration", createdAt: now,
    }).onConflictDoNothing();
  }
  const revision = campaign.audienceRevision + 1;
  const profile = { ...next, revision, updatedAt: now };
  const requestedReason = meta.reason ?? "owner_edit";
  const reason = meta.restoredFrom !== undefined ? "restored"
    : requestedReason === "owner_edit" && !meta.otherEdits ? painDecisionReason(editableAudience(before), next) : requestedReason;
  const summary = meta.restoredFrom !== undefined ? `restored revision ${meta.restoredFrom}`
    : reason === "learned" ? "Proposed a pain from the rooms"
    : reason === "pain_kept" ? "Kept a pain from the rooms"
    : reason === "pain_dismissed" ? "Dismissed a proposed pain"
    : before.testSource !== next.testSource ? (next.testSource === "derived" ? "Switched to structured audience" : "Switched to a custom relevance test")
    : sameAudience({ ...editableAudience(before), where: next.where }, next) ? "Changed where they are"
    : "Updated who this campaign looks for";
  await tx.insert(audienceRevisions).values({
    campaignId: campaign.id, revision, profile, reason, summary,
    changedBy: meta.changedBy ?? "owner", restoredFrom: meta.restoredFrom ?? null, createdAt: now,
  });
  return {
    audienceProfile: profile, audienceRevision: revision,
    aiFilter: { ...(campaign.aiFilter ?? {}), instruction },
    compiledBrief: null,
  };
}

export async function saveAudience(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  input: { baseRevision: number; profile: unknown },
  now = Date.now(),
  meta: AudienceWriteMeta = {},
): Promise<{ revision: number }> {
  const parsed = audienceProfileInputSchema.parse(input.profile);
  const [campaign] = await tx.select().from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt))).for("update");
  if (!campaign) throw new AudienceNotFound();
  const patch = await audienceRevisionPatch(tx, campaign, parsed, input.baseRevision, meta, now);
  if (patch.audienceRevision === undefined) return { revision: campaign.audienceRevision };
  await tx.update(campaigns).set({
    audienceProfile: patch.audienceProfile, audienceRevision: patch.audienceRevision,
    aiFilter: patch.aiFilter, compiledBrief: patch.compiledBrief, updatedAt: now,
  }).where(eq(campaigns.id, campaignId));
  try {
    await tx.transaction((sp) => routeCompile(sp, organizationId, { kind: "campaign", campaignId }));
  } catch (error) {
    console.error("[audience] brief compile not routed", { campaignId, error: error instanceof Error ? error.message : String(error) });
  }
  return { revision: patch.audienceRevision };
}

export async function initializeAudience(tx: Tx, campaign: Campaign, input: AudienceProfileInput | undefined, now: number, reason: "created" | "migrated" = "created", copied = false) {
  if (campaign.audienceProfile) return;
  const facts = input ? audienceProfileInputSchema.parse(input) : editableAudience(audienceProfile(campaign));
  if (input && !copied && facts.pains.some((pain) => pain.status === "proposed")) throw new InvalidAudience("New campaigns cannot start with learned proposals.");
  const instruction = audienceInstruction(facts);
  if (input && instruction.length > 16000) throw new InvalidAudience("The audience rule exceeds 16,000 characters.");
  const profile = { ...facts, revision: 1, updatedAt: now };
  await tx.update(campaigns).set({
    audienceProfile: profile, audienceRevision: 1,
    aiFilter: { ...(campaign.aiFilter ?? {}), instruction },
  }).where(eq(campaigns.id, campaign.id));
  await tx.insert(audienceRevisions).values({
    campaignId: campaign.id, revision: 1, profile, reason,
    summary: reason === "created" ? "Created audience" : "Preserved the original relevance rule",
    changedBy: reason === "created" ? "owner" : "migration", createdAt: now,
  });
}

/** Learning adds inactive proposals without a relevance revision, projection
 * or compile. The caller has grounded them in current themes. Existing pain
 * identities, including retired ones, cannot be proposed again. */
export async function setProposedPains(tx: Tx, campaignId: number, proposals: AudienceProfileInput["pains"], now = Date.now()) {
  const parsed = proposals.map((pain) => audiencePainSchema.parse(pain));
  if (parsed.some((pain) => pain.source !== "learned" || pain.status !== "proposed" || !pain.themeId || !pain.seenInRooms || pain.evidencePurgedAt !== undefined)) {
    throw new InvalidAudience("A learning proposal needs a grounded theme and cannot be active.");
  }
  const [campaign] = await tx.select().from(campaigns).where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt))).for("update");
  if (!campaign) throw new AudienceNotFound();
  if (!campaign.audienceProfile) throw new InvalidAudience("Save this campaign's Audience before adding learned pains.");
  const before = audienceProfile(campaign);
  const ids = new Set(before.pains.map((pain) => pain.id));
  const themes = new Set(before.pains.flatMap((pain) => pain.themeId ? [pain.themeId] : []));
  const available = Math.max(0, 12 - before.pains.filter((pain) => pain.status !== "retired").length);
  const added = parsed.filter((pain) => {
    if (ids.has(pain.id) || themes.has(pain.themeId!)) return false;
    ids.add(pain.id); themes.add(pain.themeId!); return true;
  }).slice(0, available);
  if (!added.length) return [];
  const next = audienceProfileInputSchema.parse({ ...editableAudience(before), pains: [...before.pains, ...added] });
  const profile = { ...next, revision: campaign.audienceRevision, updatedAt: Math.max(now, before.updatedAt + 1) };
  await tx.update(campaigns).set({ audienceProfile: profile, updatedAt: now }).where(eq(campaigns.id, campaignId));
  return added;
}

/** Room erasure also reaches inactive copies in Audience history. An owner
 * who already kept a pain has made it their own targeting fact. Otherwise
 * only a minimal retired identity survives the last source, preventing a
 * dismissed theme from being proposed again or restored from an old form.
 * Caller holds the room-evidence lock before we take the campaign lock. */
export async function purgeUnkeptThemePain(tx: Tx, campaignId: number, themeId: string, rooms: number, now: number) {
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).for("update");
  if (!campaign) return;
  const isKept = (pain: AudienceProfileInput["pains"][number]) => pain.themeId === themeId && pain.status === "active";
  if (campaign.audienceProfile?.pains.some(isKept)) return;
  const [kept] = await tx.select({ revision: audienceRevisions.revision }).from(audienceRevisions)
    .where(and(eq(audienceRevisions.campaignId, campaignId), sql`exists (
      select 1 from jsonb_array_elements(${audienceRevisions.profile} -> 'pains') pain
      where pain ->> 'themeId' = ${themeId} and pain ->> 'status' = 'active'
    )`)).limit(1);
  if (kept) return;
  const scrub = (profile: NonNullable<Campaign["audienceProfile"]>) => {
    if (!profile.pains.some((pain) => pain.themeId === themeId)) return null;
    return { ...profile, updatedAt: Math.max(now, profile.updatedAt + 1), pains: profile.pains.map((pain) =>
      pain.themeId !== themeId ? pain : { ...pain, phrases: [], seenInRooms: rooms, evidencePurgedAt: now,
        ...(rooms === 0 ? { text: "Evidence no longer retained", status: "retired" as const } : {}) }) };
  };
  const profile = campaign.audienceProfile && scrub(campaign.audienceProfile);
  if (profile) await tx.update(campaigns).set({ audienceProfile: profile, updatedAt: now }).where(eq(campaigns.id, campaignId));
  let afterRevision = -1;
  while (true) {
    const batch = await tx.select().from(audienceRevisions)
      .where(and(eq(audienceRevisions.campaignId, campaignId), gt(audienceRevisions.revision, afterRevision)))
      .orderBy(audienceRevisions.revision).limit(100);
    if (!batch.length) break;
    for (const revision of batch) {
      const historical = scrub(revision.profile);
      if (historical) await tx.update(audienceRevisions).set({ profile: historical })
        .where(and(eq(audienceRevisions.campaignId, campaignId), eq(audienceRevisions.revision, revision.revision)));
    }
    afterRevision = batch.at(-1)!.revision;
  }
}

/** Idempotent, tenant-scoped backfill for existing installs. Never called by a read. */
export async function moveAudienceToProfiles(tx: Tx, now = Date.now()) {
  const legacy = await tx.select().from(campaigns).where(isNull(campaigns.audienceProfile)).for("update");
  for (const campaign of legacy) await initializeAudience(tx, campaign, undefined, now, "migrated");
  return legacy.length;
}

export function audienceHistory(tx: Tx, campaignId: number, beforeRevision?: number, limit = 20) {
  return tx.select().from(audienceRevisions).where(and(
    eq(audienceRevisions.campaignId, campaignId),
    beforeRevision === undefined ? undefined : lt(audienceRevisions.revision, beforeRevision),
  )).orderBy(desc(audienceRevisions.revision)).limit(limit);
}

export async function audienceHistoryCount(tx: Tx, campaignId: number) {
  const [row] = await tx.select({ count: count() }).from(audienceRevisions).where(eq(audienceRevisions.campaignId, campaignId));
  return row?.count ?? 0;
}
