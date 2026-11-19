import type { ScoutIntent } from "@engager/database/schema";
import type { ConnectorDeclaration } from "../connector/capabilities";
import {
  ACTION_MODES,
  BUDGETED_MODE_KEYS,
  MODE_GRANTS,
  READ_MODES,
  capabilityAvailable,
  firstSendPending,
  intentCeilingsOf,
  networkActionFor,
  type ActionKind,
  type ActionMode,
  type BindingMode,
  type BudgetedModeKey,
  type CapabilityId,
  type StrategyWorker,
  type IntentCeilings,
  type LiveChecks,
  type ModeKey,
  type NetworkAction,
  type NetworkCatalog,
  type TargetType,
} from "./catalog";
import {
  takesIntentCeilings,
  type ActionBinding,
  type CampaignAgentStrategy,
  type StrategyStep,
} from "./contract";
import { stricterMode } from "./upgrade";

/**
 * "What may this step do, and why" — pure arithmetic over stored values.
 *
 * For every action a step binds, the mode its binding stores — Off where it
 * stores none — is what happens (INV-28): the account keeps no mode of its
 * own, so nothing above the step raises or caps it by choice. It is lowered
 * only where the arithmetic says it cannot happen, in the layer order of
 * INV-34:
 *
 *   connector   the channel's connector cannot perform it        → Off
 *   first send  the account has not yet confirmed one of it      → Ask me
 *   grant       the campaign never granted it                    → Off
 *   ceiling     a new kind's rolling-24h budget is null          → Ask me
 *   window      `now` falls outside the account's windows        → Off
 *   person      a constraint on the person in hand               → that cap
 *
 * and Follow-up can never exceed DM. These are numbers, not gates on workers
 * (INV-6): nothing here refuses anything, it says what the effective value is
 * and which scope decided it, so a surface can show why an attempted Automatic
 * remains Ask me.
 *
 * So a new kind's Automatic stands exactly when the account default holds a
 * non-null rolling-24h ceiling for it — its daily number on Limits — the
 * account has confirmed a first send of it, and nothing on the campaign
 * lowers it. Neither the account default's `grants` and `max_mode` nor the
 * campaign's own `max_mode` are read: migrations 0338 and 0339 folded each
 * into the steps it held below, so none resolves wider than it did.
 * Zero is a ceiling, not a null: it resolves Automatic and permits nothing —
 * the dispatch gate blocks each one at `ceiling_reached`
 * (`execution/actionGate.ts`). A write whose first send the account has not
 * yet confirmed is Ask me at most (`first_send_pending`), and no mode or
 * ceiling lifts it: the owner's yes on that first draft is the check, and
 * only its confirmed receipt — or the shipped record, or the owner's own live
 * check — lets it follow its stored mode (INV-31). Off stays Off.
 *
 * `publish_comment` and `public_reply` carry no stored ceiling: theirs is the
 * channel's day plan — caps, window, warm-up — which is never null, and which
 * the send path already enforces. An Ambassador armed to publish today therefore
 * resolves to Automatic under its seeded strategy (INV-28), and so does a
 * Reply asked to be Automatic — the day plan, the window and `pacingPolicy`
 * cap it at the send, as they cap every unattended comment.
 *
 * No I/O and no clock: `now`, when given, is the only time it reads, and only
 * to place a new kind inside or outside the account's sending windows.
 *
 * Expects documents that passed `parseStrategy` against the same network; a
 * binding with no catalog row is a caller bug and throws.
 */

export type ResolvedFrom =
  | "catalog"
  | "account"
  | "campaign"
  | "step"
  | "connector"
  | "person";

export type ResolveReason =
  | "capability_unavailable"
  | "first_send_pending"
  | "grant_missing"
  | "ceiling_null"
  | "outside_window"
  | "person_constraint"
  | "requires_dm"
  | "no_binding";

/** Narrowings that bind one person — exclusions, a stated preference — and
 *  only ever lower a mode. */
export type PersonConstraints = {
  max_mode?: Partial<Record<ModeKey, ActionMode>>;
};

export type ResolveInput = {
  /** The channel's active account-default document, or null when the owner
   *  has set none — in which case every new kind's ceiling is null. */
  accountDefault: CampaignAgentStrategy | null;
  campaign: CampaignAgentStrategy;
  network: NetworkCatalog;
  /** Null resolves the documents' own authority — the bindings' modes, the
   *  campaign's grants, the null-ceiling rule — and leaves
   *  availability to the run that spends it. That is what activation projects (`project.ts`):
   *  a connector can change under a campaign, a strategy version cannot. */
  connector: ConnectorDeclaration | null;
  /** The first sends and live checks recorded on the channel. Absent, none:
   *  the shipped table alone decides, so a caller that read none fails
   *  closed. */
  liveChecks?: LiveChecks;
  person?: PersonConstraints;
  now?: number;
};

