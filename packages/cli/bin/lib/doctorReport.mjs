// The pure report half of `engager doctor`. `doctor()` itself runs its checks
// for their side effects (spawning psql, `claude mcp list`, a live MCP round
// trip) and cannot be refactored into a pure pipeline without changing what
// it does; the honest extraction is the shaping and the rendering of the
// report, not the probing that fills it.
//
// `status` is one of four words, and the vocabulary is the point: doctor's
// printed mark and doctor's verdict are deliberately not the same thing.
//   "ok"   — printed ✓, healthy.
//   "fail" — printed ✗ and moves the report's verdict to unhealthy.
//   "warn" — printed ✗ but does NOT move the verdict; some rows (the agent-CLI
//            prereq owns the model-calls verdict, for one) print a ✗ that a
//            different check already accounts for.
//   "info" — carries no verdict at all (✓/✗ never apply): the Brain-vault
//            line, the license line, and a "skipping" line.

/** A recorder closure over one report's checks. `record` returns
 *  `status !== "fail"`, so a caller can write `if (!report.record(…)) ok =
 *  false;` in the same reading order the checks already run in. `finish(ok)`
 *  freezes the accumulated checks against the caller's own verdict — `ok` is
 *  never re-derived from the checks, so a mis-typed `warn` can never silently
 *  change the exit code. */
export function doctorReport(mode) {
  const checks = [];
  let claude;
  return {
    record(name, status, detail) {
      checks.push(detail === undefined ? { name, status } : { name, status, detail });
      return status !== "fail";
    },
    /** One prerequisite row from `prerequisiteReport`, carried whole:
     *  `title` and `fix` ride beside `detail`, absent keys omitted the same
     *  way `record` omits an undefined detail. Returns `status !== "fail"`
     *  like `record`, for the same `if (!…) ok = false` reading order. */
    recordRow({ name, status, title, detail, fix }) {
      const check = { name, status, title };
      if (detail !== undefined) check.detail = detail;
      if (fix) check.fix = fix;
      checks.push(check);
      return status !== "fail";
    },
    // The `claude` field, set only on a `claude`-pinned install (doctor()
    // calls this inside its `agent.agent === "claude"` branch). `finish`
    // includes the key only when this ran, so a codex-pinned install emits
    // no `claude` key at all — there is nothing truthful to say about a
    // binary that install never spawns.
    setClaude(status) {
      claude = { status };
    },
    finish(ok) {
      return Object.freeze(claude === undefined ? { mode, ok, checks } : { mode, ok, checks, claude });
    },
  };
}

/** What this machine runs. */
export function deploymentModeLine() {
  return "→ local mode — the agent, the database and the browser all run on this machine";
}

/** The exact string `doctor --json` prints: one object, nothing else. */
export function renderDoctorJson(report) {
  return JSON.stringify(report, null, 2);
}

/** `ok ? 0 : 1` — the identical expression `doctor()` already computed inline,
 *  now stated once and shared by both output modes. */
export function doctorExitCode(report) {
  return report.ok ? 0 : 1;
}

/**
 * WHERE a background agent and its role models are actually chosen, named for
 * the shape doctor is running in.
 *
 * The dashboard's Agent page owns this selection.
 *
 * Deliberately NOT the `ENGAGER_MODEL_*` lines this used to name. A role row
 * only prints when a background selection exists, and on such an install the
 * stored roles outrank the env (`ai/modelRoles.ts`, `docs/local-agents.md`):
 * the variable the owner was told to edit changes nothing until they configure
 * again, which is the thing they were being sent away from.
 */
function agentChoiceFix(independent, role) {
  if (!independent) return "Settings › Agent in the dashboard";
  return role
    ? `\`engager agent configure --${role}\``
    : "`engager agent configure`";
}

/**
 * The CANONICAL agent answer, read off the get_status round-trip doctor
 * already makes — `agent` in the reply — as lines on `say` and one of this
 * module's own status words.
 *
 * The `llm-backend` prereq row is plain-JS duplication that can only ask
 * whether a binary exists. This is `packages/core/ai/agentCli`'s own selection
 * speaking: the agent it resolved, and the refusals an owner would otherwise
 * meet as a stack trace on their first background job — a pinned agent that
 * cannot serve schema-constrained output, and a role model nothing admits on
 * this installation's route.
 *
 * `agent_selection_required` is the one refusal that is NOT a fault: a
 * self-managed install has chosen no background agent until the owner chooses
 * one, `engager init` does not choose for them, and the reads, the sign-in and
 * the prepared stages all carry on without it. It printed a ✗ and exited 1 on
 * every fresh machine, over a line whose only offered repair could not repair
 * it — so it is "info" and names where the choice is actually made.
 *
 * `independent` is that shape: the free core owns the CLI verbs, everything
 * else chooses on the Agent page. See `agentChoiceFix`.
 */
export function reportBackgroundInference(stdout, say, { independent = false } = {}) {
  let agent;
  try {
    agent = JSON.parse(stdout)?.setup?.agent;
  } catch {
    // A server too old to carry the block, or output this build does not
    // recognise. The prereq row already said what it could; inventing a
    // verdict here would be worse than saying nothing.
    return "ok";
  }
  if (!agent) return "ok";
  if (agent.error === "agent_selection_required") {
    say(
      `→ no agent is chosen for background inference yet — choose one with ${agentChoiceFix(independent)}. Unattended judgment waits; every read, the sign-in and the prepared stages carry on without it.`,
    );
    return "info";
  }
  if (agent.error) {
    say(`✗ background inference refused: ${agent.error}`);
    return "fail";
  }
  say(
    agent.installed
      ? `✓ background inference: ${agent.name} (\`${agent.bin}\`)`
      : `✗ background inference: ${agent.name} (\`${agent.bin}\`) is not on PATH`,
  );
  // `declared` is the wire name; what it answers is whether anything admits the
  // id on this installation's route — the model list the installed agent
  // reported, the selection's admission record, or the published vocabulary.
  const refused = (agent.models ?? []).filter((role) => !role.declared);
  for (const role of refused) {
    say(
      `✗ the ${role.role} model \`${role.model}\` is not admitted on this ${agent.name} installation's route — that role's calls fail; set that role to a model this installation reports, with ${agentChoiceFix(independent, role.role)}`,
    );
  }
  // Not a failure: the call runs, on the substitute. One line, so the model a
  // role is configured with is never silently not the one it runs.
  for (const role of (agent.models ?? []).filter((row) => row.configured)) {
    say(
      `→ the ${role.role} role names \`${role.configured}\`, which this ${agent.name} installation does not offer; it runs \`${role.model}\` instead — choose a model for it with ${agentChoiceFix(independent, role.role)}`,
    );
  }
  return agent.installed && refused.length === 0 ? "ok" : "fail";
}
