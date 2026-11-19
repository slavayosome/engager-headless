import {
  and,
  asc,
  eq,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  candidateActions,
  commentWatches,
  incomingComments,
  conversationSources,
  messageDraftRevisions,
  messages,
  messageStatusEvents,
  type DraftTrace,
  type Message,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { FREE_WORKSPACE_HISTORY_MODEL } from "../rooms/importedHistory";
import { delimited } from "../conversations/delimit";
import { fencedWake } from "../agentStep/wakes";
import { dmThreadItems, type DmSection, type DmThreadItem } from "../conversations/inboxView";
import { linkedinPostUrl } from "../linkedin/postUrl";

export type ThreadRoot =
  | {
      kind: "discovered_post";
      rootId: `d:${number}`;
      discoveredPostId: number;
      campaign: { id: number; name: string };
      postUrn: string;
      postUrl: string;
      postAuthor: string | null;
      postContent: string | null;
      postedAt: number | null;
      discoveredAt: number;
    }
  | {
      kind: "own_post";
      rootId: `o:${string}`;
      ownPostUrn: string;
      campaign: null;
      postUrl: string;
      postContent: string | null;
      discoveredAt: number;
    };

export type ThreadStatusEvent = {
  id: number;
  fromStatus: Message["status"] | null;
  toStatus: Message["status"];
  localDay: string;
  occurredAt: number;
};

export type ThreadDraftRevision = {
  id: number;
  revision: number;
  source: (typeof messageDraftRevisions.$inferSelect)["source"];
  draftText: string;
  requestId: string | null;
  requestVersion: number | null;
  requestedAt: number | null;
  requestedBy: string | null;
  requestNote: string | null;
  model: string | null;
  loopVersion: string | null;
  promptVersionId: number | null;
  trace: DraftTrace | null;
  createdAt: number;
};

export type ThreadWatch = {
  id: number;
  state: "active" | "expired";
  postUrn: string;
  commentUrn: string;
  lastReplyCount: number;
  lastReactionCount: number;
  /** What the agent reader made of the last check, where it read one. */
  lastReadNote: string | null;
  quietChecks: number;
  nextCheckAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

export type ThreadMessage = {
  id: number;
  kind: Message["kind"];
  campaignId: number | null;
  discoveredPostId: number | null;
  incomingCommentId: number | null;
  proposedText: string;
  finalText: string | null;
  status: Message["status"];
  externalUrn: string | null;
  /** What produced the text; `FREE_WORKSPACE_HISTORY_MODEL` marks a comment
   *  the free product posted, which never had a urn to record. */
  model: string | null;
  error: string | null;
  createdAt: number;
  postedAt: number | null;
  scheduledAt: number | null;
  postingStartedAt: number | null;
  redraftRequestId: string | null;
  redraftRequestVersion: number;
  redraftRequestedAt: number | null;
  redraftRequestedBy: string | null;
  redraftRequestNote: string | null;
  events: ThreadStatusEvent[];
  revisions: ThreadDraftRevision[];
  watch: ThreadWatch | null;
};

export type ThreadInitialRequest = {
  id: number;
  active: boolean;
  actor: string;
  createdAt: number;
  revertedAt: number | null;
  revertedBy: string | null;
};

export type ThreadIncoming = {
  id: number;
  source: "own_post" | "our_comment_thread";
  campaignId: number | null;
  discoveredPostId: number | null;
  parentMessageId: number | null;
  commentUrn: string;
  authorProfileId: string | null;
  authorName: string | null;
  text: string;
  receivedAt: number;
  sensitivity: "ok" | "hold";
  status: "new" | "reply_proposed" | "replied" | "ignored" | "dismissed";
  draftRequestId: string | null;
  draftRequestVersion: number;
  draftRequestedAt: number | null;
  draftRequestedBy: string | null;
  draftRequestNote: string | null;
};

export type ThreadAnomaly =
  | "active_watch_without_posted_message"
  | "conflicting_root_links"
  | "duplicate_initial_pipeline"
  | "duplicate_reply_pipeline"
  | "message_campaign_mismatch"
  | "missing_initial_pipeline"
  | "missing_reply_pipeline"
  | "posted_without_external_urn"
  | "redraft_after_delivery_started"
  | "reply_after_incoming_stopped";

export type ThreadAction =
  | "approve"
  | "edit"
  | "redraft"
  | "reject"
  | "post_now"
  | "unqueue"
  | "retry"
  | "draft_reply"
  | "dismiss";

export type ThreadOwner = "agent" | "you" | "engager" | "contact" | null;
/** Which half of Threads a root sorts into. `needs_you` is a WIRE value
 *  — `list_people` returns it and the Responder that will read it is not built
 *  yet — so T-8.15 retired the owner-inbox LABEL the dashboard rendered and
 *  left the value where its readers still find it. */
export type ThreadInboxSection = "needs_you" | "in_progress";
/**
 * The item-level state a turn contributes to Threads filtering.
 * Review + Issues are the two states that stop a turn until the owner answers,
 * which is what sorts its root into `needs_you`; Drafting and Scheduled are
 * system-owned work; Waiting is contact-owned silence.
 */
export type ThreadItemState =
  | "review"
  | "drafting"
  | "scheduled"
  | "waiting"
  | "issues";
export const THREAD_ITEM_STATES = [
  "review",
  "drafting",
  "scheduled",
  "waiting",
  "issues",
] as const satisfies readonly ThreadItemState[];
export type ThreadArchiveBlocker =
  | "agent_work"
  | "reply_decision"
  | "draft_review"
  | "scheduled"
  | "posting"
  | "posting_failed"
  | "delivery_uncertain"
  | "active_watch"
  | "inconsistent";

type StateFields<
  Owner extends ThreadOwner,
  Section extends ThreadInboxSection | null,
  Item extends ThreadItemState | null,
  Blocker extends ThreadArchiveBlocker | null,
  Actions extends readonly ThreadAction[],
> = {
  owner: Owner;
  section: Section;
  item: Item;
  archiveBlocker: Blocker;
  allowedActions: Actions;
};

export type ThreadTurnState =
  | ({ kind: "agent_work"; work: "initial" | "reply" | "redraft" } & StateFields<
      "agent",
      "in_progress",
      "drafting",
      "agent_work",
      readonly []
    >)
  | ({ kind: "reply_decision" } & StateFields<
      "you",
      "needs_you",
      "review",
      "reply_decision",
      readonly ["draft_reply", "dismiss"]
    >)
  | ({ kind: "draft_review" } & StateFields<
      "you",
      "needs_you",
      "review",
      "draft_review",
      readonly ["approve", "edit", "redraft", "reject"]
    >)
  | ({ kind: "scheduled" } & StateFields<
      "engager",
      "in_progress",
      "scheduled",
      "scheduled",
      readonly ["post_now", "unqueue"]
    >)
  | ({ kind: "posting" } & StateFields<
      "engager",
      "in_progress",
      "scheduled",
      "posting",
      readonly []
    >)
  | ({ kind: "posting_failed" } & StateFields<
      "you",
      "needs_you",
      "issues",
      "posting_failed",
      readonly ["retry"]
    >)
  | ({ kind: "delivery_uncertain" } & StateFields<
      "you",
      "needs_you",
      "issues",
      "delivery_uncertain",
      readonly []
    >)
  | ({ kind: "awaiting_reply" } & StateFields<
      "contact",
      null,
      "waiting",
      "active_watch",
      readonly []
    >)
  | ({ kind: "stopped" } & StateFields<
      null,
      null,
      null,
      null,
      readonly []
    >)
  | ({ kind: "quiet" } & StateFields<
      null,
      null,
      null,
      null,
      readonly []
    >)
  | ({ kind: "inconsistent"; anomalies: readonly ThreadAnomaly[] } & StateFields<
      "you",
      "needs_you",
      "issues",
      "inconsistent",
      readonly []
    >);

export type DeriveTurnStateInput = {
  turn: "initial" | "reply";
  requestActive: boolean;
  incoming?: ThreadIncoming | null;
  message?: ThreadMessage | null;
  redraftPending?: boolean;
  watch?: ThreadWatch | null;
  anomalies?: readonly ThreadAnomaly[];
  now?: number;
};

const NO_ACTIONS = [] as const;

/** The only lifecycle derivation. UI and API callers consume its exact actions. */
export function deriveTurnState(input: DeriveTurnStateInput): ThreadTurnState {
  const anomalies = [...(input.anomalies ?? [])];
  const message = input.message ?? null;
  const incoming = input.incoming ?? null;
  const redraftPending = Boolean(input.redraftPending);
  const now = input.now ?? Date.now();
  const watch = input.watch ?? message?.watch ?? null;

  if (
    message?.status === "posted" &&
    !message.externalUrn &&
    message.model !== FREE_WORKSPACE_HISTORY_MODEL
  ) {
    anomalies.push("posted_without_external_urn");
  }
  if (
    message &&
    watch?.state === "active" &&
    watch.expiresAt > now &&
    message.status !== "posted"
  ) {
    anomalies.push("active_watch_without_posted_message");
  }
  if (
    redraftPending &&
    message &&
    (message.status === "posting" || message.status === "posted")
  ) {
    anomalies.push("redraft_after_delivery_started");
  }
  if (
    incoming &&
    (incoming.status === "dismissed" || incoming.status === "ignored") &&
    message
  ) {
    anomalies.push("reply_after_incoming_stopped");
  }
  if (anomalies.length > 0) {
    return {
      kind: "inconsistent",
      anomalies: [...new Set(anomalies)],
      owner: "you",
      section: "needs_you",
      item: "issues",
      archiveBlocker: "inconsistent",
      allowedActions: NO_ACTIONS,
    };
  }

  if (!message) {
    if (input.turn === "initial") {
      return input.requestActive
        ? {
            kind: "agent_work",
            work: "initial",
            owner: "agent",
            section: "in_progress",
            item: "drafting",
            archiveBlocker: "agent_work",
            allowedActions: NO_ACTIONS,
          }
        : {
            kind: "stopped",
            owner: null,
            section: null,
            item: null,
            archiveBlocker: null,
            allowedActions: NO_ACTIONS,
          };
    }
    if (!incoming) {
      return {
        kind: "inconsistent",
        anomalies: ["missing_reply_pipeline"],
        owner: "you",
        section: "needs_you",
        item: "issues",
        archiveBlocker: "inconsistent",
        allowedActions: NO_ACTIONS,
      };
    }
    if (incoming.status === "dismissed" || incoming.status === "ignored") {
      return {
        kind: "stopped",
        owner: null,
        section: null,
        item: null,
        archiveBlocker: null,
        allowedActions: NO_ACTIONS,
      };
    }
    if (incoming.status !== "new") {
      return {
        kind: "inconsistent",
        anomalies: ["missing_reply_pipeline"],
        owner: "you",
        section: "needs_you",
        item: "issues",
        archiveBlocker: "inconsistent",
        allowedActions: NO_ACTIONS,
      };
    }
    return input.requestActive
      ? {
          kind: "agent_work",
          work: "reply",
          owner: "agent",
          section: "in_progress",
          item: "drafting",
          archiveBlocker: "agent_work",
          allowedActions: NO_ACTIONS,
        }
      : {
          kind: "reply_decision",
          owner: "you",
          section: "needs_you",
          item: "review",
          archiveBlocker: "reply_decision",
          allowedActions: ["draft_reply", "dismiss"],
        };
  }

  if (redraftPending) {
    return {
      kind: "agent_work",
      work: "redraft",
      owner: "agent",
      section: "in_progress",
      item: "drafting",
      archiveBlocker: "agent_work",
      allowedActions: NO_ACTIONS,
    };
  }
  switch (message.status) {
    case "proposed":
      return {
        kind: "draft_review",
        owner: "you",
        section: "needs_you",
        item: "review",
        archiveBlocker: "draft_review",
        allowedActions: ["approve", "edit", "redraft", "reject"],
      };
    case "approved":
      return {
        kind: "scheduled",
        owner: "engager",
        section: "in_progress",
        item: "scheduled",
        archiveBlocker: "scheduled",
        allowedActions: ["post_now", "unqueue"],
      };
    case "posting":
      return {
        kind: "posting",
        owner: "engager",
        section: "in_progress",
        item: "scheduled",
        archiveBlocker: "posting",
        allowedActions: NO_ACTIONS,
      };
    case "failed":
      return {
        kind: "posting_failed",
        owner: "you",
        section: "needs_you",
        item: "issues",
        archiveBlocker: "posting_failed",
        allowedActions: ["retry"],
      };
    case "needs_review":
      return {
        kind: "delivery_uncertain",
        owner: "you",
        section: "needs_you",
        item: "issues",
        archiveBlocker: "delivery_uncertain",
        allowedActions: NO_ACTIONS,
      };
    case "posted": {
      if (watch?.state === "active" && watch.expiresAt > now) {
        return {
          kind: "awaiting_reply",
          owner: "contact",
          section: null,
          item: "waiting",
          archiveBlocker: "active_watch",
          allowedActions: NO_ACTIONS,
        };
      }
      return {
        kind: "quiet",
        owner: null,
        section: null,
        item: null,
        archiveBlocker: null,
        allowedActions: NO_ACTIONS,
      };
    }
    case "rejected":
    case "suppressed_dryrun":
      return {
        kind: "stopped",
        owner: null,
        section: null,
        item: null,
        archiveBlocker: null,
        allowedActions: NO_ACTIONS,
      };
  }
}

export type ThreadInitialTurn = {
  kind: "initial";
  request: ThreadInitialRequest | null;
  message: ThreadMessage | null;
  anomalies: ThreadAnomaly[];
  state: ThreadTurnState;
};

export type ThreadInboundReplyTurn = {
  kind: "inbound_reply";
  incoming: ThreadIncoming;
  /** The replier's conversation (`get_person`), on a campaign that runs on its
   *  strategy; null everywhere else. */
  conversationId: number | null;
  reply: ThreadMessage | null;
  anomalies: ThreadAnomaly[];
  state: ThreadTurnState;
};

export type Thread = {
  root: ThreadRoot;
  initial: ThreadInitialTurn | null;
  replies: ThreadInboundReplyTurn[];
  section: ThreadInboxSection | null;
  /** Distinct item states present across this thread's turns. */
  items: ThreadItemState[];
  archiveBlockers: ThreadArchiveBlocker[];
  updatedAt: number;
  lastActivityAt: number;
};

export type ThreadItemStateCount = { items: number; threads: number };

export type ThreadCounts = {
  needsYou: number;
  inProgress: number;
  open: number;
  archive: number;
  total: number;
  /** Distinct Review + Issues items — everything that needs the user. */
  attentionItems: number;
  items: Record<ThreadItemState, ThreadItemStateCount>;
};

export type ThreadsView = "open" | "archive";
export type ThreadsPage = {
  view: ThreadsView;
  items: Thread[];
  counts: ThreadCounts;
  nextCursor: string | null;
  hasMore: boolean;
};

export type ThreadsPageOptions = {
  view?: ThreadsView;
  /** Only threads containing an item currently in this state. */
  filter?: ThreadItemState;
  campaignId?: number;
  search?: string;
  cursor?: string | null;
  limit?: number;
  now?: number;
};

/** A person's direct-message thread as the work queue lists it: the
 *  person's latest message fenced as untrusted data, never instructions. */
export type DmInboxRow = Omit<DmThreadItem, "lastMessage" | "section"> & {
  lastMessage: (Omit<NonNullable<DmThreadItem["lastMessage"]>, "text"> & { content: string | null }) | null;
};

export type ThreadInbox = {
  needsYou: Thread[];
  inProgress: Thread[];
  /** The DM threads conversations hold (not post threads), in the same two
   *  halves — on the first page only, since they are few and unpaged. */
  dm: { needsYou: DmInboxRow[]; inProgress: DmInboxRow[] };
  counts: ThreadCounts;
  nextCursor: string | null;
  hasMore: boolean;
};

type ThreadCursor = { updatedAt: number; rootId: string };

export function encodeThreadCursor(cursor: ThreadCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.rootId]), "utf8").toString(
    "base64url",
  );
}

