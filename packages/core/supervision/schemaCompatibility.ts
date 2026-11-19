import { isReleasedMainMigrationFork } from "@engager/database/onboardingMigrationFork";

/** Reviewed local schema edge, not a general "additive means safe" rule.
 * Both identities hash the complete migration inventory (including journal
 * and snapshots).
 *
 * `from` is the original 0.2.5 distribution inventory. It is deliberately not
 * the previous tree state: old installations still need a complete edge to the
 * candidate. The edge grows as unreleased migrations accumulate rather than
 * hopping forward one at a time, and `migrations` lists every one of them in
 * journal order. The independently signed 0.2.6 baseline is recorded below.
 *
 * What each adds, and why the set is still one reviewed edge: 0169 adds a
 * nullable text checkpoint; 0170 adds one new table, `runtime_heartbeats`, with
 * its RLS policy installed in the same transaction; 0171 adds a nullable jsonb
 * column to `tenant_runtimes` and WIDENS that table's status CHECK by one
 * value, which accepts everything the old constraint did; 0172 and 0173 add
 * one nullable bigint column each to the same table; 0174 adds one new table,
 * `chat_pending_changes`, with its RLS family installed in the same
 * transaction; 0175 adds one new table, `candidate_research`, with its RLS
 * policy installed in the same transaction (its post FK follows the concurrent
 * index phase, as `candidate_draft_requests`' does), and two nullable columns
 * to `discovered_posts`; 0176 adds two `channels` columns with constant
 * defaults, so every existing row reads them at once; 0177 adds one
 * `campaigns` boolean the same way, false on every existing target; 0178 adds
 * one nullable jsonb column to `candidate_draft_requests`; 0179 adds one more
 * there with a constant default, and one nullable bigint to `messages`; 0180
 * adds four zero-default counters to `worker_runs` and a CHECK over them;
 * 0181 adds one nullable jsonb to `voice_samples`, and to `voices` one nullable
 * jsonb and one with a constant default; 0182 adds one new table,
 * `campaign_definitions`, with its RLS policy installed in the same
 * transaction, and one `campaigns` boolean with a constant default, false on
 * every existing target; 0183 adds to `incoming_comments` one nullable text,
 * one nullable bigint and one integer with a constant default; 0184 adds one
 * `workers` boolean with a constant default, false on every existing row, and
 * WIDENS that table's `workers_enabled_does_something_check` by it, which
 * accepts everything the old constraint did; 0185 adds three new tables,
 * `journeys`, `journey_events` and `journey_sources`, each with its RLS family
 * installed in the same transaction, and one more nullable bigint to
 * `incoming_comments`; 0186 WIDENS `campaign_definitions_status_check` by two
 * values and drops NOT NULL from `chat_pending_changes.session_id` and
 * `turn_id`, each of which accepts every row the old constraint did; 0187
 * adds to `author_profiles` one text column with a constant default, `unknown`
 * on every existing row, a CHECK over it that every existing row passes, one
 * nullable bigint and one nullable jsonb; 0188 adds two new tables,
 * `step_runs` and `step_tool_calls`, each with its RLS family installed in the
 * same transaction, and to `worker_runs` two arrays and five counters,
 * each with a constant default, and a CHECK over the counters that every
 * existing row meets at its default; 0189 adds one new table,
 * `outcome_events`, with its RLS family installed in the same transaction,
 * and to `journeys` one nullable text and one nullable bigint under a CHECK
 * that every existing row (both null) passes, and WIDENS
 * `journeys_derived_stage_check` by three values, which accepts every row the
 * old constraint did; 0190 adds three new tables, `action_executions`,
 * `action_approvals` and `pause_controls`, each with its RLS family installed
 * in the same transaction; 0191 changes no shape at all — it moves the reply
 * lane of a campaign that runs on its definition off Automatic where
 * activation projected it before Reply was held at Ask me, and returns that
 * campaign's approved thread replies to proposed, values the old code already
 * writes; 0192 adds one new table, `incoming_invitations`, with its RLS family
 * installed in the same transaction; 0193 adds two new tables, `dm_threads`
 * and `inbox_reads`, each with its RLS family installed in the same
 * transaction; 0194 WIDENS `journeys_closed_check` by one value, which accepts
 * every row the old constraint did; 0195 adds one new table,
 * `memory_records`, with its RLS family installed in the same transaction,
 * and to `step_runs` one jsonb column with a constant default and one
 * nullable bigint; 0196 adds one new table, `offers`, with its RLS family
 * installed in the same transaction; 0197 adds one new table, `live_checks`,
 * with its RLS family installed in the same transaction; 0198 adds to
 * `campaigns` one nullable bigint, `deleted_at`; 0199 adds to `messages` one
 * nullable boolean, `like_with_send`, and one nullable jsonb, `like_outcome`;
 * 0200 adds to `worker_runs` one nullable text, `press_id`, and to
 * `worker_missed_runs` one nullable bigint, `dismissed_at`; 0201 adds to
 * `inbox_reads` one integer with a constant default, 0 on every existing row;
 * 0202 adds three new tables, `discovered_post_sources`, `discovery_plans` and
 * `discovery_source_changes`, each with its RLS family installed in the same
 * transaction (the first one's post FK follows the concurrent index phase, as
 * `candidate_research`'s does), and to `discovery_sources` one boolean with a
 * constant default, false on every existing row, one nullable text and two
 * nullable columns, `retired_at` and `retired_by`; 0203 adds to
 * `discovery_sources` two integers, two texts and one text array, each with a
 * constant default that every existing row reads at once; 0204 adds to
 * `channels` two integers, `reply_check_base_min` and `inbox_check_base_min`,
 * each with a constant default that every existing row reads at once; 0205
 * adds to `incoming_comments` and `inbox_reads` one text each, `reader`, with
 * a constant default and a CHECK every existing row passes at it, and to
 * `comment_watches` one nullable text, `last_read_note`; 0206 adds to
 * `channels` one bigint, `daily_reply_check_cap`, with a constant default
 * that every existing row reads at once; 0207 adds to `dm_threads` one
 * nullable text, `last_history_message_id`, filled once from `last_message_id`,
 * which does not move; 0208 adds to `comment_watches` one nullable bigint,
 * `missing_since`, and returns to `active` the agentic campaigns' comment
 * watches a single missed read retired, moving only `state`, `next_check_at`
 * and `updated_at`; 0209 adds to `incoming_comments` one nullable bigint,
 * `missing_since`, and returns to live the thread replies a single read
 * removed in the last three days, moving only `removed_at`, `status` and
 * their journey sources' `deleted_at`; 0210 adds to `incoming_comments` one
 * nullable text, `author_member_urn`, returns to `active` the agentic
 * campaigns' comment watches a hidden comment retired in the last three days
 * with the thread replies and journey sources tombstoned with them, moving
 * only the columns 0208 and 0209 move, and clears `comment_watches.missing_since`;
 * 0211 adds to `dm_threads` one nullable integer, `unread_count`, three
 * nullable bigints, `last_message_at`, `owner_held_at` and `held_message_at`,
 * and one nullable text, `held_message_text`; 0212 adds nothing and recounts
 * the voices a calibration taught from approved agent drafts (consumed, or read
 * by the first-run calibration), moving only
 * `voices`' `style_rules` closer policy, `calibration_sample_count`,
 * `maturity`, `revision` and `updated_at`, and their samples'
 * `used_in_voice_revision`; 0213 adds to `discovery_source_changes` one
 * nullable jsonb, `reading`; 0214 adds to `message_status_events` one nullable
 * text, `reason`, with a CHECK every existing row passes at null; 0215 adds to
 * `incoming_comments` one nullable text, `hold_reason`; 0216 adds to
 * `campaigns` one nullable bigint, `status_changed_at`, and one nullable text,
 * `status_changed_by`; 0217 adds to `worker_runs` one boolean, `is_test`,
 * with a constant default, false on every existing row; 0218 adds one new
 * table, `voice_questions`, with its RLS family installed in the same
 * transaction; 0219 widens `message_draft_revisions`' source CHECK by one
 * value, `variant_swap`, which every existing row passes; 0220 adds to
 * `messages` one nullable text, `error_code`, and one nullable bigint,
 * `last_attempt_at`; 0221 adds to `action_executions` one integer,
 * `reconcile_attempts`, with a constant default, zero on every existing row,
 * and one nullable bigint, `last_reconcile_at`; 0222 adds to
 * `candidate_draft_requests` one jsonb, `angle_items`, with a constant
 * default, empty on every existing row; 0223 widens `action_executions`' kind
 * and purpose CHECKs and `live_checks`' values CHECK by one value each,
 * `withdraw_invite`, `withdrawal` and `withdraw_invitation`, which every
 * existing row passes; 0224 adds one new table, `report_relays`, outside
 * RLS and written only by the cloud's report relay; 0225 adds one new table,
 * `bug_reports`, with its RLS family installed in the same transaction; 0226
 * adds to `discovery_sources` one nullable bigint, `refused_at`; 0227 adds to
 * `chat_sessions` one nullable bigint, `person_journey_id`; 0228 adds the
 * audience revision table with forced RLS and two campaign columns, copying
 * legacy rules into the new profile without changing the old rule; 0229 adds
 * one zero-default revision to discovered posts and one nullable revision to
 * research; 0230 adds room snapshots and members with forced RLS, and four
 * nullable Research projections. Its post FK follows the concurrent tenant
 * index phase; 0231 adds one nullable bigint to room members for post-only
 * skips; 0232 adds the minimal room exclusion identity table with forced
 * RLS, and two nullable journey provenance columns; 0233 adds room reply
 * draft storage with inline forced RLS. Saving a draft creates no message
 * or dispatchable work. 0234 adds nullable message-target and ledger-member
 * columns. The new runtime also writes room_reply messages, which older
 * binaries cannot dispatch safely. This edge therefore permits an upgrade,
 * but not a binary-only rollback after 0234. 0235 widens the message target
 * check to admit this separate reply kind. 0236 binds room first-send records
 * to a message and exact approval generation; its message FK follows the
 * concurrent tenant index phase. No receipt is removed. 0237 adds a topic-
 * default search intent and nullable pain id and display name; it rewrites
 * no existing search identity, term, origin or counter. 0238 adds campaign-
 * scoped author dismissals with a tenant campaign FK and forced RLS in the
 * creating migration; existing sources and room evidence are unchanged.
 * 0239 adds one nullable JSONB to source changes for server-derived room
 * decision counts; existing history receives null and is not rewritten.
 * 0240 and 0241 add retained room insights and audience themes with forced
 * RLS. 0242 adds nullable room-likelihood and Audience-revision columns to
 * discovered posts; existing rankings and verification verdicts stay intact.
 * 0243 adds nullable per-member drafting requests and a separate offer-
 * provenance table with forced RLS; it creates no owner drafts or sends.
 * 0244 adds requested lookalike reads and bounded search suggestions with
 * forced RLS and tenant foreign keys; it changes no existing searches.
 * 0245 distinguishes completed room rewrites from cancellation and failure
 * in the draft-history trigger. Existing history and other message kinds
 * remain unchanged; an owner edit replaced on request is still a redraft.
 * 0246 changes no shape: it removes the retired `legacyResearchRestriction`
 * key from stored Audience profiles and their history. Revisions, the
 * relevance rule and verification verdicts are unchanged; an older binary
 * reads the missing key as no restriction. 0247 adds a zero-default run
 * counter for matches Research left to the owner; existing runs read 0 and
 * no verdict or message is rewritten. 0248 adds nullable country columns to
 * `author_profiles` and `room_members`, gives every stored Audience a `where`
 * (the retired `ai_filter` country lists, translated to codes; none
 * elsewhere, an unknown country counting in) and drops those lists. The
 * Audience revision is unchanged; an older binary's strict Audience schema
 * refuses the new key, so, as with every edge, its rollback is refused. 0249
 * adds the account's `write_ahead` beside its pacing numbers, defaulted to
 * `rest_of_day` for every channel; an older binary never reads it and keeps
 * its buffer of three, and no row is rewritten. 0250 changes no shape: it
 * closes, once, the extra comment drafts a worker wrote for one person while
 * another decision about them waited — `rejected`, with its reason — and
 * touches nothing posted, scheduled or the owner's. 0251 adds a campaign's
 * stored `search_depth` (Quick or Standard), defaulted to `standard` for every
 * campaign with a CHECK every row passes; an older binary never reads it, and
 * no row is rewritten. 0252 adds one new table, `composer_drafts`, with its
 * RLS family installed in the same transaction; an older binary never reads
 * it. 0253 adds five nullable columns to `incoming_comments`
 * recording a reply's dismissal for its Undo; an older binary never reads
 * them, and no row is rewritten. 0254 adds a campaign's nullable
 * `depth_offer_dismissed_at`, the owner's Keep Quick on Overview's offer of
 * Standard; every campaign reads null, an older binary never reads it, and
 * no row is rewritten. 0255 adds to `worker_runs` one nullable integer,
 * `first_look_round`, and one bigint array with a constant default,
 * `first_look_post_ids`, empty on every existing run; an older binary never
 * reads either. 0256 widens one CHECK, `action_executions_purpose_check`, by
 * `invite_note`; every row passes it and an older binary never writes the
 * value. 0257 adds nullable account Terms columns; 0258 adds a nullable
 * payment-failure timestamp; 0259 widens the email-kind CHECK by the three
 * billing notifications. 0260 adds nullable setup-draft JSON; 0261/0262 add
 * nullable campaign advice-dismissal fields; 0263/0264 add nullable run
 * failure context and exact queue-job identity; 0265 adds nullable confirmed
 * refund evidence; 0266 adds a nullable rejected-account identifier. Existing
 * rows satisfy every expansion. These additions do not relax old-binary
 * rollback refusal or prove a physical upgrade. 0267 retains the released
 * dispatcher's exact SQL; its forced-RLS tables and dark organization flag
 * are added after onboarding. The exact main fork is reconciled atomically
 * before Drizzle's timestamp shortcut. 0268 adds eleven nullable columns to
 * `leads` (stage, role, origin, fit, intent, its quote, rating and their
 * times) with CHECKs every existing row passes at null; 0269 and 0270 add
 * `searches` and `lead_signals`, 0271 adds `person_reads`, each
 * with forced RLS installed in the same transaction; 0272 adds one
 * `campaigns` boolean with a constant default, false on every existing
 * target; 0273 WIDENS `composer_drafts_state_check` by `idea`, which accepts
 * every row the old constraint did; 0274 adds to `leads` two nullable
 * bigints, `contacted_at` and `relationship_at`, and one nullable jsonb,
 * `first_send`, under a CHECK that pairs the first with the last, which every
 * existing row meets at null; 0275 adds to `leads` one nullable bigint,
 * `last_words_at`, and one integer, `word_touch_count`, with a constant
 * default, then fills both once with a single UPDATE from each person's
 * campaign-thread replies already read for intent; 0276 adds one table,
 * `lead_thread_reads`, with forced RLS installed in the same transaction,
 * twenty-one integer counters with a constant default and one nullable
 * `search_depth` to `worker_runs` under CHECKs every existing run meets,
 * five nullable columns to `lead_signals` (`headline_from`, `comment_count`,
 * `angles`, `profile_spelling` and `lead_id`, the last a same-org FK to
 * `leads` that sets only itself null, with the unique index on `leads` it
 * needs), and one nullable bigint, `next_read_at`, to `searches`.
 * 0277 adds to `leads` two nullable columns, `profile_read` (jsonb) and
 * `profile_read_at` (bigint), under a CHECK that pairs them, which every
 * existing row meets at null; 0278 adds two more nullable jsonb columns,
 * `qualification` and `angles`, the second under a CHECK on its length; 0279
 * adds one nullable bigint, `opened_from_lead_id`, to `journeys`; 0280 adds two
 * tables, `search_changes` and `search_plans`, with forced RLS
 * installed in the same transaction (the first with a same-org FK to
 * `searches` that sets only itself null), and one integer,
 * `empty_reads`, with a constant default and a CHECK, to `searches`.
 * 0281 adds one table, `lead_ratings`, with forced RLS installed in the same
 * transaction, same-org FKs to `leads` (cascading), `campaigns` and
 * `searches` (each setting only itself null) and a CHECK on its values.
 * 0282 adds one nullable bigint, `research_requested_at`, to `leads`.
 * 0283 adds one nullable bigint, `undoes`, to `search_changes`, with a
 * partial unique index on it and a CHECK every existing row meets at null.
 * 0284 adds one text column, `target`, with a constant default and a CHECK
 * every existing row meets, to `search_lookalikes`.
 * 0285 WIDENS `composer_drafts_values_check` by the `lead:` box, which
 * accepts every row the old constraint did, and adds one nullable text,
 * `box_key`, to `draft_plans`; 0286 adds one table, `lead_backtests`, with
 * forced RLS installed in the same transaction and a partial unique index on
 * its open rows. 0287 adds one boolean column, `failed`, with a constant
 * default, to `search_plans`. 0288 adds one nullable text,
 * `set_aside_reason`, to `leads`, fills it for the rows already set aside, and
 * then adds a CHECK those rows meet. 0289 adds one table, `company_reads`,
 * with forced RLS installed in the same transaction and a unique index on its
 * company, and one nullable text, `company_not_read`, to `leads`, under a
 * CHECK every existing row meets at null. 0290 WIDENS
 * `lead_signals_values_check` by two verdicts, which accepts every row the old
 * constraint did, and adds one integer with a constant default, `tries`, to
 * `lead_signals`, two integers with a constant default and two nullable texts
 * to `leads`, the second of them under a CHECK every existing row meets at
 * null, and one boolean with a constant default, `lead_screen_rule`, to
 * `organizations`. 0291 adds the nullable expiry time to `lead_signals`,
 * nullable pass and company-author columns to `lead_thread_reads`, and the
 * forced-RLS `lead_source_reads` receipt table. 0292 WIDENS
 * `lead_signals_values_check` by one drop reason and
 * `worker_runs_lead_counts_check` by the integer it adds, with a constant
 * default, `lead_drop_not_audience_count`, to `worker_runs`; both accept
 * every row the old constraints did. 0294 adds two bigints with a constant
 * default, `daily_search_page_cap` and `hourly_search_cap`, to `channels`;
 * every existing row takes the 150 a day and 80 an hour the discovery limits
 * always were. Every existing row satisfies
 * the additions and an older binary never reads or writes them.
 * An older binary never reads or writes any of them, and no row is rewritten
 * except by that fill, which moves only the two columns 0275 adds and matches
 * nothing on a second pass, and by 0293, which turns the default of
 * the organizations' dispatcher switch (0267) to true and sets it on every org:
 * every `false` was 0267's default, since nothing ever set the column, and a
 * binary that reads the column drafts either way. It too matches nothing on a
 * second pass.
 *
 * 0295–0337 are 0.6.0's cleanup contract: they drop what the cleanup retired
 * and rename what it renamed. No binary before 0.6.0 runs on them, so a
 * rollback restores the pre-update snapshot rather than the old binary.
 *
 * 0338 changes no shape. It adds four functions and folds the account's mode
 * for each action into the campaign steps and own-post replies that send it,
 * the stricter of the two, so each resolves to the mode it resolved to
 * before; the account's own grants and caps stay in its documents, unread.
 * Run twice, it changes nothing the second time.
 *
 * 0339 changes no shape either. It adds one function and folds each
 * campaign's own `max_mode` into its steps the same way, through 0338's
 * functions, then drops the cap from the document it folded; the campaign's
 * grants stay, read. Run twice, it changes nothing the second time.
 *
 * Artifact signature verification and on-disk rehashing remain mandatory at
 * the caller; a version string or caller-supplied approval cannot add edges,
 * and `scripts/release/macUpgrade.smoke.ts` remains the evidence that this pair
 * actually upgrades — this constant records the pair, never proves it. */
