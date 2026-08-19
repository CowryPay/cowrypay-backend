export interface KycSession {
  providerReference: string;
  // Where the client sends the user to complete ID + liveness verification.
  // Undefined for the mock adapter — there's nothing to redirect to.
  redirectUrl?: string;
}

// Framework-agnostic slice of an incoming webhook request — just what a
// signature check actually needs, not a hard Express dependency in the
// domain layer. headers keys are expected lowercase (Express already
// normalizes them that way).
export interface WebhookRequest {
  rawBody: Buffer | undefined;
  headers: Record<string, string | undefined>;
}

// Implemented by whichever KYC vendor does ID + liveness verification
// (Smile ID / Youverify / Dojah in production, a mock in dev). Callers
// depend only on this interface.
//
// verifyWebhookSignature exists specifically so /webhooks/kyc's real
// security boundary can't be forgotten when a real vendor is finally
// wired up: POST /kyc/start hands the calling user their own
// providerReference, and until a vendor exists to verify a signature
// against, the endpoint is only safe because it's gated behind the admin
// key (see routes/kyc.ts's own comment) — a real, non-negotiable stopgap,
// not the intended final state. Making this part of the interface means
// the compiler itself refuses to let a new adapter skip it, mirroring how
// verifyPaycrestSignature/verifyBlockradarSignature already work for
// their own webhooks (HMAC over the raw body, timingSafeEqual compare) —
// each real vendor's own header name and algorithm live inside its own
// adapter, not hardcoded into the shared route.
export interface KycAdapter {
  startVerification(input: { userId: string; email: string | null }): Promise<KycSession>;
  verifyWebhookSignature(req: WebhookRequest): boolean;
}
