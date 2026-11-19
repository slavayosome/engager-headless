export type RunnerQuotaHealth = {
  explicitlyHealthy: boolean;
  unavailable: boolean;
};

export type NormalizedRunnerQuotaStatus =
  | "available"
  | "unavailable"
  | "exhausted"
  | "error"
  | "unknown";

export type NormalizedRunnerQuotaState = {
  status: NormalizedRunnerQuotaStatus;
  /** Lowercased/trimmed reported reason; unknown codes are preserved (for
   * diagnostics and transition logs) rather than rejected. Null when absent. */
  reasonCode: string | null;
  resetsAt: number | null;
  observedAt: number | null;
};

const UNKNOWN_QUOTA_STATE: NormalizedRunnerQuotaState = {
  status: "unknown",
  reasonCode: null,
  resetsAt: null,
  observedAt: null,
};

function normalizedEpochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded <= 0 || !Number.isSafeInteger(rounded)) return null;
  return rounded;
}

/**
 * Pure, unknown-tolerant reading of a runner-reported quotaState (the wire is
 * a free-form object during the 0.9.x legacy window). Statuses outside the
 * known set become "unknown"; "healthy" and the pre-0.9 `{available: boolean}`
 * shape map onto the current vocabulary; timestamps are clamped to positive
 * safe integers or dropped.
 */
export function normalizeQuotaState(raw: unknown): NormalizedRunnerQuotaState {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return UNKNOWN_QUOTA_STATE;
  }
  const value = raw as Record<string, unknown>;
  const rawStatus =
    typeof value.status === "string" ? value.status.trim().toLowerCase() : null;
  const status: NormalizedRunnerQuotaStatus =
    rawStatus === "healthy"
      ? "available"
      : rawStatus === "available" ||
          rawStatus === "unavailable" ||
          rawStatus === "exhausted" ||
          rawStatus === "error"
        ? rawStatus
        : value.available === true
          ? "available"
          : value.available === false
            ? "unavailable"
            : "unknown";
  const rawReason =
    typeof value.reasonCode === "string"
      ? value.reasonCode.trim().toLowerCase().slice(0, 100)
      : "";
  return {
    status,
    reasonCode: rawReason.length > 0 ? rawReason : null,
    resetsAt: normalizedEpochMs(value.resetsAt),
    observedAt: normalizedEpochMs(value.observedAt),
  };
}

/** Decode both v2.1 quota shapes accepted by the runner protocol. Older
 * runners report `{available:boolean}`; current engines report a status. */
export function runnerQuotaHealth(
  quota: Record<string, unknown> | null | undefined,
): RunnerQuotaHealth {
  if (!quota) return { explicitlyHealthy: false, unavailable: false };
  const status =
    typeof quota.status === "string" ? quota.status.toLowerCase() : null;
  return {
    explicitlyHealthy:
      quota.available === true ||
      status === "available" ||
      status === "healthy",
    unavailable:
      quota.available === false ||
      status === "unavailable" ||
      status === "exhausted" ||
      status === "error",
  };
}
