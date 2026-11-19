import { config } from "../config";

const FIRECRAWL_SCRAPE = "https://api.firecrawl.dev/v1/scrape";

/**
 * Scrape a URL via Firecrawl. Returns the site's own METADATA (og:title / og:description /
 * og:site_name / <title> / meta description — the canonical self-description, essentially
 * free) prepended to the cleaned main-content markdown, so the extractor anchors the name +
 * tagline on the metadata rather than a stray body detail. When the body is thin (JS-heavy
 * page / "missing homepage"), the metadata block alone is still returned. Null when
 * FIRECRAWL_API_KEY is unconfigured or the request fails — callers fall back to a direct
 * fetch. Firecrawl runs the fetch on ITS infra (renders JS, strips boilerplate, and can't
 * reach our internal network — sidestepping the SSRF surface of a direct fetch).
 */
export async function firecrawlScrape(url: string): Promise<string | null> {
  const key = config.firecrawlKey();
  if (!key) return null;
  try {
    const res = await fetch(FIRECRAWL_SCRAPE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      success?: boolean;
      data?: {
        markdown?: string;
        metadata?: {
          title?: string;
          description?: string;
          ogTitle?: string;
          ogDescription?: string;
          ogSiteName?: string;
        };
      };
    };
    const md = json?.data?.markdown?.trim() ?? "";
    const m = json?.data?.metadata ?? {};
    const siteName = (m.ogSiteName ?? "").trim();
    const title = (m.ogTitle ?? m.title ?? "").trim();
    const desc = (m.ogDescription ?? m.description ?? "").trim();
    const metaLines = [
      siteName && `Site name: ${siteName}`,
      title && `Title: ${title}`,
      desc && `Description: ${desc}`,
    ].filter(Boolean);
    // Metadata (the site's own name/pitch) FIRST, then the page body — so both a rich page
    // and a thin one yield a good name + tagline.
    const combined = [
      metaLines.length ? `SITE METADATA (the site's own description):\n${metaLines.join("\n")}` : "",
      md,
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    return combined.length >= 40 ? combined.slice(0, 12_000) : null;
  } catch {
    return null;
  }
}
