import type { ConnectorBinding } from "./connector/binding";
import { CONNECTOR_DECLARATIONS, isExactlyOnce } from "./connector/capabilities";
import type { CapabilitySurface } from "./connector/resolve";
import type { PostInput, PostResult } from "./linkedin/driver";
import { assertPostUrn, normalizePostUrn } from "./linkedin/postUrn";

/** The two writes a send performs — `PostInput`'s own kinds, which are also
 *  capability kinds, pinned equal by `RECONCILABLE_KINDS`. */
export type PostWriteKind = PostInput["kind"];

/**
 * A write and the surface that performs it, as ONE value.
 *
 * The kind picks both halves together, and it has to: two independent
 * parameters cannot say that the surface covers the input's kind, so a single
 * `postExactlyOnce(surface, input)` had to name BOTH kinds at once — an
 * intersection **no grant can satisfy on a connector that declares either
 * unsupported**, as the local browser declared `reply` until Phase 46, because
 * the resolver refuses an unsupported kind before it opens anything. A comment
 * site built against it would have had to ask for a reply grant, be refused,
 * and stop posting: a connector's entire write story, lost to a type.
 */
export type PostWrite = {
  [K in PostWriteKind]: {
    kind: K;
    use: CapabilitySurface<K>;
    input: Extract<PostInput, { kind: K }>;
    /**
     * WHICH connector performs it — the binding the grant was issued through,
     * carried so the declaration is looked up HERE rather than handed in.
     *
     * A declaration passed alongside would be a free field: nothing in this
     * type relates it to `kind`, so a reply could carry a comment's integrity
     * and typecheck. The binding cannot be paired wrongly, because the pairing
     * stops being a caller's to make (`isExactlyOnceWrite`).
     *
     * Null when the surface came through no binding at all — an injected
     * fixture driver, which is `connectorBindingForDriverName`'s own answer for
     * the mock.
     */
    connector: ConnectorBinding | null;
  };
}[PostWriteKind];

/**
 * The surface that performs BOTH writes — what a whole driver still is, and
 * the only thing that satisfies it.
 *
 * Transitional, and deliberately not the parameter of anything: it is the type
 * of the send ctx's pre-grant arm while its callers still hold drivers, and it
 * leaves with the field in T-5.6.
 */
export type PostWriteSurface = CapabilitySurface<"comment"> &
  CapabilitySurface<"reply">;

/**
 * Whether THIS write is one the connector can be asked about afterwards — the
 * whole input to the reconcile decision, in the one place kind and connector
 * meet.
 *
 * The binding is PROVENANCE and stays provenance: it is not read to decide
 * whether the account may write, which the grant already answered by refusing a
 * kind its connector does not perform. It is read to look up the same
 * declaration the resolver gated on, for the write's OWN kind — the one thing
 * that says how hard this write tries not to happen twice.
 *
 * A grant carrying no binding reached no real account: it is a driver injected
 * into a worker or MCP context, which is `connectorBindingForDriverName`'s own
 * answer for the fixture, so the fixture's declaration is the one it answers to.
 */
export function isExactlyOnceWrite(write: PostWrite): boolean {
  const declaration = CONNECTOR_DECLARATIONS[write.connector ?? "mock"];
  return isExactlyOnce(declaration[write.kind]);
}

/**
 * Stable per-target reserve key. The messages.dedupe_key UNIQUE index uses this.
 *
 * The post urn is canonicalised rather than interpolated raw. LinkedIn spells
 * one post several ways — `urn:li:ugcPost:…` vs `urn:li:activity:…` (ids
 * independently allocated, so not derivable from one another), and on the home
 * feed `updateMetadata.urn` is a per-viewer wrapper that is not the post at all.
 * Two spellings yield two keys the UNIQUE index cannot relate, and the account
 * comments twice on the same post under the owner's name.
 *
 * Normalisation is TOLERANT here — unparseable targets pass through trimmed.
 * Key construction runs for every draft, including ones never sent, and for
 * targets that legitimately are not post urns. The strict gate is
 * assertPostUrn() in postExactlyOnce(), immediately before a real write.
 *
 * A second network arrives as a dispatch on `channel.network` through
 * `network/registry.ts`, never as a second urn grammar bolted on here.
 */
export function dedupeKey(
  kind: "comment" | "reply",
  campaignId: number | null | undefined,
  targetUrn: string,
): string {
  const target =
    kind === "comment" ? normalizePostUrn(targetUrn) : targetUrn.trim();
  return `${kind}:${campaignId ?? "x"}:${target}`;
}

/**
 * Exactly-once posting. A provider write is at-least-once (a post can succeed
 * while the response times out). The connector DECLARES it can answer "did I
 * already post this?", and we make the write effectively exactly-once by
 * RECONCILING first: the reported urn is adopted instead of posting again, so
 * the job-retry path cannot double-post. A connector that declares less has
 * nothing to reconcile against, and the write is not attempted.
 */
export async function postExactlyOnce(
  write: PostWrite,
  beforeDispatch?: () => Promise<void>,
): Promise<PostResult & { reconciled?: boolean }> {
  const { input } = write;
  // Strict identity gate, at the last moment before a real write. LinkedIn
  // spells one post several ways (ugcPost vs activity, ids independently
  // allocated), and on the home feed updateMetadata.urn is a per-viewer wrapper
  // that is not the post at all. An identity we cannot parse would produce a
  // dedupe key that never collides — the retry path would then comment again,
  // and again, on someone else's post under the owner's name.
  //
  // Same rule as `dedupeKey`: a second network dispatches through
  // `network/registry.ts` on `channel.network`, it does not widen this gate.
  if (input.kind === "comment" || input.kind === "room_reply") assertPostUrn(input.postUrn);
  // The DECLARATION decides, not the members in hand. `reconcilePosted` being
  // present was the wrong question twice over: it is a fact about the object
  // this process holds rather than about the account, and the local browser
  // carries it while THROWING for replies — the exact silent degrade to
  // at-least-once the per-kind declaration exists to state. Declared
  // exactly-once is reconcile-then-write, and the write is always the
  // receipt-bearing one; a connector that declares less has no durable receipt
  // to bind the operation to, so nothing is attempted.
  if (!isExactlyOnceWrite(write) || typeof write.use.postWithReceipt !== "function") {
    return {
      ok: false,
      notAttempted: true,
      code: "UNSUPPORTED_WRITE",
      error: "This connector cannot give the write a durable receipt.",
    };
  }
  await beforeDispatch?.();
  try {
    const existing = await write.use.reconcilePosted?.(input);
    if (existing) return { ok: true, externalUrn: existing, reconciled: true };
  } catch {
    // Reconcile is best-effort; fall through and attempt the post.
  }
  return write.use.postWithReceipt(input);
}
