import { and, eq, isNull } from "drizzle-orm";
import { db as baseDb } from "@engager/database";
import {
  authorProfiles,
  incomingComments,
  leads,
  memberships,
  organizations,
  users,
  type Lead,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import {
  leadHotEmail,
  prepareEmailPayload,
  sendPreparedEmail,
} from "@engager/email";
import { getLLM, type LLM } from "../../ai/client";
import { config } from "../../config";
import { leadsEnabled } from "../../leads/gate";
import {
  applyPreparedLeadDm,
  prepareLeadDmDraft,
  writePreparedLeadDm,
} from "../../operations/leads";
import { computeLeadTier, maxTier } from "../../leads/scoring";
import { isGrant, type CapabilitySurface } from "../../connector/resolve";
import type { DriverProfile } from "../../linkedin/driver";
import {
  ConnectorError,
  isConnectorBackoff,
} from "../../linkedin/connectorError";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { reserveProfileCall } from "../../ratelimit/ledger";
import { grantFor } from "../context";
import { RescheduleError } from "../queue";
import {
  claimedJobEmailContext,
  deliverJobEmail,
  resumeJobEmailIfPresent,
} from "../emailDelivery";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
  HostedJobSpendRevokedError,
} from "../spendAccess";
import type { SelfScopedCtx } from "../worker";

/** author_profiles freshness window (matches enrich_authors' TTL). */
const PROFILE_TTL_MS = 21 * 86_400_000;

function spendGuardedLlm(ctx: SelfScopedCtx): LLM {
  const base = ctx.llm ?? getLLM();
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    await assertHostedJobSpendStillAllowed(ctx);
    return operation();
  };
  const searchText = base.searchText?.bind(base);
  return {
    text: (opts) =>
      guarded(() =>
        base.text({
          ...opts,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }),
      ),
    json: (opts) =>
      guarded(() =>
        base.json({
          ...opts,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }),
      ),
    ...(searchText
      ? {
          searchText: (opts: Parameters<NonNullable<LLM["searchText"]>>[0]) =>
            guarded(() =>
              searchText({
                ...opts,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              }),
            ),
        }
      : {}),
  };
}

/**
 * Hot-lead notification: enrich the person (best-effort, profile-budgeted),
 * finalize the tier, email the org owner ONCE. Enqueued transactionally with
 * the lead upsert (idempotency key `notify_lead:{id}` — one email per lead,
 * ever); the `notifiedAt` stamp is the second guard.
 *
 * SELF_SCOPED + phased (the checkBatchRunway discipline): snapshots and the provider
 * enrichment release their transactions. The final idempotent Resend call holds
 * one tenant transaction across recipient locks and receipt/domain settlement.
 *
 * Enrichment vs urgency: an explicit_ask lead is hot regardless of authority,
 * so when the profile budget is exhausted it emails unenriched. A
 * product_question lead needs the authority check to decide hot vs warm, so it
 * reschedules (+20min) instead of guessing.
 */
