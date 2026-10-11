// Shared by depositScanner.ts and depositReconciler.ts: one place that owns
// "fetch Transfer logs over a block range without letting a flaky or
// truncating RPC make the caller believe it saw a range it actually
// didn't." Deliberately a pure function of an injected getLogs — no RPC, no
// DB — so it can be unit-tested in isolation
// (tests/deposits/fetchTransferLogs.test.ts).

export interface DepositTransferLog {
  transactionHash: `0x${string}`;
  address: `0x${string}`;
  args: { to?: `0x${string}` | null; value?: bigint | null };
}

// Public/free RPCs (e.g. the default mainnet.base.org — see env.ts) don't
// just *reject* oversized log queries; they can also answer with HTTP 200
// and a TRUNCATED list (typically the earliest logs, the rest silently
// dropped). A count at or above this generous cap almost certainly means
// the reply was cut short — this watchlist legitimately never sees anything
// near this many transfers in one scan window today. Real incident that
// motivated the check (2026-10-10): a Base USDC deposit was missed exactly
// this way — no deposit row was ever created, yet the separate balance-based
// sweeper moved the funds, so the money silently vanished from sight.
export const TRUNCATION_SUSPECT_LOG_COUNT = 1000;

export type FetchTransferLogs = (fromBlock: bigint, toBlock: bigint) => Promise<DepositTransferLog[]>;

// Returns the logs it fully trusts plus fetchedTo — the last block they
// cover, which can be narrower than the requested toBlock when the range
// had to be shrunk (once on error, once on truncation). The caller only
// advances its own cursor to fetchedTo, so any block it can't fetch
// completely is re-asked next cycle, never silently skipped.
//
// Rationale for shrinking to the FIRST half on a truncation suspect: nodes
// truncate from the tail (they keep the earliest logs in a range), so the
// first half of the just-returned range is the trustworthy part.
export async function fetchTransferLogs(
  getLogs: FetchTransferLogs,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ logs: DepositTransferLog[]; fetchedTo: bigint }> {
  let hi = toBlock;
  for (;;) {
    let logs: DepositTransferLog[];
    try {
      logs = await getLogs(fromBlock, hi);
    } catch (err) {
      if (hi <= fromBlock) throw err; // already the narrowest possible range — a real failure
      hi = fromBlock + (hi - fromBlock) / 2n;
      continue;
    }
    if (BigInt(logs.length) >= TRUNCATION_SUSPECT_LOG_COUNT && hi > fromBlock) {
      hi = fromBlock + (hi - fromBlock) / 2n;
      continue;
    }
    return { logs, fetchedTo: hi };
  }
}

// Real incident (2026-10-10, follow-up): pointing BASE_RPC_URL at a keyed
// Alchemy endpoint fixed the truncation/rate-limit behaviour of
// fetchTransferLogs but exposed a *throughput* cap — Alchemy's free tier
// answers eth_getLogs only for ~10-block spans (wider spans fail with
// "JSON is not a valid request object"), verified live. fetchTransferLogs
// then self-heals by shrinking, but a single call can only cover the span
// the provider accepts, so a 30s poll against Base's ~2s blocks (~15 blocks
// per cycle > 10) makes the cursor fall behind forever. This wraps
// fetchTransferLogs: after the first call discovers the largest span the
// provider actually accepts for this chain/plan, it keeps issuing that same
// span back-to-back until the whole requested window is covered (or a
// per-cycle chunk budget is hit), instead of advancing only one span per
// cycle. Provider-agnostic — nothing about the limit is hardcoded; it is
// learned from the first response and re-learned each chunk.
//
// Partial-progress rule: if a chunk throws AFTER we've made progress, keep
// what we have and return (fetchedTo < toBlock, complete=false) rather than
// discarding the whole window — otherwise a late failure during a long
// catch-up would lose every earlier chunk and could never complete. If the
// FIRST chunk fails outright (nothing fetched), the error is rethrown so the
// caller still logs/retries the whole range as before.
export const MAX_CHUNKS_PER_FETCH = 200;

export interface ChunkedTransferLogsResult {
  logs: DepositTransferLog[];
  fetchedTo: bigint;
  complete: boolean;
}

export async function fetchTransferLogsChunked(
  getLogs: FetchTransferLogs,
  fromBlock: bigint,
  toBlock: bigint,
  maxChunks: number = MAX_CHUNKS_PER_FETCH,
): Promise<ChunkedTransferLogsResult> {
  if (fromBlock > toBlock) return { logs: [], fetchedTo: toBlock, complete: true };

  const logs: DepositTransferLog[] = [];
  let cursor = fromBlock;
  let chunkSpan: bigint | null = null;
  let chunks = 0;

  while (cursor <= toBlock && chunks < maxChunks) {
    // First pass: request the whole window and let fetchTransferLogs learn
    // the accepted span. After that: request exactly that span (capped to
    // what's left) so each follow-up succeeds without re-halving.
    const target = chunkSpan != null && cursor + chunkSpan - 1n < toBlock ? cursor + chunkSpan - 1n : toBlock;
    let batch: DepositTransferLog[];
    let fetchedTo: bigint;
    try {
      const res = await fetchTransferLogs(getLogs, cursor, target);
      batch = res.logs;
      fetchedTo = res.fetchedTo;
    } catch (err) {
      if (chunks === 0) throw err;
      break; // keep the progress already made; the remainder is retried next cycle
    }
    logs.push(...batch);
    chunks++;
    chunkSpan = fetchedTo - cursor + 1n;
    if (fetchedTo < cursor) break; // defensive: no forward progress, stop rather than spin
    cursor = fetchedTo + 1n;
  }

  return { logs, fetchedTo: cursor - 1n, complete: cursor > toBlock };
}