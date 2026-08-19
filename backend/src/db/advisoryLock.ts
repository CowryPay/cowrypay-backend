import { pool } from "./pool.js";

// Real gap flagged (never exploited, but never closed either): the
// payout-signing layer has exactly two places that only work correctly if
// exactly one process is running — evmNonce.ts's in-memory nonce cache for
// the shared EVM payout wallet, and stellarAdapter.ts's withdrawQueue
// promise chain serializing Stellar's single sequence number. Both are
// pure in-memory serialization, so a second process (Railway scaled past
// 1 replica, or even briefly during a rolling deploy's old/new overlap)
// would have its own independent copy and could race the first — not
// silent fund loss (a nonce/sequence collision fails cleanly on-chain),
// but a stuck payout needing manual cleanup. Currently safe because
// Railway is pinned to 1 replica, but nothing in the repo enforces that;
// this makes the existing in-memory serialization correct regardless.
//
// Postgres advisory locks give real cross-process mutual exclusion using
// the database every instance already connects to as the coordination
// point — no new infrastructure needed. Session-scoped (pg_advisory_lock/
// unlock on a dedicated connection), not pg_advisory_xact_lock, since the
// protected work here is long-running RPC calls to a chain, not a single
// DB transaction. hashtext() turns a human-readable string key
// ("evm-nonce:celo") into the stable int32 these functions actually take,
// so callers never have to invent or track numeric lock IDs by hand.
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [key]);
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    client.release();
  }
}
