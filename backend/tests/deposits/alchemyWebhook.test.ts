import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  alchemyWebhookSigningKeys: { base: "base_secret" } as Record<string, string | undefined>,
}));

vi.mock("../../src/config/env.js", () => ({ env }));
vi.mock("../../src/domain/wallets/chains.js", () => ({
  getChainConfig: (chain: string) => {
    if (chain !== "base") throw new Error(`no config for ${chain}`);
    return { tokens: { USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 } } };
  },
}));

const { verifyAlchemyWebhookSignature, normalizeAlchemyPayload } = await import("../../src/domain/deposits/alchemyWebhook.js");

const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
const sign = (body: Buffer, key = "base_secret") => createHmac("sha256", key).update(body).digest("hex");

describe("verifyAlchemyWebhookSignature", () => {
  it("accepts a correct signature for a configured chain", () => {
    expect(verifyAlchemyWebhookSignature("base", rawBody, sign(rawBody))).toBe(true);
  });

  it("rejects a signature made with the wrong key", () => {
    expect(verifyAlchemyWebhookSignature("base", rawBody, sign(rawBody, "wrong"))).toBe(false);
  });

  it("fails closed for a chain with no signing key configured", () => {
    expect(verifyAlchemyWebhookSignature("ethereum", rawBody, sign(rawBody))).toBe(false);
  });

  it("rejects a missing signature or body", () => {
    expect(verifyAlchemyWebhookSignature("base", rawBody, undefined)).toBe(false);
    expect(verifyAlchemyWebhookSignature("base", undefined, sign(rawBody))).toBe(false);
  });
});

describe("normalizeAlchemyPayload", () => {
  const payload = (activity: unknown[]) => ({ event: { activity } });

  it("extracts a transfer matching a configured token contract", () => {
    const body = payload([
      {
        hash: "0xtx1",
        toAddress: "0xWallet",
        value: 12.5,
        rawContract: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, // lowercase on the wire
      },
    ]);
    expect(normalizeAlchemyPayload("base", body)).toEqual([
      { txHash: "0xtx1", toAddress: "0xWallet", tokenSymbol: "USDC", amount: "12.5" },
    ]);
  });

  it("drops a transfer whose contract isn't a configured token", () => {
    const body = payload([{ hash: "0xtx1", toAddress: "0xWallet", value: 1, rawContract: { address: "0xSomeOtherToken" } }]);
    expect(normalizeAlchemyPayload("base", body)).toEqual([]);
  });

  it("returns an empty array for a malformed or empty payload", () => {
    expect(normalizeAlchemyPayload("base", {})).toEqual([]);
    expect(normalizeAlchemyPayload("base", null)).toEqual([]);
    expect(normalizeAlchemyPayload("base", { event: {} })).toEqual([]);
  });
});
