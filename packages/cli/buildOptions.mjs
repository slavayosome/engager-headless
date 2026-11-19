// Build options shared by the CLI bundles. Nothing here touches the disk.
import path from "node:path";
import { checkpointBuildDefines } from "./buildCheckpoint.mjs";
import { appBuildDefines } from "./buildRehearsal.mjs";

// ONLY workspace (@engager/*) code is inlined -- every other bare import stays
// external and is declared as a real npm dependency, so nothing pure-JS gets
// riskily inlined.
export const workspaceOnly = {
  name: "external-except-workspace",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@engager/")) return null;
      return { path: args.path, external: true };
    });
  },
};

export function entries(root) {
  return {
    mcp: path.join(root, "packages", "core", "mcp", "server.ts"),
    agent: path.join(root, "scripts", "agent.ts"),
    worker: path.join(root, "scripts", "worker.ts"),
    scheduler: path.join(root, "scripts", "scheduler.ts"),
    migrate: path.join(root, "packages", "database", "migrate.ts"),
    bootstrap: path.join(root, "scripts", "bootstrap-org.ts"),
    "refresh-license": path.join(root, "scripts", "refresh-license.ts"),
    "core-command": path.join(root, "scripts", "core-command.ts"),
    "local-agent": path.join(root, "scripts", "local-agent-api.ts"),
  };
}

export function bundleOptions({ version, sha, env = process.env }) {
  return {
    ...(env.ENGAGER_DEV_BUILD === "1" ? { banner: { js: 'import "../bin/lib/developmentBootstrap.mjs";' } } : {}),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    plugins: [workspaceOnly],
    logLevel: "warning",
    define: {
      __ENGAGER_VERSION__: JSON.stringify(version),
      __ENGAGER_BUILD_SHA__: JSON.stringify(sha),
      ...checkpointBuildDefines(env),
      ...appBuildDefines(env),
      ...(env.ENGAGER_LICENSE_BUILD === "1"
        ? { __ENGAGER_LICENSE_REQUIRED__: '"true"' }
        : {}),
    },
  };
}
