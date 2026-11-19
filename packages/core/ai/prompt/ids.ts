/**
 * Stable identities for every LLM call site. A `PromptId` names the CALL SITE (not
 * the text): tests route on it (FakeLLM — no more brittle system-prompt substring
 * matching), and observability records it (`ai_usage.prompt_ref`,
 * `prompts.ref`) so spend/behavior can be sliced by prompt version.
 *
 * Versioning: bump a version when the prompt's SEMANTICS change (new/removed
 * instructions, restructured sections) — not for typo-level edits; the content
 * hash in the `prompts` table still catches accidental drift. Every id starts at
 * 1 = "the text as it existed when ids were introduced".
 */

export type PromptId =
  // writers (assembled, multi-source prompts)
  | "writer.comment"
  | "writer.comment_web"
  | "writer.dm_research"
  // judges/gates
  | "judge.filter"
  | "judge.incoming_reading"
  | "judge.lead_screen"
  | "judge.lead_qualify"
  // learning loop
  | "learn.distill"
  | "learn.guidance"
  | "learn.voice"
  | "learn.voice_post"
  | "learn.structure"
  | "learn.voice_card"
  // brain
  | "brain.compile"
  | "brain.seed"
  | "brain.assess"
  | "brain.questions"
  | "brain.rerank"
  // products
  | "products.detect"
  | "products.ingest_url"
  | "products.reconcile"
  // campaigns / discovery
  | "campaigns.suggest"
  | "campaigns.audience_suggest"
  | "campaigns.fill"
  | "audience.themes"
  | "campaigns.scout_sources"
  | "campaigns.draft_from_line"
  | "campaigns.widen_line"
  | "campaigns.hashtags"
  | "discovery.enrich"
  | "discovery.plan"
  | "discovery.lookalike"
  | "leads.map_plan"
  // onboarding first-Radar evidence
  | "onboarding.angle"
  // the Ambassador's person-to-person steps
  | "agent.step"
  // the agent reader: a LinkedIn page read by a model, verified by the server
  | "reader.page"
  // a problem report the owner sent, written up by their agent for the team
  | "report.write_up";

