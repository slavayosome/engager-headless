import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { engagedProfiles, rateLimitLedger } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { clearRoomExclusion, excludeRoomIdentity } from "../rooms/retention";
import { authorIdentity } from "../people/key";

/**
 * The engaged-profiles primitive — the seed of the future Leads/contacts model.
 *
 * `engaged_profiles` has no pipeline writer yet: the only production reader is
 * `canEngage` (do-not-engage gate) and rows appear only via `setDoNotEngage`.
 * So the list derives engagement history LIVE from `rate_limit_ledger`
 * (comment/reply actions carry `target_profile_id`) and FULL-OUTER-joins the
 * stored rows, coalescing stored fields over derived ones — when a real
 * bookkeeping writer lands later, stored values win automatically.
 */

export type EngagedProfileRow = {
  profileId: string;
  name: string | null;
  headline: string | null;
  company: string | null;
  url: string | null;
  firstEngagedAt: number | null;
  lastEngagedAt: number | null;
  comments: number;
  replies: number;
  doNotEngage: boolean;
  notes: string | null;
  retainUntil: number | null;
};

export type EngagedProfilesPage = {
  total: number;
  count: number;
  profiles: EngagedProfileRow[];
};

export async function listEngagedProfiles(
  tx: Tx,
  opts: { doNotEngage?: boolean; search?: string; limit?: number; offset?: number; campaignId?: number } = {},
): Promise<EngagedProfilesPage> {
  const derived = tx
    .select({
      profileId: rateLimitLedger.targetProfileId,
      comments: sql<number>`count(*) filter (where ${rateLimitLedger.action} = 'comment')::int`.as(
        "derived_comments",
      ),
      replies: sql<number>`count(*) filter (where ${rateLimitLedger.action} = 'reply')::int`.as(
        "derived_replies",
      ),
      // ::float8 — ms timestamps; pg returns bigint aggregates as strings.
      firstTs: sql<number | null>`min(${rateLimitLedger.ts})::float8`.as("derived_first_ts"),
      lastTs: sql<number | null>`max(${rateLimitLedger.ts})::float8`.as("derived_last_ts"),
    })
    .from(rateLimitLedger)
    .where(
      and(
        inArray(rateLimitLedger.action, ["comment", "reply"]),
        isNotNull(rateLimitLedger.targetProfileId),
        opts.campaignId === undefined ? undefined : eq(rateLimitLedger.campaignId, opts.campaignId),
      ),
    )
    .groupBy(rateLimitLedger.targetProfileId)
    .as("derived");

  const profileId = sql<string>`coalesce(${engagedProfiles.profileId}, ${derived.profileId})`;
  // Stored counters default to 0 until a real writer exists — nullif lets the
  // ledger-derived count show through a zero stored row.
  const comments = sql<number>`coalesce(nullif(${engagedProfiles.totalComments}, 0), ${derived.comments}, 0)::int`;
  const replies = sql<number>`coalesce(nullif(${engagedProfiles.totalReplies}, 0), ${derived.replies}, 0)::int`;
  const firstEngagedAt = sql<
    number | null
  >`coalesce(${engagedProfiles.firstEngagedAt}, ${derived.firstTs})::float8`;
  const lastEngagedAt = sql<
    number | null
  >`coalesce(${engagedProfiles.lastEngagedAt}, ${derived.lastTs})::float8`;
  const doNotEngage = sql<boolean>`coalesce(${engagedProfiles.doNotEngage}, false)`;

  const conds: SQL[] = [];
  if (opts.campaignId !== undefined) conds.push(isNotNull(derived.profileId));
  if (opts.doNotEngage !== undefined) conds.push(sql`${doNotEngage} = ${opts.doNotEngage}`);
  if (opts.search) {
    const like = `%${opts.search}%`;
    conds.push(
      sql`(${engagedProfiles.name} ilike ${like} or ${engagedProfiles.headline} ilike ${like} or ${engagedProfiles.company} ilike ${like} or ${profileId} ilike ${like})`,
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [c] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(engagedProfiles)
    .fullJoin(derived, eq(engagedProfiles.profileId, derived.profileId))
    .where(where);

  const rows = await tx
    .select({
      profileId,
      name: engagedProfiles.name,
      headline: engagedProfiles.headline,
      company: engagedProfiles.company,
      url: engagedProfiles.url,
      firstEngagedAt,
      lastEngagedAt,
      comments,
      replies,
      doNotEngage,
      notes: engagedProfiles.notes,
      retainUntil: engagedProfiles.retainUntil,
    })
    .from(engagedProfiles)
    .fullJoin(derived, eq(engagedProfiles.profileId, derived.profileId))
    .where(where)
    .orderBy(sql`${lastEngagedAt} desc nulls last`, profileId)
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  return { total: c?.n ?? 0, count: rows.length, profiles: rows };
}

/** Flip the do-not-engage flag (upsert — blocking a never-engaged profile must
 *  still block future engagement). `canEngage` enforces the flag before every
 *  comment/reply/like. `notes`/`name`/`url` only overwrite when provided. */
export async function setDoNotEngage(
  tx: Tx,
  input: {
    profileId: string;
    doNotEngage: boolean;
    notes?: string;
    name?: string;
    url?: string;
  },
): Promise<{ profileId: string; doNotEngage: boolean; notes: string | null }> {
  const key = `p.${authorIdentity(input.profileId)}`;
  if (input.doNotEngage) await excludeRoomIdentity(tx, key);
  else await clearRoomExclusion(tx, key);
  const patch = {
    doNotEngage: input.doNotEngage,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
  };
  const [row] = await tx
    .insert(engagedProfiles)
    .values({ profileId: input.profileId, ...patch })
    .onConflictDoUpdate({
      target: [engagedProfiles.organizationId, engagedProfiles.profileId],
      set: patch,
    })
    .returning({
      profileId: engagedProfiles.profileId,
      doNotEngage: engagedProfiles.doNotEngage,
      notes: engagedProfiles.notes,
    });
  return row!;
}