export function decodeThreadCursor(
  value: string | null | undefined,
): ThreadCursor | null {
  if (!value || value.length > 500) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      parsed[0] < 0 ||
      typeof parsed[1] !== "string" ||
      !/^(d:[1-9]\d*|o:.+)$/.test(parsed[1])
    ) {
      return null;
    }
    return { updatedAt: parsed[0], rootId: parsed[1] };
  } catch {
    return null;
  }
}

type RootRow = {
  root_id: string;
  root_kind: "discovered_post" | "own_post";
  discovered_post_id: number | null;
  own_post_urn: string | null;
  campaign_id: number | null;
  campaign_name: string | null;
  post_urn: string;
  post_url: string | null;
  post_author: string | null;
  post_content: string | null;
  posted_at: number | null;
  discovered_at: number;
  updated_at: number;
  last_activity_at: number;
  section: ThreadInboxSection | null;
  archived: boolean;
};

type CountRow = {
  needs_you: number;
  in_progress: number;
  open: number;
  archive: number;
  total: number;
  attention_items: number;
  review_items: number;
  review_threads: number;
  drafting_items: number;
  drafting_threads: number;
  scheduled_items: number;
  scheduled_threads: number;
  waiting_items: number;
  waiting_threads: number;
  issues_items: number;
  issues_threads: number;
};