export const PROMPT_VERSIONS: Record<PromptId, number> = {
  "audience.themes": 1,
  "discovery.lookalike": 1,
  "campaigns.scout_sources": 1,
  // @1: the first campaign's name, audience, topics and first searches from
  // the owner's one line, with the product and Brain notes as fenced data
  // (campaigns/draftFromLine.ts).
  "campaigns.draft_from_line": 1,
  "campaigns.widen_line": 1,
  // @4: hardcoded ANTI-SLOP scaffold block (stop-slop, adapted): formula
  // reversals, negative listing, throat-clearing, vague importance, false
  // agency, adverb stuffing. (@3: register/strategy split — ALL register
  // direction moved out of the hardcoded scaffold into the voice-owned
  // StyleRules "YOUR REGISTER" block; the hardcoded OUTPUT RULES shrank to
  // invariants. @2: casing follows the learned voice.)
  // @5: factual grounding outranks the sampled structural directive; an
  // undocumented personal story falls back to an observation.
  // @6: preserve evidence scope/certainty and prohibit unsupported implications,
  // including accusations disguised as a punchline.
  // @7: the evidence line renders where the house style is READ — a habit that
  // calls for an exact figure or a dated scene applies only when the supplied
  // material carries one, so the writer stops inventing the figure the habit
  // demands.
  // @8: distinguish a proposed decision from an unsupported result or personal
  // retrospective, and give the writer a grounded contribution to make.
  // @9: ground the contribution first; retire reply-hook pressure and separate
  // voice/angle from evidence without imposing a diagnosis on the author.
  // @10: commenting preferences own strategy; Scout targeting is background.
  "writer.comment": 11,
  "writer.comment_web": 11,
  // @1: the web research behind a hot lead's DM: one to three short facts about
  // their company or product, from at most two searches (operations/leads.ts).
  "writer.dm_research": 1,
  "judge.filter": 1,
  // @1: the one reading of an incoming comment, reply, message or invitation's
  // note (ai/reading.ts) — stance, opt-out, busy, question, interest, buying
  // intent and the sensitivity hold with its arc, in one call. Replaces the
  // four classifiers that each read the same words (judge.sensitivity @2,
  // judge.lead_intent @3, judge.reply_stance @2, judge.message_intent @2).
  "judge.incoming_reading": 1,
  // @3: a person the audience rules out drops as not_audience, and
  // selling_similar means selling what the owner sells, read from the
  // products attached to the campaign (fenced). (@2: one or two angles, each
  // inside what a first contact to someone known only by their words may do
  // (`leads/scout/opener.ts`). @1: Find leads' screen (leads/scout/screen.ts)
  // — each person's own words, fenced, judged against the audience for a
  // language type and a role or one of five reasons to drop, with up to two
  // angles from the words alone.)
  "judge.lead_screen": 3,
  // @3: two or three ways in, each inside what a first contact may do for the
  // intent the call gives (`leads/scout/opener.ts`). (@2: the owner's ratings
  // of earlier verdicts on the campaign, up to six, fenced, as examples of
  // where Scout judged rightly and wrongly. @1: Find leads' qualify
  // (leads/scout/qualify.ts) — one researched person, their profile and words
  // fenced, judged against the audience for a role, a fit, an intent with the
  // quote that shows it, the reasons and what is not known, and up to three
  // ways in. The server checks the quote against what the person wrote and
  // every cited source against what it handed over.)
  "judge.lead_qualify": 6,
  // @2: strategy reframe — the distilled bullets are the campaign's content/
  // strategy guidance; register/wording rules accrue to the VOICE instead.
  "learn.distill": 2,
  // @2: forced-json + register|strategy classification — register rules route
  // to the campaign's voice (styleRules.extras), strategy to campaign guidance.
  "learn.guidance": 2,
  // @2: extraction also reports the structured `observed` register block
  // (casing / em-dashes / emoji / semicolons / openers / closers / shorthand)
  // that populates the voice's StyleRules — settings and learning stay aligned.
  "learn.voice": 2,
  "learn.voice_post": 2,
  "learn.structure": 1,
  "learn.voice_card": 1,
  "brain.compile": 1,
  "brain.seed": 1,
  "brain.assess": 1,
  "brain.questions": 1,
  "brain.rerank": 1,
  "products.detect": 1,
  "products.ingest_url": 1,
  "products.reconcile": 1,
  "campaigns.suggest": 2,
  "campaigns.audience_suggest": 1,
  // @1: Fill in the rest (campaigns/fill.ts) — values for the fields of an
  // unsaved campaign the owner left alone; the server drops the rest.
  "campaigns.fill": 1,
  "campaigns.hashtags": 1,
  "discovery.enrich": 1,
  // @5: one effective identity rule replaces inactive structured fields in
  // custom mode; learned phrases stay inside the untrusted audience context.
  // @4: the current Audience, fitting room evidence, audience words and
  // magnet authors inform search intent; judgments bind the frozen revision.
  // @3: owner skips and not-relevant signals outweigh triage rejections;
  // distinct people who replied, accepted or messaged are the strongest yield.
  // @2: each kept or added search also says how it reads — depth (pages a
  // sweep, 1–15), sort (relevance | latest) and window — and the input names
  // the run's page budget and the campaign's post-age limit. (@1: the Scout
  // plans its searches from what each one landed — keep, retire and add, each
  // with a rationale, and a note on what is working (discovery/plan.ts).)
  "discovery.plan": 6,
  // @1: Find leads' search map (leads/scout/mapPlan.ts) — seeds an empty map
  // from the audience's pains across the five language types, then each run
  // keeps, retires and adds phrases from what each landed in people (buyers,
  // peers, noise). The server holds every change to the map's bounds.
  // @2: each row also says how many of the people it found the owner rated,
  // by answer; its counts hold the owner's word in place of Scout's.
  // @3: a room mode — one post's thread the owner pointed Scout at, its
  // comments fenced and nameless, proposes phrases and says whether the
  // author is a peer or a competitor to read.
  "leads.map_plan": 3,
  "onboarding.angle": 1,
  // @4: the step decides its next move — answer, nothing, or a wait it names
  // (`wait.wake_at` with the refs and their quoted words it rests on); the
  // input carries now and each message's time in the owner's zone, and the
  // follow-up's bounds are stated. (@3: DM's and Follow-up's tool lines say
  // each sends the draft_dm it names, and a DM may name an approved CTA asset.
  // @2: Invite's tool line says the server drafts its note from the exchange
  // and takes no inputs. @1: one iteration of an agent step
  // (agentStep/prompt.ts) — the step, its tools and their modes, the fenced
  // input, and what the server did with each earlier call; answered as
  // AgentStepResult.v1.)
  "agent.step": 5,
  // @1: one page as words and anchors (reader/prompt.ts) — the comment of
  // ours and the replies beside it, the inbox's conversations, or one
  // conversation's messages — every identifier copied from an anchor and
  // every quote from the page, the page fenced as untrusted.
  "reader.page": 1,
  // @1: the owner's words, the screen and the redacted diagnostics, fenced,
  // written up as a title, summary, steps, expected, actual, a suspected area,
  // a severity and log lines quoted from the diagnostics (reports/writeUp.ts).
  "report.write_up": 1,
};

/** The recorded/routed form: `"writer.comment@1"`. */
export function promptRef(id: PromptId): string {
  return `${id}@${PROMPT_VERSIONS[id]}`;
}

/** The id half of a ref ("writer.comment@1" → "writer.comment"); tolerant of bare ids. */
export function promptIdOf(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at === -1 ? ref : ref.slice(0, at);
}
