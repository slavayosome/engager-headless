/**
 * Default, EDITABLE guidance blocks. These are the parts of the writer prompt a
 * user can override per-campaign in settings (campaign.prompts). The immutable
 * scaffold (output format + structural slots) and the system gates (filter /
 * slop / sensitivity) stay hardcoded in their modules as the "base".
 *
 * SEPARATION OF CONCERNS (writer-prompt architecture):
 *   - This guidance is STRATEGY ONLY — what a comment is FOR. It must contain
 *     NO register direction (casing, punctuation, emoji, openers, closers,
 *     shorthand, rough edges): register is owned end-to-end by the voice's
 *     StyleRules (ai/styleRules.ts) and rendered as the "YOUR REGISTER" block.
 *   - The hardcoded scaffold in ai/writer.ts is INVARIANTS ONLY (plain text,
 *     response schema, factual grounding and actual channel limits).
 * Behavioral preferences are resolved by writingInstructions.ts and may be
 * overridden by explicit owner instructions, including links and promotion.
 * Adding register advice back here re-creates the three-authorities conflict
 * this split removed — don't.
 *
 * COMMENT guidance is per-objective (the campaign's GOAL owns the strategy);
 * REPLY guidance is deliberately goal-agnostic — replying well is conversation
 * mechanics, and goal color already reaches replies through the campaign
 * guidance, brief, and angle.
 */

import type { CampaignObjective } from "@engager/database/schema";

export const DEFAULT_COMMENT_GUIDANCE = `Respond to the specific point this author is making. Write one useful contribution that could naturally start a conversation.

HOW TO CONTRIBUTE:
- Start from a detail in the supplied post. Add one practical suggestion, a considered opinion, or a genuine question that follows the requested angle.
- Respect the author's intent. A joke, celebration or deliberately provocative stance is not automatically a request for help. Do not impose a problem or diagnose why something happened just to fit the angle.
- Use numbers, examples and personal experiences only when the supplied evidence documents them and identifies whose experience it is. New value can be a proposed next step; it does not require a new fact.
- Keep a suggestion a suggestion. Do not claim to know what the author tried, missed, felt or learned unless they said so.
- Prefer a choice you would make over a verdict about their choices. State an expected benefit as a possibility, never as a guaranteed or established result.
- A useful statement is a complete comment. Ask a question only if you genuinely need the answer; do not force a challenge or a hook.

AVOID:
- Summarising the whole post, generic advice, unsolicited criticism, or a forced product pitch.
- Inventing a story, result, number or personal connection to make the comment sound distinctive.`;

/** Previously shipped default, retained only to unpin saved default copies. */
const REPLY_HOOK_COMMENT_GUIDANCE = `The single goal is to SPARK A REAL REPLY — the author should feel a pull to respond to you. A comment that states a smart take and stops is a failure; it has to leave a door open.

HOW TO EARN A REPLY (this is the whole job):
- Take a clear position. Agree-and-extend, respectfully push back, or reframe the post from a different angle — never just summarise their point back to them.
- Add ONE thing they didn't say: a specific angle, a counter-example, a concrete number, or something you've actually lived. Be specific to THIS post, not a take that fits any post.
- Land a hook they'd want to answer: a pointed question about THEIR specific situation, a friendly challenge ("but doesn't that break down once…?"), or a reframe that practically begs a reaction. Tie it to a concrete detail they wrote.

NEVER:
- Restate their point back to them as if it's news, or write a take that could sit under any post on the topic.
- Open the SAME way every time, or with a formulaic, reusable template. Vary how you come in; lead with the point as often as with yourself.
- Hedge to neutrality ("it depends", "both have merit") or read like an ad or a press release.`;

/**
 * Per-objective default comment guidance — the GOAL owns the strategy block.
 * `product` uses the general text above; the other four state what their goal
 * actually rewards. Saved default copies inherit updates through normalization.
 * All texts are strategy-only: register stays voice-owned (see header).
 */
