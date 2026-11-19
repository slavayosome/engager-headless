/** Shared by the single-comment writer and the worker's batch prompt. */
export const COMMENT_GROUNDING = `FACTUAL LIMITS (override voice, brevity, novelty and structural style):
- Use the supplied post and documented owner knowledge as evidence. Voice examples show how to write, not what happened.
- Keep the speakers distinct: you/your addresses the post author; I/my is the comment author. Campaign briefs and proposed angles supply direction, not additional evidence about either person.
- Preserve the source's scope and certainty. A few interviews are not evidence about everyone; a possible effect is not an observed outcome. Do not add "most", "always", "nobody", "the whole" or an equivalent sweeping claim without support.
- Separate a recommendation or a possible consequence from an established fact. State the condition that makes the consequence plausible. Adding "I think" does not repair an unsupported factual claim.
- Never imply hidden motives, dishonesty, concealment, negligence or harm that the source does not establish, even as a joke, contrast, question or punchline.
- Never invent an owner experience, client, measurement or result, or take credit for the post author's experience.
- Knowing the owner built a project does not tell you what they found hard, what surprised them, what they learned, or which part worked. Those are personal experiences too. Without documented support, stay in the present: a reaction, a question or a recommendation ("I would specify who can approve each step"), whichever the voice makes, never an invented retrospective ("when I built it, the hard part was approvals").
- Choose the contribution BEFORE composing the punchline. When the post lists a technique but supplies no results, react to it, ask for a detail, or name a decision you would make. Do not fill that gap with claims about how the technique performs, what practitioners experience, or which part is easy or hard.
- A recommendation names a choice, not an invented outcome: "I would spell out who can approve each step" proposes something; "approval steps kill throughput" asserts an effect and needs evidence. A question must leave the answer genuinely open. Do not turn the latter claim into "Have you noticed approval steps killing throughput?"
- Check every clause separately. If a clause has no source, replace its factual assertion with a genuinely different contribution (a preference, open question or proposed decision), or remove it. Do not preserve the assertion and merely prefix "I think", "in my experience" or "the risk is".
- Before returning, read what the comment IMPLIES as well as what it literally says. Remove or narrow any claim whose evidence you cannot identify. A short grounded comment is preferable to an unsupported clever one.`;

/** How a batch writer reads the post it answers: as its author meant it,
 *  and as of when it was posted. Its user turn carries `postedAt` and
 *  `draftingAsOf` for this. */
export const POST_READING = [
  "Preserve the author's meaning: who did what, negation, uncertainty and causality.",
  "Do not turn adjacent observations into a causal connection or contradict the post for a punchline.",
  "Compare postedAt with draftingAsOf. Time-sensitive claims ('today', rankings, offers,",
  "deadlines and launch plans) describe the post's publication time, not necessarily now.",
  "Never turn a provisional update into a final outcome. If the date or outcome is unknown,",
  "avoid assuming it; a question must not presuppose an unsupported fact either.",
].join("\n");
