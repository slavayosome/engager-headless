import {
  composeMentionText,
  isMentionableProfileId,
  reconcileTextCandidates,
  renderedMentionText,
} from "../linkedin/mention";
import { linkedinPostUrl } from "../linkedin/postUrl";
import {
  assertPostUrn,
  normalizePostUrn,
  parsePostUrn,
  postUrnTimestamp,
  sameMostLikelyPost,
} from "../linkedin/postUrn";

/**
 * What a NETWORK is, in code.
 *
 * `linkedin` / `x` / `reddit` is not an account — it is a grammar: how a post's
 * identity is spelled, what its public URL looks like, how a mention is
 * composed, which hosts are the network itself. A CHANNEL is the owner's
 * account on one of these, and the channel is what carries the exposure budget
 * (INV-4). Keeping them separate nouns is why a second account does not force a
 * second network, and a second network does not force a second budget.
 *
 * A re-homing BY REFERENCE, not a file move. `linkedin/postUrn.ts`,
 * `linkedin/postUrl.ts` and `linkedin/mention.ts` keep the fourteen importers
 * that already point at them and every member below delegates to their exports;
 * churning those imports would buy nothing. What the entry adds is an OWNER —
 * one declared place a second network is added, so the exactly-once path never
 * calcifies around `urn:li:` and a second grammar arrives as a second entry
 * here rather than a second regex at a call site. `conversations.ts` had
 * already grown that second regex; `externalUrnPattern` is where it lives now.
 */

/** Every network this code knows how to speak. `packages/database/schema.ts`
 *  spells the same list for the `channels.network` column because that package
 *  cannot import this one; `registry.test.ts` pins the two equal. */
export const NETWORK_IDS = ["linkedin"] as const;

export type NetworkId = (typeof NETWORK_IDS)[number];

export type NetworkEntry = {
  readonly id: NetworkId;
  /**
   * Canonical post identity. Every spelling of one post collapses through
   * these, because `messages.dedupe_key` is built from the result and is
   * UNIQUE — two spellings the index cannot relate is the account commenting
   * twice on one post under the owner's name.
   */
  readonly postUrn: {
    readonly parse: typeof parsePostUrn;
    readonly normalize: typeof normalizePostUrn;
    readonly assert: typeof assertPostUrn;
    readonly timestamp: typeof postUrnTimestamp;
    readonly sameMostLikelyPost: typeof sameMostLikelyPost;
  };
  /** The public link for a post — what every agent- and owner-facing surface
   *  shows, since a draft cannot be reviewed against a post you cannot open. */
  readonly postUrl: typeof linkedinPostUrl;
  /** How the network tags a person inside a comment body. */
  readonly mention: {
    readonly compose: typeof composeMentionText;
    readonly rendered: typeof renderedMentionText;
    readonly isMentionableProfileId: typeof isMentionableProfileId;
    readonly reconcileTextCandidates: typeof reconcileTextCandidates;
  };
  /**
   * The urn shape a HUMAN reads off the network and hands back as proof that a
   * message landed. Deliberately wider than `postUrn`: it accepts the comment
   * namespace, which is what an observed comment permalink carries, and which
   * no post parser should ever accept.
   */
  readonly externalUrnPattern: RegExp;
  /** Both questions are predicates rather than lists because neither is a
   *  membership test: one is subdomain-inclusive, and both must hold however
   *  the caller cased the hostname. */
  readonly hosts: {
    /** Whether a hostname is the network itself, subdomains included. The
     *  shortener is deliberately not — it is how the network points outward. */
    readonly isOwn: (host: string) => boolean;
    /** The network's own link shortener: its host, never its content. A
     *  shortened link on a post is the OUTBOUND asset the post is about. */
    readonly isShortener: (host: string) => boolean;
  };
};

const LINKEDIN_HOSTS: readonly string[] = ["linkedin.com"];
const LINKEDIN_SHORTENERS: readonly string[] = ["lnkd.in"];

export const NETWORKS: Record<NetworkId, NetworkEntry> = {
  linkedin: {
    id: "linkedin",
    postUrn: {
      parse: parsePostUrn,
      normalize: normalizePostUrn,
      assert: assertPostUrn,
      timestamp: postUrnTimestamp,
      sameMostLikelyPost,
    },
    postUrl: linkedinPostUrl,
    mention: {
      compose: composeMentionText,
      rendered: renderedMentionText,
      isMentionableProfileId,
      reconcileTextCandidates,
    },
    externalUrnPattern: /^urn:li:(?:comment|activity):\S+$/,
    hosts: {
      isOwn: (host) => {
        const lower = host.toLowerCase();
        return LINKEDIN_HOSTS.some(
          (own) => lower === own || lower.endsWith(`.${own}`),
        );
      },
      isShortener: (host) => LINKEDIN_SHORTENERS.includes(host.toLowerCase()),
    },
  },
};

/** The one network there is. A second account on LinkedIn is a second CHANNEL,
 *  not a second network — this constant is the value every channel write site
 *  stamps until a network-aware resolve replaces the read. */
export const DEFAULT_NETWORK = "linkedin" satisfies NetworkId;

export function networkFor(id: NetworkId): NetworkEntry {
  return NETWORKS[id];
}
