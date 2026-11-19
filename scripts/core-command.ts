import { existsSync, readFileSync } from "node:fs";
import { agentSetupCommand, localAgentCommand } from "../packages/core/ai/agentCli/command";
import { storedAgentSelection } from "../packages/core/ai/agentCli/selection";
import { assertNonSuperuserRole } from "@engager/database/guard";
import { pool } from "@engager/database";
import { holdExecutorLock } from "@engager/database/executorLock";
import { drainQueue, MAX_DRAIN_MS, MIN_DRAIN_MS } from "@engager/core/jobs/worker";
import { runtimeInstanceId } from "@engager/core/execution/authority";
import { maintenanceCommand, readMaintenanceInput } from "./maintenance-command";
import { reportSupervision } from "@engager/core/supervision/report";
import { resumeSupervision } from "@engager/core/supervision/record";
import { supervisionStatus } from "@engager/core/supervision/status";
import { withOrg } from "@engager/database/tenant";
import { portableExport, portableRestore } from "./portable-lifecycle";
import { shutdownAnalytics } from "@engager/observability/analytics";
import { markSetupStage } from "@engager/observability/boot";
import { SETUP_STAGES } from "@engager/observability/events";

if (existsSync(".env")) process.loadEnvFile?.(".env");
const [command, ...args] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === "agent") result = await localAgentCommand(args);
  else if (command === "agent-setup") {
    // The first-run window's Cancel terminates the CLI child, which forwards
    // the signal here; abort the scan with it so its probes die too instead
    // of finishing a scan nobody is waiting for.
    const abort = new AbortController();
    const onSignal = () => abort.abort();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    try {
      result = await agentSetupCommand(args, {
        signal: abort.signal,
        // `install` streams one JSON event per line as it happens (the
        // window renders phases live); `inventory` never emits.
        emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      });
    } finally {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
  }
  else if (command === "health") {
    await assertNonSuperuserRole();
    await pool.query("select 1");
    result = { core: "usable", background: storedAgentSelection("background") ? "selected_profile_requires_execution_verification" : "agent_selection_required", chat: storedAgentSelection("chat") ? "selected_profile_requires_execution_verification" : "agent_selection_required", authentication: "unknown", externalInteractive: "independent", browser: "not_probed" };
  } else if (command === "run") {
    const maxJobs = Number(args[0] ?? 10), maxMs = Number(args[1] ?? 25000);
    // A budget under the drainer's own claim floor would return an honest zero
    // that reads as an empty queue, so it is refused rather than reported.
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100 || !Number.isSafeInteger(maxMs) || maxMs < MIN_DRAIN_MS || maxMs > MAX_DRAIN_MS) throw new Error("drain_bounds_invalid");
    const org = process.env.ENGAGER_ORG_ID;
    if (!org) throw new Error("organization_required");
    await assertNonSuperuserRole();
    // `--long-jobs` drains as the continuous worker does: no platform deadline,
    // so a type whose budget outruns maxMs (dispatch_actions) is claimed and
    // runs its own budget instead of being left for the agent.
    const deadline = args.includes("--long-jobs") ? {} : { hardDeadlineMs: Date.now() + maxMs };
    // Held for the whole drain, so the standing agent starting meanwhile sees
    // this process alive and releases nothing it is running.
    const executorLock = await holdExecutorLock();
    try {
      result = await drainQueue({}, { ownOrgs: new Set([org]), maxJobs, maxMs, ...deadline });
    } finally {
      await executorLock.release();
    }
  } else if (command === "export-portable") {
    // Passphrase by FILE, never argv: an argument is visible to every process
    // on the machine, and this one protects the owner's whole export.
    result = await portableExport({
      output: args[0]!,
      passphraseFile: args[1]!,
      env: process.env,
    });
  } else if (command === "restore-portable") {
    result = await portableRestore({
      input: args[0]!,
      passphraseFile: args[1]!,
      env: process.env,
    });
  } else if (command === "maintenance") {
    // The backup/update/rollback DECISIONS and their receipts, so the free
    // CLI's file mechanics and the maintained Mac ask one implementation
    // (`packages/core/supervision/maintenance.ts`) rather than each carrying
    // its own retention and signature rules.
    //
    // The operation's input arrives on STDIN, never in argv: an update hands
    // over the candidate's whole payload manifest, and a released one is
    // megabytes — several times `ARG_MAX`, so the kernel would refuse to start
    // this process at all (`E2BIG`). It is read FIRST, before the checks
    // below, so that a refusal reaches the caller as its own code rather than
    // as the broken pipe a caller still writing megabytes would see instead.
    const input = await readMaintenanceInput(process.stdin);
    const org = process.env.ENGAGER_ORG_ID;
    if (!org) throw new Error("organization_required");
    await assertNonSuperuserRole();
    result = await maintenanceCommand(org, args[0] ?? "", input);
  } else if (command === "supervision") {
    const org = process.env.ENGAGER_ORG_ID;
    if (!org) throw new Error("organization_required");
    await assertNonSuperuserRole();
    if (args[0] === "report") {
      const body = JSON.parse(args[1] ?? "{}");
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("supervision_arguments_invalid");
      result = await withOrg(org, (tx) => reportSupervision(tx, org, body));
    } else {
      // `resume` is the owner's own "start it again", for the install a departed
      // supervisor left paused or waiting for recovery. It starts no process and
      // grants no extra restart attempt — the record inherits the budget it had.
      result = await withOrg(org, async (tx) => {
        if (args[0] === "resume") {
          await resumeSupervision(tx, {
            organizationId: org,
            holderId: runtimeInstanceId(),
            now: Date.now(),
          });
        }
        return supervisionStatus(tx, org);
      });
    }
  } else if (command === "setup-stage") {
    // Set up Engager's own progress, before there is an agent to report it.
    // Says nothing back: the window never waits on what this counted.
    const stage = SETUP_STAGES.find((known) => known === args[0]);
    if (!stage) throw new Error("setup_stage_unknown");
    markSetupStage(stage, { hadPriorUse: args.includes("--prior-use") });
    await shutdownAnalytics();
  } else if (command === "payload-check") {
    result = { state: "loadable", version: JSON.parse(readFileSync(args[0]!, "utf8")).version };
  } else throw new Error("core_command_unknown");
  // A streamed command (agent-setup install) already wrote its events;
  // printing its `undefined` result would add a line that is not an event.
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) {
  // A refusal travels as its CODE, never as a message: an arbitrary error string
  // can carry a connection URL, and the free CLI's repair table is keyed on the
  // code anyway. `PortableArchiveError` carries one explicitly.
  const code = (error as { code?: unknown })?.code;
  const message = typeof code === "string" ? code
    : error instanceof Error ? error.message : "";
  console.error(/^[a-z][a-z0-9_:.-]+$/.test(message) ? message : "core_operation_failed");
  process.exitCode = 1;
} finally { await pool.end(); }
