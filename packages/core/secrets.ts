import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@engager/common/crypto";
import { secrets } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * Per-org encrypted credential store. Every call MUST run inside `withOrg(orgId, …)`:
 * the `secrets.organization_id` default and the RLS predicate both come from the
 * `app.current_org` GUC, so callers never pass an organizationId — they pass the
 * org-scoped `tx` and RLS does the isolation.
 */

/** Store (upsert) an encrypted credential blob for `provider` in the current org. */
export async function putSecret(
  tx: Tx,
  provider: string,
  plaintext: string,
): Promise<void> {
  const encryptedState = encryptSecret(plaintext);
  await tx
    .insert(secrets)
    .values({ provider, encryptedState, status: "active", updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [secrets.organizationId, secrets.provider],
      set: { encryptedState, status: "active", updatedAt: Date.now() },
    });
}

/** Load + decrypt the stored secret for `provider` in the current org, or null. */
export async function getSecret(tx: Tx, provider: string): Promise<string | null> {
  const [row] = await tx.select().from(secrets).where(eq(secrets.provider, provider));
  if (!row) return null;
  return decryptSecret(row.encryptedState);
}

/** Flag a stored secret's status (e.g. "active" | "invalid" | "expired"). */
export async function markSecretStatus(
  tx: Tx,
  provider: string,
  status: string,
): Promise<void> {
  await tx
    .update(secrets)
    .set({ status, lastValidatedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(secrets.provider, provider));
}

/** Remove a stored secret for the current org (e.g. "disconnect account"). */
export async function deleteSecret(tx: Tx, provider: string): Promise<void> {
  await tx.delete(secrets).where(eq(secrets.provider, provider));
}

/**
 * Connection metadata WITHOUT decrypting — safe to surface in the UI to show
 * whether a provider is connected and when it was last validated. Returns null
 * when nothing is stored for the current org.
 */
export async function getSecretMeta(
  tx: Tx,
  provider: string,
): Promise<{ status: string; lastValidatedAt: number | null } | null> {
  const [row] = await tx
    .select({ status: secrets.status, lastValidatedAt: secrets.lastValidatedAt })
    .from(secrets)
    .where(eq(secrets.provider, provider));
  return row ?? null;
}
