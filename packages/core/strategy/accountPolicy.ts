import { eq } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import {
  campaignStrategies,
  channels,
  type CampaignStrategyRow,
  type Channel,
  type StrategyProvenance,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { channelCeilings } from "../ratelimit/ledger";
import { activateStrategy, inForceOnChannel } from "./activate";
import {
  BUDGETED_MODE_KEYS,
  MODE_KEYS,
  MODE_KEY_LABELS,
  NETWORK_CATALOGS,
  type BudgetedModeKey,
  type ModeKey,
} from "./catalog";
import { strategyIssueCode, parseStrategy, type CampaignAgentStrategy } from "./contract";
import { documentChanges } from "./flip";
import { joinAtMidnight, windowsWiden } from "./resolve";
import { accountDefaultSeed } from "./seed";

/**
 * THE ACCOUNT DEFAULT'S ONE WRITER — the numbers every campaign on the channel
 * spends: the rolling-24h ceilings without which a step's Automatic stays Ask
 * me, the per-person DM cap, and the windows unattended sends go out in.
 * Exposure is the account's (INV-4), so these live on the account default and
 * nowhere else; the contract refuses them on a campaign. The account keeps no
 * mode per action: a step's mode is what happens (INV-28), so a change here
 * carries numbers and hours only, and the `grants` and `max_mode` an older
 * default still stores are carried forward unread.
 *
 * A change is TYPED — a ceiling is a number the owner typed, never a toggle —
 * and drawn against the version in force, then classified from its own diff
 * the way a campaign's patch is (INV-26): `confirm` when it lets the account
 * do more unattended — a ceiling set or raised, a window widened — and
 * `apply` when it only holds the account closer. In chat both
 * are a card the owner spends (`chat/proposalKinds.ts`); nothing else writes
 * an account default.
 *
 * Applying writes ONE new version, active at once, and archives the one it
 * replaces: versions are appended, never rewritten. Every flagged campaign on
 * the channel is then re-projected in the same transaction — its switches
 * resolve through the account default (INV-25), so a ceiling that moved
 * reaches each of them now or not at all.
 *
 * An account with no default yet is drawn against `accountDefaultSeed`, which
 * resolves every campaign exactly as no default does: the first change writes
 * version 1, and only what the owner changed moves.
 */

export const ACCOUNT_POLICY_UPDATE = "account_policy.update";
export const ACCOUNT_POLICY_COMPILER_VERSION = "account-policy/1";

/** One sending window, as a change names it — a fresh schema each time it
 *  is used: a shared one is written once and then as a `$ref` to it, which
 *  not every client that reads these schemas follows. */
const sendingWindow = () =>
  z
    .object({
      timezone: z.string(),
      weekdays: z.array(z.number().int()),
      start: z.string(),
      end: z.string(),
    })
    .strict();

/**
 * One change to the account's policy — every field optional, and each a value
 * the owner typed. `action` names the one action a ceiling is about; the
 * per-person DM cap and the sending windows are the account's whole, so a
 * change to them names none:
 *
 *   ceiling             the most of `action` that may go out in any 24 hours
 *                       WITHOUT the owner's yes; 0 permits none, null clears
 *                       it and its Automatic waits for a yes again. Only the
 *                       new kinds have one: Comment's and Reply's is the day
 *                       plan, changed on Limits
 *   dmsPerPersonPer30d  the per-person cap a DM's Automatic needs as well
 *   windows             when an unattended send may go out — every window in
 *                       one IANA zone, ISO weekdays (Monday = 1) and HH:MM
 *                       that never crosses midnight: hours that run past it
 *                       are two windows on the same days, to 24:00 and from
 *                       00:00, the small hours counted on their own calendar
 *                       day as the active hours count them; [] sets none,
 *                       and the channel's active hours alone decide
 *   window              one window, or null for none — `windows` as it was
 *                       before the list, kept for one release; a change sets
 *                       one of the two
 *
 * One action per card keeps the schema small: it rides every chat step inside
 * `propose_change`, so its field names are the whole of what the model reads,
 * and the meaning lives here and in the engager-status skill. Its ranges are
 * the contract's, checked on the document the change makes (a negative
 * ceiling, a zone that is not one, a window crossing midnight), so the schema
 * does not spell them a second time.
 */
export const accountPolicyUpdateSchema = z
  .object({
    kind: z.literal(ACCOUNT_POLICY_UPDATE),
    action: z.enum(MODE_KEYS).optional(),
    ceiling: z.number().int().nullable().optional(),
    dmsPerPersonPer30d: z.number().int().nullable().optional(),
    windows: z.array(sendingWindow()).optional(),
    window: sendingWindow().nullable().optional(),
  })
  .strict();
export type AccountPolicyUpdate = z.infer<typeof accountPolicyUpdateSchema>;

export type AccountPolicyRefusal =
  | "no_channel"
  | "account_policy_invalid"
  | "proposal_is_a_no_op"
  | "account_policy_conflict";

export class AccountPolicyError extends AppError {
  constructor(
    code: AccountPolicyRefusal,
    message: string,
    readonly recovery: string,
  ) {
    super(code, message, code === "account_policy_invalid" ? 400 : 409);
  }
}

/** The channel, its account default's versions, and the document in force —
 *  or the seed an account with none is drawn against. */
export type AccountPolicyState = {
  channel: Pick<Channel, "id" | "network">;
  versions: CampaignStrategyRow[];
  active: CampaignStrategyRow | null;
  base: CampaignAgentStrategy;
};

/** The zone an account with no default yet is drawn in: its day plan's. */
export function accountZone(channel: Pick<Channel, "activeHours">): string {
  return channel.activeHours?.tz ?? "UTC";
}

/** `lock` takes the channel row first, so two changes to one account default
 *  serialize and the version they draw against is never raced. */
export async function readAccountPolicyState(
  tx: Tx,
  options: { lock: boolean; now: number },
): Promise<AccountPolicyState> {
  const found = await channelCeilings(tx);
  if (!found) {
    throw new AccountPolicyError(
      "no_channel",
      "No account is connected, so there is no account policy to change.",
      "Connect the LinkedIn account first.",
    );
  }
  if (options.lock) {
    await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, found.id)).for("update");
  }
  const versions = await tx
    .select()
    .from(campaignStrategies)
    .where(eq(campaignStrategies.channelId, found.id));
  const active = versions.find((row) => row.status === "active") ?? null;
  const network = NETWORK_CATALOGS[found.network];
  let base = accountDefaultSeed(accountZone(found), options.now);
  if (active) {
    const parsed = parseStrategy(active.document, { network });
    if (!parsed.success) {
      throw invalid(`the account default in force (version ${active.version})`, parsed.error.issues);
    }
    base = parsed.data;
  }
  return { channel: { id: found.id, network: found.network }, versions, active, base };
}

