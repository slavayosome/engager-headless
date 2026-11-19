import { boundaryModelScope } from "../ai/modelFor";
import { withUsageContext, type UsageContext } from "../ai/usage";

/**
 * Run `fn` inside the usage scope an ENTRY BOUNDARY opens — the worker's job
 * wrap, the MCP tool wrap, the `source: "action"` scope `campaigns/suggest.ts`
 * opens for itself, a script.
 *
 * `modelFor(role)` reads that scope and throws without one, so a test calling a
 * domain function DIRECTLY has to stand in for the boundary the function really
 * runs under. It resolves through the same `boundaryModelScope()` production
 * uses rather than a map of its own, so a test can never observe a model
 * production would not — and nested inside a real boundary it inherits, exactly
 * as a nested production scope does.
 *
 * A substitute for a boundary is never proof of one, so the real ones are pinned
 * separately: the worker wrap and a bare `source: "action"` scope in
 * `modelFor.test.ts`, the MCP tool wrap in `mcp/usage-context.test.ts`. The
 * script boundary in `scripts/backfill-leads.ts` has no suite and is pinned by
 * neither.
 */
export function withEntryBoundary<T>(
  fn: () => Promise<T>,
  ctx: UsageContext = {},
): Promise<T> {
  return withUsageContext({ source: "test", ...boundaryModelScope(), ...ctx }, fn);
}
