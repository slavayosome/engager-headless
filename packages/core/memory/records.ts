import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { AppError } from "@engager/common/errors";
import {
  actionApprovals,
  actions,
  engagedProfiles,
  conversationEvents,
  conversations,
  memoryRecords,
  messages,
  stepRuns,
  type ActionKind,
  type ActionStatus,
  type ConversationRow,
  type MemoryRecordRow,
  type MemoryScope,
  type StepMemoryPatch,
  type StepMemoryRef,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { QUEUED_STATUSES } from "../actions/pause";
import { untrusted } from "../ai/prompts";
import type { CampaignAgentStrategy } from "../strategy/contract";

/**
 * RELATIONSHIP MEMORY — what the account remembers about a person, or about
 * the people of a campaign, with who said it and where it came from (spec §05
 * R20, "memory contract and user control").
 *
 * A memory is named by where it lives: its account, slot, scope and the
 * scope's ref, and a key. Each change is a new version that supersedes the
 * one before, so the memory in force is the highest version and the rest is
 * its history. Three kinds of author are kept apart and never merged: the
 * owner; the person, in words a step cited from what it was handed
 * (`observed`); and a step's own inference (`inferred`), which can be wrong.
 *
 * A step reads what its campaign's memory bindings name, and its checkpoint
 * keeps the ids and versions it was handed (`step_runs.memory_refs`): every
 * draft and every send of that step rests on them, and an approval binds
 * their digest (`actions/approval.ts`). A step writes only what a binding
 * admits, only about the person it is talking to: one person's preference is
 * never promoted to a campaign or the account.
 *
 * The owner's controls are inspect, edit (a correction is an edit) and forget.
 * An edit or a forget invalidates what rested on the old version — queued
 * sends cancelled and their approvals invalidated, unsent drafts withdrawn,
 * waiting checkpoints ended — so the next wake works from what is true now.
 * Forgetting deletes every version, and takes the content out of the
 * checkpoints that carried it. It never touches an exclusion and never
 * creates a permission: those are not memories. "Do not remember this"
 * leaves a value-less marker that keeps the same memory from being written
 * again.
 */

export type MemoryRefusal =
  | "memory_not_found"
  | "memory_superseded"
  | "memory_not_editable"
  | "memory_not_forgettable"
  | "memory_not_a_marker";

export class MemoryError extends AppError {
  constructor(
    code: MemoryRefusal,
    message: string,
    readonly recovery: string,
  ) {
    super(code, message, code === "memory_not_found" ? 404 : 409);
  }
}

/** Where a memory lives — every version of one memory shares it. */
export type MemoryIdentity = Pick<MemoryRecordRow, "channelId" | "slot" | "scope" | "scopeRef" | "key">;

const sameIdentity = (identity: MemoryIdentity): SQL =>
  and(
    eq(memoryRecords.channelId, identity.channelId),
    eq(memoryRecords.slot, identity.slot),
    eq(memoryRecords.scope, identity.scope),
    identity.scopeRef === null
      ? sql`${memoryRecords.scopeRef} is null`
      : eq(memoryRecords.scopeRef, identity.scopeRef),
    eq(memoryRecords.key, identity.key),
  )!;

/** A version nothing supersedes: the memory in force. */
function current(tx: Tx): SQL {
  const newer = alias(memoryRecords, "newer");
  return notExists(
    tx.select({ id: newer.id }).from(newer).where(eq(newer.supersedesId, memoryRecords.id)),
  );
}

/** The digest an approval binds: the memory ids and versions a step read,
 *  in a canonical order; null when it read none. Pure. */
export function memoryVersion(refs: readonly StepMemoryRef[]): string | null {
  if (refs.length === 0) return null;
  const canonical = [...refs].sort((a, b) => a.id - b.id).map((ref) => `${ref.id}@${ref.version}`);
  return createHash("sha256").update(canonical.join(","), "utf8").digest("hex");
}

/** The scope refs a step's memory bindings let it read, for one conversation. */
function readableScopes(
  bindings: CampaignAgentStrategy["memory_bindings"],
  at: { campaignId: number; stepId: string; personId: string },
): Array<{ scope: MemoryScope; scopeRef: string | null }> {
  const refs: Record<MemoryScope, string | null> = {
    account: null,
    campaign: String(at.campaignId),
    step: `${at.campaignId}:${at.stepId}`,
    person: at.personId,
  };
  const scopes = new Set(
    bindings.filter((binding) => binding.slot === "relationship_memory").map((binding) => binding.scope),
  );
  return [...scopes].map((scope) => ({ scope, scopeRef: refs[scope] }));
}

export type StepMemory = {
  /** The section the step's input carries; null when its campaign binds no
   *  memory to read. */
  text: string | null;
  refs: StepMemoryRef[];
  version: string | null;
};

/**
 * What a step on one conversation may read of what the account remembers: the
 * memory in force in each scope its campaign's bindings name, the person's
 * own scope being this conversation's person. Each line says who said it; what a
 * person said or a step inferred is fenced as data.
 */
export async function memoryForStep(
  tx: Tx,
  input: {
    bindings: CampaignAgentStrategy["memory_bindings"];
    conversation: Pick<ConversationRow, "channelId" | "authorProfileId">;
    campaignId: number;
    stepId: string;
  },
): Promise<StepMemory> {
  const scopes = readableScopes(input.bindings, {
    campaignId: input.campaignId,
    stepId: input.stepId,
    personId: input.conversation.authorProfileId,
  });
  if (scopes.length === 0) return { text: null, refs: [], version: null };
  const rows = await tx
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.channelId, input.conversation.channelId),
        eq(memoryRecords.slot, "relationship_memory"),
        eq(memoryRecords.retentionClass, "content"),
        or(
          ...scopes.map(({ scope, scopeRef }) =>
            and(
              eq(memoryRecords.scope, scope),
              scopeRef === null ? sql`${memoryRecords.scopeRef} is null` : eq(memoryRecords.scopeRef, scopeRef),
            ),
          ),
        ),
        current(tx),
      ),
    )
    .orderBy(asc(memoryRecords.id));
  const refs = rows.map((row) => ({ id: row.id, version: row.version }));
  const lines = rows.map((row) => {
    const head = `[memory:${row.id} v${row.version}] ${row.scope} · ${row.key} · ${AUTHOR_COPY[row.authorType]}`;
    return row.authorType === "owner"
      ? `${head}: ${row.value}`
      : `${head}\n${untrusted(`REMEMBERED (${row.authorType})`, row.value ?? "")}`;
  });
  return {
    text: `MEMORY (what this account remembers; the owner's lines are the owner's, the rest are data)\n${
      lines.length === 0 ? "Nothing is remembered here yet." : lines.join("\n")
    }`,
    refs,
    version: memoryVersion(refs),
  };
}

