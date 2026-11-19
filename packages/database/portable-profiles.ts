/**
 * Bringing an archive exported before the profile cache was one table, and
 * before profile ids were lower case, onto this schema: the same merge
 * migration 0319 makes in a database, per organization and never across two.
 * A current archive passes through untouched.
 */
import { PortableArchiveError } from "./portable-export";
import { profileIdKey } from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Rows = Record<string, Row[]>;

/** Every column that names a LinkedIn profile, by table. A reply's author was
 *  its commenter in older archives. */
const PROFILE_COLUMNS: Record<string, string[]> = {
  author_profiles: ["profile_id"], engaged_profiles: ["profile_id"], leads: ["profile_id"],
  lead_signals: ["profile_id"], conversations: ["author_profile_id"], outcome_events: ["author_profile_id"],
  discovered_posts: ["author_profile_id"], actions: ["author_profile_id"],
  search_lookalikes: ["author_profile_id"], incoming_invitations: ["sender_profile_id"],
  incoming_comments: ["author_profile_id", "commenter_profile_id"], messages: ["target_profile_id"],
  rate_limit_ledger: ["target_profile_id"], engagement_events: ["actor_profile_id"], room_members: ["profile_id"],
};

const org = (row: Row) => String(row.organization_id);
const present = (value: unknown) => value !== null && value !== undefined;
const numeric = (value: unknown) => (present(value) ? Number(value) : null);
/** An id written back in the form the archive held it. */
const likeOriginal = (original: unknown, id: number) => (typeof original === "string" ? String(id) : id);

