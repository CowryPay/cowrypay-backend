import { describe, it, expect } from "vitest";
import { totalBaseUnitsFromTxPlan } from "../src/chain/usdcReadiness.js";
import type { DraftTxPlan } from "../src/schemas.js";

describe("totalBaseUnitsFromTxPlan", () => {
  it("sums payMany items", () => {
    const plan: DraftTxPlan = {
      mode: "payMany",
      items: [
        { to: "0x1", amountHuman: 1, amountBaseUnits: "1000000" },
        { to: "0x2", amountHuman: 2, amountBaseUnits: "2000000" },
      ],
    };
    expect(totalBaseUnitsFromTxPlan(plan)).toBe(3000000n);
  });

  it("multiplies payGroupEqual", () => {
    const plan: DraftTxPlan = {
      mode: "payGroupEqual",
      groupId: "1",
      amountPerMemberHuman: 10,
      amountPerMemberBaseUnits: "10000000",
      memberCount: 3,
    };
    expect(totalBaseUnitsFromTxPlan(plan)).toBe(30000000n);
  });

  it("uses payGroupSplit total", () => {
    const plan: DraftTxPlan = {
      mode: "payGroupSplit",
      groupId: "2",
      totalHuman: 15,
      totalBaseUnits: "15000000",
      memberCount: 4,
    };
    expect(totalBaseUnitsFromTxPlan(plan)).toBe(15000000n);
  });
});
