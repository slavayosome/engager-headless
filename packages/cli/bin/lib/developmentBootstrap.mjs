import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { activateDevelopmentEnvironment } from "./developmentProfile.mjs";

// First dependency of every executable entry. The artifact marker, rather
// than an inherited flag, selects isolation before runtime modules load.
const resources = fileURLToPath(new URL("../../../", import.meta.url));
const plist = path.join(resources, "../Info.plist");
const development = existsSync(plist) && /<key>CFBundleIdentifier<\/key>\s*<string>com\.engager\.menubar\.dev<\/string>/.test(readFileSync(plist, "utf8"));
if (development || existsSync(new URL("../../../development-profile.json", import.meta.url))) {
  if (!development) throw new Error("development_bundle_identity_required");
  activateDevelopmentEnvironment(resources);
}
