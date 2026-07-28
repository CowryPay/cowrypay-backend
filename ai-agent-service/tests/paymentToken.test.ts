import { describe, it, expect } from "vitest";
import { ruleParse } from "../src/ruleParser.js";
import { getTokenBySymbol } from "../src/chain/tokenConfig.js";

describe("multi-token parsing", () => {
  it("parses USDC in send single", () => {
    const p = ruleParse("Send 1 USDC to @simi");
    expect(p).toMatchObject({
      kind: "payment",
      action: "SEND_SINGLE",
      amount: 1,
      recipient: "simi",
      token: "USDC",
    });
  });

  it("parses USDm in send single", () => {
    const p = ruleParse("send 3 usdm to @bob");
    expect(p).toMatchObject({
      kind: "payment",
      action: "SEND_SINGLE",
      token: "USDm",
    });
  });

  it("maps symbols to correct decimals", () => {
    expect(getTokenBySymbol("USDC").decimals).toBe(6);
    expect(getTokenBySymbol("USDm").decimals).toBe(18);
  });
});
