import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderSkillInstallShell, type SkillInstallClient } from "../../common/skill-installer";

/**
 * Runs the served installer for one skill as `curl | sh` would, every file of
 * it with the bytes of `content`: the `curl` on its PATH copies `content` for
 * whatever the script asks to download. The script and the stand-in live under
 * `root`, so a second call replaces the first's.
 */
export function runServedInstall(root: string, install: { home: string; journal: string; client: SkillInstallClient; skill: string; paths: string[]; content: string }) {
  const bin = path.join(root, "bin"), file = path.join(root, "SKILL.md"), script = path.join(root, "install.sh");
  const sha256 = createHash("sha256").update(install.content).digest("hex"), bytes = Buffer.byteLength(install.content);
  mkdirSync(bin, { recursive: true });
  writeFileSync(file, install.content);
  writeFileSync(path.join(bin, "curl"), '#!/bin/sh\ncp "$TEST_SKILL_FILE" "$4"\n', { mode: 0o755 });
  writeFileSync(script, renderSkillInstallShell({ baseUrl: "https://example.test/skills", client: install.client,
    skills: [{ name: install.skill, files: install.paths.map((name) => ({ path: name, sha256, bytes })) }] }));
  return spawnSync("sh", [script], { encoding: "utf8", env: { ...process.env, HOME: install.home, ENGAGER_HOME: install.journal,
    PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_SKILL_FILE: file } });
}
