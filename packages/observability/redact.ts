/**
 * The one redactor every byte of a problem report's diagnostics passes through
 * — before the owner's preview, before their agent reads it, and before it is
 * sent (US-BUG-06). What it protects is the owner's account (cookies, keys,
 * passwords) and the people the owner talks to (member urns, profile and post
 * URLs, vanity slugs, other people's emails and phone numbers).
 *
 * Two moves, never a third:
 * - a line that carries a post, comment or DM body is DROPPED whole, and with
 *   it whatever continues it (a stack under it, a value on its next line). A
 *   body is prose, and prose cannot be redacted reliably — a name or a
 *   confidence in the middle of a sentence has no pattern. So the logger's text
 *   fields are recognised by name, the line a database error prints its bound
 *   values on (`params: …`) goes whatever it holds, and any line over
 *   `MAX_LINE_CHARS` goes too, since nothing that long is a diagnostic;
 * - every other line has its secrets replaced and its identities hashed. A
 *   person or a post becomes `<member#a1b2c3>` / `<post#a1b2c3>`: a short
 *   hash salted per report, so one person's lines stay correlatable inside a
 *   report and no two reports can be joined on it.
 *
 * Idempotent by construction: a placeholder matches none of the patterns, so
 * text already redacted comes back byte for byte. That is what lets the
 * server redact again what the owner previewed and still send exactly what
 * they saw.
 */
import { createHash, randomBytes } from "node:crypto";

/** A line longer than this is dropped: no diagnostic is that long, and a body
 *  pasted into an error message is. */
export const MAX_LINE_CHARS = 2_000;

/** Most lines a dropped line takes with it (see `Redactor.text`). A body that
 *  runs past this is not a log line; the cap keeps one stray quote from
 *  swallowing the rest of a file. */
const MAX_DROP_RUN = 50;

/**
 * The logger's text fields: the names a post, comment, draft, DM or owner/agent
 * note travels under (the columns in `packages/database/schema.ts` that hold
 * one, and the driver's wire names). A line naming one as a key — `text=`,
 * `"postText":`, `body: '…'`, `post_text=` — is dropped whole. Hashes and
 * ciphertexts are not bodies and do not match: `textHash` is not `text`.
 *
 * Exported for the schema coverage test: a prose column added to the schema
 * and named nowhere here fails that test rather than leaking from the first
 * report whose log prints it.
 */
export const BODY_FIELDS = [
  "text",
  "body",
  "content",
  "contentText",
  "postText",
  "opening",
  "refusalReason",
  "postBody",
  "commentText",
  "commentBody",
  "comment",
  "commentary",
  "replyText",
  "messageText",
  "messageBody",
  "message",
  "reply",
  "invitationMessage",
  "customMessage",
  "draft",
  "draftText",
  "dmDraft",
  "dm",
  "finalText",
  "editedText",
  "proposedText",
  "responseText",
  "heldMessageText",
  "parkedText",
  "seedText",
  "contextText",
  "snippet",
  "excerpt",
  "evidenceQuote",
  "agentAngle",
  "angle",
  "angleWhy",
  "agentRankReason",
  "freeTextNote",
  "draftRequestNote",
  "redraftRequestNote",
  "requestNote",
  "lastReadNote",
  "pipelineHoldNote",
  "note",
  "notes",
  "rationale",
  "rationaleSummary",
  "summary",
  "oneLiner",
  "intentEvidence",
  "intentQuote",
  "words",
  "question",
  "answer",
  "objective",
  "instruction",
  "guidance",
  "voiceHouseStyle",
  "voicePersona",
  "prompt",
  "ownerText",
  "expected",
  "working",
] as const;

/** `commentText` → `comment[_-]?Text`: the camelCase and snake_case spellings
 *  of one field are the same field. */
function fieldPattern(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1[_-]?$2");
}

/** A key's opening or closing quote, straight or typographic. */
const KEY_QUOTE = "[\"'\u2018\u2019\u201c\u201d`]";

// Not after a `:` either, which would take `urn:li:comment:(…)` for a comment.
const BODY_LINE = new RegExp(
  `(?:^|[^A-Za-z0-9_:])${KEY_QUOTE}?(?:${BODY_FIELDS.map(fieldPattern).join("|")})${KEY_QUOTE}?\\s*[:=]`,
  "i",
);

