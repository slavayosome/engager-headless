import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, chatPendingChanges, type ChatPendingChange } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { STRATEGY_PATCH, strategyPatchSchema, type StrategyPatch } from "../strategy/patch";
import { ACCOUNT_POLICY_UPDATE } from "../strategy/accountPolicy";
import {
  CAMPAIGN_FACTS,
  campaignFactsBaseSchema,
  campaignFactsSchema,
  type CampaignFactsBase,
  type CampaignFactsPatch,
} from "../operations/campaignFacts";
import { CAMPAIGN_DELETE } from "../operations/deleteCampaign";
import { contextHash as digest } from "../tasks/hash";
import type { McpCtx } from "../mcp/context";
import { errorResult, jsonResult } from "../mcp/tools/util";
import {
  PROPOSAL_KINDS,
  PROPOSED_CHANGE,
  ProposalNoOpError,
  isProposalKindName,
  type ProposalKindName,
  type ProposalSummary,
} from "./proposalKinds";

/**
 * THE ONE THING CHAT MAY DO TO A SETTING: propose it.
 *
 * `proposalKinds.ts` says what may be proposed and how each one applies. This
 * module is the primitive around that table — the tool the model calls, the row
 * it writes, and the decision an owner's click spends. The split matters
 * because the two halves answer different questions: the kinds table is
 * "which changes exist", and this file is "why a model cannot make one".
 *
 * The rule the founder set is that chat may change things only after the owner
 * says so, and it is enforced HERE rather than in the system prompt. Chat reads
 * third-party text now, so a prompt-only rule is one injected sentence from a
 * voice rewrite. What the model gets instead is a tool whose entire effect is a
 * `pending` row and a card:
 *
 *   - the payload is validated by the SAME schema the operation uses, so a
 *     proposal that could not be saved on the page is refused at the proposal,
 *     not at the click;
 *   - `before` is read off canonical state, never off the request, so the card
 *     states what IS rather than what the model said was;
 *   - the summary is written by the server, so the card's words are not the
 *     model's and its prose beside them cannot change one;
 *   - and the row is spendable exactly once, in one session, in one
 *     organization, for thirty minutes.
 *
 * NO MODEL TURN CAN SPEND ONE. There is no tool that applies a pending change —
 * not this one, not a second call to it, not a retry, and not recovery, which
 * reads receipts and never replays a step. The only caller of
 * `decidePendingChange` is the dashboard action behind the card's buttons.
 */

export const PROPOSE_CHANGE = "propose_change";

/**
 * How long a card is worth reading.
 *
 * A before → after describes a decision at a moment: the caps it names, the
 * steps it moves and the state it was computed against. Half an hour later the
 * owner is either making a different decision or not making one, and applying
 * it then is applying a sentence they have stopped reading. Staleness catches
 * the case where the numbers moved; this catches the case where nothing moved
 * and the reader did.
 */
export const PENDING_CHANGE_TTL_MS = 30 * 60_000;

/**
 * What the server says about a proposal, in its own words, on the result the
 * model reads back.
 *
 * Deliberately a sentence the model is shown rather than only a status field: a
 * model that reads `status: "pending"` and writes "done — your cap is now 40"
 * has not misread a field, it has misread what the call was. This is the field
 * that says what the call was.
 */
const NOTHING_CHANGED =
  "Nothing has changed. This is a proposal: it takes effect only when the owner presses the card's button, and it expires in 30 minutes. Do not describe it as done.";

/** And the same fact appended to a FINAL that still has one outstanding — the
 *  server's sentence, added after the model's, because prose cannot be trusted
 *  to carry it and the owner reading the answer is the person who has to act.
 *  Short, because it lands under every such answer. */
export const UNDECIDED_PROPOSAL_NOTE =
  "Not applied yet — the card above is where this becomes real.";

/** The registry's own refusal shape, so a cause a caller can act on keeps its
 *  code and recovery instead of arriving as prose (`campaignConfig.ts` does the
 *  same for the same reason) — and its details, when it carries what a retry
 *  needs: a strategy patch's issue paths, or the fresh diff of a conflict. */
export function refusalResult(error: unknown) {
  if (!(error instanceof AppError)) throw error;
  return errorResult(error.message, {
    code: error.code,
    status: error.status,
    ...("recovery" in error && typeof error.recovery === "string"
      ? { recovery: error.recovery }
      : {}),
    ...("details" in error && typeof error.details === "object" && error.details !== null
      ? { data: error.details as Record<string, unknown> }
      : {}),
  });
}

