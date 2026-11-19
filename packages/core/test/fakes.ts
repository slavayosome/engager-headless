import type { JsonOpts, LLM, TextOpts } from "../ai/client";
import { LLMOutputError } from "../ai/errors";
import { promptIdOf } from "../ai/prompt/ids";
import { currentUsageContext, type UsageContext } from "../ai/usage";
import { BRAIN_SLOTS } from "../brain/slots";

/**
 * Deterministic LLM for pipeline tests. Routes structured calls primarily by
 * `promptRef` (the stable call-site id), falling back to legacy system-prompt
 * substring matching for callers that don't pass one; overrides let a test force
 * a particular filter/slop/sensitivity verdict (or brain assessment).
 */
export class FakeLLM implements LLM {
  textReply =
    "That reporting gap is brutal — did the support delays push you to switch, or the data?";
  filter: Record<string, unknown> = {};
  /** Overrides on the "judge.incoming_reading" verdict, or a function of the
   *  call's user prompt — the one fenced item — so a read of several messages
   *  answers each by its words (default: benign, relevant, neutral, no
   *  intent; a direct message reads as a greeting). */
  reading:
    | Record<string, unknown>
    | ((user: string) => Record<string, unknown>) = {};
  /** Words the dispatcher's writer returns for an invitation's note. */
  invitationNote = "Your point about measuring it per team, weekly, stuck with me. Glad to connect.";
  /** Words the dispatcher's writer returns for a DM or a follow-up. */
  directMessage = "Happy to show you how the ramp reads your pacing first. Want a quick walkthrough this week?";
  /** Per-slot confidence override for the "brain coverage" route (default 0.5). */
  brainCoverage?: { slot: string; confidence: number; missing: string }[];
  /** Facts returned by the "extract product facts" (URL ingest) route. */
  productFacts?: { facet: string; content: string }[];
  /** Products returned by the "identify products" (brain-seed) route. */
  productsFromText?: { name: string; oneLiner?: string; facts?: { facet: string; content: string }[] }[];
  /** Decisions returned by the "reconcile product facts" route (default: add all). */
  factDecisions?: { index: number; action: string; mergeIntoId?: number; content?: string }[];
  /** Voice profile returned by the "VOICE PROFILE" (tone import / learnVoice) route. */
  voiceProfile?: {
    persona_description: string;
    style_bullets: string[];
    /** Optional structured register observations (ToneProfile.observed). */
    observed?: unknown;
  };
  /** Structural range returned by the "RANGE OF STRUCTURES" (extractStructuralRange) route. */
  structuralRange?: {
    opening: { id: string; weight: number }[];
    shape: { id: string; weight: number }[];
    stance: { id: string; weight: number }[];
  };
  /** Prose returned by the compile ("CAMPAIGN FOCUS BRIEF") text route. */
  compileBrief?: string;
  /** Terms returned by the discovery enrichment ("ADJACENT SEARCH TERMS") route. */
  enrichTerms?: { keywords: string[]; hashtags: string[] };
  /** The Scout's search plan ("discovery.plan"), or an Error the call throws
   *  (default: keep everything, change nothing). */
  searchPlan?: Record<string, unknown> | Error;
  /** The user prompts every "discovery.plan" call was asked in. */
  readonly searchPlanPrompts: string[] = [];
  lookalikeResult?: Record<string, unknown> | Error;
  readonly lookalikePrompts: string[] = [];
  audienceThemes?: Record<string, unknown> | Error;
  readonly audienceThemePrompts: string[] = [];
  /** Verdicts returned by the "worker.triage" route — the one call site
   *  Radar's manual sweep and a scheduled run share, so a test comparing the
   *  two triggers has to reach it through this fake rather than a hand-rolled
   *  one that records nothing (default: none, which triages an empty batch). */
  triageVerdicts?: {
    discoveredPostId: number;
    verdict: "match" | "reject";
    score?: number;
    reason?: string;
    angle?: string;
    roomLikely?: unknown;
  }[];
  /** The verdicts returned by the "judge.lead_screen" route, or a function of
   *  the call's user prompt (the frozen signals it renders) that gives them
   *  (default: none, which screens nobody). */
  leadScreen?: Record<string, unknown>[] | ((user: string) => Record<string, unknown>[]);
  /** The user prompts every "judge.lead_screen" call was asked in. */
  readonly leadScreenPrompts: string[] = [];
  /** The verdict returned by the "judge.lead_qualify" route, or a function of
   *  the call's user prompt (the one person it renders) that gives it
   *  (default: none, which judges nobody). */
  leadQualify?: Record<string, unknown> | ((user: string) => Record<string, unknown> | Promise<Record<string, unknown>>);
  /** The user prompts every "judge.lead_qualify" call was asked in. */
  readonly leadQualifyPrompts: string[] = [];
  /** The plan returned by the "leads.map_plan" route, seeding or tuning, or a
   *  function of the call's user prompt, whose first line says which, or an
   *  Error the call throws (default: change nothing). */
  mapPlan?: Record<string, unknown> | ((user: string) => Record<string, unknown>) | Error;
  /** The user prompts every "leads.map_plan" call was asked in. */
  readonly mapPlanPrompts: string[] = [];
  /** The verdict returned by the "verify.verdict" route — the verify
   *  stage's one model call (default: fits, nothing already said). */
  verifyVerdict?: {
    authorFit: "fits" | "maybe" | "not";
    contentFault?: "off_topic" | "engagement_bait" | "no_contribution_possible";
    reason: string;
    alreadySaid?: string[];
    genericComments?: number[];
    judgments?: Array<{ personRef: string; evidenceRefs: string[]; fit: "fits" | "maybe" | "not"; painId?: string; reason: string }>;
    insights?: { pains: Array<{ text: string; comments: string[] }>; objections: Array<{ text: string; comments: string[] }>; openQuestions: Array<{ text: string; comments: string[] }> };
  };
  roomPageVerdict?: Pick<NonNullable<FakeLLM["verifyVerdict"]>, "judgments" | "insights"> | Error;
  /**
   * The script an agent step's iterations answer from ("agent.step"): one
   * entry per call, oldest first — a result, or an Error the call throws.
   * Once it runs out every call answers `achieved` with nothing proposed.
   * `input_version` is copied from the prompt when an entry leaves it out, so
   * a script states only what it is about.
   */
  agentStepResults: Array<Record<string, unknown> | Error> = [];
  /** The prompts every "agent.step" call was asked in. */
  readonly agentStepPrompts: { system: string; user: string }[] = [];
  /**
   * The agent reader's answers ("reader.page"): one entry per call, oldest
   * first — an answer, returned as given and so free to be malformed, or an
   * Error the call throws. Once it runs out every call throws: a reader a
   * test did not script reads nothing.
   */
  readerAnswers: Array<unknown> = [];
  /** The prompts every "reader.page" call was asked in. */
  readonly readerPrompts: { system: string; user: string }[] = [];
  /** Suggestion returned by the onboarding "engagement campaign" setup route. */
  campaignSuggest?: { campaignName: string; audience: string; keywords: string[]; hashtags: string[] };
  /** The first campaign's draft from the owner's line ("campaigns.draft_from_line"),
   *  returned as given and so free to be malformed, or an Error the call throws
   *  (default: a valid draft). */
  campaignDraft?: unknown;
  /** The user prompts every "campaigns.draft_from_line" call was asked in. */
  readonly campaignDraftPrompts: string[] = [];
  /** Rule returned by the "learn.guidance" (distillRuleFromEdit) route. */
  editRule?: { rule: string; kind: "register" | "strategy" };
  /** Voice-card extras returned by the import_voice "voice tags" route. */
  voiceCardOut?: { tags: string[]; sample: string };
  /** Indices returned by the "FACT SELECTION" (fact rerank) route (default: none, which
   *  makes the reranker fall back to the incoming top-k order). */
  factPicks?: number[];
  /** Hashtags returned by the "propose up to 5 LinkedIn hashtags" (suggestHashtags) route. */
  hashtagsOut?: string[];