function invalid(what: string, issues: Parameters<typeof strategyIssueCode>[0][]): AccountPolicyError {
  return new AccountPolicyError(
    "account_policy_invalid",
    `${what} does not satisfy the strategy contract, so nothing was written: ${issues
      .map((issue) => `${issue.path.join(".") || "/"} — ${issue.message}`)
      .join("; ")}.`,
    "Fix the named fields and propose the change again.",
  );
}

/** The change, set onto a copy of the document. Pure. A ceiling for an
 *  action that has none to set is refused, never dropped. */
export function withAccountPolicy(
  document: CampaignAgentStrategy,
  change: AccountPolicyUpdate,
): CampaignAgentStrategy {
  const next = structuredClone(document);
  const budgets = next.budgets!;
  // A field about one action names it; one about the whole account does not.
  const about = (field: string): ModeKey => {
    if (change.action) return change.action;
    throw new AccountPolicyError(
      "account_policy_invalid",
      `A ${field} is about one action, and this change names none.`,
      "Name the action it is about, and propose the change again.",
    );
  };
  if (change.ceiling !== undefined) {
    const action = about("ceiling");
    if (!isBudgeted(action)) {
      throw new AccountPolicyError(
        "account_policy_invalid",
        `${MODE_KEY_LABELS[action]} has no rolling-24h ceiling: its ceiling is the day plan.`,
        "Change it on Limits (pacing.update), or propose the ceiling of a like, an invitation, an acceptance, a DM or a follow-up.",
      );
    }
    budgets.action_budgets_per_rolling_24h[action] = change.ceiling;
  }
  if (change.dmsPerPersonPer30d !== undefined) {
    budgets.max_outbound_dms_per_person_per_30d = change.dmsPerPersonPer30d;
  }
  const windows = sendingWindows(change);
  if (windows !== undefined) {
    const zones = new Set(windows.map((window) => window.timezone));
    if (zones.size > 1) {
      throw new AccountPolicyError(
        "account_policy_invalid",
        `The sending windows share one timezone, and these name ${zones.size}: ${[...zones].join(", ")}.`,
        "Give every window the same timezone, and propose the change again.",
      );
    }
    next.schedule = {
      ...next.schedule!,
      ...(windows[0] ? { timezone: windows[0].timezone } : {}),
      allowed_windows: windows.map((window) => ({
        weekdays: window.weekdays,
        start_local: window.start,
        end_local: window.end,
      })),
    };
  }
  return next;
}

/** The sending windows a change sets, as a list — the one `window` it may
 *  still name as a list of one, and null as none — or undefined when it
 *  sets none. Both at once are refused, never merged. */
