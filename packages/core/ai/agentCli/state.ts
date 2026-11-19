import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AgentCliError } from "./types";
import { parseUsageLimitReset } from "./usageLimit";

export const selectionSchema = z
  .object({
    purpose: z.enum(["background", "chat"]),
    absoluteExecutable: z.string(),
    realPath: z.string(),
    executableIdentity: z.string(),
    observedVersion: z.string(),
    adapterId: z.string(),
    modelRef: z.string(),
    providerRef: z.string(),
    authRoute: z.string(),
    authStorePath: z.string().optional(),
    configRevision: z.string(),
    capabilityEvidence: z.array(z.string()),
    missingCapabilities: z.array(z.string()),
  })
  .strict();

const claimSchema = z
  .object({
    id: z.string(),
    pid: z.number().int().positive(),
    order: z.number().int(),
    queuedAt: z.number(),
    purpose: z.enum(["background", "chat"]),
    conversationKey: z.string().optional(),
    pgid: z.number().int().positive().optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    revision: z.string(),
    sequence: z.number().int().nonnegative(),
    backgroundSelection: selectionSchema.optional(),
    chatSelection: selectionSchema.optional(),
    roles: z.record(z.string()),
    queue: z.array(claimSchema),
    active: z.array(claimSchema),
  })
  .strict();
export type LocalAgentState = z.infer<typeof stateSchema>;
export type AgentClaim = z.infer<typeof claimSchema>;

/**
 * Where THIS installation keeps its agent selections. An explicit
 * `ENGAGER_LOCAL_AGENT_STATE_DIR` is the owner's (and the test harness's) and
 * always wins; below it the state belongs to the installation root, so a core
 * installed under a custom `ENGAGER_HOME` keeps its own selections instead of
 * reaching into the default home's — two installs on one machine each pin
 * their own executable, and removing one leaves the other's pin alone.
 */
export function agentStateDirectory(): string {
  const override = process.env.ENGAGER_LOCAL_AGENT_STATE_DIR;
  if (override) return override;
  return join(
    process.env.ENGAGER_HOME ?? join(homedir(), ".engager"),
    "local-agents",
  );
}

export function agentFailure(code: string): AgentCliError {
  // Never include subprocess output, settings contents, or input in an error.
  return new AgentCliError(code, { code });
}

export function agentReportedFailure(value: unknown): AgentCliError {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (
    /authentication_required|not logged in|unauthorized|login required|invalid.*api.?key|failed to authenticate|oauth (?:session|token) (?:has )?expired/i.test(
      text,
    )
  )
    return agentFailure("authentication_required");
  if (
    /quota_exhausted|usage limit|hit your limit|limit reached|quota exceeded|rate_limit_exceeded/i.test(
      text,
    )
  ) {
    // The reset is the one thing kept of what the CLI said, as a number.
    const resetsAt = parseUsageLimitReset(text);
    return resetsAt === undefined
      ? agentFailure("quota_exhausted")
      : new AgentCliError("quota_exhausted", { code: "quota_exhausted", resetsAt });
  }
  return agentFailure("agent_reported_failure");
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function readAgentState(): Promise<LocalAgentState> {
  try {
    return stateSchema.parse(
      JSON.parse(
        await readFile(join(agentStateDirectory(), "state.json"), "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: 1,
        revision: "unconfigured",
        sequence: 0,
        roles: {},
        queue: [],
        active: [],
      };
    }
    throw agentFailure("agent_state_invalid");
  }
}

/**
 * One bounded, non-stealing lock inside the agent state directory, named so a
 * caller can serialize its own read-modify-write. A crashed lock is
 * deliberately not stolen by age: an uncertain child must block reuse.
 */
export async function withAgentLock<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const directory = agentStateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, `${name}.lock`);
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw agentFailure("agent_state_unavailable");
      if (Date.now() >= deadline)
        throw agentFailure("agent_state_locked_recovery_required");
      await delay(20);
    }
  }
  try {
    await handle.writeFile(String(process.pid));
    return await work();
  } finally {
    await handle.close();
    await unlink(lock);
  }
}

