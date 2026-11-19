import { eq } from "drizzle-orm";
import { channels } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import {
  CAP_BUCKETS,
  MODE_KEYS,
  MODE_NAMES,
  type TelemetryProps,
} from "@engager/observability/events";
import { modesByKey, parseStrategy } from "../../strategy/contract";
import { readCampaignStrategy } from "../../strategy/read";
import { readWindowChoice } from "../../linkedin/browser-use/windowChoice";
import { linkedInConnectionState } from "../../linkedin/liveness";
import { DEFAULT_NETWORK } from "../../network/registry";
import { listCampaigns } from "../../operations/campaigns";
import { listWorkers } from "../../operations/workers";
import type { HandlerCtx } from "../context";

type InstallActive = TelemetryProps<"install_active">;
type ModeCounts = Pick<InstallActive, `${(typeof MODE_KEYS)[number]}_${(typeof MODE_NAMES)[number]}`>;

/** A daily cap in the buckets the catalog allows. Null is the account's
 * default, which is its own bucket: a default says nothing about the owner. */
export function capBucket(cap: number | null | undefined): (typeof CAP_BUCKETS)[number] {
  if (cap === null || cap === undefined) return "default";
  if (cap <= 0) return "0";
  if (cap <= 5) return "1-5";
  if (cap <= 10) return "6-10";
  if (cap <= 20) return "11-20";
  if (cap <= 40) return "21-40";
  return "41+";
}

/** The product says "Ask me"; the strategy stores `review`. */
function modeName(stored: unknown): (typeof MODE_NAMES)[number] {
  return stored === "auto" ? "auto" : stored === "review" ? "ask" : "off";
}

/** How the account's session reads to telemetry: the probe's word, in the
 * five states the catalog allows. */
async function linkedinSession(tx: Tx): Promise<InstallActive["linkedin_session"]> {
  const state = await linkedInConnectionState(tx);
  if (state.status === "live") return "connected";
  if (state.reason === "account_restricted") return "restricted";
  if (state.reason === "checkpoint_required") return "challenge";
  if (state.status === "needs_signin" || state.status === "unverified") return "expired";
  return "none";
}

/**
 * What this install has set up, from rows alone. Counts and buckets: nothing
 * here is a name, a keyword or a piece of text, and a campaign the strategy
 * cannot be read for simply contributes no modes.
 */
export async function installActiveProperties(tx: Tx): Promise<InstallActive> {
  const campaigns = await listCampaigns(tx);
  const workers = await listWorkers(tx);
  const active = campaigns.filter((campaign) => campaign.status === "active");

  const counts: Record<string, number> = {};
  for (const key of MODE_KEYS) for (const mode of MODE_NAMES) counts[`${key}_${mode}`] = 0;
  for (const campaign of active) {
    const view = await readCampaignStrategy(tx, campaign.id).catch(() => null);
    const parsed = view ? parseStrategy(view.strategy.document, { network: null }) : null;
    if (!parsed?.success) continue;
    const modes: Partial<Record<string, string>> = modesByKey(parsed.data);
    for (const key of MODE_KEYS) {
      const slot = `${key}_${modeName(modes[key])}`;
      counts[slot] = (counts[slot] ?? 0) + 1;
    }
  }

  const [channel] = await tx
    .select({ comment: channels.dailyCommentCap, reply: channels.dailyReplyCap })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK));

  return {
    campaigns_active: active.length,
    campaigns_total: campaigns.length,
    workers_auto: workers.filter((worker) => worker.auto).length,
    ...(counts as ModeCounts),
    browser_visibility: readWindowChoice() === "shown" ? "shown" : "hidden",
    caps_comment: capBucket(channel?.comment),
    caps_reply: capBucket(channel?.reply),
    linkedin_session: await linkedinSession(tx),
  };
}

/**
 * The daily "this install is alive" event (Q6). The scheduler enqueues it once
 * per org per day; it reads rows and sends one event, so it holds no browser,
 * no provider and no lock beyond its own short transaction.
 */
export async function handleInstallActive(ctx: HandlerCtx): Promise<void> {
  track("install_active", await installActiveProperties(ctx.db));
}
