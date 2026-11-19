import type { Channel } from "@engager/database/schema";
import { CONNECTOR_BY_DRIVER_NAME, type ConnectorId } from "./capabilities";

/**
 * WHICH connector a channel is reached through — a binding on the channel row,
 * not its own table, until one channel needs two at once (browse to discover,
 * API to post). Typed off the column so the two lists cannot drift.
 */
export type ConnectorBinding = Channel["connector"];

/**
 * A binding is a connector minus the fixture, and the two vocabularies say so
 * to the compiler rather than by coincidence.
 *
 * `resolveChannelConnector` indexes `CONNECTOR_DECLARATIONS` — keyed by
 * `ConnectorId` — with a `ConnectorBinding`, which is legal only while every
 * binding is a connector. A new value widening the column without a matching
 * `CONNECTOR_DECLARATIONS` row is what this equality catches; `native_api`
 * joining the column next is the failure waiting to happen. Either way it fails here, one file away from the
 * enum that changed, on the line that states the relationship — never at the
 * call site the widening would otherwise reach first.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const BINDING_IS_A_NON_MOCK_CONNECTOR: Equal<
  ConnectorBinding,
  Exclude<ConnectorId, "mock">
> = true;
void BINDING_IS_A_NON_MOCK_CONNECTOR;

/**
 * The binding a driver's `name` means, and the only place that answers it.
 * `ENGAGER_DRIVER` still selects the driver; this is where that selection
 * becomes a durable fact on the row, so the resolver reads the channel rather
 * than the environment.
 *
 * DERIVED from the capability vocabulary's own name map rather than restating
 * its edges: two tables listing the driver names would be two
 * answers to one question, in the phase whose whole thesis is that there is
 * one. What is left here is the part that is genuinely this module's — the
 * EXCLUSION. `mock` reaches nothing, so it proves nothing about how the account
 * is reached, and a caller with nothing to say must write nothing rather than
 * overwrite what a real connector established. Any name the map does not know
 * is null for the same reason.
 */
export function connectorBindingForDriverName(
  name: string,
): ConnectorBinding | null {
  const connector = CONNECTOR_BY_DRIVER_NAME.get(name);
  return connector && connector !== "mock" ? connector : null;
}