export const OBJECTIVE_COMMENT_GUIDANCE: Record<CampaignObjective, string> = {
  engage: DEFAULT_COMMENT_GUIDANCE,
  product: DEFAULT_COMMENT_GUIDANCE,
  visibility: `The single goal is to BE REMEMBERED in your niche — the author and every reader should register a distinctly useful voice. Nothing is for sale here: never mention a product, never steer anywhere.

HOW TO BE WORTH REMEMBERING:
- Add ONE thing the post didn't say: a concrete example or number the post or your documented notes actually give you, or a sharper frame. Be specific to THIS post, not a take that fits any post — and never supply the missing example by inventing one.
- Take a clear position — agree-and-extend, push back kindly, or reframe. Summaries and applause are invisible.
- Show up as the same recognizable perspective across comments: your beat, your lens, your kind of example.

NEVER:
- Pitch, plug, or hint at anything you offer — not even "we solve this".
- Restate their point back to them, or hedge to neutrality ("it depends", "both have merit").
- Open the SAME way every time, or with a formulaic, reusable template.`,
  audience: `The single goal is to EARN THE CLICK TO YOUR PROFILE — a reader who sees this comment should want more of you. Generosity converts; asks repel.

HOW TO EARN A FOLLOW:
- Be the most useful voice under the post: a concrete tactic, or a number or lived example the supplied material actually gives you. Specific to THIS post, never generic — a grounded tradeoff beats an invented anecdote.
- Have a recognizable angle — the lens you always bring. A distinct perspective is what makes someone follow rather than just nod along.
- Leave a door open: a pointed question about THEIR situation or a friendly challenge earns a reply thread, and threads earn profile visits.

NEVER:
- Ask for the follow or connection, or steer readers to your content or offer. The work does the asking.
- Mention a product except when it is genuinely the answer to a direct question — and even then, at most rarely.
- Restate their point, hedge to neutrality, or open with a reusable template.`,
  nurture: `The single goal is to BUILD FAMILIARITY with THIS person over time — after a few of your comments they should know your name and think of you warmly. This is a relationship, not a broadcast.

HOW TO NURTURE:
- React to what THEY specifically said or did — their launch, their argument, their milestone. Named specifics beat clever takes.
- Show you follow their work: reference their earlier point or a thread you were both in, when it is true and natural.
- Be consistently helpful in small ways: a relevant example, an intro-worthy thought, a genuine question about their situation.
- Match their world: their vocabulary, their concerns, their stage — not your pitch.

NEVER:
- Sell, pitch, or steer to your offer; one whiff of an agenda undoes ten good touches. A product comes up only if THEY ask.
- Write a take that could sit under any post — the whole point is that it could only be about them.
- Perform for the audience over the person; this comment is for them first.`,
  thought: `The single goal is to ADVANCE YOUR POINT OF VIEW — every comment should read as one more argument in a worldview you own. Authority compounds when the position stays consistent.

HOW TO LEAD THOUGHT:
- Take the strongest defensible position the post allows: agree with a sharper claim, disagree with a reason, or reframe the debate around what actually matters.
- Argue from evidence you own: a number, a case you lived, a pattern you keep seeing. One concrete beats three abstractions.
- Disagree agreeably — attack the idea precisely, respect the person, and leave a hook they'll want to answer.
- Keep your throughline: recurring themes and stakes you return to are what make a point of view recognizable.

NEVER:
- Hedge to neutrality ("it depends", "both have merit") — a thought leader without a position is just another comment author.
- Mention a product or steer anywhere; the point of view is the product.
- Restate their point, or open with a formulaic, reusable template.`,
};

/** The live default comment guidance for a campaign's objective. */
export function defaultCommentGuidanceFor(
  objective?: CampaignObjective | null,
): string {
  return (objective && OBJECTIVE_COMMENT_GUIDANCE[objective]) || DEFAULT_COMMENT_GUIDANCE;
}

/**
 * The hardcoded structural style taxonomy: OPENING / SHAPE / STANCE classes the
 * writer can be directed into per draft. This is BOTH the diversity FLOOR (always
 * unioned with the voice-learned `voiceStructuralRange`, so a narrow corpus can't
 * collapse to a monoculture) AND the FALLBACK (used whole when nothing is learned).
 *
 * Each class has an `id` (stable key — also the value persisted on the message
 * row + the LRU rotation key) and a short imperative `directive` injected into the
 * writer's user turn. Keep the ids stable: they're stored and compared.
 */
export type StyleClass = { id: string; directive: string };
export type StyleTaxonomy = {
  opening: StyleClass[];
  shape: StyleClass[];
  stance: StyleClass[];
};

