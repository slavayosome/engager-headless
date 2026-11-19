/** Build-only rehearsal routing. Never accept a runtime destination override
 * for the scoped notification credential, or change an armed desktop build. */
export function checkpointBuildDefines(env = process.env) {
  const raw = env.ENGAGER_CHECKPOINT_REHEARSAL_ORIGIN;
  if (!raw) return {};
  const fail = () => { throw new Error("Rehearsal checkpoint build origin refused"); };
  if (env.ENGAGER_LICENSE_BUILD === "1") fail();
  let url;
  try { url = new URL(raw); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    url.pathname !== "/" || url.search || url.hash ||
    url.origin === "https://cloud.getengager.com" ||
    url.hostname.endsWith(".localhost") || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(url.hostname)) fail();
  return { __ENGAGER_CHECKPOINT_ORIGIN__: JSON.stringify(url.origin) };
}
