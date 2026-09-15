import { beforeEach, describe, expect, it, vi } from "vitest";

const screenIndividual = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() => ({ amlRecipientScreeningEnabled: true, amlMatchThreshold: 0.85 }));

vi.mock("../../src/domain/aml/dojahScreening.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  screenIndividual,
}));
vi.mock("../../src/config/env.js", () => ({ env: envMock }));
vi.mock("../../src/db/pool.js", () => ({
  pool: { query },
  withTransaction: (fn: (c: unknown) => unknown) => fn({ query }),
}));

const { computeFingerprint, screenRecipient, reviewRecipientScreening, listRecipientScreeningsAwaitingReview } = await import(
  "../../src/domain/aml/recipientScreening.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  envMock.amlRecipientScreeningEnabled = true;
});

const recipient = { accountName: "John Doe", accountIdentifier: "0123456789" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "rs1",
    fingerprint: computeFingerprint(recipient, "NGN"),
    account_name: "John Doe",
    account_identifier: "0123456789",
    fiat_currency: "NGN",
    provider: "dojah",
    status: "clear",
    match_status: "No Match",
    risk_level: "Low",
    entity_id: "ent_1",
    response: {},
    error: null,
    review_decision: null,
    review_note: null,
    reviewed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("computeFingerprint", () => {
  it("is stable across case/whitespace differences in the name", () => {
    const a = computeFingerprint({ accountName: "John Doe", accountIdentifier: "0123456789" }, "NGN");
    const b = computeFingerprint({ accountName: "  john   doe  ", accountIdentifier: "0123456789" }, "ngn");
    expect(a).toBe(b);
  });

  it("differs when the name changes on the same account", () => {
    const a = computeFingerprint({ accountName: "John Doe", accountIdentifier: "0123456789" }, "NGN");
    const b = computeFingerprint({ accountName: "Jane Doe", accountIdentifier: "0123456789" }, "NGN");
    expect(a).not.toBe(b);
  });

  it("differs across currencies for the same account number", () => {
    const a = computeFingerprint(recipient, "NGN");
    const b = computeFingerprint(recipient, "KES");
    expect(a).not.toBe(b);
  });
});

describe("screenRecipient", () => {
  it("returns a cached verdict without calling Dojah", async () => {
    query.mockResolvedValueOnce({ rows: [row({ status: "blocked" })] });

    const result = await screenRecipient(recipient, "NGN");

    expect(result.status).toBe("blocked");
    expect(screenIndividual).not.toHaveBeenCalled();
  });

  it("skips screening and returns clear when the flag is off, without calling Dojah or storing a row", async () => {
    envMock.amlRecipientScreeningEnabled = false;
    query.mockResolvedValueOnce({ rows: [] }); // no cached row

    const result = await screenRecipient(recipient, "NGN");

    expect(result.status).toBe("clear");
    expect(screenIndividual).not.toHaveBeenCalled();
  });

  it("screens a brand-new recipient and caches the outcome", async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no cached row
    screenIndividual.mockResolvedValue({ entity: { match_status: "No Match", risk_level: "Low", entity_id: "ent_1", results: [] } });
    query.mockResolvedValueOnce({ rows: [row({ status: "clear" })] }); // insert ... returning

    const result = await screenRecipient(recipient, "NGN");

    expect(result.status).toBe("clear");
    expect(screenIndividual).toHaveBeenCalledWith({ name: "John Doe" }, expect.stringMatching(/^recipient_/));
  });

  it("fails closed to review when Dojah errors, without throwing", async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no cached row
    screenIndividual.mockRejectedValue(new Error("Dojah AML screening failed (402): insufficient balance"));
    query.mockResolvedValueOnce({ rows: [row({ status: "review", error: "Dojah AML screening failed (402): insufficient balance" })] });

    const result = await screenRecipient(recipient, "NGN");

    expect(result.status).toBe("review");
  });

  it("re-reads the winning row when a concurrent first-screen races the insert", async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no cached row
    screenIndividual.mockResolvedValue({ entity: { match_status: "No Match", risk_level: "Low", entity_id: "ent_1", results: [] } });
    query.mockResolvedValueOnce({ rows: [] }); // insert ... on conflict do nothing -> lost the race
    query.mockResolvedValueOnce({ rows: [row({ status: "clear" })] }); // re-read the winner's row

    const result = await screenRecipient(recipient, "NGN");

    expect(result.status).toBe("clear");
  });
});

describe("reviewRecipientScreening", () => {
  it.each([
    ["cleared", "clear"],
    ["blocked", "blocked"],
  ] as const)("%s persists the decision", async (decision) => {
    query.mockResolvedValueOnce({ rows: [row({ status: "review" })] }); // findById-style select
    query.mockResolvedValueOnce({ rows: [row({ status: "review", review_decision: decision })] }); // update ... returning

    const result = await reviewRecipientScreening("rs1", decision, "Confirmed different person via DOB");

    expect(result.reviewDecision).toBe(decision);
  });

  it("refuses to review a clear screening", async () => {
    query.mockResolvedValueOnce({ rows: [row({ status: "clear" })] });
    await expect(reviewRecipientScreening("rs1", "blocked", "no reason at all here")).rejects.toThrow(/nothing to review/);
  });

  it("refuses to review twice", async () => {
    query.mockResolvedValueOnce({ rows: [row({ status: "review", review_decision: "cleared" })] });
    await expect(reviewRecipientScreening("rs1", "blocked", "changed my mind later")).rejects.toThrow(/already reviewed/);
  });

  it("throws if another admin decided first (concurrent review)", async () => {
    query.mockResolvedValueOnce({ rows: [row({ status: "review" })] }); // findById-style select sees it still open
    query.mockResolvedValueOnce({ rows: [] }); // update ... where review_decision is null -> lost the race

    await expect(reviewRecipientScreening("rs1", "cleared", "Checked DOB and country")).rejects.toThrow(/already reviewed/);
  });
});

describe("listRecipientScreeningsAwaitingReview", () => {
  it("returns held/blocked, undecided screenings", async () => {
    query.mockResolvedValueOnce({ rows: [row({ status: "review" })] });
    const result = await listRecipientScreeningsAwaitingReview();
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("review");
  });
});