export type ResolvedAction = {
  action_binding_id: string;
  step_id: string;
  worker: StrategyWorker;
  kind: ActionKind;
  label: string;
  capability: CapabilityId;
  target: TargetType;
  stored: NetworkAction["stored"];
  /** The binding's own mode before any ceiling — Off where it stores none;
   *  null for an action that takes no mode (Record outcome — the owner
   *  confirms). */
  requested: BindingMode | null;
  /** The strictest every ceiling allows. */
  ceiling: BindingMode | null;
  effective: BindingMode | null;
  /** Where an opener goes out to a lead by what their words show: the most it
   *  may be per intent, a key the binding leaves out at its default. Not
   *  lowered by anything above it: an opener's mode is the lower of this and
   *  `effective` (`openerModeFor`), so a cap that lowered the one lowers
   *  every intent. Null but for the Comment of a step that answers leads
   *  (`takesIntentCeilings`). */
  intent_ceilings: IntentCeilings | null;
  /** The scope that decided `effective`: the step whose binding set it — or
   *  the catalog's Off for one that sets none — when no ceiling lowered it,
   *  else the ceiling that did. */
  resolved_from: ResolvedFrom;
  versions: { account: number | null; campaign: number };
  reason: ResolveReason | null;
};

/** Every action the campaign's steps bind, resolved. */
export function resolveStrategy(input: ResolveInput): ResolvedAction[] {
  const steps = new Map(
    (input.campaign.steps ?? []).map((step) => [step.step_id, step]),
  );
  const resolved = (input.campaign.action_bindings ?? []).map((binding) => {
    const step = steps.get(binding.owner_step_id);
    if (!step) {
      throw new Error(
        `binding ${binding.action_binding_id} names no step; parse the strategy first`,
      );
    }
    return resolveBinding(input, step, binding);
  });
  return requireDmForFollowup(resolved);
}

/**
 * Follow-up continues a DM, so it can never exceed what DM resolved to — the
 * most any DM binding in the campaign allows, and Off with none.
 */
export function requireDmForFollowup(
  resolved: readonly ResolvedAction[],
): ResolvedAction[] {
  const dm = resolved
    .filter((action) => action.stored === "dm")
    .reduce<ActionMode>(
      (most, action) => looser(most, action.effective as ActionMode),
      "off",
    );
  return resolved.map((action) =>
    action.stored === "followup" ? capFollowup(action, dm) : action,
  );
}

/** One step's actions. */
export function resolveStep(
  input: ResolveInput,
  stepId: string,
): ResolvedAction[] {
  return resolveStrategy(input).filter((action) => action.step_id === stepId);
}

/**
 * The mode an opener goes out at to someone of this intent: the lower of the
 * Comment action's mode — as the binding stores it (`requested`), or as it
 * resolves now (`effective`) — and the intent's ceiling. Off where there is
 * no such action, or it is. Pure.
 */
export function openerModeFor(
  action: Pick<ResolvedAction, "requested" | "effective" | "intent_ceilings"> | undefined,
  intent: ScoutIntent,
  read: "requested" | "effective" = "effective",
): ActionMode {
  const mode = action?.[read];
  if (mode !== "review" && mode !== "auto") return "off";
  return stricterMode(mode, action?.intent_ceilings?.[intent] ?? "auto");
}

type Constraint = {
  mode: BindingMode;
  reason: ResolveReason;
  from: ResolvedFrom;
};

