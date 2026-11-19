/**
 * Best-effort public URL for a LinkedIn post: the driver's captured share_url
 * when present, else the canonical feed permalink built from the URN (works
 * for urn:li:activity/ugcPost URNs). Every agent/user-facing surface that
 * shows a post should carry this link — a draft can't be reviewed against a
 * post you can't open.
 *
 * `NETWORKS.linkedin.postUrl` in `packages/core/network/registry.ts` is what
 * OWNS this shape; a second network's permalink form is a second entry there.
 */
export function linkedinPostUrl(
  url: string | null | undefined,
  postUrn: string,
): string {
  return url || `https://www.linkedin.com/feed/update/${postUrn}`;
}

/** Owner-pasted post links become a canonical identifier before any job or
 * provider read. Never follow redirects or fetch the supplied URL: even a
 * valid LinkedIn URL may carry credentials, tracking or an unrelated path. */
export function postUrnFromUrl(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 2_048) return null;
  const urn = /^urn:li:(activity|ugcPost):([1-9]\d*)$/.exec(text);
  if (urn) return text;
  let url: URL;
  try {
    url = new URL(/^(?:www\.)?linkedin\.com\//i.test(text) ? `https://${text}` : text);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol) ||
    !["linkedin.com", "www.linkedin.com"].includes(url.hostname) || url.username || url.password || url.port) return null;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  const feed = /^\/feed\/update\/(urn:li:(?:activity|ugcPost):[1-9]\d*)\/?$/.exec(path);
  if (feed) return feed[1]!;
  const post = /^\/posts\/[^/]+-activity-([1-9]\d*)-[^/]+\/?$/.exec(path);
  return post ? `urn:li:activity:${post[1]}` : null;
}