export const DEFAULT_STYLE_TAXONOMY: StyleTaxonomy = {
  opening: [
    { id: "lead_point", directive: "Open by leading straight with your point — no warm-up, no naming the topic first." },
    { id: "lead_self", directive: "Open with a relevant experience explicitly documented in the owner's context. If none is documented, open with your present view of the post's specific point instead." },
    { id: "question_open", directive: "Open with a genuine question to the author about their specific situation." },
    { id: "fragment", directive: "Open with a short fragment or a single punchy word, the way people actually start a quick comment." },
    { id: "react_detail", directive: "Open by reacting to one concrete detail they wrote — quote or name it, don't summarize the whole post." },
    { id: "contrast", directive: "Open with a contrast or a 'but' that cuts against the obvious read of their post." },
  ],
  shape: [
    { id: "one_liner", directive: "Keep it to a single sentence — one clean thought, then stop." },
    { id: "two_beat", directive: "Two beats: a claim, then a turn (a twist, a caveat, or a question)." },
    { id: "mini_story", directive: "Tell a tiny lived moment only when that event is explicitly documented in the owner's context. Otherwise use a concrete observation about the post; never invent a story to satisfy this shape." },
    { id: "claim_evidence", directive: "A claim plus one concrete piece of evidence (a number, an example, a counter-case)." },
    { id: "social_react", directive: "React the way people actually do to a milestone or news: a brief, warm, SPECIFIC acknowledgment (name the thing they did), then — only if it genuinely fits — ONE pointed question. A few words, e.g. \"Congrats on the launch! what made you go offline-first?\" Never a paragraph." },
    { id: "pure_agree", directive: "A short, specific agreement — name exactly WHAT you agree with and explain why, using the post or documented owner facts. No question, no pivot: land it and stop." },
  ],
  stance: [
    { id: "agree_extend", directive: "Agree, then EXTEND — add the thing they didn't say, don't just echo them." },
    { id: "push_back", directive: "Respectfully push back — name where you see it differently and why." },
    { id: "reframe", directive: "Reframe their point from a different angle so it reads as a fresh take." },
    { id: "ask", directive: "Center a pointed ask — a friendly challenge they'd feel pulled to answer." },
  ],
};

/** SHAPE ids whose directive implies multiple sentences — excluded for SHORT neutral
 *  comments so the per-draft shape can't override the campaign's length rule. */
export const LONG_SHAPE_IDS = ["mini_story", "claim_evidence"] as const;
/** Ultra-short SHAPES — excluded for PROMO comments, which need room to engage the post
 *  AND name the product (a one-liner or a bare social reaction can't do both). */
export const ULTRA_SHORT_SHAPE_IDS = ["one_liner", "social_react", "pure_agree"] as const;

/**
 * Which SHAPE ids to remove from the rotation pool for this draft, so length-implying
 * shapes never get picked when the campaign wants short. Pure + unit-testable. Variety
 * is preserved by the OPENING (6) × STANCE (4) axes regardless.
 *  - PROMO (with product mention allowed): exclude the ULTRA-SHORT shapes (a promo needs
 *    ~2–3 sentences to engage AND name the product).
 *  - NEUTRAL on a non-long campaign (incl. unset length — mirrors writer.ts's lengthRule
 *    which treats anything `!== "long"` as short): exclude the long shapes.
 *  - NEUTRAL long: full spread.
 */
export function shapeExclusionFor(opts: {
  length?: "ultra_short" | "short" | "medium" | "long" | null;
  commentType: "promo" | "neutral";
  canPromo: boolean;
}): Set<string> {
  if (opts.commentType === "promo" && opts.canPromo) return new Set(ULTRA_SHORT_SHAPE_IDS);
  if (opts.length !== "long") return new Set(LONG_SHAPE_IDS);
  return new Set();
}

export const DEFAULT_REPLY_GUIDANCE = `A reply is a CONVERSATION you are already in — not a fresh comment performing for strangers. The goal is a satisfying exchange, not a longer one.

HOW TO REPLY WELL:
- Answer or react FIRST. If they asked something, answer it plainly before anything else. If they made a point, respond to THE POINT — never restate what the thread already said.
- Mirror their energy and length: a one-line reply gets a one-liner back; a thoughtful paragraph earns a real response. Never out-write them.
- Stay consistent with what YOU said earlier in the thread (your comment and its intent are provided) — build on it, don't repeat it or contradict it.
- No hooks, no thesis openers, no re-introducing yourself or the topic. You're mid-conversation.
- A question is a COST, not a technique: ask one only when the conversation genuinely needs another turn AND you have reply budget left. When the exchange has run its course — or this is your final budgeted reply — close warmly with a statement and leave it complete.
- Address them by first name only when it reads naturally; the tag/mention already names them.`;

