import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// env.ts throws at import without DATABASE_URL/SUPABASE_URL — the adapter
// only needs the Dojah secret, so mock just that.
vi.mock("../../src/config/env.js", () => ({ env: { dojahSecretKey: "test_secret" } }));

const { dojahKycAdapter } = await import("../../src/domain/kyc/dojahAdapter.js");

const step = (status: boolean) => ({ status, message: "", data: {} });

// Trimmed from Dojah's documented EasyOnboard sample payload.
function payload(overrides: Record<string, unknown> = {}) {
  return {
    reference_id: "dojah_0b7c8a4e-1111-4222-8333-944455556666",
    verification_status: "Completed",
    status: true,
    aml: { status: false },
    data: {
      index: step(true),
      user_data: step(true),
      government_data: step(true),
      id: step(true),
      selfie: step(true),
      business_data: { business_name: null, business_type: "BN" },
      additional_document: [{ document_type: "image", document_url: "https://example.test/doc.jpg" }],
    },
    ...overrides,
  };
}

describe("dojahKycAdapter.startVerification", () => {
  it("returns a reference of at least 10 chars and no redirectUrl", async () => {
    const session = await dojahKycAdapter.startVerification({ userId: "u1", email: null });
    expect(session.providerReference).toMatch(/^dojah_[0-9a-f-]{36}$/);
    expect(session.redirectUrl).toBeUndefined();
  });
});

describe("dojahKycAdapter.verifyWebhookSignature", () => {
  const rawBody = Buffer.from(JSON.stringify(payload()));
  const sign = (body: Buffer, key = "test_secret") => createHmac("sha256", key).update(body).digest("hex");

  it("accepts a correct signature over the raw body", () => {
    expect(dojahKycAdapter.verifyWebhookSignature({ rawBody, headers: { "x-dojah-signature": sign(rawBody) } })).toBe(true);
  });

  it("rejects a signature made with the wrong key", () => {
    expect(
      dojahKycAdapter.verifyWebhookSignature({ rawBody, headers: { "x-dojah-signature": sign(rawBody, "wrong") } }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(rawBody.toString().replace("Completed", "Completed "));
    expect(dojahKycAdapter.verifyWebhookSignature({ rawBody: tampered, headers: { "x-dojah-signature": sign(rawBody) } })).toBe(
      false,
    );
  });

  it("rejects a missing signature or body", () => {
    expect(dojahKycAdapter.verifyWebhookSignature({ rawBody, headers: {} })).toBe(false);
    expect(dojahKycAdapter.verifyWebhookSignature({ rawBody: undefined, headers: { "x-dojah-signature": sign(rawBody) } })).toBe(
      false,
    );
  });
});

describe("dojahKycAdapter.parseWebhookResult", () => {
  const ref = payload().reference_id;

  it("verifies when Completed and every status-bearing step passed", () => {
    expect(dojahKycAdapter.parseWebhookResult(payload())).toEqual({ providerReference: ref, decision: "verified" });
  });

  it("rejects when Completed but a step failed, even with top-level status true", () => {
    const body = payload();
    body.data = { ...body.data, address: step(false) };
    expect(dojahKycAdapter.parseWebhookResult(body)).toEqual({ providerReference: ref, decision: "rejected" });
  });

  it("rejects a Completed payload with no status-bearing steps (fails closed)", () => {
    expect(dojahKycAdapter.parseWebhookResult(payload({ data: undefined }))).toEqual({ providerReference: ref, decision: "rejected" });
    expect(dojahKycAdapter.parseWebhookResult(payload({ data: { business_data: {} } }))).toEqual({
      providerReference: ref,
      decision: "rejected",
    });
  });

  it("treats a non-boolean step status as not passed", () => {
    const body = payload();
    body.data = { ...body.data, selfie: { status: "true", message: "", data: {} } as never };
    expect(dojahKycAdapter.parseWebhookResult(body)).toEqual({ providerReference: ref, decision: "rejected" });
  });

  it.each(["Failed", "Abandoned"])("rejects on %s", (verification_status) => {
    expect(dojahKycAdapter.parseWebhookResult(payload({ verification_status }))).toEqual({
      providerReference: ref,
      decision: "rejected",
    });
  });

  it.each(["Ongoing", "Pending"])("returns null for non-terminal %s", (verification_status) => {
    expect(dojahKycAdapter.parseWebhookResult(payload({ verification_status }))).toBeNull();
  });

  it("returns null for an unparseable body", () => {
    expect(dojahKycAdapter.parseWebhookResult(payload({ reference_id: undefined }))).toBeNull();
    expect(dojahKycAdapter.parseWebhookResult("not json")).toBeNull();
    expect(dojahKycAdapter.parseWebhookResult(null)).toBeNull();
  });
});