/** Drizzle's `DrizzleQueryError` prints the bound values on a line of their
 *  own — `params: …` — and any query can bind a body, a name or a secret. */
const PARAMS_LINE = /^\s*(?:params|parameters)\s*:/i;
/** Postgres' DETAIL for a NOT NULL or CHECK violation prints the whole row. */
const FAILING_ROW = /Failing row contains/i;

/** LinkedIn's session cookies, by name. */
const COOKIE_NAMES = [
  "li_at",
  "JSESSIONID",
  "li_rm",
  "bcookie",
  "bscookie",
  "lidc",
  "li_mc",
  "liap",
  "li_gc",
];

/**
 * Words that make a key's VALUE a credential whatever it looks like, wherever
 * the key sits in the name: `password`, `anthropicApiKey`, `x-api-key`,
 * `?access_token=`, `clientSecret`. Plain `key` is not one — `dedupeKey` is an
 * identifier, and the bare `?key=` of a query string has its own rule.
 */
const SECRET_KEY_WORDS =
  "api[_-]?key|secret|passw(?:or)?d|credential|token|private[_-]?key|(?:access|master|signing|encryption|auth|session)[_-]?key|authorization|bearer|recovery[_-]?codes?";

/** Names that carry a secret word without being one: a hash, a count, a kind
 *  or an id OF a token. */
const NOT_SECRET_KEY =
  /(?:hash|count|counts|type|limit|usage|budget|endpoint|ttl|expires?\w*|length|id|ids|kind|status|prefix|fingerprint|tokens)$/i;

const SECRET_KEY_NAME = new RegExp(SECRET_KEY_WORDS, "i");

/** Whether a key's value is a credential by the key's name alone. */
export function isSecretKeyName(name: string): boolean {
  return SECRET_KEY_NAME.test(name) && !NOT_SECRET_KEY.test(name);
}

const SECRET_KEY = new RegExp(
  `(?<![A-Za-z0-9_.-])(["']?)((?=[A-Za-z0-9_.-]*?(?:${SECRET_KEY_WORDS}))[A-Za-z][A-Za-z0-9_.-]*)\\1(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}"']+)`,
  "gi",
);

