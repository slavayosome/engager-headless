import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { currentUsageContext } from "../usage";
import {
  agentChildEnvironment,
  assertSelectionRoute,
  importExistingAgentPin,
  storedAgentSelection,
  verifyAgentSelection,
} from "./selection";
import {
  abortFailureCode,
  acquireAgentClaim,
  agentFailure,
  assertNotCanceled,
  processExists,
  readAgentState,
} from "./state";
import { verifyIsolationProfile } from "./isolation";
import { offeredModelIds, storedCatalog } from "./catalog";
import { readSelectedEffort } from "./effort";
import {
  AgentCliError,
  type AgentCliAdapter,
  type AgentCliRequest,
  type AgentCliResult,
  type AgentEvent,
  type AgentModelCatalog,
  type ResolvedAgentSelection,
} from "./types";

const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_ANSWER_BYTES = 256 * 1024;

/** A parent can close while a helper it spawned is still in its own exit
 *  sequence — a reaper, a language runtime's supervisor. One short FIXED window
 *  separates that ordinary tail from a descendant that actually outlived its
 *  parent; it is never a verdict that a surviving group is harmless, and no
 *  environment switch or caller option can widen it. */
const NATURAL_DRAIN_MS = 500;

function judgmentTimeout(): number {
  const configured = process.env.ENGAGER_AGENT_CLI_TIMEOUT_MS;
  if (!configured) return 180_000;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 1 || value > 180_000)
    throw agentFailure("agent_limits_invalid");
  return value;
}

/** Cancellation settles only after the owned process group is gone. An
 * unconfirmed teardown leaves its durable installation-wide claim held. */
export const runAgentCli = createAgentExecutor();

/** The isolation boundary is injectable for offline native-policy conformance.
 * Production callers use the reviewed verifier; no environment bypass exists. */
