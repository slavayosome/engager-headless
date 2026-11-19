import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

/**
 * Serves the repo's `skills/` directory over MCP (`list_skills` / `get_skill_file`)
 * and over the HTTP mirror in `./httpRoute` so a tenant's agent can self-install
 * the Engager skills. Static, non-tenant content: every transport runs from a
 * full repo checkout (local stdio; the es3 rsync deploy ships `skills/` alongside
 * the server code), so runtime filesystem reads are the versioning story — the
 * manifest, the served bytes, and the installed copy all come from one release
 * and cannot drift from each other.
 *
 * That single-source property is load-bearing, not incidental. The dashboard's
 * `public/skills/` tree is a SEPARATELY deployed Vercel artifact and is routinely
 * several versions behind this one, so an installer pointed there would report one
 * version and install another. Never make it an install source.
 *
 * Security: `readSkillFileBytes` only serves paths that appear in the enumerated
 * manifest (membership check — no traversal possible) and enumeration itself is
 * extension-allowlisted, so nothing outside `skills/<name>/**.{md,mjs}` is ever
 * readable.
 */
export type SkillFileEntry = { path: string; sha256: string; bytes: number };
export type SkillManifest = {
  name: string;
  version: string;
  description: string;
  files: SkillFileEntry[];
};

/** Files an agent needs to run a skill. Tests/configs are deliberately excluded. */
const SERVED_EXTENSIONS = new Set([".md", ".mjs"]);

/**
 * Human-facing docs that pass the extension allowlist but have no runtime value
 * to an agent. This list decides what MCP serves and nothing else.
 */
const SERVED_EXCLUDED_PATHS = new Set(["README.md"]);

/** Only a FOUND root is remembered: a miss is probed again on the next call,
 *  so skills that appear after the process started are served instead of
 *  answering "unknown skill" until a restart. */
let cachedRoot: string | null = null;

/** A directory qualifies as the skills root only if it holds actual skills —
 *  this module's own `packages/core/skills/` source dir must not match. */
function isSkillsDir(candidate: string): boolean {
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return false;
  return readdirSync(candidate, { withFileTypes: true }).some(
    (e) => e.isDirectory() && existsSync(path.join(candidate, e.name, "SKILL.md")),
  );
}

/**
 * Where the served skills live. `ENGAGER_SKILLS_DIR` is the answer whenever it
 * is set — the process that starts a server names its own install's `skills/`
 * — and a set value holding no skills is a miss, never a cue to serve some
 * other tree. Without it, walk up from this module until a `skills/` appears
 * (a checkout, or an esbuild bundle beside a packaged `skills/`), then try the
 * working directory.
 *
 * The walk is skipped inside the Next server: webpack replaces
 * `import.meta.url` with the BUILD machine's path, which exists on no
 * customer's Mac. `NEXT_RUNTIME` is a build-time constant in that bundle, so
 * the branch — and the literal with it — is dropped from the build.
 */
export function skillsRoot(): string | null {
  cachedRoot ??= probeSkillsRoot();
  return cachedRoot;
}

