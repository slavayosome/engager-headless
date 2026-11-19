import { MODE_GRANTS, MODE_KEY_LABELS, stepName, type BindingMode, type ModeKey } from "./catalog";
import type { CampaignAgentStrategy, StrategyStep } from "./contract";
import type { ResolveReason, ResolvedAction } from "./resolve";

/**
 * THE WORDS A STRATEGY CARD SAYS — every value a patch can move, as the
 * owner would set it, and never as it is stored.
 *
 * A card's rows are read by someone deciding whether a campaign may do more,
 * so a row that prints a path (`action_bindings`) or a stored object
 * (`{"max_count":0,…}`) is a row they cannot decide from. Every value is
 * said here in words or not at all: a policy is one plain sentence, a step
 * list is its steps' names, and what is only the record behind a design —
 * its bindings, grants and capability groups — is said by the action rows
 * that already name each send's mode.
 *
 * Pure and dependency-free beyond the catalog's labels, so the card that
 * renders rows a release before this one stored (`ownerRows`) can take it
 * into the browser.
 */

/** One line of a card: old → new. */
export type CardRow = { label: string; before: string; after: string };

/** Stored `off` / `review` / `auto` and a read's `on`, as the owner reads them. */
export const MODE_WORDS: Readonly<Record<BindingMode, string>> = {
  off: "Off",
  on: "On",
  review: "Ask me",
  auto: "Automatic",
};

/** What holds an action below the mode it was asked for. A hold that lifts —
 *  a first send confirmed, a ceiling set — says what it becomes then. */
const HELD_WORDS: Readonly<Record<ResolveReason, (mode: string, asked: string) => string>> = {
  first_send_pending: (mode, asked) => `${mode} until the first one goes out, then ${asked}`,
  ceiling_null: (mode, asked) => `${mode} until a rolling-24h ceiling is set, then ${asked}`,
  capability_unavailable: (mode) => `${mode} — the account's connector can't do it yet`,
  grant_missing: (mode) => `${mode} — not granted to this campaign`,
  outside_window: (mode) => `${mode} outside the sending window`,
  person_constraint: (mode) => `${mode} — held for this person`,
  requires_dm: (mode) => `${mode} — Follow-up can't go further than DM`,
  no_binding: (mode) => `${mode} — the campaign has no such step`,
};

/** An action's effective mode, and — when something holds it below what was
 *  asked — what holds it. */
export function describeAction(
  action: Pick<ResolvedAction, "effective" | "requested" | "reason"> | undefined,
): string {
  if (!action) return "Not in the strategy";
  if (action.effective === null) return "You confirm";
  const mode = MODE_WORDS[action.effective];
  if (action.reason === null || action.requested === null) return mode;
  return HELD_WORDS[action.reason](mode, MODE_WORDS[action.requested]);
}

const isMode = (value: unknown): value is BindingMode => typeof value === "string" && value in MODE_WORDS;

/** A binding's stored mode: absent is Off. */
export function modeWords(value: unknown): string {
  return isMode(value) ? MODE_WORDS[value] : MODE_WORDS.off;
}

export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const NOT_SET = "Not set";

/** A stored value as a row says it: text as it is, cut at 200 characters so a
 *  step's instructions never make a card — or the summary stored with it —
 *  as long as the instructions themselves. */