export const BILLING_CHECKPOINT_COMPATIBILITY = {
  from: "1cb7cdcbc6c77cf3aa0b54b19b8d5a6ac51b0996c3c66dbbd62152e35a401500",
  to: "82b7931d214d198071adf3d2a8ccea3343ee0945a727a578e754b0b1bed8fa9a",
  /** In journal order — the sequence a `from` database gains to reach `to`. */
  migrations: [
    {
      file: "0169_billing_schedule_checkpoint.sql",
      sha256:
        "ce3a27213e619d9976d0aae4f5b7e9f996140ddde2705bcb3cbe10aa894fad07",
      timestamp: 1789205415894,
    },
    {
      file: "0170_nebulous_cassandra_nova.sql",
      sha256:
        "34e204f4e0b9678b993ebbb4928c3687bb4fade149d444ecacea19ae9d5cbc8a",
      timestamp: 1789395079196,
    },
    {
      file: "0171_tenant_teardown_evidence.sql",
      sha256:
        "d381a08eb0b510b2ce3b381d839e06cc6aa8ae917c6bcff3eeff68ca6ab0fc0e",
      timestamp: 1789413776336,
    },
    {
      file: "0172_tenant_export_receipt.sql",
      sha256:
        "4794bb90bbb9afe7560bc00fed6c7eb2351fad51f293ac96991278db41245c36",
      timestamp: 1789415762170,
    },
    {
      file: "0173_tenant_disconnected_at.sql",
      sha256:
        "2bfca65d9bf88519f4ca711e1107658b3562d5133bcd09a71912b77aa567eec5",
      timestamp: 1789416754965,
    },
    {
      file: "0174_many_tusk.sql",
      sha256:
        "bc4ea56a54d5eba57863ab50d11f728f60058254f78bfcef3032f3d65f8bf80a",
      timestamp: 1789962551999,
    },
    {
      file: "0175_candidate_research.sql",
      sha256:
        "9a893c18277322290f7dd30f510a25228eeb8fb0cc47bd37764aae7ba1559473",
      timestamp: 1791542088537,
    },
    {
      file: "0176_research_read_caps.sql",
      sha256:
        "1009d8e7f0f9b7c388125ae851108c72913030f3358737499a1afd7908042434",
      timestamp: 1791544610545,
    },
    {
      file: "0177_campaign_verify_stage.sql",
      sha256:
        "8b5747c0786decfd959cdf4049ef92638cd8cf5d3d71bd94838bcb4f19c0576c",
      timestamp: 1791552314014,
    },
    {
      file: "0178_draft_recommended.sql",
      sha256:
        "35ad4fe883978a58c366171eaaf3aadc453c1553df66004bfdf638204c3b526c",
      timestamp: 1791554202922,
    },
    {
      file: "0179_owner_stories.sql",
      sha256:
        "1cc8e558be6ab2f6f625119d69ecb3f50e8ad42fce19973a410ce683f4aee8a8",
      timestamp: 1791555892405,
    },
    {
      file: "0180_run_verify_counts.sql",
      sha256:
        "d7a08615621fa3cbfb1ef6c3c84f3dd24b6bc06b1b392bf4a592615ad829502c",
      timestamp: 1791557858678,
    },
    {
      file: "0181_voice_edit_learning.sql",
      sha256:
        "24efdf32aba7713ba707fde88b846e3688fc4449e4ac96d34306f42d52f4ec19",
      timestamp: 1791560491933,
    },
    {
      file: "0182_campaign_definitions.sql",
      sha256:
        "177c189e2bc8ff528f0361f090789dfbcc96df5016d06752a2225c8aaf44b8a6",
      timestamp: 1791651994614,
    },
    {
      file: "0183_reply_observation.sql",
      sha256:
        "27a18564e49ec223a2cdf7bfc2f96b64955c66f1e860f9d5229b579f00d74369",
      timestamp: 1791656873653,
    },
    {
      file: "0184_ambassador_conversation.sql",
      sha256:
        "0c86c9fc8762c1f8be4b9cd25121b7d2a3302696d64b76372b725975a64c6ecd",
      timestamp: 1791660219335,
    },
    {
      file: "0185_journeys.sql",
      sha256:
        "bf3b16714e2d58129f54f897909c710c06673e7ab17cf6ca47308a504f85f54f",
      timestamp: 1791663587679,
    },
    {
      file: "0186_definition_patch.sql",
      sha256:
        "f53cc177817aa5a19e522e778a3f6f2089dd16b2d5ca183cef28da5ea7075b49",
      timestamp: 1791664737656,
    },
    {
      file: "0187_relationship_read.sql",
      sha256:
        "8db97fb11f004043ff901dd39c68071b4eeca0aaf832d7603d67281578370326",
      timestamp: 1791666856226,
    },
    {
      file: "0188_agent_step_runtime.sql",
      sha256:
        "0b913f0fd13d44a520aabace790021cd7be76a0bbde0ab27cb91a5c6c5459300",
      timestamp: 1791668009272,
    },
    {
      file: "0189_outcome_events.sql",
      sha256:
        "c7439ca979bb5063db9542aad2083ba4827a2d4157dbd9fa514855f8d0ac3d8c",
      timestamp: 1791671842372,
    },
    {
      file: "0190_action_ledger.sql",
      sha256:
        "21a9bbb87bdbf88c743720ad6cf4deff508beb86d49d36cc1ec5a27646eecc48",
      timestamp: 1791675900894,
    },
    {
      file: "0191_reply_review_only.sql",
      sha256:
        "9251b5e82e1e5c459ff4b1b89cedd6c257500aeaec9161274ddcbddffc5b8c80",
      timestamp: 1791677755104,
    },
    {
      file: "0192_incoming_invitations.sql",
      sha256:
        "e3c2c04624ea21381860dced6b8404916e0507e8fcc09d757ce00a34e347456d",
      timestamp: 1791680498543,
    },
    {
      file: "0193_dm_read.sql",
      sha256:
        "43c758946e2c58fee1579f988054a0eab8869e612def2176e5e531d9cb1aa696",
      timestamp: 1791685123611,
    },
    {
      file: "0194_invitation_with_note.sql",
      sha256:
        "e4ac2047bbad7ff0146ba717854b9425ae9166f6e5f5decd29055cd4990d17eb",
      timestamp: 1791687405025,
    },
    {
      file: "0195_relationship_memory.sql",
      sha256:
        "a48501b21e8794453c03ff9b22e4cc13c71774b2c0f314d9e95370d0b3756c51",
      timestamp: 1791695082007,
    },
    {
      file: "0196_offers.sql",
      sha256:
        "b228b35f460f2e8b2552179ad41ae6f68c0af1fca4daf301a6ddb3c1bf44ca33",
      timestamp: 1791710175319,
    },
    {
      file: "0197_live_checks.sql",
      sha256:
        "81fb3506b64464f54b5e8d6a028305ffcb613c28d0a9da40ee47a1c81138ce87",
      timestamp: 1791715873048,
    },
    {
      file: "0198_campaign_deleted_at.sql",
      sha256:
        "f339f43fec27c77b31f4c4e4bb8fca9b5197f573bf9a2d7d2f44324819c2fc6f",
      timestamp: 1791729932949,
    },
    {
      file: "0199_like_with_send.sql",
      sha256:
        "a233a317be19e4be572b3314b9af5fa1899f89dd5137f11f81723e677bc5f64a",
      timestamp: 1791733630728,
    },
    {
      file: "0200_press_id_and_dismissed_misses.sql",
      sha256:
        "c469f4856bb46b146f1c436595a82d15bfca9523895982f89dddee2d623b93f7",
      timestamp: 1791767427493,
    },
    {
      file: "0201_inbox_unread_restores.sql",
      sha256:
        "08c62ed7532d441c5c1ee9bf46a1395c38cb313714c3c45cd2667b94bae9a2fe",
      timestamp: 1791774833417,
    },
    {
      file: "0202_scout_learns_searches.sql",
      sha256:
        "1174632d58c317218e55648ede0bda5c7f2e851bbea7314690bebeedcac515ed",
      timestamp: 1791775230860,
    },
    {
      file: "0203_scout_search_depth.sql",
      sha256:
        "4e76d6491f823e6ac914388019c9f2abfe6257be1662f0d08dc8b72236a348ba",
      timestamp: 1791781253362,
    },
    {
      file: "0204_check_cadences.sql",
      sha256:
        "95b8b73315ccab740fcb91898e964c54fd055e6ff6324835fbc0588737b38e5b",
      timestamp: 1791792224697,
    },
    {
      file: "0205_agent_reader.sql",
      sha256:
        "89ec3dee6fba57511ec6e8c9370ea74150b847b87391c330b86330bc7545d831",
      timestamp: 1791801843833,
    },
    {
      file: "0206_reply_check_budget.sql",
      sha256:
        "04d1baf7b8c5ee39d974854bbf6ec945fef596b13b7e476eb54d545ab1c2b1ab",
      timestamp: 1791808780014,
    },
    {
      file: "0207_dm_history_anchor.sql",
      sha256:
        "81d361113970d02e8ac33bf5cf9e1b1192581e2745fa8fcae1f44a01e9f4c3e8",
      timestamp: 1791819931664,
    },
    {
      file: "0208_observation_anchor.sql",
      sha256:
        "592bc65244707e015a700e98a00df7528d2e3f1f4be51db2621dbc600761313a",
      timestamp: 1791829204899,
    },
    {
      file: "0209_reply_missing_since.sql",
      sha256:
        "e3e2a93159c67361915d716455781a310dc77a4630ab924a483302c126120c49",
      timestamp: 1791856569194,
    },
    {
      file: "0210_hidden_comment_not_deleted.sql",
      sha256:
        "cde66022d5c0b49905b869cec7a9840ffb1ba4b8635819d95aa6d3de79577f86",
      timestamp: 1791862195409,
    },
    {
      file: "0211_dm_thread_list_state.sql",
      sha256:
        "7f9a4ee96caa9b5009cb869a921d82e6fa4aa17f11cfde888155edde005b4611",
      timestamp: 1791866019025,
    },
    {
      file: "0212_owner_written_voice.sql",
      sha256:
        "f1308877a8a1fde28bb4772ff82e85b79e45fc3ad2e0aa236c3672cb50077ff0",
      timestamp: 1791872441784,
    },
    {
      file: "0213_source_change_reading.sql",
      sha256:
        "9c4c9773ce17320df64c23e3bc502d63147b9212151758f6a58b07abe41d6f67",
      timestamp: 1791889356045,
    },
    {
      file: "0214_message_status_reason.sql",
      sha256:
        "1da214e75b6057d00411fc5403b06d7c53a96d53f349d706e5383880b4437ea5",
      timestamp: 1791898457446,
    },
    {
      file: "0215_incoming_hold_reason.sql",
      sha256:
        "2721617c9568acabe7256e0a7f171fb6064b14d0bdcd30e654049aba3b7ba515",
      timestamp: 1791898624606,
    },
    {
      file: "0216_campaign_status_changed.sql",
      sha256:
        "8bfc15a3dc80fbfd546a61fafc618d2a226d2afe8f7159abf03398ccca555dd7",
      timestamp: 1791898859885,
    },
    {
      file: "0217_run_is_test.sql",
      sha256:
        "9f9ac485a051064a24d8f09d6712959d758f0455bb4611e20ee615d0c0db5498",
      timestamp: 1791908006924,
    },
    {
      file: "0218_voice_questions.sql",
      sha256:
        "91edb45504d8716936086db4582164b8221d326f7a790bc28cabf0c7c0ef75d5",
      timestamp: 1791913245973,
    },
    {
      file: "0219_variant_swap.sql",
      sha256:
        "b27009529b8068a48ad844da53da1fbb9aa086bb13ce885af9de14a6a61452fd",
      timestamp: 1791941132683,
    },
    {
      file: "0220_message_failure_cause.sql",
      sha256:
        "76deb8e095ab9bb805534300ec5d10f4ac2c1c335cdfcf2956e21c40c66ec27c",
      timestamp: 1791942317646,
    },
    {
      file: "0221_action_reconcile_attempts.sql",
      sha256:
        "455764a4db568841769edd4c6e1276030114eb7ad2dd277906c44c28e5657379",
      timestamp: 1791947408056,
    },
    {
      file: "0222_candidate_angle_items.sql",
      sha256:
        "90946f41ee26953674d807a0aa7ede5bdc0f0b4b6c8e6fc3259e2e3845a4eb0f",
      timestamp: 1791962363193,
    },
    {
      file: "0223_withdraw_invite.sql",
      sha256:
        "342bdca8b14869321f30e9001594031cb57787fc1b207fa8fe165004942ba860",
      timestamp: 1791963978450,
    },
    {
      file: "0224_report_relays.sql",
      sha256:
        "ce7c58a3be3fc771a64dea9dcd02739942f2f1f44eb3e65f4ea0fe89b6dad58f",
      timestamp: 1791984960798,
    },
    {
      file: "0225_bug_reports.sql",
      sha256:
        "ed6f4a710e491aebf236724c6fe078e05a2af58218f55f03d80e03b3167189aa",
      timestamp: 1791986283366,
    },
    {
      file: "0226_discovery_sources_refused_at.sql",
      sha256:
        "d6c8714ed8ac00f1739fd2eb13ee9df2a370bcf631610b822277fe56c665163d",
      timestamp: 1792083602788,
    },
    {
      file: "0227_naive_dragon_man.sql",
      sha256:
        "e95a70baefd4c6d16bcad4b965357873389587f30ebd77822f4fc420ba44c2f3",
      timestamp: 1792242964792,
    },
    {
      file: "0228_audience_profiles.sql",
      sha256: "ba176a0bdaea97d9cba0505b1df26653f2c7b8518baba0adffa2ddc2e12bb2ec",
      timestamp: 1792254118737,
    },
    {
      file: "0229_audience_judgment_revision.sql",
      sha256: "4f36ef78ac95e1e0f34fc4d2f366930d1d018ca905cfe8872489e23eb79e95d7",
      timestamp: 1792255498013,
    },
    {
      file: "0230_room_snapshots.sql",
      sha256: "9481ace69da0e55a12d666389311acc020f02a9811a96116d31b2b9934ba2c01",
      timestamp: 1792255974280,
    },
    {
      file: "0231_room_post_skips.sql",
      sha256: "4a4b0b2d836585ed85a07fc184078877a7a8de72c8a044e7df5b58d3eaf63820",
      timestamp: 1792257649083,
    },
    {
      file: "0232_spotted_retention.sql",
      sha256: "a61626c0c83de971d42ac8aef79468bc35c63f0d56a3ba8c29630fa6d851dfeb",
      timestamp: 1792258303937,
    },
    {
      file: "0233_room_reply_drafts.sql",
      sha256: "f3e6590f572c6acbbf53fd4e2cb634893ee807682698e54c8fb8bff872554028",
      timestamp: 1792262803383,
    },
    {
      file: "0234_room_reply_messages.sql",
      sha256: "defcbbe1e40b08a804924851613c86a588de46060e873c64302294e4a2496757",
      timestamp: 1792263508286,
    },
    {
      file: "0235_room_reply_target_constraint.sql",
      sha256: "8fcc35a37181fab4eef833f3eb0b804cb2a1fc75af871172c84bf3c6afa5b998",
      timestamp: 1792263716461,
    },
    {
      file: "0236_room_reply_first_send.sql",
      sha256: "2859117f013d57d6889a29342773ebafc9077194082cb5e6e20689e78c400ee3",
      timestamp: 1792264704048,
    },
    {
      file: "0237_supreme_marten_broadcloak.sql",
      sha256: "186be9a23fcd62d61cb99e700ec2e3a0c3b1e888ba0abd7e1ccca8ee95ea1671",
      timestamp: 1792269906609,
    },
    {
      file: "0238_exotic_sabra.sql",
      sha256: "2596b146698e50ae5e2cad36a25bf858150a4ada219bdfef4d07efdfaa9f7756",
      timestamp: 1792273535068,
    },
    {
      file: "0239_source_room_evidence.sql",
      sha256: "c507665df5de2fc1ba82083faa8c927303971434492654ccca1e15fa26f76f6d",
      timestamp: 1792274445746,
    },
    {
      file: "0240_room_insights.sql",
      sha256: "6fd4d3635fe8dbebb7c837793f51520ba65fa1bc5bb2be9a5f6fdfd45daa3a20",
      timestamp: 1792277199225,
    },
    {
      file: "0241_audience_themes.sql",
      sha256: "02351fcd3fb7f4e01f32003d29d4899405ec11c4ccdf82db17d0bc7e5c929dae",
      timestamp: 1792278010115,
    },
    {
      file: "0242_room_likelihood.sql",
      sha256: "b6bf222f15c751d819ed786fb7b634bec325bfe405f531175b6f636b11372d92",
      timestamp: 1792287787949,
    },
    {
      file: "0243_room_reply_assist.sql",
      sha256: "4fb295993ccb2c4314285e60b9b7e285897c82df112c50432483fe8f283d5340",
      timestamp: 1792299456900,
    },
    {
      file: "0244_search_lookalikes.sql",
      sha256: "a9cf806175ed35664ea13cf309165a19fa5ce6ef9f217587a7571d1e9521dff8",
      timestamp: 1792302691910,
    },
    {
      file: "0245_room_reply_redraft_history.sql",
      sha256: "0841b1ea2ad770a6dc12cfadebbc3668dd8bea1a4a9a7f6482c7443e5baad96c",
      timestamp: 1792306091148,
    },
    {
      file: "0246_drop_builder_restriction.sql",
      sha256: "3ac39a4bf7f755ea9d539900f8868d83c7c879423ca63cd65ad5c43474e245a4",
      timestamp: 1792392837234,
    },
    {
      file: "0247_run_verify_for_owner_count.sql",
      sha256: "b700d3a95ed5b7cb81d4c8544ba80fd7e49140b2326393449761ed2cd53f51f6",
      timestamp: 1792395558566,
    },
    {
      file: "0248_audience_countries.sql",
      sha256: "636ccbe2bdba30c0e87bf605514b35d651b967a77be9173ccb6d327c0ed82242",
      timestamp: 1792401678414,
    },
    {
      file: "0249_write_ahead.sql",
      sha256: "5746ba439c112013fefefacbbecf63c66ef8c4e103c84a78fa65220593db5b03",
      timestamp: 1792414315030,
    },
    {
      file: "0250_one_decision_at_a_time.sql",
      sha256: "38167dee0e880712f491a1a854859c1ce48d551103df57148567ec1364a832b2",
      timestamp: 1792419296481,
    },
    {
      file: "0251_campaign_search_depth.sql",
      sha256: "79351f9ed33f10395c3827cbc81038508860e8e48a9d0c6955e1bad877152a4d",
      timestamp: 1792440556926,
    },
    {
      file: "0252_composer_drafts.sql",
      sha256: "ceb7d85efdcbcfdabda60ab2d54739ca0ee86668339cbfa907e8e50f90fb670e",
      timestamp: 1792443606201,
    },
    {
      file: "0253_dont_reply_undo.sql",
      sha256: "3364f06dd4032e14c84655f4eea72706daa67db5239f9e5f7e4f8c0ffa819140",
      timestamp: 1792447085580,
    },
    {
      file: "0254_depth_offer_dismissed.sql",
      sha256: "32f0943723ed168b4c2661a3824b7a9d8c0f92d0a096c2500e7c4138ebbab14b",
      timestamp: 1792452942235,
    },
    {
      file: "0255_first_look_rounds.sql",
      sha256: "2cbaef9c20042dd2055f981a996d5ead0d9fd29eba24c045886ef8cec8d0f69b",
      timestamp: 1792454912846,
    },
    {
      file: "0256_invite_note.sql",
      sha256: "4e4c17c7da6a71908cc66e247e69d0a2283eebd38d1c2d264232e682deb93ef7",
      timestamp: 1792469250541,
    },
    {
      file: "0257_terms_acceptance.sql",
      sha256: "cbd83f71a0c9107c58f9fb14433b625c6159b8322d1c1a29d0c1345e4de17c20",
      timestamp: 1792587784468,
    },
    {
      file: "0258_payment_failed_at.sql",
      sha256: "dc314b595aaab7eee2ac11141b32d38c51b0fadb092bdb5ff623d61fde8b4e8a",
      timestamp: 1792608765440,
    },
    {
      file: "0259_billing_email_kinds.sql",
      sha256: "07367ea8a6a0ef32de1db4e7ccc989e14e0db360654b5c6c632bf1e7a64049f3",
      timestamp: 1792611332710,
    },
    {
      file: "0260_first_campaign_draft.sql",
      sha256: "12907bccab16bdf5a458da584992ef8e31771e604b7e6f86f5339187e0f88afd",
      timestamp: 1792654672455,
    },
    {
      file: "0261_widen_offer_dismissed.sql",
      sha256: "5770ad0e83c9ab2f541684607fa8ad6685622bde1151df5cada3956cde22ed6a",
      timestamp: 1792736211064,
    },
    {
      file: "0262_automatic_offer_dismissed.sql",
      sha256: "11c46b21758c1f8e121b4a439755d074c2ddcc9fdf3cf24ee1b746c94718e456",
      timestamp: 1792736565866,
    },
    {
      file: "0263_agent_failure_context.sql",
      sha256: "9411ddb19ab791da5e046dca8ee6d2a086c3fd2dcd9ec6332bec7a7f9c1a2b0f",
      timestamp: 1792737033169,
    },
    {
      file: "0264_run_job_identity.sql",
      sha256: "e8c98881b567393e8a107afaf6567615aa7653e566522f350373444ef34f0a32",
      timestamp: 1792738885105,
    },
    {
      file: "0265_confirmed_refund.sql",
      sha256: "f53484975020ef01159dda9e79fd61dde3ee30b83a8f0934555d138b8d6551d9",
      timestamp: 1792743013261,
    },
    {
      file: "0266_setup_rejected_account.sql",
      sha256: "5d45f46833732c979a2bc4535d25168796feddfea667c31b10ecca74dfaed4f1",
      timestamp: 1792743837846,
    },
    {
      file: "0267_draft_dispatcher.sql",
      sha256: "2cb00485f1ab6c2240645e1ef9be93e91654f8b8a9dbc8e300faec0747d01785",
      timestamp: 1792842767155,
    },
    {
      file: "0268_lead_mode_leads.sql",
      sha256: "b2313ab1d241a5c9a04c531500e25f8f839d12f85d4060b7d6d4b41e0dd0d46a",
      timestamp: 1792957378665,
    },
    {
      file: "0269_lead_mode_searches.sql",
      sha256: "86ca5ca544341ef31eb8189b8fe4e5496eda0d0251d74b7f7974089b027d5610",
      timestamp: 1792957796131,
    },
    {
      file: "0270_lead_mode_lead_signals.sql",
      sha256: "c1036e544591be3a523aa754ea166fc72996bf4c9e744902db7394b06a823830",
      timestamp: 1792958008448,
    },
    {
      file: "0271_lead_mode_person_reads.sql",
      sha256: "930c5c4c31d7ca115a9f3ead532c729accf673e40857e13b885484789c4adf68",
      timestamp: 1792958314753,
    },
    {
      file: "0272_lead_mode_flag.sql",
      sha256: "117e11d9096bccfd0b27325a9c412de1949e986149ed760dd53c1b6124ceab47",
      timestamp: 1792959422882,
    },
    {
      file: "0273_composer_idea_state.sql",
      sha256: "8d4d042dafad9b6ba110e95115e4109b2e5dec2597762e73afd646c66acd9034",
      timestamp: 1792960912293,
    },
    {
      file: "0274_lead_mode_lifecycle.sql",
      sha256: "b9a4111ddbcbfa64eaf04cc89e056e079ad971918625662f9bdf2eebeeb5397c",
      timestamp: 1792963294848,
    },
    {
      file: "0275_lead_mode_temperature.sql",
      sha256: "533982b5f63358bb1c422f784c6ef987f7a2e7ab3fa04cdb2581e2d0cfad66cd",
      timestamp: 1792963843746,
    },
    {
      file: "0276_lead_mode_pipeline.sql",
      sha256: "1a9bbfb90f51e07654143e891ec903166c56ea10e06caf2ecff85c60e4424753",
      timestamp: 1792968897349,
    },
    {
      file: "0277_lead_mode_research.sql",
      sha256: "19fc27d1c4da3d555190bac066c97756d3e3e31e7bf8960f836666e52d333df4",
      timestamp: 1792970922632,
    },
    {
      file: "0278_lead_mode_qualify.sql",
      sha256: "30ea453a2a6f3e746ca927eabde338e4c294d15be0fd449dbcada82aedf37466",
      timestamp: 1792971331701,
    },
    {
      file: "0279_lead_mode_serve.sql",
      sha256: "0266eee873b7d129b3904badff2095f21c2b4eb534f40bfe96c8537a4299226b",
      timestamp: 1792971847978,
    },
    {
      file: "0280_lead_mode_map_plan.sql",
      sha256: "055924a3b18599cff7a1af0e2c20dc9d480c32255e6628782fbdac3eefef71ac",
      timestamp: 1792972218311,
    },
    {
      file: "0281_lead_mode_ratings.sql",
      sha256: "a0f070215805c78aeb72074b487d99290467e59d7db5087dcff8f73c0e5162e7",
      timestamp: 1792978288146,
    },
    {
      file: "0282_lead_mode_research_press.sql",
      sha256: "6bdfbf498284ae2f6bc85dd97ac5dc2f9dd3d31b602165849a7638fd50506d7d",
      timestamp: 1792978935983,
    },
    {
      file: "0283_lead_mode_map_edits.sql",
      sha256: "7f280eff2d8f437c561f2eceec3837d3c05421daffa1210268847eb6d0270881",
      timestamp: 1792979859189,
    },
    {
      file: "0284_lead_mode_room_read.sql",
      sha256: "454289a8b5ab01dd7399bde4092f50dca456fab94b2b94cfc1f3f99d705e3006",
      timestamp: 1792981475352,
    },
    {
      file: "0285_lead_mode_opener.sql",
      sha256: "7a3874d7bdc65f91cb969e69b8ad20e058bc42d5dceda53d5b970f8241f8c835",
      timestamp: 1792988033802,
    },
    {
      file: "0286_lead_mode_backtest.sql",
      sha256: "11065d15927cc0920036995c78f01b29a8b71757b10d9246c39a33b5384c0ee3",
      timestamp: 1792988046197,
    },
    {
      file: "0287_lead_mode_plan_outcome.sql",
      sha256: "ef3edf30e0ee9085c516424c84305c570a12bb1f226de4b24f8e914b8feac241",
      timestamp: 1792989625334,
    },
    {
      file: "0288_lead_mode_set_aside.sql",
      sha256: "69974a701923fea712219828e9e4f1c03eb621bce8e08bd99e1526bcfa3a35d8",
      timestamp: 1792992772516,
    },
    {
      file: "0289_lead_mode_company_reads.sql",
      sha256: "dd48d731a47226e11ca64c26c8e24be03e8eb91527be5437e5ded07938ce9ef7",
      timestamp: 1792998005550,
    },
    {
      file: "0290_lead_pipeline_carry.sql",
      sha256: "585b97478d6611149faf10e71071800f5ba1c9983c449c7056f67b54322f6641",
      timestamp: 1793106358426,
    },
    {
      file: "0291_lead_pipeline_receipts.sql",
      sha256: "e946cf9485645ad96bc8ef229553bab7f2bbc55c17c9e3f4958c6f9e3eeba669",
      timestamp: 1793111787836,
    },
    {
      file: "0292_lead_screen_not_audience.sql",
      sha256: "991949bac2d703a3cf9e9b5b59558299feb70228a84bc3e25d31797b7d299912",
      timestamp: 1793119752051,
    },
    {
      file: "0293_dispatcher_on_by_default.sql",
      sha256: "96969e5dd617c0485a43e9f5662f160be1aac16a327cf9fea044fb012fa14abc",
      timestamp: 1793164249432,
    },
    {
      file: "0294_search_caps.sql",
      sha256: "2734f2b29bce431a52c1524a09015073f231b8ac034cc1524bff14623826af04",
      timestamp: 1793177216992,
    },
    {
      file: "0295_drop_tenant_runtimes.sql",
      sha256: "2efbbe32959985499e2d40d0fc164c547708f8ca9704b65d93097312a0cd185e",
      timestamp: 1793190737903,
    },
    {
      file: "0296_drop_password_sign_in.sql",
      sha256: "0e7d7391e02fedc9e45eee765762bd6bb6d0938de986f41c3cb969ba164e2975",
      timestamp: 1793192258766,
    },
    {
      file: "0297_retired_job_types.sql",
      sha256: "d4d4e3bdbaae27a3b20d9d717b55e48d94e704e53fd93d10d04f97d7c0f9f8bc",
      timestamp: 1793195194356,
    },
    {
      file: "0298_retire_first_radar.sql",
      sha256: "cd3fe2b6823f1d4bf7751db3f5ec3fee27dc3fa0882134e89b953ce0dacd62e7",
      timestamp: 1793198119317,
    },
    {
      file: "0299_retire_first_radar_jobs.sql",
      sha256: "3bbdd31a145c8c7ae8a660b41d4377d03ec7d378a8b2eef66c0d1481384cfb8e",
      timestamp: 1793198134532,
    },
    {
      file: "0300_message_write_marker.sql",
      sha256: "166e0ef96a1a976d6f694795ea4f1ac20235656baa057111443ea4c97d767f17",
      timestamp: 1793207545819,
    },
    {
      file: "0301_own_post_reply_mode.sql",
      sha256: "58690b6e1b8cc9329824a2b301022f30199d89254c610db800eb7f5b166fd51e",
      timestamp: 1793207562864,
    },
    {
      file: "0302_change_feed_seq.sql",
      sha256: "343853fe3c3639dd5bbf9abf5e51446f8fe7346284cb1f8b391769c64a3f1452",
      timestamp: 1793208237816,
    },
    {
      file: "0303_retire_find_posts.sql",
      sha256: "99a34a63851d8836a8d6d700b4c259116fa90826a4aa945289fa2d3cbde3f612",
      timestamp: 1793208436804,
    },
    {
      file: "0304_drop_hosted_browser_and_ledger.sql",
      sha256: "d78a7f6d981728fd73d4fe70b808056fefc70ea2f61f83a2a677eaab4212c355",
      timestamp: 1793209105995,
    },
    {
      file: "0305_drop_transfer_fences.sql",
      sha256: "19854fc4f0fa62001efd252c2cdf9f09d5c3652b7f2a74995f2679be995ccf64",
      timestamp: 1793209108854,
    },
    {
      file: "0306_drop_credits_and_leases.sql",
      sha256: "1ad22b03da267d06b3f1471ca4687696fb5d72509f979d4c7ea2bb044feee507",
      timestamp: 1793209111839,
    },
    {
      file: "0307_drop_unipile.sql",
      sha256: "b6167fbf67e550cd5a461b9ff01b8906c444b65d065bae5dd84741e5b3a49568",
      timestamp: 1793209114778,
    },
    {
      file: "0308_retire_theme_rollup_and_author_enrichment.sql",
      sha256: "e0b1594162a611be8136e78671f654707bdd4fc3a47772c98490b79939d86fff",
      timestamp: 1793209392416,
    },
    {
      file: "0309_drop_agentic_workflow.sql",
      sha256: "2a7123416615ea5fb87d2ef27bd22698587796464b561b920585a349d7553f3b",
      timestamp: 1793209395377,
    },
    {
      file: "0310_drop_draft_dispatcher.sql",
      sha256: "6129c954ffd5381490c1ab1033f9d508da2904d3213c0e5c8e07c31c91aa445d",
      timestamp: 1793209398502,
    },
    {
      file: "0311_database_finalisation.sql",
      sha256: "1346df6c7c3af61b7e217a0e75a26a7476e06998454e0ad2c92bfe6f2ffe2497",
      timestamp: 1793210918920,
    },
    {
      file: "0312_definition_projection_stamp.sql",
      sha256: "3fe178f3346302b1f5ab56bf217f05482c56da789c74f8a23a6b7001254812b6",
      timestamp: 1793211490904,
    },
    {
      file: "0313_retired_w14c_jobs.sql",
      sha256: "9a8265de8d9aad34774739ecb16d9ff06b8d43fa9478b5cb060ca7c5909a35cc",
      timestamp: 1793211511965,
    },
    {
      file: "0314_drop_find_posts_tables.sql",
      sha256: "e8a1cfc7d92917fec454e03a2b86006a5f3e732715e04171eafe58c34c899227",
      timestamp: 1793212175300,
    },
    {
      file: "0315_drop_oauth_sessions_knowledge_consent_embeddings.sql",
      sha256: "8d1adaeb261ac390d5fd5b1e56a1caee618b79e728c7171398d4754ff62c75f7",
      timestamp: 1793212210707,
    },
    {
      file: "0316_drop_runner_and_api_key_tables.sql",
      sha256: "7ec1ceec68fb74c42812ace695e70269510c5e209466a93ba361dce4940b8f1a",
      timestamp: 1793212314410,
    },
    {
      file: "0317_drop_device_request_runner_columns.sql",
      sha256: "7ebf86d85c33e85eaf82b664be61a28fab5ccda364e161232ee160733a374c8b",
      timestamp: 1793213223929,
    },
    {
      file: "0318_journey_to_conversation.sql",
      sha256: "5c47c365e308724c3e3e0fe9601da488b48c1213c9482779aa2dcc4198fd8552",
      timestamp: 1793213594685,
    },
    {
      file: "0319_ambassador_contract.sql",
      sha256: "e5f94fbca63e334e363265fc2f233c67c58a65dce942ea52f668ddbefb094c8d",
      timestamp: 1793214884556,
    },
    {
      file: "0320_worker_contract.sql",
      sha256: "5fb50d94fa3c003712deb8a5e9dfb69c73adaa09fe2633e6e8dd1992193fd3ab",
      timestamp: 1793214887681,
    },
    {
      file: "0321_searches_contract.sql",
      sha256: "e511bdda726f816e880b71648e704d3086ac00d3251c2879ae26d0d3fc878d47",
      timestamp: 1793214890838,
    },
    {
      file: "0322_incoming_reading.sql",
      sha256: "c49820b213fc8e7b26e681020b6775470070bb5b5d138f983a3f1230b3443230",
      timestamp: 1793215762142,
    },
    {
      file: "0323_profile_cache_lower_case_ids.sql",
      sha256: "edba8321dd2d0b7c227d8c0d98b8b27e2b2bd0d36022ecfaf16113137eb9ecea",
      timestamp: 1793216829519,
    },
    {
      file: "0324_task_contract.sql",
      sha256: "938ff69a320dda002ebefbac69b4d651ef635b9d74eadc48329a58431a7432e6",
      timestamp: 1793217031094,
    },
    {
      file: "0325_strategy_contract.sql",
      sha256: "d579a95ea2237a4c5cb9d2d5e67f57ce3f6190201b366fe09762b30f89e432e3",
      timestamp: 1793217034543,
    },
    {
      file: "0326_campaign_words_contract.sql",
      sha256: "b2be9a5065d838c3da48a1532fca3582bcded47ac0cf158e98f3f954f35648c3",
      timestamp: 1793217242652,
    },
    {
      file: "0327_drop_device_auth_and_lead_mode.sql",
      sha256: "35b339bb3273a2faea3bbfb0be18274ebee9425ff4273b75e94f45e2be08d805",
      timestamp: 1793218699969,
    },
    {
      file: "0328_worker_run_counters_contract.sql",
      sha256: "be045c0c7d4235c8b0e319b8a0134eb29f0d571818720b335b815b665e661250",
      timestamp: 1793224530258,
    },
    {
      file: "0329_mode_fields_contract.sql",
      sha256: "57a10afc364a668afca02b3c080fbea0570311aa1d9eda847e993f914cd00a08",
      timestamp: 1793229455942,
    },
    {
      file: "0330_like_actions.sql",
      sha256: "1c433bd9f64e4399f17f354c393ec54b5a4edef96a94d58d627881a31e25f279",
      timestamp: 1793231247377,
    },
    {
      file: "0331_draft_attempts_held.sql",
      sha256: "8b2761ee0877d967f380a3cff0039337a6edbd2b1ce791dfda9eabe650046351",
      timestamp: 1793233362865,
    },
    {
      file: "0332_room_reply_actions.sql",
      sha256: "e21c7b142ac35c758f2caa994b178aeb43b53b5c6d83c85fbc61335690facc70",
      timestamp: 1793234755959,
    },
    {
      file: "0333_reply_actions.sql",
      sha256: "344d68a9b6a6d8693d51ff78fa418f50626699282f9c81212974bb3d2bbabea1",
      timestamp: 1793236386885,
    },
    {
      file: "0334_comment_actions.sql",
      sha256: "61f55c6d9b5a4de5d8e646b1f08598af4abe2fe831c1e73e7658b26306ccff1e",
      timestamp: 1793238409719,
    },
    {
      file: "0335_actions_contract.sql",
      sha256: "a1ecf697b43d0bd431b6bbe2860591fa519975ababc4decd01d9199cbc62261c",
      timestamp: 1793245993862,
    },
    {
      file: "0336_drop_hosted_lane_fence.sql",
      sha256: "da6572228cfe5549062f55af668c9f8b8d38aaabcf7e414b78066527306fa82e",
      timestamp: 1793255850683,
    },
    {
      file: "0337_chat_session_drafts.sql",
      sha256: "45461fe55bcc9de70cb7e940ea0316e095d337feca0523c3a8d1bd5bcdf96cd4",
      timestamp: 1793265363035,
    },
    {
      file: "0338_fold_account_modes.sql",
      sha256: "2351d530818664f2534634ca1dfbfc252a884ee94856f4132ef09398770ebdfc",
      timestamp: 1794756580508,
    },
    {
      file: "0339_fold_campaign_max_mode.sql",
      sha256: "65f20a2e5281ef70da9f195ba9061da6be1e81a0eef2af1d3a586d3c317f05a4",
      timestamp: 1794761936466,
    },
  ],
  priorDmgSha256: "757886f0c78664839a17117afe0ea454aa1c59b81e6880cd0b0f514cee9e3366",
} as const;