function probeSkillsRoot(): string | null {
  const explicit = process.env.ENGAGER_SKILLS_DIR;
  if (explicit) return isSkillsDir(explicit) ? explicit : null;
  if (!process.env.NEXT_RUNTIME) {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, "skills");
      if (isSkillsDir(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const cwdCandidate = path.join(process.cwd(), "skills");
  return isSkillsDir(cwdCandidate) ? cwdCandidate : null;
}

/** SKILL.md YAML frontmatter as flat strings (name/description/version). */
function parseFrontmatter(markdown: string): Record<string, string> {
  const data = matter(markdown).data as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" || typeof v === "number") out[k] = String(v);
  }
  return out;
}

function listFilesRecursive(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else if (
      SERVED_EXTENSIONS.has(path.extname(entry.name)) &&
      !SERVED_EXCLUDED_PATHS.has(rel)
    ) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Manifests plus the frontmatter-name → directory-name map they were built from. */
type SkillIndex = { manifests: SkillManifest[]; dirByName: Map<string, string> };

let cachedIndex: SkillIndex | null = null;
let cachedIndexAt = 0;

/**
 * A hosted release is an immutable directory (deploy-es3 unpacks a new release
 * and restarts the unit), so the index can live for the process lifetime there.
 * Local dev re-reads after a short TTL so an edited skill shows up without
 * restarting `npm run mcp`.
 */
const INDEX_TTL_MS = process.env.ENGAGER_RELEASE_SHA
  ? Number.POSITIVE_INFINITY
  : 5_000;

/** Test-only: drop the memo (and the root probe) so a fixture tree is re-read. */
export function resetSkillIndexCache(): void {
  cachedIndex = null;
  cachedIndexAt = 0;
  cachedRoot = null;
}

/**
 * Enumerate every servable skill with per-file hashes, memoized. Skills without
 * a SKILL.md are skipped. Hashing the whole tree used to run once per served
 * file, which cost ~N full walks per install; the HTTP mirror reads the same
 * index, so one walk now serves an entire install.
 */
function skillIndex(): SkillIndex {
  if (cachedIndex && Date.now() - cachedIndexAt < INDEX_TTL_MS) {
    return cachedIndex;
  }
  const root = skillsRoot();
  // A miss is not memoized either: on a release the TTL is infinite, and an
  // empty index cached here would outlive the miss it records.
  if (!root) return { manifests: [], dirByName: new Map() };
  const manifests: SkillManifest[] = [];
  const dirByName = new Map<string, string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillDir = path.join(root, entry.name);
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
    const files = listFilesRecursive(skillDir).map((rel): SkillFileEntry => {
      const buf = readFileSync(path.join(skillDir, rel));
      return {
        path: rel,
        sha256: createHash("sha256").update(buf).digest("hex"),
        bytes: buf.length,
      };
    });
    const name = fm.name ?? entry.name;
    manifests.push({
      name,
      version: fm.version ?? "0.0.0",
      description: fm.description ?? "",
      files,
    });
    dirByName.set(name, entry.name);
  }
  manifests.sort((a, b) => a.name.localeCompare(b.name));
  cachedIndex = { manifests, dirByName };
  cachedIndexAt = Date.now();
  return cachedIndex;
}

/**
 * Every servable skill with per-file hashes, sorted by name. The returned
 * entries are shared with the memo — treat them as read-only.
 */
export function listSkills(): SkillManifest[] {
  return skillIndex().manifests.slice();
}

/**
 * Read one skill file's raw bytes. `relPath` must exactly match a manifest entry
 * for that skill — unknown skills, unlisted paths, and traversal attempts all
 * return null (the tool layer maps that to an error result).
 *
 * Bytes, not text: the HTTP mirror's callers verify sha256 and byte count
 * against the manifest, so nothing may round-trip through a string decode.
 */
export function readSkillFileBytes(name: string, relPath: string): Buffer | null {
  const root = skillsRoot();
  if (!root) return null;
  const index = skillIndex();
  const skill = index.manifests.find((s) => s.name === name);
  if (!skill) return null;
  if (!skill.files.some((f) => f.path === relPath)) return null;
  const dirName = index.dirByName.get(name);
  if (!dirName) return null;
  // The manifest only contains paths enumerated from disk, so joining is safe;
  // resolve + prefix-check anyway as defense in depth.
  const skillDir = path.resolve(root, dirName);
  const abs = path.resolve(skillDir, relPath);
  if (!abs.startsWith(skillDir + path.sep)) return null;
  return readFileSync(abs);
}

/** UTF-8 text for one manifest-listed skill file, or null. See readSkillFileBytes. */
export function readSkillFile(name: string, relPath: string): string | null {
  return readSkillFileBytes(name, relPath)?.toString("utf8") ?? null;
}
