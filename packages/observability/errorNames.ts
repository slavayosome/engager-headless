// Pure, with no Node imports, because the dashboard's pages import it: the
// browser bundle must not pull in the catalog (which hashes with node:crypto).
/** The standard error classes, by name. Anything else (a custom class, a
 * minified name) is `other`: a class name is code, but a custom one is the
 * nearest an error gets to carrying text. */
export const ERROR_NAMES = [
  "Error",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "URIError",
  "AggregateError",
  "ChunkLoadError",
  "NetworkError",
  "TimeoutError",
  "other",
] as const;

export type ErrorName = (typeof ERROR_NAMES)[number];

export function errorNameOf(value: unknown): ErrorName {
  const name = typeof value === "object" && value !== null ? (value as { name?: unknown }).name : value;
  return typeof name === "string" && (ERROR_NAMES as readonly string[]).includes(name)
    ? (name as ErrorName)
    : "other";
}

