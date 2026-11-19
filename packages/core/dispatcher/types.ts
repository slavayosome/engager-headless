import { z } from "zod";
import { DRAFT_PLAN_SURFACES } from "@engager/database/schema";
import { ASSIST_MOVES } from "../operations/candidateDraft";

/**
 * The draft dispatcher's contract (spec "Draft Dispatcher" v0.3).
 *
 * One dispatcher decides everything that shapes a draft and saves it as a
 * plan; the writer only chooses the words; the judge checks the draft against
 * the saved plan. Every type the three share lives here, so none of them can
 * hold a private idea of what a plan says.
 *
 * - `VoiceRule`: one rule of one voice, with where it came from. Derived from
 *   the voice row, never stored apart from it (`voiceRules.ts`).
 * - `CampaignRule`: one instruction the campaign gives, by its own authority.
 * - `CompiledRules`: both, merged by authority for one campaign and channel,
 *   with every conflict that merge settled (`compile.ts`).
 * - `Budget`: how far one batch of plans may go on each rated habit, counted
 *   by code from the owner's rates and the recent drafts (`budgets.ts`).
 * - `DraftPlan`: one draft's every choice, made by a model within the
 *   compiled rules and the budget, checked by code, saved before writing.
 * - `PlanVerdict`: the judge's word on one plan item.
 */

/** Bumped when a plan's meaning changes, so a saved plan is read by the engine
 *  that made it. */
export const DRAFT_ENGINE = 1;

export const VOICE_CHANNELS = ["comment", "reply", "dm"] as const;
export type VoiceChannel = (typeof VOICE_CHANNELS)[number];

export type DraftSurface = (typeof DRAFT_PLAN_SURFACES)[number];

/** Where a voice rule came from:
 *  - `owner`: the owner set it, on the Voice page, in chat or through a tool;
 *  - `learned`: measured from texts the owner wrote, with the count;
 *  - `calibrated`: a model read the owner's examples and wrote it down;
 *  - `brain`: a writing preference the owner keeps in the Brain;
 *  - `default`: Engager's starting rule, until the owner changes it;
 *  - `inherited`: a reply or DM channel reading the comment channel's rule
 *    until it has texts of its own. */
