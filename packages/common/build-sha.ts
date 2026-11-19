// The commit a packaged build was cut from, baked the same way the product
// version is: esbuild/Next `define` replaces __ENGAGER_BUILD_SHA__ at bundle
// time. Un-baked runs (vitest, tsx, `npm run up` from a checkout) answer
// "unknown" rather than shelling out to git at runtime. Read by telemetry so a
// release can be told from the commit behind it; carries nothing about a person.
declare const __ENGAGER_BUILD_SHA__: string;

export function buildSha(): string {
  const baked = typeof __ENGAGER_BUILD_SHA__ !== "undefined" ? __ENGAGER_BUILD_SHA__ : "";
  return /^[0-9a-f]{7,40}$/i.test(baked) ? baked.toLowerCase() : "unknown";
}
