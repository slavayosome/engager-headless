import type { DiscoveredPost } from "@engager/database/schema";
import { DEFAULT_NETWORK, networkFor } from "../network/registry";

/**
 * External assets a candidate post points at — the article behind a share
 * card, links pasted into the post text. Surfaced so the OWNER'S agent can
 * fetch the asset itself (WebFetch) before judging fit or writing an angle:
 * a link-post's substance usually lives in the link, not the teaser text.
 * The server never fetches — agent-led judgment stays agent-led, and no
 * server-side request is ever made to an untrusted URL.
 */
export type ExternalLink = {
  url: string;
  title: string | null;
  /** article = the share card's asset; text = a URL in the post body. */
  source: "article" | "text";
};

const MAX_LINKS = 3;
const URL_PATTERN = /https?:\/\/[^\s<>()\[\]{}"']+/g;
/** Trailing punctuation that belongs to the sentence, not the URL. */
const TRAILING = /[.,;:!?…]+$/;

function normalize(raw: string): string | null {
  const trimmed = raw.replace(TRAILING, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The network's own URLs are the post's chrome, not an external asset — except
 *  its shortener, which is how it points OUTWARD. Which hosts those are is a
 *  fact about the network, so `network/registry.ts` is what holds it. */
function isExternal(url: string): boolean {
  const { hosts } = networkFor(DEFAULT_NETWORK);
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (hosts.isShortener(host)) return true;
    return !hosts.isOwn(host);
  } catch {
    return false;
  }
}

type MediaShape = {
  article?: { url?: unknown; title?: unknown } | null;
  links?: unknown;
};

export function extractExternalLinks(
  post: Pick<DiscoveredPost, "contentText" | "media">,
): ExternalLink[] {
  const found: ExternalLink[] = [];
  const seen = new Set<string>();
  const push = (
    raw: unknown,
    source: ExternalLink["source"],
    title: unknown = null,
  ) => {
    if (typeof raw !== "string") return;
    const url = normalize(raw);
    if (!url || !isExternal(url) || seen.has(url)) return;
    seen.add(url);
    found.push({
      url,
      title: typeof title === "string" && title.trim() ? title.trim() : null,
      source,
    });
  };

  // Sidecar-captured media: the share card's article + anchors in the body.
  const media = (post.media ?? null) as MediaShape | null;
  if (media && typeof media === "object") {
    if (media.article && typeof media.article === "object") {
      push(media.article.url, "article", media.article.title);
    }
    if (Array.isArray(media.links)) {
      for (const link of media.links) push(link, "text");
    }
  }

  // URLs pasted into the visible post text.
  for (const match of (post.contentText ?? "").match(URL_PATTERN) ?? []) {
    push(match, "text");
  }

  return found.slice(0, MAX_LINKS);
}
