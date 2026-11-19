import type { ConnectorDeclaration } from "../connector/capabilities";
import type { NetworkId } from "../network/registry";
import {
  BUDGETED_MODE_KEYS,
  WORKER_CATALOG,
  stepName,
  type BindingMode,
  type LiveChecks,
  type ModeKey,
  type NetworkCatalog,
} from "./catalog";
import type { CampaignAgentStrategy } from "./contract";
import { describeAction, joinWords, policyLines } from "./cardWords";
import { resolveStrategy, type ResolvedAction } from "./resolve";
import { bindingAvailable } from "./templates";

/**
 * WHAT A DESIGNED CAMPAIGN WILL DO, said before it starts — the card the owner
 * answers with Start campaign (spec R01: a concrete summary, the disabled
 * operations with their reasons, and a representative simulation).
 *
 * Everything here is read off the proposed document by the one resolver, with
 * the channel's real connector, so the words cannot say more than the version
 * would do: an action the connector cannot perform reads disabled with that
 * reason, one the owner left Off reads Off, and the simulation is the
 * resolver's effective values for a relevant reply arriving today — no model
 * call, no draft, nothing sent. Pure.
 */

export type DesignAction = {
  label: string;
  /** On / Off / Ask me / Automatic, or "You confirm" for Record outcome —
   *  the workspace's own words for the modes (`lib/strategy-copy.ts`). */
  mode: string;
  /** Why it cannot run at all, when it cannot. */
  disabled: string | null;
};

export type DesignStep = {
  label: string;
  worker: string;
  actions: DesignAction[];
};

export type DesignSummary = {
  /** "on LinkedIn · Jane Doe" — the account the campaign lives on for life. */
  channel: string;
  /** The concrete sentence R01 asks for. */
  sentence: string;
  steps: DesignStep[];
  /** Its policy, one plain sentence each — "DMs: wait for interest". Absent
   *  on a card an earlier release drew. */
  policies?: string[];
  /** Every operation the campaign will not perform, with its reason. */
  wontDo: Array<{ label: string; reason: string }>;
  simulation: { title: string; text: string };
};

export type DesignInput = {
  document: CampaignAgentStrategy;
  accountDefault: CampaignAgentStrategy | null;
  network: NetworkCatalog;
  connector: ConnectorDeclaration | null;
  /** The first sends and live checks recorded on the account; absent,
   *  none. */
  liveChecks?: LiveChecks;
  channel: { network: NetworkId; displayName: string | null };
};

const NETWORK_NAMES: Record<NetworkId, string> = { linkedin: "LinkedIn" };

const MODE_WORDS: Record<BindingMode, string> = {
  off: "Off",
  on: "On",
  review: "Ask me",
  auto: "Automatic",
};

/** Why the connector cannot perform an action, in the owner's words. */
export const UNAVAILABLE_REASON = "The account's connector cannot do this yet";

/** The channel as the card names it. */
export function channelLine(channel: DesignInput["channel"]): string {
  return `on ${NETWORK_NAMES[channel.network]} · ${channel.displayName ?? "your account"}`;
}

export function describeDesign(input: DesignInput): DesignSummary {
  const actions = resolveStrategy({
    accountDefault: input.accountDefault,
    campaign: input.document,
    network: input.network,
    connector: input.connector,
    liveChecks: input.liveChecks,
  });
  const disabled = (action: ResolvedAction): string | null =>
    bindingAvailable(action.capability, action.target, input.connector) ? null : UNAVAILABLE_REASON;
  const view = (action: ResolvedAction): DesignAction => ({
    label: action.label,
    mode: action.effective === null ? "You confirm" : MODE_WORDS[action.effective],
    disabled: disabled(action),
  });

  const steps = (input.document.steps ?? []).map((step) => ({
    label: stepName(step),
    worker: WORKER_CATALOG[step.worker].label,
    actions: actions.filter((action) => action.step_id === step.step_id).map(view),
  }));

  return {
    channel: channelLine(input.channel),
    sentence: designSentence(input.document, actions),
    steps,
    policies: policyLines(input.document),
    wontDo: wontDo(input, actions, disabled),
    simulation: simulate(input.document, actions),
  };
}

/** Whether a send goes out on its own, waits for a yes, or not at all. */
type Reach = "auto" | "review" | "off";

function reachOf(actions: readonly ResolvedAction[], label: string, stepId?: string): Reach {
  const found = actions.filter(
    (action) => action.label === label && (stepId === undefined || action.step_id === stepId),
  );
  if (found.some((action) => action.effective === "auto")) return "auto";
  if (found.some((action) => action.effective === "review")) return "review";
  return "off";
}

function readOn(actions: readonly ResolvedAction[], label: string): boolean {
  return actions.some((action) => action.label === label && action.effective === "on");
}

const hasStep = (document: CampaignAgentStrategy, id: string): boolean =>
  (document.steps ?? []).some((step) => step.catalog_step === id);

/**
 * The R01 sentence: what the campaign watches, what each worker does about
 * it at the mode it resolved to, and whether anything goes out without a yes.
 */
