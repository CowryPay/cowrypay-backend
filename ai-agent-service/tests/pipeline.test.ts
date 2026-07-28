import { describe, it, expect, beforeEach } from "vitest";
import { createDefaultRegistry } from "../src/resolvers.js";
import { createMockResolutionDeps } from "../src/deps/mockResolution.js";
import { handleUserMessage, paymentFromIntent } from "../src/pipeline.js";
import { ruleParse } from "../src/ruleParser.js";
import { resetStores } from "../src/state.js";
import type { ParsedIntent } from "../src/schemas.js";

const parseFromRules = async (text: string): Promise<ParsedIntent> => {
  const r = ruleParse(text);
  return r ?? { kind: "unknown", rawSummary: "no rule" };
};

function mockDeps() {
  return createMockResolutionDeps(createDefaultRegistry());
}

beforeEach(() => {
  resetStores();
});

describe("ruleParse", () => {
  it("parses casual USD group send", () => {
    const p = ruleParse("i want to send $100 to group Friends");
    expect(p).toMatchObject({
      kind: "payment",
      action: "SEND_TO_GROUP",
      perRecipientAmount: 100,
      groupName: "Friends",
    });
  });

  it("parses register as name", () => {
    expect(ruleParse("register as mack")).toMatchObject({
      kind: "admin",
      action: "REGISTER_USERNAME",
      username: "mack",
    });
  });

  it("parses send with explicit USDC token", () => {
    expect(ruleParse("Send 1 USDC to @simi")).toMatchObject({
      kind: "payment",
      action: "SEND_SINGLE",
      amount: 1,
      recipient: "simi",
      token: "USDC",
    });
  });

  it("parses send with explicit USDm token", () => {
    expect(ruleParse("send 5 usdm to @alice")).toMatchObject({
      kind: "payment",
      action: "SEND_SINGLE",
      amount: 5,
      recipient: "alice",
      token: "USDm",
    });
  });

  it("parses approve usdc for cowry", () => {
    expect(ruleParse("approve 250 usdc for cowry")).toMatchObject({
      kind: "admin",
      action: "APPROVE_USDC",
      amount: 250,
      token: "USDC",
    });
  });

  it("parses split total across group", () => {
    expect(ruleParse("split $200 across group Team")).toMatchObject({
      kind: "payment",
      action: "GROUP_SPLIT_TOTAL",
      amount: 200,
      groupName: "Team",
    });
  });

  it("parses add and cancel group", () => {
    expect(ruleParse("add @tolu to group 7")).toMatchObject({
      kind: "admin",
      action: "ADD_MEMBERS",
      groupId: "7",
      members: ["tolu"],
    });
    expect(ruleParse("cancel group 4")).toMatchObject({
      kind: "admin",
      action: "CANCEL_GROUP",
      groupId: "4",
    });
  });
});

describe("paymentFromIntent", () => {
  it("resolves SEND_SINGLE", async () => {
    const deps = mockDeps();
    const intent: ParsedIntent = {
      kind: "payment",
      action: "SEND_SINGLE",
      amount: 2000,
      recipient: "tolu",
    };
    const r = await paymentFromIntent(intent, deps, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.recipients).toHaveLength(1);
      expect(r.draft.totalAmount).toBe(2000);
      expect(r.draft.txPlan.mode).toBe("pay");
    }
  });

  it("rejects unknown user", async () => {
    const deps = mockDeps();
    const intent: ParsedIntent = {
      kind: "payment",
      action: "SEND_SINGLE",
      amount: 100,
      recipient: "nobody",
    };
    const r = await paymentFromIntent(intent, deps, undefined);
    expect(r.ok).toBe(false);
  });
});

describe("handleUserMessage", () => {
  it("draft then confirm returns tx_ready", async () => {
    const deps = mockDeps();
    const d1 = await handleUserMessage(
      "s1",
      "send 2000 to @tolu",
      deps,
      parseFromRules,
    );
    expect(d1.type).toBe("draft");

    const d2 = await handleUserMessage("s1", "confirm", deps, parseFromRules);
    expect(d2.type).toBe("tx_ready");
    if (d2.type === "tx_ready") {
      expect(d2.tx.transactions.length).toBe(1);
      expect(d2.tx.transactions[0]!.data).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(d2.tx.token.decimals).toBe(6);
      expect(d2.tx.token.symbol).toBe("USDC");
    }
  });

  it("cancel clears draft", async () => {
    const deps = mockDeps();
    await handleUserMessage("s2", "send 500 to @ada", deps, parseFromRules);
    const c = await handleUserMessage("s2", "cancel", deps, parseFromRules);
    expect(c.type).toBe("cancelled");
    const again = await handleUserMessage("s2", "confirm", deps, parseFromRules);
    expect(again.type).toBe("info");
  });

  it("group payment expands members (mock payMany)", async () => {
    const deps = mockDeps();
    const d = await handleUserMessage(
      "s3",
      "send 100 to everyone in Friends",
      deps,
      parseFromRules,
    );
    expect(d.type).toBe("draft");
    if (d.type === "draft") {
      expect(d.recipients).toHaveLength(3);
      expect(d.totalAmount).toBe(300);
    }
  });

  it("create group then pay into it", async () => {
    const deps = mockDeps();
    const info = await handleUserMessage(
      "s4",
      'create group Testers with @tolu, @ada',
      deps,
      parseFromRules,
    );
    expect(info.type).toBe("info");

    const draft = await handleUserMessage(
      "s4",
      "send 50 to everyone in Testers",
      deps,
      parseFromRules,
    );
    expect(draft.type).toBe("draft");
    if (draft.type === "draft") {
      expect(draft.recipients).toHaveLength(2);
    }
  });
});
