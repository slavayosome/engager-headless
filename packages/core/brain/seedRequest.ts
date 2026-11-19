import { withOrg } from "@engager/database/tenant";
import type { McpCtx } from "../mcp/context";
import { assertHostedMcpAccessInTx, assertHostedMcpExternalPhase, withHostedMcpScope } from "../mcp/tools/hostedSpend";
import { isGrant } from "../connector/resolve";
import { linkedInConnectionState } from "../linkedin/liveness";
import { enqueue, retireFinishedIdempotencyKey } from "../jobs/queue";
import { runInSession } from "../tasks/executor";
import { resolveJudgmentPolicy } from "../tasks/policy";
import { linkedInProvenance, loadCorpus, type CorpusSource } from "./corpus";

/** Queue or prepare one seed, keeping provider I/O outside tenant transactions. */
export async function requestBrainSeed(ctx: McpCtx, signal: AbortSignal, source: CorpusSource, scope: "brain" | "voice") {
  const authorize = () => assertHostedMcpExternalPhase(ctx, signal, "brain:write");
  const policy = await withOrg(ctx.organizationId, tx => resolveJudgmentPolicy(tx));
  let expectedAccountId: string | undefined;
  let texts: string[] | undefined;
  let provenance: string;
  if (source.kind === "linkedin") {
    const connection = await withOrg(ctx.organizationId, tx => linkedInConnectionState(tx));
    const grant = await ctx.grant("own_content");
    if (!isGrant(grant) || !connection.externalAccountId || ["no_session", "not_configured", "needs_signin"].includes(connection.status)) {
      return { ok: false as const, code: "not_connected", message: "Connect the LinkedIn account before seeding." };
    }
    expectedAccountId = connection.externalAccountId;
    provenance = linkedInProvenance(expectedAccountId);
  } else {
    const corpus = await loadCorpus({ beforeFetch: authorize }, source);
    if (!corpus.ok) return { ok: false as const, code: corpus.code, message: corpus.reason };
    texts = corpus.texts;
    provenance = corpus.provenance;
  }
  const payload = { source, scope: { kind: scope }, provenance, ...(expectedAccountId ? { expectedAccountId } : {}), ...(texts ? { texts } : {}) };
  const idempotencyKey = `seed_brain:${ctx.organizationId}:${scope}:${provenance}`;
  if (policy === "interactive_external") {
    const result = await runInSession(ctx, "seed_brain", payload, {
      signal, idempotencyKey, ...(source.kind === "linkedin" ? { capabilities: ["own_content" as const] } : {}),
      authorize: { assertInTx: tx => assertHostedMcpAccessInTx(tx, ctx, signal, "brain:write"), assertBeforeProvider: authorize },
    });
    return { ok: true as const, scope, provenance, ...result };
  }
  const jobId = await withHostedMcpScope(ctx, signal, "brain:write", async tx => {
    await retireFinishedIdempotencyKey(tx, ctx.organizationId, idempotencyKey);
    return enqueue(tx, { type: "seed_brain", payload, idempotencyKey });
  });
  return { ok: true as const, mode: "queued", scope, provenance, jobId, queued: jobId !== null };
}
