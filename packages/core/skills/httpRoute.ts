import {
  renderSkillInstallShell,
  type SkillInstallClient,
} from "@engager/common/skill-installer";
import { listSkills, readSkillFileBytes } from "./registry";

/**
 * Public, unauthenticated HTTP mirror of the SAME release's `skills/` tree that
 * `list_skills` reads, plus a one-command installer generated from it.
 *
 * Why this lives on the MCP host and not the dashboard: `registry.ts` reads the
 * MCP release's own disk, so the manifest the installer embeds, the bytes it
 * downloads, and the version `list_skills` reports are one atomic fact. The
 * dashboard's `public/skills/` tree is a separately deployed Vercel artifact that
 * routinely lags by several versions; an installer pointed there reports one
 * version and installs another, which turns each skill's "versions differ →
 * refresh" rule into an endless loop. Do not add the dashboard as a second source.
 *
 * Why unauthenticated: skill content is static and non-tenant, and the identical
 * tree has been served anonymously from the dashboard for months. This adds no
 * disclosure. Adding auth here would break `curl … | sh`, which is the entire
 * point of the route. The runner-profile narrowing in `mcp/tools/skills.ts` is an
 * MCP-surface control, not a secrecy control, and is unaffected.
 */
export type SkillHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

const SKILLS_PREFIX = "/skills/";
const INSTALL_PATH = "/skills/install.sh";
/** Rejects percent-encoding outright, so `%2F` and `%2e%2e` can never decode into a path. */
const SAFE_REST = /^[A-Za-z0-9._/-]+$/;

const INSTALL_CLIENTS: readonly SkillInstallClient[] = ["claude", "codex"];

function isInstallClient(value: string): value is SkillInstallClient {
  return (INSTALL_CLIENTS as readonly string[]).includes(value);
}

function contentTypeFor(relPath: string): string {
  if (relPath.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (relPath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function textResponse(
  status: number,
  contentType: string,
  text: string,
  extra: Record<string, string> = {},
): SkillHttpResponse {
  const body = Buffer.from(text, "utf8");
  return {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      ...extra,
    },
    body,
  };
}

function notFound(): SkillHttpResponse {
  return textResponse(404, "text/plain; charset=utf-8", "not found\n", {
    "cache-control": "no-store",
  });
}

function renderInstallScript(
  origin: string,
  client: SkillInstallClient,
): SkillHttpResponse {
  const skills = listSkills().map((skill) => ({
    name: skill.name,
    files: skill.files,
  }));
  if (skills.length === 0) {
    return textResponse(
      503,
      "text/plain; charset=utf-8",
      "skills are temporarily unavailable — retry shortly\n",
      { "cache-control": "no-store" },
    );
  }
  // Embedding the manifest (rather than having the script curl it back) pins the
  // checksums to this exact release: a deploy mid-install trips the per-file
  // sha256/byte check and the installer rolls back instead of mixing versions.
  const script = renderSkillInstallShell({
    baseUrl: `${origin}/skills`,
    client,
    clientOverridable: true,
    skills,
  });
  return textResponse(200, "text/plain; charset=utf-8", script, {
    // The body embeds a release-pinned manifest; it must never outlive a deploy.
    "cache-control": "no-store",
  });
}

function serveSkillFile(
  rest: string,
  ifNoneMatch: string | undefined,
): SkillHttpResponse {
  if (!SAFE_REST.test(rest)) return notFound();
  if (rest.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return notFound();
  }
  const slash = rest.indexOf("/");
  if (slash <= 0) return notFound();
  const name = rest.slice(0, slash);
  const relPath = rest.slice(slash + 1);

  const entry = listSkills()
    .find((skill) => skill.name === name)
    ?.files.find((file) => file.path === relPath);
  if (!entry) return notFound();

  // Membership + resolved-prefix checks live in readSkillFileBytes, the same two
  // guards get_skill_file has always used.
  const bytes = readSkillFileBytes(name, relPath);
  if (!bytes) return notFound();

  const etag = `"${entry.sha256}"`;
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(relPath),
    "content-length": String(bytes.byteLength),
    etag,
    // Always revalidate: a 304 is free and a stale skill file is not.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  };
  if (ifNoneMatch === etag) {
    return { status: 304, headers, body: Buffer.alloc(0) };
  }
  return { status: 200, headers, body: bytes };
}

/**
 * Route a request against the skills mirror. Returns null when the request is
 * not a skills request, so the caller keeps its own routing and 404 behavior.
 *
 * `origin` is the public origin the installer must download from — pass the
 * server's own (`mcpPublicOrigin`), never the dashboard's.
 */
export function handleSkillHttpRequest(input: {
  method: string;
  url: string;
  origin: string;
  ifNoneMatch?: string | undefined;
}): SkillHttpResponse | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  const [rawPath = "", rawQuery] = input.url.split("?");
  if (rawPath !== INSTALL_PATH && !rawPath.startsWith(SKILLS_PREFIX)) {
    return null;
  }

  if (rawPath === INSTALL_PATH) {
    const requested = new URLSearchParams(rawQuery ?? "").get("client");
    if (requested !== null && !isInstallClient(requested)) {
      return textResponse(
        400,
        "text/plain; charset=utf-8",
        `unsupported client: expected one of ${INSTALL_CLIENTS.join(", ")}\n`,
        { "cache-control": "no-store" },
      );
    }
    return renderInstallScript(input.origin, requested ?? "claude");
  }

  return serveSkillFile(rawPath.slice(SKILLS_PREFIX.length), input.ifNoneMatch);
}
