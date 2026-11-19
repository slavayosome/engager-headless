import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { BrainSlot } from "@engager/database/schema";
import { sha256 } from "../ai/prompts";
import { config } from "../config";
import { BRAIN_SLOTS } from "./slots";

/**
 * The Brain's PARA markdown vault — INV-14's canonical knowledge store. Notes
 * are plain Obsidian-compatible markdown files with YAML frontmatter, so the
 * owner (or their agent) can open, read, and edit them directly; every server
 * read of Brain knowledge resolves from here.
 *
 * The laptop's vault is canonical and this module is its ONLY writer. In cloud
 * mode the tenant database carries a versioned, READ-ONLY replica derived from
 * these files, which the cloud materializes into its scratch
 * `ENGAGER_BRAIN_DIR` before every vault read and never edits. Derivation runs
 * one way only, files → rows: note ids are minted from the directory
 * (`nextNoteId`), so a second writer of one vault is a correctness bug rather
 * than a synchronization problem. This module still touches no table and opens
 * no connection — the replica's writer is `packages/core/brain/mirror.ts`, and
 * the one database-package reference above is an `import type`, a type and not
 * a database access.
 *
 * Every function takes an explicit `dir` (defaulting to `config.brainDir`,
 * read at call time) so each unit test suite can point at its own temp dir
 * while vitest runs test files in parallel — never `~/.engager` in tests.
 */

export type VaultNoteInput = {
  slot: string;
  content: string;
  source: string;
  title?: string;
  tags?: string[];
  sourcePath?: string;
};

export type VaultNote = {
  id: number;
  slot: BrainSlot;
  source: string;
  /** ISO timestamp — creation time, never bumped by edits. */
  created: string;
  title?: string;
  tags?: string[];
  sourcePath?: string;
  content: string;
  /** Absolute path of the note file on disk. */
  file: string;
  /** File mtime (ms) — frontmatter carries no updated field, so readers that
   * need an `updatedAt` resolve it from the file itself. */
  updatedAt: number;
};

/**
 * `changed:false` means nothing was written / moved / removed — duplicate
 * content, a missing id, an empty patch, or blank content. Mirrors the
 * KnowledgeMutation contract so vault writers aggregate into version bumps.
 */
export type VaultMutation = {
  changed: boolean;
  id?: number;
  /** Absolute path of the file just written, when one was — so a caller needs
   *  no rescan to know which file changed. Only `writeNote` reports it. */
  file?: string;
};

export type VaultNotePatch = {
  slot?: string;
  title?: string | null;
  tags?: string[] | null;
  content?: string;
  source?: string;
  sourcePath?: string | null;
};

const STORIES_SLOT = "stories";

const AREA_SLOTS: ReadonlySet<string> = new Set(
  BRAIN_SLOTS.map((entry) => entry.id).filter((id) => id !== STORIES_SLOT),
);

/** Every slot a vault note may carry — the seven `BRAIN_SLOTS` ids. The retired
 *  `product` slot has no vault folder (see `relativeNoteFolder`) and is never
 *  valid here either. */
const VALID_SLOTS: ReadonlySet<string> = new Set(BRAIN_SLOTS.map((entry) => entry.id));

function isValidSlot(slot: string): slot is BrainSlot {
  return VALID_SLOTS.has(slot);
}

function relativeNoteFolder(slot: string): string {
  if (slot === STORIES_SLOT) return path.join("3-resources", "stories");
  if (AREA_SLOTS.has(slot)) return path.join("2-areas", slot);
  throw new Error(
    `Unknown Brain slot "${slot}" — the retired "product" slot has no vault folder`,
  );
}

/** The vault folder a slot's notes live in. Throws for the retired `product` slot. */
export function noteFolder(dir: string, slot: string): string {
  return path.join(dir, relativeNoteFolder(slot));
}

/** The folders ACTIVE notes live in — the six area slots plus resources/stories. */
function activeNoteFolders(dir: string): string[] {
  return [...AREA_SLOTS]
    .map((slot) => path.join(dir, "2-areas", slot))
    .concat(path.join(dir, "3-resources", STORIES_SLOT));
}

/** Every folder that holds a note file — the active folders plus `4-archive/`.
 *  The ONE answer to "where do notes live": the id minter spends ids across
 *  this whole set, and the replica's sync walks exactly it, so neither can
 *  drift from the other. */
export function noteFolders(dir: string = config.brainDir): string[] {
  return [...activeNoteFolders(dir), path.join(dir, "4-archive")];
}

/** `<slug>-<id>` — a slug from the title-or-content prefix, the id for uniqueness. */
function slugFor(input: { title?: string; content: string; id: number }): string {
  const source = (input.title ?? input.content).trim();
  const slug =
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note";
  return `${slug}-${input.id}`;
}

