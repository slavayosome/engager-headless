import { and, eq } from "drizzle-orm";
import { channels, systemState } from "@engager/database/schema";
import { afterCommit, withOrg, type Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import type { ConnectorBinding } from "../connector/binding";
import type { CapabilitySurface } from "../connector/resolve";
import { DEFAULT_NETWORK } from "../network/registry";
import { setChannelDisplayName } from "../profile";
import { isConnectorDrift } from "./connectorError";
import type { EnsureSessionOptions, SessionStatus, WindowPlace } from "./driver";
import { linkedInSessionStored } from "./session";
import { observeAccount } from "../execution/authority";

/**
 * ONE answer to "is LinkedIn live, as whom, confirmed when?".
 *
 * Three surfaces used to answer this three different ways and none of them
 * meant the session worked: `get_channel` returned the driver NAME
 * (`!== "mock"`, unconditionally true on any local install), while the setup
 * rail, Channels and Radar asked whether the browser profile DIRECTORY existed
 * — which Chromium creates when it launches, before any sign-in. A fresh
 * install therefore showed "LinkedIn ✓" against the very probe that returned
 * `login_required`. Everything now derives from a persisted probe result.
 */

/** How long a successful probe is treated as current before a surface starts
 *  saying "not verified since …" instead of "connected". Not a disconnection:
 *  the session usually still works, we simply have not looked recently. */
const FRESH_FOR_MS = 24 * 60 * 60 * 1000;

/** Hard ceiling on a wait-for-sign-in. Long enough for a real sign-in with 2FA,
 *  short enough that a concurrent job waiting on the serialized sidecar queue
 *  is delayed by a bounded amount. */
export const MAX_WAIT_FOR_SIGN_IN_MS = 90_000;

/** How often the sign-in wait re-reads the session. Two seconds because each
 *  tick costs one in-page snapshot and nothing else: the sidecar navigates
 *  only when NO page is on the LinkedIn origin, which a `login_required` or
 *  `checkpoint_required` answer already disproves. The owner finishing their
 *  sign-in is noticed within a couple of seconds rather than four. */
const POLL_INTERVAL_MS = 2_000;

/** Reasons that mean "the owner has something to do", i.e. worth waiting on.
 *  `account_restricted` is deliberately absent — waiting cannot fix it, and
 *  the sidecar rate-limits it. */
const AWAITABLE_REASONS = new Set(["login_required", "checkpoint_required"]);

export type LinkedInConnectionStatus =
  /** Nothing was ever established here: no credential, no probe. */
  | "not_configured"
  /** Something was, but no browser session exists: never opened, or — on a
   *  hosted channel — none running right now, whatever the last probe said. */
  | "no_session"
  /** A probe says the owner must sign in (or clear a checkpoint). */
  | "needs_signin"
  /** A session exists but no successful probe is on record, or it is stale. */
  | "unverified"
  /** A probe succeeded recently. The only status that means "it works". */
  | "live";

export type LinkedInConnectionState = {
  status: LinkedInConnectionStatus;
  /**
   * Whether the account is signed in as far as anything has seen — the single
   * boolean every legacy caller should use. True for "live", and for an
   * "unverified" account whose last check succeeded: an aged-out check is not
   * a disconnection, and while the owner's own Test connection was the only
   * thing that checked, an account posting all day read signed out every day.
   */
  connected: boolean;
  accountName: string | null;
  /**
   * The channel row's stable account id, when a probe has stamped one. The
   * display name is what the account calls ITSELF today and changes whenever
   * the owner renames the profile; this does not. Surfaces that answer "as
   * whom" name both, so a rename cannot silently rewrite who they say is
   * connected. Null until the first successful probe reports an identity.
   */
  externalAccountId: string | null;
  /** Last time a probe succeeded. */
  confirmedAt: number | null;
  /** Last time a probe ran, whatever the outcome. */
  checkedAt: number | null;
  /** The most recent probe's failure reason, when it failed. */
  reason: string | null;
};

export type LinkedInLiveness = {
  okAt: number | null;
  checkedAt: number | null;
  reason: string | null;
};

/** The persisted probe record for this org — read off the CHANNEL row, which is
 *  the account these facts describe. They used to sit on the `system_state`
 *  singleton, one org-wide slot for something that belongs to a connection. */
export async function readLinkedInLiveness(tx: Tx): Promise<LinkedInLiveness> {
  const [row] = await tx
    .select({
      okAt: channels.sessionOkAt,
      checkedAt: channels.sessionCheckedAt,
      reason: channels.sessionReason,
    })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK));
  return {
    okAt: row?.okAt ?? null,
    checkedAt: row?.checkedAt ?? null,
    reason: row?.reason ?? null,
  };
}