function resolveBinding(
  input: ResolveInput,
  step: StrategyStep,
  binding: ActionBinding,
): ResolvedAction {
  const row = networkActionFor(input.network, binding.capability_ref, step.catalog_step);
  if (!row.ok) {
    throw new Error(
      `binding ${binding.action_binding_id} has no ${input.network.network} row (${row.reason}); parse the strategy first`,
    );
  }
  const action = row.action;
  const target = binding.target ?? action.defaultTarget;
  const base = {
    action_binding_id: binding.action_binding_id,
    step_id: step.step_id,
    worker: step.worker,
    kind: action.kind,
    label: action.label,
    capability: binding.capability_ref,
    target,
    stored: action.stored,
    intent_ceilings: takesIntentCeilings(input.campaign, step, binding) ? intentCeilingsOf(binding.intent_ceilings) : null,
    versions: {
      account: input.accountDefault?.version ?? null,
      campaign: input.campaign.version,
    },
  };

  if (action.modes === null) {
    return {
      ...base,
      requested: null,
      ceiling: null,
      effective: null,
      resolved_from: "catalog",
      reason: null,
    };
  }

  const available =
    input.connector === null || capabilityAvailable(binding.capability_ref, input.connector, target);
  const unavailable: Constraint = { mode: "off", reason: "capability_unavailable", from: "connector" };

  const from: ResolvedFrom = binding.mode === undefined ? "catalog" : "step";
  if (action.stored === "step_switch" || action.stored === null) {
    // A read is the step's own switch: On / Off.
    return settle(base, READ_MODES, binding.mode ?? "off", from, available ? [] : [unavailable]);
  }

  const key = action.stored;
  const requested = (binding.mode ?? "off") as ActionMode;
  const constraints: Constraint[] = [];
  if (!available) constraints.push(unavailable);
  // Until the account confirms one, each of it waits for the owner's yes, on
  // every connector (INV-31).
  if (firstSendPending(binding.capability_ref, input.liveChecks)) {
    constraints.push({ mode: "review", reason: "first_send_pending", from: "catalog" });
  }
  const grant = MODE_GRANTS[key];
  if (!input.campaign.grants.includes(grant)) {
    constraints.push({ mode: "off", reason: "grant_missing", from: "campaign" });
  }
  if (isBudgeted(key)) {
    if (!hasCeiling(input.accountDefault, key)) {
      constraints.push({ mode: "review", reason: "ceiling_null", from: "account" });
    }
    if (
      input.now !== undefined &&
      !withinWindows(input.accountDefault?.schedule, input.now)
    ) {
      constraints.push({ mode: "off", reason: "outside_window", from: "account" });
    }
  }
  const personCap = input.person?.max_mode?.[key];
  if (personCap) {
    constraints.push({ mode: personCap, reason: "person_constraint", from: "person" });
  }
  return settle(base, ACTION_MODES, requested, from, constraints);
}

function settle(
  base: Omit<
    ResolvedAction,
    "requested" | "ceiling" | "effective" | "resolved_from" | "reason"
  >,
  order: readonly BindingMode[],
  requested: BindingMode,
  from: ResolvedFrom,
  constraints: Constraint[],
): ResolvedAction {
  const top = order[order.length - 1]!;
  // The strictest ceiling wins; between equals, the earlier layer names it.
  const strictest = constraints.reduce<Constraint | null>(
    (held, next) =>
      held === null || rank(order, next.mode) < rank(order, held.mode)
        ? next
        : held,
    null,
  );
  const ceiling = strictest?.mode ?? top;
  const lowered = rank(order, ceiling) < rank(order, requested);
  return {
    ...base,
    requested,
    ceiling,
    effective: lowered ? ceiling : requested,
    resolved_from: lowered ? strictest!.from : from,
    reason: lowered ? strictest!.reason : null,
  };
}

function capFollowup(action: ResolvedAction, dm: ActionMode): ResolvedAction {
  const effective = action.effective as ActionMode;
  if (rank(ACTION_MODES, dm) >= rank(ACTION_MODES, effective)) return action;
  return {
    ...action,
    ceiling: dm,
    effective: dm,
    resolved_from: "campaign",
    reason: "requires_dm",
  };
}

function rank(order: readonly BindingMode[], mode: BindingMode): number {
  return order.indexOf(mode);
}

function looser(a: ActionMode, b: ActionMode): ActionMode {
  return rank(ACTION_MODES, a) >= rank(ACTION_MODES, b) ? a : b;
}

function isBudgeted(key: ModeKey): key is BudgetedModeKey {
  return (BUDGETED_MODE_KEYS as readonly ModeKey[]).includes(key);
}

/** Whether the account default holds a non-null ceiling for a new kind. A DM —
 *  and a follow-up, which is one — also needs the per-person 30-day cap.
 *  Exported for the Channel's account policy, which says the same thing. */
export function hasCeiling(
  accountDefault: CampaignAgentStrategy | null,
  key: BudgetedModeKey,
): boolean {
  const budgets = accountDefault?.budgets;
  if (!budgets) return false;
  if (budgets.action_budgets_per_rolling_24h[key] === null) return false;
  if (key === "followup" && budgets.action_budgets_per_rolling_24h.dm === null) {
    return false;
  }
  if (
    (key === "dm" || key === "followup") &&
    budgets.max_outbound_dms_per_person_per_30d === null
  ) {
    return false;
  }
  return true;
}

const ISO_WEEKDAY: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * The first instant at or after `from` that falls inside one of the windows,
 * in the schedule's zone — `from` itself inside one, which no window at all
 * (an empty list, or no schedule) always is (`withinWindows`). What "sent in
 * the next allowed window" waits for: the dispatch gate holds an unattended
 * send until then (`execution/actionGate.ts`), and a follow-up that came due
 * says when it can go. Daylight saving comes from the zone (spec §14). Pure.
 */
