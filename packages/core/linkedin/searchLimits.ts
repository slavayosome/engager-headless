import { envInt } from "../config";

export const PAGE_LIMIT = Math.max(1, envInt("ENGAGER_DISCOVERY_PAGE_LIMIT", 25));

export function discoveryLeaseKind(channelId: number): string {
  return `discover-lock:${channelId}`;
}

export function pagesPerRun(): number {
  return Math.max(1, envInt("ENGAGER_DISCOVERY_PAGES_PER_RUN", 10));
}
