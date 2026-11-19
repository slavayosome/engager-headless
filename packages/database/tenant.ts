import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { db, schema } from "./client";
import { assertNonSuperuserRole } from "./guard";

/** The transaction-scoped DB handle passed to org-scoped work. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type TenantTransactionConfig = Parameters<typeof db.transaction>[1];

/** What runs once a commit has been announced. May be async; a rejection is
 * swallowed like a throw. */
type AfterCommitCallback = () => void | Promise<void>;

/** The callbacks one transaction, or one savepoint within it, is holding. */
type CommitFrame = { callbacks: AfterCommitCallback[] };

/** Transactions `withOrg` opened, and every savepoint opened inside them, each
 * mapped to the frame its callbacks belong to. */
const frames = new WeakMap<object, CommitFrame>();

/** A side effect that follows a commit never undoes it, and never fails the
 * work that was committed. */
function settle(callback: AfterCommitCallback): void {
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // See above.
  }
}

/**
 * Track `tx` against `frame`, and every savepoint opened from it against a
 * frame of its own. A savepoint's callbacks move to its parent when the
 * savepoint is released and are discarded when it rolls back, so they reach
 * the outer commit exactly when the work that registered them does.
 */
function adopt(tx: Tx, frame: CommitFrame): void {
  frames.set(tx, frame);
  const savepoint = tx.transaction.bind(tx);
  tx.transaction = async (run) => {
    const nested: CommitFrame = { callbacks: [] };
    const value = await savepoint((child) => {
      adopt(child, nested);
      return run(child);
    });
    frame.callbacks.push(...nested.callbacks);
    return value;
  };
}

/**
 * Run `fn` inside a transaction scoped to `organizationId`. Sets the
 * `app.current_org` GUC LOCAL to the transaction, which (a) supplies the default
 * for every `organization_id` column on insert and (b) drives the RLS predicate
 * so reads/writes only touch this org's rows. This is the SINGLE place tenancy is
 * applied — entry points (server actions, job handlers, MCP tools) wrap their work
 * in `withOrg`, so individual queries don't each need a `where organizationId=…`.
 * Writes use read-committed isolation; stronger isolation is for read-only
 * snapshots.
 */
export async function withOrg<T>(
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
  transactionConfig?: TenantTransactionConfig,
  // An already acquired client from the application pool lets a caller bind
  // its external lock and cancellation deadline to the entire transaction.
  connection?: PoolClient,
): Promise<T> {
  // Last-line runtime defense: every tenant transaction verifies both the DB
  // role and the database's deployment marker before setting the org GUC.
  const database = connection ? drizzle(connection, { schema }) : db;
  await assertNonSuperuserRole(database);
  const root: CommitFrame = { callbacks: [] };
  const result = await database.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('app.current_org', ${organizationId}, true)`);
      adopt(tx, root);
      try {
        return await fn(tx);
      } finally {
        frames.delete(tx);
      }
    },
    transactionConfig,
  );
  // Reached only if the transaction committed: a rollback, or a COMMIT the
  // database refuses (a deferred constraint, a serialization failure), throws
  // past here and the callbacks are never run.
  for (const callback of root.callbacks) settle(callback);
  return result;
}

/**
 * Run `callback` once the surrounding `withOrg` transaction has COMMITTED, and
 * never if it rolls back or its COMMIT fails. For effects that must describe
 * something that happened, not something that was attempted: a usage-data event
 * emitted from inside a transaction would otherwise be sent for work a later
 * statement then undid. The callback may be async; a throw or a rejection is
 * swallowed. Registered inside a savepoint (a nested `tx.transaction`), it
 * waits for the OUTER commit, and is dropped if that savepoint rolls back.
 * Handed a transaction this module did not open (a test's own), it runs at
 * once, because waiting for a commit that nobody here will announce would drop
 * the effect.
 */
export function afterCommit(tx: Tx, callback: AfterCommitCallback): void {
  const frame = frames.get(tx);
  if (!frame) {
    settle(callback);
    return;
  }
  frame.callbacks.push(callback);
}
