import { sql } from "drizzle-orm";
import { Client } from "pg";
import { db as baseDb } from "./client";
import { pgConnectionSecurityConfig } from "./poolConfig";

/**
 * Which processes of this install can be executing queue work right now, as a
 * fact the processes themselves hold rather than one a clock implies.
 *
 * Every local executor — the standing agent's `runLoop` and every drain an
 * agent session spawns — holds this advisory lock SHARED on a connection of its
 * own, from before it claims anything until it stops. Postgres drops a
 * session's advisory locks when its connection ends, and a process that exits,
 * crashes or is killed takes its connection with it, so a granted lock is a
 * live process and a dead process holds none. The install's one database is
 * the scope: two installs never share it.
 *
 * Not `runtime_heartbeats`: its `runtimeId` is the installation's execution id,
 * shared by every process at the install, so a beat cannot say WHICH process is
 * alive, and a drain does not beat at all. Not a file lock: Node has no flock,
 * and the database already outlives every executor on the Mac.
 */
const EXECUTOR_LOCK = { classId: 0x456e6761, objId: 1 } as const;

/** How soon a held lock whose connection dropped is taken again. */
const RETAKE_MS = 5_000;

export type ExecutorLock = {
  /** The backend holding this process's lock, or null while it is not held. */
  backendPid(): number | null;
  release(): Promise<void>;
};

/**
 * Take this process's share of the executor lock, on a connection the pool
 * never lends out. Throws when it cannot be taken: a process that cannot show
 * itself alive must not claim work another process may release. A connection
 * lost after that is taken again in the background.
 */
export async function holdExecutorLock(): Promise<ExecutorLock> {
  let client: Client | null = null;
  let pid: number | null = null;
  let released = false;
  const take = async () => {
    const next = new Client(pgConnectionSecurityConfig());
    // An idle connection's error is followed by its `end`, which retakes.
    next.on("error", () => {});
    await next.connect();
    try {
      await next.query("select pg_advisory_lock_shared($1, $2)", [EXECUTOR_LOCK.classId, EXECUTOR_LOCK.objId]);
      const { rows } = await next.query<{ pid: number }>("select pg_backend_pid() as pid");
      pid = rows[0]?.pid ?? null;
    } catch (error) {
      await next.end().catch(() => {});
      throw error;
    }
    client = next;
    next.once("end", () => {
      if (client !== next) return;
      client = null;
      pid = null;
      if (!released) setTimeout(retake, RETAKE_MS).unref?.();
    });
  };
  const retake = () => {
    if (released || client) return;
    take().catch(() => setTimeout(retake, RETAKE_MS).unref?.());
  };
  await take();
  return {
    backendPid: () => pid,
    release: async () => {
      released = true;
      const held = client;
      client = null;
      pid = null;
      await held?.end().catch(() => {});
    },
  };
}

/**
 * Whether any process of this install other than the one holding `own` holds
 * the executor lock now — and so may be running work. True too when `own` is
 * not held at this moment: a process that cannot see itself cannot vouch that
 * the others it sees are all there is.
 */
export async function anotherExecutorAlive(
  own: ExecutorLock,
  db: typeof baseDb = baseDb,
): Promise<boolean> {
  const pid = own.backendPid();
  if (pid === null) return true;
  const { rows } = await db.execute<{ alive: boolean }>(sql`
    select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and granted
        and database = (select oid from pg_database where datname = current_database())
        and classid = ${EXECUTOR_LOCK.classId}::oid and objid = ${EXECUTOR_LOCK.objId}::oid and objsubid = 2
        and pid <> ${pid}
    ) as alive`);
  return rows[0]?.alive !== false;
}
