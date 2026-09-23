// Identity details the vendor actually verified (from the ID document or
// government registry, not what the user typed) — what AML screening runs
// against (KYC issue #6). Optional: not every vendor or flow returns them.
export interface KycSubject {
  name: string;
  dateOfBirth?: string;
  nationality?: string;
}

export interface KycResult {
  providerReference: string;
  decision: "verified" | "rejected";
  subject?: KycSubject;
}

export interface KycSession {
  providerReference: string;
  // Where the client sends the user to complete ID + liveness verification.
  // Undefined for the mock adapter — there's nothing to redirect to.
  redirectUrl?: string;
  // Which Dojah widget to launch — no longer a single static frontend
  // value once a second EasyOnboard workflow exists for countries where
  // Government Data isn't available (see dojahAdapter.ts). Undefined for
  // the mock adapter, which has no widget at all.
  widgetId?: string;
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
  // country is which country the user is verifying from — required
  // routing input, not optional metadata: Dojah's own Government Data
  // step only supports Nigeria/Kenya (confirmed live 2026-09-22/23), so a
  // real vendor needs this to pick the right workflow/widget. The mock
  // adapter ignores it.
  startVerification(input: { userId: string; email: string | null; country: string }): Promise<KycSession>;
  verifyWebhookSignature(req: WebhookRequest): boolean;
  // Turns a vendor's own webhook body into the normalized pair
  // resolveKyc() actually needs. Adapter-owned for the same reason
  // verifyWebhookSignature is: each vendor's real payload shape (field
  // names, how "did it actually pass" is derived) lives inside its own
  // adapter, not hardcoded into the shared route — see KYC issue #4's own
  // reasoning (Dojah's top-level verification_status only means the flow
  // finished, not that it passed; real pass/fail needs each nested
  // per-step result inspected). Returns null for a payload that doesn't
  // parse OR a legitimate non-terminal event (e.g. still in progress) —
  // both cases mean "nothing to resolve yet," not an error worth a 400.
  parseWebhookResult(body: unknown): KycResult | null;
}
