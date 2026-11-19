import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { LEAD_RATINGS, OUTCOME_TYPES, campaigns, channels, companyReads, roomMembers, incomingInvitations } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { untrusted } from "../../../ai/prompts";
import { relationshipRows, personItems } from "../../../people/inbox";
import { findPerson } from "../../../people/directory";
import { archivePerson, unarchivePerson, markPersonRead, markPersonUnread } from "../../../people/reads";
import { getLead, getFoundLead, listLeadGroup, LEAD_GROUPS, type LeadGroup, type PageLead } from "../../../leads/list";
import { markLeadRead, markLeadNew } from "../../../leads/newLeads";
import { rateLead } from "../../../leads/rating";
import { setAsideLead, bringBackLead } from "../../../leads/setAside";
import { researchSignals } from "../../../leads/scout/press";
import { askRead } from "../../../people/askedRead";
import { jobs } from "@engager/database/schema";
import { takeOverConversation, releaseConversation } from "../../../actions/takeover";
import { releaseOwnerHeldThread } from "../../../conversations/dm";
import { reopenPerson } from "../../../conversations/reopen";
import { moveWake, cancelWake } from "../../../agentStep/wakes";
import { linkInvitation } from "../../../invitations/link";
import { skipRoomPerson, unskipRoomPerson } from "../../../rooms/read";
import { excludePersonKey } from "../../../actions/ledger";
import { listEngagedProfiles, setDoNotEngage } from "../../../operations/engagedProfiles";
import { listIncomingRequests } from "../../../invitations/list";
import { roomPeoplePage } from "../../../rooms/people";
import { threadsPage, threadTurn } from "../../../operations/threads";
import { listIncomingComments } from "../../../operations/incomingComments";
import { getConversation, listConversationEvents } from "../../../conversations/read";
import { listMemory, rememberResearch } from "../../../memory/records";
import { profileReads } from "../../../operations/researchReads";
import { OUTCOME_FACTS } from "../../../conversations/outcomes";
import { recordOutcome, supersedeOutcome } from "../../../conversations/recordOutcome";
import { withHostedMcpCredentialScope } from "../../tools/hostedSpend";
import { jsonResult, errorResult } from "../../tools/util";
import { mcpOperationActor, type McpCtx } from "../../context";
import { defineTool, type V2Tool } from "../define";
import { parseRef } from "../refs";

const notFound = () => errorResult("Person not found in this organization.", { code: "not_found", status: 404 });
const offsetOf = (cursor?: string) => {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9]\d{0,6})$/.test(cursor)) throw new Error("invalid_cursor");
  return Number(cursor);
};
const nextOffset = (offset: number, limit: number, total: number) => offset + limit < total ? String(offset + limit) : null;
const structuralKeys = new Set(["ref", "memberRef", "key", "personKey", "kind", "status", "stage", "type", "mode", "verdict", "rating", "source", "view", "slot", "scope", "direction", "state", "temperature", "fit", "intent", "nextCursor", "cursor", "code", "channel", "role", "deliverable", "contextRevision", "revision", "currency"]);
const structuralKey = (key: string) => structuralKeys.has(key) || /(Id|Ids|At|Urn|Url|Ref|Key|Count|Mode|Status|Kind)$/.test(key);
const ENUM = /^[a-z][a-z_]{0,31}$/;
/** Fields the server fills from a closed vocabulary, with a LinkedIn permalink
 *  or with a hash it computed. They pass when the value has the shape of one,
 *  so words that ever land in one are still fenced. */
const serverShapes = new Map<string, RegExp>([
  ...["relationship", "derivedStage", "retentionClass", "openedFrom", "languageType"].map((key): [string, RegExp] => [key, ENUM]),
  ["url", /^https:\/\/(?:www\.)?linkedin\.com\/\S{1,500}$/], ["digest", /^[0-9a-f]{64}$/],
]);
function fenceText(value: unknown, key = ""): unknown {
  if (typeof value === "string") return value === "" || structuralKey(key) || serverShapes.get(key)?.test(value) ? value : untrusted(key.toUpperCase() || "TEXT", value);
  if (Array.isArray(value)) return value.map((item) => fenceText(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, fenceText(item, field)]));
  return value;
}

/** The most Leads a page carries: with their words, and as refs alone. A
 *  page of either stays well inside what a chat turn can carry. */
