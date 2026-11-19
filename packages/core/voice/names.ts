/**
 * A VOICE'S NAME: no two voices of an org are called the same — the same
 * words, whatever their case and the space around them. A new voice or a
 * rename to a name another voice has is refused (`voiceNameTaken`); voices
 * that already share one stay as they are.
 *
 * Pure, and free of the database, so the New voice form refuses a taken name
 * as it is typed, by the rule Create holds it to.
 */

/** A name as two are compared. */
export function voiceNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** The voice among `voices` already called `name`, other than `exceptId`. */
export function voiceCalled<V extends { id: number | null; name: string }>(
  voices: readonly V[],
  name: string,
  exceptId?: number,
): V | null {
  const key = voiceNameKey(name);
  return voices.find((voice) => voice.id !== exceptId && voiceNameKey(voice.name) === key) ?? null;
}

/** What the owner is told when the name they typed is taken. */
export function voiceNameTakenWords(name: string): string {
  return `You already have a voice called “${name.trim()}”. Pick another name.`;
}
