import { describe, expect, it, vi } from "vitest";
import { fetchTransferLogs, fetchTransferLogsChunked, TRUNCATION_SUSPECT_LOG_COUNT } from "../../src/domain/deposits/depositLogQuery.js";

type Log = { transactionHash: `0x${string}`; address: `0x${string}`; args: Record<string, unknown> };
const makeLog = (i: number): Log => ({
  transactionHash: `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`,
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  args: {},
});

describe("fetchTransferLogs", () => {
  it("returns the logs and full requested range on a clean response below the truncation cap", async () => {
    const logs = [makeLog(1)];
    const res = await fetchTransferLogs(async () => logs, 100n, 110n);
    expect(res.logs).toEqual(logs);
    expect(res.fetchedTo).toBe(110n);
  });

  it("shrinks the range when a response pins the truncation cap, trusting only the first half", async () => {
    // Simulates a public RPC that answers any *wide* window with a
    // TRUNCATION_SUSPECT_LOG_COUNT-sized list (a silent truncation), but
    // returns a real, small list once the span is narrow.
    const capped = Array.from({ length: TRUNCATION_SUSPECT_LOG_COUNT }, (_, i) => makeLog(i));
    const real = [makeLog(1)];
    const calls: Array<[bigint, bigint]> = [];
    const res = await fetchTransferLogs(async (from, to) => {
      calls.push([from, to]);
      return to - from > 5n ? capped : real;
    }, 100n, 100n + 16n);

    expect(res.logs).toEqual(real);
    // 100..116 → first half is 100..108 (midpoint hi=108), which is still
    // > 5 wide? No — 108-100 = 8 > 5 → capped again → hi=104 (4 wide) → real.
    // So the last successful fetch covered 100..104.
    expect(res.fetchedTo).toBe(104n);
    expect(calls.length).toBeGreaterThan(1);
    // never accepted the truncated full-size reply as authoritative
    expect(res.fetchedTo).toBeLessThan(116n);
  });

  it("shrinks the range on a getLogs error and keeps shrinking until it succeeds", async () => {
    const real = [makeLog(1)];
    let failures = 0;
    const res = await fetchTransferLogs(async (from, to) => {
      if (to - from > 4n) {
        failures++;
        throw new Error("rate limit");
      }
      return real;
    }, 100n, 100n + 32n);
    expect(res.logs).toEqual(real);
    expect(res.fetchedTo).toBe(104n); // 100..104 is the first span <= 4 wide
    expect(failures).toBeGreaterThan(0);
  });

  it("throws when even a single-block window fails", async () => {
    await expect(
      fetchTransferLogs(
        async () => {
          throw new Error("RPC down");
        },
        100n,
        103n,
      ),
    ).rejects.toThrow("RPC down");
  });

  it("accepts a single-block response even if it is over the truncation cap (can't shrink further)", async () => {
    const capped = Array.from({ length: TRUNCATION_SUSPECT_LOG_COUNT + 5 }, (_, i) => makeLog(i));
    const res = await fetchTransferLogs(async () => capped, 100n, 100n);
    expect(res.logs).toHaveLength(TRUNCATION_SUSPECT_LOG_COUNT + 5);
    expect(res.fetchedTo).toBe(100n);
  });
});

describe("fetchTransferLogsChunked", () => {
  it("covers the whole window in a single call when the provider accepts it", async () => {
    const getLogs = vi.fn(async () => [makeLog(1)]);
    const res = await fetchTransferLogsChunked(getLogs, 100n, 110n);
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(res.logs).toHaveLength(1);
    expect(res.fetchedTo).toBe(110n);
    expect(res.complete).toBe(true);
  });

  it("keeps issuing chunks up to the provider-accepted span until the window is covered", async () => {
    // Accepts only spans of at most 4 blocks (cp. Alchemy free tier's ~10).
    const getLogs = vi.fn(async (from: bigint, to: bigint) => {
      if (to - from > 4n) throw new Error("range too large");
      return [makeLog(Number(from))];
    });
    const res = await fetchTransferLogsChunked(getLogs, 100n, 114n);
    expect(res.complete).toBe(true);
    expect(res.fetchedTo).toBe(114n);
    expect(res.logs).toHaveLength(4); // one log per chunk: 100..103, 104..107, 108..111, 112..114
    expect(getLogs.mock.calls.length).toBeGreaterThanOrEqual(4); // chunk 1 itself halved a few times
  });

  it("stops at the per-cycle chunk budget and reports the partial coverage", async () => {
    const getLogs = vi.fn(async (from: bigint, to: bigint) => {
      if (to - from > 4n) throw new Error("range too large");
      return [makeLog(Number(from))];
    });
    const res = await fetchTransferLogsChunked(getLogs, 100n, 114n, 2);
    expect(res.complete).toBe(false);
    expect(res.fetchedTo).toBe(107n);
    expect(res.logs).toHaveLength(2);
  });

  it("keeps the progress made if a later chunk fails, returning partial coverage instead of discarding", async () => {
    // Accepts spans <= 4 blocks, but the RPC goes down starting at block 108
    // — i.e. after chunk 1 (100..103) and chunk 2 (104..107) succeed.
    const getLogs = vi.fn(async (from: bigint, to: bigint) => {
      if (to - from > 4n) throw new Error("range too large");
      if (from >= 108n) throw new Error("RPC down mid-catch-up");
      return [makeLog(Number(from))];
    });
    const res = await fetchTransferLogsChunked(getLogs, 100n, 114n);
    expect(res.complete).toBe(false);
    expect(res.fetchedTo).toBe(107n); // blocks 100..107 successfully scanned
    expect(res.logs).toHaveLength(2);
  });

  it("rethrows when even the very first chunk fails (no progress at all)", async () => {
    const getLogs = async () => {
      throw new Error("RPC down");
    };
    await expect(fetchTransferLogsChunked(getLogs, 100n, 114n)).rejects.toThrow("RPC down");
  });

  it("returns an empty result for an inverted/empty window without calling getLogs", async () => {
    const getLogs = vi.fn();
    const res = await fetchTransferLogsChunked(getLogs, 100n, 90n);
    expect(getLogs).not.toHaveBeenCalled();
    expect(res.logs).toHaveLength(0);
    expect(res.fetchedTo).toBe(90n);
    expect(res.complete).toBe(true);
  });
});