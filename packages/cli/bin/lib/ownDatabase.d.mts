export function ensureOwnDatabase(
  root: string,
  env: NodeJS.ProcessEnv,
  initialize: boolean,
  deps?: unknown,
): void;

export function quietDatabaseDeps(
  env: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): unknown;

export function stopOwnDatabase(root: string, env: NodeJS.ProcessEnv): void;

export function ensureInteractiveDatabase(
  env?: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): Promise<
  | { state: "not_bundled" }
  | { state: "ready" }
  | { state: "unavailable"; code: string }
>;