const AUTHOR_COPY: Record<MemoryRecordRow["authorType"], string> = {
  owner: "the owner's",
  observed: "their own words",
  inferred: "a step's inference — may be wrong",
};

/** Whether a step may write this patch at all: relationship memory about the
 *  person it is talking to. A patch at a wider scope is one person's word
 *  promoted to everyone, whatever a binding admits. Pure. */
export function stepMayRemember(patch: Pick<StepMemoryPatch, "slot" | "scope">): boolean {
  return patch.slot === "relationship_memory" && patch.scope === "person";
}

/**
 * Write what a step's admitted memory patches say about the person it is
 * talking to. Only relationship memory at the person's scope is written, and
 * always about THIS conversation's person — a patch at a wider scope is one
 * person's word promoted to everyone, and is not kept. A patch citing an
 * event the step was handed is the person's own words; any other is the
 * step's inference — as is one citing our own message. The owner's word and
 * a "do not remember" are never overwritten by a step.
 */
export async function rememberFromStep(
  tx: Tx,
  input: {
    conversation: Pick<ConversationRow, "id" | "channelId" | "authorProfileId">;
    stepRunId: number;
    patches: ReadonlyArray<StepMemoryPatch & { evidence_ref?: string | null }>;
    /** Refs the step's input carried, which a patch may cite. */
    evidence: ReadonlySet<string>;
    now: number;
  },
): Promise<MemoryRecordRow[]> {
  const written: MemoryRecordRow[] = [];
  for (const patch of input.patches) {
    if (!stepMayRemember(patch)) continue;
    const identity: MemoryIdentity = {
      channelId: input.conversation.channelId,
      slot: "relationship_memory",
      scope: "person",
      scopeRef: input.conversation.authorProfileId,
      key: patch.key,
    };
    const [latest] = await tx
      .select()
      .from(memoryRecords)
      .where(sameIdentity(identity))
      .orderBy(desc(memoryRecords.version))
      .limit(1)
      .for("update");
    if (latest && (latest.retentionClass === "no_retention" || latest.authorType === "owner")) continue;
    if (latest?.value === patch.value) continue;
    const cited = await theirWords(tx, input.conversation.id, patch.evidence_ref, input.evidence);
    const [row] = await tx
      .insert(memoryRecords)
      .values({
        ...identity,
        value: patch.value,
        sourceRef: cited ?? `step_run:${input.stepRunId}`,
        authorType: cited ? "observed" : "inferred",
        observedAt: input.now,
        version: (latest?.version ?? 0) + 1,
        supersedesId: latest?.id ?? null,
        createdAt: input.now,
      })
      .returning();
    written.push(row!);
  }
  return written;
}

