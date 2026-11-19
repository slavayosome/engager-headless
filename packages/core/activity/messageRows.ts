import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { MESSAGE_SENDS } from "../actions/keys";
import { WAKING_REASON } from "../supervision/suspension";
import { sendLikeOffers } from "../actions/likeTarget";
import { heldForResume } from "../operations/schedule";
import {
  campaigns,
  discoveredPosts,
  incomingComments,
  actions,
  jobs,
  conversationSources,
  leadSignals,
  messages,
  roomMembers,
  type Campaign,
  type Message,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { personKey } from "../people/key";
import { linkedinPostUrl } from "../linkedin/postUrl";
import type {
  MessageStatus,
  QueueLike,
  QueueMessage,
  QueueTarget,
  SendBlock,
} from "./messageTypes";

/**
 * The account's message rows, projected once for every surface that lists them.
 *
 * SERVER ONLY (drizzle + schema); client components take `QueueMessage` with
 * `import type`, for the reason `app/activity/pipeline-tabs.ts` documents.
 *
 * Two surfaces read this now — the Channel's day plan (what is scheduled, what
 * went out) and the halves of Scout's pipeline that still act on drafts — so
 * the projection is a parameter rather than a copy: a second `toView` is a
 * second place `publishOrigin` can be forgotten, and forgetting it is silent.
 *
 * Each group is queried on its OWN statuses with its own limit, so a few drafts
 * awaiting the owner can never be buried under a thousand posted rows (which
 * one shared "most recent 100" window would do).
 */

const TARGET_EXCERPT_CHARS = 240;

export type MessageGroupSpec = {
  statuses: readonly MessageStatus[];
  limit: number;
  /**
   * WHICH END OF THE GROUP THE WINDOW TAKES — a correctness choice, not a
   * display one, because the window is applied in the query.
   *
   * "newest": most recently created first, which is what a review surface
   * wants — the drafts you have not answered are the ones just written.
   * "soonest": the next slot first (`scheduledAt` ascending; a slotless row has
   * no time to claim and sorts last, which is Postgres's own ASC default). A
   * PLAN has to take its window at this end: ordering by creation and
   * re-sorting the page in memory would let a full window drop an imminent slot
   * that happens to sit on an older row.
   * "latest": most recently SENT first. A history is ordered by when things
   * happened, and under the human-day plan creation order routinely disagrees:
   * one batch is written together and goes out over days, while the owner's own
   * rows chain at the min-gap and overtake worker rows waiting for a window.
   */
  order: "newest" | "soonest" | "latest";
};

export type MessageGroups<K extends string> = {
  rows: Record<K, QueueMessage[]>;
  /** Totals across ALL rows, not just the loaded window — an honest badge. */
  counts: Record<K, number>;
};

/** Same bulk join list_activity uses (packages/core/mcp/v2/activity/list.ts —
 *  messageTargetsById is not exported, so the pattern is replicated here). */
async function messageTargets(
  tx: Tx,
  rows: Message[],
): Promise<{
  posts: Map<number, QueueTarget>;
  incoming: Map<number, QueueTarget>;
  rooms: Map<number, QueueTarget>;
}> {
  const postIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.discoveredPostId != null ? [r.discoveredPostId] : [],
      ),
    ),
  ];
  const incomingIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.incomingCommentId != null ? [r.incomingCommentId] : [],
      ),
    ),
  ];
  const posts = new Map<number, QueueTarget>();
  if (postIds.length > 0) {
    for (const post of await tx
      .select({
        id: discoveredPosts.id,
        url: discoveredPosts.url,
        authorName: discoveredPosts.authorName,
        authorProfileId: discoveredPosts.authorProfileId,
        contentText: discoveredPosts.contentText,
        rankReason: discoveredPosts.agentRankReason,
        angle: discoveredPosts.agentAngle,
      })
      .from(discoveredPosts)
      .where(inArray(discoveredPosts.id, postIds))) {
      posts.set(post.id, {
        kind: "post",
        authorName: post.authorName,
        excerpt: post.contentText?.slice(0, TARGET_EXCERPT_CHARS) ?? null,
        url: post.url,
        personKey: personKey({ profileId: post.authorProfileId }),
        rankReason: post.rankReason,
        angle: post.angle,
      });
    }
  }
  const incoming = new Map<number, QueueTarget>();
  if (incomingIds.length > 0) {
    for (const comment of await tx
      .select({
        id: incomingComments.id,
        authorName: incomingComments.authorName,
        authorProfileId: incomingComments.authorProfileId,
        authorMemberUrn: incomingComments.authorMemberUrn,
        text: incomingComments.text,
        conversationId: conversationSources.conversationId,
      })
      .from(incomingComments)
      .leftJoin(conversationSources, eq(conversationSources.incomingCommentId, incomingComments.id))
      .where(inArray(incomingComments.id, incomingIds))) {
      incoming.set(comment.id, {
        kind: "incoming_comment",
        authorName: comment.authorName,
        excerpt: comment.text.slice(0, TARGET_EXCERPT_CHARS),
        url: null,
        conversationId: comment.conversationId,
        personKey: personKey({
          profileId: comment.authorProfileId,
          memberUrn: comment.authorMemberUrn,
          incomingCommentId: comment.id,
        }),
      });
    }
  }
  const rooms = new Map<number, QueueTarget>();
  const roomRows = rows.filter((row) => row.kind === "room_reply" && row.roomReplyTarget !== null);
  const targets = roomRows.map((row) => row.roomReplyTarget!);
  const memberIds = [...new Set(targets.flatMap((target) => (target.source === "lead" ? [] : [target.roomMemberId])))];
  const members = new Map((memberIds.length
    ? await tx.select().from(roomMembers).where(inArray(roomMembers.id, memberIds)) : []).map((member) => [member.id, member]));
  // A reply under a lead's comment names its comment by the signal Scout kept.
  const signalIds = [...new Set(targets.flatMap((target) => (target.source === "lead" ? [target.signalId] : [])))];
  const signals = new Map((signalIds.length
    ? await tx.select({ id: leadSignals.id, name: leadSignals.name, words: leadSignals.words }).from(leadSignals)
      .where(inArray(leadSignals.id, signalIds)) : []).map((signal) => [signal.id, signal]));
  for (const row of roomRows) {
    const target = row.roomReplyTarget!;
    const said = target.source === "lead" ? signals.get(target.signalId) : undefined;
    const member = target.source === "lead" ? undefined : members.get(target.roomMemberId);
    const comment = member?.comments.find((entry) => entry.commentUrn === target.parentCommentUrn);
    rooms.set(row.id, { kind: "room_comment", authorName: said?.name ?? member?.name ?? null,
      excerpt: (said?.words ?? comment?.text)?.slice(0, TARGET_EXCERPT_CHARS) ?? null, url: linkedinPostUrl(null, target.postUrn),
      personKey: personKey({ profileId: row.targetProfileId, memberUrn: target.memberUrn }) });
  }
  return { posts, incoming, rooms };
}

