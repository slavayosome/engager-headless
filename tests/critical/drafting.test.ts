import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@engager/database";
import { actions, draftAttempts, draftPlans, compiledWritingRules, messages, voiceSamples, channels, feedback, campaignGuidance, composerDrafts, leadSignals } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { withEntryBoundary } from "../../packages/core/test/boundary";
import { askedRedraft, grantComment, matchedPost, openerWorld, queueShownComment, runWorker, servedLead, verifiedThread, LeadDriver } from "../../packages/core/test/leadScout";
import { previewCommentDrafts } from "../../packages/core/workers/draftPreview";
import { answerVoiceSample, writeVoiceSamples } from "../../packages/core/voice/samples";
import { ensureDefaultVoice } from "../../packages/core/voice";
import { ownerStatedAnchor } from "../../packages/core/learning/calibrateVoice";
import { voiceBrainTools } from "../../packages/core/mcp/v2/knowledge/voiceBrain";
import { redraftAskedComments } from "../../packages/core/workers/commentRedraft";
import { brokerTurn } from "../../packages/core/test/chatBroker";
import { setCampaignStatusOp } from "../../packages/core/operations/campaigns";
import { saveOwnerComment } from "../../packages/core/operations/clientDrafting";
import { setGuidance } from "../../packages/core/learning/guidance";
import { rulesInputs, warmCompiledRules } from "../../packages/core/dispatcher/phase";
import { retrieveKnowledgeFromSnapshot, storeKnowledge, type KnowledgeRow } from "../../packages/core/brain/knowledge";
import { FakeLLM } from "../../packages/core/test/fakes";
import { afterAnswering, dispatcherLLM, GROUNDED, holdAnswers } from "../../packages/core/test/dispatcherLlm";
import { boxKey, composerFor } from "../../packages/core/composer/drafts";
import { requestComposerAngle } from "../../packages/core/composer/requests";
import { decideMessage } from "../../packages/core/test/decisions";
import { approvedComment } from "../../packages/core/test/comment";
import { applyPreparedCampaignDistillation, prepareCampaignDistillation, writePreparedCampaignDistillation } from "../../packages/core/learning/distill";
import { compiledRulesFor } from "../../packages/core/dispatcher/compile";
import { writeStepDm, writeStepReply } from "../../packages/core/agentStep/writing";
import { writeStepRoomReply } from "../../packages/core/agentStep/roomWriting";
import { writeConversationWords, type ConversationWordsInput } from "../../packages/core/dispatcher/conversationWords";
import { assertJudgedWords, landedJudged } from "../../packages/core/dispatcher/landedJudge";
import { writeLeadBoxWords } from "../../packages/core/leads/scout/openerDrafts";
import { pacingPolicy } from "../../packages/core/ratelimit/ledger";
import { beatAgent, injectedConnector, v2call } from "../../packages/core/test/mcpHarness";
import { leadOpenersOwed, runLeadOpenerPhase } from "../../packages/core/workers/phases";
import { setKillSwitch } from "../../packages/core/ratelimit/killswitch";
import { stopScope } from "../../packages/core/actions/pause";

