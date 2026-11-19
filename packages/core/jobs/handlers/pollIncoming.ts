import { incomingComments } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { getLLM } from "../../ai/client";
import { config } from "../../config";
import { isGrant, type CapabilitySurface } from "../../connector/resolve";
import { lookupProfileNames } from "../../linkedin/profileNames";
import { isConnectorBackoff } from "../../linkedin/connectorError";
import { claimPacedRun } from "../../pacing";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { replyCheckBaseMin, reservePollCall } from "../../ratelimit/ledger";
import { grantFor } from "../context";
import { enqueue, RescheduleError } from "../queue";
import type { JobResult, SelfScopedCtx } from "../worker";
import { pollReplyWatches } from "./replyWatches";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
} from "../spendAccess";

const DAY = 86_400_000;

/**
 * Pull the comments addressed to the account and persist them (dedupe by urn),
 * through whichever of the two `incoming` members the connector holds: the
 * sweep of the user's own posts, then the replies under comments we posted
 * for every campaign (`pollReplyWatches`).
 * SELF_SCOPED (like discovery): reserve the poll budget + take the capability in a SHORT
 * committed tx, RELEASE the connection, run the fetch holding NO pooled
 * connection (so a slow fetch can't pin the only connection at pool max 1), then write
 * in a second short tx. Reserving in its own committed tx means the E6 poll-budget charge
 * survives even if the subsequent fetch fails (a request that hit the provider is counted).
 *
 * PACED: the scheduler enqueues this every 5-min slot, but the actual provider read
 * self-gates on a persisted jittered interval (`claimPacedRun`, base
 * ENGAGER_POLL_INCOMING_BASE_MIN, or the account's reply setting when that is
 * shorter) — fixed-interval polling is a documented LinkedIn
 * automation detection signal. A not-due slot completes as a cheap no-op.
 *
 * A run that read the account's notification cards, or in which the agent
 * reader read a thread its parser could not (`pollReplyWatches`), completes
 * with what it did as the job's result.
 */
