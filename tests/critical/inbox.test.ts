import { v2call, parse } from "../../packages/core/test/mcpHarness";
import { buildMcpCtx } from "../../packages/core/mcp/context";
import { eq } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { pool } from "@engager/database";
import { actions, campaigns, channels, composerDrafts, incomingComments, conversationEvents, conversations, messages, organizations, stepRuns, stepToolCalls } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { injectedGrant } from "../../packages/core/jobs/context";
import { runOnce } from "../../packages/core/jobs/worker";
import { MockDriver } from "../../packages/core/linkedin/mock";
import { itemsReader, unreadPeopleFirst } from "../../packages/core/people/inbox";
import { observe, ownPostComment, readThread, reply, watchedComment } from "../../packages/core/test/conversation";
import { alwaysOpenAccountDefault, type LedgerFixture } from "../../packages/core/test/actions";
import { conversation, dmAmbassador, dmCalls, inboxRead, interestedInDms, message, OWNER, THREAD } from "../../packages/core/test/dm";
import { connectRead } from "../../packages/core/test/invite";
import { syncConversation } from "../../packages/core/conversations/inbox";
import { conversationEventArrived } from "../../packages/core/agentStep/wait";
import { readPersonMessaging } from "../../packages/core/people/messages";
import { invitationFrom, invitationRows, readOf } from "../../packages/core/test/invitations";
import { recordRelationshipRead } from "../../packages/core/conversations/record";
import { canEngage } from "../../packages/core/ratelimit/ledger";
import { ownerInvite } from "../../packages/core/actions/ownerInvite";
import { invitationLooks, requestInvitationLook } from "../../packages/core/actions/invite";
import { prepareDmWords } from "../../packages/core/chat/requestedDm";
import { dispatchAction, drainActions } from "../../packages/core/execution/actionGate";
import { resolveOutcome } from "../../packages/core/operations/outcomes";
import { observeIncomingInvitations } from "../../packages/core/invitations/observe";
import { reserveAcceptance } from "../../packages/core/invitations/accept";
import { withEntryBoundary } from "../../packages/core/test/boundary";
import { mkOrg } from "../../packages/core/test/db";
import { activateChannelAccount, hireStep } from "../../packages/core/test/strategies";
import { FakeLLM } from "../../packages/core/test/fakes";
import { leadCampaign } from "../../packages/core/test/leadScout";
import { startAsOwner } from "../../packages/core/test/startCampaign";
import { handleProcessIncomingPhased } from "../../packages/core/jobs/handlers/processIncoming";
import { modeFor } from "../../packages/core/strategy/mode";

afterAll(() => pool.end());

/** A started campaign whose Reply step is hired at `mode`, on an account that grants public replies. */
async function replyCampaign(mode: "review" | "auto" | "off") {
  const orgId = await mkOrg();
  const { campaignId } = await leadCampaign(orgId, { find: "off", research: "off" });
  await withOrg(orgId, async (tx) => {
    await hireStep(tx, orgId, campaignId, "handle_reply", { reply: mode, like_reply: "off" });
    const account = alwaysOpenAccountDefault();
    await activateChannelAccount(tx, { ...account, grants: [...account.grants, "grant_public_reply"] });
  });
  await startAsOwner(orgId, campaignId);
  return { orgId, campaignId };
}

it("holds an own-post reply on Ask me", async () => {
  const { orgId } = await replyCampaign("auto");
  const policy = { mode: "review", sensitivity_gate: true, prompt: "Reply warmly." } as const;
  await withOrg(orgId, async (tx) => {
    await tx.update(organizations).set({ ownPostReplies: policy }).where(eq(organizations.id, orgId));
    expect((await modeFor(tx, { ownPost: policy })).effective).toBe("review");
  });
  const incomingId = await ownPostComment(orgId, { commentUrn: "urn:li:comment:5678", authorProfileId: "person", text: "How did you do that?" });
  const driver = new MockDriver();
  await withEntryBoundary(() => handleProcessIncomingPhased({ organizationId: orgId, grant: injectedGrant(driver), llm: new FakeLLM() }, { incomingCommentId: incomingId }), { organizationId: orgId });
  expect(await withOrg(orgId, (tx) => tx.select().from(messages).where(eq(messages.incomingCommentId, incomingId)))).toMatchObject([{ status: "proposed", publishOrigin: "worker" }]);
  expect(driver.posted).toEqual([]);
  const heldId = await ownPostComment(orgId, { commentUrn: "urn:li:comment:5679", authorProfileId: "person2", text: "My lawyer will call." });
  const heldLlm = Object.assign(new FakeLLM(), { reading: { hold: true, category: "legal" } });
  await withEntryBoundary(() => handleProcessIncomingPhased({ organizationId: orgId, grant: injectedGrant(driver), llm: heldLlm }, { incomingCommentId: heldId }), { organizationId: orgId });
  await withOrg(orgId, async (tx) => {
    expect(await tx.select().from(messages).where(eq(messages.incomingCommentId, heldId))).toEqual([]);
    expect((await tx.select().from(incomingComments).where(eq(incomingComments.id, heldId)))[0]).toMatchObject({ sensitivity: "hold" });
  });
});

