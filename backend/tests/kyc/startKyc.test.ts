import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ kycProvider: "dojah", kycPendingTtlMinutes: 30 }));
const kycAttemptsRepo = vi.hoisted(() => ({ findPendingForUser: vi.fn(), create: vi.fn(), resolve: vi.fn() }));
const usersRepo = vi.hoisted(() => ({ findById: vi.fn(), updateKycStatus: vi.fn(), revertKycStatusIfPending: vi.fn() }));
const resolveCountry = vi.hoisted(() => vi.fn());
const startVerification = vi.hoisted(() => vi.fn());
const getKycAdapter = vi.hoisted(() => vi.fn(() => ({ startVerification })));

vi.mock("../../src/config/env.js", () => ({ env }));
vi.mock("../../src/db/pool.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("../../src/domain/kyc/repository.js", () => ({ kycAttemptsRepo }));
vi.mock("../../src/domain/users/repository.js", () => ({ usersRepo }));
vi.mock("../../src/ai-agent/offramp/countries.js", () => ({ resolveCountry }));
vi.mock("../../src/domain/kyc/index.js", () => ({ getKycAdapter }));
vi.mock("../../src/domain/aml/repository.js", () => ({ amlScreeningsRepo: { create: vi.fn() } }));
vi.mock("../../src/domain/aml/service.js", () => ({ kycStatusForScreening: vi.fn(), runAmlScreening: vi.fn() }));

const { startKyc } = await import("../../src/domain/kyc/service.js");

const user = { id: "u1", email: "a@b.com", kycStatus: "unverified" };
const country = { name: "Nigeria", countryCode: "NG", currencyCode: "NGN" };

beforeEach(() => {
  vi.clearAllMocks();
  usersRepo.findById.mockResolvedValue(user);
  resolveCountry.mockReturnValue(country);
  kycAttemptsRepo.findPendingForUser.mockResolvedValue(null);
  startVerification.mockResolvedValue({ providerReference: "dojah_new", widgetId: "widget_ng_ke" });
});

describe("startKyc dedupe/reuse", () => {
  it("creates a fresh attempt when there's no existing pending one", async () => {
    const session = await startKyc("u1", "Nigeria");

    expect(startVerification).toHaveBeenCalledOnce();
    expect(kycAttemptsRepo.create).toHaveBeenCalledWith(
      {},
      { userId: "u1", provider: "dojah", providerReference: "dojah_new", country: "Nigeria", widgetId: "widget_ng_ke" },
    );
    expect(usersRepo.updateKycStatus).toHaveBeenCalledWith({}, "u1", "pending", null);
    expect(session).toEqual({ providerReference: "dojah_new", widgetId: "widget_ng_ke" });
  });

  it("reuses a still-fresh pending attempt instead of minting (and billing) a new one", async () => {
    kycAttemptsRepo.findPendingForUser.mockResolvedValue({
      id: "old",
      providerReference: "dojah_old",
      widgetId: "widget_ng_ke",
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 minutes old, well within the 30-minute TTL
    });

    const session = await startKyc("u1", "Nigeria");

    expect(startVerification).not.toHaveBeenCalled();
    expect(kycAttemptsRepo.create).not.toHaveBeenCalled();
    expect(kycAttemptsRepo.resolve).not.toHaveBeenCalled();
    expect(session).toEqual({ providerReference: "dojah_old", widgetId: "widget_ng_ke" });
  });

  it("abandons a stale pending attempt and starts fresh instead of reusing it", async () => {
    kycAttemptsRepo.findPendingForUser.mockResolvedValue({
      id: "old",
      userId: "u1",
      providerReference: "dojah_old",
      widgetId: "widget_ng_ke",
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 60 minutes old, past the 30-minute TTL
    });
    kycAttemptsRepo.resolve.mockResolvedValue({ id: "old", status: "abandoned" });

    const session = await startKyc("u1", "Nigeria");

    // The stale attempt was abandoned (CAS'd via resolve, then the
    // CAS'd user revert) before a fresh one was created.
    expect(kycAttemptsRepo.resolve).toHaveBeenCalledWith({}, "old", "abandoned");
    expect(usersRepo.revertKycStatusIfPending).toHaveBeenCalledWith({}, "u1");
    expect(startVerification).toHaveBeenCalledOnce();
    expect(session).toEqual({ providerReference: "dojah_new", widgetId: "widget_ng_ke" });
  });
});