/** Where a finding the owner asked for was read: a page's address, or the
 *  person's LinkedIn through the account's own reads. */
export const RESEARCH_SOURCE = "research:";

/** Whether a memory is a finding kept from a look-up the owner asked for. */
export function isResearchFinding(record: Pick<MemoryRecordRow, "sourceRef">): boolean {
  return record.sourceRef.startsWith(RESEARCH_SOURCE);
}

/**
 * Keep what a look-up the owner asked for found about one person: a memory
 * at the person's scope, named by its topic, with where it was read. It is
 * what a page said, so it is kept as an inference that can be wrong, never as
 * the owner's word or the person's; a finding on the same topic replaces the
 * one before as a new version. The owner's own word on a topic, and their "do
 * not remember this", stand: null where one does.
 */
export async function rememberResearch(
  tx: Tx,
  input: { channelId: number; personId: string; topic: string; value: string; source: string; now: number },
): Promise<MemoryRecordRow | null> {
  const identity: MemoryIdentity = {
    channelId: input.channelId,
    slot: "relationship_memory",
    scope: "person",
    scopeRef: input.personId,
    key: `research: ${input.topic.trim()}`,
  };
  const [latest] = await tx
    .select()
    .from(memoryRecords)
    .where(sameIdentity(identity))
    .orderBy(desc(memoryRecords.version))
    .limit(1)
    .for("update");
  if (latest && (latest.retentionClass === "no_retention" || latest.authorType === "owner")) return null;
  const value = input.value.trim();
  if (latest?.value === value) return latest;
  const [row] = await tx
    .insert(memoryRecords)
    .values({
      ...identity,
      value,
      sourceRef: `${RESEARCH_SOURCE}${input.source}`,
      authorType: "inferred",
      observedAt: input.now,
      version: (latest?.version ?? 0) + 1,
      supersedesId: latest?.id ?? null,
      createdAt: input.now,
    })
    .returning();
  return row!;
}

/** The events that hold the person's own words: their replies and their
 *  messages, never ours. */
const THEIR_WORDS = ["reply_observed", "reply_edited", "inbound_message_observed"] as const;

/** The ref a patch cites, where it is an event the step was handed that holds
 *  the person's own words on this conversation; else null. */
async function theirWords(
  tx: Tx,
  conversationId: number,
  ref: string | null | undefined,
  handed: ReadonlySet<string>,
): Promise<string | null> {
  if (!ref || !handed.has(ref) || !/^event:\d+$/.test(ref)) return null;
  const [event] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.id, Number(ref.slice("event:".length))),
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, [...THEIR_WORDS]),
      ),
    );
  return event ? ref : null;
}

/** The memory in force where an approval's step read it: the digest of the
 *  refs it was handed that are still the memory in force — what moves when
 *  one of them is edited or forgotten. Null for a step that read none. */