/**
 * WHICH SENDS CARRY A LIKE, per campaign of a draft waiting for a yes — what
 * its "+ Like" offers (`sendLikeOffers`). One strategy read per campaign on
 * the page, not one per row.
 */
async function likeOffers(
  tx: Tx,
  rows: Array<Pick<Message, "status" | "campaignId">>,
): Promise<Map<number, Record<Message["kind"], boolean>>> {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        row.status === "proposed" && row.campaignId != null ? [row.campaignId] : [],
      ),
    ),
  ];
  const offers = new Map<number, Record<Message["kind"], boolean>>();
  if (ids.length === 0) return offers;
  // SEQUENTIAL, for the reason `loadMessageGroups` gives: one transaction.
  for (const campaign of await tx.select().from(campaigns).where(inArray(campaigns.id, ids))) {
    offers.set(campaign.id, await sendLikeOffers(tx, campaign));
  }
  return offers;
}

/** The like on a row: what became of it once it went out, or the "+ Like" a
 *  draft waiting for a yes offers. A reply's like is its step's to propose,
 *  so a reply offers one only where the step did. */
function likeView(
  row: Pick<Message, "status" | "kind" | "campaignId" | "likeWithSend" | "likeOutcome">,
  offers: Map<number, Record<Message["kind"], boolean>>,
): QueueLike | null {
  if (row.likeOutcome) {
    return { kind: "outcome", state: row.likeOutcome.state, reason: row.likeOutcome.reason ?? null };
  }
  if (row.status !== "proposed" || row.campaignId == null) return null;
  if (!offers.get(row.campaignId)?.[row.kind]) return null;
  if (row.kind === "reply" && row.likeWithSend === null) return null;
  return { kind: "offer", on: row.likeWithSend !== false };
}