// ---------------------------------------------------------------------------
// Legacy-default normalization ("frozen snapshot" repair).
//
// The dashboard campaign form used to PREFILL the guidance textareas with the
// then-current default, so merely saving a campaign froze a byte-copy of that
// default into campaign.prompts — silently pinning the campaign to an old
// prompt generation. `effective*Guidance` treats a saved value that equals ANY
// historical default as "inherit the live default", so those campaigns follow
// prompt improvements again. Genuinely customized text is honored verbatim.
// ---------------------------------------------------------------------------

/** Historical default texts (@1 pre-#143, @2 post-#143) — comment guidance. */
const LEGACY_COMMENT_GUIDANCE: string[] = [
  REPLY_HOOK_COMMENT_GUIDANCE,
  // @2 (casing follows learned voice, 2026-07-05 → @3 strategy-only split)
  `The single goal is to SPARK A REAL REPLY — the author should feel a pull to respond to you. A comment that states a smart take and stops is a failure; it has to leave a door open.

HOW TO EARN A REPLY (this is the whole job):
- Take a clear position. Agree-and-extend, respectfully push back, or reframe the post from a different angle — never just summarise their point back to them.
- Add ONE thing they didn't say: a specific angle, a counter-example, a concrete number, or something you've actually lived. Be specific to THIS post, not a take that fits any post.
- Land a hook they'd want to answer: a pointed question about THEIR specific situation, a friendly challenge ("but doesn't that break down once…?"), or a reframe that practically begs a reaction. Tie it to a concrete detail they wrote.
- Sound like a real person: an opinion, contractions, plain words, a bit of edge. Slightly rough beats polished.

WRITE LIKE A REAL PERSON TYPING A QUICK COMMENT (not a polished essay) — this is what makes it human:
- Mirror the author's OWN natural register and quirks from their persona/voice: if their voice shows they write lowercase, use shorthand (imo, tbh, w/, &, etc.), drop end punctuation, or use fragments — do the same. A LinkedIn comment is fast and off-the-cuff, looser than a written post.
- Don't be too perfect. Flawless grammar and tidy parallel structure are the biggest tells of AI. Leave the occasional rough edge — a missing comma, a fragment, a contraction. People don't proofread comments.
- CAPITALISATION IS NOT YOURS TO INVENT: follow YOUR WRITING STYLE exactly. Unless it explicitly says you start lines lowercase, write normal sentence case — do not lowercase as a shortcut to "casual".
- But NEVER force errors or break words into gibberish — it must read naturally, just not sanitised. Match how THIS specific person writes, not generic casualness.

NEVER:
- Open with "Great post", "Thanks for sharing", "Love this", or restate their point as if it's news.
- Open the SAME way every time, or with a formulaic, reusable template. Vary how you come in; lead with the point as often as with yourself.
- Lean on AI-comment tells: recycled emphatic clichés or over-uniform structure. These are the patterns LinkedIn's reach filter flags as AI — vary your phrasing and write the specific thing.
- End with a limp generic closer ("Thoughts?", "What do you think?", "Curious to hear more", "Would love your take"), or tack a question on by reflex when the comment already stands on its own.
- Hedge to neutrality ("it depends", "both have merit") or read like an ad or a press release.`,
  // @1 (pre-#143 — named "a lowercase start" as the go-to rough edge)
  `The single goal is to SPARK A REAL REPLY — the author should feel a pull to respond to you. A comment that states a smart take and stops is a failure; it has to leave a door open.

HOW TO EARN A REPLY (this is the whole job):
- Take a clear position. Agree-and-extend, respectfully push back, or reframe the post from a different angle — never just summarise their point back to them.
- Add ONE thing they didn't say: a specific angle, a counter-example, a concrete number, or something you've actually lived. Be specific to THIS post, not a take that fits any post.
- Land a hook they'd want to answer: a pointed question about THEIR specific situation, a friendly challenge ("but doesn't that break down once…?"), or a reframe that practically begs a reaction. Tie it to a concrete detail they wrote.
- Sound like a real person: an opinion, contractions, plain words, a bit of edge. Slightly rough beats polished.

WRITE LIKE A REAL PERSON TYPING A QUICK COMMENT (not a polished essay) — this is what makes it human:
- Mirror the author's OWN natural register and quirks from their persona/voice: if they tend to write lowercase, use shorthand (imo, tbh, w/, &, etc.), drop end punctuation, or use fragments — do the same. A LinkedIn comment is fast and off-the-cuff, looser than a written post.
- Don't be too perfect. Flawless grammar and tidy parallel structure are the biggest tells of AI. Leave the occasional rough edge — a lowercase start, a missing comma, a fragment, a contraction. People don't proofread comments.
- But NEVER force errors or break words into gibberish — it must read naturally, just not sanitised. Match how THIS specific person writes, not generic casualness.

NEVER:
- Open with "Great post", "Thanks for sharing", "Love this", or restate their point as if it's news.
- Open the SAME way every time, or with a formulaic, reusable template. Vary how you come in; lead with the point as often as with yourself.
- Lean on AI-comment tells: recycled emphatic clichés or over-uniform structure. These are the patterns LinkedIn's reach filter flags as AI — vary your phrasing and write the specific thing.
- End with a limp generic closer ("Thoughts?", "What do you think?", "Curious to hear more", "Would love your take"), or tack a question on by reflex when the comment already stands on its own.
- Hedge to neutrality ("it depends", "both have merit") or read like an ad or a press release.`,
];

