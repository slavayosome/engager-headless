import { sql } from "drizzle-orm";
import type { Tx } from "@engager/database/tenant";
import { memberProfilesSql, resolvePersonKeys } from "../people/directory";
import { applyPreparedMessageDecision, prepareMessageDecision, snapshotMessageDecision } from "./messages";

/** Cancel only work that has not begun sending. Reuse message decisions so
 * revision checks and feedback stay consistent, without any model/learning
 * phase. An in-flight or uncertain message remains for reconciliation. */
export async function cancelPersonMessages(tx: Tx, keys: readonly string[]): Promise<number> {
  if (!keys.length) return 0;
  const aliases = await resolvePersonKeys(tx, keys);
  const targets = [...new Set([...keys, ...aliases.values()])];
  const values = sql.join(targets.map((key) => sql`${key}`), sql`, `);
  const { rows } = await tx.execute<{ id: number }>(sql`
    with member_profiles as (${memberProfilesSql()})
    select message.id::int as id from messages message
      left join incoming_comments reply on reply.id = message.incoming_comment_id
      left join discovered_posts post on post.id = message.discovered_post_id
      left join member_profiles alias on alias.urn = coalesce(reply.author_member_urn, message.room_reply_target->>'memberUrn')
    where message.status in ('proposed', 'approved') and (
      'p.' || coalesce(message.target_profile_id, reply.author_profile_id, alias.profile_id,
        case when message.kind = 'comment' then post.author_profile_id end) in (${values})
      or 'm.' || substring(coalesce(reply.author_member_urn, message.room_reply_target->>'memberUrn') from 20) in (${values}))
    order by message.id`);
  let cancelled = 0;
  for (const row of rows) {
    const snapshot = await snapshotMessageDecision(tx, { messageId: row.id, verdict: "reject" });
    if (!snapshot.ok) continue;
    const prepared = await prepareMessageDecision(snapshot.snapshot, { llm: null });
    if ((await applyPreparedMessageDecision(tx, prepared)).ok) cancelled += 1;
  }
  return cancelled;
}