  /** The user turn of the LAST text() call — lets a test assert what reached the
   *  writer's user turn (e.g. the STYLE DIRECTIVE block, after the cache breakpoint). */
  lastTextUser?: string;
  /** The system prompt of the LAST text() call — for asserting framing/arc rules. */
  lastTextSystem?: string;

  /**
   * Every call this fake served, oldest first. The fake stands in FOR the agent
   * CLI — no adapter is resolved and no process is spawned — so this log is
   * where a test sees WHICH model a lane asked for, and under whose usage
   * scope. `scope` is the whole `currentUsageContext()` object rather than
   * a few copied fields, so context the entry boundaries learn to carry later
   * reaches assertions without editing this fake or every suite that constructs
   * it. Named `callLog` because subclasses in the suite already declare `calls`
   * as their own numeric counter, and a subclass field initializer runs after
   * this one — it would replace the array with a number.
   *
   * `searchText` is in the op union for the day a fake grows the capability, but
   * nothing pushes it: this class deliberately implements none, which is the
   * fallback contract several suites pin. A test that gives an instance or a
   * subclass its own `searchText` bypasses this log entirely.
   */
  readonly callLog: {
    op: "text" | "json" | "searchText";
    model: string;
    promptRef?: string;
    stage?: string;
    scope: UsageContext | undefined;
  }[] = [];