/** One installation-wide lock covers configuration and admission. */
export async function mutateAgentState<T>(
  change: (state: LocalAgentState) => T,
): Promise<T> {
  return withAgentLock("state", async () => {
    const directory = agentStateDirectory();
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      const state = await readAgentState();
      const result = change(state);
      stateSchema.parse(state);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(directory, "state.json"));
      return result;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
}

/**
 * What an aborted signal means. A deadline that ran out — `AbortSignal.timeout`,
 * alone or inside `AbortSignal.any` — is `agent_timeout`; anything else is a
 * caller's deliberate `agent_canceled`. The two send an owner to different
 * fixes, and a slow model reported as a cancel reads as a hang.
 */
export function abortFailureCode(
  signal: AbortSignal,
): "agent_timeout" | "agent_canceled" {
  return (signal.reason as { name?: unknown } | undefined)?.name ===
    "TimeoutError"
    ? "agent_timeout"
    : "agent_canceled";
}

export function assertNotCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw agentFailure(abortFailureCode(signal));
}

/** FIFO tickets persist across dashboard/worker/MCP processes. Dead waiters
 * may be removed; active claims are never expired while teardown is uncertain. */
export async function acquireAgentClaim(input: {
  purpose: "background" | "chat";
  conversationKey?: string;
  signal?: AbortSignal;
  waitMs?: number;
  concurrency?: number;
}): Promise<{
  id: string;
  attach: (pgid: number) => Promise<void>;
  release: () => Promise<void>;
}> {
  assertNotCanceled(input.signal);
  const concurrency = input.concurrency ?? 2;
  const waitMs = input.waitMs ?? 180_000;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 2 ||
    waitMs < 1 ||
    waitMs > 300_000
  ) {
    throw agentFailure("agent_limits_invalid");
  }
  const claim: AgentClaim = {
    id: randomUUID(),
    pid: process.pid,
    order: 0,
    queuedAt: Date.now(),
    purpose: input.purpose,
    ...(input.conversationKey
      ? { conversationKey: input.conversationKey }
      : {}),
  };
  await mutateAgentState((state) => {
    state.queue = state.queue.filter((entry) => processExists(entry.pid));
    if (state.queue.length >= 32) throw agentFailure("agent_queue_full");
    claim.order = ++state.sequence;
    state.queue.push(claim);
  });
  try {
    while (true) {
      assertNotCanceled(input.signal);
      if (Date.now() - claim.queuedAt >= waitMs)
        throw agentFailure("agent_queue_timeout");
      const admitted = await mutateAgentState((state) => {
        assertNotCanceled(input.signal);
        state.queue = state.queue.filter((entry) => processExists(entry.pid));
        // A claim whose holder died before releasing it, and whose agent
        // child is gone too, holds a slot no one will ever give back.
        state.active = state.active.filter((entry) => processExists(entry.pid) || (entry.pgid !== undefined && processExists(-entry.pgid)));
        const next = state.queue[0];
        if (next?.id !== claim.id || state.active.length >= concurrency)
          return false;
        if (
          claim.conversationKey &&
          state.active.some(
            (entry) => entry.conversationKey === claim.conversationKey,
          )
        )
          return false;
        state.queue.shift();
        state.active.push(claim);
        return true;
      });
      if (admitted) break;
      await delay(25);
    }
  } catch (error) {
    await mutateAgentState((state) => {
      state.queue = state.queue.filter((entry) => entry.id !== claim.id);
    });
    throw error;
  }
  return {
    id: claim.id,
    attach: (pgid) =>
      mutateAgentState((state) => {
        const current = state.active.find(
          (entry) => entry.id === claim.id && entry.pid === process.pid,
        );
        if (!current) throw agentFailure("agent_lease_lost");
        current.pgid = pgid;
      }),
    release: () =>
      mutateAgentState((state) => {
        const current = state.active.find((entry) => entry.id === claim.id);
        if (current?.pgid && processExists(-current.pgid))
          throw agentFailure("agent_teardown_unconfirmed");
        state.active = state.active.filter((entry) => entry.id !== claim.id);
      }),
  };
}
