import { runtimeEntitlement } from "@engager/billing/entitlement";
import { type ApiKeyScope } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { withOrg } from "@engager/database/tenant";
import type { McpCtx } from "../context";
import { errorResult } from "./util";

type HostedMcpAccessReason =
  | "subscription_inactive"
  | "credential_inactive"
  | "request_cancelled";

/** Typed control-flow error converted back into a stable MCP tool result. */
export class HostedMcpAccessError extends Error {
  constructor(readonly reason: HostedMcpAccessReason) {
    super(reason);
    this.name = "HostedMcpAccessError";
  }
}

export function assertMcpRequestActive(signal: AbortSignal): void {
  if (signal.aborted) throw new HostedMcpAccessError("request_cancelled");
}

/** Abort before applying a local MCP request. */
export async function assertHostedMcpCredentialInTx(
  _tx: Tx,
  _ctx: McpCtx,
  signal: AbortSignal,
  _requiredScope: ApiKeyScope,
): Promise<void> {
  assertMcpRequestActive(signal);
}

/**
 * Abort fence plus the entitlement check on the caller's transaction. The
 * SHARE lock makes subscription cancellation serialize with a final apply
 * instead of racing past its check.
 */
export async function assertHostedMcpAccessInTx(
  tx: Tx,
  ctx: McpCtx,
  signal: AbortSignal,
  requiredScope: ApiKeyScope,
): Promise<void> {
  await assertHostedMcpCredentialInTx(tx, ctx, signal, requiredScope);

  const entitlement = await runtimeEntitlement(tx, ctx.organizationId, {
    lock: true,
  });
  if (!entitlement.allowed) {
    throw new HostedMcpAccessError("subscription_inactive");
  }
  assertMcpRequestActive(signal);
}

/** AbortSignal-fenced RLS scope for thin safety mutations that must
 * remain available after subscription cancellation. Callers must separately
 * check entitlement before including any provider-derived enrichment. */
export async function withHostedMcpCredentialScope<T>(
  ctx: McpCtx,
  signal: AbortSignal,
  requiredScope: ApiKeyScope,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withOrg(ctx.organizationId, async (tx) => {
    await assertHostedMcpCredentialInTx(tx, ctx, signal, requiredScope);
    const result = await work(tx);
    assertMcpRequestActive(signal);
    return result;
  });
}

/** Short pre-provider access fence; no connection survives this function. */
export async function assertHostedMcpExternalPhase(
  ctx: McpCtx,
  signal: AbortSignal,
  requiredScope: ApiKeyScope,
): Promise<void> {
  await withOrg(ctx.organizationId, (tx) =>
    assertHostedMcpAccessInTx(tx, ctx, signal, requiredScope),
  );
  assertMcpRequestActive(signal);
}

/** Authorized RLS scope for snapshots and final DB-only applies. */
export async function withHostedMcpScope<T>(
  ctx: McpCtx,
  signal: AbortSignal,
  requiredScope: ApiKeyScope,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withOrg(ctx.organizationId, async (tx) => {
    await assertHostedMcpAccessInTx(tx, ctx, signal, requiredScope);
    const result = await work(tx);
    // An abort that lands during DB work rolls the transaction back.
    assertMcpRequestActive(signal);
    return result;
  });
}

/** Return null for ordinary errors so callers can rethrow programming failures. */
export function hostedMcpAccessErrorResult(error: unknown) {
  if (!(error instanceof HostedMcpAccessError)) return null;
  if (error.reason === "subscription_inactive") {
    return errorResult(
      "An active subscription is required for hosted model or network work.",
      {
        code: "subscription_inactive",
        status: 402,
        recovery:
          "Use your connected agent for reasoning and thin Engager write tools, or reactivate the subscription before retrying this hosted operation.",
      },
    );
  }
  if (error.reason === "credential_inactive") {
    return errorResult("This MCP credential is no longer authorized.", {
      code: "credential_inactive",
      status: 401,
      recovery: "Reconnect with a current interactive API key and retry.",
    });
  }
  return errorResult("The MCP request was cancelled.", {
    code: "request_cancelled",
    status: 499,
    recovery: "Retry the operation when you are ready.",
  });
}

/** Inline hosted LLM/LinkedIn/network tools are paid runtime. Pre-payment setup
 * uses bounded jobs and thin writes instead; a connected user-owned agent never
 * silently spends Engager's model allowance after cancellation. */
export async function hostedSpendDenial(tx: Tx, organizationId: string) {
  // The caller performs its hosted operation in this transaction. SHARE makes
  // cancellation serialize behind an already-authorized operation, while a
  // cancellation that committed first is observed and denied.
  const access = await runtimeEntitlement(tx, organizationId, { lock: true });
  return access.allowed
    ? null
    : errorResult(
        "An active subscription is required for hosted model or network work.",
        {
          code: "subscription_inactive",
          status: 402,
          recovery:
            "Use your connected agent for reasoning and thin Engager write tools, or reactivate the subscription before retrying this hosted operation.",
        },
      );
}
