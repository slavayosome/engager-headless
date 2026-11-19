import { CODEX_DISABLED_FEATURES } from "./codex";
import { codexProofKey, recordCodexSandboxProof } from "./codexProof";
import { verifyCodexIsolation, verifyIsolationProfile } from "./isolation";
import { verifyInvocationProfile } from "./profileEvidence";
import { eventObject, jsonPrompt, modelPayload } from "./validatedJson";
import { agentFailure } from "./state";
import type { AgentCliAdapter, ResolvedAgentSelection } from "./types";

/** Fifth adapter exists only in tests. It joins the same registry/LLM/broker;
 * no worker, stage, dashboard or provider switch knows its id. */
export const fixtureAdapter: AgentCliAdapter = {
  id: "fixture",
  name: "Fixture",
  provider: "fixture",
  descriptor: {
    adapterId: "fixture",
    adapterContractVersion: "1",
    supportedExecutableVersions: ["1.0.0"],
    background: { text: true, structured: "validated_json" },
    chat: {
      transport: "broker",
      events: true,
      textDeltas: false,
      brokerTools: true,
      resumable: "canonical_history",
    },
    isolationProfileVersion: "fixture-1",
    supportedAuthRoutes: ["fixture"],
    // Two declared models: a second one lets a suite prove that a changed role
    // reaches the executor rather than the first id a route declares.
    supportedModelRoutes: [
      { providerRef: "fixture", models: ["fixture-model", "fixture-model-2"] },
    ],
    discovery: { executables: ["fixture"] },
  },
  supportsJsonSchema: true,
  supportsWebSearch: false,
  bin: () => "fixture",
  buildArgs: (request) => ["--model", request.model],
  async prepareInvocation(request, env) {
    return {
      env: { ...env, HOME: request.requestDirectory },
      input: jsonPrompt(request),
    };
  },
  inspectOutputLine(line) {
    const event = eventObject(line);
    if (event.type === "tool_use") throw agentFailure("native_tool_attempt");
  },
  parseResult(stdout) {
    const event = eventObject(stdout.trim());
    if (event.type === "error") throw agentFailure(event.code);
    if (event.type !== "result") throw agentFailure("agent_terminal_missing");
    return { ...modelPayload(event.text), usage: {} };
  },
};

export const CONFORMANCE_IDS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "fixture",
];

export function fixtureRoute(adapter: AgentCliAdapter) {
  const route = adapter.descriptor.supportedModelRoutes.at(-1)!;
  return {
    modelRef: route.models[0]!,
    providerRef: route.providerRef,
    authRoute:
      route.authRoutes?.[0] ?? adapter.descriptor.supportedAuthRoutes[0]!,
  };
}

export async function verifyFixtureIsolation(
  adapter: AgentCliAdapter,
  selection: ResolvedAgentSelection,
) {
  if (adapter.id === "claude")
    return verifyIsolationProfile(adapter, selection);
  const common = {
    profile: adapter.descriptor.isolationProfileVersion,
    executableSha256: selection.executableIdentity,
    version: selection.observedVersion,
    platform: process.platform,
    modelRef: selection.modelRef,
    providerRef: selection.providerRef,
    authRoute: selection.authRoute,
    proofSha256: "b".repeat(64),
    sourceRef: "synthetic-conformance-only-not-native-certification",
  };
  if (adapter.id === "codex") {
    // A synthetic proof for the fake binary: the real self-test needs a real
    // seatbelt, which `codexSelfTest.test.ts` covers against its own fake.
    await recordCodexSandboxProof(codexProofKey(selection), {
      checks: ["synthetic-conformance-only-not-native-certification"],
      enabledFeatures: [],
    });
    return verifyCodexIsolation(selection);
  }
  verifyInvocationProfile(
    selection,
    adapter.descriptor.isolationProfileVersion,
    [
      {
        ...common,
        nativeToolsDenied: true,
        hostileConfigContained: true,
        noIntegrationsOrDownloads: true,
        nativeAuthOnly: true,
      },
    ],
    adapter.id === "fixture" ? [] : undefined,
  );
}

/** Synthetic child implements the CLI event protocol. All five callers use
 * actual adapters and the real subprocess supervisor, never a mocked result. */
export function childProtocol(adapter: AgentCliAdapter): string {
  return `
const adapter=${JSON.stringify(adapter.id)};
if(args.includes("--version")){console.log(${JSON.stringify(adapter.descriptor.supportedExecutableVersions[0])});process.exit(0);}
if(args.includes("--help")){console.log("--safe-mode --restricted --tools --strict-mcp-config --no-session-persistence --json-schema --ignore-user-config --ignore-rules --ephemeral --output-schema --json");process.exit(0);}
if(args[0]==="features"){console.log(${JSON.stringify(CODEX_DISABLED_FEATURES.join("\n"))});process.exit(0);}
function emit(value, mode="success") {
 const text=typeof value==="string"?value:JSON.stringify(value);
 const events=[];
 if(mode==="native")events.push(adapter==="codex"?{type:"item.started",item:{type:"file_change"}}:adapter==="claude"?{type:"assistant",message:{content:[{type:"tool_use",name:"Bash"}]}}:{type:"tool_use"});
 if(mode==="auth"||mode==="quota") {
  const code=mode==="auth"?"authentication_required":"quota_exhausted";
  events.push(adapter==="codex"?{type:"turn.failed",error:{message:code}}:adapter==="claude"?{type:"result",is_error:true,result:code}:adapter==="fixture"?{type:"error",code}:{type:"error",error:{message:code}});
 } else if(adapter==="claude")events.push({type:"result",subtype:"success",is_error:false,result:text,structured_output:typeof value==="string"?undefined:value,usage:{input_tokens:10,output_tokens:7}});
 else if(adapter==="codex")events.push({type:"item.completed",item:{type:"agent_message",text}},{type:"turn.completed",usage:{input_tokens:10,output_tokens:7}});
 else if(adapter==="gemini")events.push({type:"init",model:"observed-gemini"},{type:"message",role:"assistant",content:text,delta:true},{type:"result",status:"success",stats:{input_tokens:10,output_tokens:7}});
 else if(adapter==="opencode")events.push({type:"step_start",sessionID:"synthetic",part:{type:"step-start"}},{type:"text",sessionID:"synthetic",part:{type:"text",text,time:{end:1}}},{type:"step_finish",sessionID:"synthetic",part:{type:"step-finish",reason:"stop",tokens:{input:10,output:7}}});
 else events.push({type:"result",text});
 if(mode==="missing") {events.pop();if(!events.length)events.push({type:"partial"});}
 return events.map(e=>JSON.stringify(e)).join("\\n")+"\\n";
}
`;
}
