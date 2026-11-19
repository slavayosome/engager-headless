import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { agentFailure } from "./state";
import type { ResolvedAgentSelection } from "./types";

export type InvocationProfileEvidence = {
  profile: string;
  executableSha256: string;
  version: string;
  platform: NodeJS.Platform;
  providerRef: string;
  modelRef: string;
  authRoute: string;
  proofSha256: string;
  sourceRef: string;
  nativeToolsDenied: true;
  hostileConfigContained: true;
  noIntegrationsOrDownloads: true;
  nativeAuthOnly: true;
};

/** Exact installed behavior has not been certified. Fixtures inject their own
 * evidence into this verifier, never into production configuration or env. */
const VERIFIED_PROFILES: readonly InvocationProfileEvidence[] = [];

export function verifyInvocationProfile(
  selection: ResolvedAgentSelection,
  profile: string,
  evidence: readonly InvocationProfileEvidence[] = VERIFIED_PROFILES,
  managedPaths?: readonly string[],
): void {
  const proof = evidence.find(
    (entry) =>
      entry.profile === profile &&
      entry.executableSha256 === selection.executableIdentity &&
      entry.version === selection.observedVersion &&
      entry.platform === process.platform &&
      entry.providerRef === selection.providerRef &&
      entry.modelRef === selection.modelRef &&
      entry.authRoute === selection.authRoute &&
      /^[a-f0-9]{64}$/.test(entry.proofSha256) &&
      entry.sourceRef.length > 0 &&
      entry.nativeToolsDenied &&
      entry.hostileConfigContained &&
      entry.noIntegrationsOrDownloads &&
      entry.nativeAuthOnly,
  );
  if (!proof)
    throw agentFailure(
      `isolation_unverified:${profile}:exact_profile_evidence_missing`,
    );
  assertNoManagedProfile(selection.adapterId, managedPaths);
}

/** Presence checks only: do not inspect secrets or replace enterprise policy.
 * The supported profile cannot compose unknown mandatory settings. */
export function assertNoManagedProfile(adapterId: string, declaredPaths?: readonly string[]): void {
  if (!declaredPaths && adapterId !== "gemini" && adapterId !== "opencode")
    throw agentFailure("isolation_unverified:managed_profile_paths_unknown");
  const paths =
    declaredPaths ?? (adapterId === "gemini"
      ? ["/Library/Application Support/GeminiCli", "/etc/gemini-cli"]
      : [
          "/Library/Application Support/opencode",
          "/etc/opencode",
          "/Library/Managed Preferences/ai.opencode.managed.plist",
          join(
            "/Library/Managed Preferences",
            userInfo().username,
            "ai.opencode.managed.plist",
          ),
        ]);
  if (paths.some(existsSync))
    throw agentFailure("isolation_unverified:mandatory_policy_present");
}
