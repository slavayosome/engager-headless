import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import type { CapabilitySurface } from "../connector/resolve";
import { OWN_POST_LIMIT, type DriverPost } from "../linkedin/driver";
import { fetchProductSourceCorpus } from "../products/ingest";

/**
 * THE ONE PLACE A SEED'S BYTES COME FROM.
 *
 * `seed_brain {source, scope}` is one verb over four source kinds, and this is
 * the half of it that does I/O: read the account's own posts, crawl a URL,
 * read a file or a folder off the owner's own disk, or take the text the
 * agent already holds. What comes back is always the same shape — the texts,
 * and ONE provenance string that every note and fact the seed writes will
 * carry.
 *
 * Provenance is not decoration. The Brain's hard rule is that a fact has a
 * source a human can go back to and check, so "never invent Brain facts" needs
 * a NAME on every note: `linkedin:<account>`, `url:<host>`, `file:<absolute
 * path>`, `text:<attribution>`. The attribution on a `text` source is required
 * at the schema for exactly this reason — an agent-supplied blurb with nobody's
 * name on it is the one source that cannot be traced back afterwards.
 *
 * Nothing here thinks. The model phase belongs to whoever is judging for this
 * org (the background agent, or the caller's own session through a prepared
 * stage), and both of them read the same bytes this returns.
 */

/** The four things a seed can be made of. */
export type CorpusSource =
  | { kind: "linkedin" }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "text"; text: string; attribution: string };

export type CorpusSourceKind = CorpusSource["kind"];

export type LoadedCorpus =
  | { ok: true; texts: string[]; provenance: string; incomplete?: true }
  | { ok: false; code: CorpusErrorCode; reason: string };

export type CorpusErrorCode =
  | "corpus_not_connected"
  | "corpus_empty"
  | "corpus_url_unreadable"
  | "corpus_file_not_found"
  | "corpus_file_outside_home"
  | "corpus_file_unsupported";

/**
 * How many characters ONE seed may carry, whatever it is made of.
 *
 * The same bound the LinkedIn sweep has always had (`MAX_LINKEDIN_CORPUS_CHARS`
 * was this number): a corpus is chunked into one agent-CLI spawn per ~16k
 * characters downstream, so the bound is really a bound on how many process
 * starts a single seed can cost. Deliberately one number for every kind — a
 * folder of markdown is no cheaper to extract than 25 posts.
 */
export const MAX_SEED_CORPUS_CHARS = 50_000;

/** A single provider- or file-controlled document may not dominate the corpus. */
export const MAX_SEED_DOCUMENT_CHARS = 5_900;

/** The free-text bound `seed_brain` has always enforced, kept as the
 *  `text` source's schema bound so the alias forwards without narrowing. */
export const MAX_SEED_TEXT_CHARS = 25_000;

/** Below this a "document" is a fragment, not source material. */
const MIN_DOCUMENT_CHARS = 40;

/** What a `file` source may read. No PDF: this tree ships no PDF extractor, and
 *  a silently-skipped binary is worse than a refusal that names the rule. */
export const SEED_FILE_EXTENSIONS = [".md", ".txt"] as const;

/** How many files one folder may contribute, before the byte cap bites. */
const MAX_SEED_FILES = 200;

export type CorpusCtx = {
  /** The connected account's own-content surface — the `linkedin` kind's only
   *  reader, and absent when no account is connected. */
  driver?: CapabilitySurface<"own_content"> | undefined;
  /** Who the connected account is, for `linkedin:<account>`. */
  accountName?: string | null | undefined;
  /** How many own posts the sweep reads. */
  postLimit?: number | undefined;
  /**
   * Re-authorize immediately before the first byte moves.
   *
   * Reading a source is PROVIDER-SHAPED work on a hosted org — a browser
   * sweep, a third-party render, bandwidth — and the same fence
   * `ingest_product`'s handler puts in front of the identical crawl belongs in
   * front of this one. Asked BEFORE the read, never after: a subscription that
   * lapsed is not a reason to refuse bytes already paid for, it is a reason not
   * to spend them. A throw here propagates, so a typed cancellation stays a
   * cancellation instead of degrading into an empty corpus.
   */
  beforeFetch?: (() => void | Promise<void>) | undefined;
};

/** `linkedin:<account>` — computed WITHOUT a sweep, so the queued arm can stamp
 *  the provenance into a job payload before any browser opens. The account is
 *  the durable `externalAccountId` where a connector reports one; see
 *  `connectedAccountId` for why the display name is only a fallback. */
export function linkedInProvenance(accountName?: string | null): string {
  const name = (accountName ?? "").trim();
  return `linkedin:${name || "self"}`;
}

/**
 * Bound provider/file-controlled bodies before they fan out into seed chunks.
 *
 * `perDocument` is the MULTI-document bound and defaults off: one post out of
 * twenty-five may not eat the whole corpus, but a source that IS a single
 * document (a blurb the agent supplied, one crawled page) is bounded by the
 * corpus cap alone — clamping it to a post's width would silently truncate the
 * 25k blurb `seed_brain` has always accepted whole.
 */
