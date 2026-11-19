import { z } from "zod";
import { MAX_COMMENT_REPLIES, MAX_INBOX_THREADS } from "../linkedin/driver";

/**
 * What the agent reader's model answers, one strict shape per intent. Every
 * identifier is copied from an anchor of the page and every quoted word from
 * its text — which is what `verify.ts` holds each one to. A field the page
 * does not show is null, never a guess. Which comment a reply answers is not
 * the model's to say: the page's anchor says it.
 */

const Identifier = z.string().max(400);

export const CommentRepliesAnswer = z.object({
  our_comment: z.object({
    /** The item anchor of the comment named as ours. */
    urn: Identifier,
    found: z.boolean(),
    /** The reactions it shows, as the page counts them. */
    reaction_count: z.number().int().min(0).max(1_000_000).nullable(),
    /** The replies it shows it has, as the page counts them. */
    reply_count: z.number().int().min(0).max(1_000_000).nullable(),
  }),
  replies: z
    .array(
      z.object({
        urn: Identifier,
        author_profile: Identifier,
        author_name: z.string().max(200).nullable(),
        text: z.string().min(1).max(3_000),
        time_label: z.string().max(40).nullable(),
      }),
    )
    .max(MAX_COMMENT_REPLIES),
});
export type CommentRepliesAnswer = z.infer<typeof CommentRepliesAnswer>;

export const InboxAnswer = z.object({
  threads: z
    .array(
      z.object({
        thread_id: z.string().max(200).nullable(),
        participants: z
          .array(z.object({ name: z.string().min(1).max(200), profile: Identifier.nullable() }))
          .min(1)
          .max(20),
        group: z.boolean(),
        /** The card's last-message line, without a "You:" in front. */
        last_message_excerpt: z.string().max(1_000),
        last_message_from_self: z.boolean(),
        unread: z.boolean(),
      }),
    )
    .max(MAX_INBOX_THREADS),
});
export type InboxAnswer = z.infer<typeof InboxAnswer>;

export const DmThreadAnswer = z.object({
  /** Everyone in it but the connected account. */
  participants: z
    .array(z.object({ name: z.string().min(1).max(200), profile: Identifier }))
    .max(50),
  group: z.boolean(),
  /** Oldest first. */
  messages: z
    .array(
      z.object({
        urn: Identifier,
        author_profile: Identifier,
        text: z.string().min(1).max(20_000),
        time_label: z.string().max(40).nullable(),
      }),
    )
    .max(200),
});
export type DmThreadAnswer = z.infer<typeof DmThreadAnswer>;
