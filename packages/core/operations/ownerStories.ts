import { and, eq, gte, inArray, isNotNull, or } from "drizzle-orm";
import { messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { materializeVaultMirror } from "../brain/mirror";
import { listNotes } from "../brain/vault";
import type { KnowledgeRetrievalSnapshot } from "../brain/knowledge";

/**
 * OWNER STORIES: documented personal experiences a draft may claim.
 *
 * A story is a Brain note the owner wrote or confirmed: one in the `stories`
 * slot, or any note they tagged `owner_story`. The Brain is the vault
 * (INV-14), so they are read from its files, never from the `knowledge` table,
 * which nothing writes any more. A draft names the story it tells, or the
 * server works out which one its words tell ({@link attributeOwnerStory}); the
 * comment that goes out carries it (`messages.owner_story_id`), which records
 * recent use as writing context.
 *
 * Repetition is an inherited preference, not a hard quota. The owner can ask
 * to reuse a story; the factual boundary still refuses unknown stories, and
 * the evidence review asks whether the story fits the post it is told on.
 */
export const OWNER_STORY_TAG = "owner_story";

const STORIES_SLOT = "stories";

/**
 * How long a posted comment keeps its story spent: a rolling day, which is the
 * "today" every surface that names a spent story means.
 */
export const STORY_REST_MS = 86_400_000;

/**
 * How far a saved comment may drift from the draft that told a story and
 * still be telling it — normalized edit distance, so 0.7 keeps roughly a
 * third of the draft. Generous on purpose: a story counted as told when the
 * owner cut it rests a day it did not need to, and one missed is told twice.
 */
export const STORY_KEPT_MAX_DISTANCE = 0.7;

export type OwnerStory = {
  id: number;
  title: string | null;
  content: string;
  /** Told in a comment that is out, or about to go out, within the rest. */
  spent: boolean;
};

/**
 * The stories told too recently to tell again: in a comment approved or being
 * sent (it is going out), or posted within {@link STORY_REST_MS}. A proposal
 * still waiting on the owner's yes spends nothing.
 */
export async function spentOwnerStoryIds(
  tx: Tx,
  now: number,
): Promise<Set<number>> {
  const rows = await tx
    .selectDistinct({ id: messages.ownerStoryId })
    .from(messages)
    .where(
      and(
        isNotNull(messages.ownerStoryId),
        or(
          inArray(messages.status, ["approved", "posting"]),
          and(
            eq(messages.status, "posted"),
            gte(messages.postedAt, now - STORY_REST_MS),
          ),
        ),
      ),
    );
  return new Set(rows.flatMap((row) => (row.id == null ? [] : [row.id])));
}

/** Every owner story, oldest first, each marked spent or not. */
export async function listOwnerStories(tx: Tx, now: number, snapshot?: KnowledgeRetrievalSnapshot): Promise<OwnerStory[]> {
  if (!snapshot) await materializeVaultMirror(tx);
  const notes = (snapshot ?? await listNotes())
    .filter((note) => note.slot === STORIES_SLOT || note.tags?.includes(OWNER_STORY_TAG))
    .sort((a, b) => a.id - b.id);
  if (notes.length === 0) return [];
  const spent = await spentOwnerStoryIds(tx, now);
  return notes.map((note) => ({
    id: note.id,
    title: note.title ?? null,
    content: note.content,
    spent: spent.has(note.id),
  }));
}

/** Why a draft may not tell this story, or null when it may. */
export function storyRefusal(
  stories: readonly OwnerStory[],
  storyId: number,
): "unknown_story" | null {
  const story = stories.find((row) => row.id === storyId);
  if (!story) return "unknown_story";
  return null; // Repetition is an editorial preference, not a factual refusal.
}

/** Words that say nothing about WHICH story a text tells. */
const COMMON_WORDS = new Set(
  (
    "about above after again also always another any are because been before being between both but can " +
    "could did does doing done down each even ever for from get gets got had has have here how into its " +
    "just like made make many more most much must not now off once one only other our out over own really " +
    "same should since some still such than that the their them then there these they this those through " +
    "too under until very was way were what when where which while who why will with without would you " +
    "your and"
  ).split(" "),
);

/** The shortest a word may be to count as one that tells a story. */
const STORY_WORD_MIN = 3;
/** The words of a story a telling needs to share, at most: a long story is
 *  told in a few of its words, and asking for a share of all of them would
 *  never find it. */
const STORY_SHARED_CAP = 8;
/** The share of those a telling must reach, and the fewest words it may rest
 *  on: one rare word a story and a draft happen to share tells nothing. */
const STORY_SHARED_MIN_SHARE = 0.5;
const STORY_SHARED_MIN_WORDS = 4;

/** A word cut to the stem two forms of it share (`burned`/`burn`, `calls`/
 *  `call`, `tables`/`table`). Crude and deterministic, which is the point:
 *  both sides of every comparison are cut the same way. */
function stemOf(word: string): string {
  if (/\d/.test(word)) return word;
  let stem = word;
  if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);
  else if (stem.length > 3 && stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1);
  if (stem.length > 3 && stem.endsWith("e")) stem = stem.slice(0, -1);
  if (stem.length > 3 && stem.at(-1) === stem.at(-2)) stem = stem.slice(0, -1);
  return stem;
}

/** The words of a text that could tell a story: its figures and its
 *  uncommon words, stemmed. */
function storyWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of text.toLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/^\p{N}+$/u.test(word) || (word.length >= STORY_WORD_MIN && !COMMON_WORDS.has(word))) {
      words.add(stemOf(word));
    }
  }
  return words;
}

/**
 * The owner story a text tells, or null when it tells none.
 *
 * A model that tells a story does not always name it, so the server reads the
 * words: a text tells a story when it shares at least half of the story's
 * distinctive words (its figures and uncommon words, up to
 * {@link STORY_SHARED_CAP} of them) and at least four, or all of a shorter
 * story's. The closest story wins, the lower id on a tie. Deterministic and
 * model-free, so the same draft is attributed the same way wherever it is
 * checked.
 */
export function attributeOwnerStory(
  text: string,
  stories: readonly Pick<OwnerStory, "id" | "title" | "content">[],
): number | null {
  const told = storyWords(text);
  let best: { id: number; share: number; shared: number } | null = null;
  for (const story of stories) {
    const own = storyWords(`${story.title ?? ""} ${story.content}`);
    if (own.size === 0) continue;
    let shared = 0;
    for (const word of own) if (told.has(word)) shared += 1;
    const share = shared / Math.min(own.size, STORY_SHARED_CAP);
    if (shared < Math.min(own.size, STORY_SHARED_MIN_WORDS) || share < STORY_SHARED_MIN_SHARE) continue;
    if (
      !best ||
      share > best.share ||
      (share === best.share && (shared > best.shared || (shared === best.shared && story.id < best.id)))
    ) {
      best = { id: story.id, share, shared };
    }
  }
  return best?.id ?? null;
}

/**
 * The story a draft tells: the one it names, else the one its words tell.
 * Null when it tells none, or names one that is not the owner's (a caller
 * refuses that separately, with {@link storyRefusal}).
 */
export function storyTold(
  stories: readonly OwnerStory[],
  draft: { text: string; ownerStoryId?: number | null },
): OwnerStory | null {
  if (draft.ownerStoryId != null) {
    return stories.find((story) => story.id === draft.ownerStoryId) ?? null;
  }
  const id = attributeOwnerStory(draft.text, stories);
  return id == null ? null : (stories.find((story) => story.id === id) ?? null);
}