type RootMembershipRow = {
  entity_kind: "incoming" | "message";
  entity_id: number;
  root_id: string;
};

function rootGraph(): SQL {
  return sql`
    with recursive initial_message_roots as (
      select distinct on (m.id)
        m.id as message_id,
        coalesce('d:' || m.discovered_post_id::text, 'd:' || fallback.id::text) as root_id
      from messages m
      left join discovered_posts direct
        on direct.organization_id = m.organization_id
       and direct.id = m.discovered_post_id
      left join comment_watches watch
        on watch.organization_id = m.organization_id and watch.message_id = m.id
      left join discovered_posts fallback
        on m.discovered_post_id is null
       and fallback.organization_id = m.organization_id
       and fallback.post_urn = watch.post_urn
      where m.kind = 'comment'
        and (direct.id is not null or fallback.id is not null)
      order by m.id, (m.discovered_post_id is not null) desc, fallback.id
    ), root_nodes as (
      select 'm:' || message_id::text as node_key, root_id
      from initial_message_roots
      union
      select 'i:' || incoming.id::text, 'o:' || incoming.own_post_urn
      from incoming_comments incoming
      where incoming.source = 'own_post'
      union
      select 'i:' || incoming.id::text, 'd:' || post.id::text
      from incoming_comments incoming
      join discovered_posts post
        on post.organization_id = incoming.organization_id
       and post.id = incoming.discovered_post_id
      where incoming.source = 'our_comment_thread'
        and incoming.discovered_post_id is not null
      union
      select 'i:' || incoming.id::text, 'd:' || fallback.id::text
      from incoming_comments incoming
      join discovered_posts fallback
        on fallback.organization_id = incoming.organization_id
       and fallback.post_urn = incoming.own_post_urn
      where incoming.source = 'our_comment_thread'
        and incoming.discovered_post_id is null
        and incoming.parent_message_id is null
    ), graph_edges as (
      select
        'm:' || message.id::text as node_key,
        'i:' || incoming.id::text as parent_key
      from messages message
      join incoming_comments incoming
        on incoming.organization_id = message.organization_id
       and incoming.id = message.incoming_comment_id
      where message.kind = 'reply'
      union all
      select
        'i:' || incoming.id::text,
        'm:' || parent.id::text
      from incoming_comments incoming
      join messages parent
        on parent.organization_id = incoming.organization_id
       and parent.id = incoming.parent_message_id
      where incoming.source = 'our_comment_thread'
        and incoming.discovered_post_id is null
    ), resolved_nodes as (
      select node_key, root_id, array[node_key]::text[] as path, 0 as depth
      from root_nodes
      union all
      select edge.node_key, resolved.root_id, resolved.path || edge.node_key,
        resolved.depth + 1
      from resolved_nodes resolved
      join graph_edges edge on edge.parent_key = resolved.node_key
      where resolved.depth < 100 and not edge.node_key = any(resolved.path)
    ), incoming_roots as (
      select distinct on (substring(node_key from 3)::bigint)
        substring(node_key from 3)::bigint as incoming_id, root_id
      from resolved_nodes
      where node_key like 'i:%'
      order by substring(node_key from 3)::bigint, depth, root_id
    ), message_roots as (
      select distinct on (substring(node_key from 3)::bigint)
        substring(node_key from 3)::bigint as message_id, root_id
      from resolved_nodes
      where node_key like 'm:%'
      order by substring(node_key from 3)::bigint, depth, root_id
    )`;
}