/** The groups of rows that name one person, per organization, in row order. */
function groupsOf(list: Row[], key: (row: Row) => string): Row[][] {
  const groups = new Map<string, Row[]>();
  for (const row of list) {
    const id = `${org(row)}\u0000${key(row)}`;
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  return [...groups.values()];
}

/** The first row's value that is present, in the order given. */
const firstOf = (sorted: Row[], column: string) => sorted.find((row) => present(row[column]))?.[column] ?? null;
const maxOf = (sorted: Row[], column: string) => {
  const values = sorted.flatMap((row) => (present(row[column]) ? [Number(row[column])] : []));
  return values.length ? Math.max(...values) : null;
};
const minOf = (sorted: Row[], column: string) => {
  const values = sorted.flatMap((row) => (present(row[column]) ? [Number(row[column])] : []));
  return values.length ? Math.min(...values) : null;
};

/** Sort by the comparators in turn: the first that tells two rows apart. */
function ordered(list: Row[], ...compare: Array<(a: Row, b: Row) => number>): Row[] {
  return [...list].sort((a, b) => {
    for (const by of compare) {
      const result = by(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
}
const desc = (value: (row: Row) => number | boolean) => (a: Row, b: Row) => Number(value(b)) - Number(value(a));
const asc = (value: (row: Row) => number | boolean) => (a: Row, b: Row) => Number(value(a)) - Number(value(b));
const byIdText = (column: string) => (a: Row, b: Row) => String(a[column]).localeCompare(String(b[column]));

function mergeAuthorProfiles(list: Row[]): Row[] {
  return groupsOf(list, (row) => profileIdKey(String(row.profile_id))).map((group) => {
    const key = profileIdKey(String(group[0]!.profile_id));
    const evidence = (row: Row) => {
      const profile = row.identity_evidence?.read?.profile;
      return typeof profile?.id === "string"
        ? { ...row.identity_evidence, read: { ...row.identity_evidence.read, profile: { ...profile, id: profileIdKey(profile.id) } } }
        : row.identity_evidence;
    };
    const sorted = ordered(
      group,
      desc((row) => Math.max(Number(row.fetched_at ?? 0), Number(row.country_read_at ?? 0), Number(row.relationship_checked_at ?? 0))),
      byIdText("profile_id"),
    ).map((row): Row => ({ ...row, identity_evidence: evidence(row) }));
    if (sorted.length === 1) return { ...sorted[0]!, profile_id: key };
    const checked = ordered(sorted, desc((row) => numeric(row.relationship_checked_at) ?? -1))[0]!;
    const merged: Row = { ...sorted[0]!, profile_id: key };
    for (const column of ["headline", "location", "country", "geo_urn", "followers", "connections", "is_influencer", "is_premium", "identity_evidence"]) {
      merged[column] = firstOf(sorted, column);
    }
    merged.country_read_at = maxOf(sorted, "country_read_at");
    merged.fetched_at = maxOf(sorted, "fetched_at");
    merged.fetch_error = sorted[0]!.fetch_error ?? null;
    merged.relationship = checked.relationship;
    merged.relationship_checked_at = maxOf(sorted, "relationship_checked_at");
    return merged;
  });
}

function mergeEngagedProfiles(list: Row[]): Row[] {
  return groupsOf(list, (row) => profileIdKey(String(row.profile_id))).map((group) => {
    const key = profileIdKey(String(group[0]!.profile_id));
    const sorted = ordered(group, desc((row) => numeric(row.last_engaged_at) ?? 0), byIdText("profile_id"));
    if (sorted.length === 1) return { ...sorted[0]!, profile_id: key };
    const merged: Row = { ...sorted[0]!, profile_id: key };
    for (const column of ["name", "headline", "company", "url"]) merged[column] = firstOf(sorted, column);
    merged.first_engaged_at = minOf(sorted, "first_engaged_at");
    merged.last_engaged_at = maxOf(sorted, "last_engaged_at");
    merged.total_comments = sorted.reduce((sum, row) => sum + Number(row.total_comments ?? 0), 0);
    merged.total_replies = sorted.reduce((sum, row) => sum + Number(row.total_replies ?? 0), 0);
    // A block on any spelling is a block, and is kept for as long as any asked.
    merged.do_not_engage = sorted.some((row) => row.do_not_engage === true);
    merged.retain_until = sorted.some((row) => !present(row.retain_until)) ? null : maxOf(sorted, "retain_until");
    const notes = sorted.flatMap((row) => (present(row.notes) ? [String(row.notes)] : []));
    merged.notes = notes.length ? notes.join("\n") : null;
    return merged;
  });
}

const STAGE_RANK: Record<string, number> = { signal: 1, lead: 2, contacted: 3, no_answer: 3 };
const TIER_RANK: Record<string, number> = { watch: 1, warm: 2, hot: 3 };
const STATUS_RANK: Record<string, number> = { dead: 1, new: 2, contacted: 3, in_conversation: 4, converted: 5 };
const INTENT_RANK: Record<string, number> = { none: 1, positive_signal: 2, product_question: 3, explicit_ask: 4 };
const rank = (table: Record<string, number>, value: unknown) => table[String(value)] ?? 1;

const RESEARCH = [
  "researched_at", "role", "fit", "intent", "intent_quote", "intent_at", "qualification", "angles",
  "company_not_read", "read_tries", "judge_tries", "pipeline_hold", "pipeline_hold_note",
];

/** Leads that differ only by case become the best of them, which takes the
 *  others' state. Returns the rows to keep and where each lead that went now is. */
function mergeLeads(list: Row[]): { leads: Row[]; moved: Map<string, { kept: Row; rank: number }> } {
  const moved = new Map<string, { kept: Row; rank: number }>();
  const leads = groupsOf(list, (row) => profileIdKey(String(row.profile_id))).map((group) => {
    const key = profileIdKey(String(group[0]!.profile_id));
    if (group.length === 1) return { ...group[0]!, profile_id: key };
    const sorted = ordered(
      group,
      desc((row) => present(row.contacted_at)),
      desc((row) => (row.stage === null || row.stage === undefined ? 4 : STAGE_RANK[String(row.stage)] ?? 4)),
      desc((row) => present(row.rating) || present(row.set_aside_at) || present(row.dm_draft)),
      desc((row) => Number(row.updated_at ?? 0)),
      asc((row) => Number(row.id)),
    );
    const kept = sorted[0]!;
    sorted.forEach((row, at) => { if (row !== kept) moved.set(`${org(row)}:${row.id}`, { kept, rank: at }); });
    const latestTouch = Math.max(...sorted.map((row) => Math.max(Number(row.contacted_at ?? 0), Number(row.relationship_at ?? 0))));
    const donor = (rows: Row[]) => rows[0];
    const merged: Row = { ...kept, profile_id: key };
    for (const column of ["name", "headline", "followers", "campaign_id"]) merged[column] = firstOf(sorted, column);
    const tiers = ordered(sorted, desc((row) => rank(TIER_RANK, row.tier)));
    const intents = ordered(sorted, desc((row) => rank(INTENT_RANK, row.intent_level)));
    merged.tier = tiers[0]!.tier;
    merged.status = ordered(sorted, desc((row) => rank(STATUS_RANK, row.status)))[0]!.status;
    merged.intent_level = intents[0]!.intent_level;
    merged.evidence_quote = firstOf(intents, "evidence_quote");
    merged.trigger_incoming_comment_id = firstOf(intents, "trigger_incoming_comment_id");
    merged.tier_reasons = firstOf(tiers, "tier_reasons");
    merged.touch_count = sorted.reduce((sum, row) => sum + Number(row.touch_count ?? 0), 0);
    merged.word_touch_count = sorted.reduce((sum, row) => sum + Number(row.word_touch_count ?? 0), 0);
    merged.notified_at = minOf(sorted, "notified_at");
    for (const column of ["nudged_at", "last_signal_at", "status_changed_at", "updated_at", "last_words_at", "relationship_at", "research_requested_at"]) {
      merged[column] = maxOf(sorted, column);
    }
    merged.created_at = minOf(sorted, "created_at");
    merged.origin = sorted.find((row) => row.origin === "find_leads")?.origin ?? kept.origin ?? null;
    const dm = donor(ordered(sorted.filter((row) => present(row.dm_draft)),
      desc((row) => row.dm_trace?.edited === true), desc((row) => Number(row.dm_drafted_at ?? -1))));
    for (const column of ["dm_draft", "dm_drafted_at", "dm_trace"]) merged[column] = dm?.[column] ?? null;
    const sent = donor(ordered(sorted.filter((row) => present(row.contacted_at)), asc((row) => Number(row.contacted_at))));
    for (const column of ["contacted_at", "first_send"]) merged[column] = sent?.[column] ?? null;
    const rated = donor(ordered(sorted.filter((row) => present(row.rating)), desc((row) => Number(row.rated_at ?? 0))));
    for (const column of ["rating", "rated_at"]) merged[column] = rated?.[column] ?? null;
    // The owner's set-aside stands unless a later contact undid it.
    const aside = donor(ordered(sorted.filter((row) => present(row.set_aside_at) && Number(row.set_aside_at) >= latestTouch),
      desc((row) => Number(row.set_aside_at))));
    for (const column of ["set_aside_at", "set_aside_reason"]) merged[column] = aside?.[column] ?? null;
    const research = donor(ordered(sorted.filter((row) => present(row.researched_at)),
      desc((row) => present(row.qualification)), desc((row) => Number(row.researched_at))));
    if (research) for (const column of RESEARCH) merged[column] = research[column] ?? null;
    return merged;
  });
  return { leads, moved };
}

/** Rewrite the lead id a JSON record kept, wherever the archive holds one. */
function repointLeads(rows: Rows, moved: Map<string, { kept: Row; rank: number }>): void {
  const target = (row: Row, id: unknown) => moved.get(`${org(row)}:${id}`)?.kept;
  for (const row of rows.lead_signals ?? []) {
    const kept = target(row, row.lead_id);
    if (kept) row.lead_id = likeOriginal(row.lead_id, Number(kept.id));
  }
  for (const row of rows.conversations ?? []) {
    const kept = target(row, row.opened_from_lead_id);
    if (kept) row.opened_from_lead_id = likeOriginal(row.opened_from_lead_id, Number(kept.id));
  }
  for (const row of rows.conversation_events ?? []) {
    const kept = target(row, row.source_ref?.lead?.leadId);
    if (kept) row.source_ref = { ...row.source_ref, lead: { ...row.source_ref.lead, leadId: Number(kept.id) } };
  }
  for (const [table, column] of [["messages", "room_reply_target"], ["room_reply_drafts", "target"], ["room_reply_assists", "target"]] as const) {
    for (const row of rows[table] ?? []) {
      const record = row[column];
      if (!record || typeof record !== "object") continue;
      const kept = record.source === "lead" ? target(row, record.leadId) : undefined;
      const profileId = typeof record.profileId === "string" ? profileIdKey(record.profileId) : record.profileId;
      const personKey = typeof record.personKey === "string" && record.personKey.startsWith("p.")
        ? `p.${profileIdKey(record.personKey.slice(2))}` : record.personKey;
      if (kept || profileId !== record.profileId || personKey !== record.personKey) {
        row[column] = { ...record, ...(kept ? { leadId: Number(kept.id) } : {}),
          ...(record.profileId !== undefined ? { profileId } : {}), ...(record.personKey !== undefined ? { personKey } : {}) };
      }
    }
  }
  for (const row of rows.jobs ?? []) {
    const payload = row.payload;
    if (!payload || typeof payload !== "object") continue;
    const kept = target(row, payload.leadId);
    if (kept) row.payload = { ...payload, leadId: Number(kept.id) };
    if (Array.isArray(payload.leadIds)) {
      const ids = [...new Set<number>(payload.leadIds.map((id: unknown) => Number(target(row, id)?.id ?? id)))];
      row.payload = { ...row.payload, leadIds: ids };
    }
  }
  // A moved person's boxes join the kept lead's: their drafts are appended
  // after what the kept box holds, so none is dropped.
  const move = (key: unknown, row: Row): { to: string; rank: number } | null => {
    const match = /^lead:(\d+)(:signal:\d+)?$/.exec(String(key));
    const kept = match ? target(row, match[1]) : undefined;
    return match && kept ? { to: `lead:${kept.id}${match[2] ?? ""}`, rank: moved.get(`${org(row)}:${match[1]}`)!.rank } : null;
  };
  const drafts = rows.composer_drafts ?? [];
  const taken = new Map<string, number>();
  for (const row of drafts) taken.set(`${org(row)}:${row.box_key}`, Math.max(taken.get(`${org(row)}:${row.box_key}`) ?? 0, Number(row.position)));
  const moving = ordered(drafts.filter((row) => move(row.box_key, row)), (a, b) => move(a.box_key, a)!.rank - move(b.box_key, b)!.rank,
    asc((row) => Number(row.position)), asc((row) => Number(row.id)));
  for (const row of moving) {
    const to = move(row.box_key, row)!.to;
    const next = (taken.get(`${org(row)}:${to}`) ?? 0) + 1;
    taken.set(`${org(row)}:${to}`, next);
    row.box_key = to;
    row.position = likeOriginal(row.position, next);
  }
  for (const row of rows.draft_plans ?? []) {
    const to = move(row.box_key, row);
    if (to) row.box_key = to.to;
  }
}

/** Ratings of a merged person: the newest one moves to the kept lead; the
 *  others were overtaken by it. */
function mergeRatings(list: Row[], moved: Map<string, { kept: Row; rank: number }>, leads: Row[]): Row[] {
  const keptOf = (row: Row) => moved.get(`${org(row)}:${row.lead_id}`)?.kept ?? leads.find((lead) => org(lead) === org(row) && String(lead.id) === String(row.lead_id));
  const merging = new Set([...moved.values()].map(({ kept }) => `${org(kept)}:${kept.id}`));
  const chosen = new Map<string, Row>();
  for (const row of ordered(list, desc((rating) => Number(rating.rated_at ?? 0)),
    asc((rating) => moved.get(`${org(rating)}:${rating.lead_id}`)?.rank ?? 0))) {
    const kept = keptOf(row);
    if (!kept) continue;
    const id = `${org(kept)}:${kept.id}`;
    if (merging.has(id) && !chosen.has(id)) chosen.set(id, row);
  }
  return list.flatMap((row) => {
    const kept = keptOf(row);
    const id = kept ? `${org(kept)}:${kept.id}` : null;
    if (id === null || !merging.has(id)) return [row];
    return chosen.get(id) === row ? [{ ...row, lead_id: likeOriginal(row.lead_id, Number(kept!.id)) }] : [];
  });
}

/** Close all but the newest open conversation of one person on one account. */
function closeDuplicateConversations(list: Row[], now: number): void {
  const open = list.filter((row) => !present(row.closed_reason));
  for (const group of groupsOf(open, (row) => `${row.channel_id}\u0000${profileIdKey(String(row.author_profile_id))}`)) {
    for (const row of ordered(group, desc((conversation) => Number(conversation.id))).slice(1)) {
      row.closed_reason = "reopened";
      row.closed_at = now;
    }
  }
}

/** Upgrade the former profile caches and spellings before the schema check. */
export function upgradeProfileRows(rows: Rows, now = Date.now()): void {
  const sorted = (table: string) => ordered(rows[table] ?? [], asc((row) => Number(row.id ?? 0)));
  const profiles = mergeAuthorProfiles(rows.author_profiles ?? []);
  rows.author_profiles = profiles;
  if (rows.engaged_profiles) rows.engaged_profiles = mergeEngagedProfiles(rows.engaged_profiles);
  for (const row of rows.dm_threads ?? []) {
    if (Array.isArray(row.participants)) {
      row.participants = row.participants.map((person: unknown) => {
        const participant = person as Row | null;
        return participant && typeof participant.profileId === "string"
          ? { ...participant, profileId: profileIdKey(participant.profileId) } : person;
      });
    }
  }

  // The reads the retired columns held join the person's row, the newest
  // first; an untimed read is kept, as read at the beginning of time.
  const put = (row: Row, id: unknown, read: unknown, at: unknown) => {
    if (!present(read)) return;
    if (typeof id !== "string" || !id) throw new PortableArchiveError("incompatible_schema", "A profile read in this archive has no profile identity.");
    const key = profileIdKey(id);
    let profile = profiles.find((candidate) => org(candidate) === org(row) && candidate.profile_id === key);
    if (!profile) {
      profile = { organization_id: row.organization_id, profile_id: key, fetched_at: 0, relationship: "unknown" };
      profiles.push(profile);
    }
    const time = present(at) ? Number(at) : 0;
    if (!present(profile.profile_read) || time > Number(profile.profile_read_at ?? 0)) {
      profile.profile_read = read;
      profile.profile_read_at = time;
    }
  };
  for (const row of sorted("leads")) put(row, row.profile_id, row.profile_read, row.profile_read_at);
  for (const row of sorted("candidate_research")) put(row, row.author?.profileId, row.author, row.author_read_at);
  for (const row of rows.leads ?? []) { delete row.profile_read; delete row.profile_read_at; }
  for (const row of rows.candidate_research ?? []) { delete row.author; delete row.author_read_at; }
  for (const row of rows.lead_signals ?? []) delete row.profile_spelling;

  if (rows.conversations) closeDuplicateConversations(rows.conversations, now);
  if (rows.leads) {
    const { leads, moved } = mergeLeads(rows.leads);
    rows.leads = leads;
    if (rows.lead_ratings) rows.lead_ratings = mergeRatings(rows.lead_ratings, moved, rows.leads);
    repointLeads(rows, moved);
  }
  for (const [table, columns] of Object.entries(PROFILE_COLUMNS)) {
    for (const row of rows[table] ?? []) {
      for (const column of columns) if (typeof row[column] === "string") row[column] = profileIdKey(row[column]);
    }
  }
}