export function designSentence(
  document: CampaignAgentStrategy,
  actions: readonly ResolvedAction[],
): string {
  const parts: string[] = [];
  if (hasStep(document, "find_leads") && readOn(actions, "Find leads")) {
    parts.push(
      readOn(actions, "Research")
        ? "Scout finds people talking about the problem and researches them into leads."
        : "Scout finds people talking about the problem.",
    );
  }
  const comment = reachOf(actions, "Comment");
  if (hasStep(document, "comment_on_posts") && comment !== "off") {
    parts.push(
      comment === "auto"
        ? "The Ambassador comments on the ones that fit."
        : "The Ambassador drafts a comment for the ones that fit.",
    );
  }
  if (hasStep(document, "handle_reply")) {
    const answers = [
      reachOf(actions, "Reply") !== "off" ? "an answer" : null,
      reachOf(actions, "Like reply") !== "off" ? "a like" : null,
      hasStep(document, "connect") && reachOf(actions, "Invite") !== "off"
        ? "a connection note"
        : null,
    ].filter((part): part is string => part !== null);
    parts.push(
      answers.length > 0
        ? `I'll watch direct replies to your comments; relevant ones can get ${joinWords(answers)}.`
        : "I'll watch direct replies to your comments, and send nothing about them.",
    );
  }
  if (hasStep(document, "continue_in_dms") && reachOf(actions, "DM") !== "off") {
    parts.push(
      document.dm?.outgoing_acceptance === "contextual_opener"
        ? "After an outgoing invitation is accepted, one contextual opener may follow."
        : "I'll wait for interest before starting a DM after an outgoing invitation is accepted.",
    );
  }
  const sends = actions.filter((action) => action.stored !== "step_switch" && action.stored !== null);
  const automatic = sends.filter((action) => action.effective === "auto");
  if (automatic.length > 0) {
    parts.push(`${joinWords([...new Set(automatic.map((action) => action.label))])} go out on their own, within the account's caps.`);
  } else if (sends.some((action) => action.effective === "review")) {
    parts.push("Everything waits for your yes.");
  } else {
    parts.push("Nothing is sent.");
  }
  return parts.join(" ");
}

/** Every operation the campaign will not perform, and why. */
function wontDo(
  input: DesignInput,
  actions: readonly ResolvedAction[],
  disabled: (action: ResolvedAction) => string | null,
): DesignSummary["wontDo"] {
  const out: DesignSummary["wontDo"] = [];
  const seen = new Set<string>();
  const add = (label: string, reason: string) => {
    if (seen.has(label)) return;
    seen.add(label);
    out.push({ label, reason });
  };
  for (const action of actions) {
    if (action.stored === null || action.effective !== "off") continue;
    const unavailable = disabled(action);
    if (unavailable) add(action.label, unavailable);
    // A read the template leaves Off (Research) is not a choice the owner
    // made, and reaches nobody; only a send they left Off is theirs.
    else if (action.stored === "step_switch") continue;
    else if (action.reason === null) add(action.label, "You chose Off");
    else add(action.label, describeAction(action));
  }
  if (!hasStep(input.document, "check_outcome")) {
    add("Record outcome", "No offer to count against yet — attach a product to this campaign first");
  }
  // Ask me is the most a template ever sets; what keeps Automatic out of reach
  // for the new kinds is arithmetic, and the card says which number.
  const budgeted = new Set<ModeKey>(BUDGETED_MODE_KEYS);
  const heldByCeiling = actions.some(
    (action) =>
      action.stored !== null &&
      action.stored !== "step_switch" &&
      budgeted.has(action.stored) &&
      action.effective === "review",
  );
  add(
    "Anything without asking",
    heldByCeiling && !input.accountDefault?.budgets
      ? "No rolling-24h ceilings are set, so nothing can be Automatic"
      : "Every send waits for your yes",
  );
  return out;
}

/**
 * "What would happen to a relevant reply today", from the resolved values
 * alone. A campaign with no reply step is shown a matched post instead.
 */
function simulate(
  document: CampaignAgentStrategy,
  actions: readonly ResolvedAction[],
): DesignSummary["simulation"] {
  const outcome = (reach: Reach, waiting: string, going: string) =>
    reach === "auto" ? going : reach === "review" ? waiting : null;
  if (!hasStep(document, "handle_reply")) {
    const comment = outcome(
      reachOf(actions, "Comment"),
      "a drafted comment goes to Waiting for a yes",
      "a comment is published within the account's caps",
    );
    return {
      title: "What would happen to a matched post today",
      text: comment
        ? `Scout matches a post → ${comment}. Nothing reaches its author until then.`
        : "Scout matches a post → it waits in your deck for you to write; nothing is drafted or sent.",
    };
  }
  const now = [
    outcome(reachOf(actions, "Reply"), "an answer goes to Waiting for a yes", "an answer is posted"),
    outcome(reachOf(actions, "Like reply"), "a like on their reply waits for your yes", "their reply is liked"),
  ].filter((part): part is string => part !== null);
  const sentences = [
    `A relevant reply arrives under one of your comments → ${
      now.length > 0 ? joinWords(now) : "nothing is sent about it"
    }.`,
  ];
  if (hasStep(document, "connect")) {
    const invite = outcome(
      reachOf(actions, "Invite"),
      "a connection note waits for your yes",
      "a connection note goes out",
    );
    sentences.push(
      invite
        ? `If you're not connected yet, ${invite}; already connected, no invite.`
        : "No invitation goes out.",
    );
  }
  if (hasStep(document, "continue_in_dms")) {
    sentences.push(
      reachOf(actions, "DM") === "off"
        ? "No DM."
        : document.dm?.outgoing_acceptance === "contextual_opener"
          ? "Once they accept, one contextual opener waits for your yes."
          : "No DM until they ask to try.",
    );
  }
  return { title: "What would happen to a reply today", text: sentences.join(" ") };
}
