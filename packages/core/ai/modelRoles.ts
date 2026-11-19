import { config } from "../config";
import { installedRoleModels, storedAgentRoles } from "./agentCli/selection";
import type { UnofferedRoleModel } from "./agentCli/types";

/**
 * The roles inference resolves a model for — the ones `config.models` actually
 * has. Three serve background work and `chat` serves the dashboard chat lane,
 * which spoke an env vocabulary of its own until T-9.6 folded it in here. The
 * names are the config's own; renaming them to a triage/draft vocabulary
 * belongs with the per-worker override, which is Phase 8's.
 */
export type ModelRole = "filter" | "writer" | "writerPremium" | "chat";

/**
 * The ONE reader of `config.models` — and a leaf, because its callers need the
 * map and cannot share a module.
 *
 * `boundaryModelScope()` spreads it onto a usage scope so every `modelFor(role)`
 * inside reads the boundary's answer. The agent-CLI status probe reports it
 * while standing OUTSIDE any scope — which is what a probe is, and where
 * `modelFor` throws by design — so that function cannot serve it, and the chat
 * surface names its `--model` from outside one too. None of them may resolve
 * the roles its own way: a probe reporting a map no boundary would ever produce
 * proves nothing, and the probe's whole claim is that it agrees with what
 * inference would actually do. A direct import between the probe and `modelFor`
 * closes a cycle (`agentCli/index.ts` → `modelFor.ts` → `client.ts` →
 * `agentCli/index.ts`), so the read sits here instead, importing `../config`
 * and nothing else.
 *
 * A fresh object per call: the boundary hands its copy to an async-local scope
 * that outlives this frame, and a shared one would make every scope's answer
 * the same mutable object.
 */
export function roleModels(
  organizationOverrides: Readonly<Partial<Record<ModelRole, string>>> = {},
): Record<ModelRole, string> {
  return resolvedRoleModels(organizationOverrides).models;
}

/**
 * `roleModels`, with the roles whose configured model the installation does
 * not offer named beside the model each runs instead — for the Agent page,
 * which shows both rather than letting a substitution pass in silence.
 *
 * The precedence is the one every surface shares: the env defaults, then the
 * organization's overrides, then the local installation's own roles. Stored
 * roles WIN for an agent-CLI install: they were written against a vocabulary
 * selection had already verified the pinned agent declares, and an
 * `ENGAGER_MODEL_*` value or an organization row that quietly outranked one
 * could name a model this agent refuses. The cost is that changing the env
 * alone changes nothing until the owner reconfigures — which is what
 * `docs/local-agents.md` tells them. The result then runs through
 * `installedRoleModels`, so no source — a stale pin, an override, a shipped
 * default — can ask the installed agent for a model it does not offer.
 */
export function resolvedRoleModels(
  organizationOverrides: Readonly<Partial<Record<ModelRole, string>>> = {},
): {
  models: Record<ModelRole, string>;
  unoffered: Partial<Record<ModelRole, UnofferedRoleModel>>;
} {
  if (config.llmBackend !== "agent-cli")
    return {
      models: { ...config.models, ...organizationOverrides },
      unoffered: {},
    };
  const local = storedAgentRoles();
  const overrides = Object.fromEntries(
    Object.entries(organizationOverrides).filter(([role]) => !(role in local)),
  );
  return installedRoleModels<ModelRole>({
    ...config.models,
    ...overrides,
    ...local,
  });
}