/**
 * Compose the one connection state from the durable facts. Cheap: two indexed
 * single-row reads on any account that has ever been probed, and a third one
 * before that. No browser, safe to call on every page render.
 *
 * It asks for no connector. A name was the old answer to "is anything there",
 * and a grant cannot supply one — a capability is a set of methods. The facts
 * this reads are the account's own: the channel row, its probe record, and
 * whether a credential is stored.
 */
export async function linkedInConnectionState(
  tx: Tx,
  now = Date.now(),
  /**
   * Whether a session exists for this channel, answered from the row this
   * function has already read. Production reads the real filesystem; it is
   * injectable ONLY so a test can pin the branch it means to assert. Without
   * this seam the aged-out case resolves differently depending on whether the
   * machine running the suite happens to have a Chrome profile — green on a
   * developer's laptop, red in CI, for reasons unrelated to the code.
   */
  sessionStored: typeof linkedInSessionStored = linkedInSessionStored,
): Promise<LinkedInConnectionState> {
  // The channel row is the account, so it is what names it. This used to read
  // `profile.displayName` — identity sharing a table with persona, house style
  // and the voices map.
  const [channel] = await tx
    .select({
      displayName: channels.displayName,
      externalAccountId: channels.externalAccountId,
    })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK));
  const accountName = channel?.displayName ?? null;
  const externalAccountId = channel?.externalAccountId ?? null;
  const base = {
    accountName,
    externalAccountId,
    connected: false as const,
  };
  const liveness = await readLinkedInLiveness(tx);
  // NOTHING was ever established on this account: no row to carry a binding, no
  // probe on record, and no stored credential. Row facts, where a driver name
  // used to stand — `"mock"` meant "nothing reaches this", which is the
  // resolver's `not_connected` and is answered there now.
  //
  // The browser profile DIRECTORY is deliberately not one of them, and the
  // credential read is deliberately last: Chromium creates that directory the
  // moment it launches, which is the exact lie this file exists to correct, and
  // an account that has been probed is configured whatever `secrets` holds — so
  // the third read only happens on an account that has never been reached.
  if (!channel || liveness.checkedAt == null) {
    return {
      ...base,
      status: "not_configured",
      confirmedAt: null,
      checkedAt: null,
      reason: null,
    };
  }
  const shape = {
    accountName,
    externalAccountId,
    confirmedAt: liveness.okAt,
    checkedAt: liveness.checkedAt,
    reason: liveness.reason,
  };
  // A failed probe is the freshest evidence there is — it outranks an older
  // success, otherwise a signed-out session would keep reading "live" all day.
  //
  // The RECORD says which probe was last, not the clock. `recordProbe` is the
  // only writer of these three columns and it clears `sessionReason` on every
  // success, so a reason standing on the row IS "the most recent probe failed".
  // Comparing `checkedAt` to `okAt` asked the same question through two
  // timestamps one write assigns from one `Date.now()`: a failure landing in the
  // same millisecond as the success it followed tied, and the account read
  // `live` while signed out.
  if (liveness.reason) {
    return { ...shape, status: "needs_signin", connected: false };
  }
  if (liveness.okAt != null && now - liveness.okAt <= FRESH_FOR_MS) {
    return { ...shape, status: "live", connected: true };
  }
  // Never probed, or the last success has aged out. "A session exists" is still
  // worth distinguishing from "nothing was ever opened".
  //
  if (!sessionStored()) {
    return { ...shape, status: "no_session", connected: false };
  }
  // Aged out, not signed out: the last check found the account signed in and
  // none has failed since. Only a success with no failure after it is evidence,
  // so an account set aside before its first check (`okAt` cleared) stays out.
  return { ...shape, status: "unverified", connected: liveness.okAt != null };
}

