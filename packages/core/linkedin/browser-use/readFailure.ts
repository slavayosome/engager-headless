import { track } from "@engager/observability/analytics";
import { ConnectorError } from "../connectorError";
import type { BrowserUseOperation } from "./protocol";

/**
 * A read that failed, as usage data: which kind of page, and why in seven
 * words. Every read the sidecar makes passes `BrowserUseClient.request`, so one
 * hook there sees a LinkedIn page change hit everyone at once (Q4). The error is
 * read for its flags and its status and dropped: its message, which can name a
 * profile or a URL, never travels.
 */
const READERS: Partial<
  Record<
    BrowserUseOperation,
    "profile" | "invitations" | "conversation" | "search" | "feed" | "comments" | "me"
  >
> = {
  read_author_profile: "profile",
  read_company_page: "profile",
  read_relationship: "profile",
  read_incoming_invitations: "invitations",
  read_inbox: "conversation",
  read_dm_thread: "conversation",
  read_conversation_messages: "conversation",
  discover_posts: "search",
  read_notifications: "feed",
  read_post_thread: "feed",
  read_like_state: "feed",
  fetch_own_posts: "feed",
  read_page_for_agent: "feed",
  read_comment_replies: "comments",
  fetch_own_comments: "comments",
  fetch_own_profile: "me",
};

type Reason =
  | "ui_drift"
  | "read_failed"
  | "session_expired"
  | "rate_limited"
  | "http_4xx"
  | "http_5xx"
  | "timeout";

export function readFailureReason(error: unknown): Reason {
  if (error instanceof ConnectorError) {
    if (error.drift) return "ui_drift";
    if (error.signIn) return "session_expired";
    if (error.rateLimited) return "rate_limited";
    if (error.status !== undefined && error.status >= 500) return "http_5xx";
    if (error.status !== undefined && error.status >= 400) return "http_4xx";
  }
  if (error instanceof Error && /timeout|exceeded \d+ms/i.test(`${error.name} ${error.message}`)) {
    return "timeout";
  }
  return "read_failed";
}

/** Count one failed read. Writes and housekeeping ops are not reads and send nothing. */
export function trackReadFailure(op: BrowserUseOperation, error: unknown): void {
  const reader = READERS[op];
  if (reader === undefined) return;
  track("linkedin_read_failed", { reader, reason: readFailureReason(error) });
  // A challenge is the account under pressure, not a page that changed.
  if (error instanceof ConnectorError && error.checkpoint) {
    track("restriction_signal", {
      signal: /restricted/i.test(`${(error as { code?: string }).code ?? ""}`) ? "restricted" : "challenge",
    });
  }
}