function rootsProjection(now: number): SQL {
  return sql`${rootGraph()}, root_seeds as (
      select 'd:' || action.discovered_post_id::text as root_id
      from candidate_actions action
      where action.action = 'request_draft'
      union
      select root_id from message_roots
      union
      select root_id from incoming_roots
    ), own_metadata as (
      select
        incoming_root.root_id,
        substring(incoming_root.root_id from 3) as own_post_urn,
        (array_agg(incoming.post_text order by incoming.received_at desc, incoming.id desc)
          filter (where incoming.post_text is not null))[1] as post_content,
        min(incoming.received_at)::bigint as discovered_at
      from incoming_roots incoming_root
      join incoming_comments incoming on incoming.id = incoming_root.incoming_id
      where incoming_root.root_id like 'o:%'
      group by incoming_root.root_id
    ), roots as (
      select
        seed.root_id,
        'discovered_post'::text as root_kind,
        post.id::bigint as discovered_post_id,
        null::text as own_post_urn,
        post.campaign_id,
        campaign.name as campaign_name,
        post.post_urn,
        post.url as post_url,
        post.author_name as post_author,
        post.content_text as post_content,
        post.posted_at,
        post.discovered_at
      from root_seeds seed
      join discovered_posts post on seed.root_id = 'd:' || post.id::text
      join campaigns campaign on campaign.id = post.campaign_id
      union all
      select
        seed.root_id,
        'own_post'::text,
        null::bigint,
        own.own_post_urn,
        null::bigint,
        null::text,
        own.own_post_urn,
        null::text,
        null::text,
        own.post_content,
        null::bigint,
        own.discovered_at
      from root_seeds seed
      join own_metadata own on own.root_id = seed.root_id
    ), activity_facts as (
      select root_id, discovered_at as at from roots
      union all
      select 'd:' || discovered_post_id::text, created_at
      from candidate_actions where action = 'request_draft'
      union all
      select message_root.root_id, greatest(m.created_at, coalesce(m.posted_at, 0))
      from message_roots message_root join messages m on m.id = message_root.message_id
      union all
      select incoming_root.root_id, incoming.received_at
      from incoming_roots incoming_root
      join incoming_comments incoming on incoming.id = incoming_root.incoming_id
      where incoming_root.root_id is not null
      union all
      select message_root.root_id, event.occurred_at
      from message_roots message_root
      join message_status_events event on event.message_id = message_root.message_id
      union all
      select message_root.root_id, revision.created_at
      from message_roots message_root
      join message_draft_revisions revision on revision.message_id = message_root.message_id
      union all
      select message_root.root_id, watch.updated_at
      from message_roots message_root
      join comment_watches watch on watch.message_id = message_root.message_id
    ), unresolved_facts as (
      select
        'd:' || action.discovered_post_id::text as root_id,
        'initial'::text as item_key,
        'drafting'::text as bucket,
        action.created_at as at
      from candidate_actions action
      where action.action = 'request_draft'
        and action.reverted_at is null
        and not exists (
          select 1 from initial_message_roots initial
          where initial.root_id = 'd:' || action.discovered_post_id::text
        )
      union all
      select
        message_root.root_id,
        case when m.kind = 'comment' then 'initial'
          else coalesce('i:' || m.incoming_comment_id::text, 'm:' || m.id::text) end,
        case when m.status = 'proposed' then 'review'
          when m.status in ('failed', 'needs_review') then 'issues'
          else 'scheduled' end,
        m.created_at
      from message_roots message_root
      join messages m on m.id = message_root.message_id
      where m.status in ('proposed', 'approved', 'posting', 'failed', 'needs_review')
        and not (m.redraft_request_id is not null and not exists (
          select 1 from message_draft_revisions revision
          where revision.message_id = m.id and revision.request_id = m.redraft_request_id
        )
        )
      union all
      select
        message_root.root_id,
        case when m.kind = 'comment' then 'initial'
          else coalesce('i:' || m.incoming_comment_id::text, 'm:' || m.id::text) end,
        'drafting',
        m.redraft_requested_at
      from message_roots message_root
      join messages m on m.id = message_root.message_id
      where m.redraft_request_id is not null
        and m.redraft_requested_at is not null
        and m.status not in ('posting', 'posted')
        and not exists (
          select 1 from message_draft_revisions revision
          where revision.message_id = m.id and revision.request_id = m.redraft_request_id
        )
      union all
      select
        incoming_root.root_id,
        'i:' || incoming.id::text,
        case when incoming.draft_request_id is null then 'review' else 'drafting' end,
        incoming.received_at
      from incoming_roots incoming_root
      join incoming_comments incoming on incoming.id = incoming_root.incoming_id
      where incoming_root.root_id is not null
        and incoming.status = 'new'
        and not exists (
          select 1 from messages reply
          where reply.kind = 'reply' and reply.incoming_comment_id = incoming.id
        )
      union all
      select incoming_root.root_id, 'i:' || incoming.id::text, 'issues', incoming.received_at
      from incoming_roots incoming_root
      join incoming_comments incoming on incoming.id = incoming_root.incoming_id
      where incoming_root.root_id is not null
        and incoming.status in ('reply_proposed', 'replied')
        and not exists (
          select 1 from messages reply
          where reply.kind = 'reply' and reply.incoming_comment_id = incoming.id
        )
      union all
      select incoming_root.root_id, 'initial', 'issues', incoming.received_at
      from incoming_roots incoming_root
      join incoming_comments incoming on incoming.id = incoming_root.incoming_id
      where incoming_root.root_id like 'd:%'
        and not exists (
          select 1 from initial_message_roots initial
          where initial.root_id = incoming_root.root_id
        )
      union all
      select message_root.root_id,
        case when watched_message.kind = 'comment' then 'initial'
          else coalesce('i:' || watched_message.incoming_comment_id::text,
            'm:' || watched_message.id::text) end,
        'waiting', watch.updated_at
      from message_roots message_root
      join comment_watches watch on watch.message_id = message_root.message_id
      join messages watched_message on watched_message.id = message_root.message_id
      where watch.state = 'active' and watch.expires_at > ${now}
        and watched_message.status = 'posted'
      union all
      select message_root.root_id,
        case when m.kind = 'comment' then 'initial'
          else coalesce('i:' || m.incoming_comment_id::text, 'm:' || m.id::text) end,
        'issues', m.created_at
      from message_roots message_root
      join messages m on m.id = message_root.message_id
      where (m.status = 'posted' and m.external_urn is null
          and m.model is distinct from ${FREE_WORKSPACE_HISTORY_MODEL})
         or (m.redraft_request_id is not null and m.status in ('posting', 'posted'))
      union all
      select message_root.root_id,
        case when watched_message.kind = 'comment' then 'initial'
          else coalesce('i:' || watched_message.incoming_comment_id::text,
            'm:' || watched_message.id::text) end,
        'issues', watch.updated_at
      from message_roots message_root
      join comment_watches watch on watch.message_id = message_root.message_id
      join messages watched_message on watched_message.id = message_root.message_id
      where watch.state = 'active' and watch.expires_at > ${now}
        and watched_message.status <> 'posted'
      union all
      select incoming_root.root_id, 'i:' || incoming.id::text, 'issues', incoming.received_at
      from incoming_roots incoming_root
      join incoming_comments incoming on incoming.id = incoming_root.incoming_id
      where incoming.status in ('ignored', 'dismissed')
        and exists (
          select 1 from messages reply
          where reply.kind = 'reply' and reply.incoming_comment_id = incoming.id
        )
      union all
      select incoming_root.root_id, 'i:' || incoming.id::text, 'issues', incoming.received_at
      from incoming_roots incoming_root
      join incoming_comments incoming on incoming.id = incoming_root.incoming_id
      join message_roots parent_root
        on parent_root.message_id = incoming.parent_message_id
      where incoming.discovered_post_id is not null
        and incoming.source = 'our_comment_thread'
        and parent_root.root_id <> 'd:' || incoming.discovered_post_id::text
      union all
      select message_root.root_id, 'initial', 'issues', m.created_at
      from message_roots message_root
      join messages m on m.id = message_root.message_id
      join discovered_posts post
        on message_root.root_id = 'd:' || post.id::text
      where m.kind = 'comment' and m.campaign_id is not null
        and m.campaign_id <> post.campaign_id
    ), item_rollup as (
      select
        root_id,
        item_key,
        (array['issues', 'review', 'drafting', 'scheduled', 'waiting'])[
          min(case bucket when 'issues' then 1 when 'review' then 2
            when 'drafting' then 3 when 'scheduled' then 4 else 5 end)] as bucket,
        min(at)::bigint as at
      from unresolved_facts
      group by root_id, item_key
    ), activity_rollup as (
      select root_id, max(at)::bigint as last_activity_at
      from activity_facts group by root_id
    ), unresolved_rollup as (
      select
        root_id,
        bool_or(bucket in ('review', 'issues')) as needs_you,
        bool_or(bucket in ('drafting', 'scheduled')) as in_progress,
        min(at) filter (where bucket in ('review', 'issues'))::bigint as needs_you_at,
        min(at) filter (where bucket in ('drafting', 'scheduled'))::bigint as in_progress_at,
        min(at)::bigint as unresolved_at
      from item_rollup group by root_id
    ), projected_roots as (
      select
        root.*,
        case when coalesce(unresolved.needs_you, false) then 'needs_you'
          when coalesce(unresolved.in_progress, false) then 'in_progress'
          else null end as section,
        (unresolved.root_id is null) as archived,
        case when coalesce(unresolved.needs_you, false)
          then unresolved.needs_you_at
          when coalesce(unresolved.in_progress, false) then unresolved.in_progress_at
          else coalesce(activity.last_activity_at, root.discovered_at)
        end::bigint as updated_at,
        coalesce(activity.last_activity_at, root.discovered_at)::bigint as last_activity_at
      from roots root
      left join activity_rollup activity using (root_id)
      left join unresolved_rollup unresolved using (root_id)
    )`;
}

