import { isHostedRuntimeEnvironment } from "./environment";

export type ReleaseIdentity = {
  deploymentId: string | null;
  gitSha: string | null;
};

export type ReleaseReadiness =
  | { mode: "configured"; identity: ReleaseIdentity }
  | { mode: "disabled"; identity: ReleaseIdentity }
  | { mode: "invalid"; identity: ReleaseIdentity };

export const EMPTY_RELEASE_IDENTITY: ReleaseIdentity = {
  deploymentId: null,
  gitSha: null,
};

/** Exact Phase 6 preflight/rollback identity contract. */
export function releaseRuntimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
): ReleaseReadiness {
  let hosted: boolean;
  try {
    hosted = isHostedRuntimeEnvironment(env);
  } catch {
    // A malformed explicit deployment label cannot hide immutable Vercel
    // markers and disable the release-identity requirement.
    hosted = Boolean(
      env.VERCEL === "1" ||
        env.VERCEL_ENV ||
        env.VERCEL_GIT_COMMIT_REF ||
        env.VERCEL_DEPLOYMENT_ID ||
        env.VERCEL_GIT_COMMIT_SHA,
    );
  }
  if (!hosted) {
    return { mode: "disabled", identity: EMPTY_RELEASE_IDENTITY };
  }

  const deploymentId = env.VERCEL_DEPLOYMENT_ID?.trim() ?? "";
  const gitSha = env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  if (
    !/^dpl_[A-Za-z0-9]+$/.test(deploymentId) ||
    !/^[0-9a-fA-F]{40}$/.test(gitSha)
  ) {
    return { mode: "invalid", identity: EMPTY_RELEASE_IDENTITY };
  }

  return {
    mode: "configured",
    identity: { deploymentId, gitSha: gitSha.toLowerCase() },
  };
}
