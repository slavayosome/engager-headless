import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newLeaseToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashLeaseToken(token: string): string {
  return sha256(`engager-runner-lease:v1:${token}`);
}

export function leaseTokenMatches(token: string, expectedHash: string): boolean {
  const got = Buffer.from(hashLeaseToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

/** Hash semantically identical JSON objects identically, independent of key order. */
export function hashJson(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}

export function contextRevision(value: unknown): string {
  return `sha256:${hashJson(value)}`;
}
