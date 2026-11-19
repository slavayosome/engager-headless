/** Navigation only; returning from Stripe never proves payment. */
export function validAppBillingReturn(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      Number(url.port) >= 1024 && Number(url.port) <= 65535 && !url.username && !url.password &&
      url.pathname === "/api/license/billing/callback" && !url.search && !url.hash && url.href === value;
  } catch { return false; }
}
