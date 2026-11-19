import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  workerRuns,
  campaigns,
  channels,
  candidateResearch,
  discoveredPosts,
  leads,
  leadSignals,
  messages,
  searches,
  type Lead,
  type Search,
  type ScoutIntent,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { audienceProfile, editableAudience } from "../audience/model";
import { saveAudience } from "../audience/write";
import { activateStrategy } from "../strategy/activate";
import { addStepPatch } from "../strategy/addStep";
import type { ActionMode, CatalogStepId } from "../strategy/catalog";
import type { CampaignAgentStrategy } from "../strategy/contract";
import { STRATEGY_PATCH, applyPatchOps, readPatchState, type PatchOp } from "../strategy/patch";
import { submitStrategyPatch } from "../strategy/submit";
import type { AuthorProfileRead, CompanyPageRead, DiscoverParams, DiscoverResult, DriverPost, PostThread } from "../linkedin/driver";
import { MockDriver } from "../linkedin/mock";
import { emptyLeadCounts } from "../leads/scout/counts";
import { mergeSignals } from "../leads/scout/merge";
import type { RunPeople } from "../leads/scout/queues";
import { queueLeadComment } from "../leads/queue";
import { leadOpener, putLeadAngles } from "../leads/scout/opener";
import { writeSignal, type SignalInput } from "../leads/scout/signals";
import { getCampaign } from "../operations/campaigns";
import { requireSavedCampaign, saveCampaign } from "../operations/saveCampaign";
import { ambassadorIdFor, scoutIdFor } from "../operations/workers";
import { injectedGrant } from "../jobs/context";
import { handleWorkerRun } from "../jobs/handlers/workerRun";
import type { LLM } from "../ai/client";
import { section14AccountDefault } from "../strategy/strategy.fixture";
import { mkOrg } from "./db";
import { withEntryBoundary } from "./boundary";
import { activateChannelAccount, stageStrategyVersion } from "./strategies";
import { startAsOwner } from "./startCampaign";

/**
 * A CAMPAIGN THAT FINDS LEADS, for the suites that run one: switched, given
 * its Find leads step at the modes asked, and started — or left waiting for
 * its Start, for a test before it. Its Scout is the worker a run is for.
 */
export async function leadCampaign(
  organizationId: string,
  opts: {
    find?: "on" | "off";
    research?: "on" | "off";
    /** The Company page read, which a Deep search has on. */
    company?: "on" | "off";
    start?: boolean;
    instructions?: string;
    maxPostAgeDays?: number;
    searchDepth?: "quick" | "standard";
  } = {},
): Promise<{ campaignId: number; scoutId: number }> {
  const campaignId = await withOrg(organizationId, async (tx) => {
    const saved = await saveCampaign(tx, organizationId, {
      createFields: {
        name: `Leads ${randomUUID().slice(0, 8)}`,
        maxPostAgeDays: opts.maxPostAgeDays ?? 30,
      },
      depth: opts.searchDepth ?? "standard", source: "form", actor: "owner",
      strategyPatch: (id, state) => {
          // The add-step template seeds both reads Off; the modes asked are said on
          // the patch, as the Strategy would say them.
          const modes: Record<string, "on" | "off"> = { find_leads: opts.find ?? "on", lead_research: opts.research ?? "on", lead_company: opts.company ?? "off" };
          const added = addStepPatch({
            campaignId: id,
            expectedBaseVersion: state.active.version,
            document: state.base,
            catalogStep: "find_leads",
          });
          return {
            ...added,
            ops: added.ops.map((op): PatchOp => {
              if (op.op !== "add") return op;
              const binding = op.path.match(/^\/action_bindings\/(\w+)$/)?.[1];
              if (binding && modes[binding]) return { ...op, value: { ...(op.value as object), mode: modes[binding] } };
              if (op.path === "/steps/find_leads" && opts.instructions !== undefined) {
                return { ...op, value: { ...(op.value as object), instructions: opts.instructions } };
              }
              return op;
            }),
          };
      },
    }, "test");
    return requireSavedCampaign(saved).campaign!.id;
  });
  if (opts.start) await startAsOwner(organizationId, campaignId);
  const scoutId = await withOrg(organizationId, (tx) => scoutIdFor(tx, campaignId));
  if (scoutId === null) throw new Error("a campaign is created with its Scout");
  return { campaignId, scoutId };
}

