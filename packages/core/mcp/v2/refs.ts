import { AppError } from "@engager/common/errors";
import { parseBoxKey, type ComposerBox } from "../../composer/drafts";
import { parsePersonKey, type ParsedPersonKey } from "../../people/key";

/**
 * A typed ref names one thing in one string: `msg:41`, `person:p.jane-doe`,
 * `box:comment:7`. A tool states which kinds it takes; everything else is
 * refused before a transaction opens, so a handler only ever sees an address it
 * can address.
 */
export const REF_KINDS = [
  "msg",
  "act",
  "turn",
  "person",
  "lead",
  "post",
  "offer",
  "note",
  "mem",
  "inv",
  "member",
  "box",
] as const;

export type RefKind = (typeof REF_KINDS)[number];

/** The kinds whose id is one row id. `offer:` is the product's id: a product
 *  has one offer. */
type RowKind = Exclude<RefKind, "person" | "member" | "box">;

export type Ref =
  | { kind: RowKind; id: number }
  | { kind: "person"; key: string; person: ParsedPersonKey }
  | { kind: "member"; memberId: string }
  | { kind: "box"; key: string; box: ComposerBox };

export class InvalidRefError extends AppError {
  constructor(raw: string) {
    super(
      "invalid_ref",
      `not a ref: ${JSON.stringify(raw.slice(0, 80))}. A ref is a kind and an id, like msg:41 or person:p.jane-doe (kinds: ${REF_KINDS.join(", ")}).`,
      400,
    );
  }
}

export class RefKindNotAcceptedError extends AppError {
  constructor(kind: RefKind, accepts: readonly RefKind[]) {
    super(
      "ref_kind_not_accepted",
      `${kind}: refs are not accepted here; this tool takes ${accepts.map((k) => `${k}:`).join(", ")}`,
      400,
    );
  }
}

/** A row id, at most 15 digits, so it is always a safe integer. */
const ROW_ID = /^[1-9]\d{0,14}$/;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_REF_CHARS = 400;

function isRefKind(value: string): value is RefKind {
  return (REF_KINDS as readonly string[]).includes(value);
}

/** What a ref names. Throws `ref_kind_not_accepted` for a kind outside
 *  `accepts` (all kinds when omitted) and `invalid_ref` for any other string. */
export function parseRef(raw: string, accepts: readonly RefKind[] = REF_KINDS): Ref {
  if (typeof raw !== "string" || raw.length > MAX_REF_CHARS) throw new InvalidRefError(String(raw));
  const at = raw.indexOf(":");
  const kind = raw.slice(0, at);
  const rest = raw.slice(at + 1);
  if (at < 0 || !isRefKind(kind) || rest.length === 0) throw new InvalidRefError(raw);
  const parsed = addressOf(kind, rest);
  if (parsed === null) throw new InvalidRefError(raw);
  if (!accepts.includes(kind)) throw new RefKindNotAcceptedError(kind, accepts);
  return parsed;
}

function addressOf(kind: RefKind, rest: string): Ref | null {
  switch (kind) {
    case "person": {
      const person = parsePersonKey(rest);
      return person ? { kind, key: rest, person } : null;
    }
    case "member":
      return MEMBER_ID.test(rest) ? { kind, memberId: rest } : null;
    case "box": {
      const box = parseBoxKey(rest);
      return box ? { kind, key: rest, box } : null;
    }
    default:
      return ROW_ID.test(rest) ? { kind, id: Number(rest) } : null;
  }
}
