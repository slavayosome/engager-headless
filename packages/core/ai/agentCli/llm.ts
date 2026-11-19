import { LOCAL_AGENT_MODELS } from "@engager/common/local-agent-support";
import { zodToJsonSchema } from "zod-to-json-schema";
import { currentUsageContext, recordUsage } from "../usage";
import type {
  JsonOpts,
  LLM,
  SearchedTextResult,
  TextOpts,
  WebSearchOpts,
} from "../client";
import { GroundingEvidenceRequiredError, LLMOutputError } from "../errors";
import { agentPurposeOf, trackAgentCallFailed } from "../../telemetry/emit";
import { storedCatalog } from "./catalog";
import { runAgentCli } from "./run";
import { admittedModel, storedAgentSelection } from "./selection";
import {
  AgentCliError,
  type AgentCliAdapter,
  type AgentCliResult,
} from "./types";

/** The dispatcher's short structured steps, each answering in a few lines of
 *  JSON. At the agent's default effort most of their time is thinking, so they
 *  ask for its lowest level wherever the owner set none for the model. */
const DRAFT_STAGES: ReadonlySet<string> = new Set(["dispatcher_compile", "dispatcher_compose", "dispatcher_plan", "dispatcher_write", "dispatcher_judge"]);

/** Local usage is observability, never an Engager subscription dollar budget. */
export class AgentCliLLM implements LLM {
  constructor(
    private readonly adapter: AgentCliAdapter,
    private readonly run = runAgentCli,
  ) {}

  /**
   * Whether this call may name this model — asked of the ONE resolver, with
   * the installation evidence the selection carries.
   *
   * This used to refuse everything outside the support matrix, which made the
   * published vocabulary the sole admission rule: a model the installed agent
   * actually reports could be chosen on the Agent page and then refused at the
   * first call, with the matrix's own list as the explanation. What the matrix
   * still owns is the PRICE table and the published list; whether an id
   * travels this route is `resolveModelRoute`'s answer, and the catalog read
   * for this exact executable is the evidence that admits a new one.
   */
  private async assertAdmittedModel(model: string): Promise<void> {
    const selection =
      currentUsageContext()?.localAgentSelection ??
      storedAgentSelection("background");
    const catalog = selection
      ? await storedCatalog(selection, this.adapter.descriptor)
      : undefined;
    if (admittedModel(this.adapter, model, selection, catalog)) return;
    throw new AgentCliError(
      `${this.adapter.name} cannot be asked for model "${model}" — choose a model the installed ${this.adapter.name} reports, or one of: ${(
        LOCAL_AGENT_MODELS[this.adapter.id] ?? []
      ).join(", ")}`,
    );
  }

  private record(
    operation: "text" | "json",
    opts: TextOpts | JsonOpts<unknown>,
    result: AgentCliResult | undefined,
    startedAt: number,
    ok: boolean,
    errorKind?: string,
  ): void {
    recordUsage({
      provider:
        this.adapter.descriptor.supportedModelRoutes.find((route) =>
          route.models.includes(opts.model.replace(/-\d{8}$/, "")),
        )?.providerRef ?? this.adapter.provider,
      agentId: this.adapter.id,
      localAgentReport: {
        requestedModel: opts.model,
        actualReportedModel: result?.actualReportedModel ?? null,
        usage: result && Object.keys(result.usage).length ? result.usage : null,
      },
      model: result?.actualReportedModel ?? opts.model,
      operation,
      stage: opts.stage ?? null,
      promptRef: opts.promptRef ?? null,
      ...(result?.usage ?? {}),
      latencyMs: Date.now() - startedAt,
      ok,
      ...(!ok ? { errorKind: errorKind ?? "agent_cli" } : {}),
    });
    // Usage data: only the failures; the successes ride inside the run events.
    if (!ok) {
      trackAgentCallFailed({
        adapter: this.adapter.id,
        purpose: agentPurposeOf(`${opts.promptRef ?? ""} ${opts.stage ?? ""}`),
        code: errorKind ?? "agent_cli",
      });
    }
  }

  async text(opts: TextOpts): Promise<string> {
    await this.assertAdmittedModel(opts.model);
    const startedAt = Date.now();
    try {
      const result = await this.run(
        this.adapter,
        { model: opts.model, system: opts.system, user: opts.user },
        { signal: opts.signal },
      );
      this.record("text", opts, result, startedAt, true);
      return result.text.trim();
    } catch (error) {
      this.record(
        "text",
        opts,
        undefined,
        startedAt,
        false,
        error instanceof AgentCliError ? error.cause?.code : "agent_cli",
      );
      throw error;
    }
  }

  async json<T>(opts: JsonOpts<T>): Promise<T> {
    await this.assertAdmittedModel(opts.model);
    const jsonSchema = zodToJsonSchema(opts.schema, {
      $refStrategy: "none",
      target: "jsonSchema7",
    }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    let selection =
      currentUsageContext()?.localAgentSelection ??
      storedAgentSelection("background");
    const signal = AbortSignal.any([
      ...(opts.signal ? [opts.signal] : []),
      AbortSignal.timeout(180_000),
    ]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const startedAt = Date.now();
      let result: AgentCliResult | undefined;
      try {
        result = await this.run(
          this.adapter,
          {
            model: opts.model,
            system: opts.system,
            user:
              opts.user +
              (attempt
                ? "\nReturn only a value satisfying every supplied schema constraint. The previous attempt was invalid."
                : ""),
            jsonSchema,
            frozenSelection: selection ?? undefined,
            ...(opts.stage && DRAFT_STAGES.has(opts.stage) ? { stageEffort: "low" } : {}),
          },
          {
            signal,
            onSelection: (frozen) => {
              selection ??= frozen;
            },
          },
        );
        const parsed = opts.schema.safeParse(result.structured);
        if (result.structured === undefined || !parsed.success)
          throw new LLMOutputError("invalid_agent_output");
        this.record("json", opts, result, startedAt, true);
        return parsed.data;
      } catch (error) {
        this.record(
          "json",
          opts,
          result,
          startedAt,
          false,
          error instanceof LLMOutputError
            ? "invalid_agent_output"
            : error instanceof AgentCliError
              ? error.cause?.code
              : "agent_cli",
        );
        const invalid =
          error instanceof LLMOutputError ||
          (error instanceof AgentCliError &&
            error.message === "invalid_agent_output");
        if (!invalid) throw error;
        if (attempt === 1) throw new LLMOutputError("invalid_agent_output");
      }
    }
    throw new LLMOutputError("invalid_agent_output");
  }

  async searchText(
    opts: TextOpts & { webSearch?: WebSearchOpts },
  ): Promise<SearchedTextResult> {
    await this.assertAdmittedModel(opts.model);
    throw new GroundingEvidenceRequiredError();
  }
}