/** The session and turn a proposal belongs to. Both are the SERVER's — the
 *  broker's own session id and the request id it admitted the turn under — so
 *  neither is a value a model or a browser can choose. */
export type ProposalContext = { sessionId: string; turnId: string };

/** Where a proposal was made: a conversation, or — for a `strategy.patch`
 *  that widens, from wherever it came — none at all, which only a click that
 *  names no conversation can spend. */
export type ProposalOrigin = ProposalContext | { sessionId: null; turnId: null };

const proposalOrigin = new AsyncLocalStorage<ProposalContext>();
export function withChatProposalOrigin<T>(chat: ProposalContext | undefined, run: () => T): T {
  return chat ? proposalOrigin.run(chat, run) : run();
}

/** The sentence beside a card drawn with no conversation of its own. Inside a
 *  chat turn `recordProposal` adopts it, and the owner answers it on the card
 *  right there, so the page it would otherwise wait on is not where to send
 *  them. */
export function pendingNote(elsewhere: string): string {
  return proposalOrigin.getStore() ? NOTHING_CHANGED : elsewhere;
}

export type RecordedProposal = {
  pendingChangeId: string;
  kind: string;
  expiresAt: number;
  summary: ProposalSummary;
};

/**
 * Draw one card: validate the change with its kind's own schema, read `before`
 * off canonical state, author the summary, and write the pending row. Writes
 * nothing else — the change itself waits for the click.
 *
 * A kind may say its change is another kind's on the state in hand (a
 * worker's steps on a campaign that runs on its strategy are a
 * `strategy.patch`); the card drawn is then that kind's, validated by that
 * kind's schema.
 */
export async function recordProposal(
  tx: Tx,
  organizationId: string,
  change: { kind: ProposalKindName },
  origin: ProposalOrigin,
  now: number = Date.now(),
): Promise<RecordedProposal> {
  origin = origin.sessionId === null ? proposalOrigin.getStore() ?? origin : origin;
  let name: string = change.kind;
  let entry = PROPOSAL_KINDS[change.kind];
  // Parsed a second time on purpose. The SDK validated it against the union;
  // this is the kind's OWN schema, and it is the same call the apply path
  // makes against the stored payload — one door, so a proposal and the change
  // it becomes cannot be validated differently.
  let value: unknown = entry.schema.parse(change);
  const redirected = await entry.redirect(tx, organizationId, value);
  if (redirected) {
    if (!isProposalKindName(redirected.kind)) {
      throw new Error(`${name} redirected to an unknown kind ${redirected.kind}`);
    }
    name = redirected.kind;
    entry = PROPOSAL_KINDS[redirected.kind];
    value = entry.schema.parse(redirected.change);
  }
  const before = await entry.read(tx, organizationId, value);
  const { title, rows, level, ...said } = entry.summarize(before, value);
  // A card with no rows is a card that says nothing, and answering it would
  // still spend a click. It is also the honest answer to a model restating
  // what is already stored — which is what a summarised read most often
  // produces.
  if (rows.length === 0) throw new ProposalNoOpError();
  const summary: ProposalSummary = {
    level: level ?? entry.level,
    title,
    rows,
    page: entry.page(value),
    ...(entry.destructive ? { destructive: true } : {}),
    ...said,
  };
  const [row] = await tx
    .insert(chatPendingChanges)
    .values({
      sessionId: origin.sessionId,
      turnId: origin.turnId,
      kind: name,
      payload: value as Record<string, unknown>,
      before,
      summary: summary as unknown as Record<string, unknown>,
      expiresAt: now + PENDING_CHANGE_TTL_MS,
    })
    .returning();
  return { pendingChangeId: row!.id, kind: name, expiresAt: row!.expiresAt, summary };
}

/** What a tool that drew a card answers: the card, and the server's sentence
 *  that it is not a change. Every chat tool whose effect is a proposal answers
 *  with this, so the dashboard renders one card whichever tool drew it. */
export function proposalResult(card: RecordedProposal) {
  return jsonResult({
    proposed: true,
    ...card,
    status: "pending" as const,
    note: NOTHING_CHANGED,
  });
}

