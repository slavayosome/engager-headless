/**
 * Canonical post identity.
 *
 * LinkedIn addresses the same post under more than one urn, and the ids are NOT
 * derivable from one another. Measured on a real post (2026-08-02):
 *
 *   urn:li:ugcPost:7487798476005720064   -> snowflake ms 1785230273248
 *   urn:li:activity:7487798476521512960  -> snowflake ms 1785230273371
 *
 * 123 ms and 515,792,896 ids apart — independently allocated. There is no
 * arithmetic mapping between the namespaces, so identity CANNOT be normalised
 * after the fact. It has to be decided once, at extraction, from a single
 * authoritative field.
 *
 * Why this matters: `dedupeKey()` interpolates the urn into
 * `messages.dedupe_key`, which is UNIQUE. Two spellings of one post produce two
 * distinct keys, the unique index cannot fire, and the account comments twice on
 * the same post under the owner's name.
 *
 * THE AUTHORITATIVE FIELD IS THE PERMALINK (`socialContent.shareUrl` in Voyager,
 * the post anchor href in the DOM). Verified across the captured payloads:
 *   - shareUrl agreed with the post's real identity on 10/10 elements
 *   - `updateMetadata.urn` disagreed on 4/5 HOME FEED elements, where it is a
 *     per-viewer wrapper activity (e.g. wrapper …9713232441344 vs real
 *     …8362262134784). Commenting on a wrapper targets the wrong entity.
 *   - `*socialDetail` disagreed on 1/10, carrying a ugcPost alias for an
 *     activity-keyed update.
 *
 * So: derive from the permalink; never from updateMetadata.urn on a feed.
 *
 * `NETWORKS.linkedin.postUrn` in `packages/core/network/registry.ts` is what
 * OWNS this grammar. The file stays where its importers already point; the
 * registry entry is what a second network is added to.
 */

/** Matches the shape the sidecar write path already enforces. Ids are NOT
 *  digits-only — MockDriver emits `urn:li:activity:mock-1`, and narrowing this
 *  to \d+ would reject every fake in the test suite. */
export const POST_URN_RE = /^urn:li:(activity|ugcPost|share):([A-Za-z0-9_-]+)$/;

export type PostUrnParts = {
  namespace: "activity" | "ugcPost" | "share";
  id: string;
  urn: string;
};

/** Parse a post identity out of a bare urn, a `/feed/update/<urn>/` permalink,
 *  or a `/posts/<slug>-<type>-<id>-<hash>/` share link. Returns null when the
 *  value carries no post identity — callers decide whether that is fatal. */
export function parsePostUrn(
  value: string | null | undefined,
): PostUrnParts | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed percent-sequence must not throw; fall back to the raw text.
  }

  const direct = /urn:li:(activity|ugcPost|share):([A-Za-z0-9_-]+)/.exec(decoded);
  if (direct) {
    return {
      namespace: direct[1] as PostUrnParts["namespace"],
      id: direct[2]!,
      urn: `urn:li:${direct[1]}:${direct[2]}`,
    };
  }

  // Share-link slug form: the identity is encoded without a literal `urn:li:`.
  const slug = /\/posts\/[A-Za-z0-9_%-]+?-(ugcPost|activity|share)-(\d+)-[A-Za-z0-9_-]+/.exec(
    decoded,
  );
  if (slug) {
    return {
      namespace: slug[1] as PostUrnParts["namespace"],
      id: slug[2]!,
      urn: `urn:li:${slug[1]}:${slug[2]}`,
    };
  }
  return null;
}

/**
 * Collapse every spelling of one post to a single key form. A permalink and a
 * bare urn must not produce two dedupe keys.
 *
 * Deliberately TOLERANT: values it cannot parse pass through trimmed rather
 * than throwing. Key construction is not the right place to adjudicate LinkedIn
 * identity — it runs on every draft, for targets that legitimately are not post
 * urns (reply targets, and synthetic ids throughout the fixtures). Use
 * `assertPostUrn()` at the boundary where a live write is authorised; that is
 * where a wrong identity actually costs something.
 */
export function normalizePostUrn(value: string | null | undefined): string {
  const parsed = parsePostUrn(value);
  return parsed ? parsed.urn : String(value ?? "").trim();
}

/**
 * STRICT gate for the live-write path. Throws rather than returning a
 * best-effort string: an unidentifiable urn yields a dedupe key that can never
 * collide, which reads as "not yet posted" forever — so the retry path would
 * comment again, and again. Failing loudly is strictly safer.
 *
 * Call this immediately before authorising a real comment, not while building
 * keys for drafts that may never be sent.
 */
export function assertPostUrn(value: string | null | undefined): string {
  const parsed = parsePostUrn(value);
  if (!parsed) {
    throw new Error(
      `Unrecognised LinkedIn post urn: ${JSON.stringify(value)} — refusing to authorise a write against an identity that cannot dedupe`,
    );
  }
  return parsed.urn;
}

/**
 * Whether two urns denote the same post, as far as is DECIDABLE from the
 * strings alone.
 *
 * Cross-namespace equality is deliberately NOT attempted: ugcPost and activity
 * ids for one post are independently allocated (see the header), so no string
 * comparison can relate them. If both spellings of a post ever reach the
 * database, this returns false and the duplicate is real — the defence is to
 * emit a single canonical spelling at extraction, not to reconcile later.
 */
export function sameMostLikelyPost(a: string, b: string): boolean {
  const pa = parsePostUrn(a);
  const pb = parsePostUrn(b);
  if (!pa || !pb) return false;
  return pa.namespace === pb.namespace && pa.id === pb.id;
}

/** LinkedIn activity ids are snowflake-style: publication time in ms sits in the
 *  high bits. BigInt is mandatory — these ids exceed Number.MAX_SAFE_INTEGER and
 *  a plain Number conversion loses precision silently. Returns null when the id
 *  is not snowflake-encoded (e.g. MockDriver's `mock-1`). */
export function postUrnTimestamp(value: string | null | undefined): number | null {
  const parsed = parsePostUrn(value);
  if (!parsed || !/^\d+$/.test(parsed.id)) return null;
  const ms = Number(BigInt(parsed.id) >> 22n);
  // Bound to LinkedIn's plausible lifetime so a non-snowflake numeric id fails
  // closed instead of inventing a date.
  if (ms < 1104537600000 || ms > Date.now() + 86_400_000) return null;
  return ms;
}
