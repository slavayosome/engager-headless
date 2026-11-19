import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { prepareDevelopmentDirectory } from "./developmentProfile.mjs";
import { browserExecutablePath, browserManifestForArch } from "./browserManifest.mjs";

export function developmentBrowserLaunch(raw, ownerHome = userInfo().homedir) {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("development_browser_web_url_required");
  // Account sign-in starts at the Dev authority, then redirects to Google.
  // Reuse the owner's browser for passkeys; the callback still belongs to Dev.
  if (url.origin === "https://engager-cloud-dev.vercel.app" &&
      url.pathname === "/api/mac/google/authorize" && !url.username && !url.password) {
    return { profile: null, executable: "/usr/bin/open", args: [url.href] };
  }
  const profile = path.join(ownerHome, ".engager-dev/home/.engager/auth-browser");
  const entry = browserManifestForArch();
  if (!entry) throw new Error("development_browser_unsupported_architecture");
  return {
    profile,
    executable: browserExecutablePath(path.dirname(profile), entry),
    args: [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
      "--use-mock-keychain", "--disable-features=DialMediaRouteProvider", "--new-window", url.href],
  };
}

export function developmentAgentBrowserLaunch(raw) {
  const url = new URL(raw);
  const paths = {
    "claude.com": ["/cai/oauth/authorize"],
    "claude.ai": ["/oauth/authorize", "/login"],
    "platform.claude.com": ["/oauth/authorize", "/login"],
    "console.anthropic.com": ["/oauth/authorize", "/login"],
    "auth.openai.com": ["/codex/device", "/oauth/authorize"],
  };
  if (url.protocol !== "https:" || url.username || url.password ||
      !paths[url.hostname]?.includes(url.pathname) ||
      (url.port && url.port !== "443")) throw new Error("development_agent_auth_url_required");
  return { executable: "/usr/bin/open", args: [url.href] };
}

export function openDevelopmentAgentBrowser(raw) {
  if (process.env.ENGAGER_DEV_APP !== "1") throw new Error("development_app_required");
  // The owner explicitly chose their default browser for agent sign-in so
  // passkeys work. Agent credentials still land in the private Dev home.
  const launch = developmentAgentBrowserLaunch(raw);
  const result = spawnSync(launch.executable, launch.args, { stdio: "ignore", env: process.env });
  if (result.status !== 0) throw new Error("development_agent_browser_open_failed");
}

export function openDevelopmentBrowser(raw) {
  if (process.env.ENGAGER_DEV_APP !== "1") throw new Error("development_app_required");
  const launch = developmentBrowserLaunch(raw);
  if (launch.profile === null) {
    const result = spawnSync(launch.executable, launch.args, { stdio: "ignore", env: process.env });
    if (result.status !== 0) throw new Error("development_account_browser_open_failed");
    return;
  }
  prepareDevelopmentDirectory(launch.profile, userInfo().homedir);
  try {
    accessSync(launch.executable, constants.X_OK);
    if (realpathSync(launch.executable) !== launch.executable) throw new Error("redirected_browser");
  } catch {
    throw new Error("development_browser_requires_completed_mac_setup");
  }
  const child = spawn(launch.executable, launch.args, { detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
}