it.each(["review", "auto", "off"] as const)("records a reply once with Reply %s", async (mode) => {
  const { orgId, campaignId } = await replyCampaign(mode);
  expect((await withOrg(orgId, (tx) => modeFor(tx, { campaignId, capability: "reply_public", target: "their_reply" })))?.effective ?? "off").toBe(mode);
  const f = await watchedComment(orgId, campaignId);
  const incoming = reply(f, "9001", "How did you define useful?");
  await readThread(f, [incoming]);
  await readThread(f, [incoming]);
  const llm = new FakeLLM();
  const target = { kind: "their_reply", ref: incoming.replyUrn };
  llm.agentStepResults = [
    { proposed_tool_calls: [{ call_id: "draft", tool: "draft_comment", version: 1, target, inputs: [{ name: "thread", source: "context", ref: "verified_thread", ids: [] }], cta_asset_id: null }] },
    { proposed_tool_calls: [{ call_id: "reply", tool: "reply_public", version: 1, target, inputs: [{ name: "draft", source: "output", ref: "draft", ids: [] }], cta_asset_id: null }] },
    { status: "waiting", rationale_summary: "Their move.", wait: { event: "direct_reply", expires_in_hours: 48, wake_at: null, on_timeout: "escalate", evidence_refs: [], quote: null } },
  ];
  for (let i = 0; i < 10; i++) if (!(await runOnce({ grant: f.grant, llm }, { ownOrgs: new Set([orgId]) }))) break;
  await withOrg(orgId, async (tx) => {
    expect(await tx.select().from(incomingComments)).toHaveLength(1);
    const drafts = await tx.select().from(messages).where(eq(messages.kind, "reply"));
    if (mode === "off") expect(drafts).toEqual([]);
    else if (mode === "review") expect(drafts).toMatchObject([{ status: "proposed", publishOrigin: "worker" }]);
    else {
      expect(["approved", "posted"]).toContain(drafts[0]?.status);
      expect(drafts[0]).toMatchObject({ publishOrigin: "worker" });
      if (drafts[0]?.status === "approved") expect(drafts[0].scheduledAt).toEqual(expect.any(Number));
    }
    if (mode !== "off") {
      // Reply is the step's only action: the server drafts it, no agent turn, from the one stored reading.
      expect(llm.agentStepPrompts).toEqual([]);
      expect(await tx.select({ iterations: stepRuns.iterations }).from(stepRuns)).toMatchObject([{ iterations: 0 }]);
      expect(await tx.select({ tool: stepToolCalls.tool, outcome: stepToolCalls.outcome }).from(stepToolCalls)).toEqual([{ tool: "draft_comment", outcome: "dispatched" }]);
      expect(llm.callLog.filter((call) => call.stage === "incoming_reading")).toHaveLength(1);
      expect((await tx.select().from(incomingComments))[0]?.reading).toMatchObject({ kind: "reply", promptRef: expect.stringContaining("judge.incoming_reading") });
    }
    const read = await itemsReader(tx);
    const key = `p.${incoming.author.profileId.toLowerCase()}`;
    const [people] = await read([{ keys: [key] }]);
    const items = people?.get(key)?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    if (mode !== "off") expect(items.some((item) => item.refs.includes(`message:${drafts[0]!.id}`))).toBe(true);
    const unread = await unreadPeopleFirst(tx, { campaignId, limit: 50 });
    expect(unread).toMatchObject({ count: 1, rows: [{ unread: true }] });
  });
  // Automatic goes out through the ordinary send path, paced; the rest send nothing.
  expect(f.driver.posted.length).toBeLessThanOrEqual(mode === "auto" ? 1 : 0);
});