/** A search's words as an `ilike … escape '\'` pattern takes them literally. */
export function escapeSearch(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function rootFilters(opts: Pick<ThreadsPageOptions, "campaignId" | "search">): SQL {
  const filters: SQL[] = [];
  if (opts.campaignId != null) filters.push(sql`root.campaign_id = ${opts.campaignId}`);
  const search = opts.search?.trim();
  if (search) {
    const pattern = `%${escapeSearch(search)}%`;
    filters.push(sql`(
      concat_ws(' ', root.post_author, root.post_content, root.campaign_name) ilike ${pattern} escape '\\'
      or exists (
        select 1 from incoming_roots incoming_root
        join incoming_comments incoming on incoming.id = incoming_root.incoming_id
        where incoming_root.root_id = root.root_id
          and concat_ws(' ', incoming.author_name, incoming.text) ilike ${pattern} escape '\\'
      )
      or exists (
        select 1 from message_roots message_root
        join messages message on message.id = message_root.message_id
        where message_root.root_id = root.root_id
          and concat_ws(' ', message.proposed_text, message.final_text) ilike ${pattern} escape '\\'
      )
    )`);
  }
  return filters.length === 0 ? sql`true` : sql.join(filters, sql` and `);
}

function rootColumns(): SQL {
  return sql`root.root_id, root.root_kind,
    root.discovered_post_id::float8 as discovered_post_id, root.own_post_urn,
    root.campaign_id::float8 as campaign_id, root.campaign_name, root.post_urn,
    root.post_url, root.post_author, root.post_content,
    root.posted_at::float8 as posted_at,
    root.discovered_at::float8 as discovered_at,
    root.updated_at::float8 as updated_at,
    root.last_activity_at::float8 as last_activity_at, root.section, root.archived`;
}

async function queryCounts(
  tx: Tx,
  opts: Pick<ThreadsPageOptions, "campaignId" | "search">,
  now: number,
): Promise<ThreadCounts> {
  const result = await tx.execute(sql`${rootsProjection(now)}, filtered_roots as (
    select root.* from projected_roots root where ${rootFilters(opts)}
  ), filtered_items as (
    select item.root_id, item.bucket
    from item_rollup item
    join filtered_roots root on root.root_id = item.root_id and not root.archived
  ), root_counts as (
    select
      count(*) filter (where not archived and section = 'needs_you')::int as needs_you,
      count(*) filter (where not archived and section = 'in_progress')::int as in_progress,
      count(*) filter (where not archived)::int as open,
      count(*) filter (where archived)::int as archive,
      count(*)::int as total
    from filtered_roots
  ), item_counts as (
    select
      count(*) filter (where bucket in ('review', 'issues'))::int as attention_items,
      count(*) filter (where bucket = 'review')::int as review_items,
      count(distinct root_id) filter (where bucket = 'review')::int as review_threads,
      count(*) filter (where bucket = 'drafting')::int as drafting_items,
      count(distinct root_id) filter (where bucket = 'drafting')::int as drafting_threads,
      count(*) filter (where bucket = 'scheduled')::int as scheduled_items,
      count(distinct root_id) filter (where bucket = 'scheduled')::int as scheduled_threads,
      count(*) filter (where bucket = 'waiting')::int as waiting_items,
      count(distinct root_id) filter (where bucket = 'waiting')::int as waiting_threads,
      count(*) filter (where bucket = 'issues')::int as issues_items,
      count(distinct root_id) filter (where bucket = 'issues')::int as issues_threads
    from filtered_items
  ) select * from root_counts cross join item_counts`);
  const row = result.rows[0] as CountRow | undefined;
  return {
    needsYou: row?.needs_you ?? 0,
    inProgress: row?.in_progress ?? 0,
    open: row?.open ?? 0,
    archive: row?.archive ?? 0,
    total: row?.total ?? 0,
    attentionItems: row?.attention_items ?? 0,
    items: {
      review: {
        items: row?.review_items ?? 0,
        threads: row?.review_threads ?? 0,
      },
      drafting: {
        items: row?.drafting_items ?? 0,
        threads: row?.drafting_threads ?? 0,
      },
      scheduled: {
        items: row?.scheduled_items ?? 0,
        threads: row?.scheduled_threads ?? 0,
      },
      waiting: {
        items: row?.waiting_items ?? 0,
        threads: row?.waiting_threads ?? 0,
      },
      issues: {
        items: row?.issues_items ?? 0,
        threads: row?.issues_threads ?? 0,
      },
    },
  };
}

export type ThreadCountsOptions = Pick<
  ThreadsPageOptions,
  "campaignId" | "search" | "now"
>;

/** Count-only projection for badges and layouts; no page query, no hydration. */
export async function threadCounts(
  tx: Tx,
  opts: ThreadCountsOptions = {},
): Promise<ThreadCounts> {
  return queryCounts(tx, opts, opts.now ?? Date.now());
}

async function queryRootPage(
  tx: Tx,
  opts: Required<Pick<ThreadsPageOptions, "view" | "limit" | "now">> &
    Pick<ThreadsPageOptions, "campaignId" | "search" | "cursor" | "filter"> & {
      mode: "threads" | "inbox";
    },
): Promise<{ rows: RootRow[]; hasMore: boolean }> {
  const cursor = decodeThreadCursor(opts.cursor);
  const viewFilter =
    opts.mode === "inbox"
      ? sql`not root.archived and root.section is not null`
      : opts.view === "archive"
        ? sql`root.archived`
        : sql`not root.archived`;
  const itemFilter = opts.filter
    ? sql`exists (
        select 1 from item_rollup item
        where item.root_id = root.root_id and item.bucket = ${opts.filter}
      )`
    : sql`true`;
  const cursorPredicate = !cursor
    ? sql`true`
    : opts.view === "archive"
      ? sql`(root.updated_at, root.root_id) < (${cursor.updatedAt}, ${cursor.rootId})`
      : sql`(
          cursor_root.root_id is not null and (
            (case when root.section = 'needs_you' then 0
              when root.section = 'in_progress' then 1 else 2 end) >
              (case when cursor_root.section = 'needs_you' then 0
                when cursor_root.section = 'in_progress' then 1 else 2 end)
            or (
              root.section = cursor_root.section and root.section = 'needs_you'
              and (root.updated_at, root.root_id) > (${cursor.updatedAt}, ${cursor.rootId})
            )
            or (
              root.section is not distinct from cursor_root.section
              and root.section is distinct from 'needs_you'
              and (root.updated_at, root.root_id) < (${cursor.updatedAt}, ${cursor.rootId})
            )
          )
        )`;
  const cursorJoin =
    cursor && opts.view === "open"
      ? sql`left join projected_roots cursor_root on cursor_root.root_id = ${cursor.rootId}`
      : sql``;
  const order =
    opts.view === "archive"
      ? sql`root.updated_at desc, root.root_id desc`
      : sql`case when root.section = 'needs_you' then 0
            when root.section = 'in_progress' then 1 else 2 end,
          case when root.section = 'needs_you' then root.updated_at end asc,
          case when root.section = 'needs_you' then root.root_id end asc,
          case when root.section is distinct from 'needs_you' then root.updated_at end desc,
          case when root.section is distinct from 'needs_you' then root.root_id end desc`;
  const result = await tx.execute(sql`${rootsProjection(opts.now)}
    select ${rootColumns()} from projected_roots root ${cursorJoin}
    where ${rootFilters(opts)} and ${viewFilter} and ${itemFilter} and ${cursorPredicate}
    order by ${order}
    limit ${opts.limit + 1}`);
  const rows = result.rows as unknown as RootRow[];
  return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
}

function messageProjection(
  message: Message,
  events: ThreadStatusEvent[],
  revisions: ThreadDraftRevision[],
  watch: ThreadWatch | null,
): ThreadMessage {
  return {
    id: message.id,
    kind: message.kind,
    campaignId: message.campaignId,
    discoveredPostId: message.discoveredPostId,
    incomingCommentId: message.incomingCommentId,
    proposedText: message.proposedText,
    finalText: message.finalText,
    status: message.status,
    externalUrn: message.externalUrn,
    model: message.model,
    error: message.error,
    createdAt: message.createdAt,
    postedAt: message.postedAt,
    scheduledAt: message.scheduledAt,
    postingStartedAt: message.postingStartedAt,
    redraftRequestId: message.redraftRequestId,
    redraftRequestVersion: message.redraftRequestVersion,
    redraftRequestedAt: message.redraftRequestedAt,
    redraftRequestedBy: message.redraftRequestedBy,
    redraftRequestNote: message.redraftRequestNote,
    events,
    revisions,
    watch,
  };
}

function selectCurrentMessage(rows: ThreadMessage[]): ThreadMessage | null {
  return (
    [...rows].sort(
      (a, b) =>
        Number(b.status === "posted") - Number(a.status === "posted") || b.id - a.id,
    )[0] ?? null
  );
}

async function hydrateRoots(tx: Tx, rootRows: RootRow[], now: number): Promise<Thread[]> {
  if (rootRows.length === 0) return [];
  const rootIds = rootRows.map((row) => row.root_id);
  const discoveredIds = rootRows
    .map((row) => row.discovered_post_id)
    .filter((id): id is number => id != null);

  const requestRows =
    discoveredIds.length === 0
      ? []
      : await tx
          .select()
          .from(candidateActions)
          .where(
            and(
              eq(candidateActions.action, "request_draft"),
              inArray(candidateActions.discoveredPostId, discoveredIds),
            ),
          )
          .orderBy(asc(candidateActions.createdAt), asc(candidateActions.id));
  const membershipResult = await tx.execute(sql`${rootGraph()}
    select 'incoming'::text as entity_kind,
      incoming_id::float8 as entity_id, root_id
    from incoming_roots where root_id in (${sql.join(
      rootIds.map((rootId) => sql`${rootId}`),
      sql`, `,
    )})
    union all
    select 'message'::text, message_id::float8, root_id
    from message_roots where root_id in (${sql.join(
      rootIds.map((rootId) => sql`${rootId}`),
      sql`, `,
    )})`);
  const memberships = membershipResult.rows as unknown as RootMembershipRow[];
  const incomingMemberships = memberships.filter((row) => row.entity_kind === "incoming");
  const messageMemberships = memberships.filter((row) => row.entity_kind === "message");
  const inboundIds = incomingMemberships.map((row) => row.entity_id);
  const messageIds = messageMemberships.map((row) => row.entity_id);
  const inboundRows =
    inboundIds.length === 0
      ? []
      : await tx
          .select()
          .from(incomingComments)
          .where(inArray(incomingComments.id, inboundIds))
          .orderBy(asc(incomingComments.receivedAt), asc(incomingComments.id));
  const allMessageRows =
    messageIds.length === 0
      ? []
      : await tx.select().from(messages).where(inArray(messages.id, messageIds));
  const conversationByIncoming = new Map(
    (inboundIds.length === 0
      ? []
      : await tx
          .select({
            incomingCommentId: conversationSources.incomingCommentId,
            conversationId: conversationSources.conversationId,
          })
          .from(conversationSources)
          .where(inArray(conversationSources.incomingCommentId, inboundIds))
    ).map((row) => [row.incomingCommentId, row.conversationId]),
  );

  const rootByDiscoveredId = new Map(
    rootRows
      .filter((row) => row.discovered_post_id != null)
      .map((row) => [row.discovered_post_id!, row.root_id]),
  );
  const messageRootById = new Map(
    messageMemberships.map((row) => [row.entity_id, row.root_id]),
  );
  const incomingRootById = new Map(
    incomingMemberships.map((row) => [row.entity_id, row.root_id]),
  );
  const initialMessagesByRoot = new Map<string, Message[]>();
  for (const message of allMessageRows) {
    if (message.kind !== "comment") continue;
    const rootId = messageRootById.get(message.id);
    if (!rootId) continue;
    const current = initialMessagesByRoot.get(rootId) ?? [];
    current.push(message);
    initialMessagesByRoot.set(rootId, current);
  }
  const replyRows = allMessageRows.filter((message) => message.kind === "reply");
  const eventRows =
    messageIds.length === 0
      ? []
      : await tx
          .select()
          .from(messageStatusEvents)
          .where(inArray(messageStatusEvents.messageId, messageIds))
          .orderBy(asc(messageStatusEvents.occurredAt), asc(messageStatusEvents.id));
  const revisionRows =
    messageIds.length === 0
      ? []
      : await tx
          .select()
          .from(messageDraftRevisions)
          .where(inArray(messageDraftRevisions.messageId, messageIds))
          .orderBy(
            asc(messageDraftRevisions.createdAt),
            asc(messageDraftRevisions.revision),
            asc(messageDraftRevisions.id),
          );
  const watchRows =
    messageIds.length === 0
      ? []
      : await tx
          .select()
          .from(commentWatches)
          .where(inArray(commentWatches.messageId, messageIds));

  const eventsByMessage = new Map<number, ThreadStatusEvent[]>();
  for (const event of eventRows) {
    const current = eventsByMessage.get(event.messageId) ?? [];
    current.push({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      localDay: event.localDay,
      occurredAt: event.occurredAt,
    });
    eventsByMessage.set(event.messageId, current);
  }
  const revisionsByMessage = new Map<number, ThreadDraftRevision[]>();
  for (const revision of revisionRows) {
    const current = revisionsByMessage.get(revision.messageId) ?? [];
    current.push({
      id: revision.id,
      revision: revision.revision,
      source: revision.source,
      draftText: revision.draftText,
      requestId: revision.requestId,
      requestVersion: revision.requestVersion,
      requestedAt: revision.requestedAt,
      requestedBy: revision.requestedBy,
      requestNote: revision.requestNote,
      model: revision.model,
      loopVersion: revision.loopVersion,
      promptVersionId: revision.promptVersionId,
      trace: revision.trace,
      createdAt: revision.createdAt,
    });
    revisionsByMessage.set(revision.messageId, current);
  }
  const watchesByMessage = new Map<number, ThreadWatch>();
  for (const watch of watchRows) {
    watchesByMessage.set(watch.messageId, {
      id: watch.id,
      state: watch.state,
      postUrn: watch.postUrn,
      commentUrn: watch.commentUrn,
      lastReplyCount: watch.lastReplyCount,
      lastReactionCount: watch.lastReactionCount,
      lastReadNote: watch.lastReadNote,
      quietChecks: watch.quietChecks,
      nextCheckAt: watch.nextCheckAt,
      expiresAt: watch.expiresAt,
      createdAt: watch.createdAt,
      updatedAt: watch.updatedAt,
    });
  }
  const projectedMessages = new Map(
    allMessageRows.map((message) => [
      message.id,
      messageProjection(
        message,
        eventsByMessage.get(message.id) ?? [],
        revisionsByMessage.get(message.id) ?? [],
        watchesByMessage.get(message.id) ?? null,
      ),
    ]),
  );
  const repliesByIncoming = new Map<number, ThreadMessage[]>();
  for (const reply of replyRows) {
    if (reply.incomingCommentId == null) continue;
    const current = repliesByIncoming.get(reply.incomingCommentId) ?? [];
    const projected = projectedMessages.get(reply.id);
    if (projected) current.push(projected);
    repliesByIncoming.set(reply.incomingCommentId, current);
  }

  const requestsByRoot = new Map<string, ThreadInitialRequest[]>();
  for (const request of requestRows) {
    const rootId = rootByDiscoveredId.get(request.discoveredPostId);
    if (!rootId) continue;
    const current = requestsByRoot.get(rootId) ?? [];
    current.push({
      id: request.id,
      active: request.revertedAt == null,
      actor: request.actor,
      createdAt: request.createdAt,
      revertedAt: request.revertedAt,
      revertedBy: request.revertedBy,
    });
    requestsByRoot.set(rootId, current);
  }

  const inboundByRoot = new Map<string, typeof inboundRows>();
  const inboundLinkAnomalies = new Map<number, ThreadAnomaly[]>();
  for (const incoming of inboundRows) {
    const directRoot =
      incoming.discoveredPostId == null
        ? undefined
        : rootByDiscoveredId.get(incoming.discoveredPostId);
    const parentRoot =
      incoming.parentMessageId == null
        ? undefined
        : messageRootById.get(incoming.parentMessageId);
    const rootId = incomingRootById.get(incoming.id);
    if (!rootId) continue;
    if (directRoot && parentRoot && directRoot !== parentRoot) {
      inboundLinkAnomalies.set(incoming.id, ["conflicting_root_links"]);
    }
    const current = inboundByRoot.get(rootId) ?? [];
    current.push(incoming);
    inboundByRoot.set(rootId, current);
  }

  return rootRows.map((row): Thread => {
    const root: ThreadRoot =
      row.root_kind === "discovered_post"
        ? {
            kind: "discovered_post",
            rootId: row.root_id as `d:${number}`,
            discoveredPostId: row.discovered_post_id!,
            campaign: { id: row.campaign_id!, name: row.campaign_name! },
            postUrn: row.post_urn,
            postUrl: linkedinPostUrl(row.post_url, row.post_urn),
            postAuthor: row.post_author,
            postContent: row.post_content,
            postedAt: row.posted_at,
            discoveredAt: row.discovered_at,
          }
        : {
            kind: "own_post",
            rootId: row.root_id as `o:${string}`,
            ownPostUrn: row.own_post_urn!,
            campaign: null,
            postUrl: linkedinPostUrl(row.post_url, row.post_urn),
            postContent: row.post_content,
            discoveredAt: row.discovered_at,
          };
    const initialCandidates = (initialMessagesByRoot.get(row.root_id) ?? [])
      .map((message) => projectedMessages.get(message.id))
      .filter((message): message is ThreadMessage => Boolean(message));
    const initialMessage = selectCurrentMessage(initialCandidates);
    const requestCandidates = requestsByRoot.get(row.root_id) ?? [];
    const request =
      [...requestCandidates].reverse().find((candidate) => candidate.active) ??
      requestCandidates.at(-1) ??
      null;
    const initialAnomalies: ThreadAnomaly[] = [];
    if (initialCandidates.length > 1) initialAnomalies.push("duplicate_initial_pipeline");
    if (
      root.kind === "discovered_post" &&
      initialMessage == null &&
      (inboundByRoot.get(row.root_id)?.length ?? 0) > 0
    ) {
      initialAnomalies.push("missing_initial_pipeline");
    }
    if (
      root.kind === "discovered_post" &&
      initialMessage?.campaignId != null &&
      initialMessage.campaignId !== root.campaign.id
    ) {
      initialAnomalies.push("message_campaign_mismatch");
    }
    const initialRedraftPending = Boolean(
      initialMessage?.redraftRequestId &&
        !initialMessage.revisions.some(
          (revision) => revision.requestId === initialMessage.redraftRequestId,
        ),
    );
    const initial: ThreadInitialTurn | null =
      root.kind === "own_post"
        ? null
        : {
            kind: "initial",
            request,
            message: initialMessage,
            anomalies: initialAnomalies,
            state: deriveTurnState({
              turn: "initial",
              requestActive: Boolean(request?.active),
              message: initialMessage,
              redraftPending: initialRedraftPending,
              anomalies: initialAnomalies,
              now,
            }),
          };
    const replies = (inboundByRoot.get(row.root_id) ?? []).map(
      (incomingRow): ThreadInboundReplyTurn => {
        const incoming: ThreadIncoming = {
          id: incomingRow.id,
          source: incomingRow.source,
          campaignId: incomingRow.campaignId,
          discoveredPostId: incomingRow.discoveredPostId,
          parentMessageId: incomingRow.parentMessageId,
          commentUrn: incomingRow.commentUrn,
          authorProfileId: incomingRow.authorProfileId,
          authorName: incomingRow.authorName,
          text: incomingRow.text,
          receivedAt: incomingRow.receivedAt,
          sensitivity: incomingRow.sensitivity,
          status: incomingRow.status,
          draftRequestId: incomingRow.draftRequestId,
          draftRequestVersion: incomingRow.draftRequestVersion,
          draftRequestedAt: incomingRow.draftRequestedAt,
          draftRequestedBy: incomingRow.draftRequestedBy,
          draftRequestNote: incomingRow.draftRequestNote,
        };
        const candidates = repliesByIncoming.get(incoming.id) ?? [];
        const reply = selectCurrentMessage(candidates);
        const anomalies = [...(inboundLinkAnomalies.get(incoming.id) ?? [])];
        if (candidates.length > 1) anomalies.push("duplicate_reply_pipeline");
        const redraftPending = Boolean(
          reply?.redraftRequestId &&
            !reply.revisions.some((revision) => revision.requestId === reply.redraftRequestId),
        );
        return {
          kind: "inbound_reply",
          incoming,
          conversationId: conversationByIncoming.get(incoming.id) ?? null,
          reply,
          anomalies,
          state: deriveTurnState({
            turn: "reply",
            requestActive: incoming.draftRequestId != null,
            incoming,
            message: reply,
            redraftPending,
            anomalies,
            now,
          }),
        };
      },
    );
    const states = [...(initial ? [initial.state] : []), ...replies.map((turn) => turn.state)];
    const archiveBlockers = [
      ...new Set(
        states
          .map((state) => state.archiveBlocker)
          .filter((blocker): blocker is ThreadArchiveBlocker => blocker != null),
      ),
    ];
    const items = THREAD_ITEM_STATES.filter((item) =>
      states.some((state) => state.item === item),
    );
    return {
      root,
      initial,
      replies,
      section: states.some((state) => state.section === "needs_you")
        ? "needs_you"
        : states.some((state) => state.section === "in_progress")
          ? "in_progress"
          : null,
      items,
      archiveBlockers,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
    };
  });
}

export async function threadsPage(
  tx: Tx,
  opts: ThreadsPageOptions = {},
): Promise<ThreadsPage> {
  const view = opts.view ?? "open";
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 30)));
  const now = opts.now ?? Date.now();
  const page = await queryRootPage(tx, {
    ...opts,
    view,
    limit,
    now,
    mode: "threads",
  });
  const counts = await queryCounts(tx, opts, now);
  const items = await hydrateRoots(tx, page.rows, now);
  const last = page.rows.at(-1);
  return {
    view,
    items,
    counts,
    hasMore: page.hasMore,
    nextCursor:
      page.hasMore && last
        ? encodeThreadCursor({ updatedAt: last.updated_at, rootId: last.root_id })
        : null,
  };
}