export function registerProposalTools(
  server: McpServer,
  ctx: McpCtx,
  chat: ProposalContext,
) {
  server.registerTool(
    PROPOSE_CHANGE,
    {
      title: "Propose a change for the owner to apply",
      description:
        "Propose ONE change as a card; nothing applies before the owner's press. Do not report it as made or re-propose it while unanswered. Kill switch, billing, LinkedIn authority and disconnecting are not proposable.",
      inputSchema: { change: PROPOSED_CHANGE },
    },
    async ({ change }) => {
      try {
        return await withOrg(ctx.organizationId, async (tx) => {
          return proposalResult(await recordProposal(tx, ctx.organizationId, change, chat));
        });
      } catch (error) {
        return refusalResult(error);
      }
    },
  );
}

export type ChangeDecision = "apply" | "decline";

/**
 * What the click got. `ok` is whether the owner's decision took effect — a
 * decline that recorded is `ok`, because declining is a decision and it worked.
 */
export type DecisionResult =
  | {
      ok: true;
      status: "applied" | "already_there" | "declined";
      kind: string;
      summary: ProposalSummary;
      message: string;
      outcome?: Record<string, unknown>;
    }
  | {
      ok: false;
      status: "stale" | "expired" | "spent" | "not_found" | "refused" | "conflict";
      code?: string;
      kind?: string;
      summary?: ProposalSummary;
      message: string;
      /** On `conflict`: what replaced the base, and what the change would do
       *  against the version now in force. */
      conflict?: Record<string, unknown>;
    };

/** What an owner reads when a card can no longer be answered. Each says what
 *  happened to the proposal, and the one thing that gets the change made. */
const REFUSAL_COPY = {
  stale:
    "These settings changed since this card was drawn, so it was not applied. Ask again and a fresh card will show what they say now.",
  expired:
    "This card expired before it was answered, so nothing was applied. Ask again for a fresh one.",
  spent: "This card was already answered.",
  not_found: "This card belongs to a different conversation, so it does nothing here.",
  elsewhere: "This card is not a change to this campaign, so it does nothing here.",
  movedAgain:
    "What this change is about changed again since you read it, so nothing was applied. Reload to see what it says now.",
  conflict:
    "Another change to this campaign landed after this card was drawn, so it was not applied. Ask again and a fresh card will show the change against what is in force now.",
} as const;

/**
 * SPEND ONE PENDING CHANGE. The only way a proposal becomes a change.
 *
 * Called from the dashboard action behind the card's buttons and from nowhere
 * else — in particular from no tool, so no model turn, retry or recovery pass
 * can reach it. Four things are checked under the row's own `for update` lock,
 * and each of them is a way a click could otherwise apply something the owner
 * did not decide:
 *
 *   the ORG, by RLS — another tenant's id selects nothing at all;
 *   the SESSION, because a proposal made in one conversation is a decision the
 *     owner made there, and a card id pasted anywhere else is inert — and a
 *     proposal made outside chat is spent only by a click that names none
 *     (and, where the click says which kind about which campaign it offers —
 *     a campaign's own Confirm — by no card that is anything else);
 *   the STATUS, so a double-click, a replayed POST and a second tab all find
 *     the row already spent rather than applying twice;
 *   and the BEFORE, re-read from canonical state and compared with what the
 *     card showed: a row that moved since is refused `stale`, because the
 *     owner approved a before → after and only half of it is still true —
 *     unless the click is an informed yes, from a page that showed the owner
 *     the state as it is now beside the change (`expects.shown`, on a kind
 *     that takes one), which is held to that instead.
 *
 * A kind with a compare-and-swap is asked first: a `strategy.patch` whose
 * base version was replaced is settled `conflict` with the fresh diff, and
 * never reaches the staleness check or the apply.
 *
 * A refusal from the operation itself rolls the transaction back whole,
 * including the status write, which is the honest outcome — nothing applied and
 * the card still answerable.
 */
