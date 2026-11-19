import { AppError } from "@engager/common/errors";
import type { ActiveHours } from "@engager/database/schema";

/** Canonical local-time shape accepted by campaign and setup surfaces. */
export const ACTIVE_HOUR_HH_MM_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function activeHourMinutes(value: string): number | null {
  if (!ACTIVE_HOUR_HH_MM_PATTERN.test(value)) return null;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hours * 60 + minutes;
}

export function hasValidActiveHours(
  value: Pick<ActiveHours, "start" | "end">,
): boolean {
  return (
    activeHourMinutes(value.start) !== null &&
    activeHourMinutes(value.end) !== null
  );
}

export class InvalidCampaignActiveHoursError extends AppError {
  readonly recovery =
    "Use 24-hour HH:MM values from 00:00 through 23:59. Equal start and end are allowed and mean a 24-hour window.";

  constructor() {
    super(
      "invalid_active_hours",
      "activeHours.start and activeHours.end must be valid 24-hour HH:MM values.",
      400,
    );
  }
}

export function assertValidActiveHours(
  value: Pick<ActiveHours, "start" | "end">,
): void {
  if (!hasValidActiveHours(value)) {
    throw new InvalidCampaignActiveHoursError();
  }
}
