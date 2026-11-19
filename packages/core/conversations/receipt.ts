import { z } from "zod";
import { OUTCOME_TYPES, type OutcomeType } from "@engager/database/schema";

/** The most rows one import may carry. */
export const RECEIPT_MAX_ROWS = 500;

/**
 * One row of a receipt as the owner hands it over — the same fields whether it
 * arrives as JSON or as a CSV column. `occurredAt` is epoch milliseconds or an
 * ISO-8601 time; `conversationId` is the owner naming the person; `customerRef` is
 * an identifier the person gave themselves (the email they booked with); a row
 * that cancels or refunds names the row it reverses by
 * `supersedesSourceEventId`.
 */
export const receiptRowShape = {
  sourceEventId: z.string().trim().min(1).max(200),
  type: z.enum(OUTCOME_TYPES),
  occurredAt: z.union([z.number().int().positive(), z.string().trim().min(1).max(40)]),
  conversationId: z.union([z.number().int().positive(), z.string().trim().regex(/^\d+$/)]).optional(),
  customerRef: z.string().trim().min(1).max(320).optional(),
  supersedesSourceEventId: z.string().trim().min(1).max(200).optional(),
};

const receiptRowSchema = z.object(receiptRowShape).strict();

export type ReceiptRowInput = z.input<typeof receiptRowSchema>;

export type ReceiptRow = {
  sourceEventId: string;
  type: OutcomeType;
  occurredAt: number;
  conversationId: number | null;
  customerRef: string | null;
  supersedesSourceEventId: string | null;
};

export type ParsedReceipt =
  | { ok: true; rows: ReceiptRow[] }
  /** `row` is 1-based, counting data rows only. */
  | { ok: false; row: number | null; message: string };

/** Validate a receipt given as rows or as CSV text (a header row naming the
 *  fields above, then one row per event; an empty cell is an absent field). */
export function parseReceipt(input: {
  rows?: ReceiptRowInput[];
  csv?: string;
}): ParsedReceipt {
  if ((input.rows === undefined) === (input.csv === undefined)) {
    return { ok: false, row: null, message: "pass exactly one of `rows` or `csv`" };
  }
  let raw: unknown[];
  if (input.csv !== undefined) {
    const table = parseCsv(input.csv);
    if (!table.ok) return { ok: false, row: null, message: table.message };
    raw = table.records;
  } else {
    raw = input.rows!;
  }
  if (raw.length === 0) return { ok: false, row: null, message: "the receipt has no rows" };
  if (raw.length > RECEIPT_MAX_ROWS) {
    return {
      ok: false,
      row: null,
      message: `the receipt has ${raw.length} rows; one import takes at most ${RECEIPT_MAX_ROWS}`,
    };
  }
  const rows: ReceiptRow[] = [];
  for (const [index, candidate] of raw.entries()) {
    const parsed = receiptRowSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return {
        ok: false,
        row: index + 1,
        message: `${issue.path.join(".") || "row"}: ${issue.message}`,
      };
    }
    const occurredAt = toEpochMs(parsed.data.occurredAt);
    if (occurredAt === null) {
      return {
        ok: false,
        row: index + 1,
        message: "occurredAt: expected epoch milliseconds or an ISO-8601 time",
      };
    }
    rows.push({
      sourceEventId: parsed.data.sourceEventId,
      type: parsed.data.type,
      occurredAt,
      conversationId: parsed.data.conversationId === undefined ? null : Number(parsed.data.conversationId),
      customerRef: parsed.data.customerRef ?? null,
      supersedesSourceEventId: parsed.data.supersedesSourceEventId ?? null,
    });
  }
  return { ok: true, rows };
}

/** Epoch milliseconds from a number, a string of digits, or an ISO-8601 time
 *  (date first, so a locale's `10/11/2026` is never guessed at). */
function toEpochMs(value: number | string): number | null {
  if (typeof value === "number") return value;
  if (/^\d+$/.test(value)) return Number(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * RFC 4180 CSV into one record per data row, keyed by the header. Quoted
 * fields may hold commas, newlines and doubled quotes; empty cells are left
 * out, so an empty column reads as an absent field. A leading byte-order mark
 * — what a spreadsheet's "CSV UTF-8" export starts with — is not part of the
 * first header.
 */
function parseCsv(
  csv: string,
): { ok: true; records: Record<string, string>[] } | { ok: false; message: string } {
  const text = csv.replace(/^﻿/, "");
  const lines: string[][] = [];
  let line: string[] = [];
  let field = "";
  let quoted = false;
  let fieldWasQuoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "" && !fieldWasQuoted) {
      quoted = true;
      fieldWasQuoted = true;
    } else if (char === ",") {
      line.push(field);
      field = "";
      fieldWasQuoted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      line.push(field);
      lines.push(line);
      line = [];
      field = "";
      fieldWasQuoted = false;
    } else {
      field += char;
    }
  }
  if (quoted) return { ok: false, message: "the CSV ends inside a quoted field" };
  if (field !== "" || fieldWasQuoted || line.length > 0) {
    line.push(field);
    lines.push(line);
  }
  const nonEmpty = lines.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  const [header, ...data] = nonEmpty;
  if (!header) return { ok: false, message: "the CSV has no header row" };
  const names = header.map((name) => name.trim());
  const records: Record<string, string>[] = [];
  for (const [index, cells] of data.entries()) {
    if (cells.length !== names.length) {
      return {
        ok: false,
        message: `CSV row ${index + 1} has ${cells.length} cells; the header names ${names.length}`,
      };
    }
    const record: Record<string, string> = {};
    for (const [column, name] of names.entries()) {
      const cell = cells[column]!.trim();
      if (cell !== "") record[name] = cell;
    }
    records.push(record);
  }
  return { ok: true, records };
}
