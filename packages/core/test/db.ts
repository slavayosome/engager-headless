import { randomUUID } from "node:crypto";
import { db } from "@engager/database";
import {
  campaigns,
  channels,
  organizations,
  workers,
} from "@engager/database/schema";
import { eq } from "drizzle-orm";
import { withOrg, type Tx } from "@engager/database/tenant";
import { withEntryBoundary } from "./boundary";
import { runtimeInstanceId } from "../execution/authority";

/**
 * Run a test body inside a fresh org's RLS-scoped transaction. Each call creates
 * a unique org (no TRUNCATE), so concurrent test files stay isolated via RLS.
 *
 * These factories insert the org row DIRECTLY, so they do not run
 * `bootstrapLocalOrg`. They mint the org's `channels` row themselves instead,
 * because every org in production has one from the migration seed or that
 * bootstrap, and a factory org without one would silently skip the
 * account-level ceilings that `canEngage` enforces — a whole class of caps
 * quietly not binding in tests that assert they do.
 *
 * `dailyEngageCap` / `minActionGapSec` overrides land on the channel row, which
 * is where `canEngage` reads them and, since the contract release, the only
 * place they exist. A test that needs the row genuinely absent deletes it.
 */

/** The ceilings a test names as the org's but the account actually enforces —
 *  the org factories take them at that name and route them to the channel. */
const CHANNEL_CEILING_KEYS = ["dailyEngageCap", "minActionGapSec"] as const;

/** Split an org factory's overrides into what `organizations` takes and what
 *  the channel row does. */
function splitOrgOverrides(overrides: Record<string, unknown>): {
  org: Record<string, unknown>;
  ceilings: Record<string, unknown>;
} {
  const org: Record<string, unknown> = { ...overrides };
  const ceilings: Record<string, unknown> = {};
  for (const key of CHANNEL_CEILING_KEYS) {
    if (overrides[key] === undefined) continue;
    ceilings[key] = overrides[key];
    delete org[key];
  }
  return { org, ceilings };
}

/** Mint the org's one channel row, carrying any ceiling overrides.
 *
 *  Write authority is GRANTED here, unlike production's default-off: the send
 *  suites exist to exercise the caps, the plan and the exactly-once path, and
 *  every one of them would stop at the writes_off gate instead. A test whose
 *  subject IS that gate revokes it explicitly
 *  (`mkChannel(tx, { writesEnabled: false })`). */
async function seedChannel(
  organizationId: string,
  ceilings: Record<string, unknown>,
): Promise<void> {
  await withOrg(organizationId, (tx) =>
    tx.insert(channels).values({
      organizationId, writesEnabled: true, ...ceilings,
      externalAccountId: "mock-account", executionAccountId: "mock-account",
      executionRuntimeId: runtimeInstanceId(), executionPlacement: "local",
      executionEpoch: 1, executionState: "active",
    }),
  );
}

export async function withTestOrg<T>(
  fn: (tx: Tx, orgId: string) => Promise<T>,
  orgOverrides: Record<string, unknown> = {},
): Promise<T> {
  const { org, ceilings } = splitOrgOverrides(orgOverrides);
  const [o] = await db
    .insert(organizations)
    .values({ slug: `t-${randomUUID()}`, name: "t", ...org })
    .returning();
  await seedChannel(o!.id, ceilings);
  // Also the test's entry boundary: production pairs `withOrg` with a usage
  // scope at every entry point, and a body that reaches inference needs the one
  // `modelFor` reads.
  //
  // That is a WIDER contract than "a fresh org's transaction", and every caller
  // gets it. `recordUsage` now buffers to the scope instead of writing
  // immediately — no visible difference in a suite, where the flush is skipped
  // outright (`ai/usage.ts`) — and `claimProviderUsageContext()` answers with a
  // context where it used to answer `undefined`. Its one reader is
  // `reserveHostedAiCall`, which only the REAL provider clients reach and whose
  // missing-context refusal fires only under `enforcementEnabled()`: a dev/prod
  // `ENGAGER_DEPLOYMENT_ENV`, or `ENGAGER_HOSTED_AI_BUDGET_ENFORCE_IN_TEST=true`
  // under vitest. The two suites that pin that refusal set the deployment
  // environment themselves and open no test org. A test that wants the
  // no-context path must keep building its org by hand.
  return withEntryBoundary(() => withOrg(o!.id, (tx) => fn(tx, o!.id)), {
    organizationId: o!.id,
  });
}

/**
 * What every factory campaign is, before overrides — shared by `mkCampaign` and
 * `mkCampaignFor` so the two cannot drift, and exported so the shape itself can
 * be asserted (db.test.ts).
 *
 * No retired mode column. The overrides are typed (`CampaignOverrides` — the
 * campaign's own columns plus the account pacing keys the factory routes to the
 * channel) rather than `Record<string, unknown>`
 * so a stale key naming a dropped column is a compile error HERE — drizzle
 * drops unknown keys in silence, so an untyped factory would take one green.
 * That is a guard on this call site, not on the whole suite: a handful of files
 * still wrap these factories in their own `over: Record<string, unknown>`
 * helper, and a spread of that erases excess-property checking again.
 */
export const TEST_CAMPAIGN_DEFAULTS = {
  name: "test",
  objective: "engage",
} as const;

/** The pacing and spacing columns the send gate reads off the CHANNEL, and
 *  since the contract release the only row that has them. A test still names
 *  them at `mkCampaign`, because "this campaign paces like so" is how a suite
 *  reads — the factory routes them to the account they actually describe. */