export async function threadInbox(
  tx: Tx,
  opts: Omit<ThreadsPageOptions, "view" | "filter"> = {},
): Promise<ThreadInbox> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 30)));
  const now = opts.now ?? Date.now();
  const page = await queryRootPage(tx, {
    ...opts,
    view: "open",
    limit,
    now,
    mode: "inbox",
  });
  const counts = await queryCounts(tx, opts, now);
  const items = await hydrateRoots(tx, page.rows, now);
  const last = page.rows.at(-1);
  const dm = opts.cursor ? [] : await dmInboxRows(tx, opts);
  return {
    needsYou: items.filter((item) => item.section === "needs_you"),
    inProgress: items.filter((item) => item.section === "in_progress"),
    dm: {
      needsYou: dm.flatMap(([section, row]) => (section === "needs_you" ? [row] : [])),
      inProgress: dm.flatMap(([section, row]) => (section === "in_progress" ? [row] : [])),
    },
    counts,
    nextCursor:
      page.hasMore && last
        ? encodeThreadCursor({ updatedAt: last.updated_at, rootId: last.root_id })
        : null,
    hasMore: page.hasMore,
  };
}

/** The DM threads a conversation holds that sort into either half, narrowed
 *  the way the post-rooted rows are: to one campaign, or a name. */
