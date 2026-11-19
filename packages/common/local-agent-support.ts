import { AGENT_SUPPORT_MATRIX, type AgentModel } from "./agent-support";

/**
 * The support matrix's vocabulary, keyed by the adapter registry's string id.
 *
 * DERIVED, never a second list. The transport vocabulary the agent-CLI client
 * enforces and the `Models` column `docs/generated/support.md` publishes are
 * one fact: a list stated here as well would let the client refuse ids the
 * generated truth says are accepted, which is precisely how an owner ends up
 * reading a document that promises their model works.
 *
 * Prices stay out of the shape on purpose — a local agent runs on the owner's
 * own subscription and is never priced (`recordUsage` nulls its cost), so the
 * transport lane asks only which ids are accepted. `AgentModel.price` answers
 * the other question, for the lane that has one.
 */
export const LOCAL_AGENT_MODELS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      AGENT_SUPPORT_MATRIX.map((entry) => [
        entry.id,
        Object.freeze(entry.models.map((model: AgentModel) => model.id)),
      ]),
    ),
  );
