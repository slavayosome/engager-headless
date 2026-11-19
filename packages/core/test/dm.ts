import { asc, eq } from "drizzle-orm";
import { campaigns, conversationEvents, conversations, type ConversationRow } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { catalogStepTemplate } from "../strategy/addStep";
import { LIVE_READ_RECORDS } from "../strategy/catalog";
import { modesByKey, type CampaignAgentStrategy } from "../strategy/contract";
import { withActionModes } from "../strategy/strategy.fixture";
import { observeInbox } from "../conversations/inbox";
import type { DmMessage, DmThreadRead, InboxThread } from "../linkedin/driver";
import { dmWordsHash } from "../linkedin/driver";
import { alwaysOpenAccountDefault, liveAmbassador, type LedgerFixture } from "./actions";
import { withEntryBoundary } from "./boundary";
import { FakeLLM } from "./fakes";
import { conversationCorrelation } from "../agentStep/wait";

/**
 * The DM's fixtures: the live Ambassador of `test/actions.ts` with Handle a
 * reply and Continue in DMs as they ship — Add step's templates, their entries
 * and tools untouched, so a wake reaches Continue in DMs only as the server
 * routes one there — with DM and Follow-up at Ask me; the person's
 * conversation with the account, bound the way production binds one (an
 * inbox read over `MockDriver`); and DM's record, shipped for a suite about
 * what follows its first send.
 */

export const OWNER = "riley-owner";
export const THREAD = "2-RE1hdGEtdGhyZWFk";

/** Handle a reply and Continue in DMs as they ship, DM and Follow-up at Ask
 *  me, the follow-up policy the spec proposes. */
export function withContinueInDms(doc: CampaignAgentStrategy): CampaignAgentStrategy {
  const handle = catalogStepTemplate("handle_reply");
  const dms = catalogStepTemplate("continue_in_dms");
  return withActionModes(
    {
      ...doc,
      steps: [handle.step, { ...dms.step, instructions: "Keep it short." }],
      action_bindings: [...handle.bindings, ...dms.bindings],
      grants: [...new Set([...doc.grants, ...handle.grants, ...dms.grants])],
      dm: { outgoing_acceptance: "wait_for_interest", incoming_linked_opener: true },
      followup: { max_count: 1, delay_hours: 72, requires_explicit_interest: true },
    },
    // The steps replace the document's own, at the modes it held for each
    // action — the way they were inherited once — with these at Ask me.
    { ...modesByKey(doc), public_reply: "review", dm: "review", followup: "review" },
  );
}

/** Ship DM's and Follow-up's records (INV-31), for a suite about what follows
 *  their first send. Returns the undo. */
export function recordDmLiveChecks(): () => void {
  const before = { dm: LIVE_READ_RECORDS.send_dm, followup: LIVE_READ_RECORDS.followup };
  LIVE_READ_RECORDS.send_dm = "test";
  LIVE_READ_RECORDS.followup = "test";
  return () => {
    LIVE_READ_RECORDS.send_dm = before.dm;
    LIVE_READ_RECORDS.followup = before.followup;
  };
}

/** A live Ambassador hired to continue in DMs, with one observed reply on one
 *  conversation. */
export function dmAmbassador(
  accountDefault: CampaignAgentStrategy | null = alwaysOpenAccountDefault(),
  edit: (doc: CampaignAgentStrategy) => CampaignAgentStrategy = (doc) => doc,
): Promise<LedgerFixture> {
  return liveAmbassador(accountDefault, (doc) => edit(withContinueInDms(doc)));
}

let sequence = 0;

/** A message in the conversation, the person's unless `fromSelf`. */
export function message(f: LedgerFixture, text: string, over: Partial<DmMessage> = {}): DmMessage {
  sequence += 1;
  return {
    messageId: `urn:li:msg_message:(urn:li:fsd_profile:x,2-d${sequence})`,
    fromSelf: false,
    authorProfileId: f.conversation.authorProfileId,
    text,
    textHash: dmWordsHash(text),
    sentAt: Date.now() - 60_000 + sequence,
    observedAt: Date.now(),
    ...over,
  };
}

/** The conversation as a read of it shows it: the account and the person. */
export function conversation(
  f: LedgerFixture,
  messages: DmMessage[],
  over: Partial<DmThreadRead> = {},
): DmThreadRead {
  const person = f.conversation.authorProfileId;
  return {
    threadId: THREAD,
    participants: [
      { profileId: OWNER, profileUrl: `https://www.linkedin.com/in/${OWNER}/`, displayName: "Riley Owner", isSelf: true },
      {
        profileId: person,
        profileUrl: `https://www.linkedin.com/in/${person}/`,
        displayName: `Name of ${person}`,
        isSelf: false,
      },
    ],
    group: false,
    messages,
    complete: true,
    composer: { hasDraft: false },
    observedAt: Date.now(),
    sessionId: "session-a",
    pageFingerprint: "0123456789abcdef",
    selectorPack: "linkedin-2026-10-12.1",
    ...over,
  };
}

function card(last: DmMessage, person: string): InboxThread {
  return {
    threadId: THREAD,
    participants: [{ profileId: null, profileUrl: null, displayName: `Name of ${person}` }],
    group: false,
    lastMessage: { textHash: last.textHash, fromSelf: last.fromSelf, at: last.sentAt },
    unread: !last.fromSelf,
  };
}

