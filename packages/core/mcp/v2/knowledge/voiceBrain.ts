import { z } from "zod";
import { createHash } from "node:crypto";
import { LEARNED_DIRECTIVE_KINDS, LEARNED_MOVE_KINDS, type LearnedEditKind } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { deriveBrainCoverage } from "../../../brain/coverage";
import { listKnowledge, saveNote } from "../../../brain/knowledge";
import { nextPending } from "../../../brain/questions";
import { answerQuestion } from "../../../brain/answer";
import { allowRemembering, editMemory, inspectMemory, listMemory, previewForget } from "../../../memory/records";
import { listVoices, getVoice, createVoice, updateVoice, setVoiceChannel, setDefaultVoice, addVoiceExample, removeVoiceExample, pinVoiceExample, removeVoiceRule, setStartingRuleLine, settleProposedDescription, setLearnedDirective } from "../../../operations/voices";
import { voiceExamples } from "../../../voice/examples";
import { eligibleVoiceSamples } from "../../../learning/recalibrate";
import { listVoiceQuestions, answerVoiceQuestion, reopenVoiceQuestions } from "../../../voice/questions";
import { StyleRulesSchema, VoiceTraitsSchema } from "../../../ai/styleRules";
import { getProfile, resolveVoice, setChannelVoice } from "../../../profile";
import { ensureDefaultVoice, readOwnerWriting } from "../../../voice";
import { deriveVoiceRules } from "../../../dispatcher/voiceRules";
import { brainWritingPreferences } from "../../../strategy/writingInstructions";
import { runVoiceRelearn } from "../../../learning/relearnVoice";
import { llmWithSignal } from "../../../ai/client";
import { runPhasesInSession } from "../../../tasks/executor";
import { modeFor, resolveJudgmentPolicy } from "../../../tasks/policy";
import { assertHostedMcpExternalPhase, withHostedMcpScope } from "../../tools/hostedSpend";
import { requestBrainSeed } from "../../../brain/seedRequest";
import { refreshBrainPhased } from "../../../brain/refresh";
import { untrusted } from "../../../ai/prompts";
import { mcpOperationActor } from "../../context";
import { errorResult, jsonResult } from "../../tools/util";
import { defineTool, type V2Tool } from "../define";
import { parseRef } from "../refs";

const slot = z.enum(["identity", "expertise", "positions", "stories", "audience", "goals", "avoid"]);
const positive = z.number().int().positive();
const exampleId = (text: string) => createHash("sha256").update(text).digest("hex");

const knowledgeText = new Set(["title", "content", "value", "question", "answer", "why", "headline", "company", "note"]);
function fenceKnowledge(value: unknown, key = ""): unknown {
  if (typeof value === "string") return knowledgeText.has(key) ? untrusted(key.toUpperCase(), value) : value;
  if (Array.isArray(value)) return value.map((item) => fenceKnowledge(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, fenceKnowledge(item, field)]));
  return value;
}

