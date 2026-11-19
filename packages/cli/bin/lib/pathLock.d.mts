export function withPathLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options?: { busyMessage?: string; timeoutMs?: number },
): Promise<T>;