export function createAgentExecutor(verifyIsolation = verifyIsolationProfile) {
  // Passed selection verifications, remembered for this executor's life — the
  // production executor is the process-wide `runAgentCli`. A key is added only
  // after the full verification passes, so a refusal is re-asked (and
  // re-refused) on every call. The key is recomputed from the file on every
  // call, so a replaced binary — new inode, mtime or size — never matches the
  // old pass. Only the selection half is remembered: it is the hash and the
  // `--version` spawn. Isolation runs in full on every call, because its
  // policy questions (a managed-settings file can appear at any time) are
  // about the machine, not the binary; its own probe spawns are remembered
  // inside `isolation.ts`.
  const verified = new Set<string>();
  async function verifySelectionOnce(
    adapter: AgentCliAdapter,
    frozen: ResolvedAgentSelection,
    evidence: AgentModelCatalog | undefined,
  ): Promise<void> {
    // The route question is per model and costs no spawn or hash, so it is
    // asked on every call even when the binary's pass is remembered.
    assertSelectionRoute(adapter.descriptor, frozen, evidence);
    const key = await verificationKey(adapter.id, frozen);
    if (key !== undefined && verified.has(key)) return;
    await verifyAgentSelection(adapter.descriptor, frozen, evidence);
    if (key !== undefined) verified.add(key);
  }
  return async function run(
    adapter: AgentCliAdapter,
    request: AgentCliRequest,
    opts: {
      signal?: AbortSignal | undefined;
      onEvent?: (event: AgentEvent) => void;
      onSelection?: (selection: ResolvedAgentSelection) => void;
    } = {},
  ): Promise<AgentCliResult> {
    assertNotCanceled(opts.signal);
    if (request.webSearch) throw agentFailure("grounding_evidence_required");
    if (request.webResearch && !adapter.supportsWebResearch)
      throw agentFailure("web_research_unsupported");
    const selection = structuredClone(
      request.frozenSelection ??
        currentUsageContext()?.localAgentSelection ??
        storedAgentSelection("background") ??
        (await importExistingAgentPin(adapter, request.model)),
    );
    if (selection.adapterId !== adapter.id)
      throw agentFailure("agent_selection_conflict");
    const explicitBin =
      (adapter.id === "claude"
        ? currentUsageContext()?.agentBin
        : adapter.executableOverrideEnv
          ? process.env[adapter.executableOverrideEnv]
          : undefined) ?? process.env.ENGAGER_AGENT_CLI_BIN;
    if (explicitBin && explicitBin !== selection.absoluteExecutable)
      throw agentFailure("agent_selection_conflict");
    // The owner's effort belongs to the model they picked (`effort.ts` binds
    // it to that model). A call for another model — a role pointed elsewhere —
    // runs at that model's own default rather than at a level it may not take.
    const { effort: _carried, ...withoutEffort } = selection;
    const effort = readSelectedEffort(selection.configRevision, request.model);
    const frozen = {
      ...withoutEffort,
      modelRef: request.model,
      ...(effort ? { effort } : {}),
    };
    opts.onSelection?.(structuredClone(frozen));
    // The model is admitted by the selection's own record, or by the complete
    // list this exact installation last reported. The record alone refused a
    // model a role legitimately runs on — the newest of its family, which the
    // role resolution substitutes for an id the installation no longer
    // offers — because no save ever recorded it. A list that is not complete
    // says nothing about what runs. Read once and reused after the queue wait:
    // the call keeps the evidence it was admitted on, as it keeps its
    // selection.
    const reported = await storedCatalog(frozen, adapter.descriptor);
    const evidence = offeredModelIds(reported) ? reported : undefined;
    const listed = reported?.options.find((option) => option.id === request.model)?.efforts;
    if (!frozen.effort && request.stageEffort && listed?.includes(request.stageEffort)) {
      frozen.effort = request.stageEffort;
    }
    await verifySelectionOnce(adapter, frozen, evidence);
    await verifyIsolation(adapter, frozen, isolationOptions(opts.signal));
    const requestId = request.requestId ?? randomUUID();
    const concurrency = process.env.ENGAGER_AGENT_CLI_CONCURRENCY
      ? Number(process.env.ENGAGER_AGENT_CLI_CONCURRENCY)
      : 2;
    const claim = await acquireAgentClaim({
      purpose: frozen.purpose,
      concurrency,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    let cwd: string | undefined;
    let failed = false;
    let teardownUnconfirmed = false;
    try {
      assertNotCanceled(opts.signal);
      if (!request.preflight) {
        const state = await readAgentState();
        const current = state[`${frozen.purpose}Selection`];
        if (!current || current.configRevision !== frozen.configRevision)
          throw agentFailure("agent_selection_stale");
      }
      await verifySelectionOnce(adapter, frozen, evidence);
      await verifyIsolation(adapter, frozen, isolationOptions(opts.signal));
      assertNotCanceled(opts.signal);
      cwd = await mkdtemp(join(tmpdir(), "engager-request-"));
      const schemaFile = request.jsonSchema
        ? join(cwd, "response-schema.json")
        : undefined;
      if (schemaFile)
        await writeFile(schemaFile, JSON.stringify(request.jsonSchema), {
          mode: 0o600,
        });
      let input = JSON.stringify({
        system: request.system ?? "",
        user: request.user,
      });
      if (Buffer.byteLength(input) > MAX_STREAM_BYTES)
        throw agentFailure("agent_input_oversized");
      const preparedRequest = {
        ...request,
        frozenSelection: frozen,
        schemaFile,
        requestDirectory: cwd,
      };
      let env = agentChildEnvironment(frozen);
      if (adapter.prepareInvocation) {
        const invocation = await adapter.prepareInvocation(
          preparedRequest,
          env,
        );
        input = invocation.input;
        env = invocation.env;
      }
      if (Buffer.byteLength(input) > MAX_STREAM_BYTES)
        throw agentFailure("agent_input_oversized");
      const args = adapter.buildArgs(preparedRequest);
      assertNotCanceled(opts.signal);
      const output = await execute({
        bin: frozen.absoluteExecutable,
        args,
        input,
        cwd,
        env,
        signal: opts.signal,
        attach: claim.attach,
        timeoutMs: judgmentTimeout(),
        inspectLine: adapter.inspectOutputLine,
        classifyFailure: (stdout) => {
          try {
            adapter.parseResult(stdout);
          } catch (error) {
            if (
              error instanceof AgentCliError &&
              [
                "authentication_required",
                "quota_exhausted",
                "native_tool_attempt",
              ].includes(error.message)
            )
              // The error itself, not its code: a usage limit carries the
              // reset the adapter parsed (`cause.resetsAt`).
              return error;
          }
          return agentFailure("agent_process_failed");
        },
        started: () =>
          opts.onEvent?.({ kind: "started", requestId, adapterId: adapter.id }),
      });
      const result = adapter.parseResult(output);
      if (
        Buffer.byteLength(result.text) > MAX_ANSWER_BYTES ||
        Buffer.byteLength(JSON.stringify(result.structured ?? null)) >
          MAX_ANSWER_BYTES
      )
        throw agentFailure("agent_output_oversized");
      const completed: AgentCliResult = {
        ...result,
        requestId,
        adapterVersion: adapter.descriptor.adapterContractVersion,
        terminalState: "completed",
      };
      opts.onEvent?.({ kind: "usage", requestId, usage: result.usage });
      opts.onEvent?.({ kind: "result", requestId, result: completed });
      return completed;
    } catch (error) {
      failed = true;
      teardownUnconfirmed =
        error instanceof Error &&
        error.message === "agent_teardown_unconfirmed";
      if (error instanceof AgentCliError) throw new AgentCliError(error.message, { ...error.cause, adapterId: adapter.id });
      throw error;
    } finally {
      // An unconfirmed teardown keeps BOTH its slot and its request directory:
      // a group that outlived the kill may still be reading the schema file
      // written into it, and removing that directory underneath it is the one
      // side effect this path can still cause. Recovery is the operator's, as
      // the durable claim already says.
      if (!teardownUnconfirmed) {
        try {
          await claim.release();
        } catch (error) {
          // `release()` refuses while the owned group survives, and it throws
          // before it writes, so the slot is retained either way. It must not
          // replace the failure the caller is already being told about.
          if (!failed) throw error;
        }
        if (cwd) await rm(cwd, { recursive: true, force: true });
      }
    }
  };
}

async function execute(options: {
  bin: string;
  args: string[];
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  attach: (pgid: number) => Promise<void>;
  started: () => void;
  inspectLine?: ((line: string) => void) | undefined;
  classifyFailure: (stdout: string) => AgentCliError;
}): Promise<string> {
  const child = spawn(options.bin, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let failure: string | undefined;
  let stdout = "";
  let bytes = 0;
  let pendingLine = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    }
  };
  const terminate = (code: string) => {
    failure ??= code;
    killGroup("SIGTERM");
    escalation ??= setTimeout(() => killGroup("SIGKILL"), 5_000);
  };
  const onAbort = () =>
    terminate(
      options.signal ? abortFailureCode(options.signal) : "agent_canceled",
    );
  const timer = setTimeout(() => terminate("agent_timeout"), options.timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  child.stdout.on("data", (part: Buffer) => {
    bytes += part.length;
    if (bytes > MAX_STREAM_BYTES) terminate("agent_output_oversized");
    else {
      let text: string;
      try {
        text = decoder.decode(part, { stream: true });
      } catch {
        terminate("invalid_agent_output");
        return;
      }
      stdout += text;
      if (options.inspectLine && !failure) {
        pendingLine += text;
        const lines = pendingLine.split("\n");
        pendingLine = lines.pop() ?? "";
        for (const line of lines.filter((line) => line.trim())) {
          try {
            options.inspectLine(line);
          } catch (error) {
            terminate(
              error instanceof Error ? error.message : "invalid_agent_output",
            );
            break;
          }
        }
      }
    }
  });
  // CLI stderr can echo credentials or input. Bound it without retaining it.
  child.stderr.on("data", (part: Buffer) => {
    bytes += part.length;
    if (bytes > MAX_STREAM_BYTES) terminate("agent_output_oversized");
  });
  child.stdin.on("error", () => {
    /* EPIPE is classified by the process terminal. */
  });
  const closed = new Promise<number | null>((resolve) => {
    child.on("error", () => {
      failure ??= "agent_spawn_failed";
    });
    child.on("close", resolve);
  });
  try {
    if (child.pid) {
      try {
        await options.attach(child.pid);
      } catch {
        terminate("agent_lease_lost");
      }
    }
    if (options.signal?.aborted) onAbort();
    if (!failure) {
      try {
        options.started();
      } catch {
        terminate("agent_observer_failed");
      }
      if (options.signal?.aborted) onAbort();
      child.stdin.end(failure ? undefined : options.input);
    } else child.stdin.end();
    const code = await closed;
    // An otherwise unfailed parent may still own a helper that is mid-exit
    // when it closes. Give the group one bounded natural-drain window before
    // the verdict below, so an ordinary reaping tail is not permanently
    // classified as a descendant that survived. A failure that already
    // happened — or arrives here — ends the wait at the next poll and keeps
    // the existing fail-closed path; the overall timeout stays armed.
    if (child.pid && !failure && processExists(-child.pid)) {
      const drainUntil = Date.now() + NATURAL_DRAIN_MS;
      while (!failure && processExists(-child.pid) && Date.now() < drainUntil)
        await delay(25);
    }
    // Parent exit alone does not prove its grandchildren exited.
    if (child.pid && processExists(-child.pid)) {
      terminate(failure ?? "agent_descendant_survived");
      const deadline = Date.now() + 6_000;
      while (processExists(-child.pid) && Date.now() < deadline)
        await delay(25);
      if (processExists(-child.pid))
        throw agentFailure("agent_teardown_unconfirmed");
    }
    if (failure) throw agentFailure(failure);
    if (code !== 0) throw options.classifyFailure(stdout);
    try {
      decoder.decode();
    } catch {
      throw agentFailure("invalid_agent_output");
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** What a remembered pass is about: the file as it stands now (real path,
 *  inode, mtime, size), the adapter and the selection revision. `undefined`
 *  when the file cannot be stated — no key, no memory, and the full
 *  verification answers with its own refusal. */
async function verificationKey(
  adapterId: string,
  frozen: ResolvedAgentSelection,
): Promise<string | undefined> {
  try {
    const real = await realpath(frozen.absoluteExecutable);
    const file = await stat(real);
    return [
      real,
      file.ino,
      file.mtimeMs,
      file.size,
      adapterId,
      frozen.configRevision,
    ].join("|");
  } catch {
    return undefined;
  }
}

/** The isolation probes obey the request's cancellation too: a turn the owner
 *  stopped must not keep a native `--help` running behind it. Absent a signal
 *  the verifier keeps its own per-probe bounds. */
function isolationOptions(signal: AbortSignal | undefined): {
  signal?: AbortSignal | undefined;
} {
  return signal ? { signal } : {};
}
