import { loadCampaignProductContext } from "../products/queries";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { campaigns, conversations, leads } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { noteLimitFor } from "../agentStep/writing";
import { findPerson } from "../people/directory";
import { readPersonThreads, type PersonThread } from "../people/threads";
import type { BoxWords, ComposerAsk, RequestedInviteWords } from "./requestedDraft";
import { runSpokenWords } from "./requestedWords";

/**
 * WORDS FOR AN INVITE THE OWNER IS WRITING — the person header's Draft for me,
 * in the box for the note. Their own agent, in the chat dock, writes one note
 * from what they and the account have said to each other in public, and the
 * words go back to the box as the turn's last text: raw material, written
 * nowhere. No draft, action, request or sample records them. What is queued is
 * only what the owner presses Send invite on (`ownerInvite`), measured there
 * for how much of these words it kept.
 *
 * The dispatcher writes it as it writes a step's note, in the voice of the
 * campaign the person's conversation belongs to, else the one that touched
 * them last. Someone the owner never exchanged a word with gets a note from
 * their profile line alone; nothing is invented for it to cite.
 */

export const RequestedInviteNote = z.object({ text: z.string().trim().min(1).max(300) }).strict();

/** The most threads, and of each the most of what was said, the note may
 *  cite; and the most of any one thing said. */
const THREADS = 3;
const SAID = 6;
const CLIP = 300;

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP).trimEnd()}…` : text;
}

/** What they and the account have said to each other under posts, the newest
 *  thread first — null where nothing was. */
function exchangeOf(threads: readonly PersonThread[]): string | null {
  const blocks = [...threads]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, THREADS)
    .flatMap((thread) => {
      const said = thread.events
        .flatMap((event) => {
          if (event.kind === "our_comment" || event.kind === "our_reply") return [`You: "${clip(event.text)}"`];
          if (event.kind === "their_reply" && event.text) return [`Them: "${clip(event.text)}"`];
          return [];
        })
        .slice(-SAID);
      if (said.length === 0) return [];
      return [[...(thread.excerpt ? [`The post: "${clip(thread.excerpt)}"`] : []), ...said].join("\n")];
    });
  return blocks.length === 0 ? null : blocks.join("\n\n");
}

/** The person to word an invite note for, in the owner's own box; refused
 *  where the box would take no words — nobody Engager knows, nobody it has a
 *  profile address for, or someone the owner chose never to engage. Nothing is
 *  filed. */
export async function prepareInviteWords(tx: Tx, request: RequestedInviteWords) {
  const person = await findPerson(tx, request.personKey);
  if (!person || person.profileId === null || person.doNotEngage) throw new Error("invite_request_closed");
  const [conversation] =
    person.conversationId === null ? [] : await tx.select().from(conversations).where(eq(conversations.id, person.conversationId));
  if (!conversation?.owningCampaignId && person.campaigns.length > 1) throw new Error("invite_campaign_ambiguous");
  const [lead] = !conversation?.owningCampaignId && person.campaigns.length === 0
    ? await tx.select({ campaignId: leads.campaignId }).from(leads).where(eq(leads.profileId, person.profileId))
    : [];
  const campaignId = conversation?.owningCampaignId ?? person.campaigns[0]?.id ?? lead?.campaignId ?? null;
  const [campaign] =
    campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error("invite_campaign_missing");
  return {
    campaign,
    person,
    interestShown: conversation?.interestEvidenceEventId != null,
    exchange: exchangeOf(await readPersonThreads(tx, person.canonicalKey)),
    products: await loadCampaignProductContext(tx, campaign.id),
    maxChars: await noteLimitFor(tx, person.profileId),
  };
}

/**
 * The owner's-box workflow for an invite's note: read who they are, have the
 * dispatcher write one note through the owner's agent, and hand the words back
 * as the turn's last text. Nothing is delivered — what the owner sends is
 * theirs, measured at the press for how much of these words it kept. An angle
 * the composer asked for (`ask`) rides beside who they are.
 */
export async function runInviteWords(deps: {
  organizationId: string;
  request: RequestedInviteWords;
  llm: LLM;
  progress: (text: string) => void;
  active?: () => Promise<void>;
  ask?: ComposerAsk;
}): Promise<BoxWords> {
  deps.progress("Reading who they are and your voice…");
  await deps.active?.();
  const { campaign, person, interestShown, exchange, products, maxChars } = await withOrg(deps.organizationId, (tx) => prepareInviteWords(tx, deps.request));
  return runSpokenWords({
    ...deps,
    text: RequestedInviteNote,
    input: {
      campaign,
      surface: "invitation",
      // Someone the owner never exchanged a word with gets a note from their
      // profile line alone; nothing is invented for it to cite.
      conversation: { post: { discoveredPostId: null, authorName: person.name, postedAt: null, text: exchange ?? `Their profile line: ${person.headline ?? person.name ?? "none"}`, mediaText: null }, turns: [] },
      query: exchange ?? person.headline ?? "",
      headline: person.headline,
      products,
      firstTouch: exchange === null,
      maxChars,
      rules: [
        exchange === null ? "No exchange is evidenced: do not imply you have spoken, and invent no shared history." : "Cite the exchange you actually had; it is the only shared conversation you may refer to.",
        interestShown ? "Interest is evidenced by their quoted words; do not expand it into a commitment." : "Product interest is not evidenced: an invitation to try the product must not claim they requested or wanted it.",
      ],
    },
  });
}