export async function currentMemoryVersion(
  tx: Tx,
  stepRunId: number | null,
  bound: string | null,
): Promise<string | null> {
  if (bound === null || stepRunId === null) return bound;
  const [checkpoint] = await tx
    .select({ refs: stepRuns.memoryRefs })
    .from(stepRuns)
    .where(eq(stepRuns.id, stepRunId));
  const refs = checkpoint?.refs ?? [];
  if (refs.length === 0) return null;
  const standing = await tx
    .select({ id: memoryRecords.id })
    .from(memoryRecords)
    .where(and(inArray(memoryRecords.id, refs.map((ref) => ref.id)), current(tx)));
  const ids = new Set(standing.map((row) => row.id));
  return memoryVersion(refs.filter((ref) => ids.has(ref.id)));
}

/** The memory in force, newest first — a person's, a campaign's, or all of
 *  the account's. */
export async function listMemory(
  tx: Tx,
  filter: { personId?: string; campaignId?: number; limit?: number } = {},
): Promise<MemoryRecordRow[]> {
  const where: SQL[] = [current(tx)];
  if (filter.personId !== undefined) {
    where.push(eq(memoryRecords.scope, "person"), eq(memoryRecords.scopeRef, filter.personId));
  }
  if (filter.campaignId !== undefined) {
    where.push(
      or(
        and(eq(memoryRecords.scope, "campaign"), eq(memoryRecords.scopeRef, String(filter.campaignId))),
        and(eq(memoryRecords.scope, "step"), sql`${memoryRecords.scopeRef} like ${`${filter.campaignId}:%`}`),
      )!,
    );
  }
  return tx
    .select()
    .from(memoryRecords)
    .where(and(...where))
    .orderBy(desc(memoryRecords.createdAt), desc(memoryRecords.id))
    .limit(Math.min(filter.limit ?? 100, 100));
}

/**
 * What a conversation's steps may be handed of what the account remembers —
 * the person's own, each campaign's it runs in and their steps', and the
 * account's — with the owner's "do not remember this" markers among them, on
 * the conversation's account. The memory in force only, newest first.
 */
export async function memoryForConversation(
  tx: Tx,
  at: { channelId: number; personId: string; campaignIds: readonly number[] },
): Promise<MemoryRecordRow[]> {
  const campaigns = at.campaignIds.map(String);
  return tx
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.channelId, at.channelId),
        current(tx),
        or(
          and(eq(memoryRecords.scope, "person"), eq(memoryRecords.scopeRef, at.personId)),
          eq(memoryRecords.scope, "account"),
          ...(campaigns.length === 0
            ? []
            : [
                and(eq(memoryRecords.scope, "campaign"), inArray(memoryRecords.scopeRef, campaigns)),
                and(
                  eq(memoryRecords.scope, "step"),
                  or(...campaigns.map((id) => sql`${memoryRecords.scopeRef} like ${`${id}:%`}`)),
                ),
              ]),
        ),
      ),
    )
    .orderBy(desc(memoryRecords.createdAt), desc(memoryRecords.id))
    .limit(100);
}

async function memoryRow(tx: Tx, memoryId: number): Promise<MemoryRecordRow> {
  const [row] = await tx.select().from(memoryRecords).where(eq(memoryRecords.id, memoryId));
  if (!row) {
    throw new MemoryError(
      "memory_not_found",
      `Memory ${memoryId} not found in this organization.`,
      "Read the ids with search_knowledge; a forgotten memory is gone.",
    );
  }
  return row;
}

async function lockMemory(tx: Tx, memoryId: number): Promise<{ row: MemoryRecordRow; versions: MemoryRecordRow[] }> {
  const row = await memoryRow(tx, memoryId);
  const versions = await tx
    .select()
    .from(memoryRecords)
    .where(sameIdentity(row))
    .orderBy(asc(memoryRecords.version))
    .for("update");
  return { row, versions };
}

/** The checkpoints that were handed any of these memory versions. */
function boundTo(ids: readonly number[]): SQL {
  return or(...ids.map((id) => sql`${stepRuns.memoryRefs} @> ${JSON.stringify([{ id }])}::jsonb`))!;
}

