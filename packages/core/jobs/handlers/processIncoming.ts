import { likeableReading, likeObservedReply, likesOnSight } from "../../actions/likeTarget";
import { openPauses } from "../../actions/pause";
import { queueAutomaticReply } from "../../actions/reply";
import { scopedStop } from "../../actions/stops";
import { modeFor } from "../../strategy/mode";
import { and, eq, sql } from "drizzle-orm";
import {
  campaigns,
  channels,
  incomingComments,
  messages,
  organizations,
  type Campaign,
  type IncomingReading,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { recordPrompt } from "../../ai/prompts";
import { leadOf, readIncoming, readingOf, sensitivityOf, sensitivityRow } from "../../ai/reading";
import { prepareReplyDraft, replyPreparationRevision } from "../../draft";
import { writeReplyWords } from "../../agentStep/writing";
import { replyOf, type ClassifiedReply } from "../../conversations/classify";
import { recordReplyEvent, recordsConversation } from "../../conversations/record";
import { isRoomThreadReply } from "../../rooms/thread";
import { observesRoomReplies } from "../../rooms/continuation";
import { conversationEventArrived } from "../../agentStep/wait";
import { leadsEnabled } from "../../leads/gate";
import { upsertLeadFromSignal } from "../../leads/intake";
import { dismissIncoming } from "../../operations/dismissal";
import {
  OWN_POST_REPLIES_DEFAULTS,
} from "../../operations/orgSettings";
import { assembleReplyContext } from "../../replyContext";
import { assignSlots } from "../../operations/schedule";
import { dedupeKey } from "../../posting";
import { jobGuardedLlm } from "../providerGuard";
import { RescheduleError } from "../queue";
import {
  assertHostedJobSpendStillAllowedInTx,
  HostedJobSpendRevokedError,
} from "../spendAccess";
import type { SelfScopedCtx } from "../worker";

/**
 * The inbound pipeline for one incoming comment, split by source:
 *  - `own_post` (comment on OUR post): gated by the ORG-level ownPostReplies
 *    policy — own posts exist independently of campaigns.
 *  - `our_comment_thread` (reply to OUR comment on someone else's post): gated
 *    by the owning CAMPAIGN's reply mode — that campaign started the thread.
 * Each is read once (`ai/reading.ts`): the stored reading carries its stance,
 * opt-out, lead intent and sensitivity, and the phases below (lead intake, the
 * eligibility table, the like on sight, the hold, the closer dismissal) all
 * read it from the row. The reply is planned, written and judged by the
 * dispatcher (`writeReplyWords`, the worker-only server writer; MCP replies
 * are client-side via submit_draft); this handler resolves the gate + persona
 * vehicle, persists the draft, and decides the path. Replies default to
 * manual; a `hold` from the sensitivity gate ALWAYS forces human review, even
 * in auto mode.
 *
 * Runs inside the job's org-scoped `withOrg` tx (RLS + the GUC default supply
 * organization_id), so no query carries an organizationId.
 */

type IncomingVehicle = {
  campaign: Campaign;
  baseCampaignRevision: string;
  vehicleRevision: string;
  sourcePolicyRevision: string;
  sourcePolicyEnabled: boolean;
  sourceApprovalAuto: boolean;
};

function replyDraftStatus(
  vehicle: IncomingVehicle,
  sensitivity: { hold: boolean },
): "approved" | "proposed" {
  return vehicle.sourcePolicyEnabled &&
    vehicle.sourceApprovalAuto &&
    !sensitivity.hold
    ? "approved"
    : "proposed";
}

async function resolveIncomingVehiclePhased(
  tx: Tx,
  incoming: typeof incomingComments.$inferSelect,
  writeIgnored: boolean,
): Promise<IncomingVehicle | undefined> {
  if (incoming.source === "our_comment_thread") {
    const [campaign] = incoming.campaignId
      ? await tx
          .select()
          .from(campaigns)
          .where(eq(campaigns.id, incoming.campaignId))
          .for("share")
      : [undefined];
    if (!campaign) {
      if (writeIgnored) {
        await tx
          .update(incomingComments)
          .set({ status: "ignored" })
          .where(
            and(
              eq(incomingComments.id, incoming.id),
              eq(incomingComments.status, "new"),
            ),
          );
      }
      return undefined;
    }
    const explicitRequest = incoming.draftRequestId != null;
    const mode = (await modeFor(tx, { campaignId: campaign.id, capability: "reply_public", target: "their_reply" })).effective ?? "off";
    if (mode === "off" && !explicitRequest) {
      if (writeIgnored) {
        await tx
          .update(incomingComments)
          .set({ status: "ignored" })
          .where(
            and(
              eq(incomingComments.id, incoming.id),
              eq(incomingComments.status, "new"),
            ),
          );
      }
      return undefined;
    }
    const revision = JSON.stringify(campaign);
    return {
      campaign,
      baseCampaignRevision: revision,
      vehicleRevision: revision,
      sourcePolicyRevision: JSON.stringify({ mode }),
      sourcePolicyEnabled: mode === "review" || mode === "auto",
      sourceApprovalAuto: mode === "auto",
    };
  }

  const [organization] = await tx
    .select({ ownPostReplies: organizations.ownPostReplies })
    .from(organizations)
    .where(
      sql`${organizations.id} = nullif(current_setting('app.current_org', true), '')::uuid`,
    )
    .for("share");
  const policy = organization?.ownPostReplies ?? OWN_POST_REPLIES_DEFAULTS;
  if (policy.mode === "off") {
    if (writeIgnored) {
      await tx
        .update(incomingComments)
        .set({ status: "ignored" })
        .where(
          and(
            eq(incomingComments.id, incoming.id),
            eq(incomingComments.status, "new"),
          ),
        );
    }
    return undefined;
  }
  const [baseCampaign] = await tx
    .select()
    .from(campaigns)
    .where(eq(campaigns.status, "active"))
    .orderBy(campaigns.id)
    .limit(1)
    .for("share");
  if (!baseCampaign) return undefined;
  const resolved = await modeFor(tx, { ownPost: policy, campaignId: baseCampaign.id });
  if (resolved.effective === "off") {
    if (writeIgnored) await tx.update(incomingComments).set({ status: "ignored" })
      .where(and(eq(incomingComments.id, incoming.id), eq(incomingComments.status, "new")));
    return undefined;
  }
  // The org's own-post reply prompt stands in for the campaign's reply policy.
  const campaign: Campaign = {
    ...baseCampaign,
    prompts: { ...baseCampaign.prompts, reply_policy: policy.prompt },
  };
  return {
    campaign,
    baseCampaignRevision: JSON.stringify(baseCampaign),
    vehicleRevision: JSON.stringify(campaign),
    sourcePolicyRevision: JSON.stringify({ policy, resolved }),
    sourcePolicyEnabled: true,
    sourceApprovalAuto: resolved.effective === "auto",
  };
}

/** Stores the reading made of a row's words, and folds its buying intent into
 *  the sender's lead (a reply under our comment only). Their words count once:
 *  for the reply this reading was made of. */
async function applyReading(
  tx: Tx,
  incoming: typeof incomingComments.$inferSelect,
  reading: IncomingReading | null,
): Promise<typeof incomingComments.$inferSelect> {
  if (!reading) return incoming;
  const stored = incoming.reading?.textHash === reading.textHash ? incoming : { ...incoming, reading };
  if (stored !== incoming) {
    await tx.update(incomingComments).set({ reading }).where(eq(incomingComments.id, incoming.id));
  }
  if (
    incoming.source !== "our_comment_thread" ||
    !(await leadsEnabled(tx))
  ) {
    return stored;
  }
  const verdict = leadOf(reading);
  const fresh = incoming.intent == null;
  if (fresh) {
    await tx
      .update(incomingComments)
      .set({
        intent: verdict.intent,
        intentEvidence: verdict.evidence || null,
        classifiedAt: Date.now(),
      })
      .where(
        and(
          eq(incomingComments.id, incoming.id),
          sql`${incomingComments.intent} is null`,
        ),
      );
  }
  if (!incoming.authorProfileId) return stored;
  await upsertLeadFromSignal(tx, {
    profileId: incoming.authorProfileId,
    name: incoming.authorName,
    intent: verdict.intent,
    evidence: verdict.evidence || null,
    triggerIncomingCommentId: incoming.id,
    campaignId: incoming.campaignId,
    ...(fresh ? { words: { at: incoming.receivedAt, kind: "comment" as const } } : {}),
  });
  return stored;
}

export class ProcessIncomingStaleSnapshotError extends Error {
  constructor() {
    super("process_incoming inputs changed while cognition was in flight");
    this.name = "ProcessIncomingStaleSnapshotError";
  }
}

/** How long a reply waits on its campaign's Stop before it looks again. */
const CAMPAIGN_STOPPED_RETRY_MS = 15 * 60_000;

/**
 * A Stop on the campaign holds its reply lane (US-CMP-02): nothing in a
 * stopped campaign is drafted. The reply waits — its row as it arrived, its
 * job queued without spending an attempt — and is read and drafted on the
 * first look after the Resume. Read before any model call, again before the
 * draft is written, so one pressed while the writer was thinking writes
 * nothing either.
 */
async function waitOutCampaignStop(tx: Tx, campaignId: number | null): Promise<void> {
  if (campaignId === null) return;
  if ((await openPauses(tx, [{ scope: "campaign", scopeId: campaignId }])).length > 0) {
    throw new RescheduleError("campaign stopped", Date.now() + CAMPAIGN_STOPPED_RETRY_MS);
  }
}

export type ProcessIncomingPhasedHooks = {
  afterSnapshot?: () => Promise<void>;
  afterSensitivity?: () => Promise<void>;
  beforeApply?: () => Promise<void>;
};

export type ProcessIncomingOrgScope = <T>(
  work: (tx: Tx) => Promise<T>,
) => Promise<T>;

/** Canonical self-scoped managed-reply path. */
export async function handleProcessIncomingPhased(
  ctx: SelfScopedCtx,
  payload: { incomingCommentId: number },
  hooks: ProcessIncomingPhasedHooks = {},
  orgScope: ProcessIncomingOrgScope = (work) =>
    withOrg(ctx.organizationId, work),
): Promise<void> {
  const initialSnapshot = await orgScope(async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const [incoming] = await tx
      .select()
      .from(incomingComments)
      .where(eq(incomingComments.id, payload.incomingCommentId))
      .for("share");
    if (!incoming || incoming.status !== "new") {
      return { kind: "done" as const };
    }
    await waitOutCampaignStop(tx, incoming.campaignId);
    // A row that arrived held — backlog pollIncoming's thread arm took in
    // while nothing watched — waits for the owner, as a backlog DM does
    // (`conversations/inbox.ts`): no model reads it, and it is recorded
    // unclassified, which is review, so nothing wakes or drafts against it.
    const held = incoming.sensitivity === "hold";
    const conversationed = await recordsConversation(tx, incoming);
    const roomThread = await isRoomThreadReply(tx, incoming);
    const thread = incoming.source === "our_comment_thread";
    const foldsLead = !held && thread && incoming.intent == null && (await leadsEnabled(tx));
    const readsReply = conversationed && !held;
    // A comment on our own post is read only where a policy will answer it: one
    // the policy ignores costs no model call.
    const answerable = thread || (await resolveIncomingVehiclePhased(tx, incoming, false)) !== undefined;
    return {
      kind: "ready" as const,
      incoming,
      incomingRevision: JSON.stringify(incoming),
      needsReading:
        readingOf(incoming) === null && (thread ? foldsLead || readsReply : answerable),
      recordsConversation: conversationed,
      roomThread,
      shouldClassifyReply: !held,
      // Like reply at Automatic likes a reply the moment it is seen, once its
      // reads clear it; a held row is never one.
      likesOnSight:
        conversationed && !held && !roomThread && incoming.campaignId !== null && (await likesOnSight(tx, incoming.campaignId)) !== null,
    };
  });
  if (initialSnapshot.kind === "done") return;
  await hooks.afterSnapshot?.();

  const llm = jobGuardedLlm(ctx);
  const kind = initialSnapshot.incoming.source === "our_comment_thread" ? "reply" : "comment";
  let reading = readingOf(initialSnapshot.incoming);
  if (initialSnapshot.needsReading) {
    try {
      reading = await readIncoming(initialSnapshot.incoming.text, kind, llm);
    } catch (error) {
      // A reply no model could read is recorded unread, which is review. A
      // comment on our own post is not answered unread: the job retries.
      if (error instanceof HostedJobSpendRevokedError || kind === "comment") throw error;
      console.error(
        `[conversations] reading failed for comment ${initialSnapshot.incoming.id}:`,
        error,
      );
    }
  }
  // A reply on a conversation is read for the eligibility table. A failed read, or
  // a held row no model reads, is recorded as unclassified, which is review —
  // never as a verdict.
  const classifiedReply: ClassifiedReply | null =
    reading && initialSnapshot.recordsConversation && initialSnapshot.shouldClassifyReply
      ? replyOf(initialSnapshot.incoming.text, reading)
      : null;
  // A reply the stance read clears is liked on sight only once the
  // sensitivity check clears it too — press, legal, a competitor, profanity
  // are a person's to look at first. A reply no model could read likes nothing.
  const likeOnSight =
    initialSnapshot.likesOnSight &&
    likeableReading(classifiedReply?.reading ?? null) &&
    reading !== null &&
    !sensitivityOf(reading).hold;
  const snapshot = await orgScope(async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const [incoming] = await tx
      .select()
      .from(incomingComments)
      .where(eq(incomingComments.id, initialSnapshot.incoming.id))
      .for("update");
    if (
      !incoming ||
      JSON.stringify(incoming) !== initialSnapshot.incomingRevision
    ) {
      throw new ProcessIncomingStaleSnapshotError();
    }
    const readIncomingRow = await applyReading(tx, incoming, reading);
    const hold = reading?.verdict.hold && incoming.sensitivity !== "hold" ? sensitivityRow(sensitivityOf(reading)) : null;
    if (hold) await tx.update(incomingComments).set(hold).where(eq(incomingComments.id, incoming.id));
    if (initialSnapshot.recordsConversation) {
      // Before any reply gating: a reply no policy drafts against is still
      // an event in the person's conversation.
      const now = Date.now();
      const recorded = await recordReplyEvent(tx, {
        incoming: hold ? { ...readIncomingRow, ...hold } : readIncomingRow,
        classified: classifiedReply,
        now,
      });
      // A first sight of this revision ends the waits it answers and wakes
      // the Ambassador; a repeat of one already recorded reaches nothing.
      if (recorded?.recorded && incoming.campaignId !== null &&
          (!initialSnapshot.roomThread || await observesRoomReplies(tx, incoming.campaignId))) {
        await conversationEventArrived(tx, {
          campaignId: incoming.campaignId,
          event: recorded.event,
          now,
        });
        // The reply as first posted, never an edit of it: an edit is
        // recorded unread, and its like was the first revision's.
        if (likeOnSight && recorded.event.type === "reply_observed") {
          await likeObservedReply(tx, { incoming, conversation: recorded.conversation, event: recorded.event, now });
        }
      }
    }
    const [current] = await tx
      .select()
      .from(incomingComments)
      .where(eq(incomingComments.id, incoming.id));
    if (!current) throw new ProcessIncomingStaleSnapshotError();
    // Classification (including opt-out) still records the conversation.
    // Reply's existing Automatic mode does not hire a room reply step.
    if (initialSnapshot.roomThread) return { kind: "done" as const };
    const vehicle = await resolveIncomingVehiclePhased(tx, current, true);
    // A reply under a comment of a campaign that runs on its strategy is
    // its Ambassador's to answer: the agent step is its one drafter (INV-9),
    // so the reply lane stops here, after classification and lead intake.
    if (
      !vehicle ||
      current.source === "our_comment_thread"
    ) {
      return { kind: "done" as const };
    }
    await waitOutCampaignStop(tx, vehicle.campaign.id);
    // A Stop on the account or the conversation drafts nothing in it (INV-29):
    // no candidate is created while it stands, and the Resume replays nothing.
    if (
      vehicle.campaign.channelId !== null &&
      (await scopedStop(tx, {
        channelId: vehicle.campaign.channelId,
        campaignId: vehicle.campaign.id,
        profileId: current.authorProfileId,
        origin: "worker",
      }))
    ) {
      return { kind: "done" as const };
    }
    return {
      kind: "ready" as const,
      incoming: current,
      incomingRevision: JSON.stringify(current),
      vehicle,
    };
  });
  if (snapshot.kind === "done") return;

  const read =
    readingOf(snapshot.incoming) ?? (await readIncoming(snapshot.incoming.text, "comment", llm));
  const verdict = sensitivityOf(read);
  // A row that arrived held — a reply pollIncoming's thread arm found as
  // backlog — stays held: the reading may clear the words, never the row.
  const sensitivity =
    snapshot.incoming.sensitivity === "hold" ? { ...verdict, hold: true } : verdict;
  await hooks.afterSensitivity?.();

  const preparedOutcome = await orgScope(async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const [incoming] = await tx
      .select()
      .from(incomingComments)
      .where(eq(incomingComments.id, snapshot.incoming.id))
      .for("update");
    if (!incoming || JSON.stringify(incoming) !== snapshot.incomingRevision) {
      throw new ProcessIncomingStaleSnapshotError();
    }
    const vehicle = await resolveIncomingVehiclePhased(tx, incoming, false);
    if (
      !vehicle ||
      vehicle.baseCampaignRevision !== snapshot.vehicle.baseCampaignRevision ||
      vehicle.vehicleRevision !== snapshot.vehicle.vehicleRevision ||
      vehicle.sourcePolicyRevision !== snapshot.vehicle.sourcePolicyRevision
    ) {
      throw new ProcessIncomingStaleSnapshotError();
    }
    await applyReading(tx, incoming, read);
    const [current] = await tx
      .select()
      .from(incomingComments)
      .where(eq(incomingComments.id, incoming.id));
    if (!current) throw new ProcessIncomingStaleSnapshotError();

    if (sensitivity.hold) {
      await tx.update(incomingComments).set(
        current.sensitivity === "hold" ? { reading: read } : { reading: read, ...sensitivityRow(sensitivity) },
      ).where(eq(incomingComments.id, current.id));
      return { kind: "held" as const };
    }

    // Recompute the conversation after sensitivity/lead cognition and before
    // calling the reply writer. A concurrent posted reply
    // can exhaust the cap while those detached calls are in flight.
    const threadContext = await assembleReplyContext(tx, current);
    const shouldDismiss =
      !sensitivity.hold &&
      (sensitivity.arc === "warm_closer" ||
        sensitivity.arc === "cold_closer" ||
        threadContext.capReached);
    if (shouldDismiss) {
      return {
        kind: "dismiss" as const,
        dismissed: await dismissIncoming(tx, {
          incomingCommentId: current.id,
          campaign: vehicle.campaign,
          like: sensitivity.arc === "warm_closer" || threadContext.capReached,
          by: "agent",
        }),
      };
    }

    const prepared = await prepareReplyDraft(
      tx,
      current,
      vehicle.campaign,
      threadContext,
    );
    return {
      kind: "reply" as const,
      preparationRevision: replyPreparationRevision(prepared),
      baseCampaignRevision: vehicle.baseCampaignRevision,
      vehicleRevision: vehicle.vehicleRevision,
      sourcePolicyRevision: vehicle.sourcePolicyRevision,
      prepared,
    };
  });

  if (preparedOutcome.kind === "held") return;
  if (preparedOutcome.kind === "dismiss") return;
  const preparedReply = preparedOutcome;

  const draft = await writeReplyWords(preparedReply.prepared, {
    organizationId: ctx.organizationId,
    llm,
  });
  await hooks.beforeApply?.();
  await orgScope(async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const [incoming] = await tx
      .select()
      .from(incomingComments)
      .where(eq(incomingComments.id, snapshot.incoming.id))
      .for("update");
    if (!incoming) {
      throw new ProcessIncomingStaleSnapshotError();
    }
    const vehicle = await resolveIncomingVehiclePhased(tx, incoming, false);
    if (!vehicle) {
      throw new ProcessIncomingStaleSnapshotError();
    }
    if (
      vehicle.baseCampaignRevision !==
        preparedReply.baseCampaignRevision ||
      vehicle.vehicleRevision !== preparedReply.vehicleRevision ||
      vehicle.sourcePolicyRevision !== preparedReply.sourcePolicyRevision
    ) {
      throw new ProcessIncomingStaleSnapshotError();
    }
    await waitOutCampaignStop(tx, vehicle.campaign.id);
    const freshPrepared = await prepareReplyDraft(
      tx,
      incoming,
      vehicle.campaign,
      await assembleReplyContext(tx, incoming),
    );
    if (
      replyPreparationRevision(freshPrepared) !==
      preparedReply.preparationRevision
    ) {
      throw new ProcessIncomingStaleSnapshotError();
    }

    const promptVersionId = await recordPrompt(
      tx,
      "reply",
      draft.promptTemplate,
    );
    const status = replyDraftStatus(vehicle, sensitivity);
    const [inserted] = await tx
      .insert(messages)
      .values({
        kind: "reply",
        publishOrigin: "worker",
        campaignId: vehicle.campaign.id,
        incomingCommentId: incoming.id,
        targetProfileId: incoming.authorProfileId,
        proposedText: draft.text,
        status,
        dedupeKey: dedupeKey(
          "reply",
          vehicle.campaign.id,
          incoming.commentUrn,
        ),
        promptVersionId,
        model: draft.model,
        draftPlanId: draft.planId,
        loopVersion: "rag",
        briefSourceHash: draft.briefSourceHash ?? null,
        briefAnchorIds: draft.briefAnchorIds ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    await tx
      .update(incomingComments)
      .set({
        // A row that arrived held keeps the reason it arrived with.
        ...(incoming.sensitivity === "hold" ? {} : sensitivityRow(sensitivity)),
        reading: read,
        status: "reply_proposed",
      })
      .where(
        and(
          eq(incomingComments.id, incoming.id),
          eq(incomingComments.status, "new"),
        ),
      );
    if (inserted && status === "approved") {
      await assignSlots(tx, {
        campaign: vehicle.campaign,
        items: [{ messageId: inserted.id, kind: "reply" }],
      });
      await queueAutomaticReply(tx, inserted.id);
    }
  });
}