const LEADS_PAGE_MOST = 50;
const LEAD_REFS_MOST = 250;
/** How much of a lead's words a list row carries; `get_person` has them whole. */
const WORDS_SHOWN = 280;

/** A lead as a list row: who they are, where they stand and what they said. */
function leadRow(lead: PageLead, brief: boolean) {
  const mark = { ref: `lead:${lead.id}`, stage: lead.stage, fit: lead.fit, intent: lead.intent, wordsAt: lead.wordsAt, new: lead.new };
  if (brief) return mark;
  return {
    ...mark,
    personKey: lead.personKey,
    campaignId: lead.campaignId,
    name: lead.name,
    headline: lead.headline,
    title: lead.title,
    company: lead.company,
    words: lead.words === null || lead.words.length <= WORDS_SHOWN ? lead.words : `${lead.words.slice(0, WORDS_SHOWN)}…`,
    foundIn: lead.foundIn?.kind ?? null,
    rating: lead.rating,
    temperature: lead.temperature,
    researchedAt: lead.researchedAt,
    contactedAt: lead.contactedAt,
    pipelinePhase: lead.pipelinePhase,
    aside: lead.aside,
  };
}

const cut = (text: string | undefined, most: number) => (text === undefined || text.length <= most ? text : `${text.slice(0, most)}…`);

/** What Engager's own reads of LinkedIn already hold on a person: their
 *  profile as last read, and their company's page where one was read. Stored
 *  reads only; it opens nothing. */
async function storedReads(tx: Tx, profileId: string) {
  const stored = [...(await profileReads(tx, [profileId])).values()][0];
  if (!stored) return null;
  const { read, readAt } = stored;
  const ref = read.currentRole?.companyRef;
  const [company] = ref ? await tx.select().from(companyReads).where(eq(companyReads.companyRef, ref)) : [];
  return {
    readAt,
    headline: read.headline ?? null,
    about: cut(read.about, 1_500) ?? null,
    currentRole: read.currentRole ?? null,
    followers: read.followers ?? null,
    recentPosts: read.recentPosts.slice(0, 5).map((post) => ({ postedAt: post.postedAt ?? null, text: cut(post.text, 400) })),
    company: company
      ? { readAt: company.readAt, name: company.read.name ?? null, size: company.read.size ?? null, industry: company.read.industry ?? null, about: cut(company.read.about, 1_500) ?? null, followers: company.read.followers ?? null }
      : null,
  };
}

/** The most leads one filtered mark takes; past it the result says there are more. */
const MANY_LEADS_MOST = 5_000;

/** The marks many people can take at once: the ones a row of a list shows. */
type ManyMarks = { read?: boolean; archived?: boolean; setAside?: boolean; rating?: (typeof LEAD_RATINGS)[number]; doNotEngage?: boolean };

/** The marks asked of many people, or why they cannot be: a mark that is one
 *  person's own (a finding, an outcome, a wake) is never applied to a list. */
function manyMarks(marks: Record<string, unknown>): ManyMarks | string {
  const { read, archived, setAside, rating, doNotEngage, ...own } = marks as ManyMarks & Record<string, unknown>;
  if (Object.values(own).some((mark) => mark !== undefined)) return "Many people take read, archived, setAside, rating or doNotEngage.";
  const many = Object.fromEntries(Object.entries({ read, archived, setAside, rating, doNotEngage }).filter(([, mark]) => mark !== undefined)) as ManyMarks;
  return Object.keys(many).length > 0 ? many : "Give a mark: read, archived, setAside, rating or doNotEngage.";
}

/** One person's marks out of many; false where they are not there. A lead is
 *  set aside, never archived: the owner's "archive" of leads is that, so
 *  `archived` on a lead reads as it. */
