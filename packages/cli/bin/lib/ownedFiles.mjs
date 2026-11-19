import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function noSymlinks(file) {
  let at = path.resolve(file);
  while (true) {
    const systemAlias = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(at);
    if (!systemAlias && existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error("ownership_symlink_refused");
    const parent = path.dirname(at);
    if (parent === at) break;
    at = parent;
  }
}
export function atomicWrite(file, content, mode = 0o600) {
  noSymlinks(file);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, { mode, flag: "wx" });
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(path.dirname(file), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function readJson(file, fallback) {
  noSymlinks(file);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}
export function inventory(root, prefix = "") {
  noSymlinks(root);
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = path.posix.join(prefix, entry.name);
    const file = path.join(root, name);
    if (entry.isSymbolicLink()) throw new Error("artifact_symlink_refused");
    if (entry.isDirectory()) return inventory(root, name);
    if (!entry.isFile()) throw new Error("artifact_special_file_refused");
    const bytes = readFileSync(file);
    return [{ path: name, sha256: hash(bytes), bytes: bytes.length, mode: lstatSync(file).mode & 0o777 }];
  });
}
