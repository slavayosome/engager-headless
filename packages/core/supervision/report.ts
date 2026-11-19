import type { Tx } from "@engager/database/tenant";
import { runtimeInstanceId } from "../execution/authority";
import { redactDiagnosis, type SupervisionSignal } from "./lifecycle";
import { recordSupervisionSignal, recordSupervisionTick } from "./record";
import { supervisionStatus } from "./status";

/** The bounded local command and dashboard use the same durable policy. No
 * holder, clock, retry count or desired outcome is accepted from the caller. */
export async function reportSupervision(tx: Tx, organizationId: string, body: Record<string, unknown>) {
  const component = body.component ?? "agent";
  if (typeof component !== "string" || !["agent", "dashboard", "postgres", "supervisor"].includes(component)) {
    throw new Error("component_unsupported");
  }
  const input = { organizationId, component, holderId: runtimeInstanceId(), now: Date.now() };
  let recorded;
  if (body.action === "resume") {
    recorded = await recordSupervisionTick(tx, input);
  } else {
    if (body.action !== "signal") throw new Error("action_unsupported");
    const kind = body.signal;
    if (typeof kind !== "string" || !["start_requested", "ready", "readiness_failed", "child_exited", "stop_requested", "stopped", "revalidation_failed"].includes(kind)) {
      throw new Error("signal_unsupported");
    }
    const diagnosis = redactDiagnosis(typeof body.diagnosis === "string" ? body.diagnosis : "") ?? "";
    const signal = kind === "stopped"
      ? { kind, groupTornDown: body.groupTornDown === true, diagnosis }
      : ["readiness_failed", "child_exited", "revalidation_failed"].includes(kind)
        ? { kind, diagnosis } : { kind };
    recorded = await recordSupervisionSignal(tx, { ...input, signal: signal as SupervisionSignal });
  }
  return {
    accepted: recorded.status === "recorded",
    action: recorded.status === "recorded" ? recorded.transition.action : "none",
    status: await supervisionStatus(tx, organizationId, input.now),
  };
}
