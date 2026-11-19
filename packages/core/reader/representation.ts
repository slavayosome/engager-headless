/**
 * The agent reader's page, as the server reads it back.
 *
 * The sidecar hands over a page as words and anchors
 * (`python/engager_browser_use/agent_page.py`): `⟦item URN⟧ … ⟦/item⟧` around
 * an element keyed by a LinkedIn urn — a comment row's saying `kind=comment`,
 * or `kind=reply parent=URN` with the comment the page says it answers —
 * `⟦body⟧ … ⟦/body⟧` around a comment's own words, `⟦profile URL⟧` where a
 * link names a member or a company, `⟦thread ID⟧` where one names a
 * conversation, and `⟦button …⟧` / `⟦aria …⟧` for labels. The page's own words
 * cannot carry the brackets, so an anchor here is the page's structure and
 * never its text.
 *
 * This module is the one reading of that text the verification trusts: which
 * items the page holds, in what order, which comment each reply answers,
 * which profiles each links, and what each says — its body apart from its
 * controls. A model answer is checked against what it returns, never against
 * the model's own account of the page.
 */

export const ANCHOR_OPEN = "⟦";
export const ANCHOR_CLOSE = "⟧";

const ITEM_LINE =
  /^⟦item ([^⟦⟧\s]+)(?: kind=(comment|reply)(?: parent=([^⟦⟧\s]+))?)?⟧$/;
const ITEM_END = `${ANCHOR_OPEN}/item${ANCHOR_CLOSE}`;
const MARKER = /⟦(profile|thread|button|aria|body|\/body)(?: ([^⟦⟧]*))?⟧/g;
const PROFILE_PATH = /^\/(in|company)\/([A-Za-z0-9_%.-]+)\/?/;

/** One element the page keys by a LinkedIn urn: a comment row, a message. */
export type PageItem = {
  urn: string;
  /** Where it opens on the page, counting items from 0. */
  order: number;
  /** A comment row's kind, as the page lays it out; null for any other item. */
  kind: "comment" | "reply" | null;
  /** The comment a reply answers, as the page says — never the model. */
  parent: string | null;
  /** Its words — nested items' included — with no anchor in them,
   *  whitespace collapsed. */
  words: string;
  /** A comment's own words, inside its `⟦body⟧`: someone's text, which can
   *  say anything. */
  body: string;
  /** Everything it says itself outside its body — its controls' words and
   *  labels, its author, its time — and nothing a nested item says: where a
   *  count it shows stands. */
  controls: string;
  /** The profiles it links, as {@link profileKey}s. */
  profiles: ReadonlySet<string>;
  /** The profiles it links itself outside its body — its author's, never a
   *  person its words mention. */
  authors: ReadonlySet<string>;
};

export type ParsedPage = {
  items: readonly PageItem[];
  /** Every profile the page links, as {@link profileKey}s. */
  profiles: ReadonlySet<string>;
  /** Every conversation the page links. */
  threads: ReadonlySet<string>;
  /** The whole page's words, as {@link PageItem.words}. */
  words: string;
};

/** Whitespace collapsed, Unicode composed: how page words and an answer's
 *  words are compared. */
export function normalizeWords(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * A profile as the verification compares it — `in/<slug>` or
 * `company/<slug>`, the slug lowercased as the sidecar's own key is — from a
 * profile URL, its path, or a bare member slug. Null for anything else.
 */
export function profileKey(value: string): string | null {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_%.-]+$/.test(trimmed)) return `in/${trimmed.toLowerCase()}`;
  let path: string;
  try {
    const url = new URL(trimmed, "https://www.linkedin.com");
    if (url.hostname !== "www.linkedin.com" && url.hostname !== "linkedin.com") return null;
    path = url.pathname;
  } catch {
    return null;
  }
  const match = PROFILE_PATH.exec(path);
  return match ? `${match[1]}/${match[2]!.toLowerCase()}` : null;
}