export async function decidePendingChange(
  organizationId: string,
  input: {
    /** Null spends only a proposal made outside chat. `any` spends one
     *  whatever drew it — a campaign's Changes, and the account's, each of
     *  which lists every card about it wherever it was proposed, and so must
     *  name what it expects: a campaign's card its campaign, the account's
     *  its kind alone. */
    sessionId: string | null | "any";
    pendingChangeId: string;
    decision: ChangeDecision;
    selection?: number[];
    /** Who clicked — recorded by a kind whose change keeps its approver. */
    approver?: string;
    /** What the clicked card must be, for a surface that offers only one
     *  kind of change — about one campaign, where it names one: a card of
     *  another kind, or about another campaign, is refused before it is read
     *  any further. `shown` is what that surface showed the owner the state
     *  is now, beside the change: for a kind that takes an informed yes, the
     *  click is held to it rather than to the card's own `before`. */
    expects?: { kind: ProposalKindName; campaignId?: number; shown?: Record<string, unknown> };
    /** Written in the decision's own transaction once an apply has landed, so
     *  what the owner's yes brought with it lands with the change or not at
     *  all: a refusal after it rolls both back. Never run for a decline. */
    alongside?: (tx: Tx) => Promise<void>;
  },
  now: number = Date.now(),
): Promise<DecisionResult> {
  if (
    input.sessionId === "any" &&
    (input.expects === undefined ||
      (input.expects.kind !== ACCOUNT_POLICY_UPDATE && input.expects.campaignId === undefined))
  ) {
    throw new Error("a decision for any session must name what its card is about");
  }
  try {
    return await withOrg<DecisionResult>(organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(chatPendingChanges)
        .where(
          and(
            eq(chatPendingChanges.id, input.pendingChangeId),
            input.sessionId === "any"
              ? undefined
              : input.sessionId === null
                ? isNull(chatPendingChanges.sessionId)
                : eq(chatPendingChanges.sessionId, input.sessionId),
          ),
        )
        .for("update");
      if (!row)
        return {
          ok: false,
          status: "not_found",
          message: REFUSAL_COPY.not_found,
        };
      const summary = row.summary as unknown as ProposalSummary;
      if (input.expects && !expected(row, input.expects))
        return {
          ok: false,
          status: "refused",
          kind: row.kind,
          message: REFUSAL_COPY.elsewhere,
        };
      if (row.status !== "pending")
        return {
          ok: false,
          status: "spent",
          kind: row.kind,
          summary,
          message: REFUSAL_COPY.spent,
        };
      if (row.expiresAt <= now) {
        await settle(tx, row.id, "expired", now, null);
        return {
          ok: false,
          status: "expired",
          kind: row.kind,
          summary,
          message: REFUSAL_COPY.expired,
        };
      }
      const selectable = isProposalKindName(row.kind) && PROPOSAL_KINDS[row.kind].selectable;
      if (input.selection !== undefined && (!selectable || input.decision !== "apply") ||
          selectable && input.decision === "apply" &&
          (!Array.isArray(input.selection) || input.selection.length === 0 || input.selection.length > 4 ||
            input.selection.some((index) => !Number.isInteger(index) || index < 0 || index > 3) ||
            new Set(input.selection).size !== input.selection.length)) {
        return { ok: false, status: "refused", code: "invalid_proposal", message: "Choose valid searches from this card. Nothing was added." };
      }
      if (input.decision === "decline") {
        await settle(tx, row.id, "declined", now, null);
        return {
          ok: true,
          status: "declined",
          kind: row.kind,
          summary,
          message: "Left as it was.",
        };
      }
      // A kind a later release retired leaves rows behind it, and a kind whose
      // schema narrowed leaves payloads it no longer reads. Refusing is the
      // only honest answer: the payload was validated against a schema this
      // build no longer has, so there is nothing to re-validate it with.
      const entry = isProposalKindName(row.kind) ? PROPOSAL_KINDS[row.kind] : null;
      const parsed = entry?.schema.safeParse(row.payload);
      if (!entry || !parsed?.success)
        return {
          ok: false,
          status: "refused",
          kind: row.kind,
          summary,
          message:
            "This card was made by an older version of Engager and can no longer be applied. Ask again for a fresh one.",
        };
      const value = parsed.data;
      const conflict = await entry.conflict(tx, organizationId, value);
      if (conflict) {
        await settle(tx, row.id, "conflict", now, conflict);
        return {
          ok: false,
          status: "conflict",
          kind: row.kind,
          summary,
          message: REFUSAL_COPY.conflict,
          conflict,
        };
      }
      const before = await entry.read(tx, organizationId, value);
      const shown = entry.informedYes ? input.expects?.shown : undefined;
      if (shown !== undefined) {
        // An informed yes: the owner was shown the state beside the change,
        // and said yes to it. Spent while the state still says that — a field
        // that moved again since is refused, and the card stays answerable
        // against what it says now.
        if (digest(before) !== digest(shown))
          return {
            ok: false,
            status: "refused",
            kind: row.kind,
            summary,
            message: REFUSAL_COPY.movedAgain,
          };
      } else if (digest(before) !== digest(row.before)) {
        await settle(tx, row.id, "stale", now, { before });
        return {
          ok: false,
          status: "stale",
          kind: row.kind,
          summary,
          message: REFUSAL_COPY.stale,
        };
      }
      const outcome = await entry.apply(tx, organizationId, value, {
        approver: input.approver ?? null,
        now,
        selection: input.selection,
      });
      await input.alongside?.(tx);
      // WHAT THE OPERATION FOUND, not just that it ran. `storeKnowledge` and
      // `updateKnowledge` dedupe on content and answer `changed: false` when
      // the note the owner just approved was already in the Brain — reporting
      // that as "Applied" told them a write happened and told the next turn to
      // stop offering something it had never delivered. The decision is still
      // spent either way: they answered the card, and pressing it again must
      // not re-run the operation.
      const landed = outcome.changed === false ? "already_there" : "applied";
      await settle(tx, row.id, landed, now, outcome);
      // An expired design this card was drawn again from is spent with it.
      await tx
        .update(chatPendingChanges)
        .set({ status: "expired", decidedAt: now })
        .where(
          and(
            eq(chatPendingChanges.status, "pending"),
            sql`${chatPendingChanges.outcome} ->> 'drawnAgainAs' = ${row.id}`,
          ),
        );
      return {
        ok: true,
        status: landed,
        kind: row.kind,
        summary,
        outcome,
        message:
          landed === "applied" ? "Applied." : "It already said that — nothing to change.",
      };
    });
  } catch (error) {
    // The transaction rolled back with the refusal, so the card is still
    // answerable and nothing was written. The operation's own message is what
    // the owner needs — it is the same one the page's save would have shown.
    if (error instanceof AppError)
      return { ok: false, status: "refused", message: error.message };
    throw error;
  }
}

