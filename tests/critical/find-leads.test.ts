import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@engager/database";
import { actions, candidateResearch, discoveredPosts, conversationEvents, leads, leadSignals, searches, messages, rateLimitLedger, roomSnapshots } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { runPeople } from "../../packages/core/leads/scout/queues";
import { mkOrg } from "../../packages/core/test/db";
import { FakeLLM } from "../../packages/core/test/fakes";
import { frozenIdsIn } from "../../packages/core/test/firstLook";
import { addPhrase, commentOf, leadCampaign, leadIdIn, LeadDriver, leadBalance, leadRuns, postOf, runWorker, threadOf } from "../../packages/core/test/leadScout";
import { buildMcpCtx } from "../../packages/core/mcp/context";
import { parse, v2call } from "../../packages/core/test/mcpHarness";
import { runSteps } from "../../packages/core/test/leadSteps";

afterAll(() => pool.end());

/** A model that screens by what the words say. */
function screening(): FakeLLM {
  const llm = new FakeLLM();
  llm.leadScreen = (user) =>
    frozenIdsIn(user).map((signalId) => {
      const block = user.split(`- id: ${signalId}\n`)[1]!.split(/\n- id: /)[0]!;
      if (block.includes("👏")) return { signalId, verdict: "drop", dropReason: "no_own_words" };
      if (block.includes("our platform")) return { signalId, verdict: "drop", dropReason: "selling_similar", role: "competitor" };
      if (block.includes("hiring")) return { signalId, verdict: "drop", dropReason: "recruiter" };
      return { signalId, verdict: "pass", languageType: block.includes("Looking for a tool") ? "direct_ask" : "pain", role: "buyer" };
    });
  llm.leadQualify = (user) => {
    const asks = user.includes("Looking for a tool");
    return { leadId: leadIdIn(user), role: "buyer", fit: "strong", intent: asks ? "asking" : "problem", quote: asks ? "Looking for a tool to build board reports." : "Monthly close reporting is eating my week again.",
      reasons: [{ text: "Finance Manager at Arcwell, inside your audience.", source: "profile", ref: null, inferred: false }], unknown: "Who signs off on tools.", thread: null,
      angles: [{ name: "Answer the ask", why: "Name the tool and why it needs no analyst." }] };
  };
  return llm;
}