async function markOne(tx: Tx, ctx: McpCtx, one: { kind: "lead"; id: number } | { kind: "person"; key: string } | { kind: string }, marks: ManyMarks): Promise<boolean> {
  const now = Date.now();
  const lead = one.kind === "lead" && "id" in one ? await getLead(tx, { leadId: one.id }) : null;
  const key = one.kind === "person" && "key" in one ? one.key : lead?.personKey;
  if (!key || (!lead && !(await findPerson(tx, key)))) return false;
  if (marks.read !== undefined) {
    if (lead) await (marks.read ? markLeadRead(tx, key, now) : markLeadNew(tx, key));
    else await (marks.read ? markPersonRead(tx, key, now) : markPersonUnread(tx, key));
  }
  const aside = lead ? (marks.setAside ?? marks.archived) : undefined;
  if (lead && aside !== undefined) await (aside ? setAsideLead(tx, { leadId: lead.id, reason: "owner", now }) : bringBackLead(tx, { leadId: lead.id }));
  if (!lead && marks.archived !== undefined) await (marks.archived ? archivePerson(tx, key, now) : unarchivePerson(tx, key));
  if (lead && marks.rating) await rateLead(tx, { leadId: lead.id, verdict: marks.rating, now });
  if (marks.doNotEngage === true) await excludePersonKey(tx, { personKey: key, by: mcpOperationActor(ctx) });
  if (marks.doNotEngage === false) {
    const person = await findPerson(tx, key);
    if (person?.profileId) await setDoNotEngage(tx, { profileId: person.profileId, doNotEngage: false });
  }
  return true;
}

/** Why some of many people did not take a mark, counted by the reason. */
type Refused = Record<string, number>;
const refusals = (refused: Refused) => Object.values(refused).reduce((sum, n) => sum + n, 0);

/** One of many: marked, not there (false), or refused by a rule of the mark
 *  itself (null, counted under its code) — a rating before Research has
 *  judged them — which stops that person and no one else. */
async function markOrRefuse(tx: Tx, ctx: McpCtx, one: Parameters<typeof markOne>[2], marks: ManyMarks, refused: Refused): Promise<boolean | null> {
  try {
    return await markOne(tx, ctx, one, marks);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.status === 404) return false;
    refused[error.code] = (refused[error.code] ?? 0) + 1;
    return null;
  }
}

/** How long the tool waits on an asked read before it says the read is still out. */
const ASKED_WAIT_MS = 45_000;

/** The owner's asked read of one person (`people/askedRead.ts`), waited on for
 *  a little: a read that lands in time comes back with what it stored. */
async function askedRead(ctx: McpCtx, signal: AbortSignal, ref: string) {
  const parsed = parseRef(ref, ["person", "lead"]);
  const pressed = await withHostedMcpCredentialScope(ctx, signal, "ops:write", async (tx) => {
    const lead = parsed.kind === "lead" ? await getLead(tx, { leadId: parsed.id }) : null;
    const key = parsed.kind === "person" ? parsed.key : lead?.personKey;
    const person = key ? await findPerson(tx, key) : null;
    const profileId = person?.profileId;
    if (!person || !profileId) return null;
    return { profileId, ...(await askRead(tx, { profileId, campaignId: lead?.campaignId ?? person.campaigns[0]?.id ?? null, now: Date.now() })) };
  });
  if (!pressed) return notFound();
  const { profileId, jobId, ...press } = pressed;
  const stored = () => withHostedMcpCredentialScope(ctx, signal, "feed:read", (tx) => storedReads(tx, profileId));
  if (press.upToDate) return jsonResult(fenceText({ ref, state: "up_to_date", ...press, profile: await stored() }));
  if (jobId === null || press.startsAt === null) return jsonResult({ ref, state: "not_queued", ...press });
  if (press.startsAt > Date.now()) return jsonResult({ ref, state: "waiting_for_hours", ...press });
  const until = Date.now() + ASKED_WAIT_MS;
  while (Date.now() < until && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const [job] = await withHostedMcpCredentialScope(ctx, signal, "feed:read", async (tx) =>
      tx.select({ status: jobs.status, result: jobs.result }).from(jobs).where(and(eq(jobs.organizationId, ctx.organizationId), eq(jobs.id, jobId))));
    if (!job || job.status === "dead") return jsonResult({ ref, state: "failed", ...press });
    if (job.status === "done") return jsonResult(fenceText({ ref, state: "read", ...press, reads: job.result, profile: await stored() }));
  }
  return jsonResult({ ref, state: "reading", ...press });
}

/** A finding as it is handed over: its topic, what was found, and the page
 *  it was read on. */
const FINDING = /^([^:\n]{2,60}):\s+([\s\S]{10,600}?)\s+\(source:\s*(https?:\/\/[^\s)]{4,500})\)$/;