export type MemoryInspection = {
  memory: MemoryRecordRow;
  history: MemoryRecordRow[];
  /** Why it is used: every checkpoint that read a version of it, and what
   *  those checkpoints proposed. */
  boundBy: Array<{
    stepRunId: number;
    conversationId: number;
    campaignId: number;
    stepId: string;
    status: string;
    version: number;
    redactedAt: number | null;
    actions: Array<{ id: number; kind: string; status: string }>;
    replies: number[];
  }>;
};

export async function inspectMemory(tx: Tx, memoryId: number): Promise<MemoryInspection> {
  const { versions } = await lockMemory(tx, memoryId);
  const ids = versions.map((version) => version.id);
  const checkpoints = await tx
    .select()
    .from(stepRuns)
    .where(boundTo(ids))
    .orderBy(asc(stepRuns.id));
  const queued =
    checkpoints.length === 0
      ? []
      : await tx
          .select({
            id: actions.id,
            kind: actions.kind,
            status: actions.status,
            stepRunId: actions.stepRunId,
          })
          .from(actions)
          .where(inArray(actions.stepRunId, checkpoints.map((checkpoint) => checkpoint.id)));
  return {
    memory: versions.at(-1)!,
    history: versions,
    boundBy: checkpoints.map((checkpoint) => ({
      stepRunId: checkpoint.id,
      conversationId: checkpoint.conversationId,
      campaignId: checkpoint.campaignId,
      stepId: checkpoint.stepId,
      status: checkpoint.status,
      version: checkpoint.memoryRefs.find((ref) => ids.includes(ref.id))!.version,
      redactedAt: checkpoint.redactedAt,
      actions: queued
        .filter((action) => action.stepRunId === checkpoint.id)
        .map(({ id, kind, status }) => ({ id, kind, status })),
      replies: replyDrafts(checkpoint.drafts),
    })),
  };
}

const replyDrafts = (drafts: (typeof stepRuns.$inferSelect)["drafts"]): number[] =>
  drafts.flatMap((draft) => (draft.kind === "reply" ? [draft.messageId] : []));

export type Invalidated = {
  checkpoints: number[];
  cancelledActions: number[];
  invalidatedApprovals: number;
  withdrawnReplies: number[];
};

// What an edit or a forget stops resting on a memory, one predicate each, so
// what `previewForget` tells the owner and what `invalidateDependents` then
// does are the same rows read twice rather than two answers.

/** The sends cancelled: queued, so nothing has clicked. */
const queuedOn = (checkpointIds: readonly number[]): SQL =>
  and(
    inArray(actions.stepRunId, [...checkpointIds]),
    inArray(actions.status, QUEUED_STATUSES),
  )!;

/** The yeses that stop holding with them: neither spent nor already void. */
const standingApprovalOf = (actionIds: readonly number[]): SQL =>
  and(
    inArray(actionApprovals.actionExecutionId, [...actionIds]),
    isNull(actionApprovals.usedAt),
    isNull(actionApprovals.invalidatedAt),
  )!;

/** The drafted replies withdrawn: a worker's, and not yet sent. */
const unsentDraftIn = (messageIds: readonly number[]): SQL =>
  and(
    inArray(messages.id, [...messageIds]),
    inArray(messages.status, ["proposed", "approved"]),
    eq(messages.publishOrigin, "worker"),
  )!;

/** The checkpoints ended: still waiting on a word or a yes. */
const stillWaitingIn = (checkpointIds: readonly number[]): SQL =>
  and(inArray(stepRuns.id, [...checkpointIds]), inArray(stepRuns.status, ["waiting", "needs_approval"]))!;

/**
 * Everything that rested on these memory versions, made to stop resting on
 * them: queued sends cancelled with their approvals, unsent drafted replies
 * withdrawn, and waiting checkpoints ended — never one already sent, which is
 * history. A send past dispatch stays where the click left it.
 */
