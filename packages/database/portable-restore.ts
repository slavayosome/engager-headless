/**
 * Restoring a portable export — the other half of `./portable-export.ts`.
 *
 * The order of operations IS the contract (ADR-08): every check that can refuse
 * runs before a single live row is touched, and a refusal leaves the destination
 * exactly as it was. A corrupt archive, a wrong passphrase, a newer schema, an
 * unsafe attachment path, a foreign organization or live work on the destination all
 * stop the restore in the read phase.
 *
 * What lands is deliberately PAUSED, not resumed. The channel comes back in
 * `paused_recovery` with its session receipts cleared, because a copied probe
 * says nothing about this machine's browser and a restore has no credentials —
 * they were never in the archive. The owner's saved publish and schedule
 * settings are restored verbatim and left alone: pausing is done by the
 * execution authority, so resuming is a deliberate act rather than an
 * unnoticed side effect of importing a file.
 */
import { Pool, type PoolClient } from "pg";
import {
  copyOrgPoolConfig,
  foreignKeyEdges,
  topologicalOrder,
} from "./copy-org";
import { resolveDeploymentEnvironment } from "./environment";
import { upgradeProfileRows } from "./portable-profiles";
import {
  openPortableArchive,
  portableManifestSha256,
  PORTABLE_TABLES,
  RENAMED_ARCHIVE_TABLES as RENAMED_TABLES,
  PortableArchiveError,
  safeAttachmentPath,
  type PortableContent,
  type PortableManifest,
} from "./portable-export";

export type PortableRestoreReport = {
  organizationId: string;
  manifest: PortableManifest;
  order: string[];
  tables: { table: string; inserted: number }[];
  /** Files the caller must write beside the database, already verified. */
  attachments: { path: string; content: Buffer }[];
  /** Carried across and still open. The owner reconciles these; nothing here
   * retries any of them. */
  obligations: PortableManifest["obligations"];
  execution: "paused_recovery";
  /** How the paused install comes back: the owner connects the account and
   * this machine's own driver session is verified. Nothing resumes on its own,
   * and nothing is stuck. */
  resume: "owner_reverification_required";
};

const RENAMED_COLUMNS: Record<string, string> = {
  automation_id: "worker_id",
  automation_run_id: "worker_run_id",
  commenter_profile_id: "author_profile_id",
  commenter_member_urn: "author_member_urn",
  commenter_name: "author_name",
  agent_stage_status: "agent_task_status",
  definition_projection_schema: "strategy_projection_schema",
};

/** `worker_runs` counters an older archive still carries. The Find posts counters lost their
 *  writers, and the conversation sums are counted over step rows when a run is read. */
const DROPPED_RUN_COLUMNS: ReadonlySet<string> = new Set([
  "discovered_count", "triaged_count", "matched_count", "verified_count", "verify_for_owner_count",
  "verify_rejected_count", "verify_cap_refused_count", "rounds_count",
  "conversations_selected_count", "iterations_count", "tool_calls_dispatched_count",
  "tool_calls_discarded_count", "step_drafted_count",
]);

/** Mode columns an older archive still carries: every campaign is live and a
 *  send is held by its action's mode, so none has a reader. */
const DROPPED_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  campaigns: new Set(["run_mode", "approval_mode", "drafting_mode", "auto_reply"]),
  workers: new Set(["publish_enabled"]),
};

/** The reply prompts every create once persisted: the default, not the owner's
 *  text (`DEFAULT_AUTO_REPLY_PROMPT` and its older twin in core's
 *  `ai/promptDefaults.ts`, which this package cannot import). */
const DEFAULT_REPLY_PROMPTS: ReadonlySet<string> = new Set([
  "Reply warmly, answer the question, never pitch.",
  "Reply warmly and specifically. Answer any question. Never pitch.",
]);

/** Campaigns an older archive holds in shadow: by their `run_mode` column, or
 *  because a strategy version still in force, waiting or in review said so. */
