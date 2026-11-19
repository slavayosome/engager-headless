import type {
  DisabledLearnedEdit,
  LearnedChannelEdits,
  LearnedDirectives,
  LearnedEdit,
  LearnedEditKind,
  Voice,
} from "@engager/database/schema";
import type { WritingChannel } from "../voice";

/**
 * A VOICE'S HABITS FROM REWRITES, channel by channel. Each channel learns
 * from the owner's rewrites of its own drafts (`refreshLearnedDirectives`),
 * and its drafts follow only its own: a habit from DMs never changes a
 * comment. Comment's sit at the top level of `learned_directives`, where every
 * release reads them; a reply's and a DM's under `byChannel`.
 */

/** One channel's habits as a voice holds them; null before it has any. */
export function learnedEditsIn(
  learned: LearnedDirectives | null | undefined,
  channel: WritingChannel,
): LearnedChannelEdits | null {
  if (!learned) return null;
  return channel === "comment" ? learned : (learned.byChannel?.[channel] ?? null);
}

/** How `disabled_directives` keeps one channel's habit switched off: a
 *  comment's by its kind, a reply's or a DM's qualified by its channel. */
export function disabledEditKey(channel: WritingChannel, kind: LearnedEditKind): DisabledLearnedEdit {
  return channel === "comment" ? kind : `${channel}:${kind}`;
}

/** The habits the owner switched off for one channel, by kind. */
export function forgottenIn(
  disabled: readonly DisabledLearnedEdit[],
  channel: WritingChannel,
): LearnedEditKind[] {
  const prefix = channel === "comment" ? null : `${channel}:`;
  return disabled.flatMap((key): LearnedEditKind[] => {
    if (prefix === null) return key.includes(":") ? [] : [key as LearnedEditKind];
    return key.startsWith(prefix) ? [key.slice(prefix.length) as LearnedEditKind] : [];
  });
}

/** The learned edits a writer follows for one channel of this voice —
 *  directives and cut moves — less what the owner switched off there. */
export function activeDirectives(
  voice: Pick<Voice, "learnedDirectives" | "disabledDirectives"> | null | undefined,
  channel: WritingChannel = "comment",
): LearnedEdit[] {
  const learned = learnedEditsIn(voice?.learnedDirectives, channel);
  if (!voice || !learned) return [];
  const off = new Set(forgottenIn(voice.disabledDirectives, channel));
  return [...learned.directives, ...(learned.moves ?? [])].filter((d) => !off.has(d.kind));
}
