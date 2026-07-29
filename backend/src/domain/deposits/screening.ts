import { env } from "../../config/env.js";

export interface ScreeningResult {
  clear: boolean;
  reason?: string;
}

// Placeholder for the real AML/sanctions screening vendor (§7.5 of the
// architecture doc). Flags deposits at or above a configurable mock
// threshold purely so the MANUAL_REVIEW branch of the state machine is
// exercisable before a real screening provider is wired in.
export async function screenDeposit(amount: string): Promise<ScreeningResult> {
  const numeric = Number(amount);
  if (numeric >= env.mockScreeningFlagThreshold) {
    return { clear: false, reason: "amount_above_mock_threshold" };
  }
  return { clear: true };
}