export async function handleNotifyLead(
  ctx: SelfScopedCtx,
  payload: { leadId: number },
): Promise<void> {
  const emailCtx = claimedJobEmailContext(ctx);
  const deliveryKey = `lead:${payload.leadId}`;
  const settleInTx = async (tx: Tx) => {
    const settledAt = Date.now();
    await tx
      .update(leads)
      .set({ notifiedAt: settledAt, updatedAt: settledAt })
      .where(and(eq(leads.id, payload.leadId), isNull(leads.notifiedAt)));
  };
  const send = (
    payload: Parameters<typeof sendPreparedEmail>[0],
    key: string,
    signal: AbortSignal,
  ) => sendPreparedEmail(payload, { idempotencyKey: key, signal });

  // Once a provider attempt exists, its encrypted request outranks mutable lead
  // and template state. Resume/settle it first so an ACK can never be forgotten;
  // delivery still revalidates the bound recipient's current owner membership.
  if (
    await resumeJobEmailIfPresent(emailCtx, {
      kind: "lead_hot",
      deliveryKey,
      send,
      settleInTx,
    })
  ) {
    return;
  }

  // Phase 1 — snapshot (short org-scoped tx, then release).
  const snap = await withOrg(ctx.organizationId, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    if (!(await leadsEnabled(tx, ctx.organizationId))) return undefined;
    const [lead] = await tx
      .select()
      .from(leads)
      .where(eq(leads.id, payload.leadId));
    if (!lead || lead.notifiedAt || lead.status !== "new") return undefined;
    const [cached] = await tx
      .select({ fetchedAt: authorProfiles.fetchedAt })
      .from(authorProfiles)
      .where(
        and(
          eq(authorProfiles.profileId, lead.profileId),
          isNull(authorProfiles.fetchError),
        ),
      );
    const fresh = (cached?.fetchedAt ?? 0) > Date.now() - PROFILE_TTL_MS;
    const profiles = await grantFor(ctx, tx, "profile");
    return { lead, fresh, profiles: isGrant(profiles) ? profiles.use : null };
  });
  if (!snap) return;

  // Phase 2 — best-effort enrichment (no connection held during the fetch).
  let lead = snap.fresh
    ? snap.lead
    : await enrichAndRescore(ctx, snap.lead, snap.profiles);

  if (lead.tier !== "hot") {
    // Enrichment decided warm/watch — no email; a later signal that crosses hot
    // re-enqueues under a fresh lead state.
    return;
  }

  // Snapshot the full DM picture in a short DB-only phase. The detached writer
  // then performs every model call through a fresh spend fence; the
  // apply phase rebuilds the revision under a row lock so a human edit wins.
  const prepared = await withOrg(ctx.organizationId, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return prepareLeadDmDraft(tx, lead.id);
  });
  if (!prepared.ok) return;
  const commentText = prepared.preparation.context.base.theirText;

  // Draft the suggested DM — a suggestion the user copy-pastes; nothing ever
  // sends it. Failure degrades to a DM-less email rather than blocking the nudge.
  let dmDraft = lead.dmDraft;
  if (!dmDraft) {
    try {
      const output = await writePreparedLeadDm(prepared.preparation, {
        organizationId: ctx.organizationId,
        llm: spendGuardedLlm(ctx),
      });
      const applied = await withOrg(ctx.organizationId, async (tx) => {
        await assertHostedJobSpendStillAllowedInTx(tx, ctx);
        return applyPreparedLeadDm(
          tx,
          lead.id,
          prepared.preparation.revision,
          output,
        );
      });
      if (!applied.ok) return;
      lead = applied.lead;
      dmDraft = output.text;
    } catch (e) {
      if (e instanceof HostedJobSpendRevokedError) throw e;
      console.warn(`[notify_lead] DM draft failed for lead ${lead.id}:`, e);
    }
  }

  // Phase 3 — detached recipient/template lookup. The delivery boundary locks
  // and revalidates the exact membership + user address before provider I/O.
  await assertHostedJobSpendStillAllowed(ctx);
  const [org] = await baseDb
    .select({ name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId));
  const [owner] = await baseDb
    .select({ userId: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, ctx.organizationId),
        eq(memberships.isOwner, true),
      ),
    )
    .limit(1);
  if (!owner?.email) {
    console.warn(
      `[notify_lead] org ${ctx.organizationId}: no owner email, skipping`,
    );
    return;
  }

  const props = {
    name: lead.name,
    headline: lead.headline,
    reasons: lead.tierReasons,
    evidence: lead.evidenceQuote,
    commentText,
    dmDraft: dmDraft ?? null,
    url: org?.slug
      ? config.dashboardUrl(
          `/organizations/${encodeURIComponent(org.slug)}/leads`,
        )
      : undefined,
    orgName: org?.name,
  };
  await assertHostedJobSpendStillAllowed(ctx);
  await deliverJobEmail(emailCtx, {
    kind: "lead_hot",
    deliveryKey,
    recipientUserId: owner.userId,
    prepare: () => {
      const rendered = leadHotEmail(props);
      return prepareEmailPayload({ to: owner.email, ...rendered });
    },
    send,
    settleInTx,
  });
}

