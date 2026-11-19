/** Markers retained from imported history must continue to block duplicate sends. */
export const FREE_WORKSPACE_HISTORY_MODEL = "import:free-workspace";
export const FREE_WORKSPACE_LEDGER_SOURCE = "free_workspace";

export function hasBlockingSendHistory(media: unknown): boolean {
  return blockingSendHistory(media).length > 0;
}

/**
 * Those markers themselves, unread: how MANY comments this row says went out,
 * which is what an export compares against the lines it managed to write. It
 * returns the raw items rather than parsed attempts for the same reason the
 * check above exists — a marker too malformed to write is still a send.
 */
export function blockingSendHistory(media: unknown): unknown[] {
  const record = (media as { freeWorkspace?: unknown } | null)?.freeWorkspace;
  if (!record || typeof record !== "object") return [];
  const attempts = (record as { attempts?: unknown }).attempts;
  if (!Array.isArray(attempts)) return [];
  return attempts.filter((attempt) => {
    const outcome = (attempt as { outcome?: unknown } | null)?.outcome;
    return outcome === "posted" || outcome === "uncertain";
  });
}
