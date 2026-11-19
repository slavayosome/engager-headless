/**
 * What the model reads of a tool, as against what the server checks.
 *
 * The broker's tool list rides the system prompt of every step of every
 * turn, so each tool carries what a call is composed from — names, types, enums,
 * requireds, formats and descriptions — and not bounds, patterns or most
 * `additionalProperties`. The registry validates every call
 * against the full schema, and its refusal names the argument that was wrong.
 * A sub-schema repeated is written once under `$defs` with a short id; the
 * SDK's own `$ref`s are paths that run to sixty characters.
 */
const SERVER_ONLY = new Set([
  "$schema", "additionalProperties", "minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "minItems", "maxItems", "pattern", "default",
]);

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => !!value && typeof value === "object" && !Array.isArray(value);

function at(root: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>(
    (node, part) => (node as Record<string, unknown> | undefined)?.[part],
    root,
  );
}

/** Every `$ref` replaced by the schema it points at. The SDK's refs are paths
 *  from the root, which nothing below this function keeps valid. */
function inlineRefs(schema: unknown, root: unknown, seen: readonly string[] = []): unknown {
  if (Array.isArray(schema)) return schema.map((item) => inlineRefs(item, root, seen));
  if (!isNode(schema)) return schema;
  const { $ref, ...rest } = schema;
  const here = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, inlineRefs(value, root, seen)]));
  if (typeof $ref !== "string") return here;
  if (seen.includes($ref)) throw new Error("recursive schema");
  return { ...(inlineRefs(at(root, $ref), root, [...seen, $ref]) as Node), ...here };
}

/** The sub-schema (as JSON) whose repetition costs the most. A copy is worth a
 *  `$defs` entry when the copies it replaces outweigh the `$ref`s and the entry. */
function costliest(schema: unknown): string | null {
  const copies = new Map<string, number>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (isNode(node)) {
      if (!node.$ref && Object.keys(node).length > 0) {
        const json = JSON.stringify(node);
        copies.set(json, (copies.get(json) ?? 0) + 1);
      }
      for (const [key, value] of Object.entries(node)) {
        if (NAME_MAPS.has(key) && isNode(value)) Object.values(value).forEach(visit);
        else visit(value);
      }
    }
  };
  visit(schema);
  let best: string | null = null;
  let saved = 0;
  for (const [json, count] of copies) {
    const gain = (count - 1) * json.length - count * REF_COST - DEF_COST;
    if (count > 1 && gain > saved) [best, saved] = [json, gain];
  }
  return best;
}

/** Objects whose keys are names, not keywords: their values are the schemas. */
const NAME_MAPS = new Set(["properties", "$defs"]);
const REF_COST = 20;
const DEF_COST = 8;

/** A sub-schema written out several times is written once under `$defs`. */
function dedupe(schema: Node): Node {
  let out: Node = schema;
  for (let id = 0; id < 40; id++) {
    const json = costliest(out);
    if (!json) break;
    const name = id.toString(36);
    const swap = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(swap);
      if (!isNode(node)) return node;
      if (!node.$ref && JSON.stringify(node) === json) return { $ref: `#/$defs/${name}` };
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [
        key,
        NAME_MAPS.has(key) && isNode(value) ? Object.fromEntries(Object.entries(value).map(([entry, sub]) => [entry, swap(sub)])) : swap(value),
      ]));
    };
    const swapped = swap(out) as Node;
    out = { ...swapped, $defs: { ...(swapped.$defs as Node | undefined), [name]: JSON.parse(json) } };
  }
  return out;
}

function trim(schema: unknown, root = false): unknown {
  if (Array.isArray(schema)) return schema.map((item) => trim(item));
  if (!isNode(schema)) return schema;
  const out: Node = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SERVER_ONLY.has(key) && !(key === "additionalProperties" && isNode(value) && Object.keys(value).length)) continue;
    // A property NAMED like a keyword is a name, not a keyword.
    out[key] = key === "properties" && isNode(value)
      ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, trim(sub)]))
      : key === "enum" || key === "const" || key === "required" ? value : trim(value);
  }
  // `{ type: "string", enum: [...] }` and `{ type: "string", const: "x" }`
  // are their values.
  if (out.type === "string" && (out.const !== undefined || Array.isArray(out.enum))) delete out.type;
  // A tool's input is always an object. A nested one keeps its type: a host
  // that finds none sends the argument as JSON text, which the registry refuses.
  if (root && out.type === "object" && isNode(out.properties)) delete out.type;
  // `string | null` is `type: ["string", "null"]`.
  const pair = out.anyOf;
  if (Array.isArray(pair) && pair.length === 2) {
    const [plain, nil] = isNode(pair[0]) && pair[0].type === "null" ? [pair[1], pair[0]] : [pair[0], pair[1]];
    if (isNode(nil) && nil.type === "null" && isNode(plain) && Array.isArray(plain.enum)) {
      delete out.anyOf;
      Object.assign(out, plain, { enum: [...plain.enum, null] });
    }
    if (isNode(nil) && nil.type === "null" && isNode(plain) && typeof plain.type === "string" && plain.enum === undefined) {
      delete out.anyOf;
      Object.assign(out, plain, { type: [plain.type, "null"] });
    }
  }
  return out;
}

export function modelSchema(schema: Node): Node {
  try {
    return dedupe(trim(inlineRefs(schema, schema), true) as Node);
  } catch {
    return trim(schema, true) as Node;
  }
}