/** The signed 0.2.6 artifact already contains 0169. Its remaining migrations
 * are the same reviewed expansion above. Its old admission cannot recognize
 * this later history, so this edge permits forward recovery, not rollback. */
export const MAC_026_COMPATIBILITY = {
  from: "4587fb0653732cd791d124149da75efd291a6ac5519dda868cd4705f6efc96d3",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(1),
  priorDmgSha256: "e1b0e280d1e487e5f7f00ac2cca5437cd7de546deb22a7a2277f81d67f4bd39b",
} as const;

/** The installed signed 0.3.41 bundle and main at b74d4f74 have this exact
 *  227-migration inventory. It already contains 0169 through 0226 (58 of the
 *  original edge's migrations). Only the remaining reviewed expansion is
 *  admitted; the old binary cannot dispatch room replies after migration. */
export const MAC_0341_COMPATIBILITY = {
  from: "7fa73f166a944520df030adf9eedac40b737e3c5e2437142519b224a18fa68c4",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(58),
} as const;

/** The installed signed 0.3.42, 0.3.43 and 0.3.44 bundles and main at
 *  f18b4285 have this exact 246-migration inventory. It already contains 0169
 *  through 0245 (77 of the original edge's migrations). Only 0246 through 0256
 *  are admitted; as with every edge, a rollback to the old binary is refused. */
