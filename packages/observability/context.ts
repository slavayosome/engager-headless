/**
 * The context every event carries: which build, where it runs, on which plan,
 * through which agent, and how old the install is. Resolved once per flush and
 * cached for a few minutes, never at the call site, so `track()` stays a
 * synchronous enqueue that cannot slow or fail a product path.
 *
 * Nothing here names a person. `org` is a PostHog group keyed by
 * `hashedId(orgId)`: it lets one organisation's events be counted together and
 * tells nobody which organisation it is.
 */
import * as os from "node:os";
import { buildSha } from "@engager/common/build-sha";
import { productVersion } from "@engager/common/version";
import {
  AGENT_ADAPTERS,
  CONTEXT_SCHEMA,
  DEPLOYMENT_ENVS,
  PLACEMENTS,
  hashedId,
  type TelemetryContext,
} from "./events";
import { installAgeDays, readPlanHint } from "./telemetryState";

type Placement = (typeof PLACEMENTS)[number];

/** What only the product knows: the agent behind the install, and whether this
 * Mac holds a live managed-app claim. The claim is a licence-gate read, so only
 * a process that carries the gate can answer it; any other leaves `paid` unset, which reads the plan hint instead (`resolvePlan`). The
 * org comes from ENGAGER_ORG_ID, which every Engager process is launched
 * with. */
export type DynamicContext = {
  agentAdapter?: (typeof AGENT_ADAPTERS)[number] | "none";
  organizationId?: string;
  paid?: boolean;
};

export type ResolvedContext = {
  context: TelemetryContext;
  groups?: { org: string };
};

const CONTEXT_TTL_MS = 5 * 60_000;

let dynamicSource: (() => Promise<DynamicContext> | DynamicContext) | null = null;
let cached: { at: number; value: ResolvedContext } | null = null;

/** Called once by the process that can read the database (the agent, the
 * dashboard) so the context carries the agent adapter and the org group. */
export function registerTelemetryContext(
  source: (() => Promise<DynamicContext> | DynamicContext) | null,
): void {
  dynamicSource = source;
  cached = null;
}

export function resetTelemetryContext(): void {
  cached = null;
}

/** The placement a process was launched in. A tenant is a `cloud` deployment;
 * the Mac app's launcher exports ENGAGER_PLACEMENT=mac; everything else is a
 * checkout or an npm install. */
export function installationPlacement(env: NodeJS.ProcessEnv = process.env): Placement {
  return env.ENGAGER_PLACEMENT === "mac" ? "mac" : "checkout";
}

/** macOS names its releases after the marketing version, not the kernel:
 * Darwin 20 to 24 are macOS 11 to 15, and Darwin 25 is macOS 26. */
export function resolveOsMajor(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): TelemetryContext["os_major"] {
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  if (platform !== "darwin") return "other";
  const kernel = Number.parseInt(release, 10);
  if (!Number.isFinite(kernel)) return "other";
  const marketing = kernel >= 25 ? kernel + 1 : kernel - 9;
  const value = `macos-${marketing}`;
  return CONTEXT_SCHEMA.shape.os_major.safeParse(value).success
    ? (value as TelemetryContext["os_major"])
    : "other";
}

function resolveDeploymentEnv(env: NodeJS.ProcessEnv): TelemetryContext["deployment_env"] {
  const value = env.ENGAGER_DEPLOYMENT_ENV ?? "local";
  return (DEPLOYMENT_ENVS as readonly string[]).includes(value)
    ? (value as TelemetryContext["deployment_env"])
    : "local";
}

/** A tenant is `hosted`; a checkout holds no managed-app claim, so it is
 * `free`. A Mac is `paid` or `free` by the claim, as its own process says when
 * it carries the licence gate, else as the hint such a process left lately; a
 * Mac with neither (the free MCP server beside an agent that is not running) is
 * `unknown`, not a guess. `trial` is in the vocabulary for the day a claim
 * carries it. */
function resolvePlan(
  placement: Placement,
  dynamic: DynamicContext,
  now: number,
): TelemetryContext["plan"] {
  if (placement === "hosted") return "hosted";
  if (placement !== "mac") return "free";
  if (dynamic.paid !== undefined) return dynamic.paid ? "paid" : "free";
  return readPlanHint(now)?.plan ?? "unknown";
}

export async function resolveTelemetryContext(
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedContext> {
  if (cached && now - cached.at < CONTEXT_TTL_MS) return cached.value;
  const placement = installationPlacement(env);
  let dynamic: DynamicContext = {};
  try {
    dynamic = (await dynamicSource?.()) ?? {};
  } catch {
    // No agent or org to report: the events still carry the static context.
  }
  const context = CONTEXT_SCHEMA.parse({
    app_version: productVersion(),
    build_sha: buildSha(),
    placement,
    deployment_env: resolveDeploymentEnv(env),
    os_major: resolveOsMajor(),
    plan: resolvePlan(placement, dynamic, now),
    agent_adapter: dynamic.agentAdapter ?? "none",
    install_age_days: installAgeDays(now),
  });
  const organizationId = dynamic.organizationId ?? env.ENGAGER_ORG_ID?.trim();
  const value: ResolvedContext = {
    context,
    ...(organizationId ? { groups: { org: hashedId(organizationId) } } : {}),
  };
  cached = { at: now, value };
  return value;
}