export function serializeNote(note: {
  id: number;
  slot: string;
  source: string;
  created: string;
  title?: string;
  tags?: string[];
  sourcePath?: string;
  content: string;
}): string {
  const data: Record<string, unknown> = {
    id: note.id,
    slot: note.slot,
    source: note.source,
    created: note.created,
  };
  if (note.title !== undefined) data.title = note.title;
  if (note.tags !== undefined) data.tags = note.tags;
  if (note.sourcePath !== undefined) data.sourcePath = note.sourcePath;
  return matter.stringify(note.content, data);
}

/** A hand-edited vault gets typos — this is expected input, not corruption.
 *  `listNotes` backs unattended jobs (compile_campaign, refresh_brain), so one
 *  bad file must skip and let every other note through rather than fail the
 *  whole read; the warning is what keeps the skip from being silent. */
function warnSkippedSlot(file: string, slot: unknown): void {
  console.warn(
    `[vault] skipping ${file}: slot ${JSON.stringify(slot)} is not a canonical Brain slot (valid: ${[...VALID_SLOTS].join(", ")})`,
  );
}

function parseNoteFile(raw: string, file: string): VaultNote | null {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  if (typeof data.id !== "number" || !Number.isFinite(data.id)) return null;
  if (typeof data.slot !== "string" || data.slot === "") {
    warnSkippedSlot(file, data.slot);
    return null;
  }
  if (!isValidSlot(data.slot)) {
    warnSkippedSlot(file, data.slot);
    return null;
  }
  return {
    id: data.id,
    slot: data.slot,
    source: typeof data.source === "string" ? data.source : "manual",
    created:
      typeof data.created === "string"
        ? data.created
        : new Date(0).toISOString(),
    title: typeof data.title === "string" ? data.title : undefined,
    tags: Array.isArray(data.tags)
      ? data.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined,
    sourcePath:
      typeof data.sourcePath === "string" ? data.sourcePath : undefined,
    content: (
      typeof parsed.content === "string" ? parsed.content : String(parsed.content)
    ).trim(),
    file,
    updatedAt: 0,
  };
}

/** Read every note under the given folders; folders that do not exist yet are skipped. */
async function scanNotes(dir: string, folders: string[]): Promise<VaultNote[]> {
  const notes: VaultNote[] = [];
  for (const folder of folders) {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      continue; // vault (or this folder) not created yet
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = path.join(folder, entry.name);
      let fileStat;
      try {
        fileStat = await stat(file);
      } catch {
        continue;
      }
      const raw = await readFile(file, "utf8");
      const note = parseNoteFile(raw, file);
      if (!note) continue;
      note.updatedAt = fileStat.mtimeMs;
      notes.push(note);
    }
  }
  return notes;
}

function createdMs(note: VaultNote): number {
  const t = Date.parse(note.created);
  return Number.isFinite(t) ? t : 0;
}

/** created-desc with id-desc tiebreak — the recency order retrieval sorts by. */
function newestFirst(a: VaultNote, b: VaultNote): number {
  return createdMs(b) - createdMs(a) || b.id - a.id;
}

function vaultReadme(): string {
  const rows = BRAIN_SLOTS.map(
    (entry) =>
      `| \`${entry.id}\` | \`${relativeNoteFolder(entry.id)}/\` | ${entry.label} — ${entry.description} |`,
  ).join("\n");
  return [
    "# Engager Brain",
    "",
    "This is the Engager Brain — a PARA-shaped Obsidian vault and the canonical",
    "knowledge store. Every note is a plain markdown file with YAML frontmatter",
    "(`id`, `slot`, `source`, `created`, and optional `title`, `tags`,",
    "`sourcePath`); you and your agent can open, read, and edit them directly.",
    "",
    "## Slot → folder mapping",
    "",
    "| Slot | Folder | What it holds |",
    "| ---- | ------ | ------------- |",
    rows,
    "",
    "`1-projects/` holds pointers only (created empty). `3-resources/` also",
    "carries seeded raw material. `4-archive/` holds replaced or retired notes —",
    "they keep their frontmatter but leave the active set. The retired `product`",
    "slot gets no folder: product knowledge lives in the Products model.",
    "",
  ].join("\n");
}

/** Create the PARA layout — `1-projects/`, the slot folders, `4-archive/`,
 * and the README documenting the slot→folder mapping. Idempotent. */
export async function ensureVault(dir: string = config.brainDir): Promise<void> {
  await Promise.all([
    mkdir(path.join(dir, "1-projects"), { recursive: true }),
    mkdir(path.join(dir, "4-archive"), { recursive: true }),
    ...activeNoteFolders(dir).map((folder) =>
      mkdir(folder, { recursive: true }),
    ),
  ]);
  await writeFile(path.join(dir, "README.md"), vaultReadme());
}

