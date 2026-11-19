import type { ConversationRelationship } from "@engager/database/schema";
import type { ModeKey } from "../strategy/catalog";
import type { RelationshipRead } from "../linkedin/driver";

const DAY = 86_400_000;

/**
 * The relationship one read shows the account has with `profileId`, or
 * `unknown`. The read must be of that person — a page it verified as the
 * member asked for — and must show both facts, the degree and which way an
 * invitation is pending, if either. Neither is inferred from the other's
 * absence, and the account's own page is no relationship at all.
 */
export function relationshipOf(
  read: RelationshipRead,
  profileId: string,
): ConversationRelationship {
  if (!read.profile.verified || read.profile.id !== profileId) return "unknown";
  const { degree, pending } = read;
  if (degree === "unknown" || degree === "self" || pending === "unknown") {
    return "unknown";
  }
  if (degree === "1st") return pending === "none" ? "connected" : "unknown";
  if (pending === "outgoing") return "outgoing_pending";
  if (pending === "incoming") return "incoming_pending";
  return "not_connected";
}

/** The actions whose dispatch leans on the person's relationship. */
export type RelationshipBoundKind = Extract<
  ModeKey,
  "invite" | "accept_invite" | "dm" | "followup"
>;

/**
 * How recent a relationship read must be for an action of each kind to lean
 * on it — the window the strategy's `safety.fresh_check_required` asks for.
 * An invitation is sent or accepted only on a read made in the browser
 * session that dispatches it: a person can accept, withdraw or invite first
 * within the minute, and a restart is another session however soon it came.
 * A message to a connection leans on a read from the last day.
 */
export const RELATIONSHIP_FRESHNESS = {
  invite: "same_session",
  accept_invite: "same_session",
  dm: DAY,
  followup: DAY,
} as const satisfies Record<RelationshipBoundKind, "same_session" | number>;

/** Whether `read` is recent enough for an action of `kind` that would run in
 *  browser session `at.sessionId` — the id the action's own browser op
 *  reports. Never true with no read. */
export function relationshipFresh(
  read: Pick<RelationshipRead, "observedAt" | "sessionId"> | null,
  kind: RelationshipBoundKind,
  at: { now: number; sessionId: string },
): boolean {
  if (read === null) return false;
  const window = RELATIONSHIP_FRESHNESS[kind];
  return window === "same_session"
    ? read.sessionId === at.sessionId
    : read.observedAt >= at.now - window;
}