export function boundedTexts(
  raw: readonly string[],
  opts: { perDocument?: number } = {},
): string[] {
  const perDocument = opts.perDocument ?? MAX_SEED_CORPUS_CHARS;
  const texts: string[] = [];
  let remaining = MAX_SEED_CORPUS_CHARS;
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed.length <= MIN_DOCUMENT_CHARS || remaining <= MIN_DOCUMENT_CHARS)
      continue;
    const text = trimmed.slice(0, Math.min(perDocument, remaining));
    if (text.length <= MIN_DOCUMENT_CHARS) break;
    texts.push(text);
    remaining -= text.length;
  }
  return texts;
}

/**
 * What a voice distillation calls this corpus.
 *
 * `learnVoice` heads each sample block with its channel name and the model
 * reads it, so this names what the writing IS rather than where it came from:
 * the provenance is an id for the vault, not a sentence for a prompt, and a
 * header reading `=== TEXTSEED_BRAIN_FROM_TEXT ===` is the failure this exists
 * to avoid.
 */
export function voiceSampleChannel(provenance: string): string {
  if (provenance.startsWith("linkedin:")) return "LinkedIn posts";
  if (provenance.startsWith("url:")) return "Published writing";
  return "Own writing";
}

/** The corpus as ONE document, which is what every extraction phase reads. The
 *  label names what the pieces ARE — the LinkedIn sweep has always said `POST`,
 *  and the extraction prompt reads it. */
export function corpusText(
  texts: readonly string[],
  label = "DOCUMENT",
): string {
  if (texts.length === 1) return texts[0]!;
  return texts
    .map((text, index) => `${label} ${index + 1}:\n${text}`)
    .join("\n\n");
}

function ownPostTexts(posts: readonly DriverPost[]): string[] {
  return boundedTexts(
    posts.map((post) => post.contentText ?? ""),
    { perDocument: MAX_SEED_DOCUMENT_CHARS },
  );
}

/**
 * Is this path somewhere the OWNER keeps their own writing?
 *
 * Two roots, and both are the owner's: their home directory, and the Brain
 * vault (which `ENGAGER_BRAIN_DIR` may point outside it). The check runs on the
 * REAL path — `realpath` resolves every symlink in the chain first — so a
 * symlink inside the vault pointing at `/etc` is refused by the same rule that
 * refuses `/etc` spelled out. A seed reads whatever it is handed and turns it
 * into durable, model-visible notes; "read any file on this machine" is not a
 * capability a chat turn gets to hand out.
 */
async function rootsForFileSource(): Promise<string[]> {
  // The roots are resolved the same way the candidate is, and for the same
  // reason: on macOS `os.tmpdir()` alone is a symlink into `/private`, so a
  // vault the owner pointed there would fail its own containment check if one
  // side of the comparison were left unresolved.
  const roots = [os.homedir(), config.brainDir].filter(Boolean);
  return Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
}

function withinRoots(realPath: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => realPath === root || realPath.startsWith(`${root}${path.sep}`),
  );
}

function hasSeedExtension(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return (SEED_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Every readable seed file under `dir`, breadth-first, capped by count. A
 *  symlinked entry is resolved and dropped when it leaves the allowed roots —
 *  the same rule the top-level path gets, applied per entry. */
async function seedFilesUnder(
  dir: string,
  roots: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  const queue = [dir];
  while (queue.length && found.length < MAX_SEED_FILES) {
    const current = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      let real: string;
      try {
        real = await realpath(full);
      } catch {
        continue;
      }
      if (!withinRoots(real, roots)) continue;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(real);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        queue.push(real);
        continue;
      }
      if (!info.isFile() || !hasSeedExtension(real)) continue;
      found.push(real);
      if (found.length >= MAX_SEED_FILES) break;
    }
  }
  return found.sort();
}

/**
 * Read at most one document's worth of a file, whatever the file's size.
 *
 * `readFile` on a path the caller named is unbounded: a seed pointed at a
 * multi-gigabyte log inside the owner's own home would buy the whole thing into
 * memory to then throw all but the first 5,900 characters away. The head is all
 * a seed can use, so the head is all that is read — four bytes per character is
 * UTF-8's worst case, so the buffer cannot under-read the bound, and a
 * multi-byte character split at the edge is dropped by the decoder rather than
 * corrupting the text.
 */
async function readBoundedText(file: string): Promise<string | null> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_SEED_DOCUMENT_CHARS * 4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}

