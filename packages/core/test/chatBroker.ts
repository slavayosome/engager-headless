import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { vi } from "vitest";
import { chatBrokerTurns, chatSessions } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { ADAPTERS } from "../ai/agentCli";
import { childProtocol, fixtureAdapter, fixtureRoute } from "../ai/agentCli/conformance.fixture";
import { configureLocalAgent } from "../ai/agentCli/selection";
import type { AgentCliResult } from "../ai/agentCli/types";
import type { LLM } from "../ai/client";
import { MockDriver } from "../linkedin/mock";
import { createChatBroker } from "../chat/broker";
import type { DraftRequest } from "../chat/requestedDraft";
import { injectedConnector } from "./mcpHarness";

/** What the dispatcher's system prompt says first, for the prompt it is. */
const DISPATCHER_CALLS: Array<[string, string]> = [
  ["You plan and then write LinkedIn", "dispatcher.compose@3"],
  ["You plan LinkedIn", "dispatcher.plan@5"],
  ["You write LinkedIn", "dispatcher.write@5"],
  ["You judge already-written", "dispatcher.judge@5"],
];

/**
 * One chat broker turn with a fake agent, to its end. The agent asks for
 * `calls` one tool at a time and then answers; each judgment the broker asks
 * of it (`DRAFTING SOURCE DATA`) is answered by `llm`, the dispatcher's own
 * fake, by the prompt the system text names. `sessionId` continues that
 * conversation; without it each turn opens one of its own. Returns what the
 * turn recorded, its conversation, and the error it ended with, if any.
 */
export async function brokerTurn(
  organizationId: string,
  llm: LLM,
  input: { draftRequest?: DraftRequest; calls?: Array<{ name: string; arguments: Record<string, unknown> }>; sessionId?: string },
) {
  const root = mkdtempSync(join(tmpdir(), "engager-broker-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("ENGAGER_LOCAL_AGENT_STATE_DIR", join(root, "state"));
  ADAPTERS.fixture = fixtureAdapter;
  const bin = join(root, "fixture");
  writeFileSync(bin, `#!${process.execPath}\nconst args=process.argv.slice(2);${childProtocol(fixtureAdapter)}`, { mode: 0o700 });
  await configureLocalAgent(fixtureAdapter.descriptor, { purpose: "chat", absoluteExecutable: bin, ...fixtureRoute(fixtureAdapter) });
  const execute = async (_adapter: unknown, request: { system: string; user: string }): Promise<AgentCliResult> => {
    if (request.user.startsWith("=")) {
      const prompt = JSON.parse(request.user.split("\n").slice(1, -1).join("\n")).context as string;
      const promptRef = DISPATCHER_CALLS.find(([start]) => request.system.startsWith(start))?.[1] ?? "dispatcher.compile@1";
      return { text: "", usage: {}, structured: await llm.json({ model: "fixture", promptRef, system: request.system, user: prompt, schema: z.any() }) };
    }
    const history = JSON.parse(request.user).history as Array<{ role: string }>;
    const asked = history.slice(history.map((entry) => entry.role).lastIndexOf("user")).filter((entry) => entry.role === "tool").length;
    const tool = input.calls?.[asked];
    return { text: "", usage: {}, structured: tool ? { kind: "tool", text: null, tool } : { kind: "final", text: "Done.", tool: null } };
  };
  const requestId = randomUUID();
  const sessionId = input.sessionId ?? (await withOrg(organizationId, (tx) => tx.insert(chatSessions).values({}).returning()))[0]!.id;
  let error: Error | undefined;
  try {
    await createChatBroker(execute as never)({
      ctx: { organizationId, ...injectedConnector(new MockDriver()) },
      sessionId,
      requestId,
      userText: "Draft a comment.",
      system: "Use only the Engager broker.",
      signal: new AbortController().signal,
      onEvent: () => undefined,
      ...(input.draftRequest ? { draftRequest: input.draftRequest } : {}),
    });
  } catch (caught) {
    error = caught as Error;
  }
  const [turn] = await withOrg(organizationId, (tx) => tx.select().from(chatBrokerTurns).where(eq(chatBrokerTurns.id, requestId)));
  delete ADAPTERS.fixture;
  rmSync(root, { recursive: true, force: true });
  return { error, sessionId, steps: (turn?.steps ?? []) as Array<{ name: string; result?: { isError?: boolean; content?: Array<{ text?: string }> } }> };
}
