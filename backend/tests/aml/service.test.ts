import { beforeEach, describe, expect, it, vi } from "vitest";

const screenIndividual = vi.hoisted(() => vi.fn());
const repo = vi.hoisted(() => ({ findById: vi.fn(), recordReview: vi.fn(), listAwaitingReview: vi.fn(), create: vi.fn() }));
const usersRepo = vi.hoisted(() => ({ findById: vi.fn(), updateKycStatus: vi.fn() }));

vi.mock("../../src/domain/aml/dojahScreening.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  screenIndividual,
}));
vi.mock("../../src/config/env.js", () => ({ env: {} }));
vi.mock("../../src/domain/aml/repository.js", () => ({ amlScreeningsRepo: repo }));
vi.mock("../../src/domain/users/repository.js", () => ({ usersRepo }));
vi.mock("../../src/db/pool.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn({}) }));

const { runAmlScreening, kycStatusForScreening, reviewScreening } = await import("../../src/domain/aml/service.js");

beforeEach(() => vi.clearAllMocks());

describe("runAmlScreening", () => {
  const subject = { name: "John Doe", dateOfBirth: "1990-01-01" };

  it("returns the decided outcome with the full response kept for audit", async () => {
    const response = { entity: { match_status: "No Match", risk_level: "Low", entity_id: "ent_1", results: [] } };
    screenIndividual.mockResolvedValue(response);

    expect(await runAmlScreening(subject)).toEqual({
      provider: "dojah",
      status: "clear",
      matchStatus: "No Match",
      riskLevel: "Low",
      entityId: "ent_1",
      screenedName: "John Doe",
      screenedDateOfBirth: "1990-01-01",
      response,
      error: null,
    });
  });

  it("holds for review when there is no verified name, without calling Dojah", async () => {
    const outcome = await runAmlScreening(undefined);
    expect(outcome.status).toBe("review");
    expect(outcome.error).toMatch(/no verified name/);
    expect(screenIndividual).not.toHaveBeenCalled();
  });

  it("holds for review when Dojah fails, never passing an unscreened user", async () => {
    screenIndividual.mockRejectedValue(new Error("Dojah AML screening failed (402): insufficient balance"));
    const outcome = await runAmlScreening(subject);
    expect(outcome.status).toBe("review");
    expect(outcome.error).toMatch(/402/);
  });
});

describe("kycStatusForScreening", () => {
  it("maps clear → verified, review → pending, blocked → rejected", () => {
    expect(kycStatusForScreening("clear")).toBe("verified");
    expect(kycStatusForScreening("review")).toBe("pending");
    expect(kycStatusForScreening("blocked")).toBe("rejected");
  });
});

describe("reviewScreening", () => {
  const held = { id: "s1", userId: "u1", status: "review", reviewDecision: null };
  const user = { id: "u1", kycReference: "dojah_ref" };

  it.each([
    ["cleared", "verified"],
    ["blocked", "rejected"],
  ] as const)("%s sets the user's kyc_status to %s", async (decision, kycStatus) => {
    repo.findById.mockResolvedValue(held);
    usersRepo.findById.mockResolvedValue(user);
    repo.recordReview.mockResolvedValue({ ...held, reviewDecision: decision });

    await reviewScreening("s1", decision, "Checked DOB and country, different person");

    expect(repo.recordReview).toHaveBeenCalledWith({}, "s1", decision, "Checked DOB and country, different person");
    expect(usersRepo.updateKycStatus).toHaveBeenCalledWith({}, "u1", kycStatus, "dojah_ref");
  });

  it("refuses to review a clear screening", async () => {
    repo.findById.mockResolvedValue({ ...held, status: "clear" });
    await expect(reviewScreening("s1", "blocked", "no reason at all here")).rejects.toThrow(/nothing to review/);
    expect(usersRepo.updateKycStatus).not.toHaveBeenCalled();
  });

  it("refuses to review twice", async () => {
    repo.findById.mockResolvedValue({ ...held, reviewDecision: "cleared" });
    await expect(reviewScreening("s1", "blocked", "changed my mind later")).rejects.toThrow(/already reviewed/);
  });

  it("does not change kyc_status if another admin decided first", async () => {
    repo.findById.mockResolvedValue(held);
    usersRepo.findById.mockResolvedValue(user);
    repo.recordReview.mockResolvedValue(null);
    await expect(reviewScreening("s1", "cleared", "Checked DOB and country")).rejects.toThrow(/already reviewed/);
    expect(usersRepo.updateKycStatus).not.toHaveBeenCalled();
  });
});