/** All ACTIVE notes, newest first — created-desc, id-desc tiebreak. Archived
 * notes (in `4-archive/`) leave the active set and never appear here. */
export async function listNotes(dir: string = config.brainDir): Promise<VaultNote[]> {
  const notes = await scanNotes(dir, activeNoteFolders(dir));
  return notes.sort(newestFirst);
}

/** One active note by its numeric frontmatter id, or null when absent/archived. */
export async function readNote(
  id: number,
  dir: string = config.brainDir,
): Promise<VaultNote | null> {
  const notes = await listNotes(dir);
  return notes.find((note) => note.id === id) ?? null;
}

/** Max existing frontmatter id + 1, so ids are never reused. Archived notes
 * count — their ids stay spent. */
export async function nextNoteId(dir: string = config.brainDir): Promise<number> {
  const notes = await scanNotes(dir, noteFolders(dir));
  let max = 0;
  for (const note of notes) max = Math.max(max, note.id);
  return max + 1;
}

/**
 * Write one note. Dedupes on a sha256 content hash — re-storing identical
 * content (even into another slot) reports `changed:false`, which is what
 * makes re-seeding idempotent. Content is trimmed before hashing/storing;
 * blank content is refused.
 */
export async function writeNote(
  input: VaultNoteInput,
  dir: string = config.brainDir,
): Promise<VaultMutation> {
  const content = input.content.trim();
  if (!content) return { changed: false };
  const hash = sha256(content);
  for (const note of await listNotes(dir)) {
    if (sha256(note.content) === hash) return { changed: false };
  }
  const id = await nextNoteId(dir);
  const file = path.join(
    noteFolder(dir, input.slot),
    `${slugFor({ title: input.title, content, id })}.md`,
  );
  const raw = serializeNote({
    id,
    slot: input.slot,
    source: input.source,
    created: new Date().toISOString(),
    title: input.title,
    tags: input.tags,
    sourcePath: input.sourcePath,
    content,
  });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw);
  return { changed: true, id, file };
}

/**
 * Edit one note in place (id and `created` never move). A slot change moves
 * the file into the new slot's folder; a title/content change renames it to
 * the new slug. An empty patch and a blank-content edit report `changed:false`.
 */
export async function updateNote(
  id: number,
  patch: VaultNotePatch,
  dir: string = config.brainDir,
): Promise<VaultMutation> {
  const note = await readNote(id, dir);
  if (!note) return { changed: false };
  const next = {
    slot: patch.slot ?? note.slot,
    title: patch.title !== undefined ? patch.title ?? undefined : note.title,
    tags: patch.tags !== undefined ? patch.tags ?? undefined : note.tags,
    content: patch.content !== undefined ? patch.content.trim() : note.content,
    source: patch.source ?? note.source,
    sourcePath:
      patch.sourcePath !== undefined ? patch.sourcePath ?? undefined : note.sourcePath,
  };
  if (!next.content) return { changed: false }; // never blank a note's body
  const file = path.join(
    noteFolder(dir, next.slot),
    `${slugFor({ title: next.title, content: next.content, id })}.md`,
  );
  const raw = serializeNote({
    id: note.id,
    slot: next.slot,
    source: next.source,
    created: note.created,
    title: next.title,
    tags: next.tags,
    sourcePath: next.sourcePath,
    content: next.content,
  });
  const before = serializeNote({
    id: note.id,
    slot: note.slot,
    source: note.source,
    created: note.created,
    title: note.title,
    tags: note.tags,
    sourcePath: note.sourcePath,
    content: note.content,
  });
  if (file === note.file && before === raw) return { changed: false };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw);
  if (file !== note.file) await rm(note.file, { force: true });
  return { changed: true, id: note.id };
}

/** Delete one note. Missing/archived ids report `changed:false`. */
export async function removeNote(
  id: number,
  dir: string = config.brainDir,
): Promise<VaultMutation> {
  const note = await readNote(id, dir);
  if (!note) return { changed: false };
  await rm(note.file, { force: true });
  return { changed: true, id };
}

/** Move a note into `4-archive/` byte-for-byte — its frontmatter survives the
 * move; only its membership in the active set ends. */
export async function archiveNote(
  id: number,
  dir: string = config.brainDir,
): Promise<VaultMutation> {
  const note = await readNote(id, dir);
  if (!note) return { changed: false };
  const archiveDir = path.join(dir, "4-archive");
  await mkdir(archiveDir, { recursive: true });
  await rename(note.file, path.join(archiveDir, path.basename(note.file)));
  return { changed: true, id };
}