export const MAC_0344_COMPATIBILITY = {
  from: "5cf08613e479fce61e86c2e38b92695ab0b51558ac2e24da3dae065612bac69a",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(77),
} as const;

/** The installed signed 0.3.45 bundle and main at 9a055490 have this exact
 *  248-migration inventory. It already contains 0169 through 0247 (79 of the
 *  original edge's migrations). Only 0248 through 0290 are admitted; as with
 *  every edge, a rollback to the old binary is refused. */
export const MAC_0345_COMPATIBILITY = {
  from: "00e888abcfff5e6061475afdca81b5cceb271a38b08ab5b7c025bd77d8520072",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(79),
} as const;

/** The installed signed 0.3.46 bundle and main at 9e2c3d52 have this exact
 *  249-migration inventory. It already contains 0169 through 0248 (80 of the
 *  original edge's migrations). Only 0249 through 0290 are admitted; as with
 *  every edge, a rollback to the old binary is refused. */
export const MAC_0346_COMPATIBILITY = {
  from: "1f8a1e98ab90e45f449d47a81d8efcd6b841d5c3dc4e41b453f3308f9095bc29",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(80),
} as const;

/** The installed signed 0.3.47 bundle and main at 6daaf832 have this exact
 *  251-migration inventory. It already contains 0169 through 0250 (82 of the
 *  original edge's migrations). Only 0251 through 0290 are admitted; as with
 *  every edge, a rollback to the old binary is refused. */