async function invalidateDependents(
  tx: Tx,
  ids: readonly number[],
  reason: "memory_edited" | "memory_forgotten",
  now: number,
): Promise<{ rows: Array<typeof stepRuns.$inferSelect>; invalidated: Invalidated }> {
  const rows = await tx.select().from(stepRuns).where(boundTo(ids)).for("update");
  const checkpointIds = rows.map((row) => row.id);
  if (checkpointIds.length === 0) {
    return {
      rows,
      invalidated: { checkpoints: [], cancelledActions: [], invalidatedApprovals: 0, withdrawnReplies: [] },
    };
  }
  const cancelled = await tx
    .update(actions)
    .set({ status: "cancelled", statusReason: reason, settledAt: now, updatedAt: now })
    .where(queuedOn(checkpointIds))
    .returning({ id: actions.id });
  const approvals =
    cancelled.length === 0
      ? []
      : await tx
          .update(actionApprovals)
          .set({ invalidatedAt: now, invalidatedReason: "memory" })
          .where(standingApprovalOf(cancelled.map((row) => row.id)))
          .returning({ id: actionApprovals.id });
  const replyIds = rows.flatMap((row) => replyDrafts(row.drafts));
  const withdrawn =
    replyIds.length === 0
      ? []
      : await tx
          .update(messages)
          .set({ status: "rejected", error: reason, scheduledAt: null })
          .where(unsentDraftIn(replyIds))
          .returning({ id: messages.id });
  await tx
    .update(stepRuns)
    .set({ status: "blocked", blockedReason: reason, wait: null, finishedAt: now, updatedAt: now })
    .where(stillWaitingIn(checkpointIds));
  return {
    rows,
    invalidated: {
      checkpoints: checkpointIds,
      cancelledActions: cancelled.map((row) => row.id),
      invalidatedApprovals: approvals.length,
      withdrawnReplies: withdrawn.map((row) => row.id),
    },
  };
}

/**
 * The owner's edit — or correction — of a memory: a new version in their own
 * words, which outranks whatever said it before. Only the memory in force can
 * be edited; what rested on the old version is invalidated (`Invalidated`).
 */
export async function editMemory(
  tx: Tx,
  input: { memoryId: number; value: string; by: string; now?: number },
): Promise<{ memory: MemoryRecordRow; invalidated: Invalidated }> {
  const now = input.now ?? Date.now();
  const { row, versions } = await lockMemory(tx, input.memoryId);
  const latest = versions.at(-1)!;
  if (latest.id !== row.id) {
    throw new MemoryError(
      "memory_superseded",
      `Memory ${row.id} is version ${row.version}; version ${latest.version} (memory ${latest.id}) replaced it.`,
      `Edit memory ${latest.id}, the one in force.`,
    );
  }
  if (row.retentionClass === "no_retention") {
    throw new MemoryError(
      "memory_not_editable",
      `Memory ${row.id} is the owner's "do not remember this", not something remembered.`,
      "Only the owner lifts it in Engager.",
    );
  }
  const value = input.value.trim();
  const [memory] = await tx
    .insert(memoryRecords)
    .values({
      channelId: row.channelId,
      slot: row.slot,
      scope: row.scope,
      scopeRef: row.scopeRef,
      key: row.key,
      value,
      sourceRef: input.by,
      authorType: "owner",
      observedAt: now,
      version: row.version + 1,
      supersedesId: row.id,
      createdAt: now,
    })
    .returning();
  const { invalidated } = await invalidateDependents(
    tx,
    versions.map((version) => version.id),
    "memory_edited",
    now,
  );
  return { memory: memory!, invalidated };
}

/** The checkpoints whose admitted patches said this memory: a step writes
 *  only about the person on its own conversation, so they are that person's
 *  conversations on the account. */
async function writersOf(tx: Tx, memory: MemoryIdentity): Promise<Array<typeof stepRuns.$inferSelect>> {
  if (memory.scope !== "person" || memory.scopeRef === null) return [];
  const found = await tx
    .select({ checkpoint: stepRuns })
    .from(stepRuns)
    .innerJoin(conversations, eq(conversations.id, stepRuns.conversationId))
    .where(
      and(
        eq(conversations.channelId, memory.channelId),
        eq(conversations.authorProfileId, memory.scopeRef),
        sql`${stepRuns.memoryPatches} @> ${JSON.stringify([{ slot: memory.slot, scope: memory.scope, key: memory.key }])}::jsonb`,
      ),
    );
  return found.map((row) => row.checkpoint);
}

