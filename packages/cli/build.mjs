// Build the publishable engager package: esbuild compiles the entry
// points with ONLY workspace (@engager/*) code inlined — every other bare
// import stays external and is declared as a real npm dependency, so nothing
// pure-JS gets riskily inlined. Assets land where the code's own
// import.meta.url logic already resolves relative to the emitted bundles:
//   dist/python/      <- browser-use/subprocessTransport.ts  new URL("./python/", …)
//   dist/migrations/  <- database/migrate.ts    new URL("./migrations", …)
//   skills/           <- skills registry walk-up from dist/
import { build } from "esbuild";
import { mkdirSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSnapshot } from "./bin/lib/migrationFingerprint.mjs";
import { copyRuntimeAssets } from "./buildAssets.mjs";
import { buildSha } from "./buildSha.mjs";
import { bundleOptions, entries } from "./buildOptions.mjs";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PKG, "..", "..");
const DIST = path.join(PKG, "dist");
const VERSION = readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
// Before anything is wiped: a refused rehearsal origin must fail the build with
// the previous dist still on disk.
const options = bundleOptions({ version: VERSION, sha: buildSha(ROOT) });

rmSync(DIST, { recursive: true, force: true });
rmSync(path.join(PKG, "skills"), { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

await build({
  ...options,
  entryPoints: entries(ROOT),
  outdir: DIST,
  outExtension: { ".js": ".mjs" },
});

// Sidecar tree next to the bundles, minus local state and caches.
copyRuntimeAssets(path.join(ROOT, "packages", "core", "linkedin", "browser-use", "python"), path.join(DIST, "python"));
// drizzle-kit's snapshots are tooling input nothing applies, and a signed
// schema path reaches only a tree without them (docs/signed-schema-paths.md).
const MIGRATIONS = path.join(ROOT, "packages", "database", "migrations");
copyRuntimeAssets(MIGRATIONS, path.join(DIST, "migrations"), (file) => !isSnapshot(path.relative(MIGRATIONS, file)));
copyRuntimeAssets(path.join(ROOT, "skills"), path.join(PKG, "skills"));
copyFileSync(path.join(ROOT, "LICENSE"), path.join(DIST, "LICENSE"));
console.log("Built headless CLI, agent, MCP server and runtime assets.");
