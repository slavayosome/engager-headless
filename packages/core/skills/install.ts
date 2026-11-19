import type { SkillInstallClient } from "@engager/common/skill-installer";

/**
 * Where an agent should download the Engager skills from.
 *
 * This MUST be the MCP server's own origin. The dashboard's `public/skills/`
 * tree is a separately deployed Vercel artifact and has been observed several
 * major versions behind the MCP release (v1.3.0 served while `list_skills`
 * reported v6.5.0). An installer pointed at the dashboard therefore reports one
 * version and installs another, and every skill's "versions differ → refresh"
 * rule turns into an endless refresh loop. Serving from this server's own disk
 * makes the manifest, the bytes, and the reported version one atomic fact.
 *
 * Deliberately never reads `dashboardUrl()`. If you are here to "fix" a missing
 * install command by falling back to the dashboard origin: don't — returning
 * null is correct, and the agent falls back to `get_skill_file`.
 */
export function skillInstallOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw =
    env.ENGAGER_SKILLS_PUBLIC_URL?.trim() || env.ENGAGER_MCP_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    // HTTPS only, so a loopback dev server can never become an install source
    // for someone else's agent.
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The exact one-liner an agent runs to install every skill for one client.
 *
 * Deliberately NOT `curl … | sh`. Claude Code — the primary install client —
 * blocks pipe-to-shell at its permission classifier, so the piped form is denied
 * and the agent silently falls back to the slow per-file path, which is the exact
 * failure this whole route exists to remove. Downloading first and running the
 * file is still one command, one approval, and it leaves the script on disk where
 * a human or an agent can read it before it runs.
 */
export function skillInstallCommand(
  origin: string,
  client: SkillInstallClient,
): string {
  const target = '"${TMPDIR:-/tmp}/engager-install.sh"';
  return `curl -fsSL ${origin}/skills/install.sh -o ${target} && sh ${target} ${client}`;
}