export const MAC_0347_COMPATIBILITY = {
  from: "214cd0b61cb3831168dbfcb606053df2fdffad2283b69b6d8815d7232aba90bf",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(82),
} as const;

/** Release 0.4.5 (source commit 0f84b5c55) records this exact pre-onboarding
 * inventory. It includes through 0256; only 0257–0290 remain. This admits the
 * reviewed forward transition, never reverse binary rollback or live proof. */
export const MAC_045_COMPATIBILITY = {
  from: "282a333104f9eda44b026f6540ae606bdd436759e88383897c589c0cc2c15754",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(88),
} as const;

/** Released 0.4.9 applied the dispatcher on its parallel 0257. Its exact
 * history is reconciled before the missing onboarding migrations run; the
 * dispatcher is the one migration it already holds, so it is left out by name. */
export const MAC_049_COMPATIBILITY = {
  from: "929611aba6694d5b67660a62c2ea2ec239d636f1da376b70786073b4ddc0320b",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(88).filter(
    (migration) => migration.file !== "0267_draft_dispatcher.sql",
  ),
} as const;

/** The released 0.4.11/0.4.12 inventory, retained by the 0.4.13 updater
 * bridge, followed by the exact reviewed 22 Lead Mode migrations. The bridge
 * must know this edge before Sparkle can replace its installed controller. */
