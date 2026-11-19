import { contextHash as hash } from "./hash";

/**
 * The wire form of a prepared `draft` task's `sources`.
 *
 * `getCommentDraftingContext` answers per candidate, but a draft task asks it
 * once per frozen item about the SAME target, so the system prompt, the Brain,
 * the resolved voice, the slop rubric and the campaign's own config come back
 * byte-identical every time. Measured on a live install (2026-09-14), a
 * five-item task was 252,864 bytes and `sources.drafting` was 194,463 of
 * them — four copies of roughly 36 KB that the agent had already read.
 *
 * So the wire hoists every field that is byte-identical across the entries into
 * one `sources.draftingShared`, and each entry keeps what actually varies plus
 * `sharedRef`, the hash of the object its fields were lifted into. A task
 * whose candidates legitimately differ in a field — two targets, two voices —
 * keeps THAT field per item and hoists the rest, because identity is decided
 * field by field rather than declared by a list of names.
 *
 * ONE FIELD IS NEARLY IDENTICAL RATHER THAN IDENTICAL, and field identity alone
 * left it repeated. `systemPrompt` is rendered per candidate — the same
 * scaffold, the same voice, the same anti-slop rubric, differing in the length
 * tier the sampler drew for that post and the promo gate it opened — so a
 * target with an auto tone carries five ~10 KB prompts that agree everywhere
 * but two lines (a 116 KB five-item task, measured 2026-09-15; the 2026-09-14
 * measurement above had a pinned tone, which is why the hoist caught it there).
 * A prompt is blank-line-separated blocks, so the wire pools the blocks that
 * more than one entry carries into `draftingShared.blockPool.<field>` and
 * leaves the entry a `<field>Blocks` list: an index into that pool, or the
 * literal block where this candidate is the only one with it. Rebuild the
 * field by mapping the list and joining with a blank line. Pooling is adopted
 * only where it clearly pays for itself, so a field that is genuinely different
 * per candidate stays a plain string on the item.
 *
 * The split is WIRE-ONLY. `tasks.context` still holds the whole
 * per-item contexts, so the submit guard, the stored `contextRevision` the
 * agent echoes back, and the `evidence_review` phase all bind exactly the bytes
 * they bound before: the hoist cannot move a revision, because no revision is
 * computed from the wire. `sourceHashes.drafting` likewise keeps hashing the
 * stored array, shared fields included, so an agent verifying what it received
 * reads the digest it read before. `sharedRef` is informational — it says which
 * shared object an entry was cut against, and nothing is bound to it.
 */
const SHARED_REF = "sharedRef";
const SHARED_KEY = "draftingShared";
const DRAFTING_KEY = "drafting";
/** Where a pooled field's blocks live inside the shared object, and what an
 *  entry's own list of them is named. */
const POOL_KEY = "blockPool";
const BLOCKS_SUFFIX = "Blocks";
/** What a block is. A rendered prompt separates its sections with a blank
 *  line, and `split`/`join` on one separator is exactly lossless. */
const BLOCK_SEPARATOR = "\n\n";
/** A block shorter than this is left where it is: a reference costs bytes too,
 *  and pooling one-liners buys nothing while making the list unreadable. */
const POOL_MIN_BLOCK_CHARS = 40;
/** How much a pooled field must save to be worth the indirection it teaches. */
const POOL_MAX_RATIO = 2 / 3;

type Entry = { data: Record<string, unknown> };

/** A drafting entry the split can reach into: `intakeSuccess`, not an error. */
function hasData(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const data = (value as { data?: unknown }).data;
  return !!data && typeof data === "object" && !Array.isArray(data);
}

/**
 * One near-identical string field as a pool plus per-entry block lists, or null
 * when pooling it is not clearly worth the indirection.
 *
 * A block is pooled once MORE THAN ONE entry carries it, which is the same
 * identity test the field-level hoist makes, one level down: a section every
 * candidate shares is written once, and the two lines this candidate alone has
 * stay on it as literals. The pool is not deduplicated against the other
 * fields — one field, one pool, so the list an entry holds is read against a
 * single array rather than a namespace.
 */
function poolField(
  values: readonly string[],
): { pool: string[]; refs: (string | number)[][] } | null {
  const split = values.map((value) => value.split(BLOCK_SEPARATOR));
  const carriers = new Map<string, number>();
  for (const blocks of split)
    for (const block of new Set(blocks))
      carriers.set(block, (carriers.get(block) ?? 0) + 1);
  const index = new Map<string, number>();
  const pool: string[] = [];
  for (const [block, carried] of carriers)
    if (carried > 1 && block.length >= POOL_MIN_BLOCK_CHARS) {
      index.set(block, pool.length);
      pool.push(block);
    }
  if (!pool.length) return null;
  const refs = split.map((blocks) =>
    blocks.map((block) => index.get(block) ?? block),
  );
  const before = JSON.stringify(values).length;
  const after = JSON.stringify(pool).length + JSON.stringify(refs).length;
  return after <= before * POOL_MAX_RATIO ? { pool, refs } : null;
}

/**
 * The hoistable fields of a drafting array, or null when there is nothing to
 * hoist — one entry, an entry that failed to assemble, an already-hoisted
 * array, or a set of candidates that shares no field and has none worth
 * pooling.
 */
