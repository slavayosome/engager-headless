import { eq } from "drizzle-orm";
import { db } from "@engager/database";
import { organizations } from "@engager/database/schema";
import type { ModelRole } from "./modelRoles";

/** What the org row stores about inference: the per-role model overrides the
 *  owner set on the Agent page, and the claude spawn path when they set one. */
export type OrgAgentOverrides = {
  /** Only roles the owner explicitly set; `{}` when the column is null. */
  models: Partial<Record<ModelRole, string>>;
  /** Null = the env fallback (`ENGAGER_AGENT_CLI_BIN` → "claude"). */
  bin: string | null;
};

/**
 * The org's stored inference overrides — the DB half of what
 * `boundaryModelScopeFor` merges over `roleModels()` at an inference entry
 * boundary. An install that never touched the setting gets `{}`/null and
 * resolves exactly as before.
 *
 * On the base pool, not a tenant tx: `organizations` sits outside forced RLS
 * (the id predicate carries the isolation), and the boundary that calls this
 * stands outside any open transaction by the same contract that lets it await
 * at all. One indexed primary-key read per boundary — deliberately uncached on
 * a local single-user install, which is what makes a save take effect on the
 * very next run.
 */
export async function orgAgentOverrides(
  organizationId: string,
): Promise<OrgAgentOverrides> {
  const [row] = await db
    .select({
      modelOverrides: organizations.modelOverrides,
      agentCliBin: organizations.agentCliBin,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    models: row?.modelOverrides ?? {},
    bin: row?.agentCliBin ?? null,
  };
}
