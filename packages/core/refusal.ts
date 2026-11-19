import type { ConnectorError } from "./linkedin/connectorError";

/** The four rungs, in order. Only CHANNEL spends budget (INV-13). */
export type RefusalLayer = "org" | "worker" | "channel" | "connector";

/**
 * A no, and which rung of the ladder said it.
 *
 * The layer is a FIELD rather than something a reader infers from the call
 * site, because every rule the ladder has is about WHO: CHANNEL is the only rung
 * that spends budget (INV-13); CONNECTOR reports physics, so a failure there
 * reconciles and never blind-retries (INV-10); ORG is the owner's own stop;
 * WORKER is cheap, soft, and never the whole answer. A refusal that says only
 * "no" flattens those four into one outcome — which is exactly how a null check
 * on a held driver, a layer-4 physical condition, passed for a layer-2 supply
 * check until T-1.1 deleted it, with nothing in the code able to notice.
 *
 * WORKER is now a row, not only a rung. Phase 8's `workers` table is the same
 * noun this layer already named, so the ladder stops being an abstraction with
 * four labels and becomes four things you can point at: the org, the worker
 * row, the channel it acts on, the connector behind that channel.
 *
 * `code` stays a plain string: the vocabulary belongs to the rung that refuses —
 * `throttled` here, `not_connected` at the resolver, the gate's own reasons at
 * layer 3 — and a union owned by this module would make every new rung edit it.
 *
 * The module sits BELOW the ladder: it takes the `ConnectorError` type and
 * nothing else, and never the ledger. Dependencies point DOWN into it — layer 4
 * imports it for `connectorRefusal`, and any rung above may — so it must not
 * import a rung back, or the type that names the layers would drag one of them
 * behind every consumer.
 */
export type Refusal = {
  layer: RefusalLayer;
  code: string;
  /** What actually happened, in the refusing rung's own words. */
  detail?: string;
  /** Epoch ms before which retrying is pointless. */
  retryAt?: number;
};

/** Layer 1 — the owner's global stop: the kill switch, entitlement. */
export function refuseOrg(code: string, detail?: string): Refusal {
  return { layer: "org", code, detail };
}

/** Layer 2 — nothing needed, no supply, the campaign is paused. True whatever
 *  the account and the connector are doing, which is why it is never alone. */
export function refuseWorker(code: string, detail?: string): Refusal {
  return { layer: "worker", code, detail };
}

/** Layer 3 — the daily cap, the window, the min-gap, per-profile anti-repeat,
 *  the risk pause: the only rung that spends the account's budget. `retryAt` is
 *  when the window it names reopens. */
export function refuseChannel(
  code: string,
  detail?: string,
  retryAt?: number,
): Refusal {
  return { layer: "channel", code, detail, retryAt };
}

/**
 * Layer 4 — physical only, and the one constructor `linkedin/*` may reach.
 *
 * Named unlike its three siblings on purpose: the suite scans the connector's
 * modules for `refuseOrg`/`refuseWorker`/`refuseChannel`, and those names
 * turning up down there is the failure itself — a connector authorising work,
 * or answering for a budget it does not hold.
 */
export function connectorRefusal(
  code: string,
  detail?: string,
  retryAt?: number,
): Refusal {
  return { layer: "connector", code, detail, retryAt };
}

/**
 * How long a connector backoff parks the account.
 *
 * A second copy of `CONNECTOR_BACKOFF_PAUSE_MINUTES` in
 * `ratelimit/killswitch.ts`, pinned equal by the suite. The dependency that
 * removes the duplication points DOWN — layer 3 reading this constant, not this
 * module reaching up for layer 3's — and taking it edits a file outside this
 * task. Until someone does, the pin carries the rule: the pause and the retry
 * must not disagree about how long the condition lasts, or the job wakes into a
 * gate that still refuses it.
 */
export const CONNECTOR_BACKOFF_PAUSE_MS = 15 * 60_000;

/**
 * A layer-4 error as the layer-4 refusal it always was.
 *
 * T-2.11's taxonomy is two booleans, and the orchestrator sites all read them
 * the same way: a throttle or a checkpoint is the ACCOUNT under pressure, and
 * layer 3 parks it for the backoff window; anything else is one call that
 * failed. This states that once, in the vocabulary the rest of the ladder
 * speaks — and it decides nothing on the way. Reporting a throttle is not
 * pausing an account, and neither is a spend.
 *
 * CHECKPOINT OUTRANKS THE THROTTLE, because an error carrying both is the
 * normal case and not a corner: the sidecar raises `CHECKPOINT_REQUIRED` with
 * `rate_limited=True`, so testing `rateLimited` first would report every
 * challenged account as merely busy. `pauseChannelForConnectorBackoff` already
 * breaks the tie the same way, and the two codes are not interchangeable to the
 * owner who reads them in the run log: throttled says wait, checkpoint says go
 * clear a challenge.
 *
 * SIGN-IN OUTRANKS BOTH, and carries no `retryAt`. It is the only one of the
 * three that a window cannot fix — nobody is signed in, and the owner is the
 * only one who can be. Naming a retry time would invite the caller to park the
 * account for it, which is exactly the fifteen minutes a signed-out sweep spent
 * on a blank free install before this refusal existed (2026-09-15).
 */
export function refusalFromConnectorError(
  e: ConnectorError,
  now = Date.now(),
): Refusal {
  if (e.signIn) return connectorRefusal("login_required", e.message);
  if (e.checkpoint)
    return connectorRefusal(
      "checkpoint",
      e.message,
      now + CONNECTOR_BACKOFF_PAUSE_MS,
    );
  if (e.rateLimited)
    return connectorRefusal(
      "throttled",
      e.message,
      now + CONNECTOR_BACKOFF_PAUSE_MS,
    );
  return connectorRefusal("connector_failed", e.message);
}