async function actionFixture(): Promise<LedgerFixture> {
  const orgId = await mkOrg({ minActionGapSec: 0 });
  const { campaignId } = await leadCampaign(orgId, { find: "off", research: "off" });
  await withOrg(orgId, async (tx) => {
    for (const [step, modes] of [["handle_reply", { reply: "review", like_reply: "off" }], ["connect", { invite: "review", accept_invite: "review" }], ["continue_in_dms", { dm: "review", followup: "review" }]] as const) await hireStep(tx, orgId, campaignId, step, modes);
    await activateChannelAccount(tx, alwaysOpenAccountDefault());
  });
  await startAsOwner(orgId, campaignId);
  const f = await watchedComment(orgId, campaignId);
  const theirs = reply(f, "9001", "We measure it weekly.");
  await observe(f, [theirs]);
  const [conversation, event] = await withOrg(orgId, async (tx) => [(await tx.select().from(conversations))[0]!, (await tx.select().from(conversationEvents))[0]!] as const);
  return { ...f, conversation, event, replyUrn: theirs.replyUrn };
}

it("holds a sensitive inbound DM for the owner", async () => {
  const f = await actionFixture();
  const llm = Object.assign(new FakeLLM(), { reading: { hold: true, category: "legal", question: true } });
  const incoming = message(f, "My lawyer has a question about this.", { sentAt: Date.now() });
  const conversation = await inboxRead(f, llm, [incoming]);
  const [event] = await withOrg(f.orgId, tx => tx.select().from(conversationEvents).where(eq(conversationEvents.providerEventId, incoming.messageId)));
  expect(conversation.opsStatus).toBe("awaiting_review");
  expect(event).toMatchObject({ decision: { decision: "review" }, reading: { verdict: { hold: true } } });
  const ctx = buildMcpCtx(f.orgId);
  const ref = `person:p.${f.conversation.authorProfileId}`;
  const listed = async () => (parse(await v2call(ctx, "list_people", { view: "inbox" })).rows as Array<{ ref: string }>).some((row) => row.ref === ref);
  expect(await listed()).toBe(true);
  expect((await v2call(ctx, "update_person", { ref, archived: true })).isError).not.toBe(true);
  expect(await listed()).toBe(false);
  const { action } = await withOrg(f.orgId, (tx) => ownerInvite(tx, { personKey: `p.${f.conversation.authorProfileId}`, campaignId: f.campaignId, note: "Glad to connect.", by: "owner:test" }));
  expect((await v2call(ctx, "update_person", { ref, doNotEngage: true })).isError).not.toBe(true);
  await withOrg(f.orgId, async (tx) => {
    const [queued] = await tx.select().from(actions).where(eq(actions.id, action.id));
    expect(queued?.status).toBe("cancelled");
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, f.campaignId));
    const [channel] = await tx.select().from(channels);
    expect(await canEngage({ action: "dm", origin: "owner", pressed: true, profileId: f.conversation.authorProfileId, campaign: campaign!, channel: channel!, db: tx })).toMatchObject({ ok: false, reason: "do_not_engage" });
  });
});

