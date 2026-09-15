import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ amlScreeningEnabled: true, kycProvider: "dojah" }));
const kycAttemptsRepo = vi.hoisted(() => ({ findByProviderReference: vi.fn(), resolve: vi.fn(), create: vi.fn() }));
const amlScreeningsRepo = vi.hoisted(() => ({ create: vi.fn() }));
const usersRepo = vi.hoisted(() => ({ updateKycStatus: vi.fn(), findById: vi.fn() }));
const runAmlScreening = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/env.js", () => ({ env }));
vi.mock("../../src/db/pool.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("../../src/domain/kyc/repository.js", () => ({ kycAttemptsRepo }));
vi.mock("../../src/domain/aml/repository.js", () => ({ amlScreeningsRepo }));
vi.mock("../../src/domain/users/repository.js", () => ({ usersRepo }));
vi.mock("../../src/domain/kyc/index.js", () => ({ getKycAdapter: vi.fn() }));
vi.mock("../../src/domain/aml/service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAmlScreening,
}));

const { resolveKyc } = await import("../../src/domain/kyc/service.js");

const attempt = { id: "a1", userId: "u1", status: "pending" };
const subject = { name: "John Doe", dateOfBirth: "1990-01-01" };
const outcome = (status: string) => ({ provider: "dojah", status, screenedName: "John Doe" });

beforeEach(() => {
  vi.clearAllMocks();
  env.amlScreeningEnabled = true;
  kycAttemptsRepo.findByProviderReference.mockResolvedValue(attempt);
  kycAttemptsRepo.resolve.mockResolvedValue({ ...attempt, status: "verified" });
});

describe("resolveKyc with AML screening enabled", () => {
  it.each([
    ["clear", "verified"],
    ["review", "pending"],
    ["blocked", "rejected"],
  ])("screening %s → kyc_status %s, screening row stored", async (status, kycStatus) => {
    runAmlScreening.mockResolvedValue(outcome(status));

    await resolveKyc("dojah_ref", "verified", subject);

    expect(runAmlScreening).toHaveBeenCalledWith(subject);
    expect(kycAttemptsRepo.resolve).toHaveBeenCalledWith({}, "a1", "verified");
    expect(amlScreeningsRepo.create).toHaveBeenCalledWith({}, { userId: "u1", ...outcome(status) });
    expect(usersRepo.updateKycStatus).toHaveBeenCalledWith({}, "u1", kycStatus, "dojah_ref");
  });

  it("does not screen a user the vendor rejected", async () => {
    await resolveKyc("dojah_ref", "rejected", subject);
    expect(runAmlScreening).not.toHaveBeenCalled();
    expect(amlScreeningsRepo.create).not.toHaveBeenCalled();
    expect(usersRepo.updateKycStatus).toHaveBeenCalledWith({}, "u1", "rejected", "dojah_ref");
  });

  it("does not store a screening or change kyc_status if the attempt was resolved concurrently", async () => {
    runAmlScreening.mockResolvedValue(outcome("clear"));
    kycAttemptsRepo.resolve.mockResolvedValue(null);

    await expect(resolveKyc("dojah_ref", "verified", subject)).rejects.toThrow(/already resolved/);
    expect(amlScreeningsRepo.create).not.toHaveBeenCalled();
    expect(usersRepo.updateKycStatus).not.toHaveBeenCalled();
  });
});

describe("resolveKyc with AML screening disabled", () => {
  it("verifies directly without screening", async () => {
    env.amlScreeningEnabled = false;
    await resolveKyc("dojah_ref", "verified", subject);
    expect(runAmlScreening).not.toHaveBeenCalled();
    expect(usersRepo.updateKycStatus).toHaveBeenCalledWith({}, "u1", "verified", "dojah_ref");
  });
});