function splitDrafting(
  drafting: readonly unknown[],
): { shared: Record<string, unknown>; items: unknown[] } | null {
  if (drafting.length < 2 || !drafting.every(hasData)) return null;
  const entries = drafting as readonly Entry[];
  const first = entries[0]!.data;
  if (Object.hasOwn(first, SHARED_REF)) return null;
  const digests = entries.map(
    (entry) =>
      new Map(
        Object.entries(entry.data).map(([key, value]) => [key, hash(value)]),
      ),
  );
  const shared: Record<string, unknown> = {};
  for (const [key, digest] of digests[0]!)
    if (digests.every((other) => other.get(key) === digest))
      shared[key] = first[key];
  const pools: Record<string, string[]> = {};
  const blocks = new Map<string, (string | number)[][]>();
  // `blockPool` and `<field>Blocks` are names this split writes. A drafting
  // context that ever grows one of them owns it, so the pooling is dropped
  // rather than written over a field the agent was meant to read.
  const named = (key: string) =>
    entries.some((entry) => Object.hasOwn(entry.data, key));
  // And the name stays ON THE ITEM when they own it, hoisted or not: that makes
  // `shared.blockPool` mean exactly one thing — this split wrote it — so
  // reassembly never has to infer whose table it is reading. Without this, a
  // context owning BOTH names (an identical `blockPool` hoisted, a per-item
  // `fooBlocks` beside it) rebuilt as though the hoisted one were a pool, and
  // lost both fields. The cost is one duplicated field on a context that will
  // not exist until someone names one of ours.
  if (named(POOL_KEY)) delete shared[POOL_KEY];
  else
    for (const key of Object.keys(first)) {
      if (Object.hasOwn(shared, key) || named(key + BLOCKS_SUFFIX)) continue;
      const values = entries.map((entry) => entry.data[key]);
      if (!values.every((value) => typeof value === "string")) continue;
      const pooled = poolField(values);
      if (!pooled) continue;
      pools[key] = pooled.pool;
      blocks.set(key, pooled.refs);
    }
  const pooledKeys = [...blocks.keys()];
  if (!Object.keys(shared).length && !pooledKeys.length) return null;
  if (pooledKeys.length) shared[POOL_KEY] = pools;
  const sharedRef = hash(shared);
  return {
    shared,
    items: entries.map((entry, index) => ({
      ...entry,
      data: {
        ...Object.fromEntries(
          Object.entries(entry.data).filter(
            ([key]) => !Object.hasOwn(shared, key) && !blocks.has(key),
          ),
        ),
        ...Object.fromEntries(
          pooledKeys.map((key) => [
            key + BLOCKS_SUFFIX,
            blocks.get(key)![index]!,
          ]),
        ),
        [SHARED_REF]: sharedRef,
      },
    })),
  };
}

/**
 * The stored `sources` as the agent receives them. Every key but `drafting` is
 * passed through untouched, and a task with nothing to hoist is returned as
 * it is — including every task that is not a draft, whose `drafting` is the
 * empty array.
 */
export function wireSources(
  sources: Record<string, unknown>,
): Record<string, unknown> {
  const drafting = sources[DRAFTING_KEY];
  if (!Array.isArray(drafting)) return sources;
  const split = splitDrafting(drafting);
  if (!split) return sources;
  return { ...sources, [DRAFTING_KEY]: split.items, [SHARED_KEY]: split.shared };
}

/**
 * The block table in a shared object, which `splitDrafting` guarantees is this
 * split's own: a drafting context owning the name keeps it per item, so a
 * `blockPool` up here was never the agent's data. The shape is still checked,
 * because this reads a wire form a caller hands in.
 */
function writtenPool(
  shared: Record<string, unknown>,
): Record<string, string[] | undefined> | null {
  const pools = shared[POOL_KEY];
  if (!pools || typeof pools !== "object" || Array.isArray(pools)) return null;
  return pools as Record<string, string[] | undefined>;
}

/**
 * The inverse of the hoist: the drafting context for one frozen item, field for
 * field as it was before the split. Takes the WIRE form — what an agent holds —
 * and rebuilds one candidate's context whole.
 *
 * TEST-FACING. Nothing in the server needs it: every apply path reads the
 * stored context, which was never split. It exists so the suite can state the
 * hoist is lossless against the row itself, and it documents the reassembly an
 * external consumer of the wire form would have to do.
 */
export function reassembleDraftItem(
  task: { sources: Record<string, unknown> },
  index: number,
): unknown {
  const drafting = task.sources[DRAFTING_KEY];
  if (!Array.isArray(drafting)) throw new Error("drafting_context_absent");
  const entry = drafting[index];
  if (entry === undefined) throw new Error("drafting_item_absent");
  const shared = task.sources[SHARED_KEY];
  if (shared === undefined || !hasData(entry)) return entry;
  const { [SHARED_REF]: ref, ...rest } = entry.data;
  if (ref !== hash(shared)) throw new Error("drafting_shared_mismatch");
  const pool = writtenPool(shared as Record<string, unknown>);
  const fields = { ...(shared as Record<string, unknown>) };
  if (pool) delete fields[POOL_KEY];
  const data: Record<string, unknown> = { ...fields };
  for (const [key, value] of Object.entries(rest)) {
    const field = key.endsWith(BLOCKS_SUFFIX)
      ? key.slice(0, -BLOCKS_SUFFIX.length)
      : null;
    const blocks = field ? pool?.[field] : undefined;
    if (!field || !blocks || !Array.isArray(value)) {
      data[key] = value;
      continue;
    }
    data[field] = value
      .map((item) => {
        const block = typeof item === "number" ? blocks[item] : item;
        if (typeof block !== "string")
          throw new Error("drafting_block_missing");
        return block;
      })
      .join(BLOCK_SEPARATOR);
  }
  return { ...entry, data };
}
