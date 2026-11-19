import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { installSidecarSpawnGuard } from "./packages/core/test/sidecarGuard";

// No test launches the real Browser Use sidecar or reaches the owner's browser
// profile (`packages/core/test/sidecarGuard.ts` has the story). Every test file
// runs with both of these:
//
// 1. The profile the environment names is a fresh directory of its own, so a
//    path that falls back to it — `browserProfileDir()`, a child process that
//    inherits the env — lands in the trash, not in `~/.engager/browser-profile`.
//    Set outright rather than defaulted: a developer's shell may export the
//    live one.
// 2. A child_process call that runs `bridge.py` throws, unless its argv carries
//    a `--profile-dir` of the test's own under the system temp root. The
//    transports take a `spawnImpl`, and the suites hand them a fake.
const profile = realpathSync(mkdtempSync(join(tmpdir(), "engager-test-browser-profile-")));
process.env.ENGAGER_BROWSER_PROFILE_DIR = profile;
afterAll(() => rmSync(profile, { recursive: true, force: true }));

installSidecarSpawnGuard(createRequire(import.meta.url)("node:child_process"));
// `import { spawn } from "node:child_process"` binds the ESM view of the
// builtin, which follows the CJS object only once it is told to.
syncBuiltinESMExports();
