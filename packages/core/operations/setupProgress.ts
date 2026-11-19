import type { SetupState } from "./setup";

/**
 * Agent-facing presentation of setup progress for the `get_status` tool:
 * a plain-English `summary`, the wizard-order `currentStep`, and a `next`
 * guidance string. `get_status` deliberately renders NO card — it is the
 * agent's silent state read; the dedicated step cards (channel, brain, scout)
 * are each rendered once by their owning tool at the moment of action. The
 * lead fields exist because models narrate the first authoritative-sounding
 * thing they see — so the first things on the wire must be true, current, and
 * impossible to misread.
 */

export type SetupCardStep = "channel" | "brain" | "scout" | "handoff";

/** MUST MATCH the engager-setup skill's phase order: channel → brain → scout
 * → handoff. The agent seeds its host task list from the skill phases and
 * obeys `next` — a diverging server order makes it skip steps its own plan
 * still shows as pending. */
export const SETUP_CARD_STEPS: readonly {
  id: SetupCardStep;
  label: string;
  done: (state: SetupState) => boolean;
}[] = [
  { id: "channel", label: "Channel", done: (s) => s.linkedin.connected },
  {
    id: "brain",
    label: "Brain",
    // A truncated seed still progresses this step — the Brain never needs to
    // be exhaustive to count as seeded. seedStalled (below, a summary fact,
    // never a step) carries the agent-side thin-write recovery when the
    // background import settled with zero docs: get_channel → save_knowledge.
    done: (s) => s.brain.knowledgeCount > 0,
  },
  {
    id: "scout",
    label: "Scout",
    // MUST equal completeSetup's own campaign fence (operations/setup.ts):
    // both read isSupportedPublicCampaignRuntime, so the corridor's door can
    // never show this step green while the stamp writer still refuses.
    done: (s) => s.campaigns.supportedActive >= 1,
  },
  {
    // The stamp itself. With handoff.done reading it, "complete" implies
    // stamped by construction of this step model — there is no reachable
    // state where every step is satisfied and the stamp is unwritten.
    id: "handoff",
    label: "Handoff",
    done: (s) => s.onboardingStep === "done",
  },
];

export type SetupCardProgress = {
  completedSteps: SetupCardStep[];
  /** "complete" (not null) when all steps are done — self-describing for models. */
  currentStep: SetupCardStep | "complete";
  summary: string;
};

export function deriveSetupCardProgress(
  state: SetupState,
  /** Task kinds owed to the caller that no prepared task covers yet — see
   *  `listOwedTasks`. They qualify a fact rather than moving a step: a campaign
   *  whose brief has never compiled IS live, and saying only that was how the
   *  agent learned nothing was left to do on it. */
  owedTasks: readonly string[] = [],
): SetupCardProgress {
  const completed = SETUP_CARD_STEPS.filter((step) => step.done(state));
  const current = SETUP_CARD_STEPS.find((step) => !step.done(state)) ?? null;
  const facts: string[] = [];
  if (state.linkedin.connected) facts.push("LinkedIn connected");
  // Background learning is a fact, not a step: the connect webhook starts the
  // Brain + voice import silently and nothing in the flow waits on it.
  if (state.voice.persisted || state.brain.knowledgeCount > 0) {
    const parts = [
      state.brain.knowledgeCount > 0
        ? `Brain ${state.brain.knowledgeCount} items`
        : null,
      state.voice.persisted ? "voice saved" : null,
    ].filter(Boolean);
    facts.push(parts.join(" + "));
  } else if (state.voice.stage === "learning") {
    facts.push("Brain + voice learning in background");
  }
  // The background seed can finish without landing docs (thin post history, or
  // a provider failure), and hosted re-seeding may be denied pre-activation —
  // name the always-available thin path so the agent doesn't dead-end on 402s.
  if (state.brain.seedStalled) {
    facts.push(
      "Brain EMPTY — background seed did not land; seed it agent-side (get_channel → extract facts yourself → save_knowledge)",
    );
  }
  if (state.products.count > 0) {
    facts.push(
      `${state.products.count} product${state.products.count === 1 ? "" : "s"}`,
    );
  }
  // Keyed on the SAME predicate the scout step and completeSetup's fence read
  // — the fact can never claim a campaign live that the fence would refuse.
  if (state.campaigns.supportedActive >= 1) {
    facts.push(
      owedTasks.includes("campaign_brief")
        ? "Scout campaign live, focus brief owed"
        : "Scout campaign live",
    );
  }
  const done = facts.length > 0 ? facts.join(", ") : "nothing done yet";
  const summary = current
    ? `Setup ${completed.length}/${SETUP_CARD_STEPS.length}: ${done}. Now: ${current.label.toLowerCase()}.`
    : `Setup complete: all ${SETUP_CARD_STEPS.length} steps done (${done}).`;
  return {
    completedSteps: completed.map((step) => step.id),
    currentStep: current?.id ?? "complete",
    summary,
  };
}

/**
 * What the agent should do NOW — same contract as every other setup tool's
 * `next` string. Deliberately free of output-format advice: text-only hosts
 * need normal verbosity and the skill owns presentation.
 */
export function setupStateNext(
  state: SetupState,
  currentStep: SetupCardStep | "complete",
  /** Prepared tasks are waiting on this agent's judgment. It changes the
   *  instruction, not the step: the work already ran and the thinking is owed. */
  tasksPending = false,
  /** A sweep the server is still RUNNING (see `inFlight`). The opposite
   *  obligation: nothing is owed, and the only correct move is to wait. */
  sweepInFlight = false,
  /** Owed work with no task to read yet (see `owedTasks`): the agent
   *  PREPARES these rather than reading them. */
  tasksOwed: readonly string[] = [],
): string {
  // Before the owed-judgment line, deliberately. A sweep still running is the
  // reason there is nothing to judge yet, and an agent told to act first will
  // re-run the tool it should be polling.
  if (tasksPending)
    return `Prepared tasks are waiting on YOUR judgment (see pendingTasks) — a tool ran its I/O here because no background agent is configured, and handed the model step back. Read each with get_task, do that step yourself, and finish_task. Nothing else on this step moves until they are submitted or they expire. ${setupStateNext(state, currentStep, false, false, tasksOwed)}`;
  // After the prepared tasks, because a task that EXISTS is read and
  // submitted, while these have no id yet — the agent prepares them itself.
  if (tasksOwed.length > 0)
    return `Model work is owed to YOU with no task prepared for it yet (see owedTasks: ${tasksOwed.join(", ")}) — the tool that owed it queued nothing, because there is no background agent to run a queued job. Prepare each with start_task (a campaign_brief takes the campaign's id), do that step yourself, and finish_task. ${setupStateNext(state, currentStep)}`;
  switch (currentStep) {
    case "channel":
      return "Connect the channel in Engager. LinkedIn has no compliant automation API; automated activity can reduce reach or restrict the account. Caps and the day plan reduce risk, but do not remove it. Read get_channel for connection state.";
    case "brain":
      return "Seed the Brain with seed_brain from the owner's sources. Read its result and complete any prepared tasks with get_task and finish_task. Never invent facts.";
    case "scout":
      return "Follow engager-campaigns: use get_catalog, propose the campaign and save_campaign after the owner's agreement. Use edit_searches for agreed searches. The owner starts the campaign in Engager. Read get_campaign and get_run for results.";
    case "handoff":
      return "Explain the handoff and call complete_setup with loadedSkills. Start remains the owner's action in Engager.";
    case "complete":
      return "Setup is complete. Use engager-status for health or engager-people for people.";
  }
}