it("drafts a DM from the event its input shows tagged, ends a wait once they accept, and keeps what the owner wrote on LinkedIn", async () => {
  const f = await dmAmbassador();
  const { asked, event } = await interestedInDms(f);
  const llm = new FakeLLM();
  llm.agentStepResults = [...dmCalls(f.conversation.id, "send_dm", null, [`event:${event.id}`]).slice(0, 2), { status: "waiting", wait: { event: "invitation_status", expires_in_hours: 48, wake_at: null, on_timeout: "wake", evidence_refs: [], quote: null } }];
  for (let i = 0; i < 10; i++) if (!(await runOnce({ grant: f.grant, llm }, { ownOrgs: new Set([f.orgId]) }))) break;
  expect(await withOrg(f.orgId, (tx) => tx.select({ tool: stepToolCalls.tool, outcome: stepToolCalls.outcome }).from(stepToolCalls))).toEqual([{ tool: "draft_dm", outcome: "dispatched" }, { tool: "send_dm", outcome: "dispatched" }]);
  expect(await withOrg(f.orgId, (tx) => tx.select({ origin: actions.origin }).from(actions).where(eq(actions.kind, "dm")))).toEqual([{ origin: "worker" }]);
  const waits = () => withOrg(f.orgId, (tx) => tx.select({ wait: stepRuns.wait }).from(stepRuns).where(eq(stepRuns.status, "waiting")));
  expect(await waits()).toMatchObject([{ wait: { event: "invitation_status", consumedAt: null } }]);
  // Their acceptance, judged nothing to answer, wakes no step and still ends the wait on it.
  await withOrg(f.orgId, (tx) => conversationEventArrived(tx, { campaignId: f.campaignId, event: { id: 0, conversationId: f.conversation.id, type: "invitation_accepted", decision: { decision: "wait" } }, now: Date.now() }));
  expect(await waits()).toMatchObject([{ wait: { consumedBy: "event" } }]);
  const mine = async () => (await withOrg(f.orgId, (tx) => readPersonMessaging(tx, f.conversation.id)))?.entries.flatMap((entry) => (entry.kind === "ours" && entry.linkedIn ? [entry.text] : []));
  const link = message(f, "Sent you the link.", { fromSelf: true, authorProfileId: OWNER });
  await inboxRead(f, new FakeLLM(), [link]);
  expect(await mine(), "the inbox check opens a conversation the owner wrote in last").toEqual(["Sent you the link."]);
  // Written after the card last moved: only Check LinkedIn now reads it.
  f.driver.dmThreads.set(THREAD, conversation(f, [asked, link, message(f, "And a call link.", { fromSelf: true, authorProfileId: OWNER })]));
  expect(await syncConversation({ organizationId: f.orgId, conversationId: f.conversation.id, grant: f.grant, llm: new FakeLLM(), now: Date.now() })).toMatchObject({ status: "read" });
  expect(await mine()).toEqual(["Sent you the link.", "And a call link."]);
});

/** `act` as the agent presses it: the ledger row it lands is the owner's (a worker's proposal the press approves stays the worker's), and the driver is untouched until the drain. */
async function pressAct(orgId: string, input: Record<string, unknown>, driver: MockDriver, origin = "owner") {
  const result = parse(await v2call(buildMcpCtx(orgId), "act", input));
  expect(result).toMatchObject({ ok: true });
  expect([driver.dmsSent, driver.openedDms, driver.invitationsSent, driver.acceptInvitations].flat()).toHaveLength(0);
  const [action] = await withOrg(orgId, (tx) => tx.select().from(actions).where(eq(actions.id, result.actionId as number)));
  expect(action).toMatchObject({ origin, status: "approved" });
  return { action: action! };
}

