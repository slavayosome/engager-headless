import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Filesystem bakery lock: each contender owns a unique directory for its
 * entire lifetime. Dead-process recovery removes only that unique contender,
 * never a shared lock path which another process could already have acquired.
 * A live holder is never stolen on a timeout. The path lives on local disk.
 *
 * Keyed on a caller-chosen path so the mechanism serves any local resource one
 * process at a time — the licence cache it was written for, and the bundled
 * cluster an interactive server brings up. `busyMessage` is what a caller's
 * own vocabulary calls the timeout, because a refusal reaches an owner as its
 * message and "License refresh busy" would be a lie about a database. */
export async function withPathLock(
  lockPath,
  work,
  { busyMessage = "lock_busy", timeoutMs = 40_000 } = {},
) {
  const directory = `${lockPath}.refresh-locks`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${randomUUID()}`;
  const own = join(directory, id);
  mkdirSync(own, { mode: 0o700 }); // absence of a ticket means "choosing"
  const started = Date.now();
  function peers() {
    const result = [];
    for (const name of readdirSync(directory)) {
      if (!/^\d+-[0-9a-f-]+$/.test(name)) continue;
      const pid = Number(name.split("-")[0]);
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          rmSync(join(directory, name), { recursive: true, force: true });
          continue;
        }
      }
      let ticket = null;
      try {
        const raw = Number(
          readFileSync(join(directory, name, "ticket"), "utf8"),
        );
        if (Number.isSafeInteger(raw) && raw > 0) ticket = raw;
      } catch {
        /* still choosing, or just released */
      }
      result.push({ id: name, ticket });
    }
    return result;
  }
  try {
    const ticket = Math.max(0, ...peers().map((peer) => peer.ticket ?? 0)) + 1;
    writeFileSync(join(own, "ticket.tmp"), String(ticket), { mode: 0o600 });
    renameSync(join(own, "ticket.tmp"), join(own, "ticket"));
    while (
      peers().some(
        (peer) =>
          peer.id !== id &&
          (peer.ticket === null ||
            peer.ticket < ticket ||
            (peer.ticket === ticket && peer.id < id)),
      )
    ) {
      if (Date.now() - started > timeoutMs) throw new Error(busyMessage);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return await work();
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
}
