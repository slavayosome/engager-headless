/**
 * The channel resolver: a capability out of a channel row, or a typed refusal.
 *
 * A caller names an ACCOUNT and a CAPABILITY and receives a `Grant` carrying
 * only the members that capability covers — never a driver. That is what makes
 * the null check this phase is named for unwritable rather than merely fixed:
 * no context carries a driver to test, and the question that check stood in for
 * ("can this account do this at all?") is answered here, by the connector's
 * declaration, before anything opens a browser or a socket.
 *
 * WHICH connector is `channel.connector` — the row, never `config.driver`.
 * `ENGAGER_DRIVER` survives as the value that field was filled from, and
 * `ENGAGER_BROWSER_PROFILE_DIR` survives as a construction parameter: how to
 * open the connector, no longer which one it is. Write
 * authority is the channel row's `writes_enabled`, not an env parameter. Anything else gives two answers to "which account" — the one
 * the budget is spent against, and the one the grant was issued against.
 *
 * It is the ONLY resolver. The env-selecting one it stood alongside is gone
 * with its last caller, and so is the fake connector it handed back for "no
 * account" — a fixture answering a capability question, which is what made a
 * lost `ENGAGER_MASTER_KEY` read as "you haven't connected yet".
 *
 * Layer 4 answers PHYSICALLY and nothing else (INV-13): it reports what the
 * connector can and cannot do, and never authorises work, decides a pause, or
 * touches the ledger.
 */

import { asc, eq } from "drizzle-orm";
import { channels, type Channel } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { config } from "../config";
import { ConnectorError } from "../linkedin/connectorError";
import type { LinkedInDriver } from "../linkedin/driver";
import { browserUseDriverFromEnv } from "../linkedin/resolve";
import { DEFAULT_NETWORK } from "../network/registry";
import {
  connectorRefusal,
  refusalFromConnectorError,
  type Refusal,
} from "../refusal";
import type { ConnectorBinding } from "./binding";
import {
  CAPABILITY_METHODS,
  CONNECTOR_DECLARATIONS,
  isSupported,
  type CapabilityKind,
} from "./capabilities";

/**
 * The members a granted capability hands over — `CAPABILITY_METHODS[K]` and
 * nothing else, so "no code holds a driver" is a type-level fact rather than a
 * convention a reviewer has to enforce.
 */
export type CapabilitySurface<K extends CapabilityKind> = Pick<
  LinkedInDriver,
  (typeof CAPABILITY_METHODS)[K][number]
>;

export type Grant<K extends CapabilityKind> = {
  ok: true;
  use: CapabilitySurface<K>;
  /**
   * HOW the account was reached to grant this — the binding, which no surface
   * can carry: a capability is a set of METHODS, and the connector's identity is
   * data. `probeLinkedInSession` is the caller this exists for. It stamps the
   * binding on the channel row and used to read it off `driver.name`, so a
   * caller that hands it a granted surface and omits the binding falls through
   * to a surface that has no name and silently stops stamping.
   *
   * Null only when the surface came from no binding at all — a driver injected
   * into a worker or MCP context, which reaches no real account and must never
   * stamp the row (`connectorBindingForDriverName`'s own answer for the mock).
   *
   * ⚠️ PROVENANCE, NEVER A CAPABILITY TEST. It records which connector
   * answered, for a caller that must STAMP or REPORT one. It is not a licence
   * to ask "can this account do X" — `if (g.connector === "local_browser")` is
   * `driver.name === "browser-use"` with a new spelling, and the five
   * `driver.name ===` branches this phase deletes are what it becomes. X is
   * asked for by NAMING X and reading the refusal, which is the whole reason a
   * grant exists.
   *
   * `resolve.test.ts` scans for the LITERAL `"local_browser"` outside
   * `connector/` — the one spelling that is only ever a binding — and carries
   * the two sites that name one in an allowlist: the Channel page's probe
   * button and the connection card's label, both of which REPORT rather than
   * decide. Read its docstring before adding a third.
   */
  connector: ConnectorBinding | null;
};

export type ConnectorResolution<K extends CapabilityKind> =
  | Grant<K>
  | Refusal;

/** `Refusal` carries no `ok` — it is the ladder's own shape, shared by all four
 *  rungs — so the discriminant is the grant's presence. */
export function isGrant<K extends CapabilityKind>(
  resolution: ConnectorResolution<K>,
): resolution is Grant<K> {
  return "ok" in resolution;
}

/**
 * What resolution reads off the account's row, and all it reads.
 *
 * Narrow on purpose: the binding and the org are the entire input, so no caller
 * can come to believe that layer 4 consults the caps, the window or the risk
 * pause. Those are the CHANNEL rung's, and the day this resolver reads one is
 * the day the ladder has two budget holders (INV-13).
 */
