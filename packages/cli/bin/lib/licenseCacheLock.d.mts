export function withLicenseRefreshLock<T>(
  cachePath: string,
  work: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T>;