/**
 * A started campaign that finds leads, whose Ambassador answers a served lead:
 * Comment on posts on their post, and Meet the room under their comment where
 * asked, each at the mode asked. Find leads is Off, and Research and the Company
 * page read are On only where Meet the room needs them. `ceilings` are the
 * Comment's opener ceilings the owner changed; an intent left out reads its
 * default.
 */
export async function openerCampaign(
  organizationId: string,
  modes: {
    comment: "off" | "review" | "auto";
    room?: "off" | "review" | "auto";
    reply?: "off" | "review" | "auto";
    ceilings?: Partial<Record<ScoutIntent, ActionMode>>;
  },
): Promise<{ campaignId: number }> {
  const { campaignId } = await leadCampaign(organizationId, { find: "off", research: modes.room ? "on" : "off", company: modes.room ? "on" : "off" });
  await withOrg(organizationId, async (tx) => {
    const steps: Array<[CatalogStepId, Record<string, "off" | "review" | "auto">]> = [
      ["comment_on_posts", { comment: modes.comment, like_post: "off" }],
    ];
    if (modes.reply) steps.push(["handle_reply", { reply: modes.reply, like_reply: "off" }]);
    if (modes.room) steps.push(["meet_the_room", { reply_to_commenter: modes.room, invite_from_room: "off" }]);
    for (const [catalogStep, staged] of steps) {
      const state = await readPatchState(tx, campaignId, { lock: false });
      const patch = addStepPatch({
        campaignId,
        expectedBaseVersion: state.active.version,
        document: state.base,
        catalogStep,
        staged: { modes: staged },
      });
      await submitStrategyPatch(tx, organizationId, patch, { approver: "test", now: Date.now(), draft: true });
    }
    if (modes.ceilings) {
      const path = "/action_bindings/comment/intent_ceilings";
      await submitStrategyPatch(
        tx,
        organizationId,
        {
          kind: STRATEGY_PATCH,
          campaignId,
          expectedBaseVersion: (await readPatchState(tx, campaignId, { lock: false })).active.version,
          ops: [{ op: "add", path, value: modes.ceilings }],
          dependencyVersions: { voice: null, knowledge: null, memory: null },
          provenance: {
            instruction: "who gets an opener",
            recognizedIntent: { summary: "who gets an opener", paths: [path] },
            scope: { stepId: null },
            compilerVersion: "test/1",
          },
        },
        { approver: "test", now: Date.now(), draft: true },
      );
    }
  });
  await startAsOwner(organizationId, campaignId);
  return { campaignId };
}

/** An org with an opener campaign running, and the campaign as it stands. */
export async function openerWorld(modes: Parameters<typeof openerCampaign>[1], org: Parameters<typeof mkOrg>[0] = {}) {
  const orgId = await mkOrg(org);
  const { campaignId } = await openerCampaign(orgId, modes);
  const campaign = (await withOrg(orgId, (tx) => getCampaign(tx, campaignId)))!;
  return { orgId, campaignId, campaign };
}

/** The words a served lead said, unless a case says others. */
export const SERVED_WORDS = "Board week is the worst week of our month. We spend two days stitching board reports from HubSpot.";

/**
 * A Lead Scout served on this campaign, as serve leaves one: asking, with a
 * strong fit, unless `over` says otherwise; their words a post of theirs, or
 * a comment under someone else's; the one way in their box holds.
 */