let vaultDir: string;
beforeEach(() => { vaultDir = mkdtempSync(join(tmpdir(), "engager-drafting-")); vi.stubEnv("ENGAGER_BRAIN_DIR", vaultDir); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(vaultDir, { recursive: true, force: true }); });
afterAll(() => pool.end());
describe("drafting preview", () => {
  it("ranks post-relevant facts above newer unrelated notes and keeps constraints", async () => {
    const row = (id: number, slot: KnowledgeRow["slot"], content: string, updatedAt: number): KnowledgeRow => ({ id, slot, content, updatedAt, title: null, tags: null, source: "manual", sourcePath: null, createdAt: updatedAt });
    const notes = await retrieveKnowledgeFromSnapshot([row(1, "expertise", "Hiring engineers for small teams", 1), row(2, "expertise", "Pricing plans", 2), row(3, "avoid", "Never disclose customers", 3)], { queryText: "Hiring engineers", k: 1 });
    expect(notes.map((note) => note.content)).toEqual(["Never disclose customers", "Hiring engineers for small teams"]);
  });

  it("uses the dispatcher and keeps no drafts, plans, samples or compiled rules", async () => withEntryBoundary(async () => {
    const { orgId, campaignId, campaign } = await openerWorld({ comment: "review" });
    const lead = await servedLead(orgId, campaignId);
    await withOrg(orgId, async (tx) => {
      await setGuidance(tx, campaignId, "- Ask about the operational cost.");
      await storeKnowledge(tx, { slot: "expertise", content: "Interview moderators can affect answers", source: "manual" });
      expect((await rulesInputs(tx, campaign)).campaignRules).toContainEqual(expect.objectContaining({ source: "learned_guidance", text: "Ask about the operational cost." }));
    });
    const fullText = "We ran the interviews in a research environment with a moderator watching every session. The later sentence is only in the full read.";
    const post = await matchedPost(orgId, campaignId, { authorProfileId: lead.profileId, contentText: "We ran interviews.", verifyVerdict: "confirmed", verifiedAt: Date.now(), authorName: lead.name });
    await verifiedThread(orgId, post, fullText);
    const { llm, asked, judgePrompts, writerPrompts } = dispatcherLLM([GROUNDED]);
    const result = await withEntryBoundary(() => previewCommentDrafts(orgId, { discoveredPostId: post.id }, llm, { now: Date.now() }));
    if ("refused" in result) throw new Error(result.refused.message);
    const facts = { source: "owner_facts", text: "Interview moderators can affect answers" };
    expect(result.variants[0]?.candidates[0]).toMatchObject({ outcome: "admitted", unplanned: null, planLines: expect.stringContaining("Build on this point"), plan: { point: { quotes: expect.arrayContaining([facts]) } } });
    expect([asked, judgePrompts[0], writerPrompts[0]]).toEqual([expect.arrayContaining(["dispatcher.judge@5"]), expect.stringContaining(fullText), expect.stringContaining(fullText)]);
    expect(writerPrompts[0]).toContain(facts.text);
    // An answer to a sample is a relearn anchor, never a sample of the owner's writing.
    const sample = result.variants[0]!.candidates[0]!.attempts[0]!.text;
    const voice = await withOrg(orgId, async (tx) => { const { id } = await ensureDefaultVoice(tx); expect(await answerVoiceSample(tx, { voiceId: id, text: sample, soundsLikeMe: true })).toEqual({ revision: expect.any(Number) }); return (await ensureDefaultVoice(tx)).styleRules; });
    expect(ownerStatedAnchor(voice ?? {})).toMatchObject({ role: "anchor", texts: [expect.stringContaining(`“${sample}”`)] });
    expect(voiceBrainTools.find((tool) => tool.name === "save_voice")?.input?.parse({ styleRules: { sampleAnswers: [] } })).toEqual({ styleRules: {} });
    for (const table of [messages, draftAttempts, draftPlans, voiceSamples, compiledWritingRules]) expect(await withOrg(orgId, (tx) => tx.select().from(table))).toEqual([]);
    const input = await withOrg(orgId, async (tx) => ({ campaignId, channel: "comment" as const, ...(await rulesInputs(tx, campaign)) }));
    await compiledRulesFor(orgId, llm, input);
    const [compiled] = await withOrg(orgId, (tx) => tx.select().from(compiledWritingRules));
    expect(JSON.stringify(compiled!.rules)).toContain("Ask about the operational cost.");
    const before = asked.filter((ref) => ref === "dispatcher.compile@1").length;
    await compiledRulesFor(orgId, llm, input);
    expect(asked.filter((ref) => ref === "dispatcher.compile@1")).toHaveLength(before);
  }), 120_000);
});

const OPENER = "Stitching board reports from HubSpot sounds painful. What takes the most time?";

