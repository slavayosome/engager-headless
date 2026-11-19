import {
  isHostedRuntimeEnvironment,
  resolveDeploymentEnvironment,
} from "@engager/database/environment";

export type HostedProviderRuntimeConfig =
  | { mode: "configured" }
  | { mode: "disabled" }
  | { mode: "invalid"; reason: string };

function obviousPlaceholder(value: string): boolean {
  return /(?:change[-_ ]?me|replace[-_ ]?me|example|placeholder|dummy)/i.test(
    value,
  );
}

/** Central launch-readiness contract for paid capabilities that depend on
 * external cognition. Local/test may intentionally run
 * fakes; hosted dev/prod may not silently do so. */
export function hostedProviderRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostedProviderRuntimeConfig {
  let deployment: ReturnType<typeof resolveDeploymentEnvironment>;
  try {
    deployment = resolveDeploymentEnvironment(env);
  } catch (error) {
    return {
      mode: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "Invalid deployment environment",
    };
  }
  const hosted = isHostedRuntimeEnvironment(env);
  if (!hosted) {
    return { mode: "disabled" };
  }
  if (deployment !== "dev" && deployment !== "prod") {
    return {
      mode: "invalid",
      reason: "ENGAGER_DEPLOYMENT_ENV must be dev or prod on a hosted platform",
    };
  }

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (
    !/^sk-ant-[A-Za-z0-9_-]{12,}$/.test(anthropicKey) ||
    obviousPlaceholder(anthropicKey)
  ) {
    return {
      mode: "invalid",
      reason:
        "ANTHROPIC_API_KEY must contain a real Anthropic credential in hosted runtimes",
    };
  }
  return { mode: "configured" };
}
