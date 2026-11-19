import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, channels, incomingComments, messages, roomMembers, stepRuns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { candidateRefusal } from "../actions/ledger";
import { lockPauses } from "../actions/pause";
import { resolvedReadsOn, unmetBarrier } from "../agentStep/barriers";
import { loadStrategy } from "../agentStep/select";
import { audienceProfile } from "../audience/model";
import type { ResolvedAction } from "../strategy/resolve";
import { liveModes } from "../strategy/mode";
import { personConversationOn } from "../conversations/record";
import { getSystemState, lockEngagementSafety } from "../ratelimit/killswitch";
import { perProfileCapRefusal } from "../ratelimit/ledger";
import { roomContactSql } from "./eligibility";
import { lockRoomVoice, roomHasComment, roomHasOwnerDraft } from "./oneVoice";
import { readRoomReplySource, roomReplyKey, type RoomReplySource } from "./replySource";

export type RoomOpportunity = {
  source: RoomReplySource & { profileId: string };
  stepId: string;
  strategyVersion: number;
  mode: "review" | "auto";
  painId: string;
  conversationId: number | null;
};

export type RoomOpportunityCheck =
  | { kind: "ready"; opportunity: RoomOpportunity }
  | { kind: "held"; reason: string };

const held = (reason: string): RoomOpportunityCheck => ({ kind: "held", reason });
const OWNER_PENDING = ["proposed", "approved", "posting", "needs_review"] as const;

/** Admission before opening a conversation or calling a model. The server names
 * the exact stored comment; names and prompt text never select a recipient.
 * It creates no work and must be checked again before a draft is persisted. */
