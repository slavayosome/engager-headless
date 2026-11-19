import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { syncClientSkills } from "./clientSetup.mjs";
import { hash, inventory, noSymlinks } from "./ownedFiles.mjs";

/** Where the CLIENTS read, not where an installer once wrote: Claude's
 *  `~/.claude/skills` and Codex's `~/.agents/skills`. `CODEX_HOME` selects
 *  Codex's CONFIGURATION directory and never its skills root, so the one
 *  table in `clientSetup` answers for the legacy routes too — otherwise
 *  `engager init` reports skills Codex cannot discover, and `engager
 *  uninstall` orphans what the shell installer of the same release wrote. */
export const LEGACY_CODEX_SKILLS_ROOT = ".codex/skills";
export function legacyClients() {
  return ["claude", "codex"];
}

/** The shipped tree's files, skill by skill: a checkout's `skills/` also
 *  holds the lint test, and only a skill directory is ours to install. */
export function shippedSkillFiles(source) {
  return readdirSync(source)
    .filter((name) => statSync(path.join(source, name)).isDirectory())
    .flatMap((name) => inventory(path.join(source, name)).map((file) => ({ ...file, path: path.posix.join(name, file.path) })));
}

/**
 * Install this release's skills through the SAME journalled custody
 * `engager client setup` uses. A file whose bytes this install did not write
 * is the owner's: it is preserved and reported rather than overwritten, and
 * the whole-directory `rm -rf` per skill this route used before — which took
 * a note the owner had put inside one of our skill directories with it — is
 * gone. On a machine whose skills predate the journal, an unchanged file is
 * adopted and an edited one lands in `conflicts`; deleting it and re-running
 * takes the shipped copy.
 */
export function installLegacySkills({ root, home, source, codexHome, log = console.log }) {
  if (!existsSync(source)) {
    log(`✗ skills tree missing at ${source}`);
    return false;
  }
  const files = shippedSkillFiles(source);
  for (const client of legacyClients(home, codexHome)) {
    // A refused destination (a symlinked skills root, an unreadable journal)
    // is that client's problem alone: the rest of the run, and the other
    // client, still get their skills.
    try {
      const result = syncClientSkills({ root, home, client, source, files, codexHome });
      log(`✓ ${result.installed} skill files installed to ${result.paths.skills}`);
      if (result.conflicts.length > 0) {
        log(`→ kept your edits (${result.conflicts.join(", ")}) — delete one and re-run to take the shipped copy`);
      }
    } catch (error) {
      log(`✗ ${client} skills not installed: ${error.message}`);
    }
  }
  const stale = path.join(home, LEGACY_CODEX_SKILLS_ROOT);
  if (existsSync(stale)) {
    log(`→ an older install wrote skills to ${stale}, which Codex does not read; \`engager uninstall\` removes the unmodified ones`);
  }
  return true;
}

/**
 * The reverse, in the same custody. The journal names what this install
 * wrote; beyond it only a file whose bytes are EXACTLY what this release
 * ships is ours to remove — that is the copy the shell installer or an
 * identical earlier run left, and it is the one case where "unjournalled"
 * and "not the owner's" coincide. Anything edited, older or unrelated stays
 * and is reported, including in the retired `~/.codex/skills` root, which
 * this never removes wholesale.
 */
export function uninstallLegacySkills({ root, home, source, codexHome, log = console.log }) {
  const files = existsSync(source) ? shippedSkillFiles(source) : [];
  for (const client of legacyClients(home, codexHome)) {
    try {
      const journalled = syncClientSkills({ root, home, client, codexHome, remove: true });
      const skills = journalled.paths.skills;
      const shipped = removeUnmodifiedFiles(skills, files);
      log(`✓ ${journalled.removed + shipped.removed} skill files removed from ${skills}`);
      for (const kept of [...journalled.conflicts, ...shipped.kept]) log(`→ kept ${path.join(skills, kept)}`);
    } catch (error) {
      log(`✗ ${client} skills not removed: ${error.message}`);
    }
  }
  const stale = path.join(home, LEGACY_CODEX_SKILLS_ROOT);
  if (!existsSync(stale)) return;
  const leftovers = removeUnmodifiedFiles(stale, files);
  log(`✓ ${leftovers.removed} skill files removed from the retired ${stale}`);
  for (const kept of leftovers.kept) log(`→ kept ${path.join(stale, kept)}`);
}

/** Delete only files under `directory` whose bytes match the shipped copy,
 *  then the directories the whole removal emptied — the journal's files
 *  included, which is why every shipped name's parent is considered. A
 *  symlink, a path that REACHES THROUGH one (the retired root gets the same
 *  custody the current ones get before they are written), a directory a
 *  file's name now points at, and anything the owner changed are all left
 *  alone; `rmdirSync` on a directory that still holds something fails, which
 *  is exactly the refusal wanted, and the skills root itself is never a
 *  candidate. */
function removeUnmodifiedFiles(directory, files) {
  let removed = 0;
  const kept = [], directories = new Set();
  for (const file of files) {
    const dest = path.join(directory, file.path);
    directories.add(path.dirname(file.path));
    if (!existsSync(dest)) continue;
    try { noSymlinks(dest); } catch { kept.push(file.path); continue; }
    if (!lstatSync(dest).isFile() || hash(readFileSync(dest)) !== file.sha256) { kept.push(file.path); continue; }
    rmSync(dest); removed += 1;
  }
  for (const name of [...directories].sort((a, b) => b.length - a.length)) {
    for (let at = name; at !== "."; at = path.dirname(at)) {
      try { rmdirSync(path.join(directory, at)); } catch { break; }
    }
  }
  return { removed, kept };
}
