export type FingerprintEntry = { path: string; sha256: string };

export function migrationFingerprint(directory: string): string;

export function migrationInventory(directory: string): FingerprintEntry[];

export function fingerprintOf(entries: readonly FingerprintEntry[]): string;

export function inventoryOrder(a: FingerprintEntry, b: FingerprintEntry): number;

export function isSnapshot(path: string): boolean;

export function pathFingerprintOf(entries: readonly FingerprintEntry[]): string;