async function dmInboxRows(
  tx: Tx,
  opts: Pick<ThreadsPageOptions, "campaignId" | "search">,
): Promise<Array<[DmSection, DmInboxRow]>> {
  const search = opts.search?.toLocaleLowerCase("en");
  const items = await dmThreadItems(tx, { campaignId: opts.campaignId });
  return items.flatMap(({ section, lastMessage, ...item }) =>
    section === null ||
    (search !== undefined && !item.with.some((name) => name.toLocaleLowerCase("en").includes(search)))
      ? []
      : [
          [
            section,
            {
              ...item,
              wake: item.wake && fencedWake(item.wake),
              lastMessage: lastMessage && {
                eventId: lastMessage.eventId,
                intent: lastMessage.intent,
                reasons: lastMessage.reasons,
                at: lastMessage.at,
                content:
                  lastMessage.text === null
                    ? null
                    : delimited({ type: "inbound_message_observed", content: lastMessage.text }),
              },
            },
          ] as [DmSection, DmInboxRow],
        ],
  );
}

export type ThreadTurnRef =
  | { kind: "initial"; discoveredPostId: number }
  | { kind: "incoming"; incomingCommentId: number }
  | { kind: "message"; messageId: number };

export type ThreadTurnLookup = {
  thread: Thread;
  turn: ThreadInitialTurn | ThreadInboundReplyTurn;
};