/** The slug a key names — what every other read stores as the person's id. */
export function profileSlug(key: string): string {
  return key.slice(key.indexOf("/") + 1);
}

/** The canonical URL a key names. */
export function profileUrl(key: string): string {
  return `https://www.linkedin.com/${key}/`;
}

type Building = {
  urn: string;
  order: number;
  kind: PageItem["kind"];
  parent: string | null;
  words: string[];
  body: string[];
  controls: string[];
  profiles: Set<string>;
  authors: Set<string>;
};

/** Read the anchors and words back out of an agent page's text. */
export function parsePage(text: string): ParsedPage {
  const items: Building[] = [];
  const open: Building[] = [];
  const profiles = new Set<string>();
  const threads = new Set<string>();
  const words: string[] = [];
  let inBody = false;
  for (const line of text.split("\n")) {
    const item = ITEM_LINE.exec(line);
    if (item) {
      const building: Building = {
        urn: item[1]!,
        order: items.length,
        kind: (item[2] as PageItem["kind"] | undefined) ?? null,
        parent: item[3] ?? null,
        words: [],
        body: [],
        controls: [],
        profiles: new Set(),
        authors: new Set(),
      };
      items.push(building);
      open.push(building);
      continue;
    }
    if (line === ITEM_END) {
      open.pop();
      continue;
    }
    // Words go to every item open around them; what is said outside a body
    // belongs to the innermost one's controls alone.
    const innermost = open.at(-1);
    const say = (chunk: string) => {
      const plain = normalizeWords(chunk);
      if (!plain) return;
      words.push(plain);
      for (const building of open) building.words.push(plain);
      innermost?.[inBody ? "body" : "controls"].push(plain);
    };
    let at = 0;
    for (const marker of line.matchAll(MARKER)) {
      say(line.slice(at, marker.index));
      at = marker.index + marker[0].length;
      const [, kind, value = ""] = marker;
      if (kind === "body" || kind === "/body") {
        inBody = kind === "body";
      } else if (kind === "profile") {
        const key = profileKey(value);
        if (key === null) continue;
        profiles.add(key);
        for (const building of open) building.profiles.add(key);
        if (!inBody) innermost?.authors.add(key);
      } else if (kind === "thread") {
        threads.add(value);
      } else if (!inBody) {
        innermost?.controls.push(value);
      }
    }
    say(line.slice(at));
  }
  return {
    items: items.map((building) => ({
      urn: building.urn,
      order: building.order,
      kind: building.kind,
      parent: building.parent,
      words: building.words.join(" "),
      body: building.body.join(" "),
      controls: building.controls.join(" "),
      profiles: building.profiles,
      authors: building.authors,
    })),
    profiles,
    threads,
    words: words.join(" "),
  };
}

/** Whether `needle` stands in `haystack` as the page says it: whitespace
 *  collapsed on both sides, and not empty. */
export function saysWords(haystack: string, needle: string): boolean {
  const words = normalizeWords(needle);
  return words.length > 0 && normalizeWords(haystack).includes(words);
}

/** Whether the number stands in `shown` on its own — `1`, or `1,204` — and
 *  not inside a longer one. Zero is the absence of a count and needs no
 *  evidence. */
export function showsCount(shown: string, count: number): boolean {
  if (count === 0) return true;
  return [String(count), count.toLocaleString("en-US")].some((form) =>
    new RegExp(`(^|[^0-9,.])${form.replace(/[.,]/g, "\\$&")}($|[^0-9,.])`).test(shown),
  );
}

/** The compose view's segment: the messaging page with no conversation open. */
const COMPOSE_SEGMENT = "new";

/** The conversation a messaging address opens, or null — the compose view's
 *  among them, which opens none. */
export function threadIdOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = /^\/messaging\/thread\/([^/]+)\/?$/.exec(parsed.pathname);
    const threadId = match ? decodeURIComponent(match[1]!) : null;
    return threadId === COMPOSE_SEGMENT ? null : threadId;
  } catch {
    return null;
  }
}