export const MAC_0412_TO_050_COMPATIBILITY = {
  from: "9ef72d57debbae2b2230e71167e89783599c6f67271d90fd559b7864e7dd6cc9",
  to: "805916d03d7d028508336343028f6e9d2af9eef424255df00c69fd92a79ef690",
} as const;

/** The released 0.5.0/0.5.1 Lead Mode inventory through 0289, retained by the
 * 0.5.2 updater bridge, followed by the reviewed Find leads pipeline
 * migrations 0290–0292, the dispatcher default, 0293, and the account's
 * discovery limits, 0294. */
export const MAC_051_COMPATIBILITY = {
  from: "00ef932b468e58cb88389698cf42b6454248bf76b798f736ebe3aa81f51de8db",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(121),
} as const;

/** The released 0.5.3 Find leads pipeline inventory, which already holds
 * everything through 0292. Only 0293, the dispatcher's default-on, and 0294 are
 * admitted; as with every edge, a rollback to the old binary is refused. */
export const MAC_053_COMPATIBILITY = {
  from: "9d85ddc2660fc281b7ca7603669152eb41f194ccd4bb7b62c8ecba1ce9a4a425",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(124),
} as const;

/** The released 0.5.5/0.5.6 inventory, which already holds everything through
 * 0293. Only 0294, which adds the account's discovery limits, is admitted; as with every
 * edge, a rollback to the old binary is refused. */