/** Each row's campaign, one query over the distinct ids — the lists name and
 *  link the campaign a row was written for, and say when its pause holds it. */
async function rowCampaigns(
  tx: Tx,
  rows: Array<{ campaignId: number | null }>,
): Promise<Map<number, Pick<Campaign, "name" | "status">>> {
  const ids = [
    ...new Set(rows.flatMap((row) => (row.campaignId != null ? [row.campaignId] : []))),
  ];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(inArray(campaigns.id, ids));
  return new Map(found.map(({ id, ...campaign }) => [id, campaign]));
}

/** The holds that are only a send waiting its turn in the day plan. */
const SLOT_WAITS = ["before_scheduled_slot", "slot_overdue_replanned", "slot_unassigned"] as const;

/** The holds that are only a send spaced from the one before it: the
 *  campaign's own gap, and the account's across its campaigns. */
const GAP_WAITS = ["min_gap", "channel_min_gap"] as const;

/** The holds that pass on their own and are no refusal to show the owner: a
 *  send waiting its turn or its gap, and one that met the machine as it woke. */
export const PASSING_HOLDS = [...SLOT_WAITS, ...GAP_WAITS, WAKING_REASON] as const;

/**
 * The scheduled sends the account cannot make right now, keyed by message.
 *
 * A send the gate holds is not failed: its action stays approved with the hold
 * on its row, the drain looks again later, and the message stays `approved`
 * with its slot in the plan. This reads the hold back for the rows still in
 * the plan. An action that moved on drops out on its own: only
 * `approved`/`posting` messages are returned. `where` narrows the messages as
 * it narrows `loadMessageGroups`'s: one campaign's.
 */
export async function blockedSends(
  tx: Tx,
  organizationId: string,
  { where }: { where?: SQL } = {},
): Promise<Map<number, SendBlock>> {
  const byMessage = new Map<number, SendBlock>();
  const held = await tx
    .select({ messageId: actions.messageId, reason: actions.statusReason, at: actions.updatedAt })
    .from(actions)
    .where(and(inArray(actions.kind, [...MESSAGE_SENDS]), eq(actions.status, "approved"), sql`${actions.statusReason} like 'held:%'`,
      sql`${actions.statusReason} not in (${sql.join(PASSING_HOLDS.map((reason) => sql`${`held:${reason}`}`), sql`, `)})`));
  const [dispatch] = held.length === 0 ? [] : await tx.select({ nextRunAt: jobs.nextRunAt }).from(jobs)
    .where(and(eq(jobs.organizationId, organizationId), sql`${jobs.idempotencyKey} like 'dispatch_actions:%'`, eq(jobs.status, "queued")));
  for (const row of held) {
    if (row.messageId === null) continue;
    byMessage.set(row.messageId, { layer: "channel", code: row.reason!.slice("held:".length), detail: null, retryAt: dispatch?.nextRunAt ?? row.at });
  }
  if (byMessage.size === 0) return byMessage;
  const live = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        inArray(messages.id, [...byMessage.keys()]),
        inArray(messages.status, ["approved", "posting"]),
        where,
      ),
    );
  const liveIds = new Set(live.map((row) => row.id));
  for (const id of byMessage.keys()) {
    if (!liveIds.has(id)) byMessage.delete(id);
  }
  return byMessage;
}