/** Fetch the profile under the profile-call budget, cache it, rescore the lead. */
async function enrichAndRescore(
  ctx: SelfScopedCtx,
  lead: Lead,
  driver: CapabilitySurface<"profile"> | null,
): Promise<Lead> {
  // No profile capability → the lead is scored on the signal alone, exactly as
  // a driver without `fetchProfile` left it.
  if (!driver?.fetchProfile) return lead;
  const org = ctx.organizationId;

  // Reserve ONE profile call in its own committed tx (the enrichAuthors
  // pattern — the charge survives a failed fetch).
  const reserved = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return reserveProfileCall({ db: tx, now: Date.now() });
  });
  if (!reserved.ok) {
    if (lead.intentLevel === "explicit_ask") return lead; // already hot — send unenriched
    // hot-vs-warm hinges on authority: wait for budget instead of guessing.
    throw new RescheduleError("profile_budget", Date.now() + 20 * 60_000);
  }

  let prof: DriverProfile | null = null;
  let fetchError: string | null = null;
  await assertHostedJobSpendStillAllowed(ctx);
  try {
    prof = await driver.fetchProfile(lead.profileId); // NO connection held
  } catch (e) {
    if (isConnectorBackoff(e)) {
      // Account-level pressure pauses the account, not just this job.
      const reason = await pauseChannelForConnectorBackoff(org, e);
      throw new RescheduleError(reason, Date.now() + 15 * 60_000);
    }
    // 422/404 (company/dead profile) — proceed unenriched, cache the failure.
    fetchError =
      e instanceof ConnectorError && e.status
        ? String(e.status)
        : e instanceof Error
          ? e.name
          : "error";
  }

  return withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    await tx
      .insert(authorProfiles)
      .values({
        profileId: lead.profileId,
        headline: prof?.headline ?? null,
        location: prof?.location ?? null,
        country: prof?.country ?? null,
        followers: prof?.followers ?? null,
        connections: prof?.connections ?? null,
        isInfluencer: prof?.isInfluencer ?? null,
        isPremium: prof?.isPremium ?? null,
        fetchedAt: Date.now(),
        fetchError,
      })
      .onConflictDoUpdate({
        target: [authorProfiles.organizationId, authorProfiles.profileId],
        set: {
          headline: prof?.headline ?? null,
          followers: prof?.followers ?? null,
          connections: prof?.connections ?? null,
          isInfluencer: prof?.isInfluencer ?? null,
          isPremium: prof?.isPremium ?? null,
          fetchedAt: Date.now(),
          fetchError,
        },
      });
    if (!prof) return lead;

    // The resolved name also heals the trigger comment (pre-name-resolution
    // rows show "LinkedIn member") so thread views + DM greetings line up.
    if (prof.name && lead.triggerIncomingCommentId) {
      await tx
        .update(incomingComments)
        .set({ authorName: prof.name })
        .where(
          and(
            eq(incomingComments.id, lead.triggerIncomingCommentId),
            isNull(incomingComments.authorName),
          ),
        );
    }

    const rescored = computeLeadTier({
      intentLevel: lead.intentLevel,
      authority: prof,
      touchCount: lead.touchCount,
    });
    const tier = maxTier(lead.tier, rescored.tier);
    const [updated] = await tx
      .update(leads)
      .set({
        headline: prof.headline ?? lead.headline,
        followers: prof.followers ?? lead.followers,
        name: lead.name ?? prof.name ?? null,
        tier,
        tierReasons: rescored.reasons,
        updatedAt: Date.now(),
      })
      .where(eq(leads.id, lead.id))
      .returning();
    return updated ?? lead;
  });
}
