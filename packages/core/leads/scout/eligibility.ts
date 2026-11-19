import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@engager/database/tenant";
import { eligiblePersonSql } from "../../discovery/roomPopulation";
import { memberProfilesSql } from "../../people/directory";

/**
 * WHO MAY BE JUDGED. A signal's person is out of reach when the owner has put
 * them there, by the rule room discovery reads (`eligiblePersonSql`): erased or
 * excluded, on do-not-engage, or on a conversation the owner closed with no newer
 * one. Asked again wherever a stage would otherwise carry someone further, since
 * the owner's rules can move while a model call is out.
 */
export type SignalStanding = {
  id: number;
  /** Their profile id, as the signal names it or as the member directory ties
   *  its member urn to one; null where neither does. */
  profileId: string | null;
  eligible: boolean;
};

/**
 * The `select` every read of signals' standing is cut from: the signals `where`
 * names, each with its person's profile, whether the rules leave them within
 * reach, and when its words were said. Run under `with member_profiles as
 * (...)`, which a signal's member urn is tied to a profile through.
 */
export function signalStandingsSql(where: (profile: SQL) => SQL): SQL {
  const profile = sql`coalesce(signal.profile_id, alias.profile_id)`;
  const key = sql`coalesce('p.' || ${profile}, signal.person_key)`;
  return sql`
    select signal.id::int as id, ${profile} as "profileId",
      ${eligiblePersonSql(profile, sql`signal.member_urn`, key, "all")} as eligible,
      coalesce(signal.said_at, signal.seen_at) as "saidAt"
    from lead_signals signal
    join campaigns current on current.id = signal.campaign_id
    left join member_profiles alias on alias.urn = signal.member_urn
    where ${where(profile)}`;
}

/** The signals `where` names, as they stand now, lowest id first. */
export async function standings(tx: Tx, where: (profile: SQL) => SQL, limit: number): Promise<SignalStanding[]> {
  const read = await tx.execute<SignalStanding>(sql`
    with member_profiles as (${memberProfilesSql()})
    select standing.id, standing."profileId", standing.eligible
    from (${signalStandingsSql(where)}) standing
    order by standing.id
    limit ${limit}`);
  return read.rows;
}

/** These signals, as they stand now. */
export function standingsOf(tx: Tx, ids: readonly number[]): Promise<SignalStanding[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return standings(tx, () => sql`signal.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`, ids.length);
}

/** A lead, as the rules stand for them now. */
export type LeadStanding = {
  id: number;
  profileId: string;
  eligible: boolean;
};

/**
 * The owner rules as they apply to a lead's profile id on its campaign's
 * account. It brings its own member directory and campaign, so it reads under
 * any query that has the lead's profile id and campaign id in hand.
 */
export function eligibleLeadSql(profileId: SQL, campaignId: SQL): SQL {
  return sql`exists (
    with member_profiles as (${memberProfilesSql()})
    select 1 from campaigns current
    where current.id = ${campaignId}
      and ${eligiblePersonSql(profileId, sql`null::text`, sql`'p.' || ${profileId}`, "all")})`;
}

/**
 * These leads' persons against the same rule, for a stage that reads or serves
 * them after the screen. A lead is keyed by the profile id it requires, so the
 * member directory has nothing to add.
 */
export async function leadStandings(tx: Tx, campaignId: number, ids: readonly number[]): Promise<LeadStanding[]> {
  if (ids.length === 0) return [];
  const read = await tx.execute<LeadStanding>(sql`
    select lead.id::int as id, lead.profile_id as "profileId",
      ${eligibleLeadSql(sql`lead.profile_id`, sql`${campaignId}`)} as eligible
    from leads lead
    where lead.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    order by lead.id`);
  return read.rows;
}