// In lead mode Ask me keeps the opener in Leads; Automatic queues a capped unattended comment.
async function checkLeadOpener(mode: "review" | "auto" | "withheld" | "compare" | "style") {
  const { orgId, campaignId } = await openerWorld({ comment: mode === "auto" ? "auto" : "review" }, { minActionGapSec: 0 });
  const lead = await servedLead(orgId, campaignId, { headline: "Finance Manager at Arcwell" });
  const workerId = await grantComment(orgId, campaignId);
  const { llm, asked, judgePrompts } = dispatcherLLM([OPENER], mode === "withheld", mode === "style");
  const driver = new LeadDriver();
  let previewPlan: unknown;
  if (mode === "compare") {
    await beatAgent(orgId);
    const [signal] = await withOrg(orgId, (tx) => tx.select().from(leadSignals).where(eq(leadSignals.leadId, lead.id)));
    expect(await withEntryBoundary(() => writeVoiceSamples(orgId, { voiceId: null, exclude: [] }, llm))).toMatchObject({ samples: [{ key: `signal:${signal!.id}` }] });
    const preview = await withEntryBoundary(() => previewCommentDrafts(orgId, { leadId: lead.id, signalId: signal!.id }, llm));
    if ("refused" in preview) throw new Error(preview.refused.message);
    previewPlan = preview.variants[0]!.candidates[0]!.plan;
    for (const table of [draftPlans, draftAttempts, compiledWritingRules]) expect(await withOrg(orgId, (tx) => tx.select().from(table))).toEqual([]);
  }
  await runWorker(orgId, workerId, driver, llm);
  expect([asked, judgePrompts[0], driver.posted]).toEqual([expect.arrayContaining(["dispatcher.plan@5", "dispatcher.write@5", "dispatcher.judge@5"]), expect.stringContaining("Finance Manager at Arcwell"), []]);
  await withOrg(orgId, async (tx) => {
    const attempts = await tx.select().from(draftAttempts);
    const rows = await tx.select().from(messages);
    if (mode === "compare") return expect((await tx.select().from(draftPlans))[0]?.plan).toEqual(previewPlan);
    const key = boxKey({ kind: "lead", leadId: lead.id });
    const box = (await composerFor(tx, [key])).get(key);
    if (mode === "withheld") {
      expect(attempts.map((attempt) => attempt.outcome)).toEqual(["rewrite", "withheld"]);
      expect(attempts[1]!.reason).toContain("No evidence for the claim");
      expect(rows).toEqual([]);
    } else {
      expect(attempts.at(-1)?.outcome, JSON.stringify(attempts)).toBe("admitted");
      if (mode === "style") {
        expect(attempts).toMatchObject([{ reason: expect.any(String), verdicts: expect.arrayContaining([expect.objectContaining({ item: "register", pass: false })]) }]);
        expect(["dispatcher.write@5", "dispatcher.judge@5"].map((call) => asked.filter((ref) => ref === call).length)).toEqual([1, 1]);
      }
      expect(box?.angles[0]).toMatchObject({ state: "ready", source: "agent" });
      if (mode === "review" || mode === "style") expect(rows).toEqual([]);
      else {
        expect(rows[0]).toMatchObject({ kind: "comment", status: "approved", publishOrigin: "worker" });
        expect(rows[0]!.scheduledAt).not.toBeNull();
        const [channel] = await tx.select().from(channels);
        expect(pacingPolicy(channel!, rows[0]!.publishOrigin, Date.now())).toMatchObject({ manual: false, channelDailyCapApplies: true });
        expect(await tx.select().from(actions).where(eq(actions.messageId, rows[0]!.id))).toMatchObject([{ kind: "comment", origin: "worker", status: "reserved" }]);
      }
    }
  });
}

it.each([["review", "worker drafts a lead opener for a yes"], ["auto", "worker drafts and queues a lead opener"], ["withheld", "withholds a repeated facts miss"],
  ["style", "keeps a style miss as a note without rewriting"], ["compare", "previews the same lead and signal plan the worker saves"]] as const)("%s: %s", (mode, _title) => checkLeadOpener(mode), 120_000);

it("an agent review draft keeps worker authorship", async () => {
  const { orgId, campaignId } = await openerWorld({ comment: "review" });
  await grantComment(orgId, campaignId);
  const post = await matchedPost(orgId, campaignId);
  const result = await v2call({ organizationId: orgId, ...injectedConnector(new LeadDriver()) }, "submit_draft", { ref: `post:${post.id}`, to: "review", text: "What part of the reporting takes the most time?" });
  expect(result.isError).not.toBe(true);
  await withOrg(orgId, async tx => expect(await tx.select().from(messages)).toContainEqual(expect.objectContaining({ discoveredPostId: post.id, status: "proposed", publishOrigin: "worker" })));
});

