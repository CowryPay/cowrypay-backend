import "dotenv/config";
import { setDefaultResultOrder } from "node:dns";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";

// See src/db/pool.ts — same IPv6-first fix, needed here too since this
// script runs standalone rather than importing that pool.
setDefaultResultOrder("ipv4first");

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../db/migrations");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: false },
  });

  await pool.query(`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await pool.query("select name from _migrations")).rows.map((r: { name: string }) => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into _migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`Applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log("Migrations up to date.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