export async function servedLead(
  organizationId: string,
  campaignId: number,
  over: Partial<typeof leads.$inferInsert> = {},
  kind: "post" | "comment" = "post",
): Promise<Lead> {
  return withOrg(organizationId, async (tx) => {
    const profileId = `lead-${randomUUID().slice(0, 8)}`;
    const [lead] = await tx
      .insert(leads)
      .values({
        profileId, name: "Priya Shah", campaignId, origin: "find_leads", stage: "lead", role: "buyer", fit: "strong",
        intent: "asking", intentQuote: "We spend two days stitching board reports", intentAt: 1, touchCount: 0, ...over,
      })
      .returning();
    await tx.insert(leadSignals).values({
      campaignId, personKey: `p.${profileId}`, profileId, kind, postUrn: `urn:li:activity:${randomUUID()}`,
      commentUrn: kind === "comment" ? `urn:li:comment:${randomUUID()}` : null, words: SERVED_WORDS, verdict: "passed",
      role: "buyer", languageType: "direct_ask", leadId: lead!.id,
    });
    await putLeadAngles(tx, lead!, [{ name: "Answer her ask", why: "Say what eats board week, from her words." }]);
    return lead!;
  });
}

/** What Scout's verify read of a post found: its full text, as a thread. */
export async function verifiedThread(organizationId: string, post: { id: number; campaignId: number | null; postUrn: string }, fullText: string) {
  await withOrg(organizationId, (tx) => tx.insert(candidateResearch).values({ campaignId: post.campaignId!, discoveredPostId: post.id,
    thread: { postUrn: post.postUrn, fullText, counts: { reactions: 0, comments: 0, reposts: 0 }, comments: [] },
    threadReadAt: Date.now(), play: "early_question", alreadySaid: [], verdict: "confirmed", verifiedBy: "server" }));
}

/** A matched post on the campaign, as Scout leaves one for a comment. */
export async function matchedPost(
  organizationId: string,
  campaignId: number,
  over: Partial<typeof discoveredPosts.$inferInsert> = {},
) {
  const [post] = await withOrg(organizationId, (tx) =>
    tx
      .insert(discoveredPosts)
      .values({
        campaignId, postUrn: `urn:li:activity:${randomUUID()}`, authorProfileId: `author-${randomUUID().slice(0, 8)}`,
        authorName: "Priya Shah", contentText: SERVED_WORDS, status: "new", agentScore: 0.9,
        postedAt: Date.now(), discoveredAt: Date.now(), ...over,
      })
      .returning(),
  );
  return post!;
}

/** A worker's comment waiting for a yes, on a post the owner asked to have
 *  written again with this note. */
export async function askedRedraft(organizationId: string, campaignId: number, note: string) {
  const post = await matchedPost(organizationId, campaignId);
  const [message] = await withOrg(organizationId, (tx) =>
    tx
      .insert(messages)
      .values({
        kind: "comment", campaignId, discoveredPostId: post.id, proposedText: "Old words.", status: "proposed",
        publishOrigin: "worker", dedupeKey: randomUUID(), redraftRequestId: randomUUID(), redraftRequestVersion: 1,
        redraftRequestNote: note, redraftRequestedAt: Date.now(), redraftRequestedBy: "owner:test",
      })
      .returning(),
  );
  return { post, message: message! };
}

/** The campaign's strategy with these Ambassador steps added, each sending
 *  at the mode given, in force from now. */
export async function withAmbassadorSteps(
  orgId: string,
  campaignId: number,
  steps: ReadonlyArray<readonly [CatalogStepId, string, ActionMode]>,
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const version = await stageStrategyVersion(
      tx,
      campaignId,
      (document) => {
        let next = document;
        for (const [catalogStep, binding, mode] of steps) {
          const patch = addStepPatch({
            campaignId,
            expectedBaseVersion: next.version,
            document: next,
            catalogStep,
            staged: { modes: { [binding]: mode } },
          });
          const applied = applyPatchOps(next, patch.ops);
          if (!applied.ok) throw new Error(`cannot add ${catalogStep}`);
          next = { ...applied.document, grants: [...next.grants, ...(patch.requestedGrants?.add ?? [])] } as CampaignAgentStrategy;
        }
        return next;
      },
      Date.now() - 1_000,
    );
    await activateStrategy(tx, { campaignId, version });
  });
}

/**
 * Priya, a Signal asking on her own post, in a started campaign that finds
 * leads, whose Comment on posts and Connect send at the modes given — a step
 * not given is not in the campaign.
 */