export function said(value: unknown): string {
  if (value === null || value === undefined) return NOT_SET;
  const text = typeof value === "string" ? value : String(value);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

type Policy = {
  /** The stored field the sentence reads, which a change must sit under. */
  root: keyof CampaignAgentStrategy;
  label: string;
  say: (document: Partial<CampaignAgentStrategy>) => string;
};

const GRANT_LABELS = Object.fromEntries(
  (Object.entries(MODE_GRANTS) as Array<[ModeKey, string]>).map(([key, grant]) => [grant, MODE_KEY_LABELS[key]]),
);

/**
 * A campaign's policy, one sentence per thing the owner would decide about
 * it. `secondary` ones are the record behind what the action rows already
 * say — what a campaign may send, which groups it covers, what it may
 * remember — and are said only on a card that would otherwise say nothing.
 */
const POLICIES: ReadonlyArray<Policy & { secondary?: true }> = [
  {
    root: "observation",
    label: "Replies it watches",
    say: ({ observation }) =>
      observation
        ? `Direct replies to ${joinWords(
            observation.source_scopes.map((scope) =>
              scope === "own_comments" ? "your comments" : scope === "room" ? "your room replies" : "comments you adopt",
            ),
          )}${
            observation.replay_lookback_hours > 0
              ? `, catching up ${observation.replay_lookback_hours} hours${
                  observation.catchup_requires_review ? " with your yes" : ""
                }`
              : ""
          }`
        : NOT_SET,
  },
  {
    root: "eligibility",
    label: "Neutral replies",
    say: ({ eligibility }) =>
      eligibility
        ? { eligible: "The agent decides", review: "Wait for your yes", skip: "Skipped" }[eligibility.neutral_relevant]
        : NOT_SET,
  },
  {
    root: "eligibility",
    label: "Negative replies",
    say: ({ eligibility }) =>
      eligibility ? { skip: "Skipped", review: "Wait for your yes" }[eligibility.negative] : NOT_SET,
  },
  {
    root: "invite",
    label: "Invitations",
    say: ({ invite }) =>
      invite ? `${invite.note_required ? "Always with a note" : "A note when it helps"}, once per person` : NOT_SET,
  },
  {
    root: "dm",
    label: "DMs",
    say: ({ dm }) =>
      dm
        ? dm.outgoing_acceptance === "wait_for_interest"
          ? "Wait for interest"
          : "Open with the exchange you had"
        : NOT_SET,
  },
  {
    root: "dm",
    label: "When they invite you after an exchange",
    say: ({ dm }) => (dm ? (dm.incoming_linked_opener ? "One opener that cites it" : "No opener") : NOT_SET),
  },
  {
    root: "followup",
    label: "Follow-up",
    say: ({ followup }) =>
      followup
        ? followup.max_count === 0
          ? "None"
          : `One after ${followup.delay_hours} hours, only after interest`
        : NOT_SET,
  },
  {
    root: "cta",
    label: "Ask whether they want to try it",
    say: ({ cta }) =>
      cta
        ? `After ${cta.after_relevant_exchanges} relevant exchange${cta.after_relevant_exchanges === 1 ? "" : "s"}`
        : NOT_SET,
  },
  {
    root: "grants",
    label: "Allowed to send",
    secondary: true,
    say: ({ grants }) =>
      grants && grants.length > 0 ? joinWords(grants.map((grant) => GRANT_LABELS[grant] ?? grant)) : "Nothing",
  },
  {
    root: "capability_groups",
    label: "What it covers",
    secondary: true,
    say: ({ capability_groups: groups }) =>
      groups && groups.length > 0
        ? joinWords(
            groups.map(
              (group) =>
                ({
                  discovery: "finding posts",
                  public_engagement: "public comments and likes",
                  conversation: "conversations",
                  conversion: "outcomes",
                })[group],
            ),
          )
        : "Nothing",
  },
  {
    root: "memory_bindings",
    label: "What it may remember",
    secondary: true,
    say: ({ memory_bindings: bindings }) => {
      const writes = (bindings ?? []).filter((binding) => binding.access === "write");
      return writes.length > 0
        ? `Writes ${joinWords(writes.map((binding) => binding.slot.replaceAll("_", " ")))}`
        : "Reads only";
    },
  },
];

/** The policy rows whose sentence moved, among the roots a diff touched:
 *  `primary` always, `secondary` for a card that has nothing else to say. */
export function policyRows(
  before: Partial<CampaignAgentStrategy>,
  after: Partial<CampaignAgentStrategy>,
  roots: ReadonlySet<string>,
): { primary: CardRow[]; secondary: CardRow[] } {
  const rows = { primary: [] as CardRow[], secondary: [] as CardRow[] };
  for (const policy of POLICIES) {
    if (!roots.has(policy.root)) continue;
    const [was, now] = [policy.say(before), policy.say(after)];
    if (was !== now) (policy.secondary ? rows.secondary : rows.primary).push({ label: policy.label, before: was, after: now });
  }
  return rows;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const PRIMARY = POLICIES.filter((policy) => !policy.secondary);

/** What a document's policy says, one plain sentence each — "Neutral replies:
 *  the agent decides" — for the card that starts it. */
export function policyLines(document: Partial<CampaignAgentStrategy>): string[] {
  return PRIMARY.filter((policy) => document[policy.root] !== undefined).map((policy) => `${policy.label}: ${lowerFirst(policy.say(document))}`);
}

/** The same sentences, read off a card's rows — for a card an earlier release
 *  drew, whose design carries none. */
export function policyLinesFromRows(rows: readonly CardRow[]): string[] {
  return PRIMARY.flatMap((policy) => {
    const row = rows.find((candidate) => candidate.label === policy.label);
    return row && row.after !== NOT_SET ? [`${policy.label}: ${lowerFirst(row.after)}`] : [];
  });
}

const ENTRY_WORDS: Readonly<Record<StrategyStep["entry"]["event"], string>> = {
  room_member_spotted: "When Research spots someone who fits",
  campaign_wake: "When the campaign wakes",
  explicit_start: "When you start it",
  candidate_matched: "When a post is matched",
  lead_served: "When Scout serves a lead",
  comment_posted: "When a comment goes out",
  direct_reply: "When someone replies to you",
  invitation_status: "When an invitation changes",
  inbound_dm: "When they message you",
  outcome_evidence: "When there is evidence of an outcome",
};

/** A step's start in words. A served lead reaches Comment on posts with a
 *  post to join and Meet the room with the comment it left, and each step
 *  says so; anywhere else it is the general form. */
export function entryWordsFor(step: Pick<StrategyStep, "catalog_step" | "entry">): string {
  if (step.entry.event === "lead_served") {
    if (step.catalog_step === "comment_on_posts") return "When Scout serves a lead with a post";
    if (step.catalog_step === "meet_the_room") return "When Scout serves a lead from a comment";
  }
  return ENTRY_WORDS[step.entry.event];
}

const EXIT_WORDS: Readonly<Record<StrategyStep["on_missing_context"] | StrategyStep["on_no_progress"], string>> = {
  wait: "Wait",
  review: "Ask you",
  wait_or_review: "Wait, then ask you",
  stop: "Stop",
  escalate: "Ask you",
};

/**
 * A step's own settings that the inspector shows, one row per setting the
 * owner would recognise — keyed by the stored field, so a change under it
 * names its row. A field not here (its tools, its context, its output shape)
 * is the record behind the step, never a row of its own.
 */
export const STEP_SETTINGS: Readonly<
  Record<string, { label: string; say: (step: StrategyStep, stepLabel: (id: string) => string, bindingLabel?: (id: string) => string) => string }>
> = {
  label: { label: "name", say: (step) => said(stepName(step)) },
  objective: { label: "what it is for", say: (step) => said(step.objective) },
  instructions: { label: "instructions", say: (step) => (step.instructions ? said(step.instructions) : "None") },
  entry: { label: "starts", say: entryWordsFor },
  barriers: {
    label: "waits for",
    say: (step, stepLabel, bindingLabel = () => "Read") =>
      step.barriers.length === 0
        ? "Nothing"
        : step.barriers
            .map((barrier) =>
              barrier.type === "requires_step"
                ? `${stepLabel(barrier.step_id)} first`
                : barrier.type === "requires_read"
                  ? `${bindingLabel(barrier.action_binding_id)} On in ${stepLabel(barrier.step_id)}`
                  : barrier.type === "wait"
                    ? `${barrier.hours} hours`
                    : barrier.type === "approval"
                      ? "Your yes"
                      : `Evidence: ${barrier.evidence}`,
            )
            .join(" · "),
  },
  budget: {
    label: "each wake",
    say: ({ budget }) =>
      `${budget.iterations_per_wake} tries · ${budget.tool_actions_per_wake} actions · ${Math.round(
        budget.elapsed_seconds_per_wake / 60,
      )} min · ${budget.tokens_per_wake} tokens`,
  },
  on_missing_context: { label: "missing context", say: (step) => EXIT_WORDS[step.on_missing_context] },
  on_no_progress: { label: "no progress", say: (step) => EXIT_WORDS[step.on_no_progress] },
};

// ---------------------------------------------------------------------------
// Rows a release before this one stored
// ---------------------------------------------------------------------------

/** A stored path, which no row this module writes is ever labelled with. */
const PATH = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
/** A list or an object printed whole. */
const STRUCTURE = /^(?:\[\]|\[["{[]|\{")/;
/** `Off — Ask me asked; it waits on its first live check (the default)`. A
 *  reason no longer resolved says only the mode it held. */
const OLD_ACTION =
  /^(Off|On|Ask me|Automatic)(?: — (Off|On|Ask me|Automatic) asked; (.+))? \((?:the default|the account|this campaign|this step|the account's connector|this person)\)$/;
const OLD_REASONS: Readonly<Record<string, ResolveReason>> = {
  "the account's connector cannot do it yet": "capability_unavailable",
  "it is not granted": "grant_missing",
  "no rolling-24h ceiling is set": "ceiling_null",
  "it is outside the sending window": "outside_window",
  "a constraint on this person holds it": "person_constraint",
  "Follow-up cannot exceed DM": "requires_dm",
};
const MODE_OF = Object.fromEntries(Object.entries(MODE_WORDS).map(([mode, words]) => [words, mode])) as Record<
  string,
  BindingMode
>;

function oldValue(value: string, label: string): string {
  if (value === "not in the strategy") return "Not in the strategy";
  if (value === "the owner confirms") return "You confirm";
  if (value === "not set" && / · this (?:campaign|step)$/.test(label)) return "Inherited";
  const old = OLD_ACTION.exec(value);
  if (!old) return value;
  const [, effective, requested, reason] = old;
  const held = reason ? OLD_REASONS[reason] : undefined;
  return describeAction({
    effective: MODE_OF[effective!]!,
    requested: requested && held ? MODE_OF[requested]! : null,
    reason: held ?? null,
  });
}

/** A stored policy an earlier card printed whole under its path — `dm`,
 *  `{"outgoing_acceptance":…}` — as today's sentences for it, or nothing for
 *  any other path. */
function oldPolicy<Row extends CardRow>(row: Row): Row[] {
  const stored = (value: string): unknown =>
    value === "not set" ? undefined : /^[[{"]/.test(value) ? JSON.parse(value) : value;
  try {
    const [was, now] = [{ [row.label]: stored(row.before) }, { [row.label]: stored(row.after) }];
    return policyRows(was, now, new Set([row.label]))
      .primary.filter((policy) => !`${policy.before}${policy.after}`.includes("undefined"))
      .map((policy) => ({ ...row, ...policy }));
  } catch {
    // Cut short at the card's 200 characters, or a shape this release no
    // longer stores: there is nothing true left to say about it.
    return [];
  }
}

/**
 * Rows as a card renders them, whenever they were written: a card drawn by an
 * earlier release still sits in `chat_pending_changes.summary` with a path
 * for a label and a stored object for a value, a step named twice ("Find
 * posts · Find posts") and an action's scope in brackets. Such a row is
 * dropped or said in today's words; a row written today passes unchanged.
 */
export function ownerRows<Row extends CardRow>(rows: readonly Row[]): Row[] {
  return rows.flatMap((row): Row[] => {
    if (PATH.test(row.label)) return oldPolicy(row);
    if (STRUCTURE.test(row.before) || STRUCTURE.test(row.after)) return [];
    const label = row.label
      .split(" · ")
      .filter((part, index, parts) => part !== parts[index - 1])
      .join(" · ");
    const [before, after] = [oldValue(row.before, row.label), oldValue(row.after, row.label)];
    return before === after ? [] : [{ ...row, label, before, after }];
  });
}
