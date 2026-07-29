export interface KycSession {
  providerReference: string;
  // Where the client sends the user to complete ID + liveness verification.
  // Undefined for the mock adapter — there's nothing to redirect to.
  redirectUrl?: string;
}

// Implemented by whichever KYC vendor does ID + liveness verification
// (Smile ID / Youverify / Dojah in production, a mock in dev). Callers
// depend only on this interface.
export interface KycAdapter {
  startVerification(input: { userId: string; email: string | null }): Promise<KycSession>;
}