export async function inspectRoomOpportunity(
  tx: Tx,
  input: { campaignId: number; roomMemberId: number; parentCommentUrn: string; generationSeen: number;
    /** Only the checkpoint that owns a draft can resume it. */
    existingStepRunId?: number; sendingMessageId?: number; redraftingMessageId?: number },
  now = Date.now(),
): Promise<RoomOpportunityCheck> {
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  if ((await getSystemState(tx))?.killSwitch) return held("kill_switch");
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId));
  if (!campaign || campaign.status !== "active" || campaign.channelId === null) {
    return held("room_campaign_inactive");
  }
  const strategy = await loadStrategy(tx, campaign);
  const step = strategy?.document.steps?.find((entry) => entry.catalog_step === "meet_the_room");
  if (!strategy || !step) return held("room_step_missing");
  const actions = await liveModes(tx, campaign.id, now);
  const reply = actions.find((action) => action.step_id === step.step_id && action.kind === "room_reply");
  if (reply?.effective !== "review" && reply?.effective !== "auto") return held("room_step_off");
  // Research is a real read in this version, not a step name or a canvas link.
  const readsOn = resolvedReadsOn(actions);
  const research = strategy.document.action_bindings?.find((binding) => binding.capability_ref === "research_lead" &&
    strategy.document.steps?.some((entry) => entry.step_id === binding.owner_step_id && entry.catalog_step === "find_leads"));
  if (!research || !readsOn.has(`${research.owner_step_id}.${research.action_binding_id}`)) return held("room_research_off");

  let source: RoomReplySource;
  try {
    source = await readRoomReplySource(tx, input, { selectedBy: "worker", now });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return held(error.code);
  }
  if (source.campaignId !== campaign.id || source.channelId !== campaign.channelId) return held("room_source_mismatch");
  if (source.profileId === null) return held("room_profile_unresolved");
  if (source.evidenceReadAt > now) return held("room_evidence_unavailable");
  const [member] = await tx.select({ painId: roomMembers.painId }).from(roomMembers).where(eq(roomMembers.id, source.roomMemberId));
  const pain = audienceProfile(campaign).pains.find((entry) => entry.id === member?.painId && entry.status === "active");
  if (!pain) return held("room_pain_inactive");
  const conversation = await personConversationOn(tx, source.channelId, source.profileId);
  const refused = await candidateRefusal(tx, { channelId: source.channelId, campaignId: campaign.id,
    conversationId: conversation?.id ?? null, authorProfileId: source.profileId, generationSeen: input.generationSeen });
  if (refused) return held(refused);
  const achieved = conversation ? await tx.select({ stepId: stepRuns.stepId }).from(stepRuns)
    .where(and(eq(stepRuns.conversationId, conversation.id), eq(stepRuns.status, "achieved"))) : [];
  const barrier = unmetBarrier(step, { achievedSteps: new Set(achieved.map((run) => run.stepId)), readsOn, occurredAt: source.evidenceReadAt,
    interest: conversation?.interestEvidenceEventId !== null && conversation?.interestEvidenceEventId !== undefined,
    relevant: true, now });
  if (barrier) return held(`barrier:${barrier.type}`);
  const [channel] = await tx.select().from(channels).where(eq(channels.id, source.channelId));
  if (!channel) return held("room_account_missing");
  if (channel.pausedUntil !== null && channel.pausedUntil > now) return held("room_account_paused");
  const cap = await perProfileCapRefusal(tx, channel, source.profileId, now, source.memberUrn);
  if (cap) return held(cap.reason);
  const contact = await tx.execute<{ contacted: boolean }>(sql`select ${roomContactSql(sql`${source.profileId}`,
    sql`${source.memberUrn}`, sql`${source.channelId}`)} as contacted`);
  if (contact.rows[0]?.contacted) return held("room_person_already_contacted");

  await lockRoomVoice(tx, source);
  if (await roomHasComment(tx, source)) return held("room_voice_taken");
  const [reservation] = await tx.select().from(messages).where(eq(messages.dedupeKey, roomReplyKey(source))).limit(1);
  if (reservation) {
    const [checkpoint] = input.existingStepRunId === undefined ? [] : await tx.select().from(stepRuns)
      .where(eq(stepRuns.id, input.existingStepRunId));
    const ownsDraft = checkpoint?.campaignId === campaign.id && checkpoint.conversationId === conversation?.id &&
      checkpoint.stepId === step.step_id && checkpoint.drafts.some((draft) =>
        draft.kind === "room_reply" && draft.messageId === reservation.id && draft.target === source.parentCommentUrn);
    const sending = input.sendingMessageId === reservation.id && ["approved", "posting"].includes(reservation.status);
    if (!ownsDraft || reservation.campaignId !== campaign.id || reservation.kind !== "room_reply" ||
      reservation.workerRunId === null || reservation.roomReplyTarget?.selectedBy !== "worker" ||
      (!sending && (!["proposed", "approved", "suppressed_dryrun"].includes(reservation.status) || reservation.lastAttemptAt !== null))) {
      return held("room_reply_already_reserved");
    }
  }
  if (await roomHasOwnerDraft(tx, source)) return held("room_owner_reply_pending");
  const [ownerMessage] = await tx.select({ id: messages.id }).from(messages)
    .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId))
    .leftJoin(incomingComments, eq(incomingComments.id, messages.incomingCommentId))
    .where(and(or(eq(channels.id, source.channelId), eq(channels.externalAccountId, source.accountProfileId)), eq(messages.publishOrigin, "owner"),
      inArray(messages.status, [...OWNER_PENDING]),
      input.redraftingMessageId !== undefined && input.redraftingMessageId === reservation?.id ? ne(messages.id, reservation.id) : undefined,
      or(eq(messages.targetProfileId, source.profileId), eq(incomingComments.authorProfileId, source.profileId))))
    .limit(1);
  if (ownerMessage) return held("room_owner_reply_pending");
  return { kind: "ready", opportunity: { source: { ...source, profileId: source.profileId }, stepId: step.step_id,
    strategyVersion: strategy.version, mode: reply.effective, painId: pain.id, conversationId: conversation?.id ?? null } };
}
