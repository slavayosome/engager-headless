/** Artifact property, never a runtime switch that could redirect a paid app. */
declare const __ENGAGER_DEV_BUILD__: boolean;

export function developmentBuild(): boolean {
  return typeof __ENGAGER_DEV_BUILD__ !== "undefined" && __ENGAGER_DEV_BUILD__;
}
