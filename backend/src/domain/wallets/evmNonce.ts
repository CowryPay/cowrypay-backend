import { createPublicClient, http, type Chain } from "viem";

// Per-chain in-memory nonce tracking for the single shared payout key —
// fixes a real, live incident: both awsKmsAdapter.ts's withdraw() (called
// twice back-to-back by initiateSend — the main payout, then the fee
// sweep) and depositSweeper.ts's gas top-up (called once per wallet
// needing gas, potentially several times per sweep cycle) send FROM this
// same payout wallet, and each used to independently ask the RPC "what's
// the next nonce?" via eth_getTransactionCount(address, "pending"). After
// switching to Alchemy, a query moments after a broadcast could still
// return a stale, too-low count — Alchemy's infrastructure (load-balanced
// across nodes) doesn't always reflect a just-broadcast transaction as
// pending immediately. Result: "nonce too low" / "replacement transaction
// underpriced" on every fee sweep since the switch, confirmed via
// /admin/sends showing 100% fee-sweep failure from that point on.
//
// Fixed by never re-asking the RPC for "pending" nonce between sends in
// the same process — fetched once per chain, then handed out and
// incremented purely in memory from then on. Shared as ONE module (not
// duplicated per file) specifically so awsKmsAdapter.ts and
// depositSweeper.ts can never independently claim the same nonce for the
// same payout wallet — two separate in-memory caches for the same
// on-chain account would just recreate this exact bug between themselves.
// This also protects against the same collision if sends for two
// *different* users ever get processed concurrently on the same chain (a
// real, always-latent risk with one shared payout key, independent of the
// Alchemy-specific trigger above). Each claim chains synchronously onto
// the previous one (no `await` between reading and writing the map) so
// two calls invoked back-to-back can never both read "nothing cached yet"
// and both hit the RPC.
const nonceChains = new Map<string, Promise<number>>();

export function claimNonce(chain: string, fetchFresh: () => Promise<number>): Promise<number> {
  const previous = nonceChains.get(chain);
  const claimed = previous ? previous.then((n) => n + 1) : fetchFresh();
  nonceChains.set(chain, claimed);
  return claimed;
}

// Called when a claimed nonce turns out to be wrong anyway (e.g. this
// process just restarted and its very first fetch already raced a
// transaction from before the restart, or an out-of-band send happened)
// — drops the cache so the next call re-fetches fresh from the chain
// instead of continuing to compound a bad guess.
export function resyncNonce(chain: string): void {
  nonceChains.delete(chain);
}

export function isNonceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("nonce too low") ||
    message.includes("nonce provided for the transaction is lower") ||
    message.includes("replacement transaction underpriced") ||
    message.includes("already known")
  );
}

export function fetchPendingNonce(viemChain: Chain, rpcUrl: string, address: `0x${string}`): () => Promise<number> {
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  return () => publicClient.getTransactionCount({ address, blockTag: "pending" });
}
