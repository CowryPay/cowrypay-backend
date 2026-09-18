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

// Gives a claimed nonce back for reuse when the transaction that claimed
// it never actually broadcast. Real incident (2026-09-18): claimNonce
// reserves a nonce the instant it's called, before the send is known to
// succeed — every one of this module's callers used to release/resync
// the cache only for a RECOGNIZED nonce-conflict error (isNonceError),
// silently burning the nonce forever on any other failure (insufficient
// balance, an RPC hiccup, anything). That leaves a permanent gap: the
// next claim moves on to n+1, and every later send from that chain's
// payout wallet gets stuck behind the unfillable gap at n — recoverable
// only by restarting the process to force a full resync.
//
// Only safe to roll back when nothing has claimed a LATER nonce in the
// meantime — checked by identity: `claimedPromise` must still be the
// exact promise this chain's cache holds. If something else already
// claimed on top of it, rolling back would collide with that concurrent
// claim, so this is a no-op in that case (the advisory lock every real
// caller wraps claim+send in already excludes concurrent callers for the
// same chain in the normal case; this only guards the remaining edge).
function releaseNonce(chain: string, claimedPromise: Promise<number>, nonce: number): void {
  if (nonceChains.get(chain) === claimedPromise) {
    nonceChains.set(chain, Promise.resolve(nonce - 1));
  }
}

export function fetchPendingNonce(viemChain: Chain, rpcUrl: string, address: `0x${string}`): () => Promise<number> {
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  return () => publicClient.getTransactionCount({ address, blockTag: "pending" });
}

// Claims a nonce, runs `send` with it, and releases the nonce on ANY
// failure (see releaseNonce) before deciding what to do next — this is
// the one place the incident above is actually closed; every call site
// used to hand-roll this same claim/catch/resync shape with the bug
// baked into each copy. A recognized nonce error still gets exactly one
// resync-and-retry with a freshly-claimed nonce, same as every call site
// already did; the retry attempt's own nonce is released too if it also
// fails, rather than reintroducing the same leak on the retry path.
export async function withClaimedNonce<T>(
  chain: string,
  fetchFresh: () => Promise<number>,
  send: (nonce: number) => Promise<T>,
): Promise<T> {
  const claimedPromise = claimNonce(chain, fetchFresh);
  const nonce = await claimedPromise;
  try {
    return await send(nonce);
  } catch (err) {
    releaseNonce(chain, claimedPromise, nonce);
    if (!isNonceError(err)) throw err;
    resyncNonce(chain);
    const retryPromise = claimNonce(chain, fetchFresh);
    const retryNonce = await retryPromise;
    try {
      return await send(retryNonce);
    } catch (retryErr) {
      releaseNonce(chain, retryPromise, retryNonce);
      throw retryErr;
    }
  }
}