export type ResolvableChannel = Pick<
  Channel,
  "id" | "organizationId" | "connector"
>;

/**
 * The sidecar's code for "another process already holds this browser profile".
 *
 * The second spelling of `BROWSER_PROFILE_LOCKED_CODE`, pinned equal by the
 * suite. Matched STRUCTURALLY rather than with `instanceof` because this module
 * resolves a BINDING and opens nothing: reaching the class means importing the
 * connector's client, and the structural match costs the resolver no edge at
 * all. Matching on the code also means a future sidecar that DOES frame it as a
 * protocol error maps identically — `BrowserUseRemoteError` carries the same
 * field.
 */
const PROFILE_LOCKED_CODE = "JOURNAL_LOCKED";

/**
 * A capability on one account, or the reason there is none.
 *
 * SEVERAL kinds may be named together, and then they are all-or-nothing: one
 * surface performs all of them, so a connector that cannot do one cannot serve
 * the call. That is what a caller needs when the members travel together and a
 * second resolution would be a second connector — the send and the follow-up
 * like that rides on it, the session probe that precedes a read. Name them
 * separately when their refusals mean different things: incoming polling and
 * the Ambassador-name backfill are one handler and two questions.
 *
 * At least ONE kind, and the type says so. An empty ask runs the gate zero
 * times and still opens the connector — a decrypted credential and a
 * constructed driver behind a surface with no members — which is this module's
 * own premise ("the declaration gates the grant BEFORE anything is opened")
 * surviving as a convention instead of a guarantee.
 *
 * MUST be called inside `withOrg(organizationId, …)`: the credential read and
 * the binding heal are both RLS-scoped to the row's own org.
 */
export async function resolveChannelConnector<K extends CapabilityKind>(
  tx: Tx,
  channel: ResolvableChannel,
  kinds: K | readonly [K, ...K[]],
): Promise<ConnectorResolution<K>> {
  const opened = await openForKinds(tx, channel, kinds);
  return "layer" in opened
    ? opened
    : { ok: true, use: opened.driver, connector: opened.connector };
}

/**
 * The same resolution against the account of the org `tx` is ALREADY SCOPED TO
 * — for the callers that hold a transaction rather than a row.
 *
 * The transaction is the caller's on purpose. A resolver that opened its own
 * would nest `withOrg` inside `withOrg` at every site that resolves mid-work,
 * and at `ENGAGER_PG_POOL_MAX=1` — the local default — the inner acquire waits
 * on the connection the outer transaction is holding, forever. A caller that
 * holds none opens one around this call instead, which is what `mcp/context.ts`
 * does and why it can.
 *
 * A missing row refuses rather than throws: `channels` is written by the
 * migration seed and by `bootstrapLocalOrg`, so its absence means the org was
 * never set up — something the owner fixes with `engager init`, not a fault the
 * caller should crash on.
 *
 * It composes the PUBLIC resolver above rather than the private `openForKinds`
 * it is built on, which is the same composition `mcp/context.ts` performs a
 * transaction higher up. Reaching past a public entry point into its internals
 * would make this file's footprint an addition WITH a hidden dependency on one
 * private signature, and a sibling that rewrote that signature would then merge
 * without a single conflict marker and not compile.
 */
export async function resolveOrgConnector<K extends CapabilityKind>(
  tx: Tx,
  kinds: K | readonly [K, ...K[]],
): Promise<ConnectorResolution<K>> {
  const channel = await channelForOrg(tx);
  return channel ? resolveChannelConnector(tx, channel, kinds) : noChannelRow();
}

/**
 * The BINDING alone — which connector reaches this account — without opening
 * anything: no driver construction, no sidecar, no socket, no credential
 * decrypted. The one consumer is the dashboard's channel page: a read that
 * answered "which connector?" by CONSTRUCTING one reached for the account
 * itself, and on an install whose agent is down it failed the page it was
 * describing. The heal still runs — this is the post-heal value
 * `Grant.connector` would carry — and the foreign-org guard still answers null,
 * mirroring `openLocalBrowser`'s refusal: a probe button on somebody else's
 * profile is the thing that guard exists to prevent.
 */
export async function resolveChannelBinding(
  tx: Tx,
): Promise<ConnectorBinding | null> {
  const channel = await channelForOrg(tx);
  if (!channel) return null;
  const connector = channel.connector;
  if (
    connector === "local_browser" &&
    channel.organizationId !== config.organizationId()
  ) {
    return null;
  }
  return connector;
}

function noChannelRow(): Refusal {
  return connectorRefusal(
    "not_connected",
    "this organization has no channel row — no account has been set up",
  );
}