it("settles owner DM, invite and acceptance through the action ledger", async () => {
  const dm = await actionFixture();
  const connected = readOf(dm.conversation.authorProfileId, "1st", "none");
  await withOrg(dm.orgId, (tx) => recordRelationshipRead(tx, { conversationId: dm.conversation.id, read: connected, now: Date.now() }));
  await interestedInDms(dm);
  expect(parse(await v2call(buildMcpCtx(dm.orgId), "submit_draft", { ref: `box:dm:${dm.conversation.id}`, to: "composer", text: "Thursday works." }))).toMatchObject({ draft: { state: "ready" } });
  const sent = await pressAct(dm.orgId, { ref: `person:p.${dm.conversation.authorProfileId}`, kind: "dm", text: "Thursday works." }, dm.driver);
  expect(await withOrg(dm.orgId, (tx) => tx.select().from(composerDrafts)), "the sent draft leaves the box").toEqual([]);
  expect(await dispatchAction({ organizationId: dm.orgId, driver: dm.driver }, sent.action.id)).toMatchObject({ status: "confirmed", clicked: true, receipt: { status: "confirmed" } }); expect([...dm.driver.dmsSent, ...dm.driver.openedDms]).toHaveLength(1);

  const invite = await actionFixture();
  const invited = await pressAct(invite.orgId, { ref: `person:p.${invite.conversation.authorProfileId}`, kind: "invite", text: "Glad to connect." }, invite.driver);
  invite.driver.relationships.set(invite.conversation.authorProfileId, connectRead(invite.conversation.authorProfileId));
  expect(await dispatchAction({ organizationId: invite.orgId, driver: invite.driver }, invited.action.id)).toMatchObject({ status: "confirmed", clicked: true, receipt: { status: "confirmed" } }); expect(invite.driver.invitationsSent).toHaveLength(1);
  // Pending as Engager last read it, no DM is worded and Check LinkedIn now moves the next read of them up; connected with nothing written yet, the words are a first message.
  const words = () => withOrg(invite.orgId, (tx) => prepareDmWords(tx, { kind: "dm", conversationId: invite.conversation.id, deliver: "box" })), pressedAt = Date.now();
  await expect(words()).rejects.toThrow("dm_not_connected");
  expect(await withOrg(invite.orgId, async (tx) => [await requestInvitationLook(tx, invite.conversation.id, pressedAt), (await invitationLooks(tx, [invite.conversation.id])).get(invite.conversation.id)])).toEqual([{ at: pressedAt }, pressedAt]);
  await withOrg(invite.orgId, (tx) => recordRelationshipRead(tx, { conversationId: invite.conversation.id, read: readOf(invite.conversation.authorProfileId, "1st", "none"), now: Date.now() }));
  expect((await words()).source).toMatchObject({ purpose: "opener", conversation: "No messages yet: this is the first message to them." });

  const accept = await actionFixture(); accept.driver.incomingInvitations = [invitationFrom(accept.conversation.authorProfileId)];
  await withEntryBoundary(() => observeIncomingInvitations({ organizationId: accept.orgId, channelId: accept.channelId, driver: accept.driver }), { organizationId: accept.orgId });
  const [incoming] = await invitationRows(accept);
  const reservation = await withOrg(accept.orgId, (tx) => reserveAcceptance(tx, incoming!, Date.now()));
  expect(reservation.status).toBe("duplicate"); if (reservation.status !== "duplicate") throw new Error("acceptance was not reserved by the read");
  expect((await pressAct(accept.orgId, { ref: `inv:${incoming!.id}`, kind: "accept" }, accept.driver, "worker")).action.id).toBe(reservation.action.id);
  expect(await dispatchAction({ organizationId: accept.orgId, driver: accept.driver }, reservation.action.id)).toMatchObject({ status: "confirmed", clicked: true, receipt: { status: "confirmed" } }); expect(accept.driver.acceptInvitations).toHaveLength(1);
  for (const [f, id] of [[dm, sent.action.id], [invite, invited.action.id], [accept, reservation.action.id]] as const) {
    expect(await withOrg(f.orgId, (tx) => tx.select().from(actions))).toMatchObject([{ id, status: "confirmed", externalReceipt: expect.any(Object) }]);
  }
});

it("holds an uncertain owner invite until resolved without a second press", async () => {
  const f = await actionFixture();
  const { action } = await withOrg(f.orgId, (tx) => ownerInvite(tx, { personKey: `p.${f.conversation.authorProfileId}`, campaignId: f.campaignId, note: "Glad to connect.", by: "owner:test" }));
  f.driver.relationships.set(f.conversation.authorProfileId, connectRead(f.conversation.authorProfileId));
  const send = f.driver.sendInvitation.bind(f.driver);
  vi.spyOn(f.driver, "sendInvitation").mockImplementation(async (input) => { await send(input); throw new Error("lost response after press"); });
  expect(await dispatchAction({ organizationId: f.orgId, driver: f.driver }, action.id)).toMatchObject({ status: "uncertain", clicked: true }); const rows = () => withOrg(f.orgId, (tx) => tx.select().from(actions));
  expect((await rows())[0]).toMatchObject({ status: "uncertain" });
  await dispatchAction({ organizationId: f.orgId, driver: f.driver }, action.id); expect(f.driver.invitationsSent).toHaveLength(1);
  await withOrg(f.orgId, (tx) => resolveOutcome(tx, { ref: { kind: "act", id: action.id }, observed: "went_out", by: "owner:test" }));
  await expect(withOrg(f.orgId, (tx) => resolveOutcome(tx, { ref: { kind: "act", id: action.id }, observed: "not_sent", by: "owner:test" }))).resolves.toMatchObject({ ok: false, reason: "not_uncertain" });
  await drainActions({ organizationId: f.orgId, driver: f.driver }, (await rows())[0]!.channelId);
  expect((await rows())[0]).toMatchObject({ status: "confirmed", externalReceipt: expect.any(Object) });
  expect(f.driver.memberWrites).toEqual([{ operationId: expect.any(String), outcome: "went_out" }]); expect(f.driver.invitationsSent).toHaveLength(1);
});
