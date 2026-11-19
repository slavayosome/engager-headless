import { cloudBaseUrl } from "./cloudUrl";
import { readCachedLicense } from "./license";

/**
 * What a problem report needs from the licence gate: where it is relayed and
 * as whom, and whose email is the account's own. Core cannot read either, so
 * the processes that carry the gate — the
 * agent, the dashboard — hand these two to `registerReportSources`.
 *
 * `ReportRelayTarget` is written out here and not imported: billing imports
 * nothing from core or common. It is structurally core's `RelayTarget`, so a
 * drift between the two fails to compile where they meet, at that call.
 */
export type ReportRelayTarget = {
  origin: string;
  credential: { kind: "licence"; refreshToken: string } | null;
};

/** The account's email as the cached licence records it, or null. Display
 *  only: the cloud resolves the reply-to from the licence itself. */
export function reportAccountEmail(): string | null {
  return readCachedLicense()?.accountEmail?.trim() || null;
}

/**
 * A laptop presents its licence refresh token to the cloud; an install
 * without one reports anonymously.
 */
export function reportRelayTarget(): ReportRelayTarget {
  const refreshToken = readCachedLicense()?.refreshToken;
  return {
    origin: cloudBaseUrl(),
    credential:
      refreshToken && /^[A-Za-z0-9_-]{43}$/.test(refreshToken) ? { kind: "licence", refreshToken } : null,
  };
}