/** The five words usage data has for a session: a successful probe on record,
 *  a security checkpoint, a restriction, a failed sign-in, or no probe at all. */
function sessionClass(
  okAt: number | null,
  reason: string | null,
): "connected" | "expired" | "challenge" | "restricted" | "none" {
  if (reason === "checkpoint_required") return "challenge";
  if (reason === "account_restricted") return "restricted";
  if (reason) return "expired";
  return okAt != null ? "connected" : "none";
}

/** Persist one probe outcome. Whole record in one write: the newest probe IS
 *  the freshest truth, so last-writer-wins across the dashboard/agent/worker
 *  processes is exactly right. */
async function recordProbe(
  organizationId: string,
  session: SessionStatus,
  connector: ConnectorBinding | null,
  now: number,
  interactive = false,
  /** False for the one failure nobody asked about (`recordRunSession`): it is
   *  written down, and the account's binding is left as it stands. */
  observes = true,
): Promise<SessionStatus> {
  await withOrg(organizationId, async (tx) => {
    const [previous] = await tx
      .select({ okAt: channels.sessionOkAt, reason: channels.sessionReason })
      .from(channels)
      .where(and(eq(channels.organizationId, organizationId), eq(channels.network, DEFAULT_NETWORK)));
    if (session.ok && session.account?.displayName) {
      await setChannelDisplayName(tx, session.account.displayName);
    }
    const [bound] = await tx.select({ id: channels.id }).from(channels)
      .where(and(eq(channels.organizationId, organizationId), eq(channels.network, DEFAULT_NETWORK)));
    if (bound && observes) {
      const authority = await observeAccount(tx, bound.id, session);
      if (!authority.allowed && session.ok) session = { ...session, ok: false, reason: authority.reason };
    }
    // The channel write: liveness on every probe, identity when the driver
    // reported one. The `system_state` singleton no longer carries either —
    // the contract release dropped its liveness trio, and the channel row is
    // where a probe result belongs, since a probe describes ONE account.
    //
    // An UPDATE of the org's single channel row, never an insert-on-conflict:
    // the row already exists (seeded per org), and under NULLS NOT DISTINCT
    // (org,'linkedin',NULL) and (org,'linkedin','ada-1') are DIFFERENT keys, so
    // an upsert against the identity key would mint a second row beside the
    // seeded one. The unique key stays as the belt against duplicates.
    //
    // `DEFAULT_NETWORK`, not a literal: `packages/core/network/registry.ts`
    // owns what a network IS — urn grammar, url shape, mention syntax, hosts —
    // and is where a second one is added.
    await tx
      .update(channels)
      .set({
        sessionCheckedAt: now,
        ...(session.ok ? { sessionOkAt: now } : {}),
        sessionReason: session.ok ? null : (session.reason ?? "unknown"),
        ...(session.ok && session.account?.externalAccountId
          ? {
              externalAccountId: session.account.externalAccountId,
              verifiedAt: now,
            }
          : {}),
        // HOW this account is reached, learned from the connector that just
        // reached it — the row states the binding instead of every reader
        // asking the environment. Only a successful probe is evidence: a
        // failure may BE the misconfiguration, and a null binding (the mock,
        // which reaches nothing) proves nothing at all, so both leave whatever
        // the row already carries standing.
        ...(session.ok && connector ? { connector } : {}),
        // `displayName` is deliberately absent: `setChannelDisplayName` above
        // is its single writer, so naming it twice in one transaction would be
        // two writers for one fact.
        updatedAt: now,
      })
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.network, DEFAULT_NETWORK),
        ),
      );
    // Usage data, after the commit: the account became connected, or the
    // owner (who pressed Test connection and is watching) did not get there.
    // A background probe that fails again says nothing new and sends nothing.
    const wasLive = previous?.okAt != null && !previous.reason;
    const before = sessionClass(previous?.okAt ?? null, previous?.reason ?? null);
    // A failed probe always carries a reason here, so it is never "none".
    const after = (session.ok ? "connected" : sessionClass(null, session.reason ?? "unknown")) as Exclude<
      ReturnType<typeof sessionClass>,
      "none"
    >;
    // Edge-triggered: a session that stays as it was says nothing. One that was
    // never connected and is not yet is the baseline, not a change.
    if (after !== before && !(before === "none" && after === "expired")) {
      afterCommit(tx, () => track("linkedin_session_changed", { state: after }));
    }
    if ((after === "challenge" || after === "restricted") && after !== before) {
      afterCommit(tx, () => track("restriction_signal", { signal: after }));
    }
    if (session.ok) {
      if (!wasLive) afterCommit(tx, () => track("linkedin_connected", { outcome: "connected" }));
    } else if (interactive) {
      const outcome = session.reason === "checkpoint_required" ? "challenge" : "failed";
      afterCommit(tx, () => track("linkedin_connected", { outcome }));
    }
  });
  return session;
}

