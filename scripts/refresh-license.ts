// Explicit cloud-control credential refresh; never called by a free background tick.
import { refreshCloudCredentials } from "@engager/core/entitlements/licenseClient";

const pathIndex = process.argv.indexOf("--path");
const path = pathIndex >= 0 ? process.argv[pathIndex + 1] : undefined;
if (!path || !(await refreshCloudCredentials({ path }))) {
  console.error(
    "engager cloud: could not refresh sign-in credentials; retry, or run `engager login` if the sign-in was revoked.",
  );
  process.exitCode = 1;
}