export const MAC_056_COMPATIBILITY = {
  from: "fcfa76a05514ac8632910bf37bbe3768a00241bf1edcf00fc0bce8b92f836d04",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(125),
} as const;

/** The released 0.5.8/0.5.9/0.5.10 inventory, which already holds everything
 * through 0294. Only 0.6.0's cleanup migrations, 0295–0337, are admitted; as
 * with every edge, a rollback to the old binary is refused. */
export const MAC_059_COMPATIBILITY = {
  from: "805916d03d7d028508336343028f6e9d2af9eef424255df00c69fd92a79ef690",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(126),
} as const;

/** The released 0.6.0–0.6.17 inventory, which already holds everything
 * through 0337. Only 0338 and 0339, which fold the account's modes and then
 * each campaign's own cap into the steps, are admitted; as with every edge, a
 * rollback to the old binary is refused. */
export const MAC_060_COMPATIBILITY = {
  from: "b8ca3421e5644a9b590369df229ba5a1688fadcc40495bef664c45513a19d824",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(169),
} as const;

/** A build of `dev` at the 0338 checkpoint, as the UI simplification's wave
 * builds were installed. Only 0339 is admitted; a rollback stays refused. */
export const DEV_0338_COMPATIBILITY = {
  from: "33676e0b456826187fc7399795bcfbe79c81b4e2ffbec211df2bc6a4b5b6c027",
  to: BILLING_CHECKPOINT_COMPATIBILITY.to,
  migrations: BILLING_CHECKPOINT_COMPATIBILITY.migrations.slice(170),
} as const;

