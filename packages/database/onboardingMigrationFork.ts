import { createHash } from "node:crypto";

export type MigrationHistoryRow = { hash: string; created_at: number };

export const RELEASED_DISPATCHER_MIGRATION: MigrationHistoryRow = {
  hash: "2cb00485f1ab6c2240645e1ef9be93e91654f8b8a9dbc8e300faec0747d01785",
  created_at: 1792636974589,
};

const COMMON_HISTORY_HASH =
  "1b85d6f34ac717f78d6731cabd8e72642ebf7bc6315eff9064587da9f772d7b9";
const ONBOARDING_HISTORY: readonly MigrationHistoryRow[] = [
  {
    hash: "cbd83f71a0c9107c58f9fb14433b625c6159b8322d1c1a29d0c1345e4de17c20",
    created_at: 1792587784468,
  },
  {
    hash: "dc314b595aaab7eee2ac11141b32d38c51b0fadb092bdb5ff623d61fde8b4e8a",
    created_at: 1792608765440,
  },
  {
    hash: "07367ea8a6a0ef32de1db4e7ccc989e14e0db360654b5c6c632bf1e7a64049f3",
    created_at: 1792611332710,
  },
  {
    hash: "12907bccab16bdf5a458da584992ef8e31771e604b7e6f86f5339187e0f88afd",
    created_at: 1792654672455,
  },
  {
    hash: "5770ad0e83c9ab2f541684607fa8ad6685622bde1151df5cada3956cde22ed6a",
    created_at: 1792736211064,
  },
  {
    hash: "11c46b21758c1f8e121b4a439755d074c2ddcc9fdf3cf24ee1b746c94718e456",
    created_at: 1792736565866,
  },
  {
    hash: "9411ddb19ab791da5e046dca8ee6d2a086c3fd2dcd9ec6332bec7a7f9c1a2b0f",
    created_at: 1792737033169,
  },
  {
    hash: "e8c98881b567393e8a107afaf6567615aa7653e566522f350373444ef34f0a32",
    created_at: 1792738885105,
  },
  {
    hash: "f53484975020ef01159dda9e79fd61dde3ee30b83a8f0934555d138b8d6551d9",
    created_at: 1792743013261,
  },
  {
    hash: "5d45f46833732c979a2bc4535d25168796feddfea667c31b10ecca74dfaed4f1",
    created_at: 1792743837846,
  },
];

function same(
  left: MigrationHistoryRow | undefined,
  right: MigrationHistoryRow,
): boolean {
  return left?.hash === right.hash && left.created_at === right.created_at;
}

/** The two published branches share 0000–0256. Onboarding keeps its exact
 * 0257–0266 history; the released dispatcher's SQL is unchanged at 0267. */
export function isOnboardingMergeInventory(
  packaged: readonly MigrationHistoryRow[],
): boolean {
  return (
    packaged.length >= 268 &&
    createHash("sha256")
      .update(JSON.stringify(packaged.slice(0, 257)))
      .digest("hex") === COMMON_HISTORY_HASH &&
    ONBOARDING_HISTORY.every((row, index) =>
      same(packaged[index + 257], row),
    ) &&
    packaged[267]?.hash === RELEASED_DISPATCHER_MIGRATION.hash &&
    packaged[267].created_at > ONBOARDING_HISTORY.at(-1)!.created_at
  );
}

/** Only the exact released main history may take the fork reconciliation.
 * Missing, changed or additional rows are never inferred to be equivalent. */
export function isReleasedMainMigrationFork(
  packaged: readonly MigrationHistoryRow[],
  applied: readonly MigrationHistoryRow[],
): boolean {
  return (
    isOnboardingMergeInventory(packaged) &&
    applied.length === 258 &&
    applied.slice(0, 257).every((row, index) => same(packaged[index], row)) &&
    same(applied[257], RELEASED_DISPATCHER_MIGRATION)
  );
}