function sendingWindows(change: AccountPolicyUpdate): AccountPolicyUpdate["windows"] {
  if (change.window === undefined) return change.windows;
  if (change.windows !== undefined) {
    throw new AccountPolicyError(
      "account_policy_invalid",
      "This change sets the sending windows twice: `window` and `windows` are one setting.",
      "Send `windows` alone — [] for none — and propose the change again.",
    );
  }
  return change.window === null ? [] : [change.window];
}

function isBudgeted(key: ModeKey): key is BudgetedModeKey {
  return (BUDGETED_MODE_KEYS as readonly ModeKey[]).includes(key);
}

/** One way a change lets the account do more without the owner's yes. */
export type AccountWidening =
  | { kind: "ceiling_rises"; key: BudgetedModeKey; from: number | null; to: number | null }
  | { kind: "person_cap_rises"; from: number | null; to: number | null }
  | { kind: "windows_widen" };

/** A null ceiling holds Automatic at Ask me, so any number is more than it. */
const rises = (from: number | null, to: number | null): boolean =>
  to !== null && (from === null || to > from);

/**
 * Every way `after` lets the account do more unattended than `before`. Pure.
 * A window change widens when it covers a minute the old windows did not, moves
 * them to another zone, or clears them (none set is every hour, within the
 * channel's active hours).
 */
export function accountWidenings(
  before: CampaignAgentStrategy,
  after: CampaignAgentStrategy,
): AccountWidening[] {
  const out: AccountWidening[] = [];
  const [was, now] = [before.budgets!, after.budgets!];
  for (const key of BUDGETED_MODE_KEYS) {
    const [from, to] = [was.action_budgets_per_rolling_24h[key], now.action_budgets_per_rolling_24h[key]];
    if (rises(from, to)) out.push({ kind: "ceiling_rises", key, from, to });
  }
  if (rises(was.max_outbound_dms_per_person_per_30d, now.max_outbound_dms_per_person_per_30d)) {
    out.push({
      kind: "person_cap_rises",
      from: was.max_outbound_dms_per_person_per_30d,
      to: now.max_outbound_dms_per_person_per_30d,
    });
  }
  if (windowsWiden(before.schedule!, after.schedule!)) out.push({ kind: "windows_widen" });
  return out;
}

type Schedule = NonNullable<CampaignAgentStrategy["schedule"]>;

/** One line of the card, old → new. */
export type AccountPolicyRow = { label: string; before: string; after: string };

const NOUNS: Record<BudgetedModeKey, string> = {
  like_target: "likes",
  invite: "invitations",
  accept_invite: "acceptances",
  dm: "DMs",
  followup: "follow-ups",
};

const ceilingCopy = (value: number | null): string =>
  value === null ? "not set — Automatic waits for a yes" : value === 0 ? "0 (none without a yes)" : String(value);

/** The windows as the owner set them — a pair split at midnight as its one
 *  span (`joinAtMidnight`), all seven days as every day. */
function windowsCopy(schedule: Schedule): string {
  if (schedule.allowed_windows.length === 0) return "none set — your active hours decide";
  const days = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const spans = joinAtMidnight(
    schedule.allowed_windows.map((window) => ({
      weekdays: window.weekdays,
      start: window.start_local,
      end: window.end_local,
    })),
  );
  return `${spans
    .map((span) => {
      const on = span.weekdays.length === 7 ? "Every day" : span.weekdays.map((day) => days[day]).join(",");
      return `${on} ${span.start}–${span.end}`;
    })
    .join("; ")} (${schedule.timezone})`;
}

/** The diff the owner reads, by what each field means. Pure. */
export function accountPolicyRows(
  before: CampaignAgentStrategy,
  after: CampaignAgentStrategy,
): AccountPolicyRow[] {
  const rows: AccountPolicyRow[] = [];
  const push = (label: string, from: string, to: string) => {
    if (from !== to) rows.push({ label, before: from, after: to });
  };
  for (const key of BUDGETED_MODE_KEYS) {
    push(
      `${MODE_KEY_LABELS[key]} · most in any 24 hours without your yes`,
      ceilingCopy(before.budgets!.action_budgets_per_rolling_24h[key]),
      ceilingCopy(after.budgets!.action_budgets_per_rolling_24h[key]),
    );
  }
  push(
    "DMs to one person · most in 30 days",
    ceilingCopy(before.budgets!.max_outbound_dms_per_person_per_30d),
    ceilingCopy(after.budgets!.max_outbound_dms_per_person_per_30d),
  );
  push("Sending windows without your yes", windowsCopy(before.schedule!), windowsCopy(after.schedule!));
  return rows;
}

/** What the change does, said plainly — the spec's required preview (§09).
 *  Pure. */
