import type { StrategyStep } from "../strategy/contract";
import { CAPABILITIES } from "../strategy/catalog";
import type { ResolvedAction } from "../strategy/resolve";

/**
 * A step's typed barriers, enforced before it is entered (INV-32, spec §08
 * R21). A link between steps is advisory and is never read here; these are
 * not. Pure.
 *
 *   requires_step  the named step finished `achieved` on this conversation
 *   requires_read  the named binding resolves On in the current version
 *   wait           the hours since the reply the step answers have passed —
 *                  until then the step waits, woken at the hour
 *   approval       a person approves entry. Nothing records such an approval
 *                  before Phase 47's approvals, so the step does not enter.
 *   evidence       a fact the conversation holds: `expressed_interest` is the
 *                  person's own quoted words of interest, `relevant_reply` the
 *                  eligibility table's verdict on the reply. Any other name is
 *                  evidence nothing can show, and the step does not enter.
 */

const HOUR = 3_600_000;

export type BarrierFacts = {
  achievedSteps: ReadonlySet<string>;
  /** Resolved On reads in the effective version, keyed step.binding. */
  readsOn: ReadonlySet<string>;
  /** When the reply the step answers happened. */
  occurredAt: number;
  interest: boolean;
  /** The reply was judged `eligible`. */
  relevant: boolean;
  now: number;
};

export type UnmetBarrier =
  | { type: "wait"; until: number }
  | { type: "requires_step" | "requires_read" | "approval" | "evidence"; detail: string };

/** A stored On is insufficient if the connector cannot perform the read. */
export function resolvedReadsOn(actions: readonly ResolvedAction[]): ReadonlySet<string> {
  return new Set(actions.filter((action) => action.effective === "on" &&
    CAPABILITIES[action.capability].effect === "read")
    .map((action) => `${action.step_id}.${action.action_binding_id}`));
}

/** The first barrier the step's entry does not meet, or null. */
export function unmetBarrier(step: StrategyStep, facts: BarrierFacts): UnmetBarrier | null {
  for (const barrier of step.barriers) {
    switch (barrier.type) {
      case "requires_read": {
        const key = `${barrier.step_id}.${barrier.action_binding_id}`;
        if (!facts.readsOn.has(key)) return { type: "requires_read", detail: key };
        break;
      }
      case "requires_step":
        if (!facts.achievedSteps.has(barrier.step_id)) {
          return { type: "requires_step", detail: barrier.step_id };
        }
        break;
      case "wait": {
        const until = facts.occurredAt + barrier.hours * HOUR;
        if (facts.now < until) return { type: "wait", until };
        break;
      }
      case "approval":
        return { type: "approval", detail: "no approval record" };
      case "evidence": {
        const held =
          barrier.evidence === "expressed_interest"
            ? facts.interest
            : barrier.evidence === "relevant_reply"
              ? facts.relevant
              : false;
        if (!held) return { type: "evidence", detail: barrier.evidence };
        break;
      }
    }
  }
  return null;
}
