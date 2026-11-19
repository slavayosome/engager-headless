/** Advice about current room evidence, never a reason to stop a sweep. */
export function notFindingAudience(source: { status: string; cursorReason: string }, room: { roomsRead: number; distinctMatchingPeople: number }): boolean {
  return (source.status === "active" || source.status === "parked") &&
    !(source.status === "parked" && source.cursorReason === "refused") &&
    room.roomsRead >= 5 && room.distinctMatchingPeople === 0;
}
