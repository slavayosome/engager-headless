import type { JsonOpts, LLM } from "../ai/client";
import { FakeLLM } from "./fakes";

export const GROUNDED = "Interview moderators can affect answers. Did you notice anyone holding back once they knew someone was search?";
/** A fake model that answers each of the dispatcher's calls (compile, plan,
 *  write, compose, judge) and the older writer beside it; `unsupported` makes
 *  the judge find no evidence for the claim. A composed draft's prompt is
 *  among `writerPrompts`, as the writer's is; the planner's are `planPrompts`. */
export function dispatcherLLM(texts: string[], unsupported = false, styleMiss = false) {
  const asked: string[] = [];
  let writes = 0;
  const judgePrompts: string[] = [];
  const writerPrompts: string[] = [];
  const planPrompts: string[] = [];
  const plansFor = (user: string) =>
    [...user.matchAll(/^- id: (\d+)$/gm)].map((m) => ({
      discoveredPostId: Number(m[1]),
      point: { buildOn: "the post", quotes: [{ source: "post", text: user.includes("Board week") ? "We spend two days" : "a moderator watching every session" },
        ...(user.includes("Interview moderators can affect answers") ? [{ source: "owner_facts", text: "Interview moderators can affect answers" }] : [])], why: "the post's setting" },
      move: { value: "question", why: "the author invites a question" },
      name: "Board report time",
      story: { id: null, why: "no story fits" },
      question: { ask: true, why: "something real to ask" },
      length: { minWords: 5, maxWords: 35 },
      style: { opening: "react_detail", shape: "two_beat", stance: "ask" },
      marks: [],
      habits: [],
      examples: [],
    }));
  class DraftLLM extends FakeLLM {
    override async json<T>(opts: JsonOpts<T>): Promise<T> {
      asked.push(opts.promptRef ?? "");
      if (opts.promptRef === "dispatcher.compile@1") return opts.schema.parse({ effects: [], unmapped: [] });
      if (opts.promptRef === "dispatcher.plan@5") {
        planPrompts.push(opts.user);
        return opts.schema.parse({ plans: plansFor(opts.user) });
      }
      if (opts.promptRef === "dispatcher.compose@3") {
        writerPrompts.push(opts.user);
        const text = texts[Math.min(writes++, texts.length - 1)]!;
        return opts.schema.parse({ drafts: plansFor(opts.user).map((plan) => ({ ...plan, text })) });
      }
      if (opts.promptRef === "dispatcher.write@5") {
        writerPrompts.push(opts.user);
        const ids = [...opts.user.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
        const text = texts[Math.min(writes++, texts.length - 1)]!;
        return opts.schema.parse({ drafts: ids.map((id) => ({ discoveredPostId: id, text })) });
      }
      if (opts.promptRef === "dispatcher.judge@5") {
        judgePrompts.push(opts.user);
        const blocks = opts.user.split(/^- id: /m).slice(1);
        return opts.schema.parse({
          verdicts: blocks.map((block) => ({
            discoveredPostId: Number(block.split("\n")[0]),
            verdict: unsupported ? "unsupported" : "supported",
            ...(unsupported ? { reason: "No evidence for the claim" } : {}),
            claims: block.includes("Interview moderators can affect answers")
              ? [{ claim: "moderators affect answers", support: "owner_facts", quote: "Interview moderators can affect answers" }]
              : [{ claim: "stitching board reports sounds painful", support: "opinion" },
                  { claim: "asks what takes the most time", support: "question" }],
            items: (/^ {2}judge: (.+)$/m.exec(block)?.[1]?.split(", ") ?? []).map((item) => ({ item, pass: !(styleMiss && item === "register"), detail: styleMiss && item === "register" ? "The register differs from the plan" : "As planned" })),
          })),
        });
      }
      return super.json(opts);
    }
  }
  const llm: LLM = new DraftLLM();
  return { llm, asked, judgePrompts, writerPrompts, planPrompts };
}

/** Hold every call to this prompt until the returned release is called, as a
 *  model still at work while everything else goes on. */
export function holdAnswers(llm: LLM, promptRef: string): () => void {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const json = llm.json.bind(llm);
  llm.json = (async (opts: JsonOpts<unknown>) => {
    if (opts.promptRef === promptRef) await held;
    return json(opts);
  }) as typeof llm.json;
  return release;
}

/** Run `then` just after the model answers this prompt, as the world moves
 *  while a writer is out. */
export function afterAnswering(llm: LLM, promptRef: string, then: () => Promise<void>): void {
  const json = llm.json.bind(llm);
  llm.json = (async (opts: JsonOpts<unknown>) => {
    const out = await json(opts);
    if (opts.promptRef === promptRef) await then();
    return out;
  }) as typeof llm.json;
}
