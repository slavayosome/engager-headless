/**
 * provider mention composition for LinkedIn comments/replies. The comment body
 * accepts `mentions: [{ name, profile_id }]` plus `{{i}}` placeholders in the
 * text; LinkedIn renders the placeholder as a real @-tag of that profile.
 *
 * Drafts stay plain human-readable text everywhere (DB, dashboard, lint) — the
 * placeholder swap happens only at publish time inside the driver, and
 * reconcilePosted must accept BOTH the raw draft and the rendered tag text,
 * otherwise a retry after a timeout stops matching the landed comment and
 * double-posts (the ban path).
 *
 * `NETWORKS.linkedin.mention` in `packages/core/network/registry.ts` is what
 * OWNS this syntax; a network that tags people differently is a second entry
 * there, not a branch in here.
 */

export type MentionTarget = { profileId: string; name: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swap the drafted plain-text name for the `{{0}}` mention slot. Preference
 * order: the full name anywhere → the first name (as drafts usually address
 * people) at the start or on a word boundary → prepend the tag. Always returns
 * text containing exactly one `{{0}}`.
 */
export function composeMentionText(text: string, name: string): string {
  const full = name.trim();
  if (full) {
    const idx = text.toLowerCase().indexOf(full.toLowerCase());
    if (idx >= 0) return `${text.slice(0, idx)}{{0}}${text.slice(idx + full.length)}`;
    const first = full.split(/\s+/)[0] ?? "";
    if (first.length >= 2) {
      const word = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegExp(first)}(?![\\p{L}\\p{N}])`,
        "iu",
      ).exec(text);
      if (word) {
        return `${text.slice(0, word.index)}{{0}}${text.slice(word.index + word[0].length)}`;
      }
    }
  }
  return `{{0}} ${text}`;
}

/** What LinkedIn shows once the placeholder resolves to the tagged name. */
export function renderedMentionText(composed: string, name: string): string {
  return composed.replaceAll("{{0}}", name);
}

/**
 * True when a stored profile identifier is a real provider member id (ACoAA…
 * token or an urn) rather than a display name. Legacy intake stored NAMES in
 * author_profile_id (provider comment items put the name in `author`), and
 * sending a name as mentions[].profile_id would fail the whole post — so a
 * mention is only built from an id-shaped value.
 */
export function isMentionableProfileId(id: string): boolean {
  return /^(ACo[\w-]+|urn:[^\s]+)$/i.test(id);
}

/** Whitespace-collapsed forms a landed mention-reply may come back as. */
export function reconcileTextCandidates(text: string, mention?: MentionTarget): Set<string> {
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const out = new Set([squash(text)]);
  if (mention) {
    const composed = composeMentionText(text, mention.name);
    out.add(squash(composed));
    out.add(squash(renderedMentionText(composed, mention.name)));
    out.add(squash(renderedMentionText(composed, `@${mention.name}`)));
  }
  return out;
}

/**
 * Their words without the tag LinkedIn put in front of them: a reply under the
 * owner's comment opens with the owner's own name ("Slava Nikitin That's
 * exactly…"), which is the platform addressing the owner, not what the person
 * said. Only a LEADING mention of the full name is removed — with an `@`,
 * and the comma or colon after it — and nothing else is touched, so a reply
 * that is nothing but the name, or names the owner mid-sentence, reads as it
 * was written.
 */
export function stripOwnerMention(text: string, ownerName: string | null | undefined): string {
  const name = ownerName?.trim();
  if (!name) return text;
  const lead = new RegExp(`^\\s*@?${escapeRegExp(name)}(?![\\p{L}\\p{N}])[\\s,:;\\u2014\\u2013-]*`, "iu").exec(text);
  if (!lead) return text;
  const rest = text.slice(lead[0].length);
  return rest.trim().length === 0 ? text : rest;
}
