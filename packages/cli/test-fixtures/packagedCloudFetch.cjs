/** Offline transport for the disposable packaged-server acceptance fixture. */
function createPackagedCloudFetch(originalFetch) {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (["https://cloud.getengager.com", "https://engager-cloud-dev.vercel.app"].includes(url.origin)
        && url.pathname === "/api/license/access") {
      const body = JSON.parse(init.body);
      if (body.refreshToken !== "t".repeat(43)) throw new Error("unexpected fixture credential");
      return Response.json({ status: "allowed", email: "packaged@example.test" });
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("Unexpected external request in packaged test: " + url.origin);
    }
    return originalFetch(input, init);
  };
}
module.exports = { createPackagedCloudFetch };