const CHANNEL_PACING_KEYS = [
  "dailyCommentCap",
  "dailyReplyCap",
  "activeHours",
  "activeDays",
  "minDelaySec",
  "perProfileDayCap",
  "perProfileWeekCap",
  "perProfileMonthCap",
  "warmupWeeks",
  "warmupStartedAt",
  "warmupStartRate",
] as const;

/** What `mkCampaignFor` accepts: campaign columns plus the account's own
 *  pacing, which the factory routes to the channel they describe. Exported so a
 *  fixture can type a shared target shape once rather than re-deriving it at
 *  each call site. */
export type CampaignOverrides = Partial<typeof campaigns.$inferInsert> &
  Partial<Pick<typeof channels.$inferInsert, (typeof CHANNEL_PACING_KEYS)[number]>>;

/**
 * Insert a campaign in the current org scope and return the row — WITH its
 * Scout, because a campaign without one is a shape the product cannot produce.
 *
 * `createCampaignOp` provisions one on every path a real target is created on,
 * so a fixture that inserted the campaign alone would hand every suite a campaign
 * whose Discover button has nothing to run as. Provisioned here rather than by
 * calling the operation: the operation asserts a public input shape these
 * fixtures deliberately do not have, and takes the policy locks with it.
 */
export async function mkCampaign(tx: Tx, overrides: CampaignOverrides = {}) {
  const { campaign, pacing } = splitCampaignOverrides(overrides);
  if (Object.keys(pacing).length > 0) await tx.update(channels).set(pacing);
  const [c] = await tx
    .insert(campaigns)
    .values({
      ...TEST_CAMPAIGN_DEFAULTS,
      channelId: await orgChannelId(tx),
      ...campaign,
    })
    .returning();
  await seedScout(tx, c!);
  return c!;
}

/**
 * The account a fixture target spends against.
 *
 * `createCampaignOp` is the only writer of `campaigns.channel_id` and it always
 * stamps, so a campaign without one is a shape the product cannot produce.
 */
async function orgChannelId(tx: Tx): Promise<number | null> {
  const [row] = await tx.select({ id: channels.id }).from(channels);
  return row?.id ?? null;
}

/** The campaign's Scout, in the shape `createCampaignOp` provisions it: armed at
 *  nothing, finding on, named for the campaign and carrying its channel. */
async function seedScout(
  tx: Tx,
  campaign: { id: number; name: string; channelId: number | null },
): Promise<void> {
  await tx.insert(workers).values({
    campaignId: campaign.id,
    channelId: campaign.channelId,
    name: `Scout · ${campaign.name} #${campaign.id}`,
    type: "scout",
    auto: false,
    sweepEnabled: true,
  });
}

/** Split a campaign factory's overrides into what `campaigns` takes and what
 *  the account row does. */
function splitCampaignOverrides(overrides: CampaignOverrides): {
  campaign: Partial<typeof campaigns.$inferInsert>;
  pacing: Record<string, unknown>;
} {
  const campaign: Record<string, unknown> = { ...overrides };
  const pacing: Record<string, unknown> = {};
  for (const key of CHANNEL_PACING_KEYS) {
    if (overrides[key] === undefined) continue;
    pacing[key] = overrides[key];
    delete campaign[key];
  }
  return { campaign, pacing };
}

/** Read the org's one channel row in the current scope. `mkOrg` /
 *  `withTestOrg` already minted it, and the unique key means there is exactly
 *  one — so a test asserting a dual-write reads it rather than seeding it. */
export async function getChannel(tx: Tx) {
  const [c] = await tx.select().from(channels);
  return c!;
}

/** Read a campaign row of the current scope by id. */
export async function getCampaign(tx: Tx, id: number) {
  const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, id));
  return c!;
}

/** The account a test drives, shaped like `mkCampaign` — an UPDATE, because the
 *  org factory already minted the row and the unique key refuses a second. */
export async function mkChannel(
  tx: Tx,
  overrides: Partial<typeof channels.$inferInsert> = {},
) {
  const [c] = await tx.update(channels).set(overrides).returning();
  return c!;
}

/** Create a fresh COMMITTED org and return its id — for testing org-scoped functions
 *  (such as a self-scoped operation) that open their own `withOrg` and so can't see an
 *  outer test transaction's uncommitted rows. */
export async function mkOrg(overrides: Record<string, unknown> = {}): Promise<string> {
  const { org, ceilings } = splitOrgOverrides(overrides);
  const [o] = await db
    .insert(organizations)
    .values({ slug: `t-${randomUUID()}`, name: "t", ...org })
    .returning();
  await seedChannel(o!.id, ceilings);
  return o!.id;
}

/** Insert a COMMITTED campaign in `orgId` and return its id — same defaults as
 *  `mkCampaign` (TEST_CAMPAIGN_DEFAULTS). */
export async function mkCampaignFor(
  orgId: string,
  overrides: CampaignOverrides = {},
): Promise<number> {
  return withOrg(orgId, async (tx) => {
    const { campaign, pacing } = splitCampaignOverrides(overrides);
    if (Object.keys(pacing).length > 0) await tx.update(channels).set(pacing);
    const [c] = await tx
      .insert(campaigns)
      .values({
        ...TEST_CAMPAIGN_DEFAULTS,
        channelId: await orgChannelId(tx),
        ...campaign,
      })
      .returning();
    await seedScout(tx, c!);
    return c!.id;
  });
}

/** Read/assert within `orgId`'s committed RLS scope. */
export function inOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOrg(orgId, fn);
}
