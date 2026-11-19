import { resolveStrategy, type ResolveInput, type ResolvedAction } from "./resolve";

/** A strategy document that is not (yet) the active one, resolved as it
 *  would be: a draft before Start, a patch preview, an offer to go Automatic.
 *  What is live resolves through `modeFor`. */
export function previewModes(input: ResolveInput): ResolvedAction[] {
  return resolveStrategy(input);
}
