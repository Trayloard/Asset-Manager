import { companionCheckIn } from "./generated/api";
import type { CheckInInput, CheckInResult } from "./generated/api.schemas";

/**
 * Shape returned by the check-in endpoint — a persisted Message plus the
 * first-person reflection thought Empiri composed while the user was away
 * (null when the absence was too short or the AI call timed out).
 */
export type { CheckInResult } from "./generated/api.schemas";

/**
 * Generate a proactive companion check-in greeting. Returns the saved
 * assistant message together with any reflection thought that was due.
 */
export async function companionCheckInFull(
  id: number,
  checkInInput: CheckInInput,
  options?: RequestInit,
): Promise<CheckInResult> {
  return companionCheckIn(id, checkInInput, options);
}
