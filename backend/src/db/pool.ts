import { setDefaultResultOrder } from "node:dns";
import { Pool, type PoolClient } from "pg";
import { env } from "../config/env.js";

// Node prefers IPv6 by default when a host resolves to both; Supabase's
// pooler hosts do, and broken/flaky IPv6 on many networks surfaces as
// ECONNRESET or ETIMEDOUT instead of a clean refusal. Force IPv4 first.
setDefaultResultOrder("ipv4first");

export const pool = new Pool({
  connectionString: env.databaseUrl,
  // rejectUnauthorized: false previously left every query MITM-able by
  // anyone positioned on the network path (DNS hijack, ARP spoof in a
  // shared VPC, compromised proxy) — the connection was encrypted but the
  // server's certificate was never actually validated. Supabase's pooler
  // uses a publicly-trusted certificate chain (not self-signed), so the
  // default Node root store is enough here — no custom CA needed.
  ssl: env.databaseSsl ? { rejectUnauthorized: true } : undefined,
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