/** Historical default texts — reply guidance. */
const LEGACY_REPLY_GUIDANCE: string[] = [
  // @3 (pre-reply-intelligence: engineered "keep the conversation going")
  `The goal is to keep the conversation going — they should want to reply again.

HOW TO REPLY WELL:
- Open by addressing them by first name.
- Take a real, nuanced position on what they said — agree with a twist, or respectfully disagree and say why. Don't just thank them.
- Add a specific point or a small reframe, ideally with a memorable phrase. End with something that invites them to come back (a sharp question, or a stance they'll want to react to) — only when it's natural, never forced.`,
  // @2
  `The goal is to keep the conversation going — they should want to reply again.

HOW TO REPLY WELL:
- Open by addressing them by first name.
- Take a real, nuanced position on what they said — agree with a twist, or respectfully disagree and say why. Don't just thank them.
- Add a specific point or a small reframe, ideally with a memorable phrase. End with something that invites them to come back (a sharp question, or a stance they'll want to react to) — but only when it's natural, never a forced "thoughts?".
- Sound human: contractions, plain words, a bit of personality. Slightly rough beats polished.
- Type it like a real quick reply, not an essay: match your own natural register and shorthand, keep it loose, don't over-polish. The occasional dropped comma or fragment reads more human than flawless grammar — but never force typos or gibberish, and keep normal sentence case unless YOUR WRITING STYLE explicitly says you write lowercase.`,
  // @1
  `The goal is to keep the conversation going — they should want to reply again.

HOW TO REPLY WELL:
- Open by addressing them by first name.
- Take a real, nuanced position on what they said — agree with a twist, or respectfully disagree and say why. Don't just thank them.
- Add a specific point or a small reframe, ideally with a memorable phrase. End with something that invites them to come back (a sharp question, or a stance they'll want to react to) — but only when it's natural, never a forced "thoughts?".
- Sound human: contractions, plain words, a bit of personality. Slightly rough beats polished.
- Type it like a real quick reply, not an essay: match your own natural register and shorthand, keep it loose, don't over-polish. The occasional lowercase start or dropped comma reads more human than flawless grammar — but never force typos or gibberish.`,
];

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

/** True when the saved text is NOT an inherit (blank / any current default /
 *  any frozen historical default) — i.e. genuinely customized. */
function isCustom(
  saved: string | null | undefined,
  currents: string[],
  legacy: string[],
): boolean {
  const s = saved?.trim();
  if (!s) return false;
  const n = normalize(s);
  return ![...currents, ...legacy].some((l) => normalize(l) === n);
}

/** Every objective's current comment default — a saved copy of ANY of them is
 *  inherit (covers switching goals after a frozen prefill). */
function currentCommentDefaults(): string[] {
  return Object.values(OBJECTIVE_COMMENT_GUIDANCE);
}

