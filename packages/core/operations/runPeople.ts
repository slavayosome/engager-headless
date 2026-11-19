import { sql } from "drizzle-orm";
import type { Tx } from "@engager/database/tenant";
import { memberProfilesSql } from "../people/directory";

/** The same identity resolution and verdict aggregation as runPeople. */
export async function pageRunPeople(tx: Tx, campaignId: number, runId: number, after: string | null, limit = 100) {
  const rows = await tx.execute<{
    key: string; leadId: number | null; name: string | null; headline: string | null;
    words: string; verdict: string; reason: string | null; dropReason: string | null;
    role: string | null; fit: string | null; intent: string | null; intentQuote: string | null;
  }>(sql`
    with member_profiles as (${memberProfilesSql()}), person as (
      select word.*, coalesce('p.' || coalesce(linked.profile_id, word.profile_id, alias.profile_id), word.person_key) as person_key_resolved
      from lead_signals word
      left join leads linked on linked.id = word.lead_id
      left join member_profiles alias on alias.urn = word.member_urn
      where word.campaign_id = ${campaignId} and word.run_id = ${runId}
    ), grouped as (
      select person_key_resolved as key, max(lead_id)::int as lead_id,
        bool_or(verdict = 'passed') as passed,
        (array_agg(id order by case when verdict = 'passed' then 0 when verdict = 'dropped' then 1 else 2 end,
          coalesce(said_at, seen_at) desc, id desc))[1] as signal_id
      from person group by person_key_resolved
    )
    select grouped.key, grouped.lead_id as "leadId", word.name, word.headline, word.words,
      case when grouped.passed then 'passed' else word.verdict end as verdict,
      word.reason, word.drop_reason as "dropReason", coalesce(lead.role, word.role) as role, lead.fit, lead.intent, lead.intent_quote as "intentQuote"
    from grouped join person word on word.id = grouped.signal_id
    left join leads lead on lead.id = grouped.lead_id and lead.campaign_id = ${campaignId}
    where (${after}::text is null or grouped.key > ${after})
    order by grouped.key limit ${limit + 1}
  `);
  return { people: rows.rows.slice(0, limit), next: rows.rows.length > limit ? rows.rows[limit - 1]!.key : null };
}