/** A value an earlier rule (or an earlier pass) already replaced, or no value. */
const SETTLED_VALUE = /^["']?(?:<[a-z]+(?:#[0-9a-f]{6})?>|\*{3}|null|undefined|true|false)["']?$/;

/**
 * Value shapes that are credentials wherever they appear, even unlabelled.
 * Exported so the coverage test can name each one.
 */
export const SECRET_SHAPES: readonly RegExp[] = [
  // Anthropic before the generic `sk-` so the label is not split.
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Stripe: secret, restricted, publishable and webhook signing keys.
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9]{8,}/g,
  // Resend: `re_` then a mixed-case body. Requiring a digit and a capital
  // keeps snake_case identifiers (`re_scan_job_failed`) out of it.
  /\bre_(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{16,}/g,
  // PostHog project keys.
  /\bphc_[A-Za-z0-9]{16,}/g,
  // GitHub tokens, AWS access key ids, Firecrawl keys.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bfc-[a-f0-9]{16,}/g,
  // A JWT: three base64url segments, the first an encoded `{"`.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  // Slack, Google, npm and SendGrid keys.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  // LinkedIn's session cookies by VALUE, whatever key they sit under: li_at
  // and li_rm (`AQE…`), the JSESSIONID that doubles as the csrf token
  // (`ajax:<digits>`), and a bcookie (`v=2&<uuid>`).
  /\bAQE[A-Za-z0-9_-]{30,}/g,
  /\bajax:\d{8,}/g,
  /\bv=2&[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
  // A long padded base64 string — `ENGAGER_MASTER_KEY`'s shape (32 bytes, 43
  // characters and a pad) — unlabelled.
  /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{39,}={1,2}(?![A-Za-z0-9+/=])/g,
];

/** `<member#…>` for a person, `<post#…>` for something they wrote, and
 *  `<urn#…>` for any other LinkedIn urn (a conversation, a company page). */
type IdentityKind = "member" | "post" | "urn";

const MEMBER_URN_KINDS = new Set([
  "member",
  "person",
  "profile",
  "fs_profile",
  "fsd_profile",
  "fs_miniprofile",
  "fsd_miniprofile",
  "miniprofile",
]);
const POST_URN_KINDS = new Set([
  "activity",
  "ugcpost",
  "share",
  "comment",
  "fsd_comment",
  "article",
  "post",
]);

/** Keys whose value is a person: a vanity slug, a profile id or urn, a name. */
export const IDENTITY_KEYS = [
  "publicIdentifier",
  "vanityName",
  "vanity",
  "profileSlug",
  "slug",
  "profileId",
  "profileSpelling",
  "memberId",
  "profileUrn",
  "memberIdentity",
  "authorUrn",
  "actorUrn",
  "authorName",
  "actorName",
  "fullName",
  "firstName",
  "lastName",
  "displayName",
  "memberName",
  "profileName",
  "personName",
  "headline",
  "authorHeadline",
  "authorGeo",
  "authorName",
  "senderDisplayName",
];

export type RedactorOptions = {
  /** The account's own address: the one email a report may keep, because the
   *  team replies to it. Every other address is someone else's. */
  accountEmail?: string | null;
  /** Literal values to remove wherever they appear — the process's own
   *  secrets, read from the environment by the caller. A secret printed
   *  without its name has no shape to match; its value still does. */
  knownSecrets?: readonly string[];
  /** The names of the people this install knows — authors, comment authors,
   *  connections. A name in free text ("sent to Jane Doe") has no shape, so the
   *  only way to keep it out is to know it. Each becomes that person's
   *  `<member#…>`. */
  knownPeople?: readonly string[];
  /** The hash salt. Random per redactor, so placeholders are stable within one
   *  report and meaningless across two. Tests pin it. */
  salt?: string;
};

export type Redactor = {
  /** One line, redacted — or null when the line must be dropped whole. */
  line(input: string): string | null;
  /**
   * A block of text, line by line, with dropped lines removed. A dropped line
   * takes with it what continues it: an indented line (a stack frame, a
   * pretty-printed value), a line after one ending in `:`, `=` or an opening
   * bracket, and the lines of a quoted value still open — a body does not
   * end at its first newline.
   */
  text(input: string): string;
};

const MIN_KNOWN_SECRET_LENGTH = 8;
/** Shorter names are words as often as they are people ("Al", "Ana"). */
const MIN_KNOWN_NAME_LENGTH = 4;

const WORD = /[\p{L}\p{N}]+/gu;
/** What may sit between two words of one name: spaces, and the marks inside
 *  "Jean-Luc", "O'Brien", "Dr. Doe" and "Doe, Jane". */
const NAME_GAP = /^[\s'\u2019.,-]{1,4}$/;

type NameNode = { next: Map<string, NameNode>; end: boolean };

/**
 * Known names as a trie of lower-cased words, searched by walking each line's
 * words once — linear in the line however many names there are. (A regex of
 * every name is quadratic: 2,000 names over 1,500 lines took 11 s, and an
 * install may hold thousands.)
 */
function nameIndex(names: readonly string[]): ((text: string, replace: (name: string) => string) => string) | null {
  const root: NameNode = { next: new Map(), end: false };
  for (const name of names) {
    let node = root;
    for (const [word] of name.matchAll(WORD)) {
      const key = word.toLowerCase();
      let child = node.next.get(key);
      if (!child) node.next.set(key, (child = { next: new Map(), end: false }));
      node = child;
    }
    node.end = true;
  }
  if (root.next.size === 0) return null;

  return (text, replace) => {
    const words = [...text.matchAll(WORD)];
    let out = "";
    let copied = 0;
    for (let i = 0; i < words.length; ) {
      let node: NameNode | undefined = root;
      let last = -1;
      for (let j = i; j < words.length; j++) {
        if (j > i) {
          const gap = text.slice(words[j - 1]!.index! + words[j - 1]![0].length, words[j]!.index!);
          if (!NAME_GAP.test(gap)) break;
        }
        node = node.next.get(words[j]![0].toLowerCase());
        if (!node) break;
        if (node.end) last = j;
      }
      if (last < 0) {
        i++;
        continue;
      }
      const start = words[i]!.index!;
      const end = words[last]!.index! + words[last]![0].length;
      // Keyed on the words alone, so "Jean-Luc Picard" and "jean luc picard"
      // are one person.
      const name = words.slice(i, last + 1).map((word) => word[0]).join(" ");
      out += text.slice(copied, start) + replace(name);
      copied = end;
      i = last + 1;
    }
    return copied === 0 ? text : out + text.slice(copied);
  };
}

/** `Failed query: insert into "messages" ("id", "text") values ($1, $2)` →
 *  `Failed query: insert into "messages" …`. The SQL names columns, and a
 *  column named `text` would drop the whole line — the job's type and error
 *  class with it; the verb and the table are what a report needs of it. */
function summariseFailedQuery(input: string): string {
  const at = input.search(/Failed query:/i);
  if (at < 0) return input;
  const sql = input.slice(at + "Failed query:".length).trim();
  const target =
    sql.match(/^(insert\s+into|update|delete\s+from)\s+("[^"]+"(?:\."[^"]+")?|[\w.]+)/i) ??
    sql.match(/^(select)\b.*?\bfrom\s+("[^"]+"(?:\."[^"]+")?|[\w.]+)/i);
  const what = target ? `${target[1]!.toLowerCase().replace(/\s+/g, " ")} ${target[2]}` : "<sql omitted>";
  return `${input.slice(0, at)}Failed query: ${what} …`;
}

/** A line's `"` marks that are not escaped: odd means a string is still open. */
function opensQuote(input: string): boolean {
  return (input.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1;
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const salt = options.salt ?? randomBytes(16).toString("hex");
  const accountEmail = options.accountEmail?.trim().toLowerCase() || null;
  const knownSecrets = [...new Set(options.knownSecrets ?? [])]
    .filter((value) => value.length >= MIN_KNOWN_SECRET_LENGTH)
    // Longest first, so a secret that contains another is removed whole.
    .sort((a, b) => b.length - a.length);
  const redactPeople = nameIndex(
    [...new Set((options.knownPeople ?? []).map((name) => name.trim()))].filter(
      (name) => name.length >= MIN_KNOWN_NAME_LENGTH && /\p{L}/u.test(name),
    ),
  );

  function placeholder(kind: IdentityKind, key: string): string {
    const digest = createHash("sha256")
      .update(`${salt}\0${kind}\0${key.toLowerCase()}`, "utf8")
      .digest("hex")
      .slice(0, 6);
    return `<${kind}#${digest}>`;
  }

  function urn(kindRaw: string, id: string): string {
    const kind = kindRaw.toLowerCase();
    if (MEMBER_URN_KINDS.has(kind)) return placeholder("member", id);
    // A post's urn and its URL hash to the same key — the activity id — so a
    // post named both ways in one report reads as one post.
    if (POST_URN_KINDS.has(kind)) return placeholder("post", activityKey(id));
    return placeholder("urn", `${kind}:${id}`);
  }

  const cookieNames = COOKIE_NAMES.join("|");
  const cookieObjectName = new RegExp(`["']name["']\\s*:\\s*["'](?:${cookieNames})["']`);

  function line(input: string): string | null {
    if (input.length > MAX_LINE_CHARS) return null;
    if (PARAMS_LINE.test(input) || FAILING_ROW.test(input)) return null;
    let out = summariseFailedQuery(input);
    // `"text" = $1` names a column to bind; the value is on the `params:` line.
    if (BODY_LINE.test(out.replace(/"[A-Za-z0-9_]+"\s*=\s*\$\d+/g, ""))) return null;

    for (const secret of knownSecrets) out = out.split(secret).join("<secret>");
    if (redactPeople) out = redactPeople(out, (name) => placeholder("member", name));

    // Passwords in connection strings and URLs: `postgres://user:***@host`. The
    // password runs to the LAST `@` before the path, so one that holds an `@`
    // leaves no tail; a userinfo with no password (`https://<key>@sentry.io`)
    // is the credential itself.
    out = out.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):([^\s/]+)@/gi, "$1:***@");
    out = out.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s:/@<*]+@/gi, "$1<redacted>@");

    // Cookies: a serialized cookie object whichever way round its fields sit
    // and whichever quotes it uses (JSON, a Python repr), then `name=value` /
    // `name: value`.
    out = out.replace(/\{[^{}]*\}/g, (object) =>
      cookieObjectName.test(object)
        ? object.replace(
            /(["']value["']\s*:\s*)("[^"]*"|'[^']*')/gi,
            (_match, key: string, value: string) => `${key}${quoteLike(value, "<redacted>")}`,
          )
        : object,
    );
    out = out.replace(
      new RegExp(`\\b(${cookieNames})(["']?\\s*[=:]\\s*["']?)[^;\\s"',&}]+`, "g"),
      "$1$2<redacted>",
    );

    // Whole headers: everything after the name is the credential.
    out = out.replace(
      /\b((?:proxy-)?authorization|set-cookie|cookie|csrf-token|x-li-csrf)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\n]*)/gi,
      (_match, name: string, separator: string, value: string) =>
        `${name}${separator}${quoteLike(value, "<redacted>")}`,
    );
    out = out.replace(/\b(Bearer|bearer|BEARER|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 <redacted>");

    for (const shape of SECRET_SHAPES) out = out.replace(shape, "<secret>");

    // `ANY_KEY=…`, `*_TOKEN=…`, `*_SECRET=…`: an environment line or a flag.
    out = out.replace(
      /(["']?)\b([A-Z][A-Z0-9_]*(?:KEY|KEYS|TOKEN|SECRET|PASSWORD|DSN|CREDENTIALS?))\1(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/g,
      (_match, quote: string, name: string, separator: string, value: string) =>
        `${quote}${name}${quote}${separator}${quoteLike(value, "<redacted>")}`,
    );
    // Any other key that names a credential, in JSON, a query string or
    // `key: value` form: `"anthropicApiKey"`, `x-api-key`, `?access_token=`.
    out = out.replace(
      SECRET_KEY,
      (match, quote: string, name: string, separator: string, value: string) =>
        !isSecretKeyName(name) || SETTLED_VALUE.test(value)
          ? match
          : `${quote}${name}${quote}${separator}${quoteLike(value, "<redacted>")}`,
    );
    // Signed URLs and bare `?key=`: a query value that is a credential by
    // where it sits.
    out = out.replace(
      /([?&](?:key|sig|signature|x-amz-signature|x-amz-credential)=)[^&\s"'#]+/gi,
      "$1<redacted>",
    );

    // LinkedIn URLs before urns: a feed URL carries a urn inside it, and the
    // URL is the larger identity.
    out = out.replace(
      /(?<![a-z0-9-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/(in|pub|sales\/lead|sales\/people|posts|feed\/update|pulse|messaging\/thread)\/([^\s"'<>)\]?#]*)(?:[?#][^\s"'<>)\]]*)?/gi,
      (_match, section: string, rest: string) => {
        const path = rest.replace(/\/+$/, "");
        if (/^(posts|feed\/update|pulse)$/i.test(section)) {
          return placeholder("post", activityKey(path));
        }
        if (/^messaging/i.test(section)) return placeholder("urn", `thread:${path}`);
        return placeholder("member", path.split("/")[0] ?? path);
      },
    );
    // The same profile as a path alone — a request line or a navigation log.
    out = out.replace(
      /(?<![\w/.:%-])\/in\/([A-Za-z0-9%_.~-]+)(?:\/[^\s"'<>)\]?#]*)?(?:\?[^\s"'<>)\]#]*)?/g,
      (_match, slug: string) => placeholder("member", slug),
    );
    // A comment's urn nests its post's: `urn:li:comment:(urn:li:activity:1,2)`.
    out = out.replace(
      /urn(?::|%3A)li(?::|%3A)(?:fsd_)?comment(?::|%3A)(\([^)\s]*\)|\S+?)(?=$|[\s"',)\]}&])/gi,
      (_match, id: string) => placeholder("post", activityKey(id)),
    );
    out = out.replace(
      /urn(?::|%3A)li(?::|%3A)([A-Za-z_]+)(?::|%3A)([A-Za-z0-9_-]+)/g,
      (_match, kind: string, id: string) => urn(kind, id),
    );
    // A person named by key. Unquoted, a name runs to the next delimiter or
    // the next `key=`, so "authorName=Jane Doe status=sent" loses both words.
    out = out.replace(
      new RegExp(
        `(["']?)\\b(${IDENTITY_KEYS.join("|")})\\b\\1(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^,;&}"'\\n]+?(?=\\s*(?:[,;&}]|$|\\s[\\w-]+[:=])))`,
        "gi",
      ),
      (match, quote: string, name: string, separator: string, value: string) => {
        const bare = value.replace(/^["']|["']$/g, "");
        // Already a placeholder — a urn redacted above, or a second pass.
        if (/^<[a-z]+#[0-9a-f]{6}>$/.test(bare) || bare === "" || bare === "null") {
          return match;
        }
        return `${quote}${name}${quote}${separator}${quoteLike(value, placeholder("member", bare))}`;
      },
    );

    // Postgres' `Key (email)=(jane@acme.com) already exists`: the value is
    // whatever the column held.
    out = out.replace(/\bKey \(([^)]*)\)=\(.*?\)(?= already| is |$)/g, "Key ($1)=(<redacted>)");

    // Anchored where an address can begin, so a long run of characters that
    // could be one is scanned once and not from every position in it.
    out = out.replace(
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      (address) => (address.toLowerCase() === accountEmail ? address : "<email>"),
    );
    // Phone numbers: international with a `+`, or the NANP's 3-3-4. Bare
    // digit runs are ids and timestamps, and stay.
    out = out.replace(/\+\d[\d\s().-]{7,18}\d/g, "<phone>");
    out = out.replace(/(?<![\w.:-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.:-])/g, "<phone>");

    return out;
  }

  return {
    line,
    text(input: string): string {
      const kept: string[] = [];
      // The state of the last dropped line, while what follows may be its
      // continuation: lines taken, a string still open, a value still due.
      let dropped: { taken: number; quote: boolean; value: boolean } | null = null;
      for (const raw of input.split("\n")) {
        if (dropped) {
          const continues =
            dropped.taken < MAX_DROP_RUN && (dropped.quote || dropped.value || /^[ \t]/.test(raw));
          if (continues) {
            dropped.taken++;
            dropped.quote = dropped.quote !== opensQuote(raw);
            dropped.value = /[:=,{[(]\s*$/.test(raw);
            continue;
          }
          dropped = null;
        }
        const redacted = line(raw);
        if (redacted === null) {
          dropped = { taken: 0, quote: opensQuote(raw), value: /[:=,{[(]\s*$/.test(raw) };
        } else {
          kept.push(redacted);
        }
      }
      return kept.join("\n");
    },
  };
}

/** The activity id a post's URL or urn carries, so both spellings of one post
 *  hash alike; the whole string when it carries none. */
function activityKey(value: string): string {
  const id = value.match(/activity(?::|%3A|-)(\d{6,})/i)?.[1] ?? value.match(/^(\d{6,})$/)?.[1];
  return id ?? value;
}

/** Keep a value's own quoting around its replacement. */
function quoteLike(original: string, replacement: string): string {
  const quote = original[0];
  if ((quote === '"' || quote === "'") && original.endsWith(quote) && original.length > 1) {
    return `${quote}${replacement}${quote}`;
  }
  return replacement;
}

/**
 * The values of this process's own secrets, for `knownSecrets`: every
 * environment variable whose NAME says it holds one. Read by the caller and
 * handed in, never by the redactor itself, so a test can construct one with
 * exactly the secrets it seeds.
 */
export function secretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name]) => SECRET_ENV_NAME.test(name))
    .map(([, value]) => value?.trim() ?? "")
    .filter((value) => value.length >= MIN_KNOWN_SECRET_LENGTH);
}

/** An environment variable whose name says its value is a credential. */
export const SECRET_ENV_NAME =
  /(?:KEY|KEYS|TOKEN|SECRET|PASSWORD|DSN|CREDENTIALS?|DATABASE_URL)$/;
