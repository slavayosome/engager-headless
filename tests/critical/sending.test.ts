import { and, eq, sql } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { pool } from "@engager/database";
import { actions, campaignStrategies, channels, commentWatches, discoveredPosts, engagedProfiles, incomingComments, jobs, messages, rateLimitLedger, workers } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { canEngage, effectiveDailyCommentCap, pacingPolicy } from "../../packages/core/ratelimit/ledger";
import { applyKillSwitch, updateOrgSafety } from "../../packages/core/operations/orgSettings";
import { stageStrategyVersion } from "../../packages/core/test/strategies";
import { activateStrategy } from "../../packages/core/strategy/activate";
import { approveAction } from "../../packages/core/actions/approval";
import { stopScope } from "../../packages/core/actions/pause";
import { dispatchAction, drainActions } from "../../packages/core/execution/actionGate";
import { reactionKey } from "../../packages/core/actions/keys";
import { portableExport, portableRestore } from "../../scripts/portable-lifecycle";
import { actionRow, actionRows, insertGatedKinds, likeInput, liveAmbassador, openHours, reserve, setLikeModes, tripGuard } from "../../packages/core/test/actions";
import { queuedRoom, roomJournal, roomMessage } from "../../packages/core/test/roomReply";
import { convertLegacy, legacySend, queuedReply, rewindToLegacy } from "../../packages/core/test/reply";
import { queueAutomaticReply } from "../../packages/core/actions/reply";
import { queueComment } from "../../packages/core/actions/comment";
import { queuedComment } from "../../packages/core/test/comment";
import { MockDriver } from "../../packages/core/linkedin/mock";
import { dedupeKey, postExactlyOnce } from "../../packages/core/posting";
import { BrowserUseClient } from "../../packages/core/linkedin/browser-use/client";
import { BrowserUseDriver } from "../../packages/core/linkedin/browser-use/driver";
import { queuedOwnerTransport, startBrowserBridge } from "../../packages/core/linkedin/browser-use/bridgeServer";
import { fallbackWithAgent, gatedSidecar } from "../../packages/core/test/bridge";
import { readBridgeFile } from "../../packages/core/linkedin/browser-use/bridgeFile";
import { writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { dismissIncoming } from "../../packages/core/operations/dismissal";
import { applyMessageDecision } from "../../packages/core/operations/messages";
import { resolveOutcome } from "../../packages/core/operations/outcomes";
import type { PostInput } from "../../packages/core/linkedin/driver";
import { section14AccountDefault, withActionModes } from "../../packages/core/strategy/strategy.fixture";
import { modeFor } from "../../packages/core/strategy/mode";
import { setKillSwitch } from "../../packages/core/ratelimit/killswitch";
import { withTempDir } from "../../packages/core/test/tempDir";
import { getCampaign, getChannel, inOrg, mkOrg } from "../../packages/core/test/db";
import { buildMcpCtx } from "../../packages/core/mcp/context";
import { injectedConnector, parse, v2call } from "../../packages/core/test/mcpHarness";

afterAll(() => pool.end());

it("authorizes before reconciliation and refuses a disabled driver without a request", async () => {
  const driver = new MockDriver();
  const reconcile = vi.spyOn(driver, "reconcilePosted");
  const input = { kind: "comment" as const, postUrn: "urn:li:activity:123", text: "hello", marker: "op" };
  await expect(postExactlyOnce({ kind: "comment", use: driver, connector: null, input }, async () => { throw new Error("refused"); })).rejects.toThrow("refused");
  expect(reconcile).not.toHaveBeenCalled();
  const send = vi.fn();
  await expect(new BrowserUseDriver(new BrowserUseClient({ transport: { send, close: async () => {} } })).reconcilePosted(input)).rejects.toThrow("writes are off");
  expect(send).not.toHaveBeenCalled();
});

it("does not dispatch a write whose time expired in the bridge queue", () => withTempDir("engager-queue-", async (dir) => {
  let release!: () => void;
  const calls: string[] = [];
  const bridge = await startBrowserBridge({ sessionFile: join(dir, "bridge.json"), transport: () => gatedSidecar(calls, new Promise<void>((resolve) => { release = resolve; })) });
  try {
    const transport = queuedOwnerTransport();
    const first = transport.send({ v: 1, id: "first", op: "warm_browser", params: {} });
    const second = transport.send({ v: 1, id: "second", op: "like_post", params: { postUrn: "urn:li:activity:123" } }, { timeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await first;
    expect(await second).toMatchObject({ ok: false, error: { code: "ABANDONED" } }); expect(calls).toEqual(["warm_browser"]);
  } finally {
    release();
    await bridge?.close();
  }
}));

it("serves the bridge on a free port when another program holds its own", () => withTempDir("engager-port-", async (dir) => {
  const stranger = createServer();
  await new Promise<void>((resolve) => stranger.listen(0, "127.0.0.1", resolve));
  const taken = (stranger.address() as AddressInfo).port;
  vi.stubEnv("ENGAGER_BROWSER_BRIDGE", "on");
  vi.stubEnv("ENGAGER_BROWSER_BRIDGE_PORT", String(taken));
  vi.stubEnv("ENGAGER_BROWSER_BRIDGE_FILE", join(dir, "standing.json"));
  const bridge = await startBrowserBridge({ transport: () => gatedSidecar([], Promise.resolve()) });
  try {
    expect(bridge!.port).not.toBe(taken);
    expect(readBridgeFile()!.port).toBe(bridge!.port);
  } finally {
    await bridge?.close();
    stranger.close();
    vi.unstubAllEnvs();
  }
}));

it.each([true, false])("hands the journal to the standing bridge once the fallback has let go, the owner's window with it, and keeps serving when it will not (retires: %s)", (retires) => withTempDir("engager-yield-", async (dir) => {
  const world = await fallbackWithAgent(dir, retires);
  try {
    const transport = queuedOwnerTransport();
    const place = { left: 0, top: 0, width: 800, height: 900 };
    const first = transport.send({ v: 1, id: "first", op: "ensure_session", params: { interactive: true, place } });
    await vi.waitFor(() => expect(world.events).toEqual(["fallback holds"]));
    world.publish();
    const second = transport.send({ v: 1, id: "second", op: "ensure_session", params: { interactive: true, surface: false } });
    world.release();
    expect([(await first).ok, (await second).ok]).toEqual([true, true]);
    expect([world.events, world.ops]).toEqual(retires
      ? [["fallback holds", "fallback released", "agent holds"], { fallback: ["ensure_session"], agent: ["ensure_session"] }]
      : [["fallback holds"], { fallback: ["ensure_session", "ensure_session"], agent: [] }]);
    expect(world.toAgent.map((frame) => frame.params)).toEqual(retires ? [{ place, interactive: true }] : []);
  } finally {
    await world.stop();
  }
}));

it("holds an uncertain comment until the owner resolves it, journaling the answer before a second press", async () => {
  const f = await queuedComment();
  f.driver.failNextPost = "timeout_after_success";
  vi.spyOn(f.driver, "reconcilePosted").mockResolvedValue(null);
  expect(await f.send()).toMatchObject({ status: "uncertain" });
  expect([(await f.current()).status, await f.send()]).toMatchObject(["needs_review", { status: "not_queued" }]);
  const ref = { kind: "msg", id: f.message.id } as const, drain = () => drainActions({ organizationId: f.orgId, driver: f.driver }, f.action!.channelId);
  const answer = (observed: "went_out" | "not_sent", urn?: string) => inOrg(f.orgId, (tx) => resolveOutcome(tx, { ref, observed, urn, by: "owner:test" }));
  expect(await answer("went_out", "urn:li:comment:confirmed")).toMatchObject({ ok: true });
  await drain();
  expect(await f.current()).toMatchObject({ status: "posted", externalUrn: "urn:li:comment:confirmed" });
  expect(await answer("not_sent")).toMatchObject({ ok: false, reason: "not_uncertain", currentStatus: "confirmed" });
  expect(f.driver.posted).toHaveLength(1);

  const retry = await queuedComment();
  const markers: string[] = [], resolved: string[] = []; let first = true;
  Object.assign(retry.driver, {
    postWithReceipt: async (input: PostInput) => {
      markers.push(input.marker);
      if (first) { first = false; throw new Error("uncertain before receipt"); }
      return retry.driver.postComment((input as { postUrn: string }).postUrn, input.text);
    },
    resolveUncertainWriteOutcome: async (input: PostInput, resolutionVersion: number) => { resolved.push(input.marker); return { operationId: input.marker, state: "resolved_not_posted" as const, resolutionVersion }; },
  });
  expect(await retry.send()).toMatchObject({ status: "uncertain" });
  const asAgent = (ref: string) => v2call(buildMcpCtx(retry.orgId), "resolve_outcome", { ref, observed: "not_sent" });
  expect(parse(await asAgent(`act:${retry.action!.id}`))).toMatchObject({ code: "owner_surface_required" });
  expect(await inOrg(retry.orgId, (tx) => resolveOutcome(tx, { ref: { kind: "msg", id: retry.message.id }, observed: "not_sent", by: "owner:test", version: 9 }))).toMatchObject({ ok: false, reason: "stale_state" });
  expect(parse(await asAgent(`msg:${retry.message.id}`))).toMatchObject({ ok: true }); expect(resolved).toEqual([]);
  await drainActions({ organizationId: retry.orgId, driver: retry.driver }, retry.action!.channelId);
  expect([resolved, (await retry.current()).status]).toEqual([[retry.message.dedupeKey], "proposed"]);
  await inOrg(retry.orgId, async (tx) => {
    expect(await applyMessageDecision({ db: tx, messageId: retry.message.id, verdict: "approve" })).toMatchObject({ ok: true });
    await tx.update(messages).set({ scheduledAt: Date.now() - 1000 }).where(eq(messages.id, retry.message.id));
  });
  expect(await retry.send()).toMatchObject({ status: "confirmed" });
  expect(markers).toEqual([retry.message.dedupeKey, `${retry.message.dedupeKey}:v1`]); expect(retry.driver.posted).toHaveLength(1);

  for (const observed of ["not_sent", "went_out"] as const) {
    const room = await queuedRoom("uncertain"), frozen = roomJournal(room.driver);
    expect(await room.send()).toMatchObject({ status: "uncertain" }); expect(await roomMessage(room)).toMatchObject({ status: "needs_review" });
    const answer = () => inOrg(room.orgId, (tx) => resolveOutcome(tx, { ref: { kind: "msg", id: room.message.id }, observed, urn: "urn:li:comment:(urn:li:activity:1,2)", by: "owner:test" }));
    const drain = () => drainActions({ organizationId: room.orgId, driver: room.driver }, room.action.channelId);
    // The answer waits on the journal: the action and the account's fence hold until it takes it.
    expect(await answer()).toMatchObject({ ok: true, status: "uncertain" });
    expect(await answer()).toMatchObject({ ok: false, reason: "not_uncertain" });
    expect([frozen.length, (await actionRows(room.orgId))[0]!.status]).toEqual([0, "uncertain"]);
    await drain();
    const counted = await inOrg(room.orgId, (tx) => tx.select().from(rateLimitLedger).where(eq(rateLimitLedger.messageId, room.message.id)));
    expect([frozen, (await roomMessage(room)).status, counted.length, room.driver.roomWrites.length])
      .toEqual([[`${room.message.dedupeKey}:0`], observed === "went_out" ? "posted" : "proposed", observed === "went_out" ? 1 : 0, 1]);
  }
  // A journal that holds the write the other way is the owner's to settle again: no read or drain settles it.
  const clash = await queuedRoom("uncertain");
  await clash.send();
  Object.assign(clash.driver, { reconcilePosted: async () => "urn:li:comment:landed" }); roomJournal(clash.driver, "already_committed");
  const resolve = (observed: "not_sent" | "went_out") => inOrg(clash.orgId, (tx) => resolveOutcome(tx, { ref: { kind: "msg", id: clash.message.id }, observed, urn: "urn:li:comment:landed", by: "owner:test" }));
  const drainClash = () => drainActions({ organizationId: clash.orgId, driver: clash.driver }, clash.action.channelId);
  await resolve("not_sent"); await drainClash(); await drainClash();
  expect([(await actionRows(clash.orgId))[0]!.status, (await roomMessage(clash)).status, clash.driver.roomWrites.length]).toEqual(["uncertain", "needs_review", 1]);
  await resolve("went_out"); await drainClash();
  expect(await roomMessage(clash)).toMatchObject({ status: "posted", externalUrn: "urn:li:comment:landed" });
});

it("caps worker output over the owner's day while allowing owner words past the cap, with spacing", async () => {
  const f = await queuedComment();
  await openHours(f.orgId, { dailyCommentCap: 1, warmupWeeks: 0, minDelaySec: 0 });
  await inOrg(f.orgId, async (tx) => {
    const [channel, campaign] = [await getChannel(tx), await getCampaign(tx, f.message.campaignId!)];
    await tx.insert(rateLimitLedger).values({ action: "comment", channelId: channel.id, campaignId: campaign.id, ts: Date.now() - 180_000 });
  });
  const session = vi.spyOn(f.driver, "ensureSession");
  expect(await f.send()).toMatchObject({ status: "held", reason: "campaign_daily_comment_cap" }); expect(session).not.toHaveBeenCalled();
  expect(await f.sendAnother("urn:li:activity:t2", "owner")).toMatchObject({ status: "confirmed" });
  expect(await f.sendAnother("urn:li:activity:t3", "owner")).toMatchObject({ status: "held", reason: "min_gap" });
  await inOrg(f.orgId, async (tx) => {
    await tx.update(channels).set({ minActionGapSec: 900 });
    const [channel, campaign] = [await getChannel(tx), await getCampaign(tx, f.message.campaignId!)];
    expect(await canEngage({ action: "comment", campaign, channel, db: tx, origin: "owner", now: Date.now() + 31_000 })).toMatchObject({ ok: false, reason: "channel_min_gap" });
    const at = (day: number, hour: number) => Date.UTC(2030, 0, day, hour, 30), spend = (ts: number) => tx.insert(rateLimitLedger).values({ action: "comment", channelId: channel.id, campaignId: campaign.id, ts });
    const lateNight = { action: "comment", campaign, channel: { ...channel, activeHours: { start: "09:00", end: "01:00", tz: "UTC" } }, db: tx, origin: "worker", now: at(15, 10) } as const;
    await spend(at(14, 23)); expect(await canEngage(lateNight)).toEqual({ ok: true }); await spend(at(15, 9)); expect(await canEngage(lateNight)).toMatchObject({ reason: "campaign_daily_comment_cap" });
  });
  expect(f.driver.posted).toHaveLength(1);
});

it("holds a worker comment or reply at Off and a comment for a yes at Ask me, never the owner's own", async () => {
  const [off, review, owner] = [await queuedComment({ comment: "off" }), await queuedComment({ comment: "review" }), await queuedComment({ comment: "off", origin: "owner" })];
  expect([off.action, await off.current()]).toMatchObject([undefined, { status: "proposed", error: "comment_mode_off" }]);
  expect([review.action, await review.send()]).toMatchObject([{ status: "reserved", origin: "worker" }, { status: "awaiting_review", reason: "review_required" }]);
  expect(owner.action).toMatchObject({ kind: "comment", status: "approved", origin: "owner" });
  expect(await owner.send()).toMatchObject({ status: "confirmed" });
  const [reply, mine] = [await queuedReply({ reply: "off" }), await queuedReply({ reply: "off", origin: "owner" })];
  expect([reply.action, await reply.current()]).toMatchObject([undefined, { status: "proposed", error: "reply_mode_off" }]);
  expect(mine.action).toMatchObject({ kind: "reply", status: "approved", origin: "owner" });
});

it("sends a comment once, at its slot, counted for the day, watched for replies and its session check recorded", async () => {
  const f = await queuedComment();
  expect(f.action).toMatchObject({ kind: "comment", status: "reserved", origin: "worker", messageId: f.message.id });
  const slot = (scheduledAt: number | null) => inOrg(f.orgId, (tx) => tx.update(messages).set({ scheduledAt }).where(eq(messages.id, f.message.id)));
  await slot(null);
  expect(await f.send()).toMatchObject({ status: "held", reason: "slot_unassigned" });
  await slot(Date.now() - 1000);
  expect([await f.send(), await f.send()]).toMatchObject([{ status: "confirmed", clicked: true }, { status: "not_queued" }]);
  expect(f.driver.posted).toHaveLength(1); expect(await f.current()).toMatchObject({ status: "posted", externalUrn: f.driver.posted[0]!.urn });
  const [counted, watches, projected] = await inOrg(f.orgId, async (tx) => [
    await tx.select().from(rateLimitLedger).where(eq(rateLimitLedger.messageId, f.message.id)),
    await tx.select().from(commentWatches).where(eq(commentWatches.messageId, f.message.id)),
    await tx.select().from(jobs).where(eq(jobs.idempotencyKey, `post:${f.message.id}`))]);
  expect([counted.length, watches.length, projected]).toEqual([1, 1, []]);
  expect((await inOrg(f.orgId, (tx) => tx.select({ okAt: channels.sessionOkAt }).from(channels)))[0]?.okAt).toBeGreaterThan(0);
});

it("queues a dismissal like as a like action the gate modes, caps and spaces, and the owner's only spaces", async () => {
  const f = await queuedComment();
  const campaignId = f.message.campaignId!; await openHours(f.orgId);
  const dismiss = async (n: number, by: "agent" | "owner") => {
    const [incoming] = await inOrg(f.orgId, (tx) => tx.insert(incomingComments).values({ campaignId, ownPostUrn: "urn:li:activity:t1", commentUrn: `urn:li:comment:c${n}`, authorProfileId: `person-${n}`, text: "Thanks!", status: "new" }).returning());
    return inOrg(f.orgId, (tx) => dismissIncoming(tx, { incomingCommentId: incoming!.id, like: true, by }));
  };
  const drain = (id: number) => dispatchAction({ organizationId: f.orgId, driver: f.driver }, id);
  await inOrg(f.orgId, (tx) => setLikeModes(tx, campaignId, "off", 1));
  expect(await dismiss(1, "agent")).toMatchObject({ dismissed: true, note: "like blocked: like_off" });
  await inOrg(f.orgId, (tx) => setLikeModes(tx, campaignId, "review", 1));
  const asked = await dismiss(2, "agent");
  expect(await actionRow(f, asked.likeActionId!)).toMatchObject({ origin: "worker", status: "awaiting_review" });
  expect(await drain(asked.likeActionId!)).toMatchObject({ status: "not_queued" });
  await inOrg(f.orgId, (tx) => setLikeModes(tx, campaignId, "auto", 1));
  expect(await drain((await dismiss(3, "agent")).likeActionId!)).toMatchObject({ status: "confirmed", clicked: true });
  expect(await drain((await dismiss(4, "agent")).likeActionId!)).toMatchObject({ status: "blocked", reason: "ceiling_reached" });
  const owned = await dismiss(5, "owner");
  expect(await actionRow(f, owned.likeActionId!)).toMatchObject({ origin: "owner", status: "approved" });
  expect(await drain(owned.likeActionId!)).toMatchObject({ status: "confirmed", clicked: true }); expect(f.driver.likedComments).toHaveLength(2);
});

it("reserves a comment's like with its claim, sends it once the comment is posted", async () => {
  const f = await queuedComment();
  const campaignId = f.message.campaignId!; await openHours(f.orgId);
  await inOrg(f.orgId, (tx) => setLikeModes(tx, campaignId, "auto", 1, { publish_comment: "auto" }));
  expect(await f.send()).toMatchObject({ status: "confirmed" });
  const like = (await actionRows(f.orgId)).find((row) => row.kind === "like_target");
  expect(like).toMatchObject({ kind: "like_target", messageId: f.message.id, origin: "worker", status: "approved" });
  const drain = () => dispatchAction({ organizationId: f.orgId, driver: f.driver }, like!.id);
  const status = (value: "needs_review" | "posted") => inOrg(f.orgId, (tx) => tx.update(messages).set({ status: value }).where(eq(messages.id, f.message.id)));
  await status("needs_review");
  expect(await drain()).toMatchObject({ status: "held", reason: "send_unconfirmed" });
  await status("posted");
  expect(await drain()).toMatchObject({ status: "confirmed", clicked: true }); expect(f.driver.likedPosts).toHaveLength(1);
  expect((await f.current()).likeOutcome).toMatchObject({ state: "liked", receiptId: like!.id });
});

it("converts like receipts to one fenced action per target, and a restored archive likewise", async () => {
  const post = "urn:li:activity:t1";
  const comment = (id: number) => `urn:li:comment:(${post},${id})`;
  const seed = async (orgId: string, receipts: Array<Record<string, unknown>>, queued?: number) => inOrg(orgId, async (tx) => {
    const channelId = (await tx.select().from(channels))[0]!.id;
    const rows = await tx.insert(rateLimitLedger).values(receipts.map((meta) => ({ action: "like" as const, channelId,
      meta: { version: 1, execution: { channelId, accountId: "a", epoch: 1 }, reservedAt: 1000, postUrn: post, ...meta } }))).returning();
    if (queued) await tx.insert(actions).values({ channelId, kind: "like_target", purpose: "reaction", status: "approved", contentHash: "x", generationSeen: 0,
      idempotencyKey: `react:${channelId}:their_reply:${queued}:like`, target: { kind: "their_reply", id: String(queued), urn: comment(queued), postUrn: post },
      candidate: { text: null, sources: [], versions: { strategy: null, facts: [], memory: null, voice: null } } });
    return { channelId, ids: rows.map((row) => row.id) };
  });
  const f = { orgId: await mkOrg(), driver: new MockDriver() };
  const { channelId, ids } = await seed(f.orgId, [
    { kind: "dismissal_like_receipt", commentUrn: comment(555), state: "uncertain" },
    { kind: "followup_like_receipt", commentUrn: comment(555), state: "reserved" },
    { kind: "dismissal_like_receipt", commentUrn: comment(777), state: "succeeded" },
    { kind: "followup_like_receipt", state: "reserved" },
    { kind: "followup_like_receipt", commentUrn: comment(888), state: "succeeded" },
  ], 777);
  await inOrg(f.orgId, (tx) => tx.update(channels).set({ executionHolder: `followup:${ids[1]}` }));
  const convert = async () => {
    await inOrg(f.orgId, (tx) => tx.execute(sql`select convert_like_receipts(${f.orgId}::uuid)`));
    return (await actionRows(f.orgId)).map((row) => [row.idempotencyKey, row.status, row.fenceToken]);
  };
  const key = (on: string) => `react:${channelId}:${on}:like`;
  expect(await convert()).toEqual(expect.arrayContaining([[key("comment:777"), "confirmed", null], [key("comment:555"), "uncertain", `followup:${ids[1]}`],
    [key(`post:${post}`), "uncertain", `followup:${ids[3]}`], [key("comment:888"), "confirmed", `followup:${ids[4]}`]]));
  expect(await convert()).toHaveLength(4);
  expect(reactionKey({ channelId, target: { kind: "their_reply", id: "555" }, reaction: "like" })).toBe(key("comment:555"));
  for (const row of await actionRows(f.orgId)) expect(await dispatchAction({ organizationId: f.orgId, driver: f.driver }, row.id)).toMatchObject({ status: "not_queued" });
  expect([f.driver.likedComments, f.driver.likedPosts]).toEqual([[], []]);
  const g = { orgId: await mkOrg() };
  const { ids: [receipt] } = await seed(g.orgId, [{ kind: "followup_like_receipt", state: "uncertain" }]);
  const env = { ENGAGER_ORG_ID: g.orgId, ENGAGER_MIGRATE_DATABASE_URL: process.env.ENGAGER_MIGRATE_DATABASE_URL! };
  await withTempDir("engager-restore-", async (dir) => {
    const archive = { output: join(dir, "archive.json"), passphraseFile: join(dir, "pass"), env };
    writeFileSync(archive.passphraseFile, "a long enough passphrase");
    await portableExport(archive);
    await portableRestore({ input: archive.output, passphraseFile: archive.passphraseFile, env });
  });
  expect((await actionRows(g.orgId)).map((row) => [row.status, row.fenceToken])).toEqual([["uncertain", `followup:${receipt}`]]);
});

it("refuses a do-not-engage person for unattended comments and owner DMs", async () => {
  const f = await queuedComment();
  await inOrg(f.orgId, async (tx) => {
    await tx.insert(engagedProfiles).values({ profileId: "blocked", doNotEngage: true });
    const [channel, campaign] = [await getChannel(tx), await getCampaign(tx, f.message.campaignId!)];
    // A person is the same however their id is cased.
    for (const [action, origin, profileId] of [["comment", "worker", "blocked"], ["dm", "owner", "Blocked"]] as const) {
      expect(await canEngage({ action, origin, pressed: origin === "owner", profileId, campaign, channel, db: tx })).toMatchObject({ ok: false, reason: "do_not_engage", permanent: true });
    }
  });
});

it("lets a step's mode alone decide, once the account's own modes fold into the steps they held", async () => {
  const account = section14AccountDefault();
  account.budgets!.action_budgets_per_rolling_24h.like_target = 5;
  account.max_mode = { like_target: "review" };
  const f = await liveAmbassador(account, (doc) => withActionModes(doc, { like_target: "auto" }));
  const like = () => withOrg(f.orgId, (tx) => modeFor(tx, { campaignId: f.campaignId, actionBindingId: "like_reply" }));
  expect(await like()).toMatchObject({ effective: "auto", resolved_from: "step" });
  // Beside it a schema-2 draft whose own `modes` ask Automatic, and own-post replies at Automatic.
  await inOrg(f.orgId, (tx) => tx.execute(sql`with draft as (insert into campaign_strategies (organization_id, campaign_id, version, status, document, patch_provenance, effective_at, created_at)
    select organization_id, campaign_id, version + 1, 'draft', document || '{"schema_version":2,"modes":{"like_target":"auto"}}', patch_provenance, effective_at, created_at from campaign_strategies
    where campaign_id = ${f.campaignId} and status = 'active') update organizations set own_post_replies = '{"mode":"auto","sensitivity_gate":true,"prompt":""}' where id = ${f.orgId}`));
  const fold = () => inOrg(f.orgId, (tx) => tx.execute(sql`select fold_account_modes(${f.orgId}::uuid)`));
  const stored = () => inOrg(f.orgId, async (tx) => (await tx.execute(sql`select own_post_replies->>'mode' as own, (select jsonb_agg(document order by id)::text from campaign_strategies) as raw,
    (select jsonb_agg(jsonb_build_object('status', status, 'grants', document->'grants', 'max_mode', document->'max_mode', 'v2', document->'modes', 'modes', (select jsonb_object_agg(b->>'action_binding_id',
    b->'mode') from jsonb_array_elements(document->'action_bindings') b)) order by id) from campaign_strategies where status <> 'archived') as docs from organizations where id = ${f.orgId}`)).rows[0]!);
  // Migration 0338's fold: each step takes the account's stricter mode, Off where it granted none and Ask me under its `max_mode`; the
  // account then grants every send and caps none, so a second fold changes no byte and a step raised since stays raised.
  const [folded, held] = [await fold().then(stored), expect.objectContaining({ reply: "off", like_reply: "review" })];
  expect(folded).toMatchObject({ own: "off", docs: expect.arrayContaining([{ status: "active", grants: expect.arrayContaining(["grant_public_reply"]), max_mode: null, v2: null, modes: null },
    expect.objectContaining({ status: "active", modes: held }), expect.objectContaining({ status: "draft", v2: { like_target: "review" }, modes: held })]) });
  expect(await fold().then(stored)).toEqual(folded);
  expect(await like()).toMatchObject({ requested: "review", effective: "review", resolved_from: "step" });
  await inOrg(f.orgId, (tx) => tx.execute(sql`update campaign_strategies set document = jsonb_set(document, '{action_bindings}', (select jsonb_agg(case when b->>'action_binding_id' = 'like_reply'
    then b || '{"mode":"auto"}' else b end order by n) from jsonb_array_elements(document->'action_bindings') with ordinality e(b, n))) where campaign_id = ${f.campaignId} and status = 'active'`));
  expect(await fold().then(like)).toMatchObject({ effective: "auto", resolved_from: "step" });
});

it("folds a campaign's retired max_mode into its steps, once, and reads it no more", async () => {
  const account = section14AccountDefault();
  account.budgets!.action_budgets_per_rolling_24h.like_target = 5;
  const f = await liveAmbassador(account, (doc) => ({ ...withActionModes(doc, { like_target: "auto" }), max_mode: { like_target: "review" } }));
  const like = () => withOrg(f.orgId, (tx) => modeFor(tx, { campaignId: f.campaignId, actionBindingId: "like_reply" }));
  expect(await like()).toMatchObject({ effective: "auto", resolved_from: "step" });
  const fold = () => inOrg(f.orgId, async (tx) => { await tx.execute(sql`select fold_campaign_max_mode(${f.orgId}::uuid)`);
    return (await tx.execute(sql`select jsonb_agg(document order by id)::text as raw from campaign_strategies where campaign_id = ${f.campaignId}`)).rows[0]!.raw as string; });
  const folded = await fold();
  expect([folded.includes("max_mode"), await fold()]).toEqual([false, folded]);
  expect(await like()).toMatchObject({ requested: "review", effective: "review", resolved_from: "step" });
});

it("keeps warm-up Off as no ramp, never past the cap, and ramps from now when it is turned back on", async () => {
  const f = await queuedComment();
  await inOrg(f.orgId, (tx) => tx.update(channels).set({ dailyCommentCap: 20, warmupWeeks: 3, warmupStartedAt: Date.now() - 30 * 86_400_000 }));
  const cap = () => inOrg(f.orgId, async (tx) => effectiveDailyCommentCap(await getChannel(tx), Date.now()));
  const set = async (warmupWeeks: number) => (await inOrg(f.orgId, (tx) => updateOrgSafety(tx, f.orgId, { warmupWeeks })))?.warmupWeeks;
  // Only an explicit 0 is Off, and Off is the cap as set; On again starts the ramp over.
  expect([await cap(), await set(-2), await set(0), await cap(), await set(3), await cap()]).toEqual([20, 1, 0, 20, 3, 5]);
});

it("defaults unstamped authorship to capped worker output while owner words are only spaced", async () => {
  const f = await queuedComment();
  await inOrg(f.orgId, async (tx) => {
    const draft = { kind: "comment", campaignId: f.message.campaignId, status: "approved" } as const;
    const [unstamped, owner] = await tx.insert(messages).values([{ ...draft, proposedText: "Unstamped", dedupeKey: "unstamped" }, { ...draft, proposedText: "Owner", publishOrigin: "owner", dedupeKey: "owner" }]).returning();
    const [channel] = await tx.select().from(channels);
    expect(unstamped!.publishOrigin).toBe("worker");
    expect(pacingPolicy(channel!, unstamped!.publishOrigin, Date.now())).toMatchObject({ manual: false, channelDailyCapApplies: true, useDayPlanAnchors: true, commentDailyCap: expect.any(Number) });
    expect(pacingPolicy(channel!, owner!.publishOrigin, Date.now())).toMatchObject({ manual: true, channelDailyCapApplies: false, useDayPlanAnchors: false, commentDailyCap: 0, replyDailyCap: 0 });
  });
});

it("narrows an Automatic Comment to Ask me at the kill switch and keeps it there when it lifts", async () => {
  const f = await queuedComment();
  const campaignId = f.message.campaignId!;
  const comment = (tx: Parameters<typeof modeFor>[0]) => modeFor(tx, { campaignId, capability: "publish_comment", target: "post" });
  const [owner, wakes] = await inOrg(f.orgId, async (tx) => {
    expect(await comment(tx)).toMatchObject({ requested: "auto", effective: "auto" });
    return [(await tx.insert(messages).values({ kind: "comment", campaignId, proposedText: "Mine.", status: "approved", publishOrigin: "owner", dedupeKey: "owner-words" }).returning())[0]!,
      (await tx.select({ id: workers.id, auto: workers.auto, pausedReason: workers.pausedReason }).from(workers).where(eq(workers.campaignId, campaignId)))] as const;
  });
  for (const on of [true, false]) await inOrg(f.orgId, (tx) => applyKillSwitch(tx, f.orgId, on));
  await inOrg(f.orgId, async (tx) => {
    expect(await comment(tx)).toMatchObject({ requested: "review", effective: "review" });
    // The narrowing is one strategy version with its reason; the wake is the campaign's and stays.
    const [active] = await tx.select().from(campaignStrategies).where(and(eq(campaignStrategies.campaignId, campaignId), eq(campaignStrategies.status, "active")));
    expect(active!.patchProvenance.instruction).toContain("kill_switch");
    expect(await tx.select({ id: workers.id, auto: workers.auto, pausedReason: workers.pausedReason }).from(workers).where(eq(workers.campaignId, campaignId))).toEqual(wakes);
    const rows = await tx.select().from(messages);
    expect(rows.find((row) => row.id === f.message.id)?.status).toBe("proposed");
    expect(rows.find((row) => row.id === owner.id)?.status).toBe("approved");
    await tx.update(messages).set({ status: "approved" }).where(eq(messages.id, f.message.id));
    await queueComment(tx, f.message.id);
  });
  // After the lift a worker's comment waits for a yes instead of going out Automatic.
  expect(await f.send()).toMatchObject({ status: "awaiting_review", reason: "review_required" }); expect(f.driver.posted).toHaveLength(0);
  // A version that is Automatic and takes effect while the switch is on is narrowed too, not merely unstamped.
  await inOrg(f.orgId, async (tx) => {
    await setKillSwitch(tx, true);
    const version = await stageStrategyVersion(tx, campaignId, (doc) => withActionModes(doc, { publish_comment: "auto" }), Date.now() - 60_000);
    await activateStrategy(tx, { campaignId, version });
    expect(await comment(tx)).toMatchObject({ requested: "review", effective: "review" });
  });
});

it.each(["kill switch", "campaign Stop", "account Stop"] as const)("blocks every send kind at the %s", async (guard) => {
  const f = await queuedComment();
  await inOrg(f.orgId, async (tx) => {
    const [channel, campaign] = [await getChannel(tx), await getCampaign(tx, f.message.campaignId!)];
    await tripGuard(tx, guard, campaign.id);
    for (const action of ["comment", "reply", "room_reply", "like_target", "invite", "accept_invite", "dm", "followup", "withdraw_invite"] as const) {
      expect(await canEngage({ action, campaign, channel, db: tx, origin: "worker" })).toMatchObject({ ok: false, reason: guard === "kill switch" ? "kill switch" : guard === "campaign Stop" ? "stopped:campaign:stop" : "stopped:account:stop" });
    }
  });
  expect(await f.send()).toMatchObject(guard === "kill switch" ? { status: "held", reason: "kill switch" } : { status: "not_queued" });
  expect(f.driver.posted).toHaveLength(0);
});

it("answers Stop while the kill switch blocks sends", async () => {
  const f = await queuedComment();
  const ctx = { organizationId: f.orgId, ...injectedConnector(f.driver) };
  await inOrg(f.orgId, (tx) => setKillSwitch(tx, true));
  const result = await v2call(ctx, "stop", { scope: "account", kind: "stop", on: true });
  expect(result.isError).not.toBe(true); expect(parse(result)).toMatchObject({ created: true });
  expect(await f.send()).toMatchObject({ status: "not_queued" }); expect(f.driver.posted).toHaveLength(0);
});

it.each([["queued before", "reserved", "not_queued", "cancelled"], ["queued after", "approved", "cancelled", "paused:campaign:stop"]] as const)(
  "cancels action kinds %s a campaign Stop before dispatch", async (_when, status, outcome, reason) => {
    const f = await liveAmbassador();
    const ids = await withOrg(f.orgId, async (tx) => {
      if (status === "approved") await tripGuard(tx, "campaign Stop", f.campaignId);
      const inserted = await insertGatedKinds(tx, f, status);
      if (status === "reserved") await tripGuard(tx, "campaign Stop", f.campaignId);
      return inserted;
    });
    for (const id of ids) {
      expect(await dispatchAction({ organizationId: f.orgId, driver: f.driver, operations: {} }, id)).toMatchObject({ status: outcome, reason });
      expect(await actionRow(f, id)).toMatchObject({ status: "cancelled", statusReason: expect.stringContaining("stop") });
    }
    expect(f.driver.likedComments).toEqual([]);
  });

it.each(["kill switch", "campaign Stop"] as const)("holds an owner's comment, reply and room reply at the %s", async (guard) => {
  const [reply, room, comment] = [await queuedReply({ origin: "owner" }), await queuedRoom(), await queuedComment({ origin: "owner" })];
  for (const f of [reply, room, comment]) {
    await inOrg(f.orgId, (tx) => tripGuard(tx, guard, f.action!.campaignId!));
    expect(await f.send()).toMatchObject(guard === "kill switch" ? { status: "held", reason: "kill switch" } : { status: "not_queued" });
  }
  expect([reply.driver.posted, room.driver.roomWrites, comment.driver.posted]).toEqual([[], [], []]);
});

it("never lets a withdrawn yes authorize a re-approved reply", async () => {
  const f = await queuedReply({ reply: "review" });
  await inOrg(f.orgId, async (tx) => {
    await applyMessageDecision({ db: tx, messageId: f.message.id, verdict: "approve" });
    expect(await tx.select().from(actions)).toMatchObject([{ status: "approved" }]);
    await tx.update(messages).set({ status: "proposed" }).where(eq(messages.id, f.message.id));
    await tx.update(messages).set({ status: "approved" }).where(eq(messages.id, f.message.id));
    await queueAutomaticReply(tx, f.message.id);
  });
  expect(await f.send()).toMatchObject({ status: "awaiting_review", reason: "review_required" }); expect(f.driver.posted).toEqual([]);
});

it("keeps a thread's depth cap to the worker's replies, never the owner's own", async () => {
  const [owner, worker] = [await queuedReply({ origin: "owner", full: true }), await queuedReply({ full: true })];
  expect(await owner.send()).toMatchObject({ status: "confirmed" });
  expect(await worker.send()).toMatchObject({ status: "blocked", receipt: { evidence: { reason: "thread_depth_cap" } } });
});

it("sends a reply and a room reply once each through the gate", async () => {
  const [reply, room] = [await queuedReply({ origin: "owner" }), await queuedRoom()];
  expect([reply.action, room.action]).toMatchObject([{ kind: "reply", status: "approved", messageId: reply.message.id, origin: "owner" }, { kind: "room_reply", status: "approved", messageId: room.message.id, origin: "owner" }]);
  expect(await inOrg(room.orgId, (tx) => tx.select().from(jobs).where(eq(jobs.idempotencyKey, `post:${room.message.id}`)))).toEqual([]);
  for (const f of [reply, room]) expect([await f.send(), await f.send()]).toMatchObject([{ status: "confirmed", clicked: true }, { status: "not_queued" }]);
  expect([reply.driver.posted.length, room.driver.roomWrites.length]).toEqual([1, 1]);
  expect([await reply.current(), await roomMessage(room)]).toMatchObject([{ status: "posted", externalUrn: "urn:li:reply:mock-1" }, { status: "posted", externalUrn: "urn:li:comment:mock-room-1" }]);
});

it.each(["comment", "reply", "room_reply"] as const)("converts an in-flight %s without a second send", async (kind) => {
  for (const status of ["posting", "approved"] as const) {
    const legacy = await legacySend(kind, status);
    expect(legacy.converted).toMatchObject(status === "posting" ? { status: "uncertain", fenceToken: legacy.fence } : { status: "approved" });
    expect(await legacy.send()).toMatchObject({ status: status === "posting" ? "not_queued" : "confirmed" });
    expect(legacy.writes()).toBe(status === "posting" ? 0 : 1);
  }
});

it("refuses an answer about a converted send that may still be going out", async () => {
  const legacy = await legacySend("comment", "posting");
  const answer = () => inOrg(legacy.orgId, (tx) => resolveOutcome(tx, { ref: { kind: "act", id: legacy.converted.id }, observed: "not_sent", by: "owner:test" }));
  const first = await answer();
  await inOrg(legacy.orgId, (tx) => tx.execute(sql`update actions set attempts = jsonb_set(attempts, '{0,startedAt}', '0')`));
  expect([first, await answer()]).toMatchObject([{ reason: "in_flight" }, { ok: true }]);
});

it("moves a worker's in-flight comment onto its Comment binding, or back to the owner without one", async () => {
  const [auto, off] = [await queuedComment(), await queuedComment({ comment: "off" })];
  for (const f of [auto, off]) await inOrg(f.orgId, async (tx) => {
    await rewindToLegacy(tx, f.message.id, { status: "approved", scheduledAt: Date.now() - 1000 });
    await convertLegacy(tx, "comment", f.orgId);
  });
  const [moved] = await actionRows(auto.orgId);
  expect([moved, await dispatchAction({ organizationId: auto.orgId, driver: auto.driver }, moved!.id)]).toMatchObject([{ status: "reserved", actionBindingId: expect.any(String) }, { status: "confirmed" }]);
  expect([await actionRows(off.orgId), await off.current()]).toMatchObject([[], { status: "proposed", error: "review_required" }]);
});

it.each(["resolved_not_posted", "already_committed"] as const)("folds an answer queued for the old resolver into a fenced action that closes the journal: %s", async (state) => {
  const f = await queuedComment();
  await inOrg(f.orgId, async (tx) => {
    await rewindToLegacy(tx, f.message.id, { status: "proposed", redraftRequestVersion: 1 });
    await tx.execute(sql`insert into jobs (organization_id, type, payload, status, attempts, max_attempts, next_run_at, idempotency_key, created_at, updated_at)
      values (${f.orgId}, 'reconcile_message_write', ${JSON.stringify({ messageId: f.message.id, requestVersion: 1, sealedResolution: "sealed" })}::jsonb, 'queued', 0, 5, 0, 'resolve', 0, 0)`);
    await convertLegacy(tx, "comment", f.orgId);
  });
  const asked: Array<[string, number]> = [];
  Object.assign(f.driver, { resolveUncertainWriteOutcome: async (input: PostInput, resolutionVersion: number) =>
    (asked.push([input.marker, resolutionVersion]), { operationId: input.marker, state, resolutionVersion, externalUrn: "urn:li:comment:landed" }) });
  const [folded] = await actionRows(f.orgId);
  expect(folded).toMatchObject({ status: "uncertain", statusReason: "owner_answered:not_sent", fenceToken: `post:${f.message.id}:0` });
  await drainActions({ organizationId: f.orgId, driver: f.driver }, folded!.channelId);
  const [job] = await inOrg(f.orgId, (tx) => tx.select().from(jobs).where(eq(jobs.idempotencyKey, "resolve")));
  expect([job!.status, asked, (await actionRows(f.orgId))[0]!.status, (await f.current()).status])
    .toEqual(["done", [[f.message.dedupeKey, 1]], ...(state === "resolved_not_posted" ? ["definitely_not_sent", "proposed"] : ["uncertain", "needs_review"])]);
});

it("holds every approved action kind at the kill switch before dispatch", async () => {
  const f = await liveAmbassador();
  const ids = await withOrg(f.orgId, async (tx) => {
    const inserted = await insertGatedKinds(tx, f, "awaiting_review");
    for (const id of inserted) await approveAction(tx, { id, approver: "owner:test" });
    await setKillSwitch(tx, true);
    return inserted;
  });
  for (const id of ids) {
    expect(await dispatchAction({ organizationId: f.orgId, driver: f.driver, operations: {} }, id)).toMatchObject({ status: "held", reason: "kill switch" });
    expect(await actionRow(f, id)).toMatchObject({ status: "approved", statusReason: "held:kill switch" });
  }
  expect(f.driver.likedComments).toEqual([]);
});

it("decide relays the owner's word on a draft: a stale view changes nothing, and no yes presses the driver", async () => {
  const f = await queuedComment();
  const ctx = buildMcpCtx(f.orgId);
  const ref = `msg:${f.message.id}`;
  expect(parse(await v2call(ctx, "decide", { ref, verdict: "approve", expectedStatus: "proposed" }))).toMatchObject({ code: "stale_state", currentStatus: "approved" });
  expect(parse(await v2call(ctx, "decide", { ref: "lead:1", verdict: "approve" }))).toMatchObject({ code: "ref_kind_not_accepted" });
  expect(parse(await v2call(ctx, "decide", { ref, verdict: "unschedule" }))).toMatchObject({ ok: true, status: "proposed" });
  const before = await f.current();
  expect(parse(await v2call(ctx, "decide", { ref, verdict: "approve", variant: 999, likeWithSend: false, expectedStatus: "proposed", version: before.redraftRequestVersion }))).toMatchObject({ code: "invalid_state" });
  const after = await f.current();
  expect({ status: after.status, version: after.redraftRequestVersion, like: after.likeWithSend }).toEqual({ status: before.status, version: before.redraftRequestVersion, like: before.likeWithSend });
  expect(parse(await v2call(ctx, "decide", { ref: "offer:1", verdict: "approve", version: 1 }))).toMatchObject({ code: "version_not_supported" });
  expect(parse(await v2call(ctx, "list_activity", { view: "waiting" }))).toMatchObject({ rows: [{ ref, why: { code: "waiting_on_yes" } }] });
  await inOrg(f.orgId, (tx) => setKillSwitch(tx, true));
  expect(parse(await v2call(ctx, "decide", { ref, verdict: "approve" }))).toMatchObject({ ok: true });
  expect(await f.current()).toMatchObject({ status: "approved", publishOrigin: "worker" });
  expect(parse(await v2call(ctx, "list_activity", { view: "upcoming", refs: [ref] }))).toMatchObject({ rows: [{ ref, why: { code: "scheduled" } }] });
  expect(f.driver.posted).toHaveLength(0);
  const ledger = await liveAmbassador();
  const action = await reserve(ledger);
  const ledgerCtx = buildMcpCtx(ledger.orgId);
  expect(parse(await v2call(ledgerCtx, "decide", { ref: `act:${action.id}`, verdict: "approve", version: 0 }))).toMatchObject({ code: "version_not_supported" });
  expect(parse(await v2call(ledgerCtx, "decide", { ref: `act:${action.id}`, verdict: "approve", expectedStatus: "confirmed" }))).toMatchObject({ code: "stale_state" });
  expect((await actionRow(ledger, action.id)).status).toBe(action.status);
  await inOrg(f.orgId, async (tx) => {
    for (let i = 0; i < 26; i++) {
      const urn = `urn:li:activity:page${i}`;
      const [post] = await tx.insert(discoveredPosts).values({ campaignId: f.message.campaignId!, postUrn: urn, contentText: "Page", status: "new" }).returning();
      await tx.insert(messages).values({ kind: "comment", campaignId: f.message.campaignId!, discoveredPostId: post!.id, proposedText: "Page", status: "proposed", dedupeKey: dedupeKey("comment", f.message.campaignId!, urn) });
    }
  });
  const page = parse(await v2call(ctx, "list_activity", { view: "waiting", kind: "comment" }));
  const next = parse(await v2call(ctx, "list_activity", { view: "waiting", kind: "comment", cursor: page.nextCursor }));
  expect([page.total, (page.rows as unknown[]).length, (next.rows as unknown[]).length, next.nextCursor]).toEqual([26, 25, 1, null]);
});

it("act saves the owner's comment as the owner's and queues it for the drain, and a Stop refuses the like press", async () => {
  const f = await queuedComment();
  const ctx = buildMcpCtx(f.orgId);
  const postId = async (urn: string) => inOrg(f.orgId, async (tx) => (await tx.insert(discoveredPosts).values({
    campaignId: f.message.campaignId!, postUrn: urn, authorProfileId: "urn:li:person:y", contentText: "Another post", postedAt: Date.now() - 3_600_000, status: "new",
  }).returning())[0]!.id);
  const first = parse(await v2call(ctx, "act", { ref: `post:${await postId("urn:li:activity:t2")}`, kind: "comment", text: "Our reporting took two days too." }));
  expect(first).toMatchObject({ ok: true });
  expect((await inOrg(f.orgId, (tx) => tx.select().from(messages).where(eq(messages.id, first.messageId as number))))[0]).toMatchObject({ publishOrigin: "owner" });
  expect(parse(await v2call(ctx, "act", { ref: `post:${f.message.discoveredPostId}`, kind: "comment", text: "Twice." }))).toMatchObject({ code: "already_commented" });
  await inOrg(f.orgId, (tx) => stopScope(tx, { scope: "campaign", scopeId: f.message.campaignId!, by: "test" }));
  const stoppedPost = await postId("urn:li:activity:t3");
  expect(parse(await v2call(ctx, "act", { ref: `post:${stoppedPost}`, kind: "comment", text: "My words." }))).toMatchObject({ code: "action_stopped" });
  expect(await inOrg(f.orgId, (tx) => tx.select().from(messages).where(eq(messages.discoveredPostId, stoppedPost)))).toHaveLength(0);
  expect(parse(await v2call(ctx, "resolve_outcome", { ref: "receipt:0", observed: "went_out" }))).toMatchObject({ code: "invalid_ref" });
  expect(parse(await v2call(ctx, "act", { ref: `post:${f.message.discoveredPostId}`, kind: "like" }))).toMatchObject({ code: "action_stopped" });
  expect([f.driver.posted, f.driver.likedPosts]).toEqual([[], []]);
});
