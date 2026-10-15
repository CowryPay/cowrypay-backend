import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  alchemyAuthToken: "test_token",
  alchemyWebhookIds: { celo: undefined, base: "wh_base", optimism: undefined, ethereum: undefined, arc: undefined } as Record<
    string,
    string | undefined
  >,
}));
const walletsRepo = vi.hoisted(() => ({ listByProvider: vi.fn() }));
const sendTelegramOpsAlert = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/env.js", () => ({ env }));
vi.mock("../../src/domain/wallets/repository.js", () => ({ walletsRepo }));
vi.mock("../../src/domain/monitoring/telegram.js", () => ({ sendTelegramOpsAlert }));
vi.stubGlobal("fetch", fetchMock);

const { reconcileAlchemyWebhookAddresses } = await import("../../src/domain/monitoring/alchemyWebhookReconciler.js");

const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body), text: () => Promise.resolve("") });

beforeEach(() => {
  vi.clearAllMocks();
  env.alchemyAuthToken = "test_token";
  env.alchemyWebhookIds = { celo: undefined, base: "wh_base", optimism: undefined, ethereum: undefined, arc: undefined };
  walletsRepo.listByProvider.mockResolvedValue([{ address: "0xAbC" }, { address: "0xDeF" }]);
});

describe("reconcileAlchemyWebhookAddresses", () => {
  it("skips entirely when ALCHEMY_AUTH_TOKEN is unset", async () => {
    env.alchemyAuthToken = undefined as unknown as string;
    await reconcileAlchemyWebhookAddresses();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips entirely when no chain has a webhook configured", async () => {
    env.alchemyWebhookIds = { celo: undefined, base: undefined, optimism: undefined, ethereum: undefined, arc: undefined };
    await reconcileAlchemyWebhookAddresses();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing and alerts no one when already in sync", async () => {
    fetchMock.mockResolvedValueOnce(json({ addresses: ["0xabc", "0xdef"] })); // GET, already watches both (case-insensitive)

    await reconcileAlchemyWebhookAddresses();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramOpsAlert).not.toHaveBeenCalled();
  });

  it("patches in missing addresses and alerts", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ addresses: ["0xabc"] })) // GET — missing 0xDeF
      .mockResolvedValueOnce(json({})); // PATCH

    await reconcileAlchemyWebhookAddresses();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, patchInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(patchInit.body)).toEqual({ webhook_id: "wh_base", addresses_to_add: ["0xDeF"], addresses_to_remove: [] });
    expect(sendTelegramOpsAlert).toHaveBeenCalledWith(expect.stringContaining("Added 1 missing address"));
  });

  it("does not alert or throw when the GET call itself fails", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "boom" }, false));

    await expect(reconcileAlchemyWebhookAddresses()).resolves.toBeUndefined();

    expect(sendTelegramOpsAlert).not.toHaveBeenCalled();
  });
});