it.each(["admitted", "facts miss"] as const)("redraft and the chat broker write a comment through the dispatcher: %s", async (mode) => withEntryBoundary(async () => {
  const { orgId, campaignId } = await openerWorld({ comment: "review" });
  const { message } = await askedRedraft(orgId, campaignId, "Ask about the cost.");
  // The same words went out lately: a repeat is a note on what the owner asked for, never a rewrite.
  await withOrg(orgId, async (tx) => tx.insert(messages).values({ kind: "comment", campaignId, status: "posted", postedAt: Date.now(), publishOrigin: "worker", proposedText: OPENER, finalText: OPENER, dedupeKey: randomUUID(), discoveredPostId: (await matchedPost(orgId, campaignId)).id }));
  const { llm, asked, writerPrompts } = dispatcherLLM([OPENER], mode === "facts miss");
  const done = await redraftAskedComments({ organizationId: orgId, llm }, campaignId);
  const [row] = await withOrg(orgId, (tx) => tx.select().from(messages).where(eq(messages.id, message.id)));
  const attempts = await withOrg(orgId, (tx) => tx.select().from(draftAttempts));
  // One call writes it; the judge reads it once it lands, and the owner's yes — an "edit" that changes nothing too — waits on that judge.
  expect([writerPrompts[0], done.redrafted, asked.filter((ref) => !ref.startsWith("dispatcher.compile"))]).toEqual([expect.stringContaining("Ask about the cost."), [message.id], ["dispatcher.compose@3", "dispatcher.judge@5"]]);
  expect(row).toMatchObject({ proposedText: OPENER, status: "proposed", publishOrigin: "worker", redraftRequestId: null, error: null, draftPlanId: expect.anything() });
  expect(attempts[0]!.verdicts).toContainEqual(expect.objectContaining({ item: "repeat", pass: false }));
  const approve = expect(withOrg(orgId, (tx) => decideMessage(tx, { messageId: message.id, verdict: "edit", editedText: OPENER, decisionOrigin: "dashboard" })));
  await (mode === "admitted" ? approve.resolves.toMatchObject({ ok: true }) : approve.rejects.toMatchObject({ code: "draft_unsupported", message: expect.stringContaining("No evidence for the claim") }));
  // The chat broker, with a fake agent: for the comment box, as the chat's draft_comment tool, and for Fix, told by the server what the judge found.
  const fresh = await matchedPost(orgId, campaignId);
  const box = boxKey({ kind: "comment", discoveredPostId: fresh.id });
  const boxed = await brokerTurn(orgId, llm, { draftRequest: { kind: "comment", postId: fresh.id, deliver: "box" } });
  const tooled = await brokerTurn(orgId, llm, { calls: [{ name: "draft_comment", arguments: { ref: `post:${fresh.id}` } }, { name: "draft_message", arguments: { ref: "box:reply:1" } }] });
  await landedJudged(orgId, OPENER);
  const angles = await withOrg(orgId, async (tx) => (await composerFor(tx, [box])).get(box)?.angles ?? []);
  expect([boxed.error, angles.map((angle) => angle.text), tooled.steps[0]!.result!.content![0]!.text, tooled.steps.map((step) => step.name)]).toEqual([undefined, [OPENER], expect.stringContaining(OPENER), ["draft_comment", "draft_message"]]);
  const { turn } = await withOrg(orgId, (tx) => requestComposerAngle(tx, { box, kind: "redraft", angle: { ...angles[0]!, source: "agent" }, fix: true, by: "owner:test" }));
  await brokerTurn(orgId, llm, { draftRequest: turn! }).then(() => landedJudged(orgId, OPENER));
  expect(writerPrompts.at(-1)).toEqual(mode === "facts miss" ? expect.stringContaining("Take out what its sources do not support: No evidence for the claim") : expect.not.stringContaining("Take out"));
}), 120_000);

