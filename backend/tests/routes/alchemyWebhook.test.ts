import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  evmWebhookDepositsEnabled: true,
  alchemyWebhookSigningKeys: { base: "base_secret" } as Record<string, string | undefined>,
}));
const walletsRepo = vi.hoisted(() => ({ findByAddress: vi.fn() }));
const ingestDeposit = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/env.js", () => ({ env }));
vi.mock("../../src/domain/wallets/repository.js", () => ({ walletsRepo }));
vi.mock("../../src/domain/deposits/stateMachine.js", () => ({ ingestDeposit }));
vi.mock("../../src/domain/wallets/chains.js", () => ({
  getChainConfig: () => ({ tokens: { USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 } } }),
}));

const { alchemyWebhookRouter } = await import("../../src/routes/alchemyWebhook.js");
const { captureRawBody } = await import("../../src/middleware/captureRawBody.js");

let baseUrl: string;
let server: ReturnType<ReturnType<typeof express>["listen"]>;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use(alchemyWebhookRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  vi.clearAllMocks();
  env.evmWebhookDepositsEnabled = true;
});

const body = JSON.stringify({
  event: {
    activity: [
      { hash: "0xtx1", toAddress: "0xWallet", value: 5, rawContract: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" } },
    ],
  },
});
const sign = (b: string, key = "base_secret") => createHmac("sha256", key).update(b).digest("hex");

function post(chain: string, b: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/webhooks/alchemy/${chain}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: b,
  });
}

describe("POST /webhooks/alchemy/:chain", () => {
  it("ingests a correctly signed deposit for a configured chain", async () => {
    walletsRepo.findByAddress.mockResolvedValue({ id: "w1", userId: "u1" });

    const res = await post("base", body, { "x-alchemy-signature": sign(body) });

    expect(res.status).toBe(200);
    expect(ingestDeposit).toHaveBeenCalledWith({
      userId: "u1",
      walletId: "w1",
      tokenSymbol: "USDC",
      amount: "5",
      chain: "base", // from the URL, not the payload
      txHash: "0xtx1",
    });
  });

  it("rejects an unsigned request", async () => {
    const res = await post("base", body);
    expect(res.status).toBe(401);
    expect(ingestDeposit).not.toHaveBeenCalled();
  });

  it("rejects a request signed with the wrong secret", async () => {
    const res = await post("base", body, { "x-alchemy-signature": sign(body, "forged") });
    expect(res.status).toBe(401);
    expect(ingestDeposit).not.toHaveBeenCalled();
  });

  it("fails closed for a chain with no signing key configured, even with a well-formed signature", async () => {
    const res = await post("ethereum", body, { "x-alchemy-signature": sign(body) });
    expect(res.status).toBe(401);
    expect(ingestDeposit).not.toHaveBeenCalled();
  });

  it("acks but ignores when EVM_WEBHOOK_DEPOSITS_ENABLED is false", async () => {
    env.evmWebhookDepositsEnabled = false;
    const res = await post("base", body, { "x-alchemy-signature": sign(body) });
    expect(res.status).toBe(200);
    expect(ingestDeposit).not.toHaveBeenCalled();
  });

  it("acks but skips a transfer with no registered wallet", async () => {
    walletsRepo.findByAddress.mockResolvedValue(null);
    const res = await post("base", body, { "x-alchemy-signature": sign(body) });
    expect(res.status).toBe(200);
    expect(ingestDeposit).not.toHaveBeenCalled();
  });
});