export const voiceBrainTools: readonly V2Tool[] = [
  defineTool({
    name: "list_voices", kind: "read",
    description: "Read saved voices and optional samples, questions, rules and profile. See engager-voice-and-brain.",
    input: z.object({ id: positive.optional(), include: z.array(z.enum(["samples", "questions", "rules", "profile"])).optional() }).strict(),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      const voices = input.id ? [await getVoice(tx, input.id)].filter((v): v is NonNullable<typeof v> => v !== null) : await listVoices(tx);
      if (input.id && voices.length === 0) return errorResult(`voice ${input.id} not found`, { code: "not_found", status: 404 });
      const rows = [];
      for (const voice of voices) {
        const writing = input.include?.includes("rules") ? await readOwnerWriting(tx, voice) : null;
        rows.push({ ...voice, examples: voiceExamples(voice.styleRules).map(item => ({ ...item, id: exampleId(item.text) })),
          ...(input.include?.includes("samples") ? { samples: await eligibleVoiceSamples(tx, voice) } : {}),
          ...(input.include?.includes("questions") ? { questions: await listVoiceQuestions(tx, { voiceId: voice.id }) } : {}),
          ...(writing ? { rules: deriveVoiceRules({ voice, measured: writing.measured, brainPreferences: await brainWritingPreferences(tx) }) } : {}) });
      }
      return jsonResult({ voices: rows, ...(input.include?.includes("profile") ? { profile: resolveVoice(await getProfile(tx), "comment") } : {}) });
    }),
  }),
  defineTool({
    name: "save_voice", kind: "write",
    description: "Create or update a voice, examples, rules or answers. Proposals write nothing. See engager-voice-and-brain.",
    input: z.object({ id: positive.optional(), name: z.string().min(1).optional(), persona: z.string().optional(), houseStyle: z.string().optional(), styleRules: StyleRulesSchema.omit({ sampleAnswers: true }).partial().optional(), traits: VoiceTraitsSchema.optional(), default: z.boolean().optional(), channel: z.enum(["comment", "post"]).optional(), example: z.object({ op: z.enum(["add", "remove", "pin"]), text: z.string().optional(), id: z.string().optional() }).strict().optional(), rule: z.object({ op: z.enum(["remove", "starting_line"]), key: z.string(), text: z.string().optional() }).strict().optional(), proposedDescription: z.enum(["keep", "drop"]).optional(), learnedEdit: z.record(z.string(), z.boolean()).optional(), answer: z.object({ key: z.string(), text: z.string() }).strict().optional(), reopenQuestions: z.boolean().optional(), propose: z.boolean().optional() }).strict(),
    handler: async ({ ctx }, input) => {
      if (input.propose) return jsonResult({ proposed: true, persona: input.persona ?? null, houseStyle: input.houseStyle ?? null });
      if (Object.keys(input.learnedEdit ?? {}).some(key => !([...LEARNED_DIRECTIVE_KINDS, ...LEARNED_MOVE_KINDS] as string[]).includes(key))) return errorResult("Unknown learned edit.", { code: "invalid_input" });
      if (input.rule?.op === "starting_line" && !["on", "off"].includes(input.rule.key)) return errorResult("Set the starting line key to on or off.", { code: "invalid_input" });
      return withOrg(ctx.organizationId, async tx => {
        const voice = input.id ? await getVoice(tx, input.id) : input.name ? await createVoice(tx, { name: input.name }) : await ensureDefaultVoice(tx);
        if (!voice) return errorResult("Voice not found.", { code: "not_found", status: 404 });
        if (input.name || input.styleRules || input.traits) await updateVoice(tx, voice.id, { name: input.name, styleRules: { ...input.styleRules, ...(input.traits ? { traits: input.traits } : {}) } });
        const channel = input.channel ?? "comment";
        if (input.default) await setDefaultVoice(tx, voice.id);
        if (input.persona !== undefined || input.houseStyle !== undefined) {
          const words = { persona: input.persona, houseStyle: input.houseStyle, sources: ["manual"] };
          if (input.default || voice.isDefault) await setChannelVoice(tx, channel, words);
          else await setVoiceChannel(tx, voice.id, channel, words);
        }
        if (input.proposedDescription) await settleProposedDescription(tx, voice.id, channel, input.proposedDescription === "keep");
        for (const [key, on] of Object.entries(input.learnedEdit ?? {})) await setLearnedDirective(tx, voice.id, key as LearnedEditKind, on);
        if (input.example) {
          const text = input.example.text ?? voiceExamples((await getVoice(tx, voice.id))?.styleRules).find(item => exampleId(item.text) === input.example?.id)?.text;
          if (!text) throw new Error("Example not found.");
          if (input.example.op === "add") await addVoiceExample(tx, voice.id, text);
          else if (input.example.op === "remove") await removeVoiceExample(tx, voice.id, text);
          else await pinVoiceExample(tx, voice.id, text, "comment", true);
        }
        if (input.rule?.op === "remove") await removeVoiceRule(tx, voice.id, input.rule.text ?? input.rule.key);
        if (input.rule?.op === "starting_line") await setStartingRuleLine(tx, voice.id, input.rule.key === "on");
        if (input.answer) {
          const answer = await answerVoiceQuestion(tx, { voiceId: voice.id, key: input.answer.key, answer: input.answer.text, via: "agent" });
          if (!answer.ok) throw new Error(answer.detail);
        }
        if (input.reopenQuestions) await reopenVoiceQuestions(tx, { voiceId: voice.id });
        return jsonResult({ voice: await getVoice(tx, voice.id) });
      });
    },
  }),
  defineTool({
    name: "delete_voice", kind: "destructive",
    description: "Delete a voice only after the owner confirms in Engager. See engager-voice-and-brain.",
    input: z.object({ id: positive, promoteVoiceId: positive.optional() }).strict(),
    handler: async () => errorResult("Confirm this deletion in Engager.", { code: "needs_owner_confirmation", status: 409 }),
  }),
  defineTool({
    name: "learn_voice", kind: "write",
    description: "Relearn a voice from the owner's writing or LinkedIn. See engager-voice-and-brain.",
    input: z.object({ id: positive, from: z.enum(["own_writing", "linkedin"]), target: z.enum(["comment", "post", "both"]).optional() }).strict(),
    handler: async ({ ctx, signal }, input) => {
      const policy = await withOrg(ctx.organizationId, tx => resolveJudgmentPolicy(tx));
      const ownContent = await ctx.grant("own_content");
      const scope = <T>(work: Parameters<typeof withOrg<T>>[1]) => withHostedMcpScope(ctx, signal, "brain:write", work);
      const authorize = () => assertHostedMcpExternalPhase(ctx, signal, "brain:write");
      const run = () => runVoiceRelearn({ ownContent, ...(policy === "configured_background" ? { llm: llmWithSignal(ctx.llm, signal) } : {}) }, {
        orgScope: scope, beforeExternalPhase: authorize, beforeApplyPhase: authorize, voiceId: input.id,
        target: input.target ?? "both", channels: { linkedin: input.from === "linkedin", brain: false }, persist: true,
      });
      return jsonResult(policy === "interactive_external" ? await runPhasesInSession(ctx, run, { signal }) : { mode: modeFor(policy), ...(await run()) });
    },
  }),
  defineTool({
    name: "search_knowledge", kind: "read",
    description: "Read Brain notes, relationship memory, or pending questions. Coverage is derived without a model call. See engager-voice-and-brain.",
    input: z.object({ kind: z.enum(["note", "memory", "question"]), query: z.string().optional(), slot: z.string().optional(), scope: z.string().optional(), ref: z.string().optional(), include: z.array(z.enum(["coverage"])).optional() }).strict(),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      const ref = input.ref ? parseRef(input.ref, ["note", "mem", "person"]) : null;
      const query = input.query?.toLocaleLowerCase();
      let items: unknown;
      if (input.kind === "note") {
        if (ref && ref.kind !== "note") return errorResult("A note ref is required.", { code: "invalid_input" });
        items = (await listKnowledge(tx)).filter(row => (!ref || row.id === ref.id) && (!input.slot || row.slot === input.slot) && (!query || `${row.title ?? ""} ${row.content}`.toLocaleLowerCase().includes(query)));
      } else if (input.kind === "memory") {
        if (ref?.kind === "mem") items = await inspectMemory(tx, ref.id);
        else {
          if (ref && ref.kind !== "person") return errorResult("A memory or person ref is required.", { code: "invalid_input" });
          if (ref?.kind === "person" && ref.person.kind !== "profile") return errorResult("This person has no profile id for memory lookup.", { code: "invalid_input" });
          const personId = ref?.kind === "person" && ref.person.kind === "profile" ? ref.key.slice(2) : undefined;
          items = (await listMemory(tx, { personId })).filter(row => (!input.scope || row.scope === input.scope) && (!input.slot || row.slot === input.slot) && (!query || `${row.key} ${row.value ?? ""}`.toLocaleLowerCase().includes(query)));
        }
      } else items = await nextPending(tx, 50);
      return jsonResult({ items: fenceKnowledge(items), ...(input.include?.includes("coverage") ? { coverage: await deriveBrainCoverage(tx) } : {}) });
    }),
  }),
  defineTool({
    name: "save_knowledge", kind: "write",
    description: "Save an owner-provided Brain note, answer, or memory correction. See engager-voice-and-brain.",
    input: z.object({ ref: z.string().optional(), kind: z.enum(["note", "memory", "answer"]), slot: slot.optional(), title: z.string().max(200).optional(), content: z.string().trim().min(1).max(20000).optional(), questionId: positive.optional(), allowRemembering: z.boolean().optional(), notes: z.array(z.object({ slot, title: z.string().max(200).optional(), content: z.string().trim().min(1).max(20000) }).strict()).min(1).max(50).optional() }).strict(),
    handler: async ({ ctx }, input) => withOrg(ctx.organizationId, async tx => {
      if (input.notes) {
        // Many new notes the owner gave at once, each saved as it would be alone.
        const { notes, kind, ...one } = input;
        if (kind !== "note" || Object.values(one).some((field) => field !== undefined)) return errorResult("notes are new Brain notes, given alone with kind note.", { code: "invalid_input" });
        const saved = [];
        for (const note of notes) saved.push(await saveNote(tx, { slot: note.slot, title: note.title, content: note.content }));
        return jsonResult({ saved: saved.length, notes: saved });
      }
      const ref = input.ref ? parseRef(input.ref, ["note", "mem"]) : null;
      if (input.kind === "note") {
        if (ref && ref.kind !== "note") return errorResult("A note ref is required.", { code: "invalid_input" });
        if (!ref && (!input.slot || !input.content)) return errorResult("A new note needs slot and content.", { code: "invalid_input" });
        return jsonResult(await saveNote(tx, { id: ref?.id, slot: input.slot, title: input.title, content: input.content }));
      }
      if (input.kind === "answer") {
        if (!input.questionId || !input.content) return errorResult("An answer needs questionId and content.", { code: "invalid_input" });
        return jsonResult(await answerQuestion(tx, { questionId: input.questionId, answer: input.content, deferAssessment: true }));
      }
      if (!ref || ref.kind !== "mem") return errorResult("A memory ref is required.", { code: "invalid_input" });
      if (input.allowRemembering) return jsonResult(await allowRemembering(tx, { memoryId: ref.id }));
      if (!input.content) return errorResult("A memory correction needs content.", { code: "invalid_input" });
      return jsonResult(await editMemory(tx, { memoryId: ref.id, value: input.content, by: mcpOperationActor(ctx) }));
    }),
  }),
  defineTool({
    name: "delete_knowledge", kind: "destructive",
    description: "Preview forgetting a memory; deletion requires confirmation in Engager. See engager-voice-and-brain.",
    input: z.object({ ref: z.string(), dryRun: z.boolean().optional() }).strict(),
    handler: async ({ ctx }, { ref: raw, dryRun }) => {
      const ref = parseRef(raw, ["note", "mem"]);
      if (dryRun) return withOrg(ctx.organizationId, async tx => {
        if (ref.kind === "mem") return jsonResult(await previewForget(tx, ref.id));
        if (ref.kind === "note") return jsonResult({ note: (await listKnowledge(tx)).find(row => row.id === ref.id) ?? null });
        throw new Error("unreachable");
      });
      return errorResult("Confirm this deletion in Engager.", { code: "needs_owner_confirmation", status: 409 });
    },
  }),
  defineTool({
    name: "seed_brain", kind: "linkedin",
    description: "Seed the Brain or voice from a source, or refresh Brain questions. See engager-voice-and-brain.",
    input: z.object({ source: z.enum(["linkedin", "url", "text", "questions"]), scope: z.enum(["brain", "voice", "both"]), url: z.string().url().optional(), text: z.string().trim().min(1).max(25000).optional() }).strict(),
    handler: async ({ ctx, signal }, input) => {
      if (input.source === "questions") {
        const scope = <T>(work: Parameters<typeof withOrg<T>>[1]) => withHostedMcpScope(ctx, signal, "brain:write", work);
        const authorize = () => assertHostedMcpExternalPhase(ctx, signal, "brain:write");
        const policy = await withOrg(ctx.organizationId, tx => resolveJudgmentPolicy(tx));
        await refreshBrainPhased(scope, { ...(policy === "configured_background" ? { llm: llmWithSignal(ctx.llm, signal) } : {}), refill: { weakBelow: 1 }, beforeExternalPhase: authorize, beforeApplyPhase: authorize });
        return withOrg(ctx.organizationId, async tx => jsonResult({ questions: await nextPending(tx, 10) }));
      }
      if (input.source === "url" && (!input.url || !input.url.toLowerCase().startsWith("https://"))) return errorResult("An HTTPS URL is required.", { code: "invalid_input" });
      if (input.source === "text" && !input.text) return errorResult("Text is required.", { code: "invalid_input" });
      const source = input.source === "linkedin" ? { kind: "linkedin" as const } : input.source === "url" ? { kind: "url" as const, url: input.url! } : { kind: "text" as const, text: input.text!, attribution: "provided text" };
      const scopes = input.scope === "both" ? ["brain", "voice"] as const : [input.scope];
      const results = [];
      for (const scope of scopes) {
        const result = await requestBrainSeed(ctx, signal, source, scope);
        if (!result.ok) return errorResult(result.message, { code: result.code });
        results.push(result);
      }
      return jsonResult({ results });
    },
  }),
];