export async function handlePollIncoming(
  ctx: SelfScopedCtx,
  payload: { sinceTs?: number },
): Promise<JobResult | void> {
  const org = ctx.organizationId;
  const now = Date.now();

  const setup = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    // Never slower than the account's "Check replies every": the thread arm
    // below only reads watches this run reaches, so a reply setting under the
    // env base would otherwise be a number nothing honours.
    const paced = await claimPacedRun(
      tx,
      "poll_incoming",
      Math.min(config.pollIncomingBaseMs, (await replyCheckBaseMin(tx)) * 60_000),
      now,
    );
    if (!paced.due) return null;
    // Ask for the capability BEFORE reserving poll budget: a connector that
    // observes nothing incoming (an account nothing reaches) makes this run a
    // no-op, and reserving first would burn shared poll budget on nothing.
    const incoming = await grantFor(ctx, tx, "incoming");
    if (!isGrant(incoming)) return null;
    // The own-post sweep is the one provider call here, so only a connector
    // that HAS a sweep reserves for it. The local browser observes incoming
    // through its thread reads alone, each spending a research read of its
    // own; a poll row there would meter a call that is never made.
    const sweep = incoming.use.fetchIncomingComments
      ? await reservePollCall({ db: tx, now })
      : null;
    // The name backfill below is a SEPARATE question, asked separately: a
    // connector that polls comments but cannot read profiles leaves them
    // nameless, exactly as a driver without `fetchProfile` did.
    const names = await grantFor(ctx, tx, "profile");
    // So is the agent reader: a connector that hands over no page leaves a
    // thread its parser cannot read unread, as before.
    const pages = await grantFor(ctx, tx, "agent_read");
    const readPage = isGrant(pages) ? pages.use.readPageForAgent : undefined;
    return {
      incoming: incoming.use,
      sweep,
      names: isGrant(names) ? names.use : null,
      reader: readPage && isGrant(pages)
        ? { readPage: readPage.bind(pages.use), llm: ctx.llm ?? getLLM() }
        : null,
    };
  });
  if (!setup) return;
  if (setup.sweep) {
    if (!setup.sweep.ok) {
      throw new RescheduleError(
        setup.sweep.reason ?? "poll_capped",
        setup.sweep.retryAt,
      );
    }
    const completed = await sweepOwnPosts(
      ctx,
      setup.incoming,
      setup.names,
      payload.sinceTs ?? now - 7 * DAY,
      now,
    );
    if (!completed) return;
  }
  const watched = await pollReplyWatches(ctx, setup.incoming, now, setup.reader);
  const result: JobResult = {
    ...(watched.swept
      ? {
          notificationPages: watched.notificationPages,
          notifiedReplies: watched.notifiedReplies,
          notifiedReactions: watched.notifiedReactions,
          threadsRead: watched.threadsRead,
        }
      : {}),
    ...(watched.agentReads > 0
      ? {
          agentReads: watched.agentReads,
          agentRepliesRecorded: watched.agentRepliesRecorded,
          agentRowsDropped: watched.agentRowsDropped,
        }
      : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * The own-post sweep, reserved for above: fetch, backfill names, persist.
 * False when the connector refused at fetch time and the run should end.
 */
async function sweepOwnPosts(
  ctx: SelfScopedCtx,
  surface: CapabilitySurface<"incoming">,
  names: CapabilitySurface<"profile"> | null,
  since: number,
  now: number,
): Promise<boolean> {
  if (!surface.fetchIncomingComments) return true;
  const org = ctx.organizationId;
  await assertHostedJobSpendStillAllowed(ctx);
  let incoming;
  try {
    incoming = await surface.fetchIncomingComments(since); // NO connection held
  } catch (e) {
    // A 429/checkpoint during polling is transient (it clears on its own) — reschedule
    // WITHOUT burning a job attempt, like discovery does. Letting the raw connector error
    // propagate would count as a real failure and eventually dead-letter poll_incoming,
    // silently stopping auto-replies on a condition that was never permanent.
    if (isConnectorBackoff(e)) {
      // The throttle is the ACCOUNT's, so it pauses the account — not just this
      // job. Rescheduling alone left every other lane free to keep hitting the
      // same throttled account (T-2.11's "backoff but no auto-pause" gap).
      const reason = await pauseChannelForConnectorBackoff(org, e);
      throw new RescheduleError(reason, now + 15 * 60_000);
    }
    // Belt-and-braces behind the `incoming` grant above: a connector whose
    // declaration says yes and whose runtime says no is still a PERMANENT
    // condition for that connector, not a transient failure — complete the job
    // instead of burning attempts toward dead-letter. (Checked by code, not
    // instanceof, so this handler never static-imports the browser-use module
    // graph.)
    if ((e as { code?: unknown } | null)?.code === "unsupported_operation")
      return false;
    throw e;
  }

  // Backfill missing comment author names from the profile (still holding NO
  // connection) — the name labels the dashboard thread and enables the @-tag
  // in our reply. Best-effort: unresolved authors stay nameless.
  const unnamed = incoming.filter(
    (c) => !c.authorName && c.authorProfileId,
  );
  if (unnamed.length > 0 && names) {
    await assertHostedJobSpendStillAllowed(ctx);
    const found = await lookupProfileNames(
      names,
      unnamed.map((c) => c.authorProfileId as string),
    );
    for (const c of unnamed)
      c.authorName = found.get(c.authorProfileId as string);
  }

  await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    for (const c of incoming) {
      const [inserted] = await tx
        .insert(incomingComments)
        .values({
          ownPostUrn: c.ownPostUrn,
          commentUrn: c.commentUrn,
          authorProfileId: c.authorProfileId,
          authorName: c.authorName,
          text: c.text,
          receivedAt: c.receivedAt ?? Date.now(),
          status: "new",
          postText: c.ownPostText,
        })
        .onConflictDoNothing()
        .returning({ id: incomingComments.id });
      if (inserted) {
        await enqueue(tx, {
          type: "process_incoming",
          payload: { incomingCommentId: inserted.id },
          idempotencyKey: `process_incoming:${inserted.id}`,
          // Child work is due as of this poll's start. Re-evaluating Date.now()
          // for each row can place a later sibling a few milliseconds ahead of
          // an immediate drain's claim clock (especially under connection
          // contention or fake-clock tests), leaving one reply queued until the
          // next scheduler tick.
          nextRunAt: now,
        });
      }
    }
  });
  return true;
}