async function resolveExactRootId(tx: Tx, ref: ThreadTurnRef): Promise<string | null> {
  if (ref.kind === "initial") return `d:${ref.discoveredPostId}`;
  const nodeKey =
    ref.kind === "message" ? `m:${ref.messageId}` : `i:${ref.incomingCommentId}`;
  const result = await tx.execute(sql`${rootGraph()}
    select root_id from resolved_nodes where node_key = ${nodeKey}
    order by depth, root_id limit 1`);
  const row = result.rows[0] as { root_id: string } | undefined;
  return row?.root_id ?? null;
}

/** Exact deep links intentionally bypass campaign/search/view/page constraints. */
export async function threadTurn(
  tx: Tx,
  ref: ThreadTurnRef,
  now = Date.now(),
): Promise<ThreadTurnLookup | null> {
  const rootId = await resolveExactRootId(tx, ref);
  if (!rootId) return null;
  const result = await tx.execute(sql`${rootsProjection(now)}
    select ${rootColumns()} from projected_roots root where root.root_id = ${rootId} limit 1`);
  const row = result.rows[0] as RootRow | undefined;
  if (!row) return null;
  const [thread] = await hydrateRoots(tx, [row], now);
  if (!thread) return null;
  if (ref.kind === "initial") {
    return thread.initial ? { thread, turn: thread.initial } : null;
  }
  if (ref.kind === "incoming") {
    const turn = thread.replies.find(
      (candidate) => candidate.incoming.id === ref.incomingCommentId,
    );
    return turn ? { thread, turn } : null;
  }
  const turn =
    thread.initial?.message?.id === ref.messageId
      ? thread.initial
      : thread.replies.find((candidate) => candidate.reply?.id === ref.messageId);
  return turn ? { thread, turn } : null;
}
