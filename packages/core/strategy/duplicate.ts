import type { CampaignAgentStrategy } from "./contract";
import { STRATEGY_PATCH, STAMPED_FIELDS, type StrategyPatch, type PatchOp } from "./patch";
import { designOps } from "./templates";

/**
 * A CAMPAIGN'S STRATEGY, ON ITS COPY. A duplicate starts from its own blank
 * draft, and the source's document — the version in force, else its draft —
 * is said as ONE patch against it: every step and binding by its id in the
 * source's order and every field the source's design sets (`designOps`), every
 * other field it carries, and the grants its sends need asked for by name. The
 * stamps are the copy's own, which the server writes. Pure.
 */

export const DUPLICATE_COMPILER_VERSION = "campaign-duplicate/1";

/** What an op sets — a document field's value, which the contract checks. */
type PatchValue = Extract<PatchOp, { op: "add" }>["value"];

/** Fields said elsewhere: the stamps, the grants (`requestedGrants`), and the
 *  keyed lists `designOps` adds by id. */
const SAID_ELSEWHERE = new Set<string>([...STAMPED_FIELDS, "grants", "steps", "action_bindings"]);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function duplicatePatch(input: {
  campaignId: number;
  expectedBaseVersion: number;
  base: CampaignAgentStrategy;
  source: CampaignAgentStrategy;
  instruction: string;
}): StrategyPatch {
  const { base, source } = input;
  const ops = designOps(base, source);
  const said = new Set(ops.map((op) => op.path.split("/")[1]));
  const fields = new Set([...Object.keys(base), ...Object.keys(source)]) as Set<keyof CampaignAgentStrategy>;
  for (const field of fields) {
    if (SAID_ELSEWHERE.has(field) || said.has(field)) continue;
    const [before, after] = [base[field], source[field]];
    if (after === undefined) {
      if (before !== undefined) ops.push({ op: "remove", path: `/${field}` });
    } else if (before === undefined) {
      ops.push({ op: "add", path: `/${field}`, value: structuredClone(after) as PatchValue });
    } else if (!same(before, after)) {
      ops.push({ op: "replace", path: `/${field}`, value: structuredClone(after) as PatchValue });
    }
  }
  const add = source.grants.filter((grant) => !base.grants.includes(grant));
  const remove = base.grants.filter((grant) => !source.grants.includes(grant));
  const grants = add.length > 0 || remove.length > 0;
  return {
    kind: STRATEGY_PATCH,
    campaignId: input.campaignId,
    expectedBaseVersion: input.expectedBaseVersion,
    ops,
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    ...(grants ? { requestedGrants: { add, remove } } : {}),
    provenance: {
      instruction: input.instruction,
      recognizedIntent: {
        summary: "Copy another campaign's strategy",
        paths: [
          ...new Set(ops.map((op) => `/${op.path.split("/")[1]}`)),
          ...(grants ? ["/grants"] : []),
        ],
      },
      scope: { stepId: null },
      compilerVersion: DUPLICATE_COMPILER_VERSION,
    },
  };
}
