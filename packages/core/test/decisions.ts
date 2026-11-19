import type { Tx } from "@engager/database/tenant";
import { applyPreparedMessageDecision, prepareMessageDecision, snapshotMessageDecision } from "../operations/messages";

/** The owner's decision on a message, as the dashboard takes it: snapshot,
 *  prepare, apply. */
export async function decideMessage(tx: Tx, input: Parameters<typeof snapshotMessageDecision>[1]) {
  const snapshot = await snapshotMessageDecision(tx, input);
  if (!snapshot.ok) throw new Error(snapshot.reason);
  return applyPreparedMessageDecision(tx, await prepareMessageDecision(snapshot.snapshot, { llm: null }));
}
