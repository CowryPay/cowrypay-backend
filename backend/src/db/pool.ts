import { setDefaultResultOrder } from "node:dns";
import { Pool, type PoolClient } from "pg";
import { env } from "../config/env.js";

// Node prefers IPv6 by default when a host resolves to both; Supabase's
// pooler hosts do, and broken/flaky IPv6 on many networks surfaces as
// ECONNRESET or ETIMEDOUT instead of a clean refusal. Force IPv4 first.
setDefaultResultOrder("ipv4first");

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
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
