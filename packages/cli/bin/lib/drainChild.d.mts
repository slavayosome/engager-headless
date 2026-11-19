export function drainDueWork(options?: {
  maxJobs?: number;
  maxMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{ processed: number }>;
export function stopDrainChildren(): Promise<void>;