describe("a Find leads run, end to end", { timeout: 120_000 }, () => {
  it("reads and hands off, then the steps screen, read, judge and serve, and the rows say what each did", async () => {
    const organizationId = await mkOrg();
    const { campaignId, scoutId } = await leadCampaign(organizationId, { start: true });
    await addPhrase(organizationId, campaignId, { term: "eating my week" });
    await addPhrase(organizationId, campaignId, { term: "tool for board reporting", languageType: "direct_ask" });
    const ravi = postOf({ authorProfileId: "ravi", metrics: { comments: 3 } });
    const rival = postOf({ authorProfileId: "rival", contentText: "Try our platform for monthly close." });
    const asker = postOf({ authorProfileId: "priya", contentText: "Looking for a tool to build board reports.", postedAt: Date.now() - 7_200_000 });
    const recruiter = postOf({ authorProfileId: "recruiter", contentText: "We are hiring a controller." });
    const driver = new LeadDriver({ pages: { "eating my week": [[ravi, rival]], "tool for board reporting": [[asker, recruiter]] }, threads: [threadOf(ravi.postUrn, [commentOf({ authorProfileId: "lea", text: "Same here, it takes us a week." }), commentOf({ authorProfileId: "fan", text: "👏" })])] });
    // One of the people found is already a lead, from a reply to the owner's comment.
    await withOrg(organizationId, (tx) => tx.insert(leads).values({ profileId: "lea", name: "Lea Fischer" }));
    const llm = screening();

    await runWorker(organizationId, scoutId, driver, llm);

    // The run only read: two pages of two posts, and a thread of two comments.
    const [row] = await leadRuns(organizationId, scoutId);
    expect(row).toMatchObject({ status: "succeeded", phase: "done", searchDepth: "standard", servedStepIds: ["find_leads"], error: null,
      searchPagesCount: 2, threadReadsCount: 1, leadReadCount: 4 + 2, leadFoundCount: 6,
      leadMergedCount: 0, profileReadsCount: 0, leadResearchedCount: 0, leadBuyerCount: 0 });
    expect(llm.leadScreenPrompts).toEqual([]);
    await withOrg(organizationId, async (tx) => {
      expect(await tx.select().from(leadSignals).where(eq(leadSignals.campaignId, campaignId))).toHaveLength(6);
      expect(await tx.select().from(leads)).toHaveLength(1);
    });

    expect(await runSteps(organizationId, campaignId, driver, llm)).toEqual(["lead_screen", "research_signals", "lead_judge"]);
    const receipt = parse(await v2call(buildMcpCtx(organizationId), "get_run", { runId: row!.id, include: ["items"] }));
    expect(receipt.items).toEqual(expect.arrayContaining([expect.objectContaining({ verdict: "passed", ref: expect.stringMatching(/^lead:/) })]));
    // The run's own person counters are zeros here (the steps count from the rows), so the read leaves them off and carries the tally.
    expect(receipt.run).not.toHaveProperty("leadScreenedInCount");
    expect(receipt).toMatchObject({ run: { leadFoundCount: 6 }, counts: { found: 6, screenedIn: 3 } });
    // A person's enums and permalinks read as plain values; what they wrote stays fenced.
    const priya = parse(await v2call(buildMcpCtx(organizationId), "get_person", { ref: "person:p.priya", include: ["signals"] }));
    expect(priya).toMatchObject({ person: { relationship: "unknown", name: expect.stringContaining("untrusted") },
      signals: [{ languageType: "direct_ask", url: expect.stringMatching(/^https:\/\/www\.linkedin\.com\//), words: expect.stringContaining("untrusted") }] });
    expect(llm.leadQualifyPrompts).toHaveLength(1);
    expect(llm.leadQualifyPrompts[0]!.match(/^leadId: \d+$/gm)).toHaveLength(2);

    await withOrg(organizationId, async (tx) => {
      // The ledger holds the reads the run counts, and the two profiles the step read, and nothing else.
      const ledger = await tx.select().from(rateLimitLedger);
      expect(ledger.filter((entry) => entry.action === "discover")).toHaveLength(row!.searchPagesCount);
      expect(ledger.filter((entry) => entry.action === "thread_read")).toHaveLength(row!.threadReadsCount);
      // The two who were not leads already: a profile read each.
      expect(ledger.filter((entry) => entry.action === "profile_read")).toHaveLength(2);
      expect(ledger).toHaveLength(row!.searchPagesCount + row!.threadReadsCount + 2);
      expect((await tx.select().from(leads)).map((lead) => [lead.profileId, lead.stage ?? "relationship", lead.fit, lead.intent, lead.intentQuote]).sort()).toEqual([["lea", "relationship", null, null, null],
        ["priya", "lead", "strong", "asking", "Looking for a tool to build board reports."], ["ravi", "lead", "strong", "has_problem", "Monthly close reporting is eating my week again."]]);
      const signals = await tx.select().from(leadSignals).where(eq(leadSignals.campaignId, campaignId));
      expect(signals.filter((signal) => signal.verdict === "dropped").map((signal) => signal.dropReason).sort()).toEqual(["no_own_words", "recruiter", "selling_similar"]);
      expect(signals.map((signal) => signal.verdict).sort()).toEqual(["dropped", "dropped", "dropped", "passed", "passed", "passed"]);
      // The sweep row tags these people; the later jobs own their outcomes.
      const people = (await runPeople(tx, campaignId, [row!.id])).get(row!.id)!;
      expect(people).toMatchObject({ found: 6, screenedIn: 3, researched: 2, buyers: 2, dropped: { no_own_words: 1, selling_similar: 1, recruiter: 1 }, leads: { asking: 1, has_problem: 1 } });
      expect(leadBalance(people)).toEqual({ found: true, researched: true });
      // Each served lead has one conversation event, and nothing was sent for them.
      expect((await tx.select().from(conversationEvents)).map((event) => event.type)).toEqual(["lead_served", "lead_served"]);
      // Nothing of Find posts', and nothing that sends.
      for (const table of [discoveredPosts, candidateResearch, roomSnapshots, messages, actions]) expect(await tx.select().from(table), String(table)).toEqual([]);
    });
    expect(driver.posted).toEqual([]);
    expect(driver.profileReads, "the direct ask is read before newer pain").toEqual(["priya", "ravi"]);

    // Later, the same map again: the same people, once, a thread still inside its window is not read and
    // nobody already served is read or served again.
    await withOrg(organizationId, (tx) => tx.update(searches).set({ status: "active", cursor: null }));
    await runWorker(organizationId, scoutId, driver, llm);
    const [, again] = await leadRuns(organizationId, scoutId);
    expect(again).toMatchObject({ status: "succeeded", searchPagesCount: 2, threadReadsCount: 0, leadFoundCount: 0 });
    await runSteps(organizationId, campaignId, driver, llm);
    await withOrg(organizationId, async (tx) => {
      expect(await tx.select().from(leadSignals).where(eq(leadSignals.campaignId, campaignId))).toHaveLength(6);
      expect(await tx.select().from(leads)).toHaveLength(3);
      expect(await tx.select().from(rateLimitLedger).where(eq(rateLimitLedger.action, "profile_read"))).toHaveLength(2);
    });
    await withOrg(organizationId, tx => tx.insert(leadSignals).values(Array.from({ length: 101 }, (_, i) => ({
      campaignId, runId: row!.id, personKey: `p.page-${i}`, profileId: `page-${i}`, kind: "post" as const,
      postUrn: `urn:li:activity:${100000 + i}`, words: "A signal", verdict: "dropped" as const, dropReason: "not_audience" as const,
    }))));
    const first = parse(await v2call(buildMcpCtx(organizationId), "get_run", { runId: row!.id, include: ["items"] }));
    const second = parse(await v2call(buildMcpCtx(organizationId), "get_run", { runId: row!.id, include: ["items"], cursor: first.nextCursor }));
    const items = [...first.items as { ref: string }[], ...second.items as { ref: string }[]];
    expect(items).toHaveLength(107);
    expect(new Set(items.map(item => item.ref)).size).toBe(items.length);
    expect(second.nextCursor).toBeNull();
    const other = await mkOrg();
    expect((await v2call(buildMcpCtx(other), "get_run", { runId: row!.id })).isError).toBe(true);
  });
});
