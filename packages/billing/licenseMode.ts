// No imports. This module is the build-time gate constant: esbuild/Next
// `define` textually replaces __ENGAGER_LICENSE_REQUIRED__ at bundle time, so
// licenseRequired() must read no runtime environment or configuration of any
// kind — no process env vars, no deployment-environment resolution, no file
// reads. See docs/plan phase-15 T-15.1 / INV-18.
declare const __ENGAGER_LICENSE_REQUIRED__: string;

export function licenseRequired(): boolean {
  return (
    typeof __ENGAGER_LICENSE_REQUIRED__ !== "undefined" &&
    __ENGAGER_LICENSE_REQUIRED__ === "true"
  );
}
