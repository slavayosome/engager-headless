import { randomUUID } from "node:crypto";
import { workerRuns } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import type { JsonOpts } from "../ai/client";
import type { DiscoverParams, DiscoverResult } from "../linkedin/driver";
import { MockDriver } from "../linkedin/mock";
import { audienceProfileInputSchema } from "../audience/model";
import { requireSavedCampaign, saveCampaign } from "../operations/saveCampaign";
import { scoutIdFor } from "../operations/workers";
import { getChannel } from "./db";
import { FakeLLM } from "./fakes";
import { designAsOwner, startAsOwner } from "./startCampaign";

/**
 * A QUICK CAMPAIGN'S FIRST LOOK, for the suites that run one: the campaign,
 * an account whose searches each answer with posts of their own, and a model
 * that judges and drafts whatever the server froze.
 */

/** Searches enough for every round of a first look to read two new ones. */
export const QUICK_KEYWORDS = ["founder sales", "first sales hire", "outbound", "pricing", "churn", "pipeline"];

/**
 * A Quick campaign on its strategy, waiting for its Start or started
 * when asked. `depth` makes it another depth's, for the cases that hold the
 * others unchanged.
 */
export async function quickCampaign(
  organizationId: string,
  opts: { keywords?: string[]; start?: boolean; depth?: "quick" | "standard"; line?: string } = {},
): Promise<{ campaignId: number; scoutId: number }> {
  const campaignId = await withOrg(organizationId, async (tx) => {
    const saved = await saveCampaign(tx, organizationId, { createFields: {
      name: `Quick ${randomUUID().slice(0, 8)}`,
      discovery: { keywords: opts.keywords ?? QUICK_KEYWORDS },
      // The audience line the owner wrote, which a wider one replaces.
      ...(opts.line === undefined
        ? {}
        : { audienceProfile: audienceProfileInputSchema.parse({ who: { summary: opts.line } }) }),
    }, depth: opts.depth ?? "quick", source: "form", actor: "owner" }, "test:owner");
    return requireSavedCampaign(saved).campaign!.id;
  });
  if (opts.start) await startAsOwner(organizationId, campaignId);
  else await designAsOwner(organizationId, campaignId);
  const scoutId = await withOrg(organizationId, (tx) => scoutIdFor(tx, campaignId));
  if (scoutId === null) throw new Error("a campaign is created with its Scout");
  return { campaignId, scoutId };
}

/**
 * A first look the Scout already ran to its end: one finished first round,
 * `over` changing what it came to — no match by default, the failure of a
 * round with `{ status: "failed", error }`. Nothing of it is queued.
 */
export async function ranFirstLook(
  organizationId: string,
  scoutId: number,
  campaignId: number,
  over: Partial<typeof workerRuns.$inferInsert> = {},
): Promise<number> {
  return withOrg(organizationId, async (tx) => {
    const startedAt = Date.now() - 60_000;
    const [run] = await tx
      .insert(workerRuns)
      .values({
        workerId: scoutId,
        campaignId,
        channelId: (await getChannel(tx)).id,
        trigger: "manual",
        status: "succeeded",
        firstLookRound: 1,
        startedAt,
        finishedAt: startedAt + 30_000,
        ...over,
      })
      .returning({ id: workerRuns.id });
    return run!.id;
  });
}

/** An account whose every search answers with `perTerm` new posts of its
 *  own, each by an author of its own — but the searches named `dry`, which
 *  answer with none. */
export class TermDriver extends MockDriver {
  constructor(
    private readonly perTerm = 3,
    private readonly dry: ReadonlySet<string> = new Set(),
  ) {
    super({ posts: [] });
  }

  override async discoverPosts(params: DiscoverParams): Promise<DiscoverResult> {
    await super.discoverPosts(params);
    const term = params.term ?? "";
    if (this.dry.has(term)) return { posts: [], nextCursor: null, cursorState: "active" };
    const page = params.cursor ? Number(params.cursor) : 0;
    return {
      posts: Array.from({ length: this.perTerm }, (_, i) => {
        const id = randomUUID();
        return {
          postUrn: `urn:li:activity:${id}`,
          authorProfileId: `p-${id}`,
          authorName: `Author ${term} ${page}.${i}`,
          contentText: `A founder on "${term}": we still run every sales call ourselves, post ${i}.`,
          postedAt: Date.now() - (i + 1) * 60_000,
          detectedLanguage: "en",
          authorGeo: "US",
        };
      }),
      nextCursor: String(page + 1),
      cursorState: "active",
    };
  }
}

/** The ids a stage froze, read back off the `- id: N` lines it renders. */
export function frozenIdsIn(user: string): number[] {
  return [...user.matchAll(/^- id: (\d+)$/gm)].map((match) => Number(match[1]));
}

/**
 * A model for a first look: triage matches every post it is handed, the
 * first highest; the first-look writer drafts each post it is handed. Every
 * other call is the suite-wide fake's.
 */
export class FirstLookLLM extends FakeLLM {
  /** Posts whose first-look draft carries a character the text gate refuses. */
  readonly gated = new Set<number>();
  /** How many of each batch triage matches; the rest it rejects. */
  matchesPerBatch = Number.POSITIVE_INFINITY;
  /** The ids each triage call was handed. */
  readonly judging: number[][] = [];
  /** The ids each first-look writer call was handed. */
  readonly drafting: number[][] = [];

  override async json<T>(opts: JsonOpts<T>): Promise<T> {
    const ids = frozenIdsIn(opts.user);
    if (opts.promptRef?.startsWith("worker.triage")) {
      this.judging.push(ids);
      return {
        verdicts: ids.map((id, index) =>
          index < this.matchesPerBatch
            ? { discoveredPostId: id, verdict: "match", score: 0.95 - index * 0.01, reason: "a founder who sells" }
            : { discoveredPostId: id, verdict: "reject", reason: "not the audience" },
        ),
      } as T;
    }
    if (opts.promptRef?.startsWith("worker.first_look_draft")) {
      this.drafting.push(ids);
      return {
        drafts: ids.map((id) => ({
          discoveredPostId: id,
          move: "question",
          angle: "Ask what changed after the second call",
          rationale: "The post names doing every sales call yourself.",
          text: `When did the second call stop needing you in the room? Asking for post ${id}.${this.gated.has(id) ? "\u200b" : ""}`,
        })),
      } as T;
    }
    return super.json(opts);
  }
}

/** The wider line a model suggests for a first look that found no one, and the
 *  searches it plans from it. */
export const WIDER_LINE = "Founders and first sales hires at software companies";
export const WIDER_SEARCHES = ["first sales hire", "founder led sales", "outbound", "pricing", "churn"];

/** A model that suggests that wider line and plans those searches, keeping
 *  what it was asked. */
export class WideningLLM extends FakeLLM {
  readonly asked: Array<{ promptRef: string | undefined; user: string }> = [];

  override async json<T>(opts: JsonOpts<T>): Promise<T> {
    this.asked.push({ promptRef: opts.promptRef, user: opts.user });
    if (opts.promptRef?.startsWith("campaigns.widen_line")) return { line: WIDER_LINE } as T;
    if (opts.promptRef?.startsWith("campaigns.scout_sources")) {
      return { keywords: WIDER_SEARCHES, hashtags: ["saas"], rationale: "What they post about." } as T;
    }
    return super.json(opts);
  }
}