/** Whether a card is the kind, about the campaign, a click said it would be.
 *  Read off the stored payload, which the kind's own schema validated; a kind
 *  about no campaign carries none, and matches a click that names none. */
function expected(
  row: { kind: string; payload: unknown },
  expects: { kind: ProposalKindName; campaignId?: number },
): boolean {
  const payload = row.payload as { campaignId?: unknown } | null;
  return row.kind === expects.kind && payload?.campaignId === expects.campaignId;
}

async function settle(
  tx: Tx,
  id: string,
  status: "applied" | "already_there" | "declined" | "stale" | "expired" | "conflict",
  now: number,
  outcome: Record<string, unknown> | null,
): Promise<void> {
  await tx
    .update(chatPendingChanges)
    .set({ status, decidedAt: now, outcome })
    .where(eq(chatPendingChanges.id, id));
}

/** More card actions than one turn can hold. */
const MAX_OUTCOME_LOOKUP = 25;

/** The shape `chat_pending_changes.id` actually is. Every value reaching
 *  `settledProposals` came off a client buffer, and `uuid = $1` on anything
 *  else is a Postgres type error — thrown, in this case, before the response
 *  stream opens, which the owner reads as the turn failing. A malformed id
 *  names no row this organization holds, so the honest answer is the same one
 *  an unknown id gets: drop it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * WHAT THE ROWS SAY BECAME OF THESE CARDS.
 *
 * The client tells the next turn what the owner did, because it is the only
 * thing that watched them do it — but WHAT HAPPENED is a row, and a row is
 * something the server can read. The preamble is prompt text the agent treats
 * as fact, so it is built from this rather than from the two strings the
 * browser sent back; an id this organization does not hold comes back absent
 * and is dropped rather than described.
 *
 * Bounded and shape-checked, because the buffer is client-supplied: a turn
 * carries at most a handful of card actions, and a list longer than that is
 * not a conversation.
 */
export async function settledProposals(
  organizationId: string,
  ids: string[],
): Promise<Map<string, { kind: string; status: string }>> {
  const wanted = [...new Set(ids)]
    .filter((id) => UUID.test(id))
    .slice(0, MAX_OUTCOME_LOOKUP);
  if (wanted.length === 0) return new Map();
  return withOrg(organizationId, async (tx) =>
    new Map(
      (
        await tx
          .select({
            id: chatPendingChanges.id,
            kind: chatPendingChanges.kind,
            status: chatPendingChanges.status,
          })
          .from(chatPendingChanges)
          .where(inArray(chatPendingChanges.id, wanted))
      ).map((row) => [row.id, { kind: row.kind, status: row.status }]),
    ),
  );
}