  private record(
    op: "text" | "json",
    opts: Pick<TextOpts, "model" | "promptRef" | "stage">,
  ): void {
    this.callLog.push({
      op,
      model: opts.model,
      promptRef: opts.promptRef,
      stage: opts.stage,
      scope: currentUsageContext(),
    });
  }

  // --- shared branch bodies (reused by both the promptRef switch and the legacy
  // --- system-substring fallback so the two routes can never drift apart) ---

  private compileBriefOut(): string {
    return (
      this.compileBrief ??
      "This campaign engages people building reliable software; the writer is credible on pragmatic system design and what teams actually measure."
    );
  }
  private filterOut(): unknown {
    return {
      go: true,
      reason: "matches campaign topic",
      matches_topic: true,
      sentiment_ok: true,
      promo_safe: true,
      confidence: 3,
      ...this.filter,
    };
  }
  /** The dispatcher's calls, answered so every draft passes: a plan that
   *  quotes the first line of the words it answers, words written to it — in
   *  the same answer where the owner's ask composes them — and a judge that
   *  finds them supported. A test that needs another verdict answers them
   *  itself (`test/dispatcherLlm.ts`). */
  private dispatcherOut(promptId: string, user: string): unknown {
    const blocks = (marker: RegExp) => user.split(marker).slice(1);
    const text = user.includes("Words by") ? this.invitationNote : user.includes("Their message by") ? this.directMessage : this.textReply;
    switch (promptId) {
      case "dispatcher.compile":
        return { effects: [], unmapped: [] };
      case "dispatcher.compose":
        return { drafts: (this.dispatcherOut("dispatcher.plan", user) as { plans: object[] }).plans.map((plan) => ({ ...plan, text })) };
      case "dispatcher.plan":
        return {
          plans: blocks(/^- id: /m).map((block) => ({
            discoveredPostId: Number(block.split("\n")[0]),
            point: { buildOn: "their words", quotes: [{ source: "post", text: /^(?:Post|Comment|Words|Their reply|Their message) by [^\n]*:\n([^\n]+)/m.exec(block)?.[1]?.slice(0, 120) ?? "" }], why: "their words" },
            move: { value: "question", why: "the author invites a question" },
            name: "Their words",
            story: { id: null, why: "no story fits" },
            question: { ask: true, why: "something real to ask" },
            length: { minWords: 5, maxWords: 35 },
            style: { opening: "react_detail", shape: "two_beat", stance: "ask" },
            marks: [],
            habits: [],
            examples: [],
          })),
        };
      case "dispatcher.write":
        return {
          drafts: [...user.matchAll(/^id: (\d+)$/gm)].map((match) => ({ discoveredPostId: Number(match[1]), text })),
        };
      default:
        return {
          verdicts: blocks(/^- id: /m).map((block) => ({
            discoveredPostId: Number(block.split("\n")[0]),
            verdict: "supported",
            claims: [{ claim: "asks what takes the most time", support: "question" }],
            items: (/^ {2}judge: (.+)$/m.exec(block)?.[1]?.split(", ") ?? []).map((item) => ({ item, pass: true, detail: "As planned" })),
          })),
        };
    }
  }
  private readingOut(user: string): unknown {
    return {
      evidence: [],
      relevance: "relevant",
      stance: "neutral",
      opt_out: false,
      busy: false,
      question: false,
      interest: false,
      greeting: user.includes("BEGIN DIRECT MESSAGE"),
      uncertain: false,
      lead_evidence: "",
      lead_intent: "none",
      hold: false,
      category: "ok",
      ...(typeof this.reading === "function" ? this.reading(user) : this.reading),
    };
  }
  private brainCoverageOut(): unknown {
    return {
      slots:
        this.brainCoverage ??
        BRAIN_SLOTS.map((sl) => ({ slot: sl.id, confidence: 0.5, missing: "x" })),
    };
  }
  private brainQuestionsOut(): unknown {
    return {
      questions: [
        { slot: "identity", question: "Q1?" },
        { slot: "expertise", question: "Q2?" },
      ],
    };
  }
  private brainSeedOut(): unknown {
    return { items: [{ slot: "identity", content: "I am X" }] };
  }
  private productFactsOut(): unknown {
    return { facts: this.productFacts ?? [{ facet: "what", content: "A test product." }] };
  }
  private enrichTermsOut(): unknown {
    return this.enrichTerms ?? { keywords: [], hashtags: [] };
  }
  private searchPlanOut(user: string): unknown {
    this.searchPlanPrompts.push(user);
    if (this.searchPlan instanceof Error) throw this.searchPlan;
    return this.searchPlan ?? { working: "Nothing to change yet.", keep: [], retire: [], add: [] };
  }
  private triageOut(): unknown {
    return { verdicts: this.triageVerdicts ?? [] };
  }
  private verifyOut(): unknown {
    return this.verifyVerdict ?? { authorFit: "fits", reason: "Fits the campaign's audience." };
  }
  private hashtagsOutObj(): unknown {
    return { hashtags: this.hashtagsOut ?? ["longevity", "biohacking"] };
  }
  private campaignSuggestOut() {
    return (
      this.campaignSuggest ?? {
        campaignName: "Test campaign",
        audience: "SaaS founders shipping product",
        keywords: ["saas onboarding", "activation"],
        hashtags: ["saas"],
      }
    );
  }
  private campaignDraftOut<T>(opts: JsonOpts<T>): unknown {
    this.campaignDraftPrompts.push(opts.user);
    if (this.campaignDraft instanceof Error) throw this.campaignDraft;
    // Like the agent-CLI client, an answer the schema refuses is the model's
    // fault and surfaces as the output error, not as a schema error.
    const answer = opts.schema.safeParse(
      this.campaignDraft ?? {
        name: "Founders building with AI",
        audience: "Founders shipping products with AI coding agents.",
        topics: ["Shipping with AI agents", "First customers"],
        searches: ["solo founder first customers", "building with AI coding agents"],
      },
    );
    if (!answer.success) throw new LLMOutputError("invalid_agent_output");
    return answer.data;
  }
  private factPicksOut(): unknown {
    return { picks: this.factPicks ?? [] };
  }
  private voiceCardObj(): unknown {
    return (
      this.voiceCardOut ?? {
        tags: ["direct", "lowercase", "no fluff"],
        sample: "this is the part most teams skip — and exactly why it works.",
      }
    );
  }
  private productsFromTextOut(): unknown {
    return { products: this.productsFromText ?? [] };
  }
  private factDecisionsOut(): unknown {
    return { decisions: this.factDecisions ?? [] };
  }
  private editRuleOut(): unknown {
    return this.editRule ?? { rule: "", kind: "strategy" }; // empty rule = trivial edit
  }
  private voiceProfileOut(): unknown {
    return (
      this.voiceProfile ?? {
        persona_description: "Writes plainly and directly, lowercase, no fluff.",
        style_bullets: ["starts lines lowercase", "no marketing fluff"],
      }
    );
  }
  private structuralRangeOut(): unknown {
    return (
      this.structuralRange ?? {
        opening: [{ id: "lead_self", weight: 4 }],
        shape: [{ id: "mini_story", weight: 3 }],
        stance: [{ id: "agree_extend", weight: 2 }],
      }
    );
  }

