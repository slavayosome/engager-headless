// The build-time version constant: esbuild/Next `define` textually replaces
// __ENGAGER_VERSION__ at bundle time, so every packaged build carries the
// literal and never reaches the file read below. The read is a checkout-only
// fallback for running straight from source (vitest, tsx, `npm run up`),
// where no define has run.
import { readFileSync } from "node:fs";

declare const __ENGAGER_VERSION__: string;

export function productVersion(): string {
  if (typeof __ENGAGER_VERSION__ !== "undefined") return __ENGAGER_VERSION__;
  return readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();
}
