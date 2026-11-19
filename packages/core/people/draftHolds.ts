import { eq, sql } from "drizzle-orm";
import { channels, rateLimitLedger } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  completedLedgerActionPredicate,
  PER_PROFILE_WINDOWS,
  type PerProfileCap,
  type PerProfileChannel,
} from "../ratelimit/ledger";
import { memberProfilesSql } from "./directory";
import { parsePersonKey, personKey } from "./key";
import { decisionsWaiting, type Wait } from "./waits";

/**
 * WHEN A PERSON'S NEXT POST MAY BE DRAFTED — comment drafting is
 * person-aware, and these are its two rules, read for everyone at once so a
 * worker's selection, the intake behind it and the person's pane agree:
 *
 *  - ONE DECISION AT A TIME. While anything about a person waits for the
 *    owner's yes (`DECISION_KINDS`: a comment, reply or room-reply draft, a
 *    like, an invite, a DM, their invitation), no new post of theirs is
 *    drafted. Once it settles — sent, skipped, rejected or expired — their
 *    next eligible post may be.
 *  - THEIR ALLOWANCE. The account's per-person day, week and month caps,
 *    which the send gate counts in touches that went out
 *    (`perProfileCapRefusal`), counted here with what is already on its way
 *    to them: every comment, reply and room reply scheduled or waiting for a
 *    yes, on any campaign on the account, counts in every window until it
 *    posts.
 *
 * A held post is not refused. It stays a match, and is drafted once its
 * person frees while it is still inside its campaign's max post age: nothing
 * is stored, so every run reads the rules again.
 *
 * Unattended drafting only. The owner's own words are only spaced, and a draft
 * the owner asked for by name is theirs to ask for.
 *
 * Reads only, inside the caller's `withOrg`; every table read is under RLS.
 */

export type DraftHold =
  /** Something about them waits for the owner's yes: the oldest of it. */
  | { kind: "decision"; wait: Wait }
  /** Their allowance in `cap`'s window is spent, counting what is on its way
   *  to them. */
  | { kind: "allowance"; cap: PerProfileCap };

const DAY = 86_400_000;
const MONTH = 30 * DAY;

/** Our sends to someone that have not gone out yet: each counts against their
 *  allowance from the moment it is drafted until it posts, and a send that
 *  failed or was turned down never will. */
const ON_ITS_WAY = ["proposed", "approved", "posting", "needs_review"] as const;

type AllowanceRow = { profile_id: string } & Record<PerProfileCap, number>;

/** Each person's touches on the account in every window the caps count —
 *  those that went out, by when, and those on their way, as now — for
 *  everyone, or for one profile. */
async function allowances(
  tx: Tx,
  channel: PerProfileChannel,
  now: number,
  profileId?: string,
): Promise<AllowanceRow[]> {
  const { rows } = await tx.execute(sql`
    with member_profiles as (${memberProfilesSql()}),
    touches as (
      select coalesce(nullif(${rateLimitLedger.targetProfileId}, ''), alias.profile_id) as profile_id,
        ${rateLimitLedger.ts} as at
      from ${rateLimitLedger}
      left join member_profiles alias
        on nullif(${rateLimitLedger.targetProfileId}, '') is null and alias.urn = ${rateLimitLedger.targetMemberUrn}
      where ${rateLimitLedger.channelId} = ${channel.id}
        and ${rateLimitLedger.action} in ('comment', 'reply', 'room_reply')
        and ${rateLimitLedger.ts} >= ${now - MONTH}
        and ${completedLedgerActionPredicate()}
      union all
      select coalesce(nullif(reply.author_profile_id, ''), nullif(post.author_profile_id, ''), m.target_profile_id),
        ${now}::bigint
      from messages m
      join campaigns campaign on campaign.id = m.campaign_id
      left join discovered_posts post on post.id = m.discovered_post_id
      left join incoming_comments reply on reply.id = m.incoming_comment_id
      where campaign.channel_id = ${channel.id}
        and m.status in (${sql.join(
          ON_ITS_WAY.map((status) => sql`${status}`),
          sql`, `,
        )})
    )
    select profile_id,
      (count(*) filter (where at >= ${now - DAY}))::int as day,
      (count(*) filter (where at >= ${now - 7 * DAY}))::int as week,
      count(*)::int as month
    from touches
    where ${profileId === undefined ? sql`profile_id is not null` : sql`profile_id = ${profileId}`}
    group by profile_id`);
  return rows as AllowanceRow[];
}