export async function openerFixture(
  modes: { comment?: ActionMode; invite?: ActionMode } = { comment: "review", invite: "review" },
): Promise<{ orgId: string; campaignId: number; lead: Lead; signalId: number }> {
  const orgId = await mkOrg();
  const { campaignId } = await leadCampaign(orgId, { start: true });
  await withAmbassadorSteps(orgId, campaignId, [
    ...(modes.comment ? [["comment_on_posts", "comment", modes.comment] as const] : []),
    ...(modes.invite ? [["connect", "invite", modes.invite] as const] : []),
  ]);
  const { lead, signalId } = await screenedLead(orgId, campaignId, "priya", {
    postUrn: `urn:li:activity:${randomUUID()}`,
    words: "Can anyone recommend something that doesn’t need an analyst?",
    languageType: "direct_ask",
  });
  return { orgId, campaignId, lead, signalId };
}

/** A comment press as Leads makes one: on the post the lead's box was drawn
 *  for, read as the page reads it. */
export async function queueShownComment(
  tx: Tx,
  input: Omit<Parameters<typeof queueLeadComment>[1], "signalId">,
): ReturnType<typeof queueLeadComment> {
  const opener = await leadOpener(tx, input.leadId, input.now ?? Date.now());
  return queueLeadComment(tx, { ...input, signalId: opener?.signal.id ?? 0 });
}

/** Where Priya commented, as a reply's send names it: the comment and her
 *  member urn. The account is `fixture-owner`, as `test/roomReply.ts` has it. */
export const LEAD_COMMENT = "urn:li:comment:lead-parent";
export const LEAD_MEMBER = "urn:li:fsd_profile:lead-priya";

/**
 * Priya, a Signal asking in a comment under someone else's post, in a started
 * campaign that finds leads, whose Meet the room replies and Connect invites at
 * the modes given — a step not given is not in the campaign.
 */