function shadowCampaignIds(rows: PortableContent["rows"]): Set<number> {
  const ids = new Set<number>();
  for (const row of rows.campaigns ?? []) {
    if (row.run_mode === "shadow" && row.deleted_at == null) ids.add(Number(row.id));
  }
  for (const row of rows.campaign_definitions ?? rows.campaign_strategies ?? []) {
    const document = row.document as Record<string, unknown> | null | undefined;
    if (document?.run_mode === "shadow" && ["active", "draft", "pending_review"].includes(String(row.status))) {
      ids.add(Number(row.campaign_id));
    }
  }
  return ids;
}

/** Values the worker and ambassador renames changed in stored rows. */
function upgradeRenamedValues(table: string, next: Record<string, unknown>): void {
  for (const column of ["publish_origin", "origin"]) {
    if (next[column] === "automation") next[column] = "worker";
  }
  if (table === "workers" && next.kind === "commenter") next.kind = "ambassador";
  if (table === "step_runs" && "definition_version" in next) {
    next.strategy_version = next.definition_version;
    delete next.definition_version;
  }
  if (table === "jobs" && next.type === "activate_definition") {
    next.type = "activate_strategy";
    if (typeof next.idempotency_key === "string") next.idempotency_key = next.idempotency_key.replace(/^activate_definition:/, "activate_strategy:");
  }
  if (table === "chat_pending_changes" && next.kind === "definition.patch") {
    next.kind = "strategy.patch";
    const body = next.payload as Record<string, unknown> | null | undefined;
    if (body && typeof body === "object" && body.kind === "definition.patch") next.payload = { ...body, kind: "strategy.patch" };
  }
  if (table === "organizations" && next.onboarding_step === "target") next.onboarding_step = "campaign";
  if (table === "tasks") {
    if (next.kind === "target_brief") next.kind = "campaign_brief";
    const input = (next.context as Record<string, any> | null | undefined)?.input;
    if (input && typeof input === "object" && "stageKind" in input) {
      const { stageKind, ...rest } = input;
      next.context = { ...(next.context as object), input: { ...rest, taskKind: rest.taskKind ?? (stageKind === "target_brief" ? "campaign_brief" : stageKind) } };
    }
    const currentInput = (next.context as Record<string, any> | null | undefined)?.input;
    if (currentInput && typeof currentInput === "object" && ("targetId" in currentInput || "targetName" in currentInput)) {
      const { targetId, targetName, ...rest } = currentInput;
      next.context = { ...(next.context as object), input: {
        ...rest,
        ...(rest.campaignId === undefined && targetId !== undefined ? { campaignId: targetId } : {}),
        ...(rest.campaignName === undefined && targetName !== undefined ? { campaignName: targetName } : {}),
      } };
    }
    const receipts = next.receipts as Record<string, any> | null | undefined;
    if (receipts && typeof receipts === "object") {
      next.receipts = Object.fromEntries(Object.entries(receipts).map(([key, value]) => {
        if (!value || typeof value !== "object" || !("pendingStages" in value || "nextRequiredStage" in value)) return [key, value];
        const { pendingStages, nextRequiredStage, ...rest } = value;
        return [key, {
          ...rest,
          ...(pendingStages ? { pendingTasks: (pendingStages as unknown[]).map((v) => (v === "target_brief" ? "campaign_brief" : v)) } : {}),
          ...(nextRequiredStage !== undefined ? { nextRequiredTask: nextRequiredStage } : {}),
        }];
      }));
    }
  }
  const renameVersions = (holder: Record<string, any> | null | undefined) => {
    if (holder && typeof holder === "object" && "definition" in holder && !("strategy" in holder)) {
      const { definition, ...rest } = holder;
      return { ...rest, strategy: definition };
    }
    return holder;
  };
  if (table === "actions" && next.candidate && typeof next.candidate === "object") {
    const candidate = next.candidate as Record<string, any>;
    next.candidate = { ...candidate, versions: renameVersions(candidate.versions) };
  }
  if (table === "action_approvals") next.dependency_versions = renameVersions(next.dependency_versions as Record<string, any>);
  if (table === "step_runs" && Array.isArray(next.drafts)) {
    next.drafts = next.drafts.map((draft: Record<string, any>) => (draft && typeof draft === "object" ? { ...draft, versions: renameVersions(draft.versions) } : draft));
  }
  if (table === "conversation_events") {
    const room = (next.source_ref as Record<string, any> | null | undefined)?.room;
    if (room && typeof room === "object" && "definitionVersion" in room) {
      const { definitionVersion, ...rest } = room;
      next.source_ref = { ...(next.source_ref as object), room: { ...rest, strategyVersion: rest.strategyVersion ?? definitionVersion } };
    }
  }
  if (table === "search_lookalikes" && next.target === "listening_map") next.target = "lead_searches";
  if (table === "ai_usage") {
    if (next.stage === "automation_draft") next.stage = "worker_draft";
    if (typeof next.prompt_ref === "string") next.prompt_ref = next.prompt_ref.replace(/^automation\./, "worker.");
  }
  const target = next.room_reply_target as Record<string, unknown> | null | undefined;
  if (target && typeof target === "object" && target.selectedBy === "automation") {
    next.room_reply_target = { ...target, selectedBy: "worker" };
  }
  const payload = next.payload as Record<string, unknown> | null | undefined;
  if (table === "jobs" && payload && typeof payload === "object") {
    const { automationRunId, automationId, ...rest } = payload;
    if (automationRunId !== undefined) rest.workerRunId ??= automationRunId;
    if (automationId !== undefined && next.type === "worker_run") rest.workerId ??= automationId;
    next.payload = automationRunId !== undefined || (automationId !== undefined && next.type === "worker_run") ? rest : payload;
  }
}