it("writes the opener the owner asks for in one call, and refuses to queue it untouched over a claim its judge finds unsupported", async () => withEntryBoundary(async () => {
  const { orgId, campaignId, campaign } = await openerWorld({ comment: "review" });
  const lead = await servedLead(orgId, campaignId);
  const [signal] = await withOrg(orgId, (tx) => tx.select().from(leadSignals).where(eq(leadSignals.leadId, lead.id)));
  const { llm, asked, planPrompts } = dispatcherLLM([OPENER], true);
  await warmCompiledRules(orgId, llm, campaignId);
  const judge = holdAnswers(llm, "dispatcher.judge@5");
  const before = asked.length;
  const words = await writeLeadBoxWords({ organizationId: orgId, campaign, llm, leadId: lead.id, signalId: signal!.id, now: Date.now() });
  expect([words?.text, asked.slice(before)]).toEqual([OPENER, ["dispatcher.compose@3"]]);
  const queue = (text: string) => withOrg(orgId, (tx) => queueShownComment(tx, { leadId: lead.id, text, by: "owner:test" }));
  await expect(queue(OPENER)).rejects.toMatchObject({ code: "draft_unjudged" });
  judge();
  await landedJudged(orgId, OPENER);
  await expect(queue(OPENER)).rejects.toMatchObject({ code: "draft_unsupported" });
  expect(await queue(`${OPENER} Mine now.`)).toMatchObject({ kind: "intake", result: { ok: true } });
  // More angles, twice: each new way in is named by what it speaks to, and the second is told the move the first made.
  const box = boxKey({ kind: "lead", leadId: lead.id, signalId: signal!.id });
  for (let press = 0; press < 2; press++) await brokerTurn(orgId, llm, { draftRequest: (await withOrg(orgId, (tx) => requestComposerAngle(tx, { box, kind: "more", by: "owner:test" }))).turn! });
  const named = (await withOrg(orgId, async (tx) => (await composerFor(tx, [box])).get(box)!.angles)).filter((angle) => angle.move !== null).map((angle) => angle.angle);
  expect([named, planPrompts.at(-1)]).toEqual([["Board report time", "Board report time"], expect.stringContaining("Board report time (move: question)")]);
}), 120_000);

it("lands every version a draft's conversation writes on the same angle of its box", async () => withEntryBoundary(async () => {
  const { orgId, campaignId } = await openerWorld({ comment: "review" });
  const post = await matchedPost(orgId, campaignId);
  const box = boxKey({ kind: "comment", discoveredPostId: post.id });
  const shorter = "What takes the most time in board reports?";
  const { llm, writerPrompts } = dispatcherLLM([OPENER, shorter]);
  const opened = await brokerTurn(orgId, llm, { draftRequest: { kind: "comment", postId: post.id, deliver: "box" } });
  const revise = { name: "draft_in_box", arguments: { instruction: "Make it shorter." } };
  const followUp = await brokerTurn(orgId, llm, { sessionId: opened.sessionId, calls: [revise] });
  expect([followUp.steps[0]!.result!.content![0]!.text, writerPrompts.at(-1)]).toEqual([expect.stringContaining(shorter), expect.stringContaining("Make it shorter.")]);
  const angles = await withOrg(orgId, async (tx) => (await composerFor(tx, [box])).get(box)!.angles);
  expect(angles).toEqual([expect.objectContaining({ text: shorter, versions: [OPENER, shorter], state: "ready" })]);
  // A conversation no draft opened writes in no box.
  expect((await brokerTurn(orgId, llm, { calls: [revise] })).error?.message).toBe("broker_tool_denied");
}), 120_000);