export type ForgetOutcome = {
  forgotten: number[];
  invalidated: Invalidated;
  /** Checkpoints its content was taken out of. */
  redacted: number[];
  /** A "do not remember this" left in its place. */
  suppressed: MemoryRecordRow | null;
  /** What forgetting does not remove, and why — said so nothing is silently
   *  kept. */
  kept: Array<{ record: "do_not_engage"; profileId: string; basis: string }>;
};

/**
 * Forget a memory: every version deleted, what rested on it invalidated, and
 * its content taken out of the checkpoints that were handed it — the patches
 * that wrote it, the drafts held there, and the summary that may restate it.
 * With `doNotRemember`, a marker keeps it from being remembered again in the
 * same place. An exclusion of the person stays: forgetting never lifts one,
 * and the answer says it was kept.
 *
 * A "do not remember this" is the owner's opt-out, not something remembered:
 * forget refuses it, and only `allowRemembering` — its own, explicit owner
 * action — lifts it.
 */
export async function forgetMemory(
  tx: Tx,
  input: { memoryId: number; by: string; doNotRemember?: boolean; now?: number },
): Promise<ForgetOutcome> {
  const now = input.now ?? Date.now();
  const { row, versions } = await lockMemory(tx, input.memoryId);
  refuseMarker(row);
  const ids = versions.map((version) => version.id);
  const { rows, invalidated } = await invalidateDependents(tx, ids, "memory_forgotten", now);
  // Read by these, and written by the steps whose patches said it: the
  // content comes out of both; only what rested on it is invalidated.
  const writers = await writersOf(tx, row);
  const carried = [...rows, ...writers.filter((writer) => !rows.some((reader) => reader.id === writer.id))];
  for (const checkpoint of carried) {
    await tx
      .update(stepRuns)
      .set({
        memoryRefs: checkpoint.memoryRefs.filter((ref) => !ids.includes(ref.id)),
        memoryPatches: checkpoint.memoryPatches.filter(
          (patch) => !(patch.slot === row.slot && patch.scope === row.scope && patch.key === row.key),
        ),
        drafts: rows.includes(checkpoint) ? checkpoint.drafts.filter((draft) => draft.kind !== "dm") : checkpoint.drafts,
        rationaleSummary: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(eq(stepRuns.id, checkpoint.id));
  }
  await tx.delete(memoryRecords).where(inArray(memoryRecords.id, ids));
  const [suppressed] = input.doNotRemember
    ? await tx
        .insert(memoryRecords)
        .values({
          channelId: row.channelId,
          slot: row.slot,
          scope: row.scope,
          scopeRef: row.scopeRef,
          key: row.key,
          value: null,
          sourceRef: input.by,
          authorType: "owner",
          observedAt: now,
          retentionClass: "no_retention",
          createdAt: now,
        })
        .returning()
    : [];
  return {
    forgotten: ids,
    invalidated,
    redacted: carried.map((checkpoint) => checkpoint.id),
    suppressed: suppressed ?? null,
    kept: await keptOnForget(tx, row),
  };
}

/** A "do not remember this" is the owner's opt-out, not something remembered:
 *  forgetting refuses it, and so does the preview of a forget. */
function refuseMarker(row: MemoryRecordRow): void {
  if (row.retentionClass !== "no_retention") return;
  throw new MemoryError(
    "memory_not_forgettable",
    `Memory ${row.id} is the owner's "do not remember this", not something remembered, so forgetting does not touch it.`,
    "Only the owner lifts it in Engager.",
  );
}

/** What forgetting this memory leaves exactly where it is: the person's
 *  exclusion, which is not a memory. */
async function keptOnForget(tx: Tx, row: MemoryRecordRow): Promise<ForgetOutcome["kept"]> {
  if (row.scope !== "person" || row.scopeRef === null) return [];
  const [person] = await tx
    .select({ excluded: engagedProfiles.doNotEngage })
    .from(engagedProfiles)
    .where(eq(engagedProfiles.profileId, row.scopeRef));
  if (!person?.excluded) return [];
  return [
    {
      record: "do_not_engage",
      profileId: row.scopeRef,
      basis: "They are on this account's do-not-engage list. Forgetting what was remembered never lifts that; only removing them from the list does.",
    },
  ];
}

export type ForgetPreview = {
  memory: MemoryRecordRow;
  /** What a forget would stop resting on it, as it stands now. */
  invalidates: {
    /** Steps still waiting on a word or a yes, which it would end. */
    checkpoints: Array<{ stepRunId: number; conversationId: number; campaignId: number; stepId: string }>;
    /** Queued sends it would cancel. */
    actions: Array<{ id: number; kind: ActionKind; targetKind: string; status: ActionStatus }>;
    /** The yeses on those sends that would stop holding. */
    approvals: number;
    /** Drafted replies, not yet sent, it would withdraw. */
    replies: number[];
  };
  /** How many step records its content would be taken out of. */
  redacts: number;
  kept: ForgetOutcome["kept"];
};

/**
 * What forgetting this memory would invalidate, read and not done: the rows
 * `forgetMemory` acts on, by the same predicates, so the owner is told what
 * the forget will take before they confirm it. Refused as a forget is — a
 * "do not remember this" is not forgotten — and it changes nothing.
 */
export async function previewForget(tx: Tx, memoryId: number): Promise<ForgetPreview> {
  const row = await memoryRow(tx, memoryId);
  refuseMarker(row);
  const versions = await tx.select({ id: memoryRecords.id }).from(memoryRecords).where(sameIdentity(row));
  const readers = await tx.select().from(stepRuns).where(boundTo(versions.map((version) => version.id)));
  const checkpointIds = readers.map((reader) => reader.id);
  const replyIds = readers.flatMap((reader) => replyDrafts(reader.drafts));
  const queued =
    checkpointIds.length === 0
      ? []
      : await tx
          .select({
            id: actions.id,
            kind: actions.kind,
            targetKind: sql<string>`${actions.target} ->> 'kind'`,
            status: actions.status,
          })
          .from(actions)
          .where(queuedOn(checkpointIds))
          .orderBy(asc(actions.id));
  const [approvals] =
    queued.length === 0
      ? [{ n: 0 }]
      : await tx
          .select({ n: count() })
          .from(actionApprovals)
          .where(standingApprovalOf(queued.map((action) => action.id)));
  const replies =
    replyIds.length === 0
      ? []
      : await tx.select({ id: messages.id }).from(messages).where(unsentDraftIn(replyIds)).orderBy(asc(messages.id));
  const waiting =
    checkpointIds.length === 0
      ? []
      : await tx
          .select({
            stepRunId: stepRuns.id,
            conversationId: stepRuns.conversationId,
            campaignId: stepRuns.campaignId,
            stepId: stepRuns.stepId,
          })
          .from(stepRuns)
          .where(stillWaitingIn(checkpointIds))
          .orderBy(asc(stepRuns.id));
  const writers = await writersOf(tx, row);
  return {
    memory: row,
    invalidates: {
      checkpoints: waiting,
      actions: queued,
      approvals: approvals?.n ?? 0,
      replies: replies.map((reply) => reply.id),
    },
    redacts: new Set([...checkpointIds, ...writers.map((writer) => writer.id)]).size,
    kept: await keptOnForget(tx, row),
  };
}

/**
 * The owner's own lift of a "do not remember this": the marker goes, and what
 * a step says there may be remembered again from then on. Nothing else lifts
 * it — not a forget, an edit or a step.
 */
export async function allowRemembering(
  tx: Tx,
  input: { memoryId: number },
): Promise<{ lifted: number }> {
  const { row } = await lockMemory(tx, input.memoryId);
  if (row.retentionClass !== "no_retention") {
    throw new MemoryError(
      "memory_not_a_marker",
      `Memory ${row.id} is something remembered, not a "do not remember this".`,
      "Use save_knowledge to edit it, or confirm deletion in Engager.",
    );
  }
  await tx.delete(memoryRecords).where(eq(memoryRecords.id, row.id));
  return { lifted: row.id };
}
