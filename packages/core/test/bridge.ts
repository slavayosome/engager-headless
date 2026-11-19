import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { join } from "node:path";
import { startBrowserBridge } from "../linkedin/browser-use/bridgeServer";
import { bridgeFilePath, writeBridgeFile } from "../linkedin/browser-use/bridgeFile";
import type { SubprocessBrowserUseTransport } from "../linkedin/browser-use/subprocessTransport";
import { browserProfileDir } from "../linkedin/session";

type Frame = { op: string; id: string; params?: unknown };

/** A sidecar's answer to any frame. */
export const sidecarReply = (request: Frame) => ({ v: 1, id: request.id, op: request.op, ok: true, result: { ok: true } });

/** A sidecar that records each op it is sent and holds `warm_browser` until `gate` opens. */
export const gatedSidecar = (calls: string[], gate: Promise<void>) => ({ send: async (request: Frame) => {
  calls.push(request.op);
  if (request.op === "warm_browser") await gate;
  return sidecarReply(request);
}, close: async () => {} }) as unknown as SubprocessBrowserUseTransport;

/**
 * A session bridge holding a fallback sidecar, and the agent coming up behind it.
 *
 * The profile's journal is one lock. The fallback takes it on its first
 * operation and keeps it until `retire()` (which can be made to fail); the
 * agent, once `publish()` has put its discovery file down, starts waiting for
 * it and answers nothing until it has it, as its sidecar does. `events` is the
 * order the lock changed hands in, `ops` what each side was sent, and `toAgent`
 * the frames the agent received.
 * `ENGAGER_BROWSER_BRIDGE_FILE` is stubbed until `stop()`.
 */
export async function fallbackWithAgent(dir: string, retires: boolean) {
  const events: string[] = [];
  const ops = { fallback: [] as string[], agent: [] as string[] };
  const toAgent: Frame[] = [];
  let holder: string | null = null;
  let free: (() => void)[] = [];
  const acquire = async (who: string) => {
    while (holder !== null && holder !== who) await new Promise<void>((resolve) => free.push(resolve));
    if (holder !== who) events.push(`${who} holds`);
    holder = who;
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fallback = { send: async (request: Frame) => {
    await acquire("fallback");
    ops.fallback.push(request.op);
    if (ops.fallback.length === 1) await gate;
    return sidecarReply(request);
  }, retire: async () => {
    if (!retires) throw new Error("the sidecar would not exit");
    if (holder === "fallback") { holder = null; events.push("fallback released"); }
    free.splice(0).forEach((wake) => wake());
  }, close: async () => {} } as unknown as SubprocessBrowserUseTransport;
  let agentStarted: Promise<void> | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.end(JSON.stringify({ ok: true }));
    let body = "";
    req.on("data", (chunk) => { body += chunk; }).on("end", () => {
      const request = JSON.parse(body) as Frame;
      void agentStarted!.then(() => { ops.agent.push(request.op); toAgent.push(request); res.end(JSON.stringify(sidecarReply(request))); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("ENGAGER_BROWSER_BRIDGE_FILE", join(dir, "standing.json"));
  const bridge = await startBrowserBridge({ sessionFile: join(dir, "bridge.json"), transport: () => fallback });
  return {
    events, ops, toAgent, release,
    publish: () => {
      agentStarted = acquire("agent");
      writeBridgeFile({ protocolVersion: 1, port: (server.address() as AddressInfo).port, token: "t", pid: process.pid + 1, profileDir: browserProfileDir(), startedAt: Date.now() }, bridgeFilePath());
    },
    stop: async () => {
      release();
      await bridge?.close();
      server.closeAllConnections();
      server.close();
      vi.unstubAllEnvs();
    },
  };
}