/** Bring an archive exported before journeys became conversations onto this
 *  schema: old table and column names, and the two JSON records that named a
 *  journey. A current archive passes through untouched. */
export function upgradeRenamedRows(rows: PortableContent["rows"]): PortableContent["rows"] {
  const upgraded: PortableContent["rows"] = {};
  // Nothing goes live by inference: a campaign the archive holds in shadow
  // comes back Paused and Not started, its workers unwoken.
  const shadow = shadowCampaignIds(rows);
  const now = Date.now();
  for (const [table, list] of Object.entries(rows)) {
    // `automations` was only the id twin of `workers`; its rows are not carried.
    if (table === "automations" || table === "device_auth_requests") continue;
    upgraded[RENAMED_TABLES[table] ?? table] = list.map((row) => {
      if (table === "campaigns" && row.lead_mode === false && row.deleted_at == null) {
        throw new PortableArchiveError("incompatible_schema", "This archive contains a campaign that still finds posts.");
      }
      const next: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(row)) {
        if (table === "campaigns" && column === "lead_mode") continue;
        if (DROPPED_COLUMNS[table]?.has(column)) continue;
        const renamed = column.replace("journeys", "conversations").replace("journey", "conversation");
        const name = RENAMED_COLUMNS[renamed] ?? renamed;
        if ((RENAMED_TABLES[table] ?? table) === "worker_runs" && DROPPED_RUN_COLUMNS.has(name)) continue;
        next[name] = value;
      }
      upgradeRenamedValues(RENAMED_TABLES[table] ?? table, next);
      if (table === "campaigns") {
        // The reply-writing prompt is the owner's text, not a mode: a custom one
        // moves to the campaign's prompts unless the archive already holds one
        // there, as the migration does.
        const prompt = (row.auto_reply as { prompt?: unknown } | null | undefined)?.prompt;
        const prompts = (next.prompts as Record<string, unknown> | null | undefined) ?? {};
        const text = typeof prompt === "string" ? prompt.replace(/\r\n/g, "\n").trim() : "";
        if (text && !DEFAULT_REPLY_PROMPTS.has(text) && !("reply_policy" in prompts)) {
          next.prompts = { ...prompts, reply_policy: text };
        }
        if (shadow.has(Number(row.id)) && next.status === "active") {
          Object.assign(next, { status: "paused", status_changed_at: now, status_changed_by: "system", updated_at: now });
        }
      }
      // A pause does not hold the owner's own approved words, and the fence that
      // did is gone: they wait for a yes, as the migration leaves them. A
      // `posting` row stays for reconciliation. Post jobs are not in the
      // archive; the insert of a proposed row queues none.
      if (table === "messages" && shadow.has(Number(next.campaign_id)) && next.status === "approved") {
        Object.assign(next, { status: "proposed", scheduled_at: null });
      }
      if ((RENAMED_TABLES[table] ?? table) === "campaign_strategies") {
        if (shadow.has(Number(next.campaign_id)) && next.status === "active") next.status = "draft";
      }
      if (table === "workers" && shadow.has(Number(next.campaign_id))) Object.assign(next, { enabled: false, next_run_at: null });
      const evidence = next.attribution_evidence as Record<string, unknown> | undefined;
      if (evidence && "journeyId" in evidence) {
        const { journeyId, ...rest } = evidence;
        next.attribution_evidence = { ...rest, conversationId: rest.conversationId ?? journeyId };
      }
      const subject = next.subject as Record<string, unknown> | undefined;
      if (table === "live_checks" && subject?.kind === "journey") {
        const { journeyId, ...rest } = subject;
        next.subject = { ...rest, kind: "conversation", conversationId: rest.conversationId ?? journeyId };
      }
      return next;
    });
  }
  return upgraded;
}

