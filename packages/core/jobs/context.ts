import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { connectorBindingForDriverName } from "../connector/binding";
import {
  CAPABILITY_METHODS,
  type CapabilityKind,
} from "../connector/capabilities";
import {
  resolveOrgConnector,
  type ConnectorResolution,
} from "../connector/resolve";
import type { LinkedInDriver } from "../linkedin/driver";
import { connectorRefusal } from "../refusal";
import type { Job } from "@engager/database/schema";

/**
 * A capability on the job's account, or the reason there is none.
 *
 * It takes the CALLER'S transaction, where the MCP context's grant opens its
 * own. Six of these handlers resolve inside an already-open `withOrg`, and at
 * ENGAGER_PG_POOL_MAX=1 a second connection deadlocks forever — pg's pool has
 * no acquire timeout, so the job and the whole queue behind it hang until the
 * process is killed. `McpCtx` carries no DB handle and every tool opens its own
 * short scope, so nesting is impossible there and possible here.
 */
export type CapabilityGrant = <K extends CapabilityKind>(
  tx: Tx,
  kinds: K | readonly [K, ...K[]],
) => Promise<ConnectorResolution<K>>;

export type HandlerCtx = {
  db: Tx;
  /** The worker's capability seam — supplied for every job it runs, and the
   *  only way a handler reaches the account. Optional for the ctx a test builds
   *  BY HAND; see `grantFor` for what its absence now means. */
  grant?: CapabilityGrant;
  /** Optional overrides for tests; handlers fall back to the configured ones. */
  llm?: LLM;
  /** Fires when the job's wall-clock budget expires (serverless drain). The worker
   *  already binds `llm` to it; long multi-step handlers should also check
   *  `signal.aborted` between steps and stop early instead of starting more work. */
  signal?: AbortSignal;
  /** Canonical queue identity. The worker always supplies all three; optional only
   * for direct operation tests that do not run through the queue. */
  jobId?: number;
  jobType?: Job["type"];
  /** Queue fencing identity. A job id without its current lease token must never
   * authorize a later hosted-spend phase after reap/re-claim. */
  jobLeaseToken?: string;
};

/**
 * The capability a handler runs against, whoever filled the seam.
 *
 * `runOnce` supplies `grant` for every job it claims, so in production the
 * fallback is unreachable. It serves the ctx a test builds BY HAND — the direct
 * operation suites, which never run through the queue — and it is no longer a
 * second ANSWER, only a default: with the driver field gone there is nothing
 * else a ctx could have meant, so an unfilled seam resolves the account's own
 * row exactly as the worker's own default arm does. A suite that means a
 * different connector states one, and one that used to hand over a driver no
 * longer compiles until it does.
 */
export function grantFor<K extends CapabilityKind>(
  ctx: Pick<HandlerCtx, "grant">,
  tx: Tx,
  kinds: K | readonly [K, ...K[]],
): Promise<ConnectorResolution<K>> {
  return capabilityGrant(ctx)(tx, kinds);
}

/** The same seam as a VALUE, for a callee that resolves on its own schedule
 *  rather than inside a transaction the handler already holds — the find stage,
 *  which both triggers share and neither may bypass. */
export function capabilityGrant(
  ctx: Pick<HandlerCtx, "grant">,
): CapabilityGrant {
  return ctx.grant ?? channelGrant;
}

/**
 * The injected driver IS this process's connector, so it answers for itself.
 *
 * The seam a test fills, and the only one left: a ctx carries a grant and
 * nothing else, so a suite that wants its own connector states it here rather
 * than handing over a driver for something else to interpret.
 *
 * NOT `CONNECTOR_DECLARATIONS`, for the same reason the MCP harness refuses to
 * consult it: the drivers these suites inject contradict the fixture's
 * declaration on purpose — one is built with `capabilities: { incoming: false }`
 * to stand for a connector that cannot poll, while the mock declaration says it
 * can — so answering from the declaration would answer for a connector that is
 * not the one in hand.
 *
 * The three flags the driver still carries are its own statement about the three
 * kinds whose guards T-5.5b replaced. Every other kind is answered by
 * whether the instance implements any member that performs it — the presence
 * sniff each migrated site did for itself (`fetchProfile`, `likeComment`), and
 * unconditionally true where the interface requires those members, which is
 * equally what those sites did, since none of them asked.
 */
export function injectedGrant(driver: LinkedInDriver): CapabilityGrant {
  const connector = connectorBindingForDriverName(driver.name);
  return async (_tx, kinds) => {
    for (const kind of typeof kinds === "string" ? [kinds] : kinds) {
      if (!driverPerforms(driver, kind)) {
        return connectorRefusal(
          "unsupported",
          `the injected ${driver.name} connector does not perform ${kind}`,
        );
      }
    }
    return { ok: true, use: driver, connector };
  };
}

/**
 * The three kinds a driver still states for itself, and where it states them.
 *
 * All that is left of the capability struct, and exactly the two guards
 * T-5.5b replaced — `pollIncoming` reads one of these
 * directly. The two vocabularies spell one of them differently
 * (`ownContent` on the struct, `own_content` as a kind), which is the whole
 * reason this correspondence is written down once instead of being three
 * branches. It reaches the struct only through an INJECTED driver now, which is
 * also the last thing keeping the struct alive: a suite states a connector by
 * handing over one that contradicts the fixture's declaration, and there is
 * nowhere else for it to say so until that seam is a declaration too.
 */
const DRIVER_STATED: Partial<
  Record<CapabilityKind, keyof LinkedInDriver["capabilities"]>
> = {
  incoming: "incoming",
  own_content: "ownContent",
};

function driverPerforms(driver: LinkedInDriver, kind: CapabilityKind): boolean {
  const flag = DRIVER_STATED[kind];
  if (flag) return driver.capabilities[flag];
  const members: readonly (keyof LinkedInDriver)[] = CAPABILITY_METHODS[kind];
  return members.some((member) => typeof driver[member] === "function");
}

/** The account's own row, read and resolved inside the caller's transaction —
 *  the default behind `capabilityGrant`, and what production always uses.
 *  PRIVATE on purpose: one exported way to reach the default means one answer
 *  to "which connector", which is the whole phase. */
const channelGrant: CapabilityGrant = (tx, kinds) =>
  resolveOrgConnector(tx, kinds);