/**
 * The proposals THIS TURN made that nobody has answered yet.
 *
 * Read at the turn's final, because a final that describes a change as made
 * while its card is still sitting there is the one claim this design cannot
 * prevent structurally — the model can write any sentence. What it can be given
 * is the server's own sentence underneath, which `broker.ts` appends. Read
 * rather than derived from the turn's steps: the owner may have pressed the
 * button while the model was still thinking, and a note under an answer about a
 * change that HAS been applied is its own small lie.
 */
export async function undecidedProposals(
  organizationId: string,
  turnId: string,
  now: number = Date.now(),
): Promise<{ id: string; kind: string }[]> {
  return withOrg(organizationId, async (tx) =>
    (
      await tx
        .select({
          id: chatPendingChanges.id,
          kind: chatPendingChanges.kind,
          expiresAt: chatPendingChanges.expiresAt,
        })
        .from(chatPendingChanges)
        .where(
          and(
            eq(chatPendingChanges.turnId, turnId),
            eq(chatPendingChanges.status, "pending"),
          ),
        )
        .orderBy(asc(chatPendingChanges.createdAt))
    )
      .filter((row) => row.expiresAt > now)
      .map(({ id, kind }) => ({ id, kind })),
  );
}

/** One card about a campaign, as its own pages list it. */
export type CampaignProposal = {
  pendingChangeId: string;
  kind: string;
  /** Drawn in a chat conversation, or outside one — the owner's own agent
   *  over MCP, an old writer redirected, the workspace. */
  fromChat: boolean;
  summary: ProposalSummary;
  createdAt: number;
  expiresAt: number;
  /** Past its expiry and not yet answered: it can only be read — or drawn
   *  again, by the owner's own press (`strategy/submit.ts`). */
  expired: boolean;
};

/** How long a card nobody answered stays listed, as expired, past its expiry. */
const EXPIRED_LISTED_MS = 24 * 60 * 60_000;

/** The kinds a card about one campaign is: a change to its strategy, to
 *  what it is for, its delete, or the switch an upgrade asks for. */
const CAMPAIGN_KINDS = [STRATEGY_PATCH, CAMPAIGN_FACTS, CAMPAIGN_DELETE];

/** A card about one campaign, whatever drew it. */
function aboutCampaign(campaignId: number) {
  return and(
    inArray(chatPendingChanges.kind, CAMPAIGN_KINDS),
    sql`${chatPendingChanges.payload} ->> 'campaignId' = ${String(campaignId)}`,
  );
}

function asProposal(row: ChatPendingChange, now: number): CampaignProposal {
  return {
    pendingChangeId: row.id,
    kind: row.kind,
    fromChat: row.sessionId !== null,
    summary: row.summary as unknown as ProposalSummary,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    expired: row.expiresAt <= now,
  };
}

/**
 * EVERY UNANSWERED CHANGE TO ONE CAMPAIGN, whatever drew it, newest first —
 * what the campaign's Changes page lists, and what its bar counts while one
 * is live, so a widening an agent proposed outside the app
 * is never stranded where the owner cannot reach it. One that expired
 * unanswered stays listed as expired for a day, so the owner who was told
 * about it finds what became of it rather than nothing.
 */
export async function campaignProposals(
  tx: Tx,
  campaignId: number,
  now: number = Date.now(),
): Promise<CampaignProposal[]> {
  const rows = await tx
    .select()
    .from(chatPendingChanges)
    .where(
      and(
        aboutCampaign(campaignId),
        eq(chatPendingChanges.status, "pending"),
        gt(chatPendingChanges.expiresAt, now - EXPIRED_LISTED_MS),
      ),
    )
    .orderBy(desc(chatPendingChanges.createdAt));
  return rows.map((row) => asProposal(row, now));
}

/**
 * ONE CARD ABOUT ONE CAMPAIGN, answered or not — what its own page shows.
 * Null for an id that is not a card about this campaign, so a card id carried
 * over from another campaign reads as one that does not exist.
 */
export async function campaignProposal(
  tx: Tx,
  campaignId: number,
  pendingChangeId: string,
  now: number = Date.now(),
): Promise<(CampaignProposal & { status: ChatPendingChange["status"] }) | null> {
  if (!UUID.test(pendingChangeId)) return null;
  const [row] = await tx
    .select()
    .from(chatPendingChanges)
    .where(and(eq(chatPendingChanges.id, pendingChangeId), aboutCampaign(campaignId)));
  return row ? { ...asProposal(row, now), status: row.status } : null;
}