export function compatibleSchema(from: string | null, to: string | null, direction: "update" | "rollback"): boolean {
  if (!from || !to) return false;
  if (from === to) return true;
  const edge = BILLING_CHECKPOINT_COMPATIBILITY;
  return direction === "update"
    ? [edge, MAC_026_COMPATIBILITY, MAC_0341_COMPATIBILITY, MAC_0344_COMPATIBILITY, MAC_0345_COMPATIBILITY, MAC_0346_COMPATIBILITY, MAC_0347_COMPATIBILITY, MAC_045_COMPATIBILITY, MAC_049_COMPATIBILITY, MAC_0412_TO_050_COMPATIBILITY, MAC_051_COMPATIBILITY, MAC_053_COMPATIBILITY, MAC_056_COMPATIBILITY, MAC_059_COMPATIBILITY, MAC_060_COMPATIBILITY, DEV_0338_COMPATIBILITY].some((reviewed) =>
        from === reviewed.from && to === reviewed.to)
    : false;
}

/** Drizzle normally consults only the last timestamp. Refuse changed, missing
 * or unknown history before that shortcut can let a stale binary start.
 *
 * The one admitted surplus is a ROLLED-BACK update: a `from` binary whose
 * database already carries the edge's migrations because a newer binary ran
 * and was rolled back. Those rows are admitted only as the edge's exact
 * sequence, in order, at the end — anything else is unknown history. */
export function migrationHistoryAdmission(input: {
  schemaHash: string | null;
  packaged: readonly { hash: string; created_at: number }[];
  applied: readonly { hash: string; created_at: number }[];
}): { allowed: boolean } {
  const expected = [...input.packaged];
  const edge = BILLING_CHECKPOINT_COMPATIBILITY;
  if (input.schemaHash === edge.to && isReleasedMainMigrationFork(expected, input.applied)) {
    return { allowed: true };
  }
  if (input.schemaHash === edge.from && input.applied.length > expected.length) {
    expected.push(
      ...edge.migrations.slice(0, edge.migrations.findIndex((migration) => migration.file === "0234_room_reply_messages.sql")).map((migration) => ({
        hash: migration.sha256,
        created_at: migration.timestamp,
      })),
    );
  }
  return { allowed: input.applied.length <= expected.length && input.applied.every((row, index) =>
    row.hash === expected[index]?.hash && Number(row.created_at) === expected[index]?.created_at) };
}