export function accountPolicyPreview(
  before: CampaignAgentStrategy,
  after: CampaignAgentStrategy,
): string[] {
  const out: string[] = [];
  for (const key of BUDGETED_MODE_KEYS) {
    const [from, to] = [
      before.budgets!.action_budgets_per_rolling_24h[key],
      after.budgets!.action_budgets_per_rolling_24h[key],
    ];
    if (from === to) continue;
    out.push(
      to === null
        ? `Every one of your ${NOUNS[key]} waits for your yes again.`
        : to === 0
          ? `No ${NOUNS[key].slice(0, -1)} goes out without your yes: a ceiling of 0 permits none.`
          : `Up to ${to} ${NOUNS[key]} in any 24 hours may go out without your yes, on a campaign that asks Automatic for them — each checked again just before it goes, and none kept to make up the number later.`,
    );
  }
  if (windowsCopy(before.schedule!) !== windowsCopy(after.schedule!)) {
    out.push(
      after.schedule!.allowed_windows.length === 0
        ? "With no window set, those go out whenever your active hours allow."
        : `Those go out only inside ${windowsCopy(after.schedule!)}; outside it they wait for the next window.`,
    );
  }
  return out;
}

export type PreparedAccountPolicy = {
  state: AccountPolicyState;
  version: number;
  document: CampaignAgentStrategy;
  level: "confirm" | "apply";
  widenings: AccountWidening[];
  changes: StrategyProvenance["changes"];
  title: string;
  rows: AccountPolicyRow[];
  preview: string[];
};

/** The new version a change would write, validated and classified. Pure. */
export function prepareAccountPolicy(
  state: AccountPolicyState,
  change: AccountPolicyUpdate,
  now: number,
): PreparedAccountPolicy {
  const version = Math.max(0, ...state.versions.map((row) => row.version)) + 1;
  const stamped = {
    ...withAccountPolicy(state.base, change),
    version,
    previous_version: state.active?.version ?? null,
    effective_at: new Date(now).toISOString(),
  };
  const parsed = parseStrategy(stamped, { network: NETWORK_CATALOGS[state.channel.network] });
  if (!parsed.success) throw invalid("This change", parsed.error.issues);
  const changes = documentChanges(state.base, parsed.data);
  if (changes.length === 0) {
    throw new AccountPolicyError(
      "proposal_is_a_no_op",
      "this change would move nothing",
      "Nothing was written. The account already says this; tell the owner so, or propose a value that differs from it.",
    );
  }
  const widenings = accountWidenings(state.base, parsed.data);
  return {
    state,
    version,
    document: parsed.data,
    level: widenings.length > 0 ? "confirm" : "apply",
    widenings,
    changes,
    title:
      widenings.length > 0
        ? "Let this account send more without your yes"
        : "Hold this account to fewer sends without your yes",
    rows: accountPolicyRows(state.base, parsed.data),
    preview: accountPolicyPreview(state.base, parsed.data),
  };
}

export type AccountPolicyApplied = {
  channelId: number;
  version: number;
  level: "confirm" | "apply";
  changes: StrategyProvenance["changes"];
  /** The flagged campaigns re-projected under the new version. */
  reprojected: number[];
};

/**
 * Land a change: draw it again under the channel's lock, write its version
 * active, archive the one it replaced, and re-project every flagged campaign
 * on the channel — one transaction, the caller's.
 */
export async function applyAccountPolicy(
  tx: Tx,
  change: AccountPolicyUpdate,
  options: { approver: string | null; now: number },
): Promise<AccountPolicyApplied> {
  const prepared = prepareAccountPolicy(
    await readAccountPolicyState(tx, { lock: true, now: options.now }),
    change,
    options.now,
  );
  const { channel, active } = prepared.state;
  // Archive before writing: one active version per channel at every statement.
  if (active) {
    await tx
      .update(campaignStrategies)
      .set({ status: "archived" })
      .where(eq(campaignStrategies.id, active.id));
  }
  await tx.insert(campaignStrategies).values({
    campaignId: null,
    channelId: channel.id,
    version: prepared.version,
    status: "active",
    baseVersion: active?.version ?? null,
    document: prepared.document,
    patchProvenance: {
      source: "patch",
      instruction: null,
      intent: ACCOUNT_POLICY_UPDATE,
      scope: null,
      changes: prepared.changes,
      compilerVersion: ACCOUNT_POLICY_COMPILER_VERSION,
      approver: options.approver,
    },
    effectiveAt: options.now,
    createdAt: options.now,
  });
  const inForce = await inForceOnChannel(tx, channel.id);
  for (const row of inForce) {
    await activateStrategy(tx, row, options.now);
  }
  return {
    channelId: channel.id,
    version: prepared.version,
    level: prepared.level,
    changes: prepared.changes,
    reprojected: inForce.map((row) => row.campaignId),
  };
}
