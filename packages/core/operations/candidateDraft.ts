export const ASSIST_MOVES = [
  "your_story",
  "agree_plus",
  "push_back",
  "question",
  "answer_room",
] as const;
export type AssistMove = (typeof ASSIST_MOVES)[number];
