/**
 * How long work run inside the owner's own session may hold a tool call.
 *
 * An MCP tool call is a chat turn, and a host gives it far less patience than
 * the work sometimes needs: Claude Code's default MCP tool timeout is 60 s, so
 * anything slower answers the owner with "Request timed out" while the server
 * is still working — the transport failure this whole in-session fallback
 * exists to remove.
 *
 * So bounded work is RACED, never cancelled. Inside the bound the reply is the
 * real answer; past it the reply says the work STARTED, the work keeps going on
 * this same server process, and what it produced is read back from a durable
 * record rather than from the call that is already gone.
 *
 * Its own module because both sides of that contract need it — `executor.ts`
 * for `runPhasesInSession`, `task.ts` for the prepared sweep — and
 * `executor.ts` already imports `task.ts`, so a constant living in either one
 * makes the pair circular. One bound, one home, no cycle.
 */
export const IN_SESSION_BOUND_MS = 20_000;