const MAX_BATCH_PARAMETERS = 30_000;

async function columnsOf(client: PoolClient, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

async function jsonColumnsOf(
  client: PoolClient,
  table: string,
): Promise<Set<string>> {
  const result = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = 'public'
      and table_name = $1 and data_type in ('json', 'jsonb')`,
    [table],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function insertRows(
  client: PoolClient,
  table: string,
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  jsonColumns: ReadonlySet<string>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const list = columns.map((column) => `"${column}"`).join(", ");
  const perRow = columns.length;
  const chunk = Math.max(1, Math.floor(MAX_BATCH_PARAMETERS / perRow));
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += chunk) {
    const batch = rows.slice(offset, offset + chunk);
    const values: unknown[] = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        const value = row[column] ?? null;
        values.push(
          jsonColumns.has(column) && value !== null
            ? JSON.stringify(value)
            : value,
        );
        return `$${rowIndex * perRow + columnIndex + 1}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const result = await client.query(
      `insert into "${table}" (${list}) values ${tuples.join(", ")}`,
      values,
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Read the archive and verify everything about it and the destination, WITHOUT
 * writing. Separated so a caller — the CLI's `restore`, a rehearsal — can offer
 * the owner an honest answer before anything is replaced.
 */
export async function inspectPortableArchive(input: {
  client: PoolClient;
  archive: unknown;
  passphrase: string;
  organizationId?: string;
}): Promise<PortableContent> {
  const applied = await input.client.query<{ count: string }>(
    `select count(*)::text as count from drizzle.__drizzle_migrations`,
  );
  return openPortableArchive(input.archive, {
    passphrase: input.passphrase,
    appliedMigrations: Number(applied.rows[0]?.count ?? 0),
    organizationId: input.organizationId,
  });
}

/**
 * Whether this database is in the middle of an authority handoff.
 *
 * The evidence is the destination's own `transfer_intents` — never the archive's,
 * which deliberately excludes them (`export-manifest.ts`).
 *
 * A source-side row counts only while the fence it committed is still up: that
 * pair means another install may hold this account right now, and a file cannot
 * know otherwise, so lifting `transfer_paused` from the archive's contents
 * would remove a safety fence on its own word. A completed round trip leaves an
 * old source row behind with the fence DOWN, which is why the fence is part of
 * the test — a legitimate copy-back must still be restorable.
 *
 * A destination-side row counts unless it is this install's own `restored`
 * note, which a later restore may replace: an unfinished inbound copy is
 * evidence about another machine, and an import must not overwrite it.
 */
async function unresolvedHandoff(
  client: PoolClient,
  organizationId: string,
): Promise<{ side: string; state: string } | null> {
  const open = await client.query<{ side: string; state: string }>(
    `select i.side, i.state from transfer_intents i
       left join system_state s on s.organization_id = i.organization_id
      where i.organization_id = $1
        and i.state not in ('activated', 'abandoned')
        and ((i.side = 'source' and coalesce(s.transfer_paused, false))
          or (i.side = 'destination' and i.state <> 'restored'))
      limit 1`,
    [organizationId],
  );
  return open.rows[0] ?? null;
}

async function assertAuthorityHasNotMoved(
  client: PoolClient,
  organizationId: string,
): Promise<void> {
  const open = await unresolvedHandoff(client, organizationId);
  if (!open) return;
  throw new PortableArchiveError(
    "authority_moved",
    open.side === "source"
      ? `This installation handed its execution to another one (transfer ${open.state}) and is still fenced. Resolve that handoff before restoring over it.`
      : `This installation has an unfinished incoming transfer (${open.state}). Finish or abandon it before restoring over it.`,
  );
}

/** Live work on the destination. A restore replaces rows wholesale, so it may not
 * run over an install that is mid-send or mid-run. */
async function assertTargetIsQuiet(
  client: PoolClient,
  organizationId: string,
): Promise<void> {
  const busy = await client.query(
    `select 1 from messages where organization_id = $1 and status = 'posting'
     union all select 1 from jobs where organization_id = $1 and status = 'running'
     union all select 1 from worker_runs where organization_id = $1 and status = 'running' limit 1`,
    [organizationId],
  );
  if (busy.rowCount) {
    throw new PortableArchiveError(
      "manifest_mismatch",
      "This installation is still running work. Stop it before restoring over its data.",
    );
  }
}

export async function restorePortableExport(input: {
  /** The owner connection: restoring disables user triggers, which needs table
   * ownership, and fails loudly rather than importing half a truth without it. */
  ownerUrl: string;
  archive: unknown;
  passphrase: string;
  /** When set, the archive must describe this organization. */
  organizationId?: string;
  now?: number;
}): Promise<PortableRestoreReport> {
  const environment = resolveDeploymentEnvironment();
  const pool = new Pool(copyOrgPoolConfig(input.ownerUrl, environment));
  const now = input.now ?? Date.now();
  try {
    const client = await pool.connect();
    try {
      const content = await inspectPortableArchive({
        client,
        archive: input.archive,
        passphrase: input.passphrase,
        organizationId: input.organizationId,
      });
      content.rows = upgradeRenamedRows(content.rows);
      upgradeProfileRows(content.rows);
      const organizationId = content.manifest.organizationId;
      // Refused here, in the read phase, so an owner is told before anything is
      // locked; re-checked under the write lock below against a handoff that
      // starts in between.
      await assertAuthorityHasNotMoved(client, organizationId);
      const attachments = content.attachments.map((attachment) => {
        if (!safeAttachmentPath(attachment.path)) {
          throw new PortableArchiveError(
            "unsafe_attachment_path",
            `This archive contains an unsafe path: ${attachment.path}`,
          );
        }
        return {
          path: attachment.path,
          content: Buffer.from(attachment.content, "base64"),
        };
      });

      const order = topologicalOrder(
        [...PORTABLE_TABLES],
        await foreignKeyEdges(client),
      );
      // Column sets are compared BEFORE the write transaction: an archive that
      // names a column this schema does not have is an incompatible import, not
      // a partial one.
      const shape = new Map<
        string,
        { columns: string[]; jsonColumns: Set<string> }
      >();
      for (const table of order) {
        const columns = await columnsOf(client, table);
        const rows = content.rows[table] ?? [];
        const seen = new Set(rows.flatMap((row) => Object.keys(row)));
        const unknown = [...seen].filter(
          (column) => !columns.includes(column),
        );
        if (columns.length === 0 || unknown.length > 0) {
          throw new PortableArchiveError(
            "incompatible_schema",
            `This archive's "${table}" does not match this installation's schema.`,
          );
        }
        shape.set(table, {
          columns,
          jsonColumns: await jsonColumnsOf(client, table),
        });
      }

      await client.query("begin");
      let committed = false;
      try {
        await client.query("set local lock_timeout = '10s'");
        await client.query(`select set_config('app.current_org', $1, true)`, [
          organizationId,
        ]);
        await client.query("set constraints all deferred");
        const tables: { table: string; inserted: number }[] = [];
        await client.query(
          `lock table ${[...PORTABLE_TABLES, "jobs", "transfer_intents"].map((table) => `"${table}"`).join(", ")} in share row exclusive mode`,
        );
        await assertTargetIsQuiet(client, organizationId);
        await assertAuthorityHasNotMoved(client, organizationId);
        // A restore is not a write the product made. Its triggers would
        // fabricate draft revisions, status events and — for an `approved`
        // message — a real posting job, which is the one thing an imported file
        // must never be able to do.
        for (const table of order) {
          await client.query(`alter table "${table}" disable trigger user`);
        }
        try {
          // Queue rows name a runtime that no longer exists. They are runtime
          // state the manifest excludes, and nothing recreates them here.
          await client.query(`delete from jobs where organization_id = $1`, [
            organizationId,
          ]);
          for (const table of [...order].reverse()) {
            if (table === "users" || table === "organizations") continue;
            await client.query(
              `delete from "${table}" where organization_id = $1`,
              [organizationId],
            );
          }
          for (const table of order) {
            const { columns, jsonColumns } = shape.get(table)!;
            const rows = content.rows[table] ?? [];
            if (table === "organizations" || table === "users") {
              // Identity rows may already exist and may be shared with another
              // organization; replace only what this archive owns.
              for (const row of rows) {
                const present = columns.filter((column) => column in row);
                const assignments = present
                  .filter((column) => column !== "id")
                  .map((column, index) => `"${column}" = $${index + 2}`);
                const updated = await client.query(
                  `update "${table}" set ${assignments.join(", ")} where "id" = $1`,
                  [
                    row.id,
                    ...present
                      .filter((column) => column !== "id")
                      .map((column) =>
                        jsonColumns.has(column) && row[column] != null
                          ? JSON.stringify(row[column])
                          : (row[column] ?? null),
                      ),
                  ],
                );
                if (updated.rowCount === 0) {
                  await insertRows(client, table, [row], present, jsonColumns);
                }
              }
              tables.push({ table, inserted: rows.length });
              continue;
            }
            const present = columns.filter((column) =>
              rows.some((row) => column in row),
            );
            tables.push({
              table,
              inserted: await insertRows(
                client,
                table,
                rows,
                present.length > 0 ? present : columns,
                jsonColumns,
              ),
            });
          }
          // Explicit ids do not advance serial sequences. The next real
          // product write — including the status event a later edit fires —
          // must allocate beyond every id in the database, other tenants
          // included.
          for (const table of order) {
            for (const column of await columnsOf(client, table)) {
              const sequence = (
                await client.query<{ name: string | null }>(
                  `select pg_get_serial_sequence($1, $2) as name`,
                  [table, column],
                )
              ).rows[0]?.name;
              if (!sequence) continue;
              await client.query(
                `select setval($1, greatest(
                   coalesce((select max("${column}") from "${table}"), 1),
                   (select last_value from ${sequence
                     .split(".")
                     .map((part) => `"${part.replaceAll('"', "")}"`)
                     .join(".")})
                 ), true)`,
                [sequence],
              );
            }
          }
          // An archive from before every like was an action carries its like
          // receipts in the ledger: they become actions here, fenced uncertain
          // where open, before the channel can resume. A current archive has none.
          await client.query(`select convert_like_receipts($1::uuid)`, [organizationId]);
          // And one from before a room reply was an action carries its replies
          // as messages: the queued become actions, the in-flight fenced
          // uncertain, so none sends twice.
          await client.query(`select convert_room_replies($1::uuid)`, [organizationId]);
          // The same for a public reply: the queued become actions, the
          // in-flight fenced uncertain.
          await client.query(`select convert_replies($1::uuid)`, [organizationId]);
          // And a comment: the same.
          await client.query(`select convert_comments($1::uuid)`, [organizationId]);
          // And one from before the account kept no mode per action carries
          // the account's modes: they fold into the steps they held, so
          // nothing restored resolves wider than it did. A current archive's
          // account grants every send and caps none, so its steps, a raised
          // one included, restore as they were.
          await client.query(`select fold_account_modes($1::uuid)`, [organizationId]);
          // And one from before a campaign kept no mode of its own carries its
          // `max_mode`: that folds into its steps the same way.
          await client.query(`select fold_campaign_max_mode($1::uuid)`, [organizationId]);
          // The deferred checks run here, inside the same transaction, because
          // a table with pending trigger events cannot be altered and the
          // triggers must come back before this transaction ends.
          await client.query("set constraints all immediate");
        } finally {
          for (const table of order) {
            await client.query(`alter table "${table}" enable trigger user`);
          }
        }
        // Execution comes back PAUSED. The archive carried no credentials, so
        // a copied session receipt is meaningless here; the managed driver must
        // verify this machine's own account before anything dispatches.
        await client.query(
          `update channels set execution_state = 'paused_recovery',
             execution_runtime_id = null, execution_holder = null,
             execution_lease_until = null, execution_authority_lease_until = null,
             session_ok_at = null, session_checked_at = null, session_reason = null
           where organization_id = $1`,
          [organizationId],
        );
        // A restored install is not a transferred SOURCE. Whatever fence the
        // archive carried belonged to the machine it came from — and this
        // database's own fence was checked above, not overridden.
        await client.query(
          `update system_state set transfer_paused = false,
             updated_at = greatest(updated_at + 1, $2) where organization_id = $1`,
          [organizationId, now],
        );
        // THIS end's own handoff record, so the paused install above has a way
        // back: `observeAccount` finds it, re-verifies the account with this
        // machine's own driver session and takes one epoch above everything the
        // snapshot carried (`packages/core/execution/transfer.ts`).
        //
        // It claims nothing it cannot prove. `source_stop_confirmed_at` stays
        // null and the state is `restored` rather than `copied`, so the handoff
        // activation path — which requires a stop receipt and a verified copy —
        // refuses this row outright. Without it a restored install would hold
        // an epoch it can never raise and could never dispatch again.
        // The epoch the snapshot held. Adoption goes above it, so no runtime
        // named in the archive can still compare equal.
        const snapshotEpoch =
          (
            await client.query<{ epoch: string | null }>(
              `select max(execution_epoch)::text as epoch from channels
                 where organization_id = $1`,
              [organizationId],
            )
          ).rows[0]?.epoch ?? 0;
        const obligationSummary = Object.entries(
          content.manifest.obligations.reduce<Record<string, number>>(
            (counts, obligation) => {
              counts[obligation.kind] = (counts[obligation.kind] ?? 0) + 1;
              return counts;
            },
            {},
          ),
        ).map(([kind, count]) => ({ kind, count }));
        await client.query(
          `insert into transfer_intents (organization_id, direction, side,
             source_placement, destination_placement, state, manifest_sha256,
             obligation_summary, expected_epoch, created_at, updated_at)
           values ($1, 'restore', 'destination', $2, $2, 'restored', $3, $4::jsonb, $5, $6, $6)
           on conflict (organization_id, side) where state not in ('activated', 'abandoned')
           do update set direction = excluded.direction, state = excluded.state,
             source_placement = excluded.source_placement,
             destination_placement = excluded.destination_placement,
             manifest_sha256 = excluded.manifest_sha256,
             obligation_summary = excluded.obligation_summary,
             expected_epoch = excluded.expected_epoch,
             source_stop_confirmed_at = null, activated_epoch = null,
             activated_at = null, last_error = null,
             updated_at = excluded.updated_at`,
          [
            organizationId,
            "local",
            portableManifestSha256(content.manifest),
            JSON.stringify(obligationSummary),
            snapshotEpoch,
            now,
          ],
        );
        committed = true;
        await client.query("commit");
        return {
          organizationId,
          manifest: content.manifest,
          order,
          tables,
          attachments,
          obligations: content.manifest.obligations,
          execution: "paused_recovery",
          resume: "owner_reverification_required",
        };
      } catch (error) {
        if (!committed) await client.query("rollback").catch(() => {});
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