export function nextWindowStart(
  schedule: CampaignAgentStrategy["schedule"],
  from: number,
): number | null {
  if (!schedule || withinWindows(schedule, from)) return from;
  const local = zonedParts(schedule.timezone, from);
  let best: number | null = null;
  // A window recurs weekly, so a week and a day of local dates holds the next
  // start of every one.
  for (let day = 0; day <= 7; day += 1) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + day));
    const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    for (const window of schedule.allowed_windows) {
      if (!window.weekdays.includes(weekday)) continue;
      const [hour, minute] = window.start_local.split(":").map(Number) as [number, number];
      const start = zonedInstant(
        schedule.timezone,
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        hour,
        minute,
      );
      if (start >= from && (best === null || start < best)) best = start;
    }
  }
  return best;
}

/** The wall-clock date and time an instant shows in a zone. */
function zonedParts(timeZone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

/** The instant a zone's wall clock reads this date and time — the zone's
 *  offset taken at the guess, then again at the answer, which settles a
 *  daylight-saving edge between them. */
function zonedInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (at: number) => {
    const shown = zonedParts(timeZone, at);
    return Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) - at;
  };
  return wall - offsetAt(wall - offsetAt(wall));
}

/** Whether `now` falls inside one of the windows, in the schedule's zone. No
 *  window SET — an empty list, or no account default and so no schedule at
 *  all — leaves the channel's active hours the only ones: they bind every
 *  unattended send in `canEngage`. A missing window is not a closed one, which
 *  would turn Automatic, and the owner's yes, into never (INV-6). The dispatch
 *  gate holds a new kind outside the windows that are set
 *  (`execution/actionGate.ts`). */
export function withinWindows(
  schedule: CampaignAgentStrategy["schedule"],
  now: number,
): boolean {
  if (!schedule || schedule.allowed_windows.length === 0) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ISO_WEEKDAY[part("weekday")];
  const local = `${part("hour")}:${part("minute")}`;
  return schedule.allowed_windows.some(
    (window) =>
      weekday !== undefined &&
      window.weekdays.includes(weekday) &&
      local >= window.start_local &&
      local < window.end_local,
  );
}

type Span = { weekdays: readonly number[]; start: string; end: string };

const sameDays = (a: Span, b: Span) =>
  [...a.weekdays].sort((x, y) => x - y).join(",") === [...b.weekdays].sort((x, y) => x - y).join(",");

/**
 * Windows as the owner set them: hours past midnight are stored as two
 * windows on the same days — to 24:00, and from 00:00 — and are said as the
 * one span they were split from, 09:00–01:00. Every other window is said as
 * it is, in its place. What the account's card and its page both print, so
 * the two never read differently. Pure.
 */
export function joinAtMidnight<T extends Span>(windows: readonly T[]): T[] {
  const mornings = new Map<T, T>();
  const taken = new Set<T>();
  for (const evening of windows) {
    if (evening.end !== "24:00" || evening.start === "00:00") continue;
    const morning = windows.find(
      (other) => !taken.has(other) && other.start === "00:00" && other.end !== "24:00" && sameDays(other, evening),
    );
    if (!morning) continue;
    mornings.set(evening, morning);
    taken.add(morning);
  }
  return windows.flatMap((window) => {
    if (taken.has(window)) return [];
    const morning = mornings.get(window);
    return [morning ? { ...window, end: morning.end } : window];
  });
}

type Windows = Pick<NonNullable<CampaignAgentStrategy["schedule"]>, "timezone" | "allowed_windows">;

const minutes = (hhmm: string): number => {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  return hour * 60 + minute;
};

/**
 * Whether `after` lets a send out at an instant `before` did not: a minute
 * of some weekday none of the old windows covered, or the windows moved to
 * another zone. Hours past midnight are two windows, and each is walked on
 * its own days, so 09:00–01:00 narrowed to 09:00–23:00 widens nothing. None
 * set is every hour, within the channel's active hours: any window set from
 * none narrows, and clearing the windows widens. What classifies an account
 * change (`accountWidenings`), and what the account's page previews before it
 * sends one. Pure.
 */
export function windowsWiden(before: Windows, after: Windows): boolean {
  if (before.allowed_windows.length === 0) return false;
  if (after.allowed_windows.length === 0) return true;
  if (before.timezone !== after.timezone) return true;
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const covered = (schedule: Windows) =>
      schedule.allowed_windows
        .filter((window) => window.weekdays.includes(weekday))
        .map((window) => [minutes(window.start_local), minutes(window.end_local)] as const);
    const old = covered(before);
    for (const [start, end] of covered(after)) {
      // Walk the new window forward over the old ones; a gap is a widening.
      let cursor = start;
      while (cursor < end) {
        const over = old.find(([s, e]) => s <= cursor && cursor < e);
        if (!over) return true;
        cursor = over[1];
      }
    }
  }
  return false;
}