it("writes each surface through the dispatcher, and holds unsupported claims, words past a limit and sensitive words", async () => withEntryBoundary(async () => {
  const { orgId, campaign } = await openerWorld({ comment: "review" });
  const said = { post: { discoveredPostId: null, authorName: "Ann", postedAt: null, text: "Board week: We spend two days stitching board reports from HubSpot", mediaText: null }, turns: [] };
  const write = (surface: ConversationWordsInput["surface"], llm: ConversationWordsInput["llm"], over: Partial<ConversationWordsInput> = {}) =>
    writeConversationWords({ organizationId: orgId, campaign, llm, surface, conversation: said, query: "board", products: [], firstTouch: false, ...over });
  const fake = new FakeLLM();
  for (const [surface, text] of [["dm", fake.directMessage], ["followup", fake.directMessage], ["invitation", fake.invitationNote], ["reply", expect.any(String)], ["room_reply", expect.any(String)]] as const) expect((await write(surface, fake))?.text).toEqual(text);
  // A note does what its step asks, past the comment guidance and a comment's moves and style.
  const guided = (surface: "comment" | "invitation") => withOrg(orgId, async (tx) => (await rulesInputs(tx, campaign, surface, undefined, null)).campaignRules.map((rule) => rule.source));
  expect([await guided("comment"), await guided("invitation")]).toEqual([expect.arrayContaining(["campaign_guidance"]), []]);
  const asks = "Say who you are and what you build, then ask if they want to try it.";
  const note = "Hi Ann, two days on board reports hurts. Im Slava, I build a tool for that. Want to try it?";
  const stepped = dispatcherLLM([note]);
  const noted = await write("invitation", stepped.llm, { step: { id: "invitation", instructions: asks } });
  expect([noted?.text, noted?.plan.move.value, noted?.plan.step, stepped.planPrompts[0], stepped.writerPrompts[0], stepped.judgePrompts[0]]).toEqual([note, "step", asks,
    expect.stringContaining(`step: ${asks}`), expect.stringContaining("Do what this message's step asks"), expect.not.stringContaining("style.opening")]);
  await expect(write("invitation", fake, { maxChars: 20 })).rejects.toMatchObject({ code: "draft_withheld" });
  await expect(write("invitation", fake, { maxChars: 20, ownerRequested: true })).rejects.toMatchObject({ code: "draft_withheld" });
  expect((await write("dm", dispatcherLLM([OPENER], true).llm, { ownerRequested: true }))?.text).toBe(OPENER);
  await landedJudged(orgId, OPENER);
  await expect(withOrg(orgId, (tx) => assertJudgedWords(tx, OPENER))).rejects.toMatchObject({ code: "draft_unsupported" });
  const sensitive = Object.assign(new FakeLLM(), { reading: { hold: true, category: "legal" } });
  const run = { organizationId: orgId, step: { instructions: "" }, facts: [], offer: null, llm: sensitive };
  const incoming = { text: said.post.text, reading: null, sensitivity: "ok" };
  expect(await writeStepDm({ kind: "exchange", incoming } as never, run)).toMatchObject({ kind: "held" });
  expect([await writeStepDm({ kind: "conversation", held: true } as never, { ...run, llm: fake }), await writeStepReply({ incoming } as never, run)]).toMatchObject([{ kind: "held" }, { kind: "held" }]);
  await expect(writeStepRoomReply({ context: { recipient: { comment: said.post.text } } } as never, { organizationId: orgId, llm: sensitive, beforeCall: async () => true })).rejects.toMatchObject({ code: "room_sensitive_hold" });
  expect(sensitive.callLog.map((call) => call.stage)).not.toContain("dispatcher_write");
}), 120_000);

it("keeps surplus in one run and reuses it in the next through real selection", async () => withEntryBoundary(async () => {
  const { orgId, campaignId, campaign } = await openerWorld({ comment: "auto" }, { minActionGapSec: 0 });
  await withOrg(orgId, (tx) => tx.update(channels).set({ dailyCommentCap: 1 }));
  for (let i = 0; i < 3; i++) await servedLead(orgId, campaignId);
  const { llm, asked } = dispatcherLLM([OPENER]);
  const attempts = (outcome: string) => withOrg(orgId, (tx) => tx.select().from(draftAttempts).where(eq(draftAttempts.outcome, outcome as "held")));
  const run = async () => {
    const owed = await withOrg(orgId, (tx) => leadOpenersOwed(tx, campaign, Date.now()));
    await runLeadOpenerPhase(orgId, campaign, llm, owed, { runId: 1, press: { kind: "once", campaignId } });
    return owed;
  };
  expect((await run()).map((one) => one.hold === true)).toEqual([false, true, true]);
  expect(await attempts("held")).toHaveLength(2);
  const writes = asked.filter((ref) => ref === "dispatcher.write@5").length;
  expect((await run()).map((one) => one.hold === true)).toEqual([false, true]);
  expect([asked.filter((ref) => ref === "dispatcher.write@5").length, (await attempts("held")).length]).toEqual([writes, 1]);
  await withOrg(orgId, (tx) => setGuidance(tx, campaignId, "- Ask about costs."));
  await run();
  expect(await attempts("discarded")).toContainEqual(expect.objectContaining({ reason: "The strategy changed while this draft was held." }));
}), 120_000);