/** A change to what one campaign is for, waiting for a yes on its Strategy:
 *  what it sets, and what the fields said when it was drawn — its `before`. */
export type CampaignFactsProposal = Pick<CampaignProposal, "pendingChangeId" | "expiresAt"> & {
  patch: CampaignFactsPatch;
  base: CampaignFactsBase;
};

/** The live ones for one campaign, oldest first — the order they were asked
 *  for. Each payload and `before` is parsed by the kind's own schemas, as
 *  every stored one is before it is used. */
export async function campaignFactsProposals(
  tx: Tx,
  campaignId: number,
  now: number = Date.now(),
): Promise<CampaignFactsProposal[]> {
  const rows = await tx
    .select()
    .from(chatPendingChanges)
    .where(
      and(
        aboutCampaign(campaignId),
        eq(chatPendingChanges.kind, CAMPAIGN_FACTS),
        eq(chatPendingChanges.status, "pending"),
        gt(chatPendingChanges.expiresAt, now),
      ),
    )
    .orderBy(asc(chatPendingChanges.createdAt));
  return rows.map((row) => {
    const { patch } = campaignFactsSchema.parse(row.payload);
    const base = campaignFactsBaseSchema.parse(row.before);
    return { pendingChangeId: row.id, expiresAt: row.expiresAt, patch, base };
  });
}

/** One campaign's change waiting for a yes, as the Inbox lists it. */
export type WaitingCampaignChange = {
  pendingChangeId: string;
  campaignId: number;
  campaignName: string;
  title: string;
  /** Its yes starts the campaign. */
  start: boolean;
  /** Drawn in a chat conversation, rather than on one of the app's pages. */
  fromChat: boolean;
  expiresAt: number;
};

/**
 * EVERY CAMPAIGN CHANGE WAITING FOR A YES, across campaigns, newest first —
 * so the owner meets one from the Inbox as well as from the campaign it is
 * about. Live ones only: an expired card asks nothing of anyone.
 */
export async function waitingCampaignChanges(
  tx: Tx,
  now: number = Date.now(),
): Promise<WaitingCampaignChange[]> {
  return campaignChangesExpiring(tx, gt(chatPendingChanges.expiresAt, now));
}

/** The campaign cards nobody answered whose expiry the window holds, newest
 *  first. */
async function campaignChangesExpiring(tx: Tx, window: SQL | undefined): Promise<WaitingCampaignChange[]> {
  const rows = await tx
    .select({
      id: chatPendingChanges.id,
      sessionId: chatPendingChanges.sessionId,
      summary: chatPendingChanges.summary,
      expiresAt: chatPendingChanges.expiresAt,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
    })
    .from(chatPendingChanges)
    .innerJoin(campaigns, sql`${campaigns.id} = (${chatPendingChanges.payload} ->> 'campaignId')::bigint`)
    .where(
      and(
        inArray(chatPendingChanges.kind, CAMPAIGN_KINDS),
        eq(chatPendingChanges.status, "pending"),
        window,
        isNull(campaigns.deletedAt),
      ),
    )
    .orderBy(desc(chatPendingChanges.createdAt));
  return rows.map((row) => {
    const summary = row.summary as unknown as ProposalSummary;
    return {
      pendingChangeId: row.id,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      title: summary.title,
      start: summary.start === true,
      fromChat: row.sessionId !== null,
      expiresAt: row.expiresAt,
    };
  });
}

/** One card about the account's own policy, as its pages list it — the same
 *  card a campaign's is, about the account instead. */
export type AccountProposal = CampaignProposal;

/**
 * EVERY UNANSWERED CHANGE TO THE ACCOUNT'S POLICY, whatever drew it — the
 * owner's own agent (`update_channel`), a chat conversation, one of
 * the account's own pages — newest first: what the Inbox's Your setup row
 * lists while one is live. One that expired unanswered stays listed as
 * expired for a day, under its Earlier, as a campaign's does.
 */
export async function accountProposals(
  tx: Tx,
  now: number = Date.now(),
): Promise<AccountProposal[]> {
  const rows = await tx
    .select()
    .from(chatPendingChanges)
    .where(
      and(
        eq(chatPendingChanges.kind, ACCOUNT_POLICY_UPDATE),
        eq(chatPendingChanges.status, "pending"),
        gt(chatPendingChanges.expiresAt, now - EXPIRED_LISTED_MS),
      ),
    )
    .orderBy(desc(chatPendingChanges.createdAt));
  return rows.map((row) => asProposal(row, now));
}