/**
 * The org's account row, or null.
 *
 * Ordered and limited like the sibling reads in `ratelimit/killswitch.ts` and
 * `ratelimit/ledger.ts`: today the unique key makes the pick deterministic on
 * its own, but the day `externalAccountId` gets a second writer this would
 * choose a connector at random while they chose the lowest id.
 */
async function channelForOrg(tx: Tx): Promise<ResolvableChannel | null> {
  const [row] = await tx
    .select({
      id: channels.id,
      organizationId: channels.organizationId,
      connector: channels.connector,
    })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .orderBy(asc(channels.id))
    .limit(1);
  return row ?? null;
}

/** The binding, the declaration gate, and the open — the whole resolution
 *  before either projection of it narrows. */
async function openForKinds(
  tx: Tx,
  channel: ResolvableChannel,
  kinds: CapabilityKind | readonly [CapabilityKind, ...CapabilityKind[]],
): Promise<{ driver: LinkedInDriver; connector: ConnectorBinding } | Refusal> {
  const connector = channel.connector;
  // The declaration gates the grant BEFORE anything is OPENED — no browser, no
  // socket, no decrypted credential. Not before every read: the binding has to
  // be known first, and on an unhealed row that costs one credential-METADATA
  // lookup and, once, the stamp. This one check is what the thirteen
  // optional-method-presence probes, the three capability flags and the five
  // `driver.name ===` branches all migrate onto.
  for (const kind of typeof kinds === "string" ? [kinds] : kinds) {
    if (!isSupported(CONNECTOR_DECLARATIONS[connector][kind])) {
      return unsupportedKindRefusal(connector, kind);
    }
  }
  let opened: LinkedInDriver | Refusal;
  switch (connector) {
    case "local_browser":
      opened = await openLocalBrowser(channel);
      break;
  }
  return "layer" in opened ? opened : { driver: opened, connector };
}

/**
 * A kind this connector does not perform, in the CONNECTOR'S own words.
 *
 * Exported because two rungs ask the same question at two moments and must not
 * answer it in two sentences: this one refuses a grant at the seam, and
 * `operations/workers.ts` refuses a HIRE before there is any work to grant. A
 * layer above may quote this detail — that is what `Refusal.detail` is for —
 * but it may not compose its own, or the owner reads two different accounts of
 * one physical fact depending on which surface told them.
 */
export function unsupportedKindRefusal(
  connector: ConnectorBinding,
  kind: CapabilityKind,
): Refusal {
  return connectorRefusal(
    "unsupported",
    `the ${connector} connector does not perform ${kind}`,
  );
}

/**
 * The owner's own browser session IS the account: one human, one Chrome
 * profile, and `ENGAGER_ORG_ID` names the org that owns it. Every other org —
 * fixture tenants, stale seeds — is refused rather than handed the operator's
 * real browser.
 */
async function openLocalBrowser(
  channel: ResolvableChannel,
): Promise<LinkedInDriver | Refusal> {
  if (channel.organizationId !== config.organizationId()) {
    return connectorRefusal(
      "foreign_org",
      "the local browser session belongs to another organization",
    );
  }
  // The construction memo is keyed on the PROFILE, in `linkedin/resolve.ts` —
  // see `localBrowserKey()`. A second entry keyed on this channel would be
  // inert today (the sidecar is memoized before it is reached) and a
  // stale-driver trap tomorrow, since nothing invalidates the two together.
  return browserUseDriverFromEnv();
}

/**
 * A connector failure as the layer-4 refusal it is — or null for anything that
 * is not one, which belongs on the crash path rather than being flattened into
 * a "the account cannot do this" the owner reads.
 *
 * `refusalFromConnectorError` plus the one code it cannot name, which is why
 * this exists: a HELD PROFILE. WHERE IT IS CALLED FROM, stated plainly because
 * it is nowhere yet — resolution CANNOT raise it. Constructing the local
 * browser connector opens no subprocess (`browserUseFromEnv.test.ts` pins that
 * inertness), so the journal's flock is only taken on the first operation
 * through a granted surface. Those call sites arrive with T-5.5, and T-5.6 is
 * where a refusal becomes a job result at all; until then the worker recognises
 * the same condition by name and reschedules without burning an attempt
 * (`isBrowserSessionBusy`), which is the live handling and is untouched here.
 * A `try` around construction would be a branch that cannot fire.
 */
export function connectorFailureRefusal(error: unknown): Refusal | null {
  if (errorCode(error) === PROFILE_LOCKED_CODE) {
    // The message is our own class's, and names a journal path — not a
    // credential, unlike the faults above.
    return connectorRefusal("profile_in_use", detailOf(error));
  }
  return error instanceof ConnectorError
    ? refusalFromConnectorError(error)
    : null;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
