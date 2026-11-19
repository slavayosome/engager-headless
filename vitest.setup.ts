import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Postgres integration tests run against a dedicated test DB as the non-superuser
// `engager_app` role (so RLS is actually enforced). Run `npm run pg:test:setup`
// once to create + migrate it. CI can override DATABASE_URL.
//
// The address comes from libpq's own PGHOST/PGPORT when they are set, so a
// machine that keeps its 15+ server beside an older default cluster runs the
// gate with one exported variable instead of a per-command URL. The schema
// needs PG 15 (UNIQUE ... NULLS NOT DISTINCT); on an older default port the
// migration refuses, which reads as a broken suite rather than a wrong server.
const testServer = `${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}`;
const usingDefaultLocalDatabase = !process.env.DATABASE_URL;
process.env.DATABASE_URL ||= `postgresql://engager_app@${testServer}/engager_test`;
// Migration/cutover tests need both the app role and local owner role. Keep
// both fallbacks on the same disposable database even if a later .env load
// supplies the developer database's owner URL.
if (usingDefaultLocalDatabase && !process.env.ENGAGER_MIGRATE_DATABASE_URL) {
  const owner = encodeURIComponent(userInfo().username);
  process.env.ENGAGER_MIGRATE_DATABASE_URL =
    `postgresql://${owner}@${testServer}/engager_test`;
}
process.env.ENGAGER_DEPLOYMENT_ENV ||= "test";
// Most unit/integration fixtures exercise product behavior rather than billing.
// Entitlement-specific tests opt back into the hosted gate explicitly.
process.env.ENGAGER_PAYWALL_ENABLED ||= "false";

// Deterministic 32-byte AES key so secrets crypto (encrypt/decrypt) works in tests.
process.env.ENGAGER_MASTER_KEY ||= Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

// Never write into the owner's real ~/.engager. Every Engager default there is
// homedir-derived — the Brain vault, license.json, entitlement.json,
// device-key, install-id, authority.json, the sidecar profile and the journal
// beside it, chat-cwd, ~/.engager/.env, the CLI's own root — and most have no
// env override, so one throwaway HOME per test process moves them all. The
// vault, which MCP tools write without a path argument, gets its own override
// as well; a case that still resolves the owner's vault fails in
// `config.brainDir` instead of writing to it. Resolved like a real home, which
// has no symlink in it: macOS's tmpdir is one, into /private.
const testHome = realpathSync(mkdtempSync(join(tmpdir(), "engager-test-home-")));
process.env.HOME = testHome;
process.env.ENGAGER_BRAIN_DIR = join(testHome, ".engager", "brain");
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

// Never read the developer's real ~/.engager/browser-bridge.json: a live
// bridge on the machine running the suite would route test-constructed
// drivers at a real browser. Cases that exercise discovery point this at
// their own fixture path.
process.env.ENGAGER_BROWSER_BRIDGE_FILE ||= "/nonexistent/engager-test-browser-bridge.json";
// And never SERVE one: a harness-spawned agent (the e2e ready-line suite
// inherits this env) must not launch a real Chromium at startup. Bridge
// suites stub this back on per case.
process.env.ENGAGER_BROWSER_BRIDGE ||= "off";
// Authority fixtures never read or create the owner's installation identity.
process.env.ENGAGER_EXECUTION_ID_FILE ||= join(tmpdir(), `engager-test-execution-${process.ppid}`);
process.env.ENGAGER_LOCAL_AGENT_STATE_DIR ||= join(tmpdir(), `engager-test-local-agents-${process.pid}`);
// And never PROBE the developer's own agent CLIs. Discovery's standard roots
// include `/opt/homebrew/bin` and `/usr/bin`, which is exactly where their
// real `claude` and `codex` live, and a scan runs `--version` against whatever
// it finds — a live provider CLI executed by the gate, which this suite never
// does. Cases that exercise discovery point this at their own fixtures.
process.env.ENGAGER_AGENT_SEARCH_ROOTS ||= join(tmpdir(), `engager-test-agent-roots-${process.pid}`);
