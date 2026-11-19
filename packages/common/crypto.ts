import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (per-org credentials, browser
 * sessions, …). Layout (base64): version(1, 0x01) || iv(12) || authTag(16) || ciphertext.
 * Blobs written before the version byte landed — versionless iv(12) || authTag(16) ||
 * ciphertext — still decrypt: decryptSecret falls back to the legacy layout whenever
 * the versioned parse doesn't apply.
 * Key comes from ENGAGER_MASTER_KEY (32 bytes, base64) — never stored in the DB.
 *
 * Leaf utility: depends only on node:crypto and the env var, so it can be lifted
 * into any package without pulling in the DB or config layers.
 */
const VERSION_1 = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

function masterKey(): Buffer {
  const raw = process.env.ENGAGER_MASTER_KEY;
  if (!raw) throw new Error("Missing required env var: ENGAGER_MASTER_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `ENGAGER_MASTER_KEY must decode to 32 bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_1]), iv, tag, ct]).toString("base64");
}

// Parses the fixed iv(12) || authTag(16) || ciphertext layout, at whatever offset
// the caller has already sliced to (0 for a legacy blob, 1 past the version byte
// for a versioned one).
function decryptIvTagCiphertext(buf: Buffer): string {
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("Ciphertext too short / corrupt");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  // GCM auth tag verification throws here if the blob was tampered with.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf[0] === VERSION_1 && buf.length >= 1 + IV_LEN + TAG_LEN) {
    try {
      return decryptIvTagCiphertext(buf.subarray(1));
    } catch {
      // A legacy (unprefixed) blob's random IV starts with 0x01 about once in 256 —
      // indistinguishable from a versioned blob by that byte alone. Retry as legacy
      // before giving up; a genuinely tampered versioned blob still fails both parses.
    }
  }
  return decryptIvTagCiphertext(buf);
}
