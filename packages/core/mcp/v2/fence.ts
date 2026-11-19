import { untrusted } from "../../ai/prompts";

/** A string with no whitespace, at most 64 characters, from the id / ref / enum
 *  alphabet carries no sentence to follow: it passes as structure. */
const STRUCTURAL = /^[A-Za-z0-9_.:\-]{1,64}$/;

/** A person's key, or a ref to one, is `p.` and the profile id LinkedIn gave
 *  them, which may be in any script (`person:p.卫平-吴-a98bb9435`). An agent hands
 *  a ref back verbatim, so one inside a fence would be one it cannot use. */
const PERSON_KEY = /^(?:person:)?p\.[\p{L}\p{M}\p{N}_.\-]{1,100}$/u;

/**
 * Fence by shape, not by field name: every string in a read that was copied
 * from a person, a post, a page or model output is fenced as untrusted data,
 * except ids, refs and enum-like tokens. Numbers, booleans and null pass.
 */
export function fenceByShape(value: unknown, field = "text"): unknown {
  if (typeof value === "string") return STRUCTURAL.test(value) || PERSON_KEY.test(value) ? value : untrusted(field.toUpperCase(), value);
  if (Array.isArray(value)) return value.map((item) => fenceByShape(item, field));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fenceByShape(item, key)]));
}
