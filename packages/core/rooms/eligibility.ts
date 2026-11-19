import { sql, type SQL } from "drizzle-orm";
import { rateLimitLedger } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { completedLedgerActionPredicate } from "../ratelimit/ledger";
import { FREE_WORKSPACE_LEDGER_SOURCE } from "./importedHistory";

export const ROOM_RETENTION_MS = 90 * 86_400_000;

/** Discovery writes and erasure take this lock before campaign/research
 * rows. A read that finished outside the transaction must recheck exclusions. */
export async function lockRoomEvidence(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('room_evidence:' || current_setting('app.current_org'))) `);
}

export function roomExcludedSql(profileId: SQL, memberUrn: SQL, key: SQL, aliases: SQL) {
  return sql`exists (select 1 from room_exclusions excluded
    where excluded.identity_key = ${key} or excluded.person_key = ${key}
      or excluded.identity_key = 'p.' || ${profileId}
      or excluded.identity_key = 'm.' || substring(${memberUrn} from 20)
      or exists (select 1 from ${aliases} excluded_alias
        where excluded_alias.profile_id = ${profileId}
          and excluded.identity_key = 'm.' || substring(excluded_alias.urn from 20)))`;
}

/** Contact is a confirmed outbound receipt on this account. A conversation,
 * draft, approval, queue row, or uncertain result is never contact. Imported
 * uncertainty spends pacing budget but does not establish contact. */
export function roomContactSql(profileId: SQL, memberUrn: SQL, channelId: SQL) {
  return sql`(
    exists (select 1 from ${rateLimitLedger}
      where ${rateLimitLedger.channelId} = ${channelId}
        and (${rateLimitLedger.targetProfileId} = ${profileId} or ${rateLimitLedger.targetMemberUrn} = ${memberUrn})
        and ${rateLimitLedger.action} in ('comment', 'reply', 'room_reply', 'like', 'like_target', 'invite', 'accept_invite', 'dm', 'followup')
        and (${rateLimitLedger.meta} ->> 'source' is distinct from ${FREE_WORKSPACE_LEDGER_SOURCE}
          or ${rateLimitLedger.meta} ->> 'outcome' = 'posted')
        and ${completedLedgerActionPredicate()})
    or exists (select 1 from actions contact where contact.channel_id = ${channelId}
      and contact.author_profile_id = ${profileId} and contact.status = 'confirmed' and contact.kind <> 'withdraw_invite')
    or exists (select 1 from messages contact
      join campaigns contact_campaign on contact_campaign.id = contact.campaign_id
      left join incoming_comments reply on reply.id = contact.incoming_comment_id
      left join discovered_posts post on post.id = contact.discovered_post_id
      where contact.status = 'posted' and contact_campaign.channel_id = ${channelId}
        and (contact.kind <> 'room_reply' or nullif(contact.external_urn, '') is not null)
        and (coalesce(contact.target_profile_id, reply.author_profile_id,
          case when contact.kind = 'comment' then post.author_profile_id end) = ${profileId}
          or reply.author_member_urn = ${memberUrn}
          or (contact.kind = 'room_reply' and contact.external_urn is not null and contact.room_reply_target->>'memberUrn' = ${memberUrn})))
  )`;
}
