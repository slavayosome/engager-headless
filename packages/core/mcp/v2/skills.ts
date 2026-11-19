import { z } from "zod";
import { skillInstallCommand, skillInstallOrigin } from "../../skills/install";
import { listSkills, readSkillFile } from "../../skills/registry";
import { errorResult, jsonResult } from "../tools/util";
import { defineTool, type V2Tool } from "./define";

/**
 * Skill distribution lets an authorized agent fetch the Engager skills and
 * install them locally. Prefer the one-command installer: fetching a skill one
 * `get_skill_file` at a time pulls every byte through the agent's context and
 * back out through a write per file.
 */
export const skillTools: readonly V2Tool[] = [
  defineTool({
    name: "list_skills",
    kind: "read",
    description:
      "The Engager skills this server ships: version and file hashes each, plus an `install` command when it can serve them. Ask the owner first, run the command once, and never re-run a denied one; then read engager-setup/SKILL.md.",
    handler: async () => {
      const installOrigin = skillInstallOrigin();
      return jsonResult({
        skills: listSkills(),
        ...(installOrigin
          ? {
              install: {
                method: "shell",
                command: skillInstallCommand(installOrigin, "claude"),
                clients: {
                  claude: skillInstallCommand(installOrigin, "claude"),
                  codex: skillInstallCommand(installOrigin, "codex"),
                },
                installsTo: {
                  claude: "~/.claude/skills",
                  codex: "~/.agents/skills",
                },
                requires: ["curl", "sh", "node"],
                verifies:
                  "sha256 + byte count per file against a manifest pinned to this exact server release; a failed check rolls the whole install back",
                note: "Ask the user first with your host's native question UI — install/upgrade the skills now, or stream them instead? On yes, run this ONCE in a shell rather than calling get_skill_file per file. A host permission denial is expected, not an error: never re-run it; offer the user the exact command to run themselves and continue via get_skill_file.",
              },
            }
          : {}),
      });
    },
  }),
  defineTool({
    name: "get_skill_file",
    kind: "read",
    description:
      "One skill file by skill name and the manifest path list_skills gives. Use it when there is no install command, the owner declined it, or the host has no shell. Write it verbatim to <skills dir>/<skill>/<path>, or just read it.",
    input: z.object({ skill: z.string().min(1), path: z.string().min(1) }),
    handler: async (_call, { skill, path }) => {
      const content = readSkillFile(skill, path);
      return content === null
        ? errorResult(`unknown skill file: ${skill}/${path} (use list_skills for valid paths)`, { code: "not_found", status: 404 })
        : jsonResult({ skill, path, content });
    },
  }),
];