/**
 * Record the session check a send makes before its write
 * (`dispatchAccountWrite`) — the one check Engager makes unattended. With the
 * owner's Test connection as the only other, an account posting all day aged
 * out of "live" a day after the last press.
 *
 * Only a success is recorded, and only as the account the send is bound to.
 * A failed check stays the send's own refusal: the unattended probe reads any
 * page off LinkedIn's origin as `login_required`, so a network blip on wake
 * would otherwise read as a sign-out and pause the account. Never a gate
 * either: a record that cannot be written leaves the send to its own checks.
 */
export async function recordSendSession(
  organizationId: string,
  accountId: string,
  session: SessionStatus,
): Promise<void> {
  if (!session.ok || session.account?.externalAccountId !== accountId) return;
  await recordProbe(organizationId, session, null, Date.now()).catch(() => undefined);
}

/**
 * Record what a run's own look at the session finds, when the run has reason
 * to look: LinkedIn turned one of its reads away at sign-in, or the record
 * still carries a failure. A send's check records only a success, so an
 * account LinkedIn signed out overnight read "live" all the next day while
 * every run closed on a row of zeros (2026-11-19).
 *
 * A failure is recorded only when the connector SAW the sign-in page
 * (`signInPage`), which a network blip cannot produce. It pauses nothing,
 * where the owner's own check does: a signed-out account sends nothing as it
 * is, and a binding paused here would wait on a press the owner has no other
 * reason to make. A success is recorded as a send's is, so an account the
 * owner signed back in to reads connected again without their Test
 * connection. Never a gate: a look that cannot be taken or written leaves the
 * record as it was.
 */