/** The first window whose cap the counts reach, in the order the send gate
 *  reads them; null while every cap still has room. */
function spentCap(row: AllowanceRow, channel: PerProfileChannel): PerProfileCap | null {
  const caps: Record<PerProfileCap, number> = {
    day: channel.perProfileDayCap,
    week: channel.perProfileWeekCap,
    month: channel.perProfileMonthCap,
  };
  for (const [cap] of PER_PROFILE_WINDOWS) {
    if (caps[cap] > 0 && row[cap] >= caps[cap]) return cap;
  }
  return null;
}

async function perProfileChannel(tx: Tx, channelId: number | null): Promise<PerProfileChannel | null> {
  if (channelId === null) return null;
  const [channel] = await tx
    .select({
      id: channels.id,
      perProfileDayCap: channels.perProfileDayCap,
      perProfileWeekCap: channels.perProfileWeekCap,
      perProfileMonthCap: channels.perProfileMonthCap,
    })
    .from(channels)
    .where(eq(channels.id, channelId));
  return channel ?? null;
}

/**
 * Everyone whose next post is held now, by profile id, on the account
 * `channelId` names: a decision before an allowance, since the decision is
 * the owner's to make first. With no account, only decisions hold.
 */
export async function draftHolds(
  tx: Tx,
  channelId: number | null,
  now: number,
): Promise<Map<string, DraftHold>> {
  const holds = new Map<string, DraftHold>();
  for (const [key, wait] of await decisionsWaiting(tx)) {
    const parsed = parsePersonKey(key);
    if (parsed?.kind === "profile") holds.set(parsed.profileId, { kind: "decision", wait });
  }
  const channel = await perProfileChannel(tx, channelId);
  if (channel === null) return holds;
  for (const row of await allowances(tx, channel, now)) {
    const cap = holds.has(row.profile_id) ? null : spentCap(row, channel);
    if (cap !== null) holds.set(row.profile_id, { kind: "allowance", cap });
  }
  return holds;
}

/** Whether one person's next post is held now, and why — `draftHolds` for
 *  one profile id. */
export async function draftHoldFor(
  tx: Tx,
  channelId: number | null,
  profileId: string,
  now: number,
): Promise<DraftHold | null> {
  const key = personKey({ profileId });
  const wait = key === null ? undefined : (await decisionsWaiting(tx, { key })).get(key);
  if (wait) return { kind: "decision", wait };
  const channel = await perProfileChannel(tx, channelId);
  if (channel === null) return null;
  const [row] = await allowances(tx, channel, now, profileId);
  const cap = row ? spentCap(row, channel) : null;
  return cap === null ? null : { kind: "allowance", cap };
}

/** How every word about the rule starts — a hold's note, and the reason a
 *  draft it closed carries (migration 0250) — so the pane can find them. */
export const ONE_AT_A_TIME = "One at a time";

/** What waits for the owner's yes, as a hold names it. */
const DECISION_NOUN: Partial<Record<Wait["kind"], string>> = {
  comment_draft: "a comment",
  reply_draft: "a reply",
  room_reply_draft: "a reply to their comment",
  like_to_approve: "a like",
  invite_to_approve: "an invite",
  dm_draft: "a message",
  accept_invite: "their invitation",
};

/** What a decision hold is waiting on, in the owner's words: "a like waiting
 *  for your yes". */
export function waitingDecision(wait: Pick<Wait, "kind">): string {
  return `${DECISION_NOUN[wait.kind] ?? "something"} waiting for your yes`;
}

/** Why a person's next post is not drafted now, in the owner's words. */
export function draftHoldNote(hold: DraftHold): string {
  return hold.kind === "decision"
    ? `${ONE_AT_A_TIME} — ${waitingDecision(hold.wait)} comes first`
    : `Their ${hold.cap === "day" ? "daily" : `${hold.cap}ly`} allowance on this account is used`;
}
