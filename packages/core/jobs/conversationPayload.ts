/** Normalize jobs queued before the person-history rename. */
export function conversationPayload<T extends { conversationId: number }>(payload: T): T {
  if (payload == null || typeof payload !== "object") return payload;
  const legacy = payload as T & { journeyId?: unknown };
  if (legacy.journeyId === undefined) return payload;
  if (payload.conversationId !== undefined && payload.conversationId !== legacy.journeyId) {
    throw new Error("conflicting_conversation_id");
  }
  return { ...payload, conversationId: legacy.journeyId as number };
}