it.each(["kill", "pause", "stop"] as const)("admits nothing when %s lands while the writer runs", async (kind) => withEntryBoundary(async () => {
  const { orgId, campaignId, campaign } = await openerWorld({ comment: "review" });
  await servedLead(orgId, campaignId);
  expect(campaign.status).toBe("active");
  const { llm } = dispatcherLLM([OPENER]);
  afterAnswering(llm, "dispatcher.write@5", () => withOrg(orgId, async (tx) => {
    if (kind === "kill") await setKillSwitch(tx, true);
    else if (kind === "pause") await setCampaignStatusOp(tx, campaignId, "paused", Date.now(), { surface: "internal" });
    else await stopScope(tx, { scope: "campaign", scopeId: campaignId, by: "test" });
  }));
  const owed = await withOrg(orgId, (tx) => leadOpenersOwed(tx, campaign, Date.now()));
  expect([owed.length, await runLeadOpenerPhase(orgId, campaign, llm, owed, { runId: 1 })]).toMatchObject([1, { drafted: 0, queued: 0 }]);
  await withOrg(orgId, async (tx) => expect([(await tx.select().from(composerDrafts)).filter((row) => row.text !== null), await tx.select().from(messages)]).toEqual([[], []]));
}), 120_000);

it("keeps an untouched lead opener the agent's past the five-text window", async () => withEntryBoundary(async () => {
  const { orgId, campaignId, campaign } = await openerWorld({ comment: "review" }); const post = await matchedPost(orgId, campaignId);
  const texts = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"].map((w) => [1, 2, 3, 4, 5].map((n) => `${w}${n}`).join(" "));
  await withOrg(orgId, (tx) => tx.insert(composerDrafts).values({ boxKey: "lead:1:signal:1", campaignId, position: 1, angle: "Way in", text: texts[6]!, offered: texts.slice(0, 6) }));
  await withOrg(orgId, (tx) => saveOwnerComment(tx, campaign, { discoveredPostId: post.id, text: texts[6]!, assistTexts: texts, box: "lead:1:signal:1" }));
  expect(await withOrg(orgId, (tx) => tx.select().from(messages).where(eq(messages.discoveredPostId, post.id)))).toMatchObject([{ publishOrigin: "worker" }]);
}));

it("captures an owner's edited approval and skips distill until newer feedback", async () => withEntryBoundary(async () => {
  const { orgId, campaignId } = await openerWorld({ comment: "review" });
  await withOrg(orgId, async (tx) => {
    const message = await approvedComment(tx, campaignId, { proposedText: "A draft about board reports.", status: "proposed", scheduledAt: null });
    const words = "I would start with the board reporting workflow.";
    expect(await decideMessage(tx, { messageId: message.id, verdict: "approve", editedText: words, decisionOrigin: "dashboard" })).toMatchObject({ ok: true });
    const [saved] = await tx.select().from(messages).where(eq(messages.id, message.id));
    expect(saved).toMatchObject({ finalText: words, publishOrigin: "owner" });
    expect(await tx.select().from(voiceSamples)).toContainEqual(expect.objectContaining({ source: "edited_draft", text: words }));
    for (let i = 0; i < 2; i++) await tx.insert(feedback).values({ messageId: message.id, verdict: "approve", createdAt: Date.now() - 5000 });
    await setGuidance(tx, campaignId, "- Ask about workflow.");
    const llm = Object.assign(new FakeLLM(), { textReply: "- Ask about the workflow" });
    const calls = vi.spyOn(llm, "text");
    expect(await prepareCampaignDistillation(tx, campaignId)).toBeNull();
    expect(calls).not.toHaveBeenCalled();
    await tx.update(campaignGuidance).set({ updatedAt: Date.now() - 2000 }).where(eq(campaignGuidance.campaignId, campaignId));
    await tx.insert(feedback).values({ messageId: message.id, verdict: "approve", createdAt: Date.now() - 1000 });
    const distillation = await prepareCampaignDistillation(tx, campaignId);
    const rewritten = distillation && await writePreparedCampaignDistillation(distillation, llm);
    expect(rewritten).not.toBeNull();
    expect(await applyPreparedCampaignDistillation(tx, distillation!, rewritten!)).toBe(true);
    expect(await prepareCampaignDistillation(tx, campaignId)).toBeNull();
    expect(calls).toHaveBeenCalledTimes(1);
  });
}), 120_000);
