import { declaredModel } from "@engager/common/agent-support";

/**
 * Per-model prices for cost estimation. The Anthropic/OpenAI APIs return token
 * COUNTS, never cost — these numbers are the only source of dollars, so they MUST
 * be kept in sync with the providers' pricing pages. Prices are USD per MILLION
 * tokens. An unknown model yields a NULL cost (never a silent $0), surfaced as
 * `cost_usd_micros IS NULL` in ai_usage so it's obvious a price is missing.
 *
 * Agent models are NOT listed below. They are declared, with their prices, on
 * the support-matrix entry of the agent that serves them — one vocabulary, so
 * the lane that refuses an unknown model and the lane that prices one read the
 * same list.
 *
 * Anthropic prompt-caching pricing (relative to base input): a cache WRITE costs
 * 1.25× input, a cache READ costs 0.10× input. We default to those multipliers
 * unless a model overrides them.
 *
 * ⚠️ VERIFY these against current pricing before trusting the cost column.
 */
export type ModelPrice = {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM?: number; // default: 1.25 × inputPerM
  cacheReadPerM?: number; // default: 0.10 × inputPerM
};

export function priceFor(model: string): ModelPrice | undefined {
  // `declaredModel` strips a release date itself, so both lanes take a dated id
  // for the same model. The date rule lives beside the vocabulary rather than
  // here, or the CLI lane would have to restate it to refuse the same strings.
  const declared = declaredModel(model);
  // A matrix entry states base input and output only; the cache multipliers
  // stay this module's defaults, which is what the agent models used while
  // their prices lived in `PRICES`. A declared model with no price is
  // vocabulary only — an id Engager accepts and has verified no dollars for —
  // so it yields the same null cost any unpriced model does.
  return declared?.price;
}

export type TokenCounts = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** Billed web searches (Anthropic server tool) — priced per search, not per token. */
  webSearchRequests?: number;
};

/** Anthropic web_search server tool: $10 per 1,000 searches (plus normal tokens). */
const WEB_SEARCH_PER_1K_USD = 10;

const MICROS_PER_USD = 1_000_000;
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * A published USD-per-million price as an INTEGER of micro-USD per million
 * tokens. Provider price sheets are short decimals ($3, $0.02, $1.25×input), so
 * one rounding here is exact; every later step is integer arithmetic. Dollars
 * never become a float again, because a resource ledger that reserves and
 * settles in floats cannot be reconciled from its own rows (ADR-06).
 */
function microsPerMillion(perM: number): number {
  return Math.round(perM * MICROS_PER_USD);
}

/**
 * Cost of `units` priced at `perMillionMicros`, rounded UP. Rounding up is the
 * conservative direction in both lanes: a reservation must upper-bound what the
 * provider can bill, and a settlement must not record less than it cost.
 * Returns null when the multiplication would leave the safe-integer range —
 * an unrepresentable amount is unknown, never a silently truncated one.
 */
function componentMicros(
  units: number,
  perMillionMicros: number,
): number | null {
  if (units <= 0) return 0;
  const product = units * perMillionMicros;
  if (!Number.isSafeInteger(product)) return null;
  return Math.ceil(product / TOKENS_PER_PRICE_UNIT);
}

/**
 * Estimated cost in micro-USD (USD × 1e6), or null if the model isn't priced —
 * or if the requested counts are not safe non-negative integers, which an
 * upper-bound estimator can produce from hostile input and must never round
 * into a plausible-looking small number.
 */
export function costMicros(model: string, t: TokenCounts): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const components: Array<[number, number]> = [
    [t.inputTokens ?? 0, microsPerMillion(p.inputPerM)],
    [t.outputTokens ?? 0, microsPerMillion(p.outputPerM)],
    [t.cacheCreationTokens ?? 0, microsPerMillion(p.cacheWritePerM ?? p.inputPerM * 1.25)],
    [t.cacheReadTokens ?? 0, microsPerMillion(p.cacheReadPerM ?? p.inputPerM * 0.1)],
    [t.webSearchRequests ?? 0, WEB_SEARCH_PER_1K_USD * MICROS_PER_USD * 1_000],
  ];
  let total = 0;
  for (const [units, perMillionMicros] of components) {
    if (!Number.isFinite(units) || units < 0 || !Number.isSafeInteger(units)) {
      return null;
    }
    const part = componentMicros(units, perMillionMicros);
    if (part == null) return null;
    total += part;
  }
  return Number.isSafeInteger(total) ? total : null;
}