async function loadFileCorpus(
  raw: string,
  beforeFetch?: CorpusCtx["beforeFetch"],
): Promise<LoadedCorpus> {
  // BEFORE a single syscall, including the `realpath` that resolves the path.
  // Not because a stat costs anything, but because "nothing is touched until
  // the org is authorized" is a rule with no edge cases, and the version with
  // an edge case is the one that gets eroded: a later reader who sees the fence
  // sitting three checks down has no way to tell which of them were meant to be
  // free. It also makes the property TESTABLE without spying on `node:fs` —
  // a lapsed org asking for a path that does not exist gets the entitlement
  // refusal rather than `corpus_file_not_found`, which it could only do if the
  // fence ran first.
  await beforeFetch?.();
  const roots = await rootsForFileSource();
  const requested = raw.startsWith("~")
    ? path.join(os.homedir(), raw.slice(1))
    : path.resolve(raw);

  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    return {
      ok: false,
      code: "corpus_file_not_found",
      reason: `no file or folder at ${requested}`,
    };
  }
  // AFTER realpath, deliberately: the rule is about where the bytes actually
  // are, and a symlink is the whole reason the two can differ.
  if (!withinRoots(real, roots)) {
    return {
      ok: false,
      code: "corpus_file_outside_home",
      reason:
        "a file source must resolve inside the owner's home directory or the Brain vault",
    };
  }

  const info = await stat(real);
  let files: string[];
  if (info.isDirectory()) {
    files = await seedFilesUnder(real, roots);
    if (files.length === 0)
      return {
        ok: false,
        code: "corpus_file_unsupported",
        reason: `no ${SEED_FILE_EXTENSIONS.join("/")} files under ${real}`,
      };
  } else {
    if (!hasSeedExtension(real))
      return {
        ok: false,
        code: "corpus_file_unsupported",
        reason: `only ${SEED_FILE_EXTENSIONS.join(" and ")} files can be read (this tree ships no PDF extractor)`,
      };
    files = [real];
  }

  const raws: string[] = [];
  let budget = MAX_SEED_CORPUS_CHARS;
  for (const file of files) {
    if (budget <= MIN_DOCUMENT_CHARS) break;
    try {
      const body = await readBoundedText(file);
      if (!body) continue;
      raws.push(body);
      budget -= Math.min(body.length, MAX_SEED_DOCUMENT_CHARS);
    } catch {
      /* an unreadable file is skipped, never fatal to the whole folder */
    }
  }
  const texts = boundedTexts(raws, { perDocument: MAX_SEED_DOCUMENT_CHARS });
  if (texts.length === 0)
    return {
      ok: false,
      code: "corpus_empty",
      reason: `nothing usable to read at ${real}`,
    };
  return { ok: true, texts, provenance: `file:${real}` };
}

/**
 * Load the bytes one `seed_brain` call will seed from.
 *
 * Every arm is I/O ONLY. Nothing here opens a transaction, spends a model call
 * or writes a note — which is what lets the same function serve the queued path
 * (the worker seeds from what this returned) and the in-session path (the
 * server reads here, the caller's own agent thinks).
 */
export async function loadCorpus(
  ctx: CorpusCtx,
  source: CorpusSource,
): Promise<LoadedCorpus> {
  switch (source.kind) {
    case "linkedin": {
      if (!ctx.driver)
        return {
          ok: false,
          code: "corpus_not_connected",
          reason: "no connected account to read posts from",
        };
      await ctx.beforeFetch?.();
      let incomplete = false;
      const posts = await ctx.driver.fetchOwnPosts(
        ctx.postLimit ?? OWN_POST_LIMIT,
        () => {
          incomplete = true;
        },
      );
      const texts = ownPostTexts(posts);
      if (texts.length === 0)
        return {
          ok: false,
          code: "corpus_empty",
          reason: "the account's own posts held nothing usable to seed from",
        };
      return {
        ok: true,
        texts,
        provenance: linkedInProvenance(ctx.accountName),
        ...(incomplete ? { incomplete: true as const } : {}),
      };
    }
    case "url": {
      // The product crawler's own bounded fetch, reused rather than
      // reimplemented: one SSRF guard validating every redirect hop, one byte
      // cap, one Firecrawl-then-direct ladder. A second copy of that guard is a
      // second place for it to be wrong.
      const crawled = await fetchProductSourceCorpus(source.url, {
        ...(ctx.beforeFetch ? { beforeFetch: ctx.beforeFetch } : {}),
      });
      if (!crawled.ok)
        return {
          ok: false,
          code: "corpus_url_unreadable",
          reason: crawled.reason,
        };
      const texts = boundedTexts([crawled.text]);
      if (texts.length === 0)
        return {
          ok: false,
          code: "corpus_empty",
          reason: `nothing usable to read at ${source.url}`,
        };
      let host: string;
      try {
        host = new URL(crawled.url).host;
      } catch {
        host = crawled.url;
      }
      return { ok: true, texts, provenance: `url:${host}` };
    }
    case "file":
      return loadFileCorpus(source.path, ctx.beforeFetch);
    case "text": {
      const texts = boundedTexts([source.text]);
      if (texts.length === 0)
        return {
          ok: false,
          code: "corpus_empty",
          reason: "the supplied text held nothing usable to seed from",
        };
      return {
        ok: true,
        texts,
        provenance: `text:${source.attribution.trim()}`,
      };
    }
  }
}
