/** Build-only authority for the isolated app rehearsal. Neither its origin
 * nor its verifying key can be changed by a runtime environment variable. */
export function appBuildDefines(env = process.env) {
  const development = env.ENGAGER_DEV_BUILD === "1";
  const rehearsal = env.ENGAGER_APP_REHEARSAL_BUILD === "1";
  if (development && !rehearsal) throw new Error("Development apps require the rehearsal cloud");
  if (rehearsal && env.ENGAGER_LICENSE_BUILD === "1") {
    throw new Error("A production Mac build cannot use the rehearsal cloud");
  }
  return {
    __ENGAGER_DEV_BUILD__: JSON.stringify(development),
    __ENGAGER_APP_CLOUD_ORIGIN__: JSON.stringify(rehearsal
      ? "https://engager-cloud-dev.vercel.app" : "https://cloud.getengager.com"),
    ...(rehearsal ? {
      // Public half of the dedicated development signer, verified 2026-09-22.
      __ENGAGER_REHEARSAL_LICENSE_PUBLIC_KEY__: JSON.stringify(
        "MCowBQYDK2VwAyEAIIn0LmY492HmPc/VFW0F36xCpMCJkBHv63MWNA8I5EE="),
    } : {}),
  };
}