/** The campaign's effective comment guidance: saved custom text verbatim, or
 *  the objective's live default when unset OR when the saved text is a frozen
 *  copy of any current or historical default. */
export function effectiveCommentGuidance(
  saved: string | null | undefined,
  objective?: CampaignObjective | null,
): string {
  return isCustom(saved, currentCommentDefaults(), LEGACY_COMMENT_GUIDANCE)
    ? (saved as string).trim()
    : defaultCommentGuidanceFor(objective);
}

/** Reply-guidance twin of `effectiveCommentGuidance` (goal-agnostic — see
 *  the module header). */
export function effectiveReplyGuidance(saved: string | null | undefined): string {
  return isCustom(saved, [DEFAULT_REPLY_GUIDANCE], LEGACY_REPLY_GUIDANCE)
    ? (saved as string).trim()
    : DEFAULT_REPLY_GUIDANCE;
}

/** Write-side twin of `effectiveCommentGuidance`: text that would resolve to a
 *  default (blank, any objective's current default, or a frozen historical
 *  copy) persists as `undefined` so the row keeps inheriting live prompt
 *  improvements. */
export function storableCommentGuidance(saved: string | null | undefined): string | undefined {
  return isCustom(saved, currentCommentDefaults(), LEGACY_COMMENT_GUIDANCE)
    ? (saved as string).trim()
    : undefined;
}

/** Write-side twin of `effectiveReplyGuidance`. */
export function storableReplyGuidance(saved: string | null | undefined): string | undefined {
  return isCustom(saved, [DEFAULT_REPLY_GUIDANCE], LEGACY_REPLY_GUIDANCE)
    ? (saved as string).trim()
    : undefined;
}

// ---------------------------------------------------------------------------
// Reply playbook: the ONE effective set of campaign-level reply instructions.
//
// Two campaign fields carry reply direction and BOTH render into the same
// prompt: prompts.reply_guidance (the editable strategy block) and
// prompts.reply_policy (the "reply policy" line, which was a campaign's
// reply-lane prompt before that lane became a strategy mode).
// `effectiveReplyPlaybook` collapses the pair: default-equal policy text is
// inherit (no block), genuinely custom policy renders alongside the guidance.
// ---------------------------------------------------------------------------

/** The literal every create persisted as the reply policy before it became
 *  `prompts.reply_policy` — and the org own-post reply default. */
export const DEFAULT_AUTO_REPLY_PROMPT = "Reply warmly, answer the question, never pitch.";

/** Historical auto-reply policy defaults (persisted literal + the old
 *  render-time fallback in writer.ts). */
const LEGACY_AUTO_REPLY_PROMPTS: string[] = [
  DEFAULT_AUTO_REPLY_PROMPT,
  "Reply warmly and specifically. Answer any question. Never pitch.",
];

/** Write-side twin of the policy half of `effectiveReplyPlaybook`: default-equal
 *  text never persists, so a row keeps inheriting the live default. */
export function storableReplyPolicy(saved: string | null | undefined): string | undefined {
  const text = saved?.trim();
  if (!text) return undefined;
  const n = normalize(text);
  return LEGACY_AUTO_REPLY_PROMPTS.some((l) => normalize(l) === n) ? undefined : text;
}

export type ReplyPlaybook = {
  /** Effective reply strategy text (custom or the live default). */
  guidance: string;
  /** Custom reply policy, or null when the stored policy is default-equal or
   *  already contained in `guidance` (idempotence after the dashboard folds
   *  policy text into the playbook document). */
  policy: string | null;
  /** True when either half is genuinely customized. */
  customized: boolean;
};

/** Merge the two campaign-level reply-instruction fields into one effective
 *  playbook. Read-time only — no stored row changes shape. */
export function effectiveReplyPlaybook(campaign: {
  prompts?: { reply_guidance?: string; reply_policy?: string } | null;
}): ReplyPlaybook {
  const guidance = effectiveReplyGuidance(campaign.prompts?.reply_guidance);
  const guidanceCustom =
    storableReplyGuidance(campaign.prompts?.reply_guidance) !== undefined;
  const raw = storableReplyPolicy(campaign.prompts?.reply_policy);
  let policy: string | null = null;
  if (raw && !normalize(guidance).includes(normalize(raw))) policy = raw;
  return { guidance, policy, customized: guidanceCustom || policy != null };
}
