import { createHash } from "node:crypto";
import { developmentBuild } from "@engager/common/development";

/**
 * The page a browser lands on when the Mac app's Google sign-in comes back
 * (US-ONB-05, board 3.5). One shell for the dashboard's loopback callback
 * (success, expired) and the cloud's own routes (expired, no account), so a
 * browser tab is never left on a bare line of text. Pure: a status, a few
 * strings and the CSP that fits them. No external script, font or image, and
 * nothing a URL can inject: the only dynamic text is the verified address,
 * escaped, and it appears on the success variant alone.
 */

/** The Mac app's deep link. It brings the window forward and does nothing
 * else, so it carries no path, query or fragment (Info.plist
 * `CFBundleURLTypes`, `OpenEngagerURL.swift`). */
export const OPEN_ENGAGER_URL = developmentBuild() ? "engager-dev://open" : "engager://open";

export const EXPIRED_WORDS = "Sign-in expired. Go back to Engager and try again.";
export const NO_ACCOUNT_WORDS = "No Engager account uses that Google account. Go back to Engager and create one.";

export type AppReturnPage =
  | { kind: "signed_in"; email?: string }
  | { kind: "billing_return" }
  | { kind: "expired" }
  | { kind: "no_account" };

const STATUS: Record<AppReturnPage["kind"], number> = { signed_in: 200, billing_return: 200, expired: 400, no_account: 409 };

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

// The dark token set of packages/ui/src (the cloud and the dashboard are
// dark here), as sRGB: background, foreground, muted, border, primary and the
// destructive pair.
const STYLES = `
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#0a0a0a;color:#fafafa;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:8px;height:56px;padding:0 24px;border-bottom:1px solid #262626}
header span{font-size:16px;font-weight:600;letter-spacing:-.01em}
.mark{width:24px;height:24px;isolation:isolate}
.mark .violet{mix-blend-mode:screen}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;width:100%;max-width:384px;margin:0 auto;padding:24px 24px 96px;text-align:center}
.badge{display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:#14532d;color:#4ade80}
.badge svg{width:24px;height:24px}
h1{margin:0;font-size:20px;line-height:28px;font-weight:500;overflow-wrap:anywhere}
p{margin:0;color:#a1a1a1}
.button{display:inline-flex;align-items:center;justify-content:center;width:100%;height:40px;padding:0 16px;border-radius:8px;background:#fafafa;color:#171717;font-size:14px;font-weight:500;text-decoration:none}
.button:focus-visible{outline:2px solid #737373;outline-offset:2px}
.alert{width:100%;padding:12px 16px;border:1px solid #82181a;border-radius:8px;background:rgba(130,24,26,.25);color:#ff6467}
.alert h1{font-size:14px;line-height:20px;font-weight:500}
`.trim();

const MARK = '<svg class="mark" viewBox="0 4 40 40" aria-hidden="true"><circle cx="14" cy="18" r="14" fill="#e0a63c"/><circle class="violet" cx="26" cy="30" r="14" fill="#7c52e6"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function body(page: AppReturnPage): string {
  switch (page.kind) {
    case "billing_return":
      return `<h1>Returning to Engager…</h1>` +
        `<p>Your payment will be checked in the app.</p>` +
        `<a class="button" href="${OPEN_ENGAGER_URL}">Open Engager</a>`;
    case "signed_in":
      return `<div class="badge">${CHECK}</div>` +
        `<h1>${page.email ? `You&#39;re signed in as ${escapeHtml(page.email)}` : "You&#39;re signed in"}</h1>` +
        `<p>Return to Engager — this tab can close.</p>` +
        `<a class="button" href="${OPEN_ENGAGER_URL}">Open Engager</a>`;
    case "expired":
      return `<div class="alert" role="alert"><h1>${EXPIRED_WORDS}</h1></div>`;
    case "no_account":
      return `<div class="alert" role="alert"><h1>${NO_ACCOUNT_WORDS}</h1></div>`;
  }
}

/** The page as a response. `script` is the one inline script a caller may add
 * (the dashboard's hand-off into an existing browser session); it is allowed
 * by hash, so nothing else can run, and by `connect-src 'self'` for its
 * single same-origin request. */
export function appReturnResponse(page: AppReturnPage, opts: { status?: number; script?: string } = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">` +
    `<title>Engager</title><style>${STYLES}</style></head>` +
    `<body><header>${MARK}<span>Engager</span></header><main>${body(page)}</main>` +
    `${opts.script ? `<script>${opts.script}</script>` : ""}</body></html>`;
  const csp = ["default-src 'none'", `style-src ${sha256(STYLES)}`,
    ...(opts.script ? [`script-src ${sha256(opts.script)}`, "connect-src 'self'"] : []),
    "frame-ancestors 'none'", "base-uri 'none'"].join("; ");
  return new Response(html, {
    status: opts.status ?? STATUS[page.kind],
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "content-security-policy": csp },
  });
}
