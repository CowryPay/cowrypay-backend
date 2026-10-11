import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ walletProvider: "aws-kms" }));
const walletsRepo = vi.hoisted(() => ({ listByProvider: vi.fn() }));
const chainScanCursorRepo = vi.hoisted(() => ({ getCursor: vi.fn(), setCursor: vi.fn() }));
const ingestDeposit = vi.hoisted(() => vi.fn());
const fetchTransferLogsChunked = vi.hoisted(() => vi.fn());
const sendTelegramOpsAlert = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/env.js", () => ({ env }));
vi.mock("../../src/db/pool.js", () => ({ withTransaction: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("../../src/db/advisoryLock.js", () => ({
  withAdvisoryLock: async (_key: string, fn: () => Promise<void>) => fn(),
}));
vi.mock("../../src/db/chainScanCursorRepository.js", () => ({ chainScanCursorRepo }));
vi.mock("../../src/domain/wallets/repository.js", () => ({ walletsRepo }));
vi.mock("../../src/domain/deposits/depositLogQuery.js", () => ({ fetchTransferLogsChunked }));
vi.mock("../../src/domain/deposits/stateMachine.js", () => ({ ingestDeposit }));
vi.mock("../../src/domain/monitoring/telegram.js", () => ({ sendTelegramOpsAlert }));
vi.mock("../../src/domain/wallets/chains.js", () => ({
  getChainConfig: () => ({
    viemChain: { id: 8453, nativeCurrency: { decimals: 18 } },
    rpcUrl: "http://stub",
    tokens: { USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 } },
    nativeToken: undefined,
  }),
  SUPPORTED_CHAINS: ["base"],
}));
vi.mock("viem", () => ({
  createPublicClient: () => ({ getBlockNumber: vi.fn().mockResolvedValue(1000n), getLogs: vi.fn() }),
  http: () => ({}),
  parseAbiItem: () => ({}),
  formatUnits: (v: bigint, d: number) => String(v / 10n ** BigInt(d)),
}));

const { reconcileDeposits } = await import("../../src/domain/deposits/depositReconciler.js");

const WALLET = { id: "w1", userId: "u1", address: "0x48525412637f829ebd43a02c0ac5e65a3cb15666", provider: "aws-kms", chain: "base" };
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".toLowerCase();
const TRANSFER = {
  transactionHash: "0x25c43986f4cb0d258ea93af94cbbe46445ea8b512519b4f657737eda8a0ffb22",
  address: USDC,
  args: { to: WALLET.address.toLowerCase(), value: 5_020_000n },
};

beforeEach(() => {
  vi.clearAllMocks();
  walletsRepo.listByProvider.mockResolvedValue([WALLET]);
  chainScanCursorRepo.getCursor.mockResolvedValue(null);
  chainScanCursorRepo.setCursor.mockResolvedValue();
});

describe("reconcileDeposits", () => {
  it("re-ingests a transfer the scanner missed, advances the rescan cursor, and alerts", async () => {
    fetchTransferLogsChunked.mockResolvedValue({ logs: [TRANSFER], fetchedTo: 998n, complete: true });
    ingestDeposit.mockResolvedValue({ deposit: { id: "d1" }, alreadyProcessed: false });

    await reconcileDeposits();

    expect(ingestDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", tokenSymbol: "USDC", chain: "base", txHash: TRANSFER.transactionHash }),
    );
    expect(chainScanCursorRepo.setCursor).toHaveBeenCalledWith("reconcile:base", 998n);
    expect(sendTelegramOpsAlert).toHaveBeenCalledWith(expect.stringContaining("re-ingested and credited"));
  });

  it("does not alert when the transfer was already ingested (harmless repeat scan), but still advances", async () => {
    fetchTransferLogsChunked.mockResolvedValue({ logs: [TRANSFER], fetchedTo: 998n, complete: true });
    ingestDeposit.mockResolvedValue({ deposit: { id: "d1" }, alreadyProcessed: true });

    await reconcileDeposits();

    expect(ingestDeposit).toHaveBeenCalledTimes(1);
    expect(sendTelegramOpsAlert).not.toHaveBeenCalled();
    expect(chainScanCursorRepo.setCursor).toHaveBeenCalledWith("reconcile:base", 998n);
  });

  it("does not advance the cursor past a transfer that failed to ingest", async () => {
    fetchTransferLogsChunked.mockResolvedValue({ logs: [TRANSFER], fetchedTo: 998n, complete: true });
    ingestDeposit.mockRejectedValue(new Error("db down"));

    await reconcileDeposits();

    expect(chainScanCursorRepo.setCursor).not.toHaveBeenCalled();
    expect(sendTelegramOpsAlert).not.toHaveBeenCalled();
  });
});