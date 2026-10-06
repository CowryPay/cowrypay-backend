import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ kycProvider: "dojah", adminApiKey: "admin_key" }));
const kycAttemptsRepo = vi.hoisted(() => ({ findByProviderReference: vi.fn() }));
const abandonKycAttempt = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/env.js", () => ({ env }));
vi.mock("../../src/domain/kyc/repository.js", () => ({ kycAttemptsRepo }));
vi.mock("../../src/domain/kyc/service.js", () => ({ abandonKycAttempt, resolveKyc: vi.fn(), startKyc: vi.fn() }));
// Injects a fixed identity instead of verifying a real Supabase token —
// same no-op-middleware technique webhookRoute.test.ts uses for the
// routes it doesn't care about, just with an authUser attached since
// /kyc/cancel's own ownership check is exactly what's under test here.
vi.mock("../../src/middleware/requireAuth.js", () => ({
  requireAuth: (req: { authUser?: { id: string } }, _res: unknown, next: () => void) => {
    req.authUser = { id: "u1" };
    next();
  },
}));

const { kycRouter } = await import("../../src/routes/kyc.js");

let baseUrl: string;
let server: ReturnType<ReturnType<typeof express>["listen"]>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(kycRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  kycAttemptsRepo.findByProviderReference.mockReset();
  abandonKycAttempt.mockReset();
});

function post(body: unknown) {
  return fetch(`${baseUrl}/kyc/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /kyc/cancel", () => {
  it("400s when providerReference is missing", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(abandonKycAttempt).not.toHaveBeenCalled();
  });

  it("404s when the attempt doesn't exist", async () => {
    kycAttemptsRepo.findByProviderReference.mockResolvedValue(null);
    const res = await post({ providerReference: "dojah_ref" });
    expect(res.status).toBe(404);
    expect(abandonKycAttempt).not.toHaveBeenCalled();
  });

  it("404s rather than 403s when the attempt belongs to someone else — doesn't confirm it exists", async () => {
    kycAttemptsRepo.findByProviderReference.mockResolvedValue({ id: "a1", userId: "someone-else", providerReference: "dojah_ref" });
    const res = await post({ providerReference: "dojah_ref" });
    expect(res.status).toBe(404);
    expect(abandonKycAttempt).not.toHaveBeenCalled();
  });

  it("abandons the caller's own attempt and always returns ok, regardless of whether anything actually changed", async () => {
    kycAttemptsRepo.findByProviderReference.mockResolvedValue({ id: "a1", userId: "u1", providerReference: "dojah_ref" });
    abandonKycAttempt.mockResolvedValue(false); // e.g. a webhook won the race — still not an error to the caller

    const res = await post({ providerReference: "dojah_ref" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(abandonKycAttempt).toHaveBeenCalledWith("a1", "u1");
  });
});