/** The conversation as LinkedIn's conversation data lists it: the person by
 *  profile id, `last` itself and the one message unread, no draft, never read
 *  by the owner — enough, on a bound conversation, to stand for its read. */
function listedCard(last: DmMessage, person: string): InboxThread {
  return {
    threadId: THREAD,
    participants: [
      { profileId: person, profileUrl: `https://www.linkedin.com/in/${person}/`, displayName: `Name of ${person}` },
    ],
    group: false,
    lastMessage: {
      textHash: last.textHash,
      fromSelf: last.fromSelf,
      at: last.sentAt,
      messageId: last.messageId,
      text: last.text,
      authorProfileId: last.authorProfileId,
    },
    unread: true,
    unreadCount: 1,
    lastReadAt: null,
    hasDraft: false,
  };
}

/** The conversation as LinkedIn's conversation data lists one the owner has
 *  with the person: by their member urn alone, `last` itself and the one
 *  message unread. */
function memberCard(last: DmMessage, person: string, memberUrn: string): InboxThread {
  const listed = listedCard(last, person);
  return {
    ...listed,
    participants: [{ profileId: null, profileUrl: null, displayName: `Name of ${person}`, memberUrn }],
    lastMessage: { ...listed.lastMessage, authorProfileId: null },
  };
}

/** The verdict a message whose words say `quote` gets, as `label`. */
export function says(label: "busy" | "interest" | "question" | "greeting" | "opt_out", quote: string) {
  return { evidence: [{ quote, supports: label }], greeting: label === "greeting", [label]: true };
}

/**
 * The person writes `messages` in their conversation — the fake's thread
 * holds them behind its inbox card — and the Ambassador's inbox read records
 * them, classified by `llm`, on their conversation. With `listed`, the card is
 * LinkedIn's conversation data, whose last message stands for the read of a
 * bound conversation; with `memberUrn`, that data naming the person by it
 * alone; `cardOver` changes what the card says beside. Returns the conversation
 * after.
 */
export async function inboxRead(
  f: LedgerFixture,
  llm: FakeLLM,
  messages: DmMessage[],
  over: Partial<DmThreadRead> = {},
  {
    listed = false,
    memberUrn,
    cardOver = {},
  }: { listed?: boolean; memberUrn?: string; cardOver?: Partial<InboxThread> } = {},
): Promise<ConversationRow> {
  const existing = f.driver.dmThreads.get(THREAD);
  const before = existing && !(existing instanceof Error) ? existing.messages : [];
  const all = [...before, ...messages.filter((m) => !before.some((b) => b.messageId === m.messageId))];
  f.driver.dmThreads.set(THREAD, conversation(f, all, over));
  f.driver.inbox = {
    threads: [
      {
        ...(memberUrn !== undefined
          ? memberCard(all.at(-1)!, f.conversation.authorProfileId, memberUrn)
          : (listed ? listedCard : card)(all.at(-1)!, f.conversation.authorProfileId)),
        ...cardOver,
      },
    ],
    truncated: false,
    observedAt: Date.now(),
    sessionId: "session-a",
    pageFingerprint: "0123456789abcdef",
    selectorPack: "linkedin-2026-10-12.1",
  };
  const [campaign] = await withOrg(f.orgId, (tx) => tx.select().from(campaigns).where(eq(campaigns.id, f.campaignId)));
  await withEntryBoundary(
    () =>
      observeInbox({
        organizationId: f.orgId,
        campaign: campaign!,
        grant: f.grant,
        llm,
        runId: null,
        now: Date.now(),
        sleep: async () => undefined,
      }),
    { organizationId: f.orgId },
  );
  return (await withOrg(f.orgId, (tx) => tx.select().from(conversations).where(eq(conversations.id, f.conversation.id))))[0]!;
}

/** The person asks to try it in their conversation: the thread binds, and
 *  their interest stands on the conversation. */
export async function interestedInDms(f: LedgerFixture, words = "Could I try it on my own account?") {
  const llm = new FakeLLM();
  llm.reading = says("interest", words);
  const asked = message(f, words);
  const conversation = await inboxRead(f, llm, [asked]);
  const [event] = await withOrg(f.orgId, (tx) =>
    tx
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.providerEventId, asked.messageId))
      .orderBy(asc(conversationEvents.id)),
  );
  return { conversation, asked, event: event! };
}

/** The calls Continue in DMs makes to answer: draft a DM from the
 *  conversation (all of it, or the `threadIds` named), then send that draft —
 *  or follow up with it. */
export function dmCalls(
  conversationId: number,
  send: "send_dm" | "followup" = "send_dm",
  ctaAssetId: string | null = null,
  threadIds: string[] = [],
) {
  return [
    {
      proposed_tool_calls: [
        {
          call_id: "d1",
          tool: "draft_dm",
          version: 1,
          target: { kind: "dm_thread", ref: conversationCorrelation(conversationId) },
          inputs: [{ name: "thread", source: "context", ref: "dm_thread", ids: threadIds }],
          cta_asset_id: ctaAssetId,
        },
      ],
    },
    {
      proposed_tool_calls: [
        {
          call_id: "s1",
          tool: send,
          version: 1,
          target: { kind: "dm_thread", ref: conversationCorrelation(conversationId) },
          inputs: [{ name: "draft", source: "output", ref: "d1", ids: [] }],
          cta_asset_id: ctaAssetId,
        },
      ],
    },
    { status: "waiting" },
  ];
}