export async function replyFixture(
  modes: { reply?: ActionMode; invite?: ActionMode } = { reply: "review", invite: "review" },
): Promise<{ orgId: string; campaignId: number; lead: Lead; signalId: number; postUrn: string }> {
  const orgId = await mkOrg();
  const { campaignId } = await leadCampaign(orgId, { start: true, company: modes.reply ? "on" : "off" });
  await withAmbassadorSteps(orgId, campaignId, [
    ...(modes.reply ? [["meet_the_room", "reply_to_commenter", modes.reply] as const] : []),
    ...(modes.invite ? [["connect", "invite", modes.invite] as const] : []),
  ]);
  await withOrg(orgId, (tx) => tx.update(channels).set({ externalAccountId: "fixture-owner", executionAccountId: "fixture-owner" }));
  // A post urn the send path accepts: an activity id is digits.
  const postUrn = `urn:li:activity:${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 15)}`)}`;
  const { lead, signalId } = await screenedLead(orgId, campaignId, "priya", {
    kind: "comment",
    postUrn,
    commentUrn: LEAD_COMMENT,
    memberUrn: LEAD_MEMBER,
    words: "Can anyone recommend something for month-end that doesn’t need an analyst?",
    languageType: "direct_ask",
  });
  return { orgId, campaignId, lead, signalId, postUrn };
}

/** The pains a campaign's audience holds, saved as the owner saves them. */
export async function withPains(
  organizationId: string,
  campaignId: number,
  pains: Array<{ id: string; text: string; phrases?: string[]; status?: "active" | "retired" }>,
): Promise<void> {
  await withOrg(organizationId, async (tx) => {
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
    const profile = audienceProfile(campaign!);
    await saveAudience(tx, organizationId, campaignId, {
      baseRevision: profile.revision,
      profile: {
        ...editableAudience(profile),
        testSource: "derived",
        who: { summary: "Finance and operations leads", signals: [], companyKinds: [] },
        pains: pains.map((pain) => ({ id: pain.id, text: pain.text, phrases: pain.phrases ?? [], source: "owner", status: pain.status ?? "active" })),
      },
    });
  });
}

/** One row of a campaign's search map, a Pain phrase unless it says
 *  otherwise. */
export async function addPhrase(
  organizationId: string,
  campaignId: number,
  over: Partial<typeof searches.$inferInsert> = {},
): Promise<Search> {
  return withOrg(organizationId, async (tx) => {
    const term = over.term ?? `phrase ${randomUUID().slice(0, 8)}`;
    const [row] = await tx
      .insert(searches)
      .values({
        campaignId,
        sourceKey: `kw:${term}`,
        lane: "keywords",
        term,
        languageType: "pain",
        origin: "pains",
        ...over,
      })
      .returning();
    return row!;
  });
}

/**
 * A person whose words passed the screen and who is merged into a Signal: the
 * state Research starts from. `over` changes the words they said, or what the
 * screen made of them.
 */
export async function screenedLead(
  organizationId: string,
  campaignId: number,
  profileId: string,
  over: Partial<SignalInput> & { runId?: number } = {},
): Promise<{ lead: Lead; signalId: number }> {
  const written = await withOrg(organizationId, (tx) =>
    writeSignal(tx, {
      campaignId,
      profileId,
      name: profileId,
      headline: "Finance · Operations",
      kind: "post",
      postUrn: `urn:li:activity:${randomUUID()}`,
      words: "Monthly close reporting is eating my week again.",
      verdict: "passed",
      role: "buyer",
      languageType: "pain",
      ...over,
    }),
  );
  if (!written.written) throw new Error(`not written: ${written.reason}`);
  await mergeSignals({
    organizationId,
    campaign: { id: campaignId },
    depth: "standard",
    counts: emptyLeadCounts(),
    report: async () => {},
    continueRun: async () => true,
  });
  const lead = await withOrg(organizationId, async (tx) =>
    (await tx.select().from(leads).where(eq(leads.profileId, profileId)))[0],
  );
  if (!lead) throw new Error(`${profileId} was not merged into a lead`);
  return { lead, signalId: written.signal.id };
}

/** The person a qualify call was handed, read back off the `leadId:` line. */
export function leadIdIn(user: string): number {
  return Number(/^leadId: (\d+)$/m.exec(user)![1]);
}

/** A profile read of a person: a finance manager at a company of 70 to 90,
 *  unless it says otherwise. */
export function profileOf(profileId: string, over: Partial<AuthorProfileRead> = {}): AuthorProfileRead {
  return {
    profileId,
    name: profileId,
    headline: "Finance Manager at Arcwell",
    about: "I run month-end for a construction software company.",
    currentRole: { title: "Finance Manager", company: "Arcwell", companySize: "70-90" },
    followers: 380,
    country: "IE",
    recentPosts: [],
    isCompanyPage: false,
    ...over,
  };
}

/** A campaign's Scout runs, oldest first. */
export async function leadRuns(organizationId: string, scoutId: number) {
  return withOrg(organizationId, (tx) =>
    tx.select().from(workerRuns).where(eq(workerRuns.workerId, scoutId)).orderBy(workerRuns.id),
  );
}

let seq = 0;

/** A post a search returns: a person's words, fresh unless it says otherwise. */
export function postOf(over: Partial<DriverPost> = {}): DriverPost {
  const n = seq++;
  return {
    postUrn: `urn:li:activity:lead-post-${n}`,
    authorProfileId: `author-${n}`,
    authorName: `Author ${n}`,
    authorHeadline: "Finance · Operations",
    url: `https://www.linkedin.com/feed/update/urn:li:activity:lead-post-${n}`,
    contentText: "Monthly close reporting is eating my week again.",
    postedAt: Date.now() - 3_600_000,
    metrics: { comments: 0 },
    ...over,
  };
}

/** A comment a thread read returns. */
export function commentOf(over: Partial<PostThread["comments"][number]> = {}): PostThread["comments"][number] {
  const n = seq++;
  return {
    commentUrn: `urn:li:comment:(activity:lead,${n})`,
    authorProfileId: `comment-author-${n}`,
    authorName: `Comment author ${n}`,
    authorHeadline: "Operations",
    text: "We lose two days to it every month.",
    reactions: 0,
    authorReplied: false,
    isOwner: false,
    ...over,
  };
}