/** One change to the account's policy waiting for a yes, as the Inbox lists it. */
export type WaitingAccountChange = Pick<WaitingCampaignChange, "pendingChangeId" | "title" | "fromChat" | "expiresAt">;

/** Every live account change waiting for a yes, newest first — so the owner
 *  meets one from Activity as well as from the account it is about. */
export async function waitingAccountChanges(
  tx: Tx,
  now: number = Date.now(),
): Promise<WaitingAccountChange[]> {
  return (await accountProposals(tx, now))
    .filter((proposal) => !proposal.expired)
    .map(waitingAccountChange);
}

function waitingAccountChange(proposal: AccountProposal): WaitingAccountChange {
  return {
    pendingChangeId: proposal.pendingChangeId,
    title: proposal.summary.title,
    fromChat: proposal.fromChat,
    expiresAt: proposal.expiresAt,
  };
}

/**
 * THE CHANGES THAT EXPIRED BEFORE THE OWNER ANSWERED, across campaigns and the
 * account, while they are still listed — a day past their expiry, the rule
 * their own pages list them by. Each opens on its page, where a design can be
 * drawn again against today's strategy; nothing here answers one.
 */
export async function expiredChanges(
  tx: Tx,
  now: number = Date.now(),
): Promise<{ campaigns: WaitingCampaignChange[]; account: WaitingAccountChange[] }> {
  return {
    campaigns: await campaignChangesExpiring(
      tx,
      and(lte(chatPendingChanges.expiresAt, now), gt(chatPendingChanges.expiresAt, now - EXPIRED_LISTED_MS)),
    ),
    account: (await accountProposals(tx, now)).filter((proposal) => proposal.expired).map(waitingAccountChange),
  };
}

/** ONE CARD ABOUT THE ACCOUNT'S POLICY, answered or not — what its own page
 *  shows. Null for an id that is not one. */
export async function accountProposal(
  tx: Tx,
  pendingChangeId: string,
  now: number = Date.now(),
): Promise<(AccountProposal & { status: ChatPendingChange["status"] }) | null> {
  if (!UUID.test(pendingChangeId)) return null;
  const [row] = await tx
    .select()
    .from(chatPendingChanges)
    .where(
      and(eq(chatPendingChanges.id, pendingChangeId), eq(chatPendingChanges.kind, ACCOUNT_POLICY_UPDATE)),
    );
  return row ? { ...asProposal(row, now), status: row.status } : null;
}

/**
 * AN EXPIRED CARD, TAKEN FOR THE OWNER'S LATER YES — locked, so two presses
 * cannot both draw it again. Its patch is parsed by the kind's own schema, as
 * every stored payload is before it is used. Null when the id is not an
 * expired, unanswered card about this campaign: one still open is answered
 * where it stands, and one answered is spent.
 */
export async function takeExpiredProposal(
  tx: Tx,
  campaignId: number,
  pendingChangeId: string,
  now: number = Date.now(),
): Promise<{ id: string; patch: StrategyPatch } | null> {
  if (!UUID.test(pendingChangeId)) return null;
  const [row] = await tx
    .select()
    .from(chatPendingChanges)
    .where(
      and(
        eq(chatPendingChanges.id, pendingChangeId),
        aboutCampaign(campaignId),
        // Only a change to its strategy is drawn again; a delete is asked
        // for afresh.
        eq(chatPendingChanges.kind, STRATEGY_PATCH),
        eq(chatPendingChanges.status, "pending"),
        lte(chatPendingChanges.expiresAt, now),
      ),
    )
    .for("update");
  return row ? { id: row.id, patch: strategyPatchSchema.parse(row.payload) } : null;
}

/** Name the card an expired one was drawn again as. It stays listed, and
 *  answerable again, until that card's yes lands (`decidePendingChange`). */
export async function markDrawnAgain(tx: Tx, id: string, drawnAgainAs: string): Promise<void> {
  await tx.update(chatPendingChanges).set({ outcome: { drawnAgainAs } }).where(eq(chatPendingChanges.id, id));
}

/** Settle an expired card once what it proposed landed another way: it
 *  leaves the list, and `outcome` says where it went. */
export async function retireExpiredProposal(
  tx: Tx,
  id: string,
  now: number,
  outcome: Record<string, unknown>,
): Promise<void> {
  await settle(tx, id, "expired", now, outcome);
}