export async function recordRunSession(
  driver: CapabilitySurface<"session">,
  organizationId: string,
  turnedAway: boolean,
): Promise<void> {
  try {
    const [row] = await withOrg(organizationId, (tx) =>
      tx
        .select({ reason: channels.sessionReason, accountId: channels.executionAccountId })
        .from(channels)
        .where(eq(channels.network, DEFAULT_NETWORK)),
    );
    if (!row || (!turnedAway && !row.reason)) return;
    const session = await driver.ensureSession({ existingPageOnly: true });
    if (session.ok) {
      if (row.accountId) await recordSendSession(organizationId, row.accountId, session);
    } else if (session.signInPage) {
      await recordProbe(organizationId, session, null, Date.now(), false, false);
    }
  } catch {
    // The look is the run's courtesy, not its work.
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Probe the session and RECORD the outcome through `recordProbe`, the only
 * writer of liveness (a send's own check reaches it through
 * `recordSendSession`, a run's through `recordRunSession`).
 *
 * With `waitForSignInMs`, keep re-checking while the owner signs in, so the
 * same call that opened the window is the one that notices. That re-check is
 * nearly free: the sidecar skips its navigation when ANY of its pages is
 * already on linkedin.com, which a `login_required`/`checkpoint_required`
 * reason guarantees — so each tick is one in-page evaluation, not a LinkedIn
 * read, and never a navigation away from the tab the owner is signing in on.
 * That is why this waits rather than a background poller: no fixed-cadence
 * traffic, and one claim on the single-holder browser instead of N.
 *
 * Only the FIRST tick brings the window up (and puts it in `place`): the owner
 * is in it by then, and a window that came to the front every two seconds would
 * take the keyboard from the app they went to for a code. `recheck` is a probe
 * that is never the first — a wait the sign-in step chains onto the last one —
 * or a single look at who is signed in now; either way the window stays where
 * it is. `openSignIn` sends the browser to LinkedIn's sign-in page first.
 *
 * `connector` is the binding to stamp, and the CALLER states it. No capability
 * surface can carry a name — a capability is a set of methods — and the caller
 * resolved the connector, so it is the one that knows. Omitting it says "no
 * evidence" and leaves whatever the row carries standing, which is the honest
 * answer from a probe that reached the account through something it cannot
 * name.
 */
export async function probeLinkedInSession(
  driver: CapabilitySurface<"session">,
  organizationId: string,
  opts: {
    waitForSignInMs?: number | undefined;
    connector?: ConnectorBinding | null | undefined;
    recheck?: boolean | undefined;
    openSignIn?: boolean | undefined;
    place?: WindowPlace | undefined;
  } = {},
): Promise<SessionStatus> {
  const budget = Math.min(
    Math.max(opts.waitForSignInMs ?? 0, 0),
    MAX_WAIT_FOR_SIGN_IN_MS,
  );
  const deadline = Date.now() + budget;
  // A sign-in budget means the owner pressed Test connection and is watching;
  // so does a look they asked for at who is signed in.
  const interactive = budget > 0 || opts.recheck === true || opts.openSignIn === true;
  const surfaces = interactive && opts.recheck !== true;
  let session: SessionStatus;
  let transportFailures = 0;
  for (let tick = 0; ; tick += 1) {
    try {
      // Let a hidden headed browser surface itself for the owner — once.
      const first = tick === 0 && surfaces;
      const options: EnsureSessionOptions = interactive
        ? {
            interactive: true,
            ...(first ? {} : { surface: false }),
            ...(first && opts.openSignIn ? { signIn: true } : {}),
            ...(first && opts.place ? { place: opts.place } : {}),
          }
        : { interactive: false };
      const raw = await driver.ensureSession(options);
      // A driver that returns nothing is a broken driver, not a live session.
      // Normalize rather than dereference: this runs inside real jobs, and a
      // malformed implementation must not crash the owner's posting run.
      session =
        raw && typeof raw === "object" && typeof raw.ok === "boolean"
          ? raw
          : { ok: false, reason: "driver returned no session status" };
      transportFailures = 0;
    } catch (error) {
      // A page LinkedIn changed is read the same way next time: not a sign-in
      // to wait on, and not a sidecar to retry.
      if (isConnectorDrift(error)) {
        session = { ok: false, reason: "ui_drift" };
        break;
      }
      // Two consecutive transport failures means the sidecar is unhealthy, not
      // that the owner is mid-sign-in. Stop rather than hammer it.
      transportFailures += 1;
      const code = (error as { code?: unknown } | null)?.code;
      session = {
        ok: false,
        reason: error instanceof Error ? error.message : "probe failed",
        ...(typeof code === "string" ? { code } : {}),
      };
      if (transportFailures >= 2 || Date.now() >= deadline) break;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (session.ok) break;
    if (!AWAITABLE_REASONS.has(session.reason ?? "")) break;
    if (Date.now() + POLL_INTERVAL_MS > deadline) break;
    // Jitter so two processes that started together do not lock-step, clamped
    // to what is left: the guard above admits a sleep of one whole interval,
    // and the jitter on top of it would carry the wait past the caller's
    // budget by up to a quarter of one.
    const jittered = POLL_INTERVAL_MS + Math.floor(POLL_INTERVAL_MS * 0.25 * ((Date.now() % 7) / 7));
    await sleep(Math.min(jittered, deadline - Date.now()));
  }
  return recordProbe(
    organizationId,
    session,
    opts.connector ?? null,
    Date.now(),
    surfaces,
  ).catch(() => ({ ok: false, reason: "account_verification_unavailable" }));
}