  private agentStepOut(system: string, user: string): unknown {
    this.agentStepPrompts.push({ system, user });
    const next = this.agentStepResults.shift();
    if (next instanceof Error) throw next;
    const version = /input_version`: copy exactly: ([0-9a-f]{64})/.exec(system)?.[1] ?? "";
    return {
      status: "achieved",
      rationale_summary: "Nothing more to do here.",
      input_version: version,
      memory_version: null,
      evidence_refs: [],
      proposed_tool_calls: [],
      memory_patches: [],
      wait: null,
      ...next,
    };
  }

  private readerOut(system: string, user: string): unknown {
    this.readerPrompts.push({ system, user });
    if (this.readerAnswers.length === 0) {
      throw new Error("FakeLLM: no scripted agent reader answer");
    }
    const next = this.readerAnswers.shift();
    if (next instanceof Error) throw next;
    return next;
  }

  async text(opts: TextOpts): Promise<string> {
    this.record("text", opts);
    this.lastTextUser = opts.user;
    this.lastTextSystem = opts.system;
    // PRIMARY route: the stable call-site id (promptRef, sans "@version").
    if (opts.promptRef) {
      switch (promptIdOf(opts.promptRef)) {
        case "brain.compile":
          return this.compileBriefOut();
        case "writer.comment":
        case "learn.distill":
        case "learn.guidance":
          return this.textReply;
      }
    }
    // Legacy fallback: system-prompt substring routing (P5 deletes this).
    // The compiler emits prose via text(); route it so a test can assert the brief.
    if ((opts.system ?? "").includes("CAMPAIGN FOCUS BRIEF")) {
      return this.compileBriefOut();
    }
    return this.textReply;
  }
  async json<T>(opts: JsonOpts<T>): Promise<T> {
    this.record("json", opts);
    // PRIMARY route: the stable call-site id (promptRef, sans "@version").
    if (opts.promptRef) {
      switch (promptIdOf(opts.promptRef)) {
        case "judge.filter":
          return this.filterOut() as T;
        case "dispatcher.compile":
        case "dispatcher.compose":
        case "dispatcher.plan":
        case "dispatcher.write":
        case "dispatcher.judge":
          return opts.schema.parse(this.dispatcherOut(promptIdOf(opts.promptRef), opts.user)) as T;
        case "judge.incoming_reading":
          return this.readingOut(opts.user) as T;
        case "brain.assess":
          return this.brainCoverageOut() as T;
        case "brain.questions":
          return this.brainQuestionsOut() as T;
        case "brain.seed":
          return this.brainSeedOut() as T;
        case "brain.rerank":
          return this.factPicksOut() as T;
        // NOTE: the legacy substring for this route ("extract product facts") rotted —
        // the live prompt says "You extract a product's identity and facts" — so the
        // URL-ingest route is ONLY reachable via this id.
        case "products.ingest_url":
          return this.productFactsOut() as T;
        case "products.detect":
          return this.productsFromTextOut() as T;
        case "products.reconcile":
          return this.factDecisionsOut() as T;
        case "discovery.enrich":
          return this.enrichTermsOut() as T;
        case "discovery.plan":
          return this.searchPlanOut(opts.user) as T;
        case "discovery.lookalike":
          this.lookalikePrompts.push(opts.user);
          if (this.lookalikeResult instanceof Error) throw this.lookalikeResult;
          return (this.lookalikeResult ?? { judgments: [], proposals: [] }) as T;
        case "audience.themes":
          this.audienceThemePrompts.push(opts.user);
          if (this.audienceThemes instanceof Error) throw this.audienceThemes;
          return (this.audienceThemes ?? { themes: [] }) as T;
        case "worker.triage":
          return this.triageOut() as T;
        case "judge.lead_screen":
          this.leadScreenPrompts.push(opts.user);
          return { verdicts: typeof this.leadScreen === "function" ? this.leadScreen(opts.user) : (this.leadScreen ?? []) } as T;
        case "leads.map_plan": {
          this.mapPlanPrompts.push(opts.user);
          if (this.mapPlan instanceof Error) throw this.mapPlan;
          return (typeof this.mapPlan === "function" ? this.mapPlan(opts.user) : (this.mapPlan ?? {})) as T;
        }
        case "judge.lead_qualify": {
          this.leadQualifyPrompts.push(opts.user);
          const verdicts = await Promise.all(opts.user.split("\n\n--- NEXT PERSON ---\n\n").map((person) =>
            typeof this.leadQualify === "function" ? this.leadQualify(person) : (this.leadQualify ?? {}),
          ));
          return { verdicts } as T;
        }
        case "verify.verdict":
          return this.verifyOut() as T;
        case "verify.room_page":
          if (this.roomPageVerdict instanceof Error) throw this.roomPageVerdict;
          return (this.roomPageVerdict ?? { judgments: [] }) as T;
        case "campaigns.hashtags":
          return this.hashtagsOutObj() as T;
        case "campaigns.suggest":
          return this.campaignSuggestOut() as T;
        case "campaigns.scout_sources":
          return { ...this.campaignSuggestOut(), rationale: "Search for the audience's stated problem." } as T;
        case "campaigns.draft_from_line":
          return this.campaignDraftOut(opts) as T;
        case "learn.guidance":
          return this.editRuleOut() as T;
        case "learn.voice_card":
          return this.voiceCardObj() as T;
        case "learn.voice":
        case "learn.voice_post":
          return this.voiceProfileOut() as T;
        case "learn.structure":
          return this.structuralRangeOut() as T;
        case "agent.step":
          return this.agentStepOut(opts.system ?? "", opts.user) as T;
        case "reader.page":
          return this.readerOut(opts.system ?? "", opts.user) as T;
      }
    }
    // Legacy fallback: system-prompt substring routing (P5 deletes this).
    const s = opts.system ?? "";
    let obj: unknown;
    if (s.includes("relevance gate")) {
      obj = this.filterOut();
    } else if (s.includes("You read one") || s.includes("You read the note")) {
      obj = this.readingOut(opts.user);
    } else if (s.includes("brain coverage")) {
      obj = this.brainCoverageOut();
    } else if (s.includes("brain questions")) {
      obj = this.brainQuestionsOut();
    } else if (s.includes("brain seed")) {
      obj = this.brainSeedOut();
    } else if (s.includes("extract product facts")) {
      obj = this.productFactsOut();
    } else if (s.includes("ADJACENT SEARCH TERMS")) {
      obj = this.enrichTermsOut();
    } else if (s.includes("propose up to 5 LinkedIn hashtags")) {
      obj = this.hashtagsOutObj();
    } else if (s.includes("engagement campaign for the user")) {
      obj = this.campaignSuggestOut();
    } else if (s.includes("FACT SELECTION")) {
      obj = this.factPicksOut();
    } else if (s.includes("voice tags")) {
      obj = this.voiceCardObj();
    } else if (s.includes("identify products")) {
      obj = this.productsFromTextOut();
    } else if (s.includes("reconcile product facts")) {
      obj = this.factDecisionsOut();
    } else if (s.includes("VOICE PROFILE")) {
      obj = this.voiceProfileOut();
    } else if (s.includes("RANGE OF STRUCTURES")) {
      obj = this.structuralRangeOut();
    } else {
      throw new Error("FakeLLM: unmatched json call");
    }
    return obj as T;
  }
}
