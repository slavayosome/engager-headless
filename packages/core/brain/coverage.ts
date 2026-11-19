import {
  brainState,
  type BrainSlot,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { BRAIN_SLOTS } from "./slots";
import { listNotes } from "./vault";

/** How full a slot is, read off its row count and nothing else. */
export type BrainSlotCoverage = "empty" | "thin" | "covered";

/**
 * The slots coverage reports. `BRAIN_SLOTS` holds seven entries but is annotated
 * with the whole column enum, which still carries the retired `product` value so
 * legacy rows keep reading (see `slots.ts`). A `Record<BrainSlot, …>` would
 * therefore promise a key this module never writes, and under
 * `noUncheckedIndexedAccess` a literal-key read of a Record is never
 * `| undefined` — so `coverage.product.state` would typecheck and throw.
 */
export type BrainCoverageSlot = Exclude<BrainSlot, "product">;

export type BrainCoverage = Record<
  BrainCoverageSlot,
  { state: BrainSlotCoverage; missing: string }
>;

/** `BRAIN_SLOTS`' seven entries, typed as the seven — what coverage iterates
 *  and what a surface listing coverage renders beside it. */
export const COVERAGE_SLOTS = BRAIN_SLOTS.filter(
  (slot): slot is (typeof BRAIN_SLOTS)[number] & { id: BrainCoverageSlot } =>
    slot.id !== "product",
);

/** Documents a slot needs before it stops being thin. */
const COVERED_FROM = 3;

function stateFor(rows: number): BrainSlotCoverage {
  if (rows === 0) return "empty";
  if (rows < COVERED_FROM) return "thin";
  return "covered";
}

/**
 * Coverage as a state the server can observe: count this org's knowledge
 * documents per slot and name what that count is — never what a model scored it
 * (INV-2). Nothing is `empty`, one or two is `thin`, three or more is
 * `covered`.
 *
 * The `missing` phrase beside it is the one part of the cached assessment that
 * is not a number. `persistBrainAssessment` has stored it per slot all along
 * and nothing ever read it back. It is a hint, so a slot the assessment never
 * reached carries none and its state still stands on the rows.
 */
export async function deriveBrainCoverage(tx: Tx): Promise<BrainCoverage> {
  const rowsBySlot = new Map<BrainSlot, number>();
  for (const note of await listNotes()) {
    const slot = note.slot;
    rowsBySlot.set(slot, (rowsBySlot.get(slot) ?? 0) + 1);
  }
  const [state] = await tx.select({ slots: brainState.slots }).from(brainState);

  const coverage = {} as BrainCoverage;
  for (const slot of COVERAGE_SLOTS) {
    coverage[slot.id] = {
      state: stateFor(rowsBySlot.get(slot.id) ?? 0),
      missing: state?.slots?.[slot.id]?.missing ?? "",
    };
  }
  return coverage;
}
