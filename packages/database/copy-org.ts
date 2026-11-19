/**
 * What a portable restore shares with the database layer: the pool settings
 * for a connection to a URL the process env does not describe, and the
 * dependency order of the manifest tables.
 */
import type { PoolClient, PoolConfig } from "pg";
import {
  isLoopbackDatabaseHost,
  type DeploymentEnvironment,
} from "./environment";
import { pgConnectionSecurityConfig } from "./poolConfig";

/** A SECOND foreign-key cycle among the manifest tables. The schema has exactly
 *  one — `messages` ↔ `incoming_comments` — and both of its constraints are
 *  deferrable (`0149_deferrable_comment_cycle.sql`), so that component is
 *  written as one group inside a destination transaction that defers every check to
 *  commit. The order below is computed, never hardcoded, so a cycle a later
 *  migration adds surfaces HERE rather than silently inverting an insert order
 *  and corrupting a copy — a new cycle's constraints are not deferrable, and
 *  making them so is a deliberate decision, not something a copier may assume. */
export class CopyOrgCycleError extends Error {
  constructor(remaining: readonly string[]) {
    super(
      `Refusing to copy: more than one foreign-key cycle survives among ${remaining.join(", ")}`,
    );
    this.name = "CopyOrgCycleError";
  }
}

/**
 * Verified TLS stays one authority — this function — while each connection
 * answers for itself. `pgConnectionSecurityConfig`'s defaults come from the
 * process env, which cannot answer for a URL it was not configured for. A
 * loopback host is described as `local` here for the same reason
 * `assertMigrationTargetIsSafe` returns early on one: whatever the deployment
 * is, that server has no certificate to verify.
 */
export function copyOrgPoolConfig(
  url: string,
  environment: DeploymentEnvironment,
): Pick<PoolConfig, "connectionString" | "ssl"> {
  const loopback = isLoopbackDatabaseHost(url);
  return pgConnectionSecurityConfig(
    url,
    loopback ? "false" : "true",
    loopback ? "local" : environment,
  );
}

type ForeignKeyEdge = { child: string; parent: string };

/** Everything `from` reaches through `next`, inside `scope`. Plainly, because
 *  the manifest is 67 tables — not a graph library's problem. */
function reachable(
  from: string,
  scope: ReadonlySet<string>,
  next: ReadonlyMap<string, Set<string>>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    for (const step of next.get(stack.pop()!) ?? []) {
      if (!scope.has(step) || seen.has(step)) continue;
      seen.add(step);
      stack.push(step);
    }
  }
  return seen;
}

/**
 * The insert order, computed at the SOURCE from `pg_catalog.pg_constraint`
 * rather than declared here. Parents first; ties keep the manifest's own
 * order, so two runs against one schema resolve identically.
 *
 * A cycle stalls that sort, and exactly one is expected: the tables of that one
 * component come out as a group, in the manifest's order, for the destination
 * transaction to write with its constraints deferred to commit. A second one
 * raises — see `CopyOrgCycleError`.
 */
/** Exported for `./portable-restore.ts`, which writes the same manifest tables
 * from a file rather than from a second database and must use the identical
 * dependency order and the identical single-cycle refusal. */
export function topologicalOrder(
  tables: readonly string[],
  edges: readonly ForeignKeyEdge[],
): string[] {
  const parents = new Map<string, Set<string>>(
    tables.map((table) => [table, new Set<string>()]),
  );
  const children = new Map<string, Set<string>>(
    tables.map((table) => [table, new Set<string>()]),
  );
  for (const edge of edges) {
    // Self-edges (a tree table pointing at its own parent row) constrain the
    // row order inside one table, never the table order between two.
    if (edge.child === edge.parent) continue;
    if (!parents.has(edge.child) || !parents.has(edge.parent)) continue;
    parents.get(edge.child)!.add(edge.parent);
    children.get(edge.parent)!.add(edge.child);
  }

  const order: string[] = [];
  const remaining = new Set(tables);
  let cycleBroken = false;
  while (remaining.size > 0) {
    let ready = tables.filter(
      (table) => remaining.has(table) && parents.get(table)!.size === 0,
    );
    if (ready.length === 0) {
      // Stalled: every remaining table waits on another. The cycle components
      // are the strongly connected ones — a table merely DOWNSTREAM of a cycle
      // is blocked too, and becomes ready once the cycle is written.
      const components: string[][] = [];
      const claimed = new Set<string>();
      for (const table of tables) {
        if (!remaining.has(table) || claimed.has(table)) continue;
        const down = reachable(table, remaining, children);
        const up = reachable(table, remaining, parents);
        const component = tables.filter(
          (other) =>
            other === table ||
            (remaining.has(other) && down.has(other) && up.has(other)),
        );
        if (component.length === 1) continue;
        for (const member of component) claimed.add(member);
        components.push(component);
      }
      if (cycleBroken || components.length !== 1) {
        throw new CopyOrgCycleError([...remaining]);
      }
      // The one cycle, in the manifest's order: with a single cycle its
      // members can have no blocking parent outside it, so writing them as a
      // group leaves every other edge satisfied. One is the limit because one
      // is what was made deferrable — see `CopyOrgCycleError`.
      cycleBroken = true;
      ready = components[0]!;
    }
    for (const table of ready) {
      remaining.delete(table);
      order.push(table);
      for (const child of children.get(table)!) {
        parents.get(child)!.delete(table);
      }
    }
  }
  return order;
}

export async function foreignKeyEdges(
  client: PoolClient,
): Promise<ForeignKeyEdge[]> {
  const result = await client.query<ForeignKeyEdge>(`
    select ch.relname as child, pa.relname as parent
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class ch on ch.oid = c.conrelid
    join pg_catalog.pg_class pa on pa.oid = c.confrelid
    join pg_catalog.pg_namespace n on n.oid = ch.relnamespace
    where c.contype = 'f' and n.nspname = 'public'
  `);
  return result.rows;
}
