import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ kycProvider: "dojah", dojahSecretKey: "test_secret", adminApiKey: "admin_key" }));
const resolveKyc = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/env.js", () => ({ env }));
vi.mock("../../src/domain/kyc/service.js", () => ({ resolveKyc, startKyc: vi.fn() }));
// Only /kyc/start uses it — mocked so the test doesn't pull in Supabase auth.
vi.mock("../../src/middleware/requireAuth.js", () => ({ requireAuth: vi.fn() }));

const { kycRouter } = await import("../../src/routes/kyc.js");
const { captureRawBody } = await import("../../src/middleware/captureRawBody.js");

let baseUrl: string;
let server: ReturnType<ReturnType<typeof express>["listen"]>;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use(kycRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  resolveKyc.mockReset();
  env.kycProvider = "dojah";
});

const passed = { status: true, message: "", data: {} };
const dojahBody = JSON.stringify({
  reference_id: "dojah_0b7c8a4e-1111-4222-8333-944455556666",
  verification_status: "Completed",
  data: { id: passed, selfie: passed, government_data: passed },
});
const sign = (body: string, key = "test_secret") => createHmac("sha256", key).update(body).digest("hex");

function post(body: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/webhooks/kyc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /webhooks/kyc with KYC_PROVIDER=dojah", () => {
  it("resolves a correctly signed Dojah webhook without an admin key", async () => {
    const res = await post(dojahBody, { "x-dojah-signature": sign(dojahBody) });
    expect(res.status).toBe(200);
    expect(resolveKyc.mock.calls[0].slice(0, 2)).toEqual(["dojah_0b7c8a4e-1111-4222-8333-944455556666", "verified"]);
  });

  it("rejects an unsigned request", async () => {
    const res = await post(dojahBody);
    expect(res.status).toBe(401);
    expect(resolveKyc).not.toHaveBeenCalled();
  });

  it("rejects a request signed with the wrong secret", async () => {
    const res = await post(dojahBody, { "x-dojah-signature": sign(dojahBody, "forged") });
    expect(res.status).toBe(401);
    expect(resolveKyc).not.toHaveBeenCalled();
  });

  it("does not let the admin key stand in for a Dojah signature", async () => {
    const res = await post(dojahBody, { "x-admin-key": "admin_key" });
    expect(res.status).toBe(401);
    expect(resolveKyc).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/kyc with KYC_PROVIDER=mock", () => {
  const mockBody = JSON.stringify({ providerReference: "mock_ref_1234", decision: "verified" });

  it("still requires the admin key", async () => {
    env.kycProvider = "mock";
    const res = await post(mockBody);
    expect(res.status).toBe(401);
    expect(resolveKyc).not.toHaveBeenCalled();
  });

  it("resolves with the admin key", async () => {
    env.kycProvider = "mock";
    const res = await post(mockBody, { "x-admin-key": "admin_key" });
    expect(res.status).toBe(200);
    expect(resolveKyc.mock.calls[0].slice(0, 2)).toEqual(["mock_ref_1234", "verified"]);
  });
});
