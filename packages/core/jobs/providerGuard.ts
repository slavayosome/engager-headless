import { getLLM, type LLM } from "../ai/client";
import { assertHostedJobSpendStillAllowed } from "./spendAccess";
import type { SelfScopedCtx } from "./worker";

/**
 * Fence every managed model request against the current subscription and exact
 * queue lease. The check runs in its own short org scope and releases the pool
 * before provider I/O begins.
 */
export function jobGuardedLlm(ctx: SelfScopedCtx): LLM {
  const base = ctx.llm ?? getLLM();
  const before = async () => {
    await assertHostedJobSpendStillAllowed(ctx);
  };
  const searchText = base.searchText?.bind(base);
  return {
    text: async (opts) => {
      await before();
      return base.text({
        ...opts,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },
    json: async (opts) => {
      await before();
      return base.json({
        ...opts,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },
    ...(searchText
      ? {
          searchText: async (
            opts: Parameters<NonNullable<LLM["searchText"]>>[0],
          ) => {
            await before();
            return searchText({
              ...opts,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
          },
        }
      : {}),
  };
}
