import type { BrainSlot } from "@engager/database/schema";

/**
 * The fixed coverage model for the Brain. Each slot is a facet of "who this
 * person is + what they believe" that the writer draws on and the agentic
 * interview tries to fill. Order is the canonical display/assessment order.
 */
export const BRAIN_SLOTS: { id: BrainSlot; label: string; description: string }[] = [
  {
    id: "identity",
    label: "Identity",
    description: "Who you are: role, background, what you do day-to-day.",
  },
  {
    id: "expertise",
    label: "Expertise",
    description: "The domains and skills you can speak about with authority.",
  },
  {
    id: "positions",
    label: "Positions",
    description: "Opinions and stances you hold — the takes you'll defend.",
  },
  {
    id: "stories",
    label: "Stories",
    description: "Concrete lived experiences, projects, and anecdotes you can draw on.",
  },
  {
    id: "audience",
    label: "Audience",
    description: "Who you want to reach and what they care about.",
  },
  {
    id: "goals",
    label: "Goals",
    description: "What you're trying to achieve by engaging here.",
  },
  {
    id: "avoid",
    label: "Avoid",
    description: "Topics, tones, and claims you never want to touch.",
  },
  // NOTE: "product" was intentionally dropped from the Brain coverage model —
  // product knowledge now lives in the Products model (products/product_facts).
  // The "product" value stays in the BrainSlot union + column enum so any legacy
  // rows still read, but the interview/coverage no longer track it.
];