/** Load one row window per named group, in that group's own order, plus each
 *  group's true total. `blocks` (from `blockedSends`) stamps the rows whose
 *  send keeps being refused; without it every row reads as unblocked. `where`
 *  narrows every group and every total alike — one conversation's rows. */
export async function loadMessageGroups<K extends string>(
  tx: Tx,
  spec: Record<K, MessageGroupSpec>,
  opts: { blocks?: Map<number, SendBlock>; where?: SQL } = {},
): Promise<MessageGroups<K>> {
  // Entries rather than keys: `spec[key]` on a generic Record is an indexed
  // access, and `noUncheckedIndexedAccess` would make every group optional.
  const groups = Object.entries(spec) as [K, MessageGroupSpec][];
  // SEQUENTIAL on purpose: these share one transaction, and a pg client
  // cannot run concurrent queries (Promise.all here trips pg's
  // "client is already executing a query" deprecation and breaks on pg@9).
  const perGroup: (typeof messages.$inferSelect)[][] = [];
  for (const [, group] of groups) {
    perGroup.push(
      await tx
        .select()
        .from(messages)
        .where(and(inArray(messages.status, [...group.statuses]), opts.where))
        .orderBy(
          group.order === "soonest"
            ? asc(messages.scheduledAt)
            : group.order === "latest"
              ? desc(messages.postedAt)
              : desc(messages.createdAt),
        )
        .limit(group.limit),
    );
  }
  const all = perGroup.flat();
  const targets = await messageTargets(tx, all);
  const offers = await likeOffers(tx, all);
  const rowCampaign = await rowCampaigns(tx, all);
  const campaignOf = (row: Message) =>
    row.campaignId != null ? rowCampaign.get(row.campaignId) : undefined;
  const held = (row: Message) => {
    const campaign = campaignOf(row);
    return campaign !== undefined && heldForResume(row, campaign);
  };
  const countRows = await tx
    .select({ status: messages.status, n: count() })
    .from(messages)
    .where(opts.where)
    .groupBy(messages.status);
  const byStatus = new Map(countRows.map((row) => [row.status, row.n]));

  const toView = (row: (typeof all)[number]): QueueMessage => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    text: row.finalText ?? row.proposedText,
    edited: row.finalText != null && row.finalText !== row.proposedText,
    // The column, unmapped: "owner" is what the send gate will read off this
    // very row, so anything derived here (a run id, a decision record) would be
    // a second opinion about whose volume this is.
    publishOrigin: row.publishOrigin,
    error: row.error,
    errorCode: row.errorCode,
    lastAttemptAt: row.lastAttemptAt,
    externalUrn: row.externalUrn,
    createdAt: row.createdAt,
    scheduledAt: row.scheduledAt,
    postedAt: row.postedAt,
    redraftRequestVersion: row.redraftRequestVersion,
    redraftAsked: row.redraftRequestId != null,
    retryable:
      row.status === "failed" &&
      row.postingStartedAt == null &&
      row.externalUrn == null &&
      row.redraftRequestId == null,
    pick: row.trace?.pick ?? null,
    target:
      targets.rooms.get(row.id) ?? (row.discoveredPostId != null && row.kind === "comment"
        ? targets.posts.get(row.discoveredPostId)
        : undefined) ??
      (row.incomingCommentId != null
        ? targets.incoming.get(row.incomingCommentId)
        : undefined) ??
      null,
    blocked: opts.blocks?.get(row.id) ?? null,
    like: likeView(row, offers),
    campaignId: row.campaignId,
    campaignName: campaignOf(row)?.name ?? null,
    workerRunId: row.workerRunId,
    heldForResume: held(row),
  });

  const rows = {} as Record<K, QueueMessage[]>;
  const counts = {} as Record<K, number>;
  groups.forEach(([key, group], index) => {
    rows[key] = (perGroup[index] ?? []).map(toView);
    counts[key] = group.statuses.reduce<number>(
      (sum, status) => sum + (byStatus.get(status) ?? 0),
      0,
    );
  });
  return { rows, counts };
}