export const RULE_SOURCES = ["owner", "learned", "calibrated", "brain", "default", "inherited"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

/** What a voice rule governs. `note` is prose the compile reads and turns into
 *  structured rules; every other kind is already structured. */
export const VOICE_RULE_KINDS = [
  "mark", "habit", "question", "length", "punctuation", "register", "rough_edge",
  "emoji", "opener_ban", "avoid_word", "structure", "note",
] as const;
export type VoiceRuleKind = (typeof VOICE_RULE_KINDS)[number];

const rate = z.number().min(0).max(1);

export const RuleDetailSchema = z.object({
  /** For `learned`: how many owner texts it was measured from. */
  count: z.number().int().nonnegative().optional(),
  /** When it was set, measured or calibrated, epoch ms. */
  at: z.number().int().optional(),
  /** For `inherited`: the channel it is read from. */
  from: z.enum(VOICE_CHANNELS).optional(),
}).strict();

export const VoiceRuleSchema = z.object({
  /** Stable across reads and recomputes: `<channel>.<kind>.<key>`, for
   *  example `comment.mark.:-)`. A plan and a verdict cite it. */
  id: z.string().min(1),
  voiceId: z.number().int().nullable(),
  voiceName: z.string(),
  channel: z.enum(VOICE_CHANNELS),
  kind: z.enum(VOICE_RULE_KINDS),
  key: z.string().min(1),
  /** The rule's value, by kind: a rate for `mark`, `habit` and `question`;
   *  `{min,max}` words for `length`; `allow`/`forbid` for `punctuation` and
   *  `rough_edge`; a number for `emoji`; a string list for `opener_ban` and
   *  `avoid_word`; axis weights for `structure`; the prose for `note`. */
  value: z.unknown(),
  source: z.enum(RULE_SOURCES),
  detail: RuleDetailSchema,
  /** The rule in plain words, as the owner reads it and the compile reads it. */
  text: z.string().min(1),
});
export type VoiceRule = z.infer<typeof VoiceRuleSchema>;

/** Where a campaign instruction comes from, highest authority first. */
export const CAMPAIGN_RULE_SOURCES = ["step", "campaign_guidance", "learned_guidance", "tone"] as const;
export type CampaignRuleSource = (typeof CAMPAIGN_RULE_SOURCES)[number];

export const CampaignRuleSchema = z.object({
  /** `campaign.<source>.<n>`, stable for an unchanged instruction. */
  id: z.string().min(1),
  source: z.enum(CAMPAIGN_RULE_SOURCES),
  text: z.string().min(1),
});
export type CampaignRule = z.infer<typeof CampaignRuleSchema>;

const ruleIds = z.array(z.string().min(1));

/** A rated habit or mark as compiled: the owner's rate and who said so.
 *  `allowed: false` means a higher authority forbade it outright. */
const RatedSchema = z.object({ rate, allowed: z.boolean(), ruleIds });

export const CONTENT_POLICIES = ["never", "not_on_first_touch", "allowed"] as const;

/** The rated habits a plan decides on, keyed by their trait. */
export const PLAN_HABITS = ["eitherOrRate", "adviceRate", "tagPhraseRate", "colonRate", "exclamationRate"] as const;
export type PlanHabit = (typeof PLAN_HABITS)[number];

/** The moves a plan picks from: the assist moves, a reaction that stands
 *  on its own — a dry joke or a sharp take — which a set of angles does not
 *  spread across, and the one move of a message whose step says what it
 *  does (`DraftPlan.step`). */
export const PLAN_MOVES = [...ASSIST_MOVES, "react", "step"] as const;
export type PlanMove = (typeof PLAN_MOVES)[number];

export const CompiledRulesSchema = z.object({
  channel: z.enum(VOICE_CHANNELS),
  voiceId: z.number().int().nullable(),
  marks: z.record(z.string(), RatedSchema),
  habits: z.record(z.enum(PLAN_HABITS), RatedSchema),
  question: z.object({ rate, must: z.enum(["ask", "never"]).nullable(), ruleIds }),
  length: z.object({ minWords: z.number().int().positive(), maxWords: z.number().int().positive(), ruleIds }),
  punctuation: z.object({
    emDash: z.enum(["allow", "forbid"]),
    semicolon: z.enum(["allow", "forbid"]),
    aside: z.enum(["spaced_hyphen", "em_dash", "parentheses", "comma"]).nullable(),
    ruleIds,
  }),
  register: z.object({
    register: z.string().nullable(),
    casing: z.enum(["sentence", "lowercase", "mirror"]),
    roughEdges: z.enum(["allow", "forbid"]),
    shorthand: z.enum(["allow", "forbid"]),
    ruleIds,
  }),
  emojiMax: z.number().int().nonnegative(),
  bannedOpeners: z.array(z.string()),
  avoidWords: z.array(z.string()),
  structure: z.object({
    opening: z.array(z.object({ id: z.string(), weight: z.number() })),
    shape: z.array(z.object({ id: z.string(), weight: z.number() })),
    stance: z.array(z.object({ id: z.string(), weight: z.number() })),
  }),
  content: z.object({
    product: z.enum(CONTENT_POLICIES),
    link: z.enum(CONTENT_POLICIES),
    pitch: z.enum(CONTENT_POLICIES),
    ruleIds,
  }),
  /** Instructions that are not a structured field, kept for the planner to
   *  weigh, each with the rules it came from. */
  notes: z.array(z.object({ text: z.string().min(1), ruleIds })),
});
export type CompiledRules = z.infer<typeof CompiledRulesSchema>;

export const RuleConflictSchema = z.object({
  /** The compiled field the two rules disagreed on, e.g. `marks.:-)`. */
  field: z.string().min(1),
  winner: z.string().min(1),
  loser: z.string().min(1),
  /** In the owner's words: what each said and which won. */
  sentence: z.string().min(1),
});
export type RuleConflict = z.infer<typeof RuleConflictSchema>;

/** How many plans in one batch may carry each rated thing. A ceiling the
 *  planner stays within, never a quota it must fill. */
export const BudgetSchema = z.object({
  size: z.number().int().positive(),
  marks: z.record(z.string(), z.number().int().nonnegative()),
  habits: z.record(z.enum(PLAN_HABITS), z.number().int().nonnegative()),
  question: z.number().int().nonnegative(),
});
export type Budget = z.infer<typeof BudgetSchema>;

/**
 * The conversation a draft speaks into, word for word: what the writer sees
 * of the world (spec, "Context routing"). Its bounds are a fact of the
 * surface, set by code: a comment answers the post; a reply, the post and the
 * exchange under our comment; a DM, the whole thread. Everything around it
 * (the room, the author's profile, the Brain) reaches the writer only as the
 * plan quotes it.
 *
 * An opener to someone Find leads found answers words of theirs that no
 * discovered post holds: `leadId` names them, and `post` holds those words —
 * their post (a `comment`), their comment under someone else's (a
 * `room_reply`), or either behind the note of a connection `invitation`.
 */
export const DraftConversationSchema = z.object({
  surface: z.enum(DRAFT_PLAN_SURFACES),
  leadId: z.number().int().optional(),
  /** The id a reply, DM or note is known by where it answers no discovered
   *  post and no lead: the row it answers (`dispatcher/conversationWords.ts`). */
  draftKey: z.number().int().optional(),
  post: z.object({
    discoveredPostId: z.number().int().nullable(),
    authorName: z.string().nullable(),
    postedAt: z.number().int().nullable(),
    /** The full post, never a preview slice. */
    text: z.string(),
    mediaText: z.string().nullable(),
  }),
  /** The exchange this draft continues before the words in `post`, oldest
   *  first; empty for a comment. */
  turns: z.array(z.object({
    speaker: z.enum(["owner", "author", "other"]),
    name: z.string().nullable(),
    text: z.string().min(1),
  })),
});
export type DraftConversation = z.infer<typeof DraftConversationSchema>;

/** What the owner asked of one comment in their own words: a redraft's note
 *  with the words it replaces, or the angle a box asked to have drafted. The
 *  planner reads it as an input; the writer follows it where the plan leaves
 *  the words open. Nothing in it is evidence for a claim. */
export type OwnerAsk = { note: string | null; replacing: string | null };

/** A quote the plan hands the writer and the judge: verbatim words from one
 *  named source. */
export const PlanQuoteSchema = z.object({
  source: z.enum(["post", "comment", "thread", "story", "owner_facts"]),
  text: z.string().min(1),
});

/** One reason per decision, for the preview and the run page. */
const why = z.string().min(1).max(240);

/** What an opener to a lead may do, from the row their intent reads
 *  (`leads/scout/opener.ts`), and the way in it writes out. */
export const OpenerPlanSchema = z.object({
  /** The row: `asking`, `has_problem`, `topic_only` or `signal`. */
  row: z.string().min(1),
  /** What an opener to them does, in the row's words. */
  does: z.string().min(1),
  /** The shape every opener takes: its parts and its one question at most. */
  shape: z.string().min(1),
  /** The angle the draft writes out: its name and its line. */
  angle: z.object({ name: z.string().min(1), why: z.string().min(1) }).nullable(),
});
export type OpenerPlan = z.infer<typeof OpenerPlanSchema>;

export const DraftPlanSchema = z.object({
  engine: z.literal(DRAFT_ENGINE),
  surface: z.enum(DRAFT_PLAN_SURFACES),
  discoveredPostId: z.number().int().nullable(),
  /** The composer box a plan answers where no post does: a lead's opener,
   *  `lead:<id>`. */
  boxKey: z.string().min(1).optional(),
  /** The frozen source of a lead opener. */
  leadSignalId: z.number().int().positive().optional(),
  leadSignalHash: z.string().min(1).optional(),
  /** What the opener was written under: their intent, row, content gate and
   *  products. A held draft is used only while it still holds. */
  leadContextHash: z.string().min(1).optional(),
  leadAnglePosition: z.number().int().positive().nullable().optional(),
  /** Set exactly on an opener to a lead: what their intent lets it do. */
  opener: OpenerPlanSchema.optional(),
  /** Set exactly on a message its step writes, a connection note or a DM:
   *  the step's instructions, the owner's own, which say what it does and
   *  rule its move and shape. */
  step: z.string().min(1).optional(),
  /** The point the draft builds on, and the words it builds on. */
  point: z.object({ buildOn: z.string().min(1), quotes: z.array(PlanQuoteSchema).min(1), why }),
  move: z.object({ value: z.enum(PLAN_MOVES), why }),
  /** What the draft speaks to, in a few words: the name an angle it adds to
   *  the owner's box goes by. Absent where the planner gave none. */
  name: z.string().min(1).optional(),
  /** The owner story the draft tells, or none. Fresh words: the wordings the
   *  account already sent with it are listed to avoid. */
  story: z.object({
    id: z.number().int(),
    content: z.string().min(1),
    avoidWordings: z.array(z.string()),
    why,
  }).nullable(),
  question: z.object({ ask: z.boolean(), why }),
  /** The words it runs to, and — where its surface has a hard limit, as a
   *  connection invitation's note does — the most characters it may take. */
  length: z.object({
    minWords: z.number().int().positive(),
    maxWords: z.number().int().positive(),
    maxChars: z.number().int().positive().optional(),
  }),
  style: z.object({ opening: z.string().min(1), shape: z.string().min(1), stance: z.string().min(1) }),
  /** Each of the voice's marks: `use` puts it in this draft, `omit` keeps it out. */
  marks: z.record(z.string(), z.enum(["use", "omit"])),
  habits: z.record(z.enum(PLAN_HABITS), z.enum(["use", "omit"])),
  punctuation: z.object({
    emDash: z.enum(["allow", "forbid"]),
    semicolon: z.enum(["allow", "forbid"]),
    aside: z.enum(["spaced_hyphen", "em_dash", "parentheses", "comma"]).nullable(),
  }),
  register: z.object({
    register: z.string().nullable(),
    casing: z.enum(["sentence", "lowercase", "mirror"]),
    roughEdges: z.enum(["allow", "forbid"]),
  }),
  content: z.object({ product: z.boolean(), link: z.boolean(), pitch: z.boolean() }),
  /** Copied from the compile so the judge checks the plan alone. */
  words: z.object({
    bannedOpeners: z.array(z.string()),
    avoidWords: z.array(z.string()),
    emojiMax: z.number().int().nonnegative(),
  }),
  /** The owner's example texts the writer is shown, all agreeing with this
   *  plan: as many as the voice's `exemplarCount`, 1 to 12. */
  examples: z.array(z.string().min(1)).max(12),
  /** The rule ids behind each decided field, keyed by plan path. */
  sources: z.record(z.string(), ruleIds),
  budget: BudgetSchema,
  rulesRevision: z.string().min(1),
});
export type DraftPlan = z.infer<typeof DraftPlanSchema>;

/** A lead's composer box, or a reply's or DM's own key, as a plan keys it;
 *  `composer/drafts.ts` owns the lead's format. */
const BOX = /^(?:lead|draft):([1-9]\d{0,14})$/u;

/** The id a batch knows one draft by — the one every planner, writer and
 *  judge call is told and answers with: its post's, an opener's lead, or the
 *  row a reply, DM or note answers. A batch holds one kind only. */
export function conversationId(conversation: Pick<DraftConversation, "leadId" | "draftKey" | "post">): number {
  const id = conversation.leadId ?? conversation.draftKey ?? conversation.post.discoveredPostId;
  if (id === null) throw new Error("this conversation names neither a post, a lead nor a row to answer");
  return id;
}

/** What a conversation's words are called in a prompt: a post, a comment
 *  under someone else's post, the words of theirs a connection invitation
 *  answers, or the reply or message a private or public answer follows. */
export function wordsLabel(surface: DraftSurface): string {
  switch (surface) {
    case "room_reply":
      return "Comment";
    case "invitation":
      return "Words";
    case "reply":
      return "Their reply";
    case "dm":
    case "followup":
      return "Their message";
    default:
      return "Post";
  }
}

/** The same id, read off a plan: its post's, or the lead or row its box names. */
export function planDraftId(plan: Pick<DraftPlan, "discoveredPostId" | "boxKey">): number {
  if (plan.discoveredPostId !== null) return plan.discoveredPostId;
  const box = plan.boxKey === undefined ? null : BOX.exec(plan.boxKey);
  if (!box) throw new Error("this plan names neither a post nor a lead's or row's box");
  return Number(box[1]);
}

const SPEAKERS = { owner: () => "You", author: (name: string | null) => name ?? "The author", other: (name: string | null) => name ?? "Someone" };

/** A conversation as the planner, the writer and the judge read it: the
 *  exchange before the words (oldest first), then the words answered. */
export function conversationText({ surface, post, turns }: DraftConversation): string {
  return [
    turns.length > 0
      ? `Before this, oldest first:\n${turns.map((turn) => `- ${SPEAKERS[turn.speaker](turn.name)}: ${turn.text}`).join("\n")}\n`
      : "",
    `${wordsLabel(surface)} by ${post.authorName ?? "an unknown author"}:`,
    post.text,
    post.mediaText ? `\nText in the post's media:\n${post.mediaText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Whether a surface speaks into an exchange rather than a post: a reply, a
 *  DM, a follow-up, a note or a room reply. */
export const speaksToPerson = (surface: DraftSurface) => surface !== "comment" && surface !== "angle";

/** What a batch is told besides where an id answers a person's words rather
 *  than a post. */
export const SPOKEN_RULES = [
  "SURFACES: an id whose conversation is a reply, a DM, a follow-up, a connection note or a room reply is not a",
  "comment on a post: wherever these rules say comment, read what that surface writes. A reply answers what they",
  "said under the owner's own comment or post; a DM goes to one person in private, a follow-up after their silence;",
  "a note goes with a connection invitation; a room reply answers one comment under someone else's post. What came",
  "before their words (`Before this`) is the only history the owner and this person have: nothing outside it happened.",
  "",
];

/** The judge's word on one plan item. `item` is the plan path it checks, for
 *  example `marks.:-)`, `habits.eitherOrRate`, `length` or `facts`. */
export const PlanVerdictSchema = z.object({
  item: z.string().min(1),
  pass: z.boolean(),
  /** A miss code fixed without a rewrite. */
  fixed: z.boolean().optional(),
  by: z.enum(["code", "model"]),
  detail: z.string().min(1),
  ruleIds: ruleIds.optional(),
});
export type PlanVerdict = z.infer<typeof PlanVerdictSchema>;