/** A post read in full, with the comments under it. */
export function threadOf(
  postUrn: string,
  comments: PostThread["comments"],
  over: Partial<PostThread> = {},
): PostThread {
  return {
    postUrn,
    fullText: "A post.",
    counts: { reactions: 0, comments: comments.length, reposts: 0 },
    comments,
    ...over,
  };
}

/**
 * An account whose searches answer from a script: each term's pages in order,
 * the author feeds under `author:<id>`, and the threads it can open. A term it
 * has no page for is dry, and `failures` throws for the terms it names.
 */
export class LeadDriver extends MockDriver {
  constructor(
    private readonly script: {
      pages?: Record<string, DriverPost[][]>;
      threads?: PostThread[];
      failures?: Record<string, Error>;
      /** The profiles it can read, and the ones whose read throws. */
      profiles?: AuthorProfileRead[];
      profileFailures?: Record<string, Error>;
      /** The company pages it can read, and the ones whose read throws. */
      companies?: CompanyPageRead[];
      companyFailures?: Record<string, Error>;
    } = {},
  ) {
    super({ posts: [], threads: script.threads, authors: script.profiles, companies: script.companies });
  }

  override async readAuthorProfile(profileId: string): Promise<AuthorProfileRead> {
    const read = await super.readAuthorProfile(profileId);
    const failure = this.script.profileFailures?.[profileId];
    if (failure) throw failure;
    return read;
  }

  override async readCompanyPage(companyRef: string): Promise<CompanyPageRead> {
    const read = await super.readCompanyPage(companyRef);
    const failure = this.script.companyFailures?.[companyRef];
    if (failure) throw failure;
    return read;
  }

  override async discoverPosts(params: DiscoverParams): Promise<DiscoverResult> {
    await super.discoverPosts(params);
    const key = params.kind === "author" ? `author:${params.term}` : params.term;
    const failure = this.script.failures?.[key];
    if (failure) throw failure;
    const pages = this.script.pages?.[key] ?? [];
    const page = params.cursor ? Number(params.cursor) : 0;
    return {
      posts: pages[page] ?? [],
      nextCursor: page + 1 < pages.length ? String(page + 1) : null,
      cursorState: "active",
    };
  }
}

/** Hold the driver's discovery open: `entered` settles once a run is inside it, and the run goes on when `release` is called. */
export function holdDiscovery(driver: LeadDriver) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const discover = driver.discoverPosts.bind(driver);
  driver.discoverPosts = async (params) => { enter(); await held; return discover(params); };
  return { entered, release };
}

/** The two identities everyone a run found keeps: they either passed the screen
 *  or dropped for one of six reasons, and everyone researched became a buyer, was
 *  not a fit, was a peer or a competitor, or is a possible partner. */
export function leadBalance(people: RunPeople): { found: boolean; researched: boolean } {
  return {
    found: people.found === people.screenedIn + Object.values(people.dropped).reduce((sum, n) => sum + n, 0),
    researched: people.researched === people.buyers + people.notFit + people.peers + people.partners,
  };
}

/** One wake of a worker, through the entry boundary, as its Run now does. */
export function runWorker(
  organizationId: string,
  workerId: number,
  driver: MockDriver,
  llm: LLM,
  trigger: "manual" | "schedule" | "agent" = "manual",
): Promise<unknown> {
  return withEntryBoundary(() => handleWorkerRun({ organizationId, grant: injectedGrant(driver), llm }, { workerId, trigger }));
}

/**
 * The campaign's Ambassador, once the account default is in force, which the
 * lead opener needs before it may draft.
 */
export async function grantComment(organizationId: string, campaignId: number): Promise<number> {
  return withOrg(organizationId, async (tx) => {
    const account = section14AccountDefault();
    account.grants = [...new Set([...account.grants, "grant_publish_comment" as const])];
    await activateChannelAccount(tx, account);
    return (await ambassadorIdFor(tx, campaignId))!;
  });
}
