import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  actionApprovals,
  actions,
  campaigns,
  channels,
  conversationSources,
  conversations,
  messages,
  pauseControls,
  type ActionStatus,
  type ConversationOpsStatus,
  type PauseControlRow,
  type PauseReason,
  type PauseScope,
} from "@engager/database/schema";
import { afterCommit, type Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import { trackStopChanged } from "../telemetry/emit";
import { endLiveCheckWrites } from "../liveChecks/records";
import { channelCeilings } from "../ratelimit/ledger";
import { ActionLedgerError } from "./errors";
import { isMessageSend, MESSAGE_SENDS } from "./keys";

/**
 * THE DURABLE STOP (INV-29; spec §01 R02, §16 "concurrency and stopping
 * semantics").
 *
 * A Stop is a `pause_controls` row on an account, a campaign or a
 * conversation, under a cancellation GENERATION that rises with every pause
 * the org writes. Two readers hold it, and both read the row AND the number:
 *
 *   - candidate creation — the wake's selection and checkpoint
 *     (`agentStep/select.ts`, `agentStep/wake.ts`) and every reservation
 *     (`actions/ledger.ts`) — creates nothing on a paused scope;
 *   - the dispatch gate (`execution/actionGate.ts`) cancels what is queued.
 *
 * The generation is what an open/closed flag cannot say: an action reserved
 * under generation 5, on a campaign stopped at 6, is cancelled at the gate
 * even after that Stop is resumed, because it was made before the owner said
 * stop. A reservation records the generation it was made under
 * (`generation_seen`); anything later on any scope it touches outranks it.
 *
 * Writing a Stop also cancels the queued rows on its scope in the same
 * transaction — `reserved`, `awaiting_review`, `approved` — and puts the
 * scope's approved unattended comments and replies back to drafts, so the
 * owner sees the queue empty when they press it; `canEngage` holds every
 * other send in the scope while the Stop stands (`actions/stops.ts`). What is past the click is left
 * exactly where it is: a `dispatching` row settles `uncertain` at worst and
 * waits for reconciliation; a Stop never turns a send that may have landed
 * into one that did not.
 *
 * Restart, reconnection, a settings edit or the end of a wake close nothing.
 * Only `resumeScope` — the owner's explicit Resume — writes `resumed_at`, and
 * it replays nothing: what the Stop cancelled stays cancelled, and the next
 * wake reads the current state afresh.
 */

export type PauseScopeRef = { scope: PauseScope; scopeId: number };

/** The rows a Stop cancels: everything short of the click. */
export const QUEUED_STATUSES = [
  "reserved",
  "awaiting_review",
  "approved",
] as const satisfies readonly ActionStatus[];

/** Every scope an action on this account, campaign and conversation touches
 *  — a channel's Stop pauses every campaign on it (INV-34). */
export function scopesOf(input: {
  channelId: number;
  campaignId: number | null;
  conversationId: number | null;
}): PauseScopeRef[] {
  return [
    { scope: "account", scopeId: input.channelId },
    ...(input.campaignId === null ? [] : [{ scope: "campaign" as const, scopeId: input.campaignId }]),
    ...(input.conversationId === null ? [] : [{ scope: "conversation" as const, scopeId: input.conversationId }]),
  ];
}

function touching(scopes: readonly PauseScopeRef[]): SQL {
  return or(
    ...scopes.map((ref) =>
      and(eq(pauseControls.scope, ref.scope), eq(pauseControls.scopeId, ref.scopeId)),
    ),
  )!;
}

/**
 * The org's pause lock, held to commit. Every pause writer takes it (a Stop,
 * a takeover, an exclusion), and so does everything that creates or
 * dispatches work and must not miss one — a reservation, and the dispatch
 * gate under the account's holder — so a pause either committed before they
 * read or waits for them to commit. Taken before any action row is locked,
 * which is what keeps the two orders from deadlocking.
 */
export async function lockPauses(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('pause_controls:' || coalesce(current_setting('app.current_org', true), '')))`,
  );
}

/** The org's highest generation — what a reservation made now is made under.
 *  0 before the first pause. */
export async function currentGeneration(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ generation: sql<number>`coalesce(max(${pauseControls.generation}), 0)::bigint` })
    .from(pauseControls);
  return Number(row?.generation ?? 0);
}

/** Every pause on any of these scopes that is open, or that was written after
 *  `generationSeen` — the two kinds a reader must answer to. */
export async function pausesTouching(
  tx: Tx,
  scopes: readonly PauseScopeRef[],
  generationSeen: number,
): Promise<PauseControlRow[]> {
  if (scopes.length === 0) return [];
  return tx
    .select()
    .from(pauseControls)
    .where(
      and(
        touching(scopes),
        or(isNull(pauseControls.resumedAt), sql`${pauseControls.generation} > ${generationSeen}`),
      ),
    )
    .orderBy(desc(pauseControls.generation));
}

/** The open Stops holding a campaign: its own, and its account's — Pause
 *  LinkedIn — which stops every campaign on it (INV-34). */
export async function campaignStops(
  tx: Tx,
  campaign: { id: number; channelId: number | null },
): Promise<PauseControlRow[]> {
  return openPauses(tx, [
    { scope: "campaign", scopeId: campaign.id },
    ...(campaign.channelId === null ? [] : [{ scope: "account" as const, scopeId: campaign.channelId }]),
  ]);
}

export type PauseVerdict =
  | { kind: "paused"; pause: PauseControlRow }
  | { kind: "superseded"; pause: PauseControlRow };

/**
 * What the pauses an action touches say about it: an open one pauses it; a
 * resumed one written after it was made supersedes it. Null when neither.
 * Open wins, so the reason a surface shows is the Stop still in force.
 */
export function pauseVerdict(
  pauses: readonly PauseControlRow[],
  generationSeen: number,
): PauseVerdict | null {
  const open = pauses.find((pause) => pause.resumedAt === null);
  if (open) return { kind: "paused", pause: open };
  const later = pauses.find((pause) => pause.generation > generationSeen);
  return later ? { kind: "superseded", pause: later } : null;
}

/** `paused:campaign:stop`, `superseded:account:restriction` — the reason a
 *  refused or cancelled row carries. */
export function pauseReasonCode(verdict: PauseVerdict): string {
  return `${verdict.kind}:${verdict.pause.scope}:${verdict.pause.reason}`;
}

/**
 * WHETHER THE OWNER'S OWN ACT IS THE REVIEW a conversation waits for — the one
 * way a conversation that is not `runnable` still takes work (INV-29), decided per
 * `opsStatus` for candidate creation (`candidateRefusal`) and the dispatch gate
 * (`admit`) alike:
 *
 *   runnable         work runs.
 *   awaiting_review  something in it waits for the OWNER — a reply to answer, a
 *                    draft to approve, an invitation to read. Unattended work
 *                    does not pile a new candidate on it; the owner pressing
 *                    Invite, Accept, DM or Like on that very page IS the
 *                    review, so their press runs. The only value that does.
 *   human_owned      the owner took it over: nothing is sent in it, theirs
 *                    included, until they hand it back (`takeover.ts`).
 *   paused           a Stop holds it, which only a Resume lifts.
 *   blocked          LinkedIn warned about the recipient: nothing goes to them.
 *   uncertain        a send to them may have landed and is not settled: sticky
 *                    (INV-10), whoever asks.
 *
 * An unstamped origin is a worker's, as everywhere (`publishOrigin`).
 */
export function ownerIsTheReview(origin: "owner" | "worker" | undefined, opsStatus: ConversationOpsStatus): boolean {
  return origin === "owner" && opsStatus === "awaiting_review";
}

/** The open pauses on these scopes, newest first — what a reservation and a
 *  wake check before creating anything. */
export async function openPauses(
  tx: Tx,
  scopes?: readonly PauseScopeRef[],
): Promise<PauseControlRow[]> {
  return tx
    .select()
    .from(pauseControls)
    .where(
      scopes === undefined
        ? isNull(pauseControls.resumedAt)
        : scopes.length === 0
          ? sql`false`
          : and(isNull(pauseControls.resumedAt), touching(scopes)),
    )
    .orderBy(desc(pauseControls.generation));
}

/**
 * The scope a caller names, with the account's id filled in when they name
 * only "the account": this org's connected LinkedIn channel. A campaign and a
 * conversation are always named by id.
 */
export async function scopeRef(
  tx: Tx,
  scope: PauseScope,
  scopeId: number | undefined,
): Promise<PauseScopeRef> {
  if (scopeId !== undefined) return { scope, scopeId };
  const channel = scope === "account" ? await channelCeilings(tx) : null;
  if (!channel) {
    throw new ActionLedgerError(
      "scope_not_found",
      scope === "account"
        ? "This organization has no connected account to stop."
        : `A ${scope} Stop names the ${scope} by id.`,
      scope === "conversation"
        ? "Pass the conversation id (`conversationId` on an action or an inbound reply turn)."
        : "Pass the campaign's id from list_campaigns.",
    );
  }
  return { scope, scopeId: channel.id };
}

/** A scope names a row of this org: its channel, campaign or conversation. */
async function assertScope(tx: Tx, ref: PauseScopeRef): Promise<void> {
  const [row] =
    ref.scope === "account"
      ? await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, ref.scopeId))
      : ref.scope === "campaign"
        ? await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, ref.scopeId))
        : await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, ref.scopeId));
  if (!row) {
    throw new ActionLedgerError(
      "scope_not_found",
      `No ${ref.scope === "account" ? "account" : ref.scope} ${ref.scopeId} in this organization.`,
      ref.scope === "conversation"
        ? "A conversation is a conversation: its id is on the action (`conversationId`) or on the activity list returns."
        : "Read the id from list_campaigns or get_channel and try again.",
    );
  }
}

export type StopOutcome = {
  pause: PauseControlRow;
  /** False when the scope was already stopped for this reason: a second Stop
   *  is the first, and writes no new generation. */
  created: boolean;
  /** The queued actions this Stop cancelled. */
  cancelled: number;
  /** The unattended comments and replies on `messages` it put back to
   *  drafts. */
  disarmed: number;
};

/**
 * Pause a scope. Serialized per org, so generations are dense and never
 * reused; idempotent per scope and reason. In the same transaction it cancels
 * the scope's queued ledger rows and puts its approved unattended comments and
 * replies back to drafts, as the kill switch does for the whole org — and does
 * both again on a repeated Stop. Every send the `messages` path makes in the
 * scope meets the pause at `canEngage` while it stands (`actions/stops.ts`).
 */
export async function stopScope(
  tx: Tx,
  input: PauseScopeRef & { reason?: PauseReason; by: string; now?: number },
): Promise<StopOutcome> {
  const now = input.now ?? Date.now();
  const reason = input.reason ?? "stop";
  await assertScope(tx, input);
  await lockPauses(tx);
  const [open] = await tx
    .select()
    .from(pauseControls)
    .where(
      and(
        eq(pauseControls.scope, input.scope),
        eq(pauseControls.scopeId, input.scopeId),
        eq(pauseControls.reason, reason),
        isNull(pauseControls.resumedAt),
      ),
    );
  const pause =
    open ??
    (
      await tx
        .insert(pauseControls)
        .values({
          scope: input.scope,
          scopeId: input.scopeId,
          reason,
          generation: (await currentGeneration(tx)) + 1,
          pausedAt: now,
          pausedBy: input.by,
        })
        .returning()
    )[0]!;
  const cancelled = await cancelQueued(tx, input, `paused:${input.scope}:${reason}`, now);
  const disarmed = await disarmQueuedMessages(tx, input);
  // Usage data: a new Stop on the account or a campaign, or a sign from
  // LinkedIn that put one there. A conversation's Stop is about a person.
  if (open === undefined) {
    if (reason === "stop" && (input.scope === "account" || input.scope === "campaign")) {
      trackStopChanged(
        { scope: input.scope === "account" ? "everything" : "campaign", on: true, by: input.by },
        tx,
      );
    }
    if (reason === "warning") afterCommit(tx, () => track("restriction_signal", { signal: "warning_banner" }));
    if (reason === "restriction") afterCommit(tx, () => track("restriction_signal", { signal: "restricted" }));
  }
  return { pause, created: open === undefined, cancelled, disarmed };
}

/**
 * The scope's approved unattended comments and replies, back to drafts with
 * their slot released — what the kill switch does to every one
 * (`suspendWorkerPublishing`). An owner's own words keep their slot; the
 * pause holds them at `canEngage` until the Resume.
 */
async function disarmQueuedMessages(tx: Tx, ref: PauseScopeRef): Promise<number> {
  const inScope =
    ref.scope === "account"
      ? inArray(
          messages.campaignId,
          tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.channelId, ref.scopeId)),
        )
      : ref.scope === "campaign"
        ? eq(messages.campaignId, ref.scopeId)
        : inArray(
            messages.incomingCommentId,
            tx
              .select({ id: conversationSources.incomingCommentId })
              .from(conversationSources)
              .where(eq(conversationSources.conversationId, ref.scopeId)),
          );
  const disarmed = await tx
    .update(messages)
    .set({ status: "proposed", scheduledAt: null })
    .where(
      and(inScope, eq(messages.status, "approved"), eq(messages.publishOrigin, "worker")),
    )
    .returning({ id: messages.id });
  return disarmed.length;
}

/**
 * The owner's explicit Resume: close every open pause on the scope except a
 * takeover, which only releasing the conversation ends
 * (`actions/takeover.ts`). Nothing is replayed — what the Stop cancelled stays
 * cancelled, and the generation it wrote still outranks whatever was reserved
 * before it.
 *
 * Naming a `reason` closes only that one: the owner's own Pause LinkedIn
 * resumes their Stop and leaves a pause LinkedIn's warning put there open.
 */
export async function resumeScope(
  tx: Tx,
  input: PauseScopeRef & { reason?: PauseReason; by: string; now?: number },
): Promise<{ resumed: PauseControlRow[]; stillOpen: PauseControlRow[] }> {
  const now = input.now ?? Date.now();
  await assertScope(tx, input);
  const resumed = await tx
    .update(pauseControls)
    .set({ resumedAt: now, resumedBy: input.by })
    .where(
      and(
        eq(pauseControls.scope, input.scope),
        eq(pauseControls.scopeId, input.scopeId),
        isNull(pauseControls.resumedAt),
        sql`${pauseControls.reason} <> 'takeover'`,
        input.reason === undefined ? undefined : eq(pauseControls.reason, input.reason),
      ),
    )
    .returning();
  if (
    (input.scope === "account" || input.scope === "campaign") &&
    resumed.some((pause) => pause.reason === "stop")
  ) {
    trackStopChanged(
      { scope: input.scope === "account" ? "everything" : "campaign", on: false, by: input.by },
      tx,
    );
  }
  return { resumed, stillOpen: await openPauses(tx, [input]) };
}

/**
 * Cancel the queued actions on one scope. A conversation's are its own;
 * a campaign's carry its id; an account's are every action on the channel.
 * Their live approvals are invalidated with them, with the same reason, so no
 * yes outlives the row it was given for.
 */
export async function cancelQueued(
  tx: Tx,
  ref: PauseScopeRef,
  reason: string,
  now: number,
): Promise<number> {
  const column =
    ref.scope === "account"
      ? actions.channelId
      : ref.scope === "campaign"
        ? actions.campaignId
        : actions.conversationId;
  // A reply's message is locked before its action, as everywhere else.
  const queuedReplies = await tx.select({ messageId: actions.messageId }).from(actions)
    .where(and(eq(column, ref.scopeId), inArray(actions.status, QUEUED_STATUSES), inArray(actions.kind, [...MESSAGE_SENDS])));
  const lockedMessages = queuedReplies.flatMap((row) => (row.messageId === null ? [] : [row.messageId]));
  if (lockedMessages.length > 0) {
    await tx.select({ id: messages.id }).from(messages).where(inArray(messages.id, lockedMessages)).orderBy(messages.id).for("update");
  }
  const cancelled = await tx
    .update(actions)
    .set({ status: "cancelled", statusReason: reason, settledAt: now, updatedAt: now })
    .where(and(eq(column, ref.scopeId), inArray(actions.status, QUEUED_STATUSES)))
    .returning({ id: actions.id, kind: actions.kind, messageId: actions.messageId });
  // A reply's message follows its action out of the queue, the owner's own
  // words too: what the Stop cancelled waits for a fresh yes.
  const replies = cancelled.flatMap((row) => (isMessageSend(row.kind) && row.messageId !== null ? [row.messageId] : []));
  if (replies.length > 0) {
    await tx.update(messages).set({ status: "proposed", scheduledAt: null, error: reason })
      .where(and(inArray(messages.id, replies), eq(messages.status, "approved")));
  }
  await endLiveCheckWrites(
    tx,
    cancelled.map((row) => row.id),
    "cancelled",
    now,
  );
  if (cancelled.length > 0) {
    await tx
      .update(actionApprovals)
      .set({ invalidatedAt: now, invalidatedReason: reason })
      .where(
        and(
          inArray(
            actionApprovals.actionExecutionId,
            cancelled.map((row) => row.id),
          ),
          isNull(actionApprovals.usedAt),
          isNull(actionApprovals.invalidatedAt),
        ),
      );
  }
  return cancelled.length;
}
