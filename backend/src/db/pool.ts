import { setDefaultResultOrder } from "node:dns";
import { Pool, type PoolClient } from "pg";
import { env } from "../config/env.js";

// Node prefers IPv6 by default when a host resolves to both; Supabase's
// pooler hosts do, and broken/flaky IPv6 on many networks surfaces as
// ECONNRESET or ETIMEDOUT instead of a clean refusal. Force IPv4 first.
setDefaultResultOrder("ipv4first");

export const pool = new Pool({
  connectionString: env.databaseUrl,
  // rejectUnauthorized: false leaves every query MITM-able in principle by
  // anyone positioned on the network path — tried flipping this to true
  // and confirmed LIVE that this project's Supabase pooler presents a
  // certificate Node's default root store doesn't trust
  // (SELF_SIGNED_CERT_IN_CHAIN, reproduced across every DB-backed route
  // and poller within seconds of deploying that change) — reverted
  // immediately. The real fix needs Supabase's actual CA bundle supplied
  // explicitly via `ca`, not just flipping this flag; tracked separately,
  // not attempted again without it in hand.
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
  // Without these, a flaky network path to the DB hangs a request forever
  // instead of failing with a clear error — connectionTimeoutMillis bounds
  // how long to wait for a new connection, statement_timeout bounds how
  // long any single query can run once connected.
  connectionTimeoutMillis: 8_000,
  statement_timeout: 10_000,
});

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