/** The account a person's memory is kept on: their newest campaign's, else
 *  the organization's one. */
async function memoryChannel(tx: Tx, campaignId: number | undefined): Promise<number | null> {
  if (campaignId !== undefined) {
    const [campaign] = await tx.select({ channelId: campaigns.channelId }).from(campaigns).where(eq(campaigns.id, campaignId));
    if (campaign?.channelId != null) return campaign.channelId;
  }
  const [channel] = await tx.select({ id: channels.id }).from(channels).limit(1);
  return channel?.id ?? null;
}

export const peopleTools: readonly V2Tool[] = [
  defineTool({
    name: "list_people", kind: "read", description: "List people in an owner view. See engager-people.",
    input: z.object({ view: z.enum(["inbox", "leads", "threads", "engaged", "room", "invitations", "incoming"]), campaignId: z.number().int().positive().optional(), unread: z.boolean().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(LEAD_REFS_MOST).optional(), group: z.enum(LEAD_GROUPS).optional(), wordsBefore: z.number().int().positive().optional(), brief: z.boolean().optional() }).strict(),
    handler: async ({ ctx, signal }, input) => withHostedMcpCredentialScope(ctx, signal, "feed:read", async (tx) => {
      if (input.view !== "leads" && (input.group !== undefined || input.wordsBefore !== undefined || input.brief !== undefined)) return errorResult("group, wordsBefore and brief apply to Leads.", { code: "invalid_filter", status: 400 });
      const limit = Math.min(input.limit ?? 25, input.view !== "leads" ? 100 : input.brief ? LEAD_REFS_MOST : LEADS_PAGE_MOST);
      if (input.unread !== undefined && input.view !== "inbox" && input.view !== "leads") return errorResult("Unread applies to Inbox and Leads.", { code: "invalid_filter", status: 400 });
      if (input.view === "inbox") {
        const page = await relationshipRows(tx, { campaignId: input.campaignId, cursor: input.cursor, limit, unread: input.unread });
        return jsonResult(fenceText({ ...page, rows: page.rows.map((row) => ({ ...row, ref: `person:${row.key}` })) }));
      }
      if (input.view === "threads") {
        const page = await threadsPage(tx, { campaignId: input.campaignId, cursor: input.cursor, limit });
        return jsonResult(fenceText({ ...page, items: page.items.map((thread) => ({ ...thread, ref: thread.replies[0] ? `turn:${thread.replies[0].incoming.id}` : thread.root.kind === "discovered_post" ? `post:${thread.root.discoveredPostId}` : null })) }));
      }
      const offset = offsetOf(input.cursor);
      if (input.view === "leads") {
        const group = input.group ?? "leads";
        const page = await listLeadGroup(tx, { campaignId: input.campaignId, unread: input.unread, group, wordsBefore: input.wordsBefore, limit, offset });
        if (!page) return notFound();
        return jsonResult(fenceText({ group, rows: page.rows.map((lead) => leadRow(lead, input.brief === true)), count: page.count, counts: page.counts, nextCursor: nextOffset(offset, limit, page.count) }));
      }
      if (input.view === "engaged") {
        const page = await listEngagedProfiles(tx, { limit, offset, campaignId: input.campaignId });
        return jsonResult(fenceText({ ...page, profiles: page.profiles.map((row) => ({ ...row, ref: `person:p.${row.profileId}` })), nextCursor: nextOffset(offset, limit, page.total) }));
      }
      if (input.view === "invitations") {
        const all = await listIncomingRequests(tx, { limit: offset + limit + 1, campaignId: input.campaignId });
        const rows = all.slice(offset, offset + limit);
        return jsonResult(fenceText({ rows: rows.map((row) => ({ ...row, ref: `inv:${row.id}` })), nextCursor: all.length > offset + limit ? String(offset + limit) : null }));
      }
      if (input.view === "room") {
        const page = await roomPeoplePage(tx, { campaignId: input.campaignId, limit, offset, now: Date.now() });
        return jsonResult(fenceText({ ...page, people: page.people.map((row) => ({ ...row, ref: `person:${row.personKey}`, memberRef: `member:${row.member.roomMemberId}` })), nextCursor: nextOffset(offset, limit, page.total) }));
      }
      const page = await listIncomingComments(tx, { campaignId: input.campaignId, limit, offset });
      return jsonResult(fenceText({ ...page, rows: page.rows.map((row) => ({ ...row, ref: `turn:${row.id}` })), nextCursor: nextOffset(offset, limit, page.total) }));
    }),
  }),
  defineTool({
    name: "get_person", kind: "read", description: "Read a person and their stored evidence. See engager-people.",
    input: z.object({ ref: z.string(), include: z.array(z.enum(["conversation", "thread", "events", "signals", "memory", "profile"])).optional() }).strict(),
    handler: async ({ ctx, signal }, { ref, include }) => {
      const parsed = parseRef(ref, ["person", "lead", "turn"]);
      return withHostedMcpCredentialScope(ctx, signal, "feed:read", async (tx) => {
        if (parsed.kind === "turn") {
          const turn = await threadTurn(tx, { kind: "incoming", incomingCommentId: parsed.id });
          return turn ? jsonResult(fenceText({ ref, ...turn })) : notFound();
        }
        const lead = parsed.kind === "lead" ? await getLead(tx, { leadId: parsed.id }) : null;
        if (parsed.kind === "lead" && !lead) return notFound();
        const key = parsed.kind === "person" ? parsed.key : lead?.personKey;
        if (!key) return notFound();
        const person = await findPerson(tx, key);
        if (!person) return notFound();
        const selected = new Set(include ?? []);
        const detail = lead ?? (selected.has("signals") ? await getLead(tx, { personKey: key }) : null);
        const found = detail ? await getFoundLead(tx, key) : null;
        return jsonResult(fenceText({ ref, person, ...(detail ? { lead: { ...detail, signals: undefined, qualification: found?.evidence?.qualification ?? null } } : {}),
          ...(selected.has("signals") ? { signals: (detail?.signals ?? []).map((signal) => ({ ...signal, screen: { verdict: signal.verdict, reason: signal.dropReason ?? signal.reason }, judge: found?.evidence?.qualification ?? null })) } : {}),
          ...(selected.has("thread") ? { thread: (await personItems(tx, [person.canonicalKey])).get(person.canonicalKey) ?? null } : {}),
          ...(selected.has("conversation") ? { conversation: person.conversationId ? await getConversation(tx, person.conversationId) : null } : {}),
          ...(selected.has("events") ? { events: person.conversationId ? await listConversationEvents(tx, { conversationId: person.conversationId }) : null } : {}),
          ...(selected.has("memory") ? { memory: person.profileId ? await listMemory(tx, { personId: person.profileId }) : [] } : {}),
          ...(selected.has("profile") ? { profile: person.profileId ? await storedReads(tx, person.profileId) : null } : {}) }));
      });
    },
  }),
  defineTool({
    name: "update_person", kind: "write", description: "Apply owner marks in order; earlier marks remain if one fails. See engager-people.",
    input: z.object({ ref: z.string().optional(), refs: z.array(z.string()).min(1).max(LEAD_REFS_MOST).optional(), wordsBefore: z.number().int().positive().optional(), campaignId: z.number().int().positive().optional(), group: z.enum(LEAD_GROUPS).optional(), unread: z.boolean().optional(), view: z.enum(["leads", "inbox"]).optional(), read: z.boolean().optional(), archived: z.boolean().optional(), setAside: z.boolean().optional(), rating: z.enum(LEAD_RATINGS).optional(), doNotEngage: z.boolean().optional(), findings: z.array(z.string().max(1200)).max(5).optional(), ownership: z.enum(["take_over", "release", "hand_back"]).optional(), reopen: z.boolean().optional(), wakeAt: z.number().int().positive().optional(), cancelWake: z.boolean().optional(), outcome: z.object({ type: z.enum(OUTCOME_TYPES), occurredAt: z.number().int().positive().optional(), note: z.string().max(2000).optional(), evidenceRef: z.string().max(500).optional(), reference: z.string().max(200).optional(), customerRef: z.string().max(320).optional() }).strict().optional(), supersedes: z.number().int().positive().optional(), linkTo: z.string().optional() }).strict(),
    handler: async ({ ctx, signal }, input) => {
      const { ref, refs, wordsBefore, campaignId, group, unread, view, ...marks } = input;
      const filtered = wordsBefore !== undefined || group !== undefined || unread !== undefined || view !== undefined;
      if ([ref !== undefined, refs !== undefined, filtered].filter(Boolean).length !== 1) return errorResult("Give ref, refs, or a filter (view, group, wordsBefore, unread).", { code: "invalid_request", status: 400 });
      if (ref === undefined) {
        const many = manyMarks(marks);
        if (typeof many === "string") return errorResult(many, { code: "invalid_request", status: 400 });
        if (refs !== undefined) {
          const people = refs.map((one) => parseRef(one, ["lead", "person"]));
          if (people.some((one) => one.kind === "person") && (many.setAside !== undefined || many.rating !== undefined)) return errorResult("setAside and rating are a lead's; give lead refs.", { code: "invalid_request", status: 400 });
          return jsonResult(await withHostedMcpCredentialScope(ctx, signal, "ops:write", async (tx) => {
            const missing: string[] = [];
            const refused: Refused = {};
            for (const [at, one] of people.entries()) {
              const done = await markOrRefuse(tx, ctx, one, many, refused);
              if (done === false) missing.push(refs[at]!);
            }
            return { applied: Object.keys(many), changed: refs.length - missing.length - refusals(refused), missing, ...(refusals(refused) ? { refused } : {}) };
          }));
        }
        if (view === "inbox") {
          // Everyone on the Inbox list, or its unread: the marks its rows show.
          if (group !== undefined || wordsBefore !== undefined || many.setAside !== undefined || many.rating !== undefined) return errorResult("The Inbox takes read, archived or doNotEngage, narrowed by unread and campaignId.", { code: "invalid_request", status: 400 });
          return jsonResult(await withHostedMcpCredentialScope(ctx, signal, "ops:write", async (tx) => {
            const keys: string[] = [];
            for (let cursor: string | null = null, pages = 0; pages < 10; pages += 1) {
              const page: Awaited<ReturnType<typeof relationshipRows>> = await relationshipRows(tx, { campaignId, unread, cursor, limit: 1_000 });
              keys.push(...page.rows.map((row) => row.key));
              cursor = page.nextCursor;
              if (cursor === null) break;
            }
            let changed = 0;
            for (const key of keys) if (await markOne(tx, ctx, { kind: "person", key }, many)) changed += 1;
            return { applied: Object.keys(many), changed };
          }));
        }
        // Everyone the Leads page lists under a filter, without the list
        // crossing the wire: frozen first, a page at a time, then marked, so a
        // mark that moves people out of a group skips no one. A mark that
        // takes people off the list leaves those already contacted, and
        // counts them, unless their group is named.
        const removes = many.setAside === true || many.rating !== undefined || many.doNotEngage === true;
        if (many.setAside === false && group !== "set_aside") return errorResult("Bring people back from group set_aside.", { code: "invalid_request", status: 400 });
        const groups = group ? [group] : (["leads", "signals", "no_answer", ...(removes ? [] : ["contacted" as const])] as const);
        const result = await withHostedMcpCredentialScope(ctx, signal, "ops:write", async (tx) => {
          const frozen: Array<{ id: number; group: LeadGroup }> = [];
          let more = false;
          for (const each of groups) {
            for (let offset = 0; ; offset += LEAD_REFS_MOST) {
              const page = await listLeadGroup(tx, { campaignId, unread, group: each, wordsBefore, limit: LEAD_REFS_MOST, offset });
              if (!page) return null;
              for (const lead of page.rows) frozen.push({ id: lead.id, group: each });
              if (page.rows.length < LEAD_REFS_MOST) break;
              if (frozen.length >= MANY_LEADS_MOST) { more = true; break; }
            }
          }
          const byGroup: Partial<Record<LeadGroup, number>> = {};
          const refused: Refused = {};
          for (const lead of frozen) if ((await markOrRefuse(tx, ctx, { kind: "lead", id: lead.id }, many, refused)) === true) byGroup[lead.group] = (byGroup[lead.group] ?? 0) + 1;
          const contacted = removes && !group ? await listLeadGroup(tx, { campaignId, unread, group: "contacted", wordsBefore, limit: 1 }) : null;
          return { applied: Object.keys(many), changed: Object.values(byGroup).reduce((sum, n) => sum + (n ?? 0), 0), byGroup, ...(refusals(refused) ? { refused } : {}), ...(more ? { more } : {}), ...(contacted ? { contactedLeft: contacted.count } : {}) };
        });
        return result ? jsonResult(result) : notFound();
      }
      const parsed = parseRef(ref, ["person", "lead", "member", "inv"]);
      const exists = await withHostedMcpCredentialScope(ctx, signal, "ops:write", async (tx) => {
        if (parsed.kind === "person") return (await findPerson(tx, parsed.key)) !== null;
        if (parsed.kind === "lead") return (await getLead(tx, { leadId: parsed.id })) !== null;
        if (parsed.kind === "inv") return (await tx.select({ id: incomingInvitations.id }).from(incomingInvitations).where(eq(incomingInvitations.id, parsed.id))).length > 0;
        if (parsed.kind === "member" && /^[1-9]\d{0,14}$/.test(parsed.memberId)) return (await tx.select({ id: roomMembers.id }).from(roomMembers).where(eq(roomMembers.id, Number(parsed.memberId)))).length > 0;
        return false;
      });
      if (!exists) return notFound();
      const applied: string[] = [];
      for (const field of ["read", "archived", "setAside", "rating", "doNotEngage", "findings", "ownership", "reopen", "wakeAt", "cancelWake", "outcome", "supersedes", "linkTo"] as const) {
        if (input[field] === undefined) continue;
        try {
          await withHostedMcpCredentialScope(ctx, signal, "ops:write", async (tx) => {
            const lead = parsed.kind === "lead" ? await getLead(tx, { leadId: parsed.id }) : null;
            const key = parsed.kind === "person" ? parsed.key : lead?.personKey;
            if (parsed.kind === "lead" && !lead) throw new Error("not_found");
            if (field === "read" && key) {
              if (parsed.kind === "lead") await (input.read ? markLeadRead(tx, key, Date.now()) : markLeadNew(tx, key));
              else await (input.read ? markPersonRead(tx, key, Date.now()) : markPersonUnread(tx, key));
            } else if (field === "archived" && key) await (input.archived ? archivePerson(tx, key, Date.now()) : unarchivePerson(tx, key));
            else if (field === "setAside" && parsed.kind === "lead") {
              const result = input.setAside ? await setAsideLead(tx, { leadId: parsed.id, reason: "owner", now: Date.now() }) : await bringBackLead(tx, { leadId: parsed.id });
              if (!result) throw new Error("not_found");
            } else if (field === "rating" && parsed.kind === "lead" && input.rating) {
              if (!await rateLead(tx, { leadId: parsed.id, verdict: input.rating, now: Date.now() })) throw new Error("not_found");
            } else if (field === "doNotEngage" && key) {
              if (input.doNotEngage) await excludePersonKey(tx, { personKey: key, by: mcpOperationActor(ctx) });
              else {
                const person = await findPerson(tx, key);
                if (!person?.profileId) throw new Error("not_found");
                await setDoNotEngage(tx, { profileId: person.profileId, doNotEngage: false });
              }
            } else if (field === "findings" && input.findings && key) {
              // What a look-up the owner asked for found, kept on the person
              // with where it was read: an inference, never their words.
              const person = await findPerson(tx, key);
              const channelId = await memoryChannel(tx, person?.campaigns[0]?.id);
              if (!person?.profileId || channelId === null) throw new Error("not_found");
              const now = Date.now();
              for (const finding of input.findings) {
                const [, topic, text, source] = FINDING.exec(finding.trim()) ?? [];
                if (!topic || !text || !source) throw new Error('A finding reads "topic: what was found (source: https://…)".');
                await rememberResearch(tx, { channelId, personId: person.profileId, topic, value: `${text} (source: ${source})`, source, now });
              }
            } else if (field === "setAside" && parsed.kind === "member" && /^[1-9]\d*$/.test(parsed.memberId) && Number.isSafeInteger(Number(parsed.memberId))) {
              if (input.setAside) await skipRoomPerson(tx, Number(parsed.memberId));
              else await unskipRoomPerson(tx, Number(parsed.memberId));
            } else if (field === "linkTo" && parsed.kind === "inv" && input.linkTo) {
              const target = parseRef(input.linkTo, ["person"]);
              const person = target.kind === "person" ? await findPerson(tx, target.key) : null;
              if (!person?.conversationId) throw new Error("not_found");
              await linkInvitation(tx, { id: parsed.id, conversationId: person.conversationId, by: mcpOperationActor(ctx) });
            } else if (field === "outcome" && input.outcome && key) {
              const person = await findPerson(tx, key);
              if (!person?.conversationId) throw new Error("not_found");
              const now = Date.now();
              const { type, ...details } = input.outcome;
              const result = input.supersedes
                ? await supersedeOutcome(tx, { ...details, type, eventId: input.supersedes, conversationId: person.conversationId, occurredAt: details.occurredAt ?? now, recordedBy: mcpOperationActor(ctx), now })
                : (OUTCOME_FACTS as readonly string[]).includes(type)
                  ? await recordOutcome(tx, { ...details, type: type as (typeof OUTCOME_FACTS)[number], conversationId: person.conversationId, occurredAt: details.occurredAt ?? now, recordedBy: mcpOperationActor(ctx), now })
                  : null;
              if (!result) throw new Error("invalid_outcome");
              if (!result.ok) throw new Error(result.reason);
            } else if (field === "supersedes" && input.outcome) {
              // The preceding outcome operation applies the correction atomically.
            } else if (["ownership", "reopen", "wakeAt", "cancelWake"].includes(field) && key) {
              const person = await findPerson(tx, key);
              if (!person?.conversationId) throw new Error("not_found");
              const common = { conversationId: person.conversationId, by: mcpOperationActor(ctx), now: Date.now() };
              if (field === "ownership") {
                if (input.ownership === "take_over") await takeOverConversation(tx, common);
                else if (input.ownership === "release") await releaseConversation(tx, common);
                else await releaseOwnerHeldThread(tx, common);
              } else if (field === "reopen" && input.reopen) await reopenPerson(tx, common);
              else if (field === "wakeAt" && input.wakeAt !== undefined) await moveWake(tx, { ...common, at: input.wakeAt });
              else if (field === "cancelWake" && input.cancelWake) await cancelWake(tx, common);
            } else throw new Error("field_not_applicable");
          });
          applied.push(field);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = message === "not_found" || message === "This person is gone." || (error instanceof AppError && error.status === 404) ? "not_found" : error instanceof AppError ? error.code : "field_failed";
          return errorResult(message, { code, ...(code === "not_found" ? { status: 404 } : {}), data: { field, applied } });
        }
      }
      return jsonResult({ ref: input.ref, applied });
    },
  }),
  defineTool({
    name: "research_person", kind: "linkedin", description: "Queue the owner's research press within the account's read budget; `read` re-reads one named person's profile and company page on the owner's ask. See engager-people.",
    input: z.object({ campaignId: z.number().int().positive().optional(), refs: z.array(z.string()).min(1).max(10).optional(), newest: z.number().int().min(1).max(10).optional(), read: z.string().optional() }).strict(),
    handler: async ({ ctx, signal }, input) => {
      if (input.read !== undefined) {
        if (input.refs !== undefined || input.newest !== undefined) return errorResult("Give read alone.", { code: "invalid_request", status: 400 });
        return askedRead(ctx, signal, input.read);
      }
      if (input.campaignId === undefined) return errorResult("Give campaignId.", { code: "invalid_request", status: 400 });
      const campaignId = input.campaignId;
      if ((input.refs === undefined) === (input.newest === undefined)) return errorResult("Give refs or newest.", { code: "invalid_request", status: 400 });
      const ids = input.refs?.map((ref) => { const parsed = parseRef(ref, ["lead"]); if (parsed.kind !== "lead") throw new Error("invalid_ref"); return parsed.id; });
      const result = await withHostedMcpCredentialScope(ctx, signal, "ops:write", async (tx) => {
        // Research reads a Signal's profile: anyone named who is past that
        // stage is said to be, where the press would only leave them out.
        const past: Array<{ ref: string; stage: string }> = [];
        if (ids) for (const id of ids) {
          const lead = await getLead(tx, { leadId: id });
          if (!lead || lead.campaignId !== campaignId) return null;
          if (lead.stage !== "signal") past.push({ ref: `lead:${id}`, stage: lead.stage });
        }
        const pressed = await researchSignals(tx, ids ? { campaignId, leadIds: ids, now: Date.now() } : { campaignId, newest: input.newest!, now: Date.now() });
        return pressed && ids ? { ...pressed, alreadyResearched: past } : pressed;
      });
      return result ? jsonResult(result) : notFound();
    },
  }),
];
